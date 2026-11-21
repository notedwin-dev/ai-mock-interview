# Image for a single AIMIS LiveKit agent role. Build from the repo root:
#   docker build -f agents/Dockerfile --build-arg AGENT_ENTRY=scripts/livekit-generator.mjs -t aimis-generator .
#   docker build -f agents/Dockerfile --build-arg AGENT_ENTRY=scripts/livekit-interviewer.mjs -t aimis-interviewer .
#
# Deploy each image to LiveKit Cloud (see docs/DEPLOYMENT.md). Vercel hosts the
# Next.js app only; these workers need a long-lived process and cannot run there.
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.21.0 --activate

COPY package.json pnpm-lock.yaml ./
# Workers need no generated Prisma client, so skip the postinstall prisma step.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY scripts ./scripts
COPY src/lib/interview/generation-contract.mjs ./src/lib/interview/generation-contract.mjs

ARG AGENT_ENTRY=scripts/livekit-interviewer.mjs
ENV AGENT_ENTRY=${AGENT_ENTRY}

CMD ["sh", "-c", "node \"$AGENT_ENTRY\""]
