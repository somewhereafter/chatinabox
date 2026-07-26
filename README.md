# Catinabox

Talk to your real Codex CLI sessions from Telegram.

Catinabox discovers running Codex panes in tmux, attaches your private bot to
one, relays both sides of the conversation, and gives you enough terminal
control to operate pickers and approvals from a phone. When detached, a small
persistent **🪄 Lobby** wakes automatically and helps you find, resume, rename,
start, or switch workers.

> [!CAUTION]
> Catinabox gives the allowed Telegram account a root Codex session with
> approvals and sandboxing bypassed. It is for a dedicated, disposable,
> sandboxed VPS—not a workstation, shared host, or server containing unrelated
> secrets. Read [SECURITY.md](SECURITY.md) before installing.

## What it feels like

- Send a normal Telegram message and receive Codex progress, tool activity,
  terminal-waiting state, and the final answer.
- Send several follow-ups while Codex works; Catinabox queues them and flushes
  them together at the next tool boundary.
- Send photos, albums, captions, and files directly into the attached session.
- Use `/screen` for a tall, high-clarity terminal snapshot. Tap Esc, arrows,
  Enter, Tab, Page Up/Down, or send `/key down down enter`.
- Use Codex slash commands such as `/model` unchanged. Unknown bot commands are
  intentionally forwarded to the Codex TUI.
- See messages typed locally in tmux, permanent context-compacted/image-viewed
  events, transient activity, rich Telegram formatting, links, and reply
  context.
- Let sessions rename or hand themselves back to the Lobby through the local
  typed CLI.

## Install

Start with a fresh Debian/Ubuntu-style VPS. Install:

- Node.js 22 or newer
- the current Codex CLI, authenticated for root
- tmux
- ImageMagick (`convert`)
- Google Chrome or Chromium and a readable monospace font
- systemd

Create a bot with [@BotFather](https://t.me/BotFather) and find your numeric
Telegram user ID. Then:

```bash
git clone https://github.com/somewhereafter/catinabox.git
cd catinabox
sudo ./scripts/install.sh
```

The installer asks for the bot token and your user ID without printing the
token, runs the full verification suite, installs versioned releases under
`/opt/catinabox`, merges lifecycle hooks into root's Codex configuration,
installs Lobby/global instructions, disables any webhook for this bot, and
starts both services.

For automation:

```bash
sudo CATINABOX_TG_BOT_TOKEN='123:secret' \
  CATINABOX_TG_USER_ID='123456789' \
  ./scripts/install.sh
```

Validate the host without installing:

```bash
sudo ./scripts/install.sh --dry-run
```

After installation, open the bot and send `/start`. Check the server with:

```bash
catinabox doctor
systemctl status catinabox catinabox-bridge
```

## Telegram controls

| Command | Result |
| --- | --- |
| `/codex` | Active and recent sessions with tap-to-attach controls |
| `/codex new [name]` | Start a Sol/high full-access worker |
| `/codex rename name` | Rename the attached session |
| `/codex detach` | Return to the persistent Lobby |
| `/codex off` | Turn routing off until the next message wakes Lobby |
| `/codex interrupt` | Send Ctrl-C |
| `/screen` | Fresh terminal image and interactive key controls |
| `/key KEY [KEY…]` | Send Esc, Enter, arrows, Tab, PgUp/PgDn, and control keys |
| `/help` | Complete in-bot guide |

On mobile, a message containing only `up`, `down`, `left`, or `right` (including
sequences such as `down down enter`) acts as a key command.

## Local control API

Codex itself can manage the connection:

```bash
catinabox catalog --json
catinabox new "Investigate build" --cwd /root/project --json
catinabox self rename "Catinabox development" --json
catinabox handoff %4 --json
catinabox self lobby --json
catinabox send-image /tmp/chart.png "Latest result" --json
```

`--json` is the stable machine-readable surface used by the Lobby and worker
instructions.

## Architecture

```text
Telegram Bot API
      │
      ▼
unprivileged catinabox service ── SQLite routing/queue state
      │ group-only Unix socket
      ▼
root catinabox-bridge ── tmux panes ── Codex CLI + lifecycle hooks
```

Pane operations are bound to the tmux server PID, pane ID, and pane PID—not a
display name. The bridge also reads Codex's session index/transcripts for
recent-session discovery and reliable event delivery. Telegram never needs
public ingress; the bot uses long polling.

Bot state lives in `/var/lib/catinabox`; root-only bridge and Lobby state lives
in `/var/lib/catinabox-bridge`. Secrets are in
`/etc/catinabox/catinabox.env`, and releases in `/opt/catinabox/releases`.
`/opt/catinabox/current` is the active release symlink.

## Profiles

The friendly profiles are Sol (high-cost/default worker), Terra (medium), and
Luna (low). Their model IDs are configurable:

```ini
CATINABOX_SOL_MODEL=gpt-5.6-sol
CATINABOX_TERRA_MODEL=gpt-5.6-terra
CATINABOX_LUNA_MODEL=gpt-5.6-luna
```

Lobby uses Terra/low/fast. Workers default to Sol/high/standard. Adjust the
mapping in `/etc/catinabox/catinabox.env` if your Codex installation uses
different model IDs.

## Upgrade and uninstall

Pull a new checkout and run `sudo ./scripts/install.sh` again. Every install is
a new immutable release, so the previous directory remains available for
manual rollback.

```bash
sudo ./scripts/uninstall.sh          # preserve state and secrets
sudo ./scripts/uninstall.sh --purge  # also delete state/secrets and service user
```

The managed Codex hooks and instruction blocks are deliberately left in place
by uninstall so a reinstall preserves behavior; remove their
`catinabox:begin/end` block and Catinabox hook commands manually for a complete
configuration cleanup.
