# Contributing

Requirements: Node.js 22+, Codex CLI, tmux, ImageMagick, and Chrome/Chromium.

```bash
npm ci
npm run verify
sudo ./scripts/install.sh --dry-run
```

Keep Telegram ownership checks fail-closed, keep callback payloads opaque, and
preserve exact pane identity checks (`tmux server PID + pane ID + pane PID`).
New commands should work through both Telegram and the stable `catinabox
--json` control API where appropriate.

Do not commit bot tokens, Telegram IDs, Codex transcripts, generated terminal
screens, SQLite state, or local `.env` files.
