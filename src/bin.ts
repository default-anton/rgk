#!/usr/bin/env node
import { main } from "./cli.js";

try {
  const code = await main(process.argv.slice(2), process.env);
  process.exitCode = code;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`rgk: unexpected failure: ${message}\n`);
  process.exitCode = 2;
}
