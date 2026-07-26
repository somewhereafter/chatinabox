import { describe, expect, it } from "vitest";
import {
  buildCodexAttachmentPrompt,
  buildBundledTelegramPrompt,
  buildTelegramTextPrompt,
  codexHelpText,
  formatCodexActivityStatus,
  formatCodexEvent,
  formatCodexQueuedUntilToolStatus,
  formatCodexRichMarkdown,
  parseArrowShortcut,
  sanitizeAttachmentFileName,
  selectTelegramMedia,
} from "../src/vps/codex-telegram";
import type { TelegramMessage } from "../src/telegram-types";

function message(
  overrides: Partial<TelegramMessage>,
): TelegramMessage {
  return {
    message_id: 42,
    chat: { id: 1 },
    from: { id: 2 },
    date: 1,
    ...overrides,
  };
}

describe("Codex Telegram attachments", () => {
  it("labels final answers with fin in standard and rich formatting", () => {
    const event = {
      id: 1,
      kind: "assistant_final" as const,
      target: { serverPid: 1, paneId: "%1", panePid: 2 },
      sessionId: "session",
      turnId: "turn",
      assistantName: "Sol" as const,
      message: "Finished.",
      createdAt: 1,
    };
    expect(formatCodexEvent(event)[0]).toContain(
      "🪩 <b>Sol · fin</b>",
    );
    expect(formatCodexRichMarkdown(event)).toContain(
      "🪩 **Sol · fin**",
    );
    const lobbyEvent = { ...event, assistantName: "Lobby" as const };
    expect(formatCodexEvent(lobbyEvent)[0]).toContain(
      "🪄 <b>Lobby · fin</b>",
    );
    expect(formatCodexRichMarkdown(lobbyEvent)).toContain(
      "🪄 **Lobby · fin**",
    );
  });

  it("selects the largest Telegram photo variant", () => {
    expect(selectTelegramMedia(message({
      photo: [
        {
          file_id: "small",
          file_unique_id: "s",
          width: 320,
          height: 240,
          file_size: 12_000,
        },
        {
          file_id: "large",
          file_unique_id: "l",
          width: 1_920,
          height: 1_080,
          file_size: 400_000,
        },
      ],
    }))).toEqual({
      fileId: "large",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      declaredBytes: 400_000,
      kind: "image",
    });
  });

  it("preserves useful filenames without allowing path traversal", () => {
    expect(sanitizeAttachmentFileName("../../my report (final).pdf"))
      .toBe("_my_report_final_.pdf");
    expect(sanitizeAttachmentFileName("\u0000/..")).toBe("attachment.bin");
  });

  it("builds one Codex turn for multiple attachments and a caption", () => {
    const prompt = buildCodexAttachmentPrompt([
      {
        path: "/var/lib/chatinabox/codex-attachments/id/01-photo.jpg",
        fileName: "01-photo.jpg",
        mimeType: "image/jpeg",
        bytes: 123,
        kind: "image",
      },
      {
        path: "/var/lib/chatinabox/codex-attachments/id/02-notes.pdf",
        fileName: "02-notes.pdf",
        mimeType: "application/pdf",
        bytes: 456,
        kind: "file",
      },
    ], "Compare these and explain the difference.");

    expect(prompt).toContain("1. /var/lib/chatinabox/");
    expect(prompt).toContain("2. /var/lib/chatinabox/");
    expect(prompt).toContain("Sent from Telegram");
    expect(prompt).not.toContain("Telegram user");
    expect(prompt).toContain("use the image viewer for images");
    expect(prompt).toContain("Compare these and explain the difference.");
  });

  it("passes one message through unchanged and bundles message bursts in order", () => {
    expect(buildBundledTelegramPrompt(["one message"])).toBe("one message");
    const bundled = buildBundledTelegramPrompt([
      "first thought",
      "and one more detail",
    ]);
    expect(bundled).toContain("--- Message 1 ---\nfirst thought");
    expect(bundled).toContain("--- Message 2 ---\nand one more detail");
    expect(bundled.indexOf("first thought"))
      .toBeLessThan(bundled.indexOf("and one more detail"));
  });

  it("adds a short quoted-reply reference without copying an entire message", () => {
    const prompt = buildTelegramTextPrompt(message({
      text: "This is the part I mean.",
      reply_to_message: message({
        message_id: 41,
        from: { id: 9, is_bot: true, first_name: "Sol" },
        text: "A".repeat(400),
      }),
    }));
    expect(prompt).toContain("Sent from Telegram in reply to Sol:");
    expect(prompt).toContain("This is the part I mean.");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(380);
  });

  it("formats accumulating Codex activity with natural plurals", () => {
    expect(formatCodexActivityStatus("1\u001f1")).toContain(
      "Ran <b>1</b> thing · ✏️ Edited <b>1</b> file",
    );
    expect(formatCodexActivityStatus("12\u001f3")).toContain(
      "Ran <b>12</b> things · ✏️ Edited <b>3</b> files",
    );
    expect(formatCodexActivityStatus("not counters")).toBeNull();
    expect(formatCodexActivityStatus("2\u001f0", "Sol")).toContain(
      "🎱 <b>Sol is working…</b>",
    );
    expect(formatCodexActivityStatus("2\u001f0", "Lobby")).toContain(
      "🪄 <b>Lobby is working…</b>",
    );
  });

  it("formats the busy-turn steering queue with natural plurals", () => {
    expect(formatCodexQueuedUntilToolStatus(1)).toContain(
      "🟠 <b>Message is queued · sending after Codex’s next tool call…</b>",
    );
    expect(formatCodexQueuedUntilToolStatus(3)).toContain(
      "🟠 <b>3 messages are queued · sending after Codex’s next tool call…</b>",
    );
    expect(formatCodexQueuedUntilToolStatus(1, "Luna")).toContain(
      "sending after Luna’s next tool call",
    );
  });

  it("documents every terminal key and stays within one Telegram message", () => {
    const help = codexHelpText();
    for (const key of [
      "esc",
      "enter",
      "up",
      "down",
      "left",
      "right",
      "tab",
      "backtab",
      "pageup",
      "pagedown",
      "home",
      "end",
      "backspace",
      "space",
      "ctrl-c",
      "ctrl-d",
      "ctrl-l",
      "ctrl-r",
    ]) {
      expect(help).toContain(`<code>${key}</code>`);
    }
    expect(help.length).toBeLessThanOrEqual(4_096);
    expect(help).toContain("/key down down enter");
    expect(help).toContain("down down right");
    expect(help).toContain("/model");
    expect(help).toContain("persistent 🪄 Lobby");
    expect(help).toContain("/codex off");
  });

  it("recognizes arrow-only mobile messages without stealing normal prose", () => {
    expect(parseArrowShortcut("up")).toEqual(["up"]);
    expect(parseArrowShortcut("down down, right")).toEqual([
      "down",
      "down",
      "right",
    ]);
    expect(parseArrowShortcut("UP LEFT")).toEqual(["up", "left"]);
    expect(parseArrowShortcut("enter")).toBeNull();
    expect(parseArrowShortcut("go up")).toBeNull();
    expect(parseArrowShortcut("up please")).toBeNull();
  });
});
