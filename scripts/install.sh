#!/usr/bin/env bash
set -euo pipefail

# Runtime hosts may expose an Agent-bundled Node under /usr/local/bin. The
# Supervisor is infrastructure software and must use the system Node installed
# and versioned by Runtime Management.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/usr/local/sbin:${PATH:-}"

REPO_URL="${SOP_AGENTD_REPO_URL:-https://github.com/ChangfengHU/sop-runtime-agentd.git}"
REF="${SOP_AGENTD_REF:-main}"
INSTALL_DIR="${SOP_AGENTD_INSTALL_DIR:-/opt/sop-runtime-agentd}"
PORT="${SOP_AGENTD_PORT:-8789}"
START_SERVICE=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --skip-start) START_SERVICE=false; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

for command in git node npm; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 1; }
done

/usr/bin/node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    console.error(`Node.js >=22.19 is required; found ${process.versions.node}`);
    process.exit(1);
  }
'

if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --prune origin
  git -C "$INSTALL_DIR" checkout --detach "origin/$REF"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --filter=blob:none --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm ci --omit=dev=false
npm run build

install -d -m 0700 /etc/sop-runtime-agentd/credentials
install -d -m 0755 /etc/sop-runtime-agentd/providers
if [[ ! -f /etc/sop-runtime-agentd/agentd.env ]]; then
  umask 077
  {
    printf 'SOP_AGENTD_HOST=127.0.0.1\n'
    printf 'SOP_AGENTD_PORT=%s\n' "$PORT"
    printf 'SOP_AGENTD_DATA_DIR=/var/lib/sop-runtime-agentd\n'
    printf 'SOP_AGENTD_CREDENTIAL_DIR=/etc/sop-runtime-agentd/credentials\n'
    printf 'SOP_AGENTD_PROVIDER_DIR=/etc/sop-runtime-agentd/providers\n'
    printf 'SOP_AGENTD_MAX_CONCURRENT=2\n'
  } > /etc/sop-runtime-agentd/agentd.env
fi

if [[ "$START_SERVICE" == true ]]; then
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required to start the service" >&2; exit 1; }
  install -m 0644 deploy/sop-runtime-agentd.service /etc/systemd/system/sop-runtime-agentd.service
  systemctl daemon-reload
  systemctl enable --now sop-runtime-agentd.service
  curl -fsS "http://127.0.0.1:${PORT}/health"
fi
