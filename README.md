# Server-Pulse

Ultra-lightweight, zero-bloat Linux server & Docker container monitor with a minimal OLED Dark Chrome Manifest V3 extension.

* **Micro-Agent (Go stdlib only):** `8 MB` `FROM scratch` Docker image, `~3–4 MB` RAM, `0.00%` idle CPU, read-only Docker socket (`:ro`), `2.5s` single-flight cache.
* **Chrome MV3 Extension (Vanilla HTML/CSS/JS):** `~37 KB` total (`17 KB` zipped), zero frameworks (`no React/npm`), strict CSP, live toolbar Badge (`RAM%` or `CPU%`), per-container RAM/CPU rows, collapsible Top Processes.

---

## 30-Second Quickstart

### 1. Install the Agent on Your Server (1 command)

```bash
curl -fsSL https://raw.githubusercontent.com/Man30ur/server-pulse/main/deploy/install.sh | bash
```

The installer clones into `/opt/server-pulse`, generates a 64-char random Bearer token in `.env` (`chmod 600`), builds & starts the read-only `scratch` container, verifies `/health`, and prints a single **Quick-Connect link**:

```text
pulse://YOUR_SERVER_IP:9191#YOUR_GENERATED_TOKEN
```

### 2. Install & Connect the Chrome Extension (1 paste)

1. Download **`server-pulse-extension.zip`** from the [Latest Release](https://github.com/Man30ur/server-pulse/releases/latest) and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder.
3. Click the **Server-Pulse** icon in Chrome, paste the `pulse://...` link into **Server URL** — URL and Bearer Token split automatically — and click **Save & Connect**.

Done! Both the extension and your credentials stay saved permanently in `chrome.storage.local`.

---

## Security by Design

* **Read-Only Access:** Docker socket is mounted `:ro` and the agent only issues HTTP `GET` requests. No exec, restart, or mutation endpoints exist.
* **Minimal Host Exposure:** Mounts only `/var/run/docker.sock:ro`, `/proc:/host/proc:ro`, and `/etc/hostname:/host/hostname:ro` (never mounts host `/`), with `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, and `mem_limit: 32m`.
* **Timing-Safe Auth:** Every `/api/*` request requires `Authorization: Bearer <PULSE_TOKEN>` verified with `crypto/subtle.ConstantTimeCompare`.
* **Strict MV3 CSP:** Zero inline scripts, zero `eval`, zero `innerHTML`; CORS restricted to `chrome-extension://`.

---

## Configuration (`.env`)

See [`.env.example`](./.env.example):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PULSE_BIND` | `0.0.0.0` | Listen interface |
| `PULSE_PORT` | `9191` | HTTP port |
| `PULSE_TOKEN` | *(required)* | 64-char random Bearer secret (`openssl rand -hex 32`) |
| `PULSE_CACHE_TTL_MS` | `2500` | Snapshot cache TTL (prevents Docker socket hammering) |
| `PULSE_TOP_PROCESSES` | `6` | Number of non-container host processes returned |
| `PULSE_HOSTNAME` | host `/etc/hostname` | Optional display name in the popup |

---

## Development & Tests

```bash
# Run Go unit & E2E tests (mock Docker Unix socket + mock /proc + RSS check)
(cd agent && go test -v -race ./...)
(cd tests && go test -v ./...)

# Run Chrome MV3 extension & strict CSP tests
node --test tests/extension_test.mjs

# Build dist/server-pulse-extension.zip for GitHub Releases / Chrome Web Store
bash deploy/pack-extension.sh
```

## License

[MIT](./LICENSE)
