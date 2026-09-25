import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeServer } from "./bridge-server.js";
import { loadConfig, loadDotEnv, writeBridgePortFile } from "./config.js";
import { createLogger } from "./logger.js";
import { createMameController } from "./mame-process.js";
import { registerTools, type ToolDeps } from "./tools.js";
import { createToolchain } from "./toolchain.js";

export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "coco3-mcp-bridge", version: "1.0.2" });
  registerTools(server, deps);
  return server;
}

function isDirectRun(): boolean {
  const href = import.meta.url.toLowerCase();
  return process.argv.some((arg) => {
    if (!arg || arg.startsWith("-")) return false;
    try {
      return pathToFileURL(path.resolve(arg)).href.toLowerCase() === href;
    } catch {
      return false;
    }
  });
}

export async function main(): Promise<void> {
  const root = projectRoot();
  const fileEnv = loadDotEnv(path.join(root, ".env"));
  const config = loadConfig({ ...fileEnv, ...process.env }, root);
  for (const dir of [
    config.logDir,
    config.snapshotDir,
    config.stateDir,
    config.workDir,
    config.storageDir,
    config.disksDir,
    config.hostBasDir,
    config.hostBinDir,
    config.hostDataDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeBridgePortFile(config);
  const logger = createLogger(config.logDir);
  const mame = createMameController(config);
  const bridge = createBridgeServer(config.bridgePort, (line, error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.log(`bridge received malformed line: ${line} (${message})`);
  });
  mame.onUnexpectedExit((code) => {
    logger.log(`mame exited unexpectedly code=${code ?? "null"}`);
    void bridge.stop().catch((error: unknown) => {
      logger.log(`bridge stop after mame exit failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  const server = createMcpServer({
    config,
    mame,
    bridge,
    toolchain: createToolchain(config.decbPath, undefined, config.rootDir),
    logger,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("coco3-mcp-bridge listening on stdio");
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
