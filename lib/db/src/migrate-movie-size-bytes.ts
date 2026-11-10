import { pool } from "./index";

// Development setup only, never API startup or a production build hook.
// Nullable with no default: preserve historical rows without guessing file sizes.
try {
  await pool.query("ALTER TABLE studio_exports ADD COLUMN IF NOT EXISTS size_bytes bigint");
} finally {
  await pool.end();
}
