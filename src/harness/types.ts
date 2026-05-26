// ─── Envelope ────────────────────────────────────────────────
// Mirrors crates/protocol/src/lib.rs Envelope<T>

export interface Envelope<T> {
  request_id: string;
  thread_id?: string;
  body: T;
}

// ─── Thread ──────────────────────────────────────────────────

export type ThreadStatus =
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "paused"
  | "archived";

export type SessionSource =
  | "interactive"
  | "resume"
  | "fork"
  | "api"
  | "unknown";

export interface Thread {
  id: string;
  preview: string;
  ephemeral: boolean;
  model_provider: string;
  created_at: number;
  updated_at: number;
  status: ThreadStatus;
  path?: string;
  cwd: string;
  cli_version: string;
  source: SessionSource;
  name?: string;
}

// ─── Thread Requests ─────────────────────────────────────────

export interface ThreadStartParams {
  model?: string;
  model_provider?: string;
  cwd?: string;
  persist_extended_history?: boolean;
}

export interface ThreadResumeParams {
  thread_id: string;
  history?: unknown[];
  path?: string;
  model?: string;
  model_provider?: string;
  cwd?: string;
  approval_policy?: string;
  sandbox?: string;
  config?: unknown;
  base_instructions?: string;
  developer_instructions?: string;
  personality?: string;
  persist_extended_history?: boolean;
}

export interface ThreadForkParams {
  thread_id: string;
  path?: string;
  model?: string;
  model_provider?: string;
  cwd?: string;
  approval_policy?: string;
  sandbox?: string;
  config?: unknown;
  base_instructions?: string;
  developer_instructions?: string;
  persist_extended_history?: boolean;
}

export interface ThreadListParams {
  include_archived?: boolean;
  limit?: number;
}

export interface ThreadReadParams {
  thread_id: string;
}

export interface ThreadSetNameParams {
  thread_id: string;
  name: string;
}

export type ThreadRequest =
  | { kind: "create"; metadata: unknown }
  | { kind: "start"; params: ThreadStartParams }
  | { kind: "resume"; params: ThreadResumeParams }
  | { kind: "fork"; params: ThreadForkParams }
  | { kind: "list"; params: ThreadListParams }
  | { kind: "read"; params: ThreadReadParams }
  | { kind: "set_name"; params: ThreadSetNameParams }
  | { kind: "archive"; thread_id: string }
  | { kind: "unarchive"; thread_id: string }
  | { kind: "message"; thread_id: string; input: string };

// ─── Thread Response ─────────────────────────────────────────

export interface ThreadResponse {
  thread_id: string;
  status: string;
  thread?: Thread;
  threads: Thread[];
  model?: string;
  model_provider?: string;
  cwd?: string;
  approval_policy?: string;
  sandbox?: string;
  events: EventFrame[];
  data: unknown;
}

// ─── App Requests ────────────────────────────────────────────

export type AppRequest =
  | { kind: "capabilities" }
  | { kind: "config_get"; key: string }
  | { kind: "config_set"; key: string; value: string }
  | { kind: "config_unset"; key: string }
  | { kind: "config_list" }
  | { kind: "models" }
  | { kind: "thread_loaded_list" };

export interface AppResponse {
  ok: boolean;
  data: unknown;
  events: EventFrame[];
}

// ─── Prompt ──────────────────────────────────────────────────

export interface PromptRequest {
  thread_id?: string;
  prompt: string;
  model?: string;
}

export interface PromptResponse {
  output: string;
  model: string;
  events: EventFrame[];
}

// ─── Approval ────────────────────────────────────────────────

export type AskForApproval =
  | "unless_trusted"
  | "on_failure"
  | "on_request"
  | "never"
  | { reject: { sandbox_approval: boolean; rules: boolean; mcp_elicitations: boolean } };

export type ReviewDecisionTag =
  | "approved"
  | "approved_execpolicy_amendment"
  | "approved_for_session"
  | "denied"
  | "abort";

export type NetworkPolicyRuleAction = "allow" | "deny";

export interface NetworkPolicyAmendment {
  host: string;
  action: NetworkPolicyRuleAction;
}

export type ReviewDecision =
  | { type: "approved" }
  | { type: "approved_execpolicy_amendment" }
  | { type: "approved_for_session" }
  | {
      type: "network_policy_amendment";
      host: string;
      action: NetworkPolicyRuleAction;
    }
  | { type: "denied" }
  | { type: "abort" };

export interface NetworkApprovalContext {
  host: string;
  protocol: string;
}

export interface ExecApprovalRequestEvent {
  call_id: string;
  approval_id: string;
  turn_id: string;
  command: string;
  cwd: string;
  reason: string;
  network_approval_context?: NetworkApprovalContext;
  proposed_execpolicy_amendment: string[];
  proposed_network_policy_amendments: NetworkPolicyAmendment[];
  additional_permissions: string[];
  available_decisions: ReviewDecision[];
}

// ─── Tools ───────────────────────────────────────────────────

export type ToolKind = "function" | "mcp";

export interface LocalShellParams {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export type ToolPayload =
  | { type: "function"; arguments: string }
  | { type: "custom"; input: string }
  | { type: "local_shell"; params: LocalShellParams }
  | {
      type: "mcp";
      server: string;
      tool: string;
      raw_arguments: unknown;
      raw_tool_call_id?: string;
    };

export type ToolOutput =
  | { type: "function"; body?: unknown; success: boolean }
  | { type: "mcp"; result: unknown };

// ─── Response Stream ─────────────────────────────────────────

export type ResponseChannel = "text" | "reasoning";

// ─── MCP Startup ─────────────────────────────────────────────

export type McpStartupStatus =
  | "starting"
  | "ready"
  | { failed: { error: string } }
  | "cancelled";

export interface McpStartupUpdateEvent {
  server_name: string;
  status: McpStartupStatus;
}

export interface McpStartupFailure {
  server_name: string;
  error: string;
}

export interface McpStartupCompleteEvent {
  ready: string[];
  failed: McpStartupFailure[];
  cancelled: string[];
}

// ─── EventFrame — the core streaming event ───────────────────

export type EventFrame =
  | { event: "response_start"; response_id: string }
  | {
      event: "response_delta";
      response_id: string;
      delta: string;
      channel: ResponseChannel;
    }
  | { event: "response_end"; response_id: string }
  | {
      event: "tool_call_start";
      response_id: string;
      tool_name: string;
      arguments: unknown;
    }
  | {
      event: "tool_call_result";
      response_id: string;
      tool_name: string;
      output: unknown;
    }
  | { event: "mcp_startup_update"; update: McpStartupUpdateEvent }
  | { event: "mcp_startup_complete"; summary: McpStartupCompleteEvent }
  | { event: "mcp_tool_call_begin"; server_name: string; tool_name: string }
  | {
      event: "mcp_tool_call_end";
      server_name: string;
      tool_name: string;
      ok: boolean;
    }
  | { event: "exec_approval_request"; request: ExecApprovalRequestEvent }
  | { event: "apply_patch_approval_request"; request: ExecApprovalRequestEvent }
  | { event: "elicitation_request"; server_name: string; request_id: string; prompt: string }
  | { event: "exec_command_begin"; command: string; cwd: string }
  | { event: "exec_command_output_delta"; command: string; delta: string }
  | { event: "exec_command_end"; command: string; exit_code: number }
  | { event: "patch_apply_begin"; path: string }
  | { event: "patch_apply_end"; path: string; ok: boolean }
  | { event: "turn_started"; turn_id: string }
  | { event: "turn_complete"; turn_id: string }
  | { event: "turn_aborted"; turn_id: string; reason: string }
  | { event: "error"; response_id: string; message: string };

// ─── Approval decision sent back to the server ───────────────

export interface ApprovalDecisionRequest {
  decision: string;
  remember?: boolean;
}

// ─── SSE event envelope from /v1/threads/{id}/events ─────────

export interface SseEventEnvelope {
  seq: number;
  timestamp: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  event: string;
  payload: Record<string, unknown>;
}

// ─── HTTP API types ──────────────────────────────────────────

export interface CreateThreadRequest {
  model?: string;
  workspace?: string;
  mode?: string;
  allow_shell?: boolean;
  trust_mode?: boolean;
  auto_approve?: boolean;
  archived?: boolean;
  system_prompt?: string;
  task_id?: string;
}

export interface ThreadRecord {
  id: string;
  title: string;
  preview: string;
  model: string;
  mode: string;
  archived: boolean;
  workspace: string;
  created_at: string;
  updated_at: string;
  latest_turn_id?: string;
  latest_turn_status?: string;
  task_id?: string;
  path?: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  model: string;
  mode: string;
  archived: boolean;
  updated_at: string;
  latest_turn_id?: string;
  latest_turn_status?: string;
}

export interface UpdateThreadRequest {
  archived?: boolean;
  allow_shell?: boolean;
  trust_mode?: boolean;
  auto_approve?: boolean;
  model?: string;
  mode?: string;
  title?: string;
  system_prompt?: string;
}

export interface StartTurnRequest {
  prompt: string;
  model?: string;
  mode?: string;
}

export interface TurnRecord {
  id: string;
  thread_id: string;
  status: "queued" | "in_progress" | "completed" | "failed" | "interrupted" | "canceled";
  created_at: string;
  started_at?: string;
  ended_at?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    cost_usd: number;
  };
  error_summary?: string;
}

export type TurnItemKind =
  | "user_message"
  | "agent_message"
  | "agent_reasoning"
  | "tool_call"
  | "file_change"
  | "command_execution"
  | "context_compaction"
  | "status"
  | "error";

export interface HealthResponse {
  status: string;
  service: string;
  mode: string;
}

export interface ModelEntry {
  id: string;
  owned_by: string;
}

export type ApprovalMode = "plan" | "agent" | "yolo";
