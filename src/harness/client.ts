import * as http from "node:http";
import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import {
  HealthResponse,
  CreateThreadRequest,
  ThreadRecord,
  ThreadSummary,
  UpdateThreadRequest,
  StartTurnRequest,
  SseEventEnvelope,
  ApprovalDecisionRequest,
  ModelEntry,
} from "./types";

/**
 * HTTP/SSE client for codewhale-tui serve --http.
 *
 * Methods (request → response):
 *   GET  /health              → { status, service, mode }
 *   POST /v1/threads          → ThreadRecord (create)
 *   GET  /v1/threads          → ThreadRecord[] (list)
 *   GET  /v1/threads/summary  → ThreadSummary[] (summaries)
 *   GET  /v1/threads/{id}     → { thread: ThreadRecord, turns: TurnRecord[] }
 *   PATCH /v1/threads/{id}    → ThreadRecord (update)
 *   POST /v1/threads/{id}/turns → TurnRecord (start a turn)
 *   GET  /v1/threads/{id}/events → SSE stream (wraps in EventEmitter)
 *   POST /v1/approvals/{id}   → submit approval decision
 */

export class CodewhaleClient extends EventEmitter {
  private baseUrl: string;
  private authToken: string | null;

  constructor(port: number, authToken?: string) {
    super();
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.authToken = authToken ?? null;
  }

  // ── JSON helpers ──────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        url,
        {
          method,
          headers: {
            ...headers,
            ...(payload ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            try {
              const json = JSON.parse(raw) as T;
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`[${res.statusCode}] ${raw}`));
              } else {
                resolve(json);
              }
            } catch {
              reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(30_000, () => {
        req.destroy(new Error("Request timeout"));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Health ─────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    return this.request("GET", "/health");
  }

  // ── Threads ────────────────────────────────────────────────

  async createThread(params: CreateThreadRequest = {}): Promise<ThreadRecord> {
    return this.request("POST", "/v1/threads", params);
  }

  async listThreads(
    limit = 50,
    includeArchived = false
  ): Promise<ThreadRecord[]> {
    const qs = new URLSearchParams({
      limit: String(limit),
      include_archived: String(includeArchived),
    });
    return this.request("GET", `/v1/threads?${qs}`);
  }

  async listThreadSummaries(
    limit = 50,
    search?: string
  ): Promise<ThreadSummary[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (search) qs.set("search", search);
    return this.request("GET", `/v1/threads/summary?${qs}`);
  }

  async getThread(
    id: string
  ): Promise<{ thread: ThreadRecord; turns: unknown[] }> {
    return this.request("GET", `/v1/threads/${id}`);
  }

  async updateThread(
    id: string,
    changes: UpdateThreadRequest
  ): Promise<ThreadRecord> {
    return this.request("PATCH", `/v1/threads/${id}`, changes);
  }

  async resumeThread(id: string): Promise<ThreadRecord> {
    return this.request("POST", `/v1/threads/${id}/resume`, {});
  }

  async forkThread(id: string): Promise<ThreadRecord> {
    return this.request("POST", `/v1/threads/${id}/fork`, {});
  }

  async compactThread(id: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/v1/threads/${id}/compact`, {});
  }

  async deleteThread(id: string): Promise<{ ok: boolean }> {
    // Try POST pattern first (matching compact/resume/fork conventions)
    try {
      return await this.request("POST", `/v1/threads/${id}/delete`, {});
    } catch {
      // Fall back to standard REST DELETE
      return this.request("DELETE", `/v1/threads/${id}`);
    }
  }

  // ── Turns ──────────────────────────────────────────────────

  async startTurn(
    threadId: string,
    params: StartTurnRequest
  ): Promise<unknown> {
    return this.request("POST", `/v1/threads/${threadId}/turns`, params);
  }

  // ── SSE event stream ───────────────────────────────────────

  /**
   * Connect to the SSE event stream for a thread.
   * Emits "event" for each parsed SseEventEnvelope, and "end" on close.
   * Returns an AbortController for cancellation.
   */
  streamEvents(threadId: string, sinceSeq = 0): AbortController {
    const ac = new AbortController();
    const url = new URL(
      `/v1/threads/${threadId}/events?since_seq=${sinceSeq}`,
      this.baseUrl
    );

    const doGet = () => {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (this.authToken) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }
      http
        .get(
          url,
          {
            headers,
            signal: ac.signal,
          },
          (res) => {
            let buffer = "";
            res.on("data", (chunk: Buffer) => {
              buffer += chunk.toString("utf-8");
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              let currentData = "";
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  currentData += line.slice(6);
                } else if (line === "" && currentData) {
                  try {
                    const parsed = JSON.parse(currentData) as SseEventEnvelope;
                    this.emit("event", parsed);
                  } catch {
                    // skip unparseable events
                  }
                  currentData = "";
                }
              }
            });
            res.on("end", () => this.emit("end"));
            res.on("error", (err) => {
              if (!ac.signal.aborted) this.emit("error", err);
            });
          }
        )
        .on("error", (err) => {
          if (!ac.signal.aborted) this.emit("error", err);
        });
    };

    doGet();
    return ac;
  }

  // ── Approval ───────────────────────────────────────────────

  async submitApproval(
    approvalId: string,
    decision: ApprovalDecisionRequest
  ): Promise<unknown> {
    return this.request("POST", `/v1/approvals/${approvalId}`, decision);
  }

  // ── Models ─────────────────────────────────────────────────
  //
  // Note: the HTTP runtime API does not expose a /v1/models endpoint.
  // Model list is obtained by calling the CLI binary separately:
  //   codewhale-tui models --json
  //
  // This helper parses the CLI output, which returns a JSON array of
  // { id: string, owned_by: string } objects.
}

/**
 * Run `codewhale-tui models --json` and return the parsed model list.
 * `binaryPath` must point to the codewhale-tui executable.
 */
export function fetchModelsFromCli(binaryPath: string): Promise<ModelEntry[]> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(binaryPath, ["models", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code: number) => {
      if (code !== 0) {
        reject(new Error(`codewhale-tui models exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Error("Failed to parse model list JSON"));
      }
    });
    child.on("error", reject);
  });
}
