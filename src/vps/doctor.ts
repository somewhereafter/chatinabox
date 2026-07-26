import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CodexBridgeClient } from "./codex-bridge-client";

interface Check {
  readonly ok: boolean;
  readonly label: string;
  readonly detail: string;
  readonly hint?: string;
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const environmentPath =
    process.env.CHATINABOX_ENV || "/etc/chatinabox/chatinabox.env";
  if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);

  const checks: Check[] = [];
  checks.push(environmentCheck(environmentPath));

  const tmux = executableCheck("tmux", process.env.CHATINABOX_TMUX_PATH, [
    "/usr/bin/tmux",
    "/usr/local/bin/tmux",
  ]);
  const codex = executableCheck(
    "Codex CLI",
    process.env.CHATINABOX_CODEX_PATH,
    ["/usr/local/bin/codex", "/usr/bin/codex"],
  );
  checks.push(tmux, codex);
  checks.push(executableCheck(
    "ImageMagick",
    process.env.CHATINABOX_CONVERT_PATH,
    ["/usr/bin/convert", "/usr/local/bin/convert"],
  ));
  checks.push(executableCheck(
    "Chrome/Chromium",
    process.env.CHATINABOX_CHROME_PATH,
    [
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
  ));

  if (codex.ok) {
    const version = spawnSync(codex.detail, ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    checks.push({
      ok: version.status === 0,
      label: "Codex version",
      detail: version.status === 0
        ? version.stdout.trim() || "available"
        : "could not execute",
      hint: "Run codex --version as root.",
    });
  }

  const token = process.env.TG_BOT_TOKEN?.trim();
  const allowed = process.env.TG_ALLOWED_USER_IDS?.trim();
  checks.push({
    ok: Boolean(token),
    label: "Telegram token",
    detail: token ? "configured (hidden)" : "missing",
    hint: `Set TG_BOT_TOKEN in ${environmentPath}.`,
  });
  checks.push({
    ok: Boolean(
      allowed &&
      allowed !== "*" &&
      /^[1-9]\d*(?:,[1-9]\d*)*$/u.test(allowed),
    ),
    label: "Owner allowlist",
    detail: allowed
      ? allowed === "*"
        ? "wildcard is forbidden"
        : `${allowed.split(",").length} owner${allowed.includes(",") ? "s" : ""}`
      : "missing",
    hint: "Set TG_ALLOWED_USER_IDS to your numeric Telegram user ID.",
  });

  checks.push(serviceCheck("Bridge service", "chatinabox-bridge.service"));
  checks.push(serviceCheck("Telegram service", "chatinabox.service"));

  const socket =
    process.env.CHATINABOX_BRIDGE_SOCKET || "/run/chatinabox/bridge.sock";
  const bridge = await new CodexBridgeClient(socket, 2_000)
    .request({ op: "ping" })
    .catch(() => null);
  checks.push({
    ok: bridge?.ok === true && "pong" in bridge,
    label: "Session bridge",
    detail: bridge?.ok ? "responding" : `unavailable at ${socket}`,
    hint: "Inspect: journalctl -u chatinabox-bridge -n 50",
  });

  if (token) {
    const bot = await telegramCall<{
      username?: string;
    }>(token, "getMe");
    checks.push({
      ok: bot?.ok === true,
      label: "Telegram API",
      detail: bot?.ok
        ? `connected as @${bot.result?.username || "bot"}`
        : "not reachable or token rejected",
      hint: "Verify the BotFather token and outbound HTTPS.",
    });

    const webhook = await telegramCall<{ url?: string }>(
      token,
      "getWebhookInfo",
    );
    const webhookUrl = webhook?.result?.url?.trim() || "";
    checks.push({
      ok: webhook?.ok === true && webhookUrl === "",
      label: "Telegram delivery",
      detail: webhook?.ok
        ? webhookUrl
          ? "a webhook is still active"
          : "long polling is clear"
        : "could not inspect webhook state",
      hint: "Re-run the installer to clear the webhook.",
    });
  }

  const failed = checks.filter((check) => !check.ok);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: failed.length === 0,
        checks,
        failed: failed.length,
      })}\n`,
    );
  } else {
    process.stdout.write("Chatinabox doctor\n\n");
    for (const check of checks) {
      process.stdout.write(
        `${check.ok ? "✓" : "✗"} ${check.label}\n  ${check.detail}\n`,
      );
    }
    if (failed.length === 0) {
      process.stdout.write("\nEverything is connected. Send /start in Telegram.\n");
    } else {
      process.stdout.write(`\n${failed.length} check${failed.length === 1 ? "" : "s"} need attention:\n`);
      for (const check of failed) {
        if (check.hint) process.stdout.write(`- ${check.hint}\n`);
      }
    }
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

function environmentCheck(path: string): Check {
  if (!existsSync(path)) {
    return {
      ok: false,
      label: "Environment",
      detail: `missing: ${path}`,
      hint: "Run sudo ./scripts/install.sh.",
    };
  }
  const stats = statSync(path);
  const mode = stats.mode & 0o777;
  const safe = stats.uid === 0 && (mode & 0o027) === 0;
  return {
    ok: safe,
    label: "Environment",
    detail:
      `${path} · mode ${mode.toString(8).padStart(3, "0")} · ` +
      `${stats.uid === 0 ? "root-owned" : `uid ${stats.uid}`}`,
    hint: `Run chown root:chatinabox ${path} && chmod 640 ${path}.`,
  };
}

function executableCheck(
  label: string,
  configured: string | undefined,
  candidates: readonly string[],
): Check {
  const path = configured?.trim() ||
    candidates.find((candidate) => existsSync(candidate));
  const ok = Boolean(path && existsSync(path) && statSync(path).isFile());
  return {
    ok,
    label,
    detail: ok ? path! : "not found",
    hint: `Install ${label} or configure its CHATINABOX_*_PATH override.`,
  };
}

function serviceCheck(label: string, unit: string): Check {
  if (!existsSync("/usr/bin/systemctl") && !existsSync("/bin/systemctl")) {
    return { ok: false, label, detail: "systemctl not found" };
  }
  const result = spawnSync("systemctl", ["is-active", unit], {
    encoding: "utf8",
    timeout: 3_000,
  });
  const state = result.stdout.trim() || "inactive";
  return {
    ok: result.status === 0 && state === "active",
    label,
    detail: state,
    hint: `Inspect: systemctl status ${unit}`,
  };
}

async function telegramCall<T>(
  token: string,
  method: string,
): Promise<{ ok?: boolean; result?: T } | null> {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    signal: AbortSignal.timeout(5_000),
  }).then((response) => response.json() as Promise<{
    ok?: boolean;
    result?: T;
  }>).catch(() => null);
}

void main();
