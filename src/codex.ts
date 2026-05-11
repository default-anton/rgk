import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "./candidates.js";
import type { Config } from "./config.js";
import { batchCandidates, buildPromptText, promptBytes, totalPromptBytes } from "./prompt.js";
import { runCaptured } from "./process.js";

export { batchCandidates, fixedPromptBytes, promptBytes, totalPromptBytes } from "./prompt.js";

const schema = {
  type: "object",
  properties: {
    ranked_ids: {
      type: "string",
      description:
        "Space-separated match IDs ordered from most relevant to least relevant. Return an empty string if no matches are relevant.",
      pattern: "^$|^[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$",
    },
  },
  required: ["ranked_ids"],
  additionalProperties: false,
};

const instructions = `You are filtering ripgrep results.

Return only IDs whose result satisfies the user's condition.
Rank strongest, most direct matches first.
Prefer precise evidence in the matched line over weak contextual guesses.
If nothing satisfies the condition, return no IDs.

Output must match the JSON schema exactly.`;

type CodexResponse = {
  readonly ranked_ids?: unknown;
};

type CodexInputFiles = {
  readonly schemaPath: string;
  readonly instructionsPath: string;
};

export async function rankCandidates(
  condition: string,
  candidates: readonly Candidate[],
  config: Config,
): Promise<string> {
  const batches = batchCandidates(condition, candidates, config.promptMaxBytes);
  const totalBytes = totalPromptBytes(condition, batches);
  if (totalBytes > config.totalPromptMaxBytes) {
    throw new Error(
      `keep input is ${totalBytes} bytes, above RGK_TOTAL_PROMPT_MAX_BYTES=${config.totalPromptMaxBytes}. Narrow the rg query or raise RGK_TOTAL_PROMPT_MAX_BYTES.`,
    );
  }

  const rankedByBatch = await mapConcurrent(batches, config.codexConcurrency, (batch, signal) =>
    rankCandidateBatch(condition, batch, config, signal),
  );

  return rankedByBatch.filter((rankedIds) => rankedIds !== "").join(" ");
}

async function rankCandidateBatch(
  condition: string,
  candidates: readonly Candidate[],
  config: Config,
  signal: AbortSignal,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rgk-"));
  const outputPath = join(directory, "out.json");

  try {
    const { schemaPath, instructionsPath } = await materializeCodexInputFiles(directory);
    const prompt = buildPrompt(condition, candidates, config.promptMaxBytes);
    const result = await runCaptured(
      config.codexPath,
      [
        "exec",
        "--model",
        config.model,
        "-c",
        'web_search="disabled"',
        "-c",
        `model_reasoning_effort=${config.reasoningEffort}`,
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-rules",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "-c",
        `model_instructions_file=${instructionsPath}`,
        "--output-last-message",
        outputPath,
        "--color",
        "never",
        "-",
      ],
      { input: prompt, timeoutMs: config.timeoutMs, signal },
    );

    if (config.debug && result.stderr !== "") {
      process.stderr.write(result.stderr);
    }

    if (result.timedOut) {
      throw new Error(`codex timed out after RGK_CODEX_TIMEOUT_MS=${config.timeoutMs}`);
    }

    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `codex exited ${result.code}`,
      );
    }

    const rawOutput = await readFile(outputPath, "utf8").catch(() => result.stdout);
    return keepBatchRankedIds(parseRankedIds(rawOutput), candidates);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function materializeCodexInputFiles(directory: string): Promise<CodexInputFiles> {
  const schemaPath = join(directory, "schema.json");
  const instructionsPath = join(directory, "system.md");

  await Promise.all([
    writeFile(schemaPath, `${JSON.stringify(schema)}\n`, "utf8"),
    writeFile(instructionsPath, instructions, "utf8"),
  ]);

  return { schemaPath, instructionsPath };
}

export function buildPrompt(
  condition: string,
  candidates: readonly Candidate[],
  maxBytes = 400_000,
): string {
  const prompt = buildPromptText(condition, candidates);
  const bytes = promptBytes(condition, candidates);
  if (bytes > maxBytes) {
    throw new Error(
      `keep prompt is ${bytes} bytes, above RGK_PROMPT_MAX_BYTES=${maxBytes}. Narrow the rg query, lower RGK_PROMPT_LINE_MAX_BYTES, or raise RGK_PROMPT_MAX_BYTES.`,
    );
  }

  return prompt;
}

async function mapConcurrent<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, signal: AbortSignal) => Promise<U>,
): Promise<readonly U[]> {
  const controller = new AbortController();
  const results = Array.from<U | undefined>({ length: items.length });
  let nextIndex = 0;
  let firstError: unknown;

  function worker(): Promise<void> {
    if (controller.signal.aborted || nextIndex >= items.length) {
      return Promise.resolve();
    }

    const index = nextIndex;
    nextIndex += 1;
    const item = items[index];
    if (item === undefined) {
      return worker();
    }

    return fn(item, controller.signal).then(
      (result) => {
        results[index] = result;
        return worker();
      },
      (error: unknown) => {
        firstError ??= error;
        controller.abort();
      },
    );
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  if (firstError !== undefined) {
    throw firstError;
  }

  return results.map((result) => {
    if (result === undefined) {
      throw new Error("concurrent codex ranking did not produce a result");
    }

    return result;
  });
}

function keepBatchRankedIds(rankedIds: string, candidates: readonly Candidate[]): string {
  const batchIds = new Set(candidates.map((candidate) => candidate.id));
  return rankedIds
    .trim()
    .split(/\s+/u)
    .filter((id) => batchIds.has(id))
    .join(" ");
}

function parseRankedIds(rawOutput: string): string {
  const response = JSON.parse(rawOutput) as CodexResponse;
  if (typeof response.ranked_ids !== "string") {
    throw new Error("codex response did not contain ranked_ids string");
  }

  return response.ranked_ids;
}
