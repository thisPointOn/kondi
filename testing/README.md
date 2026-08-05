# Kondi Pipeline E2E Tests

End-to-end tests of every pipeline feature, run against the REAL
`PipelineExecutor` with the real stores and the Node platform adapter
(real filesystem). LLM steps use NVIDIA NIM's `nemotron-3-nano`
(free-credit) for genuine model calls; personas whose **name starts with
`SCRIPTED:`** are answered by the harness with canned text instead, so
control-flow tests (loops, conditions, failures) are deterministic.

Run everything:

    cd mcp-connect-mvp && NVIDIA_API_KEY=... npx tsx ../testing/harness/run-all.ts

Each numbered folder is one test: its `README.md` describes the pipeline
shape and what's being verified; `result.json` is written by the run
(pass/fail per assertion + captured step artifacts); step output files
land in the folder too (it doubles as the pipeline working directory).

| Test | Covers |
|------|--------|
| 01-linear-chain | text input+instructions → analysis (decision artifact) → agent; output chaining |
| 02-parallel-join | parallel stage barrier; {{input}} join + {{input[N]}} indexed access |
| 03-json-fields | outputType json; {{input.field}} dot-paths; fenced-JSON recovery |
| 04-condition-branch | condition true→continue, false→stop; skip_next_stage |
| 05-loop-feedback | judge→condition loop_to_stage; feedback rides the back-edge; maxLoops; onLoopExhausted fail |
| 06-script-step | script step, $KONDI_INPUT env, output chaining |
| 07-input-sources | file/directory/url input sources + instructions reach the first step |
| 08-gate | gate approve → continues; gate reject → stops |
| 09-failure-policy | step error under stop vs skip_step |
| 10-resume | completed steps are skipped on re-run (rerun-forward priming) |
| 11-worker-file-output | worker output written to the working dir; {{file}} template resolves |
| 12-full-council | manager+worker council step end-to-end (deliberation engine via pipeline) |

Not covered here (manual/expensive): coding orchestrator with CLI agents,
scheduler/memory across runs, MCP tool use inside steps.
