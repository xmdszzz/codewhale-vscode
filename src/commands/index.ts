import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodewhaleManager } from "../harness/manager";
import { ChatPanelProvider } from "../webview/provider";
import { ApprovalMode } from "../harness/types";
import { prepareDiffPreview } from "../harness/diff";

/**
 * Register all VSCode commands and return their disposables.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  manager: CodewhaleManager,
  chatProvider: ChatPanelProvider
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // ── codewhale.openPanel ─────────────────────────────────────
  // Opens CodeWhale as a dedicated editor panel (like Claude Code).
  disposables.push(
    vscode.commands.registerCommand("codewhale.openPanel", () => {
      chatProvider.openPanel();
    })
  );

  // ── codewhale.newThread ────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("codewhale.newThread", async () => {
      const client = manager.getClient();
      if (!client) {
        vscode.window.showErrorMessage("CodeWhale is not running yet.");
        return;
      }

      const defaultMode = vscode.workspace
        .getConfiguration("codewhale")
        .get<string>("defaultMode", "agent") as ApprovalMode;

      try {
        const thread = await client.createThread({
          mode: defaultMode,
          auto_approve: defaultMode === "yolo",
          workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        });
        chatProvider.openPanel();
        vscode.window.showInformationMessage(
          `New conversation created: ${thread.id.slice(0, 8)}...`
        );
        vscode.commands.executeCommand(
          "setContext",
          "codewhale.activeThreadId",
          thread.id
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to create thread: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  // ── codewhale.toggleApprovalMode ───────────────────────────
  const approvalModes: ApprovalMode[] = ["plan", "agent", "yolo"];
  // Persist mode index across extension reloads
  const KEY_MODE = "codewhale.approvalModeIndex";
  let modeIndex: number = context.globalState.get<number>(KEY_MODE) ?? 0;
  if (modeIndex < 0 || modeIndex >= approvalModes.length) modeIndex = 0;

  disposables.push(
    vscode.commands.registerCommand("codewhale.toggleApprovalMode", () => {
      modeIndex = (modeIndex + 1) % approvalModes.length;
      context.globalState.update(KEY_MODE, modeIndex);
      const mode = approvalModes[modeIndex];
      const labels: Record<ApprovalMode, string> = {
        plan: "Plan — read-only exploration",
        agent: "Agent — interactive with approval",
        yolo: "YOLO — auto-approved",
      };
      vscode.window.showInformationMessage(
        `Approval mode: ${labels[mode]}`
      );
      vscode.commands.executeCommand(
        "setContext",
        "codewhale.approvalMode",
        mode
      );
    })
  );

  // ── codewhale.showSettings ─────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("codewhale.showSettings", () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "codewhale"
      );
    })
  );

  // ── codewhale.viewDiff ─────────────────────────────────────
  // Opens VSCode's built-in diff editor for a file change.
  // Called from the webview when user clicks "View Diff" on a tool card.
  //
  // Parameters (packed into a single arg for command invocation):
  //   { filePath: string, diffText: string }
  disposables.push(
    vscode.commands.registerCommand(
      "codewhale.viewDiff",
      async (arg: { filePath: string; diffText: string }) => {
        const { filePath, diffText } = arg;

        // Resolve absolute path relative to workspace
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          vscode.window.showErrorMessage("No workspace folder open.");
          return;
        }

        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspaceRoot, filePath);

        let newContent: string;
        try {
          newContent = fs.readFileSync(absPath, "utf-8");
        } catch {
          vscode.window.showErrorMessage(
            `File not found: ${filePath}`
          );
          return;
        }

        const preview = prepareDiffPreview(diffText, newContent);
        if (!preview) {
          vscode.window.showErrorMessage(
            `Could not parse diff content. File: ${filePath}`
          );
          return;
        }

        // Create temp untitled document for the old (pre-change) content
        const oldDoc = await vscode.workspace.openTextDocument({
          content: preview.oldContent,
          language: detectLanguage(filePath),
        });

        // Use the file on disk as the new version
        const newUri = vscode.Uri.file(absPath);

        // Open VSCode's built-in diff editor:
        //   left (old)  = pre-change content
        //   right (new) = current file on disk
        await vscode.commands.executeCommand(
          "vscode.diff",
          oldDoc.uri,
          newUri,
          `${path.basename(filePath)} (before) ↔ ${path.basename(filePath)} (after)`
        );
      }
    )
  );

  return disposables;
}

/** Best-effort language detection from file extension. */
function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    rb: "ruby",
    css: "css",
    html: "html",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "shellscript",
    sql: "sql",
    xml: "xml",
    c: "c",
    cpp: "cpp",
    h: "c",
  };
  return map[ext] ?? "plaintext";
}
