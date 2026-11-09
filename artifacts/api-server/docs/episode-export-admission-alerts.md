# Provider-clip export admission alerts

The API server writes Pino structured logs for the shared provider-clip export pool (`provider-clip-episode`). Production log aggregation should parse the JSON fields and group by `event`, `failure`, and `pool`.

## Events and response

| Event | Meaning | Response |
| --- | --- | --- |
| `episode_export.capacity_rejected` | The shared pool is full. This is an expected retryable condition, not a coordination failure. | Track sustained volume separately; the response includes `retryAfterSeconds`. |
| `episode_export.coordination_failure` with `failure=admission_database_error` | The server could not check out a shared slot. | Page on repeated events and check database reachability, credentials/configuration, and transaction errors. |
| `episode_export.coordination_failure` with `failure=heartbeat_ownership_lost` | A renewal confirmed that this process no longer owns its lease. | Page on repeated events and inspect lease expiry, pool coordination, and process pauses. |
| `episode_export.coordination_failure` with `failure=heartbeat_database_error` or `heartbeat_deadline_exceeded` | A renewal failed or exceeded the safe ownership deadline. | Page on repeated events and inspect database latency/errors and event-loop or process stalls. |
| `episode_export.coordination_failure` with `failure=release_database_error` | Cleanup could not release the lease; it remains occupied until expiry. | Page on repeated events and inspect database availability and release query failures. |
| `episode_export.http_outcome` | Provider-clip route outcome, including capacity rejection or unavailable admission. | Use to correlate structured admission signals with failed HTTP downloads; do not count it as an additional coordination failure. |

## Suggested thresholds

- **Coordination alert:** trigger when at least **3 `episode_export.coordination_failure` events with the same `failure` and `pool` occur in a rolling **5 minutes**. The event includes `thresholdCount: 3` and `windowSeconds: 300` for alert-rule configuration.
- **Capacity-pressure warning:** trigger when at least **10 `episode_export.capacity_rejected` events for the pool occur in a rolling **5 minutes**. This is a demand/capacity signal, not a database-coordination alert; inspect concurrent workload before changing pool capacity.
- Do not alert on a single capacity rejection. The provider-clip endpoint intentionally responds with HTTP 503 and `Retry-After` during ordinary global saturation.

Events intentionally omit owner IDs, episode IDs, clip URLs, SQL details, and raw database errors. Alert thresholds are emitted as structured metadata and documented here; connect these rules to the deployment's log aggregation/alerting service.
