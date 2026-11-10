# Performance Strategy

## Hot paths
- `GET /api/studio/bootstrap` gates the web workspace and the main mobile tabs. It currently returns full scripts and all clips/assets; no automatic bootstrap polling was found.
- Web/mobile movie history hooks poll every three seconds and retain loaded pages. Web also recomputes saved-movie storage totals every three seconds and preflight estimates every thirty seconds while its dashboard is mounted.
- Authenticated private media/range requests, AI/video generation, provider-clip episode downloads, and queued storyboard movie exports.
- Mobile has a standalone Expo production static server (`server/serve.js`); its actual deployment traffic was not available.

## Large / growing tables
- `studio_clips` grows with each successful clip generation; `studio_exports` retains movie history until explicit deletion. Scenes, shots, and references grow as creators save work.
- No live row counts, deployed index inventory, or execution plans were available. Do not assume these tables are already large.
- Declared export indexes cover ID and request ID, but not queue status/stale-render predicates. The worker wakes every ten seconds per API instance, including when idle.

## Performance budgets and constraints
- Provider-clip episode exports intentionally share two PostgreSQL admission leases and a 15-minute deadline, including delivery and cleanup. Preserve admission, cancellation, fail-closed renewal, and resource limits; do not recommend unbounded parallel media processing.
- Dialogue TTS is currently regenerated per episode download, serially by scene/group; each provider attempt has a 90-second timeout.
- Storyboard movie rendering/preflight have explicit resource bounds and isolated bounded DB pools. Preflight already batches scripts and projects bounded text; ZIP compression already runs in a worker with transferable buffers.
- Studio data is intentionally shared under the current single-project architecture. Access isolation is a separate product/security concern, not a performance finding by itself.
- This scan had no workflow, browser, or deployment log content. Findings are source-evidenced, not measured production latency claims. Scan without running project scripts or querying live databases.

## Dismissed categories
- None recorded; no seeded performance issues were present in task 88.
