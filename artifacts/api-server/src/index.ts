import app from "./app";
import { logger } from "./lib/logger";
import { wakeMovieWorker, stopMovieWorker } from "./lib/movieRenderer";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void wakeMovieWorker();
  setInterval(() => { void wakeMovieWorker(); }, 10_000).unref();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(1), 15_000);
    timeout.unref();
    void stopMovieWorker().finally(() => server.close(() => { clearTimeout(timeout); process.exit(0); }));
  });
}
