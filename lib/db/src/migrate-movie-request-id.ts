import { pool } from "./index";

// Additive, repeatable migration. Apply before starting API versions that read
// request_id; existing movie history and legacy clients keep nullable IDs.
try {
  await pool.query(`
    ALTER TABLE studio_exports ADD COLUMN IF NOT EXISTS request_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS studio_exports_request_id_unique
      ON studio_exports (request_id);
  `);
} finally {
  await pool.end();
}
