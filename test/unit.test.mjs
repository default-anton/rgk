import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, UsageError } from "../dist/args.js";
import { orderCandidates, parseRgJson } from "../dist/candidates.js";
import { withKeepRgFlags } from "../dist/cli.js";
import { buildPrompt } from "../dist/codex.js";
import { loadRgPath } from "../dist/config.js";

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

test("buildPrompt keeps condition and compact candidates", () => {
  assert.equal(
    buildPrompt("auth failures", [{ id: "m1", output: "a", promptLine: "m1 a" }]),
    "Condition:\nauth failures\n\nCandidates:\nm1 a\n",
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

test("loadRgPath does not validate keep-only environment", () => {
  assert.equal(loadRgPath({ RGK_KEEP_LIMIT: "bad", RGK_RG_PATH: "custom-rg" }), "custom-rg");
});
