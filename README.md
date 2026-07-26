<p align="center">
  <img src="assets/chatinabox.svg" alt="Chatinabox — your Codex terminal, carried through Telegram" width="100%">
</p>

Chatinabox is a private Telegram surface for the Codex CLI already running on
your server. It discovers real tmux sessions, attaches to one, and carries the
conversation, terminal state, files, and controls into your pocket.

[Quick start](#quick-start) ·
[The experience](#the-experience) ·
[Controls](#telegram-controls) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Security](SECURITY.md) ·
[Contributing](CONTRIBUTING.md)

Codex still owns authentication, threads, models, tools, compaction, and the
terminal UI. Chatinabox controls discovery, routing, Telegram presentation,
session continuity, and the small local API that lets a session move itself.

This is your actual Codex session—not a second assistant pretending to be it.

Chatinabox is an independent open-source project. It is not an OpenAI product.

## The experience

Walk away from the VPS and continue the exact same Codex process from Telegram.
When you return to tmux, the thread, model, working directory, terminal UI, and
interactive state are still there. Chatinabox does not create a parallel API
conversation or hide Codex behind another assistant.

- Discover running sessions and recent saved threads automatically. Start,
  resume, rename, interrupt, or switch between them with tap controls—and let a
  Codex session rename or hand off itself through the local control API.
- Keep one conversation across phone and terminal. Prompts typed locally are
  mirrored to Telegram, and Telegram messages enter the live Codex TUI rather
  than a separate backend.
- Know what is happening without watching a terminal: working, accumulating
  tool and file activity, waiting for input, queued follow-ups, compaction, and
  image views appear as clean transient or durable events.
- Send several thoughts while Codex is busy. They remain ordered and are
  delivered together at the next safe tool boundary instead of starting
  competing turns or disappearing.
- Open a tall, readable, color-preserving terminal view with `/screen`. Use its
  buttons—or `/key`—for Esc, arrows, Enter, Tab, paging, control keys, and
  interactive pickers such as `/model`.
- Send photos, albums, captions, and files with a prompt. Codex can send
  generated images and local files back through the same connection.
- Read answers as Telegram-native messages with headings, emphasis, links,
  lists, quotes, code blocks, and rich tables instead of raw terminal text.
  Long responses are split without breaking formatting.
- Reply to a specific Telegram message to pass Codex a short attributed snippet
  as context without copying the entire quoted turn.

When no worker is attached, **🪄 Lobby** stays available as a small persistent
control intelligence. Talk to it normally; it can orient you, recover recent
work, or hand you to the right session. A detached message wakes it
automatically.

## Quick start

### Requirements

- A dedicated Debian/Ubuntu-style VPS with systemd
- Node.js 22 or newer
- A recent [Codex CLI](https://developers.openai.com/codex) authenticated for
  the root account
- tmux
- ImageMagick (`convert`)
- Google Chrome or Chromium and a readable monospace font
- A Telegram bot from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user ID

The Codex CLI can be installed with its official installer or npm:

```sh
npm install -g @openai/codex
```

### Install Chatinabox

```sh
git clone https://github.com/somewhereafter/chatinabox.git
cd chatinabox
sudo ./scripts/install.sh
```

The installer asks for the bot token and owner ID, verifies the complete source
tree, installs an immutable release under `/opt/chatinabox`, merges the Codex
lifecycle hooks, installs Lobby and worker instructions, claims the bot's
long-poll update stream, configures the bot profile and command menu, and starts
both services.

For a non-interactive install:

```sh
sudo CHATINABOX_TG_BOT_TOKEN='123:secret' \
  CHATINABOX_TG_USER_ID='123456789' \
  ./scripts/install.sh
```

Validate a host without changing it:

```sh
sudo ./scripts/install.sh --dry-run
```

### Codex instructions

The normal installer safely merges Chatinabox's managed worker block into
`/root/.codex/AGENTS.md` without replacing existing personal instructions. It
also installs the Lobby's more specialized `AGENTS.md` in the Lobby workspace.

To install or repair only the global worker instructions manually:

```sh
sudo install -d -m 0700 /root/.codex
sudo node ops/install-chatinabox-instructions.mjs \
  ops/chatinabox-global-AGENTS-block.md \
  /root/.codex/AGENTS.md
```

Alternatively, copy the complete marked block from
[`ops/chatinabox-global-AGENTS-block.md`](ops/chatinabox-global-AGENTS-block.md)
into `/root/.codex/AGENTS.md`. Keep its `chatinabox:begin` and
`chatinabox:end` comments so upgrades and uninstall can update only that block.
Start a new Codex session afterward so the instructions are loaded.

### First conversation

Open the bot and send:

```text
/start
```

Chatinabox presents the running and recent session catalog. Pick one, start a
new worker, or simply talk to the Lobby. Verify the server at any time:

```sh
chatinabox doctor
chatinabox doctor --json
systemctl status chatinabox chatinabox-bridge
```

## Telegram controls

| Command | Purpose |
| --- | --- |
| `/codex` | Show active and recent sessions with tap-to-attach controls |
| `/codex new [name]` | Start and attach a Sol/high full-access worker |
| `/codex rename name` | Rename the attached session |
| `/codex detach` | Return to the persistent Lobby |
| `/codex off` | Turn routing off until the next message wakes Lobby |
| `/codex interrupt` | Send Ctrl-C to the attached session |
| `/screen` | Post a fresh terminal view with interactive key controls |
| `/key KEY [KEY…]` | Send Esc, Enter, arrows, Tab, paging, and control keys |
| `/help` | Show the complete guide inside Telegram |

On mobile, a message containing only `up`, `down`, `left`, or `right` also acts
as a key command. Sequences such as `down down enter` work too.

## Session control API

Codex can operate the connection instead of merely describing what to do:

```sh
chatinabox catalog --json
chatinabox new "Investigate build" --cwd /root/project --json
chatinabox self rename "Build investigation" --json
chatinabox handoff %4 --json
chatinabox self lobby --json
chatinabox send-image /tmp/chart.png "Latest result" --json
```

`--json` is the stable machine-readable surface used by Lobby and the managed
worker instructions. Pane actions bind to the tmux server PID, pane ID, and
pane PID rather than trusting a display name.

## Under the hood

| Layer | Approach |
| --- | --- |
| Telegram | Owner-bound long polling; no public webhook or ingress |
| Routing | One Telegram chat attached to one exact tmux pane identity |
| Continuity | Running panes plus Codex's session index and transcripts |
| Delivery | Lifecycle hooks with transcript fallback and final deduplication |
| Follow-ups | Durable ordered queue flushed at the next tool boundary |
| Terminal | ANSI-aware HTML render in headless Chrome, delivered as PNG |
| Control | Unprivileged bot over a group-only Unix socket to a root bridge |
| State | Separate bot-writable and root-only SQLite stores |

The complete design and trust boundaries are documented in
[Architecture](docs/ARCHITECTURE.md).

## Model profiles

Friendly profiles are Sol (default/high-cost), Terra (medium), and Luna (low).
Lobby uses Terra/low/fast; workers default to Sol/high/standard. Model IDs are
configuration, not baked-in product assumptions:

```ini
CHATINABOX_SOL_MODEL=gpt-5.6-sol
CHATINABOX_TERRA_MODEL=gpt-5.6-terra
CHATINABOX_LUNA_MODEL=gpt-5.6-luna
```

Change the mapping in `/etc/chatinabox/chatinabox.env` when your Codex
installation uses different model IDs.

## Full-access boundary

Chatinabox deliberately launches Codex with approval and sandbox bypass flags.
That is the product mode, not an optional shortcut.

An allowed Telegram user can direct a root Codex process and therefore control
the host. Install Chatinabox only on a dedicated, disposable, externally
sandboxed VPS with no unrelated secrets, workloads, credentials, or trusted
network access. Read [SECURITY.md](SECURITY.md) before using it.

## Upgrade and uninstall

Pull a new checkout and run the installer again. Each install creates a new
release directory and atomically moves `/opt/chatinabox/current`.

```sh
sudo ./scripts/uninstall.sh          # preserve state and secrets
sudo ./scripts/uninstall.sh --purge  # also remove state, secrets, and user
```

Uninstall removes the managed Codex hooks and instruction block. Without
`--purge`, local session state and secrets remain available for a reinstall.

## Project notes

- [Changelog](CHANGELOG.md)
- [Acknowledgements](ACKNOWLEDGEMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

Chatinabox is available under the [MIT License](LICENSE).
