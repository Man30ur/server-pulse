#!/usr/bin/env bash
set -euo pipefail

# Server-Pulse One-Line Installer
# Usage (direct): curl -fsSL https://raw.githubusercontent.com/Man30ur/server-pulse/main/deploy/install.sh | bash
# Usage (local):  bash deploy/install.sh

REPO_URL="${PULSE_REPO_URL:-https://github.com/Man30ur/server-pulse.git}"
TARBALL_URL="${PULSE_TARBALL_URL:-https://github.com/Man30ur/server-pulse/archive/refs/heads/main.tar.gz}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose plugin is not installed." >&2
  exit 1
fi

resolve_root() {
  local src="${BASH_SOURCE[0]:-}"
  if [ -n "$src" ] && [ -f "$src" ]; then
    local dir
    dir="$(cd "$(dirname "$src")/.." && pwd)"
    if [ -f "${dir}/deploy/docker-compose.yml" ] && [ -f "${dir}/agent/go.mod" ]; then
      echo "$dir"
      return
    fi
  fi

  local target="${INSTALL_DIR:-}"
  if [ -z "$target" ]; then
    if [ "$(id -u)" -eq 0 ] || [ -w /opt ]; then
      target="/opt/server-pulse"
    else
      target="${HOME}/server-pulse"
    fi
  fi

  if [ -d "${target}/.git" ] && command -v git >/dev/null 2>&1; then
    echo "[server-pulse] Updating ${target}..." >&2
    git -C "$target" pull --ff-only >&2
  elif [ -f "${target}/deploy/docker-compose.yml" ] && [ -f "${target}/agent/go.mod" ]; then
    echo "[server-pulse] Using existing installation at ${target}..." >&2
  elif command -v git >/dev/null 2>&1; then
    echo "[server-pulse] Cloning into ${target}..." >&2
    mkdir -p "$(dirname "$target")"
    git clone --depth 1 "$REPO_URL" "$target" >&2
  else
    echo "[server-pulse] Downloading archive into ${target}..." >&2
    mkdir -p "$target"
    curl -fsSL "$TARBALL_URL" | tar -xz --strip-components=1 -C "$target"
  fi
  echo "$target"
}

gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

detect_ip() {
  local ip=""
  if command -v curl >/dev/null 2>&1; then
    ip="$(curl -4fsS --max-time 3 https://ifconfig.me 2>/dev/null || true)"
  fi
  if [ -z "$ip" ]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  echo "${ip:-YOUR_SERVER_IP}"
}

ROOT_DIR="$(resolve_root)"
ENV_FILE="${ROOT_DIR}/.env"

if [ ! -f "$ENV_FILE" ]; then
  PULSE_PORT="${PULSE_PORT:-9191}"
  PULSE_HOST="${PULSE_HOSTNAME:-$(hostname -s 2>/dev/null || hostname)}"
  TOKEN="$(gen_token)"
  umask 077
  cat > "$ENV_FILE" <<EOF
PULSE_BIND=0.0.0.0
PULSE_PORT=${PULSE_PORT}
PULSE_TOKEN=${TOKEN}
PULSE_CACHE_TTL_MS=2500
PULSE_TOP_PROCESSES=6
PULSE_HOSTNAME=${PULSE_HOST}
DOCKER_SOCKET=/var/run/docker.sock
EOF
  echo "[server-pulse] Created ${ENV_FILE} (mode 600)."
else
  echo "[server-pulse] Using existing ${ENV_FILE}."
fi

PULSE_PORT="$(awk -F= '/^PULSE_PORT=/{print $2}' "$ENV_FILE" | tr -d '[:space:]')"
PULSE_PORT="${PULSE_PORT:-9191}"
PULSE_TOKEN="$(awk -F= '/^PULSE_TOKEN=/{print $2}' "$ENV_FILE" | tr -d '[:space:]')"

echo "[server-pulse] Pulling prebuilt image (falls back to local build if unavailable)..."
(cd "${ROOT_DIR}/deploy" && { docker compose pull --quiet 2>/dev/null || echo "[server-pulse] Prebuilt image unavailable, building locally."; } && docker compose up -d)

echo -n "[server-pulse] Waiting for healthcheck"
for _ in $(seq 1 20); do
  if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${PULSE_PORT}/health" >/dev/null 2>&1; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 0.5
done

SERVER_IP="$(detect_ip)"
cat <<EOF

====================================================================
 Server-Pulse is running!

 1) Instant web dashboard (no install, works on phones too):

   http://${SERVER_IP}:${PULSE_PORT}/#${PULSE_TOKEN}

 2) Chrome extension (live toolbar badge) - paste this link in it:

   pulse://${SERVER_IP}:${PULSE_PORT}#${PULSE_TOKEN}

 Keep these links private (they contain your Bearer token).
====================================================================
EOF
