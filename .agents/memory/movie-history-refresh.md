---
name: Movie history refresh
description: Why preserving a paginated movie history requires stable ID coverage during refresh.
---

Refreshing saved movie history must preserve the loaded ID range and an explicitly selected older movie, while still applying fresh server statuses and removals.

**Why:** Re-fetching the same number of fixed-size pages can silently drop the oldest loaded movies when new movies arrive at the front. Keeping a separate accumulated copy avoids that loss but risks retaining deleted movies or outdated statuses.

**How to apply:** Preserve cursor boundaries during refresh and fetch enough rows to cover each previously loaded range. Verify insertion across multiple page boundaries, failed refreshes, and selection through the existing private-media player boundary. Do not retain stale rows indefinitely just to preserve a selection.
