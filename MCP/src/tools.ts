import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { BridgeClient } from "./bridge-server.js";
import type { Logger } from "./logger.js";
import type { MameController } from "./mame-process.js";
import type { BuildDiskRequest, Toolchain } from "./toolchain.js";

export interface ToolDeps {
  config: AppConfig;
  mame: MameController;
  bridge: BridgeClient;
  toolchain: Toolchain;
  logger: Logger;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

type Args = Record<string, unknown>;
type Handler = (deps: ToolDeps, args: Args) => Promise<ToolResult>;

const PING_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;
const STATE_TIMEOUT_MS = 2_000;

export const TOOL_INFO: Record<string, { description: string }> = {
  coco_start: {
    description:
      "Spawn local official MAME coco3 with the disk controller and wait until the Lua bridge answers ping.",
  },
  coco_stop: {
    description: "Stop the MAME process tree and close the bridge listener.",
  },
  coco_status: {
    description: "Report whether MAME is running, whether the bridge answered, and the mounted flop1 image.",
  },
  coco_mount_flop: {
    description:
      "Mount a disk image on flop1 or flop2. Prefer paths like storage/disks/game.dsk (resolved from the MCP root). Drives come from manager.machine.images.",
  },
  coco_unmount_flop: {
    description: "Unload the disk image from flop1 or flop2.",
  },
  coco_type: {
    description: "Post one natural-keyboard string. pressEnter defaults to true and appends {ENTER} when it is not already present, then waits until the queue is empty and not posting.",
  },
  coco_snapshot: {
    description: "Capture the CoCo screen to snapshots/current.png and return the PNG. Falls back to the newest PNG in the snapshot directory.",
  },
  coco_soft_reset: {
    description: "Soft-reset the emulated CoCo. This does not hard-reset MAME.",
  },
  coco_list_images: {
    description: "List MAME image devices, including flop1 and flop2, with tag, briefname, filename, and exists.",
  },
  coco_build_disk: {
    description:
      "Build a 35-track Disk BASIC image with ToolShed decb. Prefer storage/disks for output and storage/host/bas|bin|data for inputs. BASIC is tokenized; BIN and data are copied unchanged.",
  },
  coco_read_memory: {
    description:
      "Read bytes from the current 64K MMU window, not physical RAM. $0400 is the 32-column text screen only in the CoCo 1/2-compatible map.",
  },
  coco_write_memory: {
    description: "Write bytes into the current 64K MMU window, not physical RAM.",
  },
  coco_save_state: {
    description: "Schedule a MAME save into the state directory. The save is asynchronous; fileFound reports whether the file appeared.",
  },
  coco_load_state: {
    description:
      "Schedule a MAME state load. Fails immediately if no matching file exists in the state directory; otherwise the load is asynchronous and the result is reported as scheduled.",
  },
};

function textResult(text: string, isError = false): ToolResult {
  return isError ? { isError: true, content: [{ type: "text", text }] } : { content: [{ type: "text", text }] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLength(input: unknown, address: number): number {
  const length = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(length) || length < 1 || length > 65536) {
    throw new Error(`bad length ${String(input)}`);
  }
  if (address + length - 1 > 0xffff) {
    throw new Error(`bad length ${String(input)}`);
  }
  return length;
}

function normalizeAddress(input: unknown): string {
  const text = String(input ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(text)) throw new Error(`bad address ${String(input)}`);
  const value = Number.parseInt(text, 16);
  if (value < 0 || value > 0xffff) throw new Error(`bad address ${String(input)}`);
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function addressValue(hex: string): number {
  return Number.parseInt(hex, 16);
}

function validStateName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && !/[\\/]/.test(name);
}

function driveOf(args: Args): string {
  const drive = typeof args.drive === "string" ? args.drive : "flop1";
  if (drive !== "flop1" && drive !== "flop2") throw new Error("drive must be flop1 or flop2");
  return drive;
}

async function pollPing(bridge: BridgeClient, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last = "ping timeout";
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const response = await bridge.request("ping", {}, Math.min(1000, remaining));
      if (response.ok) return null;
      last = response.error;
    } catch (error) {
      last = messageOf(error);
    }
    if (Date.now() >= deadline) break;
    await sleep(50);
  }
  return last;
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const info = await stat(file);
      if (info.size > 0) return true;
    } catch {
      // The snapshot has not been written yet.
    }
    if (Date.now() > deadline) break;
    await sleep(50);
  }
  return false;
}

async function newestPng(dir: string, started: number): Promise<string | null> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (info.size <= 0 || info.mtimeMs < started - 1000) continue;
      if (!best || info.mtimeMs >= best.mtime) best = { file, mtime: info.mtimeMs };
    } catch {
      // Skip a file that disappears between readdir and stat.
    }
  }
  return best?.file ?? null;
}

async function waitForNewestPng(dir: string, started: number, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const found = await newestPng(dir, started);
    if (found) return found;
    if (Date.now() > deadline) break;
    await sleep(50);
  }
  return null;
}

async function findStateFile(dir: string, name: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const names = await readdir(dir);
      const match = names.find((entry) => entry === name || entry.startsWith(`${name}.`));
      if (match) return path.join(dir, match);
    } catch {
      // The state directory may not exist yet.
    }
    if (Date.now() > deadline) break;
    await sleep(50);
  }
  return null;
}

/**
 * Absolute paths unchanged.
 * Paths under storage/ resolve from the MCP root (easy disk/host layout).
 * Everything else matches path.resolve(cwd) (unit-test compatible).
 */
function resolveDiskPath(config: AppConfig, raw: string): string {
  const text = raw.trim();
  if (path.isAbsolute(text)) return path.normalize(text);
  const norm = text.replace(/\\/g, "/");
  if (norm === "storage" || norm.startsWith("storage/")) {
    return path.resolve(config.rootDir, text);
  }
  return path.resolve(text);
}

const handlers: Record<string, Handler> = {
  async coco_start(deps) {
    const running = deps.mame.status();
    if (running.running) {
      const error = await pollPing(deps.bridge, PING_TIMEOUT_MS);
      if (error) return textResult(error, true);
      return textResult(JSON.stringify({ ok: true, alreadyRunning: true, pid: running.pid, bridge: true }));
    }
    try {
      await deps.bridge.start();
      const started = deps.mame.start();
      const error = await pollPing(deps.bridge, PING_TIMEOUT_MS);
      if (error) {
        await deps.mame.stop();
        await deps.bridge.stop();
        return textResult(error, true);
      }
      deps.logger.log(`coco_start pid ${started.pid ?? "unknown"}`);
      return textResult(JSON.stringify({ ok: true, alreadyRunning: false, pid: started.pid, bridge: true }));
    } catch (error) {
      await deps.mame.stop().catch(() => undefined);
      await deps.bridge.stop().catch(() => undefined);
      return textResult(messageOf(error), true);
    }
  },

  async coco_stop(deps) {
    await deps.mame.stop();
    await deps.bridge.stop();
    deps.logger.log("coco_stop");
    return textResult(JSON.stringify({ ok: true }));
  },

  async coco_status(deps) {
    const status = deps.mame.status();
    const body: Record<string, unknown> = { running: status.running, pid: status.pid, bridge: false };
    if (!status.running) return textResult(JSON.stringify(body));
    try {
      const ping = await deps.bridge.request("ping", {}, 500);
      if (!ping.ok) return textResult(JSON.stringify(body));
      const details = await deps.bridge.request("status", {}, 500);
      if (details.ok && details.result && typeof details.result === "object") {
        const record = details.result as Record<string, unknown>;
        return textResult(
          JSON.stringify({
            running: true,
            pid: status.pid,
            bridge: true,
            driver: record.driver,
            flop1: record.flop1,
            posting: record.posting,
            empty: record.empty,
          }),
        );
      }
      body.bridge = true;
    } catch {
      body.bridge = false;
    }
    return textResult(JSON.stringify(body));
  },

  async coco_mount_flop(deps, args) {
    try {
      const rawPath = String(args.path ?? "").trim();
      if (!rawPath) throw new Error("path is required");
      const drive = driveOf(args);
      const response = await deps.bridge.request("mount", {
        briefname: drive,
        path: resolveDiskPath(deps.config, rawPath),
      });
      if (!response.ok) return textResult(response.error, true);
      return textResult(JSON.stringify(response.result));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_unmount_flop(deps, args) {
    try {
      const drive = driveOf(args);
      const response = await deps.bridge.request("unmount", { briefname: drive });
      if (!response.ok) return textResult(response.error, true);
      return textResult(JSON.stringify(response.result));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_type(deps, args) {
    try {
      const pressEnter = args.pressEnter !== false;
      let text = String(args.text ?? "");
      if (pressEnter && !text.endsWith("{ENTER}")) text += "{ENTER}";
      const queued = await deps.bridge.request("type", { text });
      if (!queued.ok) return textResult(queued.error, true);
      const deadline = Date.now() + PING_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const idle = await deps.bridge.request("wait_idle", {}, 1000);
        if (!idle.ok) return textResult(idle.error, true);
        const result = idle.result as { idle?: boolean } | null;
        if (result?.idle === true) return textResult(JSON.stringify({ queued: true, text }));
        await sleep(50);
      }
      return textResult("timed out waiting for keyboard idle", true);
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_snapshot(deps) {
    try {
      const target = path.join(deps.config.snapshotDir, "current.png");
      const started = Date.now();
      await mkdir(deps.config.snapshotDir, { recursive: true });
      await rm(target, { force: true });
      const response = await deps.bridge.request(
        "snapshot",
        { path: target, snapshotDirectory: deps.config.snapshotDir },
        SNAPSHOT_TIMEOUT_MS,
      );
      if (!response.ok) return textResult(response.error, true);
      const result = (response.result ?? {}) as { method?: string; path?: string };
      const file =
        result.method === "video"
          ? await waitForNewestPng(deps.config.snapshotDir, started, SNAPSHOT_TIMEOUT_MS)
          : (await waitForFile(typeof result.path === "string" ? result.path : target, SNAPSHOT_TIMEOUT_MS))
            ? typeof result.path === "string"
              ? result.path
              : target
            : null;
      if (!file) return textResult("snapshot file missing", true);
      const bytes = await readFile(file);
      if (bytes.length === 0) return textResult("snapshot file missing", true);
      return {
        content: [
          { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
          { type: "text", text: file },
        ],
      };
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_soft_reset(deps) {
    try {
      const response = await deps.bridge.request("soft_reset", {});
      if (!response.ok) return textResult(response.error, true);
      return textResult(JSON.stringify(response.result));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_list_images(deps) {
    try {
      const response = await deps.bridge.request("list_images", {});
      if (!response.ok) return textResult(response.error, true);
      return textResult(JSON.stringify(response.result));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_build_disk(deps, args) {
    const request: BuildDiskRequest = {
      dskPath: String(args.dskPath ?? ""),
      files: Array.isArray(args.files) ? (args.files as BuildDiskRequest["files"]) : [],
    };
    try {
      const result = await deps.toolchain.buildDisk(request);
      return textResult(JSON.stringify(result));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_read_memory(deps, args) {
    try {
      const address = normalizeAddress(args.address);
      const length = normalizeLength(args.length, addressValue(address));
      const response = await deps.bridge.request("read_mem", { address, length });
      if (!response.ok) return textResult(response.error, true);
      return textResult(JSON.stringify(response.result));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_write_memory(deps, args) {
    try {
      const address = normalizeAddress(args.address);
      const data = String(args.data ?? "");
      const response = await deps.bridge.request("write_mem", { address, data });
      if (!response.ok) return textResult(response.error, true);
      return textResult(JSON.stringify(response.result));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_save_state(deps, args) {
    try {
      if (!validStateName(args.name)) return textResult("invalid state name", true);
      const response = await deps.bridge.request("save_state", { name: args.name });
      if (!response.ok) return textResult(response.error, true);
      await mkdir(deps.config.stateDir, { recursive: true });
      const file = await findStateFile(deps.config.stateDir, args.name, STATE_TIMEOUT_MS);
      return textResult(JSON.stringify({ scheduled: true, name: args.name, fileFound: file !== null, file }));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },

  async coco_load_state(deps, args) {
    try {
      if (!validStateName(args.name)) return textResult("invalid state name", true);
      // machine:load(filename) has no synchronous error signal (MAME Lua Scripting
      // Interface, "Running machine": it only "schedules" the load and "returns
      // immediately, before the machine state is [loaded]" - see
      // https://docs.mamedev.org/luascript/ref-core.html). Check the state directory
      // ourselves first so a missing state fails fast and honestly instead of asking
      // MAME to load a file that was never there.
      const found = await findStateFile(deps.config.stateDir, args.name, 0);
      if (!found) return textResult(`no saved state named "${args.name}"`, true);
      const response = await deps.bridge.request("load_state", { name: args.name });
      if (!response.ok) return textResult(response.error, true);
      return textResult(JSON.stringify({ scheduled: true, name: args.name }));
    } catch (error) {
      return textResult(messageOf(error), true);
    }
  },
};

export function createToolHandlers(deps: ToolDeps): Record<string, (args: Args) => Promise<ToolResult>> {
  const bound: Record<string, (args: Args) => Promise<ToolResult>> = {};
  for (const name of Object.keys(TOOL_INFO)) {
    const handler = handlers[name];
    if (!handler) throw new Error(`missing handler ${name}`);
    bound[name] = (args) => handler(deps, args ?? {});
  }
  return bound;
}

const inputSchemas: Record<string, Record<string, z.ZodTypeAny>> = {
  coco_start: {},
  coco_stop: {},
  coco_status: {},
  coco_mount_flop: {
    path: z
      .string()
      .describe("Disk image path. Prefer storage/disks/name.dsk (from MCP root) or an absolute path"),
    drive: z.enum(["flop1", "flop2"]).optional().describe("Disk drive. Defaults to flop1"),
  },
  coco_unmount_flop: {
    drive: z.enum(["flop1", "flop2"]).optional().describe("Disk drive. Defaults to flop1"),
  },
  coco_type: {
    text: z.string().describe("Text to post, including optional {ENTER} or {BREAK} codes"),
    pressEnter: z.boolean().optional().describe("Append {ENTER} when the text does not already end with it. Defaults to true"),
  },
  coco_snapshot: {},
  coco_soft_reset: {},
  coco_list_images: {},
  coco_build_disk: {
    dskPath: z.string().describe("Output .dsk path (prefer storage/disks/name.dsk)"),
    files: z.array(
      z.object({
        hostPath: z.string().describe("Host file (prefer storage/host/bas|bin|data/...)"),
        cocoName: z.string(),
        kind: z.enum(["bas", "bin", "data"]),
      }),
    ),
  },
  coco_read_memory: {
    address: z.string().describe("Hex address in the current 64K MMU window, such as 0400 or 0x0400"),
    length: z.number().int().describe("Number of bytes, from 1 through 65536"),
  },
  coco_write_memory: {
    address: z.string().describe("Hex address in the current 64K MMU window"),
    data: z.string().describe("Space-separated hex bytes"),
  },
  coco_save_state: {
    name: z.string().describe("State name stored under the state directory"),
  },
  coco_load_state: {
    name: z.string().describe("State name stored under the state directory"),
  },
};

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const bound = createToolHandlers(deps);
  for (const name of Object.keys(TOOL_INFO)) {
    server.registerTool(
      name,
      {
        description: TOOL_INFO[name]?.description,
        inputSchema: inputSchemas[name] ?? {},
      },
      async (args) => bound[name]?.(args as Args) ?? textResult(`missing handler ${name}`, true),
    );
  }
}
