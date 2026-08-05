# 06 · Script step
agent → script (echo "SCRIPT_SAW=$KONDI_INPUT") → agent.
Verifies: previous output arrives via $KONDI_INPUT, script stdout chains to the next step.
