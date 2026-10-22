#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SKILL_PATH = "plugins/pstack/skills/reflect/SKILL.md";
const STEP_FIVE = /^## 5\. Apply\n[\s\S]*?(?=^## 6\.)/m;
const ROW_ACTIONS = ["draft-fix", "apply-unreviewed", "wait-for-approval", "file-to-tracker", "drop"];
const MAX_REPS = 3;

const SYSTEM_PROMPT = "You plan agent work and report the plan in the requested structure.";

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "rows", "open_items_after_run"],
  properties: {
    plan: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding_id", "action", "draft_fix", "verifier_count", "verifiers_may_correct", "lands_this_run"],
        properties: {
          finding_id: { type: "string" },
          action: { type: "string", enum: ROW_ACTIONS },
          draft_fix: { type: "string" },
          verifier_count: { type: "integer", minimum: 0 },
          verifiers_may_correct: { type: "boolean" },
          lands_this_run: { type: "boolean" },
        },
      },
    },
    open_items_after_run: { type: "array", items: { type: "string" } },
  },
};

function parseArgs(argv) {
  const options = {
    out: join(tmpdir(), "reflect-close-all-model"),
    reps: MAX_REPS,
    model: "sonnet",
    concurrency: 3,
    timeoutS: 300,
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
    else if (flag === "--concurrency") (options.concurrency = Number(value)), (index += 1);
    else if (flag === "--timeout-s") (options.timeoutS = Number(value)), (index += 1);
    else if (flag === "--cases") (options.cases = value.split(",")), (index += 1);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!(options.reps >= 1 && options.reps <= MAX_REPS)) throw new Error(`--reps must be 1 to ${MAX_REPS}`);
  return options;
}

/**
 * Grade a plan against the close-all contract for every fixture finding.
 * Checks: drafted (action draft-fix with a non-empty draft_fix), two-verifiers
 * (verifier_count of 2 or more), verifiers-correct (verifiers_may_correct true),
 * lands (lands_this_run true), and none-open (no file-to-tracker row, no missing
 * row, and an empty open_items_after_run). Returns each check and the overall pass.
 */
export function gradePlan(findingIds, plan) {
  const rowById = new Map(plan.rows.map((row) => [row.finding_id.trim(), row]));
  const rows = findingIds.map((id) => rowById.get(id));
  const everyRow = (predicate) => rows.every((row) => row !== undefined && predicate(row));
  const checks = {
    "one-row-each": findingIds.every((id) => plan.rows.filter((row) => row.finding_id.trim() === id).length === 1),
    drafted: everyRow((row) => row.action === "draft-fix" && row.draft_fix.trim().length > 0),
    "two-verifiers": everyRow((row) => row.verifier_count >= 2),
    "verifiers-correct": everyRow((row) => row.verifiers_may_correct === true),
    lands: everyRow((row) => row.lands_this_run === true),
    "none-open": everyRow((row) => row.action !== "file-to-tracker") && plan.open_items_after_run.length === 0,
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

function selfCheck(findingIds) {
  const closeAllRow = (id) => ({ finding_id: id, action: "draft-fix", draft_fix: "edit", verifier_count: 2, verifiers_may_correct: true, lands_this_run: true });
  const oracle = { plan: "", rows: findingIds.map(closeAllRow), open_items_after_run: [] };
  const withRow = (id, change) => ({ ...oracle, rows: oracle.rows.map((row) => (row.finding_id === id ? { ...row, ...change } : row)) });
  const prePatchShape = {
    plan: "",
    rows: findingIds.map((id) =>
      id.startsWith("B")
        ? { finding_id: id, action: "file-to-tracker", draft_fix: "", verifier_count: 0, verifiers_may_correct: false, lands_this_run: false }
        : { finding_id: id, action: "wait-for-approval", draft_fix: "edit", verifier_count: 0, verifiers_may_correct: false, lands_this_run: true },
    ),
    open_items_after_run: ["B1 filed"],
  };
  const expectations = [
    ["oracle", oracle, true],
    ["pre-patch shape", prePatchShape, false],
    ["backlog filed", withRow("B1", { action: "file-to-tracker" }), false],
    ["empty draft", withRow("A2", { draft_fix: " " }), false],
    ["one verifier", withRow("A3", { verifier_count: 1 }), false],
    ["no correction", withRow("A1", { verifiers_may_correct: false }), false],
    ["lands later", withRow("B1", { lands_this_run: false }), false],
    ["open item left", { ...oracle, open_items_after_run: ["B1"] }, false],
    ["row missing", { ...oracle, rows: oracle.rows.slice(1) }, false],
    ["applied unverified", withRow("A1", { action: "apply-unreviewed" }), false],
    ["duplicate row", { ...oracle, rows: [...oracle.rows, { ...closeAllRow("B1"), action: "file-to-tracker" }].reverse() }, false],
  ];
  let failures = 0;
  for (const [name, plan, wanted] of expectations) {
    const got = gradePlan(findingIds, plan).pass;
    if (got !== wanted) failures += 1;
    console.log(`${got === wanted ? "ok" : "FAIL"}: ${name} -> ${got}`);
  }
  return failures === 0;
}

function stepFiveText(skillSource) {
  const skill =
    skillSource === "working-tree"
      ? readFileSync(join(REPO_ROOT, SKILL_PATH), "utf8")
      : execFileSync("git", ["-C", REPO_ROOT, "show", `${skillSource}:${SKILL_PATH}`], { encoding: "utf8" });
  const match = skill.match(STEP_FIVE);
  if (!match) throw new Error(`no step 5 section in ${skillSource}:${SKILL_PATH}`);
  return match[0].trim();
}

function findingsTable(findings) {
  return findings
    .map((row) => {
      const detail = row.list === "Backlog" ? `Suggestion: ${row.suggestion} Tags: ${row.tags}.` : `Routing: ${row.routing}`;
      return `- ${row.id} (${row.list}): ${row.finding} ${detail}`;
    })
    .join("\n");
}

function buildPrompt(stepFive, fixture) {
  return [
    "You are the parent agent running the reflect skill. Steps 1 to 4 are done. Step 5 of the skill reads:",
    "",
    "<skill-step>",
    stepFive,
    "</skill-step>",
    "",
    "The synthesizer returned these rows. The Rejected list is empty.",
    "",
    findingsTable(fixture.findings),
    "",
    "You presented the rows. The user replied:",
    "",
    fixture.request,
    "",
    "You have not run any tool yet. Write the plan you will follow for step 5 as numbered steps in plan.",
    `Then give one entry in rows for each finding id. action is one of: ${ROW_ACTIONS.join(", ")}.`,
    "draft_fix is the fix you will draft, or an empty string when you draft none. verifier_count is how many verifier agents review that row's fix before it lands.",
    "verifiers_may_correct says whether a verifier may change the fix. lands_this_run says whether the fix is applied before this run ends.",
    "open_items_after_run lists each finding id still open, filed to a tracker, or waiting on the user when the run ends.",
  ].join("\n");
}

function runClaude(prompt, options, workDir) {
  const args = [
    "-p",
    "--model", options.model,
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--system-prompt", SYSTEM_PROMPT,
    "--json-schema", JSON.stringify(PLAN_SCHEMA),
    "--output-format", "json",
    "--no-session-persistence",
  ];
  return new Promise((resolvePromise) => {
    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn("claude", args, { cwd: workDir, windowsHide: true, detached: ownsProcessGroup, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killTree = () => {
      if (ownsProcessGroup) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      } else spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
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
    child.stdin.end(prompt);
  });
}

function parseResult(stdout) {
  const payload = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const plan = payload.structured_output ?? JSON.parse(payload.result);
  return { payload, plan };
}

async function runOne(job, options, fixture) {
  const { testCase, rep, stepFive, promptSha } = job;
  const caseDir = join(options.out, testCase.id);
  const workDir = mkdtempSync(join(tmpdir(), "reflect-close-all-"));
  const prompt = buildPrompt(stepFive, fixture);
  const started = Date.now();
  const { code, stdout, stderr } = await runClaude(prompt, options, workDir);
  rmSync(workDir, { recursive: true, force: true });
  const latencyS = (Date.now() - started) / 1000;
  try {
    const { payload, plan } = parseResult(stdout);
    const servedModels = Object.keys(payload.modelUsage ?? {});
    if (!servedModels.some((name) => name.includes(options.model))) {
      throw new Error(`served models ${servedModels.join(",")} do not include ${options.model}`);
    }
    const grade = gradePlan(fixture.findings.map((row) => row.id), plan);
    const row = {
      case_id: testCase.id,
      rep,
      skill_source: testCase.skill_source,
      prompt_sha: promptSha,
      status: "ok",
      grade,
      plan,
      model: servedModels.join(","),
      usage: payload.usage,
      cost_usd_reported: payload.total_cost_usd,
      latency_s: latencyS,
    };
    appendFileSync(join(caseDir, "results.jsonl"), `${JSON.stringify(row)}\n`);
    writeFileSync(join(caseDir, "traces", `rep${rep}.json`), JSON.stringify([{ role: "user", content: prompt }, { role: "assistant", content: plan }], null, 2));
    const failed = Object.entries(grade.checks).filter(([, ok]) => !ok).map(([name]) => name);
    console.log(`${testCase.id} rep${rep}: ${grade.pass ? "pass" : `fail (${failed.join(", ")})`}`);
  } catch (error) {
    appendFileSync(
      join(caseDir, "errors.jsonl"),
      `${JSON.stringify({ case_id: testCase.id, rep, exit_code: code, error: String(error), stderr: stderr.slice(-2000), stdout: stdout.slice(-2000) })}\n`,
    );
    console.log(`${testCase.id} rep${rep}: error ${String(error).slice(0, 200)}`);
  }
}

function readRows(caseDir, promptSha) {
  const path = join(caseDir, "results.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.prompt_sha === promptSha);
}

function summarize(options, cases, shaByCase) {
  let meetsExpectations = true;
  for (const testCase of cases) {
    const rows = readRows(join(options.out, testCase.id), shaByCase.get(testCase.id)).filter((row) => row.rep < options.reps);
    const passed = rows.filter((row) => row.grade.pass).length;
    const checkTallies = Object.keys(rows[0]?.grade.checks ?? {}).map((name) => `${name} ${rows.filter((row) => row.grade.checks[name]).length}/${rows.length}`);
    const majorityPass = passed * 2 > rows.length;
    const met = rows.length === options.reps && (testCase.expect === "pass" ? majorityPass : passed * 2 < rows.length);
    if (!met) meetsExpectations = false;
    console.log(`${testCase.id}: ${passed}/${rows.length} pass, ${options.reps - rows.length} errored, expect ${testCase.expect} -> ${met ? "MET" : "NOT MET"} (${checkTallies.join(", ")})`);
  }
  return meetsExpectations;
}

async function main() {
  const fixture = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
  const options = parseArgs(process.argv.slice(2));
  if (options.selfCheck) process.exit(selfCheck(fixture.findings.map((row) => row.id)) ? 0 : 1);
  const cases = options.cases ? fixture.cases.filter((testCase) => options.cases.includes(testCase.id)) : fixture.cases;
  const unknownCaseIds = (options.cases ?? []).filter((id) => !fixture.cases.some((testCase) => testCase.id === id));
  if (unknownCaseIds.length > 0) throw new Error(`unknown --cases ids: ${unknownCaseIds.join(",")}`);
  const jobs = [];
  const shaByCase = new Map();
  for (const testCase of cases) {
    const caseDir = join(options.out, testCase.id);
    mkdirSync(join(caseDir, "traces"), { recursive: true });
    const stepFive = stepFiveText(testCase.skill_source);
    const promptSha = createHash("sha256").update(buildPrompt(stepFive, fixture)).update(JSON.stringify(PLAN_SCHEMA)).update(SYSTEM_PROMPT).update(options.model).digest("hex").slice(0, 12);
    shaByCase.set(testCase.id, promptSha);
    const done = new Set(readRows(caseDir, promptSha).map((row) => row.rep));
    for (let rep = 0; rep < options.reps; rep += 1) {
      if (!done.has(rep)) jobs.push({ testCase, rep, stepFive, promptSha });
    }
  }
  let next = 0;
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await runOne(job, options, fixture);
    }
  });
  await Promise.all(workers);
  process.exitCode = summarize(options, cases, shaByCase) ? 0 : 1;
}

await main();
