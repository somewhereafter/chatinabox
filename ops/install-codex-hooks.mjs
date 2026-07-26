import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const sourcePath = process.argv[2];
const targetPath = process.argv[3];
if (!sourcePath || !targetPath) {
  throw new Error("Usage: install-codex-hooks.mjs SOURCE TARGET");
}

const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const target = existsSync(targetPath)
  ? JSON.parse(readFileSync(targetPath, "utf8"))
  : { description: "User lifecycle hooks.", hooks: {} };
if (!isRecord(source.hooks) || !isRecord(target.hooks)) {
  throw new Error("Hook files must contain a hooks object");
}

const bridgeCommand =
  "/usr/bin/node /opt/catinabox/current/dist/vps/codex-hook.js";
for (const [event, sourceGroups] of Object.entries(source.hooks)) {
  if (!Array.isArray(sourceGroups)) continue;
  const existing = Array.isArray(target.hooks[event])
    ? target.hooks[event]
    : [];
  const withoutOldBridgeEntries = existing.filter(
    (group) => !containsCommand(group, bridgeCommand),
  );
  target.hooks[event] = [...withoutOldBridgeEntries, ...sourceGroups];
}

const temporaryPath = path.join(
  path.dirname(targetPath),
  `.hooks.json.codex-telegram-${process.pid}.tmp`,
);
writeFileSync(temporaryPath, `${JSON.stringify(target, null, 2)}\n`, {
  mode: 0o600,
});
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, targetPath);

function containsCommand(value, command) {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some(
    (hook) => isRecord(hook) && hook.command === command,
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
