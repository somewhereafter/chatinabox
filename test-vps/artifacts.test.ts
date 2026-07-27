import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactRegistry,
  artifactManifest,
  publishArtifactShelf,
} from "../src/vps/artifacts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatinabox-artifacts-"));
  roots.push(root);
  return root;
}

describe("ArtifactRegistry", () => {
  it("keeps independent, stable shelves for each Codex session", async () => {
    const root = await temporaryRoot();
    let now = 1_800_000_000_000;
    const registry = new ArtifactRegistry(
      path.join(root, "artifacts.sqlite"),
      () => now,
    );
    const route = {
      chatId: -10042,
      ownerUserId: 42,
      messageThreadId: 26,
      sessionId: "thread-a",
    };

    const first = registry.add(route, {
      title: "Architecture",
      kind: "interactive",
      url: "https://example.com/apps/architecture",
      previewUrl: "https://example.com/previews/architecture.png",
      metadata: {
        renderer: "iframe",
        capabilities: ["resize", "download"],
      },
    });
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(first.artifacts).toHaveLength(1);
    expect(first.artifacts[0]).toMatchObject({
      title: "Architecture",
      kind: "interactive",
      url: "https://example.com/apps/architecture",
    });

    now += 1;
    const second = registry.add(route, {
      title: "Source bundle",
      kind: "archive",
      telegramMessageId: 808,
    });
    expect(second.id).toBe(first.id);
    expect(second.artifacts).toHaveLength(2);
    expect(second.updatedAt).toBe(now);

    const anotherSession = registry.add(
      { ...route, sessionId: "thread-b" },
      {
        title: "Live dashboard",
        kind: "app",
        url: "https://dash.example.net/",
      },
    );
    expect(anotherSession.id).not.toBe(first.id);
    expect(anotherSession.artifacts).toHaveLength(1);
    registry.close();
  });

  it("publishes a provider-neutral manifest without local paths", async () => {
    const root = await temporaryRoot();
    const registry = new ArtifactRegistry(path.join(root, "artifacts.sqlite"));
    const shelf = registry.add(
      {
        chatId: 42,
        ownerUserId: 42,
        messageThreadId: 0,
        sessionId: "thread-a",
      },
      {
        title: "Simulation",
        kind: "web-app",
        url: "https://example.com/sim",
        telegramMessageId: 99,
        metadata: { framework: "anything" },
      },
    );
    const manifest = artifactManifest(shelf);
    expect(manifest).toMatchObject({
      version: 1,
      shelf: { id: shelf.id },
      artifacts: [{
        title: "Simulation",
        kind: "web-app",
        url: "https://example.com/sim",
        telegramMessageId: 99,
        metadata: { framework: "anything" },
      }],
    });
    expect(JSON.stringify(manifest)).not.toContain("/root/");

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        `https://shelf.example/api/v1/shelves/${shelf.id}`,
      );
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer publisher-secret",
        "content-type": "application/json",
      });
      return Response.json({
        ok: true,
        shelfUrl: `https://shelf.example/s/${shelf.id}`,
        launchUrl: `https://t.me/example_bot?startapp=${shelf.id}`,
      });
    });
    await expect(publishArtifactShelf(shelf, {
      apiUrl: "https://shelf.example/api",
      apiToken: "publisher-secret",
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toMatchObject({
      ok: true,
      launchUrl: `https://t.me/example_bot?startapp=${shelf.id}`,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    registry.close();
  });

  it("rejects unsafe public URLs and oversized metadata", async () => {
    const root = await temporaryRoot();
    const registry = new ArtifactRegistry(path.join(root, "artifacts.sqlite"));
    const route = {
      chatId: 42,
      ownerUserId: 42,
      messageThreadId: 0,
      sessionId: "thread-a",
    };
    expect(() => registry.add(route, {
      title: "unsafe",
      kind: "html",
      url: "javascript:alert(1)",
    })).toThrow("must use HTTPS");
    expect(() => registry.add(route, {
      title: "too much",
      kind: "data",
      metadata: { value: "x".repeat(20_000) },
    })).toThrow("metadata is too large");
    registry.close();
  });
});
