# Cline2API · Cloudflare Workers Edition

Turn Cline's (https://cline.bot) free model access into an OpenAI-compatible API, deployed on Cloudflare Workers — free, serverless, no local process required.

> Reverse-engineered from https://github.com/luawei1/cline2api
>
> (a Go reverse proxy), rewritten as a pure-JS Worker.

---

## 1. Preparation: Get a Cline refreshToken ⭐ (the most important step)

To call the Cline API you need a **refreshToken** (essentially your Cline account's "long-term key", used to obtain the accessToken for each request).

This repo provides **two ways to get it**, pick either one:

### Option 1: Command-line script (recommended, bundled in this repo as `cline_oauth.py`)

The script launches Cline's official **WorkOS device authorization flow**. You just log in once in the browser, everything else is automatic:

```bash
# 1. Run the script, it prints an authorization link
python3 cline_oauth.py

# 2. The script prints a link like:
#    https://authkit.cline.bot/device?user_code=XXXX-XXXX
#    Open it in your browser and authorize with Google / GitHub / email

# 3. Once authorized, the script polls automatically and prints the refreshToken
```

> What the script does internally (reverse-engineered from auth.go):
> 1. `POST api.workos.com/.../authorize/device` → get device_code + authorization link
> 2. Poll `api.workos.com/.../authenticate` → get the WorkOS access_token after authorization succeeds
> 3. `POST api.cline.bot/api/v1/auth/register` → exchange the WorkOS token for Cline's refreshToken

### Option 2: GitHub Actions workflow (no local environment needed, works from a phone) ⭐

The repo ships with a `.github/workflows/get-token.yml` workflow that **runs even from a phone**: you only need to open the authorization link pushed via Telegram on your phone browser and complete the login; the script polls in the cloud automatically and the resulting refreshToken is **sent only to your Telegram, never into the Actions logs**.

**Step 1: Configure Telegram variables (required, the workflow refuses to run without them)**

In the repo's **Settings → Secrets and variables → Actions**, add two secrets:
- `TG_BOT_TOKEN`: your Telegram Bot token
- `TG_CHAT_ID`: the chat_id that receives messages (your own id)

> If either is missing, the workflow exits immediately with an error and never enters the authorization flow.

**Step 2: Trigger manually**

1. Go to the repo's **Actions** page → click **"Get Cline refreshToken"** in the left sidebar
2. Click **Run workflow** on the right → optionally set the authorization wait seconds (default 300) → run
3. Telegram receives the **authorization link + device code** → open it in a phone/PC browser and log in with Google/GitHub/email to authorize
4. On success → Telegram receives the **`refreshToken`**, copy it straight into your CF Worker secret variable

**Security notes:**
- 🔒 The `refreshToken` and account **email never appear in Actions logs** (`::add-mask::` double masking + Telegram-only delivery)
- 🔁 After each run the workflow automatically **cleans up old runs, keeping only the latest one**
- ⏱️ If pushing the authorization link to Telegram fails, the workflow aborts — better to fail than leak the token into logs

### Option 3: Extract from the original Go program (if you already used cline2api)

1. Download a release binary from [cline2api releases](https://github.com/luawei1/cline2api/releases)
2. Run `./cline-proxy --login`, log in to Cline in the browser
3. Open `~/.cline2api/.cline-accounts.json`, find the `refreshToken` field, copy it

---

## 2. Deploy to Cloudflare Workers

> ⚠️ **Recommended method: copy-paste the code, do NOT deploy via Git integration.**
> In practice, GitHub-linked CF deployment (Git integration) often fails due to entry-file/build-environment issues,
> and changing environment variables doesn't take effect automatically. The "copy code" method below is the most stable and fastest.

### What you need

- A Cloudflare account (free signup: [dash.cloudflare.com](https://dash.cloudflare.com))
- The `CLINE_REFRESH_TOKEN` obtained in the previous step

### Deployment steps (copy-paste method, recommended ✅)

1. Open this repo's `worker.js`, **select all and copy the entire code**
2. Log in at [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**
3. Name it `cline2api` (customizable) → **Deploy**
4. Enter the Worker → **Edit code** → delete the default code, **paste** the full `worker.js` content you copied → **Deploy** (top right)
5. **Configure environment variables** (important ⚠️):
   - Worker → **Settings** → **Variables and Secrets** → **Add**:
     - **Secret**: `CLINE_REFRESH_TOKEN` = the refreshToken from step one (required)
       - **Multi-account supported**: one token per line, see the "Multi-account" section below
     - **Secret**: `API_KEY` = your access key, e.g. `sk-cline-xxx` (recommended, customizable)
   - ⚠️ **After saving you MUST click "Deploy" again to trigger recompilation**, or the variables won't take effect!
6. Done! Your API Base URL is `https://cline2api.<your-subdomain>.workers.dev`

> 💡 To verify the environment variables are active, hit the diagnostic endpoint:
> ```bash
> curl https://cline2api.<your-subdomain>.workers.dev/v1/health
> ```
> If it returns `api_key_configured: true` the variables are live; `account_count` shows how many accounts are configured.

### Variables reference

| Variable | Type | Required | Description |
|---|---|---|---|
| `CLINE_REFRESH_TOKEN` | Secret | ✅ | Cline account refreshToken, **one per line, multi-account supported** |
| `API_KEY` | Secret | Recommended | Client access key; if unset, defaults to `cline2api-default-key` |

> Variable names must match **exactly** (all caps, no spaces). After changing them you **must save and redeploy** for changes to take effect.

### 🔁 Multi-account (auto-switch when quota runs out) ⭐

When one account's free quota/rate limit runs out and you want to switch to the next? No need to change anything — just put **one token per line in `CLINE_REFRESH_TOKEN`**:

```
first-account-refreshToken
second-account-refreshToken
third-account-refreshToken
```

**How it works:**
- 🔄 **Account pool round-robin**: requests rotate across accounts, spreading load
- ⚡ **Auto-switch on quota exhaustion / rate limit**: if an account hits a 429 (`Daily free limit reached`) or an empty response,
  the worker **parses the upstream cooldown hint** (e.g. `Try again in 2h 51m`), cools that account down for exactly that duration and switches to the next one, retrying the same request
- 🚫 **Dead accounts are skipped automatically**: failed refreshes don't block anything
- ✅ **Independent caches**: each account's accessToken is cached independently
- 🛡️ **No spinning when all accounts cool down**: returns the upstream response directly instead of blindly retrying
- Fully backward compatible with a single account

**Verify:** after deployment, visit `/v1/health`; `account_count` is the number of configured accounts.

### Verify the deployment

```bash
curl https://cline2api.<your-subdomain>.workers.dev/v1/models \
  -H "Authorization: Bearer <YOUR_API_KEY>"
```
It should return the model list. Then send a chat request:

```bash
curl https://cline2api.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"poolside/laguna-s-2.1:free","messages":[{"role":"user","content":"hi"}]}'
```

---

## 3. Using with AgentScope (model integration)

When hooking this Worker into **AgentScope (QwenPaw / qwenpaw.agentscope.io)** as an OpenAI-compatible API:

### ⚠️ Key point: use the Workers domain directly, not a custom domain

- Use **`https://cline2api.<your-subdomain>.workers.dev/v1`** as the model **Base URL / API Base**.
- Do **not** use a bound custom domain (e.g. `api.llm.xxx.com`): during AgentScope integration,
  custom domains can fail due to certificate/routing/auth-header handling issues.
  The official Workers domain is the most reliable.

### How to configure in AgentScope (OpenAI-compatible mode)

- **API Base / Base URL**: `https://cline2api.<your-subdomain>.workers.dev/v1`
  (some platforms want the field without `/v1`: `https://cline2api.<your-subdomain>.workers.dev`; try whichever the platform suggests)
- **API Key**: the `API_KEY` value you set (e.g. `sk-cline-xxx`)
- **Model**: `deepseek/deepseek-v4-flash` (default), `stealth/ox-alpha`, `poolside/laguna-s-2.1:free`, or `zai/glm-5.2` (paid, ~$0.0008/request).
  `depth/deepseek-v4-flash` is a spelling alias of `deepseek/deepseek-v4-flash` — same free model, any prefix works.

> If AgentScope uses the standard OpenAI SDK, just set the base_url + api_key above.
> If testing returns 401, make sure the `API_KEY` variable was configured in CF and redeployed.

### ⚠️ Advanced: add a custom User-Agent header to the model (prevents Workers error 1010)

**Important**: Cline's Workers gateway may block requests with **non-browser UAs outright** with
error **`1010`** (an error seen when accessed from browsers / non-Cloudflare-Workers pages). In AgentScope, after configuring
Base URL / API Key / Model, if **every call fails with 1010 or a connection error**, odds are the request's
`User-Agent` is too "robotic" (e.g. curl / python-httpx / the platform's default SDK UA) and got blocked by the gateway.

**Fix**: add a browser UA under the model's **Advanced settings / Custom headers**:

```text
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

**In AgentScope specifically**: on the model config page → find the model's **Advanced settings / Custom Headers** area,
add one header:
- Key: `User-Agent`
- Value: the Chrome UA string above

Save and retry — the Workers gateway will treat it as normal browser traffic.

> 💡 Rule of thumb: **if any platform gets 1010 against this Worker, add this browser UA header first**.
> The gateway judges "browser or not" purely by UA, regardless of whether your API Key is correct. Only investigate the Key if you still get 401 after adding the UA.

---

## 4. Usage

```text
Base URL: https://cline2api.<your-subdomain>.workers.dev/v1
API Key:  <the API_KEY you set>
Model:    deepseek/deepseek-v4-flash   (default)
```

Compatible with OpenAI clients (`/v1/chat/completions`) and Anthropic clients (`/v1/messages`, auto-converted).

### Available models (tested)

| Model ID | Result |
|---|---|
| `deepseek/deepseek-v4-flash` | ✅ **Free, working** (default; requires full Cline client headers + forced streaming, fixed) |
| `depth/deepseek-v4-flash` | ✅ **Free, working** (spelling alias of `deepseek/deepseek-v4-flash`, same model, any prefix works) |
| `stealth/ox-alpha` | ✅ **Free, working** ("Ox Alpha" stealth preview model on Cline's free tier; 1M context, limited-time early free access — added 2026-08-25) |
| `poolside/laguna-s-2.1:free` | ✅ **Free, working** |
| `zai/glm-5.2` | ✅ **Working (paid)**, uses Cline system credentials, ~$0.0008/request |
| `cline-free/glm-5.2` | ❌ **Delisted** (upstream 404 `model not found`, tested 2026-08-06) |
| `cline-pass/*` | ❌ 403, requires a paid cline-pass subscription |

> ⚠️ **2026-08-25 update**:
> - **`stealth/ox-alpha` added** ("Ox Alpha"): an anonymous stealth preview model that Cline now lists in its official
>   free tier (`stealth/ox-alpha`, described as "High-quality coding model with early free access"). It is exposed by this worker as-is,
>   treated like the other free channels (non-streaming client requests are served by forcing upstream streaming and aggregating).
>   Note: it is a limited-time free preview — availability and pricing may change upstream.
>
> ⚠️ **2026-08-06 update**:
> - **`cline-free/glm-5.2` delisted upstream**: that free model name now returns 404 `model not found` from Cline upstream (not a header issue —
>   the same Cline fingerprint headers used for deepseek still return 200). The paid channel for the same model, `zai/glm-5.2`, works (~$0.0008/request,
>   using Cline system credentials); `cline-pass/glm-5.2` needs a subscription and returns 403.
> - If your AgentScope still has `cline-free/glm-5.2` configured, switch to `deepseek/deepseek-v4-flash` (free) or `zai/glm-5.2` (paid).
>
> ⚠️ **2026-08-05 fix log**:
> - **403 "only available via Cline product surfaces"**: the worker's request headers were too minimal, so the official side flagged it as third-party traffic.
>   Fix: added the complete Cline client fingerprint headers (`User-Agent: Cline/3.0.47`, `HTTP-Referer`, `X-CLIENT-TYPE: cline-sdk`,
>   `X-CLIENT-VERSION`, `X-PLATFORM`, etc.), restoring `deepseek/deepseek-v4-flash` and `cline-free/glm-5.2`.
> - **Non-streaming 500 "empty response content"**: upstream rate-limits non-streaming requests on the free channels (deepseek + cline-free), while streaming works fine.
>   Fix: when the client asks for non-streaming, the worker forces stream toward upstream and aggregates chunks back into a non-streaming response.
> - **429 "Daily free limit reached"**: not a bug — the **account's daily free quota** ran out (`Try again in Xh Xm`).
>   This is Cline's official daily quota for free models; it recovers automatically after the cooldown. Multi-account helps mitigate it (multiple tokens on separate lines in `CLINE_REFRESH_TOKEN`).
> - **Multi-account auto-switch on 429**: on 429 rate limits, the upstream cooldown duration is parsed (e.g. `Try again in 2h 51m`),
>   that account is cooled down, and the same request is retried on the next available account; when all accounts are cooling, the upstream response is returned as-is instead of spinning.

---

## 5. Project structure

```
.
├── worker.js               # Main Worker code (deployment core)
├── cline_oauth.py          # Script to obtain CLINE_REFRESH_TOKEN ⭐
├── .github/workflows/
│   └── get-token.yml       # Manually-run workflow: fetch refreshToken via Telegram
├── wrangler.toml           # (Optional) wrangler CLI deployment config; ignore if copy-pasting
├── test_request.json       # Sample test request
└── README.md               # This file
```

## 6. refreshToken FAQ

**Q: Who can see my refreshToken?**
→ Only you. It lives in CF Workers **secret variables** (encrypted storage, invisible in code and logs). Don't mix real refreshTokens into `wrangler.toml` variables — secrets must use `wrangler secret` or the Dashboard's "Secret" type.

**Q: Does the refreshToken expire?**
→ Yes, but Cline's refreshToken has a fairly long validity. If requests start returning 401/403 token-invalid errors later, just rerun `cline_oauth.py` for a new one.

**Q: Is the free quota enough?**
→ Both `deepseek/deepseek-v4-flash` (default) and `poolside/laguna-s-2.1:free` are free models.
   deepseek has a **daily free quota** (when exhausted it returns 429 "Daily free limit reached", recovering hours later);
   multi-account mitigates this (one token per line in `CLINE_REFRESH_TOKEN`, auto-switching when quota runs out).
   `zai/glm-5.2` is a paid model (~$0.0008/request) using Cline system credentials, with no daily quota limit.

---

## License

MIT © 2026 pingmike2
