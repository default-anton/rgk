import { spawn } from "node:child_process";

export type ProcessResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export function runCaptured(
  command: string,
  args: readonly string[],
  options: { readonly input?: string; readonly timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return;
            }

            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
          }, options.timeoutMs);

    timeout?.unref();

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
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve({ code: code ?? signalToCode(signal), stdout, stderr });
    });

    if (options.input !== undefined) {
      if (stdinStream === null) {
        child.kill("SIGTERM");
        reject(new Error("failed to write child process input"));
        return;
      }

      stdinStream.end(options.input);
    }
  });
}

export function execInherited(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? signalToCode(signal)));
  });
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
