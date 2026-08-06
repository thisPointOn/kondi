# 04 · Content Refinery

**Goal:** live web data → structured JSON → parallel expert lenses → synthesized
explainer → mechanically-enforced length. Shows url input, JSON field
templating, parallel stages, and a script-driven quality loop.

**Input:** `url` source — the Wikipedia summary API for the Delphi method,
fetched at run start.

| # | Step | Type | What it does | Expected output |
|---|---|---|---|---|
| 1 | Fact extraction | agent | Extracts strict JSON (topic, definition, origin, key_steps[], criticisms[]) — downstream steps address fields via `{{input.field}}` | Valid JSON |
| 2a | Practitioner lens | analysis (parallel) | When should a team actually use this method? Fed only the relevant JSON fields | Use/avoid guidance grounded in the facts |
| 2b | Historian lens | analysis (parallel) | Origin and evolution — fed different JSON fields | Essential historical context |
| 3 | Explainer synthesis | council | Editor + writer merge BOTH lenses | 350–450 word plain-language explainer |
| 4 | Length check | script | `wc -w` on the explainer — the word count is measured, not asserted | `LENGTH OK (N words)` |
| 5 | Length gate | condition | Loops back to synthesis with the measured count as feedback (≤2 tries) | continue |
