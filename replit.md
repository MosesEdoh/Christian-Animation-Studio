# Frame & Faith Creative Studio

Private creative workspace for writing, directing, storyboarding, and generating a Christian animated action series for ages 5–17.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/creative-studio/src/App.tsx` — main studio workspace and workflow views
- `artifacts/creative-studio/src/index.css` — evening storyboard room visual system
- `artifacts/api-server/src/routes/studio.ts` — studio bootstrap, AI actions, and clip generation routes
- `artifacts/api-server/src/lib/ai.ts` — direct Gemini client with transient retry handling
- `artifacts/api-server/src/lib/video-provider.ts` — swappable mock / Runway / Luma / Pika adapter
- `lib/api-spec/openapi.yaml` — source-of-truth API contract
- `lib/db/src/schema/studio.ts` — Postgres schema and seed-backed studio entities

## Architecture decisions

- The first build uses a single active studio project with database-backed episodes, scenes, characters, shots, and clips.
- Gemini text actions run server-side so the API key never reaches the browser.
- Video generation is isolated behind `video-provider.ts`; `VIDEO_PROVIDER=mock` keeps local development usable until a provider is configured.
- Reference image uploads currently use browser-session previews; persistent file storage is intentionally a follow-up to avoid storing base64 bytes in Postgres.

## Product

The studio provides a dashboard, screenplay editor, AI co-writer, audience safety check, character bible, director notes, cinematography shot suggestions, storyboard upload/reordering, and a per-shot animation queue.

## User preferences

- Dark-mode-friendly personal tool; Christian, age-appropriate action tone; video provider must remain swappable.

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`.
- Gemini direct API keys for new users may reject older model names; the client defaults to `GEMINI_MODEL` or `gemini-3.6-flash`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
