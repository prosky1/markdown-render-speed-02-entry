// parse.js — a fast drop-in replacement for marked 18.1.3's marked.parse,
// with marked's default options (gfm on, breaks off, pedantic off, async off).
// Written in-session from the CommonMark 0.31.2 and GFM 0.29 specifications,
// verified against marked's observable output with a black-box probe oracle.
// No marked source was copied: every line below was authored here.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = Object.create(null);
  const blocks = parseBlocks(src, refs);
  return renderBlocks(blocks, refs);
}

// ---------------------------------------------------------------- helpers

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return PUNCT.indexOf(ch) >= 0;
  // CommonMark "Unicode punctuation" = general categories P or S.
  return /[\p{P}\p{S}]/u.test(ch);
}
// Backslash escapes work only before ASCII punctuation (CommonMark).
function isAsciiPunct(ch) {
  if (!ch) return false;
  return ch.charCodeAt(0) < 128 && PUNCT.indexOf(ch) >= 0;
}
function isSpace(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
  // CommonMark Unicode whitespace: U+00A0, U+1680, U+2000-U+200A,
  // U+202F, U+205F, U+3000 (U+00A0 is the cm-353 case: *\u00A0a\u00A0*).
  return ch === ' ' || ch === ' ' || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
}
function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

// Escape & < > " ' in a text run (marked escapes quotes in text and in
// code spans too). Text runs handed here never contain an entity
// sequence: the inline scanner splits those out first.
function escText(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Escape an attribute value: & < > ", but leave a valid entity reference
// (&name; / &#...; / &#x...;) untouched, exactly as marked renders it.
function escAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const m = entityAt(s, i);
      if (m) { out += m.numeric ? escAttr(m.text) : m.text; i += m.len; continue; }
      out += '&amp;'; i++;
    } else if (c === 60) { out += '&lt;'; i++; }
    else if (c === 62) { out += '&gt;'; i++; }
    else if (c === 34) { out += '&quot;'; i++; }
    else if (c === 39) { out += '&#39;'; i++; }
    else { out += s[i]; i++; }
  }
  return out;
}

// If an entity reference starts at s[i], return {text, len, numeric}
// where text is what marked outputs for it (named references verbatim,
// numeric decoded, invalid code points replaced by U+FFFD); else null.
// A numeric reference has at most 7 decimal digits or 6 hex digits —
// more than that is not an entity at all and stays literal text.
function entityAt(s, i) {
  const n = s.length;
  if (s[i] !== '&' || i + 1 >= n) return null;
  const c1 = s[i + 1];
  if (c1 === '#') {
    let j = i + 2;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n && ((s[j] >= '0' && s[j] <= '9') || (hex && ((s[j] >= 'a' && s[j] <= 'f') || (s[j] >= 'A' && s[j] <= 'F'))))) j++;
    const digits = s.slice(start, j);
    if (j === start || j >= n || s[j] !== ';') return null;
    if (digits.length > (hex ? 6 : 7)) return null;
    let cp = parseInt(digits, hex ? 16 : 10);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { text: String.fromCodePoint(cp), len: j - i + 1, numeric: true };
  }
  if ((c1 >= 'a' && c1 <= 'z') || (c1 >= 'A' && c1 <= 'Z')) {
    let j = i + 1;
    while (j < n && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= '0' && s[j] <= '9'))) j++;
    if (j < n && s[j] === ';') return { text: s.slice(i, j + 1), len: j - i + 1, numeric: false };
  }
  return null;
}

// Decode entities inside a link destination or title the way marked does:
// numeric references become the character, named references stay verbatim.
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const m = entityAt(s, i);
      if (m) { out += m.text; i += m.len; continue; }
    }
    out += s[i++];
  }
  return out;
}

// Normalise a link reference label: trim, collapse internal whitespace to
// one space, case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Encode a link destination the way marked renders it in href="...":
// encodeURI, except that an existing %XX sequence is left alone (the %
// itself is not re-escaped). Backslashes, < >, " and non-ASCII all become
// percent-escapes; javascript: / vbscript: are NOT sanitized.
function encodeHref(dest) {
  try {
    return encodeURI(dest).replace(/%25/g, '%');
  } catch {
    // A lone surrogate makes encodeURI throw; fall back to escaping
    // just the ASCII specials instead of failing the whole render.
    let out = '';
    for (let i = 0; i < dest.length; i++) {
      const c = dest.charCodeAt(i);
      if (c === 32) out += '%20';
      else if (c === 60) out += '%3C';
      else if (c === 62) out += '%3E';
      else if (c === 34) out += '%22';
      else out += dest[i];
    }
    return out;
  }
}

// ---------------------------------------------------------------- inline
//
// The scanner walks the text once and emits a flat list of items:
//   {k:'t', s}        escaped text
//   {k:'code', s}     code span (escaped content)
//   {k:'br'}          hard line break
//   {k:'html', s}     raw HTML (verbatim)
//   {k:'link', href, title, kids}   kids = inline items of the link text
//   {k:'img', src, title, alt}      alt = plain text
//   {k:'d', ch, n, open, close}     emphasis / strikethrough delimiter run
// Emphasis is resolved over the item list afterwards (delimiter algorithm),
// then the list is rendered to a string.

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*/;

function parseInline(s, refs, inLink) {
  const items = [];
  const delims = [];
  const n = s.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) items.push({ k: 't', s: escText(s.slice(textStart, end)) });
  };
  const pushDelim = (ch, start, len, open, close) => {
    const d = { k: 'd', ch, n: len, open, close, start };
    items.push(d);
    delims.push(d);
    return d;
  };

  while (i < n) {
    const c = s[i];
    const cc = s.charCodeAt(i);
    // Backslash: escape of punctuation, or hard break before a newline.
    if (cc === 92) { // backslash
      const nx = s[i + 1];
      if (nx === '\n') { flushText(i); items.push({ k: 'br' }); i += 2; textStart = i; continue; }
      if (nx && isAsciiPunct(nx)) { flushText(i); items.push({ k: 't', s: escText(nx) }); i += 2; textStart = i; continue; }
      i++;
      continue;
    }
    // Code span.
    if (cc === 96) { // backtick
      let j = i;
      while (j < n && s[j] === '`') j++;
      const len = j - i;
      const close = findCodeClose(s, j, len);
      if (close >= 0) {
        let content = s.slice(j, close).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flushText(i);
        items.push({ k: 'code', s: escText(content) });
        i = close + len;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // Emphasis / strikethrough delimiter runs.
    if (cc === 42 || cc === 95 || cc === 126) { // * _ ~
      const ch = c;
      let j = i;
      while (j < n && s[j] === ch) j++;
      const len = j - i;
      const prev = i > 0 ? s[i - 1] : '';
      const next = j < n ? s[j] : '';
      const leftFlank = next !== '' && !isSpace(next) && (!isPunct(next) || prev === '' || isSpace(prev) || isPunct(prev));
      const rightFlank = prev !== '' && !isSpace(prev) && (!isPunct(prev) || next === '' || isSpace(next) || isPunct(next));
      let open, close;
      if (ch === '_') {
        open = leftFlank && (!rightFlank || prev === '' || isSpace(prev) || isPunct(prev));
        close = rightFlank && (!leftFlank || next === '' || isSpace(next) || isPunct(next));
      } else {
        open = leftFlank;
        close = rightFlank;
      }
      if (ch === '~' && len < 1) { i = j; continue; }
      if (open || close) {
        flushText(i);
        pushDelim(ch, i, len, open, close);
        i = j;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // Entity reference.
    if (cc === 38) { // &
      const m = entityAt(s, i);
      if (m) { flushText(i); items.push({ k: 't', s: m.numeric ? escText(m.text) : m.text }); i += m.len; textStart = i; continue; }
      i++;
      continue;
    }
    // < : autolink, email, or raw HTML tag.
    if (cc === 60) { // <
      const got = tryAngle(s, i, refs);
      if (got) {
        flushText(i);
        items.push(got.item);
        i = got.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Link or image. A link's text may contain an image but not another
    // link, so ![ is allowed inside a link but [ is not.
    if (cc === 91 && !inLink) { // [
      const got = tryLink(s, i, refs, false);
      if (got) {
        flushText(i);
        items.push(got.item);
        i = got.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (cc === 33 && s[i + 1] === '[') { // ![
      const got = tryLink(s, i + 1, refs, true);
      if (got) {
        flushText(i);
        items.push(got.item);
        i = got.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Newline: hard break (2+ trailing spaces or backslash handled above)
    // or soft break.
    if (cc === 10) { // \n
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && s[k] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        flushText(k + 1);
        items.push({ k: 'br' });
      } else {
        flushText(i);
        items.push({ k: 't', s: '\n' });
      }
      i++;
      textStart = i;
      continue;
    }
    // GFM extended autolinks: www. / http(s):// / bare e-mail, at a word
    // boundary.
    if ((c === 'w' || c === 'h' || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122))) {
      const prev = i > 0 ? s[i - 1] : '';
      if (prev === '' || isSpace(prev) || (isPunct(prev) && prev !== '/' && prev !== '@')) {
        const got = tryGfmAutolink(s, i);
        if (got) {
          flushText(i);
          items.push(got.item);
          i = got.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  processEmphasis(items, delims);
  return items;
}

function findCodeClose(s, from, len) {
  const n = s.length;
  let i = from;
  while (i < n) {
    if (s[i] === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      if (j - i === len) return i;
      i = j;
    } else i++;
  }
  return -1;
}

// Find the index of the `]` matching the `[` at `open` (depth-aware,
// skipping code spans and backslash escapes). -1 when there is none.
function findLinkEnd(s, open) {
  const n = s.length;
  let depth = 1;
  let i = open + 1;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const len = j - i;
      const close = findCodeClose(s, j, len);
      if (close < 0) return -1;
      i = close + len;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Parse the tail of an inline link after `]`: (dest "title"). Returns
// {dest, title, end} or null.
function parseLinkTail(s, i) {
  const n = s.length;
  i = skipWs(s, i);
  if (i >= n || s[i] !== '(') return null;
  i++;
  i = skipWs(s, i);
  let dest = '';
  if (i < n && s[i] === '<') {
    let j = i + 1;
    let buf = '';
    while (j < n && s[j] !== '>') {
      if (s[j] === '\n') return null;
      if (s[j] === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
      buf += s[j]; j++;
    }
    if (j >= n) return null;
    dest = buf;
    i = j + 1;
  } else {
    let depth = 0;
    let j = i;
    let buf = '';
    while (j < n) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
      if (c === '(') { depth++; buf += c; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; buf += c; j++; continue;
      }
      if (c.charCodeAt(0) < 32) return null;
      buf += c; j++;
    }
    dest = buf;
    i = j;
  }
  i = skipWs(s, i);
  let title = null;
  if (i < n && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const q = s[i];
    const closeQ = q === '(' ? ')' : q;
    let j = i + 1;
    let buf = '';
    let ok = false;
    while (j < n) {
      const c = s[j];
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
      if (c === closeQ) { ok = true; break; }
      if (c === '\n' && q !== '"') { /* titles may span lines */ }
      buf += c; j++;
    }
    if (!ok) return null;
    title = buf;
    i = j + 1;
    i = skipWs(s, i);
  }
  if (i >= n || s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

// Try to parse a link or image starting at the `[` at `open`.
// Returns {item, end} or null.
// Does `text` contain a link (not an image)? A link's text may not
// contain a link, so an outer [text](...) whose text holds a link is
// not a link at all — the inner link wins and the outer brackets stay
// literal. Code spans are skipped (a [ inside `...` is not a link).
function containsLink(text, refs) {
  if (text.indexOf('[') < 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > 0) { i = end; continue; }
    }
    if (text[i] === '[' && text[i - 1] !== '!') {
      if (tryLink(text, i, refs, false)) return true;
    }
  }
  return false;
}

function tryLink(s, open, refs, isImg) {
  const close = findLinkEnd(s, open);
  if (close < 0) return null;
  const rawText = s.slice(open + 1, close);
  if (!isImg && containsLink(rawText, refs)) return null;
  let dest = null;
  let title = null;
  let end = close + 1;
  const after = s[end];
  if (after === '(') {
    const tail = parseLinkTail(s, end);
    if (!tail) return null;
    dest = tail.dest;
    title = tail.title;
    end = tail.end;
  } else if (after === '[') {
    const lblEnd = s.indexOf(']', end + 1);
    if (lblEnd < 0) return null;
    const label = s.slice(end + 1, lblEnd);
    const key = normLabel(label === '' ? rawText : label);
    const ref = refs[key];
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = lblEnd + 1;
  } else {
    const key = normLabel(rawText);
    const ref = refs[key];
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
  }
  dest = decodeEntities(dest);
  if (title !== null) title = decodeEntities(title);
  if (isImg) {
    const altKids = parseInline(rawText, refs, true);
    const alt = stripTags(renderItems(altKids));
    return { item: { k: 'img', src: encodeHref(dest), title: title === null ? null : escAttr(title), alt: escAttr(alt) }, end };
  }
  const kids = parseInline(rawText, refs, true);
  return { item: { k: 'link', href: encodeHref(dest), title: title === null ? null : escAttr(title), kids }, end };
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

// Try <...> at position i: autolink, e-mail autolink, or raw HTML.
// Returns {item, end} or null.
function tryAngle(s, i) {
  const n = s.length;
  // Comment, processing instruction, declaration, CDATA.
  if (s.startsWith('<!--', i)) {
    const end = s.indexOf('-->', i + 4);
    if (end >= 0) return { item: { k: 'html', s: s.slice(i, end + 3) }, end: end + 3 };
    return null;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end >= 0) return { item: { k: 'html', s: s.slice(i, end + 2) }, end: end + 2 };
    return null;
  }
  if (s.startsWith('<!', i)) {
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end >= 0) return { item: { k: 'html', s: s.slice(i, end + 3) }, end: end + 3 };
      return null;
    }
    const m = /^<![A-Za-z][^>]*>/.exec(s.slice(i));
    if (m) return { item: { k: 'html', s: m[0] }, end: i + m[0].length };
    return null;
  }
  if (s.startsWith('</', i) || /[A-Za-z]/.test(s[i + 1] || '')) {
    const m = /^<\/?[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(s.slice(i));
    if (m) return { item: { k: 'html', s: m[0] }, end: i + m[0].length };
  }
  // Autolink <scheme:...> or <email>.
  const gt = s.indexOf('>', i + 1);
  if (gt > 0) {
    const inner = s.slice(i + 1, gt);
    if (inner.indexOf(' ') < 0 && inner.indexOf('<') < 0 && inner.indexOf('\n') < 0) {
      if (SCHEME_RE.test(inner)) {
        const href = encodeHref(inner);
        return { item: { k: 'link', href, title: null, kids: [{ k: 't', s: escText(inner) }] }, end: gt + 1 };
      }
      if (EMAIL_RE.test(inner)) {
        const href = 'mailto:' + inner;
        return { item: { k: 'link', href, title: null, kids: [{ k: 't', s: escText(inner) }] }, end: gt + 1 };
      }
    }
  }
  return null;
}

const GFM_URL_RE = /^(?:https?:\/\/|www\.)[^\s<>\[\]{}|\\^`]+/i;
const GFM_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;

// GFM extended autolink at position i. Returns {item, end} or null.
function tryGfmAutolink(s, i) {
  const rest = s.slice(i);
  let m = GFM_URL_RE.exec(rest);
  if (m) {
    let url = m[0];
    url = trimAutolinkEnd(url);
    if (!/\./.test(url.replace(/^https?:\/\//, '').replace(/^www\./, ''))) return null;
    const href = url.startsWith('www.') ? 'http://' + url : url;
    return { item: { k: 'link', href: encodeHref(href), title: null, kids: [{ k: 't', s: escText(url) }] }, end: i + url.length };
  }
  m = GFM_EMAIL_RE.exec(rest);
  if (m) {
    const email = m[0];
    return { item: { k: 'link', href: 'mailto:' + email, title: null, kids: [{ k: 't', s: escText(email) }] }, end: i + email.length };
  }
  return null;
}

// Strip trailing punctuation from a GFM autolink, per the GFM rules.
function trimAutolinkEnd(url) {
  let end = url.length;
  const TRAIL = '?!.,:;*_~\'"';
  while (end > 0) {
    const c = url[end - 1];
    if (TRAIL.indexOf(c) >= 0) {
      if (c === ';') {
        const amp = url.lastIndexOf('&', end - 1);
        if (amp >= 0 && /^[A-Za-z][A-Za-z0-9]*;$/.test(url.slice(amp, end))) break;
      }
      end--;
      continue;
    }
    if (c === ')') {
      let depth = 0;
      let hasOpen = false;
      for (let k = 0; k < end; k++) {
        if (url[k] === '(') { depth++; hasOpen = true; }
        else if (url[k] === ')') depth--;
      }
      if (!hasOpen || depth > 0) { end--; continue; }
      break;
    }
    if (c === ']' || c === '}') {
      const open = c === ']' ? '[' : '{';
      if (url.indexOf(open) < 0) { end--; continue; }
      break;
    }
    break;
  }
  return url.slice(0, end);
}

// The CommonMark delimiter algorithm over the scanned items.
function processEmphasis(items, delims) {
  const bottom = Object.create(null);
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.close || closer.n === 0) continue;
    const ch = closer.ch;
    const bot = bottom[ch] === undefined ? -1 : bottom[ch];
    let oi = ci - 1;
    let opener = null;
    while (oi > bot) {
      const cand = delims[oi];
      if (cand.ch === ch && cand.open && cand.n > 0) {
        if (ch === '~' && cand.n < 1) { oi--; continue; }
        // Odd-match rule: if EITHER delimiter can both open and close,
        // the sum of the two runs must not be a multiple of 3 unless
        // both are multiples of 3 (spec rule 10).
        if ((cand.open && cand.close) || (closer.open && closer.close)) {
          const sum = cand.n + closer.n;
          if (sum % 3 === 0 && !(cand.n % 3 === 0 && closer.n % 3 === 0)) { oi--; continue; }
        }
        opener = cand;
        break;
      }
      oi--;
    }
    if (!opener) {
      // Only a closer that cannot itself open can be the lower bound:
      // a closer that can open is still a potential opener for a later
      // closer (foo*bar* — the first * must stay searchable).
      if (!closer.open) bottom[ch] = ci;
      continue;
    }
    let use;
    if (ch === '~') use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    else use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const tag = ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    wrapDelimiters(items, opener, closer, tag, use);
    opener.n -= use;
    closer.n -= use;
    if (opener.n === 0) {
      const idx = delims.indexOf(opener);
      if (idx >= 0) delims.splice(idx, 1);
      if (idx <= ci) ci--;
      if (bottom[ch] !== undefined && bottom[ch] >= idx) bottom[ch]--;
    }
    if (closer.n > 0) { ci--; continue; }
  }
}

// Replace the opener/closer delimiter items with open/close markers.
// A partially-used delimiter keeps its item (with its leftover count,
// decremented by the caller) so it can match again — that is what makes
// ****foo**** become <strong><strong>foo</strong></strong> instead of
// leaving the outer pair literal. The open marker goes after the
// opener's leftover characters; the close marker goes before the
// closer's leftover characters.
function wrapDelimiters(items, opener, closer, tag, use) {
  const oi = items.indexOf(opener);
  const ci = items.indexOf(closer);
  if (oi < 0 || ci < 0 || ci <= oi) return;
  const leftOver = opener.n - use;
  const rightOver = closer.n - use;
  if (leftOver > 0) items.splice(oi + 1, 0, { k: 'open', tag });
  else items.splice(oi, 1, { k: 'open', tag });
  const ci2 = items.indexOf(closer);
  if (rightOver > 0) items.splice(ci2, 0, { k: 'close', tag });
  else items.splice(ci2, 1, { k: 'close', tag });
}

function renderItems(items) {
  let out = '';
  for (const it of items) {
    if (it.k === 't' || it.k === 'code') {
      out += it.k === 'code' ? '<code>' + it.s + '</code>' : it.s;
    } else if (it.k === 'br') out += '<br>';
    else if (it.k === 'html') out += it.s;
    else if (it.k === 'open') out += '<' + it.tag + '>';
    else if (it.k === 'close') out += '</' + it.tag + '>';
    else if (it.k === 'link') {
      out += '<a href="' + escAttr(it.href) + '"';
      if (it.title !== null) out += ' title="' + it.title + '"';
      out += '>' + renderItems(it.kids) + '</a>';
    } else if (it.k === 'img') {
      out += '<img src="' + escAttr(it.src) + '" alt="' + it.alt + '"';
      if (it.title !== null) out += ' title="' + it.title + '"';
      out += '>';
    } else if (it.k === 'd') {
      if (it.n > 0) out += escText(it.ch.repeat(it.n));
    }
  }
  return out;
}

// ---------------------------------------------------------------- blocks
//
// Block parsing follows the CommonMark reference algorithm: a stack of open
// containers (block quotes, list items) is matched against every line, then
// new leaf blocks are opened at the remaining content. Tabs are handled by
// column, so a tab that straddles an indent boundary contributes spaces.

function makeCursor(text) {
  return { s: text, i: 0, col: 0, pend: 0 };
}
function curPeek(c) {
  if (c.pend > 0) return ' ';
  return c.i < c.s.length ? c.s[c.i] : '';
}
function curAdvance(c, n) {
  while (n > 0) {
    if (c.pend > 0) {
      const t = Math.min(c.pend, n);
      c.pend -= t; c.col += t; n -= t;
    } else if (c.i >= c.s.length) return false;
    else if (c.s[c.i] === '\t') {
      const w = 4 - (c.col % 4);
      c.i++;
      if (w <= n) { c.col += w; n -= w; }
      else { c.pend = w - n; c.col += n; n = 0; }
    } else { c.i++; c.col++; n--; }
  }
  return true;
}
function curSkipSpaces(c, maxCols) {
  let n = 0;
  while (n < maxCols) {
    const ch = curPeek(c);
    if (ch !== ' ' && ch !== '\t') break;
    curAdvance(c, 1);
    n++;
  }
  return n;
}
function curRest(c) {
  return ' '.repeat(c.pend) + c.s.slice(c.i);
}
function curIsBlank(c) {
  let i = c.i;
  if (c.pend > 0) return true;
  while (i < c.s.length) {
    if (c.s[i] !== ' ' && c.s[i] !== '\t') return false;
    i++;
  }
  return true;
}
// Visual column of the first non-space/tab character, and its char index.
// `base` is the absolute column the text starts at: tab widths depend on
// the absolute column, so a tab after a stripped container prefix must be
// measured from the line start, not from the stripped text's start.
function indentOf(text, base) {
  base = base || 0;
  let col = 0;
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    if (text[i] === '\t') col += 4 - ((base + col) % 4);
    else col++;
    i++;
  }
  return { col, idx: i };
}
// The content of a line starting at visual column `col` (a tab straddling
// the boundary contributes spaces). `base` is the absolute column the
// text starts at.
function sliceFromCol(text, col, base) {
  base = base || 0;
  let c = 0;
  let i = 0;
  while (i < text.length && c < col) {
    if (text[i] === '\t') {
      const w = 4 - ((base + c) % 4);
      if (c + w > col) return ' '.repeat(c + w - col) + text.slice(i + 1);
      c += w; i++;
    } else { c++; i++; }
  }
  return text.slice(i);
}

// Remove up to n columns of leading spaces/tabs (tab-aware from base).
// Unlike sliceFromCol, this only removes whitespace: a line with no
// leading spaces is returned unchanged. A tab that straddles the cut
// leaves spaces for its remainder.
function stripIndent(text, n, base) {
  base = base || 0;
  let c = 0, i = 0;
  while (i < text.length && c < n) {
    const ch = text[i];
    if (ch === ' ') { c++; i++; }
    else if (ch === '\t') {
      const w = 4 - ((base + c) % 4);
      if (c + w > n) return ' '.repeat(c + w - n) + text.slice(i + 1);
      c += w; i++;
    } else break;
  }
  return text.slice(i);
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HR_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const BULLET_RE = /^ {0,3}([-+*])([ \t]+|$)/;
const ORDERED_RE = /^ {0,3}(\d{1,9})([.)])([ \t]+|$)/;
const TABLE_DELIM_CELL = /^:?-+:?$/;

function isBlankLine(text) {
  return /^[ \t]*$/.test(text);
}

// Parse a link destination starting at s[i], then an optional title.
// Returns {dest, title, maybeTitle, end} or null. `maybeTitle` means the
// line ended right after the destination: a title may still follow on the
// next line (CommonMark spec example 192).
function parseDestAndTitle(s, i) {
  let dest = '';
  if (s[i] === '<') {
    let j = i + 1;
    let buf = '';
    while (j < s.length && s[j] !== '>') {
      if (s[j] === '\n') return null;
      if (s[j] === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
      buf += s[j]; j++;
    }
    if (j >= s.length) return null;
    dest = buf;
    i = j + 1;
  } else {
    let j = i;
    let buf = '';
    let depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
      if (c === '(') { depth++; buf += c; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; buf += c; j++; continue;
      }
      if (c.charCodeAt(0) < 32) return null;
      buf += c; j++;
    }
    if (buf === '') return null;
    dest = buf;
    i = j;
  }
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  let title = null;
  let maybeTitle = false;
  if (i < s.length) {
    const q = s[i];
    if (q === '"' || q === "'" || q === '(') {
      const closeQ = q === '(' ? ')' : q;
      let j = i + 1;
      let buf = '';
      let ok = false;
      while (j < s.length) {
        const c = s[j];
        if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
        if (c === closeQ) { ok = true; break; }
        buf += c; j++;
      }
      if (!ok) return null;
      title = buf;
      i = j + 1;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      if (i < s.length) return null;
    } else return null;
  } else {
    maybeTitle = true;
  }
  return { dest: decodeEntities(dest), title: title === null ? null : decodeEntities(title), maybeTitle, end: i };
}

// Try to parse a link reference definition starting at `content` (the
// paragraph-start line, containers already stripped). Returns
// {label, dest, title, maybeTitle} for a complete definition, {label,
// awaitingDest, raw} when the label and colon are present but the
// destination is on a following line (spec examples 193/195/198), or
// null when the line is not a definition.
function tryParseRefDef(content) {
  if (!/^ {0,3}\[/.test(content)) return null;
  const close = findLinkEnd(content, 0);
  if (close < 0) return null;
  const label = content.slice(1, close);
  if (label.trim() === '') return null;
  let i = close + 1;
  if (content[i] !== ':') return null;
  i++;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return { label: normLabel(label), awaitingDest: true, raw: content };
  const res = parseDestAndTitle(content, i);
  if (!res) return null;
  return { label: normLabel(label), dest: res.dest, title: res.title, maybeTitle: res.maybeTitle };
}

// Parse a destination (+ optional title) on a definition continuation
// line. The line may be indented arbitrarily (spec example 193). Returns
// {dest, title, maybeTitle} or null.
function parseDestLine(content) {
  let i = 0;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return null;
  return parseDestAndTitle(content, i);
}

// A line consisting only of a link title (for a definition whose title is
// on the following line). The line may be indented arbitrarily (spec
// example 193). Returns the title string or null.
function parseTitleLine(content) {
  let i = 0;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return null;
  const q = content[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const closeQ = q === '(' ? ')' : q;
  let j = i + 1;
  let buf = '';
  while (j < content.length) {
    const c = content[j];
    if (c === '\\' && j + 1 < content.length && isAsciiPunct(content[j + 1])) { buf += content[j + 1]; j += 2; continue; }
    if (c === closeQ) {
      j++;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      return j >= content.length ? buf : null;
    }
    buf += c; j++;
  }
  return null;
}

// HTML block start conditions (CommonMark types 1-7). Returns the type
// (1-7) or 0 when the line does not start an HTML block. `inParagraph`
// matters only for type 7.
function htmlBlockType(content, inParagraph) {
  const s = content;
  // Type 1 starts with an OPENING script/pre/style/textarea tag only;
  // a closing tag such as </pre> is not an HTML block start.
  if (/^ {0,3}<(script|pre|style|textarea)([\s>]|$)/i.test(s)) return 1;
  if (/^ {0,3}<!--/.test(s)) return 2;
  if (/^ {0,3}<\?/.test(s)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(s)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(s)) return 5;
  if (/^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s\/>]|$)/i.test(s)) return 6;
  if (!inParagraph && /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>[ \t]*$/.test(s)) return 7;
  return 0;
}

function htmlBlockEnd(type, content) {
  if (type === 1) return /<\/(script|pre|style|textarea)>/i.test(content);
  if (type === 2) return /-->/.test(content);
  if (type === 3) return /\?>/.test(content);
  if (type === 4) return />/.test(content);
  if (type === 5) return /\]\]>/.test(content);
  return false; // types 6 and 7 end at a blank line
}

// Split a table row line into cells (unescaped pipes; optional outer pipes).
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableDelimRow(content) {
  const cells = splitTableRow(content);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!TABLE_DELIM_CELL.test(t)) return null;
    aligns.push(t.startsWith(':') ? (t.endsWith(':') ? 'center' : 'left') : (t.endsWith(':') ? 'right' : null));
  }
  return aligns;
}

function parseBlocks(src, refs) {
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const starts = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) { starts[i] = off; off += lines[i].length + 1; }

  const root = { type: 'document', children: [] };
  const stack = [root];
  let tip = null; // currently open leaf block, if any
  let pendingDef = null; // a definition awaiting its title on the next line
  let pendingLabel = null; // a definition awaiting its destination
  let looseMark = null; // {list} recorded at a blank line inside a list

  const top = () => stack[stack.length - 1];
  const addChild = (parent, node) => { parent.children.push(node); return node; };
  const closeLeaf = () => { tip = null; };
  // Close open blocks down to (but excluding) `keep` stack depth.
  const closeTo = (depth) => {
    while (stack.length > depth) stack.pop();
    tip = null;
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const cur = makeCursor(raw);

    // --- 1. Match open containers.
    let depth = 1; // stack index of the first container to match
    let allMatched = true;
    let col = 0;
    while (depth < stack.length) {
      const node = stack[depth];
      if (node.type === 'list') { depth++; continue; } // transparent
      if (node.type === 'blockquote') {
        const c2 = makeCursor(raw);
        c2.i = cur.i; c2.col = cur.col; c2.pend = cur.pend;
        curSkipSpaces(c2, 3);
        if (curPeek(c2) === '>') {
          curAdvance(c2, 1);
          if (curPeek(c2) === ' ' || curPeek(c2) === '\t') curAdvance(c2, 1);
          cur.i = c2.i; cur.col = c2.col; cur.pend = c2.pend;
          depth++;
          col = cur.col;
          continue;
        }
        allMatched = false;
        break;
      }
      if (node.type === 'item') {
        if (curIsBlank(cur)) {
          // A blank line consumes up to the item's content indent, so a
          // code block inside the item sees the remainder (usually '').
          curAdvance(cur, node.indent);
          depth++;
          col = cur.col;
          continue;
        }
        const rest = curRest(cur);
        const ind = indentOf(rest, cur.col);
        if (ind.col >= node.indent) {
          curAdvance(cur, node.indent);
          depth++;
          col = cur.col;
          continue;
        }
        allMatched = false;
        break;
      }
      break; // a leaf cannot be a container; stop
    }

    const content = curRest(cur);
    const contentBase = cur.col; // absolute column the content starts at
    const blank = isBlankLine(content);

    // --- 2. Container mismatch: lazy paragraph continuation or close.
    if (!allMatched) {
      const para = tip && tip.type === 'paragraph' ? tip : null;
      // A list-item line is never a lazy continuation when the paragraph
      // sits inside a list item: the item has ended and the line starts
      // a new item (an ordered list starting at 2 still opens a new
      // list here — the "cannot interrupt a paragraph" rule only binds
      // a paragraph at the same level).
      const listLine = BULLET_RE.test(content) || ORDERED_RE.test(content);
      const inItem = stack.some((n) => n.type === 'item');
      const lazy = para && !blank && !startsInterrupt(content, para) && !(listLine && inItem);
      if (lazy) {
        // Keep containers open; the line continues the paragraph. A
        // lazy line that looks like a setext underline cannot be one,
        // so it is kept as paragraph text with 4 spaces prepended.
        para.lines.push(SETEXT_RE.test(content) ? '    ' + content : content);
        continue;
      }
      // Close unmatched containers (and the open leaf).
      closeTo(depth);
    }
    if (blank) {
      // Blank line: it may end a pending definition (the label line
      // becomes paragraph text, spec example 199), is content inside
      // code blocks and HTML blocks of types 1-5, ends HTML blocks of
      // types 6-7, paragraphs and tables, and marks a list as loose.
      if (pendingLabel) {
        tip = addChild(top(), { type: 'paragraph', lines: [pendingLabel.raw] });
        pendingLabel = null;
      }
      if (pendingDef) pendingDef = null;
      if (tip && tip.type === 'code') {
        // A blank line inside fenced code keeps its content past the
        // fence's indentation; inside indented code it keeps the spaces
        // past the 4-column indent.
        tip.lines.push(tip.fenced ? stripIndent(content, tip.fenceIndent || 0, contentBase) : stripIndent(content, 4, contentBase));
        continue;
      }
      if (tip && tip.type === 'html') {
        if (tip.htmlType === 6 || tip.htmlType === 7) { tip.endedAtBlank = true; closeLeaf(); }
        else { tip.lines.push(content); tip.endLine = li; }
        continue;
      }
      if (tip && tip.type === 'paragraph') closeLeaf();
      if (tip && tip.type === 'table') closeLeaf();
      const listNode = findOpenList(stack);
      if (listNode) looseMark = listNode;
      continue;
    }

    // If a list was marked loose and this line continues it, mark it loose.
    // A blank line followed by a non-list block ends the list without
    // making it loose (the list's last item is not separated by a blank
    // line from anything inside the list).
    if (looseMark) {
      if (stack.indexOf(looseMark) >= 0) {
        const topNode = top();
        let continues = topNode.type === 'item';
        if (!continues && topNode === looseMark) {
          const bm = BULLET_RE.exec(content);
          const om = ORDERED_RE.exec(content);
          if (!looseMark.ordered && bm && bm[1] === looseMark.delim) continues = true;
          if (looseMark.ordered && om && om[2] === looseMark.delim) continues = true;
        }
        if (continues) looseMark.tight = false;
      }
      looseMark = null;
    }

    // --- 3. Open leaf blocks: fenced code, indented code, HTML block.
    if (tip && tip.type === 'code' && tip.fenced) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
      if (m && m[1][0] === tip.fenceChar && m[1].length >= tip.fenceLen) {
        closeLeaf();
        continue;
      }
      // Up to the opening fence's indentation is stripped from each line.
      tip.lines.push(stripIndent(content, tip.fenceIndent || 0, contentBase));
      continue;
    }
    if (tip && tip.type === 'code' && !tip.fenced) {
      const ind = indentOf(content, contentBase);
      if (!blank && ind.col >= 4) {
        tip.lines.push(sliceFromCol(content, 4, contentBase));
        continue;
      }
      if (blank) { tip.lines.push(''); continue; }
      closeLeaf();
      // fall through: reprocess this line as a new block
    }
    if (tip && tip.type === 'html') {
      if (tip.htmlType <= 5 ? htmlBlockEnd(tip.htmlType, content) : false) {
        // The line that ends the block is part of the block.
        tip.lines.push(content);
        tip.endLine = li;
        closeLeaf();
        continue;
      }
      tip.lines.push(content);
      tip.endLine = li;
      continue;
    }

    // --- 4. Open (or continue) blocks at this line.
    processContent(content, li, contentBase);
  }

  // Process one line's content as the start or continuation of blocks
  // inside the currently open containers. Called once per physical line
  // and recursively for a list item's or blockquote's first-line
  // remainder. Returns when the line is consumed.
  function processContent(content, lineIdx, base) {
    base = base || 0;
    // A definition awaiting its destination or title on this line.
    if (pendingLabel) {
      const res = parseDestLine(content);
      if (res) {
        const stored = !refs[pendingLabel.label];
        if (stored) refs[pendingLabel.label] = { dest: res.dest, title: res.title };
        if (res.maybeTitle && stored) pendingDef = { label: pendingLabel.label };
        pendingLabel = null;
        return;
      }
      // Not a destination: the label line becomes paragraph text.
      const rawLabel = pendingLabel.raw;
      pendingLabel = null;
      tip = addChild(top(), { type: 'paragraph', lines: [rawLabel] });
      // Fall through: this line follows that paragraph.
    }
    if (pendingDef) {
      const t = parseTitleLine(content);
      if (t !== null) {
        const rec = refs[pendingDef.label];
        if (rec) rec.title = decodeEntities(t);
        pendingDef = null;
        return;
      }
      pendingDef = null; // the definition stands without a title
    }
    // Setext heading: converts the open paragraph.
    if (tip && tip.type === 'paragraph') {
      const sm = SETEXT_RE.exec(content);
      if (sm) {
        const level = sm[1][0] === '=' ? 1 : 2;
        const text = tip.lines.join('\n').replace(/^[ \t]+|[ \t]+$/g, '');
        const parent = top();
        parent.children[parent.children.length - 1] = { type: 'heading', level, text };
        closeLeaf();
        return;
      }
      // Table: a one-line paragraph plus a delimiter row with the same
      // number of cells (marked allows a header without pipes). The
      // delimiter row itself must be indented at most 3 spaces.
      if (tip.lines.length === 1 && indentOf(content, base).col <= 3) {
        const aligns = isTableDelimRow(content);
        if (aligns) {
          const header = splitTableRow(tip.lines[0]);
          if (aligns.length === header.length) {
            const table = { type: 'table', header, aligns, rows: [] };
            const parent = top();
            parent.children[parent.children.length - 1] = table;
            tip = table;
            return;
          }
        }
      }
    }
    // A list open at the top is finished unless this line starts a new
    // item in it (the item is its own container; anything else belongs
    // to the list's parent). A line that is also a thematic break counts
    // as the break, not an item (the break is checked before lists).
    const isListItem = (BULLET_RE.test(content) || ORDERED_RE.test(content)) && !HR_RE.test(content);
    if (!isListItem) {
      while (top().type === 'list') stack.pop();
    }
    // Blockquote: open the container, then process the remainder.
    const bq = /^ {0,3}>/.exec(content);
    if (bq) {
      closeLeaf();
      const bqNode = addChild(top(), { type: 'blockquote', children: [] });
      stack.push(bqNode);
      const bc = makeCursor(content);
      curSkipSpaces(bc, 3);
      curAdvance(bc, 1); // '>'
      if (curPeek(bc) === ' ' || curPeek(bc) === '\t') curAdvance(bc, 1);
      const rest = curRest(bc);
      if (rest !== '' && !isBlankLine(rest)) processContent(rest, lineIdx, bc.col);
      return;
    }
    // ATX heading.
    const atx = ATX_RE.exec(content);
    if (atx) {
      closeLeaf();
      let text = content.slice(atx[0].length).replace(/^[ \t]+|[ \t]+$/g, '');
      text = text.replace(/[ \t]+#+$/, '');
      if (/^#+$/.test(text)) text = '';
      addChild(top(), { type: 'heading', level: atx[1].length, text });
      return;
    }
    // Fenced code.
    const fence = FENCE_RE.exec(content);
    if (fence) {
      closeLeaf();
      const info = content.slice(fence[0].length).trim();
      if (fence[1][0] === '`' && info.indexOf('`') >= 0) {
        // A backtick fence cannot carry backticks in its info string:
        // treat the line as paragraph text.
      } else {
        tip = addChild(top(), { type: 'code', fenced: true, fenceChar: fence[1][0], fenceLen: fence[1].length, info, fenceIndent: indentOf(content, base).col, lines: [] });
        return;
      }
    }
    // HTML block.
    const inPara = !!(tip && tip.type === 'paragraph');
    const htype = htmlBlockType(content, inPara);
    if (htype) {
      closeLeaf();
      tip = addChild(top(), { type: 'html', htmlType: htype, lines: [content], startLine: lineIdx, endLine: lineIdx, endedAtBlank: false });
      if (htype <= 5 && htmlBlockEnd(htype, content)) closeLeaf();
      return;
    }
    // Thematic break.
    if (HR_RE.test(content)) {
      closeLeaf();
      addChild(top(), { type: 'hr' });
      return;
    }
    // List item: open it, then process the remainder as its first content.
    const opened = tryOpenList(content, stack, tip, base);
    if (opened !== null) {
      closeLeaf();
      if (opened.rest !== '' && !isBlankLine(opened.rest)) processContent(opened.rest, lineIdx, opened.base);
      return;
    }
    // Indented code (cannot interrupt a paragraph).
    if (!tip || tip.type !== 'paragraph') {
      const ind = indentOf(content, base);
      if (ind.col >= 4) {
        closeLeaf();
        tip = addChild(top(), { type: 'code', fenced: false, info: '', lines: [sliceFromCol(content, 4, base)] });
        return;
      }
    }
    // Table row continuation.
    if (tip && tip.type === 'table') {
      tip.rows.push(splitTableRow(content));
      return;
    }
    // Paragraph start / continuation.
    if (tip && tip.type === 'paragraph') {
      tip.lines.push(content);
      return;
    }
    // New paragraph: first consume any link reference definitions.
    const def = tryParseRefDef(content);
    if (def) {
      if (def.awaitingDest) {
        pendingLabel = def;
      } else {
        const stored = !refs[def.label];
        if (stored) refs[def.label] = { dest: def.dest, title: def.title };
        if (def.maybeTitle && stored) pendingDef = { label: def.label };
      }
      closeLeaf();
      return;
    }
    tip = addChild(top(), { type: 'paragraph', lines: [content] });
  }

  // Finalise: drop trailing blank lines from code blocks (marked's code
  // text is the lines joined with '\n' plus a trailing '\n', or '' when
  // nothing remains), and compute each HTML block's raw text from its
  // container-stripped lines. An HTML block's text carries a trailing
  // '\n' unless it ended at a blank line (types 6-7) or the source ends
  // without one at the block's last line.
  const walk = (node) => {
    if (node.type === 'code') {
      // Trailing blank lines are dropped. Fenced code drops only truly
      // empty lines (a line of spaces is kept, spec example 129);
      // indented code drops any trailing whitespace-only line.
      if (node.fenced) {
        while (node.lines.length && node.lines[node.lines.length - 1] === '') node.lines.pop();
      } else {
        while (node.lines.length && /^[ \t]*$/.test(node.lines[node.lines.length - 1])) node.lines.pop();
      }
    }
    if (node.type === 'html') {
      let text = node.lines.join('\n');
      // A trailing '\n' is kept unless the following line is blank (a
      // blank line, or a blockquote marker followed by nothing) or the
      // block is the document's last line and the source ends without one.
      const next = node.endLine + 1 < lines.length ? lines[node.endLine + 1] : null;
      const nextBlank = next !== null && (isBlankLine(next) || /^ {0,3}>[ \t]*$/.test(next));
      const atEofNoNl = next === null && !src.endsWith('\n');
      if (!nextBlank && !atEofNoNl) text += '\n';
      node.text = text;
    }
    if (node.children) node.children.forEach(walk);
  };
  walk(root);
  return root.children;
}

function findOpenList(stack) {
  for (let i = stack.length - 1; i >= 1; i--) {
    if (stack[i].type === 'list') return stack[i];
    if (stack[i].type === 'item') continue;
    return null;
  }
  return null;
}

// Whether `content` starts a block that can interrupt a paragraph (used to
// decide lazy continuation).
function startsInterrupt(content, para) {
  if (ATX_RE.test(content)) return true;
  if (FENCE_RE.test(content)) return true;
  if (htmlBlockType(content, true) > 0) return true;
  if (HR_RE.test(content)) return true;
  const bm = BULLET_RE.exec(content) || ORDERED_RE.exec(content);
  if (bm) {
    // A list interrupts a paragraph only when its first item is non-empty
    // (bullets) or starts at 1 (ordered).
    const after = content.slice(bm[0].length);
    if (after.trim() === '') return false;
    if (ORDERED_RE.test(content)) {
      const num = parseInt(ORDERED_RE.exec(content)[1], 10);
      return num === 1;
    }
    return true;
  }
  return false;
}

// Try to open a list item at `content`. Returns the item's first-line
// remainder (to be processed as the item's first content) when a list item
// was opened, or null when the line is not a list item. `stack` and `tip`
// are the parser's, for the paragraph-interrupt rule and for finding the
// list to continue.
function tryOpenList(content, stack, tip, base) {
  base = base || 0;
  let m = BULLET_RE.exec(content);
  let ordered = false;
  let markerText = '';
  let delim = '';
  let startNum = 1;
  if (m) {
    markerText = m[1];
  } else {
    m = ORDERED_RE.exec(content);
    if (!m) return null;
    ordered = true;
    startNum = parseInt(m[1], 10);
    delim = m[2];
    markerText = m[1] + m[2];
  }
  // A list interrupts a paragraph only under the usual conditions.
  if (tip && tip.type === 'paragraph') {
    const after = content.slice(m[0].length);
    if (after.trim() === '') return null;
    if (ordered && startNum !== 1) return null;
  }
  // Columns: the marker sits after up to 3 spaces of indentation.
  const markerCol = indentOf(content, base).col;
  const markerEndCol = markerCol + markerText.length;
  // The whitespace after the marker, counted in columns (tab-aware,
  // measured from the absolute column).
  let col = markerEndCol;
  let j = markerCol + markerText.length;
  let spaces = 0;
  while (j < content.length && (content[j] === ' ' || content[j] === '\t') && spaces < 5) {
    const w = content[j] === '\t' ? 4 - ((base + col) % 4) : 1;
    col += w; spaces += w; j++;
  }
  const afterSpaces = content.slice(j);
  let indent;
  if (afterSpaces.trim() === '') {
    // Empty item: its content starts one space after the marker.
    indent = markerEndCol + 1;
    openItem(stack, ordered, startNum, ordered ? delim : markerText, indent, '', base + markerCol);
    return { rest: '', base };
  }
  if (spaces >= 1 && spaces <= 4) {
    indent = markerEndCol + spaces;
  } else {
    // 5+ spaces: the content starts one space after the marker.
    indent = markerEndCol + 1;
  }
  const rest = openItem(stack, ordered, startNum, ordered ? delim : markerText, indent, sliceFromCol(content, indent, base), base + markerCol);
  return { rest, base: base + indent };
}

// Create (or continue) the list and append a new item to it. `remainder`
// is the item's first-line content. Whether this is a sibling item or a
// nested list is decided by the marker's absolute column against the
// parent list's marker column: the same column continues the list, a
// deeper column nests under the open item.
function openItem(stack, ordered, startNum, wantDelim, indent, remainder, absMarkerCol) {
  const topNode = stack[stack.length - 1];
  let parent;
  let existingList = null;
  if (topNode.type === 'item') {
    const p = stack[stack.length - 2];
    if (p && p.type === 'list' && absMarkerCol === p.markerCol) {
      stack.pop(); // sibling: close the current item, reuse its list
      existingList = p;
      parent = stack[stack.length - 2];
    } else {
      parent = topNode; // nested list under the open item
    }
  } else if (topNode.type === 'list') {
    existingList = topNode;
    parent = stack[stack.length - 2];
  } else {
    parent = topNode;
  }
  let list = null;
  if (existingList && existingList.ordered === ordered && existingList.delim === wantDelim) list = existingList;
  if (!list) {
    list = { type: 'list', ordered, start: startNum, delim: wantDelim, tight: true, children: [], markerCol: absMarkerCol };
    parent.children.push(list);
    stack.push(list);
  }
  const item = { type: 'item', indent, children: [] };
  list.children.push(item);
  stack.push(item);
  return remainder;
}

// ---------------------------------------------------------------- rendering

function renderInline(text, refs) {
  return renderItems(parseInline(text, refs));
}

function renderBlocks(nodes, refs) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, refs);
  return out;
}

function renderBlock(node, refs) {
  switch (node.type) {
    case 'heading':
      return '<h' + node.level + '>' + renderInline(node.text, refs) + '</h' + node.level + '>\n';
    case 'paragraph':
      return '<p>' + renderInline(node.lines.join('\n'), refs) + '</p>\n';
    case 'code': {
      const text = node.lines.length ? node.lines.join('\n') + '\n' : '';
      // The info string's backslash escapes are decoded (`` ``` foo\+bar ``
      // gives language "foo+bar"); the first word is the language.
      const lang = node.info ? node.info.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1').split(/\s+/)[0] : '';
      const cls = lang ? ' class="language-' + escAttr(lang) + '"' : '';
      return '<pre><code' + cls + '>' + escText(text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(node.children, refs) + '</blockquote>\n';
    case 'hr':
      return '<hr>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let s = '<' + tag + start + '>\n';
      for (const item of node.children) if (item.type === 'item') s += renderItem(item, node.tight, refs);
      return s + '</' + tag + '>\n';
    }
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.header.length; i++) {
        const a = node.aligns[i] ? ' align="' + node.aligns[i] + '"' : '';
        s += '<th' + a + '>' + renderInline(node.header[i], refs) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (node.rows.length) {
        s += '<tbody>';
        for (const row of node.rows) {
          s += '<tr>\n';
          for (let i = 0; i < node.header.length; i++) {
            const cell = i < row.length ? row[i] : '';
            const a = node.aligns[i] ? ' align="' + node.aligns[i] + '"' : '';
            s += '<td' + a + '>' + renderInline(cell, refs) + '</td>\n';
          }
          s += '</tr>\n';
        }
        s += '</tbody>';
      }
      return s + '</table>\n';
    }
  }
  return '';
}

// A list item. In a tight list a paragraph renders as bare inline text;
// in a loose list it keeps its <p> tags. A leading "[ ] " / "[x] "
// becomes a disabled checkbox, inside the <p> for loose lists.
function renderItem(item, tight, refs) {
  let s = '<li>';
  const kids = item.children;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.type === 'paragraph') {
      let text = child.lines.join('\n');
      let checkbox = '';
      if (i === 0) {
        const tm = /^\[([ xX])\] +/.exec(text);
        if (tm) {
          checkbox = '<input' + (tm[1] !== ' ' ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
          text = text.slice(tm[0].length);
        }
      }
      if (tight) s += checkbox + renderInline(text, refs);
      else s += '<p>' + checkbox + renderInline(text, refs) + '</p>\n';
    } else {
      s += renderBlock(child, refs);
    }
  }
  return s + '</li>\n';
}
