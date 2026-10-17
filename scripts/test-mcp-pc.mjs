// 电脑控制 MCP server（src/mcp-pc.js）的离线回归：
//   1) 静态断言权限设计不回退：x-agent-call 声明、注册期开关、无任意命令工具、
//      控制类工具全部要求 token、桥接端点先校验 pc.enabled；
//   2) stdio 拉起 server：pc_status 永远可用；控制工具注册与否与 pc.enabled 一致；
//   3) 无效令牌调用控制工具必须失败（桥接不在线 = fail-closed，同样算通过）。
// 不真动鼠标键盘（真机验证由管理员按 docs/guides/PC.md 手工做）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

// ── 1) 静态断言（防止后续改动悄悄削弱权限设计） ─────────────────────────────
const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-pc.js'), 'utf8');
ok(source.includes("'x-agent-call': '1'"), 'MCP 调桥接鉴权时声明 x-agent-call（防 confused deputy 提权）');
ok(source.includes('if (pcEnabled()) {'), '控制类工具注册期受 pc.enabled 过滤');
ok(!/server\.tool\(\s*['"]pc_(run|shell|exec)/.test(source), '不提供 pc_run/pc_shell 任意命令工具');
const tokenCount = (source.match(/token: tokenSchema/g) || []).length;
ok(tokenCount === 8, `八个控制类工具全部要求 token（实际 ${tokenCount}）`);
ok(source.includes('AbortSignal.timeout(10000)'), '鉴权请求带超时');
ok(/fail-closed/.test(source), '桥接不可达时 fail-closed 有明确处理');
// 键鼠注入必须走 param() 默认值 / base64，不允许把外部字符串拼进 PS 命令体
ok(source.includes('psStr ='), '外部字符串经单引号转义（psStr）进入 PS param 默认值');

const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
ok(bridge.includes("'/api/pc/auth'"), '桥接注册了 /api/pc/auth 端点');
const authIdx = bridge.indexOf("req.method === 'POST' && url.pathname === '/api/pc/auth'");
const enabledCheckIdx = bridge.indexOf('cfg.pc?.enabled !== true', authIdx);
ok(authIdx >= 0 && enabledCheckIdx > authIdx && enabledCheckIdx - authIdx < 2000, 'pc/auth 端点先校验 pc.enabled（未启用即拒绝）');
ok(bridge.includes("|| url.pathname === '/api/pc/auth'"), 'pc/auth 在 agent 可访问路径白名单内');
const restrict = fs.readFileSync(path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'), 'utf8');
ok(restrict.includes("'mcp__pc__'"), "qq-tool-restrict 白名单含 mcp__pc__（配合两层门禁）");

// ── 2) stdio 运行时 ─────────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const enabled = cfg.pc?.enabled === true;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'mcp-pc.js')],
  cwd: ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'bridge-test', version: '0.1.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log('工具:', names.join(', '));
  ok(names.includes('pc_status'), 'pc_status 始终注册');
  const CONTROL = ['pc_screenshot', 'pc_click', 'pc_move', 'pc_drag', 'pc_scroll', 'pc_key', 'pc_text', 'pc_window'];
  const haveAll = CONTROL.every((n) => names.includes(n));
  ok(haveAll === enabled, `控制工具注册状态与 pc.enabled=${enabled} 一致`);
  const status = await client.callTool({ name: 'pc_status', arguments: {} });
  const statusText = status.content?.[0]?.text ?? '';
  ok(!status.isError, 'pc_status 不报错');
  let parsed = null;
  try { parsed = JSON.parse(statusText); } catch {}
  ok(parsed && parsed.enabled === enabled, 'pc_status 返回的 enabled 与配置一致');
  if (parsed && parsed.screens) console.log('  屏幕信息:', parsed.screens, '| 前台:', parsed.foreground?.slice(0, 60));
  if (enabled) {
    const denied = await client.callTool({ name: 'pc_key', arguments: { token: 'invalid-token-for-offline-test', key: 'enter' } });
    const deniedText = denied.content?.map((c) => c.text ?? '').join('') ?? '';
    ok(denied.isError === true, '无效令牌调用控制工具必须失败（鉴权拒绝或桥接不可达均算 fail-closed）');
    ok(/令牌|鉴权|不可达/.test(deniedText), `拒绝原因可读：${deniedText.slice(0, 80)}`);
  }
} catch (error) {
  ok(false, `stdio 连接/调用失败：${error?.message ?? error}`);
} finally {
  try { await client.close(); } catch {}
}
console.log(failures === 0 ? '\ntest-mcp-pc 全部通过' : `\n${failures} 项断言失败`);
process.exit(failures ? 1 : 0);
