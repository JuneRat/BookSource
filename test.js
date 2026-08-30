#!/usr/bin/env node
/**
 * 阅读 App 书源本地测试器 (纯 Node, 零依赖)
 * 用法:
 *   node test.js <书源.json> search <关键词>
 *   node test.js <书源.json> explore <分类名>
 *   node test.js <书源.json> toc <书籍URL或相对路径>
 *   node test.js <书源.json> content <章节URL或相对路径>
 *   node test.js <书源.json> all <关键词>
 */
const fs = require('fs');
const path = require('path');

// ==================== java 桥接 ====================
function makeJava(sourceHeader) {
  const baseHeaders = Object.assign({
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
  }, parseHeaderStr(sourceHeader));

  function parseHeaderStr(s) {
    try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
  }

  async function doFetch(url, options) {
    const resp = await fetch(url, options);
    return resp;
  }

  const java = {
    // java.ajax(url, headers?) -> string (跟随重定向)
    ajax: async (url, headers) => {
      const resp = await doFetch(url, { headers: Object.assign({}, baseHeaders, headers || {}), redirect: 'follow' });
      return await resp.text();
    },
    // java.get(url, headers?) -> {header(name), body}
    get: async (url, headers) => {
      const resp = await doFetch(url, { headers: Object.assign({}, baseHeaders, headers || {}), redirect: 'manual' });
      return {
        header: (n) => resp.headers.get(n) || '',
        body: () => resp.headers.get('content-type')?.includes('charset=gbk') ? decGbk(resp) : resp.text(),
        _resp: resp
      };
    },
    // java.post(url, body, headers) -> {body()} (Jsoup风格)
    post: async (url, body, headers) => {
      const h = Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded'
      }, baseHeaders, headers || {});
      const resp = await doFetch(url, { method: 'POST', body, headers: h });
      const text = await resp.text();
      return { body: () => text, statusCode: () => resp.status };
    },
    log: (...a) => console.log('    [js log]', ...a),
    strToMd5: s => s, // 简化
    base64Decode: s => Buffer.from(s, 'base64').toString('utf-8'),
    base64Encode: s => Buffer.from(s, 'utf-8').toString('base64'),
    // legado JsExtensions.sleep: 同步阻塞
    sleep: (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms) || 0); } catch (e) { const until = Date.now() + (Number(ms) || 0); while (Date.now() < until) {} } }
  };
  return java;
}

// ==================== 阅读选择器引擎(近似实现) ====================
function resolveUrl(base, rel) {
  if (/^https?:/.test(rel)) return rel;
  if (rel.startsWith('//')) return 'https:' + rel;
  try { return new URL(rel, base).href; } catch (e) { return rel; }
}

function extractBySelector(element, rule) {
  // XPath字段规则: //xxx/@attr 或 //xxx/text()
  if (/^\/\/.*\/@[\w-]+$/.test(rule)) {
    const attr = rule.split('/@').pop();
    const items = xpathItems(element, rule.split('/@')[0]);
    return items.length ? attrOf(items[0], attr) : null;
  }
  if (/^\/\/.*\/text\(\)$/.test(rule)) {
    const items = xpathItems(element, rule.replace(/\/text\(\)$/, ''));
    return items.length ? textOf(items[0]) : null;
  }
  // 支持: xxx##替换正则##替换为 (净化)
  let clean = null;
  if (rule.includes('##')) {
    const parts = rule.split('##');
    rule = parts[0];
    clean = parts.slice(1);
  }
  let value = selectValue(element, rule);
  if (value != null && clean && clean[0]) {
    try { value = String(value).replace(new RegExp(clean[0], 'g'), clean[1] || ''); } catch (e) {}
  }
  return value;
}

function selectValue(root, rule) {
  let el = root;
  const steps = rule.split('@');
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    if (step === 'text') return textOf(el);
    if (step === 'textNodes') return textNodesOf(el);
    if (step === 'ownText') return ownTextOf(el);
    if (step === 'html') return htmlOf(el);
    if (/^(href|src|title|alt|value|id|class|style|content|data-.+)$/.test(step)) return attrOf(el, step);
    el = selectOne(el, step);
    if (!el) return null;
  }
  return el;
}

function selectOne(el, step) {
  // class.xxx / id.xxx / tag.xxx, 支持索引 tag.a.2 / class.foo.1
  let m = step.match(/^class\.([\w.-]+?)(?:\.(-?\d+))?$/);
  if (m) {
    let cls = m[1];
    // 贪婪修正: 若末段是纯数字且没被单独捕获, 剥出来当索引
    if (!m[2]) {
      const dm = cls.match(/^(.+\.(\d+))$/);
      if (dm) { /* cls含.a.1但整体匹配 */ }
    }
    const parts = cls.split('.');
    const lastPart = parts[parts.length - 1];
    let idx = m[2] ? parseInt(m[2]) : null;
    if (idx === null && /^\d+$/.test(lastPart) && parts.length > 1 && !/^class\.\d/.test(step)) {
      // class.foo.1 形式(末段数字=索引), 但 class.a.b.c 的c若是数字也在此列——阅读语义如此
      idx = parseInt(lastPart);
      cls = parts.slice(0, -1).join('.');
    }
    const multi = cls.includes('.');
    if (multi) {
      // class.a.b = 同时含a和b
      const parts = cls.split('.');
      const all = Array.from(findAll(el, '*')).filter(e => {
        const cs = (e.attrs.class || '').split(/\s+/);
        return parts.every(p => cs.includes(p));
      });
      if (m[2]) { const i = parseInt(m[2]); return i < 0 ? all[all.length + i] : all[i]; }
      return all[0] || null;
    }
    return nthOf(el, '.' + cssEscape(cls), m[2], 'class');
  }
  m = step.match(/^id\.([^.]+)$/);
  if (m) return findOne(el, '#' + cssEscape(m[1]));
  m = step.match(/^tag\.([^.]+)(?:\.(-?\d+))?$/);
  if (m) return nthOf(el, m[1], m[2], 'tag');
  m = step.match(/^text\.([^.]+)$/);
  if (m) { // text.作者 -> ownText含此文字的元素(同Jsoup :containsOwn, 不命中仅包裹的父元素)
    const all = findAll(el, '*');
    for (const e of all) {
      if (ownTextOf(e).includes(m[1])) return e;
    }
    return null;
  }
  // 兜底: 当作css选择器
  return findOne(el, step);
}

// 极简DOM(自实现, 因为不装依赖): 解析用正则切块,只支持常见结构
// 说明: 这里偷懒用一个手写 mini parser, 复杂HTML可能有偏差——足够测试用
class MiniDom {
  constructor(tag, attrs, parent) {
    this.tag = tag; this.attrs = attrs || {}; this.children = []; this.parent = parent;
    this.text = ''; // 直接文本
  }
}
function parseHtml(html) {
  // 使用正则流式解析(标签+文本), 构建树
  const root = { tag: '#root', attrs: {}, children: [], parent: null, text: '' };
  const stack = [root];
  const voidTags = new Set(['br','img','input','meta','link','hr','area','base','col','embed','source','track','wbr']);
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  let count = 0;
  while ((m = re.exec(html)) !== null) {
    if (++count > 2000000) break; // 防超大页面
    if (m[4] !== undefined) {
      // 文本节点
      const top = stack[stack.length - 1];
      const t = decodeEntities(m[4]);
      if (t.trim()) {
        top.children.push({ tag: '#text', text: t, parent: top, children: [], attrs: {} });
      }
      continue;
    }
    const tag = m[1].toLowerCase();
    const selfClose = m[3] === '/' || voidTags.has(tag);
    if (m[0].startsWith('</')) {
      // 关闭标签: 弹栈到匹配
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = parseAttrs(m[2] || '');
    const node = { tag, attrs, children: [], parent: stack[stack.length - 1], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}
function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[2] !== undefined ? m[2] : ''));
  }
  return attrs;
}
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
// ---- 树查询 ----
function findAll(node, pred, out = []) {
  for (const c of node.children || []) {
    if (c.tag === '#text') continue;
    if (matchPred(c, pred)) out.push(c);
    findAll(c, pred, out);
  }
  return out;
}
function matchPred(el, pred) {
  if (pred === '*') return true;
  if (pred.startsWith('.')) return (el.attrs.class || '').split(/\s+/).includes(pred.slice(1));
  if (pred.startsWith('#')) return el.attrs.id === pred.slice(1);
  return el.tag === pred;
}
function findOne(scope, pred) {
  if (scope.tag !== '#root' && scope.tag !== '#text' && matchPred(scope, pred)) return scope;
  const r = findAll(scope, pred);
  return r[0] || null;
}
function nthOf(el, pred, idxStr, type) {
  const list = findAll(el, pred);
  if (!idxStr) return list[0] || null;
  const idx = parseInt(idxStr);
  if (idx < 0) return list[list.length + idx] || null;
  return list[idx] || null;
}
function cssEscape(s) { return s.replace(/([^\w-])/g, '\\$1'); }
// ---- 取值 ----
function textOf(el) {
  if (!el) return null;
  let s = '';
  (function walk(n) {
    for (const c of n.children) {
      if (c.tag === '#text') s += c.text;
      else walk(c);
    }
  })(el);
  return s.trim();
}
function ownTextOf(el) {
  if (!el) return null;
  let s = '';
  for (const c of el.children) if (c.tag === '#text') s += c.text;
  return s.trim();
}
function textNodesOf(el) {
  if (!el) return null;
  return ownTextOf(el);
}
function htmlOf(el) {
  if (!el) return null;
  return serNode(el);
}
function serNode(el) {
  let s = '';
  (function walk(n) {
    for (const c of n.children) {
      if (c.tag === '#text') s += c.text;
      else {
        const attrs = Object.entries(c.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
        const inner = '';
        s += `<${c.tag}${attrs}>`;
        walk(c);
        s += `</${c.tag}>`;
      }
    }
  })(el);
  return s;
}
function attrOf(el, name) {
  if (!el) return null;
  return el.attrs[name] !== undefined ? el.attrs[name] : null;
}

// ==================== 列表选择 ====================
function selectList(html, listRule) {
  const root = parseHtml(html);
  const el = selectOne(root, listRule);
  if (!el) return [];
  // 列表项 = el 的直接子元素(带tag的) — 近似: 返回el本身包装为单项
  // 阅读语义: bookList规则选中的每个元素作为一个条目
  // 我们返回该容器下的"子元素组"(单个包装)
  return [el];
}
// 更贴近阅读: bookList 选中的是"重复的兄弟元素组",通常是 class.item
// 实现为: 找到规则匹配的所有兄弟中同tag同class的连续组 -> 太复杂
// 简化: 直接 findAll 所有匹配, 每个匹配是一个条目(阅读的list规则实际就是全文档查询)
function matchPredSafe(el, pred) {
  try { return matchPred(el, pred); } catch(e) { return false; }
}
function selectItems(html, listRule) {
  const root = parseHtml(html);
  // XPath规则支持(简化): //tag[@class="x"]/... 
  if (listRule.startsWith('//')) {
    return xpathItems(root, listRule);
  }
  for (const r0 of listRule.split('||')) {
    const steps = r0.split('@');
    if (steps.length >= 2) {
      // 多级规则语义: 第1级=定位容器(selectOne), 后续每级=容器内 findAll 该选择器的全部, 取其子集递进
      // 例: id.allchapter@tag.dd@tag.a → allchapter容器内所有a(经dd限定)
      let scope = selectOne(root, steps[0]);
      if (!scope) continue;
      let items = [scope];
      for (let i = 1; i < steps.length; i++) {
        const st = steps[i];
        let pred = st;
        if (st.startsWith('class.')) pred = '.' + st.slice(6).split('.')[0];
        else if (st.startsWith('tag.')) pred = st.slice(4).split('.')[0];
        else if (st.startsWith('id.')) pred = '#' + st.slice(3);
        // 在每个当前条目内找该级选择器(含自身)
        const next = [];
        for (const it of items) {
          if (pred !== '*' && matchPredSafe(it, pred)) next.push(it);
          for (const f of findAll(it, pred)) next.push(f);
        }
        if (!next.length) break;
        items = next;
      }
      if (items.length > 1 || (items.length === 1 && items[0] !== scope)) return items;
      // 单元素时视为定位失败,落入单级分支
    }
    // 单级规则
    const r = r0;
    let pred;
    if (r.startsWith('class.')) {
      const clsPath = r.slice(6).split('@')[0];
      const parts = clsPath.split('.').filter(p => !/^-?\d+$/.test(p));
      if (parts.length > 1) {
        // 多class: 过滤
        const all = Array.from(findAll(root, '*')).filter(e => {
          const cs = (e.attrs.class || '').split(/\s+/);
          return parts.every(p => cs.includes(p));
        });
        if (all.length) return all;
        continue;
      }
      pred = '.' + parts[0];
    }
    else if (r.startsWith('id.')) pred = '#' + r.slice(3).split('@')[0];
    else if (r.startsWith('tag.')) pred = r.slice(4).split('@')[0].split('.')[0];
    else pred = r;
    const items = findAll(root, pred);
    if (items.length) return items;
  }
  return [];
}

// 简化XPath: 支持 //tag[@class="a b"]、//tag[contains(@class,"x")]、//tag、属性取值/@attr、末段text()
function xpathItems(root, xp) {
  // 拆分段
  const segs = xp.replace(/^\/\//, '').split('/').filter(Boolean);
  let ctx = [root];
  for (const seg of segs) {
    if (seg === 'text()') continue;
    if (seg.startsWith('@')) break; // 属性终点
    const m = seg.match(/^([a-zA-Z\d]+)(?:\[@class="([^"]+)"\]|\[contains\(@class,"([^"]+)"\)\])?(?:\[([^\]]+)\])?$/);
    if (!m) return [];
    const tag = m[1] === '*' ? null : m[1].toLowerCase();
    const clsExact = m[2], clsHas = m[3];
    const next = [];
    for (const el of ctx) {
      for (const d of findAll(el, tag || '*')) {
        const cs = (d.attrs.class || '').split(/\s+/);
        if (clsExact !== undefined && clsExact !== null && cs.join(' ') !== clsExact && !cs.includes(clsExact)) continue;
        if (clsHas !== undefined && clsHas !== null && !cs.some(c => c.includes(clsHas) || c === clsHas)) continue;
        next.push(d);
      }
    }
    ctx = next;
    if (!ctx.length) return [];
  }
  return ctx;
}

// ==================== JS 规则执行 ====================
// 预抓取js里的java.ajax/get/post字面量调用, 使其可同步使用(阅读Rhino是同步IO)
async function prefetchJavaCalls(body, java) {
  const re = /java\.(ajax|get|post)\(\s*(['"])([^'"]+)\2/g;
  const urls = new Set();
  let m;
  while ((m = re.exec(body)) !== null) {
    // 拼接式URL(引号后紧跟+)只预取静态完整部分会拿到无参页面, 直接跳过(由curl兜底按需请求)
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (after.trim().startsWith('+')) continue;
    urls.add(m[3]);
  }
  const cache = {};
  const headersCache = {};
  await Promise.all([...urls].map(async u => {
    try {
      const resp = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0', 'Referer': u }, redirect: 'manual'});
      headersCache[u] = resp;
      // 302: 跟随到最终页
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location') || '';
        const abs = loc.startsWith('http') ? loc : new URL(loc, u).href;
        const r2 = await fetch(abs, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0', 'Referer': u } });
        headersCache[u] = { headers: { get: (n) => n.toLowerCase() === 'location' ? loc : (r2.headers.get(n) || '') } };
        cache[u] = await r2.text();
      } else {
        cache[u] = await resp.text();
      }
    } catch (e) { cache[u] = ''; }
  }));
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
  const { execSync } = require('child_process');
  function shellQuote(v) {
    v = String(v);
    return /'^[\w\-./:=?&%+,]*$'/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'";
  }
  function shellQuoteSafe(v) {
    v = String(v).replace(/[^\x00-\xff]+/g, m => encodeURIComponent(m));
    return /'^[\w\-./:=?&%+,]*$'/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'";
  }
  function curlSync(url, method, body, headers) {
    // 同步HTTP(动态URL兜底): 返回 {status, headers, text}
    const args = ['-s', '-i', '-X', method || 'GET', '-A', shellQuote(UA), '--max-time', '20'];
    for (const [k, v] of Object.entries(headers || {})) args.push('-H', shellQuote(k + ': ' + v));
    if (body) args.push('--data', shellQuote(body));
    args.push(shellQuote(url.replace(/[^\x00-\xff]+/g, m => encodeURIComponent(m))));
    try {
      console.log('    [cmd]', 'curl ' + args.join(' '));
      const raw = execSync('curl ' + args.join(' '), { maxBuffer: 20 * 1024 * 1024 }).toString();
      const idx = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, idx), text = raw.slice(idx + 4);
      const hlines = head.split('\r\n');
      const status = parseInt((hlines[0] || '').match(/\s(\d+)\s/) ? hlines[0].match(/\s(\d+)\s/)[1] : '0');
      const hmap = {};
      for (let i = 1; i < hlines.length; i++) {
        const c = hlines[i].indexOf(':');
        if (c > 0) hmap[hlines[i].slice(0, c).toLowerCase()] = hlines[i].slice(c + 1).trim();
      }
      return { status, headers: { get: (n) => hmap[n.toLowerCase()] || '' }, text };
    } catch (e) { console.log('    [curlSync错误]', e.message ? e.message.slice(0, 150) : e); return { status: 0, headers: { get: () => '' }, text: '' }; }
  }
  return {
    ajax: (u, h) => {
      if (cache[u] !== undefined) return cache[u];
      return curlSync(u, 'GET', null, h).text;
    },
    get: (u, h) => {
      if (cache[u] !== undefined) return { header: (n) => headersCache[u] ? (headersCache[u].headers.get(n) || '') : '', body: () => cache[u] || '' };
      console.log('    [curl兜底 GET]', u.slice(0, 90));
      const r = curlSync(u, 'GET', null, h);
      console.log('    [curl结果] status', r.status, 'loc:', r.headers.get('location'));
      return { header: (n) => r.headers.get(n), body: () => r.text };
    },
    post: (u, b, h) => {
      if (cache[u] !== undefined && !b) return { body: () => cache[u] || '' };
      const r = curlSync(u, 'POST', b, h);
      return { body: () => r.text };
    },
    sleep: (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms) || 0); } catch (e) { const until = Date.now() + (Number(ms) || 0); while (Date.now() < until) {} } },
    log: (...a) => console.log('    [js log]', ...a)
  };
}

async function runJsRule(rule, ctx) {
  // ctx: {result, baseUrl, key, page, java}
  let body = rule.replace(/^@js:/, '');
  // 若js体含java.*调用且注入的是异步桥接, 换成预抓取同步层
  if (/java\.(ajax|get|post)\(/.test(body)) {
    ctx.java = await prefetchJavaCalls(body, ctx.java);
  }
  // body可能是表达式(IIFE)或语句块(let list...): 分别包装
  const isExpr = /^\s*\(?\s*function|^\s*[({[]/.test(body.trim()) && /\)\s*;?\s*$/.test(body.trim()) || /^@/.test(body);
  const trimmed = body.trim();
  let wrapped;
  if (/^\(function|^\(\{/.test(trimmed)) {
    wrapped = `return (async () => { return (${body}) })()`;   // IIFE/对象表达式
  } else {
    // 语句块: 无显式return时, 把最后一个表达式变成return值(Rhino取末表达式语义)
    let b = body.trim().replace(/;+$/, '');
    if (!/return\s/.test(b.slice(-120))) {
      const lastSemi = b.lastIndexOf(';');
      const lastBrace = b.lastIndexOf('}');
      const cut = Math.max(lastSemi, lastBrace);
      const lastExpr = b.slice(cut + 1).trim();
      if (lastExpr) {
        b = b.slice(0, cut + 1) + '\nreturn (' + lastExpr + ');';
      } else {
        b = b + '\nreturn undefined;';
      }
    }
    wrapped = `return (async () => { ${b} })()`;
  }
  const fn = new Function('result', 'baseUrl', 'key', 'page', 'java', 'JSON', 'String', wrapped);
  // 注意: 阅读是同步Rhino,这里async化; 规则里同步return的值会被await解包
  return await fn(ctx.result, ctx.baseUrl, ctx.key, ctx.page, ctx.java, JSON, String);
}

// ==================== 主流程 ====================
async function main() {
  const [file, cmd, arg] = process.argv.slice(2);
  if (!file || !cmd) {
    console.log('用法: node test.js <书源.json> <search|explore|toc|content|all> [参数]');
    process.exit(1);
  }
  const abs = path.resolve(file);
  let sources;
  try {
    sources = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    if (!Array.isArray(sources)) sources = [sources];
  } catch (e) {
    console.log('✗ JSON解析失败:', e.message); process.exit(1);
  }
  const src = sources[0];
  const java = makeJava(src.header);
  const base = src.bookSourceUrl.replace(/\/$/, '');
  console.log(`▣ 书源: ${src.bookSourceName} (${base})`);

  try {
    if (cmd === 'search') await testSearch(src, java, base, arg);
    else if (cmd === 'explore') await testExplore(src, java, base, arg);
    else if (cmd === 'toc') await testToc(src, java, base, arg);
    else if (cmd === 'content') await testContent(src, java, base, arg);
    else if (cmd === 'all') await testAll(src, java, base, arg);
    else console.log('未知命令:', cmd);
  } catch (e) {
    console.log('✗ 异常:', typeof e === 'string' ? e : e.message);
  }
}

async function fetchPage(java, base, url) {
  const full = resolveUrl(base, url);
  return await java.ajax(full);
}

async function testSearch(src, java, base, key) {
  console.log(`\n[search] 关键词: ${key}`);
  let searchUrl = src.searchUrl;
  // 处理POST形式 "url,{json}"
  let postBody = null;
  const cm = searchUrl.match(/^(.+),\{(.+)\}$/s);
  if (cm) { searchUrl = cm[1]; postBody = JSON.parse('{' + cm[2] + '}'); }
  let url = resolveUrl(base, searchUrl
    .replace('{{key}}', encodeURIComponent(key)).replace('{{page}}', '1'));
  let html;
  if (postBody && postBody.method === 'POST') {
    const body = (postBody.body || '').replace('{{key}}', encodeURIComponent(key));
    const resp = await java.post(url, body, {});
    html = resp.body();
  } else if (searchUrl.startsWith('@js:')) {
    url = await runJsRule(searchUrl, { result: '', baseUrl: base, key, page: 1, java });
    console.log('  js生成URL:', url);
    html = await java.ajax(url);
  } else {
    html = await java.ajax(url);
  }
  const rule = src.ruleSearch || {};
  const items = selectItems(html, rule.bookList || '');
  console.log(`  结果数: ${items.length}`);
  if (!items.length) { console.log('  ✗ bookList 无匹配! 保存页面到 /tmp/last_search.html'); fs.writeFileSync('/tmp/last_search.html', html); return; }
  const sample = items[0];
  const name = extractBySelector(sample, rule.name || '') || '?';
  const bookUrl = extractBySelector(sample, rule.bookUrl || '') || '';
  console.log(`  首条: ${name} → ${bookUrl}`);
  if (!bookUrl || bookUrl === '?') console.log('  ⚠ bookUrl为空,检查规则');
  return { bookUrl, html };
}

async function testToc(src, java, base, bookUrl) {
  console.log(`\n[toc] ${bookUrl}`);
  const html = await fetchPage(java, base, bookUrl);
  const rule = src.ruleToc || {};
  // tocUrl?
  let tocHtml = html, tocUrl = bookUrl;
  if (src.ruleBookInfo && src.ruleBookInfo.tocUrl) {
    const root = parseHtml(html);
    const t = extractBySelector(root, src.ruleBookInfo.tocUrl);
    if (t && t !== bookUrl) {
      tocUrl = resolveUrl(base, t);
      console.log('  tocUrl →', tocUrl);
      tocHtml = await fetchPage(java, base, tocUrl);
    }
  }
  const items = selectItems(tocHtml, rule.chapterList || '');
  console.log(`  章节数: ${items.length}`);
  if (!items.length) { console.log('  ✗ chapterList 无匹配! 页面存 /tmp/last_toc.html'); fs.writeFileSync('/tmp/last_toc.html', tocHtml); return; }
  const pick = items[Math.min(2, items.length - 1)]; // 取第3章, 避开目录首尾的"查看全部"类链接
  const cn = extractBySelector(pick, rule.chapterName || 'text') || '?';
  const cu = extractBySelector(pick, rule.chapterUrl || 'href') || '';
  console.log(`  样章: ${cn} → ${cu}`);
  // nextTocUrl
  if (rule.nextTocUrl) {
    const root = parseHtml(tocHtml);
    let next = '';
    if (rule.nextTocUrl.startsWith('@js:')) next = await runJsRule(rule.nextTocUrl, { result: tocHtml, baseUrl: resolveUrl(base, tocUrl), java });
    else next = extractBySelector(root, rule.nextTocUrl) || '';
    console.log(`  翻页: ${next || '(无,末页)'}`);
  }
  return { chapterUrl: cu };
}

async function testContent(src, java, base, chapterUrl) {
  console.log(`\n[content] ${chapterUrl}`);
  const html = await fetchPage(java, base, chapterUrl);
  const rule = src.ruleContent || {};
  if (!rule.content) { console.log('  ✗ 无content规则'); return; }
  let out;
  if (rule.content.startsWith('@js:')) {
    out = await runJsRule(rule.content, { result: html, baseUrl: resolveUrl(base, chapterUrl), java });
  } else {
    const root = parseHtml(html);
    out = extractBySelector(root, rule.content);
  }
  if (out == null || String(out).length === 0) {
    console.log('  ✗ 提取为空! 页面存 /tmp/last_content.html'); fs.writeFileSync('/tmp/last_content.html', html); return null;
  }
  const s = String(out);
  console.log(`  ✓ ${s.length}字`);
  console.log(`  首50: ${s.slice(0, 50).replace(/\n/g, '⏎')}`);
  console.log(`  末30: ${s.slice(-30).replace(/\n/g, '⏎')}`);
  // nextContentUrl
  if (rule.nextContentUrl) {
    let next = '';
    if (rule.nextContentUrl.startsWith('@js:')) next = await runJsRule(rule.nextContentUrl, { result: html, baseUrl: resolveUrl(base, chapterUrl), java });
    else next = extractBySelector(parseHtml(html), rule.nextContentUrl) || '';
    console.log(`  正文分页: ${next || '(无)'}`);
  }
  return s;
}

async function testExplore(src, java, base, title) {
  console.log(`\n[explore] 分类: ${title}`);
  let eu = src.exploreUrl || '';
  let target = null;
  if (eu.startsWith('@js:')) {
    const out = await runJsRule(eu, { result: '', baseUrl: base, java, page: 1 });
    const list = JSON.parse(out);
    for (const it of list) {
      if (it.title === title || !title) { target = it; if (title) break; }
    }
    if (!target && list.length) target = list[0];
    if (!target) { console.log('  ✗ js发现规则输出为空'); return; }
    console.log(`  发现入口数: ${list.length} | 选中: ${target.title}`);
    target.url = target.url.replace('{{page}}', '1');
  } else {
    for (const line of eu.split('\n')) {
      const [t, u] = line.split('::');
      if (t.trim() === title || !title) { target = { title: t.trim(), url: u.replace('{{page}}', '1') }; break; }
    }
  }
  const html = await fetchPage(java, base, target.url);
  const rule = src.ruleExplore || {};
  const items = selectItems(html, rule.bookList || '');
  console.log(`  条目数: ${items.length}`);
  if (!items.length) { console.log('  ✗ bookList 无匹配! 页面存 /tmp/last_explore.html'); fs.writeFileSync('/tmp/last_explore.html', html); return; }
  const name = extractBySelector(items[0], rule.name || '') || '?';
  const bu = extractBySelector(items[0], rule.bookUrl || '') || '';
  console.log(`  首条: ${name} → ${bu}`);
}

async function testAll(src, java, base, key) {
  const r1 = await testSearch(src, java, base, key);
  if (!r1 || !r1.bookUrl) { console.log('\n✗ 全链路在search中断'); return; }
  const r2 = await testToc(src, java, base, r1.bookUrl);
  if (!r2 || !r2.chapterUrl) { console.log('\n✗ 全链路在toc中断'); return; }
  const r3 = await testContent(src, java, base, r2.chapterUrl);
  if (!r3) { console.log('\n✗ 全链路在content中断'); return; }
  console.log('\n▣ 全链路 PASS ✓');
}

main();
