---
name: run_crew_research
description: >
  Run the local CrewAI research pipeline when a task needs deep web research,
  a structured competitor audit, or multi-angle document synthesis.
---

# run_crew_research

Use this skill when the ticket asks for deep web research, a structured competitor audit, or a synthesis that has to hold more than one angle at the same time. Do not use it for a one-file code edit, a status check, or a question the current workspace already answers.

## Command

Run this from the repository root. The bridge exports `HERMES_CREW_ROOT` and puts that root on `PYTHONPATH`.

```bash
./crews/.venv/bin/python -m crews.research_crew --topic "$ARG"
```

If the current directory is not the repository root:

```bash
"$HERMES_CREW_ROOT/crews/.venv/bin/python" -m crews.research_crew --topic "$ARG"
```

`$ARG` is the research topic or the audit question, not the whole ticket transcript. Quote it. Do not interpolate it into a shell command you build with `eval`.

Add `--format json` only when the caller asked for a machine-readable object. The default stdout is markdown. Progress from the crew goes to stderr and is not part of the report.

## Before you run it

1. Confirm `crews/.venv/bin/python` exists. If it does not, stop and say `crews/setup_env.sh` has not been run. Do not install packages into the Paperclip Node tree.
2. `SERPER_API_KEY` enables web search. When it is unset, the report is model knowledge and the Sources section must say that. Do not invent URLs to fill the gap.
3. `CREWAI_MODEL` or `OPENAI_MODEL` selects the crew model. Leave both unset to use CrewAI's default model for the environment.

## How to use the result

1. Read stdout as the whole report. Ignore stderr except when the process exits non-zero.
2. Save stdout into the task workspace as `research/<topic-slug>.md`. Create `research/` if it is missing. Use a short slug made from the topic.
3. In the final reply, include the report's Summary and the workspace path. Leave the full memo in the file.
4. A non-zero exit is a failed research run. Return the stderr message and do not treat partial stdout as a finished audit.
5. Do not post the Paperclip comment or change ticket status yourself. The Hermes bridge records the artifact and the resolution comment after the process exits.
