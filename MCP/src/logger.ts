import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface Logger {
  log(message: string): void;
  logPath: string;
}

export function createLogger(logDir: string): Logger {
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "mcp.log");
  return {
    logPath,
    log(message: string) {
      const line = `[${new Date().toISOString()}] ${message}\n`;
      process.stderr.write(line);
      appendFileSync(logPath, line);
    },
  };
}
