# Architecture

Chatinabox carries one real Codex CLI session through Telegram. It does not
create a parallel chat backend or proxy model traffic.

```text
Telegram Bot API
      │ long polling
      ▼
chatinabox service (unprivileged)
      │
      ├── owner policy, menus, formatting, attachments, voice transcription
      ├── forum routing, setup, presence, and delivery state
      ├── durable schedules, occurrence claims, and direct message delivery
      ├── read-only private experience profile
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
      └── root-only bridge, Lobby, and manager workspaces
                    │
                    ▼
              tmux + Codex CLI
```

## Process boundary

The Telegram process runs as the `chatinabox` system user. It can read its bot
environment and private experience profile, and write only its own state and
attachment tree. It cannot rewrite the root bridge environment, profile, Lobby
instructions, bridge database, release files, or systemd units.

When Scribe is configured, the Telegram process downloads each owner-authorized
voice note with the same 20 MB bound used for attachments, holds it in memory,
and sends it to ElevenLabs' synchronous Scribe v2 endpoint. Only the resulting
text is handed to Codex; Chatinabox does not persist the source audio.

The bridge runs as root because it controls root-owned tmux sessions and starts
Codex in the project's deliberate full-access mode. Its only client surface is
`/run/chatinabox/bridge.sock`, mode `0660`, owned by the `chatinabox` group.

This separation limits accidental local reachability. It does not reduce the
authority of an allowed Telegram user: that user can direct root Codex.

## Forum control layer

Forum registration is explicit and owner-bound:

- one overview/dashboard topic per managed forum;
- one manager topic per managed forum;
- any number of work topics, each attached to an exact Codex pane.

Overview and manager topics are isolated from ordinary worker routing. Work
topics store their launch profile, activity state, idle clock, and durable Codex
session ID. When the inactivity window elapses, the bridge closes only an idle
pane; the topic keeps enough state to resume the same Codex thread later.

Telegram topic icons are presentation state. A worker must remain idle across a
stable polling interval before changing from working to ready, and an active
turn record overrides a momentary tmux status miss.

## Experience profile

`/etc/chatinabox/profile.json` separates product behavior from one person's
names, symbols, manager identity, model defaults, and idle policy. The
unprivileged Telegram service hot-reloads the validated file read-only.

Root Codex sessions can update the profile through `chatinabox profile set`.
That command accepts an allowlisted set of fields, normalizes lengths and
values, writes atomically, and constrains manager workspaces beneath
`/var/lib/chatinabox-bridge/`. The installer creates the neutral profile only
when no profile exists, so upgrades preserve local identity.

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

Telegram updates have separate in-flight and completed markers. The long-poll
offset advances only after handling completes; an in-flight marker is reclaimed
on process restart, while completed updates remain deduplicated. Telegram prompt
handoffs also carry stable delivery IDs into the root bridge, so replaying an
update after a bot restart does not paste the same prompt into Codex twice.

## Scheduled actions

Schedules and their occurrence ledger live in the unprivileged Telegram
service's SQLite state. One-time ISO dates, bounded intervals, and five-field
cron expressions with IANA timezones resolve to a single `next_run_at`. Missed
recurring windows coalesce into one current occurrence instead of replaying a
backlog.

Claiming an occurrence and advancing its schedule happen in one immediate
transaction. Abandoned claims become eligible for retry after five minutes.
Successful messages record their Telegram message ID; topic tasks use a stable
occurrence delivery ID when they cross the bridge. Three consecutive dispatch
failures pause a schedule.

Messages are sent directly and do not start Codex. Tasks target a stable
chat/owner/topic route, resume a sleeping topic when needed, and enter its
normal follow-up queue. Recent outcomes are rendered in the same rate-limited
Overview update as session, goal, and usage state.

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
| `/etc/chatinabox/profile.json` | `root` | names, symbols, defaults, idle policy |
| `/opt/chatinabox/releases` | `root` | immutable installed releases |
| `/run/chatinabox/bridge.sock` | `root:chatinabox` | local bridge API |
