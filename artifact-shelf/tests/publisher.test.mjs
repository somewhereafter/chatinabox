import assert from "node:assert/strict";
import test from "node:test";
import {
  RequestError,
  validateManifest,
} from "../lib/publisher.ts";

const shelfId = "0123456789abcdefghijklmnopqrstuv";

function artifact(overrides = {}) {
  return {
    id: "artifact-1",
    title: "Interactive map",
    kind: "web-app",
    url: "https://artifact.example/map",
    metadata: { renderer: "full-page" },
    createdAt: 1_800_000_000_000,
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    version: 1,
    shelf: { id: shelfId, updatedAt: 1_800_000_000_000 },
    artifacts: [artifact()],
    ...overrides,
  };
}

test("accepts and normalizes a bounded provider-neutral manifest", () => {
  const result = validateManifest(manifest(), shelfId);
  assert.equal(result.shelf.id, shelfId);
  assert.equal(result.artifacts[0].url, "https://artifact.example/map");
  assert.deepEqual(result.artifacts[0].metadata, {
    renderer: "full-page",
  });
});

test("rejects identity mismatches, duplicate IDs, and unsafe URLs", () => {
  assert.throws(
    () => validateManifest(manifest(), `${shelfId}x`),
    (error) => error instanceof RequestError && error.status === 400,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({ artifacts: [artifact(), artifact()] }),
        shelfId,
      ),
    /artifact IDs must be unique/,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({ artifacts: [artifact({ url: "javascript:alert(1)" })] }),
        shelfId,
      ),
    /safe HTTPS URL/,
  );
});

test("enforces publisher resource limits", () => {
  assert.throws(
    () =>
      validateManifest(
        manifest({
          artifacts: Array.from({ length: 201 }, (_, index) =>
            artifact({ id: `artifact-${index}` })),
        }),
        shelfId,
      ),
    /invalid artifact collection/,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({
          artifacts: [
            artifact({ metadata: { payload: "x".repeat(16_385) } }),
          ],
        }),
        shelfId,
      ),
    /metadata is too large/,
  );
});
