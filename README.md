# persona-pi-extensions

Rhine 的个人专属 Pi Agent 扩展套件。

## 包含的扩展

1. **`extension-manager`** (`/extension-manager`)
   - 终端全屏 TUI 扩展与包管理器。
   - 集中浏览、搜索扩展与包，查看用途与配置状态。
   - 支持单项启用/禁用暂存、整包开关、差异对比与配置回滚。
   - 修改保存后自动支持热重载（`/reload`）。

2. **`smart-models`** (`/models`, `/m`, `Alt+M`)
   - 智能模型选择与最近使用记录。
   - 按上游供应商分类呈现，支持模糊搜索与快速切换。

3. **`sessions`** (`/sessions`)
   - 双栏历史会话选择器，带实时对话与代码变更预览。
   - 自动过滤子代理（`subagent[...]`）临时会话，界面清爽聚焦。
   - 支持快捷键 `Ctrl+S` / `Alt+S` 一键切换是否显示子代理会话。
   - 支持 `Alt+W` / `Ctrl+T` 切换当前目录与全部工作区会话。

## 安装与使用

在任意已安装 Pi 的机器上：

```bash
pi install git:github.com/rhine9473/persona-pi-extensions
```

## 更新扩展

在终端中执行：

```bash
pi update --extensions
```
