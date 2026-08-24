#!/usr/bin/env python3
"""One-shot script to obtain a Cline refreshToken (WorkOS device authorization flow).

Usage:
  python3 cline_oauth.py

Flow (reverse-engineered from cline2api/auth.go):
  1. POST api.workos.com/user_management/authorize/device → get the authorization link
  2. Print the link / push it to Telegram, wait for the user to authorize in the browser (polls authenticate automatically)
  3. On success → call api.cline.bot/api/v1/auth/register with the WorkOS token
  4. Get the refreshToken → paste it into the Cloudflare Worker secret variable

Local auto-save:
  Every successful login appends the refreshToken to refresh_tokens.txt, one per line,
  so multiple accounts simply stack up — run once per account. Duplicates are skipped.
  Override the file with the REFRESH_TOKENS_FILE env var. Never written on CI runners.

Security behavior inside GitHub Actions (important):
  * When TG_BOT_TOKEN / TG_CHAT_ID are configured, both the authorization link and
    the refreshToken are pushed to Telegram, and **the refreshToken is never printed
    to stdout/logs**.
  * Without Telegram configured (local manual run), it prints as before for easy viewing.

Environment variables:
  TG_BOT_TOKEN         Telegram Bot Token (optional; pushes only when set together with TG_CHAT_ID)
  TG_CHAT_ID           Telegram receiving chat_id (optional)
  OAUTH_POLL_TIMEOUT   Authorization wait seconds (optional; defaults to WorkOS's expires_in)
  REFRESH_TOKENS_FILE  Local save path (optional; default refresh_tokens.txt)

Dependencies: Python 3 standard library only, no pip installs needed.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device"
WORKOS_AUTH = "https://api.workos.com/user_management/authenticate"
CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register"
CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"


def in_ci():
    return os.environ.get("GITHUB_ACTIONS") == "true"


def tg_configured():
    return bool(os.environ.get("TG_BOT_TOKEN") and os.environ.get("TG_CHAT_ID"))


def send_tg(text):
    """Push text to Telegram; returns False on failure."""
    token = os.environ.get("TG_BOT_TOKEN")
    chat = os.environ.get("TG_CHAT_ID")
    if not token or not chat:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = json.dumps({"chat_id": chat, "text": text}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return True
    except Exception as e:
        print(f"   ⚠️ Telegram send failed: {e}")
        return False


def mask_value(value):
    """Mask a sensitive value in GitHub Actions logs when running in CI (masked even if accidentally printed)."""
    if in_ci() and value:
        print(f"::add-mask::{value}")


def tokens_file_path():
    """Path of the local file where refreshTokens are auto-saved (one per line)."""
    return os.environ.get("REFRESH_TOKENS_FILE", "refresh_tokens.txt")


def save_token_to_file(rt):
    """Append the refreshToken to the tokens file on a new line.

    New accounts are appended automatically; duplicates are skipped.
    Never writes the file on CI runners (GitHub Actions) — tokens live only
    in Telegram there. Returns True if the token was newly added.
    """
    if in_ci():
        return False
    path = tokens_file_path()
    existing = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            existing = [line.strip() for line in f if line.strip()]
    if rt in existing:
        print(f"ℹ️ Token already saved in {path}, skipping duplicate.")
        return False
    with open(path, "a", encoding="utf-8") as f:
        f.write(rt + "\n")
    print(f"💾 Saved to {path} (account #{len(existing) + 1}). Run again with another account to append more.")
    return True


def post_form(url, form):
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def post_json(url, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def device_auth():
    """Start WorkOS device authorization; returns (device_code, user_code, auth URL, interval, expires_in)."""
    resp = post_form(WORKOS_DEVICE, {"client_id": CLIENT_ID})
    url = resp.get("verification_uri_complete") or resp.get("verification_uri")
    return (resp["device_code"], resp["user_code"], url,
            resp.get("interval", 5), resp.get("expires_in", 300))


def poll_token(device_code, interval, expires_in):
    """Poll WorkOS until the user finishes authorizing; returns the WorkOS access/refresh token."""
    interval = max(interval, 5)
    deadline = time.time() + expires_in
    while time.time() < deadline:
        time.sleep(interval)
        try:
            a = post_form(WORKOS_AUTH, {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
            })
            if "access_token" in a:
                return a
            err = a.get("error")
            if err == "slow_down":
                interval += 5
            elif err not in ("authorization_pending",):
                print(f"   [{err}] {a.get('error_description', '')}")
        except Exception as e:
            print(f"   polling error: {e}")
    raise TimeoutError("authorization timed out")


def main():
    print("🚀 Starting the Cline WorkOS device authorization flow...\n")
    device_code, user_code, auth_url, interval, expires_in = device_auth()

    # Optional polling timeout override
    env_timeout = os.environ.get("OAUTH_POLL_TIMEOUT")
    if env_timeout:
        try:
            expires_in = int(env_timeout)
        except ValueError:
            pass

    use_tg = tg_configured()
    print("=" * 60)
    print("1️⃣  Open this link in your browser:")
    print(f"    {auth_url}")
    print("2️⃣  The page asks for a device code (usually pre-filled automatically):")
    print(f"    {user_code}")
    print("3️⃣  Log in and authorize with Google / GitHub / email")
    print("=" * 60)

    # Push the authorization link to Telegram so authorization can be completed from a phone
    if use_tg:
        tg_msg = (
            "🔑 *Cline authorization request*\n\n"
            "Open the link below in your browser to authorize (device code pre-filled):\n"
            f"{auth_url}\n\n"
            f"Device code: `{user_code}`\n"
            f"The script polls automatically for up to {expires_in} seconds."
        )
        ok = send_tg(tg_msg)
        if not ok:
            print("❌ Failed to push the authorization link to Telegram (check TG_BOT_TOKEN / TG_CHAT_ID)")
            sys.exit(1)
        print("📨 Authorization link pushed to Telegram.")
    else:
        print("ℹ️ Telegram not configured; the authorization link is shown in the log below only.")

    print(f"\n🔄 Waiting for your authorization (polling automatically, up to {expires_in} seconds)...")
    try:
        workos = poll_token(device_code, interval, expires_in)
    except TimeoutError as e:
        print(f"❌ {e}, please run again")
        sys.exit(1)
    print("✅ WorkOS authorization succeeded!")

    print("\n🔗 Registering with Cline using the WorkOS token...")
    cline = post_json(CLINE_REGISTER, {
        "accessToken": workos["access_token"],
        "refreshToken": workos["refresh_token"],
    })
    data = cline.get("data", {})
    rt = data.get("refreshToken")
    if not rt:
        print("❌ Registration failed, response:", json.dumps(cline, ensure_ascii=False)[:500])
        sys.exit(1)

    email = (data.get("userInfo") or {}).get("email", "unknown")
    # The email is also treated as sensitive: mask it to keep it out of Actions logs
    mask_value(email)
    print("\n" + "=" * 60)
    # Displayed after masking; logs show ***
    print(f"✅ Login successful! Account: {email}")

    # Auto-save locally (appends on a new line, skips duplicates; skipped on CI runners)
    save_token_to_file(rt)

    # Key security point: in CI with Telegram configured, the refreshToken is only pushed
    # to Telegram, never printed to logs
    if use_tg:
        mask_value(rt)  # safety net: masked even if accidentally printed
        ok = send_tg(
            "🔑 *Cline refreshToken obtained*\n\n"
            f"Account: `{email}`\n\n"
            "Put the line below into the Cloudflare Worker secret `CLINE_REFRESH_TOKEN` (append on new lines for multiple accounts):\n"
            f"`{rt}`"
        )
        if not ok:
            print("❌ Failed to push the refreshToken to Telegram! Token was NOT printed to logs; fix the Telegram config and retry.")
            sys.exit(1)
        print("🔑 refreshToken sent privately via Telegram (not written to logs).")
    else:
        mask_value(rt)
        print("\n🔑 Put the line below into the Cloudflare Worker secret CLINE_REFRESH_TOKEN:")
        print("    " + rt)
    print("=" * 60)


if __name__ == "__main__":
    main()
