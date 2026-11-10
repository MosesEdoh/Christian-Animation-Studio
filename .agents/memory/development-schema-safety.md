---
name: Safe development schema setup
description: Why legacy unique indexes must match Drizzle constraints before unattended development schema setup.
---

Do not force a schema push to bypass a prompt about truncating saved movie history. Reconcile equivalent standalone unique indexes with the schema's unique constraints without deleting rows.

**Why:** A prior additive movie migration used a standalone unique index. Drizzle did not recognize it as the declared unique constraint and offered to truncate the populated export table before adding that constraint. Attaching the existing index as a constraint preserves its protection and the movie history.

**How to apply:** When development schema setup unexpectedly asks about deleting data, inspect PostgreSQL constraints as well as indexes. Keep these repairs in development/post-merge setup, never API startup or production build hooks. Also inspect command output: this Drizzle version printed a non-TTY prompt error while returning exit code zero.
