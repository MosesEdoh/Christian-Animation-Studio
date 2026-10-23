---
name: Gemini model availability
description: Provider behavior encountered while wiring direct Gemini text generation.
---

Newly issued Gemini API keys can reject older model IDs with a 404 and recommend a newer flash model. Keep the model name configurable through an environment variable instead of hardcoding an aging model.

Free-tier Gemini requests can also hit a strict per-minute quota. A burst of parallel requests may return 429 even when the key and model are valid. For multi-part generation, pace or serialize requests and validate the complete result before writing it.

**Why:** The older model ID was rejected despite a valid key, and a later concurrent batch hit the provider's request-per-minute limit. Both failures were provider constraints, not credential errors.

**How to apply:** Keep the model configurable; use paced requests for free-tier batches, and avoid partial database writes when model output is incomplete or malformed.