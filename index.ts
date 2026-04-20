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

// ── Lovable Cloud session bridge (no direct Supabase access from worker) ──
// LOVABLE_SESSION_URL points to the protected edge function:
//   https://<project>.functions.supabase.co/telegram-worker-session
// The worker authenticates with Bearer ${WORKER_SECRET}; the edge function
// verifies the secret and returns session_string (or accepts updates).
const LOVABLE_SESSION_URL = process.env.LOVABLE_SESSION_URL || "";
if (!LOVABLE_SESSION_URL) {
  console.warn("[startup] LOVABLE_SESSION_URL missing — /send rehydration will fail after worker restart.");
}

async function fetchSessionFromCloud(sessionId: string): Promise<any | null> {
  if (!LOVABLE_SESSION_URL) return null;
  const r = await fetch(LOVABLE_SESSION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WORKER_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "get", session_id: sessionId }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error(`[rehydrate] sid=${sessionId} cloud fetch failed: ${r.status} ${t.slice(0, 200)}`);
    return null;
  }
  const json = await r.json().catch(() => null);
  return json?.session ?? null;
}

async function persistSessionStringToCloud(sessionId: string, sessionString: string): Promise<void> {
  if (!LOVABLE_SESSION_URL) return;
  const r = await fetch(LOVABLE_SESSION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WORKER_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "update_session_string", session_id: sessionId, session_string: sessionString }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.warn(`[persist] sid=${sessionId} cloud update failed: ${r.status} ${t.slice(0, 200)}`);
  }
}

// ── Peer metadata bridge ────────────────────────────────────────────
interface StoredPeer {
  chat_id: number;
  peer_type: string | null;
  access_hash: string | null;
  username: string | null;
  chat_title: string | null;
  chat_type?: string | null;
}

async function fetchPeerFromCloud(sessionId: string, chatId: number): Promise<StoredPeer | null> {
  if (!LOVABLE_SESSION_URL) return null;
  try {
    const r = await fetch(LOVABLE_SESSION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "get_peer", session_id: sessionId, chat_id: chatId }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn(`[peer] get_peer failed sid=${sessionId} chat=${chatId}: ${r.status} ${t.slice(0, 200)}`);
      return null;
    }
    const json = await r.json().catch(() => null);
    return json?.peer ?? null;
  } catch (err: any) {
    console.warn(`[peer] get_peer error sid=${sessionId} chat=${chatId}: ${err?.message}`);
    return null;
  }
}

async function upsertPeerToCloud(
  sessionId: string,
  chatId: number,
  peerType: string | null,
  accessHash: string | null,
  extra?: { chat_title?: string | null; username?: string | null }
): Promise<void> {
  if (!LOVABLE_SESSION_URL) return;
  try {
    const r = await fetch(LOVABLE_SESSION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "upsert_peer",
        session_id: sessionId,
        chat_id: chatId,
        peer_type: peerType,
        access_hash: accessHash,
        chat_title: extra?.chat_title ?? null,
        username: extra?.username ?? null,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn(`[peer] upsert_peer failed sid=${sessionId} chat=${chatId}: ${r.status} ${t.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.warn(`[peer] upsert_peer error sid=${sessionId} chat=${chatId}: ${err?.message}`);
  }
}

// Best-effort: extract peer metadata from a GramJS entity and persist it.
async function persistEntityPeer(sessionId: string, chatId: number, entity: any): Promise<void> {
  try {
    const className: string | undefined = entity?.className;
    let peerType: string | null = null;
    let accessHash: string | null = null;

    if (className === "User") {
      peerType = "user";
      if (entity.accessHash !== undefined && entity.accessHash !== null) {
        accessHash = typeof entity.accessHash === "bigint" ? entity.accessHash.toString() : String(entity.accessHash);
      }
    } else if (className === "Channel" || className === "ChannelForbidden") {
      peerType = "channel";
      if (entity.accessHash !== undefined && entity.accessHash !== null) {
        accessHash = typeof entity.accessHash === "bigint" ? entity.accessHash.toString() : String(entity.accessHash);
      }
    } else if (className === "Chat" || className === "ChatForbidden") {
      peerType = "chat";
    } else {
      return;
    }

    const title =
      entity.title ??
      [entity.firstName, entity.lastName].filter(Boolean).join(" ") ??
      null;
    const username = entity.username ?? null;

    await upsertPeerToCloud(sessionId, chatId, peerType, accessHash, {
      chat_title: title || null,
      username,
    });
  } catch (err: any) {
    console.warn(`[peer] persistEntityPeer error sid=${sessionId} chat=${chatId}: ${err?.message}`);
  }
}

// Build an explicit InputPeer from stored metadata (used when GramJS cache is empty).
function buildInputPeerFromStored(stored: StoredPeer, chatId: number): any | null {
  const peerType = (stored.peer_type || stored.chat_type || "").toLowerCase();
  try {
    if (peerType === "user") {
      if (!stored.access_hash) return null;
      return new Api.InputPeerUser({
        userId: BigInt(chatId) as any,
        accessHash: BigInt(stored.access_hash) as any,
      });
    }
    if (peerType === "channel" || peerType === "supergroup") {
      if (!stored.access_hash) return null;
      // Channel IDs are stored as negative bigints in some clients; normalize to positive.
      const rawId = BigInt(chatId);
      const normalized = rawId < 0n ? -rawId : rawId;
      return new Api.InputPeerChannel({
        channelId: normalized as any,
        accessHash: BigInt(stored.access_hash) as any,
      });
    }
    if (peerType === "chat" || peerType === "group") {
      const rawId = BigInt(chatId);
      const normalized = rawId < 0n ? -rawId : rawId;
      return new Api.InputPeerChat({ chatId: normalized as any });
    }
  } catch (err: any) {
    console.warn(`[peer] buildInputPeerFromStored failed chat=${chatId}: ${err?.message}`);
  }
  return null;
}

// ── Live inbound message handler ────────────────────────────────────
async function postStoreMessage(payload: Record<string, unknown>): Promise<void> {
  if (!LOVABLE_SESSION_URL) return;
  const t0 = Date.now();
  try {
    const r = await fetch(LOVABLE_SESSION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "store_message", ...payload }),
    });
    const elapsed = Date.now() - t0;
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn(`[live-msg] store_message failed status=${r.status} elapsed_ms=${elapsed} body=${t.slice(0, 200)}`);
    } else {
      console.log(`[live-msg] store_message OK elapsed_ms=${elapsed} uid=${payload.update_id}`);
    }
  } catch (err: any) {
    console.warn(`[live-msg] store_message error: ${err?.message}`);
  }
}

const liveHandlerAttached = new WeakSet<TelegramClient>();

function attachLiveMessageHandler(sessionId: string, client: TelegramClient): void {
  if (liveHandlerAttached.has(client)) return;
  liveHandlerAttached.add(client);

  client.addEventHandler(async (update: any) => {
    try {
      const cls = update?.className;
      if (
        cls !== "UpdateNewMessage" &&
        cls !== "UpdateNewChannelMessage" &&
        cls !== "UpdateShortMessage" &&
        cls !== "UpdateShortChatMessage"
      ) {
        return;
      }

      const recvAt = Date.now();
      const msg: any = update.message ?? update;
      const isOut = !!msg.out;

      let chatId: number | null = null;
      const peer = msg.peerId ?? msg.toId ?? null;
      if (peer) {
        const peerCls: string = peer.className;
        if (peerCls === "PeerUser") chatId = Number(peer.userId);
        else if (peerCls === "PeerChannel") chatId = Number(peer.channelId);
        else if (peerCls === "PeerChat") chatId = Number(peer.chatId);
      } else if (typeof msg.userId !== "undefined") {
        chatId = Number(msg.userId);
      } else if (typeof msg.chatId !== "undefined") {
        chatId = Number(msg.chatId);
      }

      const msgId = Number(msg.id ?? 0);
      if (!chatId || !msgId) return;

      // Outbound messages are persisted by telegram-client-send (the direct send path).
      // Skip them here to avoid creating a second DB row with a different update_id.
      if (isOut) {
        console.log(`[live-msg] sid=${sessionId} skip outbound chat=${chatId} mid=${msgId} (handled by telegram-client-send)`);
        return;
      }

      const updateId = Math.abs(chatId * 1_000_000 + msgId);
      const text = typeof msg.message === "string" ? msg.message : null;
      const date = typeof msg.date === "number" ? msg.date : null;

      console.log(`[live-msg] sid=${sessionId} recv chat=${chatId} mid=${msgId} dir=inbound t=${recvAt}`);

      await postStoreMessage({
        session_id: sessionId,
        chat_id: chatId,
        update_id: updateId,
        direction: "inbound",
        text,
        sender_name: null,
        message_date: date,
        raw_update: { live: true, className: cls, message_id: msgId },
      });
    } catch (err: any) {
      console.warn(`[live-msg] handler error sid=${sessionId}: ${err?.message}`);
    }
  });

  console.log(`[live-msg] handler attached sid=${sessionId}`);
}

// Rehydrate a session from Lovable Cloud if not in memory (worker restart case)
async function getOrRehydrateSession(sessionId: string): Promise<LiveSession | null> {
  const existing = sessions.get(sessionId);
  if (existing && existing.client) {
    try {
      const sender = (existing.client as any)._sender;
      if (!sender || !sender.isConnected || !sender.isConnected()) {
        console.log(`[rehydrate] sid=${sessionId} live session present but not connected — reconnecting`);
        await connectWithTimeout(existing.client, 15000);
      }
    } catch (e: any) {
      console.warn(`[rehydrate] sid=${sessionId} reconnect check failed: ${e?.message}`);
    }
    attachLiveMessageHandler(sessionId, existing.client);
    return existing;
  }

  if (!LOVABLE_SESSION_URL) {
    console.error(`[rehydrate] sid=${sessionId} LOVABLE_SESSION_URL not set — cannot rehydrate`);
    return null;
  }

  console.log(`[rehydrate] sid=${sessionId} not in memory — fetching from Lovable Cloud`);
  try {
    const row = await fetchSessionFromCloud(sessionId);
    if (!row || !row.session_string) {
      console.error(`[rehydrate] sid=${sessionId} no row or empty session_string returned from cloud`);
      return null;
    }

    const stringSession = new StringSession(row.session_string);
    const client = new TelegramClient(stringSession, API_ID, API_HASH, {
      connectionRetries: 3,
      deviceModel: "Lovable CRM",
      appVersion: "1.0.0",
    });
    await connectWithTimeout(client, 15000);
    console.log(`[rehydrate] sid=${sessionId} connected OK`);

    const live: LiveSession = {
      client,
      state: "authorized",
      userId: row.user_id,
      sessionId: row.id,
      finalizeUrl: "",
      telegramName: row.telegram_name,
      telegramUsername: row.telegram_username,
      telegramUserId: row.telegram_user_id,
      phone: row.phone,
      eventFired: true,
      finalized: true,
      createdAt: Date.now(),
    };
    sessions.set(sessionId, live);
    attachLiveMessageHandler(sessionId, client);
    return live;
  } catch (err: any) {
    console.error(`[rehydrate] sid=${sessionId} error: ${err?.message}`);
    return null;
  }
}

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

// Auto-cleanup every 60s — only remove unauthorized stale sessions (QR flows that
// never completed). Authorized sessions stay resident so the live message handler
// keeps firing for inbound updates.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.state !== "authorized" && now - s.createdAt > 5 * 60 * 1000) {
      console.log(`[cleanup] Removing stale unauthorized session ${id}`);
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
    // Attach the live message handler immediately so inbound updates flow
    // through the bridge without waiting for the first /send call.
    try { attachLiveMessageHandler(session.sessionId, client); } catch (e: any) {
      console.warn(`[finalizeAuth] attach live handler warn: ${e?.message}`);
    }
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

// ── POST /send/:sessionId ──────────────────────────────────────────
// Send an outbound Telegram message via the live worker client.
// Body: { chat_id: number, text: string, reply_to_msg_id?: number }
app.post("/send/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { chat_id, text, reply_to_msg_id } = req.body || {};

  if (typeof chat_id !== "number" || typeof text !== "string" || !text.length) {
    return res.status(400).json({ error: "chat_id (number) and text (string) required" });
  }
  if (text.length > 4096) {
    return res.status(400).json({ error: "text too long (max 4096)" });
  }

  console.log(`\n[send] sid=${sessionId} chat_id=${chat_id} reply_to=${reply_to_msg_id ?? "none"} text_len=${text.length}`);

  try {
    const live = await getOrRehydrateSession(sessionId);
    if (!live) {
      console.error(`[send] sid=${sessionId} no live session and rehydrate failed`);
      return res.status(404).json({ error: "Session not found or could not be rehydrated" });
    }

    const client = live.client;

    // ── Resolve target peer using a 5-step fallback chain ─────────────
    // 1. client.getEntity(chat_id) — uses GramJS in-memory cache.
    // 2. Stored peer (peer_type + access_hash) from Lovable Cloud bridge.
    // 3. Construct explicit InputPeer{User|Channel|Chat}.
    // 4. Last resort: client.getDialogs() to repopulate cache, then retry getEntity.
    // 5. Clean error to UI with debug info.
    let target: any = null;
    let resolvedEntity: any = null;
    const tried: string[] = [];
    let stored: StoredPeer | null = null;
    let lastErr: string | null = null;

    // Step 1: getEntity
    try {
      tried.push("getEntity");
      console.log(`[send] sid=${sessionId} step1 getEntity chat_id=${chat_id}`);
      resolvedEntity = await client.getEntity(chat_id);
      target = resolvedEntity;
      const eid = typeof resolvedEntity?.id === "bigint" ? resolvedEntity.id.toString() : resolvedEntity?.id;
      console.log(`[send] sid=${sessionId} step1 OK className=${resolvedEntity?.className} id=${eid}`);
    } catch (e: any) {
      lastErr = e?.message || String(e);
      console.warn(`[send] sid=${sessionId} step1 getEntity failed: ${lastErr}`);
    }

    // Step 2 + 3: stored peer → explicit InputPeer
    if (!target) {
      tried.push("storedPeer");
      stored = await fetchPeerFromCloud(sessionId, chat_id);
      console.log(
        `[send] sid=${sessionId} step2 stored peer: ${
          stored ? `peer_type=${stored.peer_type || stored.chat_type} has_access_hash=${!!stored.access_hash}` : "none"
        }`
      );
      if (stored) {
        const inputPeer = buildInputPeerFromStored(stored, chat_id);
        if (inputPeer) {
          tried.push("inputPeer");
          target = inputPeer;
          console.log(`[send] sid=${sessionId} step3 built InputPeer className=${inputPeer.className}`);
        }
      }
    }

    // Step 4: getDialogs refresh + retry
    if (!target) {
      tried.push("getDialogsRefresh");
      console.log(`[send] sid=${sessionId} step4 refreshing dialogs to repopulate entity cache`);
      try {
        const dialogs: any = await client.getDialogs({ limit: 500 });
        console.log(`[send] sid=${sessionId} step4 fetched ${dialogs?.length ?? 0} dialogs`);
        // Persist any peer metadata we just learned about.
        try {
          for (const d of dialogs || []) {
            const ent = d?.entity;
            const idVal = ent?.id;
            const idNum =
              typeof idVal === "bigint" ? Number(idVal) : typeof idVal === "number" ? idVal : null;
            if (idNum !== null) {
              await persistEntityPeer(sessionId, idNum, ent);
            }
          }
        } catch (persistAllErr: any) {
          console.warn(`[send] sid=${sessionId} step4 dialog persist warn: ${persistAllErr?.message}`);
        }

        try {
          resolvedEntity = await client.getEntity(chat_id);
          target = resolvedEntity;
          console.log(`[send] sid=${sessionId} step4 retry getEntity OK className=${resolvedEntity?.className}`);
        } catch (e2: any) {
          lastErr = e2?.message || String(e2);
          console.warn(`[send] sid=${sessionId} step4 retry getEntity failed: ${lastErr}`);
        }
      } catch (dialogErr: any) {
        console.warn(`[send] sid=${sessionId} step4 getDialogs failed: ${dialogErr?.message}`);
      }
    }

    // Step 4.5: ResolveUsername fallback — when stored row has username but no access_hash.
    if (!target) {
      tried.push("resolveUsername");
      try {
        if (!stored) {
          stored = await fetchPeerFromCloud(sessionId, chat_id);
        }
        const uname = stored?.username || null;
        console.log(`[send] sid=${sessionId} step4.5 resolveUsername uname=${uname || "none"}`);
        if (uname) {
          const resolved: any = await client.invoke(
            new Api.contacts.ResolveUsername({ username: uname })
          );
          const users = resolved?.users || [];
          const chats = resolved?.chats || [];
          // Find the matching entity
          let matched: any = null;
          for (const u of users) {
            const uid = typeof u?.id === "bigint" ? Number(u.id) : u?.id;
            if (uid === chat_id) { matched = u; break; }
          }
          if (!matched) {
            for (const c of chats) {
              const cid = typeof c?.id === "bigint" ? Number(c.id) : c?.id;
              if (cid === chat_id) { matched = c; break; }
            }
          }
          // Fallback: take the first user/chat returned
          if (!matched && users.length > 0) matched = users[0];
          if (!matched && chats.length > 0) matched = chats[0];

          if (matched) {
            console.log(`[send] sid=${sessionId} step4.5 resolved className=${matched.className} hasAccessHash=${matched.accessHash != null}`);
            // Persist learned access_hash for next time
            const matchedId = typeof matched.id === "bigint" ? Number(matched.id) : matched.id;
            await persistEntityPeer(sessionId, matchedId, matched);
            // Build InputPeer from this entity
            if (matched.className === "User" && matched.accessHash != null) {
              target = new Api.InputPeerUser({
                userId: BigInt(matchedId) as any,
                accessHash: typeof matched.accessHash === "bigint" ? matched.accessHash : BigInt(matched.accessHash) as any,
              });
              resolvedEntity = matched;
            } else if ((matched.className === "Channel" || matched.className === "ChannelForbidden") && matched.accessHash != null) {
              target = new Api.InputPeerChannel({
                channelId: BigInt(matchedId) as any,
                accessHash: typeof matched.accessHash === "bigint" ? matched.accessHash : BigInt(matched.accessHash) as any,
              });
              resolvedEntity = matched;
            }
          } else {
            console.warn(`[send] sid=${sessionId} step4.5 ResolveUsername returned no users/chats`);
          }
        }
      } catch (resolveErr: any) {
        console.warn(`[send] sid=${sessionId} step4.5 ResolveUsername failed: ${resolveErr?.message}`);
      }
    }

    // Step 5: clean error
    if (!target) {
      const debug = {
        tried,
        peer_known: !!stored,
        had_access_hash: !!stored?.access_hash,
        peer_type: stored?.peer_type || stored?.chat_type || null,
        had_username: !!stored?.username,
      };
      console.error(`[send] sid=${sessionId} entity resolution FAILED chat=${chat_id} debug=${JSON.stringify(debug)} last=${lastErr}`);
      return res.status(400).json({
        error: `entity resolution failed for chat ${chat_id} (peer_type=${debug.peer_type || "unknown"}, access_hash=${debug.had_access_hash ? "present" : "missing"}, username=${debug.had_username ? "present" : "missing"}): ${lastErr || "unknown"}`,
        chat_id: String(chat_id),
        peer_type: debug.peer_type,
        had_access_hash: debug.had_access_hash,
        had_username: debug.had_username,
        tried: debug.tried,
        telegram_error: lastErr,
      });
    }

    // Send the message
    let result: any;
    try {
      const sendOpts: any = { message: text };
      if (typeof reply_to_msg_id === "number") sendOpts.replyTo = reply_to_msg_id;
      result = await client.sendMessage(target, sendOpts);
      console.log(`[send] sid=${sessionId} sendMessage OK message_id=${result?.id} date=${result?.date}`);
    } catch (sendErr: any) {
      const msg = sendErr?.message || String(sendErr);
      console.error(`[send] sid=${sessionId} sendMessage FAILED: ${msg}`);
      return res.status(502).json({ error: `sendMessage failed: ${msg}` });
    }

    // After successful send, persist resolved entity peer back (insurance for future restarts).
    try {
      if (resolvedEntity) {
        await persistEntityPeer(sessionId, chat_id, resolvedEntity);
      } else if (!stored?.access_hash) {
        // We sent via InputPeer with stored hash — nothing new to learn.
      }
    } catch (peerPersistErr: any) {
      console.warn(`[send] sid=${sessionId} post-send peer persist warn: ${peerPersistErr?.message}`);
    }

    // Persist (possibly rotated) session string back to Lovable Cloud — best effort
    try {
      const newSessionString = (client.session as StringSession).save();
      if (newSessionString) {
        await persistSessionStringToCloud(sessionId, newSessionString);
      }
    } catch (persistErr: any) {
      console.warn(`[send] sid=${sessionId} session persist failed (non-fatal): ${persistErr?.message}`);
    }

    return res.json({
      ok: true,
      message_id: typeof result?.id === "bigint" ? Number(result.id) : result?.id,
      date: typeof result?.date === "bigint" ? Number(result.date) : result?.date,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[send] sid=${sessionId} unexpected error: ${msg}`);
    return res.status(500).json({ error: msg });
  }
});

// ── POST /send-media/:sessionId ────────────────────────────────────
// Body: { chat_id: number, media_url: string, file_name: string, media_type: "image"|"video", mime_type?: string, caption?: string, spoiler?: boolean }
app.post("/send-media/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { chat_id, media_url, file_name, media_type, mime_type, caption, parse_mode, spoiler } = req.body || {};
  const cleanCaption = typeof caption === "string" && caption.trim().length > 0 ? caption : undefined;
  const useSpoiler = spoiler === true;
  const cleanParseMode =
    typeof parse_mode === "string" && ["html", "md", "markdown"].includes(parse_mode.toLowerCase())
      ? parse_mode.toLowerCase()
      : undefined;

  if (typeof chat_id !== "number" || typeof media_url !== "string" || !media_url || !file_name || !media_type) {
    return res.status(400).json({ error: "chat_id, media_url, file_name, media_type required" });
  }

  console.log(`[send-media] sid=${sessionId} chat_id=${chat_id} type=${media_type} file=${file_name} spoiler=${useSpoiler}`);

  try {
    const live = await getOrRehydrateSession(sessionId);
    if (!live) {
      return res.status(404).json({ error: "Session not found or could not be rehydrated" });
    }
    const client = live.client;

    // Resolve target peer (reuse 5-step logic, simplified)
    let target: any = null;
    let resolvedEntity: any = null;
    let stored: StoredPeer | null = null;
    let lastErr: string | null = null;

    try {
      resolvedEntity = await client.getEntity(chat_id);
      target = resolvedEntity;
    } catch (e: any) {
      lastErr = e?.message || String(e);
    }

    if (!target) {
      stored = await fetchPeerFromCloud(sessionId, chat_id);
      if (stored) {
        const inputPeer = buildInputPeerFromStored(stored, chat_id);
        if (inputPeer) target = inputPeer;
      }
    }

    if (!target) {
      try {
        await client.getDialogs({ limit: 200 });
        resolvedEntity = await client.getEntity(chat_id);
        target = resolvedEntity;
      } catch (e: any) {
        lastErr = e?.message || String(e);
      }
    }

    if (!target) {
      return res.status(400).json({ error: `entity resolution failed: ${lastErr || "unknown"}` });
    }

    // Download media from signed URL
    let buffer: Buffer;
    try {
      const r = await fetch(media_url);
      if (!r.ok) {
        return res.status(502).json({ error: `media download failed: ${r.status}` });
      }
      const ab = await r.arrayBuffer();
      buffer = Buffer.from(ab);
      console.log(`[send-media] sid=${sessionId} downloaded ${buffer.length} bytes`);
    } catch (dlErr: any) {
      return res.status(502).json({ error: `media download error: ${dlErr?.message}` });
    }

    // Build CustomFile for GramJS
    const { CustomFile } = await import("telegram/client/uploads.js");
    const customFile = new CustomFile(file_name, buffer.length, "", buffer);

    let result: any;
    try {
      result = await client.sendFile(target, {
        file: customFile,
        forceDocument: false,
        videoNote: false,
        supportsStreaming: media_type === "video",
        ...(useSpoiler ? { spoiler: true } : {}),
        ...(cleanCaption ? { caption: cleanCaption } : {}),
        ...(cleanParseMode ? { parseMode: cleanParseMode } : {}),
      });
      if (useSpoiler) console.log(`[send-media] sid=${sessionId} sent with native spoiler blur`);
      console.log(`[send-media] sid=${sessionId} sendFile OK message_id=${result?.id}`);
    } catch (sendErr: any) {
      const msg = sendErr?.message || String(sendErr);
      console.error(`[send-media] sid=${sessionId} sendFile FAILED: ${msg}`);
      return res.status(502).json({ error: `sendFile failed: ${msg}` });
    }

    try {
      if (resolvedEntity) await persistEntityPeer(sessionId, chat_id, resolvedEntity);
    } catch {}

    try {
      const newSessionString = (client.session as StringSession).save();
      if (newSessionString) await persistSessionStringToCloud(sessionId, newSessionString);
    } catch {}

    return res.json({
      ok: true,
      message_id: typeof result?.id === "bigint" ? Number(result.id) : result?.id,
      date: typeof result?.date === "bigint" ? Number(result.date) : result?.date,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[send-media] sid=${sessionId} unexpected error: ${msg}`);
    return res.status(500).json({ error: msg });
  }
});

// ── POST /delete-message/:sessionId ────────────────────────────────
// Delete a message from a chat. With revoke=true, deletes for both sides
// (sender + recipient) on Telegram. Body: { chat_id, message_id, revoke? }
app.post("/delete-message/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { chat_id, message_id, revoke } = req.body || {};

  if (typeof chat_id !== "number" || typeof message_id !== "number") {
    return res.status(400).json({ error: "chat_id and message_id (numbers) required" });
  }

  console.log(`[delete-msg] sid=${sessionId} chat=${chat_id} mid=${message_id} revoke=${revoke !== false}`);

  try {
    const live = await getOrRehydrateSession(sessionId);
    if (!live) {
      return res.status(404).json({ error: "Session not found or could not be rehydrated" });
    }

    const client = live.client;

    // Resolve target peer (reuse same fallback chain as /send, simplified)
    let target: any = null;
    let resolvedEntity: any = null;
    try {
      resolvedEntity = await client.getEntity(chat_id);
      target = resolvedEntity;
    } catch (e: any) {
      console.warn(`[delete-msg] sid=${sessionId} getEntity failed: ${e?.message}`);
    }

    if (!target) {
      const stored = await fetchPeerFromCloud(sessionId, chat_id);
      if (stored) {
        const inputPeer = buildInputPeerFromStored(stored, chat_id);
        if (inputPeer) target = inputPeer;
      }
    }

    if (!target) {
      try {
        await client.getDialogs({ limit: 200 });
        resolvedEntity = await client.getEntity(chat_id);
        target = resolvedEntity;
      } catch (e: any) {
        console.warn(`[delete-msg] sid=${sessionId} dialog refresh failed: ${e?.message}`);
      }
    }

    if (!target) {
      return res.status(400).json({ error: `entity resolution failed for chat ${chat_id}` });
    }

    try {
      await client.deleteMessages(target, [message_id], { revoke: revoke !== false });
      console.log(`[delete-msg] sid=${sessionId} delete OK mid=${message_id}`);
    } catch (delErr: any) {
      const msg = delErr?.message || String(delErr);
      console.error(`[delete-msg] sid=${sessionId} delete FAILED: ${msg}`);
      return res.status(502).json({ error: `deleteMessages failed: ${msg}` });
    }

    try {
      const newSessionString = (client.session as StringSession).save();
      if (newSessionString) await persistSessionStringToCloud(sessionId, newSessionString);
    } catch {}

    return res.json({ ok: true });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[delete-msg] sid=${sessionId} unexpected error: ${msg}`);
    return res.status(500).json({ error: msg });
  }
});

// ── Start server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Telegram Worker running on port ${PORT}`);
  console.log(`   API_ID: ${API_ID}`);
  console.log(`   Active sessions: ${sessions.size}`);
});

