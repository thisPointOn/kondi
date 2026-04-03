# CrewAI Bridge — Council as a CrewAI Tool

**Goal:** Python CrewAI agents (47k GitHub stars) can invoke Kondi councils as a tool. Bridges the Python/TypeScript gap via subprocess.

## What This Gets You

- Largest multi-agent community (47k stars, 100k+ developers)
- CrewAI users can add council deliberations to their crews
- Council becomes a tool any CrewAI agent can call
- Concept is very similar — CrewAI "crews" are like councils

## The Challenge

CrewAI is Python-only. Kondi councils are TypeScript. The bridge spawns the Kondi CLI as a subprocess and parses JSON output. This is reliable and how many cross-language integrations work.

## Skeleton: CrewAI Custom Tool

```python
# kondi_council_tool.py
"""
Kondi Council Tool for CrewAI
Bridges to the Kondi TypeScript CLI via subprocess.

Install: pip install kondi-council-crewai
Requires: npm install -g kondi-council (or kondi on PATH)
"""

import json
import subprocess
from crewai.tools import BaseTool
from pydantic import BaseModel, Field
from typing import Optional


class CouncilInput(BaseModel):
    task: str = Field(description="The problem or question for the council")
    council_type: str = Field(
        default="analysis",
        description="Council type: analysis, code_planning, coding, council, review"
    )
    working_dir: Optional[str] = Field(
        default=None,
        description="Absolute path to the target project directory"
    )
    config_path: Optional[str] = Field(
        default=None,
        description="Path to a custom council config JSON file"
    )


class KondiCouncilTool(BaseTool):
    name: str = "kondi_council"
    description: str = (
        "Run a multi-LLM council deliberation with manager, consultant, and "
        "worker personas. Use for structured analysis, code review, "
        "implementation planning, or multi-perspective debate. Returns the "
        "council's decision and final output."
    )
    args_schema: type[BaseModel] = CouncilInput

    def _run(self, task: str, council_type: str = "analysis",
             working_dir: str = None, config_path: str = None) -> str:
        cmd = [
            "kondi-council", "council",
            "--task", task,
            "--type", council_type,
            "--json-stdout", "--quiet",
        ]
        if working_dir:
            cmd.extend(["--working-dir", working_dir])
        if config_path:
            cmd.extend(["--config", config_path])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600,
                cwd=working_dir,
            )

            if result.returncode != 0:
                return f"Council failed: {result.stderr}"

            data = json.loads(result.stdout)
            return (
                f"## Council Result ({council_type})\n\n"
                f"**Status:** {data.get('status', 'unknown')}\n"
                f"**Rounds:** {data.get('council', {}).get('rounds', 0)}\n\n"
                f"### Decision\n{data.get('decision', 'No decision')}\n\n"
                f"### Output\n{data.get('output', 'No output')}"
            )
        except subprocess.TimeoutExpired:
            return "Council timed out after 10 minutes"
        except Exception as e:
            return f"Council error: {str(e)}"


# Usage with CrewAI
if __name__ == "__main__":
    from crewai import Agent, Task, Crew

    council_tool = KondiCouncilTool()

    reviewer = Agent(
        role="Senior Code Reviewer",
        goal="Ensure code quality and security",
        backstory="You use multi-model councils for thorough analysis.",
        tools=[council_tool],
    )

    review_task = Task(
        description="Run a council analysis on {project_path} and summarize findings",
        agent=reviewer,
        expected_output="Prioritized list of issues with severity ratings",
    )

    crew = Crew(agents=[reviewer], tasks=[review_task])
    result = crew.kickoff(inputs={"project_path": "/path/to/project"})
    print(result)
```

## Steps to Build and Distribute

### 1. Create the Python package

```bash
cd integrations/crewai-bridge
mkdir kondi_council_crewai
touch kondi_council_crewai/__init__.py
# Copy the tool class into __init__.py
```

### 2. Create pyproject.toml

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "kondi-council-crewai"
version = "0.1.0"
description = "Kondi multi-LLM council deliberation tool for CrewAI"
license = "AGPL-3.0-only"
requires-python = ">=3.10"
dependencies = ["crewai>=0.50.0"]

[project.urls]
Repository = "https://github.com/youruser/kondi"
```

### 3. Test

```bash
pip install -e .
python -c "from kondi_council_crewai import KondiCouncilTool; print('OK')"
```

### 4. Publish to PyPI

```bash
pip install build twine
python -m build
twine upload dist/*
```

### 5. Users install

```bash
pip install kondi-council-crewai
npm install -g kondi-council  # also need the CLI
```

## Resources

- [CrewAI docs](https://docs.crewai.com/)
- [CrewAI custom tools](https://docs.crewai.com/concepts/tools)
- [CrewAI GitHub](https://github.com/crewAIInc/crewAI)
- [PyPI publishing guide](https://packaging.python.org/en/latest/tutorials/packaging-projects/)
