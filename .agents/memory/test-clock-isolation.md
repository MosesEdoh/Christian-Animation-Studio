---
name: Test clock isolation
description: Avoid leaking controlled clocks between Node test cases.
---

Use one mock tracker for timer globals, including cancellation, and advance the monotonic clock with the timeout scheduler.

**Why:** Combining Node's test-context mock timers with process-wide method wrappers caused subsequent export cancellation tests to hang even though the controlled-clock test passed alone. Restoring wrappers and resetting timers separately did not reliably restore normal timers under the existing hooks.

**How to apply:** For export regressions that already use process-wide method mocks, prefer a local deterministic scheduler restored by the same tracker. Flush asynchronous renewal continuations between timer firings and run the surrounding suite to check isolation, not just the new test alone.

For process-crash recovery regressions, keep clock and timer interception inside disposable child workers, and give every worker the same private temporary root before importing application modules.

**Why:** Advancing recovery time against the normal operating-system temporary directory could reclaim unrelated abandoned renders. Child isolation also prevents controlled timers from leaking into the parent test runner.

**How to apply:** Never exercise application startup recovery with a simulated future clock unless its default temporary storage root has already been isolated. Replace unrelated external services rather than introducing production-only test switches.
