import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogger } from "../src/logger.js";

test("logger writes the same line to stderr and logs/mcp.log and never stdout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coco-log-"));
  const logDir = path.join(dir, "nested", "logs");
  let stderr = "";
  let stdout = "";
  const originalErr = process.stderr.write.bind(process.stderr);
  const originalOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const logger = createLogger(logDir);
    logger.log("hello");
    assert.equal(logger.logPath, path.join(logDir, "mcp.log"));
    assert.match(stderr, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello\n$/);
    assert.equal(await readFile(logger.logPath, "utf8"), stderr);
    assert.equal(stdout, "");
  } finally {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
    await rm(dir, { recursive: true, force: true });
  }
});
