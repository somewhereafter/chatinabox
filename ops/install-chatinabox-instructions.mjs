import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const blockPath = process.argv[2];
const targetPath = process.argv[3];
const legacyPaths = process.argv.slice(4);
if (!blockPath || !targetPath) {
  throw new Error(
    "Usage: install-chatinabox-instructions.mjs BLOCK TARGET [LEGACY_TARGET...]",
  );
}

const start = "<!-- chatinabox:begin -->";
const end = "<!-- chatinabox:end -->";
const block = readFileSync(blockPath, "utf8").trim();
if (!block.startsWith(start) || !block.endsWith(end)) {
  throw new Error("Chatinabox instruction block is missing managed markers");
}

const existing = existsSync(targetPath)
  ? readFileSync(targetPath, "utf8")
  : "";
const startIndex = existing.indexOf(start);
const endIndex = existing.indexOf(end);
let next;
if (startIndex >= 0 && endIndex >= startIndex) {
  next =
    existing.slice(0, startIndex).trimEnd() +
    "\n\n" +
    block +
    existing.slice(endIndex + end.length);
} else {
  next = existing.trimEnd() + (existing.trim() ? "\n\n" : "") + block + "\n";
}

const temporaryPath = path.join(
  path.dirname(targetPath),
  `.AGENTS.md.chatinabox-${process.pid}.tmp`,
);
writeFileSync(temporaryPath, next, { mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, targetPath);

for (const legacyPath of legacyPaths) {
  if (path.resolve(legacyPath) === path.resolve(targetPath)) continue;
  removeManagedBlock(legacyPath);
}

function removeManagedBlock(filePath) {
  if (!existsSync(filePath)) return;
  const existing = readFileSync(filePath, "utf8");
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return;
  const cleaned =
    `${existing.slice(0, startIndex).trimEnd()}\n\n` +
    existing.slice(endIndex + end.length).trimStart();
  const contents = cleaned.trim() ? `${cleaned.trimEnd()}\n` : "";
  const legacyTemporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.chatinabox-${process.pid}.tmp`,
  );
  const mode = statSync(filePath).mode & 0o777;
  writeFileSync(legacyTemporaryPath, contents, { mode });
  chmodSync(legacyTemporaryPath, mode);
  renameSync(legacyTemporaryPath, filePath);
}
