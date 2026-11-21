# Deployment topology

Next.js is deployed to **Vercel**. The two LiveKit agent workers are **not**
part of that deployment: they hold long-lived WebRTC connections, which a
request-scoped serverless function cannot do. They run as hosted LiveKit Cloud
agents (free Build plan is supported, with concurrency limits and cold starts).

| Component | Where it runs | Entry |
| --- | --- | --- |
| Next.js app, API routes, webhooks | Vercel | standard Next.js build |
| Voice interview planner | LiveKit Cloud agent `aimis-generator` | `scripts/livekit-generator.mjs` |
| Live interviewer | LiveKit Cloud agent `aimis-interviewer` | `scripts/livekit-interviewer.mjs` |

## Vercel

Deploy the repo normally. Required server env vars are in `docs/ENVIRONMENT.md`.
Configure the LiveKit webhook URL to `https://<vercel-host>/api/v1/webhooks/livekit`
for `room_started` and `room_finished`.

## Hosted agents

Build one image per role from the repo root:

```sh
docker build -f agents/Dockerfile \
  --build-arg AGENT_ENTRY=scripts/livekit-generator.mjs \
  -t aimis-generator .
docker build -f agents/Dockerfile \
  --build-arg AGENT_ENTRY=scripts/livekit-interviewer.mjs \
  -t aimis-interviewer .
```

Register and deploy each with the LiveKit CLI (verify current syntax in the
LiveKit docs before running):

```sh
lk cloud auth
lk agent create --id aimis-generator
lk agent deploy --id aimis-generator --image aimis-generator \
  --secrets GOOGLE_GENERATIVE_AI_API_KEY=... \
  --secrets APP_URL=https://<vercel-host>
lk agent create --id aimis-interviewer
lk agent deploy --id aimis-interviewer --image aimis-interviewer \
  --secrets GOOGLE_GENERATIVE_AI_API_KEY=... \
  --secrets APP_URL=https://<vercel-host>
```

`APP_URL` must point at the deployed Vercel host so workers can POST captions,
the generated configuration and finalized transcripts. The `LIVEKIT_*` keys are
read by the app; the agents receive their credentials from the LiveKit runtime.
No Vapi account or key is involved.

For local development, the same scripts run directly with `pnpm agent:generator`
and `pnpm agent:interviewer` (both defined in `package.json`).
