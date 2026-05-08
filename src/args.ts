export type ParsedArgs =
  | { readonly keep: null; readonly rgArgs: readonly string[] }
  | { readonly keep: string; readonly rgArgs: readonly string[] };

export function parseArgs(args: readonly string[]): ParsedArgs {
  const rgArgs: string[] = [];
  let keep: string | null = null;
  let afterTerminator = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (afterTerminator) {
      rgArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      afterTerminator = true;
      rgArgs.push(arg);
      continue;
    }

    if (arg === "--keep") {
      if (keep !== null) {
        throw new UsageError("--keep can only be provided once");
      }

      const value = args[index + 1];
      if (value === undefined) {
        throw new UsageError("--keep requires a condition");
      }

      keep = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--keep=")) {
      if (keep !== null) {
        throw new UsageError("--keep can only be provided once");
      }

      keep = arg.slice("--keep=".length);
      continue;
    }

    rgArgs.push(arg);
  }

  if (keep === null) {
    return { keep: null, rgArgs };
  }

  if (keep.trim() === "") {
    throw new UsageError("--keep condition cannot be empty");
  }

  return { keep, rgArgs };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
