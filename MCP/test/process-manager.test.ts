import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildMameArgs, createMameController, type SpawnOptions, type Spawned } from "../src/mame-process.js";

interface FakeChild extends Spawned {
  signal?: NodeJS.Signals;
  emitExit(code: number | null): void;
}

function fakeChild(pid: number): FakeChild {
  const listeners: Array<(code: number | null) => void> = [];
  const child: FakeChild = {
    pid,
    killed: false,
    exitCode: null,
    kill(signal?: NodeJS.Signals) {
      this.killed = true;
      this.signal = signal;
      return true;
    },
    on(event, listener) {
      if (event === "exit") listeners.push(listener);
    },
    emitExit(code) {
      this.exitCode = code;
      for (const listener of listeners) listener(code);
    },
  };
  return child;
}

test("windows controller spawns once, logs to a file, and taskkills the tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coco-mame-"));
  try {
    const mamePath = path.join(root, "mame", "mame.exe");
    const cfg = loadConfig(
      {
        MAME_PATH: mamePath,
        MAME_ROMPATH: path.join(root, "roms"),
        BRIDGE_PORT: "18765",
      },
      root,
    );
    const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    let child: FakeChild | undefined;
    const spawner = {
      spawn(command: string, args: string[], options: SpawnOptions): Spawned {
        calls.push({ command, args, options });
        if (command === "taskkill") {
          const killer = fakeChild(0);
          queueMicrotask(() => killer.emitExit(0));
          return killer;
        }
        child = fakeChild(4242);
        return child;
      },
    };
    const mame = createMameController(cfg, spawner, "win32");
    const unexpected: Array<number | null> = [];
    mame.onUnexpectedExit((code) => unexpected.push(code));

    assert.deepEqual(mame.start(), { started: true, alreadyRunning: false, pid: 4242 });
    assert.deepEqual(mame.status(), { running: true, pid: 4242, exitCode: null });
    assert.equal(calls[0].command, mamePath);
    assert.deepEqual(calls[0].args, buildMameArgs(cfg));
    assert.equal(calls[0].options.cwd, path.dirname(mamePath));
    assert.equal(calls[0].options.env?.BRIDGE_PORT, "18765");
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.stdio?.[0], "ignore");
    assert.equal(typeof calls[0].options.stdio?.[1], "number");
    assert.equal(typeof calls[0].options.stdio?.[2], "number");
    assert.equal(existsSync(path.join(root, "logs", "mame.log")), true);

    assert.deepEqual(mame.start(), { started: false, alreadyRunning: true, pid: 4242 });
    assert.equal(calls.filter((call) => call.command === mamePath).length, 1);

    child?.emitExit(1);
    assert.deepEqual(mame.status(), { running: false, pid: null, exitCode: 1 });
    assert.deepEqual(unexpected, [1]);

    assert.equal(mame.start().started, true);
    const beforeStop = calls.length;
    await mame.stop();
    const kill = calls.find((call) => call.command === "taskkill");
    assert.ok(kill);
    assert.deepEqual(kill?.args, ["/PID", "4242", "/T", "/F"]);
    assert.equal(mame.status().running, false);
    child?.emitExit(0);
    assert.deepEqual(unexpected, [1]);
    await mame.stop();
    assert.equal(calls.length, beforeStop + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("posix stop sends SIGTERM and does not taskkill", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coco-mame-posix-"));
  try {
    const cfg = loadConfig({ MAME_PATH: path.join(root, "mame"), MAME_ROMPATH: path.join(root, "roms") }, root);
    let child: FakeChild | undefined;
    const calls: string[] = [];
    const mame = createMameController(
      cfg,
      {
        spawn(command) {
          calls.push(command);
          child = fakeChild(7);
          return child;
        },
      },
      "linux",
    );
    mame.start();
    await mame.stop();
    assert.equal(child?.signal, "SIGTERM");
    assert.equal(calls.includes("taskkill"), false);
    assert.equal(mame.status().running, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start throws when MAME_PATH is empty", () => {
  const mame = createMameController(loadConfig({}, path.resolve("empty-mame")), { spawn() { throw new Error("spawned"); } }, "win32");
  assert.throws(() => mame.start(), /MAME_PATH/);
});
