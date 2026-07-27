# Artifact shelf publisher

Chatinabox can collect every output made in one Codex session behind one shelf
link. The shelf is deliberately provider-neutral: Chatinabox does not dictate
how an artifact is built, where it is deployed, or what it can do.

Native Telegram file delivery works without a publisher. Configure a publisher
only when you want the session-level web or Telegram Mini App shelf.

## Fastest production setup

This repository includes a complete publisher and Mini App under
[`artifact-shelf/`](../artifact-shelf/). It has:

- the single-control black artifact shell and compact session sidebar;
- durable D1-backed manifest storage;
- a constant-time bearer-token write boundary;
- bounded manifest, URL, metadata, and artifact validation;
- Telegram Mini App viewport, safe-area, back-button, and launch-parameter
  support;
- full-viewport cross-origin artifacts with an external-open fallback.

Deploy that directory with OpenAI Sites, set its `PUBLISHER_TOKEN` runtime
secret to a new random value of at least 32 characters, and register the
deployed HTTPS origin as the bot's Main Mini App URL in BotFather. Then install
or upgrade Chatinabox with:

```sh
sudo \
  CHATINABOX_ARTIFACTS_API_URL='https://your-shelf.example/api/' \
  CHATINABOX_ARTIFACTS_API_TOKEN='the-same-random-publisher-secret' \
  ./scripts/install.sh
```

`chatinabox doctor` verifies the authenticated publisher and its storage.
Chatinabox resolves the bot's public username through the Bot API when it needs
to create the `startapp` launch link, so there is no extra bot-identity setting
to maintain.

## Agent workflow

Share a local file natively and register it:

```sh
chatinabox share ./report.pdf "Final report" --json
```

For a richer artifact, deploy it through the route appropriate to the work,
then register its public URL:

```sh
chatinabox share 'https://artifact.example/app' \
  "Interactive system map" \
  --title "System map" \
  --kind "interactive-app" \
  --metadata '{"renderer":"full-page","version":"1"}' \
  --json
```

Use `--url` when a local file also has a deployed version, `--preview` for a
separate preview URL, and `--no-deliver` when the artifact has already been
posted. Repeat `share` for every output in the session. `artifact list` shows
the local registry and `artifact sync` republishes the complete manifest.

## Configuration

Set both values during install:

```sh
sudo \
  CHATINABOX_ARTIFACTS_API_URL='https://artifacts.example.com/api/' \
  CHATINABOX_ARTIFACTS_API_TOKEN='a-long-random-publisher-secret' \
  ./scripts/install.sh
```

Upgrades preserve these values. If neither is set, `share` still delivers
native files and links and records the session locally. A half-configured
publisher is rejected.

## HTTP contract

The configured API must accept:

```text
GET {CHATINABOX_ARTIFACTS_API_URL}/v1/health
Authorization: Bearer {CHATINABOX_ARTIFACTS_API_TOKEN}
```

and return `{"ok":true}` so `chatinabox doctor` can verify the connection.
Manifest publication uses:

```text
PUT {CHATINABOX_ARTIFACTS_API_URL}/v1/shelves/{opaque-shelf-id}
Authorization: Bearer {CHATINABOX_ARTIFACTS_API_TOKEN}
Content-Type: application/json
```

Request body:

```json
{
  "version": 1,
  "shelf": {
    "id": "opaque-shelf-id",
    "updatedAt": 1800000000000
  },
  "artifacts": [
    {
      "id": "uuid",
      "title": "System map",
      "kind": "interactive-app",
      "url": "https://artifact.example/app",
      "previewUrl": "https://artifact.example/preview.png",
      "telegramMessageId": 808,
      "metadata": {
        "renderer": "full-page"
      },
      "createdAt": 1800000000000
    }
  ]
}
```

`url`, `previewUrl`, and `telegramMessageId` are independently optional.
`metadata` is an open JSON object so renderers and deployers can negotiate
capabilities without changing Chatinabox. Public URLs use HTTPS.

Successful response:

```json
{
  "ok": true,
  "shelfUrl": "https://artifacts.example.com/s/opaque-shelf-id",
  "launchUrl": "https://t.me/your_bot?startapp=opaque-shelf-id"
}
```

Both returned URLs are optional. When `launchUrl` is present, Chatinabox posts
an “Open artifact shelf” button in the attached Telegram topic. When only
`shelfUrl` is present, Chatinabox creates the Telegram Main Mini App launch URL
itself. The stable shelf button is posted for the first artifact in a session;
later artifacts update that same shelf without adding another navigation
message.

## Production requirements

- Treat the API token as a secret and compare it in constant time.
- Permit `PUT` only with the publisher token; public shelf reads must be
  read-only.
- Treat shelf and artifact IDs as opaque. Never derive filesystem paths from
  them.
- Validate the manifest version and enforce reasonable request, field, and
  artifact-count limits at the publisher.
- Store complete manifests atomically so readers never observe half an update.
- Keep public shelf identifiers cryptographically random and unguessable; the
  bundled registry uses 192-bit IDs.
- Serve the Mini App and artifact URLs over HTTPS with a restrictive security
  policy appropriate to the renderer.
- Do not inject remote artifact HTML into the shelf origin. Navigate to or
  isolate externally hosted applications according to their declared
  capabilities.
- Keep deployment credentials out of artifact metadata and logs.

The publisher may use any database, object store, framework, cloud, or
self-hosted stack. Its responsibility is durable manifest storage and shelf
navigation—not artifact deployment.
