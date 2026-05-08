export type Candidate = {
  readonly id: string;
  readonly output: string;
  readonly promptLine: string;
};

export type CandidatePresentation = {
  readonly promptLineMaxBytes: number;
  readonly outputLineMaxBytes: number;
};

const defaultPresentation: CandidatePresentation = {
  promptLineMaxBytes: 600,
  outputLineMaxBytes: 300,
};

const contextRatio = 0.4;

type RgJsonText = {
  readonly text?: string;
  readonly bytes?: string;
};

type DecodedRgJsonText = {
  readonly text: string;
  readonly stringIndexForByteOffset: (byteOffset: number) => number;
};

type RgJsonEvent = {
  readonly type?: string;
  readonly data?: {
    readonly path?: RgJsonText;
    readonly lines?: RgJsonText;
    readonly line_number?: number;
    readonly submatches?: readonly { readonly start?: number; readonly end?: number }[];
  };
};

type MatchSpan = {
  readonly startBytes: number;
  readonly start: number;
  readonly end: number;
};

type NormalizedLine = {
  readonly text: string;
  readonly stringIndexForRawIndex: (rawIndex: number) => number;
};

export function parseRgJson(
  stdout: string,
  presentation: CandidatePresentation = defaultPresentation,
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  let nextId = 1;

  for (const line of stdout.split("\n")) {
    const lineCandidates = parseRgJsonLine(line, nextId, Number.POSITIVE_INFINITY, presentation);
    candidates.push(...lineCandidates);
    nextId += lineCandidates.length;
  }

  return candidates;
}

export function parseRgJsonLine(
  line: string,
  nextId: number,
  maxCandidates = Number.POSITIVE_INFINITY,
  presentation: CandidatePresentation = defaultPresentation,
): readonly Candidate[] {
  if (line.length === 0 || maxCandidates <= 0) {
    return [];
  }

  let event: RgJsonEvent;
  try {
    event = JSON.parse(line) as RgJsonEvent;
  } catch {
    return [];
  }

  if (event.type !== "match") {
    return [];
  }

  const path = decodeRgJsonText(event.data?.path);
  const matchedLine = decodeRgJsonText(event.data?.lines);
  const lineNumber = event.data?.line_number;
  if (path === null || matchedLine === null || lineNumber === undefined) {
    return [];
  }

  const submatches = event.data?.submatches;
  const matches =
    submatches === undefined || submatches.length === 0 ? [{ start: 0, end: 0 }] : submatches;
  const body = normalizeLineText(matchedLine.text);
  const matchSpan = spanForMatches(matches, matchedLine.stringIndexForByteOffset);
  if (matchSpan === null) {
    return [];
  }

  const matchStart = body.stringIndexForRawIndex(matchSpan.start);
  const matchEnd = body.stringIndexForRawIndex(matchSpan.end);
  const column = matchSpan.startBytes + 1;
  const outputBody = summarizeAroundMatch(body.text, matchStart, matchEnd, {
    maxBytes: presentation.outputLineMaxBytes,
    contextBytes: contextBytesFor(presentation.outputLineMaxBytes),
  });
  const promptBody = summarizeAroundMatch(body.text, matchStart, matchEnd, {
    maxBytes: presentation.promptLineMaxBytes,
    contextBytes: contextBytesFor(presentation.promptLineMaxBytes),
  });
  const output = `${path.text}:${lineNumber}:${column}:${outputBody}`;
  const promptOutput = `${path.text}:${lineNumber}:${column}:${promptBody}`;
  const id = `m${nextId.toString(36)}`;

  return [{ id, output, promptLine: `${id} ${promptOutput}` }];
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

function decodeRgJsonText(value: RgJsonText | undefined): DecodedRgJsonText | null {
  if (value?.text !== undefined) {
    const text = value.text;
    return {
      text,
      stringIndexForByteOffset: (byteOffset) => byteOffsetToStringIndex(text, byteOffset),
    };
  }

  if (value?.bytes !== undefined) {
    const bytes = Buffer.from(value.bytes, "base64");
    return {
      text: bytes.toString("utf8"),
      stringIndexForByteOffset: (byteOffset) =>
        bytes.subarray(0, clamp(byteOffset, 0, bytes.length)).toString("utf8").length,
    };
  }

  return null;
}

function normalizeLineText(text: string): NormalizedLine {
  const indexMap = Array.from<number>({ length: text.length + 1 });
  let normalized = "";
  let rawIndex = 0;

  indexMap[0] = 0;
  while (rawIndex < text.length) {
    const char = text[rawIndex];
    if (char === undefined) {
      break;
    }

    if (char === "\r" || char === "\n") {
      const nextIndex = char === "\r" && text[rawIndex + 1] === "\n" ? rawIndex + 2 : rawIndex + 1;
      if (nextIndex < text.length) {
        normalized += "\\n";
      }
      for (let index = rawIndex + 1; index <= nextIndex; index += 1) {
        indexMap[index] = normalized.length;
      }
      rawIndex = nextIndex;
      continue;
    }

    normalized += char;
    rawIndex += 1;
    indexMap[rawIndex] = normalized.length;
  }

  return {
    text: normalized,
    stringIndexForRawIndex: (rawStringIndex) =>
      indexMap[clamp(rawStringIndex, 0, text.length)] ?? normalized.length,
  };
}

function spanForMatches(
  matches: readonly { readonly start?: number; readonly end?: number }[],
  stringIndexForByteOffset: (byteOffset: number) => number,
): MatchSpan | null {
  let startBytes: number | null = null;
  let start: number | null = null;
  let end: number | null = null;

  for (const match of matches) {
    const matchStartBytes = Math.max(match.start ?? 0, 0);
    const matchEndBytes = Math.max(match.end ?? matchStartBytes, matchStartBytes);
    const matchStart = stringIndexForByteOffset(matchStartBytes);
    const matchEnd = stringIndexForByteOffset(matchEndBytes);

    startBytes = startBytes === null ? matchStartBytes : Math.min(startBytes, matchStartBytes);
    start = start === null ? matchStart : Math.min(start, matchStart);
    end = end === null ? matchEnd : Math.max(end, matchEnd);
  }

  if (startBytes === null || start === null || end === null) {
    return null;
  }

  return { startBytes, start, end };
}

function contextBytesFor(maxBytes: number): number {
  return Math.floor(maxBytes * contextRatio);
}

function summarizeAroundMatch(
  body: string,
  matchStart: number,
  matchEnd: number,
  options: { readonly maxBytes: number; readonly contextBytes: number },
): string {
  if (byteLength(body) <= options.maxBytes) {
    return body;
  }

  const safeMatchStart = clamp(matchStart, 0, body.length);
  const safeMatchEnd = clamp(Math.max(matchEnd, safeMatchStart), safeMatchStart, body.length);
  const matchText = body.slice(safeMatchStart, safeMatchEnd);
  const matchBytes = byteLength(matchText);
  const truncationMarker = "...";

  if (matchBytes > options.maxBytes) {
    return summarizeLongMatch(matchText, options.maxBytes, truncationMarker);
  }

  const remainingBytes = options.maxBytes - matchBytes;
  const prefix = summarizePrefix(
    body.slice(0, safeMatchStart),
    Math.min(options.contextBytes, Math.floor(remainingBytes / 2)),
  );
  const suffix = summarizeSuffix(
    body.slice(safeMatchEnd),
    Math.min(options.contextBytes, remainingBytes - byteLength(prefix)),
  );

  return `${prefix}${matchText}${suffix}`;
}

function summarizePrefix(value: string, maxBytes: number): string {
  return summarizeSide(value, maxBytes, truncateStartByBytes, (text, marker) => `${marker}${text}`);
}

function summarizeSuffix(value: string, maxBytes: number): string {
  return summarizeSide(value, maxBytes, truncateEndByBytes, (text, marker) => `${text}${marker}`);
}

function summarizeLongMatch(value: string, maxBytes: number, marker: string): string {
  const markerBytes = byteLength(marker);
  if (maxBytes <= markerBytes) {
    return truncateEndByBytes(value, maxBytes);
  }

  const remainingBytes = maxBytes - markerBytes;
  const prefixBytes = Math.ceil(remainingBytes / 2);
  const suffixBytes = remainingBytes - prefixBytes;
  return `${truncateEndByBytes(value, prefixBytes)}${marker}${truncateStartByBytes(
    value,
    suffixBytes,
  )}`;
}

function summarizeSide(
  value: string,
  maxBytes: number,
  truncate: (value: string, maxBytes: number) => string,
  formatTruncated: (text: string, marker: string) => string,
): string {
  if (value === "" || maxBytes <= 0) {
    return "";
  }

  if (byteLength(value) <= maxBytes) {
    return value;
  }

  const truncationMarker = "...";
  const markerBytes = byteLength(truncationMarker);
  if (maxBytes <= markerBytes) {
    return "";
  }

  return formatTruncated(truncate(value, maxBytes - markerBytes), truncationMarker);
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

function byteOffsetToStringIndex(value: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }

  let bytesSeen = 0;
  let stringIndex = 0;
  for (const char of value) {
    const nextBytesSeen = bytesSeen + byteLength(char);
    if (nextBytesSeen > byteOffset) {
      return stringIndex;
    }

    bytesSeen = nextBytesSeen;
    stringIndex += char.length;
    if (bytesSeen === byteOffset) {
      return stringIndex;
    }
  }

  return value.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
