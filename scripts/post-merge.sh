#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server exec tsx ../../lib/db/src/migrate-movie-request-id.ts
pnpm --filter @workspace/api-server exec tsx ../../lib/db/src/migrate-movie-size-bytes.ts
# Use the exact workspace name. No --force: refuse changes that need a
# destructive-data confirmation instead of approving them unattended.
pnpm --filter @workspace/db run push
