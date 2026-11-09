---
name: Workspace hook tests
description: React peer duplication when exercising real workspace query hooks in Vitest.
---

When testing actual generated hooks across workspace package boundaries, ensure the renderer and React Query share one React instance. Vite deduplication alone may not affect dependencies that Vitest externalizes.

**Why:** Hook-mocked component suites passed while real generated hooks failed with an invalid-hook-call error: externalized React Query resolved a different installed React peer from the renderer.

**How to apply:** When adding real-hook integration tests or changing test dependency handling, preserve a single React and React Query context across workspace boundaries. If invalid-hook-call errors occur only with real hooks, check dependency externalization before changing application hooks.

When the browser reports mismatched React versions but installed packages and the lockfile agree, inspect Vite's dependency-optimization cache before changing dependencies.

**Why:** A stale prebundle retained an older React DOM runtime after the workspace packages had been aligned; passing unit tests and type checks did not expose the browser failure.

**How to apply:** Remove only the affected app's generated Vite cache and restart its managed workflow, then verify the preview. Do not change correctly aligned dependency versions to compensate for stale generated modules.
