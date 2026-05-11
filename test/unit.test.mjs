import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, UsageError } from "../dist/args.js";
import { orderCandidates, parseRgJson, parseRgJsonLine } from "../dist/candidates.js";
import { firstKeepIncompatibleRgFlag, withKeepRgFlags } from "../dist/cli.js";
import { batchCandidates, buildPrompt, promptBytes, totalPromptBytes } from "../dist/codex.js";
import { loadKeepConfig, loadRgPath } from "../dist/config.js";

test("parseArgs passes through normal rg args", () => {
  assert.deepEqual(parseArgs(["foo", "src", "-n"]), {
    keep: null,
    rgArgs: ["foo", "src", "-n"],
  });
});

test("parseArgs removes --keep and condition", () => {
  assert.deepEqual(parseArgs(["foo", "--keep", "mentions auth", "src"]), {
    keep: "mentions auth",
    rgArgs: ["foo", "src"],
  });
});

test("parseArgs supports --keep=value", () => {
  assert.deepEqual(parseArgs(["foo", "--keep=mentions auth", "src"]), {
    keep: "mentions auth",
    rgArgs: ["foo", "src"],
  });
});

test("parseArgs respects argument terminator", () => {
  assert.deepEqual(parseArgs(["--", "--keep", "literal"]), {
    keep: null,
    rgArgs: ["--", "--keep", "literal"],
  });
});

test("parseArgs rejects missing or duplicate keep", () => {
  assert.throws(() => parseArgs(["foo", "--keep"]), UsageError);
  assert.throws(() => parseArgs(["foo", "--keep", "a", "--keep", "b"]), UsageError);
});

test("parseRgJson converts rg match events to stable candidates", () => {
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text: "const token = getToken();\n" },
      line_number: 7,
      submatches: [{ start: 6 }],
    },
  })}\n${JSON.stringify({ type: "summary", data: {} })}\n`;

  assert.deepEqual(parseRgJson(stdout), [
    {
      id: "m1",
      output: "src/app.ts:7:7:const token = getToken();",
      promptLine: "m1 src/app.ts:7:7:const token = getToken();",
    },
  ]);
});

test("orderCandidates follows ranked_ids, ignores unknown IDs, and dedupes", () => {
  const candidates = [
    { id: "m1", output: "one", promptLine: "m1 one" },
    { id: "m2", output: "two", promptLine: "m2 two" },
  ];

  assert.deepEqual(orderCandidates(candidates, "m2 missing m2 m1"), [candidates[1], candidates[0]]);
});

test("parseRgJson creates one candidate per matched line", () => {
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text: "foo foo\n" },
      line_number: 7,
      submatches: [
        { start: 0, end: 3 },
        { start: 4, end: 7 },
      ],
    },
  })}\n`;

  assert.deepEqual(parseRgJson(stdout), [
    {
      id: "m1",
      output: "src/app.ts:7:1:foo foo",
      promptLine: "m1 src/app.ts:7:1:foo foo",
    },
  ]);
});

test("parseRgJsonLine honors the candidate cap before summarizing same-line matches", () => {
  const line = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text: "foo foo foo\n" },
      line_number: 7,
      submatches: [
        { start: 0, end: 3 },
        { start: 4, end: 7 },
        { start: 8, end: 11 },
      ],
    },
  });

  assert.deepEqual(parseRgJsonLine(line, 10, 0), []);
  assert.deepEqual(parseRgJsonLine(line, 10, 1), [
    {
      id: "ma",
      output: "src/app.ts:7:1:foo foo foo",
      promptLine: "ma src/app.ts:7:1:foo foo foo",
    },
  ]);
});

test("parseRgJson truncates long prompt lines around the match", () => {
  const text = `${"a".repeat(5_000)}needle${"z".repeat(5_000)}\n`;
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text },
      line_number: 7,
      submatches: [{ start: 5_000, end: 5_006 }],
    },
  })}\n`;

  const [candidate] = parseRgJson(stdout);
  assert.equal(candidate.output.includes("needle"), true);
  assert.equal(candidate.promptLine.includes("needle"), true);
  assert.equal(Buffer.byteLength(candidate.output, "utf8") < 400, true);
  assert.equal(Buffer.byteLength(candidate.promptLine, "utf8") < 700, true);
});

test("parseRgJson accepts presentation budgets", () => {
  const text = `${"a".repeat(5_000)}needle${"z".repeat(5_000)}\n`;
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text },
      line_number: 7,
      submatches: [{ start: 5_000, end: 5_006 }],
    },
  })}\n`;

  const [candidate] = parseRgJson(stdout, { promptLineMaxBytes: 120, outputLineMaxBytes: 80 });
  assert.equal(candidate.output.includes("needle"), true);
  assert.equal(Buffer.byteLength(candidate.output, "utf8") < 120, true);
  assert.equal(Buffer.byteLength(candidate.promptLine, "utf8") < 160, true);
});

test("parseRgJson preserves matches that exactly fit the output budget", () => {
  const match = "x".repeat(300);
  const text = `a${match}z\n`;
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text },
      line_number: 7,
      submatches: [{ start: 1, end: 301 }],
    },
  })}\n`;

  const [candidate] = parseRgJson(stdout, { promptLineMaxBytes: 600, outputLineMaxBytes: 300 });
  assert.equal(candidate.output, `src/app.ts:7:2:${match}`);
});

test("parseRgJson maps ripgrep byte offsets before summarizing unicode lines", () => {
  const prefix = "é".repeat(5_000);
  const text = `${prefix}needle${"z".repeat(5_000)}\n`;
  const start = Buffer.byteLength(prefix, "utf8");
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text },
      line_number: 7,
      submatches: [{ start, end: start + 6 }],
    },
  })}\n`;

  const [candidate] = parseRgJson(stdout);
  assert.equal(candidate.promptLine.includes("needle"), true);
});

test("parseRgJson maps offsets after escaped newlines", () => {
  const prefix = `${"a\n".repeat(1_000)}`;
  const text = `${prefix}needle${"z".repeat(5_000)}\n`;
  const start = Buffer.byteLength(prefix, "utf8");
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text },
      line_number: 7,
      submatches: [{ start, end: start + 6 }],
    },
  })}\n`;

  const [candidate] = parseRgJson(stdout);
  assert.equal(candidate.output.includes("needle"), true);
  assert.equal(candidate.promptLine.includes("needle"), true);
});

test("parseRgJson keeps matches emitted with base64 bytes", () => {
  const rawLine = Buffer.from([0x66, 0x6f, 0x6f, 0x20, 0xff, 0x20, 0x62, 0x61, 0x72, 0x0a]);
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { bytes: Buffer.from("src/app.ts", "utf8").toString("base64") },
      lines: { bytes: rawLine.toString("base64") },
      line_number: 7,
      submatches: [{ start: 0, end: 3 }],
    },
  })}\n`;

  assert.deepEqual(parseRgJson(stdout), [
    {
      id: "m1",
      output: "src/app.ts:7:1:foo � bar",
      promptLine: "m1 src/app.ts:7:1:foo � bar",
    },
  ]);
});

test("parseRgJson prompt summaries preserve long matches before context", () => {
  const prefix = "a".repeat(5_000);
  const match = `${"M".repeat(1_980)}ENDMATCH`;
  const text = `${prefix}${match}${"z".repeat(5_000)}\n`;
  const stdout = `${JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text },
      line_number: 7,
      submatches: [{ start: prefix.length, end: prefix.length + match.length }],
    },
  })}\n`;

  const [candidate] = parseRgJson(stdout);
  assert.equal(candidate.output.includes("ENDMATCH"), true);
  assert.equal(candidate.promptLine.includes("ENDMATCH"), true);
  assert.equal(Buffer.byteLength(candidate.output, "utf8") < 400, true);
  assert.equal(Buffer.byteLength(candidate.promptLine, "utf8") < 700, true);
});

test("buildPrompt keeps condition and compact candidates", () => {
  assert.equal(
    buildPrompt("auth failures", [{ id: "m1", output: "a", promptLine: "m1 a" }]),
    "Condition:\nauth failures\n\nCandidates:\nm1 a\n",
  );
});

test("buildPrompt rejects prompts above the configured byte limit", () => {
  assert.throws(
    () => buildPrompt("auth failures", [{ id: "m1", output: "a", promptLine: "m1 a" }], 10),
    /RGK_PROMPT_MAX_BYTES/u,
  );
});

test("batchCandidates splits candidates by prompt byte limit", () => {
  const candidates = [
    { id: "m1", output: "a", promptLine: "m1 a" },
    { id: "m2", output: "b", promptLine: "m2 b" },
    { id: "m3", output: "c", promptLine: "m3 c" },
  ];
  const batches = batchCandidates("auth failures", candidates, 48);

  assert.deepEqual(
    batches.map((batch) => batch.map((candidate) => candidate.id)),
    [["m1", "m2"], ["m3"]],
  );
  assert.equal(
    totalPromptBytes("auth failures", batches),
    promptBytes("auth failures", candidates.slice(0, 2)) +
      promptBytes("auth failures", candidates.slice(2)),
  );
});

test("withKeepRgFlags inserts forced flags before option terminator", () => {
  assert.deepEqual(withKeepRgFlags(["foo", "src"]), ["foo", "src", "--json", "--color=never"]);
  assert.deepEqual(withKeepRgFlags(["-foo", "--", "file.txt"]), [
    "-foo",
    "--json",
    "--color=never",
    "--",
    "file.txt",
  ]);
});

test("firstKeepIncompatibleRgFlag detects rg output modes that bypass JSON", () => {
  assert.equal(firstKeepIncompatibleRgFlag(["foo", "-l"]), "-l");
  assert.equal(firstKeepIncompatibleRgFlag(["foo", "--count-matches"]), "--count-matches");
  assert.equal(firstKeepIncompatibleRgFlag(["foo", "--quiet"]), "--quiet");
  assert.equal(firstKeepIncompatibleRgFlag(["foo", "-nq"]), "-q");
  assert.equal(firstKeepIncompatibleRgFlag(["foo", "-n"]), null);
  assert.equal(firstKeepIncompatibleRgFlag(["-e", "-l"]), null);
  assert.equal(firstKeepIncompatibleRgFlag(["-e-l"]), null);
  assert.equal(firstKeepIncompatibleRgFlag(["--replace", "-l", "foo"]), null);
  assert.equal(firstKeepIncompatibleRgFlag(["--replace=-l", "foo"]), null);
  assert.equal(firstKeepIncompatibleRgFlag(["-r", "-l", "foo"]), null);
  assert.equal(firstKeepIncompatibleRgFlag(["-r-l", "foo"]), null);
  assert.equal(firstKeepIncompatibleRgFlag(["foo", "--", "-l"]), null);
});

test("loadKeepConfig reads keep budget environment", () => {
  const config = loadKeepConfig({
    RGK_PROMPT_LINE_MAX_BYTES: "120",
    RGK_OUTPUT_LINE_MAX_BYTES: "80",
    RGK_TOTAL_PROMPT_MAX_BYTES: "900000",
    RGK_CODEX_CONCURRENCY: "2",
  });
  assert.equal(config.promptLineMaxBytes, 120);
  assert.equal(config.outputLineMaxBytes, 80);
  assert.equal(config.totalPromptMaxBytes, 900_000);
  assert.equal(config.codexConcurrency, 2);
});

test("loadKeepConfig rejects line budgets too small to be useful", () => {
  assert.throws(
    () => loadKeepConfig({ RGK_OUTPUT_LINE_MAX_BYTES: "3" }),
    /RGK_OUTPUT_LINE_MAX_BYTES must be an integer >= 4/u,
  );
});

test("loadRgPath does not validate keep-only environment", () => {
  assert.equal(loadRgPath({ RGK_PROMPT_MAX_BYTES: "bad", RGK_RG_PATH: "custom-rg" }), "custom-rg");
});
