export type Config = KeepConfig & {
  readonly rgPath: string;
};

export type KeepConfig = {
  readonly codexPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly promptMaxBytes: number;
  readonly totalPromptMaxBytes: number;
  readonly promptLineMaxBytes: number;
  readonly outputLineMaxBytes: number;
  readonly codexConcurrency: number;
  readonly timeoutMs: number;
  readonly debug: boolean;
};

export function loadRgPath(env: NodeJS.ProcessEnv): string {
  return env.RGK_RG_PATH ?? "rg";
}

const minLineMaxBytes = 4;

export function loadKeepConfig(env: NodeJS.ProcessEnv): KeepConfig {
  return {
    codexPath: env.RGK_CODEX_PATH ?? "codex",
    model: env.RGK_MODEL ?? "gpt-5.4-mini",
    reasoningEffort: env.RGK_REASONING_EFFORT ?? "none",
    promptMaxBytes: readPositiveInteger(env.RGK_PROMPT_MAX_BYTES, 400_000, "RGK_PROMPT_MAX_BYTES"),
    totalPromptMaxBytes: readPositiveInteger(
      env.RGK_TOTAL_PROMPT_MAX_BYTES,
      4_000_000,
      "RGK_TOTAL_PROMPT_MAX_BYTES",
    ),
    promptLineMaxBytes: readIntegerAtLeast(
      env.RGK_PROMPT_LINE_MAX_BYTES,
      600,
      minLineMaxBytes,
      "RGK_PROMPT_LINE_MAX_BYTES",
    ),
    outputLineMaxBytes: readIntegerAtLeast(
      env.RGK_OUTPUT_LINE_MAX_BYTES,
      300,
      minLineMaxBytes,
      "RGK_OUTPUT_LINE_MAX_BYTES",
    ),
    codexConcurrency: readPositiveInteger(env.RGK_CODEX_CONCURRENCY, 4, "RGK_CODEX_CONCURRENCY"),
    timeoutMs: readPositiveInteger(env.RGK_CODEX_TIMEOUT_MS, 300_000, "RGK_CODEX_TIMEOUT_MS"),
    debug: env.RGK_DEBUG === "1" || env.RGK_DEBUG === "true",
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return { rgPath: loadRgPath(env), ...loadKeepConfig(env) };
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  return readIntegerAtLeast(value, fallback, 1, name);
}

function readIntegerAtLeast(
  value: string | undefined,
  fallback: number,
  minimum: number,
  name: string,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed.toString() !== value) {
    const requirement = minimum === 1 ? "a positive integer" : `an integer >= ${minimum}`;
    throw new Error(`${name} must be ${requirement}`);
  }

  return parsed;
}
