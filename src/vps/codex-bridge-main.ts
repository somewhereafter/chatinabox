import {
  CodexBridge,
} from "./codex-bridge";
import { DEFAULT_CODEX_BRIDGE_SOCKET } from "./codex-bridge-protocol";
import { readExperienceProfile } from "./experience-profile";

const profile = readExperienceProfile(
  process.env.CHATINABOX_PROFILE_PATH ??
    "/etc/chatinabox/profile.json",
);

const bridge = new CodexBridge({
  socketPath:
    process.env.CHATINABOX_BRIDGE_SOCKET ?? DEFAULT_CODEX_BRIDGE_SOCKET,
  databasePath:
    process.env.CHATINABOX_BRIDGE_DB ??
    "/var/lib/chatinabox-bridge/bridge.sqlite",
  defaultCwd: process.env.CHATINABOX_DEFAULT_CWD ?? process.cwd(),
  lobbyCwd:
    process.env.CHATINABOX_LOBBY_CWD ??
    "/var/lib/chatinabox-bridge/lobby",
  managerCwd:
    process.env.CHATINABOX_MANAGER_CWD ??
    profile.manager.cwd,
  workspaceRoots: (
    process.env.CHATINABOX_WORKSPACE_ROOTS ??
      process.env.CHATINABOX_DEFAULT_CWD ??
      "/root"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`[ChatinaboxBridge] ${signal} received; shutting down.`);
  await bridge.close();
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

bridge.listen().then(
  () => console.log("[ChatinaboxBridge] Ready."),
  () => {
    console.error("[ChatinaboxBridge] Failed to start.");
    process.exit(1);
  },
);
