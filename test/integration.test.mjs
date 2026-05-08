import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;

test("keep mode filters piped stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
await new Promise((resolve) => process.stdin.resume().on("end", resolve));
await import("node:fs/promises").then(({ writeFile }) => writeFile(process.argv[outputIndex + 1], JSON.stringify({ ranked_ids: "m1" })));
console.log(JSON.stringify({ ranked_ids: "m1" }));
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    input: "foo\nbar\n",
    env: { RGK_CODEX_PATH: fakeCodex },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "<stdin>:1:1:foo\n");
});

test("keep mode stops rg after candidate limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeRg = join(directory, "rg.mjs");
  await writeFile(
    fakeRg,
    `#!/usr/bin/env node
for (let index = 1; index <= 1000; index += 1) {
  console.log(JSON.stringify({ type: "match", data: { path: { text: "file.txt" }, lines: { text: "foo\\n" }, line_number: index, submatches: [{ start: 0 }] } }));
}
`,
    "utf8",
  );
  await chmod(fakeRg, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    env: { RGK_RG_PATH: fakeRg, RGK_KEEP_LIMIT: "2" },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /more than 2 candidates matched/u);
});

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}
