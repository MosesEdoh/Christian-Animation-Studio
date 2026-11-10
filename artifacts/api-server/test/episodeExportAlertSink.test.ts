import assert from "node:assert/strict";
import { test } from "node:test";
import { createEpisodeExportAlertSink } from "../src/lib/episodeExportAlertSink";

test("forwards only admission signals as structured JSON to the Better Stack source", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const sink = createEpisodeExportAlertSink({
    enabled: true,
    sourceToken: "test-source-token",
    ingestingUrl: "https://s123.us-west-2a.betterstackdata.com",
    post: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 202 };
    },
  });

  await sink({
    event: "episode_export.coordination_failure",
    failure: "heartbeat_database_error",
    pool: "provider-clip-episode",
    thresholdCount: 3,
    windowSeconds: 300,
    groupBy: ["event", "failure", "pool"],
  }, "Episode export heartbeat database operation failed");

  assert.equal(request?.url, "https://s123.us-west-2a.betterstackdata.com/");
  assert.equal(request?.init.method, "POST");
  assert.equal((request?.init.headers as Record<string, string>).authorization, "Bearer test-source-token");
  assert.deepEqual(JSON.parse(String(request?.init.body)), {
    event: "episode_export.coordination_failure",
    failure: "heartbeat_database_error",
    pool: "provider-clip-episode",
    thresholdCount: 3,
    windowSeconds: 300,
    groupBy: ["event", "failure", "pool"],
    service: "frame-faith-api-server",
    message: "Episode export heartbeat database operation failed",
  });
});

test("accepts Better Stack's bare ingesting host as HTTPS", async () => {
  let requestUrl = "";
  const sink = createEpisodeExportAlertSink({
    enabled: true,
    sourceToken: "test-source-token",
    ingestingUrl: "s123.us-west-2a.betterstackdata.com",
    post: async url => {
      requestUrl = url;
      return { ok: true, status: 202 };
    },
  });

  await sink({ event: "episode_export.capacity_rejected" }, "capacity");
  assert.equal(requestUrl, "https://s123.us-west-2a.betterstackdata.com/");
});

test("does not forward unrelated route outcomes or development logs", async () => {
  let sends = 0;
  const sink = createEpisodeExportAlertSink({
    enabled: false,
    sourceToken: "test-source-token",
    ingestingUrl: "https://s123.us-west-2a.betterstackdata.com",
    post: async () => {
      sends++;
      return { ok: true, status: 202 };
    },
  });

  await sink({ event: "episode_export.http_outcome", outcome: "capacity_rejected" }, "route outcome");
  await sink({ event: "episode_export.capacity_rejected" }, "development event");
  assert.equal(sends, 0);
});

test("reports missing config, invalid destinations, and HTTP failures without throwing", async () => {
  const failures: string[] = [];
  const missing = createEpisodeExportAlertSink({
    enabled: true,
    onDeliveryFailure: reason => failures.push(reason),
  });
  const invalid = createEpisodeExportAlertSink({
    enabled: true,
    sourceToken: "test-source-token",
    ingestingUrl: "http://127.0.0.1",
    onDeliveryFailure: reason => failures.push(reason),
  });
  const rejected = createEpisodeExportAlertSink({
    enabled: true,
    sourceToken: "test-source-token",
    ingestingUrl: "https://s123.us-west-2a.betterstackdata.com",
    post: async () => ({ ok: false, status: 403 }),
    onDeliveryFailure: reason => failures.push(reason),
  });

  await missing({ event: "episode_export.capacity_rejected" }, "capacity");
  await invalid({ event: "episode_export.capacity_rejected" }, "capacity");
  await rejected({ event: "episode_export.capacity_rejected" }, "capacity");
  assert.deepEqual(failures, ["missing_configuration", "invalid_destination", "http_403"]);
});
