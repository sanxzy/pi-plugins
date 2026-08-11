import { spawn, type ChildProcess } from "node:child_process";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface ProcessStdioOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: "pipe" | "inherit" | "overlapped";
}

const CLOSE_GRACE_MS = 150;
const STDERR_LIMIT = 32 * 1024;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Terminate a local MCP process and all descendants in its dedicated group. */
export async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already gone.
      return;
    }
  }
  await wait(CLOSE_GRACE_MS);
  // Kill the whole group even if the direct child already exited, so that
  // orphans spawned by the server cannot outlive the owning session.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The group is fully gone.
    }
  }
}

/**
 * Stdio MCP transport with bounded stderr consumption and process-group cleanup.
 * A detached Unix child gives the launched server a private process group so a
 * server-created descendant cannot outlive the owning session.
 */
export class ProcessStdioTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private child?: ChildProcess;
  private closing?: Promise<void>;
  private stderrBuffer = "";
  private started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(private readonly options: ProcessStdioOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderrText(): string {
    return this.stderrBuffer;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("ProcessStdioTransport already started");
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: this.options.env,
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: process.platform === "win32",
        stdio: ["pipe", "pipe", this.options.stderr ?? "inherit"],
      });
      this.child = child;
      child.once("error", (error) => {
        this.onerror?.(error);
        reject(error);
      });
      child.once("spawn", () => {
        if (this.closing) {
          // A timeout or cancellation closed the transport while the OS was
          // still spawning. Terminate the freshly spawned group so a slow
          // spawn cannot defeat the startup timeout or leak the process.
          const pid = child.pid;
          if (pid) void terminateProcessTree(pid);
          reject(new Error("ProcessStdioTransport closed during startup"));
          return;
        }
        resolve();
      });
      child.once("close", () => {
        if (this.child === child) this.child = undefined;
        this.onclose?.();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        while (true) {
          try {
            const message = this.readBuffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            break;
          }
        }
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stderr?.on("data", (chunk: Buffer) => {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-STDERR_LIMIT);
      });
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error("MCP stdio transport is not connected");
    const serialized = serializeMessage(message);
    if (stdin.write(serialized)) return;
    await new Promise<void>((resolve, reject) => {
      stdin.once("drain", resolve);
      stdin.once("error", reject);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    this.closing = (async () => {
      if (!child?.pid) {
        this.readBuffer.clear();
        return;
      }
      try {
        child.stdin?.end();
      } catch {
        // Continue with process-group termination.
      }
      await wait(CLOSE_GRACE_MS);
      await terminateProcessTree(child.pid);
      this.child = undefined;
      this.readBuffer.clear();
    })();
    return this.closing;
  }
}