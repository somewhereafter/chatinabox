import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const assetsDir = new URL("../dist/client/assets/", import.meta.url);
const files = await readdir(assetsDir);
const stylesheet = files.find((file) => file.endsWith(".css"));
assert.ok(stylesheet, "no stylesheet in the build output");
const css = await readFile(new URL(stylesheet, assetsDir), "utf8");

/** Every declaration block whose selector list contains `selector` exactly. */
function rules(selector) {
  const matches = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selectors, body] of css.matchAll(pattern)) {
    const list = selectors.split(",").map((entry) => entry.trim());
    if (list.includes(selector)) matches.push(body);
  }
  assert.ok(matches.length > 0, `no rule found for ${selector}`);
  return matches;
}

test("ships the universal border-box and zero-inset reset", () => {
  assert.match(css, /\*,\s*:before,\s*:after\{[^}]*box-sizing:border-box/);
  assert.match(css, /\*\{margin:0;padding:0\}/);
});

test("the document imposes nothing on artifacts", () => {
  for (const body of rules("body")) {
    assert.doesNotMatch(body, /(^|;)padding/);
    assert.doesNotMatch(body, /max-width/);
  }
  // The canvas scrolls, so the document must not scroll behind it.
  assert.ok(rules("body").some((body) => /overflow:hidden/.test(body)));
});

test("the canvas hands the full viewport to the artifact", () => {
  const canvas = rules(".canvas");
  const combined = canvas.join(";");

  for (const forbidden of [
    /(^|;)padding/,
    /(^|;)background/,
    /(^|;)border(-\w+)?:/,
    /max-width/,
    /margin:(?!0)/,
  ]) {
    assert.doesNotMatch(combined, forbidden, `canvas must not set ${forbidden}`);
  }

  assert.match(combined, /position:fixed/);
  assert.match(combined, /height:var\(--app-h,\s*100dvh\)/);
  assert.match(combined, /overflow:auto/);
  // Artifact scrolling must not chain into Telegram's swipe-to-dismiss.
  assert.match(combined, /overscroll-behavior:contain/);
});

test("chrome respects safe areas and Telegram's reported viewport", () => {
  assert.match(css, /--inset-top:\s*env\(safe-area-inset-top/);
  assert.match(css, /--inset-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(css, /--inset-left:\s*env\(safe-area-inset-left/);
  assert.match(css, /--trigger-inset:/);

  const trigger = rules(".trigger").join(";");
  assert.match(trigger, /position:fixed/);
  assert.match(trigger, /var\(--inset-top\)/);
  assert.match(trigger, /var\(--inset-left\)/);
  assert.match(trigger, /backdrop-filter:blur/);

  assert.ok(rules(".shelf-foot").some((rule) => /var\(--inset-bottom\)/.test(rule)));
  assert.ok(rules(".shelf").some((rule) => /var\(--app-h,\s*100dvh\)/.test(rule)));
});

test("the shelf is off-canvas until opened and contains its own scrolling", () => {
  // The minifier may rewrite translate3d() to translate().
  assert.ok(
    rules(".shelf").some((rule) => /transform:translate(3d)?\(-101%/.test(rule)),
    "closed shelf must sit off-canvas",
  );
  assert.match(
    css,
    /\.shelf\[data-open="?true"?\]\{[^}]*transform:translate(3d)?\(0/,
  );
  assert.match(rules(".shelf-scroll").join(";"), /overscroll-behavior:contain/);
});

test("honours reduced motion", () => {
  const query = css.match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\{(.*?)\}\}/s,
  );
  assert.ok(query, "no reduced-motion block");
  assert.match(query[1], /transition-duration:\.01ms!important/);
  assert.match(query[1], /animation-duration:\.01ms!important/);
});
