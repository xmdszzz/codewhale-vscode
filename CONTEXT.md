# CONTEXT — CodeWhale VSCode Extension

## 项目定位

本插件是 CodeWhale 编码 Agent 的 VSCode 可视化前端。后端通过 `codewhale-tui serve --http` 提供 HTTP/SSE Runtime API。

## 术语表

### codewhale-tui

CodeWhale 的终端原生二进制文件，包含 TUI 引擎和 Runtime HTTP Server。通过 `serve --http` 子命令启动，侦听 `localhost:7878`，提供 REST + SSE 接口。插件通过 `child_process.spawn` 管理其生命周期。

来源：[Hmbown/CodeWhale](https://github.com/Hmbown/CodeWhale/releases)

### Thread

一次编码对话的持久化记录。对应 HTTP API 的 ThreadRecord 实体。一个 Thread 包含多个 Turn。Thread 可存档（archive）、恢复（resume）、分叉（fork）。用户在 VSCode 插件中手动新建 Thread，每个 Thread 独立管理。

### Turn

Thread 内的一轮请求-响应交互。用户发一条 prompt → Agent 产生一个 Turn。Turn 状态：`queued → in_progress → completed|failed|interrupted|canceled`。

### Item

Turn 中的最小粒度单位。类型：`agent_message`（LLM 文本响应）、`agent_reasoning`（思维链）、`tool_call`（通用工具调用）、`file_change`（文件修改）、`command_execution`（Shell 命令执行）。

Item 的 `detail` 字段在 `file_change` 类型中包含标准 unified diff 文本。

### SSE（Server-Sent Events）

HTTP API 通过 `GET /v1/threads/{id}/events?since_seq=N` 推送的实时事件流。每个事件带有全局递增的 `seq` 编号，支持断线重连（从上次收到的 seq 继续）。事件类型：`item.started`、`item.delta`、`item.completed`、`approval.required`、`turn.completed` 等。

### 审批模式

插件提供三种审批模式：

- **Plan** — 只读探索模式。Agent 只能读取文件、搜索代码，不可执行写操作或 Shell 命令
- **Agent** — 交互审批模式（默认）。工具调用需用户逐条确认，审批卡片内嵌在对话流中
- **YOLO** — 全自动模式。所有工具调用自动批准，无需用户交互。对应 HTTP API 的 `auto_approve: true`

### Provider

API 提供商（DeepSeek 等）。用户在设置面板中配置 Provider 的 API Key 和 Base URL。模型列表通过 `codewhale-tui models --json` 从 API 拉取。

### Webview Bridge

VSCode Webview 的沙箱隔离机制意味着 Webview 不能直接发起 HTTP 请求到 localhost。Extension Host 作为代理：
- Webview → postMessage → Extension Host → HTTP/SSE → codewhale-tui
- codewhale-tui → SSE → Extension Host → postMessage → Webview

### 技术栈

- TypeScript 5.x + VSCode Extension API
- React 18（webview），@vscode/webview-ui-toolkit（主题适配）
- esbuild 打包 webview 为单文件，tsc 编译扩展代码
- child_process.spawn 管理 codewhale-tui 进程生命周期
