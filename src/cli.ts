#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./args.js";
import { orderCandidates } from "./candidates.js";
import { rankCandidates } from "./codex.js";
import { loadConfig, loadRgPath } from "./config.js";
import {
  execInherited,
  formatSpawnError,
  isSpawnError,
  runCaptured,
  runRgCandidates,
} from "./process.js";

const version = readPackageVersion();
let pipeHandlersInstalled = false;

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  installPipeHandlers();

  if (argv.length === 1 && argv[0] === "--rgk-help") {
    writeStdout(helpText);
    return 0;
  }

  if (argv.length === 1 && argv[0] === "--rgk-version") {
    writeStdout(`rgk ${version}\n`);
    return 0;
  }

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "--version")) {
    return runRgThenAppendRgkInfo(argv, env);
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError || error instanceof Error) {
      writeStderr(`rgk: ${error.message}\n`);
      return 2;
    }

    throw error;
  }

  if (parsed.keep === null) {
    try {
      return await execInherited(loadRgPath(env), parsed.rgArgs);
    } catch (error) {
      writeStderr(`rgk: ${formatSpawnError("rg", error)}\n`);
      return 2;
    }
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof Error) {
      writeStderr(`rgk: ${error.message}\n`);
      return 2;
    }

    throw error;
  }

  const incompatibleFlag = firstKeepIncompatibleRgFlag(parsed.rgArgs);
  if (incompatibleFlag !== null) {
    writeStderr(`rgk: --keep does not support rg output mode ${incompatibleFlag}\n`);
    return 2;
  }

  let rgResult;
  try {
    rgResult = await runRgCandidates(
      config.rgPath,
      withKeepRgFlags(parsed.rgArgs),
      {
        condition: parsed.keep,
        perRequestMaxBytes: config.promptMaxBytes,
        totalMaxBytes: config.totalPromptMaxBytes,
      },
      {
        promptLineMaxBytes: config.promptLineMaxBytes,
        outputLineMaxBytes: config.outputLineMaxBytes,
      },
    );
  } catch (error) {
    writeStderr(`rgk: ${formatSpawnError("rg", error)}\n`);
    return 2;
  }

  if (rgResult.stderr !== "") {
    writeStderr(rgResult.stderr);
  }

  if (rgResult.promptBudgetExceeded !== null) {
    const message =
      rgResult.promptBudgetExceeded === "request"
        ? `rgk: a keep candidate is above RGK_PROMPT_MAX_BYTES=${config.promptMaxBytes}. Lower RGK_PROMPT_LINE_MAX_BYTES or raise RGK_PROMPT_MAX_BYTES.\n`
        : `rgk: keep input is above RGK_TOTAL_PROMPT_MAX_BYTES=${config.totalPromptMaxBytes}. Narrow the rg query or raise RGK_TOTAL_PROMPT_MAX_BYTES.\n`;
    writeStderr(message);
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
    writeStderr(`rgk: keep filter failed: ${message}\n`);
    return 2;
  }

  const kept = orderCandidates(rgResult.candidates, rankedIds);
  if (kept.length === 0) {
    return 1;
  }

  for (const candidate of kept) {
    writeStdout(`${candidate.output}\n`);
  }

  return 0;
}

async function runRgThenAppendRgkInfo(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  try {
    const rgResult = await runCaptured(loadRgPath(env), argv, { inheritStdin: true });
    if (rgResult.stdout !== "") {
      writeStdout(rgResult.stdout);
    }
    if (rgResult.stderr !== "") {
      writeStderr(rgResult.stderr);
    }

    if (rgResult.code !== 0) {
      return rgResult.code;
    }

    if (argv[0] === "--version") {
      writeStdout(`rgk ${version}\n`);
    } else {
      writeStdout(`\n${helpText}`);
    }

    return 0;
  } catch (error) {
    writeStderr(`rgk: ${formatSpawnError("rg", error)}\n`);
    return 2;
  }
}

export function withKeepRgFlags(args: readonly string[]): readonly string[] {
  const terminatorIndex = args.indexOf("--");
  const forcedFlags = ["--json", "--color=never"];
  if (terminatorIndex === -1) {
    return [...args, ...forcedFlags];
  }

  return [...args.slice(0, terminatorIndex), ...forcedFlags, ...args.slice(terminatorIndex)];
}

export function firstKeepIncompatibleRgFlag(args: readonly string[]): string | null {
  const incompatibleLongFlags = new Set([
    "--count",
    "--count-matches",
    "--files",
    "--files-with-matches",
    "--files-without-match",
    "--quiet",
  ]);
  const longValueFlags = new Set([
    "--after-context",
    "--before-context",
    "--context",
    "--file",
    "--glob",
    "--max-count",
    "--max-filesize",
    "--regexp",
    "--replace",
    "--type",
    "--type-not",
  ]);
  const incompatibleShortFlags = new Set(["c", "l", "L", "q"]);
  const shortValueFlags = new Set(["A", "B", "C", "e", "f", "g", "m", "M", "r", "t", "T"]);
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--") {
      return null;
    }

    if (arg.startsWith("--")) {
      const flagName = arg.split("=", 1)[0] ?? arg;
      if (incompatibleLongFlags.has(flagName)) {
        return flagName;
      }
      if (longValueFlags.has(flagName) && !arg.includes("=")) {
        skipNext = true;
      }
      continue;
    }

    if (!arg.startsWith("-") || arg === "-") {
      continue;
    }

    const incompatibleShortFlag = firstIncompatibleShortFlag(
      arg,
      incompatibleShortFlags,
      shortValueFlags,
    );
    if (incompatibleShortFlag !== null) {
      return incompatibleShortFlag;
    }

    const lastFlag = arg.at(-1);
    if (arg.length === 2 && lastFlag !== undefined && shortValueFlags.has(lastFlag)) {
      skipNext = true;
    }
  }

  return null;
}

function firstIncompatibleShortFlag(
  arg: string,
  incompatibleShortFlags: ReadonlySet<string>,
  shortValueFlags: ReadonlySet<string>,
): string | null {
  for (let index = 1; index < arg.length; index += 1) {
    const flag = arg[index];
    if (flag === undefined) {
      continue;
    }

    if (incompatibleShortFlags.has(flag)) {
      return `-${flag}`;
    }

    if (shortValueFlags.has(flag)) {
      return null;
    }
  }

  return null;
}

function installPipeHandlers(): void {
  if (pipeHandlersInstalled) {
    return;
  }

  pipeHandlersInstalled = true;
  process.stdout.on("error", handlePipeError);
  process.stderr.on("error", handlePipeError);
}

function handlePipeError(error: NodeJS.ErrnoException): void {
  if (isClosedPipeError(error)) {
    process.exit(0);
  }

  throw error;
}

function writeStdout(text: string): void {
  writeStream(process.stdout, text);
}

function writeStderr(text: string): void {
  writeStream(process.stderr, text);
}

function writeStream(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text);
  } catch (error) {
    if (isClosedPipeError(error)) {
      process.exit(0);
    }

    throw error;
  }
}

function isClosedPipeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPIPE" || error.code === "ENOTCONN")
  );
}

function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json does not contain a version string");
  }

  return packageJson.version;
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
  RGK_MODEL                   Codex model (default: gpt-5.4-mini)
  RGK_REASONING_EFFORT        Codex reasoning effort (default: medium)
  RGK_PROMPT_MAX_BYTES        Max prompt bytes per Codex request (default: 400000)
  RGK_TOTAL_PROMPT_MAX_BYTES  Max total keep prompt bytes processed (default: 4000000)
  RGK_PROMPT_LINE_MAX_BYTES   Max matched-line bytes sent per candidate (default: 600, min: 4)
  RGK_OUTPUT_LINE_MAX_BYTES   Max matched-line bytes printed per result (default: 300, min: 4)
  RGK_CODEX_CONCURRENCY       Max concurrent Codex requests (default: 4)
  RGK_DEBUG                   Print Codex diagnostics when set to 1 or true

Use rg --help for ripgrep options. Use --rgk-help or --rgk-version for wrapper-only output.
`;
