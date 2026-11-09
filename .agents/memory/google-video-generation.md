---
name: Google video generation
description: Supported Google video-generation API choice and important regional reference-image limits.
---

Google Flow is a creator-facing web app, not a documented third-party generation API. For application integration, Google's supported API is Gemini Omni Flash via the Gemini Interactions API. Current documentation describes clips from 3 to 15 seconds and up to six reference images. It also says image uploads containing minors are not supported in the EEA, Switzerland, or the UK.

**Why:** The studio serves families and children worldwide, and its owner is in the EEA. A provider choice must account for both API support and child-image restrictions.

**How to apply:** Integrate through the official Gemini API rather than automating the Flow website. Design reference handling so real images of minors are not sent to Gemini Omni from restricted regions; check current official documentation before changing providers or regional behavior.
