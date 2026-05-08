import { spawn } from "node:child_process";
import { parseRgJsonLine, type Candidate } from "./candidates.js";

export type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RgCandidatesResult = {
  readonly code: number;
  readonly stderr: string;
  readonly candidates: readonly Candidate[];
  readonly limitExceeded: boolean;
};

export function runCaptured(
  command: string,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly timeoutMs?: number;
    readonly inheritStdin?: boolean;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdioForInput(options), "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setProcessTimeout(child, options.timeoutMs, () => settled);

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
      reject(error);
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearProcessTimeout(timeout);
      resolve({ code: code ?? signalToCode(signal), stdout, stderr });
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
  keepLimit: number,
): Promise<RgCandidatesResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    const candidates: Candidate[] = [];
    let stderr = "";
    let pending = "";
    let nextId = 1;
    let limitExceeded = false;

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream === null || stderrStream === null) {
      child.kill("SIGTERM");
      reject(new Error("failed to capture rg output"));
      return;
    }

    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const remainingCandidates = keepLimit + 1 - candidates.length;
        const lineCandidates = parseRgJsonLine(line, nextId, remainingCandidates);
        if (lineCandidates.length > 0) {
          candidates.push(...lineCandidates);
          nextId += lineCandidates.length;
          if (candidates.length > keepLimit) {
            limitExceeded = true;
            child.kill("SIGTERM");
            return;
          }
        }
        newlineIndex = pending.indexOf("\n");
      }
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (!limitExceeded && pending !== "") {
        const remainingCandidates = keepLimit + 1 - candidates.length;
        const lineCandidates = parseRgJsonLine(pending, nextId, remainingCandidates);
        if (lineCandidates.length > 0) {
          candidates.push(...lineCandidates);
          limitExceeded = candidates.length > keepLimit;
        }
      }

      resolve({
        code: limitExceeded ? 0 : (code ?? signalToCode(signal)),
        stderr,
        candidates,
        limitExceeded,
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
): NodeJS.Timeout | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }

  const timeout = setTimeout(() => {
    if (isSettled()) {
      return;
    }

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
