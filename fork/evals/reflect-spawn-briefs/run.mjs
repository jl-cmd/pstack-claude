#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TEMPLATE_DIRECTORY = "plugins/pstack/skills/reflect/references";
const OUTCOME_LINE = /^Outcome:.*$/m;
const BLOCKER_LINE = /^On a blocker:.*$/m;

function parseArgs(argv) {
  const options = {
    hook: join(homedir(), ".claude", "hooks", "routing", "spawn_oversight_hook.py"),
    baseRef: "origin/main",
    variants: ["baseline", "v1"],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--hook") (options.hook = resolve(value)), (index += 1);
    else if (flag === "--base-ref") (options.baseRef = value), (index += 1);
    else if (flag === "--variants") (options.variants = value.split(",")), (index += 1);
    else throw new Error(`unknown flag: ${flag}`);
  }
  return options;
}

function templateText(variant, template, baseRef) {
  const relativePath = `${TEMPLATE_DIRECTORY}/${template}`;
  if (variant === "v1") return readFileSync(join(REPO_ROOT, relativePath), "utf8");
  return execFileSync("git", ["-C", REPO_ROOT, "show", `${baseRef}:${relativePath}`], { encoding: "utf8" });
}

function applyMutation(text, mutation) {
  if (mutation === "drop-outcome") return text.replace(OUTCOME_LINE, "");
  if (mutation === "drop-blocker") return text.replace(BLOCKER_LINE, "");
  return text;
}

function hookDecision(hookPath, prompt) {
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", description: "reflect reviewer", prompt },
  });
  const stdout = execFileSync("python3", [hookPath], { input: payload, encoding: "utf8" }).trim();
  if (!stdout) return "allow";
  const decision = JSON.parse(stdout).hookSpecificOutput?.permissionDecision;
  return decision === "deny" ? "deny" : "allow";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.hook)) throw new Error(`spawn hook not found: ${options.hook}`);
  const allCases = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
  const summary = {};
  for (const variant of options.variants) {
    let passed = 0;
    for (const evalCase of allCases) {
      const prompt = applyMutation(templateText(variant, evalCase.template, options.baseRef), evalCase.mutation);
      const decision = hookDecision(options.hook, prompt);
      const verdict = decision === evalCase.expect ? "PASS" : "FAIL";
      if (verdict === "PASS") passed += 1;
      console.log(`${variant}\t${evalCase.id}\texpect=${evalCase.expect}\tgot=${decision}\t${verdict}`);
    }
    summary[variant] = `${passed}/${allCases.length}`;
  }
  console.log(JSON.stringify(summary));
  return Object.values(summary).every((score) => score.split("/")[0] === score.split("/")[1]) ? 0 : 1;
}

process.exitCode = main();
