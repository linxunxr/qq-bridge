// QQ 卡片消息（OneBot json/xml 段）的文本化：提取应用名/标题/摘要/跳转链接，
// 让 agent 能读懂分享卡片（音乐、应用、小程序、链接预览、战绩卡等）。
//
// OneBot 11 的 json 段形如 {type:'json', data:{data:'<JSON 字符串>'}}，载荷是
// QQ 的 ark 卡片：{app, desc, prompt, meta:{<per-app>:{title, desc, jump_url, preview}}}}。
// 不同 app 的 meta 子键名不一样（news/miniapp/music/…），所以按值遍历找字段。
// 提不出现实内容的卡片回退占位符 [卡片消息]，不编造。
const FALLBACK = '[卡片消息]';

function cleanUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\//.test(s) ? s : '';
}

export function describeJsonCard(rawData, maxChars = 300) {
  let obj = null;
  if (rawData && typeof rawData === 'object') {
    obj = rawData;
  } else {
    const raw = String(rawData ?? '').trim();
    if (!raw) return FALLBACK;
    try { obj = JSON.parse(raw); } catch { return FALLBACK; }
  }
  if (!obj || typeof obj !== 'object') return FALLBACK;
  const app = String(obj.app ?? obj.viewName ?? '').replace(/^com\.tencent\./, '').trim();
  const desc = String(obj.desc ?? '').trim();
  let title = '';
  let sub = '';
  let url = '';
  for (const m of Object.values(obj.meta ?? {})) {
    if (!m || typeof m !== 'object') continue;
    const t = String(m.title ?? '').trim();
    const d = String(m.desc ?? '').trim();
    const u = cleanUrl(m.jump_url ?? m.qqdocurl ?? m.url);
    if (!t && !d && !u) continue;
    if (!title) title = t;
    if (!sub && d && d !== title) sub = d;
    if (!url) url = u;
    if (title && sub && url) break;
  }
  if (!title) title = desc;
  const parts = [];
  if (title) parts.push(title);
  if (sub) parts.push(sub);
  if (url) parts.push(url);
  if (!parts.length) return FALLBACK;
  const label = app ? `[卡片:${app}]` : '[卡片]';
  return `${label} ${parts.join(' — ')}`.slice(0, maxChars);
}

// 老式 xml 卡片：正文是 <msg …>…<title>标题</title>…</msg>，链接常在属性里。
// 只抽 title/summary/可点链接；抽不到就回退占位符。
export function describeXmlCard(rawData, maxChars = 300) {
  const raw = String(rawData ?? '').trim();
  if (!raw.startsWith('<')) return FALLBACK;
  const title = (/>([^<>]{1,80})<\/title>/i.exec(raw)?.[1]
    ?? /title="([^"]{1,80})"/i.exec(raw)?.[1]
    ?? /summary="([^"]{1,80})"/i.exec(raw)?.[1]
    ?? '').trim();
  const url = cleanUrl(/url="([^"]+)"/i.exec(raw)?.[1] ?? /href="([^"]+)"/i.exec(raw)?.[1] ?? '');
  const parts = [];
  if (title) parts.push(title);
  if (url) parts.push(url);
  if (!parts.length) return FALLBACK;
  return `[卡片] ${parts.join(' — ')}`.slice(0, maxChars);
}
