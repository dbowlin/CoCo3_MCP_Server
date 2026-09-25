import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function walkTs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkTs(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

test("server source never writes stdout with console.log", async () => {
  const files = await walkTs(path.join(root, "src"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /console\.log\s*\(/, file);
  }
});

test("index.ts follows the SDK 1.30 stdio example", async () => {
  const index = await readFile(path.join(root, "src", "index.ts"), "utf8");
  assert.match(index, /@modelcontextprotocol\/sdk\/server\/mcp\.js/);
  assert.match(index, /@modelcontextprotocol\/sdk\/server\/stdio\.js/);
  assert.match(index, /McpServer/);
  assert.match(index, /StdioServerTransport/);
  assert.match(index, /\.connect\s*\(/);
  assert.doesNotMatch(index, /@modelcontextprotocol\/sdk\/server\/index\.js/);
  assert.doesNotMatch(index, /setRequestHandler/);
});

test("package.json pins @modelcontextprotocol/sdk 1.30.0 exactly", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], "1.30.0");
});
