---
name: Temporary render recovery safety
description: Conservative ownership policy for recovering abandoned render folders.
---

Treat uncertain ownership as potentially active, even when a temporary render folder is older than its recovery lease. A live owner PID is protected even if that PID may have been reused; unknown hosts, invalid ownership metadata, and permission-denied process probes are not proof of abandonment.

**Why:** The task explicitly requires that recovery never remove active render directories. Reclaiming every ambiguous leftover is less important than preserving work that may still be running.

**How to apply:** Keep cleanup conservative if changing owner identification or moving temporary storage to a shared filesystem. Do not replace process-ownership checks with age alone for folders that have owner metadata.
