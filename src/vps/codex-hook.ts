import { CodexBridgeClient } from "./codex-bridge-client";
import { isPlainRecord } from "./codex-bridge-protocol";

const MAX_INPUT_BYTES = 768 * 1024;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) return;
    chunks.push(buffer);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return;
  }
  const paneId = process.env.TMUX_PANE;
  if (!isPlainRecord(payload) || !paneId || !/^%\d{1,10}$/u.test(paneId)) {
    return;
  }
  const client = new CodexBridgeClient(
    process.env.CHATINABOX_BRIDGE_SOCKET,
    1_500,
  );
  await client
    .request({ op: "hook", paneId, payload })
    .catch(() => undefined);
}

main().finally(() => {
  // Stop hooks accept an empty JSON object as a no-op decision.
  process.stdout.write("{}\n");
});
