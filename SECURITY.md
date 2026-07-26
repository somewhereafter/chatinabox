# Security model

Chatinabox intentionally launches Codex with:

```text
--dangerously-bypass-approvals-and-sandbox
--dangerously-bypass-hook-trust
```

That is the product choice, not an optional mode. A person who controls the
allowed Telegram account can direct a root Codex process and therefore control
the host.

Use Chatinabox only on a dedicated, disposable, sandboxed VPS with no unrelated
secrets, workloads, credentials, or trusted network access. Do not install it
on a personal workstation or a shared production server.

The Telegram surface fails closed to the numeric IDs in
`TG_ALLOWED_USER_IDS`; `*` is rejected. The bot runs unprivileged. A separate
root process owns tmux and Codex and exposes a group-restricted Unix socket.
This boundary limits accidental reachability, but it does not make an allowed
Telegram user safe.

Telegram 2FA protects account login, while bot messages are still handled by
Telegram's cloud Bot API. Treat the bot token as a root-equivalent secret for
this VPS. Revoke it with BotFather if exposed.

Forum mode requires the bot to manage topics in the selected private
supergroup. Do not add the bot to unrelated groups. Chatinabox still checks the
numeric owner allowlist before routing messages or callbacks, and topic
attachments are scoped by chat, owner, and thread.

The first-run guide is a root Codex session, not a lower-trust configuration
assistant. Its profile command can change only validated presentation and launch
defaults, but the conversation itself retains the full host authority described
above. The profile is stored at `/etc/chatinabox/profile.json`, contains no bot
token, is read-only to the Telegram service, and is preserved across upgrades.

Please report vulnerabilities privately through GitHub's security advisory
flow. Do not include bot tokens, Telegram IDs, transcripts, or terminal images.
