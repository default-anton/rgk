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

  let rgResult;
  try {
    rgResult = await runRgCandidates(
      config.rgPath,
      withKeepRgFlags(parsed.rgArgs),
      config.keepLimit,
    );
  } catch (error) {
    writeStderr(`rgk: ${formatSpawnError("rg", error)}\n`);
    return 2;
  }

  if (rgResult.stderr !== "") {
    writeStderr(rgResult.stderr);
  }

  if (rgResult.limitExceeded) {
    writeStderr(
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

function installPipeHandlers(): void {
  if (pipeHandlersInstalled) {
    return;
  }

  pipeHandlersInstalled = true;
  process.stdout.on("error", handlePipeError);
  process.stderr.on("error", handlePipeError);
}

function handlePipeError(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") {
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
    if (isEpipe(error)) {
      process.exit(0);
    }

    throw error;
  }
}

function isEpipe(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPIPE";
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
  RGK_MODEL              Codex model (default: gpt-5.3-codex-spark)
  RGK_REASONING_EFFORT   Codex reasoning effort (default: low)
  RGK_KEEP_LIMIT         Max candidates sent to Codex (default: 300)
  RGK_PROMPT_MAX_BYTES   Max prompt bytes sent to Codex (default: 180000)
  RGK_DEBUG              Print Codex diagnostics when set to 1 or true

Use rg --help for ripgrep options. Use --rgk-help or --rgk-version for wrapper-only output.
`;
