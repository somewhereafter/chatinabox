"use client";

import type { ReactNode } from "react";
import type { ArtifactRecord } from "./artifact-types";

export function artifactMeta(artifact: ArtifactRecord): string {
  const summary = artifact.metadata.summary;
  if (typeof summary === "string" && summary.trim()) {
    return summary.trim().slice(0, 120);
  }
  if (artifact.url) {
    try {
      return new URL(artifact.url).hostname;
    } catch {
      return "deployed artifact";
    }
  }
  return artifact.telegramMessageId
    ? "shared in this Telegram topic"
    : "session output";
}

export function artifactKind(artifact: ArtifactRecord): string {
  return artifact.kind.slice(0, 12).toUpperCase();
}

export function renderArtifact(artifact: ArtifactRecord): ReactNode {
  const renderer = artifact.metadata.renderer;
  if (
    artifact.url &&
    renderer !== "external" &&
    renderer !== "download"
  ) {
    return (
      <iframe
        className="artifact-frame"
        src={artifact.url}
        title={artifact.title}
        referrerPolicy="no-referrer"
        loading="eager"
      />
    );
  }

  if (artifact.url) {
    return (
      <ArtifactNotice
        eyebrow={artifactKind(artifact)}
        title={artifact.title}
        detail="This artifact opens in its own full page."
        action={
          <a href={artifact.url} target="_blank" rel="noreferrer">
            Open artifact
          </a>
        }
      />
    );
  }

  return (
    <ArtifactNotice
      eyebrow={artifactKind(artifact)}
      title={artifact.title}
      detail={
        artifact.telegramMessageId
          ? "This file was delivered natively in the Telegram topic."
          : "This output is registered in the session without a web preview."
      }
    />
  );
}

function ArtifactNotice({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="artifact-notice">
      <div className="artifact-notice-inner">
        <p className="artifact-notice-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{detail}</p>
        {action ? <div className="artifact-notice-action">{action}</div> : null}
      </div>
    </div>
  );
}
