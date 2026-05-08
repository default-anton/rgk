#!/usr/bin/env node
import { parseArgs, UsageError } from "./args.js";
import { parseRgJson, orderCandidates } from "./candidates.js";
import { rankCandidates } from "./codex.js";
import { loadConfig } from "./config.js";
import { execInherited, runCaptured } from "./process.js";

const version = "0.1.0";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(helpText);
    return 0;
  }

  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write(`rgk ${version}\n`);
    return 0;
  }

  let parsed;
  let config;

  try {
    parsed = parseArgs(argv);
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof UsageError || error instanceof Error) {
      process.stderr.write(`rgk: ${error.message}\n`);
      return 2;
    }

    throw error;
  }

  if (parsed.keep === null) {
    return execInherited(config.rgPath, parsed.rgArgs);
  }

  const rgResult = await runCaptured(config.rgPath, [...parsed.rgArgs, "--json", "--color=never"]);
  if (rgResult.stderr !== "") {
    process.stderr.write(rgResult.stderr);
  }

  if (rgResult.code === 1) {
    return 1;
  }

  if (rgResult.code !== 0) {
    if (rgResult.stdout !== "") {
      process.stdout.write(rgResult.stdout);
    }
    return rgResult.code;
  }

  const candidates = parseRgJson(rgResult.stdout);
  if (candidates.length === 0) {
    return 1;
  }

  if (candidates.length > config.keepLimit) {
    process.stderr.write(
      `rgk: ${candidates.length} candidates exceeds RGK_KEEP_LIMIT=${config.keepLimit}. Narrow the rg query or increase RGK_KEEP_LIMIT.\n`,
    );
    return 2;
  }

  let rankedIds: string;
  try {
    rankedIds = await rankCandidates(parsed.keep, candidates, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`rgk: keep filter failed: ${message}\n`);
    return 2;
  }

  const kept = orderCandidates(candidates, rankedIds);
  if (kept.length === 0) {
    return 1;
  }

  for (const candidate of kept) {
    process.stdout.write(`${candidate.output}\n`);
  }

  return 0;
}

const helpText = `rgk ${version}

Usage:
  rgk [rg args...] --keep "natural language condition"
  rgk [rg args...]

Without --keep, rgk execs rg directly.
With --keep, rgk runs rg, asks Codex to keep and rank relevant matches, then prints plain path:line:column:text results.

Wrapper option:
  --keep <condition>   Keep and rank rg matches that satisfy the condition

Environment:
  RGK_MODEL              Codex model (default: gpt-5.3-codex-spark)
  RGK_REASONING_EFFORT   Codex reasoning effort (default: low)
  RGK_KEEP_LIMIT         Max candidates sent to Codex (default: 300)
  RGK_DEBUG              Print Codex diagnostics when set to 1 or true

Use rg --help for ripgrep options.
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main(process.argv.slice(2), process.env);
  process.exitCode = code;
}
