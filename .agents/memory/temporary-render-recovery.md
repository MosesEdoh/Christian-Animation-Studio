---
name: Temporary render recovery safety
description: Conservative ownership policy for recovering abandoned render folders.
---

Treat uncertain ownership as potentially active, even when a temporary render folder is older than its recovery lease. A live owner PID is protected even if that PID may have been reused; unknown hosts, invalid ownership metadata, and permission-denied process probes are not proof of abandonment.

**Why:** The task explicitly requires that recovery never remove active render directories. Reclaiming every ambiguous leftover is less important than preserving work that may still be running.

**How to apply:** Keep cleanup conservative if changing owner identification or moving temporary storage to a shared filesystem. Do not replace process-ownership checks with age alone for folders that have owner metadata.

Episode downloads need separate protection for surviving media children as well as the server owner. Uncertain child startup must remain protected, even if this leaves a folder requiring manual attention. Database probe failures are also uncertainty, not evidence that an admission lease expired.

**Why:** Abrupt server termination can leave FFmpeg alive after its parent dies, including the window before the parent can publish the child's identity. A total export deadline or an expired database lease alone cannot prove that child has stopped.

**How to apply:** Preserve the conservative child-start handoff when changing episode media execution. Never reclaim a marked episode folder solely from its age or admission expiry, and never inspect or delete saved objects during temporary-folder recovery.
