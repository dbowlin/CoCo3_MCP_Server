import net from "node:net";
import { encodeRequest, parseResponseLine, type BridgeResponse } from "./protocol.js";

export interface BridgeClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponse>;
  readonly listening: boolean;
  readonly port: number;
  readonly address: string;
}

interface Pending {
  resolve: (value: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Called with the raw line and the parse/dispatch error whenever a message from the
 * Lua bridge can't be turned into a BridgeResponse. Previously these were dropped with
 * no observability at all; a malformed line from MAME now shows up in the caller's log
 * instead of silently vanishing.
 */
export type OnBridgeProtocolError = (line: string, error: unknown) => void;

export function createBridgeServer(port: number, onProtocolError?: OnBridgeProtocolError): BridgeClient {
  let server: net.Server | null = null;
  let socket: net.Socket | null = null;
  let buffer = "";
  let nextId = 1;
  let boundPort = port;
  const pending = new Map<string, Pending>();

  function failAll(error: Error): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function onData(chunk: Buffer | string): void {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = parseResponseLine(line);
        const entry = pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.id);
          entry.resolve(message);
        }
      } catch (error) {
        // Malformed line: keep the socket open (one bad line should not end the
        // session), but surface it so it is not silently invisible.
        onProtocolError?.(line, error);
      }
      newline = buffer.indexOf("\n");
    }
  }

  return {
    get listening() {
      return Boolean(server?.listening);
    },
    get port() {
      return boundPort;
    },
    get address() {
      return "127.0.0.1";
    },
    async start() {
      if (server) return;
      const created = net.createServer((sock) => {
        if (socket && socket !== sock) {
          socket.removeAllListeners("data");
          socket.destroy();
        }
        buffer = "";
        socket = sock;
        sock.on("data", onData);
        sock.on("error", () => undefined);
        sock.on("close", () => {
          if (socket === sock) socket = null;
          failAll(new Error("bridge not connected"));
        });
      });
      server = created;
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(port, "127.0.0.1", () => {
          const addr = created.address();
          if (addr && typeof addr === "object") boundPort = addr.port;
          resolve();
        });
      });
    },
    async stop() {
      failAll(new Error("bridge not connected"));
      const current = socket;
      socket = null;
      current?.destroy();
      const listening = server;
      server = null;
      if (!listening) return;
      await new Promise<void>((resolve) => {
        listening.close(() => resolve());
      });
    },
    request(cmd, params, timeoutMs = 5000) {
      if (!socket || socket.destroyed) return Promise.reject(new Error("bridge not connected"));
      const id = String(nextId);
      nextId += 1;
      const line = encodeRequest({ id, cmd, params });
      const active = socket;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${cmd}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        active.write(line);
      });
    },
  };
}
