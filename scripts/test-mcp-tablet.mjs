// 平板 MCP server（src/mcp-tablet.js）的离线回归：
//   1) 静态断言权限设计不回退：x-agent-call 声明、注册期开关、无任意 shell 工具、
//      控制类工具全部要求 token、桥接端点先校验 tablet.enabled；
//   2) stdio 拉起 server：tablet_status 永远可用；控制工具注册与否与 tablet.enabled 一致；
//   3) 无效令牌调用控制工具必须失败（桥接不在线 = fail-closed，同样算通过）。
// 不需要平板在线；tablet_status 的设备探测失败只是 online:false，不算错误。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

// ── 1) 静态断言（防止后续改动悄悄削弱权限设计） ─────────────────────────────
const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-tablet.js'), 'utf8');
ok(source.includes("'x-agent-call': '1'"), 'MCP 调桥接鉴权时声明 x-agent-call（防 confused deputy 提权）');
ok(source.includes('if (tabletEnabled()) {'), '控制类工具注册期受 tablet.enabled 过滤');
ok(!/server\.tool\(\s*['"]tablet_shell/.test(source), '不提供 tablet_shell 任意命令工具');
const tokenCount = (source.match(/token: tokenSchema/g) || []).length;
ok(tokenCount === 8, `八个控制类工具全部要求 token（实际 ${tokenCount}）`);
ok(source.includes('AbortSignal.timeout(10000)'), '鉴权请求带超时');
ok(/fail-closed/.test(source), '桥接不可达时 fail-closed 有明确处理');

const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
ok(bridge.includes("'/api/tablet/auth'"), '桥接注册了 /api/tablet/auth 端点');
// 锚定 POST 端点定义本身（不是 agentAllowed 白名单里那处更早的引用）
const authIdx = bridge.indexOf("req.method === 'POST' && url.pathname === '/api/tablet/auth'");
const enabledCheckIdx = bridge.indexOf('cfg.tablet?.enabled !== true', authIdx);
ok(authIdx >= 0 && enabledCheckIdx > authIdx && enabledCheckIdx - authIdx < 2000, 'tablet/auth 端点先校验 tablet.enabled（未启用即拒绝）');
ok(bridge.includes("|| url.pathname === '/api/tablet/auth'"), 'tablet/auth 在 agent 可访问路径白名单内');
// 守卫：tablet 命名空间进执行期白名单的前提是两层硬门禁存在（注册开关 + 鉴权端点）。
const restrict = fs.readFileSync(path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'), 'utf8');
ok(restrict.includes("'mcp__tablet__'"), "qq-tool-restrict 白名单含 mcp__tablet__（配合上面两层门禁）");

// ── 2) stdio 运行时 ─────────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const enabled = cfg.tablet?.enabled === true;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'mcp-tablet.js')],
  cwd: ROOT,
  stderr: 'pipe',
});
const client = new Client({ name: 'bridge-test', version: '0.1.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log('工具:', names.join(', '));
  ok(names.includes('tablet_status'), 'tablet_status 始终注册');
  const CONTROL = ['tablet_screenshot', 'tablet_read_screen', 'tablet_tap', 'tablet_swipe', 'tablet_fling', 'tablet_key', 'tablet_text', 'tablet_open_url'];
  const haveAll = CONTROL.every((n) => names.includes(n));
  ok(haveAll === enabled, `控制工具注册状态与 tablet.enabled=${enabled} 一致`);
  const status = await client.callTool({ name: 'tablet_status', arguments: {} });
  const statusText = status.content?.[0]?.text ?? '';
  ok(!status.isError, 'tablet_status 不报错（设备不在线只影响 online 字段）');
  let parsed = null;
  try { parsed = JSON.parse(statusText); } catch {}
  ok(parsed && parsed.enabled === enabled, 'tablet_status 返回的 enabled 与配置一致');
  if (enabled) {
    const denied = await client.callTool({ name: 'tablet_tap', arguments: { token: 'invalid-token-for-offline-test', x: 1, y: 1 } });
    const deniedText = denied.content?.map((c) => c.text ?? '').join('') ?? '';
    ok(denied.isError === true, '无效令牌调用控制工具必须失败（鉴权拒绝或桥接不可达均算 fail-closed）');
    ok(/令牌|鉴权|不可达/.test(deniedText), `拒绝原因可读：${deniedText.slice(0, 80)}`);
  }
} catch (error) {
  ok(false, `stdio 连接/调用失败：${error?.message ?? error}`);
} finally {
  try { await client.close(); } catch {}
}
console.log(failures === 0 ? '\ntest-mcp-tablet 全部通过' : `\n${failures} 项断言失败`);
process.exit(failures ? 1 : 0);
