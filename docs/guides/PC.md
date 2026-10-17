# 电脑控制工具（mcp-pc）

把**本机**（桥接 / DSH / QQ 客户端所在的主机）交给 QQ 会话 agent：截屏看画面、鼠标点击/拖拽/滚动、键盘按键/组合键、输入文本、激活窗口——典型用途是回合制/慢节奏游戏（放置、棋牌、网页游戏）与一般电脑操作。本页讲配置、权限模型与边界；实现见 `src/mcp-pc.js`。

## 更新记录

| 日期 | 变更内容 |
| --- | --- |
| 2026-10-16 | 首版：pc MCP server（9 个工具）、桥接鉴权端点 `/api/pc/auth`、配置项与 preset 说明；记事本输入链路实测通过。 |

## 配置

`config.json` 的 `pc` 段（模板见 `config.example.json`）：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关，默认 `false`。`false` 时 MCP server 只注册 `pc_status`（探测用），所有控制工具不存在 |
| `allowConvKeys` | 允许使用电脑控制的 QQ 会话白名单（`private:QQ号` / `group:群号`）。**留空 = 仅 `private:<ownerQQ>`（管理员私聊）**。电脑比平板更敏感，**不建议**加群 |
| `maxScreenshotBytes` | 单张截屏字节上限，默认 `4000000`；超过拒绝返回 |

改完配置：桥接侧（`enabled` / `allowConvKeys`）**重启桥接**生效；MCP 侧（工具注册）**重启 DSH** 生效。首次接入先跑 `node scripts/setup-dsh.mjs`（把 `mcp-pc` 挂进 DSH profile）再重启 DSH。

## 权限模型（与平板完全同构的两层硬门禁 + 一层命名空间白名单）

1. **注册期**：`pc.enabled !== true` 时，`src/mcp-pc.js` 只注册 `pc_status`，八个控制工具（`pc_screenshot` / `pc_click` / `pc_move` / `pc_drag` / `pc_scroll` / `pc_key` / `pc_text` / `pc_window`）根本不存在。
2. **调用期（每次都鉴权）**：控制工具带 `token`（二代会话令牌）请求桥接 `POST /api/pc/auth`；桥接用令牌反查会话，命中 `pc.allowConvKeys`（默认仅管理员私聊）才放行。群聊会话、伪造/过期令牌、桥接不在线一律拒绝（fail-closed）。
3. **命名空间**：`qq-tool-restrict.mjs` 白名单含 `mcp__pc__`，前提是上面两层门禁存在（`scripts/test-mcp-pc.mjs` 静态断言钉住）。

推论：一代 `chat` / `reserved` 模式没有会话令牌，电脑工具天然不可用；`closed-agent` 模式 owner 本来就有完整本地工具，不依赖这套。

## 实现要点

- **不引入原生 npm 依赖**：键鼠注入用扫描码级 `SendInput`（游戏读 scancode，vk 注入会被很多游戏忽略）、截屏用 GDI+、窗口用 `EnumWindows`/`SetForegroundWindow`——全部经 `powershell.exe` 的 `Add-Type` P/Invoke 完成，npm 树保持纯 JS（README 的「无原生/注入面」属性不变）。
- 每次操作 spawn 一个 powershell（约 1 秒级延迟）；LLM 回合本身数秒，够用。
- 脚本以 UTF-16LE base64 传输（`-EncodedCommand`），外部参数一律走 `param()` 默认值（字符串单引号转义 / base64），不拼接进命令体。
- 文本输入用 `KEYEVENTF_UNICODE` 逐字符注入，支持中文；截屏本地留档 `state/pc-shots/`（保留最近 12 张）。

## 使用边界（重要）

- **网络游戏勿用**：合成键鼠注入可能被反作弊（EAC / BattlEye 等）判定为自动化工具并**封号**。单机、放置、网页游戏没问题。
- **节奏现实**：每步操作 = 截屏 → 模型判断 → 注入，约数秒。回合制/慢节奏可行；实时对抗类（FPS/MOBA）没有可玩性。
- **人机冲突**：管理员正在用电脑时，agent 抢鼠标键盘会打架。preset 已写明：管理员明确要求时才动电脑，动之前说一声要做什么。
- 没有 `pc_run` / 任意命令工具——能力面收敛到上面九个明确动作；启动游戏由管理员自己完成（agent 只操作已打开的窗口）。

## 工具一览

| 工具 | 令牌 | 作用 |
| --- | --- | --- |
| `pc_status` | 不需要 | 探测：功能开关、屏幕分辨率（虚拟屏，含多屏）、当前前台窗口标题 |
| `pc_screenshot` | 需要 | 截全屏（JPEG，多屏合一），图像直接进模型上下文 |
| `pc_click` | 需要 | 鼠标点击（left/right/middle，可双击） |
| `pc_move` | 需要 | 移动鼠标（不点击） |
| `pc_drag` | 需要 | 按住左键拖拽（分段移动模拟真人） |
| `pc_scroll` | 需要 | 滚轮上下滚动 |
| `pc_key` | 需要 | 按键/组合键（`w`、`enter`、`ctrl+s`、`alt+enter`；扫描码注入；`holdMs` 控制按住时长） |
| `pc_text` | 需要 | 向聚焦输入框输入文本（Unicode，支持中文） |
| `pc_window` | 需要 | `list` 列出可见窗口 / `activate` 按标题子串激活（操作游戏前先激活） |

## 回归与验证

- 离线：`npm run test:audit`（含 `scripts/test-mcp-pc.mjs`：权限设计静态断言 + stdio 冒烟 + 无效令牌 fail-closed，**不动真鼠标键盘**）。
- 真机手工验证（2026-10-16 实测通过）：`pc_status` 读到双屏 4754×1440 与前台窗口；`pc_screenshot` 返回 648KB JPEG；打开记事本 → `pc_window activate` → `pc_text` 输入 → 窗口标题变为 `*PC control OK - Notepad`（标题带 `*` 证明输入落地）；群聊令牌被 403。
