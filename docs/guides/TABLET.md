# 鸿蒙平板工具（mcp-tablet）

把一台通过 DevEco Studio / hdc 连接的鸿蒙平板交给 QQ 会话 agent：它可以看到平板屏幕（截图 / 读屏），也能做点击、滑动、按键、输入这些明确动作——典型用途是「刷视频、获取信息」。本页讲配置方法与权限模型；工具实现见 `src/mcp-tablet.js`。

## 更新记录

| 日期 | 变更内容 |
| --- | --- |
| 2026-10-16 | 首版：tablet MCP server（8 个工具）、桥接鉴权端点 `/api/tablet/auth`、配置项与 preset 说明。 |
| 2026-10-16 | 新增 `tablet_open_url`（平板浏览器打开 http(s) 网页），控制工具共 8 个。 |

## 配置

`config.json` 的 `tablet` 段（模板见 `config.example.json`）：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关，默认 `false`。`false` 时 MCP server 只注册 `tablet_status`（探测用），所有控制工具不存在 |
| `hdcPath` | `hdc.exe` 绝对路径。留空时按 PATH → `C:\Program Files\Huawei\DevEco Studio\sdk\<版本>\openharmony\toolchains\hdc.exe` 顺序找；DevEco 装在自定义目录（如本机 `D:\200software\210DEV\DevEco Studio`）时必须显式填 |
| `target` | 目标设备序列号。无线调试填 `IP:端口`（如 `192.168.3.27:36271`），每次调用前会自动 `tconn` 自愈掉线；留空时取唯一在线设备，多台会报错要求指定 |
| `allowConvKeys` | 允许使用平板工具的 QQ 会话白名单（`private:QQ号` / `group:群号`）。**留空 = 仅 `private:<ownerQQ>`（管理员私聊）**；要开放某个群就显式加进去，想全关就设 `enabled: false` |
| `maxScreenshotBytes` | 单张截图字节上限，默认 `4000000`；超过会拒绝返回并提示 |

改完配置：桥接侧（`enabled` / `allowConvKeys`）**重启桥接**生效；MCP 侧（工具注册、`hdcPath`、`target`）**重启 DSH** 生效。首次接入要先跑一遍 `node scripts/setup-dsh.mjs`（把 `mcp-tablet` 挂进 DSH profile）再重启 DSH。

## 权限模型（两层硬门禁 + 一层命名空间白名单）

平板是主人物理设备：截图能看到私人内容，点击/输入能操作任意应用。所以**不是**只靠一个 config 开关：

1. **注册期**：`tablet.enabled !== true` 时，`src/mcp-tablet.js` 只注册 `tablet_status`，七个控制工具（`tablet_screenshot` / `tablet_read_screen` / `tablet_tap` / `tablet_swipe` / `tablet_fling` / `tablet_key` / `tablet_text`）根本不存在——不占 system prompt、不给模型误调的机会。
2. **调用期（每次都鉴权）**：控制工具带 `token` 参数（与 `qq_get_unread_messages` 等 v2 工具同一个【会话令牌】）请求桥接 `POST /api/tablet/auth`；桥接用令牌反查会话，命中 `tablet.allowConvKeys`（默认仅管理员私聊）才放行。群聊会话、伪造/过期令牌、桥接不在线（fail-closed）一律拒绝。
3. **命名空间**：`plugins/qq-agent-presets/qq-tool-restrict.mjs` 的执行期白名单加了 `mcp__tablet__` 前缀——前两层在，这个前缀才敢加；`scripts/test-mcp-tablet.mjs` 用静态断言钉住这层关系。

推论：

- 一代 `chat` / `reserved` 模式没有会话令牌，平板工具天然不可用（preset 里已写明怎么回答）。
- `closed-agent` 模式 owner 本来就有完整本地工具（可直接用 hdc），不依赖这套。
- 想给群聊开：把 `group:群号` 加进 `allowConvKeys`，并清楚这意味着**该群任何人的诱导都可能驱动平板**——建议保持默认只开管理员私聊。

## 工具一览

| 工具 | 令牌 | 作用 |
| --- | --- | --- |
| `tablet_status` | 不需要 | 探测：功能开关、设备在线状态、型号；不在线时给出可操作提示 |
| `tablet_screenshot` | 需要 | 截图，JPEG 图像直接进模型上下文（多模态）；本地留档在 `state/tablet-shots/`（保留最近 12 张） |
| `tablet_read_screen` | 需要 | dumpLayout 压缩成「坐标/文字/可点可滚」的紧凑树（默认 18000 字符上限），适合读屏幕上的文字 |
| `tablet_tap` | 需要 | 点击坐标 |
| `tablet_swipe` | 需要 | (x1,y1)→(x2,y2) 精确滑动，可调速度 |
| `tablet_fling` | 需要 | 按方向快滑：`up`=看下一条、`down`=回上一条、`left`/`right`=翻页（刷视频主力） |
| `tablet_key` | 需要 | Back / Home / Power 或数字键码 |
| `tablet_text` | 需要 | 输入文本（可带坐标点输入框，或输入到已聚焦输入框；中文经 base64 安全透传） |
| `tablet_open_url` | 需要 | 在平板默认浏览器打开 http(s) 网页（`aa start -U`）：能看到**渲染后的页面**与平板上已登录的账号；URL 经单引号转义，`&` 等元字符安全；返回后用截图/读屏看内容、fling 滚动、Back 返回。仅 http/https，其他协议拒绝 |

没有 `tablet_shell` / 任意 hdc 命令工具——能力面收敛到上面这些明确动作（理由见 `src/mcp-tablet.js` 头注释）。

### 网页：平板浏览器 vs web_fetch 的分工

`mcp__web-search-safe__web_fetch` 返回**纯文本正文**，适合查资料、读文章（不动平板、便宜）。`tablet_open_url` 适合三类 web_fetch 做不到的场景：需要**渲染效果**（看页面长什么样/截图给用户）、需要**平板上的登录态**（已登录站点的内容）、页面是 JS 重渲染抓不到正文。preset 里已写明：查资料优先 web_search/web_fetch，需要渲染或登录态才动平板。

## 运维备忘

- **无线调试端口会变**：平板重启或无线调试重开后端口变化，表现为「目标设备不在线」。到 设置→系统→开发者选项→无线调试 查看当前端口，更新 `tablet.target` 即可（MCP 侧改完重启 DSH）。
- **锁屏状态**：平板息屏锁屏后只能读到锁屏界面；刷视频前需要管理员本人解锁。`tablet_key Power` 可亮屏。
- **截图体积**：锁屏壁纸/相册等大图画面 JPEG 可到 2~3 MB，超过 `maxScreenshotBytes` 会被拒；模型侧一般先 Home 回桌面再截。
- 排查顺序：`tablet_status` 的提示 → `hdc list targets`（hdcPath 对不对、设备在不在线）→ 桥接日志里搜 `[tablet]`（鉴权通过/拒绝都有记录，QQ 活动日志同样可见）。

## 回归

- 离线（无需平板）：`npm run test:audit`（含 `scripts/test-mcp-tablet.mjs`：权限设计静态断言 + stdio 冒烟 + 无效令牌 fail-closed）。
- 全部 MCP server 接入冒烟：`npm run test:mcp-servers`。
- 真机端到端：参考本页权限模型手工验证——`tablet_status` 在线、owner 私聊令牌截图成功、群聊令牌被 403。
