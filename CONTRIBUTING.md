# Contributing

Requirements: Node.js 22+, Codex CLI, tmux, ImageMagick, and Chrome/Chromium.

```bash
npm ci
npm run verify
sudo ./scripts/install.sh --dry-run
```

Keep Telegram ownership checks fail-closed, keep callback payloads opaque, and
preserve exact pane identity checks (`tmux server PID + pane ID + pane PID`).
New commands should work through both Telegram and the stable `chatinabox
--json` control API where appropriate.

Keep public experience defaults neutral. Names, marks, topic identities, model
preferences, and idle policy belong in the private experience profile. Add
tests for both the neutral default and any configurable presentation path.

Do not commit bot tokens, Telegram IDs, Codex transcripts, generated terminal
screens, SQLite state, local `.env` files, or personal profile files.
