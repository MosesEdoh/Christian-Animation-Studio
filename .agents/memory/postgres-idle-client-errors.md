---
name: PostgreSQL idle-client errors
description: Prevent node-postgres pool-level idle socket errors from crashing the process during database interruptions.
---

Attach an error listener to every `pg.Pool`. node-postgres reports unexpected socket loss from idle clients through the pool's `error` event; without a listener, EventEmitter can terminate the process even though no request owns that client. Keep active query failures observable to the caller so lease and request logic can respond normally.

**Why:** A controlled database connection interruption during an active export showed that an idle pooled socket could crash the worker before heartbeat failure handling completed.

**How to apply:** When creating a `pg.Pool`, handle pool-level idle-client errors separately from active query rejection. Log a safe, non-sensitive summary and let the pool discard the broken idle client.
