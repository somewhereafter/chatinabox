export type ArtifactMetadata = Readonly<Record<string, unknown>>;

export type ArtifactRecord = {
  id: string;
  title: string;
  kind: string;
  url?: string;
  previewUrl?: string;
  telegramMessageId?: number;
  metadata: ArtifactMetadata;
  createdAt: number;
};

export type ArtifactManifest = {
  version: 1;
  shelf: {
    id: string;
    updatedAt: number;
  };
  artifacts: ArtifactRecord[];
};

export type ShelfResponse = {
  ok: true;
  manifest: ArtifactManifest;
};
