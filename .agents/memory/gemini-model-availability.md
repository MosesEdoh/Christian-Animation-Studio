---
name: Gemini model availability
description: Provider behavior encountered while wiring direct Gemini text generation.
---

Newly issued Gemini API keys can reject older model IDs with a 404 and recommend a newer flash model. Keep the model name configurable through an environment variable instead of hardcoding an aging model.

**Why:** The first direct request using an older flash model was rejected even though the key was valid; the API response explicitly recommended a newer model.

**How to apply:** When adding Gemini-backed features, use the configured model and preserve a simple environment override so provider availability can change without a code rewrite.