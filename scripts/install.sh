#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dry_run=false
no_start=false
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    --no-start) no_start=true ;;
    -h|--help)
      echo "Usage: sudo ./scripts/install.sh [--dry-run] [--no-start]"
      exit 0
      ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

need node
need npm
need tmux
need codex
need convert
need systemctl

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22 or newer is required; found $(node --version)." >&2
  exit 1
fi

chrome_path="${CHATINABOX_CHROME_PATH:-}"
if [[ -z "$chrome_path" ]]; then
  for candidate in \
    /usr/bin/google-chrome \
    /opt/google/chrome/chrome \
    /usr/bin/chromium \
    /usr/bin/chromium-browser
  do
    if [[ -x "$candidate" ]]; then chrome_path="$candidate"; break; fi
  done
fi
if [[ -z "$chrome_path" || ! -x "$chrome_path" ]]; then
  echo "Chrome or Chromium is required for clear /screen images." >&2
  echo "Install google-chrome-stable or chromium, then retry." >&2
  exit 1
fi

echo "Building and testing Chatinabox…"
(
  cd "$repo_dir"
  npm ci
  npm run verify
)

if $dry_run; then
  echo
  echo "Dry run passed. No system files or services were changed."
  exit 0
fi

bot_token="${CHATINABOX_TG_BOT_TOKEN:-${TG_BOT_TOKEN:-}}"
owner_ids="${CHATINABOX_TG_USER_ID:-${TG_ALLOWED_USER_IDS:-}}"
if [[ -z "$bot_token" ]]; then
  read -r -s -p "Telegram bot token from @BotFather: " bot_token
  echo
fi
if [[ -z "$owner_ids" ]]; then
  read -r -p "Your numeric Telegram user ID: " owner_ids
fi
if [[ ! "$bot_token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "The Telegram bot token does not look valid." >&2
  exit 1
fi
if [[ ! "$owner_ids" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]; then
  echo "Use one numeric Telegram ID, or a comma-separated list." >&2
  exit 1
fi

if ! getent group chatinabox >/dev/null; then
  groupadd --system chatinabox
fi
if ! id chatinabox >/dev/null 2>&1; then
  useradd --system --gid chatinabox --home-dir /var/lib/chatinabox \
    --shell /usr/sbin/nologin chatinabox
fi

install -d -m 0755 /opt/chatinabox/releases
install -d -o chatinabox -g chatinabox -m 0700 /var/lib/chatinabox
install -d -o root -g root -m 0700 /var/lib/chatinabox-bridge
install -d -o root -g chatinabox -m 0770 /run/chatinabox
install -d -m 0755 /etc/chatinabox

release_id="$(date -u +%Y%m%dT%H%M%S%NZ)-$(git -C "$repo_dir" rev-parse --short HEAD 2>/dev/null || echo local)"
release_dir="/opt/chatinabox/releases/$release_id"
install -d -m 0755 "$release_dir"
cp -a "$repo_dir/dist" "$repo_dir/bin" "$repo_dir/ops" \
  "$repo_dir/package.json" "$repo_dir/package-lock.json" "$release_dir/"
chmod +x "$release_dir/bin/chatinabox" "$release_dir/ops/chatinabox-command"
(
  cd "$release_dir"
  npm ci --omit=dev
)
ln -sfn "$release_dir" /opt/chatinabox/current

node_path="$(command -v node)"
codex_path="$(command -v codex)"
tmux_path="$(command -v tmux)"
convert_path="$(command -v convert)"
env_file=/etc/chatinabox/chatinabox.env
install -o root -g chatinabox -m 0640 /dev/null "$env_file"
{
  printf 'TG_BOT_TOKEN=%s\n' "$bot_token"
  printf 'TG_ALLOWED_USER_IDS=%s\n' "$owner_ids"
  printf 'CHATINABOX_DATA_DIR=/var/lib/chatinabox\n'
  printf 'CHATINABOX_BRIDGE_SOCKET=/run/chatinabox/bridge.sock\n'
  printf 'CHATINABOX_BRIDGE_DB=/var/lib/chatinabox-bridge/bridge.sqlite\n'
  printf 'CHATINABOX_DEFAULT_CWD=/root\n'
  printf 'CHATINABOX_LOBBY_CWD=/var/lib/chatinabox-bridge/lobby\n'
  printf 'CHATINABOX_CODEX_PATH=%s\n' "$codex_path"
  printf 'CHATINABOX_TMUX_PATH=%s\n' "$tmux_path"
  printf 'CHATINABOX_CONVERT_PATH=%s\n' "$convert_path"
  printf 'CHATINABOX_CHROME_PATH=%s\n' "$chrome_path"
} > "$env_file"
chown root:chatinabox "$env_file"
chmod 0640 "$env_file"

install -m 0644 "$repo_dir/ops/systemd/chatinabox-bridge.service" \
  /etc/systemd/system/chatinabox-bridge.service
install -m 0644 "$repo_dir/ops/systemd/chatinabox.service" \
  /etc/systemd/system/chatinabox.service
if [[ "$node_path" != /usr/bin/node ]]; then
  sed -i "s|/usr/bin/node|$node_path|g" \
    /etc/systemd/system/chatinabox-bridge.service \
    /etc/systemd/system/chatinabox.service \
    "$release_dir/ops/codex-hooks.json"
fi
install -m 0755 "$repo_dir/ops/chatinabox-command" /usr/local/bin/chatinabox

install -d -m 0700 /root/.codex
node "$repo_dir/ops/install-codex-hooks.mjs" \
  "$release_dir/ops/codex-hooks.json" /root/.codex/hooks.json
node "$repo_dir/ops/install-chatinabox-instructions.mjs" \
  "$repo_dir/ops/chatinabox-global-AGENTS-block.md" /root/AGENTS.md
install -d -o root -g root -m 0700 /var/lib/chatinabox-bridge/lobby
install -o root -g root -m 0600 \
  "$repo_dir/ops/chatinabox-lobby-AGENTS.md" \
  /var/lib/chatinabox-bridge/lobby/AGENTS.md

# Polling and webhooks are mutually exclusive. Installing Chatinabox claims
# this bot's update stream.
TG_BOT_TOKEN="$bot_token" node -e \
  'fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/deleteWebhook`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({drop_pending_updates:false})}).then(r=>r.json()).then(v=>{if(!v.ok)process.exit(1)})'

systemctl daemon-reload
systemctl enable chatinabox-bridge.service chatinabox.service >/dev/null
if ! $no_start; then
  systemctl restart chatinabox-bridge.service
  systemctl restart chatinabox.service
  sleep 2
  /usr/local/bin/chatinabox doctor
fi

echo
echo "Chatinabox installed. Open your bot in Telegram and send /start."
if $no_start; then
  echo "Services were installed but not started; run: systemctl start chatinabox-bridge chatinabox"
fi
