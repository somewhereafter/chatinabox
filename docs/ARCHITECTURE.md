# Architecture

Chatinabox carries one real Codex CLI session through Telegram. It does not
create a parallel chat backend or proxy model traffic.

```text
Telegram Bot API
      │ long polling
      ▼
chatinabox service (unprivileged)
      │
      ├── owner policy, menus, formatting, attachments
      ├── routing, queue, status, and delivery SQLite state
      │
      └── group-only Unix socket
                    │
                    ▼
chatinabox-bridge (root)
      │
      ├── tmux discovery and exact pane identity
      ├── Codex process and transcript discovery
      ├── terminal capture and ANSI-aware rendering
      ├── lifecycle event ingestion
      └── root-only bridge and Lobby SQLite state
                    │
                    ▼
              tmux + Codex CLI
```

## Process boundary

The Telegram process runs as the `chatinabox` system user. It can read its bot
environment and write only its own state and attachment tree. It cannot rewrite
the root bridge environment, Lobby instructions, bridge database, release
files, or systemd units.

The bridge runs as root because it controls root-owned tmux sessions and starts
Codex in the project's deliberate full-access mode. Its only client surface is
`/run/chatinabox/bridge.sock`, mode `0660`, owned by the `chatinabox` group.

This separation limits accidental local reachability. It does not reduce the
authority of an allowed Telegram user: that user can direct root Codex.

## Session identity

Names are presentation. Every pane mutation carries:

- tmux server PID;
- pane ID;
- pane PID.

The bridge revalidates all three before sending text, keys, interrupts, renames,
screens, or handoffs. A stale button cannot silently target a newly reused pane
name.

## Event delivery

Codex lifecycle hooks report session start, prompt submission, stop, and
session end events over the local socket. The bridge binds panes to Codex
session IDs and transcript files, mirrors local prompts, and derives compact
activity state from transcript records.

Transcript reading is also the recovery path when a lifecycle event is missed.
Final deliveries are deduplicated per Telegram owner and pane.

## Follow-up queue

Telegram messages arriving during an active turn are stored in order. A
transient queue message tells the user that delivery is waiting. At the next
tool boundary, Chatinabox bundles the pending messages into one ordered prompt,
sends it to the pane, and removes only the rows that were successfully handed
off.

## Terminal view

The bridge captures tmux text and styles, converts ANSI state into a bounded
HTML document, renders that document in local headless Chrome, and returns PNG
bytes over the socket. Telegram buttons send an allowlisted set of tmux keys
and then refresh the same screen message.

## Durable locations

| Path | Owner | Contents |
| --- | --- | --- |
| `/var/lib/chatinabox` | `chatinabox` | Telegram routing, queues, attachments |
| `/var/lib/chatinabox-bridge` | `root` | bridge events, bindings, Lobby |
| `/etc/chatinabox/chatinabox.env` | `root:chatinabox` | bot secret and paths |
| `/opt/chatinabox/releases` | `root` | immutable installed releases |
| `/run/chatinabox/bridge.sock` | `root:chatinabox` | local bridge API |
