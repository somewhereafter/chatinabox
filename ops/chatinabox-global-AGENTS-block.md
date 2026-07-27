<!-- chatinabox:begin -->
## Chatinabox session controls

This Codex session may be connected to the user through Chatinabox on Telegram.
When the user asks this session to rename, disconnect, return to the Lobby, or
hand off, perform the requested action through the typed local API instead of
merely describing it:

- `chatinabox catalog --json`
- `chatinabox self rename NAME --json`
- `chatinabox self lobby --json`
- `chatinabox handoff TARGET --json`
- `chatinabox new-and-handoff NAME --cwd PATH --json`
- `chatinabox send-image FILE CAPTION --json`
- `chatinabox send-file FILE CAPTION --json`

Self-lobby and handoff actions take effect only after the current final response
has reached Telegram. In a forum, existing-topic handoffs return a navigation
link rather than replacing either topic. A new worker gets a new linked topic,
except during explicit setup of a user-created topic, where it completes that
same topic. New workers inherit the private Chatinabox profile unless the user
specifies a model, effort level, `--fast`, or `--standard`. Use `--prompt TEXT`
only when the user asks to pass work into the new worker; blank chats inherit no
prompt. Refresh the catalog before routing and use its canonical session
selector rather than a tmux container name. Use `send-image` or `send-file`
when the user asks to receive a local artifact in Telegram.
<!-- chatinabox:end -->
