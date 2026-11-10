# Provider-clip export admission alerts

The API server writes Pino structured logs for the shared provider-clip export pool (`provider-clip-episode`). In production, it forwards only `episode_export.coordination_failure` and `episode_export.capacity_rejected` events to the Better Stack HTTP source **Frame Faith Episode Export API**. The source extracts `event`, `failure`, and `pool` as labels for aggregation. The API also emits coordination grouping metadata as `groupBy: ["event", "failure", "pool"]`.

## Ownership and response

- **Alert owner:** Elizabeth, through the Better Stack team email notification. The on-call acknowledges the alert, investigates using the steps below, and hands off unresolved database or deployment incidents to the database/platform on-call.
- **Coordination alert:** notify the API service owner by team email at the threshold below. Start with the alert's `failure` and `pool`, then check API and database health for the matching time window. Do not include request or owner identifiers in incident notes.
- **Capacity warning:** notify the API service on-call as a warning, not a page. Check concurrent export demand and retry behavior before considering a capacity change; ordinary saturation is expected and responses include `retryAfterSeconds`.
- **Recovery:** confirm new coordination events stop and exports can acquire/release leases normally before resolving the incident.

## Events and response

| Event | Meaning | Response |
| --- | --- | --- |
| `episode_export.capacity_rejected` | The shared pool is full. This is an expected retryable condition, not a coordination failure. | Track sustained volume separately; the response includes `retryAfterSeconds`. |
| `episode_export.coordination_failure` with `failure=admission_database_error` | The server could not check out a shared slot. | Page on repeated events and check database reachability, credentials/configuration, and transaction errors. |
| `episode_export.coordination_failure` with `failure=heartbeat_ownership_lost` | A renewal confirmed that this process no longer owns its lease. | Page on repeated events and inspect lease expiry, pool coordination, and process pauses. |
| `episode_export.coordination_failure` with `failure=heartbeat_database_error` or `heartbeat_deadline_exceeded` | A renewal failed or exceeded the safe ownership deadline. | Page on repeated events and inspect database latency/errors and event-loop or process stalls. |
| `episode_export.coordination_failure` with `failure=release_database_error` | Cleanup could not release the lease; it remains occupied until expiry. | Page on repeated events and inspect database availability and release query failures. |
| `episode_export.http_outcome` | Provider-clip route outcome, including capacity rejection or unavailable admission. | Use to correlate structured admission signals with failed HTTP downloads; do not count it as an additional coordination failure. |

## Alert rules

Better Stack has a dedicated `Episode export alerts` dashboard with two independent 300-second threshold rules:

- **Coordination alert:** count `episode_export.coordination_failure` events grouped by `event`, `failure`, and `pool`; notify the team at **3 events per group in 5 minutes**. The event includes `thresholdCount: 3`, `windowSeconds: 300`, and `groupBy` metadata.
- **Capacity-pressure warning:** count `episode_export.capacity_rejected` events grouped by `event` and `pool`; notify the team as a warning at **10 events per group in 5 minutes**. This is a demand/capacity signal, not a database-coordination alert; inspect concurrent workload before changing pool capacity. The event includes `signalThresholdCount: 10` and `signalWindowSeconds: 300`.
- Do not alert on a single capacity rejection. The provider-clip endpoint intentionally responds with HTTP 503 and `Retry-After` during ordinary global saturation.

Events intentionally omit owner IDs, episode IDs, clip URLs, SQL details, and raw database errors. `episode_export.http_outcome` is for correlation only and must not be counted as an additional coordination failure.

## Delivery and escalation status

The Better Stack source, label extraction, dashboard, and both alert rules are configured. Email notifications target the Better Stack team, whose member Elizabeth is the named owner. The default primary on-call schedule has no assigned users, so these alerts send email and do not phone-page or SMS anyone.

The API reads the source token from the `BETTERSTACK_SOURCE_TOKEN` secret and the public source URL from `BETTERSTACK_INGESTING_HOST`. A harmless smoke event was accepted with HTTP 202, and the source page confirmed that it was visible. The connected SQL query tool still reports that the US West log collection is not found, so use the source page to verify delivery until that query path is available. The application logs a rate-limited local warning if delivery is missing or rejected. Do not use smoke events to test alert thresholds; only real structured admission events match the two rules.
