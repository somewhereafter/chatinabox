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
- `chatinabox share SOURCE CAPTION --title TITLE --kind KIND --json`
- `chatinabox artifact list --json`
- `chatinabox artifact sync --json`
- `chatinabox schedule create message --at ISO --text TEXT --json`
- `chatinabox schedule create task --every 15m --prompt TEXT --json`
- `chatinabox schedule list --json`
- `chatinabox schedule update|pause|resume|run|cancel ID --json`
- `chatinabox schedule occurrences [ID] --json`
- `chatinabox schedule routes --json`

Self-lobby and handoff actions take effect only after the current final response
has reached Telegram. In a forum, existing-topic handoffs return a navigation
link rather than replacing either topic. A new worker gets a new linked topic,
except during explicit setup of a user-created topic, where it completes that
same topic. New workers inherit the private Chatinabox profile unless the user
specifies a model, effort level, `--fast`, or `--standard`. Use `--prompt TEXT`
only when the user asks to pass work into the new worker; blank chats inherit no
prompt. Refresh the catalog before routing and use its canonical session
selector rather than a tmux container name.

When the user explicitly asks for a reminder, scheduled message, recurring
check, or future task, use the schedule API instead of merely promising to
remember. Natural language is the user interface: translate it into an exact
`--at`, `--every`, or five-field `--cron` schedule, include `--timezone` when
wall-clock recurrence matters, and report the resolved `nextRunAt`. If a
wall-clock time could refer to more than one timezone, ask rather than guess.
Messages are delivered without invoking Codex; tasks wake and continue the
destination topic's existing Codex session. The current attached topic is the
default.
Use `schedule routes` and `--topic` when the user names another destination.
Never create a persistent schedule from an inferred suggestion alone.

When work produces an artifact, choose the delivery and deployment route that
fits the artifact itself. A small local image or document can be shared
directly with `chatinabox share FILE CAPTION --json`. A website, interactive
visualization, application, or other substantial artifact should be built and
deployed with whatever capable tooling and hosting the task requires, then
registered with
`chatinabox share HTTPS_URL CAPTION --title TITLE --kind KIND --json`.
Repeat the command for every artifact made in the session; Chatinabox groups
them into one session shelf when a shelf publisher is configured. The registry
is navigation, not a renderer or deployment constraint. Do not weaken an
artifact to fit a hardcoded format, directory, framework, or host.
<!-- chatinabox:end -->
