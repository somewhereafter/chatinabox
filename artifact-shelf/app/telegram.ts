"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/** The slice of the Telegram Web App bridge this shell actually touches. */
type TelegramWebApp = {
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent?(event: string, handler: () => void): void;
  offEvent?(event: string, handler: () => void): void;
  platform?: string;
  viewportStableHeight?: number;
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick?(handler: () => void): void;
  };
  initDataUnsafe?: {
    start_param?: string;
  };
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

const SHELL_COLOR = "#000000";

function getWebApp(): TelegramWebApp | undefined {
  if (typeof window === "undefined") return undefined;
  return window.Telegram?.WebApp;
}

/**
 * telegram-web-app.js defines `WebApp` in any browser, so its presence proves
 * nothing. Outside a real Mini App container the platform stays "unknown".
 */
function isInsideTelegram(webApp = getWebApp()): boolean {
  return Boolean(webApp) && webApp?.platform !== "unknown";
}

// Whether we are inside Telegram is fixed for the life of the document, so the
// store never notifies; it exists to give the server a stable `false` and the
// client the truth, without a hydration mismatch.
const subscribe = () => () => {};
const getServerSnapshot = () => false;

/**
 * Reads the opaque shelf requested at launch. Telegram supplies it as a start
 * parameter; a plain browser can pass `?shelf=` instead.
 */
function readLaunchParam(webApp: TelegramWebApp | undefined): string | null {
  const search = new URLSearchParams(window.location.search);
  return (
    webApp?.initDataUnsafe?.start_param ??
    search.get("tgWebAppStartParam") ??
    search.get("shelf")
  );
}

type Options = {
  /** Called once on mount with the launch parameter, when there is one. */
  onLaunchParam: (param: string) => void;
  /** Mirrors the shelf state onto Telegram's native back button. */
  menuOpen: boolean;
  onMenuBack: () => void;
};

export function useTelegramShell({
  onLaunchParam,
  menuOpen,
  onMenuBack,
}: Options) {
  const isTelegram = useSyncExternalStore(
    subscribe,
    isInsideTelegram,
    getServerSnapshot,
  );
  const launched = useRef(false);

  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    const param = readLaunchParam(getWebApp());
    if (param) onLaunchParam(param);
  }, [onLaunchParam]);

  useEffect(() => {
    const webApp = getWebApp();
    if (!isTelegram || !webApp) return;

    webApp.setHeaderColor?.(SHELL_COLOR);
    webApp.setBackgroundColor?.(SHELL_COLOR);
    webApp.ready();
    webApp.expand();

    // Telegram's stable viewport is the only reliable height inside the
    // WebView; without it the shell falls back to 100dvh.
    const applyViewport = () => {
      const height = webApp.viewportStableHeight;
      if (!height) return;
      document.documentElement.style.setProperty("--app-h", `${height}px`);
    };

    applyViewport();
    webApp.onEvent?.("viewportChanged", applyViewport);
    return () => webApp.offEvent?.("viewportChanged", applyViewport);
  }, [isTelegram]);

  useEffect(() => {
    const backButton = getWebApp()?.BackButton;
    if (!isTelegram || !backButton) return;

    if (!menuOpen) {
      backButton.hide();
      return;
    }

    backButton.onClick(onMenuBack);
    backButton.show();
    return () => backButton.offClick?.(onMenuBack);
  }, [isTelegram, menuOpen, onMenuBack]);

  const closeApp = useCallback(() => getWebApp()?.close(), []);

  return { isTelegram, closeApp };
}
