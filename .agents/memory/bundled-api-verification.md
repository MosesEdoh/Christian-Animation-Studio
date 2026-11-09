---
name: Bundled API verification
description: Why server import-boundary changes require checking the bundled runtime, not only TypeScript and tsx tests.
---

Verify the managed API workflow starts after changing server module-loading boundaries, even when TypeScript and tsx tests pass.

**Why:** Mixing a dynamic import of the shared database entry with existing static imports caused generated Zod schema initialization to fail only in the esbuild bundle. The same code passed direct-source tests.

**How to apply:** Keep database imports static where possible and initialize connection pools lazily instead. Treat the bundled startup check as a separate verification boundary from source-based tests.
