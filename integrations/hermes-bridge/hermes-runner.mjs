#!/usr/bin/env node
/**
 * External Hermes worker for a Paperclip process agent.
 *
 * Paperclip starts this process. The process reads the assigned ticket,
 * spawns the Hermes CLI in the workspace, and posts the artifact plus a
 * resolution comment through the Paperclip HTTP API. It does not import
 * Paperclip source.
 *
 * Default Hermes argv matches the installed one-shot CLI:
 *   hermes chat -q "<task>" -Q --yolo --source tool
 * Set HERMES_CLI_STYLE=run-task for:
 *   hermes run --task "<task>" [--max-tokens N] [--budget CENTS]
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BRIDGE_DIR, "../..");
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const STATUS_PREFERENCE = ["in_progress", "todo", "in_review", "blocked", "backlog"];

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function apiBase(raw) {
  let api = String(raw || "http://127.0.0.1:3100").trim().replace(/\/+$/, "");
  if (!api.endsWith("/api")) api += "/api";
  return api;
}

function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length > 6) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
    .replace(
      /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1[redacted]",
    );
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[body] = true;
    else {
      out[body] = next;
      i += 1;
    }
  }
  return out;
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number;
}

function parsePayload(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Ticket payload must be a JSON object");
  }
  const issue = data.issue && typeof data.issue === "object" ? data.issue : data;
  return {
    id: firstString(issue.id, issue.issueId, issue.taskId, issue.ticketId, data.id),
    identifier: firstString(issue.identifier, data.identifier),
    title: firstString(issue.title, data.title),
    description: firstString(issue.description, issue.body, data.description, data.body),
    tokenCap: asNumber(issue.tokenCap ?? issue.maxTokens ?? data.tokenCap ?? data.maxTokens),
    budgetCents: asNumber(
      issue.budgetCents ?? issue.budget ?? data.budgetCents ?? data.budget,
    ),
    maxTurns: asNumber(issue.maxTurns ?? data.maxTurns),
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickIssue(issues) {
  const rows = Array.isArray(issues)
    ? issues
    : Array.isArray(issues?.issues)
      ? issues.issues
      : Array.isArray(issues?.items)
        ? issues.items
        : [];
  const ranked = rows
    .filter((issue) => issue && typeof issue.id === "string" && OPEN_STATUSES.includes(issue.status))
    .map((issue) => ({ issue, rank: STATUS_PREFERENCE.indexOf(issue.status) }))
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank);
  return ranked[0]?.issue ?? null;
}

function buildTaskPrompt(task) {
  const lines = [
    "You are running as an external Hermes worker for one Paperclip ticket.",
    "Do the ticket inside this workspace. Do not call the Paperclip API.",
    "This runner posts the artifact and the resolution comment after you exit.",
    "",
    `Ticket: ${task.identifier || task.id || "(local)"}`,
    `Title: ${task.title || "(untitled)"}`,
  ];
  if (task.budgetCents !== undefined) lines.push(`Budget cap (cents): ${task.budgetCents}`);
  if (task.tokenCap !== undefined) lines.push(`Token cap: ${task.tokenCap}`);
  lines.push("", "Description:", task.description || "(no description)");
  lines.push(
    "",
    "When the ticket needs deep web research, a structured competitor audit, or multi-angle document synthesis, follow skills/hermes-crew/SKILL.md (run_crew_research).",
    "Finish by leaving the deliverable in the workspace. Your final reply is the resolution text.",
  );
  return lines.join("\n");
}

function buildHermesArgs(options) {
  const bin = options.bin || "hermes";
  const prompt = options.prompt;
  const style = options.style === "run-task" ? "run-task" : "chat";
  if (style === "run-task") {
    const args = [bin, "run", "--task", prompt];
    if (options.tokenCap !== undefined) args.push("--max-tokens", String(Math.floor(options.tokenCap)));
    if (options.budgetCents !== undefined) args.push("--budget", String(Math.floor(options.budgetCents)));
    return args;
  }
  const args = [bin, "chat", "-q", prompt, "-Q", "--yolo", "--source", "tool"];
  if (options.model) args.push("-m", options.model);
  if (options.provider && options.provider !== "auto") args.push("--provider", options.provider);
  if (options.toolsets) args.push("-t", options.toolsets);
  if (options.maxTurns !== undefined && options.maxTurns > 0) {
    args.push("--max-turns", String(Math.floor(options.maxTurns)));
  }
  if (options.passRunBudget && options.budgetCents !== undefined) {
    args.push("--run-budget", (options.budgetCents / 100).toFixed(2));
  }
  return args;
}

function parseHermesOutput(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const sessionMatch = stdout.match(/^session_id:\s*(\S+)/m) || combined.match(/session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i);
  const usageMatch = combined.match(/tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i);
  const costMatch = combined.match(/(?:cost|spent)[:\s]*\$?([\d.]+)/i);
  let response = stdout;
  const sessionAt = stdout.lastIndexOf("\nsession_id:");
  if (sessionAt > 0) response = stdout.slice(0, sessionAt);
  response = response
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("session_id:")) return false;
      if (trimmed.startsWith("[tool]") || trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) return false;
      return true;
    })
    .join("\n")
    .trim();
  return {
    sessionId: sessionMatch?.[1] || null,
    response,
    usage: usageMatch
      ? { inputTokens: Number(usageMatch[1]) || 0, outputTokens: Number(usageMatch[2]) || 0 }
      : null,
    costUsd: costMatch ? Number(costMatch[1]) : null,
  };
}

function help() {
  return `Usage: node integrations/hermes-bridge/hermes-runner.mjs [options]

Reads a Paperclip ticket, runs Hermes in the workspace, and posts the result.

Options:
  --issue-id <id>           Ticket id or identifier (else PAPERCLIP_TASK_ID, else the assigned inbox)
  --title <text>            Ticket title, when the API is not used
  --description <text>      Ticket description
  --payload-json <json>     Ticket object on the command line
  --payload-file <path>     Ticket JSON file. "-" reads stdin
  --token-cap <n>           Token cap passed through to Hermes
  --budget-cents <n>        Budget cap in cents
  --max-turns <n>           Hermes --max-turns for the chat style
  --status <status>         Issue status after success (default in_review)
  --style <chat|run-task>   Hermes argv style (default HERMES_CLI_STYLE or chat)
  --dry-run                 Print the Hermes argv and skip the API and the process
  --no-checkout             Do not checkout the ticket before running
  --no-post                 Do not write comments, attachments, or status
  --self-check              Run local assertions and exit
  --help                    Show this help

Environment (Paperclip process adapter injects the PAPERCLIP_* run values):
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID,
  PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID, PAPERCLIP_WORKSPACE_CWD
  HERMES_BIN, HERMES_CLI_STYLE, HERMES_MODEL, HERMES_PROVIDER, HERMES_TOOLSETS,
  HERMES_MAX_TURNS, HERMES_TOKEN_CAP, HERMES_BUDGET_CENTS, HERMES_PASS_RUN_BUDGET,
  HERMES_TIMEOUT_SEC, HERMES_CWD, HERMES_CREW_ROOT
`;
}

function selfCheck() {
  const checks = [];
  const assert = (name, condition) => checks.push([name, Boolean(condition)]);
  assert("api base", apiBase("http://127.0.0.1:3100/") === "http://127.0.0.1:3100/api");
  assert("api suffix", apiBase("http://127.0.0.1:3100/api/") === "http://127.0.0.1:3100/api");
  const payload = parsePayload({
    ticketId: "11111111-1111-4111-8111-111111111111",
    title: "Audit rivals",
    body: "Compare three products",
    maxTokens: 4000,
    budget: 250,
  });
  assert("payload id", payload.id.startsWith("11111111"));
  assert("payload body", payload.description === "Compare three products");
  assert("payload caps", payload.tokenCap === 4000 && payload.budgetCents === 250);
  const chat = buildHermesArgs({
    bin: "hermes",
    style: "chat",
    prompt: "do the task",
    model: "auto-model",
    maxTurns: 12,
    budgetCents: 250,
    passRunBudget: true,
  });
  assert("chat command", chat[0] === "hermes" && chat[1] === "chat" && chat.includes("-q") && chat.includes("-Q"));
  assert("chat budget", chat.includes("--max-turns") && chat.includes("--run-budget") && chat.includes("2.50"));
  const runTask = buildHermesArgs({
    bin: "hermes",
    style: "run-task",
    prompt: "do the task",
    tokenCap: 4000,
    budgetCents: 250,
  });
  assert(
    "run-task command",
    JSON.stringify(runTask) === JSON.stringify(["hermes", "run", "--task", "do the task", "--max-tokens", "4000", "--budget", "250"]),
  );
  const picked = pickIssue([
    { id: "a", status: "blocked" },
    { id: "b", status: "todo" },
    { id: "c", status: "in_progress" },
  ]);
  assert("pick in progress", picked?.id === "c");
  const parsed = parseHermesOutput("The answer\n\nsession_id: abc123\n", "tokens: 10 input 4 output\n");
  assert("parse session", parsed.sessionId === "abc123" && parsed.usage.inputTokens === 10 && parsed.response === "The answer");
  assert("redact", redact("Authorization: Bearer supersecretvalue", ["supersecretvalue"]) === "Authorization: Bearer [redacted]");
  const failed = checks.filter((entry) => !entry[1]);
  if (failed.length) fail(`self-check failed: ${failed.map((entry) => entry[0]).join(", ")}`);
  process.stdout.write(`self-check ok (${checks.length})\n`);
}

async function readPayload(args) {
  if (typeof args["payload-json"] === "string") return parsePayload(args["payload-json"]);
  if (typeof args["payload-file"] === "string") {
    if (args["payload-file"] === "-") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      return parsePayload(Buffer.concat(chunks).toString("utf8"));
    }
    const { readFile } = await import("node:fs/promises");
    return parsePayload(await readFile(args["payload-file"], "utf8"));
  }
  if (!process.stdin.isTTY && args["payload-file"] === undefined && args["payload-json"] === undefined && args._.includes("-")) {
    return null;
  }
  return {
    id: firstString(args["issue-id"], process.env.PAPERCLIP_TASK_ID),
    identifier: "",
    title: firstString(args.title),
    description: firstString(args.description),
    tokenCap: asNumber(args["token-cap"] ?? process.env.HERMES_TOKEN_CAP ?? process.env.PAPERCLIP_TOKEN_CAP),
    budgetCents: asNumber(args["budget-cents"] ?? process.env.HERMES_BUDGET_CENTS),
    maxTurns: asNumber(args["max-turns"] ?? process.env.HERMES_MAX_TURNS),
  };
}

function paperclipHeaders(env, json = true) {
  const headers = { Authorization: `Bearer ${env.PAPERCLIP_API_KEY}` };
  if (json) headers["Content-Type"] = "application/json";
  if (env.PAPERCLIP_RUN_ID) headers["X-Paperclip-Run-Id"] = env.PAPERCLIP_RUN_ID;
  return headers;
}

async function paperclipFetch(env, method, urlPath, body, { json = true } = {}) {
  const response = await fetch(`${env.api}${urlPath}`, {
    method,
    headers: paperclipHeaders(env, json && body !== undefined),
    body: body === undefined ? undefined : json ? JSON.stringify(body) : body,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    throw new Error(`${method} ${urlPath} failed (${response.status}): ${redact(detail, [env.PAPERCLIP_API_KEY])}`);
  }
  return parsed;
}

async function hydrateTask(env, task) {
  const me = await paperclipFetch(env, "GET", "/agents/me");
  env.agentId = env.agentId || me?.id || "";
  env.companyId = env.companyId || me?.companyId || "";
  const remaining = Math.max(0, Number(me?.budgetMonthlyCents || 0) - Number(me?.spentMonthlyCents || 0));
  if (task.budgetCents === undefined && Number.isFinite(remaining)) task.budgetCents = remaining;

  if (!task.id && env.agentId && env.companyId) {
    const assigned = await paperclipFetch(
      env,
      "GET",
      `/companies/${encodeURIComponent(env.companyId)}/issues?assigneeAgentId=${encodeURIComponent(env.agentId)}&status=${OPEN_STATUSES.join(",")}`,
    );
    const chosen = pickIssue(assigned);
    if (!chosen) return null;
    task.id = chosen.id;
    task.title = task.title || chosen.title || "";
    task.identifier = task.identifier || chosen.identifier || "";
  }
  if (!task.id) return task.title || task.description ? task : null;

  const issue = await paperclipFetch(env, "GET", `/issues/${encodeURIComponent(task.id)}`);
  task.id = issue.id || task.id;
  task.identifier = task.identifier || issue.identifier || "";
  task.title = task.title || issue.title || "";
  task.description = task.description || issue.description || "";
  return task;
}

async function checkoutIssue(env, issueId) {
  const updated = await paperclipFetch(env, "POST", `/issues/${encodeURIComponent(issueId)}/checkout`, {
    agentId: env.agentId,
    expectedStatuses: OPEN_STATUSES,
  });
  if (!updated || !updated.id) {
    throw new Error("Checkout did not acquire the ticket");
  }
}

function childEnv(env, task) {
  const next = { ...process.env };
  if (task.tokenCap !== undefined) next.HERMES_TOKEN_CAP = String(Math.floor(task.tokenCap));
  if (task.budgetCents !== undefined) {
    next.HERMES_BUDGET_CENTS = String(Math.floor(task.budgetCents));
    next.HERMES_BUDGET_USD = (task.budgetCents / 100).toFixed(2);
  }
  next.HERMES_CREW_ROOT = env.crewRoot;
  next.PYTHONPATH = next.PYTHONPATH ? `${env.crewRoot}${path.delimiter}${next.PYTHONPATH}` : env.crewRoot;
  return next;
}

function runHermes(args, { cwd, env, timeoutSec, onChunk }) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, timeoutSec * 1000)
      : null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onChunk("stdout", text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onChunk("stderr", text);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      finish({
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function artifactMarkdown(task, parsed, result) {
  const usage = parsed.usage
    ? `${parsed.usage.inputTokens} input / ${parsed.usage.outputTokens} output`
    : "not reported";
  return [
    `# ${task.title || task.identifier || task.id || "Hermes result"}`,
    "",
    parsed.response || "(Hermes returned no response text)",
    "",
    "## Run metadata",
    "",
    `- Ticket: ${task.identifier || task.id || "local"}`,
    `- Session: ${parsed.sessionId || "none"}`,
    `- Tokens: ${usage}`,
    `- Cost USD: ${parsed.costUsd ?? "not reported"}`,
    `- Exit code: ${result.exitCode ?? "null"}`,
    "",
  ].join("\n");
}

async function uploadArtifact(env, issueId, filePath, filename) {
  const bytes = await (await import("node:fs/promises")).readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "text/markdown" }), filename);
  const attachment = await paperclipFetch(
    env,
    "POST",
    `/companies/${encodeURIComponent(env.companyId)}/issues/${encodeURIComponent(issueId)}/attachments`,
    form,
    { json: false },
  );
  const workProduct = await paperclipFetch(env, "POST", `/issues/${encodeURIComponent(issueId)}/work-products`, {
    type: "artifact",
    provider: "paperclip",
    title: filename,
    status: "ready_for_review",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "unknown",
    summary: "Hermes execution artifact",
    ...(env.PAPERCLIP_RUN_ID ? { createdByRunId: env.PAPERCLIP_RUN_ID } : {}),
    metadata: {
      attachmentId: attachment.id,
      contentType: "text/markdown",
      byteSize: attachment.byteSize ?? bytes.length,
      contentPath: attachment.contentPath,
      openPath: attachment.openPath || attachment.contentPath,
      downloadPath: attachment.downloadPath || attachment.contentPath,
      originalFilename: filename,
    },
  });
  return { attachment, workProduct };
}

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated; full text is in the artifact]`;
}

async function postResolution(env, task, parsed, result, artifactPath) {
  let link = "";
  try {
    const uploaded = await uploadArtifact(env, task.id, artifactPath, `${task.identifier || "hermes"}-result.md`);
    const contentPath = uploaded.attachment.contentPath || "";
    link = contentPath ? `\n\n- Artifact: [${task.title || "Hermes result"}](${contentPath})` : "";
  } catch (error) {
    link = `\n\nArtifact upload failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const succeeded = result.exitCode === 0 && !result.timedOut;
  const body = clip(
    [
      succeeded ? "## Hermes finished" : "## Hermes failed",
      "",
      parsed.response || "(no response text)",
      "",
      `- Session: \`${parsed.sessionId || "none"}\``,
      `- Tokens: ${parsed.usage ? `${parsed.usage.inputTokens} in / ${parsed.usage.outputTokens} out` : "not reported"}`,
      `- Exit: ${result.exitCode ?? "null"}${result.timedOut ? " (timed out)" : ""}`,
      link,
    ].join("\n"),
    20000,
  );
  await paperclipFetch(env, "POST", `/issues/${encodeURIComponent(task.id)}/comments`, {
    body,
    clientRequestId: randomUUID(),
  });
  await paperclipFetch(env, "PATCH", `/issues/${encodeURIComponent(task.id)}`, {
    status: succeeded ? env.successStatus : "blocked",
  });
}

function printDryRun(args, cwd) {
  const printable = [];
  for (let i = 0; i < args.length; i += 1) {
    printable.push(args[i]);
    if (args[i] === "-q" || args[i] === "--task") {
      printable.push("<task prompt>");
      i += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({ cwd, argv: printable }, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(help());
    return;
  }
  if (args["self-check"]) {
    selfCheck();
    return;
  }

  const env = {
    api: apiBase(process.env.PAPERCLIP_API_URL),
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY || "",
    PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID || "",
    agentId: process.env.PAPERCLIP_AGENT_ID || "",
    companyId: process.env.PAPERCLIP_COMPANY_ID || "",
    crewRoot: process.env.HERMES_CREW_ROOT || REPO_ROOT,
    successStatus: firstString(args.status, "in_review"),
  };
  if (!["in_review", "done", "blocked", "todo", "in_progress"].includes(env.successStatus)) {
    fail(`Unsupported --status ${env.successStatus}`);
  }

  let task = await readPayload(args);
  if (!task) fail("Provide a ticket via --issue-id, --payload-file, --title, or Paperclip env");
  const canPost = Boolean(env.PAPERCLIP_API_KEY) && args["no-post"] !== true && args["dry-run"] !== true;
  if (canPost) {
    task = await hydrateTask(env, task);
    if (!task) {
      process.stderr.write("No assigned Paperclip ticket. Nothing to run.\n");
      return;
    }
    if (task.id && env.agentId && args["no-checkout"] !== true) await checkoutIssue(env, task.id);
  }
  if (!task.title && !task.description && !task.id) {
    fail("Provide a ticket via --issue-id, --payload-file, --title, or Paperclip env");
  }

  const style = firstString(args.style, process.env.HERMES_CLI_STYLE, "chat");
  const hermesArgs = buildHermesArgs({
    bin: process.env.HERMES_BIN || "hermes",
    style,
    prompt: buildTaskPrompt(task),
    model: process.env.HERMES_MODEL || "",
    provider: process.env.HERMES_PROVIDER || "",
    toolsets: process.env.HERMES_TOOLSETS || "",
    maxTurns: task.maxTurns,
    tokenCap: task.tokenCap,
    budgetCents: task.budgetCents,
    passRunBudget: process.env.HERMES_PASS_RUN_BUDGET === "1",
  });
  const cwd = process.env.HERMES_CWD || process.env.PAPERCLIP_WORKSPACE_CWD || REPO_ROOT;
  if (args["dry-run"]) {
    printDryRun(hermesArgs, cwd);
    return;
  }

  const logDir = path.join(BRIDGE_DIR, "logs");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `${(task.identifier || task.id || "local").replace(/[^\w.-]+/g, "_")}-${stamp}.log`);
  const chunks = [];
  const onChunk = (stream, text) => {
    const safe = redact(text, [env.PAPERCLIP_API_KEY]);
    chunks.push(`[${stream}] ${safe}`);
    process.stderr.write(safe);
  };

  let result;
  try {
    result = await runHermes(hermesArgs, {
      cwd,
      env: childEnv(env, task),
      timeoutSec: asNumber(process.env.HERMES_TIMEOUT_SEC) ?? 1800,
      onChunk,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to start Hermes: ${message}`);
  }
  await writeFile(logPath, chunks.join(""), "utf8");
  const parsed = parseHermesOutput(result.stdout, result.stderr);
  const outDir = path.join(BRIDGE_DIR, "out");
  await mkdir(outDir, { recursive: true });
  const artifactPath = path.join(outDir, `${(task.identifier || task.id || "local").replace(/[^\w.-]+/g, "_")}-${stamp}.md`);
  await writeFile(artifactPath, artifactMarkdown(task, parsed, result), "utf8");

  if (canPost && task.id) await postResolution(env, task, parsed, result, artifactPath);

  const summary = {
    issueId: task.id || null,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    sessionId: parsed.sessionId,
    usage: parsed.usage,
    costUsd: parsed.costUsd,
    artifactPath,
    logPath,
    posted: Boolean(canPost && task.id),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(redact(message, [process.env.PAPERCLIP_API_KEY || ""]));
});
