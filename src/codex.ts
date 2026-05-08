import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "./candidates.js";
import type { Config } from "./config.js";
import { runCaptured } from "./process.js";

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

export async function rankCandidates(
  condition: string,
  candidates: readonly Candidate[],
  config: Config,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rgk-"));
  const schemaPath = join(directory, "schema.json");
  const instructionsPath = join(directory, "system.md");
  const outputPath = join(directory, "out.json");

  try {
    await writeFile(schemaPath, `${JSON.stringify(schema)}\n`, "utf8");
    await writeFile(instructionsPath, instructions, "utf8");

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
      { input: prompt, timeoutMs: config.timeoutMs },
    );

    if (config.debug && result.stderr !== "") {
      process.stderr.write(result.stderr);
    }

    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || `codex exited ${result.code}`,
      );
    }

    const rawOutput = await readFile(outputPath, "utf8").catch(() => result.stdout);
    return parseRankedIds(rawOutput);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function buildPrompt(
  condition: string,
  candidates: readonly Candidate[],
  maxBytes = 180_000,
): string {
  const prompt = `Condition:\n${condition}\n\nCandidates:\n${candidates.map((candidate) => candidate.promptLine).join("\n")}\n`;
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `keep prompt is ${bytes} bytes, above RGK_PROMPT_MAX_BYTES=${maxBytes}. Narrow the rg query, lower RGK_KEEP_LIMIT, or raise RGK_PROMPT_MAX_BYTES.`,
    );
  }

  return prompt;
}

function parseRankedIds(rawOutput: string): string {
  const response = JSON.parse(rawOutput) as CodexResponse;
  if (typeof response.ranked_ids !== "string") {
    throw new Error("codex response did not contain ranked_ids string");
  }

  return response.ranked_ids;
}
