# Changelog

## 0.1.2 — 2026-05-27

### Added
- Cancel/Stop button during AI generation (uses `POST /v1/threads/{id}/turns/{turnId}/interrupt`)
- Fork from here — hover agent message → "⋯" menu → fork conversation
- Auto-create thread on send: typing in empty state and pressing Send auto-creates a new thread
- Color-coded mode badges (Plan=blue, Agent=green, YOLO=red) in header, input, and sidebar

### Fixed
- Delete thread: removed broken two-click confirmation (React closure stale state caused infinite retry loop)
- Delete thread now removes item from sidebar instantly (optimistic UI)
- Markdown headings: all 6 levels (h1–h6) now render properly
- Per-project chat history: threads filtered by current workspace
- Global config persistence: API key/base URL survive workspace switches
- Compaction UX: spinner animation, locked input during compaction

### Removed
- Auto-compact feature (backend incompatibility)
- Rewind code / Fork+Rewind (no backend REST endpoint)

## 0.1.0 — 2026-05-26

### Added
- Chat panel with React-based UI for CodeWhale AI coding agent
- SSE streaming support for real-time agent output
- Thread management: create, rename, delete conversations
- Approval system: Plan / Agent / YOLO modes with inline approval cards
- Markdown rendering with full syntax support (tables, code blocks, etc.)
- Diff preview via VSCode built-in diff editor
- Context usage ring with compact/compaction capability
- Provider settings panel (API key, base URL, model selection)
- Auto-download of codewhale-tui binary from GitHub Releases
- Auto-reconnect on unexpected server exit
- Status bar entry and editor/title menu contribution
- Conversation sidebar with search and hover actions
- Two-click delete confirmation for thread safety
- Slash command menu and file attachment support

### Technical
- HTTP/SSE client for codewhale-tui serve --http
- Subprocess lifecycle manager with health-check and port allocation
- Environment variable injection for provider configuration
- CSS-based hover effects for all interactive buttons
- Persistent delete tracking via VSCode globalState
- TypeScript 5.5 + React 19 + esbuild toolchain
