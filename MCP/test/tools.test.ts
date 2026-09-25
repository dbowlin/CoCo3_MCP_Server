import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createToolHandlers, registerTools, TOOL_INFO } from "../src/tools.js";

const TOOL_NAMES = [
  "coco_build_disk",
  "coco_list_images",
  "coco_load_state",
  "coco_mount_flop",
  "coco_read_memory",
  "coco_save_state",
  "coco_snapshot",
  "coco_soft_reset",
  "coco_start",
  "coco_status",
  "coco_stop",
  "coco_type",
  "coco_unmount_flop",
  "coco_write_memory",
];

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function textOf(result: ToolResult): string {
  return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

interface Harness {
  root: string;
  config: AppConfig;
  requests: Array<{ cmd: string; params: Record<string, unknown> }>;
  order: string[];
  mame: { started: number; stopped: number; running: boolean; pid: number | null };
  handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
  deps: Parameters<typeof createToolHandlers>[0];
  pingOk: boolean;
  failCmds: Set<string>;
  snapshotMode: "screen" | "video" | "missing";
  listResult: unknown;
  toolchainError: string | null;
  built: unknown;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "coco-tools-"));
  await mkdir(path.join(root, "snapshots"), { recursive: true });
  await mkdir(path.join(root, "states"), { recursive: true });
  const config = loadConfig(
    {
      MAME_PATH: path.join(root, "mame.exe"),
      MAME_ROMPATH: path.join(root, "roms"),
      DECB_PATH: "decb",
    },
    root,
  );
  const state: Harness = {
    root,
    config,
    requests: [],
    order: [],
    mame: { started: 0, stopped: 0, running: false, pid: null },
    handlers: {},
    deps: undefined as unknown as Harness["deps"],
    pingOk: true,
    failCmds: new Set<string>(),
    snapshotMode: "screen",
    listResult: [{ tag: ":flop1", briefname: "flop1", filename: "A.DSK", exists: true }],
    toolchainError: null,
    built: undefined,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
  let idleCalls = 0;
  const bridge = {
    listening: false,
    port: config.bridgePort,
    address: "127.0.0.1",
    async start() {
      state.order.push("bridge-start");
      this.listening = true;
    },
    async stop() {
      state.order.push("bridge-stop");
      this.listening = false;
    },
    async request(cmd: string, params: Record<string, unknown>) {
      state.requests.push({ cmd, params });
      if (cmd === "ping") {
        return state.pingOk
          ? { id: "1", ok: true as const, result: { t: 0 } }
          : { id: "1", ok: false as const, error: "no bridge" };
      }
      if (state.failCmds.has(cmd)) {
        return { id: "1", ok: false as const, error: "no flop1 image device" };
      }
      if (cmd === "wait_idle") {
        idleCalls += 1;
        return { id: "1", ok: true as const, result: { idle: idleCalls >= 2 } };
      }
      if (cmd === "status") {
        return {
          id: "1",
          ok: true as const,
          result: { driver: "coco3", flop1: "GAME.DSK", posting: false, empty: true },
        };
      }
      if (cmd === "list_images") return { id: "1", ok: true as const, result: state.listResult };
      if (cmd === "read_mem") return { id: "1", ok: true as const, result: { data: "41 42" } };
      if (cmd === "write_mem") return { id: "1", ok: true as const, result: { bytes: 2 } };
      if (cmd === "snapshot") {
        assert.equal(existsSync(String(params.path)), false);
        if (state.snapshotMode === "screen") {
          writeFileSync(String(params.path), "PNGDATA");
          return { id: "1", ok: true as const, result: { method: "screen", path: params.path } };
        }
        if (state.snapshotMode === "video") {
          writeFileSync(path.join(config.snapshotDir, "shot.png"), "VIDEO");
          return {
            id: "1",
            ok: true as const,
            result: { method: "video", snapshotDirectory: params.snapshotDirectory, path: params.path },
          };
        }
        return { id: "1", ok: true as const, result: { method: "screen", path: params.path } };
      }
      if (cmd === "type") return { id: "1", ok: true as const, result: { queued: true } };
      if (cmd === "soft_reset") return { id: "1", ok: true as const, result: { reset: "soft" } };
      if (cmd === "save_state" || cmd === "load_state") {
        return { id: "1", ok: true as const, result: { scheduled: true, name: params.name } };
      }
      return { id: "1", ok: true as const, result: { briefname: params.briefname, filename: params.path ?? null } };
    },
  };
  const mame = {
    buildArgs() {
      return [];
    },
    start() {
      state.mame.started += 1;
      state.mame.running = true;
      state.mame.pid = 4242;
      state.order.push("mame-start");
      return { started: true, alreadyRunning: false, pid: 4242 };
    },
    async stop() {
      state.mame.stopped += 1;
      state.mame.running = false;
      state.mame.pid = null;
      state.order.push("mame-stop");
    },
    status() {
      return { running: state.mame.running, pid: state.mame.pid, exitCode: null as number | null };
    },
    onUnexpectedExit() {
      return undefined;
    },
  };
  const toolchain = {
    async buildDisk(req: { dskPath: string; files: unknown[] }) {
      state.built = req;
      if (state.toolchainError) throw new Error(state.toolchainError);
      return { dskPath: req.dskPath, steps: ["dskini"] };
    },
  };
  const deps = { config, mame, bridge, toolchain, logger: { log() { return undefined; } } };
  state.deps = deps;
  state.handlers = createToolHandlers(deps) as Harness["handlers"];
  return state;
}

test("tool handlers and descriptions cover the coco set", async () => {
  const box = await harness();
  try {
    assert.deepEqual(Object.keys(box.handlers).sort(), TOOL_NAMES);
    assert.deepEqual(Object.keys(TOOL_INFO).sort(), TOOL_NAMES);
    assert.match(TOOL_INFO.coco_read_memory.description, /current 64K MMU window/);
    assert.match(TOOL_INFO.coco_read_memory.description, /not physical RAM/);
    assert.match(TOOL_INFO.coco_read_memory.description, /\$0400/);
    assert.match(TOOL_INFO.coco_write_memory.description, /current 64K MMU window/);
    assert.match(TOOL_INFO.coco_write_memory.description, /not physical RAM/);
    const registered: string[] = [];
    registerTools(
      { registerTool(name: string) { registered.push(name); } } as never,
      box.deps,
    );
    assert.deepEqual(registered.sort(), TOOL_NAMES);
  } finally {
    await box.cleanup();
  }
});

test("coco_start is idempotent when ping already works", async () => {
  const box = await harness();
  try {
    box.mame.running = true;
    box.mame.pid = 99;
    const result = await box.handlers.coco_start({});
    assert.equal(box.mame.started, 0);
    assert.deepEqual(JSON.parse(textOf(result)), { ok: true, alreadyRunning: true, pid: 99, bridge: true });
  } finally {
    await box.cleanup();
  }
});

test("coco_start does not spawn a second process when an existing bridge never answers", { timeout: 30_000 }, async () => {
  const box = await harness();
  try {
    box.mame.running = true;
    box.mame.pid = 99;
    box.pingOk = false;
    const result = await box.handlers.coco_start({});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "no bridge");
    assert.equal(box.mame.started, 0);
    assert.equal(box.mame.stopped, 0);
  } finally {
    await box.cleanup();
  }
});

test("coco_start listens before spawn and stops both when ping fails", { timeout: 30_000 }, async () => {
  const box = await harness();
  try {
    box.pingOk = false;
    const result = await box.handlers.coco_start({});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "no bridge");
    assert.deepEqual(
      box.order.filter((item) => item.endsWith("start")),
      ["bridge-start", "mame-start"],
    );
    assert.ok(box.order.indexOf("mame-stop") < box.order.indexOf("bridge-stop"));
    assert.equal(box.mame.started, 1);
  } finally {
    await box.cleanup();
  }
});

test("coco_start reports a fresh process when ping succeeds", async () => {
  const box = await harness();
  try {
    const result = await box.handlers.coco_start({});
    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(textOf(result)), { ok: true, alreadyRunning: false, pid: 4242, bridge: true });
    assert.deepEqual(
      box.order.filter((item) => item.endsWith("start")),
      ["bridge-start", "mame-start"],
    );
  } finally {
    await box.cleanup();
  }
});

test("coco_stop stops mame before the bridge", async () => {
  const box = await harness();
  try {
    const result = await box.handlers.coco_stop({});
    assert.ok(!result.isError);
    assert.deepEqual(box.order, ["mame-stop", "bridge-stop"]);
  } finally {
    await box.cleanup();
  }
});

test("coco_status reports process fields and bridge details", async () => {
  const box = await harness();
  try {
    const down = JSON.parse(textOf(await box.handlers.coco_status({}))) as { running: boolean; bridge: boolean };
    assert.equal(down.running, false);
    assert.equal(down.bridge, false);
    assert.equal(box.requests.some((req) => req.cmd === "ping"), false);

    box.mame.running = true;
    box.mame.pid = 7;
    const up = JSON.parse(textOf(await box.handlers.coco_status({})));
    assert.deepEqual(up, {
      running: true,
      pid: 7,
      bridge: true,
      driver: "coco3",
      flop1: "GAME.DSK",
      posting: false,
      empty: true,
    });
  } finally {
    await box.cleanup();
  }
});

test("coco_mount_flop resolves the path and defaults to flop1", async () => {
  const box = await harness();
  try {
    await box.handlers.coco_mount_flop({ path: "disk.dsk" });
    await box.handlers.coco_mount_flop({ path: "C:\\games\\a.dsk", drive: "flop2" });
    assert.deepEqual(box.requests[0], {
      cmd: "mount",
      params: { briefname: "flop1", path: path.resolve("disk.dsk") },
    });
    assert.deepEqual(box.requests[1], {
      cmd: "mount",
      params: { briefname: "flop2", path: path.resolve("C:\\games\\a.dsk") },
    });
    const before = box.requests.length;
    const bad = await box.handlers.coco_mount_flop({ path: "a.dsk", drive: "flop3" });
    assert.equal(bad.isError, true);
    assert.equal(box.requests.length, before);
  } finally {
    await box.cleanup();
  }
});

test("coco_mount_flop returns the raw lua error", async () => {
  const box = await harness();
  try {
    box.failCmds.add("mount");
    const result = await box.handlers.coco_mount_flop({ path: "a.dsk" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "no flop1 image device");
  } finally {
    await box.cleanup();
  }
});

test("coco_unmount_flop defaults to flop1", async () => {
  const box = await harness();
  try {
    await box.handlers.coco_unmount_flop({});
    assert.deepEqual(box.requests.at(-1), { cmd: "unmount", params: { briefname: "flop1" } });
  } finally {
    await box.cleanup();
  }
});

test("coco_type posts one string and waits until idle", async () => {
  const box = await harness();
  try {
    await box.handlers.coco_type({ text: "DIR" });
    assert.equal(box.requests.filter((req) => req.cmd === "type").length, 1);
    assert.equal(box.requests.find((req) => req.cmd === "type")?.params.text, "DIR{ENTER}");
    assert.ok(box.requests.filter((req) => req.cmd === "wait_idle").length >= 2);
  } finally {
    await box.cleanup();
  }
});

test("coco_type does not double {ENTER} and can skip it", async () => {
  const box = await harness();
  try {
    await box.handlers.coco_type({ text: "DIR{ENTER}" });
    assert.equal(box.requests.find((req) => req.cmd === "type")?.params.text, "DIR{ENTER}");
    box.requests.length = 0;
    await box.handlers.coco_type({ text: "DIR", pressEnter: false });
    assert.equal(box.requests.find((req) => req.cmd === "type")?.params.text, "DIR");
  } finally {
    await box.cleanup();
  }
});

test("coco_snapshot returns a png from screen:snapshot", async () => {
  const box = await harness();
  try {
    const current = path.join(box.config.snapshotDir, "current.png");
    await writeFile(current, "STALE");
    const result = await box.handlers.coco_snapshot({});
    assert.ok(!result.isError);
    const image = result.content.find((part) => part.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.equal(Buffer.from(image?.data ?? "", "base64").toString("utf8"), "PNGDATA");
    assert.match(textOf(result), /current\.png/);
    assert.equal(box.requests[0]?.cmd, "snapshot");
    assert.equal(box.requests[0]?.params.path, current);
    assert.equal(box.requests[0]?.params.snapshotDirectory, box.config.snapshotDir);
  } finally {
    await box.cleanup();
  }
});

test("coco_snapshot falls back to the newest png in the snapshot directory", async () => {
  const box = await harness();
  try {
    box.snapshotMode = "video";
    const old = path.join(box.config.snapshotDir, "old.png");
    await writeFile(old, "OLD");
    const past = new Date(Date.now() - 120_000);
    await utimes(old, past, past);
    await writeFile(path.join(box.config.snapshotDir, "current.png"), "STALE");
    const result = await box.handlers.coco_snapshot({});
    assert.ok(!result.isError);
    const image = result.content.find((part) => part.type === "image");
    assert.equal(Buffer.from(image?.data ?? "", "base64").toString("utf8"), "VIDEO");
    assert.match(textOf(result), /shot\.png/);
  } finally {
    await box.cleanup();
  }
});

test("coco_snapshot errors when no png appears", { timeout: 15_000 }, async () => {
  const box = await harness();
  try {
    box.snapshotMode = "missing";
    await writeFile(path.join(box.config.snapshotDir, "current.png"), "STALE");
    const result = await box.handlers.coco_snapshot({});
    assert.equal(result.isError, true);
  } finally {
    await box.cleanup();
  }
});

test("coco_soft_reset sends only soft_reset", async () => {
  const box = await harness();
  try {
    const result = await box.handlers.coco_soft_reset({});
    assert.ok(!result.isError);
    assert.equal(box.requests.at(-1)?.cmd, "soft_reset");
    assert.equal(box.requests.some((req) => req.cmd === "hard_reset"), false);
  } finally {
    await box.cleanup();
  }
});

test("coco_list_images returns the lua array", async () => {
  const box = await harness();
  try {
    const result = await box.handlers.coco_list_images({});
    assert.deepEqual(JSON.parse(textOf(result)), box.listResult);
  } finally {
    await box.cleanup();
  }
});

test("coco_build_disk delegates to decb and surfaces stderr", async () => {
  const box = await harness();
  try {
    const files = [{ hostPath: "a.bas", cocoName: "A.BAS", kind: "bas" }];
    const ok = await box.handlers.coco_build_disk({ dskPath: "a.dsk", files });
    assert.ok(!ok.isError);
    assert.deepEqual(JSON.parse(textOf(ok)), { dskPath: "a.dsk", steps: ["dskini"] });
    assert.deepEqual(box.built, { dskPath: "a.dsk", files });
    box.toolchainError = "disk full";
    const bad = await box.handlers.coco_build_disk({ dskPath: "a.dsk", files });
    assert.equal(bad.isError, true);
    assert.equal(textOf(bad), "disk full");
  } finally {
    await box.cleanup();
  }
});

test("memory tools use the current MMU window address", async () => {
  const box = await harness();
  try {
    const read = await box.handlers.coco_read_memory({ address: "0400", length: 16 });
    assert.ok(!read.isError);
    assert.deepEqual(box.requests.at(-1), { cmd: "read_mem", params: { address: "0400", length: 16 } });
    assert.equal(JSON.parse(textOf(read)).data, "41 42");
    const normalized = await box.handlers.coco_read_memory({ address: "0x400", length: 1 });
    assert.ok(!normalized.isError);
    assert.equal(box.requests.at(-1)?.params.address, "0400");
    assert.equal(box.requests.at(-1)?.params.length, 1);
    const beforeInvalid = box.requests.length;
    const zero = await box.handlers.coco_read_memory({ address: "0400", length: 0 });
    const huge = await box.handlers.coco_read_memory({ address: "0400", length: 65537 });
    const wide = await box.handlers.coco_read_memory({ address: "10000", length: 1 });
    assert.equal(zero.isError, true);
    assert.equal(huge.isError, true);
    assert.equal(wide.isError, true);
    assert.equal(box.requests.length, beforeInvalid);
    const before = box.requests.length;
    await box.handlers.coco_write_memory({ address: "0400", data: "41 42" });
    assert.deepEqual(box.requests.at(-1), { cmd: "write_mem", params: { address: "0400", data: "41 42" } });
    assert.ok(box.requests.length > before);
  } finally {
    await box.cleanup();
  }
});

test("save and load state report scheduled work", { timeout: 20_000 }, async () => {
  const box = await harness();
  try {
    const missing = JSON.parse(textOf(await box.handlers.coco_save_state({ name: "checkpoint" })));
    assert.equal(missing.scheduled, true);
    assert.equal(missing.fileFound, false);
    await writeFile(path.join(box.config.stateDir, "checkpoint.sta"), "sta");
    const present = JSON.parse(textOf(await box.handlers.coco_save_state({ name: "checkpoint" })));
    assert.equal(present.scheduled, true);
    assert.equal(present.fileFound, true);
    assert.match(String(present.file), /checkpoint/);
    const loaded = JSON.parse(textOf(await box.handlers.coco_load_state({ name: "checkpoint" })));
    assert.equal(loaded.scheduled, true);
    assert.equal(box.requests.at(-1)?.cmd, "load_state");
    assert.equal(box.requests.at(-1)?.params.name, "checkpoint");
    for (const name of ["", "a/b", "a\\b", "../x"]) {
      const before = box.requests.length;
      const saved = await box.handlers.coco_save_state({ name });
      const loadedBad = await box.handlers.coco_load_state({ name });
      assert.equal(saved.isError, true);
      assert.equal(loadedBad.isError, true);
      assert.equal(box.requests.length, before);
    }
  } finally {
    await box.cleanup();
  }
});

test("coco_load_state fails fast on a valid name with no matching file, without asking MAME", async () => {
  const box = await harness();
  try {
    const before = box.requests.length;
    const result = await box.handlers.coco_load_state({ name: "never-saved" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /never-saved/);
    assert.equal(box.requests.some((req) => req.cmd === "load_state"), false);
    assert.equal(box.requests.length, before);
  } finally {
    await box.cleanup();
  }
});
