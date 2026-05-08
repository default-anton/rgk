import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";

const cliPath = new URL("../dist/bin.js", import.meta.url).pathname;

test("keep mode filters piped stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
if (!process.argv.includes("--ignore-rules") || !process.argv.includes("--ignore-user-config")) process.exit(2);
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

test("keep mode exits cleanly when stdout pipe closes early", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const outputIndex = process.argv.indexOf("--output-last-message");
await new Promise((resolve) => process.stdin.resume().on("end", resolve));
const ranked_ids = Array.from({ length: 300 }, (_, index) => \`m\${(index + 1).toString(36)}\`).join(" ");
await import("node:fs/promises").then(({ writeFile }) => writeFile(process.argv[outputIndex + 1], JSON.stringify({ ranked_ids })));
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);

  const head = spawn("head", ["-n", "1"], { stdio: ["pipe", "ignore", "ignore"] });
  const child = spawn(process.execPath, [cliPath, "foo", "--keep", "contains foo"], {
    env: { ...process.env, RGK_CODEX_PATH: fakeCodex },
    stdio: ["pipe", "pipe", "pipe"],
  });
  head.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
  });
  child.stdout.pipe(head.stdin);
  child.stdin.end("foo\n".repeat(300));
  await Promise.all([waitForClose(head), waitForClose(child)]);

  assert.equal(child.exitCode, 0);
});

test("keep mode handles codex exiting before reading prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(fakeCodex, "#!/usr/bin/env node\nprocess.exit(2);\n", "utf8");
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    input: `${"foo x".padEnd(1_000, "x")}\n`.repeat(300),
    env: { RGK_CODEX_PATH: fakeCodex, RGK_PROMPT_MAX_BYTES: "1000000" },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /rgk: keep filter failed:/u);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event|write EPIPE/u);
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

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

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
