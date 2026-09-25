import assert from "node:assert/strict";
import test from "node:test";
import { createToolchain, planDecbSteps } from "../src/toolchain.js";

test("planDecbSteps tokenizes BASIC and copies bin and data unchanged", () => {
  assert.deepEqual(
    planDecbSteps({
      dskPath: "C:\\work\\hi.dsk",
      files: [
        { hostPath: "C:\\work\\hi.bas", cocoName: "HI.BAS", kind: "bas" },
        { hostPath: "C:\\work\\hi.bin", cocoName: "HI.BIN", kind: "bin" },
        { hostPath: "C:\\work\\hi.dat", cocoName: "HI.DAT", kind: "data" },
      ],
    }),
    [
      { args: ["dskini", "-3", "C:\\work\\hi.dsk"] },
      { args: ["copy", "-t", "C:\\work\\hi.bas", "C:\\work\\hi.dsk,HI.BAS"] },
      { args: ["copy", "C:\\work\\hi.bin", "C:\\work\\hi.dsk,HI.BIN"] },
      { args: ["copy", "C:\\work\\hi.dat", "C:\\work\\hi.dsk,HI.DAT"] },
    ],
  );
});

test("planDecbSteps rejects empty, punctuated, and unknown coco names", () => {
  const dskPath = "a.dsk";
  assert.throws(() => planDecbSteps({ dskPath, files: [{ hostPath: "a", cocoName: "", kind: "bas" }] }));
  assert.throws(() => planDecbSteps({ dskPath, files: [{ hostPath: "a", cocoName: "A,B", kind: "bas" }] }));
  assert.throws(() => planDecbSteps({ dskPath, files: [{ hostPath: "a", cocoName: "A/B", kind: "bin" }] }));
  assert.throws(() => planDecbSteps({ dskPath, files: [{ hostPath: "a", cocoName: "A\\B", kind: "data" }] }));
  assert.throws(() =>
    planDecbSteps({ dskPath, files: [{ hostPath: "a", cocoName: "A.BAS", kind: "nope" as "bas" }] }),
  );
});

test("buildDisk stops at the first decb error and returns its stderr", async () => {
  const seen: Array<{ command: string; args: string[] }> = [];
  const toolchain = createToolchain("C:\\toolshed\\decb.exe", {
    async run(command, args) {
      seen.push({ command, args });
      if (args[0] === "copy") return { code: 1, stdout: "", stderr: "disk full" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(
    () =>
      toolchain.buildDisk({
        dskPath: "o.dsk",
        files: [
          { hostPath: "a.bas", cocoName: "A.BAS", kind: "bas" },
          { hostPath: "b.bin", cocoName: "B.BIN", kind: "bin" },
        ],
      }),
    /disk full/,
  );
  assert.deepEqual(
    seen.map((call) => call.command),
    ["C:\\toolshed\\decb.exe", "C:\\toolshed\\decb.exe"],
  );
  assert.deepEqual(
    seen.map((call) => call.args),
    [
      ["dskini", "-3", "o.dsk"],
      ["copy", "-t", "a.bas", "o.dsk,A.BAS"],
    ],
  );
});

test("buildDisk uses stdout when stderr is empty and returns step lines", async () => {
  const toolchain = createToolchain("decb", {
    async run(_command, args) {
      if (args[0] === "dskini") return { code: 2, stdout: "boom-stdout", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(() => toolchain.buildDisk({ dskPath: "o.dsk", files: [] }), /boom-stdout/);

  const ok = createToolchain("decb", {
    async run() {
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const result = await ok.buildDisk({
    dskPath: "o.dsk",
    files: [{ hostPath: "a.bas", cocoName: "A.BAS", kind: "bas" }],
  });
  assert.deepEqual(result, {
    dskPath: "o.dsk",
    steps: ["dskini -3 o.dsk", "copy -t a.bas o.dsk,A.BAS"],
  });
});
