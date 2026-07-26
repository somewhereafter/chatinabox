import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed Chatinabox configuration", () => {
  it("replaces prerelease hooks without disturbing unrelated hooks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatinabox-hooks-"));
    roots.push(root);
    const source = path.join(root, "source.json");
    const target = path.join(root, "target.json");
    const releaseHook =
      "/usr/bin/node /opt/chatinabox/current/dist/vps/codex-hook.js";
    const prereleaseHook =
      "/usr/bin/node /opt/anime-pipe/current/dist-vps/vps/codex-hook.js";
    await writeFile(source, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: releaseHook }] }],
      },
    }));
    await writeFile(target, JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: prereleaseHook }] },
          { hooks: [{ type: "command", command: "/usr/local/bin/keep-me" }] },
        ],
      },
    }));

    await execFileAsync(
      process.execPath,
      ["ops/install-codex-hooks.mjs", source, target],
      { cwd: path.resolve(".") },
    );

    const installed = await readFile(target, "utf8");
    expect(installed).not.toContain(prereleaseHook);
    expect(installed.match(/\/opt\/chatinabox\/current/gu)).toHaveLength(1);
    expect(installed).toContain("/usr/local/bin/keep-me");
  });

  it("merges worker instructions and removes the legacy managed block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatinabox-config-"));
    roots.push(root);
    const block = path.join(root, "managed.md");
    const agents = path.join(root, "codex", "AGENTS.md");
    const legacyAgents = path.join(root, "AGENTS.md");
    await writeFile(
      block,
      "<!-- chatinabox:begin -->\nnew managed block\n<!-- chatinabox:end -->\n",
    );
    await mkdir(path.dirname(agents), { recursive: true });
    await writeFile(agents, "# Existing global guidance\n");
    await writeFile(
      legacyAgents,
      "# Keep me\n\n" +
        "<!-- catinabox:begin -->\nold managed block\n<!-- catinabox:end -->\n",
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await execFileAsync(
        process.execPath,
        [
          "ops/install-chatinabox-instructions.mjs",
          block,
          agents,
          legacyAgents,
        ],
        { cwd: path.resolve(".") },
      );
    }

    const agentsAfter = await readFile(agents, "utf8");
    expect(agentsAfter).toContain("# Existing global guidance");
    expect(agentsAfter).toContain("new managed block");
    expect(agentsAfter.match(/chatinabox:begin/gu)).toHaveLength(1);
    const legacyAfter = await readFile(legacyAgents, "utf8");
    expect(legacyAfter).toBe("# Keep me\n");
  });

  it("removes only Chatinabox hooks and its marked instruction block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "chatinabox-config-"));
    roots.push(root);
    const hooks = path.join(root, "hooks.json");
    const agents = path.join(root, "AGENTS.md");
    await writeFile(hooks, JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{
              type: "command",
              command:
                "/usr/bin/node /opt/chatinabox/current/dist/vps/codex-hook.js",
            }],
          },
          {
            hooks: [{
              type: "command",
              command: "/usr/local/bin/keep-this-hook",
            }],
          },
        ],
      },
    }));
    await writeFile(
      agents,
      "# Personal instructions\n\n" +
        "<!-- chatinabox:begin -->\nmanaged\n<!-- chatinabox:end -->\n\n" +
        "Keep this paragraph.\n",
    );

    await execFileAsync(
      process.execPath,
      ["ops/uninstall-chatinabox-config.mjs"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          CHATINABOX_CODEX_HOOKS: hooks,
          CHATINABOX_GLOBAL_AGENTS: agents,
        },
      },
    );

    const hooksAfter = await readFile(hooks, "utf8");
    expect(hooksAfter).not.toContain("/opt/chatinabox/");
    expect(hooksAfter).toContain("keep-this-hook");
    const agentsAfter = await readFile(agents, "utf8");
    expect(agentsAfter).not.toContain("chatinabox:begin");
    expect(agentsAfter).toContain("# Personal instructions");
    expect(agentsAfter).toContain("Keep this paragraph.");
  });
});
