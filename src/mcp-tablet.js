// 鸿蒙平板查看/操作 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 工具（serverName: tablet，注册期按 tablet.enabled 过滤，未启用时只注册 tablet_status）：
//   tablet_status       —— 只读探测：功能开关、目标设备是否在线、设备型号（不需要会话令牌）
//   tablet_screenshot   —— 截图，图像直接进入模型上下文（需要 token）
//   tablet_read_screen  —— 读屏幕：可见文字/可点元素的紧凑 UI 树（需要 token）
//   tablet_tap          —— 点击坐标（需要 token）
//   tablet_swipe        —— 从 (x1,y1) 滑到 (x2,y2)（需要 token）
//   tablet_fling        —— 按方向快滑 up/down/left/right（刷视频/翻列表用）（需要 token）
//   tablet_key          —— 按键 Back/Home/Power 或键码（需要 token）
//   tablet_text         —— 输入文本（可指定坐标，或输入到已聚焦输入框）（需要 token）
//   tablet_open_url     —— 在平板默认浏览器打开 http(s) 网页（需要 token）
//
// ── 权限设计（与 mcp-snowluma-safe 的 v2 工具同一套会话令牌）──────────────────
//
// 平板是主人物理设备：截图可能看到私人内容、点击/输入能操作任意应用。因此这里
// **不是**只靠 config 开关，而是每次控制类调用都先到桥接的 POST /api/tablet/auth 鉴权：
//   会话令牌（token 参数，同 qq_get_unread_messages 等工具）→ 桥接反查会话 key →
//   命中 tablet.allowConvKeys（默认仅 `private:<ownerQQ>` 管理员私聊）才放行。
// 群聊会话、无令牌调用、桥接不在线（fail-closed）一律拒绝。
// 一代 chat/reserved 模式没有会话令牌，这些工具在那两个模式下自然不可用；
// closed-agent 模式 owner 本来就有完整本地工具（可直接用 hdc），不依赖本 server。
//
// ── 为什么没有 tablet_shell / 任意 hdc 命令工具 ─────────────────────────────
//
// 与 mcp-host-server.js「不代装、不代启 SnowLuma」同一思路：能力面收敛到上面九个
// 明确动作。任意 shell 等于把整台设备（含 settings、文件系统）交给模型，超出
// 「看屏幕 + 刷视频/查信息」的需求范围，也会让 RULES.md 的边界承诺失效。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(ROOT, 'state', 'tablet-shots');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function tabletConfig() {
  return loadConfig().tablet ?? {};
}

function tabletEnabled() {
  return tabletConfig().enabled === true;
}

// ── hdc 定位：配置显式路径 → PATH → DevEco Studio 默认安装位置 ───────────────
// 每次调用重新解析（不缓存）：改了 config.json 下一次工具调用即生效。
function findHdc() {
  const configured = String(tabletConfig().hdcPath ?? '').trim();
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    throw new Error(`tablet.hdcPath 指向的文件不存在：${configured}（请改填 DevEco Studio 的 sdk/<版本>/openharmony/toolchains/hdc.exe）`);
  }
  const roots = [...new Set([
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
  ].filter(Boolean))];
  for (const root of roots) {
    const sdkDir = path.join(root, 'Huawei', 'DevEco Studio', 'sdk');
    let versions = [];
    try {
      versions = fs.readdirSync(sdkDir).filter((d) => {
        try { return fs.statSync(path.join(sdkDir, d)).isDirectory(); } catch { return false; }
      }).sort().reverse();
    } catch { continue; }
    for (const v of versions) {
      const candidate = path.join(sdkDir, v, 'openharmony', 'toolchains', 'hdc.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // 交给 PATH 兜底（spawn 时若不存在会在结果里给出明确报错）
  return 'hdc';
}

// 串行执行：hdc server 对同一目标的并发调用偶发拒绝，工具调用频率也不高，
// 排队比加锁重试简单可靠。
let hdcChain = Promise.resolve();
function runHdc(args, timeoutMs = 15000) {
  const exec = () => new Promise((resolve) => {
    let hdcPath;
    try { hdcPath = findHdc(); } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let child;
    try {
      child = spawn(hdcPath, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: stdout.trim(), stderr: `无法启动 hdc（${hdcPath}）：${error?.message ?? error}；可在 config.json 的 tablet.hdcPath 填绝对路径` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
  const run = hdcChain.then(exec, exec);
  hdcChain = run.catch(() => {});
  return run;
}

function failSniff(res) {
  const text = `${res.stdout}\n${res.stderr}`;
  if (/\[Fail\]|failed|Error opening|No such file/i.test(text) && !/No Error/i.test(res.stdout)) {
    throw new Error(text.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ') || 'hdc 命令失败');
  }
  return res;
}

const HOST_PORT_RE = /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/;

// 解析目标设备：配置了 tablet.target 就先 tconn（无线连接掉线自愈），否则取唯一在线设备。
async function resolveTarget() {
  const target = String(tabletConfig().target ?? '').trim();
  if (target && HOST_PORT_RE.test(target)) {
    await runHdc(['tconn', target], 8000); // 幂等；失败不拦截，下面用在线列表给出准确报错
  }
  const res = await runHdc(['list', 'targets'], 8000);
  const lines = res.stdout.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && s !== '[Empty]' && !/^IO /.test(s));
  if (target) {
    if (!lines.includes(target)) {
      throw new Error(`目标设备 ${target} 不在线。无线调试的端口在平板重启/重开后会变：到 设置→系统→开发者选项→无线调试 查看当前端口，更新 config.json 的 tablet.target`);
    }
    return target;
  }
  if (!lines.length) {
    throw new Error('没有在线的鸿蒙设备（hdc list targets 为空）。平板需开启开发者选项，并完成无线调试配对/USB 连接');
  }
  if (lines.length > 1) {
    throw new Error(`检测到多台设备（${lines.join('、')}）：请在 config.json 的 tablet.target 指定其中一台`);
  }
  return lines[0];
}

// 一次工具调用内复用同一目标：target 解析一次，后续 hdc 命令都带 -t。
async function withDevice(fn) {
  const target = await resolveTarget();
  const hdc = (args, timeoutMs) => runHdc(['-t', target, ...args], timeoutMs);
  return fn(target, hdc);
}

async function shellOn(hdc, args, timeoutMs = 20000) {
  return failSniff(await hdc(['shell', ...args], timeoutMs));
}

// ── 桥接鉴权：会话令牌 → /api/tablet/auth → 是否允许操作平板 ────────────────
function readConsoleToken() {
  // 与 mcp-snowluma-safe.js 相同：每次重读，config 优先，其次 state/console-token。
  try {
    const token = loadConfig().consoleToken;
    if (token) return String(token);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function authorizeTablet(token) {
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const headers = {
    'content-type': 'application/json',
    'x-agent-call': '1',
    ...(readConsoleToken() ? { 'x-console-token': readConsoleToken() } : {}),
    ...(token ? { 'x-agent-token': token } : {}),
  };
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/tablet/auth`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: String(token ?? ''), action: 'control' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`桥接进程不可达，平板工具拒绝执行（fail-closed）：${error?.message ?? error}`);
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error || `平板工具鉴权失败（HTTP ${res.status}）`);
  }
  return body;
}

// 鉴权失败/设备错误的统一出口：isError + 可操作提示，模型能据此向管理员说明。
function toolError(error) {
  return {
    content: [{ type: 'text', text: `平板操作失败：${error?.message ?? error}` }],
    isError: true,
  };
}

// ── 设备动作实现 ─────────────────────────────────────────────────────────────
function pruneShots(keep = 12) {
  try {
    const files = fs.readdirSync(SHOTS_DIR)
      .filter((f) => f.startsWith('shot-'))
      .sort()
      .slice(0, -keep);
    for (const f of files) fs.rmSync(path.join(SHOTS_DIR, f), { force: true });
  } catch {}
}

async function captureScreenshot() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const remote = `/data/local/tmp/qqbridge-shot-${stamp}.jpeg`;
  const maxBytes = Number(tabletConfig().maxScreenshotBytes ?? 4_000_000);
  const result = await withDevice(async (target, hdc) => {
    await shellOn(hdc, ['uitest', 'screenCap', '-p', remote], 25000);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const local = path.join(SHOTS_DIR, `shot-${stamp}.jpeg`);
    failSniff(await hdc(['file', 'recv', remote, local], 30000));
    void hdc(['shell', 'rm', '-f', remote], 8000).catch(() => {});
    const buf = fs.readFileSync(local);
    return { target, local, buf, maxBytes };
  });
  if (result.buf.length > result.maxBytes) {
    throw new Error(`截图 ${(result.buf.length / 1024 / 1024).toFixed(1)}MB 超过上限（tablet.maxScreenshotBytes=${result.maxBytes}）：换个画面（如先 Home 回桌面）再截，或调大上限`);
  }
  pruneShots();
  return {
    content: [
      { type: 'image', data: result.buf.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'text', text: JSON.stringify({ file: path.basename(result.local), bytes: result.buf.length, target: result.target }) },
    ],
  };
}

// bounds "[x1,y1][x2,y2]" → [x1,y1,x2,y2]
function parseBounds(bounds) {
  const m = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(String(bounds ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

// dumpLayout 的 JSON 太大（实测 200KB+），压成「每行一个有意义节点」的缩进树。
// 有意义 = 有文字/id/描述，或可点/可滚/可长按/可选中有状态，或是窗口根（带 abilityName）。
function condenseLayout(root, maxChars) {
  const lines = [];
  let truncated = false;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return;
    if (lines.join('\n').length > maxChars) { truncated = true; return; }
    const a = node.attributes ?? {};
    const rect = parseBounds(a.bounds);
    const flags = [
      a.clickable === 'true' ? '可点' : '',
      a.scrollable === 'true' ? '可滚' : '',
      a.longClickable === 'true' ? '长按' : '',
      a.selected === 'true' ? '选中' : '',
      a.checked === 'true' ? '勾选' : '',
      a.focused === 'true' ? '聚焦' : '',
    ].filter(Boolean).join(',');
    const bits = [
      a.text ? `text="${String(a.text).slice(0, 120)}"` : '',
      a.id ? `id=${a.id}` : '',
      a.description ? `desc="${String(a.description).slice(0, 60)}"` : '',
      !a.text && !a.id && a.type ? `type=${a.type}` : '',
    ].filter(Boolean).join(' ');
    if (a.abilityName) {
      lines.push(`${'  '.repeat(depth)}◇ 窗口 ${a.abilityName}${rect ? ` [${rect.join(',')}]` : ''}`);
    }
    if (bits || flags) {
      lines.push(`${'  '.repeat(depth)}[${rect ? rect.join(',') : '?'}]${flags ? ` <${flags}>` : ''} ${bits}`.trim().slice(0, 240));
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? `${text}\n…（已截断：元素过多。可用 tablet_screenshot 看整体，或缩小关注区域）` : text;
}

async function readScreen(maxChars) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const remote = `/data/local/tmp/qqbridge-layout-${stamp}.json`;
  const local = path.join(SHOTS_DIR, `layout-${stamp}.json`);
  const text = await withDevice(async (_target, hdc) => {
    try {
      await shellOn(hdc, ['uitest', 'dumpLayout', '-p', remote], 25000);
      failSniff(await hdc(['file', 'recv', remote, local], 20000));
      const root = JSON.parse(fs.readFileSync(local, 'utf8'));
      return condenseLayout(root, maxChars);
    } finally {
      fs.rmSync(local, { force: true });
      void hdc(['shell', 'rm', '-f', remote], 8000).catch(() => {});
    }
  });
  return { content: [{ type: 'text', text }] };
}

// 中文/特殊字符走设备 shell 内的 base64 解码（与 devecocli 同款做法），
// 避免文本里的空格/引号/换行把 hdc shell 参数拆坏。
function shellSafeText(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  return `$(printf '%s' '${b64}' | base64 -d)`;
}

// hdc 会把 argv 用空格拼成一条命令交给设备 shell 再解析，所以含 & ? 空格 等
// shell 元字符的参数（典型：带查询串的 URL）必须自己包一层单引号。
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

const DIR_NUM = { left: 0, right: 1, up: 2, down: 3 };
const intArg = (name, max = 30000) => z.number().int().min(0).max(max).describe(name);
const tokenSchema = z.string().describe('会话令牌（提示中的【会话令牌】，与管理员私聊/授权会话对应）');

const server = new McpServer({ name: 'tablet', version: '0.2.0-r3' });

server.tool(
  'tablet_status',
  '探测鸿蒙平板是否可用（只读）：功能开关、目标设备在线状态、设备型号。不需要会话令牌。其余 tablet_* 工具需要会话令牌，且仅管理员授权的会话（默认管理员私聊）可通过。',
  {},
  async () => {
    try {
      const cfg = tabletConfig();
      if (!tabletEnabled()) {
        return { content: [{ type: 'text', text: JSON.stringify({ enabled: false, hint: '平板工具未启用：在 config.json 设置 tablet.enabled=true 并填 tablet.target 后重启 DSH' }, null, 2) }] };
      }
      const info = { enabled: true, target: cfg.target || '(自动选择唯一在线设备)' };
      try {
        const target = await resolveTarget();
        info.online = true;
        info.target = target;
        const model = await withDevice(async (_t, hdc) => ({
          model: (await shellOn(hdc, ['param', 'get', 'const.product.model'], 10000)).stdout,
          name: (await shellOn(hdc, ['param', 'get', 'const.product.name'], 10000)).stdout,
        }));
        info.device = model;
      } catch (error) {
        info.online = false;
        info.hint = String(error?.message ?? error);
      }
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    } catch (error) {
      return toolError(error);
    }
  }
);

// 控制类工具只在启用时注册（注册期过滤，理由同 mcp-snowluma-safe.js 的
// TOOL_CONFIG_FLAGS：关着还注册 = 白占每次请求的 system prompt 并诱导误调）。
if (tabletEnabled()) {
  server.tool(
    'tablet_screenshot',
    '截取鸿蒙平板当前屏幕，图像直接进入上下文（配合 tablet_read_screen 可同时拿到文字）。需要会话令牌；仅管理员授权的会话可用。',
    { token: tokenSchema },
    async ({ token }) => {
      try {
        await authorizeTablet(token);
        return await captureScreenshot();
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'tablet_read_screen',
    '读取鸿蒙平板屏幕上当前可见的界面结构：每行一个元素的坐标/文字/是否可点可滚，适合获取屏幕上的文字信息（视频标题、评论、设置项等）。返回较大时会被截断。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      maxChars: z.number().int().min(2000).max(40000).optional().describe('返回文本上限（字符），默认 18000'),
    },
    async ({ token, maxChars }) => {
      try {
        await authorizeTablet(token);
        return await readScreen(Math.min(maxChars ?? 18000, 40000));
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'tablet_tap',
    '点击鸿蒙平板屏幕上的坐标。坐标可从 tablet_read_screen 的 [x1,y1,x2,y2] 或 tablet_screenshot 中取（点元素中心）。需要会话令牌；仅管理员授权的会话可用。',
    { token: tokenSchema, x: intArg('横坐标（像素）'), y: intArg('纵坐标（像素）') },
    async ({ token, x, y }) => {
      try {
        await authorizeTablet(token);
        await withDevice(async (_t, hdc) => shellOn(hdc, ['uitest', 'uiInput', 'click', String(x), String(y)]));
        return { content: [{ type: 'text', text: `已点击 (${x},${y})` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'tablet_swipe',
    '在鸿蒙平板上从 (x1,y1) 滑动到 (x2,y2)（慢速精确滑动，如拖动进度条、移动图标）。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      x1: intArg('起点横坐标'), y1: intArg('起点纵坐标'),
      x2: intArg('终点横坐标'), y2: intArg('终点纵坐标'),
      speedPxPerS: z.number().int().min(200).max(40000).optional().describe('滑动速度（像素/秒，200~40000，默认 600，越小越慢）'),
    },
    async ({ token, x1, y1, x2, y2, speedPxPerS }) => {
      try {
        await authorizeTablet(token);
        const args = ['uitest', 'uiInput', 'swipe', String(x1), String(y1), String(x2), String(y2)];
        if (speedPxPerS !== undefined) args.push(String(speedPxPerS));
        await withDevice(async (_t, hdc) => shellOn(hdc, args));
        return { content: [{ type: 'text', text: `已滑动 (${x1},${y1})→(${x2},${y2})` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'tablet_fling',
    '在鸿蒙平板上按方向快滑（系统默认速度，适合翻页/刷视频/滚列表）：up=手指向上滑（看下一条/向下滚动），down=向下滑（回看上一条），left/right=横向翻页。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      direction: z.enum(['up', 'down', 'left', 'right']).describe('手指滑动方向：up=看下一条，down=回上一条'),
    },
    async ({ token, direction }) => {
      try {
        await authorizeTablet(token);
        await withDevice(async (_t, hdc) => shellOn(hdc, ['uitest', 'uiInput', 'dircFling', String(DIR_NUM[direction])]));
        return { content: [{ type: 'text', text: `已向 ${direction} 快滑` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'tablet_key',
    '按鸿蒙平板的按键：Back（返回）、Home（回桌面）、Power（电源）或数字键码。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      key: z.string().regex(/^(Back|Home|Power|\d{1,5})$/).describe('Back / Home / Power 或数字键码'),
    },
    async ({ token, key }) => {
      try {
        await authorizeTablet(token);
        await withDevice(async (_t, hdc) => shellOn(hdc, ['uitest', 'uiInput', 'keyEvent', key]));
        return { content: [{ type: 'text', text: `已按 ${key}` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'tablet_open_url',
    '在鸿蒙平板的默认浏览器里打开一个 http(s) 网页（能用平板上已登录的账号看到渲染后的页面）。看内容用 tablet_screenshot 截图 / tablet_read_screen 读文字，tablet_fling 滚动页面，tablet_key Back 返回。仅允许 http/https。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      url: z.string().min(1).max(800).describe('要打开的 http(s) 网址'),
    },
    async ({ token, url }) => {
      try {
        await authorizeTablet(token);
        let parsed;
        try { parsed = new URL(String(url)); } catch { throw new Error('网址格式无效'); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`仅允许 http/https 网址（收到 ${parsed.protocol}//）`);
        }
        const res = await withDevice(async (_t, hdc) => shellOn(hdc, ['aa', 'start', '-U', shellQuote(String(url))]));
        // aa start 成功输出 "start ability successfully."；失败只打 "error: ..."，
        // 不在 failSniff 的通配里，这里显式核对。
        if (!/successfully/i.test(res.stdout)) {
          throw new Error(`打开失败：${(res.stdout || res.stderr || '无输出').split(/\r?\n/)[0]}`);
        }
        return { content: [{ type: 'text', text: `已在平板浏览器打开：${String(url)}` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'tablet_text',
    '向鸿蒙平板输入文本（最多 500 字符）。给 x/y 时先点击该坐标处的输入框再输入；不给则输入到当前已聚焦的输入框。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      text: z.string().min(1).max(500).describe('要输入的文本'),
      x: intArg('输入框横坐标（可选，不给则输入到已聚焦输入框）').optional(),
      y: intArg('输入框纵坐标（与 x 一起给）').optional(),
    },
    async ({ token, text, x, y }) => {
      try {
        await authorizeTablet(token);
        const enc = shellSafeText(text);
        const args = (x !== undefined && y !== undefined)
          ? ['uitest', 'uiInput', 'inputText', String(x), String(y), enc]
          : ['uitest', 'uiInput', 'text', enc];
        await withDevice(async (_t, hdc) => shellOn(hdc, args));
        return { content: [{ type: 'text', text: '已输入文本' }] };
      } catch (error) { return toolError(error); }
    }
  );
}

await server.connect(new StdioServerTransport());
