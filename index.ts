import express from "express";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// ── Config ──────────────────────────────────────────────────────────
console.log("[startup] All env var keys:", Object.keys(process.env).sort());
const PORT = parseInt(process.env.PORT || "3000", 10);
const API_ID = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
const WORKER_SECRET = process.env.WORKER_SECRET || "";

const missing: string[] = [];
if (!process.env.TELEGRAM_API_ID || !API_ID) missing.push("TELEGRAM_API_ID");
if (!API_HASH) missing.push("TELEGRAM_API_HASH");
if (!WORKER_SECRET) missing.push("WORKER_SECRET");

if (missing.length) {
  console.error(`Missing or invalid env vars: ${missing.join(", ")}`);
  console.error(
    `Detected — TELEGRAM_API_ID: "${process.env.TELEGRAM_API_ID ?? ""}" ` +
    `(parsed ${API_ID}), TELEGRAM_API_HASH length: ${API_HASH.length}, ` +
    `WORKER_SECRET length: ${WORKER_SECRET.length}`
  );
  process.exit(1);
}

// ── DC address map for migration ────────────────────────────────────
const DC_ADDRESSES: Record<number, string> = {
  1: "149.154.175.53",
  2: "149.154.167.51",
  3: "149.154.175.100",
  4: "149.154.167.91",
  5: "91.108.56.130",
};

// ── Boot diagnostics ────────────────────────────────────────────────
const BOOT_TIME = Date.now();
const BOOT_ID = Math.random().toString(36).slice(2, 10);
console.log(`[boot] worker booted. boot_id=${BOOT_ID} boot_time=${new Date(BOOT_TIME).toISOString()}`);

// ── In-memory session store ─────────────────────────────────────────
interface LiveSession {
  client: TelegramClient;
  state: "waiting" | "needs_password" | "authorized" | "error";
  userId: string;       // Supabase user_id
  sessionId: string;    // telegram_sessions.id
  finalizeUrl: string;  // edge function URL for callback
  qrUrl?: string;
  expires?: number;
  telegramName?: string | null;
  telegramUsername?: string | null;
  telegramUserId?: number;
  phone?: string | null;
  error?: string;
  eventFired: boolean;
  finalized: boolean;
  createdAt: number;
}

const sessions = new Map<string, LiveSession>();

// Auto-cleanup every 60s — remove sessions older than 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 5 * 60 * 1000) {
      console.log(`[cleanup] Removing stale session ${id}`);
      try { s.client.disconnect(); } catch {}
      sessions.delete(id);
    }
  }
}, 60_000);

// ── Auth middleware ─────────────────────────────────────────────────
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Helpers ─────────────────────────────────────────────────────────

function tokenToUrl(token: Buffer): string {
  const base64 = token.toString("base64url");
  return `tg://login?token=${base64}`;
}

async function connectWithTimeout(client: TelegramClient, timeoutMs = 15000): Promise<void> {
  await Promise.race([
    client.connect(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("connect timeout")), timeoutMs)
    ),
  ]).catch((err) => {
    if (err.message === "connect timeout") {
      const sender = (client as any)._sender;
      if (sender && sender.isConnected && sender.isConnected()) {
        console.log("[connect] Timeout but sender connected — proceeding");
        return;
      }
      throw new Error("connect timeout and sender not connected");
    }
    throw err;
  });
}

async function postFinalize(session: LiveSession, sessionString: string) {
  const payload = {
    action: "finalize",
    session_id: session.sessionId,
    user_id: session.userId,
    session_string: sessionString,
    telegram_user_id: session.telegramUserId,
    telegram_name: session.telegramName,
    telegram_username: session.telegramUsername,
    phone: session.phone,
  };

  console.log(`[finalize→edge] sid=${session.sessionId} url=${session.finalizeUrl}`);

  const res = await fetch(session.finalizeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WORKER_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`[finalize→edge] status=${res.status} body=${text.slice(0, 300)}`);

  if (!res.ok) {
    throw new Error(`finalize callback failed: ${res.status} ${text}`);
  }
}

async function finalizeAuth(session: LiveSession, client: TelegramClient) {
  try {
    const me = await client.getMe() as any;
    session.telegramUserId = typeof me.id === "bigint" ? Number(me.id) : Number(me.id);
    session.telegramName = [me.firstName, me.lastName].filter(Boolean).join(" ") || null;
    session.telegramUsername = me.username || null;
    session.phone = me.phone || null;

    const sessionString = (client.session as StringSession).save();

    console.log(`[finalizeAuth] sid=${session.sessionId} tgUser=${session.telegramUserId} name=${session.telegramName}`);

    await postFinalize(session, sessionString);

    session.finalized = true;
    session.state = "authorized";
    console.log(`[finalizeAuth] SUCCESS — session ${session.sessionId} authorized`);
  } catch (err: any) {
    console.error(`[finalizeAuth] Error:`, err);
    session.state = "error";
    session.error = err.message;
  }
}

async function handleLoginTokenResult(
  result: any,
  session: LiveSession,
  client: TelegramClient
) {
  const className = result?.className;
  console.log(`[handleLoginTokenResult] sid=${session.sessionId} className=${className}`);

  if (className === "auth.LoginToken") {
    session.qrUrl = tokenToUrl(result.token);
    session.expires = result.expires;
    return;
  }

  if (className === "auth.LoginTokenMigrateTo") {
    console.log(`[migrate] sid=${session.sessionId} target DC=${result.dcId}`);

    let migratedClient: TelegramClient | null = null;
    try {
      console.log(`[migrate] creating new client for DC ${result.dcId}`);
      const migratedSession = new StringSession("");
      migratedClient = new TelegramClient(migratedSession, API_ID, API_HASH, {
        connectionRetries: 3,
        deviceModel: "Lovable CRM",
        appVersion: "1.0.0",
      });

      console.log(`[migrate] connecting target-DC client (pre-switch)`);
      await connectWithTimeout(migratedClient, 15000);
      console.log(`[migrate] connected, switching to DC ${result.dcId}`);

      await (migratedClient as any)._switchDC(result.dcId);
      console.log(`[migrate] switched to DC ${result.dcId}`);

      // small settle delay so the new DC sender is ready
      await new Promise((r) => setTimeout(r, 300));

      console.log(`[migrate] invoking ImportLoginToken on DC ${result.dcId}`);
      const importResult: any = await migratedClient.invoke(
        new Api.auth.ImportLoginToken({ token: result.token })
      );
      console.log(`[migrate] ImportLoginToken result className=${importResult?.className}`);

      if (importResult?.className === "auth.LoginTokenSuccess") {
        session.client = migratedClient;
        try { client.disconnect(); } catch {}
        await finalizeAuth(session, migratedClient);
      } else if (importResult?.className === "auth.LoginToken") {
        // Telegram returned a refreshed QR token — surface it to the user
        session.qrUrl = tokenToUrl(importResult.token);
        session.expires = importResult.expires;
        session.client = migratedClient;
      } else {
        throw new Error(`Unexpected ImportLoginToken result: ${importResult?.className}`);
      }
    } catch (err: any) {
      console.error(`[migrate] FAILED:`, err?.message || err);
      if (err?.message?.includes("SESSION_PASSWORD_NEEDED")) {
        session.state = "needs_password";
        if (migratedClient) session.client = migratedClient;
      } else {
        session.state = "error";
        session.error = `DC migration to ${result.dcId} failed: ${err?.message || err}`;
        try { migratedClient?.disconnect(); } catch {}
      }
    }
    return;
  }

  if (className === "auth.LoginTokenSuccess") {
    await finalizeAuth(session, client);
    return;
  }

  console.warn(`[handleLoginTokenResult] Unexpected className: ${className}`);
}

// ── Express app ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(authMiddleware);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, activeSessions: sessions.size });
});

// ── POST /qr/init ──────────────────────────────────────────────────
app.post("/qr/init", async (req, res) => {
  const { session_id, user_id, finalize_url } = req.body;
  if (!session_id || !user_id || !finalize_url) {
    return res.status(400).json({ error: "session_id, user_id and finalize_url required" });
  }

  console.log(`\n[init] sid=${session_id} uid=${user_id} finalize=${finalize_url}`);

  try {
    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
      connectionRetries: 3,
      deviceModel: "Lovable CRM",
      appVersion: "1.0.0",
    });

    await connectWithTimeout(client, 15000);
    console.log(`[init] Connected to Telegram`);

    const result = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId: API_ID,
        apiHash: API_HASH,
        exceptIds: [],
      })
    );

    console.log(`[init] ExportLoginToken result: ${result?.className}`);

    if (result?.className !== "auth.LoginToken") {
      return res.status(500).json({ error: `Unexpected: ${result?.className}` });
    }

    const qrUrl = tokenToUrl(result.token);
    const expires = result.expires;

    const liveSession: LiveSession = {
      client,
      state: "waiting",
      userId: user_id,
      sessionId: session_id,
      finalizeUrl: finalize_url,
      qrUrl,
      expires,
      eventFired: false,
      finalized: false,
      createdAt: Date.now(),
    };
    sessions.set(session_id, liveSession);

    client.addEventHandler(async (update: any) => {
      if (update?.className !== "UpdateLoginToken") return;

      console.log(`\n[EVENT] UpdateLoginToken fired for sid=${session_id}`);
      liveSession.eventFired = true;

      try {
        const newResult = await client.invoke(
          new Api.auth.ExportLoginToken({
            apiId: API_ID,
            apiHash: API_HASH,
            exceptIds: [],
          })
        );
        await handleLoginTokenResult(newResult, liveSession, client);
      } catch (err: any) {
        console.error(`[EVENT handler] Error:`, err);
        if (err.message?.includes("SESSION_PASSWORD_NEEDED")) {
          liveSession.state = "needs_password";
        } else {
          liveSession.state = "error";
          liveSession.error = err.message;
        }
      }
    });

    console.log(`[init] Event handler registered. QR ready.`);

    console.log(`[init] sid=${session_id} stored. boot_id=${BOOT_ID} activeSessions=${sessions.size}`);

    res.json({ qr_url: qrUrl, expires, boot_id: BOOT_ID });
  } catch (err: any) {
    console.error(`[init] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /qr/check/:sessionId ───────────────────────────────────────
app.get("/qr/check/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    const uptime = Math.round((Date.now() - BOOT_TIME) / 1000);
    const knownIds = [...sessions.keys()].join(",");
    console.warn(`[check] sid=${sessionId} NOT FOUND. boot_id=${BOOT_ID} uptime=${uptime}s activeSessions=${sessions.size} knownIds=[${knownIds}]`);
    return res.status(404).json({ error: "Session not found", status: "expired", boot_id: BOOT_ID, uptime_seconds: uptime, active_sessions: sessions.size });
  }

  console.log(`[check] sid=${sessionId} state=${session.state} eventFired=${session.eventFired}`);

  const response: any = {
    status: session.state,
    event_fired: session.eventFired,
    age_seconds: Math.round((Date.now() - session.createdAt) / 1000),
  };

  if (session.state === "authorized") {
    response.telegram_name = session.telegramName;
    response.telegram_username = session.telegramUsername;
  }

  if (session.state === "error") {
    response.error = session.error;
  }

  if (session.qrUrl) {
    response.qr_url = session.qrUrl;
  }

  res.json(response);
});

// ── POST /qr/password/:sessionId ───────────────────────────────────
app.post("/qr/password/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { password } = req.body;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  if (!password) {
    return res.status(400).json({ error: "password required" });
  }

  console.log(`[password] sid=${sessionId}`);

  try {
    const result = await session.client.invoke(
      new Api.auth.CheckPassword({
        password: await session.client.invoke(new Api.account.GetPassword()).then(
          (pwd: any) => {
            return (session.client as any).computeSrpPassword(pwd, password);
          }
        ),
      })
    );

    console.log(`[password] Result: ${result?.className}`);

    if ((result as any)?.className === "auth.Authorization") {
      await finalizeAuth(session, session.client);
      res.json({
        status: "authorized",
        telegram_name: session.telegramName,
        telegram_username: session.telegramUsername,
      });
    } else {
      res.json({ status: "error", error: `Unexpected: ${result?.className}` });
    }
  } catch (err: any) {
    console.error(`[password] Error:`, err);
    res.status(400).json({ error: err.message });
  }
});

// ── Start server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Telegram Worker running on port ${PORT}`);
  console.log(`   API_ID: ${API_ID}`);
  console.log(`   Active sessions: ${sessions.size}`);
});
