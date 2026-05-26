集成测试操作指南
前置条件

项目: e:\proj\mayin\CodeWhale-vscode
已编译: out/extension.js, out/webview.js, out/harness/*
测试通过: 19/19
Step 1 — 启动 Extension Development Host
在当前 VSCode 窗口中按 F5，或：

Ctrl+Shift+D → 选择 "Run Extension" → 点击绿色播放按钮
这会启动一个新的 VSCode 窗口（Extension Development Host），CodeWhale 扩展自动激活。

Step 2 — 验证下载流程
预期行为（首次启动，没有二进制时）：

右下角出现通知 "Starting CodeWhale..."
下载进度显示 "Downloading binary... XX%"
Chat 面板显示进度条
完成后通知 "CodeWhale ready (port XXXX)"
如果已有二进制（codewhale.binaryPath 已配或 PATH 中有 codewhale-tui）：

直接连接，右上角 ConnectionBadge 绿色 "Connected"
Step 3 — 验证对话流程
步骤	操作	预期结果
3a	点击左侧 CodeWhale 图标 → Chat 面板	显示 "Create a new thread to get started"
3b	点击 New Thread 或侧边栏 + 按钮	创建新 Thread，切换到空对话
3c	输入 prompt 按 Enter	User 气泡出现，Agent 气泡开始流式渲染
3d	观察流式输出	文字逐字出现，光标闪烁动画
Step 4 — 验证审批模式
步骤	操作	预期结果
4a	顶部切换模式 → Plan	发送 prompt 后只读探索，不执行命令
4b	切换 → Agent	工具调用需要审批（出现 ApprovalCard）
4c	点击 Approve	命令继续执行，ToolCard 状态变为 ✓
4d	点击 Deny	命令被拒绝
4e	切换 → YOLO	工具自动批准执行
Step 5 — 验证 Diff 预览
步骤	操作	预期结果
5a	发送 "create a hello.js file"	ToolCard 出现，含文件名
5b	点击 View Diff 按钮	打开 VSCode 内置 diff 编辑器，左右对比
Step 6 — 验证 Thread 管理
步骤	操作	预期结果
6a	侧边栏悬停 Thread → 点击 ✏️	标题处出现内联输入框，输入新名称后 Enter 确认
6b	悬停 Thread → 点击 🗑️	按钮变红变 ❓，再次点击确认删除，对话从列表消失
6c	点击侧边栏不同 Thread	切换对话，显示历史消息
6d	输入栏下方点击 / commands	显示命令菜单，可键盘上下选择
6e	输入栏左侧 📎 按钮	弹出附件菜单：添加文件/文件夹/剪贴板
6f	输入栏底栏 ContextRing	显示上下文用量环，点击可触发 compact
Step 7 — 验证 Provider 配置
步骤	操作	预期结果
7a	点击 ⚙ → Provider Settings	弹出配置面板
7b	输入 Provider/API Key/Base URL → Save	显示绿色 "Saved ✓"
7c	关闭面板 → 重新打开	之前保存的值已恢复
Step 8 — 验证错误恢复
步骤	操作	预期结果
8a	任务管理器 kill codewhale-tui 进程	ConnectionBadge 变红 "Disconnected"
8b	等待数秒	出现 "Reconnecting (attempt N)..." 横幅
8c	重连成功	ConnectionBadge 恢复绿色，对话继续可用
准备好后按 F5 开始第一个验证步骤。