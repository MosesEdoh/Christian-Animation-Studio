import express from "express";
import { mock } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool, studioExportsTable } from "@workspace/db";
import { movieDb } from "../../src/lib/movieRenderer";
import movieRoutes from "../../src/routes/movieExports";

// Only the parent-created test schema is accessible to this connection.
const [schema, gateInserts] = process.argv.slice(2);
if (!/^movie_idempotency_[a-f0-9]{32}$/.test(schema ?? "")) {
  throw new Error("An isolated movie-idempotency schema is required");
}
const client = await pool.connect();
await client.query(`SET search_path TO "${schema}"`);
const isolatedDb = drizzle(client);
mock.method(db, "select", isolatedDb.select.bind(isolatedDb));
let releaseInsert: () => void;
const insertGate = new Promise<void>(resolve => { releaseInsert = resolve; });
process.on("message", message => {
  if ((message as { command?: string }).command === "release-inserts") releaseInsert();
});
// Pause immediately before executing real INSERTs so both processes have
// completed their replay lookups. No in-memory lock can arbitrate this race.
mock.method(db, "insert", (table: typeof studioExportsTable) => ({
  values(values: typeof studioExportsTable.$inferInsert) {
    return {
      onConflictDoNothing(config: { target: typeof studioExportsTable.requestId }) {
        return {
          async returning() {
            if (gateInserts === "gated") {
              process.send!({ kind: "insert-ready" });
              await insertGate;
            }
            return isolatedDb.insert(table).values(values).onConflictDoNothing(config).returning();
          },
        };
      },
    };
  },
}));
// Test admission and persistence only; never render, use storage, or change
// resource limits. The independent route connections above remain real.
mock.method(movieDb, "update", () => ({ set: () => ({ where: async () => [] }) }));
mock.method(movieDb, "select", () => ({ from: () => ({
  where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
}) }));

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers["x-test-withhold-response"] === "true") {
    res.json = body => {
      // The real route has committed its INSERT and constructed its 202 body,
      // but no headers/body have been delivered. Parent kills this process.
      process.send!({ kind: "accepted-without-delivery", job: body, headersSent: res.headersSent });
      return res;
    };
  }
  next();
});
app.use("/api", movieRoutes);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const { rows: [connection] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
process.send!({
  kind: "ready",
  pid: process.pid,
  backendPid: connection.pid,
  origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
});
