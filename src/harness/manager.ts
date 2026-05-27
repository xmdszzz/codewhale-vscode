import * as cp from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import { CodewhaleClient } from "./client";
import { BinaryDownloader } from "./downloader";

/**
 * Subprocess lifecycle manager for codewhale-tui serve --http.
 *
 * Responsibilities:
 *  - Auto-download binary via GitHub Releases (if missing)
 *  - Allocate a port (hash-based with conflict detection)
 *  - Spawn `codewhale-tui serve --http --port <p>`
 *  - Health-check until the server is ready
 *  - Auto-reconnect on unexpected exit
 *  - Graceful shutdown on deactivate
 */

const PORT_RANGE_START = 7878;
const PORT_RANGE_END = 7978;
const PORT_MAX_RETRIES = 5;
const HEALTH_POLL_MS = 300;
const HEALTH_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class CodewhaleManager extends EventEmitter {
  private process: cp.ChildProcess | null = null;
  private client: CodewhaleClient | null = null;
  private port = 0;
  private downloader: BinaryDownloader;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private seed = "";

  constructor(
    storagePath: string,
    private readonly binaryVersion: string,
    private readonly customBinaryPath?: string,
    private env?: Record<string, string>
  ) {
    super();
    this.downloader = new BinaryDownloader(storagePath, binaryVersion);
  }

  // ── Binary ─────────────────────────────────────────────────

  get binaryPath(): string {
    return this.customBinaryPath ?? this.downloader.binaryPath;
  }

  /** Download the binary if not already installed. */
  async ensureBinary(): Promise<void> {
    if (this.customBinaryPath) return; // user-provided, skip download

    if (this.downloader.isInstalled()) return;

    this.emit("download", { phase: "started" });
    this.downloader.on("progress", (p) => this.emit("download", p));
    try {
      await this.downloader.ensure();
      this.emit("download", { phase: "done" });
    } catch (err) {
      this.emit("download", {
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // ── Port allocation ────────────────────────────────────────

  private portFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async allocatePort(seed: string): Promise<number> {
    const hash = [...seed].reduce(
      (h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0,
      0
    );
    let port =
      PORT_RANGE_START +
      (Math.abs(hash) % (PORT_RANGE_END - PORT_RANGE_START));

    for (let i = 0; i < PORT_MAX_RETRIES; i++) {
      if (await this.portFree(port)) return port;
      port = port < PORT_RANGE_END ? port + 1 : PORT_RANGE_START;
    }

    throw new Error(
      `All ${PORT_RANGE_END - PORT_RANGE_START} ports in range ${PORT_RANGE_START}-${PORT_RANGE_END} are in use. ` +
      `Close other CodeWhale instances or free a port and try again.`
    );
  }

  // ── Spawn ──────────────────────────────────────────────────

  /** Start the codewhale-tui server and wait for it to become healthy. */
  async start(seed: string): Promise<{ client: CodewhaleClient; port: number }> {
    this.seed = seed;
    this.shuttingDown = false;

    await this.ensureBinary();
    this.port = await this.allocatePort(seed);

    const spawnEnv = { ...process.env, ...this.env };
    if (this.env && Object.keys(this.env).length > 0) {
      console.log("[CodeWhale] injecting env vars:", Object.keys(this.env).join(", "));
    }
    this.process = cp.spawn(
      this.binaryPath,
      ["serve", "--http", "--port", String(this.port)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv,
      }
    );

    // Capture auth token from server stdout (printed early in startup)
    let authToken: string | undefined;
    let stdoutBuf = "";
    const TOKEN_RE = /Authorization:\s*Bearer\s+(\S+)/;

    this.process.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      this.emit("stdout", text);
      stdoutBuf += text;
    });

    this.process.stderr?.on("data", (d: Buffer) =>
      this.emit("stderr", d.toString())
    );
    this.process.on("exit", (code) => {
      this.emit("exit", code);
      if (!this.shuttingDown && code !== 0 && code !== null) {
        this._scheduleReconnect();
      }
    });

    // Wait briefly for the token (server prints it at startup)
    const tokenDeadline = Date.now() + 10_000;
    while (!authToken && Date.now() < tokenDeadline) {
      const m = stdoutBuf.match(TOKEN_RE);
      if (m) {
        authToken = m[1];
        break;
      }
      await sleep(100);
    }

    // Clean up previous client before creating a new one
    this.client?.removeAllListeners();
    this.client = null;

    // Health-check until ready
    const client = new CodewhaleClient(this.port, authToken);
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const h = await client.health();
        if (h.status === "ok") {
          this.client = client;
          this.reconnectAttempts = 0;
          this.emit("ready", { port: this.port });
          return { client, port: this.port };
        }
      } catch {
        // not ready yet
      }
      await sleep(HEALTH_POLL_MS);
    }

    this.stop();
    throw new Error(
      `codewhale-tui did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`
    );
  }

  // ── Reconnection ───────────────────────────────────────────

  private _scheduleReconnect() {
    if (this.shuttingDown || this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempts++;

    this.emit("reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        const result = await this.start(this.seed);
        this.emit("reconnected", { port: result.port, client: result.client });
      } catch {
        // Will schedule another retry via the exit handler
      }
    }, delay);
  }

  // ── Shutdown ───────────────────────────────────────────────

  /** Gracefully stop the server, then force-kill if needed. */
  stop(): void {
    this.shuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const proc = this.process;
    if (!proc) return;

    // Clean up old client listeners
    this.client?.removeAllListeners();
    this.client = null;

    const shutdownTimeout = 2000;

    // Try graceful HTTP shutdown
    try {
      const req = http.request(
        `http://127.0.0.1:${this.port}/shutdown`,
        { method: "POST" },
        (res) => {
          res.resume(); // drain response
          // Wait briefly for the process to exit gracefully, then force-kill
          setTimeout(() => {
            if (proc.exitCode === null) proc.kill();
          }, shutdownTimeout);
        }
      );
      req.on("error", () => {
        // If shutdown endpoint fails, force-kill immediately
        if (proc.exitCode === null) proc.kill();
      });
      req.setTimeout(shutdownTimeout, function (this: import("node:http").ClientRequest) {
        this.destroy();
      });
      req.end();
    } catch {
      if (proc.exitCode === null) proc.kill();
    }
  }

  /** Update environment and restart the server with new config. */
  async restart(newEnv: Record<string, string>): Promise<{ client: CodewhaleClient; port: number }> {
    this.shuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this.client = null;

    // Poll until the old port is released, with a 10s timeout
    const portWas = this.port;
    if (portWas > 0) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await this.portFree(portWas)) break;
        await sleep(100);
      }
    }

    this.env = newEnv;
    this.shuttingDown = false;
    return this.start(this.seed);
  }

  /** The running client; undefined if not yet healthy or disconnected. */
  getClient(): CodewhaleClient | null {
    return this.client;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
