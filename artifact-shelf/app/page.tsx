"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  artifactKind,
  artifactMeta,
  renderArtifact,
} from "./artifacts";
import type {
  ArtifactManifest,
  ArtifactRecord,
  ShelfResponse,
} from "./artifact-types";
import { useTelegramShell } from "./telegram";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; manifest: ArtifactManifest }
  | { status: "error"; message: string };

export default function Home() {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [shelfId, setShelfId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const shelfElementId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shelfRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLElement>(null);

  const artifacts =
    loadState.status === "ready" ? loadState.manifest.artifacts : [];
  const active = artifacts.find((item) => item.id === activeId) ?? null;
  const count = String(artifacts.length).padStart(2, "0");

  const closeShelf = useCallback(({ restoreFocus = true } = {}) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const onLaunchParam = useCallback((param: string) => {
    if (validShelfId(param)) setShelfId(param);
  }, []);

  const { isTelegram, closeApp } = useTelegramShell({
    onLaunchParam,
    menuOpen: open,
    onMenuBack: closeShelf,
  });

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const fromQuery = search.get("shelf");
    if (fromQuery && validShelfId(fromQuery)) setShelfId(fromQuery);
  }, []);

  useEffect(() => {
    if (!shelfId) {
      setLoadState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setLoadState({ status: "loading" });
    void fetch(`/api/v1/shelves/${encodeURIComponent(shelfId)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | ShelfResponse
          | { error?: string }
          | null;
        if (!response.ok || !body || body.ok !== true) {
          throw new Error(
            body && "error" in body && body.error
              ? body.error
              : "This artifact shelf is unavailable.",
          );
        }
        setLoadState({ status: "ready", manifest: body.manifest });
        const requested = new URLSearchParams(window.location.search).get(
          "artifact",
        );
        if (
          requested &&
          body.manifest.artifacts.some((artifact) => artifact.id === requested)
        ) {
          setActiveId(requested);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "This artifact shelf is unavailable.",
        });
      });
    return () => controller.abort();
  }, [shelfId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeShelf();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeShelf]);

  useEffect(() => {
    if (!open) return;
    const shelf = shelfRef.current;
    const target =
      shelf?.querySelector<HTMLElement>('[aria-current="true"]') ??
      shelf?.querySelector<HTMLElement>(".row");
    const frame = requestAnimationFrame(() => target?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    canvasRef.current?.scrollTo({ top: 0, left: 0 });
  }, [activeId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (shelfId) url.searchParams.set("shelf", shelfId);
    if (activeId) url.searchParams.set("artifact", activeId);
    else url.searchParams.delete("artifact");
    window.history.replaceState(null, "", url);
  }, [shelfId, activeId]);

  const select = (artifact: ArtifactRecord) => {
    setActiveId(artifact.id);
    closeShelf({ restoreFocus: false });
    requestAnimationFrame(() => canvasRef.current?.focus());
  };

  return (
    <>
      <h1 className="sr-only">Artifact shelf</h1>
      <p className="sr-only" role="status">
        {active ? `${active.title} open` : statusText(loadState)}
      </p>

      <button
        ref={triggerRef}
        type="button"
        className="trigger"
        data-open={open}
        data-idle={!active}
        aria-expanded={open}
        aria-controls={shelfElementId}
        aria-label={open ? "Close artifact shelf" : "Open artifact shelf"}
        onClick={() => (open ? closeShelf() : setOpen(true))}
      >
        <span className="trigger-glyph" aria-hidden="true">
          <span className="bar" />
          <span className="bar" />
          <span className="bar" />
        </span>
      </button>

      <aside
        ref={shelfRef}
        id={shelfElementId}
        className="shelf"
        data-open={open}
        inert={!open}
        aria-labelledby={titleId}
      >
        <div className="shelf-head">
          <p className="shelf-eyebrow">Chatinabox</p>
          <h2 className="shelf-title" id={titleId}>
            Session artifacts
          </h2>
          <p className="shelf-count">
            <span className="dot" aria-hidden="true" />
            {loadState.status === "loading"
              ? "loading shelf"
              : `${count} on the shelf`}
          </p>
        </div>

        <nav className="shelf-scroll" aria-labelledby={titleId}>
          {loadState.status === "error" ? (
            <p className="shelf-message">{loadState.message}</p>
          ) : artifacts.length ? (
            <ul className="shelf-list">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <button
                    type="button"
                    className="row"
                    aria-current={
                      artifact.id === activeId ? "true" : undefined
                    }
                    onClick={() => select(artifact)}
                  >
                    <span className="row-name">{artifact.title}</span>
                    <span className="row-kind">{artifactKind(artifact)}</span>
                    <span className="row-meta">{artifactMeta(artifact)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="shelf-message">
              {loadState.status === "loading"
                ? "Fetching session outputs…"
                : "No session shelf is open."}
            </p>
          )}
        </nav>

        <div className="shelf-foot">
          {active?.url ? (
            <a
              className="foot-action"
              href={active.url}
              target="_blank"
              rel="noreferrer"
            >
              Open full page
            </a>
          ) : (
            <span className="foot-note">Nothing open</span>
          )}
          {isTelegram ? (
            <button type="button" className="foot-action" onClick={closeApp}>
              Close app
            </button>
          ) : (
            <span className="foot-note">Esc to close</span>
          )}
        </div>
      </aside>

      <div
        className="scrim"
        data-open={open}
        aria-hidden="true"
        onClick={() => closeShelf()}
      />

      <main
        ref={canvasRef}
        id="artifact-canvas"
        className="canvas"
        tabIndex={-1}
        inert={open}
        data-artifact={active?.id ?? ""}
        data-empty={!active}
      >
        {active ? renderArtifact(active) : <EmptyCanvas state={loadState} />}
      </main>
    </>
  );
}

function EmptyCanvas({ state }: { state: LoadState }) {
  const title =
    state.status === "error"
      ? "Shelf unavailable"
      : state.status === "loading"
        ? "Opening shelf"
        : "No artifact open";
  const detail =
    state.status === "ready"
      ? `${String(state.manifest.artifacts.length).padStart(2, "0")} on the shelf`
      : state.status === "error"
        ? "Open the menu for details"
        : state.status === "loading"
          ? "One moment"
          : "Open from a Chatinabox session";

  return (
    <div className="empty">
      <div className="empty-inner">
        <span className="empty-rule" aria-hidden="true" />
        <p className="empty-title">{title}</p>
        <p className="empty-sub">{detail}</p>
      </div>
    </div>
  );
}

function statusText(state: LoadState): string {
  if (state.status === "loading") return "Artifact shelf loading";
  if (state.status === "error") return state.message;
  if (state.status === "ready") {
    return `${state.manifest.artifacts.length} artifacts available`;
  }
  return "No artifact open";
}

function validShelfId(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,96}$/u.test(value);
}
