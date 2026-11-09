---
name: Movie output limits
description: Why bounded movie encoding must reject size-limited results even when FFmpeg exits successfully.
---

Treat a size-limited FFmpeg result as a failed movie, not a successful partial export. Leave room for muxer packet overhead when allocating output bytes.

**Why:** FFmpeg's `-fs` can exit successfully after stopping early and can exceed its requested size by a packet. Publishing that output would silently omit part of the creator's story.

**How to apply:** Keep the post-encode size check and negative-path coverage when changing encoder flags or temporary-file budgeting. Never infer completeness solely from a zero encoder exit code.

Bound database waits as well as rendering operations, and account for a completion write committing before its response reaches the worker.

**Why:** Aborting a render signal does not interrupt an ordinary awaited database update. A stalled progress or failure-status write can block the queue indefinitely; simply racing a completion write can leave a late `ready` row pointing to a movie that cleanup already deleted.

**How to apply:** Keep both server-side statement and client/connection timeouts for movie database work. Retain guarded, compensating completion writes and tests for stalled progress, failed status reporting, and late completion responses.
