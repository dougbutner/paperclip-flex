"""Researcher plus synthesis writer.

Run from the repository root:

    ./crews/.venv/bin/python -m crews.research_crew --topic "TOPIC"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the research crew and print the report.")
    parser.add_argument("--topic", required=True, help="Research topic, competitor, or document question")
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Stdout shape. Logs stay on stderr.",
    )
    return parser.parse_args(argv)


def prepare_local_storage() -> None:
    storage = Path(__file__).resolve().parent / ".crewai"
    storage.mkdir(exist_ok=True)
    os.environ.setdefault("CREWAI_STORAGE_DIR", str(storage))
    os.environ.setdefault("CREWAI_TELEMETRY_OPT_OUT", "true")
    os.environ.setdefault("OTEL_SDK_DISABLED", "true")


def load_tools() -> list:
    if not os.environ.get("SERPER_API_KEY"):
        print("SERPER_API_KEY is unset; the researcher will not call web search.", file=sys.stderr)
        return []
    from crewai_tools import SerperDevTool

    return [SerperDevTool()]


def build_crew(topic: str):
    from crewai import Agent, Crew, Process, Task

    tools = load_tools()
    llm = os.environ.get("CREWAI_MODEL") or os.environ.get("OPENAI_MODEL") or ""
    shared = {"verbose": False, "allow_delegation": False}
    if llm:
        shared["llm"] = llm
    researcher = Agent(
        role="Researcher",
        goal=f"Gather distinct, sourced angles on: {topic}",
        backstory=(
            "You collect competing explanations and name the limit of each source. "
            "You do not invent URLs. Without a search tool, you label claims as model knowledge."
        ),
        tools=tools,
        **shared,
    )
    writer = Agent(
        role="Synthesis Writer",
        goal="Turn the research notes into a short decision memo",
        backstory="You keep disagreements visible and separate evidence from recommendation.",
        **{**shared},
    )
    research = Task(
        description=(
            "Research this topic from at least three angles: {topic}. "
            "Cover what is known, what the main alternatives claim, and what is still uncertain. "
            "If web search is unavailable, say so in the notes."
        ),
        expected_output="Bullet research notes with a source label on every claim.",
        agent=researcher,
    )
    synthesis = Task(
        description=(
            "Write a markdown memo on {topic} from the research notes. "
            "Use these sections: Summary, Findings, Disagreements, Sources, Open questions. "
            "Do not add a source you cannot name."
        ),
        expected_output="A markdown memo with the five required sections.",
        agent=writer,
        context=[research],
    )
    return Crew(
        agents=[researcher, writer],
        tasks=[research, synthesis],
        process=Process.sequential,
        verbose=False,
    )


def result_text(result: object) -> str:
    raw = getattr(result, "raw", None)
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return str(result).strip()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    topic = args.topic.strip()
    if not topic:
        print("--topic must not be empty", file=sys.stderr)
        return 2
    try:
        import crewai  # noqa: F401
    except ImportError:
        print(
            "crewai is not installed. Run crews/setup_env.sh, then call "
            "./crews/.venv/bin/python -m crews.research_crew",
            file=sys.stderr,
        )
        return 2

    prepare_local_storage()
    crew = build_crew(topic)
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = crew.kickoff(inputs={"topic": topic})
    finally:
        sys.stdout = real_stdout

    report = result_text(result)
    if args.format == "json":
        json.dump({"topic": topic, "format": "markdown", "report": report}, real_stdout)
        real_stdout.write("\n")
    else:
        real_stdout.write(report)
        if not report.endswith("\n"):
            real_stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
