<p align="center">
  <img src="assets/chatinabox.svg" alt="Chatinabox — your Codex terminal, carried through Telegram" width="100%">
</p>

Chatinabox carries the Codex CLI already running on your server into a private
Telegram chat or forum. A topic can hold one real Codex session: same process,
same thread, same workspace, same terminal when you come back.

[Quick start](#quick-start) ·
[Forum setup](#forum-setup) ·
[Controls](#controls) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Security](SECURITY.md)

Codex still owns the model conversation, tools, authentication, compaction, and
terminal UI. Chatinabox handles discovery, routing, Telegram presentation, and
continuity around it.

No parallel assistant backend. No second copy of the thread.

Chatinabox is an independent open-source project, not an OpenAI product.

## A quiet control room

A forum gives the system a useful shape without turning it into a dashboard
product:

- **overview** — live session counts, working/idle state, and usage windows;
- **🔮 manager** — a conversational guide for finding, creating, resuming, and
  coordinating sessions;
- **work topics** — one topic per Codex thread, named and configured before it
  starts.

Topic icons carry simple presence: working, ready, or resting. Idle workers can
close after a configurable window while their Codex history and launch profile
remain available behind a restart button.

The names above are defaults, not branding requirements. First-run setup lets
you talk through the tone, names, symbols, models, workspaces, and idle policy
you want. Those choices live in a private host profile rather than the source
tree.

The older one-chat flow remains available. Chatinabox can still discover,
attach, resume, rename, interrupt, and switch ordinary tmux sessions without a
forum.

## What comes through

- Normal prompts, local tmux prompts, progress, reasoning summaries, final
  responses, and context compaction.
- Compact transient state for commands, edited files, explored items, active
  shells, queued messages, terminal waits, and elapsed turn time.
- Ordinary messages steer a busy turn immediately; `/queue your follow-up`
  explicitly holds a message for the next turn.
- Native Codex goals synchronized across Telegram and terminal sessions, with
  transient Pause/Resume/Edit/Clear controls and completion history in the
  overview dashboard.
- Telegram-native headings, emphasis, links, lists, quotes, code blocks,
  tables, details, and long-message splitting.
- Photos, albums, captions, files, generated images, and local file delivery.
- A tall color-preserving `/screen` view with tap controls for terminal keys
  and interactive Codex pickers.
- Topic/session name sync, safe handoffs, and exact tmux pane identity checks.

## Quick start

### Requirements

- A dedicated Debian/Ubuntu-style VPS with systemd
- Node.js 22 or newer
- A recent [Codex CLI](https://developers.openai.com/codex), authenticated for
  the root account
- tmux
- ImageMagick (`convert`)
- Google Chrome or Chromium with a readable monospace font
- A Telegram bot from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user ID

Install Codex using its official installer or npm:

```sh
npm install -g @openai/codex
```

Then install Chatinabox:

```sh
git clone https://github.com/somewhereafter/chatinabox.git
cd chatinabox
sudo ./scripts/install.sh
```

The installer verifies the source tree, creates an immutable release under
`/opt/chatinabox`, merges the Codex lifecycle hooks and managed instructions,
configures Telegram, and starts the unprivileged bot plus root session bridge.

For a non-interactive install:

```sh
sudo CHATINABOX_TG_BOT_TOKEN='123:secret' \
  CHATINABOX_TG_USER_ID='123456789' \
  ./scripts/install.sh
```

Check a host without changing it:

```sh
sudo ./scripts/install.sh --dry-run
```

Open the bot and send `/start`. On a fresh install, the first conversation is
setup: describe what you want, or say “keep it simple.” The guide writes a
validated private profile and walks you through the Telegram side.

## Forum setup

Create a private Telegram supergroup, enable **Topics**, add the bot as an
administrator, and allow it to manage topics and pin messages.

Then make:

1. an overview/dashboard topic and send `/overview setup`;
2. a manager topic and send `/manager setup`;
3. a normal work topic and send `/setup`.

The manager keeps the 🔮 topic icon. Pin the manager and overview/dashboard
topics in the forum list so the two control surfaces stay easy to reach. In work
topics, the bot pins each completed final response as a navigable checkpoint;
Telegram keeps the topic's checkpoint pins in its native order.

Creating a work topic opens a compact starter automatically. Pick a detected
Git repository (or enter a path), tune the topic name/model/reasoning/speed, and
either start a fresh chat, connect an unbound running Codex session, or resume a
recent saved Codex chat. The configured manager can also join that one topic as
a temporary natural-language setup guide and hand it over to the real worker;
the permanent manager session stays in place. `/setup` reopens the starter.
Telegram topic renames remain synced to the live Codex/tmux session. If an idle
topic has gone to sleep, its next ordinary message resumes the saved Codex
chat, shows a short wake-up notice, waits for the worker to settle, and then
relays that original message.

Visible Codex thought summaries are grouped into one expandable **show
thinking** section per uninterrupted reasoning run. The section is updated at a
measured cadence and is always flushed before the next continuation or final
answer, preserving Telegram message order without a stream of tiny thought
messages.

Native goal mode stays native: start or edit a goal with Codex in Telegram,
tmux, or the web terminal and the same state appears everywhere. An active goal
keeps its work topic awake. Pausing a goal does not interrupt the current turn;
it lets that turn finish and stops automatic continuation afterward. Completed
goals arrive as their own topic event and the latest ten remain available in
the overview dashboard's expandable history.

`/nexus` and `/wizard` remain compatibility aliases for existing installs.

## Private profile

Public defaults are deliberately plain. Personal presentation and launch policy
live at:

```text
/etc/chatinabox/profile.json
```

The installer creates it once and preserves it across upgrades. It contains no
bot token. The bot reads it; root Codex sessions can update it through a narrow
typed command:

```sh
chatinabox profile show --json
chatinabox profile set --assistant-name "mori" --assistant-mark "⌁" --json
chatinabox profile set --overview-name "desk" --overview-emoji "◉" --json
chatinabox profile set --manager-name "guide" --manager-icon "🔮" --json
chatinabox profile set --idle-minutes 45 --complete --json
```

`ops/chatinabox-profile.json` documents the complete neutral profile. Manager
workspaces are constrained beneath `/var/lib/chatinabox-bridge/`.

## Controls

| Command | Purpose |
| --- | --- |
| `/start` | First-run setup or the normal session entry point |
| `/settings` | Revisit names, symbols, and defaults with the guide |
| `/setup` | Configure and start a Codex chat in the current work topic |
| `/overview setup` | Register the current topic as the live dashboard |
| `/overview refresh` | Refresh the dashboard immediately |
| `/manager setup` | Register and start the 🔮 manager topic |
| `/manager wake` | Reconnect the manager topic |
| `/codex` | Show active and recent sessions |
| `/codex new [name]` | Start and attach a worker |
| `/codex rename name` | Rename the attached session |
| `/codex detach` | Return to the persistent Lobby |
| `/codex off` | Pause routing until the next message |
| `/codex interrupt` | Interrupt the current turn |
| `/screen` | Post a fresh terminal view with key controls |
| `/key KEY [KEY…]` | Send allowlisted terminal keys |
| `/help` | Show the complete in-Telegram guide |

On mobile, a message containing only `up`, `down`, `left`, or `right` also acts
as a key command. Sequences such as `down down enter` work too.

## Local control API

Codex can operate the connection instead of merely describing an action:

```sh
chatinabox catalog --json
chatinabox new "Investigate build" --cwd /root/project --json
chatinabox self rename "Build investigation" --json
chatinabox handoff %4 --json
chatinabox self lobby --json
chatinabox send-image /tmp/chart.png "Latest result" --json
```

`--json` is the stable machine-readable surface used by the managed Codex
instructions. Pane mutations bind to tmux server PID, pane ID, and pane PID
rather than trusting a display name.

## Model profiles

The friendly internal profiles are Sol, Terra, and Luna. Their actual model IDs
are environment mappings:

```ini
CHATINABOX_SOL_MODEL=gpt-5.6-sol
CHATINABOX_TERRA_MODEL=gpt-5.6-terra
CHATINABOX_LUNA_MODEL=gpt-5.6-luna
```

Worker and manager defaults are selected separately in the private profile.

## Full-access boundary

Chatinabox launches Codex with approval and sandbox bypass flags. An allowed
Telegram user can therefore direct a root Codex process and control the host.

Use it only on a dedicated, disposable, externally sandboxed VPS with no
unrelated secrets, workloads, credentials, or trusted network access. Read
[SECURITY.md](SECURITY.md) before installing.

## Operations

```sh
chatinabox doctor
chatinabox doctor --json
systemctl status chatinabox chatinabox-bridge
```

Pull a newer checkout and run the installer again. Releases are installed
atomically and the private profile is preserved.

```sh
sudo ./scripts/uninstall.sh          # preserve state and secrets
sudo ./scripts/uninstall.sh --purge  # remove state, secrets, and system user
```

Further notes:
[Architecture](docs/ARCHITECTURE.md) ·
[Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md) ·
[Acknowledgements](ACKNOWLEDGEMENTS.md)

MIT licensed.
