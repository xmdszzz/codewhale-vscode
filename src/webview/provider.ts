import * as vscode from "vscode";
import * as fs from "node:fs";
import { CodewhaleClient } from "../harness/client";
import { SseEventEnvelope } from "../harness/types";
import * as os from "node:os";
import * as cp from "node:child_process";

/**
 * WebviewViewProvider that manages the CodeWhale chat panel.
 *
 * Responsibilities:
 *  - Load the HTML page and inject the webview bundle URI
 *  - Bridge postMessage (webview) ↔ SSE events (HTTP client)
 *  - Handle incoming messages: sendPrompt, approvalDecision,
 *    newThread, listThreads, selectThread
 */

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src __CSP_SOURCE__; style-src __CSP_SOURCE__ 'unsafe-inline'; font-src __CSP_SOURCE__; img-src __CSP_SOURCE__ data:; connect-src __CSP_SOURCE__;"
  />
  <title>CodeWhale</title>
</head>
<body>
  <div id="root"></div>
  <script src="__SCRIPT_URI__"></script>
</body>
</html>`;

export class ChatPanelProvider {
  private _panel: vscode.WebviewPanel | null = null;
  private _client: CodewhaleClient | null = null;
  private _sseAbort: AbortController | null = null;
  private _activeThreadId: string | null = null;
  private _binaryPath: string | null = null;
  private _deletedThreadIds: Set<string>;

  /** Called when the user saves provider config — extension wires this to restart the server. */
  onConfigChanged: (() => void) | null = null;

  /** Set by extension.ts so we can invoke the CLI binary for operations like delete. */
  setBinaryPath(path: string) {
    this._binaryPath = path;
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context?: vscode.ExtensionContext
  ) {
    this._deletedThreadIds = new Set(
      _context?.globalState.get<string[]>("deletedThreadIds") ?? []
    );
  }

  private _persistDeleted() {
    this._context?.globalState.update("deletedThreadIds", [...this._deletedThreadIds]);
  }

  /** Update the client reference (called when manager finishes starting). */
  setClient(client: CodewhaleClient) {
    this._client = client;
    this._postToWebview({
      type: "connectionState",
      state: "connected",
    });
  }

  /** Called by extension.ts when the CodewhaleManager emits "exit". */
  onServerExit() {
    this._client = null;
    this._postToWebview({
      type: "connectionState",
      state: "disconnected",
    });
  }

  /** Forward download progress to the webview. */
  onDownloadProgress(p: { phase: string; current?: number; total?: number; message?: string }) {
    this._postToWebview({ type: "downloadProgress", ...p });
  }

  /** Forward reconnection status to the webview. */
  onReconnecting(p: { attempt: number; delayMs: number }) {
    this._postToWebview({ type: "reconnecting", ...p });
  }

  /** Forward reconnection success to the webview, and re-establish SSE if needed. */
  onReconnected(_p: { port: number }) {
    this._postToWebview({
      type: "connectionState",
      state: "connected",
    });
    // Re-subscribe to the active thread's events after reconnect
    if (this._client && this._activeThreadId) {
      this._resumeSseAfterReconnect();
    }
  }

  /** Re-establish SSE stream after reconnect without clearing webview state. */
  private _resumeSseAfterReconnect() {
    const client = this._client;
    const threadId = this._activeThreadId;
    if (!client || !threadId) return;

    this._sseAbort?.abort();
    this._startSseStream(threadId);
  }

  // ── HTML ──────────────────────────────────────────────────

  private _buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "out", "webview.js")
    );
    const cspSource = webview.cspSource.replace(/'/g, "&#39;");
    return HTML_TEMPLATE
      .replace("__SCRIPT_URI__", scriptUri.toString())
      .replace("__CSP_SOURCE__", cspSource);
  }

  // ── postMessage helpers ───────────────────────────────────

  private _postToWebview(msg: Record<string, unknown>) {
    this._panel?.webview.postMessage(msg);
  }

  /** Open CodeWhale as a dedicated editor panel (like Claude Code). */
  openPanel(): vscode.WebviewPanel {
    // Reuse existing panel if already open
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Two);
      return this._panel;
    }

    const panel = vscode.window.createWebviewPanel(
      "codewhale.panel",
      "CodeWhale",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this._extensionUri, "out"),
        ],
        retainContextWhenHidden: true,
      }
    );

    panel.webview.html = this._buildHtml(panel.webview);

    panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => this._handleMessage(msg)
    );

    panel.onDidDispose(() => {
      this._panel = null;
    });

    this._panel = panel;

    // Forward initial connection state
    this._postToWebview({
      type: "connectionState",
      state: this._client ? "connected" : "connecting",
    });

    return panel;
  }

  // ── Incoming messages from webview ────────────────────────

  private async _handleMessage(msg: Record<string, unknown>) {
    const client = this._client;

    switch (msg.type) {
      case "init": {
        // Webview loaded — send current connection state
        this._postToWebview({
          type: "connectionState",
          state: client ? "connected" : "connecting",
        });
        if (client) {
          this._sendThreadList(client);
        }
        break;
      }

      case "newThread": {
        if (!client) return;
        try {
          const mode =
            (msg.mode as string) ??
            vscode.workspace
              .getConfiguration("codewhale")
              .get<string>("defaultMode", "agent");

          // Pick workspace from active editor, fall back to first folder
          const wsFolder = vscode.window.activeTextEditor
            ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
            : undefined;
          const workspace = wsFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          console.log("[CodeWhale] creating thread...");
          const thread = await client.createThread({
            mode,
            auto_approve: mode === "yolo",
            workspace,
          });
          console.log("[CodeWhale] thread created:", thread.id);
          this._postToWebview({ type: "threadCreated", thread });
          this._switchToThread(thread.id);
        } catch (err) {
          console.error("[CodeWhale] createThread failed:", err);
          this._postToWebview({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "listThreads": {
        if (!client) return;
        this._sendThreadList(client);
        break;
      }

      case "searchThreads": {
        if (!client) return;
        try {
          const search = (msg.search as string) || undefined;
          const threads = await client.listThreadSummaries(50, search);
          const filtered = threads.filter((t) => !this._deletedThreadIds.has(t.id));
          this._postToWebview({ type: "threadList", threads: filtered });
        } catch {
          // best-effort
        }
        break;
      }

      case "selectThread": {
        const threadId = msg.threadId as string;
        this._loadAndSwitchThread(threadId);
        break;
      }

      case "sendPrompt": {
        if (!client || !this._activeThreadId) {
          console.log("[CodeWhale] sendPrompt ignored — no client or thread");
          return;
        }
        try {
          console.log("[CodeWhale] starting turn for thread:", this._activeThreadId);
          await client.startTurn(this._activeThreadId, {
            prompt: msg.prompt as string,
          });
          console.log("[CodeWhale] turn started, waiting for SSE events...");
        } catch (err) {
          console.error("[CodeWhale] startTurn failed:", err);
          this._postToWebview({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "approvalDecision": {
        if (!client) return;
        try {
          await client.submitApproval(msg.approvalId as string, {
            decision: msg.decision as string,
            remember: msg.remember as boolean | undefined,
          });
        } catch (err) {
          this._postToWebview({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "viewDiff": {
        vscode.commands.executeCommand("codewhale.viewDiff", {
          filePath: msg.filePath as string,
          diffText: msg.diffText as string,
        });
        break;
      }

      case "renameThread": {
        if (!client) return;
        try {
          const threadId = msg.threadId as string;
          const title = msg.title as string;
          await client.updateThread(threadId, { title });
          this._postToWebview({ type: "threadRenamed", threadId, title });
          this._sendThreadList(client);
        } catch (err) {
          this._postToWebview({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "deleteThread": {
        if (!client) return;
        const threadId = msg.threadId as string;
        console.log("[CodeWhale] deleteThread requested:", threadId);

        // Always mark as deleted locally so it never reappears in the list
        this._deletedThreadIds.add(threadId);
        this._persistDeleted();

        // Try best-effort server-side deletion
        // Strategy 1: HTTP API
        try {
          await client.deleteThread(threadId);
          console.log("[CodeWhale] deleteThread: HTTP API succeeded");
        } catch {
          console.log("[CodeWhale] deleteThread: HTTP API failed, trying filesystem...");
          // Strategy 2: Try to find thread on disk
          try {
            const detail = await client.getThread(threadId);
            const t = detail.thread as unknown as Record<string, unknown>;
            const candidates: string[] = [];
            if (t.path) candidates.push(t.path as string);
            if (t.workspace) {
              const ws = t.workspace as string;
              candidates.push(`${ws}/.codewhale/threads/${threadId}`);
              candidates.push(`${ws}/.codewhale/sessions/${threadId}`);
            }
            const homedir = os.homedir();
            candidates.push(`${homedir}/.codewhale/threads/${threadId}`);
            candidates.push(`${homedir}/.codewhale/sessions/${threadId}`);
            candidates.push(`${homedir}/.config/codewhale/threads/${threadId}`);
            for (const p of candidates) {
              if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                console.log("[CodeWhale] deleteThread: filesystem deleted", p);
                break;
              }
            }
          } catch {
            // best-effort
          }
          // Strategy 3: CLI binary
          if (this._binaryPath) {
            try {
              cp.execFileSync(this._binaryPath, ["thread", "delete", threadId], { timeout: 10_000, stdio: "pipe" });
              console.log("[CodeWhale] deleteThread: CLI succeeded");
            } catch {
              // CLI didn't work either
            }
          }
        }

        // Always notify webview — local state already updated
        this._postToWebview({ type: "threadDeleted", threadId });
        if (this._activeThreadId === threadId) {
          this._sseAbort?.abort();
          this._sseAbort = null;
          this._activeThreadId = null;
          this._postToWebview({ type: "activeThread", threadId: null });
        }
        this._sendThreadList(client);
        break;
      }

      case "saveProviderConfig": {
        const providerConfig = msg.config as Record<string, unknown>;
        this._context?.globalState.update("providerConfig", providerConfig);
        this._postToWebview({
          type: "providerConfigSaved",
          config: providerConfig,
        });
        // Notify extension to restart server with new config
        this.onConfigChanged?.();
        break;
      }

      case "getProviderConfig": {
        const config =
          this._context?.globalState.get<Record<string, unknown>>("providerConfig") ?? {};
        this._postToWebview({
          type: "providerConfig",
          config,
        });
        break;
      }

      case "compactThread": {
        if (!client) return;
        try {
          const result = await client.compactThread(msg.threadId as string);
          if (result.ok) {
            this._postToWebview({ type: "contextCompacted", threadId: msg.threadId });
          }
        } catch (err) {
          this._postToWebview({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "pickFiles": {
        const kind = (msg.kind as string) ?? "both";
        const files = await vscode.window.showOpenDialog({
          canSelectFiles: kind !== "folder",
          canSelectFolders: kind !== "files",
          canSelectMany: true,
          openLabel: "Add to context",
          title: kind === "folder" ? "Add folder to context" : kind === "files" ? "Add files to context" : "Add files or folders to context",
        });
        if (files && files.length > 0) {
          const contextFiles = files.map((uri) => {
            let type: "file" | "dir" = "file";
            try {
              type = fs.statSync(uri.fsPath).isDirectory() ? "dir" : "file";
            } catch {
              // fallback to file
            }
            return { path: uri.fsPath, type };
          });
          this._postToWebview({
            type: "contextFilesUpdated",
            files: contextFiles,
          });
        }
        break;
      }
    }
  }

  // ── Thread switching ──────────────────────────────────────

  /** Load thread history and switch to it. The SSE stream replays all events from the beginning. */
  private async _loadAndSwitchThread(threadId: string) {
    const client = this._client;
    if (!client) return;

    // Cancel previous SSE subscription and clear UI
    this._sseAbort?.abort();
    this._sseAbort = null;
    this._activeThreadId = threadId;
    this._postToWebview({ type: "activeThread", threadId });

    // Use SSE stream to replay all history (since_seq=0 replays everything)
    this._startSseStream(threadId);
  }

  private _switchToThread(threadId: string) {
    // Cancel previous SSE subscription
    this._sseAbort?.abort();
    this._sseAbort = null;

    this._activeThreadId = threadId;
    this._postToWebview({ type: "activeThread", threadId });

    this._startSseStream(threadId);
  }

  private _startSseStream(threadId: string) {
    const client = this._client;
    if (!client) return;

    // Remove old listeners to prevent accumulation across thread switches
    client.removeAllListeners("event");
    client.removeAllListeners("error");
    client.removeAllListeners("end");

    this._sseAbort = client.streamEvents(threadId);
    client.on("event", (ev: SseEventEnvelope) => {
      console.log("[CodeWhale SSE]", ev.event, ev.item_id);
      this._postToWebview({ type: "sseEvent", event: ev });

      // After a turn completes, fetch real token usage from REST API
      if (ev.event === "turn.completed" && this._client) {
        this._fetchUsage(ev.thread_id);
      }
    });
    client.on("error", (err: Error) => {
      console.error("[CodeWhale SSE error]", err.message);
    });
    client.on("end", () => {
      console.log("[CodeWhale SSE] stream ended");
      this._postToWebview({
        type: "connectionState",
        state: "disconnected",
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────

  /** After a turn completes, fetch real token usage from REST API and send to webview. */
  private async _fetchUsage(threadId: string) {
    const client = this._client;
    if (!client) return;

    // Small delay so the server has time to finalize usage accounting
    await new Promise((r) => setTimeout(r, 300));

    try {
      const detail = await client.getThread(threadId);
      const turns = detail.turns as Array<{ usage?: { input_tokens: number; output_tokens: number; cached_tokens?: number; reasoning_tokens?: number; cost_usd?: number } }>;
      if (!turns || turns.length === 0) return;

      let totalInput = 0;
      let totalOutput = 0;
      let totalCost = 0;
      for (const turn of turns) {
        if (turn.usage) {
          totalInput += turn.usage.input_tokens;
          totalOutput += turn.usage.output_tokens;
          totalCost += turn.usage.cost_usd ?? 0;
        }
      }

      if (totalInput + totalOutput > 0) {
        this._postToWebview({
          type: "threadUsage",
          threadId,
          tokens: totalInput + totalOutput,
          cost: Math.round(totalCost * 10000) / 10000,
        });
      }
    } catch {
      // best-effort — estimation remains visible in webview
    }
  }

  private async _sendThreadList(client: CodewhaleClient) {
    try {
      const threads = await client.listThreadSummaries(50);
      const filtered = threads.filter((t) => !this._deletedThreadIds.has(t.id));
      this._postToWebview({ type: "threadList", threads: filtered });
    } catch {
      // ignore — list fetch is best-effort
    }
  }
}
