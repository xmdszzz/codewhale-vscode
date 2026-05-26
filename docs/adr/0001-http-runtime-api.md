# ADR-0001: 选择 HTTP Runtime API 作为通信协议

**日期：** 2026-05-26

**状态：** 已采纳

## 背景

CodeWhale 后端提供了多种集成模式：

| 协议 | 命令 | 传输 |
|---|---|---|
| App Server | `codewhale app-server --stdio` | stdio JSON-RPC 2.0 |
| ACP Server | `codewhale serve --acp` | stdio JSON-RPC 2.0 (ACP) |
| **HTTP Runtime** | **`codewhale serve --http`** | **HTTP + SSE (localhost:7878)** |
| MCP Server | `codewhale serve --mcp` | stdio MCP |

VSCode 插件需要流式渲染 LLM 响应、展示工具审批对话框、管理 Thread/Turn 生命周期。

## 决策

选择 **HTTP Runtime API** (`codewhale serve --http`)。

## 原因

### App Server (`--stdio`) 能力不足

- `thread/message` 是空占位符，不调用 LLM，不执行工具
- `invoke_tool` 对需要审批的工具立即返回 `{"status":"approval_required"}`，不提供等待审批决定的机制
- 没有流式传输——所有 events 作为批式数组一次性返回

### ACP Server (`--acp`) 同样不足

- 仅 ~500 行，hand-rolled adapter
- 无流式响应：等待 LLM 完整响应后一次性发回
- 无工具调用：prompt 发送给没有 tools 的模型
- 无审批机制
- 无会话持久化

### HTTP Runtime API 功能完整

- **流式渲染**：SSE `item.delta` 事件逐 token 推送
- **审批流程**：`approval.required` SSE 事件 + `POST /v1/approvals/{id}` 双向 handshake
- **Thread 管理**：完整的 CRUD、resume、fork、compact
- **持久化**：Thread/Turn/Item 数据模型，restart 时自动恢复
- **成熟度**：2000+ 行的 runtime_api.rs，完整的协议测试套件（`crates/protocol/tests/`）
- **外部集成设计**：CORS 白名单、auth token、SSE replay/reconnect（seq 机制）

### 权衡：stdio vs HTTP

- **缺点**：需要管理端口分配（每窗口独立进程），需要 CORS 配置
- **优点**：所有功能开箱即用，无需修改任何 Rust 代码

## 影响

- Extension Host 需通过 HTTP + SSE 通信，Webview 不能直连（沙箱隔离），extension 需做 SSE ↔ postMessage 代理
- 每 VSCode 窗口 spawn 独立 `codewhale-tui` 进程，用 `env.sessionId` 哈希映射端口 7878-7978
