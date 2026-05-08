#!/usr/bin/env node
import { parseArgs, UsageError } from "./args.js";
import { orderCandidates } from "./candidates.js";
import { rankCandidates } from "./codex.js";
import { loadConfig, loadRgPath } from "./config.js";
import { execInherited, formatSpawnError, isSpawnError, runRgCandidates } from "./process.js";

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
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError || error instanceof Error) {
      process.stderr.write(`rgk: ${error.message}\n`);
      return 2;
    }

    throw error;
  }

  if (parsed.keep === null) {
    try {
      return await execInherited(loadRgPath(env), parsed.rgArgs);
    } catch (error) {
      process.stderr.write(`rgk: ${formatSpawnError("rg", error)}\n`);
      return 2;
    }
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`rgk: ${error.message}\n`);
      return 2;
    }

    throw error;
  }

  let rgResult;
  try {
    rgResult = await runRgCandidates(
      config.rgPath,
      withKeepRgFlags(parsed.rgArgs),
      config.keepLimit,
    );
  } catch (error) {
    process.stderr.write(`rgk: ${formatSpawnError("rg", error)}\n`);
    return 2;
  }

  if (rgResult.stderr !== "") {
    process.stderr.write(rgResult.stderr);
  }

  if (rgResult.limitExceeded) {
    process.stderr.write(
      `rgk: more than ${config.keepLimit} candidates matched. Narrow the rg query or increase RGK_KEEP_LIMIT.\n`,
    );
    return 2;
  }

  if (rgResult.code === 1) {
    return 1;
  }

  if (rgResult.code !== 0) {
    return rgResult.code;
  }

  if (rgResult.candidates.length === 0) {
    return 1;
  }

  let rankedIds: string;
  try {
    rankedIds = await rankCandidates(parsed.keep, rgResult.candidates, config);
  } catch (error) {
    const message = isSpawnError(error)
      ? formatSpawnError("codex", error)
      : error instanceof Error
        ? error.message
        : String(error);
    process.stderr.write(`rgk: keep filter failed: ${message}\n`);
    return 2;
  }

  const kept = orderCandidates(rgResult.candidates, rankedIds);
  if (kept.length === 0) {
    return 1;
  }

  for (const candidate of kept) {
    process.stdout.write(`${candidate.output}\n`);
  }

  return 0;
}

export function withKeepRgFlags(args: readonly string[]): readonly string[] {
  const terminatorIndex = args.indexOf("--");
  const forcedFlags = ["--json", "--color=never"];
  if (terminatorIndex === -1) {
    return [...args, ...forcedFlags];
  }

  return [...args.slice(0, terminatorIndex), ...forcedFlags, ...args.slice(terminatorIndex)];
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
  try {
    const code = await main(process.argv.slice(2), process.env);
    process.exitCode = code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`rgk: unexpected failure: ${message}\n`);
    process.exitCode = 2;
  }
}
