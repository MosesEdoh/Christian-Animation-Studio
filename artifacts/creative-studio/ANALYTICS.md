# Movie export analytics

## Collector lifecycle

This website uses **Replit-hosted analytics**, not an app-managed Umami install.
Analytics access was checked and returned `authorized` before instrumentation.
The authoritative setup contract is `.local/skills/project-analytics/SKILL.md`:
Replit's publishing proxy injects the tracker into published website HTML when
analytics is enabled in Publishing settings. Enabling analytics on an already
published site requires a subsequent publish for that injection to take effect.

Do not add a tracker script, website ID, collector URL, or analytics environment
variables to the app. Missing `window.umami` in the development preview is
expected, not a missing application dependency. The wrapper safely ignores
missing trackers, synchronous exceptions, and rejected tracker promises.

The current task changes code only; it does not publish or verify live collection.
Tests supply a fake tracker to verify the application-side event contract.

## Event contract

| Event | Meaning | Dimensions |
| --- | --- | --- |
| `movie_preflight_outcome` | A displayed estimate changes or a fresh pre-queue check completes/fails | `source`: estimate/queue; `target`: series/episode; `aspect_ratio`: 16:9/9:16; `outcome`: passed/blocked/unavailable; queue checks also include `request_mode` |
| `movie_episode_selected` | Creator switches from the series option to an episode | `preceding_series_preflight`: passed/blocked/unavailable/unchecked |
| `movie_queue_succeeded` | One creation request is acknowledged successfully by the API | `target`, `aspect_ratio`, `quality`: 720p/1080p, `request_mode`, `preceding_series_preflight` |

`request_mode` is single, all_formats, retry, or missing_formats.
Queue success is **not** render completion; a partial four-format batch records
only acknowledged requests. Displayed estimates suppress consecutive identical
outcomes for the same selection and orientation, including polling refreshes.
Pre-queue checks are separate from displayed estimates, since saved work can change.

Series outcome attribution is local to the mounted movie-export component. It
uses the latest observed series outcome, including fresh pre-queue failures, and
does not persist across navigation or reload. It measures association, not proof
that a warning caused the choice. No custom correlation or identity is sent.

Payloads contain only the fixed categorical values above. Never include scripts,
titles, reference paths, episode/job IDs, identities, media URLs, or raw errors.
