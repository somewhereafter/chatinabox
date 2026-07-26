<!-- chatinabox:begin -->
## Chatinabox session controls

This Codex session may be connected to the user through Chatinabox on Telegram.
When the user asks this session to rename, disconnect, return to the Lobby, or
hand off, perform the requested action through the typed local API instead of
merely describing it:

- `chatinabox self rename NAME --json`
- `chatinabox self lobby --json`
- `chatinabox handoff TARGET --json`
- `chatinabox new-and-handoff NAME --cwd PATH --model sol --effort high --json`
- `chatinabox list --json`

Self-lobby and handoff actions take effect only after the current final response
has reached Telegram. New workers default to Sol with high reasoning unless the
user specifies Luna, Terra, another effort level, or `--fast`.
<!-- chatinabox:end -->
