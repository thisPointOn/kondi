# 03 · JSON output + field templating
Step 1 emits prose-wrapped fenced JSON with outputType json → stored artifact must be CLEAN JSON → step 2's template FRUIT={{input.fruit}};N={{input.stats.n}} must render the values.
Verifies: extractJsonBlock at store time, dot-path templating.
