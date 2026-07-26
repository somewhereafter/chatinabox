const token = process.env.TG_BOT_TOKEN?.trim();
if (!token) throw new Error("TG_BOT_TOKEN is required");

const commands = [
  { command: "codex", description: "Sessions, connection, and controls" },
  { command: "screen", description: "View and control the terminal" },
  { command: "key", description: "Send terminal keys" },
  { command: "help", description: "Complete Chatinabox guide" },
];

await call("deleteWebhook", { drop_pending_updates: false });
await call("setMyCommands", { commands });
await call("setMyDescription", {
  description:
    "Your real Codex CLI sessions, through Telegram. " +
    "Discover, attach, continue, and control the terminal.",
});
await call("setMyShortDescription", {
  short_description: "Your Codex sessions, through Telegram.",
});

process.stdout.write("Telegram bot profile and command menu configured.\n");

async function call(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || "unknown error"}`);
  }
}
