# syntax=docker/dockerfile:1
# Single AIMIS agent image (Build plan allows one deployed agent):
#   docker build -f agents/Dockerfile -t aimis-agent .
#
# Based on the official LiveKit Agent Dockerfile guidance:
# https://docs.livekit.io/deploy/agents/builds/
# ca-certificates is required by the SDK's native Rust core for TLS.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.21.0

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Native LiveKit RTC modules need their install scripts. Provide the Prisma
# schema/config so the root postinstall (`prisma generate`) can also run.
COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN pnpm install --frozen-lockfile
COPY . .
# Prisma is a dev dependency removed by prune; skip scripts at this stage only.
RUN pnpm prune --prod --ignore-scripts

FROM base
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/app" --shell "/sbin/nologin" --uid "${UID}" appuser
WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
ENV NODE_ENV=production

# LiveKit Cloud requires a fixed startup command. The pnpm script supplies the
# single `start` subcommand; invoking the script directly would print usage.
CMD ["pnpm", "agent"]
