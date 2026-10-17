#!/usr/bin/env node
/**
 * 同步 Otter 的 DSH 随机端口到 config.json。
 *
 * Otter 用 `dsh web --port 0` 启动（随机端口），每次重启都会变化；
 * 本脚本找到正在运行的 DSH 进程的监听端口，写进 config.json 的 dsh.baseUrl。
 * 用法：Otter（重）启动后、启动 qq-bridge 前跑一次：
 *   node sync-dsh-port.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CFG = path.join(import.meta.dirname, 'config.json');

const ps = `
$ports = @()
# 形态一：官方桌面端（DeepSeek Harness.exe，Electron）
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
  (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -match 'DeepSeek'
} | ForEach-Object { $ports += $_.LocalPort }
# 形态二：CLI（dsh web / bin.js web，含 Otter spawn 的随机端口）
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh.*bin\\.js web' } | ForEach-Object {
  $procId = $_.ProcessId
  Get-NetTCPConnection -OwningProcess $procId -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $ports += $_.LocalPort }
}
$ports | Sort-Object -Unique
`;

// 用 -EncodedCommand（UTF-16LE base64）传输，避免 shell 引号/换行转义问题
const encoded = Buffer.from(ps, 'utf16le').toString('base64');
let ports;
try {
  ports = [...new Set(execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8' })
    .split(/\s+/).map(Number).filter((p) => p > 0))];
} catch (e) {
  console.error('找不到运行中的 DSH（bin.js web）进程——先启动 Otter/DSH 再跑本脚本。');
  process.exit(1);
}
if (!ports.length) {
  console.error('DSH 进程在跑但没有监听端口（可能还在启动中），稍等几秒重试。');
  process.exit(1);
}
if (ports.length > 1) console.warn(`发现多个 DSH 端口 ${ports.join(', ')}，取第一个——如有多个 DSH 实例请关掉多余的。`);

const baseUrl = `http://127.0.0.1:${ports[0]}`;
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const old = cfg.dsh?.baseUrl;
if (old === baseUrl) {
  console.log(`dsh.baseUrl 已是 ${baseUrl}，无需修改。`);
} else {
  cfg.dsh.baseUrl = baseUrl;
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  console.log(`dsh.baseUrl: ${old ?? '(空)'} → ${baseUrl}`);
}
console.log('下一步：重启 qq-bridge（npm start）使配置生效。');
