import { describe, expect, it } from "vitest";
import {
  hasMarkdownTable,
  renderTelegramMarkdownChunks,
} from "../src/vps/telegram-markdown";

describe("Telegram Markdown rendering", () => {
  it("renders the CommonMark features Codex uses into Telegram-safe HTML", () => {
    const [html] = renderTelegramMarkdownChunks(
      "# Heading\n\n" +
        "**bold** and *italic* and ~~gone~~ with `npm test`.\n\n" +
        "> quoted advice\n\n" +
        "- first\n- second\n\n" +
        "1. one\n2. two\n\n" +
        "[OpenAI](https://openai.com)\n\n" +
        "```ts\nconst answer = 42 < 50;\n```",
    );

    expect(html).toContain("<b>Heading</b>");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<i>italic</i>");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain("<blockquote>quoted advice");
    expect(html).toContain("• first");
    expect(html).toContain("1. one");
    expect(html).toContain('<a href="https://openai.com">OpenAI</a>');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("42 &lt; 50;");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<ul>");
  });

  it("escapes raw HTML and refuses unsafe or relative links", () => {
    const [html] = renderTelegramMarkdownChunks(
      '<b>not trusted</b> [bad](javascript:alert("x")) [local](/root/file)',
    );

    expect(html).toContain("&lt;b&gt;not trusted&lt;/b&gt;");
    expect(html).not.toContain("<b>not trusted</b>");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="/root/file"');
  });

  it("renders tables as compact mobile-friendly rows", () => {
    const [html] = renderTelegramMarkdownChunks(
      "| Model | State |\n| --- | --- |\n| Sol | Working |\n| Luna | Ready |",
    );

    expect(html).toContain("<b>Model</b> │ <b>State</b>");
    expect(html).toContain("Sol │ Working");
    expect(html).toContain("Luna │ Ready");
    expect(html).not.toContain("<table>");
  });

  it("detects real Markdown tables without treating ordinary pipes as tables", () => {
    expect(hasMarkdownTable(
      "| Model | State |\n| --- | --- |\n| Sol | Working |",
    )).toBe(true);
    expect(hasMarkdownTable("Use `left | right` in this example.")).toBe(false);
  });

  it("splits long code safely with balanced preformatted tags", () => {
    const chunks = renderTelegramMarkdownChunks(
      `\`\`\`text\n${"safe <value>\n".repeat(80)}\`\`\``,
      256,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith('<pre><code class="language-text">')).toBe(true);
      expect(chunk.endsWith("</code></pre>")).toBe(true);
      expect(chunk).toContain("&lt;value&gt;");
    }
  });

  it("linkifies plain web addresses", () => {
    const [html] = renderTelegramMarkdownChunks("See https://openai.com/docs.");
    expect(html).toContain('<a href="https://openai.com/docs">');
  });
});
