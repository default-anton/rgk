export type Candidate = {
  readonly id: string;
  readonly output: string;
  readonly promptLine: string;
};

type RgJsonEvent = {
  readonly type?: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly lines?: { readonly text?: string };
    readonly line_number?: number;
    readonly submatches?: readonly { readonly start?: number }[];
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

  const column = (event.data?.submatches?.[0]?.start ?? 0) + 1;
  const body = normalizeLineText(text);
  const output = `${path}:${lineNumber}:${column}:${body}`;
  const id = `m${nextId.toString(36)}`;

  return { id, output, promptLine: `${id} ${output}` };
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
