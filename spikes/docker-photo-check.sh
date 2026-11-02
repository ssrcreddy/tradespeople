#!/bin/sh
# Runs the photo spike inside the production base image (design §7: node:24-bookworm-slim)
# so sharp/heic-convert are proven on Linux, not just on the dev machine.
# Usage (from repo root): sh spikes/docker-photo-check.sh
set -e
docker run --rm \
  -v "$(pwd)":/src:ro \
  -w /work \
  node:24-bookworm-slim \
  sh -c '
    set -e
    cp -r /src/package.json /src/pnpm-workspace.yaml /src/tsconfig.base.json /src/packages /work/
    mkdir -p spikes && cp -r /src/spikes/*.ts /src/spikes/package.json /src/spikes/samples spikes/
    corepack enable >/dev/null 2>&1
    pnpm install --filter @qa/spikes... --config.confirmModulesPurge=false >/dev/null
    cd spikes && node photo.ts samples/photos
  '
