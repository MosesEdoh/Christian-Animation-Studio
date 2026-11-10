import { pool } from "./index";

// Additive, repeatable migration. Apply before starting API versions that read
// request_id; existing movie history and legacy clients keep nullable IDs.
try {
  await pool.query(`
    BEGIN;
    ALTER TABLE studio_exports ADD COLUMN IF NOT EXISTS request_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS studio_exports_request_id_unique
      ON studio_exports (request_id);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'studio_exports'::regclass
          AND conname = 'studio_exports_request_id_unique'
      ) THEN
        ALTER TABLE studio_exports
          ADD CONSTRAINT studio_exports_request_id_unique
          UNIQUE USING INDEX studio_exports_request_id_unique;
      END IF;
    END $$;
    COMMIT;
  `);
} finally {
  await pool.end();
}
