export interface BridgeRequest {
  id: string;
  cmd: string;
  params?: Record<string, unknown>;
}

export interface BridgeSuccess {
  id: string;
  ok: true;
  result: unknown;
}

export interface BridgeFailure {
  id: string;
  ok: false;
  error: string;
}

export type BridgeResponse = BridgeSuccess | BridgeFailure;

export function encodeRequest(req: BridgeRequest): string {
  return JSON.stringify({ id: req.id, cmd: req.cmd, params: req.params ?? {} }) + "\n";
}

export function parseResponseLine(line: string): BridgeResponse {
  let value: unknown;
  try {
    value = JSON.parse(line.trim());
  } catch {
    throw new Error("invalid bridge json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid bridge response");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") throw new Error("invalid bridge id");
  if (typeof record.ok !== "boolean") throw new Error("invalid bridge ok");
  if (record.ok) {
    const result = record.result === undefined || record.result === null ? {} : record.result;
    return { id: record.id, ok: true, result };
  }
  return {
    id: record.id,
    ok: false,
    error: typeof record.error === "string" ? record.error : "bridge error",
  };
}
