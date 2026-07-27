import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  escapeTelegramHtml,
  tgSetChatPhoto,
  tgSetChatTitle,
  tgSetMyName,
  tgSetMyProfilePhoto,
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
import { buildChatinaboxCatalog } from "./chatinabox-catalog";
import {
  DEFAULT_EXPERIENCE_PROFILE,
  patchExperienceProfile,
  readExperienceProfile,
  writeExperienceProfile,
  type ExperienceProfilePatch,
  type ReasoningEffort,
  type WorkerModel,
} from "./experience-profile";

async function main(): Promise<number> {
  const environmentPath =
    process.env.CHATINABOX_ENV ?? "/etc/chatinabox/chatinabox.env";
  if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);
  const args = process.argv.slice(2);
  const json = removeFlag(args, "--json");
  const command = args.shift() ?? "list";
  const bridge = new CodexBridgeClient();

  try {
    if (command === "profile") {
      return await profileCommand(args, json);
    }
    if (command === "catalog") {
      return outputCatalog(await bridge.request({ op: "list" }), json);
    }
    if (command === "list" || command === "status") {
      return output(await bridge.request({ op: "list" }), json);
    }
    if (command === "new") {
      const defaults = configuredWorkerDefaults();
      const cwd = takeOption(args, "--cwd");
      const model =
        parseWorkerModel(takeOption(args, "--model")) ?? defaults.model;
      const reasoningEffort =
        parseReasoningEffort(takeOption(args, "--effort")) ??
        defaults.reasoningEffort;
      const fast = configuredFast(args, defaults.fast);
      const name = args.join(" ").trim() || undefined;
      return output(
        await bridge.request({
          op: "new",
          ...(name ? { name } : {}),
          ...(cwd ? { cwd } : {}),
          model,
          reasoningEffort,
          fast,
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
      const defaults = configuredWorkerDefaults();
      const cwd = takeOption(args, "--cwd");
      const model =
        parseWorkerModel(takeOption(args, "--model")) ?? defaults.model;
      const reasoningEffort =
        parseReasoningEffort(takeOption(args, "--effort")) ??
        defaults.reasoningEffort;
      const fast = configuredFast(args, defaults.fast);
      const name = args.join(" ").trim() || undefined;
      const source = await resolveCurrentTarget(bridge);
      if (!source) {
        return usage("new-and-handoff must run inside a discovered Codex tmux pane");
      }
      const created = await bridge.request({
        op: "new",
        ...(name ? { name } : {}),
        ...(cwd ? { cwd } : {}),
        model,
        reasoningEffort,
        fast,
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
      const threadOption = takeOption(args, "--thread");
      const caption = args.join(" ").trim();
      const source = chatOption
        ? null
        : await resolveCurrentTarget(bridge);
      return await deliverTelegramMedia(
        command,
        file,
        caption,
        chatOption,
        threadOption,
        source,
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
      process.stderr.write(`chatinabox: ${message}\n`);
    }
    return 1;
  }
}

async function profileCommand(args: string[], json: boolean): Promise<number> {
  const action = args.shift() ?? "show";
  const profilePath =
    process.env.CHATINABOX_PROFILE_PATH?.trim() ||
    "/etc/chatinabox/profile.json";
  if (action === "show") {
    if (args.length > 0) return usage("profile show does not take arguments");
    return outputProfile(
      { ok: true, profile: readExperienceProfile(profilePath), profilePath },
      json,
    );
  }
  if (action === "defaults") {
    if (args.length > 0) {
      return usage("profile defaults does not take arguments");
    }
    const profile = writeExperienceProfile(
      profilePath,
      DEFAULT_EXPERIENCE_PROFILE,
    );
    return outputProfile({ ok: true, profile, profilePath }, json);
  }
  if (action === "sync") {
    if (args.length > 0) return usage("profile sync does not take arguments");
    const profile = readExperienceProfile(profilePath);
    return outputProfile(
      {
        ok: true,
        profile,
        profilePath,
        telegram: await syncTelegramIdentity(profile),
      },
      json,
    );
  }
  if (action !== "set") {
    return usage("profile requires show, set, sync, or defaults");
  }

  const assistantName = takeOption(args, "--assistant-name");
  const assistantMark = takeOption(args, "--assistant-mark");
  const assistantPhoto = takeOption(args, "--assistant-photo");
  const overviewName = takeOption(args, "--overview-name");
  const overviewEmoji = takeOption(args, "--overview-emoji");
  const groupName = takeOption(args, "--group-name");
  const groupPhoto = takeOption(args, "--group-photo");
  const managerName = takeOption(args, "--manager-name");
  const managerEmoji = takeOption(args, "--manager-emoji");
  const managerRole = takeOption(args, "--manager-role");
  const managerTopic = takeOption(args, "--manager-topic");
  const managerIcon = takeOption(args, "--manager-icon");
  const managerCwd = takeOption(args, "--manager-cwd");
  const managerModel = optionalModel(takeOption(args, "--manager-model"));
  const managerEffort = optionalEffort(
    takeOption(args, "--manager-effort"),
  );
  const defaultModel = optionalModel(takeOption(args, "--default-model"));
  const defaultEffort = optionalEffort(
    takeOption(args, "--default-effort"),
  );
  const idleMinutesRaw = takeOption(args, "--idle-minutes");
  const complete = removeFlag(args, "--complete");
  const reopen = removeFlag(args, "--reopen");
  const managerFast = removeFlag(args, "--manager-fast");
  const managerStandard = removeFlag(args, "--manager-standard");
  const defaultFast = removeFlag(args, "--default-fast");
  const defaultStandard = removeFlag(args, "--default-standard");
  if (complete && reopen) {
    return usage("profile set cannot combine --complete and --reopen");
  }
  if (managerFast && managerStandard) {
    return usage(
      "profile set cannot combine --manager-fast and --manager-standard",
    );
  }
  if (defaultFast && defaultStandard) {
    return usage(
      "profile set cannot combine --default-fast and --default-standard",
    );
  }
  if (args.length > 0) {
    return usage(`unknown profile option: ${args[0]}`);
  }
  let idleCloseMinutes: number | undefined;
  if (idleMinutesRaw !== undefined) {
    idleCloseMinutes = Number(idleMinutesRaw);
    if (
      !Number.isSafeInteger(idleCloseMinutes) ||
      idleCloseMinutes < 0 ||
      idleCloseMinutes > 10_080
    ) {
      return usage("--idle-minutes must be an integer from 0 to 10080");
    }
  }
  const assistantPhotoPath = assistantPhoto !== undefined
    ? prepareIdentityPhoto(assistantPhoto, "assistant")
    : undefined;
  const groupPhotoPath = groupPhoto !== undefined
    ? prepareIdentityPhoto(groupPhoto, "group")
    : undefined;

  const patch: ExperienceProfilePatch = {
    ...(complete || reopen ? { setupComplete: complete } : {}),
    ...(
      assistantName !== undefined ||
        assistantMark !== undefined ||
        assistantPhotoPath !== undefined
        ? {
            assistant: {
              ...(assistantName !== undefined ? { name: assistantName } : {}),
              ...(assistantMark !== undefined ? { mark: assistantMark } : {}),
              ...(assistantPhotoPath !== undefined
                ? { photoPath: assistantPhotoPath }
                : {}),
            },
          }
        : {}
    ),
    ...(
      overviewName !== undefined ||
        overviewEmoji !== undefined ||
        groupName !== undefined ||
        groupPhotoPath !== undefined
        ? {
            overview: {
              ...(overviewName !== undefined ? { name: overviewName } : {}),
              ...(overviewEmoji !== undefined ? { emoji: overviewEmoji } : {}),
              ...(groupName !== undefined ? { groupName } : {}),
              ...(groupPhotoPath !== undefined
                ? { groupPhotoPath }
                : {}),
            },
          }
        : {}
    ),
    ...(
      managerName !== undefined ||
        managerEmoji !== undefined ||
        managerRole !== undefined ||
        managerTopic !== undefined ||
        managerIcon !== undefined ||
        managerCwd !== undefined ||
        managerModel !== undefined ||
        managerEffort !== undefined ||
        managerFast ||
        managerStandard
        ? {
            manager: {
              ...(managerName !== undefined ? { name: managerName } : {}),
              ...(managerEmoji !== undefined ? { emoji: managerEmoji } : {}),
              ...(managerRole !== undefined ? { role: managerRole } : {}),
              ...(managerTopic !== undefined
                ? { topicName: managerTopic }
                : {}),
              ...(managerIcon !== undefined
                ? { topicIconEmoji: managerIcon }
                : {}),
              ...(managerCwd !== undefined ? { cwd: managerCwd } : {}),
              ...(managerModel !== undefined ? { model: managerModel } : {}),
              ...(managerEffort !== undefined
                ? { reasoningEffort: managerEffort }
                : {}),
              ...(managerFast || managerStandard
                ? { fast: managerFast }
                : {}),
            },
          }
        : {}
    ),
    ...(
      defaultModel !== undefined ||
        defaultEffort !== undefined ||
        idleCloseMinutes !== undefined ||
        defaultFast ||
        defaultStandard
        ? {
            sessions: {
              ...(defaultModel !== undefined
                ? { defaultModel }
                : {}),
              ...(defaultEffort !== undefined
                ? { defaultReasoningEffort: defaultEffort }
                : {}),
              ...(idleCloseMinutes !== undefined ? { idleCloseMinutes } : {}),
              ...(defaultFast || defaultStandard
                ? { defaultFast }
                : {}),
            },
          }
        : {}
    ),
  };
  const profile = writeExperienceProfile(
    profilePath,
    patchExperienceProfile(readExperienceProfile(profilePath), patch),
  );
  const identityChanged =
    assistantName !== undefined ||
    assistantPhotoPath !== undefined ||
    groupName !== undefined ||
    groupPhotoPath !== undefined;
  return outputProfile({
    ok: true,
    profile,
    profilePath,
    ...(identityChanged
      ? { telegram: await syncTelegramIdentity(profile) }
      : {}),
  }, json);
}

interface TelegramIdentitySync {
  readonly bot: "updated" | "skipped" | "failed";
  readonly groups: readonly {
    readonly chatId: number;
    readonly status: "updated" | "failed";
    readonly detail?: string;
  }[];
  readonly warnings: readonly string[];
}

function prepareIdentityPhoto(
  input: string,
  target: "assistant" | "group",
): string {
  const source = path.resolve(input);
  const stats = statSync(source);
  if (!stats.isFile()) throw new Error(`${input} is not a regular file`);
  if (stats.size > 20 * 1_024 * 1_024) {
    throw new Error(`${input} is larger than 20 MB`);
  }
  const convert =
    process.env.CHATINABOX_CONVERT_PATH?.trim() ||
    "/usr/bin/convert";
  if (!existsSync(convert)) {
    throw new Error(
      "ImageMagick is required to prepare identity photos; install it and retry",
    );
  }
  const directory = "/var/lib/chatinabox/profile-assets";
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const destination = path.join(directory, `${target}.jpg`);
  const temporary = `${destination}.${process.pid}.tmp.jpg`;
  const converted = spawnSync(convert, [
    source,
    "-auto-orient",
    "-thumbnail",
    "1024x1024^",
    "-gravity",
    "center",
    "-extent",
    "1024x1024",
    temporary,
  ], { encoding: "utf8", timeout: 30_000 });
  if (converted.status !== 0) {
    throw new Error(
      `could not prepare ${target} photo: ` +
        (converted.stderr.trim() || "ImageMagick failed"),
    );
  }
  chmodSync(temporary, 0o644);
  renameSync(temporary, destination);
  return destination;
}

async function syncTelegramIdentity(
  profile: ReturnType<typeof readExperienceProfile>,
): Promise<TelegramIdentitySync> {
  const token = process.env.TG_BOT_TOKEN?.trim();
  if (!token) {
    return {
      bot: "skipped",
      groups: [],
      warnings: ["TG_BOT_TOKEN is unavailable; run profile sync after install."],
    };
  }
  const env: BotEnv = { TG_BOT_TOKEN: token };
  const warnings: string[] = [];
  let bot: TelegramIdentitySync["bot"] = "updated";
  const named = await tgSetMyName(env, profile.assistant.name)
    .catch(() => null);
  if (!named?.ok) {
    bot = "failed";
    warnings.push(named?.description || "Could not update the bot name.");
  }
  if (profile.assistant.photoPath) {
    const photo = await tgSetMyProfilePhoto(
      env,
      new Blob([readFileSync(profile.assistant.photoPath)], {
        type: "image/jpeg",
      }),
    ).catch(() => null);
    if (!photo?.ok) {
      bot = "failed";
      warnings.push(photo?.description || "Could not update the bot photo.");
    }
  }

  const groups: {
    chatId: number;
    status: "updated" | "failed";
    detail?: string;
  }[] = [];
  for (const chatId of registeredOverviewChats()) {
    const title = profile.overview.groupName
      ? await tgSetChatTitle(
          env,
          chatId,
          profile.overview.groupName,
        ).catch(() => null)
      : null;
    let failure = !profile.overview.groupName || title?.ok
      ? ""
      : title?.description || "Could not update the group title.";
    if (!failure && profile.overview.groupPhotoPath) {
      const photo = await tgSetChatPhoto(
        env,
        chatId,
        new Blob([readFileSync(profile.overview.groupPhotoPath)], {
          type: "image/jpeg",
        }),
      ).catch(() => null);
      if (!photo?.ok) {
        failure = photo?.description || "Could not update the group photo.";
      }
    }
    groups.push({
      chatId,
      status: failure ? "failed" : "updated",
      ...(failure ? { detail: failure } : {}),
    });
    if (failure) {
      warnings.push(
        `Group ${chatId}: ${failure} Give the bot permission to change group info.`,
      );
    }
  }
  return { bot, groups, warnings };
}

function registeredOverviewChats(): number[] {
  const databasePath = path.join(
    process.env.CHATINABOX_DATA_DIR ?? "/var/lib/chatinabox",
    "chatinabox.sqlite",
  );
  if (!existsSync(databasePath)) return [];
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
}

function configuredWorkerDefaults(): {
  readonly model: WorkerModel;
  readonly reasoningEffort: ReasoningEffort;
  readonly fast: boolean;
} {
  const profilePath =
    process.env.CHATINABOX_PROFILE_PATH?.trim() ||
    "/etc/chatinabox/profile.json";
  const sessions = readExperienceProfile(profilePath).sessions;
  return {
    model: sessions.defaultModel,
    reasoningEffort: sessions.defaultReasoningEffort,
    fast: sessions.defaultFast,
  };
}

function configuredFast(args: string[], fallback: boolean): boolean {
  const fast = removeFlag(args, "--fast");
  const standard = removeFlag(args, "--standard");
  if (fast && standard) {
    throw new Error("--fast and --standard cannot be combined");
  }
  return fast ? true : standard ? false : fallback;
}

function outputProfile(
  result: {
    readonly ok: true;
    readonly profile: ReturnType<typeof readExperienceProfile>;
    readonly profilePath: string;
    readonly telegram?: TelegramIdentitySync;
  },
  json: boolean,
): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify(result.profile, null, 2)}\n\n${result.profilePath}\n`,
    );
  }
  return 0;
}

function optionalModel(value: string | undefined): WorkerModel | undefined {
  if (value === undefined) return undefined;
  const model = parseWorkerModel(value);
  if (!model) throw new Error("invalid model");
  return model;
}

function optionalEffort(
  value: string | undefined,
): ReasoningEffort | undefined {
  return parseReasoningEffort(value);
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
    process.stderr.write(`chatinabox: ${response.error}\n`);
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
  const catalog = buildChatinaboxCatalog(
    response.panes,
    response.recent,
    mostRecentAttachedTarget(),
  );
  if (json) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return 0;
  }
  const lines = ["🪄 Chatinabox catalog"];
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
  threadOption: string | undefined,
  source: CodexPaneIdentity | null,
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

  const { env, chatId, messageThreadId } = loadTelegramDeliveryTarget(
    chatOption,
    threadOption,
    source,
  );
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
      undefined,
      messageThreadId || undefined,
    );
  } else {
    const raw = await tgSendDocument(
      env,
      chatId,
      new Blob([bytes], { type: "application/octet-stream" }),
      fileName,
      safeCaption,
      messageThreadId || undefined,
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
        messageThreadId,
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
  threadOption: string | undefined,
  source: CodexPaneIdentity | null,
): {
  readonly env: BotEnv;
  readonly chatId: number;
  readonly messageThreadId: number;
} {
  const secretsPath =
    process.env.CHATINABOX_ENV ?? "/etc/chatinabox/chatinabox.env";
  if (existsSync(secretsPath)) process.loadEnvFile(secretsPath);
  const token = process.env.TG_BOT_TOKEN?.trim();
  if (!token) throw new Error("TG_BOT_TOKEN is unavailable");

  const attachedRoute = chatOption
    ? null
    : source
      ? attachedTelegramRoute(source)
      : mostRecentAttachedRoute();
  const rawChat =
    chatOption ??
    attachedRoute?.chatId ??
    process.env.CHATINABOX_TELEGRAM_CHAT_ID ??
    process.env.TG_ALLOWED_USER_IDS?.split(",")
      .map((value) => value.trim())
      .find((value) => /^\d+$/u.test(value));
  if (!rawChat || !/^-?\d+$/u.test(rawChat)) {
    throw new Error(
      "No default Telegram chat is configured; use --chat CHAT_ID",
    );
  }
  const chatId = Number(rawChat);
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error("Telegram chat id is invalid");
  }
  const rawThread = threadOption ?? attachedRoute?.messageThreadId ?? "0";
  if (!/^\d+$/u.test(rawThread)) {
    throw new Error("Telegram message thread id is invalid");
  }
  const messageThreadId = Number(rawThread);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId < 0) {
    throw new Error("Telegram message thread id is invalid");
  }
  return { env: { TG_BOT_TOKEN: token }, chatId, messageThreadId };
}

function attachedTelegramRoute(
  target: CodexPaneIdentity,
): {
  readonly chatId: string;
  readonly messageThreadId: string;
} | null {
  return queryAttachedTelegramRoute(
    `WHERE server_pid = ? AND pane_id = ? AND pane_pid = ?`,
    [target.serverPid, target.paneId, target.panePid],
  );
}

function mostRecentAttachedRoute(): {
  readonly chatId: string;
  readonly messageThreadId: string;
} | null {
  return queryAttachedTelegramRoute("", []);
}

function queryAttachedTelegramRoute(
  where: string,
  parameters: readonly (number | string)[],
): {
  readonly chatId: string;
  readonly messageThreadId: string;
} | null {
  const dataDir =
    process.env.CHATINABOX_DATA_DIR ?? "/var/lib/chatinabox";
  const databasePath = path.join(dataDir, "chatinabox.sqlite");
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      `SELECT chat_id, message_thread_id
       FROM codex_attachments
       ${where}
       ORDER BY attached_at DESC
       LIMIT 1`,
    ).get(...parameters) as {
      chat_id?: number;
      message_thread_id?: number;
    } | undefined;
    const chatId = row?.chat_id;
    const messageThreadId = row?.message_thread_id;
    return Number.isSafeInteger(chatId) &&
        chatId !== 0 &&
        Number.isSafeInteger(messageThreadId) &&
        messageThreadId! >= 0
      ? {
          chatId: String(chatId),
          messageThreadId: String(messageThreadId),
        }
      : null;
  } finally {
    database.close();
  }
}

function mostRecentAttachedTarget(): CodexPaneIdentity | null {
  const dataDir =
    process.env.CHATINABOX_DATA_DIR ?? "/var/lib/chatinabox";
  const databasePath = path.join(dataDir, "chatinabox.sqlite");
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
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  args.splice(index, 2);
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
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  throw new Error("--effort must be low, medium, high, or xhigh");
}

function usage(error: string): number {
  process.stderr.write(`chatinabox: ${error}\n\n${help()}`);
  return 2;
}

function help(): string {
  return `Usage: chatinabox COMMAND [ARGS] [--json]

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
  send-image FILE [CAPTION]    Send an inline image to the attached topic
  send-file FILE [CAPTION]     Send a local file to the attached topic
  profile show                 Show the private experience profile
  profile set [OPTIONS]        Update names, symbols, defaults, or setup state
  profile sync                 Reapply bot and forum identity to Telegram
  profile defaults             Reset to the neutral first-run profile

TARGET can be the 1-based list number, tmux pane id (%4), or unique name.
New-session options: --cwd PATH, --model sol|luna|terra,
  --effort low|medium|high|xhigh, --fast, --standard.
  Omitted options use the private profile defaults.
Media commands prefer this worker's attached Telegram topic, then the latest
attachment, configured chat, and sole allowed user. Override with --chat ID
and optional --thread ID.
Profile options include --assistant-name, --assistant-mark, --assistant-photo,
  --overview-name, --overview-emoji, --group-name, --group-photo,
  --manager-name, --manager-emoji, --manager-role,
  --manager-topic, --manager-icon, --manager-cwd, --manager-model,
  --manager-effort, --manager-fast|--manager-standard, --default-model,
  --default-effort, --default-fast|--default-standard, --idle-minutes,
  --complete, and --reopen.
Use --json for a stable machine-readable interface.
`;
}

main().then((code) => {
  process.exitCode = code;
});
