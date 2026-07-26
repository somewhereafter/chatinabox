import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const hooksPath =
  process.env.CHATINABOX_CODEX_HOOKS || "/root/.codex/hooks.json";
const agentsPaths = process.env.CHATINABOX_GLOBAL_AGENTS
  ? [process.env.CHATINABOX_GLOBAL_AGENTS]
  : ["/root/.codex/AGENTS.md", "/root/AGENTS.md"];

removeHooks(hooksPath);
for (const agentsPath of agentsPaths) {
  removeInstructionBlock(agentsPath);
}

function removeHooks(filePath) {
  if (!existsSync(filePath)) return;
  const document = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(document.hooks)) return;
  for (const [event, groups] of Object.entries(document.hooks)) {
    if (!Array.isArray(groups)) continue;
    document.hooks[event] = groups.filter(
      (group) => !containsChatinaboxHook(group),
    );
  }
  atomicWrite(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

function removeInstructionBlock(filePath) {
  if (!existsSync(filePath)) return;
  const start = "<!-- chatinabox:begin -->";
  const end = "<!-- chatinabox:end -->";
  const existing = readFileSync(filePath, "utf8");
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return;
  const next =
    `${existing.slice(0, startIndex).trimEnd()}\n\n` +
    existing.slice(endIndex + end.length).trimStart();
  atomicWrite(filePath, next.trim() ? `${next.trimEnd()}\n` : "");
}

function containsChatinaboxHook(value) {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some(
    (hook) =>
      isRecord(hook) &&
      typeof hook.command === "string" &&
      hook.command.endsWith(
        " /opt/chatinabox/current/dist/vps/codex-hook.js",
      ),
  );
}

function atomicWrite(filePath, contents) {
  const mode = statSync(filePath).mode & 0o777;
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.chatinabox-${process.pid}.tmp`,
  );
  writeFileSync(temporaryPath, contents, { mode });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, filePath);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
