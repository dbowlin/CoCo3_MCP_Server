import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { writeBridgePortFile, type AppConfig } from "./config.js";

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: ["ignore", number, number] | ["ignore", "pipe", "pipe"];
  windowsHide?: boolean;
}

export interface Spawned {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null) => void): void;
}

export interface Spawner {
  spawn(command: string, args: string[], options: SpawnOptions): Spawned;
}

export function buildMameArgs(config: AppConfig): string[] {
  return [
    "coco3",
    "-window",
    "-skip_gameinfo",
    "-natural",
    // CoCo 3 has a mouse port; without these MAME captures the host cursor.
    "-nomouse",
    "-mouse_device",
    "none",
    "-ext",
    "fdc",
    "-ramsize",
    config.cocoRam,
    "-rompath",
    config.mameRomPath,
    "-autoboot_script",
    config.bridgeLuaPath,
    "-autoboot_delay",
    "0",
    "-snapshot_directory",
    config.snapshotDir,
    "-state_directory",
    config.stateDir,
  ];
}

const defaultSpawner: Spawner = {
  spawn(command, args, options) {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      windowsHide: options.windowsHide,
    });
    const exitListeners: Array<(code: number | null) => void> = [];
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      for (const listener of exitListeners) listener(code);
    };
    // Unhandled spawn errors (e.g. ENOENT) crash the MCP process; treat them as exit.
    child.on("error", () => settle(1));
    child.on("exit", (code) => settle(code));
    return {
      pid: child.pid,
      killed: false,
      get exitCode() {
        return child.exitCode;
      },
      kill(signal?: NodeJS.Signals) {
        const killed = child.kill(signal);
        this.killed = killed;
        return killed;
      },
      on(event, listener) {
        if (event === "exit") exitListeners.push(listener);
      },
    };
  },
};

export interface MameStatus {
  running: boolean;
  pid: number | null;
  exitCode: number | null;
}

export interface MameStart {
  started: boolean;
  alreadyRunning: boolean;
  pid: number | null;
}

export interface MameController {
  buildArgs(): string[];
  start(): MameStart;
  stop(): Promise<void>;
  status(): MameStatus;
  onUnexpectedExit(cb: (code: number | null) => void): void;
}

export function createMameController(
  config: AppConfig,
  spawner: Spawner = defaultSpawner,
  platform: NodeJS.Platform = process.platform,
): MameController {
  let child: Spawned | null = null;
  let logFd: number | null = null;
  let lastExit: number | null = null;
  let intentional = false;
  const listeners: Array<(code: number | null) => void> = [];

  function closeLog(): void {
    if (logFd === null) return;
    try {
      closeSync(logFd);
    } catch {
      // The descriptor may already be closed.
    }
    logFd = null;
  }

  return {
    buildArgs() {
      return buildMameArgs(config);
    },
    start() {
      if (!config.mamePath) throw new Error("MAME_PATH is not set");
      if (!config.mameRomPath) throw new Error("MAME_ROMPATH is not set");
      if (child) return { started: false, alreadyRunning: true, pid: child.pid ?? null };
      intentional = false;
      writeBridgePortFile(config);
      mkdirSync(config.logDir, { recursive: true });
      const fd = openSync(path.join(config.logDir, "mame.log"), "a");
      logFd = fd;
      const spawned = spawner.spawn(config.mamePath, buildMameArgs(config), {
        cwd: path.dirname(config.mamePath),
        env: { ...process.env, BRIDGE_PORT: String(config.bridgePort) },
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
      child = spawned;
      lastExit = null;
      spawned.on("exit", (code) => {
        lastExit = code;
        if (child === spawned) child = null;
        closeLog();
        if (!intentional) {
          for (const listener of listeners) listener(code);
        }
      });
      return { started: true, alreadyRunning: false, pid: spawned.pid ?? null };
    },
    async stop() {
      if (!child) return;
      intentional = true;
      const current = child;
      const pid = current.pid;
      if (platform === "win32" && pid !== undefined) {
        await new Promise<void>((resolve) => {
          const killer = spawner.spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          killer.on("exit", () => resolve());
        });
      } else {
        current.kill("SIGTERM");
      }
      if (child === current) child = null;
      closeLog();
    },
    status() {
      return {
        running: child !== null,
        pid: child?.pid ?? null,
        exitCode: child ? null : lastExit,
      };
    },
    onUnexpectedExit(cb) {
      listeners.push(cb);
    },
  };
}
