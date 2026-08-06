# Verification — 04 · Content Refinery

Run: live fetch of the Wikipedia summary API at run start; all 6 steps
completed; the length gate FIRED once in an earlier iteration (explainer out of
range → measured word count fed back → rewrite → pass), demonstrating the
loop-with-feedback mechanism in production.

| Step | Verdict | Evidence |
|---|---|---|
| Fact extraction | **PASS** | Strict, valid JSON. Content factually correct beyond the fetched summary (RAND Corporation, 1950s, Helmer/Dalkey/Rescher; accurate step sequence). |
| Practitioner lens (parallel) | **PASS** | Analysis demonstrably grounded in the extracted fields — the definition text flows through `{{input.definition}}` into the reasoning. |
| Historian lens (parallel) | **PASS** | Origin/evolution context consistent with the extracted origin field. |
| Explainer synthesis | **PASS** | Coherent plain-language explainer weaving both lenses; history + when-to-use guidance integrated. Minor blemish: the worker's process footer ("COMPLETION SUMMARY") rides along in the artifact. |
| Length check | **PASS** | `wc -w` → "LENGTH OK (446 words)" — measured, not asserted. |
| Length gate | **PASS** | Continue on OK; verified loop-back with word-count feedback in an earlier iteration. |

## Bugs this example surfaced during development (since fixed)
1. Tool definitions offered to tool-less API models → the extractor emitted a
   fake `fetch` tool call as its output.
2. A suppressed worker's custom systemPrompt is silently replaced by the
   minimal worker prompt — the JSON contract never reached the model until the
   persona was unsuppressed and the contract duplicated into the task.
3. Raw article HTML would overflow context; the example uses the compact
   summary API — a practical pattern for url inputs.
