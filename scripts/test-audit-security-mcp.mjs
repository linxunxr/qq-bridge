// Exercise MCP callbacks with a fake transport: no network, config or stdio server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';

function loadWebTools(safeFetch) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, { safeFetch, McpServer, StdioServerTransport: class {}, z, URL, setTimeout, clearTimeout });
  return async (name, arguments_) => {
    const tool = tools.get(name);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

test('MCP search uses bounded shared safeFetch after query sanitization', async () => {
  const calls = [];
  const callTool = loadWebTools(async (url, maxChars) => {
    calls.push({ url, maxChars });
    return { statusCode: 200, body: '<li class="b_algo"><h2><a href="https://example.com/">Fixture title</a></h2><p>Fixture summary</p></li>' };
  });
  const result = await callTool('web_search', { query: '  fixture [CQ:at,qq=1]\n phrase  ' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.query, 'fixture phrase');
  assert.equal(parsed.results[0].title, 'Fixture title');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'fixture phrase');
  assert.equal(calls[0].maxChars, 512000);
});

test('MCP fetch uses shared transport and exposes rejection as a tool error', async () => {
  const callTool = loadWebTools(async () => { throw new Error('fixture: internal redirect rejected'); });
  for (const [name, args] of [['web_fetch', { url: 'http://example.com' }], ['web_search', { query: 'fixture' }]]) {
    const result = await callTool(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /internal redirect rejected/);
  }
});

test('empty searches are rejected without calling the transport', async () => {
  const callTool = loadWebTools(async () => { assert.fail('Unexpected transport call'); });
  const result = await callTool('web_search', { query: '[CQ:at,qq=1]\n ' });
  assert.equal(result.isError, true);
});

// 回归：cn.bing.com 会对无 Cookie 客户端间歇性下发「空壳结果页」（HTTP 200、框架
// 齐全、0 条 b_algo；无 JS 客户端的相关性还会被降级——搜新闻返回黄历/天气）。
// 新策略 RSS 优先：cn 空壳时换 www 的 RSS 输出兜底，能拿到结果就正常返回，
// 不再让模型把「被节流」报告成「网上什么都没有」（2026-10-16 群聊实录）。
test('throttled cn pages fall back to www RSS output', async () => {
  const urls = [];
  const callTool = loadWebTools(async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.startsWith('https://cn.bing.com/')) {
      return { statusCode: 200, body: '<html><head><title>fixture - 搜索</title></head><body><ol id="b_results"></ol></body></html>' };
    }
    if (u.includes('format=rss')) {
      return {
        statusCode: 200,
        body: '<rss><channel><title>必应：fixture</title>'
          + '<item><title><![CDATA[Real news from RSS]]></title><link>https://example.com/news</link>'
          + '<description><![CDATA[Fixture snippet]]></description></item></channel></rss>',
      };
    }
    assert.fail('RSS 兜底已命中，不应再退到 HTML：' + u);
  });
  const result = await callTool('web_search', { query: '今日新闻' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0]?.title, 'Real news from RSS', 'www RSS 兜底的结果应被采用');
  assert.equal(parsed.results[0]?.url, 'https://example.com/news');
  assert.equal(urls.length, 2, 'cn RSS 首查 + www RSS 兜底，共两次');
  assert.ok(urls[0].includes('format=rss'), '首查即走 RSS');
  assert.equal(new URL(urls[1]).searchParams.get('setmkt'), 'zh-CN');
});

// 回归：RSS 两级都空时仍能退回 HTML 解析（防 RSS 输出某天下线/变形）。
test('HTML parsing remains as the last fallback when RSS yields nothing', async () => {
  const callTool = loadWebTools(async (url) => {
    if (String(url).includes('format=rss')) return { statusCode: 200, body: '<rss><channel></channel></rss>' };
    if (String(url).startsWith('https://www.bing.com/')) {
      return { statusCode: 200, body: '<li class="b_algo"><h2><a href="https://example.com/html">HTML fallback</a></h2><p>Fixture snippet</p></li>' };
    }
    return { statusCode: 200, body: '<ol id="b_results"></ol>' };
  });
  const result = await callTool('web_search', { query: '今日新闻' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results[0]?.title, 'HTML fallback');
});

// 回归：image_search 从 Bing 图片搜索页的 m 属性里抽 murl 直链（供表情包入库用），
// 仍走共享 safeFetch 传输；两个前台都空时带 note 而不是裸空列表。
test('image_search extracts murl direct links from the Bing images page', async () => {
  const calls = [];
  const callTool = loadWebTools(async (url, maxChars) => {
    calls.push({ url: String(url), maxChars });
    return {
      statusCode: 200,
      body: '<div class="iuscp" m="{&quot;murl&quot;:&quot;https://pic.example.com/a%2Fcat1.jpg&quot;,&quot;turl&quot;:&quot;t1&quot;}" m="{&quot;murl&quot;:&quot;https://pic.example.com/cat2.gif&quot;}"></div>',
    };
  });
  const result = await callTool('image_search', { query: '猫猫 表情包' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.images[0], 'https://pic.example.com/a/cat1.jpg', 'murl 应解码后返回');
  assert.equal(parsed.images[1], 'https://pic.example.com/cat2.gif');
  assert.ok(calls[0].url.includes('/images/search?'), '应请求 Bing 图片搜索');
  assert.equal(calls[0].maxChars, 512000, '沿用受限传输链路的读取上限');
});

test('image_search falls back across Bing fronts and reports a note on total emptiness', async () => {
  const hosts = [];
  const callTool = loadWebTools(async (url) => {
    hosts.push(new URL(String(url)).host);
    return { statusCode: 200, body: '<html><body>no results</body></html>' };
  });
  const result = await callTool('image_search', { query: '猫猫 表情包' });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed.images, []);
  assert.match(parsed.note, /没有返回结果|限流/);
  assert.deepEqual(hosts, ['www.bing.com', 'cn.bing.com'], 'www 失败后应换 cn 前台');
});

// 回归：qq_fetch_sticker 把网图入库请求发给桥接端点，参数与会话令牌完整传递；
// 桥接侧错误（ok:false / HTTP 错误）必须作为工具错误浮出，不能假装入库成功。
test('qq_fetch_sticker posts to the bridge endpoint and surfaces failures', async () => {
  const seen = [];
  const fixtureConfig = { socialV2: { sticker: { enabled: true }, tools: { fetchSticker: true } } };
  const okTool = loadSnowlumaTools(async (url, init) => {
    seen.push({ url: String(url), body: init?.body });
    return Response.json({ ok: true, emojiId: 'EMOJI1', sticker: { id: 'EMOJI1', desc: '猫猫' }, remark: '猫猫' });
  }, fixtureConfig);
  const result = await okTool('qq_fetch_sticker', { key: 'group:771440459', token: 'tok', url: 'https://pic.example.com/cat.gif', note: '猫猫' });
  assert.equal(seen[0].url.includes('/api/socialV2/fetch-sticker'), true);
  const body = JSON.parse(seen[0].body);
  assert.equal(body.key, 'group:771440459');
  assert.equal(body.url, 'https://pic.example.com/cat.gif');
  assert.equal(body.note, '猫猫');
  assert.notEqual(result.isError, true);

  const failTool = loadSnowlumaTools(async () => Response.json({ ok: false, error: '入库/收藏表情太频繁了' }), fixtureConfig);
  const denied = await failTool('qq_fetch_sticker', { key: 'group:771440459', token: 'tok', url: 'https://pic.example.com/cat.gif' });
  assert.equal(denied.isError, true, '桥接拒绝必须浮出为工具错误');
  assert.match(denied.content[0].text, /太频繁/);
});

// 回归：三次都拿到「HTTP 200 但 0 条结果」时，不能返回看似权威的裸空列表——
// 要带 note 说明可能被限流，让模型说「暂时搜不到」而不是「什么都没有」。
test('all-empty Bing responses return a throttling note instead of a bare empty list', async () => {
  const callTool = loadWebTools(async () => ({ statusCode: 200, body: '<ol id="b_results"></ol>' }));
  const result = await callTool('web_search', { query: '今日新闻' });
  assert.notEqual(result.isError, true, 'HTTP 层都正常，不作为工具错误');
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.results.length, 0);
  assert.match(parsed.note, /限流|没有返回结果/);
});

/**
 * 用假 transport 加载 mcp-snowluma-safe.js，拿到它的工具回调。
 * 只需要把 fetch（桥接 API / OneBot HTTP）、McpServer、zod、两个本地纯模块塞进上下文。
 */
function loadSnowlumaTools(fetchImpl, fixtureConfig = null) {
  const tools = new Map();
  // vm 里没有 ESM 的 import.meta，把模块顶部的 __dirname 推导整段替换成固定值。
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  const fixtureFs = fixtureConfig === null ? fs : {
    ...fs,
    readFileSync(file, ...args) {
      if (path.basename(String(file)) === 'config.json' && String(file).includes('fixture')) {
        return JSON.stringify(fixtureConfig);
      }
      return fs.readFileSync(file, ...args);
    },
  };
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    AbortSignal,
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    fs: fixtureFs,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value),
  });
  return async (name, arguments_ = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} should be registered`);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

// 回归：桥接用 200 + {ok:false} 表达业务失败（例如发送被安全审计拦截）。
// agentApi 若不检查 body.ok，就会把「被拦截」当成「发送成功」报给模型 ——
// 模型据此认为消息已发出，既不再重试也不告诉用户，是典型的静默错误。
test('a bridge 200 with ok:false is reported to the model as a failure', async () => {
  const callTool = loadSnowlumaTools(async () => Response.json(
    { ok: false, error: '消息含敏感信息，已阻止发送' },
    { status: 200 },
  ));
  const result = await callTool('qq_send_group_message', { groupId: '456', message: 'fixture' });
  assert.equal(result.isError, true, 'ok:false 必须作为工具错误返回');
  assert.match(result.content[0].text, /阻止发送/);
});

// 回归：旧只读工具没有会话令牌，只能用在封闭 agent（管理员私聊）里。
// 桥接的 /api/status 对「带 agent 令牌」的调用返回最小对象（不含 mode 字段），
// 于是「看到 reserved2 才拒绝」的黑名单写法会判定为假 ⇒ 在二代仿真模式下放行，
// 把白名单群名、群成员名单注入模型上下文。
test('legacy read tools fail closed unless the bridge reports closed-agent', async () => {
  for (const status of [
    { mode: 'reserved2' }, { mode: 'chat' }, { mode: 'reserved' },
    {},                       // 无 mode 字段（桥接对 agent 流量返回的最小状态）
  ]) {
    const callTool = loadSnowlumaTools(async () => Response.json(status));
    const result = await callTool('qq_list_groups', {});
    assert.equal(result.isError, true, `mode=${status.mode ?? '(缺失)'} 时旧只读工具必须拒绝`);
  }
  // 只有确认是 closed-agent 才放行
  const callTool = loadSnowlumaTools(async (url) => {
    if (String(url).includes('/api/status')) return Response.json({ mode: 'closed-agent' });
    return Response.json({ status: 'ok', retcode: 0, data: [{ group_id: 456, group_name: 'fixture' }] });
  });
  const result = await callTool('qq_list_groups', {});
  assert.notEqual(result.isError, true, 'closed-agent 下应放行');
});

test('denied legacy group reads never reveal the group allowlist', async () => {
  const fixtureConfig = { allow: { groups: ['111111', '222222'] } };
  for (const mode of ['reserved2', 'closed-agent']) {
    const calls = [];
    const callTool = loadSnowlumaTools(async (url) => {
      calls.push(String(url));
      if (String(url).includes('/api/status')) return Response.json({ mode });
      assert.fail('denied group read must not call OneBot');
    }, fixtureConfig);
    for (const name of ['qq_get_group_members', 'qq_get_group_history']) {
      const result = await callTool(name, { groupId: '999999' });
      assert.equal(result.isError, true, `${name} in ${mode} must fail`);
      assert.doesNotMatch(result.content[0].text, /111111|222222/);
    }
    assert.equal(calls.length, 2, 'only the two authorization checks should reach the bridge');
  }
});
