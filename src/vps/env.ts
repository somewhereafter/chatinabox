import path from "node:path";

export interface CatinaboxEnv {
  readonly TG_BOT_TOKEN: string;
  readonly TG_ALLOWED_USER_IDS: string;
  readonly DATA_DIR: string;
  readonly CODEX_BRIDGE_SOCKET: string;
  readonly DEFAULT_CWD: string;
}

export function loadCatinaboxEnv(
  source: NodeJS.ProcessEnv = process.env,
): CatinaboxEnv {
  const token = source.TG_BOT_TOKEN?.trim();
  if (!token) throw new Error("TG_BOT_TOKEN is required");

  const allowed = source.TG_ALLOWED_USER_IDS?.trim();
  if (!allowed || allowed === "*") {
    throw new Error(
      "TG_ALLOWED_USER_IDS must contain your numeric Telegram user ID",
    );
  }

  const dataDir = path.resolve(
    source.CATINABOX_DATA_DIR?.trim() || "/var/lib/catinabox",
  );
  return {
    TG_BOT_TOKEN: token,
    TG_ALLOWED_USER_IDS: allowed,
    DATA_DIR: dataDir,
    CODEX_BRIDGE_SOCKET:
      source.CATINABOX_BRIDGE_SOCKET?.trim() ||
      "/run/catinabox/bridge.sock",
    DEFAULT_CWD: path.resolve(
      source.CATINABOX_DEFAULT_CWD?.trim() || process.cwd(),
    ),
  };
}
