import { existsSync, statSync } from "node:fs";
import { CodexBridgeClient } from "./codex-bridge-client";

interface Check {
  readonly ok: boolean;
  readonly label: string;
  readonly detail: string;
}

async function main(): Promise<void> {
  const environmentPath =
    process.env.CATINABOX_ENV || "/etc/catinabox/catinabox.env";
  if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);

  const checks: Check[] = [];
  checks.push(fileCheck("tmux", process.env.CATINABOX_TMUX_PATH, [
    "/usr/bin/tmux",
    "/usr/local/bin/tmux",
  ]));
  checks.push(fileCheck("Codex CLI", process.env.CATINABOX_CODEX_PATH, [
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ]));
  checks.push(fileCheck("ImageMagick", process.env.CATINABOX_CONVERT_PATH, [
    "/usr/bin/convert",
    "/usr/local/bin/convert",
  ]));
  checks.push(fileCheck("Chrome/Chromium", process.env.CATINABOX_CHROME_PATH, [
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]));

  const token = process.env.TG_BOT_TOKEN?.trim();
  const allowed = process.env.TG_ALLOWED_USER_IDS?.trim();
  checks.push({
    ok: Boolean(token),
    label: "Telegram token",
    detail: token ? "configured (hidden)" : "missing",
  });
  checks.push({
    ok: Boolean(allowed && allowed !== "*" && /^[1-9]\d*(?:,[1-9]\d*)*$/u.test(allowed)),
    label: "Owner allowlist",
    detail: allowed
      ? allowed === "*" ? "wildcard is forbidden" : `${allowed.split(",").length} owner(s)`
      : "missing",
  });

  const socket =
    process.env.CATINABOX_BRIDGE_SOCKET || "/run/catinabox/bridge.sock";
  const bridge = await new CodexBridgeClient(socket, 2_000)
    .request({ op: "ping" })
    .catch(() => null);
  checks.push({
    ok: bridge?.ok === true && "pong" in bridge,
    label: "Session bridge",
    detail: bridge?.ok ? "responding" : `unavailable at ${socket}`,
  });

  if (token) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: AbortSignal.timeout(5_000) },
    ).then((value) => value.json() as Promise<{ ok?: boolean; result?: { username?: string } }>)
      .catch(() => null);
    checks.push({
      ok: response?.ok === true,
      label: "Telegram API",
      detail: response?.ok
        ? `connected as @${response.result?.username || "bot"}`
        : "not reachable or token rejected",
    });
  }

  for (const check of checks) {
    process.stdout.write(
      `${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}\n`,
    );
  }
  const failed = checks.filter((check) => !check.ok).length;
  process.stdout.write(
    failed === 0
      ? "\nCatinabox is ready.\n"
      : `\n${failed} check(s) need attention.\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

function fileCheck(
  label: string,
  configured: string | undefined,
  candidates: readonly string[],
): Check {
  const path = configured?.trim() ||
    candidates.find((candidate) => existsSync(candidate));
  const ok = Boolean(path && statSync(path).isFile());
  return { ok, label, detail: ok ? path! : "not found" };
}

void main();
