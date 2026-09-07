/**
 * cline2api - Cloudflare Workers edition
 *
 * Reverse-engineered from https://github.com/luawei1/cline2api (a Go reverse proxy)
 *
 * Core logic:
 *  1. Exchange the refreshToken for an accessToken on every request (cached in memory, auto-refreshed when expired)
 *  2. Forward OpenAI / Anthropic requests to https://api.cline.bot/api/v1/chat/completions
 *  3. Strip the upstream {data:{...}} wrapper from SSE streaming responses before passing them through to the client
 *
 * Environment variables:
 *  - CLINE_REFRESH_TOKEN (required)   Cline account refreshToken
 *  - API_KEY                (optional) Custom access key; if unset a random one is generated per deployment and printed to logs
 *
 * Usage (OpenAI-compatible):
 *   curl https://your-worker/v1/chat/completions \
 *     -H "Authorization: Bearer <API_KEY>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"cline/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
 */

const CLINE_API_BASE = "https://api.cline.bot/api/v1";

// Account pool: supports multiple Cline accounts, each with its own accessToken cache.
// The CLINE_REFRESH_TOKEN env var can contain multiple lines, one refreshToken per line;
// accounts rotate automatically when quota runs out (empty response).
// Shape: { refreshToken, accessToken, expiry, cooldownUntil }
let accounts = [];
let accountIndex = 0;          // round-robin cursor
let currentAccount = null;     // account currently in use (safe under the serial queue)

// Model list: uses the full model IDs returned by Cline's /v1/models as-is.
// No artificial cline/ prefix is added; Telegram displays these full IDs,
// avoiding confusion when different providers' model names get truncated.
const MODELS = [
  // Latest free GLM multimodal model (added 2026-08-25) — Cline's current free tier.
  { id: "z-ai/glm-5.3-flash", upstream: "z-ai/glm-5.3-flash", provider: "z-ai", cost: "free" },
  // Stealth preview model ("Ox Alpha"; early free access) — kept for backward compatibility.
  { id: "stealth/ox-alpha", upstream: "stealth/ox-alpha", provider: "stealth", cost: "free" },
  { id: "deepseek/deepseek-v4-flash", upstream: "deepseek/deepseek-v4-flash", provider: "deepseek", cost: "free" },
  { id: "poolside/laguna-s-2.1:free", upstream: "poolside/laguna-s-2.1:free", provider: "poolside", cost: "free" },
  { id: "cline-pass/glm-5.2", upstream: "cline-pass/glm-5.2", provider: "zai", cost: "pass" },
  { id: "cline-pass/deepseek-v4-flash", upstream: "cline-pass/deepseek-v4-flash", provider: "deepseek", cost: "pass" },
  { id: "cline-pass/qwen3.7-max", upstream: "cline-pass/qwen3.7-max", provider: "qwen", cost: "pass" },
];

// Default model: Cline's free DeepSeek channel (full headers + forced streaming, fixed)
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const VERSION = "1.4.0";

// Loose spellings clients commonly send, mapped to canonical model IDs
const MODEL_ALIASES = {
  "ox-alpha": "stealth/ox-alpha",
  "0x-alpha": "stealth/ox-alpha",
  "0xalpha": "stealth/ox-alpha",
  "oxalpha": "stealth/ox-alpha",
  "x-preview-f-free": "stealth/ox-alpha",
  "glm-5.3-flash": "z-ai/glm-5.3-flash",
  "zai/glm-5.3-flash": "z-ai/glm-5.3-flash",
  "z-ai/glm-5.3-flash": "z-ai/glm-5.3-flash",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "depth/deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "laguna-s-2.1": "poolside/laguna-s-2.1:free",
  "laguna-s-2.1-free": "poolside/laguna-s-2.1:free",
};

// Resolve a client-supplied model name into a MODELS entry.
// Order: exact ID → alias table → slug match (ignores prefix/suffix/case/spelling of "0x").
// NOT STRICT: anything else is forwarded verbatim and upstream decides
// (only an empty model falls back to the default).
function resolveModel(raw) {
  const input = String(raw || "").trim();
  if (!input) return null;

  const byId = MODELS.find((m) => m.id === input);
  if (byId) return byId;

  // Normalize for comparison: lowercase, spaces/underscores → dashes, "0x" → "ox", drop ":free"-style suffixes
  const canon = (s) => s.split(":")[0].trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/^0x/, "ox");

  const aliased = MODEL_ALIASES[canon(input)];
  if (aliased) {
    return MODELS.find((m) => m.id === aliased) || { id: aliased, upstream: aliased };
  }

  const slug = canon(input.split("/").pop());
  const matched = MODELS.find((m) => canon(m.upstream.split("/").pop()) === slug);
  if (matched) return matched;

  return { id: input, upstream: input }; // unknown: forward as-is, upstream decides
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Health/diagnostic endpoint (no auth; used to check whether env vars are configured)
    if (request.method === "GET" && url.pathname === "/v1/health") {
      const poolN = parseAccounts(env).length;
      return jsonResponse({
        ok: true,
        version: VERSION,
        authenticated: !!(env.API_KEY),
        accounts: poolN,
        model: DEFAULT_MODEL,
      }, 200);
    }

    // Per-account quota/usage tracking (requires API key). Shows which accounts are
    // cooling with their daily-reset countdown, plus lifetime counters. No tokens exposed.
    if (request.method === "GET" && url.pathname === "/v1/accounts") {
      const key = getApiKey(request, env);
      if (!key) {
        return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
      }
      const pool = parseAccounts(env);
      await dbEnsure(env, pool.length);
      const rows = (await dbRows(env)) || [];
      const now = Date.now();
      const list = pool.map((_, i) => {
        const r = rows.find((x) => x.idx === i) || {};
        // Cooldown is the daily-quota reset countdown: eligible again once it passes
        const until = Math.max(r.cooldown_until || 0, pool[i].cooldownUntil || 0);
        const cooling = until > now;
        return {
          account: `${i + 1}/${pool.length}`,
          status: cooling ? "cooling" : "ok",
          reset_in_seconds: cooling ? Math.ceil((until - now) / 1000) : 0,
          total_requests: r.total_requests || 0,
          total_429s: r.total_429s || 0,
          total_errors: r.total_errors || 0,
          last_used_at: r.last_used_at || 0,
          last_error: r.last_error || "",
        };
      });
      return jsonResponse({
        ok: true,
        time: now,
        persistent: !!(env.DB),
        db_last_error: dbLastError,
        eligible: list.filter((a) => a.status === "ok").length,
        accounts: list,
      }, 200);
    }

    // Global auth: every endpoint requires an API key (except OPTIONS preflight).
    // If API_KEY is not configured, the built-in default key "cline2api-default-key" is used.
    // (Optional) Setting API_KEY="" disables authentication entirely.
    // GET /v1/models
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      const key = getApiKey(request, env);
      if (!key) {
        return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
      }
      return handleModels();
    }

    // POST chat endpoints
    if (request.method === "POST") {
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
        return handleChat(request, env);
      }
      if (url.pathname === "/v1/messages" || url.pathname === "/messages") {
        return handleAnthropic(request, env);
      }
    }

    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  },

  // Quota checker (cron, every 5 min — see [triggers] in wrangler.toml).
  // Re-verifies accounts whose recorded reset time is due: still-limited accounts
  // get a fresh countdown, restored ones are cleared so requests flow to them again.
  // This + failure-triggered saves are the ONLY D1 users; normal requests never touch D1.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const pool = parseAccounts(env);
        if (pool.length === 0 || !env.DB) return;
        await dbEnsure(env, pool.length);
        const rows = await dbRows(env);
        if (!rows) return;
        const now = Date.now();
        for (const r of rows) {
          const until = r.cooldown_until || 0;
          // Probe only accounts with a recorded reset that is due (or overdue)
          if (until > 0 && until - now <= 5 * 60 * 1000) {
            await probeAccountQuota(env, r.idx);
            await sleep(1000); // gentle pacing between probes
          }
        }
      } catch (e) {}
    })());
  },
};

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

// Parse the account pool from the environment: one token per line in CLINE_REFRESH_TOKEN
function parseAccounts(env) {
  const raw = env.CLINE_REFRESH_TOKEN || "";
  const tokens = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 8);
  if (tokens.length === 0) return [];

  // If the token list changed (accounts added/removed), rebuild the pool
  const changed =
    accounts.length !== tokens.length ||
    accounts.some((a, i) => a.refreshToken !== tokens[i]);
  if (changed) {
    accounts = tokens.map((rt) => ({
      refreshToken: rt,
      accessToken: null,
      expiry: 0,
      cooldownUntil: 0,
    }));
  }
  return accounts;
}

// Get the current account's accessToken (cached independently; refreshed when expired or cooling)
async function getAccountToken(account) {
  const now = Date.now();
  // Not usable while cooling down
  if (account.cooldownUntil > now) {
    throw new Error("account_cooldown");
  }
  if (account.accessToken && now < account.expiry) {
    return account.accessToken;
  }
  const resp = await fetch(CLINE_API_BASE + "/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refreshToken: account.refreshToken,
      grantType: "refresh_token",
    }),
  });
  if (!resp.ok) {
    // Refresh failed: cool down for 60s, let the caller switch accounts
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_failed");
  }
  const data = await resp.json();
  const accessToken = data?.data?.accessToken;
  if (!accessToken) {
    account.cooldownUntil = now + 60 * 1000;
    throw new Error("refresh_no_token");
  }
  account.accessToken = accessToken;
  // Cline rotates the refreshToken on refresh; the new token must be saved to avoid invalid_grant on the next refresh.
  if (typeof data?.data?.refreshToken === "string" && data.data.refreshToken.trim()) {
    account.refreshToken = data.data.refreshToken.trim();
  }
  // Expiry: prefer the server-provided value, fall back to 10 minutes minus a 60s safety margin
  const expiresAt = data?.data?.expiresAt;
  let expiry = now + 10 * 60 * 1000;
  if (typeof expiresAt === "number") {
    expiry = expiresAt;
  } else if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!isNaN(t)) expiry = t;
  }
  account.expiry = expiry - 60000;
  return accessToken;
}

async function getAccessToken(env) {
  const pool = parseAccounts(env);
  if (pool.length === 0) {
    throw new Error("Missing CLINE_REFRESH_TOKEN environment variable");
  }
  // HOT PATH = ZERO D1. Pure in-memory rotation only. D1 is touched exclusively
  // on failures (persist reset time) and by the 5-minute quota-checker cron —
  // normal requests never wait on the database.
  // Rotate the starting account on EVERY request for even quota burn.
  const start = accountIndex % pool.length;
  accountIndex = (accountIndex + 1) % pool.length;
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const acc = pool[(start + attempt) % pool.length]; // rotate + walk forward
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) continue;
    currentAccount = acc;
    try {
      return await getAccountToken(acc);
    } catch (e) {
      if (e.message === "account_cooldown") continue;
      continue; // refresh failed too: move to the next account
    }
  }
  // Everything failed: clear cooldown and retry the first account once
  const acc = pool[0];
  currentAccount = acc;
  acc.cooldownUntil = 0;
  try {
    return await getAccountToken(acc);
  } catch (e) {
    throw new Error("All accounts failed to refresh tokens");
  }
}

// ---------------------------------------------------------------------------
// Persistent account state (Cloudflare D1) — survives isolates/restarts and is
// shared across all requests. Tracks per-account quota cooldowns (daily reset
// countdowns), usage counters and errors. Every function below is a safe no-op
// when no D1 binding exists (env.DB undefined), falling back to in-memory only.
// ---------------------------------------------------------------------------

let dbCache = { at: 0, rows: null };
const DB_CACHE_TTL_MS = 30000; // short read cache; invalidated on every write
let dbLastError = ""; // last D1 failure reason (surfaced via /v1/accounts for debugging)

function dbNoteError(e) {
  dbLastError = String((e && e.message) || e || "unknown").slice(0, 200);
}

function dbInvalidate() {
  dbCache = { at: 0, rows: null };
}

// Read all account rows (cached briefly). Returns null when D1 is unavailable.
async function dbRows(env) {
  if (!env.DB) return null;
  const now = Date.now();
  if (dbCache.rows && now - dbCache.at < DB_CACHE_TTL_MS) return dbCache.rows;
  try {
    const res = await env.DB.prepare("SELECT * FROM accounts").all();
    dbCache = { at: now, rows: res.results || [] };
    return dbCache.rows;
  } catch (e) {
    dbNoteError(e);
    return null; // table missing etc: degrade to in-memory
  }
}

// Make sure a row exists for every pool position (new accounts appear automatically).
// Skips the write entirely when cached rows already cover the pool (saves D1 quota).
async function dbEnsure(env, n) {
  if (!env.DB) return;
  try {
    const rows = await dbRows(env);
    if (rows && rows.length >= n) return; // nothing to do
    await env.DB.batch(
      Array.from({ length: n }, (_, i) =>
        env.DB.prepare("INSERT OR IGNORE INTO accounts (idx) VALUES (?)").bind(i)
      )
    );
    dbInvalidate();
  } catch (e) {
    dbNoteError(e);
  }
}

// Persist a cooldown + bump counters. kind: "rate" (429/quota) or "error" (empty/failed).
async function dbMarkCooldown(env, idx, untilMs, kind, detail) {
  if (!env.DB) return;
  try {
    const col = kind === "rate" ? "total_429s" : "total_errors";
    await env.DB.prepare(
      `UPDATE accounts SET cooldown_until = ?, ${col} = ${col} + 1, last_error = ? WHERE idx = ?`
    ).bind(untilMs, String(detail || kind).slice(0, 200), idx).run();
    dbInvalidate();
  } catch (e) {
    dbNoteError(e);
  }
}

// Clear a cooldown after the quota-reset probe succeeds (account usable again)
async function dbClearCooldown(env, idx) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      "UPDATE accounts SET cooldown_until = 0, last_error = 'quota restored (cron probe)' WHERE idx = ?"
    ).bind(idx).run();
    dbInvalidate();
  } catch (e) {
    dbNoteError(e);
  }
}

// Which pool position served the current request, e.g. "3/7" (for the X-Cline-Account debug header)
function servingAccountLabel(env) {
  const pool = parseAccounts(env);
  const i = currentAccount ? pool.indexOf(currentAccount) : -1;
  return (i >= 0 ? i + 1 : "?") + "/" + pool.length;
}

// Cline client fingerprint headers (the official side uses these to identify "is this a real Cline client")
// Missing headers trigger 403: "deepseek/deepseek-v4-flash is only available via Cline product surfaces"
function clineHeaders(sessionId) {
  return {
    Authorization: "Bearer workos:" + currentToken,
    "Content-Type": "application/json",
    "User-Agent": "Cline/3.0.47",
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-IS-MULTIROOT": "false",
    "X-CLIENT-TYPE": "cline-sdk",
    "X-CLIENT-VERSION": "3.0.47",
    "X-PLATFORM": "terminal",
    "X-PLATFORM-VERSION": "3.0.47",
    "X-CORE-VERSION": "0.0.66",
    "X-Task-ID": sessionId,
  };
}

// The current account's accessToken (used by clineHeaders)
let currentToken = "";

async function clineFetch(env, path, bodyObj, sessionId, retried = false) {
  const acc = currentAccount || null;
  const token = await getAccessToken(env);
  currentToken = token;
  const headers = clineHeaders(sessionId);
  headers.Authorization = "Bearer workos:" + token;
  const resp = await fetch(CLINE_API_BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });
  if (resp.status === 401 && !retried) {
    // Token invalid: mark the current account as cooling down and force a retry (another account / refresh will be used)
    if (currentAccount) {
      currentAccount.cooldownUntil = Date.now() + 60 * 1000;
      currentAccount.accessToken = null;
      currentAccount.expiry = 0;
    }
    return clineFetch(env, path, bodyObj, sessionId, true);
  }
  return resp;
}

// Probe one account's live quota with a minimal 1-token request (5-minute cron only,
// never on the request path). 429 → still exhausted: persist the fresh reset time.
// 2xx → quota restored: clear the cooldown so traffic flows to it again.
// Anything else → leave state untouched for the next check.
async function probeAccountQuota(env, poolIdx) {
  const pool = parseAccounts(env);
  const acc = pool[poolIdx];
  if (!acc) return;
  currentAccount = acc;
  let token;
  try {
    token = await getAccountToken(acc);
  } catch (e) {
    const until = Date.now() + 5 * 60 * 1000;
    acc.cooldownUntil = until;
    await dbMarkCooldown(env, poolIdx, until, "error", "cron probe: refresh failed");
    return;
  }
  currentToken = token;
  const headers = clineHeaders("cron-probe");
  headers.Authorization = "Bearer workos:" + token;
  let resp;
  try {
    resp = await fetch(CLINE_API_BASE + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1,
        session_id: "cron-probe",
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
  } catch (e) {
    return; // network blip: leave state as-is, retry next cron
  }
  if (resp.status === 429) {
    const text = await resp.text().catch(() => "");
    const ms = parseCooldown(text, resp.status);
    acc.cooldownUntil = Date.now() + ms;
    await dbMarkCooldown(env, poolIdx, Date.now() + ms, "rate",
      `cron probe: still limited, resets in ${Math.round(ms / 1000)}s`);
    return;
  }
  try { await resp.body.cancel(); } catch (e) {}
  if (resp.ok) {
    acc.cooldownUntil = 0;
    await dbClearCooldown(env, poolIdx);
  }
  // Other statuses (400/403/5xx): leave state untouched, retry next cron
}

// ---------------------------------------------------------------------------
// Concurrency queue: the upstream free channel returns empty responses when
// concurrency exceeds 1, so requests are forced serial with a minimum gap
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve(); // tail of the global serial queue
const MIN_GAP_MS = 800;            // minimum interval between two upstream requests

function enqueue(fn) {
  // After the previous task finishes, wait for the gap, then run fn
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn);
  // Keep the chain going on success or failure, so the queue never breaks
  queueTail = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Parse the wait time from upstream 429/rate-limit responses, returns milliseconds
// Supported formats: "Try again in 2h 51m" / "Try again in 30m" / "Try again in 1h" / "Try again in 15s"
function parseCooldown(body, status) {
  const m = (body || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseInt(m[3] || 0, 10);
    const ms = (h * 3600 + min * 60 + s) * 1000;
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000); // cap at 6 hours
  }
  // 429 defaults to 5 minutes; empty response defaults to 60 seconds
  if (status === 429) return 5 * 60 * 1000;
  return 60 * 1000;
}

// clineFetch with retries: auto-switch accounts + exponential backoff on 429 rate limits / empty responses / 5xx.
// When an account's quota is exhausted or rate-limited (429 Daily free limit reached):
//   - Cool that account down (duration parsed from the upstream hint, e.g. 2h51m)
//   - Automatically rotate to the next account and retry the same request
// When all accounts are cooling down, return the original response as-is (no spinning)
async function clineFetchWithRetry(env, path, bodyObj, sessionId, isStream = false, maxRetries = 4) {
  let lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Run through the queue serially to avoid concurrent empty responses
    const resp = await enqueue(() => clineFetch(env, path, bodyObj, sessionId));
    lastResp = resp;

    // Read the body uniformly (clone doesn't consume the stream)
    let bodyText = "";
    try {
      bodyText = await resp.clone().text();
    } catch (e) {}

    // Detect "quota/rate limit" signals (need to switch accounts):
    // 1. 429 (Daily free limit reached / rate limit)
    // 2. 5xx containing "empty response content"
    // 3. 200 non-streaming but the body is an empty-response wrapper
    const isLimitHit =
      resp.status === 429 ||
      (resp.status >= 500 && bodyText.includes("empty response content")) ||
      (resp.ok && !isStream && bodyText.includes("empty response content"));

    if (isLimitHit) {
      const cooldownMs = parseCooldown(bodyText, resp.status);
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + cooldownMs;
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        // Persist the quota cooldown (daily-reset countdown) so ALL isolates skip this account until reset
        const pool = parseAccounts(env);
        await dbMarkCooldown(env, pool.indexOf(currentAccount), Date.now() + cooldownMs, "rate",
          `429/quota, resets in ${Math.round(cooldownMs / 1000)}s`);
        console.log(`[account-switch] account quota/rate-limited, cooling down ${Math.round(cooldownMs / 1000)}s, switching to the next one`);
      }
      // Other accounts still available → short backoff then retry (switches to the next account)
      const pool = parseAccounts(env);
      const hasOther = pool.some((a) => !a.cooldownUntil || a.cooldownUntil <= Date.now());
      if (!hasOther) {
        console.log(`[retry] all accounts cooling down, returning upstream response as-is`);
        return resp; // no spinning; pass the 429/error back to the client
      }
      await sleep(500 + Math.floor(Math.random() * 500));
      continue;
    }

    // Normal response (200)
    if (resp.ok) {
      if (isStream) return resp; // streaming: forward directly
      return resp;               // non-streaming: body confirmed not an empty response
    }

    // Other errors (403/400/401 etc.) are not retried, returned as-is
    return resp;
  }
  // Retries exhausted: return the last response
  return lastResp;
}

// ---------------------------------------------------------------------------
// OpenAI protocol
// ---------------------------------------------------------------------------

async function handleChat(request, env) {
  // API key authentication
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let params;
  try {
    params = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!params.stream;
  const sessionId = "sess_" + Date.now();
  const modelConfig = resolveModel(params.model) || MODELS.find((m) => m.id === DEFAULT_MODEL);
  const model = modelConfig.id;
  const upstreamModel = modelConfig.upstream;

  // Build the upstream body (external model IDs kept separate from Cline upstream IDs)
  const body = {
    model: upstreamModel,
    max_tokens: params.max_tokens || params.max_completion_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: params.reasoning_effort || params.reasoningEffort || "high",
    messages: params.messages || [],
  };
  // ⚠️ Free channels (deepseek, stealth, z-ai, cline-free): non-streaming requests get rate-limited upstream (500 empty response content)
  //    while streaming works. So when the client asks for non-streaming, force stream toward
  //    upstream and aggregate the chunks back into a non-streaming response.
  const forceStream = !isStream && /^(deepseek|stealth|z-ai|cline-free)\//.test(upstreamModel);
  if (isStream || forceStream) body.stream = true;
  // Pass through optional parameters
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
    if (params[k] !== undefined) body[k] = params[k];
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // Client wants streaming: pass the SSE through directly
      return streamResponse(resp, model, { "X-Cline-Account": servingAccountLabel(env) });
    }
    if (forceStream) {
      // Client wants non-streaming + upstream is streaming: aggregate chunks and return
      // ⚠️ The free channel (deepseek/cline-free) can occasionally return an "HTTP 200 but content empty all along"
      //    stream (100 chunks of pure reasoning, no real content). Content is checked here: retry on another account if empty.
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      retried.data.model = model;
      return jsonResponse(retried.data, 200, { "X-Cline-Account": servingAccountLabel(env) });
    }
    // Non-streaming + non-deepseek: original logic
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    normalized.model = model;
    return jsonResponse(normalized, 200, { "X-Cline-Account": servingAccountLabel(env) });
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// Aggregate the upstream SSE stream into an OpenAI non-streaming response object.
// Used when "the client wants non-streaming, but the upstream only supports streaming" (deepseek free channel).
// Extra handling: upstream 200 with completely empty content (reasoning only) → treated as a bad response, switch account and retry.
// The caller passes in the already-obtained upstream response; this function handles aggregation + content checking + retry on empty.
async function nonStreamWithContentCheck(env, path, bodyObj, sessionId, firstResp) {
  const maxAttempts = 3; // at most 3 attempts (covers multi-account switching)
  let lastData = null;
  let resp = firstResp;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!resp) {
      // Need to re-issue the upstream request (retrying after an empty response)
      resp = await clineFetchWithRetry(env, path, bodyObj, sessionId, true);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { error: jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status) };
    }
    const ct = resp.headers.get("content-type") || "";
    let normalized = null;
    if (ct.includes("text/event-stream")) {
      normalized = await streamToNonStream(resp);
    } else {
      const raw = await resp.json().catch(() => null);
      if (raw) normalized = unwrapData(raw);
    }
    if (!normalized) {
      return { error: jsonResponse({ error: { message: "upstream returned non-SSE body", type: "api_error" } }, 502) };
    }
    lastData = normalized;
    const msg = normalized?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const reasoning = (msg.reasoning || "").trim();
    // ⚠️ Reasoning fallback marker: when content is empty, streamToNonStream folds reasoning into content,
    //    which must be recognized here — it must not be treated as a "good response".
    const isReasoningFallback = msg.reasoning_used_as_content === true;
    if (content && !isReasoningFallback) {
      return { data: normalized }; // real content present → good response
    }
    // Empty content (or reasoning-only fallback): if only reasoning was returned, cool this account down and retry
    if (reasoning || isReasoningFallback) {
      if (currentAccount) {
        currentAccount.cooldownUntil = Date.now() + 30 * 1000; // short 30s cooldown
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        const pool = parseAccounts(env);
        await dbMarkCooldown(env, pool.indexOf(currentAccount), Date.now() + 30 * 1000, "error", "empty content");
        console.log(`[empty-content] account ${attempt} returned empty content, cooling down 30s, retry #${attempt + 2}`);
      }
      await sleep(300 + Math.floor(Math.random() * 300));
      resp = null; // re-request on the next loop iteration (switches to the next account)
      continue;
    }
    // Completely empty (not even reasoning) → retry too
    console.log(`[empty-response] account ${attempt} returned a fully empty response, retry #${attempt + 2}`);
    await sleep(300 + Math.floor(Math.random() * 300));
    resp = null;
  }
  // Still empty after exhausting retries: return the last result (at least it carries reasoning, so the client sees something)
  return { data: lastData };
}

async function streamToNonStream(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const normalized = unwrapData(obj);
        const choice = normalized?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (normalized.id) id = normalized.id;
        if (normalized.model) model = normalized.model;
        if (normalized.usage) usage = normalized.usage;
      } catch {}
    }
  }

  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning = reasoning;
  // ⚠️ Fallback: the free channel occasionally streams reasoning only with no content at all (HTTP 200 but empty).
  //    After aggregation, if content is still empty and reasoning is not, fold reasoning into content so
  //    clients (qwenpaw etc.) receive something visible instead of "silently never replying".
  if (!content && reasoning) {
    msg.content = reasoning;
    msg.reasoning_used_as_content = true;
  }
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message: msg,
      finish_reason: finishReason || "stop",
      logprobs: null,
      native_finish_reason: finishReason || "stop",
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API → converted to OpenAI format then forwarded
// ---------------------------------------------------------------------------

async function handleAnthropic(request, env) {
  const key = getApiKey(request, env);
  if (!key) {
    return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
  }

  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const isStream = !!req.stream;
  const sessionId = "sess_" + Date.now();
  const modelConfig = resolveModel(req.model) || MODELS.find((m) => m.id === DEFAULT_MODEL);
  const requestedModel = modelConfig.id;
  const upstreamModel = modelConfig.upstream;

  // Anthropic → OpenAI message conversion
  const messages = [];
  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
    messages.push({ role: "system", content: sysContent });
  }
  for (const m of req.messages || []) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    messages.push({ role: m.role, content });
  }

  const body = {
    model: upstreamModel,
    max_tokens: req.max_tokens || 128000,
    session_id: sessionId,
    reasoning_effort: "high",
    messages,
  };
  // ⚠️ Free channels (deepseek, stealth, z-ai, cline-free): non-streaming is rate-limited upstream, force stream and aggregate
  const forceStream = !isStream && /^(deepseek|stealth|z-ai|cline-free)\//.test(upstreamModel);
  if (isStream || forceStream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
  }

  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, true);
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: { message: "upstream error: " + errText.slice(0, 300), type: "api_error" } }, resp.status);
    }
    if (isStream) {
      // Upstream is OpenAI SSE; convert to Anthropic SSE format
      return streamResponseAnthropic(resp, { "X-Cline-Account": servingAccountLabel(env) });
    }
    if (forceStream) {
      // Client wants non-streaming + upstream is streaming: aggregate then convert to Anthropic
      // ⚠️ Same content check applies: the free channel occasionally returns a "200 but content empty" stream; retry on another account if empty
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, resp);
      if (retried.error) return retried.error;
      return jsonResponse(openAItoAnthropic(retried.data), 200, { "X-Cline-Account": servingAccountLabel(env) });
    }
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    // OpenAI → Anthropic
    return jsonResponse(openAItoAnthropic(normalized), 200, { "X-Cline-Account": servingAccountLabel(env) });
  } catch (e) {
    return jsonResponse({ error: { message: e.message, type: "api_error" } }, 500);
  }
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

// Strip the upstream {data:{...}} wrapper (the upstream sometimes wraps in a data layer)
function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}

// OpenAI SSE streaming passthrough (strips the data wrapper)
async function streamResponse(upstream, externalModel, extraHeaders = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Process line by line
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") {
              await writer.write(encoder.encode(line + "\n\n"));
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              if (normalized && externalModel) normalized.model = externalModel;
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch {
              await writer.write(encoder.encode(line + "\n"));
            }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch (e) {
      // ignore
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

// Anthropic SSE: convert upstream OpenAI chunks to Anthropic format
async function streamResponseAnthropic(upstream, extraHeaders = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              const choice = normalized?.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta || {};
              if (delta.content) {
                await writer.write(encoder.encode("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } }) + "\n\n"));
              }
              if (delta.tool_calls && delta.tool_calls.length > 0) {
                for (const tc of delta.tool_calls) {
                  await writer.write(encoder.encode("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.function?.arguments || "") } }) + "\n\n"));
                }
              }
            } catch {}
          }
        }
      }
      // End events
      await writer.write(encoder.encode("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }) + "\n\n"));
      await writer.write(encoder.encode("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n"));
    } catch (e) {
    } finally {
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

// OpenAI non-streaming → Anthropic non-streaming
function openAItoAnthropic(openAI) {
  const choice = openAI?.choices?.[0];
  const content = choice?.message?.content || "";
  return {
    id: openAI?.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: openAI?.model || "",
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: openAI?.usage?.prompt_tokens || 0,
      output_tokens: openAI?.usage?.completion_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function handleModels() {
  return handleModelsAsync().catch(() => handleModelsStatic());
}

// Static fallback: our known IDs (used when the upstream catalog fetch fails)
function handleModelsStatic() {
  const list = MODELS.map((m) => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "cline",
  }));
  return jsonResponse({ object: "list", data: list }, 200, { "X-Cline2api-Version": VERSION });
}

// Live Cline catalog (public endpoint, no account quota spent), cached 1 hour.
// Merges free + clinePass + recommended (+ clineCloud) groups so clients that
// auto-detect (Cline extension, OpenCode, Hermes…) see everything Cline offers.
let modelsCache = { at: 0, list: null };
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

async function handleModelsAsync() {
  const now = Date.now();
  if (!modelsCache.list || now - modelsCache.at >= MODELS_CACHE_TTL_MS) {
    const resp = await fetch("https://api.cline.bot/api/v1/ai/cline/recommended-models");
    if (!resp.ok) throw new Error("upstream " + resp.status);
    const data = await resp.json();
    const seen = new Set();
    const list = [];
    const push = (id) => {
      id = String(id || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      list.push(id);
    };
    for (const group of [data?.free, data?.clinePass, data?.recommended, data?.clineCloud]) {
      if (Array.isArray(group)) for (const m of group) push(m && m.id);
    }
    for (const m of MODELS) push(m.id); // keep our known IDs even if upstream drops them
    if (list.length === 0) throw new Error("empty upstream list");
    modelsCache = { at: now, list };
  }
  const list = modelsCache.list.map((id) => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: id.includes("/") ? id.split("/")[0] : "cline",
  }));
  return jsonResponse({ object: "list", data: list }, 200, { "X-Cline2api-Version": VERSION });
}

function getApiKey(request, env) {
  const provided = env.API_KEY;
  // API_KEY not configured → use the built-in default key
  const expected = provided !== undefined && provided !== null && provided !== "" ? provided : "cline2api-default-key";

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7) === expected ? expected : null;
  }
  const xKey = request.headers.get("x-api-key");
  return xKey === expected ? expected : null;
}

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  };
}

