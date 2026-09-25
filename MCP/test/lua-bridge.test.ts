import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("bridge.lua stays on the MAME allow-list", async () => {
  const src = await readFile(path.join(root, "scripts", "bridge.lua"), "utf8");
  assert.equal(pathToFileURL(path.join(root, "scripts", "bridge.lua")).protocol, "file:");
  assert.doesNotMatch(src, /require\s*\(/);
  assert.doesNotMatch(src, /floppydisc/);
  assert.doesNotMatch(src, /hard_reset/);
  assert.doesNotMatch(src, /mame\.machine\s*\(/);
  assert.doesNotMatch(src, /0E00/);
  for (const needle of [
    "manager.machine",
    "emu.register_frame",
    "emu.file",
    "socket.127.0.0.1",
    "BRIDGE_PORT",
    "18765",
    "os.getenv",
    "in_use",
    "is_posting",
    "empty",
    "soft_reset",
    ":snapshot",
    "video:snapshot",
    "read_u8",
    "write_u8",
    "briefname",
    "brief_instance_name",
    "flop1",
    "flop2",
    "pcall",
    ":save",
    ":load",
    ":unload",
    "ping",
    "wait_idle",
    "list_images",
    "read_mem",
    "write_mem",
    "save_state",
    "load_state",
    "unmount",
    "machine not ready",
    "1024",
    "invalid data byte",
    "address outside current 64K MMU window",
    "^%x%x$",
  ]) {
    assert.equal(src.includes(needle), true, needle);
  }
  assert.equal(src.split("post_coded").length - 1, 1);
});

// bridge.lua has no local Lua interpreter to execute against (see AGENTS.md test
// runner notes), so this is a source-level regression guard, not a behavioral test:
// it locks in that cmd_write_mem validates every token up front instead of silently
// keeping only the substrings that happen to look like hex pairs.
test("bridge.lua write_mem validates the whole data string before writing", async () => {
  const src = await readFile(path.join(root, "scripts", "bridge.lua"), "utf8");
  const start = src.indexOf("local function cmd_write_mem");
  assert.ok(start >= 0, "cmd_write_mem not found");
  const end = src.indexOf("\nend", start);
  const body = src.slice(start, end);
  assert.match(body, /error\("address outside current 64K MMU window"\)/);
  assert.match(body, /error\("invalid data byte: "/);
  assert.match(body, /string\.match\(token, "\^%x%x\$"\)/);
});

// Same caveat as above: source-level guard, not a behavioral test. Locks in that
// cmd_mount no longer unloads the current image before load() is confirmed to
// succeed (per MAME Lua Scripting Interface docs, image:load(filename) reports
// success/failure via its own return value — no separate unload is documented as
// required first: https://docs.mamedev.org/luascript/ref-devices.html).
test("bridge.lua mount does not discard the current image before load succeeds", async () => {
  const src = await readFile(path.join(root, "scripts", "bridge.lua"), "utf8");
  const start = src.indexOf("local function cmd_mount");
  assert.ok(start >= 0, "cmd_mount not found");
  const end = src.indexOf("\nend", start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /:unload\(\)/);
  assert.match(body, /image:load\(params\.path\)/);
});
