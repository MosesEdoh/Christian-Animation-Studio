---
name: Better Stack ingestion credentials
description: Separate Better Stack account management from the application’s log-ingestion credentials.
---

Use the source-specific ingest token and ingest host for application log delivery. The Better Stack management connection can create sources, labels, dashboards, and alerts, but its OAuth/API access does not authenticate the app’s HTTP log requests.

**Why:** The source and alert rules were created successfully, but an app smoke event was rejected with HTTP 401 when the supplied token was not accepted by that source.

**How to apply:** Keep the source token in Replit Secrets, use the source’s ingest host as non-secret configuration, and verify Better Stack accepts a smoke event before describing alerts as live.
