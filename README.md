# rhine-pi-extensions

一套面向 [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 的增强扩展套件，涵盖 **半透明圆角 TUI 美化**、**独立子代理与超时工具** 以及 **Antigravity 多账号容灾通道**。

所有扩展均可通过内置的 `/extension-manager` **按需单项开关**，不必全盘照单全收。

<!-- 建议后续补充 2~3 张终端截图放到 docs/images/，视觉吸引力会更好 -->
<!-- ![TUI Preview](./docs/images/preview.png) -->

---

## 快速开始

### 1. 零配置先试玩（不写入全局配置）

```bash
pi -e git:github.com/rhine9473/rhine-pi-extensions
```

### 2. 正式安装与更新

```bash
# 安装
pi install git:github.com/rhine9473/rhine-pi-extensions

# 更新
pi update --extensions
```

> 💡 **只想要其中某几个扩展？**
> 安装后在 Pi 里运行 `/extension-manager`，用空格即可单独关闭不需要的扩展并热重载生效；也可以直接在 `settings.json` 中通过 Pi 包资源过滤语法按需引入。

---

## 扩展清单

### 1. 界面与交互增强 (`extensions/ui/pi-ui-*`)

| 扩展 | 命令 / 快捷键 | 功能说明 | 备注 |
| :--- | :--- | :--- | :--- |
| **`pi-ui-tool-fold`** | `Ctrl+O` 展开 | 将单轮多个工具调用折叠为 1px 圆角摘要框（含状态、关键目标、耗时与真实报错行） | 终端透明背景友好 |
| **`pi-ui-user-card`** | 自动生效 | 将用户消息实心底条替换为半透明 1px 圆角卡片（`╭─ ❯ ─╮`），透出终端亚克力/毛玻璃效果 | 支持 OSC 133 与长文本折叠 |
| **`pi-ui-extension-manager`** | `/extension-manager` | 全屏 TUI 扩展与包管理器：浏览说明、按作者分组、单项/整包开关、保存前 diff 预览与热重载 | — |
| **`pi-ui-smart-models`** | `/models` · `/m` · `Alt+M` | 按供应商分类的智能模型选择器，支持模糊搜索、最近使用与**按模型记忆思考强度** | — |
| **`pi-ui-sessions`** | `/sessions` | 双栏历史会话选择器，实时预览对话与代码变更（`Ctrl+D` 删除 / `Ctrl+B` 子代理 / `Ctrl+T` 工作区） | — |
| **`pi-ui-turn-time`** | 自动生效 | 每次回答结束后在底部显示极简分隔耗时线（如 `── ✓ 耗时 2s ────`） | — |
| **`pi-ui-input-fold`** | 自动生效 | 粘贴或输入大段长日志时自动折叠显示，避免刷屏 | — |
| **`pi-ui-image-paste`** | `Ctrl+V` | Windows 下截图粘贴自动折叠为 `[Image #1]` 占位块并支持直接读图 | 主要面向 Windows |

### 2. 工具与子代理 (`extensions/tools/pi-tool-*`)

| 扩展 | 命令 | 功能说明 |
| :--- | :--- | :--- |
| **`pi-tool-subagents`** | `/subagents` · `/btw` | 独立上下文子代理调度与后台并发执行，支持 `worktree` 隔离、进度监控与结果自动回传（附带 `subagents` skill） |
| **`pi-tool-bash-timeout`** | 自动生效 | 为非交互式子任务的 Bash 命令增加 120 秒自动超时兜底，防止进程挂死 |

### 3. 模型通道 (`extensions/providers/pi-provider-*`)

| 扩展 | 命令 | 功能说明 |
| :--- | :--- | :--- |
| **`pi-provider-antigravity`** | `/agy` | 精简版 Antigravity OAuth Provider：支持本地 HTTP 代理登录与刷新、`-tiered` 模型去重、多账号 5h/7d 冷却感知与热切换，以及圆角控制台 `/agy` |

---

## 环境要求与开发测试

- **运行时**：Pi Coding Agent（需支持 `pi-package` 扩展清单）
- **本地验证**：
  ```bash
  npm test
  ```

## Credits & License

- 基于 **MIT** 协议开源。
- 部分扩展在 [`Rahularya01/pi-antigravity`](https://github.com/Rahularya01/pi-antigravity) 等开源项目（MIT）基础上做了精简与重构，特此致谢。
