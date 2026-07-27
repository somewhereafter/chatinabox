import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

let cached;
async function html() {
  cached ??= await (async () => {
    const response = await render();
    assert.equal(response.status, 200);
    return response.text();
  })();
  return cached;
}

test("server-renders the artifact shell", async () => {
  const markup = await html();
  assert.match(markup, /<title>Artifact Shelf · Chatinabox<\/title>/i);
  assert.match(markup, /<h1 class="sr-only">Artifact shelf<\/h1>/);
  assert.doesNotMatch(markup, /codex-preview|Your site is taking shape/i);
});

test("preserves the Telegram Mini App bridge and social metadata", async () => {
  const markup = await html();
  assert.match(markup, /telegram-web-app\.js/);
  assert.match(
    markup,
    /property="og:image" content="https?:\/\/[^"]+\/og-v2\.png"/,
  );
  assert.match(markup, /name="twitter:card" content="summary_large_image"/);
  // Safe-area insets only resolve when the viewport covers the display cutout.
  assert.match(markup, /name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(markup, /name="theme-color" content="#000000"/);
});

test("exposes exactly one shell control, labelled and collapsed", async () => {
  const markup = await html();
  const triggers = markup.match(/class="trigger"/g) ?? [];
  assert.equal(triggers.length, 1);

  const trigger = markup.match(/<button[^>]*class="trigger"[^>]*>/)[0];
  assert.match(trigger, /aria-expanded="false"/);
  assert.match(trigger, /aria-label="Open artifact shelf"/);

  const controls = trigger.match(/aria-controls="([^"]+)"/)[1];
  assert.match(markup, new RegExp(`<aside id="${controls}"[^>]*class="shelf"`));
});

test("ships an inert shelf that waits for the session manifest", async () => {
  const markup = await html();
  const shelf = markup.slice(markup.indexOf("<aside"), markup.indexOf("</aside>"));

  // Closed shelf must be out of the tab order and hidden from assistive tech.
  assert.match(markup.match(/<aside[^>]*>/)[0], /inert=""/);

  assert.match(shelf, /<nav[^>]*aria-labelledby=/);
  assert.equal((shelf.match(/class="row"/g) ?? []).length, 0);
  assert.doesNotMatch(shelf, /aria-current/);
});

test("defaults to an intentional empty canvas, not an artifact", async () => {
  const markup = await html();
  const canvas = markup.slice(markup.indexOf('<main'), markup.indexOf("</main>"));

  assert.match(canvas, /data-empty="true"/);
  assert.match(canvas, /class="empty"/);
  assert.match(canvas, /No artifact open/);
  assert.match(markup, /role="status">No artifact open/);

  // No artifact content may render before one is chosen.
  assert.doesNotMatch(canvas, /<img/);
  assert.doesNotMatch(canvas, /<iframe/);
});

test("keeps the document itself free of shell chrome", async () => {
  const markup = await html();
  const body = markup.match(/<body[^>]*>/)[0];

  // Only the font-variable classes; no inline styles, padding, or wrappers.
  assert.doesNotMatch(body, /style=/);
  assert.match(body, /^<body class="[^"]*geist[^"]*">$/);
  // The canvas is a direct child of body, so nothing can box an artifact in.
  assert.match(markup, /<main[^>]*class="canvas"/);
});
