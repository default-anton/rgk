import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../dist/cli.js";

test("main handles wrapper-only help", async () => {
  const writes = capture(process.stdout);
  try {
    assert.equal(await main(["--rgk-help"], {}), 0);
    assert.match(writes.output(), /--keep <condition>/u);
  } finally {
    writes.restore();
  }
});

test("main handles wrapper-only version", async () => {
  const writes = capture(process.stdout);
  try {
    assert.equal(await main(["--rgk-version"], {}), 0);
    assert.match(writes.output(), /^rgk \d+\.\d+\.\d+\n$/u);
  } finally {
    writes.restore();
  }
});

test("main appends rgk version to rg version", async () => {
  const writes = capture(process.stdout);
  try {
    assert.equal(await main(["--version"], {}), 0);
    assert.match(writes.output(), /ripgrep/u);
    assert.match(writes.output(), /\nrgk \d+\.\d+\.\d+\n$/u);
  } finally {
    writes.restore();
  }
});

function capture(stream) {
  const original = stream.write;
  let output = "";
  stream.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((arg) => typeof arg === "function");
    callback?.();
    return true;
  };

  return {
    output: () => output,
    restore: () => {
      stream.write = original;
    },
  };
}
