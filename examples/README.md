# Kondi Showcase Examples

Four real pipelines, run end-to-end with real models, collectively using
**every Kondi step type**: council, code_planning, analysis, agent, coding,
review, enrich, gate, script, and condition (with loops). Each folder holds:

- `README.md` — the goal, and each step's description + expected output
- `pipeline.json` — the full post-run pipeline (importable: Pipelines → Import)
- `outputs/` — every step's actual output
- `VERIFICATION.md` — an honest per-step assessment of the real run

| Example | Step types exercised | Input source |
|---|---|---|
| 01 · Market Brief | enrich, analysis, council | **file** (the product README) |
| 02 · Code Factory | code_planning, gate, coding, script, condition(loop), review, agent | text spec |
| 03 · Policy Debate | council (4 personas, 2 rounds), condition, agent | text question |
| 04 · Content Refinery | agent(json), analysis ×2 (**parallel**), council, script, condition(loop) | **url** (live fetch) |

Reproduce: `cd mcp-connect-mvp && NVIDIA_API_KEY=... npx tsx ../examples/harness/run-examples.ts`
(Example 02 additionally uses the local `claude` CLI for the coding worker.)
