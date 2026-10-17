// 电脑（本机）查看/操作 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 工具（serverName: pc，注册期按 pc.enabled 过滤，未启用时只注册 pc_status）：
//   pc_status      —— 只读探测：功能开关、屏幕分辨率、前台窗口标题（不需要会话令牌）
//   pc_screenshot  —— 截屏，JPEG 图像直接进入模型上下文（需要 token）
//   pc_click       —— 鼠标点击（左/右/中，可双击）（需要 token）
//   pc_move        —— 移动鼠标到坐标（需要 token）
//   pc_drag        —— 按住左键从 (x1,y1) 拖到 (x2,y2)（需要 token）
//   pc_scroll      —— 滚轮上下滚动（需要 token）
//   pc_key         —— 按键/组合键（扫描码注入，游戏可识别）（需要 token）
//   pc_text        —— 输入文本（Unicode 注入，支持中文）（需要 token）
//   pc_window      —— 列出可见窗口 / 按标题激活窗口（需要 token）
//
// ── 权限设计（与 mcp-tablet 完全同构的两层硬门禁）────────────────────────────
//
// 电脑是本机、是桥接/DSH/QQ 客户端所在的主机——比平板更敏感。因此：
//   ① 注册期：config.json pc.enabled !== true 时控制工具根本不注册；
//   ② 调用期：每次调用先过桥接 POST /api/pc/auth（会话令牌 → 会话 →
//      pc.allowConvKeys，默认仅 private:<ownerQQ> 管理员私聊）。
// 群聊会话、无令牌调用、桥接不在线（fail-closed）一律拒绝。
//
// ── 实现约束：不引入原生 npm 依赖 ───────────────────────────────────────────
// 本仓库的安全属性之一是「依赖全为纯 JS、无 .node/FFI」（README 合规说明）。
// 键鼠注入用扫描码级 SendInput、截屏用 GDI+，全部经 powershell.exe 的
// Add-Type P/Invoke 完成——依赖系统自带组件，npm 树保持纯 JS。
// 每次操作 spawn 一个 powershell（约 1 秒级延迟）：LLM 回合本身数秒，够用；
// 不做常驻注入进程（复杂且更容易出安全纰漏）。
//
// ⚠️ 反作弊：合成键鼠注入可能被网游反作弊（EAC/BattlEye 等）判定为自动化工具
// 并封号。工具描述与 preset 已写明：只用于单机/允许自动化的场景，网游勿用。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(ROOT, 'state', 'pc-shots');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function pcConfig() {
  return loadConfig().pc ?? {};
}

function pcEnabled() {
  return pcConfig().enabled === true;
}

// ── PowerShell 执行：脚本以 UTF-16LE base64 传输（-EncodedCommand），参数走
// param() 默认值（数字/布尔由 JS 字面量生成，字符串单引号转义），杜绝拼接注入。
let psChain = Promise.resolve();
function runPowerShell(script, timeoutMs = 20000) {
  const exec = () => new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: `无法启动 powershell.exe：${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
  const run = psChain.then(exec, exec);
  psChain = run.catch(() => {});
  return run;
}

const psStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── C# 注入内核：扫描码 SendInput（游戏读 scancode，vk 注入会被很多游戏忽略）。
const CS_HELPER = `
using System;
using System.Runtime.InteropServices;
public static class Pc {
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  const uint KEYUP = 0x0002, SCANCODE = 0x0008, UNICODE = 0x0004;
  const uint LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040, WHEELF = 0x0800;
  static INPUT Key(ushort scan, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wScan = scan;
    i.u.ki.dwFlags = SCANCODE | (up ? KEYUP : 0);
    return i;
  }
  static INPUT Mouse(uint flags, int data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = (uint)data;
    return i;
  }
  static INPUT Uni(char c, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wScan = c;
    i.u.ki.dwFlags = UNICODE | (up ? KEYUP : 0);
    return i;
  }
  public static void MoveTo(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(30); }
  public static void Click(string button, bool dbl) {
    uint d = button == "right" ? RDOWN : button == "middle" ? MDOWN : LDOWN;
    uint u = button == "right" ? RUP : button == "middle" ? MUP : LUP;
    int times = dbl ? 2 : 1;
    for (int t = 0; t < times; t++) {
      SendInput(2, new INPUT[]{ Mouse(d,0), Mouse(u,0) }, Marshal.SizeOf(typeof(INPUT)));
      if (t + 1 < times) System.Threading.Thread.Sleep(60);
    }
  }
  public static void Scroll(bool down, int delta) {
    SendInput(1, new INPUT[]{ Mouse(WHEELF, down ? -delta : delta) }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void KeyCombo(int[] scans, int holdMs) {
    var list = new System.Collections.Generic.List<INPUT>();
    foreach (int s in scans) list.Add(Key((ushort)s, false));
    System.Threading.Thread.Sleep(holdMs < 0 ? 0 : (holdMs > 5000 ? 5000 : holdMs));
    for (int i = scans.Length - 1; i >= 0; i--) list.Add(Key((ushort)scans[i], true));
    SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
  public static void TypeText(string text) {
    var list = new System.Collections.Generic.List<INPUT>();
    foreach (char c in text) { list.Add(Uni(c, false)); list.Add(Uni(c, true)); }
    SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Drag(int x, int y) {
    // 分段移动更像真人拖拽，也给目标应用时间跟随重绘
    SendInput(1, new INPUT[]{ Mouse(LDOWN, 0) }, Marshal.SizeOf(typeof(INPUT)));
    POINT p; GetCursorPos(out p);
    const int steps = 12;
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(p.x + (x - p.x) * i / steps, p.y + (y - p.y) * i / steps);
      System.Threading.Thread.Sleep(12);
    }
    SendInput(1, new INPUT[]{ Mouse(LUP, 0) }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static string Cursor() { POINT p; GetCursorPos(out p); return p.x + "," + p.y; }
}`;

function withHelper(body) {
  return `$cs = @'
${CS_HELPER}
'@
Add-Type -TypeDefinition $cs -Language CSharp
${body}`;
}

// 键名 → 扫描码（set 1）。字母/数字直接用单字符；未知键名在 JS 层报错。
const SCAN_CODES = {
  esc: 0x01, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0A, '0': 0x0B,
  minus: 0x0C, equal: 0x0D, backspace: 0x0E, tab: 0x0F, q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19,
  lbracket: 0x1A, rbracket: 0x1B, enter: 0x1C, ctrl: 0x1D, a: 0x1E, s: 0x1F, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26,
  semicolon: 0x27, quote: 0x28, backtick: 0x29, lshift: 0x2A, backslash: 0x2B, z: 0x2C, x: 0x2D, c: 0x2E, v: 0x2F, b: 0x30, n: 0x31, m: 0x32,
  comma: 0x33, period: 0x34, slash: 0x35, rshift: 0x36, numpadstar: 0x37, alt: 0x38, space: 0x39, capslock: 0x3A,
  f1: 0x3B, f2: 0x3C, f3: 0x3D, f4: 0x3E, f5: 0x3F, f6: 0x40, f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
  numlock: 0x45, scrolllock: 0x46, home: 0x47, up: 0x48, pgup: 0x49, left: 0x4B, right: 0x4D, end: 0x4F, down: 0x50, pgdn: 0x51,
  insert: 0x52, delete: 0x53, win: 0xDB,
};

function parseKeyCombo(spec) {
  const parts = String(spec).split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('按键不能为空');
  return parts.map((token) => {
    const code = SCAN_CODES[String(token).toLowerCase()];
    if (!code) {
      throw new Error(`未知按键「${token}」。支持单字符字母/数字，以及：${Object.keys(SCAN_CODES).filter((k) => k.length > 1).join(' ')}`);
    }
    return code;
  });
}

// ── 桥接鉴权：与 mcp-tablet 相同的令牌反查 + pc.allowConvKeys ────────────────
function readConsoleToken() {
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

async function authorizePc(token) {
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    'x-agent-call': '1',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(token ? { 'x-agent-token': token } : {}),
  };
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/pc/auth`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: String(token ?? ''), action: 'control' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`桥接进程不可达，电脑工具拒绝执行（fail-closed）：${error?.message ?? error}`);
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error || `电脑工具鉴权失败（HTTP ${res.status}）`);
  }
  return body;
}

function toolError(error) {
  return {
    content: [{ type: 'text', text: `电脑操作失败：${error?.message ?? error}` }],
    isError: true,
  };
}

async function psStatus() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class PcW { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }
"@
$h=[PcW]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 512
[PcW]::GetWindowText($h,$sb,512) | Out-Null
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
"screens=$($b.Width)x$($b.Height)+$($b.X)+$($b.Y)"
"foreground=$($sb.ToString())"
`.trim();
  const res = await runPowerShell(script, 15000);
  if (!/^screens=/m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '读取屏幕信息失败');
  const info = {};
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^(screens|foreground)=(.*)$/.exec(line.trim());
    if (m) info[m[1]] = m[2];
  }
  return info;
}

async function captureScreenshot() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const local = path.join(SHOTS_DIR, `shot-${stamp}.jpeg`);
  // local 由本进程生成（state/pc-shots/ 带时间戳），不接收外部字符串
  const script = `
param([string]$OutPath=${psStr(local)})
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)
# 三参 Save(codec, encoderParams) 在 PS 里抛「参数无效」，两参 ImageFormat.Jpeg 稳定
$bmp.Save($OutPath,[System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $bmp.Dispose()
Write-Output ("saved " + (Get-Item $OutPath).Length)
`.trim();
  const res = await runPowerShell(script, 30000);
  if (!/^saved \d+/m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '截屏失败');
  const maxBytes = Number(pcConfig().maxScreenshotBytes ?? 4_000_000);
  const buf = fs.readFileSync(local);
  if (buf.length > maxBytes) {
    throw new Error(`截屏 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过上限（pc.maxScreenshotBytes=${maxBytes}）`);
  }
  try {
    const files = fs.readdirSync(SHOTS_DIR).filter((f) => f.startsWith('shot-')).sort().slice(0, -12);
    for (const f of files) fs.rmSync(path.join(SHOTS_DIR, f), { force: true });
  } catch {}
  return {
    content: [
      { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'text', text: JSON.stringify({ file: path.basename(local), bytes: buf.length }) },
    ],
  };
}

const server = new McpServer({ name: 'pc', version: '0.2.0-r3' });

server.tool(
  'pc_status',
  '探测电脑控制是否可用（只读）：功能开关、屏幕分辨率、当前前台窗口。不需要会话令牌。其余 pc_* 工具需要会话令牌，且仅管理员授权的会话（默认管理员私聊）可通过。',
  {},
  async () => {
    try {
      if (!pcEnabled()) {
        return { content: [{ type: 'text', text: JSON.stringify({ enabled: false, hint: '电脑控制未启用：在 config.json 设置 pc.enabled=true 后重启 DSH' }, null, 2) }] };
      }
      const info = await psStatus();
      return { content: [{ type: 'text', text: JSON.stringify({ enabled: true, ...info }, null, 2) }] };
    } catch (error) {
      return toolError(error);
    }
  }
);

if (pcEnabled()) {
  const tokenSchema = z.string().describe('会话令牌（提示中的【会话令牌】，与管理员私聊/授权会话对应）');
  const intArg = (name, max = 30000) => z.number().int().min(0).max(max).describe(name);

  server.tool(
    'pc_screenshot',
    '截取电脑全屏，JPEG 图像直接进入上下文。看游戏画面/桌面/窗口内容用它；配合 pc_click/pc_key 操作，每步操作后先截屏确认再下一步。需要会话令牌；仅管理员授权的会话可用。',
    { token: tokenSchema },
    async ({ token }) => {
      try {
        await authorizePc(token);
        return await captureScreenshot();
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'pc_click',
    '在电脑屏幕坐标点击鼠标。button 可选 left/right/middle，double=true 双击。坐标从 pc_screenshot 里判断。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      x: intArg('横坐标（像素）'), y: intArg('纵坐标（像素）'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('默认 left'),
      double: z.boolean().optional().describe('是否双击，默认 false'),
    },
    async ({ token, x, y, button, double }) => {
      try {
        await authorizePc(token);
        const script = withHelper(`param([int]$X=${x},[int]$Y=${y},[string]$B=${psStr(button ?? 'left')},[bool]$D=${double ? '$true' : '$false'})
[Pc]::MoveTo($X,$Y)
[Pc]::Click($B,$D)
Write-Output ("ok cursor=" + [Pc]::Cursor())`);
        const res = await runPowerShell(script);
        if (!/^ok /m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '点击失败');
        return { content: [{ type: 'text', text: `已点击 (${x},${y}) ${button ?? 'left'}${double ? ' 双击' : ''}` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'pc_move',
    '把鼠标移动到电脑屏幕坐标（不点击）。需要会话令牌；仅管理员授权的会话可用。',
    { token: tokenSchema, x: intArg('横坐标（像素）'), y: intArg('纵坐标（像素）') },
    async ({ token, x, y }) => {
      try {
        await authorizePc(token);
        const script = withHelper(`param([int]$X=${x},[int]$Y=${y})
[Pc]::MoveTo($X,$Y)
Write-Output ("ok cursor=" + [Pc]::Cursor())`);
        const res = await runPowerShell(script);
        if (!/^ok /m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '移动失败');
        return { content: [{ type: 'text', text: `已移动到 (${x},${y})` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'pc_drag',
    '按住鼠标左键从 (x1,y1) 拖到 (x2,y2)（拖拽窗口/滑块/物品）。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      x1: intArg('起点横坐标'), y1: intArg('起点纵坐标'),
      x2: intArg('终点横坐标'), y2: intArg('终点纵坐标'),
    },
    async ({ token, x1, y1, x2, y2 }) => {
      try {
        await authorizePc(token);
        const script = withHelper(`param([int]$X1=${x1},[int]$Y1=${y1},[int]$X2=${x2},[int]$Y2=${y2})
[Pc]::MoveTo($X1,$Y1)
[Pc]::Drag($X2,$Y2)
Write-Output "ok"`);
        const res = await runPowerShell(script);
        if (!/^ok/m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '拖拽失败');
        return { content: [{ type: 'text', text: `已拖拽 (${x1},${y1})→(${x2},${y2})` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'pc_scroll',
    '滚动鼠标滚轮（作用于鼠标当前位置下的窗口）。amount 为格数，先用 1~3 试。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      direction: z.enum(['up', 'down']).describe('滚动方向'),
      amount: z.number().int().min(1).max(30).optional().describe('格数，默认 3'),
    },
    async ({ token, direction, amount }) => {
      try {
        await authorizePc(token);
        const n = amount ?? 3;
        const script = withHelper(`param([bool]$Down=${direction === 'down' ? '$true' : '$false'},[int]$N=${n})
[Pc]::Scroll($Down, $N * 120)
Write-Output "ok"`);
        const res = await runPowerShell(script);
        if (!/^ok/m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '滚动失败');
        return { content: [{ type: 'text', text: `已向 ${direction} 滚动 ${n} 格` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'pc_key',
    '按电脑键盘的键或组合键，格式如 "w"、"enter"、"esc"、"ctrl+s"、"shift+tab"、"alt+enter"。扫描码注入（游戏可识别；holdMs 控制按住时长）。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      key: z.string().min(1).max(60).describe('键或组合键，用 + 连接，如 w / enter / ctrl+s'),
      holdMs: z.number().int().min(0).max(5000).optional().describe('按住时长（毫秒），默认 30'),
    },
    async ({ token, key, holdMs }) => {
      try {
        await authorizePc(token);
        const scans = parseKeyCombo(key);
        const arr = `@( ${scans.join(', ')} )`;
        const script = withHelper(`param([int[]]$S=${arr},[int]$H=${holdMs ?? 30})
[Pc]::KeyCombo($S, $H)
Write-Output "ok"`);
        const res = await runPowerShell(script);
        if (!/^ok/m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '按键失败');
        return { content: [{ type: 'text', text: `已按 ${key}` }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'pc_text',
    '向电脑当前聚焦的输入框输入文本（Unicode 注入，支持中文；先用 pc_click 点进输入框或 pc_window 激活窗口）。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      text: z.string().min(1).max(500).describe('要输入的文本'),
    },
    async ({ token, text }) => {
      try {
        await authorizePc(token);
        const b64 = Buffer.from(String(text), 'utf16le').toString('base64');
        const script = withHelper(`param([string]$T=[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')))
[Pc]::TypeText($T)
Write-Output "ok"`);
        const res = await runPowerShell(script);
        if (!/^ok/m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '输入失败');
        return { content: [{ type: 'text', text: '已输入文本' }] };
      } catch (error) { return toolError(error); }
    }
  );

  server.tool(
    'pc_window',
    '管理电脑窗口：action=list 列出可见窗口标题；action=activate 按标题子串激活（切到前台）。操作游戏前先 activate 游戏窗口。需要会话令牌；仅管理员授权的会话可用。',
    {
      token: tokenSchema,
      action: z.enum(['list', 'activate']).describe('list=列出窗口，activate=激活窗口'),
      title: z.string().max(120).optional().describe('activate 时必填：窗口标题的子串（不区分大小写）'),
    },
    async ({ token, action, title }) => {
      try {
        await authorizePc(token);
        if (action === 'activate') {
          if (!title) throw new Error('activate 需要提供 title（窗口标题子串）');
          const script = `
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class PcA {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  public static string Activate(string part) {
    StringBuilder sb = new StringBuilder(512); string found = null;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = t; ShowWindow(h, 9); SetForegroundWindow(h); return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$r = [PcA]::Activate(${psStr(title)})
if ($r) { "activated=$r" } else { "notfound" }
`.trim();
          const res = await runPowerShell(script);
          if (/^notfound/m.test(res.stdout)) {
            throw new Error(`没有找到标题包含「${title}」的可见窗口；可用 action=list 查看`);
          }
          if (!/^activated=/m.test(res.stdout)) throw new Error(res.stderr || res.stdout || '激活失败');
          return { content: [{ type: 'text', text: `已激活窗口：${/^activated=(.*)$/m.exec(res.stdout)?.[1] ?? ''}` }] };
        }
        const script = `
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class PcL {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static System.Collections.Generic.List<string> List() {
    var outp = new System.Collections.Generic.List<string>();
    StringBuilder sb = new StringBuilder(512);
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) { GetWindowText(h, sb, 512); if (sb.Length > 0) outp.Add(sb.ToString()); }
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
"@
[PcL]::List() | Select-Object -First 40
`.trim();
        const res = await runPowerShell(script, 15000);
        const titles = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return { content: [{ type: 'text', text: `可见窗口（前 ${titles.length} 个）：\n${titles.join('\n')}` }] };
      } catch (error) { return toolError(error); }
    }
  );
}

await server.connect(new StdioServerTransport());
