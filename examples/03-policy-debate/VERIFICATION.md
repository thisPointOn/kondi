# Verification — 03 · Policy Debate

Run: real models (nemotron-super ×3 personas, nemotron-nano skeptic/summarizer),
2 deliberation rounds, all 3 steps completed. Verified by reading every output.

| Step | Verdict | Evidence |
|---|---|---|
| Council deliberation | **PASS — strong** | A complete, actionable pilot design: 10-week limited-team trial, six measurable acceptance criteria (velocity ±5%, defect leakage ±5%, eNPS +5, overtime ≤2%, SLA ≥95%, ≤10% Friday work), named data sources (Jira/HRIS/survey), rollback rule. The Advocate/Skeptic tension visibly shaped the conditions. Contains the required RECOMMENDATION marker. |
| Verdict guard | **PASS** | Condition matched RECOMMENDATION and passed the deliberation through unchanged (pass-through verified — the summary step received the real verdict, not condition bookkeeping). |
| Executive summary | **PASS** | Faithful compression: verdict, all-criteria condition, SLA risk, well-being metric with ±5% guardrails, 90-day review. Exactly the 5 required bullets. |

Notes: an earlier run of this example exposed a real executor bug (condition
steps replaced the data flow with "Condition evaluated: TRUE" — fixed so
conditions/gates pass data through). This run validates the fix end-to-end.
