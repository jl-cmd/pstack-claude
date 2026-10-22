#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SKILL_PATH = "plugins/pstack/skills/maintain-verification-skill/SKILL.md";
const SESSION_TOOL = /list_sessions|search_session_transcripts|get_session|export_transcript/;
const STOP_TOOL = /AskUserQuestion|ask_user|^stop$/i;
const REPO_TOOL = /bash|powershell|git|gh/i;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "input"],
        properties: {
          tool: { type: "string" },
          input: { type: "string" },
        },
      },
    },
  },
};

function parseArgs(argv) {
  const options = {
    out: join(tmpdir(), "mvs-target-lookup"),
    reps: 3,
    model: "claude-opus-5-5",
    effort: "medium",
    baseRef: "origin/main",
    concurrency: 4,
    timeoutS: 300,
    variants: ["baseline", "v1"],
    cases: null,
    selfCheck: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--self-check") options.selfCheck = true;
    else if (flag === "--out") (options.out = resolve(value)), (index += 1);
    else if (flag === "--reps") (options.reps = Number(value)), (index += 1);
    else if (flag === "--model") (options.model = value), (index += 1);
    else if (flag === "--effort") (options.effort = value), (index += 1);
    else if (flag === "--base-ref") (options.baseRef = value), (index += 1);
    else if (flag === "--concurrency") (options.concurrency = Number(value)), (index += 1);
    else if (flag === "--timeout-s") (options.timeoutS = Number(value)), (index += 1);
    else if (flag === "--variants") (options.variants = value.split(",")), (index += 1);
    else if (flag === "--cases") (options.cases = value.split(",")), (index += 1);
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

function firstIndex(steps, predicate) {
  const found = steps.findIndex(predicate);
  return found === -1 ? Infinity : found;
}

export function gradePlan(expect, steps) {
  const askIndex = firstIndex(steps, (step) => STOP_TOOL.test(step.tool));
  const sessionIndex = firstIndex(steps, (step) => SESSION_TOOL.test(step.tool) || (/ToolSearch/.test(step.tool) && SESSION_TOOL.test(step.input)));
  if (expect === "session-first") return sessionIndex !== Infinity && sessionIndex < askIndex;
  if (expect === "no-session") return sessionIndex === Infinity;
  if (expect === "main-then-pr") {
    const isRepoTool = (step) => REPO_TOOL.test(step.tool);
    const mainIndex = firstIndex(steps, (step) => isRepoTool(step) && /origin[/ ]main/i.test(step.input));
    const pullIndex = firstIndex(steps, (step) => isRepoTool(step) && /\bgh\s+pr\b|refs\/pull|\/pulls\b|\bpull\/[\d*]/i.test(step.input));
    return pullIndex !== Infinity && mainIndex < pullIndex && pullIndex < askIndex;
  }
  throw new Error(`unknown expectation: ${expect}`);
}

function selfCheck() {
  const plans = {
    sessionOracle: [{ tool: "search_session_transcripts", input: "discount-code driver" }, { tool: "ask_user", input: "which" }],
    sessionNull: [{ tool: "glob", input: ".claude/skills/verify*/" }, { tool: "ask_user", input: "which one?" }],
    sessionLate: [{ tool: "ask_user", input: "which one?" }, { tool: "list_sessions", input: "" }],
    noSessionOracle: [{ tool: "glob", input: ".claude/skills/verify*/" }, { tool: "ask_user", input: "which one?" }],
    noSessionNull: [{ tool: "list_sessions", input: "" }],
    prOracle: [
      { tool: "git", input: "git fetch origin && git ls-tree origin/main .claude/skills/verify/features/" },
      { tool: "gh", input: "gh pr list --state open --json headRefName" },
      { tool: "ask_user", input: "not found" },
    ],
    prNull: [{ tool: "glob", input: "features/*.md" }, { tool: "stop", input: "page missing" }],
    prWrongOrder: [
      { tool: "gh", input: "gh pr list --state open" },
      { tool: "git", input: "git show origin/main:.claude/skills/verify/features/refunds.md" },
    ],
    prGitPull: [
      { tool: "git", input: "git show origin/main:.claude/skills/verify/features/refunds.md" },
      { tool: "git", input: "git pull" },
      { tool: "ask_user", input: "not found" },
    ],
    prFetchRefs: [
      { tool: "git", input: "git ls-tree origin/main .claude/skills/verify/features/" },
      { tool: "git", input: "git fetch origin +refs/pull/*/head:refs/remotes/origin/pr/*" },
    ],
  };
  const expectations = [
    ["session-first", plans.sessionOracle, true],
    ["session-first", plans.sessionNull, false],
    ["session-first", plans.sessionLate, false],
    ["session-first", [], false],
    ["no-session", plans.noSessionOracle, true],
    ["no-session", plans.noSessionNull, false],
    ["main-then-pr", plans.prOracle, true],
    ["main-then-pr", plans.prNull, false],
    ["main-then-pr", plans.prWrongOrder, false],
    ["main-then-pr", plans.prGitPull, false],
    ["main-then-pr", plans.prFetchRefs, true],
    ["main-then-pr", [], false],
  ];
  let failures = 0;
  for (const [expect, steps, wanted] of expectations) {
    const got = gradePlan(expect, steps);
    const ok = got === wanted;
    if (!ok) failures += 1;
    console.log(`${ok ? "ok" : "FAIL"}: ${expect} on ${JSON.stringify(steps.map((step) => step.tool))} -> ${got}`);
  }
  return failures === 0;
}

function skillText(variant, options) {
  if (variant === "baseline") {
    return execFileSync("git", ["show", `${options.baseRef}:${SKILL_PATH}`], { cwd: REPO_ROOT, encoding: "utf8" });
  }
  return readFileSync(join(REPO_ROOT, SKILL_PATH), "utf8");
}

function buildPrompt(skill, testCase) {
  const command = `/maintain-verification-skill ${testCase.args}`.trim();
  return [
    "You are working in a web store repository at /work/shop-app.",
    "The user typed this command:",
    "",
    command,
    "",
    "That command loads the skill below. Follow it.",
    "",
    "<skill>",
    skill,
    "</skill>",
    "",
    `What you know about the repository: ${testCase.facts}`,
    "Your tools: Read, Glob, Grep, Edit, Write, Bash (git and gh work), AskUserQuestion, Agent, Skill, ToolSearch.",
    "Deferred tools (load one with ToolSearch before you call it): WebFetch, WebSearch, TaskStop, Monitor, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__search_session_transcripts, mcp__ccd_session_mgmt__get_session, mcp__ccd_session_mgmt__export_transcript, mcp__ccd_pr__get_status, mcp__scheduled-tasks__list_scheduled_tasks.",
    "",
    "You have not run any tool yet. Write the first actions you will take, in order, up to five, as tool calls: the tool name and its input. Write ToolSearch loads as their own step. To end without a target, use the tool name stop.",
  ].join("\n");
}

function runClaude(prompt, options, workDir) {
  const reportPath = join(workDir, "broker-report.json");
  const args = [
    join(homedir(), ".claude", "scripts", "account_broker.py"),
    "run", "--product", "claude", "--report", reportPath, "--",
    "claude", "-p", prompt,
    "--model", options.model,
    "--effort", options.effort,
    "--tools", "",
    "--json-schema", JSON.stringify(PLAN_SCHEMA),
    "--output-format", "json",
    "--no-session-persistence",
  ];
  return new Promise((resolvePromise) => {
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn("python", args, { cwd: workDir, windowsHide: true, detached: ownsProcessGroup, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killTree = () => {
      if (ownsProcessGroup) process.kill(-child.pid, "SIGKILL");
      else spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    };
    const timer = setTimeout(killTree, options.timeoutS * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function parseResult(stdout) {
  const start = stdout.indexOf("{");
  const payload = JSON.parse(stdout.slice(start));
  const plan = payload.structured_output ?? JSON.parse(payload.result);
  return { payload, steps: plan.steps };
}

async function runOne(job, options) {
  const { variant, testCase, rep, skill } = job;
  const variantDir = join(options.out, variant);
  const workDir = mkdtempSync(join(tmpdir(), "shop-app-"));
  const prompt = buildPrompt(skill, testCase);
  const started = Date.now();
  const { code, stdout, stderr } = await runClaude(prompt, options, workDir);
  const latencyS = (Date.now() - started) / 1000;
  try {
    const { payload, steps } = parseResult(stdout);
    const servedModels = Object.keys(payload.modelUsage ?? {});
    if (!servedModels.some((name) => name.startsWith(options.model))) {
      throw new Error(`served models ${servedModels.join(",")} do not include ${options.model}`);
    }
    const passed = gradePlan(testCase.expect, steps);
    const row = {
      prompt_id: testCase.id,
      rep,
      variant,
      tags: testCase.tags,
      prompt: `/maintain-verification-skill ${testCase.args}`.trim(),
      status: "ok",
      grade: { pass: passed ? 1 : 0 },
      steps,
      model: servedModels.join(","),
      usage: payload.usage,
      cost_usd_reported: payload.total_cost_usd,
      latency_s: latencyS,
    };
    appendFileSync(join(variantDir, "results.jsonl"), `${JSON.stringify(row)}\n`);
    writeFileSync(
      join(variantDir, "traces", `${testCase.id}_rep${rep}.json`),
      JSON.stringify([{ role: "user", content: prompt }, { role: "assistant", content: JSON.stringify({ steps }, null, 2) }], null, 2),
    );
    console.log(`${variant} ${testCase.id} rep${rep}: ${passed ? "pass" : "fail"} ${steps.map((step) => step.tool).join(" > ")}`);
  } catch (error) {
    appendFileSync(
      join(variantDir, "errors.jsonl"),
      `${JSON.stringify({ prompt_id: testCase.id, rep, variant, exit_code: code, error: String(error), stderr: stderr.slice(-2000), stdout: stdout.slice(-2000) })}\n`,
    );
    console.log(`${variant} ${testCase.id} rep${rep}: error ${String(error).slice(0, 200)}`);
  }
}

function completedKeys(variantDir) {
  const path = join(variantDir, "results.jsonl");
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
      const row = JSON.parse(line);
      return `${row.prompt_id}#${row.rep}`;
    }),
  );
}

function summarize(options) {
  for (const variant of options.variants) {
    const path = join(options.out, variant, "results.jsonl");
    if (!existsSync(path)) continue;
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const byTag = new Map();
    for (const row of rows) {
      const tag = row.tags[0];
      const tally = byTag.get(tag) ?? { pass: 0, total: 0 };
      tally.pass += row.grade.pass;
      tally.total += 1;
      byTag.set(tag, tally);
    }
    const total = rows.reduce((sum, row) => sum + row.grade.pass, 0);
    const parts = [...byTag].map(([tag, tally]) => `${tag} ${tally.pass}/${tally.total}`);
    console.log(`${variant}: ${total}/${rows.length} pass (${parts.join(", ")})`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfCheck) process.exit(selfCheck() ? 0 : 1);
  const allCases = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
  const cases = options.cases ? allCases.filter((testCase) => options.cases.includes(testCase.id)) : allCases;
  const jobs = [];
  for (const variant of options.variants) {
    const variantDir = join(options.out, variant);
    mkdirSync(join(variantDir, "traces"), { recursive: true });
    const done = completedKeys(variantDir);
    const skill = skillText(variant, options);
    for (const testCase of cases) {
      for (let rep = 0; rep < options.reps; rep += 1) {
        if (!done.has(`${testCase.id}#${rep}`)) jobs.push({ variant, testCase, rep, skill });
      }
    }
  }
  let next = 0;
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await runOne(job, options);
    }
  });
  await Promise.all(workers);
  summarize(options);
}

await main();
