import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createBridgeServer } from "../src/bridge-server.js";

function onceConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => resolve());
  });
}

test("bridge listens on 127.0.0.1 and correlates response ids", async () => {
  const bridge = createBridgeServer(0);
  const sockets: net.Socket[] = [];
  try {
    await bridge.start();
    assert.equal(bridge.address, "127.0.0.1");
    assert.equal(bridge.listening, true);
    assert.ok(bridge.port > 0);

    const socket = net.connect(bridge.port, "127.0.0.1");
    sockets.push(socket);
    await onceConnect(socket);
    let buf = "";
    const seen: Array<{ id: string; cmd: string }> = [];
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as { id: string; cmd: string };
        buf = buf.slice(nl + 1);
        seen.push(req);
        if (seen.length === 2) {
          const [first, second] = seen;
          socket.write(JSON.stringify({ id: second.id, ok: true, result: { cmd: second.cmd } }) + "\n");
          socket.write(JSON.stringify({ id: first.id, ok: true, result: { cmd: first.cmd } }) + "\n");
        }
        nl = buf.indexOf("\n");
      }
    });

    const first = bridge.request("ping", {});
    const second = bridge.request("status", {});
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.id, "1");
    assert.equal(right.id, "2");
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (left.ok) assert.deepEqual(left.result, { cmd: "ping" });
    if (right.ok) assert.deepEqual(right.result, { cmd: "status" });
  } finally {
    for (const socket of sockets) socket.destroy();
    await bridge.stop();
  }
});

test("request without a client reports that the bridge is not connected", async () => {
  const bridge = createBridgeServer(0);
  try {
    await bridge.start();
    await assert.rejects(() => bridge.request("status", {}), /bridge not connected/);
  } finally {
    await bridge.stop();
  }
});

test("a malformed line reaches onProtocolError instead of being silently dropped", async () => {
  const seen: Array<{ line: string; error: unknown }> = [];
  const bridge = createBridgeServer(0, (line, error) => seen.push({ line, error }));
  let socket: net.Socket | undefined;
  try {
    await bridge.start();
    socket = net.connect(bridge.port, "127.0.0.1");
    await onceConnect(socket);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const req = JSON.parse(buf.slice(0, nl)) as { id: string; cmd: string };
        buf = buf.slice(nl + 1);
        socket?.write("not json at all\n");
        socket?.write(JSON.stringify({ id: req.id, ok: true, result: {} }) + "\n");
        nl = buf.indexOf("\n");
      }
    });
    const response = await bridge.request("ping", {});
    assert.equal(response.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].line, "not json at all");
    assert.ok(seen[0].error instanceof Error);
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});

test("request times out when the client stays silent", async () => {
  const bridge = createBridgeServer(0);
  let socket: net.Socket | undefined;
  try {
    await bridge.start();
    socket = net.connect(bridge.port, "127.0.0.1");
    await onceConnect(socket);
    socket.on("data", () => undefined);
    await assert.rejects(() => bridge.request("ping", {}, 200), /ping/);
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});
