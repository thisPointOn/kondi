# 05 · Loop with feedback
work → condition (STATUS: PASS / else loop back, maxLoops 3). Scripted worker FAILs once then PASSes.
Verifies: loop fires once, retry input contains 'THIS IS A RETRY' + the judge feedback, run completes.
Second pipeline always FAILs with maxLoops 2 + onLoopExhausted fail → run must reject, worker ran 3×, pipeline failed.
