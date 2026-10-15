# Hermes and CrewAI sidecar

This fork runs Hermes Agent and a CrewAI research pipeline beside Paperclip. The new files live in `integrations/hermes-bridge/`, `crews/`, and `skills/hermes-crew/`. Paperclip starts the bridge as a process agent. The bridge calls the public issue API. No Paperclip TypeScript, schema, or UI file is part of this setup.

The only pre-existing file this setup changes is `.gitignore`. The change is an appended block at the end of the file.

## 1. Install the crew environment

From the repository root:

```sh
bash crews/setup_env.sh
```

That creates `crews/.venv` and installs the pinned `crewai` and `crewai-tools` versions from `crews/requirements.txt`. Paperclip's `node_modules` is untouched.

Smoke the crew after you export a model key:

```sh
export OPENAI_API_KEY="..."
# optional: export SERPER_API_KEY="..."
# optional: export CREWAI_MODEL="openai/gpt-4.1-mini"
./crews/.venv/bin/python -m crews.research_crew --topic "two open-source issue trackers"
```

Stdout is the markdown memo. Add `--format json` for `{"topic","format","report"}`.

## 2. Point Hermes at the skill

Hermes loads skills from `~/.hermes/skills`. Link the repo skill once:

```sh
mkdir -p ~/.hermes/skills
ln -sfn "$PWD/skills/hermes-crew" ~/.hermes/skills/run_crew_research
```

The skill name is `run_crew_research`. Its instructions tell Hermes to run:

```sh
./crews/.venv/bin/python -m crews.research_crew --topic "$ARG"
```

Install Hermes itself with the upstream Hermes installer (`pip install hermes-agent` or the current Nous Research install). Confirm the one-shot works:

```sh
hermes chat -q "Reply with the single word pong" -Q --yolo --source tool
```

## 3. Register the worker in Paperclip

Paperclip does not watch a repository-root `.paperclip.yaml` for live agent config. `.paperclip.yaml` is the company-package sidecar written by company export and read by company import. Register the live agent in the board UI, or with a board API key. An agent API key cannot set a process command.

In the UI, create an agent with adapter type `process`:

- Command: `bash`
- Args: `["/absolute/path/to/paperclip-flex/integrations/hermes-bridge/run-task.sh"]`
- Working directory: `/absolute/path/to/paperclip-flex`
- Timeout seconds: `1800`
- Grace seconds: `15`

The same fields as JSON for `POST /api/companies/<company-id>/agents` with a board bearer token:

```json
{
  "name": "Hermes Researcher",
  "role": "researcher",
  "adapterType": "process",
  "budgetMonthlyCents": 5000,
  "adapterConfig": {
    "command": "bash",
    "args": ["/absolute/path/to/paperclip-flex/integrations/hermes-bridge/run-task.sh"],
    "cwd": "/absolute/path/to/paperclip-flex",
    "timeoutSec": 1800,
    "graceSec": 15,
    "env": {
      "HERMES_CLI_STYLE": "chat",
      "HERMES_CREW_ROOT": "/absolute/path/to/paperclip-flex"
    }
  },
  "runtimeConfig": {
    "heartbeat": { "enabled": false, "wakeOnDemand": true }
  }
}
```

`role` has to be one of the instance's allowed agent roles. `researcher` is the intended role when that value is allowed; otherwise use `general`.

Assign a ticket to this agent. Paperclip heartbeats the process, injects `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_RUN_ID`, and the bridge:

1. Reads `PAPERCLIP_TASK_ID` when it is set.
2. Otherwise takes the assigned `in_progress` ticket, then `todo`.
3. Checks the ticket out.
4. Spawns Hermes in the workspace.
5. Uploads the markdown artifact, posts a resolution comment, and sets the ticket to `in_review`.

A failed Hermes exit sets the ticket to `blocked` and still posts the comment.

### Hermes command styles

`HERMES_CLI_STYLE=chat` is the default because current Hermes Agent exposes the one-shot as `hermes chat -q`. The bridge adds `-Q`, `--yolo`, and `--source tool`. Token and budget caps are exported as `HERMES_TOKEN_CAP`, `HERMES_BUDGET_CENTS`, and `HERMES_BUDGET_USD`. Set `HERMES_MAX_TURNS` to pass `--max-turns`. Set `HERMES_PASS_RUN_BUDGET=1` to also pass `--run-budget` in USD. Leave that off unless your Hermes build accepts the flag. The gateway-backed `hermes chat` refuses `--run-budget`.

`HERMES_CLI_STYLE=run-task` uses the literal sidecar contract:

```text
hermes run --task "<task>" --max-tokens <token cap> --budget <cents>
```

Use that style only when the `hermes` binary on `PATH` implements `run --task`. The stock Nous Research CLI does not.

You can also invoke the bridge by hand:

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_API_KEY="$PAPERCLIP_API_KEY" \
PAPERCLIP_AGENT_ID="$PAPERCLIP_AGENT_ID" \
PAPERCLIP_COMPANY_ID="$PAPERCLIP_COMPANY_ID" \
PAPERCLIP_RUN_ID="$PAPERCLIP_RUN_ID" \
PAPERCLIP_TASK_ID="$PAPERCLIP_TASK_ID" \
bash integrations/hermes-bridge/run-task.sh
```

`--dry-run` prints the argv and does not spawn Hermes or call the API. Pass a local title so it has a prompt to shape:

```sh
bash integrations/hermes-bridge/run-task.sh --dry-run --title "Ping" --description "Reply with pong"
```

`--payload-file ticket.json` runs from a local ticket object with `id`, `title`, `description`, `tokenCap`, and `budgetCents`.

Logs and artifacts stay in `integrations/hermes-bridge/logs/` and `integrations/hermes-bridge/out/`. Those directories are gitignored.

### Company package sidecar

If you export a company and want the process agent to travel with the package, the agent entry's `.paperclip.yaml` carries `adapterType: process` and the `adapterConfig` object above. Import that package through Paperclip's company import. Do not add a second runner config under Paperclip's `server/` or `ui/` trees.

Upstream Paperclip also ships a built-in `hermes_local` adapter. This sidecar is the path that stays outside that package and adds the CrewAI pipeline. You can hire a `hermes_local` agent from the UI without using this bridge. Hiring that adapter still does not require a source edit.

## 4. Pull upstream without a merge commit

Add the upstream remote once:

```sh
git remote add upstream https://github.com/paperclipai/paperclip.git
```

Skip that command if `upstream` already exists. Update this branch with a rebase:

```sh
git status
git fetch upstream
git rebase upstream/main
```

Commit or stash local work before the rebase. `git status` should be clean, or you should know which files are stashed.

New sidecar paths do not overlap upstream history, so they rebase as added files. The appended `.gitignore` block can conflict only when upstream edits the same tail lines. Keep both sides: upstream's hunk, then the sidecar block that starts with `Fork sidecar: Hermes bridge and CrewAI`.

After the rebase:

```sh
git status
node integrations/hermes-bridge/hermes-runner.mjs --self-check
```

Do not use `git pull upstream main` for this fork. That creates a merge commit. `git fetch upstream` followed by `git rebase upstream/main` replays the fork commits on top of upstream.

## Local files that stay untracked

The root `.gitignore` ignores `.venv/`, `crews/__pycache__/`, `*.sqlite`, and `*.session-token`, plus Hermes session databases under `.hermes/sessions/`. Crew scratch data goes to `crews/.crewai/`. Do not commit API keys. Put model and search keys in the process agent environment or your shell, not in the ticket text.
