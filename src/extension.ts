import * as vscode from "vscode";
import { CodewhaleManager } from "./harness/manager";
import { CodewhaleClient } from "./harness/client";
import { ChatPanelProvider } from "./webview/provider";
import { registerCommands } from "./commands";

let manager: CodewhaleManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("codewhale");
  const binaryVersion = config.get<string>("binaryVersion", "v0.8.44");
  const customBinaryPath = config.get<string>("binaryPath", "") || undefined;

  // Build environment from stored provider config
  const providerConfig = context.globalState.get<Record<string, string>>("providerConfig") ?? {};
  const env: Record<string, string> = {};
  if (providerConfig.providerName) {
    env.DEEPSEEK_PROVIDER = providerConfig.providerName;
  }
  if (providerConfig.apiKey) {
    env.DEEPSEEK_API_KEY = providerConfig.apiKey;
  }
  if (providerConfig.baseUrl) {
    env.DEEPSEEK_BASE_URL = providerConfig.baseUrl;
  }

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
    const newConfig = context.globalState.get<Record<string, string>>("providerConfig") ?? {};
    const newEnv: Record<string, string> = {};
    if (newConfig.providerName) newEnv.DEEPSEEK_PROVIDER = newConfig.providerName;
    if (newConfig.apiKey) newEnv.DEEPSEEK_API_KEY = newConfig.apiKey;
    if (newConfig.baseUrl) newEnv.DEEPSEEK_BASE_URL = newConfig.baseUrl;

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
        // Listen for download progress and update the notification
        const onDownload = (p: { phase: string; current?: number; total?: number }) => {
          if (p.phase === "downloading" && p.current != null && p.total != null) {
            const pct = Math.round((p.current / p.total) * 100);
            progress.report({ message: `Downloading binary... ${pct}%` });
          } else if (p.phase === "verifying") {
            progress.report({ message: "Verifying checksum..." });
          }
        };
        manager!.on("download", onDownload);

        const { client, port } = await manager!.start(seed);
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
