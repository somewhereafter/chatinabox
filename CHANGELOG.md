# Changelog

Notable changes to Chatinabox are recorded here.

## Unreleased

## 2.1.0 — 2026-07-27

- Added optional Telegram voice-note and audio transcription through
  ElevenLabs Scribe v2, delivered to Codex like ordinary typed prompts.
- Added English language hints, optional technical keyterms, bounded in-memory
  audio handling, safe provider errors, and upgrade-safe API-key rotation.
- Verified the live Telegram → Scribe → Codex → Telegram path.

## 2.0.2 — 2026-07-27

- Quarantined Codex memory-maintenance turns so their prompt, transient
  activity, reasoning, and final report stay out of Telegram.
- Bounded unknown local prompt relays to prevent one oversized event from
  flooding Telegram and rate-limiting unrelated topics.
- Prevented the persistent Lobby identity and internal workspace from becoming
  a normal topic's launch defaults, with launch-time repair for stale rows.

## 2.0.1 — 2026-07-27

- Extended first-run personalization to the actual Telegram bot name/photo and
  forum group name/photo, with preview-first setup guidance and retryable sync.
- Added Codex login, automation-flag, and managed-hook checks to installation
  and diagnostics.
- Preserved existing environment settings during upgrades and restored the
  previous immutable release when activation fails.
- Made the `/screen` browser dependencies optional for the rest of Chatinabox.
- Reworked the README into a shorter, factual install and operating guide.

## 2.0.0 — 2026-07-27

- Added automatic new-topic setup with bounded Git repository discovery,
  configurable launch defaults, fresh chats, unbound running sessions, recent
  saved chats, and a profile-driven temporary manager guide.
- Made Telegram update processing restart-safe with separate in-flight and
  completed state, and added bridge-level prompt delivery IDs to prevent
  duplicate prompt pastes during replay.
- Kept the live transient visible while forming expandable thinking sections,
  reset interrupted transients on the next prompt, and confirmed interrupts
  from recovered pane state when lifecycle events are delayed.
- Added forum-native work topics, a live overview, a 🔮 manager topic, topic
  presence icons, and resumable inactivity shutdown.
- Added conversational first-run setup plus a validated private experience
  profile for names, symbols, manager identity, launch defaults, and idle
  policy.
- Kept `/nexus` and `/wizard` as compatibility aliases while giving new
  installs neutral `/overview` and `/manager` surfaces.
- Added topic-scoped routing, session/topic rename sync, transient interrupts,
  durable reasoning summaries, activity detail, and safer multi-pane renames.
- Expanded the product experience and documented manual Codex instruction
  installation.
- Corrected global worker instructions to install under the Codex home
  directory while cleaning up the legacy target.
- Added project acknowledgements and provenance.
- Refined the session picker, first-run copy, terminal captions, and canonical
  command guidance.
- Added concise Telegram bot metadata and a native command menu during install.
- Added quoted-reply context, explicit expired-button feedback, and attachment
  routing failures instead of silent drops.
- Expanded `chatinabox doctor` with service, webhook, ownership, version, hints,
  and JSON diagnostics.
- Made uninstall remove managed hooks and global instructions cleanly.

## 0.1.0 — 2026-07-26

- Extracted the Codex-to-Telegram system into a standalone project.
- Added automatic running and recent session discovery with tap-to-attach
  controls.
- Added the persistent Lobby, session handoffs, self-renaming, and a stable
  JSON control API.
- Added ordered follow-up queues, attachments and albums, terminal screenshots,
  key controls, rich Telegram rendering, and local-message mirroring.
- Added transient work, tool, file, terminal, and compaction states with durable
  final, compaction, and image-view events.
- Added owner-only long polling, exact tmux pane identity checks, separated
  root/bot state, versioned installation, doctor, and uninstall tooling.
