import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

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

test("stdio server lists every coco tool and describes the MMU window", { timeout: 20_000 }, async () => {
  const tsxPkg = JSON.parse(readFileSync(path.join(root, "node_modules", "tsx", "package.json"), "utf8")) as {
    bin: string | { tsx: string };
  };
  const binRel = typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin.tsx;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "node_modules", "tsx", binRel), path.join(root, "src", "index.ts")],
    cwd: root,
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        MAME_PATH: path.join(root, "mame.exe"),
        MAME_ROMPATH: path.join(root, "roms"),
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  });
  const client = new Client({ name: "coco3-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      TOOL_NAMES,
    );
    const read = listed.tools.find((tool) => tool.name === "coco_read_memory");
    const write = listed.tools.find((tool) => tool.name === "coco_write_memory");
    assert.match(read?.description ?? "", /current 64K MMU window/);
    assert.match(read?.description ?? "", /not physical RAM/);
    assert.match(read?.description ?? "", /\$0400/);
    assert.match(write?.description ?? "", /current 64K MMU window/);
    assert.match(write?.description ?? "", /not physical RAM/);
  } finally {
    await client.close();
  }
});
