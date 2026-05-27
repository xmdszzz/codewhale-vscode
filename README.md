# CodeWhale VSCode

VSCode extension for **CodeWhale** — an open-source AI coding agent powered by DeepSeek V4 with a 1M-token context window. Chat with the agent, approve or deny tool calls, view diffs, and manage conversations — all inside VSCode.

## Features

- **Chat Interface** — Send prompts and watch the agent's streaming response in real time
- **Approval System** — Three modes: Plan (read-only), Agent (approve each action), YOLO (auto-approve)
- **Diff Preview** — View file changes side-by-side in VSCode's built-in diff editor
- **Thread Management** — Create, rename, search, and delete conversations
- **Context Usage Ring** — Visual token usage indicator with one-click compaction
- **Provider Settings** — Configure API key, base URL, and model provider from the UI
- **Markdown Rendering** — Full syntax support including tables, code blocks, and Mermaid diagrams
- **Auto-Reconnect** — Gracefully recovers from unexpected server exits
- **Binary Auto-Download** — Fetches the codewhale-tui binary from GitHub Releases on first launch

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/) or [GitHub Releases](https://github.com/codewhale/codewhale-vscode/releases)
2. Click the CodeWhale icon in the editor toolbar or run `Ctrl+Shift+L`
3. The binary downloads automatically on first launch
4. Configure your provider in the ⚙ settings panel
5. Start a new conversation and begin coding

## Configuration

| Setting | Description | Default |
|---|---|---|
| `codewhale.binaryVersion` | Pinned version of codewhale-tui to download | `v0.8.44` |
| `codewhale.binaryPath` | Custom path to local binary (skips download) | `""` |
| `codewhale.defaultMode` | Default approval mode: `plan`, `agent`, `yolo` | `agent` |

Provider settings (API key, base URL, provider name) are configured through the ⚙ panel in the chat UI.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` | Open CodeWhale panel |
| `Ctrl+Shift+N` | New conversation |
| `Ctrl+Enter` | Send message (in chat input) |
| `Enter` | Send message |
| `Shift+Enter` | Newline in message |

## Development

```bash
# Install dependencies
npm install

# Build webview (React → out/webview.js)
npm run build:webview

# Compile TypeScript (src → out/)
npm run compile

# Watch mode
npm run watch

# Lint
npm run lint
```

### Project Structure

```
├── assets/             # Extension icon
├── src/
│   ├── extension.ts    # Extension entry point
│   ├── commands/       # Registered VSCode commands
│   ├── harness/        # codewhale-tui process manager, HTTP/SSE client
│   └── webview/
│       ├── provider.ts # Webview ↔ extension message bridge
│       └── panel/
│           └── App.tsx # React chat UI
├── esbuild.config.mjs  # Webview bundler config
├── tsconfig.json       # TypeScript config
└── package.json        # Extension manifest
```

## Requirements

- VS Code `>= 1.90.0`
- [codewhale-tui](https://github.com/codewhale/codewhale-tui) binary (auto-downloaded or provided via `codewhale.binaryPath`)

## License

[MIT](LICENSE)
