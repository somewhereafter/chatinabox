import { randomBytes } from "node:crypto";

const token = process.env.TG_BOT_TOKEN?.trim();
if (!token) throw new Error("TG_BOT_TOKEN is required");

const me = await call("getMe", {});
const webhook = await call("getWebhookInfo", {});
if (webhook.result?.url) {
  throw new Error(
    "This bot already has a webhook. Set CHATINABOX_TG_USER_ID explicitly " +
      "instead of using automatic owner discovery.",
  );
}

const pending = await call("getUpdates", { timeout: 0, limit: 100 });
let offset = Array.isArray(pending.result)
  ? Math.max(0, ...pending.result.map((update) => Number(update.update_id) + 1))
  : 0;
const challenge = randomBytes(4).toString("hex");
const username = me.result?.username ? `@${me.result.username}` : "the bot";
process.stderr.write(
  `Open ${username} in Telegram and send this exact message:\n\n` +
    `  /claim ${challenge}\n\n` +
    "Waiting for the private message (up to 3 minutes)…\n",
);

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const updates = await call("getUpdates", {
    offset,
    timeout: 20,
    limit: 100,
    allowed_updates: ["message"],
  });
  for (const update of updates.result ?? []) {
    offset = Math.max(offset, Number(update.update_id) + 1);
    const message = update.message;
    if (
      message?.chat?.type === "private" &&
      message?.from?.is_bot !== true &&
      message?.text?.trim() === `/claim ${challenge}` &&
      Number.isSafeInteger(message.from.id) &&
      message.from.id > 0
    ) {
      await call("getUpdates", {
        offset,
        timeout: 0,
        limit: 1,
        allowed_updates: ["message"],
      });
      process.stdout.write(String(message.from.id));
      process.stderr.write("Owner confirmed.\n");
      process.exit(0);
    }
  }
}

throw new Error(
  "Timed out waiting for the claim message. Run the installer again or set " +
    "CHATINABOX_TG_USER_ID explicitly.",
);

async function call(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    },
  );
  const result = await response.json();
  if (!result.ok) {
    throw new Error(
      `Telegram ${method} failed: ${result.description || "unknown error"}`,
    );
  }
  return result;
}
