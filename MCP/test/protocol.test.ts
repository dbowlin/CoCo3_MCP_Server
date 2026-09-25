import assert from "node:assert/strict";
import test from "node:test";
import { encodeRequest, parseResponseLine } from "../src/protocol.js";

test("encodeRequest writes one JSON object and a newline", () => {
  const line = encodeRequest({
    id: "1",
    cmd: "mount",
    params: { briefname: "flop1", path: "C:\\games\\a.dsk" },
  });
  assert.equal(line.includes("\n"), true);
  assert.equal(line.indexOf("\n"), line.length - 1);
  assert.equal(
    line,
    JSON.stringify({
      id: "1",
      cmd: "mount",
      params: { briefname: "flop1", path: "C:\\games\\a.dsk" },
    }) + "\n",
  );
});

test("encodeRequest defaults omitted params to an object", () => {
  assert.equal(encodeRequest({ id: "2", cmd: "status" }), JSON.stringify({ id: "2", cmd: "status", params: {} }) + "\n");
});

test("parseResponseLine accepts success, a missing result, and errors", () => {
  assert.deepEqual(parseResponseLine('{"id":"1","ok":true,"result":{"t":1}}\n'), {
    id: "1",
    ok: true,
    result: { t: 1 },
  });
  assert.deepEqual(parseResponseLine('  {"id":"1","ok":true}  \n'), {
    id: "1",
    ok: true,
    result: {},
  });
  assert.deepEqual(parseResponseLine('{"id":"1","ok":false,"error":"no flop1 image device"}'), {
    id: "1",
    ok: false,
    error: "no flop1 image device",
  });
  assert.deepEqual(parseResponseLine('{"id":"1","ok":false,"error":12}'), {
    id: "1",
    ok: false,
    error: "bridge error",
  });
});

test("parseResponseLine rejects malformed lines", () => {
  assert.throws(() => parseResponseLine("not json"));
  assert.throws(() => parseResponseLine('{"ok":true}'));
  assert.throws(() => parseResponseLine('{"id":1,"ok":true}'));
  assert.throws(() => parseResponseLine('{"id":"1","ok":"yes"}'));
});
