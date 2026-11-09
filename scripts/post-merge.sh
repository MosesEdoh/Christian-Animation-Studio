#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server exec tsx ../../lib/db/src/migrate-movie-request-id.ts
pnpm --filter db push
