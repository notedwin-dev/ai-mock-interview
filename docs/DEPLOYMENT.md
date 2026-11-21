# Deployment topology

Next.js is deployed to **Vercel**. The LiveKit agent is **not** part of that
deployment: it holds long-lived WebRTC connections, which a request-scoped
serverless function cannot do. It runs as a hosted LiveKit Cloud agent (free
Build plan supports one deployed agent, so the planner and interviewer roles
share a single worker chosen by dispatch metadata).

| Component | Where it runs | Entry |
| --- | --- | --- |
| Next.js app, API routes, webhooks | Vercel | standard Next.js build |
| Voice planner + live interviewer | LiveKit Cloud agent `aimis-agent` | `scripts/livekit-agent.mjs` |

## Vercel

Deploy the repo normally. Required server env vars are in `docs/ENVIRONMENT.md`.
Configure the LiveKit webhook URL to `https://<vercel-host>/api/v1/webhooks/livekit`
for `room_started` and `room_finished`.

## Hosted agents

Build one image from the repo root:

```sh
docker build -f agents/Dockerfile -t aimis-agent .
```

Register and deploy that single agent with the LiveKit CLI (verify current
syntax in the LiveKit docs before running):

```sh
lk cloud auth
lk agent create --id aimis-agent
lk agent deploy --id aimis-agent --image aimis-agent \
  --secrets GOOGLE_GENERATIVE_AI_API_KEY=... \
  --secrets APP_URL=https://<vercel-host>
```

Dispatches include `role: "generator"` or `role: "interviewer"` in their
metadata; the single worker entry routes to the right flow.

`APP_URL` must point at the deployed Vercel host so workers can POST captions,
the generated configuration and finalized transcripts. The `LIVEKIT_*` keys are
read by the app; the agents receive their credentials from the LiveKit runtime.
No Vapi account or key is involved.

For local development, run `pnpm agent` (defined in `package.json`).

## Why not Vercel Sandbox for the workers?

An on-demand Vercel Sandbox can host a voice agent, but LiveKit Agents are
designed as a standby **worker pool**: an agent server registers with LiveKit
and waits for dispatch, which completes in under 150 ms when a server is ready.
A fresh sandbox must clone the repo, install dependencies and start the agent —
roughly 20–40 s — and needs extra lifecycle/polling code. Hosted agents are
LiveKit's first-class deployment path and keep dispatch fast with no extra app
code, so this project uses them while Vercel hosts only the Next.js app.
Revisit if a single-platform deployment becomes more important than join latency.
