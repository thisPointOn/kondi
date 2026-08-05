# 02 · Parallel fan-out / join
One parallel layer (two scripted steps) → a join step reading {{input}} (must see BOTH) → a step reading {{input[0]}} (must see only the first).
Verifies: stage barrier, all-outputs join, indexed input selection. Fully scripted (deterministic).
