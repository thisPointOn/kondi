"""
Kondi Council Tool for CrewAI

Bridges Kondi's TypeScript council CLI to Python CrewAI agents.

Usage:
    from kondi_council_crewai import KondiCouncilTool

    tool = KondiCouncilTool()
    agent = Agent(role="Reviewer", tools=[tool])
"""

import json
import shutil
import subprocess
from typing import Optional

from crewai.tools import BaseTool
from pydantic import BaseModel, Field


class CouncilInput(BaseModel):
    task: str = Field(description="The problem or question for the council")
    council_type: str = Field(
        default="analysis",
        description="Council type: analysis, code_planning, coding, council, review",
    )
    working_dir: Optional[str] = Field(
        default=None,
        description="Absolute path to the target project directory",
    )
    config_path: Optional[str] = Field(
        default=None,
        description="Path to a custom council config JSON file",
    )


def _find_kondi() -> str:
    """Find the kondi CLI binary."""
    for cmd in ("kondi-council", "kondi"):
        if shutil.which(cmd):
            return cmd
    raise FileNotFoundError(
        "kondi-council CLI not found. Install with: npm install -g kondi-council"
    )


class KondiCouncilTool(BaseTool):
    name: str = "kondi_council"
    description: str = (
        "Run a multi-LLM council deliberation with manager, consultant, and "
        "worker personas. Use for structured code analysis, implementation "
        "planning, code review, or multi-perspective debate. Returns the "
        "council's decision and final output."
    )
    args_schema: type[BaseModel] = CouncilInput

    def _run(
        self,
        task: str,
        council_type: str = "analysis",
        working_dir: Optional[str] = None,
        config_path: Optional[str] = None,
    ) -> str:
        kondi = _find_kondi()
        cmd = [
            kondi, "council",
            "--task", task,
            "--type", council_type,
            "--json-stdout", "--quiet",
            "--output", "none",
        ]
        if working_dir:
            cmd.extend(["--working-dir", working_dir])
        if config_path:
            cmd.extend(["--config", config_path])

        env = dict(__import__("os").environ)
        env.pop("CLAUDECODE", None)

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600,
                cwd=working_dir,
                env=env,
            )

            if result.returncode != 0:
                return f"Council failed (exit {result.returncode}): {result.stderr}"

            data = json.loads(result.stdout)
            lines = [
                f"## Council Result ({council_type})",
                "",
                f"**Status:** {data.get('status', 'unknown')}",
                f"**Rounds:** {data.get('council', {}).get('rounds', 0)}",
                f"**Tokens:** {data.get('council', {}).get('totalTokensUsed', 0)}",
                "",
                "### Decision",
                data.get("decision") or "_No decision recorded._",
                "",
                "### Output",
                data.get("output") or "_No output recorded._",
            ]
            return "\n".join(lines)

        except subprocess.TimeoutExpired:
            return "Council timed out after 10 minutes"
        except json.JSONDecodeError as e:
            return f"Failed to parse council output: {e}"
        except Exception as e:
            return f"Council error: {e}"
