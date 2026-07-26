import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
