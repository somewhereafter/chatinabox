<p align="center">
  <img src="assets/chatinabox.svg" alt="Chatinabox — Codex sessions through Telegram" width="100%">
</p>

Chatinabox carries the Codex CLI already running on your server into a private
Telegram chat or forum. One work topic holds one real Codex session: the same
process, thread, workspace, tools, and terminal when you come back.

[Quick start](#quick-start) · [First run](#first-run) ·
[Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) ·
[Changelog](CHANGELOG.md)

Codex still owns the model conversation, authentication, tools, compaction, and
terminal UI. Chatinabox handles discovery, routing, Telegram presentation, and
continuity around it.

Chatinabox is an independent open-source project, not an OpenAI product.

> [!CAUTION]
> An allowed Telegram account controls a full-access Codex process on the host.
> Use a dedicated VPS without unrelated secrets or workloads. Read
> [SECURITY.md](SECURITY.md) before installing.

## What it does

- Relays prompts, progress, reasoning summaries, final responses, files, and
  generated images.
- Keeps live work in one transient message and groups reasoning into an
  expandable thinking section.
- Discovers, creates, resumes, renames, interrupts, and switches Codex sessions.
- Gives forum topics working, ready, and sleeping states.
- Preserves native Codex goals, steering, context compaction, and queued turns.
- Maintains an overview topic and a persistent manager topic for session work.
- Pins completed final responses as per-topic checkpoints.
- Provides `/screen` and safe terminal key controls when its optional display
  dependencies are installed.

There is no second assistant backend and no copied conversation state.

## Quick start

Use a dedicated Debian or Ubuntu VPS with systemd.

Required:

- Node.js 22 or newer
- a recent Codex CLI, logged in for `root`
- tmux
- a Telegram bot token and your numeric Telegram user ID

ImageMagick and Chrome/Chromium are optional; both are only needed for
`/screen`. ImageMagick is also used when setup prepares custom profile photos.

```sh
npm install -g @openai/codex
sudo codex login

git clone https://github.com/somewhereafter/chatinabox.git
cd chatinabox
sudo ./scripts/install.sh
```

The installer runs the full verification suite before changing the host. It
also checks Codex authentication and the full-access/trusted-hook flags, merges
its lifecycle hooks without replacing unrelated hooks, installs an immutable
release, and runs `chatinabox doctor`. On upgrades it preserves the existing
token, paths, defaults, profile, and state. A failed activation restores the
previous release.

Non-interactive install:

```sh
sudo CHATINABOX_TG_BOT_TOKEN='123:secret' \
  CHATINABOX_TG_USER_ID='123456789' \
  ./scripts/install.sh
```

Check the host and source without installing:

```sh
sudo ./scripts/install.sh --dry-run
```

## First run

Open the bot in a private chat and send `/start`.

The setup guide works from ordinary conversation. It can propose and apply:

- the Telegram bot name and photo;
- the forum group name and photo;
- the dashboard and manager identities;
- default models, reasoning level, speed, workspaces, and idle policy.

It shows a compact preview before changing anything. The result is stored in
`/etc/chatinabox/profile.json`, outside the repository, and survives upgrades.
Fresh installs use neutral names; none of the maintainer's personal identity is
part of the product defaults.

For a forum, create a private supergroup, enable Topics, and add the bot as an
administrator. It needs permission to manage topics, pin and delete messages,
and change group info. Then create:

1. an overview topic and send `/overview setup`;
2. a manager topic and send `/manager setup`;
3. a work topic and send `/setup`.

Creating a work topic also opens its setup card automatically. It can start a
new Codex chat, connect an unbound running session, or resume a saved one. The
manager can handle the same setup in plain language.

Pin the overview and manager topics in Telegram's forum list. Chatinabox pins
final responses inside each work topic as its checkpoint history.

## Profile

The profile can also be changed directly:

```sh
chatinabox profile show --json
chatinabox profile set \
  --assistant-name "mori" \
  --assistant-photo /path/to/bot-photo.png \
  --group-name "night shift" \
  --group-photo /path/to/group-photo.png \
  --json
chatinabox profile set --idle-minutes 45 --complete --json
chatinabox profile sync --json
```

Photos are normalized to square JPEG assets under
`/var/lib/chatinabox/profile-assets`. `profile sync` reapplies the configured
bot and forum identity after permissions change.

The complete neutral schema is in
[`ops/chatinabox-profile.json`](ops/chatinabox-profile.json).

## Telegram controls

| Command | Action |
| --- | --- |
| `/start` | Enter setup or open the session picker |
| `/settings` | Revisit the private profile |
| `/setup` | Configure the current work topic |
| `/overview setup` | Register the overview topic |
| `/manager setup` | Register the manager topic |
| `/codex` | List active and recent sessions |
| `/codex new [name]` | Start and attach a worker |
| `/codex rename name` | Rename the attached session |
| `/codex interrupt` | Interrupt the current turn |
| `/codex detach` | Return to the Lobby |
| `/queue text` | Hold a message for the next turn |
| `/screen` | Post the current terminal view |
| `/key KEY [KEY…]` | Send allowlisted terminal keys |
| `/help` | Show the full in-Telegram guide |

`/nexus` and `/wizard` remain aliases for older installs.

## Local control

Codex and host scripts use a small typed command surface:

```sh
chatinabox catalog --json
chatinabox new "Investigate build" --cwd /root/project --json
chatinabox self rename "Build investigation" --json
chatinabox handoff %4 --json
chatinabox self lobby --json
chatinabox send-image /tmp/chart.png "Latest result" --json
```

Session mutations use tmux server PID, pane ID, and pane PID rather than display
names alone.

## Operations

```sh
chatinabox doctor
systemctl status chatinabox chatinabox-bridge
sudo ./scripts/install.sh
```

Running the installer again creates and activates a new immutable release.

```sh
sudo ./scripts/uninstall.sh          # keep state and secrets
sudo ./scripts/uninstall.sh --purge  # remove everything
```

See [SECURITY.md](SECURITY.md) before exposing a bot to a real machine.

MIT.
