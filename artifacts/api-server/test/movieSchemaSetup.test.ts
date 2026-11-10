import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, studioExportsTable } from "@workspace/db";

const exec = promisify(execFile);

test("development movie migrations preserve history and restore the worker query", async () => {
  const client = await pool.connect();
  const schema = `movie_schema_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE studio_exports (
        id serial PRIMARY KEY, episode_id integer,
        aspect_ratio text NOT NULL, quality text NOT NULL,
        status text NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
        object_path text, error text, started_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO studio_exports (aspect_ratio, quality, status, object_path)
        VALUES ('16:9', '720p', 'ready', '/objects/legacy'),
               ('9:16', '1080p', 'queued', NULL);
    `);
    const before = (await client.query("SELECT * FROM studio_exports ORDER BY id")).rows;
    // Child processes execute the actual setup entrypoints against only this
    // temporary schema, never the application's saved exports.
    const connection = new URL(process.env.DATABASE_URL!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const migrate = async () => {
      for (const name of ["request-id", "size-bytes"]) {
        await exec(process.execPath, ["--import", "tsx", `../../lib/db/src/migrate-movie-${name}.ts`], {
          env: { ...process.env, DATABASE_URL: connection.toString() },
          timeout: 15_000,
        });
      }
    };
    await migrate();
    await migrate();
    const after = (await client.query("SELECT * FROM studio_exports ORDER BY id")).rows;
    assert.deepEqual(after, before.map(row => ({ ...row, request_id: null, size_bytes: null })));
    const isolatedDb = drizzle(client);
    // Match movieRenderer's queued-candidate read, including every schema column.
    const candidates = await isolatedDb.select().from(studioExportsTable)
      .where(eq(studioExportsTable.status, "queued")).orderBy(asc(studioExportsTable.id)).limit(1);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sizeBytes, null);
    const column = await client.query(`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'studio_exports' AND column_name = 'size_bytes'
    `, [schema]);
    assert.deepEqual(column.rows, [{ data_type: "bigint", is_nullable: "YES", column_default: null }]);
    // Reproduce the earlier migration's standalone-index state and upgrade it
    // without changing existing IDs or discarding its uniqueness protection.
    await client.query(`
      ALTER TABLE studio_exports DROP CONSTRAINT studio_exports_request_id_unique;
      CREATE UNIQUE INDEX studio_exports_request_id_unique ON studio_exports (request_id);
      UPDATE studio_exports SET request_id = 'existing-request' WHERE id = 1;
    `);
    await migrate();
    const constraints = await client.query(`
      SELECT conname FROM pg_constraint WHERE conrelid = 'studio_exports'::regclass AND contype = 'u'
    `);
    assert.deepEqual(constraints.rows, [{ conname: "studio_exports_request_id_unique" }]);
    await assert.rejects(client.query("UPDATE studio_exports SET request_id = 'existing-request' WHERE id = 2"),
      (error: { code?: string }) => error.code === "23505");
    assert.equal((await client.query("SELECT count(*)::int AS total FROM studio_exports")).rows[0].total, 2);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});
