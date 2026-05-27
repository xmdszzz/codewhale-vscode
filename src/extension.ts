import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CodewhaleManager } from "./harness/manager";
import { CodewhaleClient } from "./harness/client";
import { ChatPanelProvider } from "./webview/provider";
import { registerCommands } from "./commands";

let manager: CodewhaleManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("codewhale");
  const binaryVersion = config.get<string>("binaryVersion", "v0.8.44");
  const customBinaryPath = config.get<string>("binaryPath", "") || undefined;

  // Build environment from VS Code settings (primary) + globalState (fallback)
  const env = buildProviderEnv(config, context);

  manager = new CodewhaleManager(
    context.globalStorageUri.fsPath,
    binaryVersion,
    customBinaryPath,
    env
  );

  // ── Create the chat panel provider (manages the editor panel) ──
  const chatProvider = new ChatPanelProvider(context.extensionUri, context);
  chatProvider.setBinaryPath(manager.binaryPath);

  // ── Status bar entry (always visible, click to open/reveal) ──
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.text = "$(comment-discussion) CodeWhale";
  statusBarItem.tooltip = "Open CodeWhale Chat";
  statusBarItem.command = "codewhale.openPanel";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // When config changes, restart the server with new env vars
  chatProvider.onConfigChanged = () => {
    const newConfig = vscode.workspace.getConfiguration("codewhale");
    const newEnv = buildProviderEnv(newConfig, context);

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "CodeWhale: Applying new config...", cancellable: false },
      async () => {
        try {
          const result = await manager!.restart(newEnv);
          chatProvider.setClient(result.client);
          chatProvider.onReconnected(result);
          vscode.window.showInformationMessage(`CodeWhale restarted (port ${result.port})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`CodeWhale restart failed: ${msg}`);
          chatProvider.onServerExit();
        }
      }
    );
  };

  // ── Register commands ──────────────────────────────────────
  const cmdDisposables = registerCommands(context, manager, chatProvider);
  context.subscriptions.push(...cmdDisposables);

  // ── Start the codewhale-tui process ────────────────────────
  const seed = vscode.env.sessionId;
  context.subscriptions.push(
    new vscode.Disposable(() => manager?.stop())
  );

  // Wire server lifecycle events → notify provider
  manager.on("exit", () => chatProvider.onServerExit());
  manager.on("download", (p) => chatProvider.onDownloadProgress(p));
  manager.on("reconnecting", (p) => chatProvider.onReconnecting(p));
  manager.on("stdout", (d) => console.log("[codewhale-tui]", d));
  manager.on("stderr", (d) => console.error("[codewhale-tui]", d));

  // When the manager reconnects, refresh the provider's client reference
  manager.on("reconnected", (p: { port: number; client: CodewhaleClient }) => {
    chatProvider.setClient(p.client);
    chatProvider.onReconnected(p);
  });

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Starting CodeWhale...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const mgr = manager;
        if (!mgr) {
          vscode.window.showErrorMessage("CodeWhale manager not initialized.");
          return;
        }
        // Listen for download progress and update the notification
        const onDownload = (p: { phase: string; current?: number; total?: number }) => {
          if (p.phase === "downloading" && p.current != null && p.total != null) {
            const pct = Math.round((p.current / p.total) * 100);
            progress.report({ message: `Downloading binary... ${pct}%` });
          } else if (p.phase === "verifying") {
            progress.report({ message: "Verifying checksum..." });
          }
        };
        mgr.on("download", onDownload);

        const { client, port } = await mgr.start(seed);
        mgr.off("download", onDownload);

        console.log(`[CodeWhale] server ready on port ${port}`);
        chatProvider.setClient(client);

        // Auto-open the editor panel when ready
        chatProvider.openPanel();

        vscode.window.showInformationMessage(
          `CodeWhale ready (port ${port})`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `CodeWhale failed to start: ${msg}`
        );
        console.error("[CodeWhale]", msg);
      }
    }
  );
}

export function deactivate() {
  manager?.stop();
}

/** Build env vars from VS Code settings (primary) + globalState (fallback). */
function buildProviderEnv(
  config: vscode.WorkspaceConfiguration,
  context: vscode.ExtensionContext
): Record<string, string> {
  const stored = context.globalState.get<Record<string, string>>("providerConfig") ?? {};

  // VS Code settings take precedence, then globalState fallback
  const providerName = config.get<string>("providerName", "") || stored.providerName || "";
  const apiKey = config.get<string>("apiKey", "") || stored.apiKey || "";
  const baseUrl = config.get<string>("baseUrl", "") || stored.baseUrl || "";

  const env: Record<string, string> = {};
  if (providerName) env.DEEPSEEK_PROVIDER = providerName;
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
  if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl;

  // Mirror to ~/.deepseek/config.toml so the backend can find the key
  // even if env vars don't propagate (e.g. workspace switching edge cases)
  if (apiKey || baseUrl) {
    try {
      const dir = path.join(os.homedir(), ".deepseek");
      fs.mkdirSync(dir, { recursive: true });
      let toml = "";
      if (apiKey) toml += `api_key = "${apiKey}"\n`;
      if (baseUrl) toml += `base_url = "${baseUrl}"\n`;
      fs.writeFileSync(path.join(dir, "config.toml"), toml, "utf-8");
      console.log("[CodeWhale] synced config to ~/.deepseek/config.toml");
    } catch {
      // best-effort file write — env vars still work
    }
  }

  return env;
}
