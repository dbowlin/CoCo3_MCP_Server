import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AppConfig {
  mamePath: string;
  mameRomPath: string;
  decbPath: string;
  bridgePort: number;
  cocoRam: string;
  rootDir: string;
  bridgeLuaPath: string;
  bridgePortFile: string;
  snapshotDir: string;
  stateDir: string;
  workDir: string;
  logDir: string;
  /** Root for user disks and host files: storage/ */
  storageDir: string;
  /** Disk images (.dsk): storage/disks */
  disksDir: string;
  /** Host BASIC sources: storage/host/bas */
  hostBasDir: string;
  /** Host binaries: storage/host/bin */
  hostBinDir: string;
  /** Other host data files: storage/host/data */
  hostDataDir: string;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 18765;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid BRIDGE_PORT: ${raw}`);
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new Error(`invalid BRIDGE_PORT: ${raw}`);
  }
  return port;
}

/** Resolve relative tool paths against the MCP root; leave bare commands (e.g. decb) alone. */
function resolveToolPath(raw: string, root: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (path.isAbsolute(text)) return path.normalize(text);
  if (!/[\\/]/.test(text) && !text.startsWith(".")) return text;
  return path.resolve(root, text);
}

export function loadConfig(env: Record<string, string | undefined>, rootDir: string): AppConfig {
  const root = path.resolve(rootDir);
  const bridgeLuaPath = path.join(root, "scripts", "bridge.lua");
  const storageDir = path.join(root, "storage");
  return {
    mamePath: resolveToolPath(env.MAME_PATH ?? "", root),
    mameRomPath: resolveToolPath(env.MAME_ROMPATH ?? "", root),
    decbPath: resolveToolPath(env.DECB_PATH ?? "decb", root),
    bridgePort: parsePort(env.BRIDGE_PORT),
    cocoRam: env.COCO_RAM ?? "512K",
    rootDir: root,
    bridgeLuaPath,
    bridgePortFile: path.join(path.dirname(bridgeLuaPath), "bridge.port"),
    snapshotDir: path.join(root, "snapshots"),
    stateDir: path.join(root, "states"),
    workDir: path.join(root, "work"),
    logDir: path.join(root, "logs"),
    storageDir,
    disksDir: path.join(storageDir, "disks"),
    hostBasDir: path.join(storageDir, "host", "bas"),
    hostBinDir: path.join(storageDir, "host", "bin"),
    hostDataDir: path.join(storageDir, "host", "data"),
  };
}

/** Writes scripts/bridge.port so Lua can read BRIDGE_PORT when os.getenv is unavailable. */
export function writeBridgePortFile(config: AppConfig): void {
  mkdirSync(path.dirname(config.bridgePortFile), { recursive: true });
  writeFileSync(config.bridgePortFile, `${config.bridgePort}\n`, "utf8");
}

export function loadDotEnv(filePath: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}
