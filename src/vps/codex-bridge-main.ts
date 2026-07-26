import {
  CodexBridge,
} from "./codex-bridge";
import { DEFAULT_CODEX_BRIDGE_SOCKET } from "./codex-bridge-protocol";

const bridge = new CodexBridge({
  socketPath:
    process.env.CATINABOX_BRIDGE_SOCKET ?? DEFAULT_CODEX_BRIDGE_SOCKET,
  databasePath:
    process.env.CATINABOX_BRIDGE_DB ??
    "/var/lib/catinabox/bridge.sqlite",
  defaultCwd: process.env.CATINABOX_DEFAULT_CWD ?? process.cwd(),
  lobbyCwd:
    process.env.CATINABOX_LOBBY_CWD ??
    "/var/lib/catinabox/lobby",
});

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`[CodexBridge] ${signal} received; shutting down.`);
  await bridge.close();
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

bridge.listen().then(
  () => console.log("[CodexBridge] Ready."),
  () => {
    console.error("[CodexBridge] Failed to start.");
    process.exit(1);
  },
);
