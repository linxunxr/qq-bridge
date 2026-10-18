// QQ 卡片消息文本化（src/qq-card.js）的单元回归 + 桥接接入静态断言。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { describeJsonCard, describeXmlCard } from '../src/qq-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('小程序/应用分享卡：提取 app、标题、摘要、跳转链接', () => {
  const payload = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    desc: '哔哩哔哩',
    meta: {
      miniapp: {
        title: '【视频】猫猫歪头合集',
        desc: '笑死我了这个猫',
        jump_url: 'https://b23.tv/abc123',
        preview: 'https://i0.hdslb.com/x.jpg',
      },
    },
  });
  const out = describeJsonCard(payload);
  assert.match(out, /^\[卡片:miniapp_01\]/);
  assert.match(out, /猫猫歪头合集/);
  assert.match(out, /笑死我了这个猫/);
  assert.match(out, /https:\/\/b23\.tv\/abc123/);
});

test('json 段的 data 可能已是对象（非字符串）', () => {
  const out = describeJsonCard({ app: '', desc: '', meta: { news: { title: '网易云每日推荐', jump_url: 'https://y.music.example/song' } } });
  assert.match(out, /\[卡片\] 网易云每日推荐 — https:\/\/y\.music\.example\/song/);
});

test('只有 desc 的卡片用 desc 当标题；title 优先于 desc', () => {
  assert.match(describeJsonCard(JSON.stringify({ desc: '某某的战绩' })), /^\[卡片\] 某某的战绩/);
  assert.match(
    describeJsonCard(JSON.stringify({ desc: '外层描述', meta: { x: { title: '内层标题' } } })),
    /内层标题(?!.*外层描述)/,
  );
});

test('非法/空载荷回退占位符，不编造内容', () => {
  assert.equal(describeJsonCard(''), '[卡片消息]');
  assert.equal(describeJsonCard('not json {'), '[卡片消息]');
  assert.equal(describeJsonCard(JSON.stringify({ foo: 1 })), '[卡片消息]');
});

test('超长卡片内容截断到 300 字符', () => {
  const out = describeJsonCard(JSON.stringify({ meta: { x: { title: '长'.repeat(500) } } }));
  assert.ok(out.length <= 300);
});

test('xml 卡片：抽 title 与 url，抽不到回退', () => {
  const xml = '<msg service="33" url="https://example.com/x"><title>投票标题</title><summary>来投票</summary></msg>';
  assert.match(describeXmlCard(xml), /\[卡片\] 投票标题 — https:\/\/example\.com\/x/);
  assert.equal(describeXmlCard('<foo></foo>'), '[卡片消息]');
  assert.equal(describeXmlCard(''), '[卡片消息]');
});

test('桥接已把 json/xml 段接到卡片文本化（静态断言，防回退成占位符）', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.ok(bridge.includes("case 'json': out.push(describeJsonCard(d.data)); break;"), 'json 段应走 describeJsonCard');
  assert.ok(bridge.includes("case 'xml': out.push(describeXmlCard(d.data)); break;"), 'xml 段应走 describeXmlCard');
});
