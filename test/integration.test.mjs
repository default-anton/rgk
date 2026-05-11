import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("keep mode splits oversized keep prompts across Codex calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  const callsPath = join(directory, "calls.txt");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const outputIndex = process.argv.indexOf("--output-last-message");
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const ids = [...input.matchAll(/^m[0-9a-z]+ /gm)].map((match) => match[0].trim()).join(" ");
const { appendFile, writeFile } = await import("node:fs/promises");
await appendFile(${JSON.stringify(callsPath)}, "x");
await writeFile(process.argv[outputIndex + 1], JSON.stringify({ ranked_ids: ids }));
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    input: "foo\nfoo\nfoo\n",
    env: { RGK_CODEX_PATH: fakeCodex, RGK_PROMPT_MAX_BYTES: "56" },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "<stdin>:1:1:foo\n<stdin>:2:1:foo\n<stdin>:3:1:foo\n");
  assert.equal((await readFile(callsPath, "utf8")).length, 3);
});

test("keep mode ignores Codex IDs outside each candidate batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const outputIndex = process.argv.indexOf("--output-last-message");
await new Promise((resolve) => process.stdin.resume().on("end", resolve));
await import("node:fs/promises").then(({ writeFile }) => writeFile(process.argv[outputIndex + 1], JSON.stringify({ ranked_ids: "m3" })));
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    input: "foo\nfoo\nfoo\n",
    env: { RGK_CODEX_PATH: fakeCodex, RGK_PROMPT_MAX_BYTES: "56" },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "<stdin>:3:1:foo\n");
});

test("keep mode enforces total prompt budget after batching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(fakeCodex, "#!/usr/bin/env node\nprocess.exit(99);\n", "utf8");
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    input: "foo\nfoo\nfoo\n",
    env: {
      RGK_CODEX_PATH: fakeCodex,
      RGK_PROMPT_MAX_BYTES: "56",
      RGK_TOTAL_PROMPT_MAX_BYTES: "100",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /RGK_TOTAL_PROMPT_MAX_BYTES=100/u);
});

test(
  "keep mode cancels in-flight Codex batches after one batch fails",
  { timeout: 1_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
    const fakeCodex = join(directory, "codex.mjs");
    const startedPath = join(directory, "started.txt");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const fs = await import("node:fs/promises");
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
if (input.includes("m1 ")) {
  while (true) {
    try {
      await fs.readFile(${JSON.stringify(startedPath)}, "utf8");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  console.error("batch failed");
  process.exit(2);
}
await fs.writeFile(${JSON.stringify(startedPath)}, "started");
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    const result = await runCli(["foo", "--keep", "contains foo"], {
      input: "foo\nfoo\n",
      env: {
        RGK_CODEX_PATH: fakeCodex,
        RGK_PROMPT_MAX_BYTES: "56",
        RGK_CODEX_CONCURRENCY: "2",
        RGK_CODEX_TIMEOUT_MS: "10000",
      },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /batch failed/u);
    assert.equal(await readFile(startedPath, "utf8"), "started");
  },
);

test("keep mode honors configured output line budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const outputIndex = process.argv.indexOf("--output-last-message");
await new Promise((resolve) => process.stdin.resume().on("end", resolve));
await import("node:fs/promises").then(({ writeFile }) => writeFile(process.argv[outputIndex + 1], JSON.stringify({ ranked_ids: "m1" })));
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["needle", "--keep", "contains needle"], {
    input: `${"a".repeat(2_000)}needle${"z".repeat(2_000)}\n`,
    env: { RGK_CODEX_PATH: fakeCodex, RGK_OUTPUT_LINE_MAX_BYTES: "80" },
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /needle/u);
  assert.equal(Buffer.byteLength(result.stdout, "utf8") < 120, true);
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
    if (!isClosedPipeError(error)) {
      throw error;
    }
  });
  child.stdout.pipe(head.stdin);
  child.stdin.end("foo\n".repeat(300));
  await Promise.all([waitForClose(head), waitForClose(child)]);

  assert.equal(child.exitCode, 0);
});

test("keep mode rejects rg output modes that bypass JSON", async () => {
  const result = await runCli(["foo", "-l", "--keep", "contains foo"], { input: "foo\n" });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not support rg output mode -l/u);
});

test("keep mode rejects quiet output mode", async () => {
  const result = await runCli(["foo", "-q", "--keep", "contains foo"], { input: "foo\n" });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not support rg output mode -q/u);
});

test("keep mode reports codex timeouts clearly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeCodex = join(directory, "codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
await new Promise((resolve) => setTimeout(resolve, 10_000));
`,
    "utf8",
  );
  await chmod(fakeCodex, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    input: "foo\n",
    env: { RGK_CODEX_PATH: fakeCodex, RGK_CODEX_TIMEOUT_MS: "50" },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /codex timed out after RGK_CODEX_TIMEOUT_MS=50/u);
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

test("keep mode stops rg using batched total prompt budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgk-test-"));
  const fakeRg = join(directory, "rg.mjs");
  const completedPath = join(directory, "completed.txt");
  await writeFile(
    fakeRg,
    `#!/usr/bin/env node
let index = 0;
const interval = setInterval(async () => {
  index += 1;
  console.log(JSON.stringify({ type: "match", data: { path: { text: "file.txt" }, lines: { text: "foo\\n" }, line_number: index, submatches: [{ start: 0 }] } }));
  if (index === 50) {
    clearInterval(interval);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(completedPath)}, "complete"));
  }
}, 10);
`,
    "utf8",
  );
  await chmod(fakeRg, 0o755);

  const result = await runCli(["foo", "--keep", "contains foo"], {
    env: {
      RGK_RG_PATH: fakeRg,
      RGK_PROMPT_MAX_BYTES: "75",
      RGK_TOTAL_PROMPT_MAX_BYTES: "120",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /RGK_TOTAL_PROMPT_MAX_BYTES=120/u);
  await assert.rejects(readFile(completedPath, "utf8"), /ENOENT/u);
});

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function isClosedPipeError(error) {
  return error.code === "EPIPE" || error.code === "ENOTCONN";
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
