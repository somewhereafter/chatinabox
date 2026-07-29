import net from "node:net";
import {
  DEFAULT_CODEX_BRIDGE_SOCKET,
  type CodexBridgeRequest,
  type CodexBridgeResponse,
} from "./codex-bridge-protocol";

const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 3_000;
const SCREEN_REQUEST_TIMEOUT_MS = 20_000;
const GOAL_REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_REQUEST_TIMEOUT_MS = 90_000;

export function bridgeRequestTimeoutMs(
  request: Pick<CodexBridgeRequest, "op">,
  baselineMs = REQUEST_TIMEOUT_MS,
): number {
  if (
    request.op === "new" ||
    request.op === "resume" ||
    request.op === "lobby"
  ) {
    return Math.max(baselineMs, STARTUP_REQUEST_TIMEOUT_MS);
  }
  if (request.op === "screen") {
    return Math.max(baselineMs, SCREEN_REQUEST_TIMEOUT_MS);
  }
  if (
    request.op === "goals" ||
    request.op === "goal_get" ||
    request.op === "goal_set" ||
    request.op === "goal_clear"
  ) {
    return Math.max(baselineMs, GOAL_REQUEST_TIMEOUT_MS);
  }
  return baselineMs;
}

export class CodexBridgeClient {
  constructor(
    readonly socketPath =
      process.env.CHATINABOX_BRIDGE_SOCKET ??
      DEFAULT_CODEX_BRIDGE_SOCKET,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  request(request: CodexBridgeRequest): Promise<CodexBridgeResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      let data = "";

      const finish = (
        callback: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        callback();
      };

      const timeoutMs = bridgeRequestTimeoutMs(request, this.timeoutMs);
      const timer = setTimeout(() => {
        finish(() => reject(new Error("Codex bridge timed out")));
      }, timeoutMs);
      timer.unref();

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.end(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: string) => {
        data += chunk;
        if (Buffer.byteLength(data) > MAX_RESPONSE_BYTES) {
          finish(() => reject(new Error("Codex bridge response was too large")));
        }
      });
      socket.once("error", () => {
        finish(() => reject(new Error("Codex bridge is unavailable")));
      });
      socket.once("end", () => {
        finish(() => {
          try {
            const parsed = JSON.parse(data.trim()) as CodexBridgeResponse;
            resolve(parsed);
          } catch {
            reject(new Error("Codex bridge returned an invalid response"));
          }
        });
      });
    });
  }
}
