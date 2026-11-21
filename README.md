# persona-pi-extensions

Rhine 的个人专属 Pi Agent 扩展套件，按大类与统一前缀整理。

## 目录结构与扩展列表

### 1. 界面 UI / UX 类 (`extensions/ui/pi-ui-*`)

1. **`pi-ui-extension-manager`** (`/extension-manager`)
   - 终端全屏 TUI 扩展与包管理器。
   - 集中浏览、搜索扩展与包，查看用途与配置状态，支持单项/整包开关、差异对比、回滚与热重载。
2. **`pi-ui-smart-models`** (`/models`, `/m`, `Alt+M`)
   - 智能模型选择与最近使用记录，按上游供应商分类呈现，支持模糊搜索与快速切换。
3. **`pi-ui-sessions`** (`/sessions`)
   - 双栏历史会话选择器，带实时对话与代码变更预览，支持 `Ctrl+D` 删除、`Ctrl+B` 切换子代理、`Ctrl+T` 切换工作区。
4. **`pi-ui-turn-time`**
   - 每次回答结束后在底部显示耗时（如 `Worked for 2.3s`）。
5. **`pi-ui-input-fold`**
   - 终端里输入或粘贴大段日志时自动折叠显示，不刷屏。
6. **`pi-ui-image-paste`**
   - Windows 截图粘贴自动折叠为 `[Image #1]` 占位块。

### 2. 实用工具类 (`extensions/tools/pi-tool-*`)

1. **`pi-tool-subagents`** (`/subagents`, `/btw`)
   - 独立上下文子代理调度，支持后台运行、进度监控与结果自动回传，内置多种角色分派。
2. **`pi-tool-bash-timeout`**
   - 为非交互式子任务的 Bash 命令设置 120 秒自动超时，防止命令挂死。

### 3. 通道 / Provider 类 (`extensions/providers/pi-provider-*`)

1. **`pi-provider-antigravity`** (`/agy`)
   - 精简版 Antigravity OAuth Provider（基于 `Rahularya01/pi-antigravity`，MIT 协议）。
   - 支持本地 HTTP 代理 OAuth 登录与刷新、重复 `-tiered` 模型去重、类 Magpie 多账号冷却感知与热切换，以及圆角控制台 `/agy`。

## 安装与更新

```bash
pi install git:github.com/rhine9473/persona-pi-extensions
pi update --extensions
```

## License

MIT — 包含各自独立扩展的上游 MIT 版权声明。
