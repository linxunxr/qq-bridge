// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从一次 Bing 响应里解析结果块；cn/www 两个前台共用，抽出函数供重试兜底复用。
function parseBingResults(html) {
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return results;
}

// 解析 Bing 的 RSS 输出（`format=rss`）：item/title/link/description，稳定且面向程序。
function stripCdata(s) {
  return String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function parseBingRss(xml) {
  const results = [];
  for (const block of xml.split('<item>').slice(1)) {
    const end = block.indexOf('</item>');
    const item = end >= 0 ? block.slice(0, end) : block;
    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/i);
    const descMatch = item.match(/<description>([\s\S]*?)<\/description>/i);
    const title = titleMatch ? decodeHtml(stripCdata(titleMatch[1])) : '';
    const urlStr = linkMatch ? decodeHtml(stripCdata(linkMatch[1])).trim() : '';
    const snippet = descMatch ? decodeHtml(stripCdata(descMatch[1])) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return results;
}

async function fetchBingPage(host, query, { rss = false, extraParams = {} } = {}) {
  const url = new URL(`https://${host}/search`);
  url.searchParams.set('q', query);
  if (rss) url.searchParams.set('format', 'rss');
  for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  return rss ? parseBingRss(res.body) : parseBingResults(res.body);
}

// cn.bing.com 的 HTML 结果页对无 Cookie 的程序化客户端有**两副面孔**（2026-10-16
// 实测）：① 间歇性下发「空壳页」——HTTP 200、框架齐全，但 0 条 b_algo（~84.5KB vs
// 正常 ~97KB，会连续几次又在约 45s 后自愈，www 前台不受影响）；② 即使有结果，无 JS
// 客户端拿到的 SERP 相关性也常被降级（搜「今日热点新闻」返回黄历/天气）。同一条链路
// 上加 `format=rss` 则两者皆无——RSS 稳定输出 10 条且是正常 organic 结果。因此：
//   RSS(cn) → RSS(www) → HTML(cn) → HTML(www) 逐级兜底（同为 Bing，不新增数据出机面）；
//   全部拿不到结果时不再返回看似权威的裸空列表，而是带 note 说明「可能被限流」，
//   让模型能说「暂时搜不到」而不是把节流报告成「网上什么都没有」（群聊实录翻过车）。
async function bingSearch(query) {
  const attempts = [
    { host: 'cn.bing.com', waitMs: 0, rss: true },
    { host: 'www.bing.com', waitMs: 1000, rss: true, extraParams: { setmkt: 'zh-CN' } },
    { host: 'cn.bing.com', waitMs: 1000, rss: false },
    { host: 'www.bing.com', waitMs: 0, rss: false, extraParams: { setmkt: 'zh-CN' } },
  ];
  let sawEmptyPage = false;
  let lastError = null;
  for (const { host, waitMs, rss, extraParams } of attempts) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      const results = await fetchBingPage(host, query, { rss, extraParams });
      if (results.length > 0) return { query, results };
      sawEmptyPage = true;
    } catch (error) {
      lastError = error;
    }
  }
  // 四次全是网络/HTTP 错误：维持旧行为——作为工具错误抛出，模型知道搜索失败。
  // 只要拿到过一次「HTTP 200 但空结果」的空页，就按「暂时无结果」而不是失败上报。
  if (lastError && !sawEmptyPage) throw lastError;
  return {
    query,
    results: [],
    note: lastError
      ? `搜索服务暂时没有返回结果（可能被 Bing 限流；最后一次错误：${lastError.message}）`
      : '搜索服务暂时没有返回结果（可能被 Bing 限流，稍后重试）',
  };
}

// Bing 图片搜索的结果页把每条结果的元数据放在元素的 m="…" 属性里（HTML 转义的
// JSON），其中 murl 是原图直链。不支持 format=rss（返回的是 HTML 页），所以只能
// 从 HTML 里抽；www 与 cn 两个前台都试，空结果时换下一个（与 web_search 的
// 空壳节流是同类现象）。
function extractBingImageUrls(html, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g)) {
    let u = m[1];
    try { u = decodeURIComponent(u); } catch {}
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

async function bingImageSearch(query) {
  for (const host of ['www.bing.com', 'cn.bing.com']) {
    const url = new URL(`https://${host}/images/search`);
    url.searchParams.set('q', query);
    if (host === 'www.bing.com') url.searchParams.set('setmkt', 'zh-CN');
    try {
      const res = await safeFetch(url.toString(), 512000);
      if (res.statusCode < 200 || res.statusCode >= 300) continue;
      const images = extractBingImageUrls(res.body);
      if (images.length > 0) return { query, images };
    } catch { /* 换下一个前台 */ }
  }
  return { query, images: [], note: '图片搜索暂时没有返回结果（可能被 Bing 限流，稍后重试；也可以换个更具体的关键词，如「xxx 表情包」）' };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.2.0-r3' });



server.tool(
  'web_search',
  '只读搜索网络用语/梗/黑话的含义，返回 Bing 搜索结果（标题/URL/摘要）。仅用于理解词义，不执行任何本地操作。结果为空且带 note 字段时表示搜索服务暂时受限（如被限流），应如实说「暂时搜不到」，不要据此断定「网上没有相关内容」。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'image_search',
  '只读搜索图片，返回候选图片的 http(s) 直链。主要用于找表情包素材：搜「xxx 表情包」挑一条直链，交给 mcp__snowluma__qq_fetch_sticker 收入 QQ 收藏表情。不执行任何本地操作。',
  { query: z.string().describe('图片搜索词，如「猫猫 歪头 表情包」') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingImageSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `图片搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
