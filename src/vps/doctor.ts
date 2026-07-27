import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexBridgeClient } from "./codex-bridge-client";
import { normalizeExperienceProfile } from "./experience-profile";

interface Check {
  readonly ok: boolean;
  readonly label: string;
  readonly detail: string;
  readonly hint?: string;
  readonly required?: boolean;
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const environmentPath =
    process.env.CHATINABOX_ENV || "/etc/chatinabox/chatinabox.env";
  if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);

  const checks: Check[] = [];
  checks.push(environmentCheck(environmentPath));
  checks.push(profileCheck(
    process.env.CHATINABOX_PROFILE_PATH ||
      "/etc/chatinabox/profile.json",
  ));

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
  checks.push({
    ...executableCheck(
    "ImageMagick",
    process.env.CHATINABOX_CONVERT_PATH,
    ["/usr/bin/convert", "/usr/local/bin/convert"],
    ),
    required: false,
  });
  checks.push({
    ...executableCheck(
    "Chrome/Chromium",
    process.env.CHATINABOX_CHROME_PATH,
    [
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
    ),
    required: false,
  });

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
    const login = spawnSync(codex.detail, ["login", "status"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    checks.push({
      ok: login.status === 0,
      label: "Codex login",
      detail: login.status === 0
        ? login.stdout.trim() || "authenticated"
        : "root is not authenticated",
      hint: "Run sudo codex login.",
    });
    const help = spawnSync(codex.detail, ["--help"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const requiredFlags = [
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    ];
    const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
    checks.push({
      ok: help.status === 0 && missingFlags.length === 0,
      label: "Codex automation flags",
      detail: missingFlags.length === 0
        ? "full-access and trusted-hook flags available"
        : `missing: ${missingFlags.join(", ")}`,
      hint: "Update Codex, then re-run the installer.",
    });
  }

  checks.push(hooksCheck("/root/.codex/hooks.json"));

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
      id?: number;
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
    if (bot?.ok && Number.isSafeInteger(bot.result?.id)) {
      const databasePath = path.join(
        process.env.CHATINABOX_DATA_DIR || "/var/lib/chatinabox",
        "chatinabox.sqlite",
      );
      for (const chatId of registeredForumChats(databasePath)) {
        const membership = await telegramCall<{
          status?: string;
          can_manage_topics?: boolean;
          can_pin_messages?: boolean;
          can_delete_messages?: boolean;
          can_change_info?: boolean;
        }>(token, "getChatMember", {
          chat_id: chatId,
          user_id: bot.result!.id!,
        });
        const member = membership?.result;
        const creator = member?.status === "creator";
        const missing = creator
          ? []
          : [
              ["manage topics", member?.can_manage_topics],
              ["pin messages", member?.can_pin_messages],
              ["delete messages", member?.can_delete_messages],
              ["change group info", member?.can_change_info],
            ].filter(([, enabled]) => enabled !== true)
              .map(([label]) => label);
        checks.push({
          ok: membership?.ok === true &&
            (creator ||
              member?.status === "administrator" && missing.length === 0),
          label: `Forum permissions (${chatId})`,
          detail: membership?.ok !== true
            ? "could not inspect the bot membership"
            : creator
            ? "group creator"
            : missing.length === 0
            ? "topics, pins, deletes, and group info allowed"
            : `missing: ${missing.join(", ")}`,
          hint:
            "Enable topics, pins, deletes, and changing group info in the " +
            "bot's Telegram administrator permissions.",
        });
      }
    }

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
  checks.push(await artifactPublisherCheck(
    process.env.CHATINABOX_ARTIFACTS_API_URL,
    process.env.CHATINABOX_ARTIFACTS_API_TOKEN,
  ));

  const failed = checks.filter((check) => !check.ok && check.required !== false);
  const warnings = checks.filter((check) =>
    !check.ok && check.required === false
  );
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: failed.length === 0,
        checks,
        failed: failed.length,
        warnings: warnings.length,
      })}\n`,
    );
  } else {
    process.stdout.write("Chatinabox doctor\n\n");
    for (const check of checks) {
      process.stdout.write(
        `${check.ok ? "✓" : check.required === false ? "!" : "✗"} ` +
          `${check.label}\n  ${check.detail}\n`,
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
    if (warnings.length > 0) {
      process.stdout.write("\nOptional features:\n");
      for (const check of warnings) {
        if (check.hint) process.stdout.write(`- ${check.hint}\n`);
      }
    }
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

function registeredForumChats(databasePath: string): number[] {
  if (!existsSync(databasePath)) return [];
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database.prepare(
        "SELECT chat_id FROM nexus_dashboards ORDER BY chat_id",
      ).all() as unknown as { chat_id: number }[];
      return rows
        .map((row) => row.chat_id)
        .filter((chatId) => Number.isSafeInteger(chatId) && chatId < 0);
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}

function hooksCheck(hooksPath: string): Check {
  if (!existsSync(hooksPath)) {
    return {
      ok: false,
      label: "Codex hooks",
      detail: `missing: ${hooksPath}`,
      hint: "Re-run the installer to merge the Chatinabox hooks.",
    };
  }
  try {
    const text = readFileSync(hooksPath, "utf8");
    const required = [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "SessionEnd",
      "/opt/chatinabox/current/",
    ];
    const missing = required.filter((value) => !text.includes(value));
    return {
      ok: missing.length === 0,
      label: "Codex hooks",
      detail: missing.length === 0
        ? "installed without replacing unrelated hooks"
        : `missing managed entries: ${missing.join(", ")}`,
      hint: "Re-run the installer to repair the managed hook entries.",
    };
  } catch {
    return {
      ok: false,
      label: "Codex hooks",
      detail: `could not read ${hooksPath}`,
      hint: "Check root ownership and re-run the installer.",
    };
  }
}

function profileCheck(profilePath: string): Check {
  if (!existsSync(profilePath)) {
    return {
      ok: false,
      label: "Experience profile",
      detail: `missing: ${profilePath}`,
      hint: "Re-run the installer to create the neutral profile.",
    };
  }
  try {
    const stats = statSync(profilePath);
    const mode = stats.mode & 0o777;
    const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as unknown;
    const normalized = normalizeExperienceProfile(parsed);
    const root = typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
    const safe = stats.uid === 0 && (mode & 0o022) === 0;
    const valid = root.version === 1 &&
      typeof root.assistant === "object" &&
      typeof root.overview === "object" &&
      typeof root.manager === "object" &&
      typeof root.sessions === "object";
    return {
      ok: safe && valid,
      label: "Experience profile",
      detail:
        `${profilePath} · ${normalized.setupComplete ? "configured" : "setup pending"} · ` +
        `mode ${mode.toString(8).padStart(3, "0")}`,
      hint: safe
        ? "Run chatinabox profile defaults, then revisit /settings."
        : `Run chown root:root ${profilePath} && chmod 644 ${profilePath}.`,
    };
  } catch {
    return {
      ok: false,
      label: "Experience profile",
      detail: `invalid JSON: ${profilePath}`,
      hint: "Run chatinabox profile defaults, then revisit /settings.",
    };
  }
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
  body?: Record<string, unknown>,
): Promise<{ ok?: boolean; result?: T } | null> {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    ...(body && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(5_000),
  }).then((response) => response.json() as Promise<{
    ok?: boolean;
    result?: T;
  }>).catch(() => null);
}

async function artifactPublisherCheck(
  configuredUrl: string | undefined,
  configuredToken: string | undefined,
): Promise<Check> {
  const apiUrl = configuredUrl?.trim();
  const apiToken = configuredToken?.trim();
  if (!apiUrl && !apiToken) {
    return {
      ok: false,
      required: false,
      label: "Artifact shelf",
      detail: "native sharing enabled; session shelf publisher not configured",
      hint:
        "Optional: configure CHATINABOX_ARTIFACTS_API_URL and " +
        "CHATINABOX_ARTIFACTS_API_TOKEN.",
    };
  }
  if (!apiUrl || !apiToken) {
    return {
      ok: false,
      required: false,
      label: "Artifact shelf",
      detail: "publisher configuration is incomplete",
      hint:
        "Set both CHATINABOX_ARTIFACTS_API_URL and " +
        "CHATINABOX_ARTIFACTS_API_TOKEN, or remove both.",
    };
  }
  let healthUrl: URL;
  try {
    const base = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
    if (base.protocol !== "https:") throw new Error("HTTPS required");
    healthUrl = new URL("v1/health", base);
  } catch {
    return {
      ok: false,
      required: false,
      label: "Artifact shelf",
      detail: "publisher URL is not a valid HTTPS URL",
      hint: "Set CHATINABOX_ARTIFACTS_API_URL to the publisher API root.",
    };
  }
  try {
    const response = await fetch(healthUrl, {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => null) as {
      ok?: boolean;
    } | null;
    return {
      ok: response.ok && body?.ok === true,
      required: false,
      label: "Artifact shelf",
      detail: response.ok && body?.ok === true
        ? `publisher responding at ${healthUrl.origin}`
        : `publisher health rejected (${response.status})`,
      hint: "Check the artifact publisher URL, token, and service logs.",
    };
  } catch {
    return {
      ok: false,
      required: false,
      label: "Artifact shelf",
      detail: `publisher unavailable at ${healthUrl.origin}`,
      hint: "Check the artifact publisher URL, TLS, firewall, and service.",
    };
  }
}

void main();
