import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { buildMameArgs } from "../src/mame-process.js";

test("buildMameArgs matches the required coco3 command", () => {
  const root = path.resolve("C:/coco/MCP");
  const cfg = loadConfig(
    {
      MAME_PATH: "C:\\mame\\mame.exe",
      MAME_ROMPATH: "C:\\mame\\roms",
      COCO_RAM: "512K",
    },
    root,
  );
  assert.deepEqual(buildMameArgs(cfg), [
    "coco3",
    "-window",
    "-skip_gameinfo",
    "-natural",
    "-nomouse",
    "-mouse_device",
    "none",
    "-ext",
    "fdc",
    "-ramsize",
    "512K",
    "-rompath",
    "C:\\mame\\roms",
    "-autoboot_script",
    path.join(root, "scripts", "bridge.lua"),
    "-autoboot_delay",
    "0",
    "-snapshot_directory",
    path.join(root, "snapshots"),
    "-state_directory",
    path.join(root, "states"),
  ]);
  assert.equal(buildMameArgs(cfg).includes("-console"), false);
  assert.equal(path.isAbsolute(buildMameArgs(cfg)[14]), true);
});
