import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { escapeTelegramHtml } from "../telegram";

const TELEGRAM_MARKDOWN_MAX_CHARS = 3_200;
const SAFE_LINK = /^(?:https?:\/\/|tg:\/\/|mailto:)/iu;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*)$/u;

interface ListState {
  readonly kind: "bullet" | "ordered";
  next: number;
}

interface TelegramRenderEnvironment {
  readonly lists: ListState[];
}

const markdown = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
});

markdown.validateLink = (url) => SAFE_LINK.test(url);

markdown.renderer.rules.text = (tokens, index) =>
  escapeTelegramHtml(tokens[index].content);
markdown.renderer.rules.softbreak = () => "\n";
markdown.renderer.rules.hardbreak = () => "\n";
markdown.renderer.rules.code_inline = (tokens, index) =>
  `<code>${escapeTelegramHtml(tokens[index].content)}</code>`;
markdown.renderer.rules.strong_open = () => "<b>";
markdown.renderer.rules.strong_close = () => "</b>";
markdown.renderer.rules.em_open = () => "<i>";
markdown.renderer.rules.em_close = () => "</i>";
markdown.renderer.rules.s_open = () => "<s>";
markdown.renderer.rules.s_close = () => "</s>";
markdown.renderer.rules.link_open = (tokens, index) => {
  const href = tokens[index].attrGet("href") ?? "";
  return `<a href="${escapeTelegramHtml(href)}">`;
};
markdown.renderer.rules.link_close = () => "</a>";
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const source = token.attrGet("src") ?? "";
  const alt = renderer.renderInlineAsText(token.children ?? [], options, env);
  return `🖼️ <a href="${escapeTelegramHtml(source)}">${
    escapeTelegramHtml(alt || "image")
  }</a>`;
};
markdown.renderer.rules.paragraph_open = (tokens, index) =>
  tokens[index].hidden ? "" : "";
markdown.renderer.rules.paragraph_close = (tokens, index) =>
  tokens[index].hidden ? "" : "\n\n";
markdown.renderer.rules.heading_open = () => "<b>";
markdown.renderer.rules.heading_close = () => "</b>\n\n";
markdown.renderer.rules.blockquote_open = () => "<blockquote>";
markdown.renderer.rules.blockquote_close = () => "</blockquote>\n\n";
markdown.renderer.rules.hr = () => "───────────── ✦ ─────────────\n\n";
markdown.renderer.rules.code_block = (tokens, index) =>
  telegramCodeBlock(tokens[index].content);
markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  return telegramCodeBlock(token.content, token.info);
};
markdown.renderer.rules.bullet_list_open = (_tokens, _index, _options, env) => {
  renderEnvironment(env).lists.push({ kind: "bullet", next: 1 });
  return "";
};
markdown.renderer.rules.bullet_list_close = (
  _tokens,
  _index,
  _options,
  env,
) => {
  renderEnvironment(env).lists.pop();
  return "\n";
};
markdown.renderer.rules.ordered_list_open = (tokens, index, _options, env) => {
  const start = Number(tokens[index].attrGet("start") ?? "1");
  renderEnvironment(env).lists.push({
    kind: "ordered",
    next: Number.isSafeInteger(start) && start > 0 ? start : 1,
  });
  return "";
};
markdown.renderer.rules.ordered_list_close = (
  _tokens,
  _index,
  _options,
  env,
) => {
  renderEnvironment(env).lists.pop();
  return "\n";
};
markdown.renderer.rules.list_item_open = (
  _tokens,
  _index,
  _options,
  env,
) => {
  const state = renderEnvironment(env).lists.at(-1);
  if (!state || state.kind === "bullet") return "• ";
  const prefix = `${state.next}. `;
  state.next += 1;
  return prefix;
};
markdown.renderer.rules.list_item_close = () => "\n";
markdown.renderer.rules.table_open = () => "";
markdown.renderer.rules.table_close = () => "\n";
markdown.renderer.rules.thead_open = () => "";
markdown.renderer.rules.thead_close = () => "";
markdown.renderer.rules.tbody_open = () => "";
markdown.renderer.rules.tbody_close = () => "";
markdown.renderer.rules.tr_open = () => "";
markdown.renderer.rules.tr_close = () => "\n";
markdown.renderer.rules.th_open = () => "<b>";
markdown.renderer.rules.th_close = () => "</b> │ ";
markdown.renderer.rules.td_open = () => "";
markdown.renderer.rules.td_close = () => " │ ";

export function renderTelegramMarkdownChunks(
  value: string,
  maxVisibleChars = TELEGRAM_MARKDOWN_MAX_CHARS,
): string[] {
  if (!Number.isSafeInteger(maxVisibleChars) || maxVisibleChars < 128) {
    throw new Error("Telegram Markdown chunk size is invalid.");
  }
  const normalized = value
    .replace(/\u0000/gu, "�")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (!normalized) return ["(Codex finished without a text response.)"];

  const wholeHtml = renderMarkdown(normalized);
  const wholeVisibleLength = telegramVisibleLength(wholeHtml);
  if (wholeVisibleLength <= maxVisibleChars) return [wholeHtml];

  const fragments = splitMarkdownBlocks(normalized).flatMap((block) =>
    renderBlockFragments(block, maxVisibleChars)
  );
  const chunks: string[] = [];
  let current = "";
  let currentLength = 0;
  for (const fragment of fragments) {
    const cleaned = fragment.html.trim();
    if (!cleaned) continue;
    const separator = current ? "\n\n" : "";
    if (
      current &&
      currentLength + separator.length + fragment.visibleLength >
        maxVisibleChars
    ) {
      chunks.push(current);
      current = cleaned;
      currentLength = fragment.visibleLength;
      continue;
    }
    current += `${separator}${cleaned}`;
    currentLength += separator.length + fragment.visibleLength;
  }
  if (current) chunks.push(current);
  return chunks.length > 0
    ? chunks
    : ["(Codex finished without a text response.)"];
}

export function hasMarkdownTable(value: string): boolean {
  return markdown.parse(value.replace(/\u0000/gu, "�"), {}).some(
    (token) => token.type === "table_open",
  );
}

function renderBlockFragments(
  source: string,
  maxVisibleChars: number,
): Array<{ readonly html: string; readonly visibleLength: number }> {
  const html = renderMarkdown(source);
  const visibleLength = telegramVisibleLength(html);
  if (visibleLength <= maxVisibleChars) return [{ html, visibleLength }];

  const fence = parseFence(source);
  if (fence) {
    return splitPlainText(fence.content, maxVisibleChars - 32).map((content) => {
      const fragment = telegramCodeBlock(content, fence.language);
      return {
        html: fragment,
        visibleLength: telegramVisibleLength(fragment),
      };
    });
  }

  // Very large single paragraphs are uncommon. Losing styling for only that
  // oversized block is safer than cutting through an HTML entity or open tag.
  return splitPlainText(source, maxVisibleChars).map((content) => ({
    html: escapeTelegramHtml(content),
    visibleLength: content.length,
  }));
}

function renderMarkdown(source: string): string {
  const env: TelegramRenderEnvironment = { lists: [] };
  return markdown.render(source, env).trim();
}

function renderEnvironment(value: unknown): TelegramRenderEnvironment {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lists" in value) ||
    !Array.isArray(value.lists)
  ) {
    throw new Error("Telegram Markdown render environment is missing.");
  }
  return value as TelegramRenderEnvironment;
}

function telegramCodeBlock(content: string, rawLanguage = ""): string {
  const language = rawLanguage
    .trim()
    .split(/\s+/u)[0]
    .replace(/[^a-z0-9_+-]/giu, "")
    .slice(0, 32);
  const className = language
    ? ` class="language-${escapeTelegramHtml(language)}"`
    : "";
  return `<pre><code${className}>${escapeTelegramHtml(content.replace(/\n$/u, ""))}</code></pre>\n\n`;
}

function parseFence(
  source: string,
): { readonly language: string; readonly content: string } | null {
  const match = source.match(FENCE_OPEN);
  if (!match) return null;
  const marker = match[1];
  const remainder = match[3];
  const lines = remainder.split("\n");
  const closing = new RegExp(
    `^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`,
    "u",
  );
  if (!closing.test(lines.at(-1) ?? "")) return null;
  lines.pop();
  return {
    language: match[2].trim(),
    content: lines.join("\n"),
  };
}

function splitMarkdownBlocks(value: string): string[] {
  const blocks: string[] = [];
  const lines = value.split("\n");
  let pending: string[] = [];
  let fenceMarker: string | null = null;

  const flush = () => {
    const block = pending.join("\n").trim();
    if (block) blocks.push(block);
    pending = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1] ?? null;
    if (fenceMarker) {
      pending.push(line);
      if (
        fence &&
        fence[0] === fenceMarker[0] &&
        fence.length >= fenceMarker.length
      ) {
        fenceMarker = null;
      }
      continue;
    }
    if (fence) {
      if (pending.length > 0) flush();
      fenceMarker = fence;
      pending.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    pending.push(line);
  }
  flush();
  return blocks;
}

function splitPlainText(value: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    const candidate = remaining.slice(0, maxChars);
    const lineBreak = candidate.lastIndexOf("\n");
    const wordBreak = candidate.lastIndexOf(" ");
    const boundary = Math.max(lineBreak, wordBreak);
    const splitAt = boundary > maxChars * 0.55 ? boundary : maxChars;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function telegramVisibleLength(value: string): number {
  return value
    .replace(/<[^>]*>/gu, "")
    .replace(/&#\d+;|&(?:lt|gt|amp|quot);/gu, "x")
    .length;
}
