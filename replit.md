# Frame & Faith Creative Studio

Private creative workspace for writing, directing, storyboarding, and generating a Christian animated action series for ages 5–17.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm test:episode-exports` — episode assembly, ZIP, download helper, and signed-in dashboard component regression tests; requires `ffmpeg` and `ffprobe`, creates temporary media, and mocks provider downloads without querying the database
- `pnpm test:episode-admission` — shared admission unit and PostgreSQL multi-process/crash-recovery tests; requires `DATABASE_URL` and the current DB schema; uses isolated test pool names
- `pnpm --filter @workspace/creative-studio run test:components` — dashboard and episode download controls in jsdom; no sign-in, database, or running servers required
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
- `artifacts/api-server/src/routes/storage.ts` — signed private asset uploads and protected reads
- `artifacts/api-server/src/routes/auth.ts` — Replit OIDC browser sign-in and sessions
- `artifacts/api-server/src/lib/ai.ts` — direct Gemini client with transient retry handling
- `artifacts/api-server/src/lib/video-provider.ts` — swappable mock / Runway / Luma / Pika adapter
- `lib/api-spec/openapi.yaml` — source-of-truth API contract
- `lib/db/src/schema/studio.ts` — Postgres schema and seed-backed studio entities
- `lib/db/src/schema/auth.ts` — session and user tables required for signed-in uploads

## Architecture decisions

- The first build uses a single active studio project with database-backed episodes, scenes, characters, shots, and clips.
- Gemini text actions run server-side so the API key never reaches the browser.
- Video generation is isolated behind `video-provider.ts`; `VIDEO_PROVIDER=mock` keeps local development usable until a provider is configured.
- Reference images are uploaded directly to private App Storage using presigned URLs; Postgres stores object paths and metadata, not image bytes.
- Reference uploads and private asset reads require an authenticated Replit session.
- The series ZIP export includes scripts, shot lists, character data, reference images, and provider clips when they are browser-downloadable; otherwise it records provider URLs.
- Scene headings, intentions, scripts, and storyboard-card edits/order are stored in Postgres; unsaved script edits save before changing scenes or leaving the editor.
- Difficult faith questions are explored in a Bible-grounded, broadly Christian writers’ tool; the question is sent to Gemini for generation but is not saved to the studio database.

## Product

The studio provides a dashboard, screenplay editor, AI co-writer, audience safety check, character bible, director notes, cinematography shot suggestions, persistent storyboard and character references, a per-shot animation queue, and an all-episodes ZIP export. Its Christian framing should be rooted in the Bible, welcoming of difficult questions children may feel unable to ask, age-aware, and clear that safety concerns need a trusted safe adult rather than secrecy.

## User preferences

- Dark-mode-friendly personal tool; Bible-grounded Christian and age-appropriate action tone; video provider must remain swappable.

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after changing `lib/api-spec/openapi.yaml`.
- Gemini direct API keys for new users may reject older model names; the client defaults to `GEMINI_MODEL` or `gemini-3.6-flash`.
- A mock video provider creates queue records, not rendered video; real media downloads depend on the selected provider returning accessible clip URLs.
- Provider-clip episode MP4 exports share a global capacity of two via PostgreSQL leases (including streaming and cleanup), with no queue. Excess requests return 503 / `EPISODE_EXPORT_BUSY` and `Retry-After: 15`. Owners renew every 15 seconds; leases expire after 60 seconds, and failed renewal stops the export. Database failures never fall back to local admission. This is separate from the storyboard movie queue.
- An admitted provider-clip episode export has a 15-minute total budget across provider downloads, media conversion, and MP4 delivery. The deadline aborts active work/streams; temporary-file cleanup finishes before admission is released. A timeout before delivery returns a retryable 502; during delivery the partial response is closed.
- Roll out shared admission only after applying the DB schema, and drain/restart all old API instances: older versions do not participate in shared admission. Changing the capacity requires draining exports and updating both the code constant and the `provider-clip-episode` pool capacity together; mismatched instances fail closed.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
