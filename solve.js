// solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns for the
// same input: a JSON object of output path -> file text. The dialect (front matter,
// templates, Markdown subset, slug rule, report) is makefun-site's own, implemented here
// from its README and reference behaviour. No dependencies, no state between calls:
// every case is answered from its input alone.

// ---------------------------------------------------------------- text rules

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_FIND = /[&<>"']/;
const ESCAPE_ALL = /[&<>"']/g;

// Escapes & < > " ' per the house table. Most text holds none of them: a native scan
// checks first, and a text without any is returned as it stands.
function escapeHtml(text) {
  if (!ESCAPE_FIND.test(text)) return text;
  return text.replace(ESCAPE_ALL, (c) => ESCAPE_MAP[c]);
}

const SLUG_LIMIT = 64;
const MARK_RE = /\p{M}/gu;

// The house slug: NFKD, combining marks dropped, A-Z lowered, every run of characters
// outside [a-z0-9] collapsed to one "-", none at either end, cut at 64 characters with a
// trailing "-" at the cut dropped, "untitled" when nothing survives.
function slugify(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let pendingGap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      pendingGap = out.length > 0;
      continue;
    }
    if (pendingGap) out += '-';
    pendingGap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_LIMIT).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// The first of slug, slug-2, slug-3, ... not in `taken`; the winner is added to `taken`.
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// "2026-11-09" -> "9 November 2026", from the string alone.
function longDate(date) {
  const parts = date.split('-');
  return `${Number(parts[2])} ${MONTH_NAMES[Number(parts[1]) - 1]} ${parts[0]}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;

function monthLength(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// A front-matter string: "..." with \" and \\ as its only escapes, or a bare rest-of-line
// that opens on neither " nor [. Returns { value } or { error }.
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > monthLength(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Splits a source into { data, body }, or { error } with the first refusal reason met.
// The lines are walked by offset, so the body is never split into lines at all: it is
// the text after the closing --- line, exactly what joining those lines would give.
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // First pass: find the closing --- (an unclosed front matter is refused before any
  // line inside it is read), remembering the few lines in between.
  const fmLines = [];
  let pos = firstNl === -1 ? text.length + 1 : firstNl + 1;
  let body = null;
  while (body === null) {
    if (pos > text.length) return { error: 'the front matter is not closed' };
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      body = nl === -1 ? '' : text.slice(nl + 1);
    } else {
      if (nl === -1) return { error: 'the front matter is not closed' };
      fmLines.push(line);
      pos = nl + 1;
    }
  }
  const data = {};
  for (let idx = 0; idx < fmLines.length; idx++) {
    const line = fmLines[idx];
    if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${idx + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- markdown

const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_QUOTE = /^>/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

function mdHeading(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// A line of nothing but spaces and tabs (or nothing).
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function mdEndsParagraph(line) {
  if (isBlankLine(line)) return true;
  const c0 = line[0];
  if (c0 === '`') return MD_FENCE_OPEN.test(line);
  if (c0 === '#') return mdHeading(line) !== null;
  if (c0 === '-' || c0 === '*') return MD_HR.test(line);
  return false;
}

// Spaces and tabs dropped at both ends of a line.
function mdTrim(line) {
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start++;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

// The block pass lives in renderMarkdown below: it walks the same lines in the same
// order (blank, fence, heading, break, blockquote, list, paragraph) and renders each
// block as it is read, so no token objects are built.

// The characters a backslash escapes, as a table by char code (all are ASCII).
const MD_ESCAPABLE = new Array(128).fill(false);
for (const c of '\\`*_[]()#+-.!>') MD_ESCAPABLE[c.charCodeAt(0)] = true;

function isEscapable(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 && MD_ESCAPABLE[code];
}

// The first index >= from where `what` occurs outside a backslash escape, or -1.
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// The first single "*" >= from (one not part of a "**" run), outside an escape, or -1.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Renders one run of inline markup; env.link(target) resolves a link's href.
function renderInline(s, env) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isEscapable(s[i + 1])) {
      out += escapeHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${renderInline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${renderInline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${renderInline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    // A plain run: everything up to the next character the markup reads (\ ` * [),
    // written through the escape table in one piece.
    let j = i + 1;
    while (j < s.length) {
      const d = s[j];
      if (d === '\\' || d === '`' || d === '*' || d === '[') break;
      j++;
    }
    out += escapeHtml(s.slice(i, j));
    i = j;
  }
  return out;
}

// Renders a body in one pass over its lines: { html, toc, excerpt } — the table of
// contents holds every level 2 and 3 heading; the excerpt is the first paragraph's
// inline HTML ("" when there is none). Each block is followed by "\n" in the HTML.
function renderMarkdown(src, env) {
  const slugOf = env.slugify ?? slugify;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const fence = line[0] === '`' ? MD_FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      let body = '';
      i++;
      while (i < lines.length && !MD_FENCE_CLOSE.test(lines[i])) {
        body += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      html += `<pre><code${cls}>${body}</code></pre>\n`;
      continue;
    }
    const heading = line[0] === '#' ? mdHeading(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugOf(heading.text), ids);
      const inner = renderInline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      i++;
      continue;
    }
    if ((line[0] === '-' || line[0] === '*') && MD_HR.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line[0] === '>') {
      const parts = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) {
        const t = mdTrim(lines[i++].replace(/^> ?/, ''));
        if (t !== '') parts.push(t);
      }
      html +=
        parts.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : `<blockquote>\n<p>${renderInline(parts.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = MD_BULLET.exec(line);
    const ordered = bullet === null ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push(mdTrim(isOrdered ? m[2] : m[1]));
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1] += `\n${mdTrim(lines[i])}`;
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const item of items) block += `<li>${renderInline(item, env)}</li>\n`;
      html += `${block}</${tag}>\n`;
      continue;
    }
    const parts = [mdTrim(line)];
    i++;
    while (i < lines.length && !mdEndsParagraph(lines[i])) parts.push(mdTrim(lines[i++]));
    const inner = renderInline(parts.join('\n'), env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_LIMIT = 8;

class TemplateError extends Error {}

function tplPath(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Splits a template source into text / var / raw / tag tokens. A {% %} tag that sits
// alone on its line (only spaces or tabs beside it) takes the whole line with it.
function tplTokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Parses a template into its node tree, or throws TemplateError with the reason.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
    } else if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
    } else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPath(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPath(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// The value at `path`: its first name from the nearest scope holding it, then own
// properties down; undefined when any step is missing.
function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// A value as template text: strings as-is, numbers in JavaScript's digits, booleans as
// true/false, arrays as their items joined by ", ", anything else as "".
function tplText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplText).join(', ');
  return '';
}

function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Renders a node tree in a scope ({ vars, parent }); ctx carries the parsed templates.
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var': {
        const v = tplLookup(scope, n.path);
        out += ctx.escape(typeof v === 'string' ? v : tplText(v));
        break;
      }
      case 'raw':
        out += tplText(tplLookup(scope, n.path));
        break;
      case 'if': {
        const v = tplTruthy(tplLookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = tplLookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {
            [n.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
          };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_LIMIT) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

const REPORT_PATH = 'build-report.txt';
const RESERVED_DIRS = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The whitespace JavaScript's \s names beyond the ASCII six, by code unit.
const EXTRA_WHITESPACE = new Set([
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

// The ASCII whitespace codes, as a table.
const ASCII_WHITESPACE = new Array(128).fill(false);
for (const code of [9, 10, 11, 12, 13, 32]) ASCII_WHITESPACE[code] = true;

// The words of a body: its runs of characters other than whitespace (what /\S+/g
// counts), tallied by a scan instead of a match array.
function countWords(text) {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ws = code < 128 ? ASCII_WHITESPACE[code] : EXTRA_WHITESPACE.has(code);
    if (ws) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}

// Resolves a link's relative path from a source's directory (its parts, split once
// per source); null when it climbs above the root.
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

// Whether a link target opens with a scheme (https:, mailto:, ...): a letter, then
// letters, digits, "+", "-" or ".", then a colon.
function hasScheme(target) {
  const first = target.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const code = target.charCodeAt(i);
    if (code === 58) return true; // ':'
    const ok =
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
      code === 43 || code === 45 || code === 46; // '+', '-', '.'
    if (!ok) return false;
  }
  return false;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function linkRecord(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkRecord(s.newer ?? null),
    older: linkRecord(s.older ?? null),
    is_post: s.post,
  };
}

// One site's output tree: path -> text, exactly as makefun-site 1.0.0 builds it.
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Slugify is a pure function of its text; within one build the same titles, tag
  // names and heading texts recur constantly, so each is slugged once per build.
  const slugCache = new Map();
  const slugCached = (text) => {
    let slug = slugCache.get(text);
    if (slug === undefined) {
      slug = slugify(text);
      slugCache.set(text, slug);
    }
    return slug;
  };

  // Sources in code-unit path order; .md files are sources (line ends made "\n"),
  // everything else is a static file carried as given.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    }
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, with the house's refusal checks in their order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED_DIRS.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order; the
  // root reserves posts/tags/page from the start.
  const takenByDir = new Map();
  const takenIn = (dir) => {
    if (!takenByDir.has(dir)) takenByDir.set(dir, new Set(dir === '' ? RESERVED_DIRS : []));
    return takenByDir.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugCached(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown bodies, with links resolved against the built pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      slugify: slugCached,
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts collection: newest date first, equal dates by slug in code-unit order.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags grouped by slug, each named as first met walking the posts in order, then
  // ordered by post count (most first) and slug.
  const tagBySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugCached(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugCached(name);
      if (!tagBySlug.has(slug)) tagBySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = tagBySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugCached(name);
        return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tagList = [...tagBySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // Layouts: every page through its layout, the paged index, one page per tag, the
  // tags index, then the static files (a built page shadows a static of its path).
  // A source's card is built once per build and shared by every list that shows it.
  const cardCache = new Map();
  const cardFor = (s) => {
    let card = cardCache.get(s);
    if (card === undefined) {
      card = cardOf(s);
      cardCache.set(s, card);
    }
    return card;
  };
  const cards = new Map(posts.map((p) => [p, cardFor(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined
      ? null
      : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cardFor(s)) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const tagView = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', { tag: tagView });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and broken link, sorted, then the counts line.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output[REPORT_PATH] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
