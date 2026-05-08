export type Candidate = {
  readonly id: string;
  readonly output: string;
  readonly promptLine: string;
};

const maxPromptBodyBytes = 2_000;
const promptContextBytes = 800;

type RgJsonEvent = {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly lines?: { readonly text?: string };
    readonly line_number?: number;
    readonly submatches?: readonly { readonly start?: number; readonly end?: number }[];
  };
};

export function parseRgJson(stdout: string): readonly Candidate[] {
  const candidates: Candidate[] = [];
  let nextId = 1;

  for (const line of stdout.split("\n")) {
    const candidate = parseRgJsonLine(line, nextId);
    if (candidate === null) {
      continue;
    }

    candidates.push(candidate);
    nextId += 1;
  }

  return candidates;
}

export function parseRgJsonLine(line: string, nextId: number): Candidate | null {
  if (line.length === 0) {
    return null;
  }

  let event: RgJsonEvent;
  try {
    event = JSON.parse(line) as RgJsonEvent;
  } catch {
    return null;
  }

  if (event.type !== "match") {
    return null;
  }

  const path = event.data?.path?.text;
  const text = event.data?.lines?.text;
  const lineNumber = event.data?.line_number;
  if (path === undefined || text === undefined || lineNumber === undefined) {
    return null;
  }

  const firstMatch = event.data?.submatches?.[0];
  const matchStart = firstMatch?.start ?? 0;
  const matchEnd = firstMatch?.end ?? matchStart;
  const column = matchStart + 1;
  const body = normalizeLineText(text);
  const output = `${path}:${lineNumber}:${column}:${body}`;
  const promptOutput = `${path}:${lineNumber}:${column}:${summarizeForPrompt(
    body,
    matchStart,
    matchEnd,
  )}`;
  const id = `m${nextId.toString(36)}`;

  return { id, output, promptLine: `${id} ${promptOutput}` };
}

export function orderCandidates(
  candidates: readonly Candidate[],
  rankedIds: string,
): readonly Candidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const ordered: Candidate[] = [];

  for (const id of rankedIds.trim().split(/\s+/u)) {
    if (id === "" || seen.has(id)) {
      continue;
    }

    seen.add(id);
    const candidate = byId.get(id);
    if (candidate !== undefined) {
      ordered.push(candidate);
    }
  }

  return ordered;
}

function normalizeLineText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\n$/u, "")
    .replaceAll("\n", "\\n");
}

function summarizeForPrompt(body: string, matchStart: number, matchEnd: number): string {
  if (byteLength(body) <= maxPromptBodyBytes) {
    return body;
  }

  const safeMatchStart = clamp(matchStart, 0, body.length);
  const safeMatchEnd = clamp(Math.max(matchEnd, safeMatchStart), safeMatchStart, body.length);
  const matchText = body.slice(safeMatchStart, safeMatchEnd);

  if (byteLength(matchText) >= maxPromptBodyBytes) {
    return `${truncateEndByBytes(matchText, maxPromptBodyBytes - byteLength("...[truncated]"))}...[truncated]`;
  }

  const prefixBudget = Math.min(
    promptContextBytes,
    Math.floor((maxPromptBodyBytes - byteLength(matchText)) / 2),
  );
  const suffixBudget = maxPromptBodyBytes - byteLength(matchText) - prefixBudget;
  const prefix = truncateStartByBytes(body.slice(0, safeMatchStart), prefixBudget);
  const suffix = truncateEndByBytes(body.slice(safeMatchEnd), suffixBudget);
  const prefixMarker =
    byteLength(body.slice(0, safeMatchStart)) > byteLength(prefix) ? "...[truncated]" : "";
  const suffixMarker =
    byteLength(body.slice(safeMatchEnd)) > byteLength(suffix) ? "...[truncated]" : "";

  return truncateEndByBytes(
    `${prefixMarker}${prefix}${matchText}${suffix}${suffixMarker}`,
    maxPromptBodyBytes,
  );
}

function truncateStartByBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  let result = "";
  const chars = Array.from(value);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    if (char === undefined) {
      continue;
    }

    const next = `${char}${result}`;
    if (byteLength(next) > maxBytes) {
      return result;
    }
    result = next;
  }

  return result;
}

function truncateEndByBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  let result = "";
  for (const char of value) {
    const next = `${result}${char}`;
    if (byteLength(next) > maxBytes) {
      return result;
    }
    result = next;
  }

  return result;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
