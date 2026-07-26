import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const blockPath = process.argv[2];
const targetPath = process.argv[3];
if (!blockPath || !targetPath) {
  throw new Error("Usage: install-catinabox-instructions.mjs BLOCK TARGET");
}

const start = "<!-- catinabox:begin -->";
const end = "<!-- catinabox:end -->";
const block = readFileSync(blockPath, "utf8").trim();
if (!block.startsWith(start) || !block.endsWith(end)) {
  throw new Error("Catinabox instruction block is missing managed markers");
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
  `.AGENTS.md.catinabox-${process.pid}.tmp`,
);
writeFileSync(temporaryPath, next, { mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, targetPath);
