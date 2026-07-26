<!-- catinabox:begin -->
## Catinabox session controls

This Codex session may be connected to the user through Catinabox on Telegram.
When the user asks this session to rename, disconnect, return to the Lobby, or
hand off, perform the requested action through the typed local API instead of
merely describing it:

- `catinabox self rename NAME --json`
- `catinabox self lobby --json`
- `catinabox handoff TARGET --json`
- `catinabox new-and-handoff NAME --cwd PATH --model sol --effort high --json`
- `catinabox list --json`

Self-lobby and handoff actions take effect only after the current final response
has reached Telegram. New workers default to Sol with high reasoning unless the
user specifies Luna, Terra, another effort level, or `--fast`.
<!-- catinabox:end -->
