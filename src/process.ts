import { spawn } from "node:child_process";
import { parseRgJsonLine, type Candidate, type CandidatePresentation } from "./candidates.js";
import { createPromptBudgetTracker, type PromptBudgetFailure } from "./prompt.js";

export type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type RgCandidatesResult = {
  readonly code: number;
  readonly stderr: string;
  readonly candidates: readonly Candidate[];
  readonly promptBudgetExceeded: PromptBudgetFailure | null;
};

export type RgCandidateBudget = {
  readonly condition: string;
  readonly perRequestMaxBytes: number;
  readonly totalMaxBytes: number;
};

export function runCaptured(
  command: string,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly timeoutMs?: number;
    readonly inheritStdin?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdioForInput(options), "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeout = setProcessTimeout(
      child,
      options.timeoutMs,
      () => settled,
      () => {
        timedOut = true;
      },
    );

    let abortKillTimeout: NodeJS.Timeout | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      abortKillTimeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
      abortKillTimeout.unref();
    };
    if (options.signal?.aborted === true) {
      abort();
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (stdoutStream === null || stderrStream === null) {
      child.kill("SIGTERM");
      reject(new Error("failed to capture child process output"));
      return;
    }

    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settled = true;
      clearProcessTimeout(timeout);
      clearProcessTimeout(abortKillTimeout);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("exit", () => {
      settled = true;
    });
    child.on("close", (code, signal) => {
      clearProcessTimeout(timeout);
      clearProcessTimeout(abortKillTimeout);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code: code ?? signalToCode(signal), stdout, stderr, timedOut });
    });

    if (options.input !== undefined) {
      if (stdinStream === null) {
        child.kill("SIGTERM");
        reject(new Error("failed to write child process input"));
        return;
      }

      stdinStream.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") {
          return;
        }

        settled = true;
        clearProcessTimeout(timeout);
        reject(error);
      });
      stdinStream.end(options.input);
    }
  });
}

export function runRgCandidates(
  command: string,
  args: readonly string[],
  budget: RgCandidateBudget,
  presentation: CandidatePresentation,
): Promise<RgCandidatesResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    const candidates: Candidate[] = [];
    let stderr = "";
    let pending = "";
    let nextId = 1;
    let promptBudgetExceeded: PromptBudgetFailure | null = null;
    const promptBudget = createPromptBudgetTracker(budget.condition, {
      perRequestMaxBytes: budget.perRequestMaxBytes,
      totalMaxBytes: budget.totalMaxBytes,
    });

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream === null || stderrStream === null) {
      child.kill("SIGTERM");
      reject(new Error("failed to capture rg output"));
      return;
    }

    const addCandidates = (lineCandidates: readonly Candidate[]): boolean => {
      for (const candidate of lineCandidates) {
        const budgetResult = promptBudget.add(candidate);
        if (!budgetResult.ok) {
          promptBudgetExceeded = budgetResult.reason;
          child.kill("SIGTERM");
          return false;
        }

        candidates.push(candidate);
        nextId += 1;
      }

      return true;
    };

    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const lineCandidates = parseRgJsonLine(
          line,
          nextId,
          Number.POSITIVE_INFINITY,
          presentation,
        );
        if (!addCandidates(lineCandidates)) {
          return;
        }
        newlineIndex = pending.indexOf("\n");
      }
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (promptBudgetExceeded === null && pending !== "") {
        const lineCandidates = parseRgJsonLine(
          pending,
          nextId,
          Number.POSITIVE_INFINITY,
          presentation,
        );
        addCandidates(lineCandidates);
      }

      resolve({
        code: promptBudgetExceeded === null ? (code ?? signalToCode(signal)) : 0,
        stderr,
        candidates,
        promptBudgetExceeded,
      });
    });
  });
}

export function execInherited(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? signalToCode(signal)));
  });
}

export function isSpawnError(error: unknown): boolean {
  return error instanceof Error && "code" in error;
}

export function formatSpawnError(tool: string, error: unknown): string {
  if (error instanceof Error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ENOENT") {
      return `failed to run ${tool}: executable not found`;
    }

    return `failed to run ${tool}: ${error.message}`;
  }

  return `failed to run ${tool}: ${String(error)}`;
}

function stdioForInput(options: {
  readonly input?: string;
  readonly inheritStdin?: boolean;
}): "ignore" | "pipe" | "inherit" {
  if (options.input !== undefined) {
    return "pipe";
  }

  return options.inheritStdin === true ? "inherit" : "ignore";
}

function setProcessTimeout(
  child: ReturnType<typeof spawn>,
  timeoutMs: number | undefined,
  isSettled: () => boolean,
  onTimeout: () => void,
): NodeJS.Timeout | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }

  const timeout = setTimeout(() => {
    if (isSettled()) {
      return;
    }

    onTimeout();
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
  }, timeoutMs);
  timeout.unref();
  return timeout;
}

function clearProcessTimeout(timeout: NodeJS.Timeout | undefined): void {
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}

function signalToCode(signal: NodeJS.Signals | null): number {
  if (signal === null) {
    return 1;
  }

  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  return 1;
}
