import { useState, useEffect, useRef, useCallback, useReducer, Component, memo } from "react";
import { createRoot } from "react-dom/client";

// ── Types ───────────────────────────────────────────────────

type ConnectionState = "connecting" | "connected" | "disconnected";
type ApprovalMode = "plan" | "agent" | "yolo";

interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  model: string;
  mode: string;
  archived: boolean;
  updated_at: string;
  latest_turn_id?: string;
}

interface SseEventEnvelope {
  seq: number;
  event: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  payload: Record<string, unknown>;
}

interface DownloadProgress {
  phase: string;
  current?: number;
  total?: number;
  message?: string;
}

interface ReconnectInfo {
  attempt: number;
  delayMs: number;
}

type UIMessage =
  | { kind: "user"; id: string; content: string }
  | { kind: "agent"; id: string; content: string; reasoning: string; streaming: boolean }
  | { kind: "tool"; id: string; toolName: string; args: string; output: string; status: "running" | "done" | "error"; filePath?: string; isDiff?: boolean }
  | { kind: "approval"; id: string; approvalId: string; command: string; cwd: string; reason: string }
  | { kind: "status"; id: string; text: string; level: "info" | "error" };

interface ContextFile {
  path: string;
  type: "file" | "dir";
}

// ── Diff helpers ─────────────────────────────────────────────

/** Heuristic: does the output look like a unified diff? */
function looksLikeDiff(text: string): boolean {
  return /^(--- |\+\+\+ |diff --git |@@ )/m.test(text);
}

/** Extract the file path from a unified diff's "+++ b/..." header. */
function extractFilePath(text: string): string {
  const m = text.match(/^\+\+\+ b\/(.+)$/m);
  return m ? m[1] : "";
}

// ── VSCode API ──────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: Record<string, unknown>): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

// ── State reducer ───────────────────────────────────────────

interface State {
  messages: UIMessage[];
  threads: ThreadSummary[];
  activeThreadId: string | null;
  connectionState: ConnectionState;
  approvalMode: ApprovalMode;
  downloadPhase: string;
  downloadPct: number;
  reconnectAttempt: number;
  contextFiles: ContextFile[];
  contextTokens: number;
  contextCompactable: boolean;
  contextCost: number;
}

const DEFAULT_MODEL_MAX_TOKENS = 1_000_000;

type Action =
  | { type: "setThreads"; threads: ThreadSummary[] }
  | { type: "setActiveThread"; threadId: string | null }
  | { type: "setConnection"; state: ConnectionState }
  | { type: "setApprovalMode"; mode: ApprovalMode }
  | { type: "addMessage"; msg: UIMessage }
  | { type: "updateMessage"; id: string; patch: Partial<UIMessage> }
  | { type: "appendDelta"; id: string; delta: string; channel: "text" | "reasoning" }
  | { type: "finishStreaming"; id: string }
  | { type: "finishAllStreaming" }
  | { type: "setDownload"; phase: string; pct: number }
  | { type: "setReconnect"; attempt: number }
  | { type: "addContextFile"; file: ContextFile }
  | { type: "removeContextFile"; path: string }
  | { type: "clearContextFiles" }
  | { type: "setContextUsage"; tokens: number; cost?: number }
  | { type: "setCompactable"; compactable: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "setThreads":
      return { ...state, threads: action.threads };
    case "setActiveThread":
      return { ...state, activeThreadId: action.threadId, messages: [], contextTokens: 0, contextCompactable: false, contextCost: 0 };
    case "setConnection":
      return { ...state, connectionState: action.state };
    case "setApprovalMode":
      return { ...state, approvalMode: action.mode };
    case "addMessage":
      return { ...state, messages: [...state.messages, action.msg] };
    case "updateMessage":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id ? { ...m, ...action.patch } as UIMessage : m
        ),
      };
    case "appendDelta": {
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== action.id) return m;
          if (m.kind !== "agent") return m;
          if (action.channel === "reasoning") {
            return { ...m, reasoning: m.reasoning + action.delta };
          }
          return { ...m, content: m.content + action.delta };
        }),
      };
    }
    case "finishStreaming":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id && m.kind === "agent"
            ? { ...m, streaming: false } as UIMessage
            : m
        ),
      };
    case "finishAllStreaming":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.kind === "agent" && m.streaming) {
            return { ...m, streaming: false } as UIMessage;
          }
          if (m.kind === "tool" && m.status === "running") {
            return { ...m, status: "done" } as UIMessage;
          }
          return m;
        }),
      };
    case "setDownload":
      return { ...state, downloadPhase: action.phase, downloadPct: action.pct };
    case "setReconnect":
      return { ...state, reconnectAttempt: action.attempt };
    case "addContextFile":
      if (state.contextFiles.some((f) => f.path === action.file.path)) return state;
      return { ...state, contextFiles: [...state.contextFiles, action.file] };
    case "removeContextFile":
      return { ...state, contextFiles: state.contextFiles.filter((f) => f.path !== action.path) };
    case "clearContextFiles":
      return { ...state, contextFiles: [] };
    case "setContextUsage":
      return { ...state, contextTokens: action.tokens, contextCost: action.cost ?? state.contextCost };
    case "setCompactable":
      return { ...state, contextCompactable: action.compactable };
    default:
      return state;
  }
}

// ── Components ──────────────────────────────────────────────

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const colors: Record<ConnectionState, string> = {
    connecting: "var(--vscode-inputValidation-warningBorder, #cca700)",
    connected: "var(--vscode-testing-iconPassed, #73c991)",
    disconnected: "var(--vscode-inputValidation-errorBorder, #f14c4c)",
  };
  const labels: Record<ConnectionState, string> = {
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Disconnected",
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 10,
        fontSize: 11,
        color: colors[state],
        border: `1px solid ${colors[state]}`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: colors[state],
          display: "inline-block",
        }}
      />
      {labels[state]}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const RING_RADIUS = 11;
const RING_STROKE = 3;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_VIEWBOX = 28;

function ContextRing({
  tokens,
  maxTokens,
  compactable,
  onCompact,
  cost,
}: {
  tokens: number;
  maxTokens: number;
  compactable: boolean;
  onCompact: () => void;
  cost: number;
}) {
  const pct = Math.min(tokens / maxTokens, 1);
  const fillOffset = RING_CIRCUMFERENCE * (1 - pct);
  const color =
    pct > 0.9
      ? "var(--vscode-inputValidation-errorBorder)"
      : pct > 0.6
        ? "var(--vscode-inputValidation-warningBorder)"
        : "var(--vscode-testing-iconPassed)";
  const hasContent = tokens > 0;
  const shouldCompact = compactable && hasContent;

  return (
    <div
      title={`Context: ${formatTokens(tokens)} / ${formatTokens(maxTokens)} (${Math.round(pct * 100)}%)${cost > 0 ? ` — $${cost.toFixed(4)}` : ""}${hasContent ? " — Click to compact" : ""}`}
      onClick={hasContent ? onCompact : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        cursor: hasContent ? "pointer" : "default",
        opacity: hasContent ? 1 : 0.3,
        padding: "1px 6px",
        borderRadius: 10,
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => { if (hasContent) e.currentTarget.style.background = "var(--vscode-toolbar-hoverBackground)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <svg width="22" height="22" viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`}>
        <circle
          cx={RING_VIEWBOX / 2}
          cy={RING_VIEWBOX / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="var(--vscode-panel-border)"
          strokeWidth={RING_STROKE}
        />
        {hasContent && (
          <circle
            cx={RING_VIEWBOX / 2}
            cy={RING_VIEWBOX / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={RING_STROKE}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={fillOffset}
            transform={`rotate(-90 ${RING_VIEWBOX / 2} ${RING_VIEWBOX / 2})`}
            strokeLinecap="round"
          />
        )}
        {shouldCompact && (
          <text
            x={RING_VIEWBOX / 2}
            y={RING_VIEWBOX / 2 + 4}
            textAnchor="middle"
            fontSize="11"
            fill="var(--vscode-foreground)"
          >
            ⟳
          </text>
        )}
      </svg>
      <span style={{ fontSize: 11, color: "var(--vscode-descriptionForeground)" }}>
        {formatTokens(tokens)}{cost > 0 ? `  $${cost.toFixed(2)}` : ""}
      </span>
    </div>
  );
}

function ApprovalModeSelector({
  mode,
  onChange,
}: {
  mode: ApprovalMode;
  onChange: (m: ApprovalMode) => void;
}) {
  const modes: { key: ApprovalMode; label: string }[] = [
    { key: "plan", label: "Plan" },
    { key: "agent", label: "Agent" },
    { key: "yolo", label: "YOLO" },
  ];
  return (
    <div style={{ display: "flex", gap: 2, background: "var(--vscode-input-background)", borderRadius: 4, padding: 2 }}>
      {modes.map((m) => (
        <button
          key={m.key}
          onClick={() => onChange(m.key)}
          style={{
            padding: "2px 10px",
            border: "none",
            borderRadius: 3,
            fontSize: 11,
            fontWeight: mode === m.key ? 600 : 400,
            cursor: "pointer",
            background: mode === m.key ? "var(--vscode-button-background)" : "transparent",
            color: mode === m.key ? "var(--vscode-button-foreground)" : "var(--vscode-foreground)",
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

const SLASH_COMMANDS = [
  { cmd: "/help", desc: "Show help and available commands" },
  { cmd: "/clear", desc: "Clear the current conversation context" },
  { cmd: "/model", desc: "Switch the AI model" },
  { cmd: "/mode", desc: "Change approval mode (plan/agent/yolo)" },
  { cmd: "/todos", desc: "List current todo items" },
  { cmd: "/diff", desc: "View current changes as a diff" },
  { cmd: "/undo", desc: "Undo the last turn" },
  { cmd: "/reset", desc: "Reset the entire session" },
];

function MessageInput({
  disabled,
  onSend,
  mode,
  onModeChange,
  contextFiles,
  onAddFiles,
  onRemoveFile,
  contextTokens,
  contextMaxTokens,
  contextCompactable,
  onCompact,
  contextCost,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
  mode: ApprovalMode;
  onModeChange: (m: ApprovalMode) => void;
  contextFiles: ContextFile[];
  onAddFiles: () => void;
  onRemoveFile: (path: string) => void;
  contextTokens: number;
  contextMaxTokens: number;
  contextCompactable: boolean;
  onCompact: () => void;
  contextCost: number;
}) {
  const [value, setValue] = useState("");
  const [showAttach, setShowAttach] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    setShowSlash(false);
  };

  const filteredCommands = SLASH_COMMANDS.filter((c) =>
    c.cmd.startsWith(slashFilter)
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSlash) {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSlash(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (filteredCommands.length > 0) {
          const idx = Math.min(slashIdx, filteredCommands.length - 1);
          setValue((prev) => prev.replace(/\/\S*$/, filteredCommands[idx].cmd + " "));
          setShowSlash(false);
        }
        return;
      }
    }
    if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape") {
      setShowAttach(false);
      setShowSlash(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);

    const cursorPos = e.target.selectionStart ?? v.length;
    const beforeCursor = v.slice(0, cursorPos);
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/\S*)$/);
    if (slashMatch) {
      setSlashFilter(slashMatch[1]);
      setShowSlash(true);
      setSlashIdx(0);
    } else {
      setShowSlash(false);
      setSlashIdx(0);
    }
  };

  const insertSlashCommand = (cmd: string) => {
    setValue((prev) => prev.replace(/\/\S*$/, cmd + " "));
    setShowSlash(false);
    textareaRef.current?.focus();
  };

  const modes: { key: ApprovalMode; label: string }[] = [
    { key: "plan", label: "Plan" },
    { key: "agent", label: "Agent" },
    { key: "yolo", label: "YOLO" },
  ];

  return (
    <div
      style={{
        borderTop: "1px solid var(--vscode-panel-border)",
        background: "var(--vscode-editor-background)",
      }}
    >
      {/* Context file tags */}
      {contextFiles.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            padding: "4px 12px 0",
          }}
        >
          {contextFiles.map((f) => (
            <span
              key={f.path}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 6px",
                fontSize: 11,
                borderRadius: 3,
                background: "var(--vscode-badge-background)",
                color: "var(--vscode-badge-foreground)",
              }}
            >
              {f.type === "dir" ? "📁 " : "📄 "}
              {f.path.split(/[/\\]/).pop() ?? f.path}
              <button
                onClick={() => onRemoveFile(f.path)}
                style={{
                  background: "none",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Textarea */}
      <div style={{ padding: "8px 12px 0" }}>
        <div style={{ position: "relative" }}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder="Send a message... (Enter to send, Shift+Enter for newline, / for commands)"
            rows={2}
            style={{
              width: "100%",
              resize: "none",
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "var(--vscode-font-family)",
              color: "var(--vscode-input-foreground)",
              background: "var(--vscode-input-background)",
              border: "1px solid var(--vscode-input-border)",
              borderRadius: 6,
              outline: "none",
              boxSizing: "border-box",
            }}
          />

          {/* Slash command popup */}
          {showSlash && filteredCommands.length > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                marginBottom: 4,
                minWidth: 280,
                background: "var(--vscode-dropdown-background)",
                border: "1px solid var(--vscode-dropdown-border)",
                borderRadius: 6,
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                zIndex: 50,
                overflow: "hidden",
              }}
            >
              {filteredCommands.map((c, i) => (
                <button
                  key={c.cmd}
                  onClick={() => insertSlashCommand(c.cmd)}
                  onMouseEnter={() => setSlashIdx(i)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 12px",
                    border: "none",
                    background: i === slashIdx
                      ? "var(--vscode-list-activeSelectionBackground)"
                      : "transparent",
                    color: "var(--vscode-dropdown-foreground)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontFamily: "var(--vscode-font-family)",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{c.cmd}</span>
                  <span
                    style={{
                      marginLeft: 12,
                      color: "var(--vscode-descriptionForeground)",
                    }}
                  >
                    {c.desc}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar: attach, slash hint, mode selector, send */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
        }}
      >
        {/* Attach button */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowAttach(!showAttach)}
            disabled={disabled}
            title="Add files or context"
            className="icon-btn"
            style={{
              width: 28,
              height: 28,
              fontSize: 14,
              lineHeight: "14px",
              background: "var(--vscode-toolbar-hoverBackground)",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            📎
          </button>

          {showAttach && (
            <>
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 49,
                }}
                onClick={() => setShowAttach(false)}
              />
              <div
                style={{
                  position: "absolute",
                  bottom: "110%",
                  left: 0,
                  minWidth: 200,
                  background: "var(--vscode-dropdown-background)",
                  border: "1px solid var(--vscode-dropdown-border)",
                  borderRadius: 6,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                  zIndex: 50,
                  overflow: "hidden",
                }}
              >
                {[
                  { icon: "📄", label: "Add files...", kind: "files" },
                  { icon: "📁", label: "Add folder...", kind: "folder" },
                  { icon: "📋", label: "Add from clipboard", kind: "clipboard" },
                ].map((item) => (
                  <button
                    key={item.kind}
                    onClick={() => {
                      setShowAttach(false);
                      if (item.kind === "files" || item.kind === "folder") {
                        vscode.postMessage({ type: "pickFiles", kind: item.kind });
                      }
                      if (item.kind === "clipboard") {
                        navigator.clipboard.readText().then((t) => {
                          setValue((prev) => prev + t);
                        });
                      }
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 12px",
                      border: "none",
                      background: "transparent",
                      color: "var(--vscode-dropdown-foreground)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontFamily: "var(--vscode-font-family)",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background =
                        "var(--vscode-list-activeSelectionBackground)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <span style={{ marginRight: 8 }}>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Slash command hint */}
        <button
          className="mini-btn"
          style={{
            width: "auto",
            padding: "1px 6px",
            fontSize: 10,
          }}
          onClick={() => {
            setValue((prev) => prev + "/");
            setSlashFilter("/");
            setShowSlash(true);
            textareaRef.current?.focus();
          }}
          title="Show command menu"
        >
          / commands
        </button>

        {/* Context usage ring */}
        {contextTokens > 0 && (
          <div style={{ marginLeft: 12 }}>
            <ContextRing
              tokens={contextTokens}
              maxTokens={contextMaxTokens}
              compactable={contextCompactable}
              onCompact={onCompact}
              cost={contextCost}
            />
          </div>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Mode selector */}
        <div
          style={{
            display: "flex",
            gap: 1,
            background: "var(--vscode-input-background)",
            borderRadius: 4,
            padding: 1,
          }}
        >
          {modes.map((m) => (
            <button
              key={m.key}
              onClick={() => onModeChange(m.key)}
              className={`mode-btn${mode === m.key ? " active" : ""}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="send-btn"
          style={{
            fontSize: 13,
            fontWeight: 600,
            opacity: disabled || !value.trim() ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ── Markdown renderer ────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRE_STYLE = 'background:var(--vscode-textCodeBlock-background);padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.5;margin:8px 0;';
const CODE_STYLE = 'background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px;font-size:12px;';
const TH_STYLE = 'border:1px solid var(--vscode-panel-border);padding:6px 12px;text-align:left;font-weight:600;';
const TD_STYLE = 'border:1px solid var(--vscode-panel-border);padding:6px 12px;';

function renderMarkdown(md: string): string {
  if (!md) return "";

  const protectedBlocks: string[] = [];

  function protect(html: string): string {
    const idx = protectedBlocks.length;
    protectedBlocks.push(html);
    return `\x00PROT${idx}\x00`;
  }

  let html = md;

  // Phase 1: Extract code blocks (protect from all processing)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const trimmed = code.trim();
    if (lang === "mermaid") {
      try {
        const raw = btoa(unescape(encodeURIComponent(trimmed)));
        const src = `https://mermaid.ink/img/${raw}`;
        return protect(`<div style="margin:8px 0;"><div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:4px;">mermaid</div><img src="${src}" alt="Diagram" style="max-width:100%;background:#fff;border-radius:6px;padding:8px;"/><details style="margin-top:4px;"><summary style="font-size:10px;color:var(--vscode-descriptionForeground);cursor:pointer;">View source</summary><pre style="${PRE_STYLE}"><code>${escapeHtml(trimmed)}</code></pre></details></div>`);
      } catch {
        // encoding failed, render as regular code block
      }
    }
    const langLabel = lang ? `<span style="font-size:10px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:4px;">${escapeHtml(lang)}</span>` : "";
    return protect(`<pre style="${PRE_STYLE}">${langLabel}<code>${escapeHtml(trimmed)}</code></pre>`);
  });

  // Phase 2: Extract inline code
  html = html.replace(/`([^`]+)`/g, (_m, code: string) => {
    return protect(`<code style="${CODE_STYLE}">${escapeHtml(code)}</code>`);
  });

  // Phase 3: Tables
  html = html.replace(/(?:^|\n)(\|[^\n]+\|)\n\|[-: |]+\|\n((?:\|[^\n]+\|\n?)+)/g, (_m, header: string, body: string) => {
    const headers = header.split("|").filter(c => c.trim()).map(c => `<th style="${TH_STYLE}">${processInline(c.trim())}</th>`).join("");
    const rows = body.trim().split("\n").map(row =>
      `<tr>${row.split("|").filter(c => c.trim()).map(c => `<td style="${TD_STYLE}">${processInline(c.trim())}</td>`).join("")}</tr>`
    ).join("");
    return protect(`<table style="border-collapse:collapse;margin:8px 0;width:100%;"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`);
  });

  // Phase 4: Escape HTML in remaining (non-protected) text
  html = escapeHtml(html);

  // Phase 5: Inline formatting FIRST (on escaped text), so blocks wrap already-formatted content
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/\b_(.+?)_\b/g, "<em>$1</em>");
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--vscode-textLink-foreground);">$1</a>');

  // Phase 6: Block formatting (wraps already-formatted inline HTML)
  // Blockquotes — after escaping, > becomes &gt;
  html = html.replace(/^&gt; (.+)$/gm, (_m, content: string) => {
    return protect(`<blockquote style="border-left:3px solid var(--vscode-activityBar-border);margin:8px 0;padding:4px 12px;color:var(--vscode-descriptionForeground);">${content}</blockquote>`);
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, (_m, content: string) => protect(`<h4 style="margin:12px 0 4px;font-size:14px;">${content}</h4>`));
  html = html.replace(/^## (.+)$/gm, (_m, content: string) => protect(`<h3 style="margin:14px 0 4px;font-size:15px;">${content}</h3>`));
  html = html.replace(/^# (.+)$/gm, (_m, content: string) => protect(`<h2 style="margin:16px 0 6px;font-size:16px;">${content}</h2>`));

  // Horizontal rules
  html = html.replace(/^[-*_]{3,}$/gm, () => protect('<hr style="border:none;border-top:1px solid var(--vscode-panel-border);margin:12px 0;">'));

  // Unordered lists
  html = html.replace(/((?:^[*-] .+$\n?)+)/gm, (m) => {
    const items = m.trim().split("\n").map(line => `<li style="margin-left:20px;">${line.replace(/^[*-] /, "")}</li>`).join("");
    return protect(`<ul style="margin:4px 0;padding:0;">${items}</ul>`);
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+$\n?)+)/gm, (m) => {
    const items = m.trim().split("\n").map(line => `<li style="margin-left:20px;">${line.replace(/^\d+\. /, "")}</li>`).join("");
    return protect(`<ol style="margin:4px 0;padding:0;">${items}</ol>`);
  });

  // Phase 7: Paragraphs
  html = html.replace(/\n\n+/g, '</p><p style="margin:4px 0;">');
  html = '<p style="margin:4px 0;">' + html + '</p>';
  html = html.replace(/\n/g, "<br>");

  // Phase 8: Restore all protected blocks
  html = html.replace(/\x00PROT(\d+)\x00/g, (_m, idx: string) => protectedBlocks[parseInt(idx)] ?? "");

  // Clean up empty paragraphs
  html = html.replace(/<p style="margin:4px 0;"><\/p>/g, "");

  return html;
}

function processInline(text: string): string {
  // Process bold, italic, code within table cells
  return text
    .replace(/`([^`]+)`/g, `<code style="${CODE_STYLE}">$1</code>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

// ── Message renderers ───────────────────────────────────────

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: "none",
          color: "var(--vscode-descriptionForeground)",
          cursor: "pointer",
          fontSize: 11,
          padding: 0,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Reasoning</span>
      </button>
      {open && (
        <pre
          style={{
            margin: "4px 0 0",
            padding: 8,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            color: "var(--vscode-descriptionForeground)",
            background: "var(--vscode-textCodeBlock-background)",
            borderRadius: 4,
            borderLeft: "2px solid var(--vscode-activityBar-border)",
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

const AgentBubble = memo(function AgentBubble({ msg }: { msg: UIMessage & { kind: "agent" } }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        fontSize: 13,
        lineHeight: 1.5,
        wordBreak: "break-word",
      }}
    >
      <ReasoningBlock text={msg.reasoning} />
      {msg.content ? (
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
      ) : (
        msg.streaming ? <Cursor /> : null
      )}
    </div>
  );
});

function Cursor() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 14,
        background: "var(--vscode-editorCursor-foreground, #ccc)",
        animation: "blink 1s step-end infinite",
        verticalAlign: "text-bottom",
      }}
    />
  );
}

const ToolCard = memo(function ToolCard({ msg }: { msg: UIMessage & { kind: "tool" } }) {
  const [expanded, setExpanded] = useState(false);
  const statusIcon = msg.status === "running" ? "⟳" : msg.status === "error" ? "✗" : "✓";
  const statusColor =
    msg.status === "running"
      ? "var(--vscode-inputValidation-warningBorder)"
      : msg.status === "error"
        ? "var(--vscode-inputValidation-errorBorder)"
        : "var(--vscode-testing-iconPassed)";

  const handleViewDiff = () => {
    vscode.postMessage({
      type: "viewDiff",
      filePath: msg.filePath ?? "",
      diffText: msg.output,
    });
  };

  return (
    <div
      style={{
        margin: "4px 12px",
        padding: 8,
        borderRadius: 6,
        border: "1px solid var(--vscode-panel-border)",
        background: "var(--vscode-editor-inactiveSelectionBackground)",
        fontSize: 12,
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
        }}
      >
        <span style={{ color: statusColor }}>{statusIcon}</span>
        <span style={{ fontWeight: 600 }}>{msg.toolName}</span>
        {msg.filePath && (
          <span style={{ color: "var(--vscode-textLink-foreground)", fontSize: 11 }}>
            {msg.filePath}
          </span>
        )}
        <span style={{ color: "var(--vscode-descriptionForeground)", marginLeft: "auto" }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>

      {/* View Diff button for file changes */}
      {msg.isDiff && msg.status === "done" && (
        <button
          onClick={(e) => { e.stopPropagation(); handleViewDiff(); }}
          style={{
            marginTop: 6,
            padding: "4px 10px",
            border: "1px solid var(--vscode-button-background)",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 11,
            background: "transparent",
            color: "var(--vscode-button-background)",
            fontWeight: 500,
          }}
        >
          View Diff
        </button>
      )}

      {expanded && (
        <div style={{ marginTop: 6 }}>
          {msg.args && (
            <pre
              style={{
                margin: 0,
                padding: 6,
                fontSize: 11,
                whiteSpace: "pre-wrap",
                background: "var(--vscode-textCodeBlock-background)",
                borderRadius: 4,
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {msg.args}
            </pre>
          )}
          {msg.output && !msg.isDiff && (
            <pre
              style={{
                margin: "4px 0 0",
                padding: 6,
                fontSize: 11,
                whiteSpace: "pre-wrap",
                background: "var(--vscode-textCodeBlock-background)",
                borderRadius: 4,
                maxHeight: 300,
                overflow: "auto",
              }}
            >
              {msg.output.slice(0, 2000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

const ApprovalCard = memo(function ApprovalCard({
  msg,
  onDecide,
}: {
  msg: UIMessage & { kind: "approval" };
  onDecide: (approvalId: string, decision: string, remember?: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      style={{
        margin: "8px 12px",
        padding: 10,
        borderRadius: 8,
        border: "2px solid var(--vscode-inputValidation-warningBorder, #cca700)",
        background: "var(--vscode-editor-background)",
        fontSize: 12,
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          fontWeight: 600,
          marginBottom: expanded ? 8 : 0,
        }}
      >
        <span>⚠</span>
        <span>Approval Required</span>
        <span style={{ color: "var(--vscode-descriptionForeground)", marginLeft: "auto" }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>

      {expanded && (
        <>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: "var(--vscode-descriptionForeground)" }}>Command: </span>
            <code
              style={{
                padding: "1px 4px",
                background: "var(--vscode-textCodeBlock-background)",
                borderRadius: 3,
                wordBreak: "break-all",
              }}
            >
              {msg.command}
            </code>
          </div>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: "var(--vscode-descriptionForeground)" }}>CWD: </span>
            {msg.cwd}
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: "var(--vscode-descriptionForeground)" }}>Reason: </span>
            {msg.reason}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => onDecide(msg.approvalId, "Approved")}
              style={approveBtnStyle}
            >
              Approve
            </button>
            <button
              onClick={() => onDecide(msg.approvalId, "ApprovedForSession")}
              style={{ ...approveBtnStyle, background: "var(--vscode-button-secondaryBackground)" }}
            >
              Approve for Session
            </button>
            <button
              onClick={() => onDecide(msg.approvalId, "Denied")}
              style={denyBtnStyle}
            >
              Deny
            </button>
            <button
              onClick={() => onDecide(msg.approvalId, "Abort")}
              style={denyBtnStyle}
            >
              Abort
            </button>
          </div>
        </>
      )}
    </div>
  );
});

const approveBtnStyle: React.CSSProperties = {
  padding: "4px 12px",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
  background: "var(--vscode-button-background)",
  color: "var(--vscode-button-foreground)",
};

const denyBtnStyle: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid var(--vscode-panel-border)",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  background: "transparent",
  color: "var(--vscode-foreground)",
};


function ProviderSettingsPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const [providerName, setProviderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [baseUrlError, setBaseUrlError] = useState("");
  const [saved, setSaved] = useState(false);

  const validateBaseUrl = (url: string) => {
    if (!url) { setBaseUrlError(""); return; }
    if (!/^https?:\/\/.+/.test(url)) {
      setBaseUrlError("URL must start with http:// or https://");
    } else {
      setBaseUrlError("");
    }
  };

  useEffect(() => {
    // Request current config from extension
    vscode.postMessage({ type: "getProviderConfig" });
    const handler = (e: MessageEvent) => {
      const msg = e.data as Record<string, unknown>;
      if (msg.type === "providerConfig" && msg.config) {
        const cfg = msg.config as Record<string, string>;
        setProviderName(cfg.providerName ?? "");
        setApiKey(cfg.apiKey ?? "");
        setBaseUrl(cfg.baseUrl ?? "");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleSave = () => {
    vscode.postMessage({
      type: "saveProviderConfig",
      config: { providerName, apiKey, baseUrl },
    });
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 800);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          padding: 20,
          borderRadius: 8,
          background: "var(--vscode-editor-background)",
          border: "1px solid var(--vscode-panel-border)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Provider Settings</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--vscode-descriptionForeground)" }}>
            ✕
          </button>
        </div>

        <label style={labelStyle}>
          Provider Name
          <input
            value={providerName}
            onChange={(e) => setProviderName(e.target.value)}
            placeholder="deepseek"
            style={inputStyle}
          />
        </label>

        <label style={labelStyle}>
          API Key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            style={inputStyle}
          />
        </label>

        <label style={labelStyle}>
          Base URL
          <input
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); validateBaseUrl(e.target.value); }}
            onBlur={(e) => validateBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            style={{ ...inputStyle, borderColor: baseUrlError ? "var(--vscode-inputValidation-errorBorder)" : inputStyle.borderColor }}
          />
          <span style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)", marginTop: 2 }}>
            默认 https://api.deepseek.com/v1
          </span>
          {baseUrlError && (
            <span style={{ fontSize: 10, color: "var(--vscode-inputValidation-errorForeground)", marginTop: 2 }}>{baseUrlError}</span>
          )}
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={denyBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={{
            padding: "4px 16px",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            background: saved ? "var(--vscode-testing-iconPassed)" : "var(--vscode-button-background)",
            color: "var(--vscode-button-foreground)",
          }}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 12,
  fontSize: 12,
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  fontFamily: "var(--vscode-font-family)",
  color: "var(--vscode-input-foreground)",
  background: "var(--vscode-input-background)",
  border: "1px solid var(--vscode-input-border)",
  borderRadius: 4,
  outline: "none",
};

const StatusBanner = memo(function StatusBanner({ msg }: { msg: UIMessage & { kind: "status" } }) {
  const bg =
    msg.level === "error"
      ? "var(--vscode-inputValidation-errorBackground)"
      : "var(--vscode-inputValidation-infoBackground)";
  return (
    <div
      style={{
        margin: "4px 12px",
        padding: "6px 10px",
        borderRadius: 4,
        background: bg,
        fontSize: 12,
        color: "var(--vscode-foreground)",
      }}
    >
      {msg.text}
    </div>
  );
});

function FileContextBar({
  files,
  onRemove,
  onClear,
}: {
  files: ContextFile[];
  onRemove: (path: string) => void;
  onClear: () => void;
}) {
  if (files.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        borderTop: "1px solid var(--vscode-panel-border)",
        background: "var(--vscode-editor-background)",
        fontSize: 11,
        color: "var(--vscode-descriptionForeground)",
        minHeight: 24,
      }}
    >
      <span style={{ fontWeight: 500 }}>Showing current file selection:</span>
      {files.map((f) => (
        <span
          key={f.path}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "1px 6px",
            borderRadius: 3,
            background: "var(--vscode-badge-background)",
            color: "var(--vscode-badge-foreground)",
          }}
        >
          {f.type === "dir" ? "📁" : "📄"} {f.path}
          <button
            onClick={() => onRemove(f.path)}
            style={{
              background: "none",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
              lineHeight: 1,
              marginLeft: 2,
            }}
          >
            ×
          </button>
        </span>
      ))}
      <button
        onClick={onClear}
        style={{
          marginLeft: "auto",
          background: "none",
          border: "none",
          color: "var(--vscode-descriptionForeground)",
          cursor: "pointer",
          fontSize: 11,
          padding: 0,
        }}
      >
        Clear all
      </button>
    </div>
  );
}

// ── Thread list sidebar ─────────────────────────────────────

function ThreadSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  threads: ThreadSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  return (
    <div
      style={{
        width: 200,
        borderRight: "1px solid var(--vscode-panel-border)",
        display: "flex",
        flexDirection: "column",
        background: "var(--vscode-sideBar-background)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--vscode-descriptionForeground)" }}>
          Threads
        </span>
        <button
          onClick={onNew}
          title="New thread"
          className="icon-btn"
          style={{
            width: 20,
            height: 20,
            fontSize: 14,
            lineHeight: "14px",
            background: "var(--vscode-button-background)",
            color: "var(--vscode-button-foreground)",
          }}
        >
          +
        </button>
      </div>
      {/* Search */}
      <div style={{ padding: "0 8px 4px" }}>
        <input
          placeholder="Search conversations..."
          onChange={(e) => vscode.postMessage({ type: "searchThreads", search: e.target.value })}
          style={{
            width: "100%",
            padding: "3px 6px",
            fontSize: 11,
            fontFamily: "var(--vscode-font-family)",
            color: "var(--vscode-input-foreground)",
            background: "var(--vscode-input-background)",
            border: "1px solid var(--vscode-input-border)",
            borderRadius: 3,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {threads.map((t) => (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            onMouseEnter={() => setHoverId(t.id)}
            onMouseLeave={() => setHoverId(null)}
            className="sidebar-item"
            style={{
              padding: "6px 10px",
              cursor: "pointer",
              fontSize: 12,
              position: "relative",
              background:
                t.id === activeId
                  ? "var(--vscode-list-activeSelectionBackground)"
                  : "transparent",
              color:
                t.id === activeId
                  ? "var(--vscode-list-activeSelectionForeground)"
                  : "var(--vscode-foreground)",
              borderLeft: t.id === activeId ? "3px solid var(--vscode-focusBorder)" : "3px solid transparent",
              opacity: t.archived ? 0.5 : 1,
            }}
          >
            <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {editingId === t.id ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onRename(t.id, editTitle.trim() || t.title || t.id.slice(0, 8));
                      setEditingId(null);
                    }
                    if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  onBlur={() => setEditingId(null)}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: "100%",
                    fontSize: 12,
                    fontFamily: "var(--vscode-font-family)",
                    color: "var(--vscode-input-foreground)",
                    background: "var(--vscode-input-background)",
                    border: "1px solid var(--vscode-focusBorder)",
                    borderRadius: 2,
                    padding: "1px 4px",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              ) : (
                t.title || t.id.slice(0, 8)
              )}
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--vscode-descriptionForeground)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginTop: 2,
              }}
            >
              {t.preview || " "}
            </div>
            {/* Hover actions */}
            {hoverId === t.id && (
              <div
                style={{
                  position: "absolute",
                  right: 4,
                  top: 4,
                  display: "flex",
                  gap: 2,
                }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(t.id);
                    setEditTitle(t.title || "");
                  }}
                  title="Rename"
                  className="mini-btn"
                >
                  ✏️
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (deletingId === t.id) {
                      onDelete(t.id);
                      setDeletingId(null);
                    } else {
                      setDeletingId(t.id);
                      setTimeout(() => setDeletingId(null), 3000);
                    }
                  }}
                  title={deletingId === t.id ? "Click again to confirm delete" : "Delete"}
                  className="mini-btn"
                  style={deletingId === t.id ? { background: "var(--vscode-inputValidation-errorBackground)", color: "var(--vscode-inputValidation-errorBorder)" } : undefined}
                >
                  {deletingId === t.id ? "❓" : "🗑️"}
                </button>
              </div>
            )}
          </div>
        ))}
        {threads.length === 0 && (
          <div
            style={{
              padding: 12,
              fontSize: 11,
              color: "var(--vscode-descriptionForeground)",
              textAlign: "center",
            }}
          >
            No conversations yet
          </div>
        )}
      </div>
    </div>
  );
}

// ── Error Boundary ──────────────────────────────────────────

class ErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            color: "var(--vscode-foreground)",
            fontFamily: "var(--vscode-font-family)",
            gap: 12,
            padding: 20,
          }}
        >
          <span style={{ fontSize: 28 }}>⚠</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Something went wrong</span>
          <pre
            style={{
              fontSize: 11,
              color: "var(--vscode-inputValidation-errorBorder)",
              whiteSpace: "pre-wrap",
              maxWidth: 400,
              textAlign: "center",
            }}
          >
            {this.state.error}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: "" })}
            style={{
              padding: "6px 16px",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
              background: "var(--vscode-button-background)",
              color: "var(--vscode-button-foreground)",
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Main App ────────────────────────────────────────────────

export default function App() {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    threads: [],
    activeThreadId: null,
    connectionState: "connecting",
    approvalMode: "agent",
    downloadPhase: "",
    downloadPct: 0,
    reconnectAttempt: 0,
    contextFiles: [],
    contextTokens: 0,
    contextCompactable: false,
    contextCost: 0,
  });

  const chatEndRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<Map<string, boolean>>(new Map());
  const itemKindRef = useRef<Map<string, string>>(new Map()); // item_id → kind from item.started
  const hasDeltaRef = useRef<Set<string>>(new Set()); // item_ids that received at least one delta
  const pendingUserMsgRef = useRef<string>("");

  // ── Scroll to bottom when new messages arrive ────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  // ── Listen for postMessage from extension ────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data as Record<string, unknown>;
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "connectionState":
          dispatch({ type: "setConnection", state: msg.state as ConnectionState });
          if (msg.state === "connected") {
            dispatch({ type: "setReconnect", attempt: 0 });
          }
          break;

        case "threadList":
          dispatch({ type: "setThreads", threads: msg.threads as ThreadSummary[] });
          break;

        case "threadCreated":
          // Refresh the thread list
          vscode.postMessage({ type: "listThreads" });
          break;

        case "activeThread":
          dispatch({
            type: "setActiveThread",
            threadId: msg.threadId as string,
          });
          break;

        case "sseEvent":
          handleSseEvent(msg.event as SseEventEnvelope);
          break;

        case "threadRenamed":
          // Refresh the thread list after rename
          vscode.postMessage({ type: "listThreads" });
          break;

        case "threadDeleted": {
          const deletedId = msg.threadId as string;
          if (state.activeThreadId === deletedId) {
            dispatch({ type: "setActiveThread", threadId: null });
          }
          vscode.postMessage({ type: "listThreads" });
          break;
        }

        case "error":
          dispatch({
            type: "addMessage",
            msg: {
              kind: "status",
              id: `err-${Date.now()}`,
              text: msg.message as string,
              level: "error",
            },
          });
          break;

        case "downloadProgress": {
          const dp = msg as unknown as DownloadProgress;
          if (dp.phase === "downloading" && dp.current != null && dp.total != null) {
            dispatch({
              type: "setDownload",
              phase: "downloading",
              pct: Math.round((dp.current / dp.total) * 100),
            });
          } else if (dp.phase === "verifying") {
            dispatch({ type: "setDownload", phase: "verifying", pct: 0 });
          } else if (dp.phase === "done") {
            dispatch({ type: "setDownload", phase: "", pct: 0 });
          }
          break;
        }

        case "reconnecting": {
          const ri = msg as unknown as ReconnectInfo;
          dispatch({ type: "setReconnect", attempt: ri.attempt });
          dispatch({
            type: "addMessage",
            msg: {
              kind: "status",
              id: `reconnect-${ri.attempt}`,
              text: `Connection lost. Reconnecting (attempt ${ri.attempt})...`,
              level: "info",
            },
          });
          break;
        }

        case "threadUsage": {
          // Real token counts from backend API
          const tokens = msg.tokens as number;
          const cost = msg.cost as number | undefined;
          if (typeof tokens === "number") {
            dispatch({ type: "setContextUsage", tokens, cost });
            dispatch({ type: "setCompactable", compactable: tokens > DEFAULT_MODEL_MAX_TOKENS * 0.4 });
          }
          break;
        }

        case "contextCompacted": {
          dispatch({ type: "setContextUsage", tokens: 0 });
          dispatch({ type: "setCompactable", compactable: false });
          break;
        }

        case "contextFilesUpdated": {
          const files = msg.files as ContextFile[];
          dispatch({ type: "clearContextFiles" });
          files.forEach((f) => dispatch({ type: "addContextFile", file: f }));
          break;
        }
      }
    };

    window.addEventListener("message", handler);
    // Tell the extension we're ready
    vscode.postMessage({ type: "init" });
    vscode.postMessage({ type: "listThreads" });

    return () => window.removeEventListener("message", handler);
  }, []);

  // ── SSE event → UI state ─────────────────────────────────
  function handleSseEvent(ev: SseEventEnvelope) {
    const { event, payload } = ev;

    // Log payload structure for debugging
    if (event !== "item.delta") {
      console.log("[SSE]", event, "item_id:", ev.item_id, "payload keys:", Object.keys(payload).join(","));
    }

    switch (event) {
      case "item.started": {
        const item = payload.item as Record<string, unknown> | undefined;
        const kind = (item?.kind as string) ?? "unknown";
        console.log("[SSE] item.started kind:", kind);

        if (kind === "user_message") {
          // User messages: dedup against local add from handleSend (live mode).
          // During history replay, pendingUserMsgRef is empty so we add for real.
          const id = (item?.id as string) ?? ev.item_id;
          const text = (item?.detail as string) ?? (item?.text as string) ?? "";
          if (pendingUserMsgRef.current === text) {
            pendingUserMsgRef.current = ""; // consumed by SSE — skip add
            activeItemRef.current.set(id, true); // but track ID so item.completed doesn't re-add
            break;
          }
          activeItemRef.current.set(id, true);
          itemKindRef.current.set(id, kind);
          dispatch({
            type: "addMessage",
            msg: { kind: "user", id, content: text },
          });
        } else if (kind === "context_compaction" || kind === "status") {
          // System status items — show as info status message
          const id = (item?.id as string) ?? ev.item_id;
          activeItemRef.current.set(id, true);
          itemKindRef.current.set(id, kind);
          const statusText = kind === "context_compaction" ? "Context compaction in progress..." : "";
          dispatch({
            type: "addMessage",
            msg: { kind: "status", id, text: statusText, level: "info" },
          });
        } else if (kind === "agent_message" || kind === "agent_reasoning") {
          const id = (item?.id as string) ?? ev.item_id;
          if (activeItemRef.current.has(id)) return;
          activeItemRef.current.set(id, true);
          itemKindRef.current.set(id, kind);
          dispatch({
            type: "addMessage",
            msg: {
              kind: "agent",
              id,
              content: "",
              reasoning: "",
              streaming: true,
            },
          });
        } else if (kind === "tool_call" || kind === "file_change" || kind === "command_execution") {
          const id = (item?.id as string) ?? ev.item_id;
          const tool = payload.tool as Record<string, unknown> | undefined;
          itemKindRef.current.set(id, kind);
          dispatch({
            type: "addMessage",
            msg: {
              kind: "tool",
              id,
              toolName: (tool?.name as string) ?? kind,
              args: JSON.stringify(tool?.input ?? {}, null, 2),
              output: "",
              status: "running",
            },
          });
        } else {
          // Unknown kind — treat as agent message to show content
          console.log("[SSE] unknown item kind:", kind, "treating as agent message");
          const id = (item?.id as string) ?? ev.item_id;
          if (activeItemRef.current.has(id)) return;
          activeItemRef.current.set(id, true);
          itemKindRef.current.set(id, "agent_message");
          dispatch({
            type: "addMessage",
            msg: {
              kind: "agent",
              id,
              content: "",
              reasoning: "",
              streaming: true,
            },
          });
        }
        break;
      }

      case "item.delta": {
        const delta = (payload.delta as string) ?? (payload.text as string);
        if (!delta) break;
        hasDeltaRef.current.add(ev.item_id);
        const deltaKind = (payload.kind as string) ?? itemKindRef.current.get(ev.item_id) ?? "";
        const channel =
          deltaKind === "agent_reasoning" || deltaKind === "reasoning" ? "reasoning" : "text";
        dispatch({
          type: "appendDelta",
          id: ev.item_id,
          delta,
          channel,
        });
        break;
      }

      case "item.completed": {
        const item = payload.item as Record<string, unknown> | undefined;
        const kind = (item?.kind as string) ?? "unknown";
        const id = ev.item_id;
        console.log("[SSE] item.completed kind:", kind);

        if (kind === "user_message") {
          // User message completed — if not already added by item.started, add now (history replay safety net)
          if (!activeItemRef.current.has(id)) {
            activeItemRef.current.set(id, true);
            const text = (item?.detail as string) ?? (item?.text as string) ?? "";
            dispatch({
              type: "addMessage",
              msg: { kind: "user", id, content: text },
            });
          }
        } else if (kind === "context_compaction" || kind === "status") {
          // Compaction complete — reset context usage and show result
          dispatch({ type: "setContextUsage", tokens: 0 });
          dispatch({ type: "setCompactable", compactable: false });
          const detail = (item?.detail as string) ?? (payload?.detail as string) ?? "";
          // Update status message with result
          const id = ev.item_id;
          if (detail && activeItemRef.current.has(id)) {
            dispatch({ type: "updateMessage", id, patch: { text: `Context compacted: ${detail}` } as Partial<UIMessage> });
          }
        } else if (kind === "agent_message" || kind === "agent_reasoning" || kind === "unknown") {
          // If the item wasn't started (unknown kind captured mid-stream), create it now
          if (!activeItemRef.current.has(id)) {
            activeItemRef.current.set(id, true);
            const detail = (item?.detail as string) ?? (payload.detail as string) ?? "";
            const text = (item?.text as string) ?? (payload.text as string) ?? "";
            const itemKind = itemKindRef.current.get(id) ?? kind;
            const content = detail || text || JSON.stringify(item);
            dispatch({
              type: "addMessage",
              msg: {
                kind: "agent",
                id,
                content: itemKind === "agent_reasoning" ? "" : content,
                reasoning: itemKind === "agent_reasoning" ? content : "",
                streaming: false,
              },
            });
          } else {
            // Only append detail if deltas weren't already received (no duplication)
            if (!hasDeltaRef.current.has(id)) {
              const detail = (item?.detail as string) ?? (payload.detail as string) ?? "";
              const text = (item?.text as string) ?? (payload.text as string) ?? "";
              const fullText = detail || text;
              if (fullText) {
                const itemKind = itemKindRef.current.get(id) ?? kind;
                const channel =
                  itemKind === "agent_reasoning" ? "reasoning" : "text";
                dispatch({ type: "appendDelta", id, delta: fullText, channel });
              }
            }
            dispatch({ type: "finishStreaming", id });
          }
        } else if (kind === "tool_call" || kind === "file_change" || kind === "command_execution") {
          const detail = (item?.detail as string) ?? "";
          const text = (item?.text as string) ?? "";
          const output = detail || text;
          const isDiff = looksLikeDiff(output);
          const filePath = isDiff ? extractFilePath(output) : undefined;
          dispatch({
            type: "updateMessage",
            id,
            patch: {
              status: "done",
              output,
              isDiff,
              filePath,
            } as Partial<UIMessage>,
          });
        } else if (kind === "error") {
          dispatch({
            type: "addMessage",
            msg: {
              kind: "status",
              id: `turn-err-${Date.now()}`,
              text: (item?.detail as string) ?? (item?.message as string) ?? "Unknown error",
              level: "error",
            },
          });
        }
        break;
      }

      case "item.failed": {
        const item = payload.item as Record<string, unknown> | undefined;
        const errMsg = (item?.detail as string) ?? (payload.error as string) ?? "Item failed";
        console.log("[SSE] item.failed:", errMsg);
        dispatch({ type: "finishStreaming", id: ev.item_id });
        // If the item was never started, show as error status
        if (!activeItemRef.current.has(ev.item_id)) {
          dispatch({
            type: "addMessage",
            msg: {
              kind: "status",
              id: `item-err-${Date.now()}`,
              text: errMsg,
              level: "error",
            },
          });
        } else {
          dispatch({
            type: "updateMessage",
            id: ev.item_id,
            patch: {
              status: "error",
              output: errMsg,
            } as Partial<UIMessage>,
          });
        }
        break;
      }

      case "approval.required": {
        const approvalId = (payload.approval_id as string) ?? ev.item_id;
        dispatch({
          type: "addMessage",
          msg: {
            kind: "approval",
            id: `approval-${approvalId}`,
            approvalId,
            command: (payload.command as string) ?? (payload.tool_name as string) ?? "",
            cwd: (payload.cwd as string) ?? "",
            reason: (payload.reason as string) ?? (payload.description as string) ?? "",
          },
        });
        break;
      }

      case "turn.completed": {
        dispatch({ type: "finishAllStreaming" });
        activeItemRef.current.clear();
        itemKindRef.current.clear();
        hasDeltaRef.current.clear();
        // Context usage is estimated from messages via useEffect
        break;
      }

      case "turn.error": {
        dispatch({ type: "finishAllStreaming" });
        activeItemRef.current.clear();
        itemKindRef.current.clear();
        hasDeltaRef.current.clear();
        const errMsg = (payload.error as string) ?? (payload.message as string) ?? "Turn failed";
        dispatch({
          type: "addMessage",
          msg: {
            kind: "status",
            id: `turn-err-${Date.now()}`,
            text: errMsg,
            level: "error",
          },
        });
        break;
      }

      // Lifecycle events — informational, not displayed
      case "thread.started":
      case "turn.started":
      case "turn.lifecycle":
        break;

      default: {
        console.log("[SSE] unhandled event:", event, JSON.stringify(payload).slice(0, 300));
        break;
      }
    }
  }

  // ── Callbacks ─────────────────────────────────────────────
  const handleSend = useCallback(
    (text: string) => {
      if (!state.activeThreadId) return;
      pendingUserMsgRef.current = text;
      dispatch({
        type: "addMessage",
        msg: { kind: "user", id: `user-${Date.now()}`, content: text },
      });
      vscode.postMessage({
        type: "sendPrompt",
        threadId: state.activeThreadId,
        prompt: text,
      });
    },
    [state.activeThreadId]
  );

  const handleNewThread = useCallback(() => {
    vscode.postMessage({ type: "newThread", mode: state.approvalMode });
  }, [state.approvalMode]);

  const handleSelectThread = useCallback((id: string) => {
    vscode.postMessage({ type: "selectThread", threadId: id });
  }, []);

  const handleApproval = useCallback(
    (approvalId: string, decision: string, remember?: boolean) => {
      vscode.postMessage({
        type: "approvalDecision",
        approvalId,
        decision,
        remember,
      });
    },
    []
  );

  const [showSettings, setShowSettings] = useState(false);

  const handleModeChange = useCallback((mode: ApprovalMode) => {
    dispatch({ type: "setApprovalMode", mode });
  }, []);

  const handleRename = useCallback((id: string, title: string) => {
    vscode.postMessage({ type: "renameThread", threadId: id, title });
  }, []);

  const handleDelete = useCallback((id: string) => {
    console.log("[CodeWhale webview] handleDelete called, id:", id);
    vscode.postMessage({ type: "deleteThread", threadId: id });
  }, []);

  const handleAddFiles = useCallback(() => {
    vscode.postMessage({ type: "pickFiles" });
  }, []);

  const handleRemoveFile = useCallback((path: string) => {
    dispatch({ type: "removeContextFile", path });
  }, []);

  const handleClearFiles = useCallback(() => {
    dispatch({ type: "clearContextFiles" });
  }, []);

  // ── Render ─────────────────────────────────────────────────
  const isBusy = state.messages.some(
    (m) =>
      (m.kind === "agent" && m.streaming) ||
      (m.kind === "tool" && m.status === "running")
  );

  // Estimate context tokens from message content (≈3 chars per token)
  useEffect(() => {
    let chars = 0;
    for (const m of state.messages) {
      if (m.kind === "user") chars += m.content.length;
      else if (m.kind === "agent") chars += m.content.length + m.reasoning.length;
      else if (m.kind === "tool") chars += (m.output?.length ?? 0) + (m.args?.length ?? 0);
      else if (m.kind === "status") chars += m.text.length;
    }
    const estimatedTokens = Math.ceil(chars / 3);
    dispatch({ type: "setContextUsage", tokens: estimatedTokens });
    dispatch({ type: "setCompactable", compactable: estimatedTokens > DEFAULT_MODEL_MAX_TOKENS * 0.4 });
  }, [state.messages]);

  return (
    <ErrorBoundary>
    <style>{`
      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0; }
      }
      button {
        transition: background 0.15s, opacity 0.15s;
      }
      button:hover:not(:disabled) {
        filter: brightness(1.15);
      }
      .mini-btn {
        width: 22px; height: 22px; border: none; border-radius: 3px;
        cursor: pointer; font-size: 12px; line-height: 12px;
        display: flex; align-items: center; justify-content: center;
        background: var(--vscode-toolbar-hoverBackground);
        color: var(--vscode-foreground);
      }
      .mini-btn:hover {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      .sidebar-item:hover {
        background: var(--vscode-list-hoverBackground) !important;
      }
      .icon-btn {
        background: transparent; border: none; border-radius: 4px;
        cursor: pointer; color: var(--vscode-foreground);
        display: flex; align-items: center; justify-content: center;
      }
      .icon-btn:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }
      .mode-btn {
        padding: 3px 8px; border: none; border-radius: 3px;
        font-size: 11px; cursor: pointer;
        background: transparent; color: var(--vscode-foreground);
      }
      .mode-btn:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }
      .mode-btn.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        font-weight: 600;
      }
      .send-btn {
        padding: 6px 14px; border: none; border-radius: 4px;
        cursor: pointer; font-size: 13px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      .send-btn:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground);
      }
      .send-btn:disabled {
        cursor: not-allowed; opacity: 0.5;
      }
    `}</style>
    <div
      style={{
        display: "flex",
        height: "100vh",
        fontFamily: "var(--vscode-font-family)",
        color: "var(--vscode-foreground)",
      }}
    >
      <ThreadSidebar
        threads={state.threads}
        activeId={state.activeThreadId}
        onSelect={handleSelectThread}
        onNew={handleNewThread}
        onRename={handleRename}
        onDelete={handleDelete}
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 12px",
            borderBottom: "1px solid var(--vscode-panel-border)",
            background: "var(--vscode-titleBar-activeBackground, var(--vscode-editor-background))",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>CodeWhale</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={() => setShowSettings(true)}
              title="Provider Settings"
              className="icon-btn"
              style={{
                width: 28,
                height: 28,
                fontSize: 16,
              }}
            >
              ⚙
            </button>
            <ConnectionBadge state={state.connectionState} />
          </div>
        </div>

        {/* Provider Settings Modal */}
        {showSettings && (
          <ProviderSettingsPanel onClose={() => setShowSettings(false)} />
        )}

        {/* Download / reconnect status */}
        {state.downloadPhase && (
          <div
            style={{
              margin: 0,
              padding: "6px 12px",
              background: "var(--vscode-inputValidation-infoBackground)",
              borderBottom: "1px solid var(--vscode-panel-border)",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {state.downloadPhase === "verifying" ? "Verifying binary..." : `Downloading CodeWhale... ${state.downloadPct}%`}
            </span>
            {state.downloadPhase === "downloading" && (
              <div
                style={{
                  flex: 1,
                  height: 4,
                  background: "var(--vscode-input-background)",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${state.downloadPct}%`,
                    height: "100%",
                    background: "var(--vscode-button-background)",
                    transition: "width 0.2s",
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "4px 0",
            willChange: "transform",
          }}
        >
          {state.messages.length === 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--vscode-descriptionForeground)",
                fontSize: 13,
                gap: 8,
              }}
            >
              <span style={{ fontSize: 28 }}>🐋</span>
              <span>
                {state.connectionState === "connected"
                  ? "Create a new thread to get started"
                  : "Waiting for CodeWhale to connect..."}
              </span>
              {state.connectionState === "connected" && (
                <button
                  onClick={handleNewThread}
                  style={{
                    marginTop: 4,
                    padding: "6px 16px",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 13,
                    background: "var(--vscode-button-background)",
                    color: "var(--vscode-button-foreground)",
                  }}
                >
                  New Thread
                </button>
              )}
            </div>
          )}
          {state.messages.map((msg) => {
            switch (msg.kind) {
              case "user":
                return (
                  <div key={msg.id} style={{ padding: "8px 12px" }}>
                    <div
                      style={{
                        display: "inline-block",
                        maxWidth: "85%",
                        padding: "6px 12px",
                        borderRadius: 12,
                        background: "var(--vscode-button-background)",
                        color: "var(--vscode-button-foreground)",
                        fontSize: 13,
                        lineHeight: 1.4,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {msg.content}
                    </div>
                  </div>
                );
              case "agent":
                return <AgentBubble key={msg.id} msg={msg} />;
              case "tool":
                return <ToolCard key={msg.id} msg={msg} />;
              case "approval":
                return (
                  <ApprovalCard
                    key={msg.id}
                    msg={msg}
                    onDecide={handleApproval}
                  />
                );
              case "status":
                return <StatusBanner key={msg.id} msg={msg} />;
              default:
                return null;
            }
          })}
          <div ref={chatEndRef} />
        </div>

        {/* File context bar */}
        <FileContextBar
          files={state.contextFiles}
          onRemove={handleRemoveFile}
          onClear={handleClearFiles}
        />

        {/* Input */}
        <MessageInput
          disabled={
            state.connectionState !== "connected" ||
            state.activeThreadId === null ||
            isBusy
          }
          onSend={handleSend}
          mode={state.approvalMode}
          onModeChange={handleModeChange}
          contextFiles={state.contextFiles}
          onAddFiles={handleAddFiles}
          onRemoveFile={handleRemoveFile}
          contextTokens={state.contextTokens}
          contextMaxTokens={DEFAULT_MODEL_MAX_TOKENS}
          contextCompactable={state.contextCompactable}
          onCompact={() => vscode.postMessage({ type: "compactThread", threadId: state.activeThreadId })}
          contextCost={state.contextCost}
        />
      </div>
    </div>
    </ErrorBoundary>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
