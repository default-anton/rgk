export type Config = KeepConfig & {
  readonly rgPath: string;
};

export type KeepConfig = {
  readonly codexPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly keepLimit: number;
  readonly promptMaxBytes: number;
  readonly timeoutMs: number;
  readonly debug: boolean;
};

export function loadRgPath(env: NodeJS.ProcessEnv): string {
  return env.RGK_RG_PATH ?? "rg";
}

export function loadKeepConfig(env: NodeJS.ProcessEnv): KeepConfig {
  return {
    codexPath: env.RGK_CODEX_PATH ?? "codex",
    model: env.RGK_MODEL ?? "gpt-5.3-codex-spark",
    reasoningEffort: env.RGK_REASONING_EFFORT ?? "low",
    keepLimit: readPositiveInteger(env.RGK_KEEP_LIMIT, 300, "RGK_KEEP_LIMIT"),
    promptMaxBytes: readPositiveInteger(env.RGK_PROMPT_MAX_BYTES, 180_000, "RGK_PROMPT_MAX_BYTES"),
    timeoutMs: readPositiveInteger(env.RGK_CODEX_TIMEOUT_MS, 300_000, "RGK_CODEX_TIMEOUT_MS"),
    debug: env.RGK_DEBUG === "1" || env.RGK_DEBUG === "true",
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return { rgPath: loadRgPath(env), ...loadKeepConfig(env) };
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed.toString() !== value) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
