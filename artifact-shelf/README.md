# Chatinabox Artifact Shelf

A production-ready Telegram Mini App and manifest publisher for reopening every
artifact made in one Chatinabox session without leaving Telegram.

The app is a shell, not a frame. The page is black and empty until an artifact
is chosen; a single glass control in the top-left opens a compact dark shelf
listing the session’s artifacts. Choosing one hands it the entire viewport.

## Prerequisites

- Node.js `>=22.13.0`

## Local development

```bash
npm install
npm run dev
npm run build
```

Generate the D1 migration after changing `db/schema.ts`:

```bash
npm run db:generate
```

## Production configuration

The site needs a D1 binding named `DB` and these runtime variables:

- `PUBLISHER_TOKEN`: a random secret of at least 32 characters. Chatinabox uses
  it to replace a session's complete manifest.

The public read route is protected by an opaque, 192-bit shelf ID rather than
an account. The write route requires the publisher token, validates and bounds
the complete manifest, and atomically replaces the durable D1 record.

Configure the deployed origin as the bot's Mini App URL in BotFather. Then set
Chatinabox's `CHATINABOX_ARTIFACTS_API_URL` to that origin plus `/api/` and
`CHATINABOX_ARTIFACTS_API_TOKEN` to the same publisher token.

## Rendering contract

The shell adds no padding, background, width, or frame around the artifact
canvas. HTTPS artifacts render full-viewport in a cross-origin iframe by
default and always get an external full-page link. Set
`metadata.renderer` to `external` or `download` when an artifact must skip
embedding. Native Telegram-only files remain visible on the shelf and point the
user back to the originating topic.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build, then verify the rendered shell and the shipped stylesheet
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
