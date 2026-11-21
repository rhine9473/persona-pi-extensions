# pi-antigravity

精简版 Antigravity OAuth Provider（基于 [Rahularya01/pi-antigravity](https://github.com/Rahularya01/pi-antigravity)，MIT 协议）。

仅保留 Antigravity 模型通道与多账号调度能力，移除 `google_search`、`read_url_content`、`generate_image` 等冗余工具及网页抓取依赖，并重构了交互式终端 UI、多账号冷却感知与无感热切换机制。

## 特性

- **纯正模型通道**：不额外注入搜索、网页抓取或生图工具，零冗余依赖负担。
- **类 Magpie 多账号热切换**：
  - 按模型配额池（`Gemini` / `Argon` / `Claude / GPT`）记录冷却倒计时；
  - 请求前自动跳过冷却中、暂停或失效账号；
  - 请求中遇 `429` 配额耗尽、`401` 失效、`403` 验证/受限或持续拥堵时自动热切到下一个可用账号重试；
  - 支持三种策略：**粘性优先**（默认，保前缀缓存）、**轮询**、**最高余量**。
- **现代终端控制台（`/agy`）**：
  - 圆角透明轮廓 + 顶边嵌入标题，内容最宽 132 列居中自适应（支持 ≥120 / 90–119 / 60–89 / <60 四档布局）；
  - **账号页**：一屏对比所有账号、套餐、状态、轮转开关与半格细配额条，支持内联登录、二次确认解绑、调序、清冷却；
  - **模型页**：合并重复的 `-tiered` 变体（如 `Gemini 4 Hydrogen`），直观选择思考档位；
  - **诊断页**：健康体检 + 快捷修复、设置项调整、近期热切换日志与脱敏诊断复制。
- **代理兼容**：修复 OAuth 登录与刷新在本地 HTTP 代理（不开 TUN）下绕过 `HTTPS_PROXY`/`HTTP_PROXY` 的问题。

## 安装

```bash
pi install git:github.com/rhine9473/pi-antigravity
```

## 命令

- `/agy` — 打开控制台（支持补全 `accounts`、`usage`、`models`、`doctor`、`refresh`、`credits on|off`、`--json`）
- `/antigravity.accounts` — 直接打开账号管理页（兼容 `switch <序号|邮箱>` / `remove <序号|邮箱>`）
- `/antigravity.usage` — 打开账号页并刷新全部账号额度
- `/antigravity.models` — 打开模型与思考档位页
- `/antigravity.doctor` — 打开诊断与设置页
- `/antigravity.credits [on|off]` — 开关 AI 积分超额兜底
- `/antigravity.refresh` — 强制同步模型目录

## 风险说明

> 本扩展通过官方客户端 OAuth 接口直接通信，非官方授权集成。消费级账号使用第三方 Harness 访问 Antigravity 接口存在服务条款风险（参见上游 [#154](https://github.com/Rahularya01/pi-antigravity/issues/154)），请自行评估风险后使用。

## License

MIT — 保留上游作者 Rahul Arya 版权声明及个人修改部分，详见 [LICENSE](LICENSE)。
