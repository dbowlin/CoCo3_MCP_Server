import { spawn } from "node:child_process";

export interface DiskFile {
  hostPath: string;
  cocoName: string;
  kind: "bas" | "bin" | "data";
}

export interface BuildDiskRequest {
  dskPath: string;
  files: DiskFile[];
}

export interface DecbStep {
  args: string[];
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[]): Promise<CommandResult>;
}

export function planDecbSteps(req: BuildDiskRequest): DecbStep[] {
  const steps: DecbStep[] = [{ args: ["dskini", "-3", req.dskPath] }];
  for (const file of req.files) {
    if (file.kind !== "bas" && file.kind !== "bin" && file.kind !== "data") {
      throw new Error(`unknown coco file kind: ${String(file.kind)}`);
    }
    if (!file.cocoName || /[,/\\]/.test(file.cocoName)) {
      throw new Error(`invalid coco name: ${file.cocoName}`);
    }
    const destination = `${req.dskPath},${file.cocoName}`;
    if (file.kind === "bas") steps.push({ args: ["copy", "-t", file.hostPath, destination] });
    else steps.push({ args: ["copy", file.hostPath, destination] });
  }
  return steps;
}

function makeDefaultRunner(cwd?: string): CommandRunner {
  return {
    run(command, args) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, cwd });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

export interface Toolchain {
  buildDisk(req: BuildDiskRequest): Promise<{ dskPath: string; steps: string[] }>;
}

export function createToolchain(decbPath: string, runner?: CommandRunner, cwd?: string): Toolchain {
  const active = runner ?? makeDefaultRunner(cwd);
  return {
    async buildDisk(req) {
      const planned = planDecbSteps(req);
      const steps: string[] = [];
      for (const step of planned) {
        const result = await active.run(decbPath, step.args);
        if (result.code !== 0) {
          const message = result.stderr.trim() || result.stdout.trim() || `decb exited ${result.code}`;
          throw new Error(message);
        }
        steps.push(step.args.join(" "));
      }
      return { dskPath: req.dskPath, steps };
    },
  };
}
