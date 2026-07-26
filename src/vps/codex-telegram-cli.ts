import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  escapeTelegramHtml,
  tgSendDocument,
  tgSendPhoto,
} from "../telegram";
import type { BotEnv, TelegramResponse } from "../telegram-types";
import { CodexBridgeClient } from "./codex-bridge-client";
import type {
  CodexBridgeResponse,
  CodexPane,
  CodexPaneIdentity,
} from "./codex-bridge-protocol";
import { buildCatinaboxCatalog } from "./catinabox-catalog";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = removeFlag(args, "--json");
  const command = args.shift() ?? "list";
  const bridge = new CodexBridgeClient();

  try {
    if (command === "catalog") {
      return outputCatalog(await bridge.request({ op: "list" }), json);
    }
    if (command === "list" || command === "status") {
      return output(await bridge.request({ op: "list" }), json);
    }
    if (command === "new") {
      const cwd = takeOption(args, "--cwd");
      const model = parseWorkerModel(takeOption(args, "--model"));
      const reasoningEffort = parseReasoningEffort(
        takeOption(args, "--effort"),
      );
      const fast = removeFlag(args, "--fast");
      const name = args.join(" ").trim() || undefined;
      return output(
        await bridge.request({
          op: "new",
          ...(name ? { name } : {}),
          ...(cwd ? { cwd } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(fast ? { fast: true } : {}),
        }),
        json,
      );
    }
    if (command === "lobby") {
      return output(await bridge.request({ op: "lobby" }), json);
    }
    if (command === "self") {
      const action = args.shift();
      const source = await resolveCurrentTarget(bridge);
      if (!source) {
        return usage("self commands must run inside a discovered Codex tmux pane");
      }
      if (action === "status") {
        const listed = await bridge.request({ op: "list" });
        if (!listed.ok || !("panes" in listed)) return output(listed, json);
        const pane = listed.panes.find((candidate) =>
          candidate.serverPid === source.serverPid &&
          candidate.paneId === source.paneId &&
          candidate.panePid === source.panePid
        );
        return pane
          ? output({ ok: true, pane }, json)
          : usage("the current Codex session is no longer running");
      }
      if (action === "rename") {
        const name = args.join(" ").trim();
        if (!name) return usage("self rename requires NAME");
        return output(
          await bridge.request({ op: "renameSelf", target: source, name }),
          json,
        );
      }
      if (action === "lobby" || action === "disconnect") {
        const lobby = await bridge.request({ op: "lobby" });
        if (!lobby.ok || !("pane" in lobby)) return output(lobby, json);
        return output(
          await bridge.request({
            op: "handoff",
            source,
            destination: lobby.pane,
          }),
          json,
        );
      }
      return usage("self requires status, rename NAME, or lobby");
    }
    if (command === "handoff") {
      const selector = args.shift();
      if (!selector) return usage("handoff requires TARGET");
      const source = await resolveCurrentTarget(bridge);
      if (!source) {
        return usage("handoff must run inside a discovered Codex tmux pane");
      }
      const destination = await resolveTarget(bridge, selector);
      if (!destination) return usage(`no unique Codex pane matched ${selector}`);
      return output(
        await bridge.request({ op: "handoff", source, destination }),
        json,
      );
    }
    if (command === "new-and-handoff") {
      const cwd = takeOption(args, "--cwd");
      const model = parseWorkerModel(takeOption(args, "--model"));
      const reasoningEffort = parseReasoningEffort(
        takeOption(args, "--effort"),
      );
      const fast = removeFlag(args, "--fast");
      const name = args.join(" ").trim() || undefined;
      const source = await resolveCurrentTarget(bridge);
      if (!source) {
        return usage("new-and-handoff must run inside a discovered Codex tmux pane");
      }
      const created = await bridge.request({
        op: "new",
        ...(name ? { name } : {}),
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(fast ? { fast: true } : {}),
      });
      if (!created.ok || !("pane" in created)) return output(created, json);
      return output(
        await bridge.request({
          op: "handoff",
          source,
          destination: created.pane,
        }),
        json,
      );
    }
    if (command === "resume") {
      const sessionId = args.shift();
      if (!sessionId) return usage("resume requires a saved session id");
      const name = args.join(" ").trim() || undefined;
      return output(
        await bridge.request({
          op: "resume",
          sessionId,
          ...(name ? { name } : {}),
        }),
        json,
      );
    }
    if (command === "rename") {
      const selector = args.shift();
      const name = args.join(" ").trim();
      if (!selector || !name) return usage("rename requires TARGET and NAME");
      const target = await resolveTarget(bridge, selector);
      if (!target) return usage(`no unique Codex pane matched ${selector}`);
      return output(
        await bridge.request({ op: "rename", target, name }),
        json,
      );
    }
    if (command === "interrupt") {
      const selector = args.shift();
      if (!selector) return usage("interrupt requires TARGET");
      const target = await resolveTarget(bridge, selector);
      if (!target) return usage(`no unique Codex pane matched ${selector}`);
      return output(await bridge.request({ op: "interrupt", target }), json);
    }
    if (command === "keys" || command === "key") {
      const selector = args.shift();
      if (!selector || args.length < 1) {
        return usage("keys requires TARGET and one or more keys");
      }
      const target = await resolveTarget(bridge, selector);
      if (!target) return usage(`no unique Codex pane matched ${selector}`);
      return output(
        await bridge.request({ op: "keys", target, keys: args }),
        json,
      );
    }
    if (command === "screen") {
      const selector = args.shift();
      if (!selector) return usage("screen requires TARGET");
      const outputPath = takeOption(args, "--output");
      const target = await resolveTarget(bridge, selector);
      if (!target) return usage(`no unique Codex pane matched ${selector}`);
      const response = await bridge.request({ op: "screen", target });
      if (
        response.ok &&
        "screen" in response &&
        outputPath
      ) {
        writeFileSync(
          outputPath,
          Buffer.from(response.screen.imageBase64, "base64"),
          { mode: 0o600 },
        );
        if (!json) {
          process.stdout.write(`${outputPath}\n`);
          return 0;
        }
      }
      return output(response, json);
    }
    if (command === "send") {
      const selector = args.shift();
      if (!selector) return usage("send requires TARGET");
      const target = await resolveTarget(bridge, selector);
      if (!target) return usage(`no unique Codex pane matched ${selector}`);
      const text = args.join(" ").trim() || readStdin();
      if (!text) return usage("send requires prompt text or stdin");
      return output(await bridge.request({ op: "send", target, text }), json);
    }
    if (command === "send-image" || command === "send-file") {
      const file = args.shift();
      if (!file) return usage(`${command} requires FILE`);
      const chatOption = takeOption(args, "--chat");
      const caption = args.join(" ").trim();
      return await deliverTelegramMedia(
        command,
        file,
        caption,
        chatOption,
        json,
      );
    }
    if (command === "help" || command === "--help" || command === "-h") {
      process.stdout.write(help());
      return 0;
    }
    return usage(`unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: "UNAVAILABLE", error: message })}\n`,
      );
    } else {
      process.stderr.write(`codex-telegram: ${message}\n`);
    }
    return 1;
  }
}

async function resolveTarget(
  bridge: CodexBridgeClient,
  selector: string,
): Promise<CodexPaneIdentity | null> {
  const response = await bridge.request({ op: "list" });
  if (!response.ok || !("panes" in response)) return null;
  let matches: readonly CodexPane[];
  if (/^\d{1,2}$/u.test(selector)) {
    matches = response.panes[Number(selector) - 1]
      ? [response.panes[Number(selector) - 1]]
      : [];
  } else if (/^%\d{1,10}$/u.test(selector)) {
    matches = response.panes.filter((pane) => pane.paneId === selector);
  } else {
    const normalized = selector.toLowerCase();
    matches = response.panes.filter(
      (pane) =>
        pane.windowName.toLowerCase() === normalized ||
        pane.sessionName.toLowerCase() === normalized,
    );
  }
  const pane = matches.length === 1 ? matches[0] : null;
  return pane
    ? {
        serverPid: pane.serverPid,
        paneId: pane.paneId,
        panePid: pane.panePid,
      }
    : null;
}

async function resolveCurrentTarget(
  bridge: CodexBridgeClient,
): Promise<CodexPaneIdentity | null> {
  const paneId = process.env.TMUX_PANE?.trim();
  if (paneId && /^%\d{1,10}$/u.test(paneId)) {
    return resolveTarget(bridge, paneId);
  }
  const threadId = process.env.CODEX_THREAD_ID?.trim();
  if (!threadId) return null;
  const response = await bridge.request({ op: "list" });
  if (!response.ok || !("panes" in response)) return null;
  const matches = response.panes.filter((pane) => pane.sessionId === threadId);
  const pane = matches.length === 1 ? matches[0] : null;
  return pane
    ? {
        serverPid: pane.serverPid,
        paneId: pane.paneId,
        panePid: pane.panePid,
      }
    : null;
}

function output(response: CodexBridgeResponse, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
  }
  if (!response.ok) {
    process.stderr.write(`codex-telegram: ${response.error}\n`);
    return 1;
  }
  if ("panes" in response) {
    if (response.panes.length === 0) {
      process.stdout.write("No running Codex tmux sessions.\n");
    } else {
      for (const [index, pane] of response.panes.entries()) {
        process.stdout.write(
          `${index + 1}. ${pane.windowName}  ${pane.paneId}  ${pane.cwd}` +
            `  ${pane.busy ? "busy" : "ready"}` +
            `${pane.sessionId ? `  ${pane.sessionId}` : ""}\n`,
        );
      }
    }
    if (response.recent.length > 0) {
      process.stdout.write("\nRecent saved chats:\n");
      for (const recent of response.recent) {
        process.stdout.write(
          `- ${recent.name}  ${recent.id}  ${recent.updatedAt}\n`,
        );
      }
    }
  } else if ("pane" in response) {
    process.stdout.write(
      `${response.pane.windowName} ${response.pane.paneId} ${response.pane.cwd}\n`,
    );
  } else if ("sent" in response) {
    process.stdout.write("Prompt sent.\n");
  } else if ("interrupted" in response) {
    process.stdout.write("Interrupt sent.\n");
  } else if ("keysSent" in response) {
    process.stdout.write("Keys sent.\n");
  } else if ("screen" in response) {
    process.stdout.write(
      `Terminal image captured (${response.screen.width}x${response.screen.height}). ` +
        "Use --output FILE or --json.\n",
    );
  } else if ("handoffQueued" in response) {
    process.stdout.write(
      `Handoff queued for after this turn → ${response.destination.windowName}.\n`,
    );
  } else if ("acked" in response) {
    process.stdout.write(`${response.acked ? "Acknowledged" : "Not found"}.\n`);
  } else {
    process.stdout.write("OK\n");
  }
  return 0;
}

function outputCatalog(
  response: CodexBridgeResponse,
  json: boolean,
): number {
  if (!response.ok || !("panes" in response)) return output(response, json);
  const catalog = buildCatinaboxCatalog(
    response.panes,
    response.recent,
    mostRecentAttachedTarget(),
  );
  if (json) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return 0;
  }
  const lines = ["🪄 Catinabox catalog"];
  lines.push(
    catalog.attached
      ? `Attached: ${catalog.attached.name} (${catalog.attached.role})`
      : "Attached: none",
    "",
    "Running workers:",
    ...(
      catalog.workers.length > 0
        ? catalog.workers.map(
            (worker) =>
              `- ${worker.selector}  ${worker.name}  ${worker.model}  ` +
              `${worker.status}  ${worker.cwd}`,
          )
        : ["- none"]
    ),
  );
  if (catalog.recent.length > 0) {
    lines.push(
      "",
      "Recent saved threads:",
      ...catalog.recent.map(
        (session) => `- ${session.name}  ${session.sessionId}`,
      ),
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function readStdin(): string {
  if (process.stdin.isTTY) return "";
  return readFileSync(0, "utf8").trim();
}

async function deliverTelegramMedia(
  command: "send-image" | "send-file",
  inputPath: string,
  caption: string,
  chatOption: string | undefined,
  json: boolean,
): Promise<number> {
  const filePath = path.resolve(inputPath);
  const stats = statSync(filePath);
  if (!stats.isFile()) return usage("FILE must be a regular file");
  const maxBytes =
    command === "send-image" ? 10 * 1024 * 1024 : 49 * 1024 * 1024;
  if (stats.size < 1 || stats.size > maxBytes) {
    return usage(
      command === "send-image"
        ? "send-image accepts files up to 10 MB"
        : "send-file accepts files up to 49 MB",
    );
  }

  const { env, chatId } = loadTelegramDeliveryTarget(chatOption);
  const fileName = path.basename(filePath);
  const bytes = readFileSync(filePath);
  const safeCaption = caption
    ? escapeTelegramHtml(caption).slice(0, 900)
    : undefined;
  let response: TelegramResponse<{ message_id: number }>;
  if (command === "send-image") {
    response = await tgSendPhoto(
      env,
      chatId,
      new Blob([bytes], { type: imageMimeType(fileName) }),
      safeCaption,
    );
  } else {
    const raw = await tgSendDocument(
      env,
      chatId,
      new Blob([bytes], { type: "application/octet-stream" }),
      fileName,
      safeCaption,
    );
    response = (await raw.json()) as TelegramResponse<{ message_id: number }>;
  }
  if (!response.ok) {
    throw new Error("Telegram rejected the media delivery");
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        delivered: true,
        chatId,
        messageId: response.result.message_id,
        file: filePath,
      })}\n`,
    );
  } else {
    process.stdout.write(
      `Delivered ${fileName} to Telegram (message ${response.result.message_id}).\n`,
    );
  }
  return 0;
}

function loadTelegramDeliveryTarget(
  chatOption: string | undefined,
): { readonly env: BotEnv; readonly chatId: number } {
  const secretsPath =
    process.env.CATINABOX_ENV ?? "/etc/catinabox/catinabox.env";
  if (existsSync(secretsPath)) process.loadEnvFile(secretsPath);
  const token = process.env.TG_BOT_TOKEN?.trim();
  if (!token) throw new Error("TG_BOT_TOKEN is unavailable");

  const rawChat =
    chatOption ??
    process.env.CATINABOX_TELEGRAM_CHAT_ID ??
    process.env.TG_ALLOWED_USER_IDS?.split(",")
      .map((value) => value.trim())
      .find((value) => /^\d+$/u.test(value)) ??
    mostRecentAttachedChat();
  if (!rawChat || !/^-?\d+$/u.test(rawChat)) {
    throw new Error(
      "No default Telegram chat is configured; use --chat CHAT_ID",
    );
  }
  const chatId = Number(rawChat);
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error("Telegram chat id is invalid");
  }
  return { env: { TG_BOT_TOKEN: token }, chatId };
}

function mostRecentAttachedChat(): string | undefined {
  const dataDir =
    process.env.CATINABOX_DATA_DIR ?? "/var/lib/catinabox";
  const databasePath = path.join(dataDir, "catinabox.sqlite");
  if (!existsSync(databasePath)) return undefined;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      `SELECT chat_id
       FROM codex_attachments
       ORDER BY attached_at DESC
       LIMIT 1`,
    ).get() as { chat_id?: number } | undefined;
    const chatId = row?.chat_id;
    return Number.isSafeInteger(chatId) && chatId !== 0
      ? String(chatId)
      : undefined;
  } finally {
    database.close();
  }
}

function mostRecentAttachedTarget(): CodexPaneIdentity | null {
  const dataDir =
    process.env.CATINABOX_DATA_DIR ?? "/var/lib/catinabox";
  const databasePath = path.join(dataDir, "catinabox.sqlite");
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      `SELECT server_pid, pane_id, pane_pid
       FROM codex_attachments
       ORDER BY attached_at DESC
       LIMIT 1`,
    ).get() as {
      server_pid?: number;
      pane_id?: string;
      pane_pid?: number;
    } | undefined;
    const target = row
      ? {
          serverPid: row.server_pid,
          paneId: row.pane_id,
          panePid: row.pane_pid,
        }
      : null;
    return isPaneIdentityLike(target) ? target : null;
  } finally {
    database.close();
  }
}

function isPaneIdentityLike(value: unknown): value is CodexPaneIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const target = value as Record<string, unknown>;
  return Number.isSafeInteger(target.serverPid) &&
    Number(target.serverPid) > 0 &&
    typeof target.paneId === "string" &&
    /^%\d{1,10}$/u.test(target.paneId) &&
    Number.isSafeInteger(target.panePid) &&
    Number(target.panePid) > 0;
}

function imageMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function removeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

function parseWorkerModel(
  value: string | undefined,
): "sol" | "luna" | "terra" | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "sol" || normalized === "luna" || normalized === "terra") {
    return normalized;
  }
  throw new Error("--model must be sol, luna, or terra");
}

function parseReasoningEffort(
  value: string | undefined,
): "low" | "medium" | "high" | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  throw new Error("--effort must be low, medium, or high");
}

function usage(error: string): number {
  process.stderr.write(`catinabox: ${error}\n\n${help()}`);
  return 2;
}

function help(): string {
  return `Usage: catinabox COMMAND [ARGS] [--json]

Commands:
  catalog                      Canonical attached/running/recent session view
  list                         List running and recent Codex sessions
  new [NAME] [OPTIONS]         Start a full-access Codex session in tmux
  lobby                        Ensure the persistent 🪄 Lobby is running
  resume SESSION_ID [NAME]     Resume a saved Codex chat in tmux
  rename TARGET NAME           Rename a running session
  self rename NAME             Rename the current Codex session
  self status                  Resolve this Codex thread to its running pane
  self lobby                   Return Telegram to 🪄 Lobby after this turn
  handoff TARGET               Attach Telegram to TARGET after this turn
  new-and-handoff [NAME]       Start a worker and hand off after this turn
  send TARGET TEXT             Send a prompt (or read it from stdin)
  interrupt TARGET             Send Ctrl-C
  keys TARGET KEY [KEY...]     Send allowlisted terminal keys
  screen TARGET --output FILE  Capture the current terminal as PNG
  send-image FILE [CAPTION]    Send an inline image to your Telegram chat
  send-file FILE [CAPTION]     Send a local file to your Telegram chat

TARGET can be the 1-based list number, tmux pane id (%4), or unique name.
New-session options: --cwd PATH, --model sol|luna|terra,
  --effort low|medium|high, --fast. Defaults: Sol, high, Standard.
Media commands use the sole allowed user as the default chat; override with --chat ID.
Use --json for a stable machine-readable interface.
`;
}

main().then((code) => {
  process.exitCode = code;
});
