// parse.js — a fast drop-in replacement for marked 18.1.3's marked.parse,
// with marked's default options (gfm on, breaks off, pedantic off, async off).
// Written in-session from the CommonMark 0.31.2 and GFM 0.29 specifications,
// verified against marked's observable output with a black-box probe oracle.
// No marked source was copied: every line below was authored here.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = Object.create(null);
  docInLink = false;
  const blocks = parseBlocks(src, refs);
  return renderBlocks(blocks, refs);
}

// Document-level GFM-autolink suppression, mirroring marked's lexer
// state: an unclosed <a ...> tag (inline HTML matching /^<a /i) sets
// this for the rest of the document, and only a literal </a> clears
// it. While set, no GFM autolink (URL or e-mail) is formed anywhere
// — markdown links, emphasis and code spans are unaffected. Link and
// image text parsing saves and restores it (marked's De does the
// same), so a tag inside link text does not leak out.
let docInLink = false;

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
// one space, case-fold. The lower-upper-lower round trip is marked's
// folding: it maps ẞ to ss (ß uppercases to SS) where a plain
// toLowerCase would leave ß unmatched against an SS label.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
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
    // A backslash-newline is a hard break only when non-whitespace
    // follows it (marked's br rule carries a (?!\s*$) lookahead).
    if (cc === 92) { // backslash
      const nx = s[i + 1];
      if (nx === '\n' && !restIsAllWs(s, i + 2)) { flushText(i); items.push({ k: 'br' }); i += 2; while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; textStart = i; continue; }
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
    // Emphasis / strikethrough delimiter runs. A leading `_` can also
    // start a bare e-mail address (_a@b.co links whole in marked), so
    // try the e-mail match before treating it as a delimiter.
    if (cc === 42 || cc === 95 || cc === 126) { // * _ ~
      if (cc === 95 && !inLink && !docInLink) {
        const em = tryGfmEmail(s, i);
        if (em) {
          flushText(i);
          items.push(em.item);
          i = em.end;
          textStart = i;
          continue;
        }
      }      const ch = c;
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
        if (got.item.k === 'html') {
          const tag = got.item.s;
          if ((tag[1] === 'a' || tag[1] === 'A') && tag[2] === ' ') docInLink = true;
          else if (tag[1] === '/' && (tag[2] === 'a' || tag[2] === 'A') && tag[3] === '>') docInLink = false;
        }
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
    // or soft break. After a hard break the next line's leading spaces
    // and tabs are stripped; a hard break at the very end of the text
    // (only whitespace follows) is not a break at all.
    if (cc === 10) { // \n
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && s[k] === ' ') { spaces++; k--; }
      if (spaces >= 2 && !restIsAllWs(s, i + 1)) {
        flushText(k + 1);
        items.push({ k: 'br' });
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      flushText(i);
      items.push({ k: 't', s: '\n' });
      i++;
      textStart = i;
      continue;
    }
    // GFM extended autolinks: www. / http(s):// / ftp:// / mailto: /
    // xmpp: / bare e-mail. Suppressed inside a link's text and while
    // an unclosed <a> tag leaks inLink across the document. The
    // boundary rules differ per form (probed against marked): schemes
    // link anywhere, www. needs a boundary (start, whitespace, or one
    // of ( * _ ~ [) or a fresh token position, mailto:/xmpp: need a
    // non-alphanumeric before them, and bare e-mail matches wherever
    // its pattern starts.
    if (!inLink && !docInLink && ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 46 || cc === 43 || cc === 45)) {
      const fresh = textStart === i && (items.length === 0 || items[items.length - 1].k !== 't');
      const got = tryGfmAutolink(s, i, fresh);
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
    i++;
  }
  flushText(n);
  processEmphasis(items, delims);
  return items;
}

// Is s[from..] only whitespace (spaces, tabs, newlines and the other
// ASCII whitespace characters)?
function restIsAllWs(s, from) {
  for (let q = from; q < s.length; q++) {
    const ch = s[q];
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f' && ch !== '\v') return false;
  }
  return true;
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
// skipping backslash escapes). Backticks follow marked's label
// pattern: a backtick run must form a complete code span (the closing
// run need not match the opening run's length) or sit immediately
// before the closing `]` — an unclosed backtick anywhere else makes
// the whole label fail. The span closer is backtracked: the first
// (shortest-content) closer is tried first, then later ones.
function findLinkEnd(s, open) {
  return scanLabel(s, open + 1, 1);
}

function scanLabel(s, i, depth) {
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) { i += 2; continue; }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      // Try each later backtick run as the span closer, shortest
      // content first.
      let k = j;
      while (k < n) {
        const nb = s.indexOf('`', k);
        if (nb < 0) break;
        let m = nb;
        while (m < n && s[m] === '`') m++;
        const r = scanLabel(s, m, depth);
        if (r >= 0) return r;
        k = m;
      }
      // No span closer worked: the run is only valid immediately
      // before a ] when it is TWO or more backticks (marked's
      // alternative is `` ``+(?=\]) `` — a single backtick there
      // fails the whole label).
      if (j - i >= 2 && j < n && s[j] === ']') {
        depth--;
        if (depth === 0) return j;
        i = j + 1;
        continue;
      }
      return -1;
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
  const wsBeforeTitle = i;
  i = skipWs(s, i);
  let title = null;
  if (i < n && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    // A title needs whitespace before it: ](dest"title") is not a link.
    if (i === wsBeforeTitle) return null;
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
    if (text[i] === '!' && text[i + 1] === '[') {
      // A formed image is not a link: skip past it, so its label
      // (e.g. the [6] in ![command][6]) is not mistaken for one.
      const img = tryLink(text, i + 1, refs, true);
      if (img) { i = img.end - 1; continue; }
    }
    if (text[i] === '[' && text[i - 1] !== '!') {
      if (tryLink(text, i, refs, false)) return true;
    }
  }
  return false;
}

// Does `label` contain an unescaped `[`? Link reference labels (and
// shortcut labels) may not: marked's label pattern excludes `[`, so a
// label like ref[bar] can never match a definition — and a definition
// with such a label is not a definition at all.
function labelHasBracket(label) {
  return label.replace(/\\[\s\S]/g, '').indexOf('[') >= 0;
}

// Does a <...> tag or autolink starting inside the link text at
// s[from..to] run past the text's end? When it does, the `]` that
// seemed to close the text is inside the tag, and marked rejects the
// whole link (its Be check). Code spans and backslash escapes are
// skipped while scanning for `<`.
function linkTextHasRunawayTag(s, from, to) {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const len = j - i;
      const close = findCodeClose(s, j, len);
      if (close < 0) { i = j; continue; }
      i = close + len;
      continue;
    }
    if (c === '<') {
      const got = tryAngle(s, i);
      if (got && got.end > to) return true;
      if (got) { i = got.end; continue; }
    }
    i++;
  }
  return false;
}

function tryLink(s, open, refs, isImg) {
  const close = findLinkEnd(s, open);
  if (close < 0) return null;
  const rawText = s.slice(open + 1, close);
  if (linkTextHasRunawayTag(s, open + 1, close)) return null;
  if (!isImg && containsLink(rawText, refs)) return null;
  let dest = null;
  let title = null;
  let end = close + 1;
  const after = s[end];
  if (after === '(') {
    // Inline link — but if the tail fails to parse, fall back to the
    // shortcut reference lookup below ([foo](not a link) with a [foo]
    // definition links to the definition, tail left literal).
    const tail = parseLinkTail(s, end);
    if (tail) {
      dest = tail.dest;
      title = tail.title;
      end = tail.end;
    }
  } else if (after === '[') {
    // Full or collapsed reference. When the second label is present
    // and well-formed but has no definition, marked does NOT fall back
    // to the shortcut: it emits just the `[` and moves on ([foo][bar]
    // with [foo] defined but [bar] not stays literal for foo). Only a
    // malformed second label (no closing ], or an unescaped [ inside
    // it) falls through to the shortcut lookup below.
    const lblEnd = s.indexOf(']', end + 1);
    if (lblEnd >= 0) {
      const label = s.slice(end + 1, lblEnd);
      if (!labelHasBracket(label)) {
        if (label === '') {
          // Collapsed reference: the label is the link text.
          const key = normLabel(rawText);
          const ref = refs[key];
          if (ref) {
            dest = ref.dest;
            title = ref.title;
            end = lblEnd + 1;
          }
        } else {
          const ref = refs[normLabel(label)];
          if (ref) {
            dest = ref.dest;
            title = ref.title;
            end = lblEnd + 1;
          } else {
            return null; // well-formed full reference, no definition
          }
        }
      }
    }
  }
  if (dest === null) {
    if (labelHasBracket(rawText)) return null;
    const key = normLabel(rawText);
    const ref = refs[key];
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = close + 1;
  }
  dest = decodeEntities(dest);
  if (title !== null) title = decodeEntities(title);
  if (isImg) {
    // The alt text is the link text parsed as normal inline content
    // (links and images inside it do parse) and then stripped of tags
    // — an inner image contributes its own alt text. A tag inside the
    // alt text must not leak docInLink out (marked's De restores it).
    const savedDocInLink = docInLink;
    const altKids = parseInline(rawText, refs, false);
    docInLink = savedDocInLink;
    const alt = stripTags(renderItems(altKids));
    return { item: { k: 'img', src: encodeHref(dest), title: title === null ? null : escAttr(title), alt: escAttr(alt) }, end };
  }
  const savedDocInLink = docInLink;
  const kids = parseInline(rawText, refs, true);
  docInLink = savedDocInLink;
  return { item: { k: 'link', href: encodeHref(dest), title: title === null ? null : escAttr(title), kids }, end };
}

function stripTags(html) {
  return html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, '');
}

// Try <...> at position i: autolink, e-mail autolink, or raw HTML.
// Returns {item, end} or null.
function tryAngle(s, i) {
  const n = s.length;
  // Comment, processing instruction, declaration, CDATA. <!--> and
  // <!---> are complete comments (abrupt closing) in marked.
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { item: { k: 'html', s: '<!-->' }, end: i + 5 };
    if (s.startsWith('<!--->', i)) return { item: { k: 'html', s: '<!--->' }, end: i + 6 };
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
  // Closing tags take no attributes (</a href="foo"> is literal text);
  // opening tags do.
  if (s.startsWith('</', i)) {
    const m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s.slice(i));
    if (m) return { item: { k: 'html', s: m[0] }, end: i + m[0].length };
  } else if (/[A-Za-z]/.test(s[i + 1] || '')) {
    const m = /^<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(s.slice(i));
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

// GFM extended autolinks, as marked implements them (probed).
// Schemes http/https/ftp are matched case-insensitively per letter;
// www. must be lowercase. The host is one or more alnum/hyphen labels
// (a dot is NOT required: www.foo links), then any run of non-space,
// non-< characters. The e-mail pattern's trailing (?![\w-]) lookahead
// is what makes a.b-c_d@a.b- stay literal while a.b-c_d@a.b. links.
const GFM_SCHEME_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/;
const GFM_WWW_RE = /^www\.(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/;
const GFM_EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const GFM_MAILTO_RE = /^(?:mailto:|xmpp:)[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?/;
// Trailing-punctuation trim for autolinks (marked's "backpedal"):
// the kept prefix is built from safe chunks — runs of characters that
// are not trailing punctuation, balanced (...) groups, and & not
// starting an &name; entity at the very end — plus punctuation runs
// that are not at the end. Applied repeatedly until stable, it drops
// trailing ?!.,:;*_'\"~ and unbalanced ) while keeping ] } and
// balanced parens, and drops a trailing &name; whole.
const GFM_BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

function trimAutolinkEnd(url) {
  let prev;
  do {
    prev = url;
    const m = GFM_BACKPEDAL_RE.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return url;
}

// GFM extended autolink at position i. `fresh` says the position
// follows a non-text token (a code span, link, tag, break or delimiter
// run), which counts as a word boundary for www. Returns {item, end}
// or null.
function tryGfmAutolink(s, i, fresh) {
  const rest = s.slice(i);
  const prev = i > 0 ? s[i - 1] : '';
  // mailto: / xmpp: (lowercase only) need a non-alphanumeric before
  // them, so xmailto: is not a scheme (its bare e-mail still links).
  if ((rest.startsWith('mailto:') || rest.startsWith('xmpp:')) && (prev === '' || !/[A-Za-z0-9]/.test(prev))) {
    const m = GFM_MAILTO_RE.exec(rest);
    if (m) {
      const url = trimAutolinkEnd(m[0]);
      if (url) return { item: { k: 'link', href: encodeHref(url), title: null, kids: [{ k: 't', s: escText(url) }] }, end: i + url.length };
    }
  }
  // http(s):// and ftp:// link anywhere, even mid-word (xhttp://...).
  let m = GFM_SCHEME_RE.exec(rest);
  if (m) {
    const url = trimAutolinkEnd(m[0]);
    if (url) return { item: { k: 'link', href: encodeHref(url), title: null, kids: [{ k: 't', s: escText(url) }] }, end: i + url.length };
  }
  // www. needs a boundary: start, whitespace, ( * _ ~ [, or a fresh
  // token position. After " ! . : / { } ; and the like it stays text.
  if (rest.startsWith('www.') && (fresh || prev === '' || prev === ' ' || prev === '\t' || prev === '\n' || prev === '(' || prev === '*' || prev === '_' || prev === '~' || prev === '[')) {
    m = GFM_WWW_RE.exec(rest);
    if (m) {
      const url = trimAutolinkEnd(m[0]);
      if (url) return { item: { k: 'link', href: encodeHref('http://' + url), title: null, kids: [{ k: 't', s: escText(url) }] }, end: i + url.length };
    }
  }
  return tryGfmEmail(s, i);
}

// Bare e-mail autolink at position i. The pattern itself rejects a
// trailing - or _ (the (?![\w-]) lookahead), so a.b-c_d@a.b- is literal.
function tryGfmEmail(s, i) {
  const m = GFM_EMAIL_RE.exec(s.slice(i));
  if (m) {
    const email = m[0];
    return { item: { k: 'link', href: 'mailto:' + email, title: null, kids: [{ k: 't', s: escText(email) }] }, end: i + email.length };
  }
  return null;
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
        if (ch === '~') {
          // Strikethrough only pairs runs of the SAME length, 1 or 2:
          // ~~a~ and ~~~a~~~ stay literal in marked.
          if (cand.n !== closer.n || cand.n > 2) { oi--; continue; }
        } else if ((cand.open && cand.close) || (closer.open && closer.close)) {
          // Odd-match rule: if EITHER delimiter can both open and close,
          // the sum of the two runs must not be a multiple of 3 unless
          // both are multiples of 3 (spec rule 10).
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
    if (ch === '~') use = opener.n;
    else use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const tag = ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    wrapDelimiters(items, opener, closer, tag, use);
    // Delimiter runs strictly between the opener and closer lose their
    // ability to open (they can still close): *foo _bar* baz_ leaves
    // the _ pair literal because the _bar opener was deactivated.
    const oiPos = delims.indexOf(opener);
    const ciPos = delims.indexOf(closer);
    if (oiPos >= 0 && ciPos > oiPos) {
      for (let k = oiPos + 1; k < ciPos; k++) delims[k].open = false;
    }
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
// Does the cursor's remainder start with whitespace containing a tab?
// Used to find the outermost container whose strip exposes a leading
// tab: marked expands such tabs (from that level's columns) before
// lexing the content, so the expansion base is the cursor column
// before that strip.
function restHasLeadingTab(c) {
  let k = c.i;
  while (k < c.s.length && (c.s[k] === ' ' || c.s[k] === '\t')) {
    if (c.s[k] === '\t') return true;
    k++;
  }
  return false;
}
// The cursor's remainder with leading tabs expanded to spaces, as
// marked does when it extracts a container's content. `expandBase`
// is the cursor column before the outermost strip that exposed a
// leading tab (null when no container strip exposed one, in which
// case the text is returned untouched — top-level lines keep their
// literal tabs). Expansion starts at column (cur.col - expandBase):
// the content's first character in the expansion level's text.
function expandContent(cur, expandBase) {
  const content = curRest(cur);
  if (expandBase === null) return content;
  let i = 0;
  let hasTab = false;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) {
    if (content[i] === '\t') { hasTab = true; break; }
    i++;
  }
  if (!hasTab) return content;
  let col = cur.col - expandBase;
  let out = '';
  let j = 0;
  while (j < content.length && (content[j] === ' ' || content[j] === '\t')) {
    if (content[j] === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else { out += ' '; col++; }
    j++;
  }
  return out + content.slice(j);
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

// Strip up to n leading whitespace CHARACTERS (spaces or tabs, each
// counting as one) from a fenced code line. Only backtick fences strip
// (marked's indentCodeCompensation); tilde fences keep every line
// untouched. `strip` is false for tilde fences.
function stripFenceIndent(text, n, strip) {
  if (!strip || n <= 0) return text;
  let i = 0;
  while (i < text.length && i < n && (text[i] === ' ' || text[i] === '\t')) i++;
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
  const wsBeforeTitle = i;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  let title = null;
  let maybeTitle = false;
  if (i < s.length) {
    const q = s[i];
    if (q === '"' || q === "'" || q === '(') {
      // A title needs whitespace before it: [foo]: <bar>(baz) is not
      // a definition.
      if (i === wsBeforeTitle) return null;
      const closeQ = q === '(' ? ')' : q;
      let j = i + 1;
      let buf = '';
      let ok = false;
      while (j < s.length) {
        const c = s[j];
        if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { buf += s[j + 1]; j += 2; continue; }
        if (c === closeQ) { ok = true; break; }
        if (q === '(' && c === '(') return null;
        buf += c; j++;
      }
      if (!ok) {
        // Unterminated title: it may close on a following line (the
        // definition stays pending until it does).
        return { dest: decodeEntities(dest), titlePartial: { quote: q, text: buf }, maybeTitle: false, end: i };
      }
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
// {label, dest, title, maybeTitle} for a complete definition,
// {label, awaitingDest, raw} when the label and colon are present but
// the destination is on a following line (spec examples 193/195/198),
// {label, dest, titlePartial, raw} when the destination parsed but the
// title runs onto following lines, {labelPartial, raw} when the label
// itself spans lines and has not closed yet, or null when the line is
// not a definition. A label containing an unescaped `[` is never a
// definition (marked's label pattern excludes `[`).
function tryParseRefDef(content) {
  const m = /^ {0,3}\[/.exec(content);
  if (!m) return null;
  const openIdx = m[0].length - 1; // index of the '['
  let j = openIdx + 1;
  let closeIdx = -1;
  while (j < content.length) {
    const ch = content[j];
    if (ch === '\\' && j + 1 < content.length) { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') { closeIdx = j; break; }
    j++;
  }
  if (closeIdx < 0) return { labelPartial: true, raw: content };
  const label = content.slice(openIdx + 1, closeIdx);
  if (label.trim() === '') return null;
  let i = closeIdx + 1;
  if (content[i] !== ':') return null;
  i++;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return { label: normLabel(label), awaitingDest: true, raw: [content] };
  const res = parseDestAndTitle(content, i);
  if (!res) return null;
  if (res.titlePartial) return { label: normLabel(label), dest: res.dest, titlePartial: res.titlePartial, raw: [content] };
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
// example 193). Returns the title string, {partial: {quote, text}} when
// the title runs onto a following line, or null when the line is not a
// title.
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
    if (q === '(' && c === '(') return null;
    buf += c; j++;
  }
  return { partial: { quote: q, text: buf } };
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
  // Type 7: a complete open or close tag alone on its line. Closing
  // tags take no attributes (</a href="foo"> is not an HTML block).
  if (!inParagraph && /^ {0,3}<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>[ \t]*$/.test(s)) return 7;
  if (!inParagraph && /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.test(s)) return 7;
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
  let pendingLabel = null; // a definition awaiting its destination ({label, raw: [lines]})
  let pendingLabelPartial = null; // a definition whose label spans lines ({parts: [lines]})
  let pendingTitle = null; // a definition whose title spans lines ({label, dest, quote, buf, rawLines})
  // Snapshot of the container stack at the most recent structural blank
  // line. A list (or an item's parent list) that is still open when the
  // next block starts inside it becomes loose — but only the lists the
  // blank line actually passed through, so a blank inside a nested list
  // leaves the outer list tight.
  let blankStack = null;
  // Set when the current line was consumed entirely as link reference
  // definition material (no block created): a definition line does not
  // consume a pending blank line's loose-marking effect.
  let lineWasDef = false;

  const top = () => stack[stack.length - 1];
  const addChild = (parent, node) => {
    parent.children.push(node);
    // A blank line passed through this item and it already had a child:
    // the blank separates two blocks inside the item, so the parent
    // list is loose.
    if (blankStack && parent.type === 'item' && blankStack.indexOf(parent) >= 0 && parent.children.length > 1) {
      const list = stack[stack.indexOf(parent) - 1];
      if (list && list.type === 'list') list.tight = false;
    }
    return node;
  };
  const closeLeaf = () => { tip = null; };
  // Close open blocks down to (but excluding) `keep` stack depth.
  const closeTo = (depth) => {
    while (stack.length > depth) stack.pop();
    tip = null;
  };

  // Match the open containers against `raw`. Returns {depth, allMatched,
  // cur, blankNodes}: `depth` is the stack index where matching stopped
  // (or stack.length when everything matched), `cur` the cursor at that
  // point (its rest is the line's content there), and `blankNodes` the
  // containers whose remainder after matching is blank — a blank line
  // only separates blocks in those containers (a `>` line is blank
  // inside its blockquote, but not inside the enclosing list item).
  function matchContainers(raw) {
    const cur = makeCursor(raw);
    let depth = 1; // stack index of the first container to match
    let allMatched = true;
    const blankNodes = [];
    // Cursor column before the outermost strip that exposed a leading
    // tab in the remainder (null when none did). Drives expandContent.
    let expandBase = null;
    if (curIsBlank(cur)) blankNodes.push(stack[0]);
    while (depth < stack.length) {
      const node = stack[depth];
      if (node.type === 'list') {
        if (curIsBlank(cur)) blankNodes.push(node);
        depth++;
        continue;
      } // transparent
      if (node.type === 'blockquote') {
        const c2 = makeCursor(raw);
        c2.i = cur.i; c2.col = cur.col; c2.pend = cur.pend;
        curSkipSpaces(c2, 3);
        if (curPeek(c2) === '>') {
          const colBefore = cur.col;
          curAdvance(c2, 1);
          if (curPeek(c2) === ' ' || curPeek(c2) === '\t') curAdvance(c2, 1);
          cur.i = c2.i; cur.col = c2.col; cur.pend = c2.pend;
          if (expandBase === null && restHasLeadingTab(cur)) expandBase = colBefore;
          if (curIsBlank(cur)) blankNodes.push(node);
          depth++;
          continue;
        }
        allMatched = false;
        break;
      }
      if (node.type === 'item') {
        if (curIsBlank(cur)) {
          // A blank line consumes up to the item's content indent, so a
          // code block inside the item sees the remainder (usually '').
          const colBefore = cur.col;
          curAdvance(cur, node.indent);
          if (expandBase === null && restHasLeadingTab(cur)) expandBase = colBefore;
          blankNodes.push(node);
          depth++;
          continue;
        }
        const rest = curRest(cur);
        const ind = indentOf(rest, cur.col);
        if (ind.col >= node.indent) {
          const colBefore = cur.col;
          curAdvance(cur, node.indent);
          if (expandBase === null && restHasLeadingTab(cur)) expandBase = colBefore;
          if (curIsBlank(cur)) blankNodes.push(node);
          depth++;
          continue;
        }
        allMatched = false;
        break;
      }
      break; // a leaf cannot be a container; stop
    }
    return { depth, allMatched, cur, blankNodes, expandBase };
  }

  // Look ahead from the blank line at `li` to the next non-blank line.
  // Returns null at EOF, else {blanks, depth, allMatched, content,
  // contentBase, isCodeLine, isSiblingItem}. Decides whether a blank
  // after a code-merged line is absorbed into the paragraph (the next
  // line is a code line inside the same item) or ends it.
  function lookAheadFrom(li) {
    let j = li + 1;
    while (j < lines.length && isBlankLine(lines[j])) j++;
    if (j >= lines.length) return null;
    const blanks = j - li;
    const { depth, allMatched, cur, expandBase } = matchContainers(lines[j]);
    const content = expandContent(cur, expandBase);
    const contentBase = cur.col;
    // A code line inside the same item: all containers matched and the
    // content starts with 4+ columns of indentation.
    const isCodeLine = allMatched && indentOf(content, contentBase).col >= 4;
    // A sibling item: matching stopped at an item whose parent list the
    // line's marker continues (same column, same ordered/delim).
    let isSiblingItem = false;
    if (!allMatched && stack[depth] && stack[depth].type === 'item') {
      const list = stack[depth - 1];
      if (list && list.type === 'list') {
        const bm = BULLET_RE.exec(content);
        const om = !bm && ORDERED_RE.exec(content);
        if (bm || om) {
          const markerCol = contentBase + indentOf(content, contentBase).col;
          const ordered = !!om;
          const delim = ordered ? om[2] : bm[1];
          if (markerCol === list.markerCol && list.ordered === ordered && list.delim === delim) isSiblingItem = true;
        }
      }
    }
    return { blanks, depth, allMatched, content, contentBase, isCodeLine, isSiblingItem };
  }

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];

    // --- 1. Match open containers.
    const { depth, allMatched, cur, blankNodes, expandBase } = matchContainers(raw);

    const content = expandContent(cur, expandBase);
    const contentBase = cur.col; // absolute column the content starts at
    const blank = isBlankLine(content);

    // --- 2. Container mismatch: lazy leaf continuation or close.
    if (!allMatched) {
      const para = tip && tip.type === 'paragraph' ? tip : null;
      // A line starting a block (heading, fence, HTML, HR, blockquote,
      // or a list item when inside a list item) ends the containers;
      // anything else may continue the open leaf lazily. A fenced code
      // block or HTML block only absorbs a lazy line once it already
      // has content (an opener alone does not); a table always does.
      const listLine = BULLET_RE.test(content) || ORDERED_RE.test(content);
      const inItem = stack.some((n) => n.type === 'item');
      const bqLine = /^ {0,3}>/.test(content);
      const blockStart = !blank && (startsInterrupt(content, para) || bqLine || (listLine && inItem));
      // A fenced code block, HTML block or table absorbs a lazy line
      // only when the tip sits inside a list item at or below the
      // mismatch point: marked's blockquote tokenizer ends the quote
      // when its last token is code/html/table, but re-lexes a list —
      // so a fence in an item in a quote absorbs, while a fence
      // directly in a quote (or in a quote in an item) does not.
      let inListAtMismatch = false;
      for (let k = depth; k < stack.length; k++) {
        if (stack[k].type === 'item') { inListAtMismatch = true; break; }
      }
      // After a code-merged line, an outdented line does not lazily
      // continue a paragraph inside a list item — the item ends (in a
      // blockquote it does).
      const lazyPara = para && !blank && !blockStart && !(para.lastWasCodeMerge && para.inItem);
      if (lazyPara) {
        // Keep containers open; the line continues the paragraph.
        blankStack = null;
        const ind = indentOf(content, contentBase);
        if (ind.col >= 4) {
          // Code-merge: a lazy line that is code-indented merges into
          // the paragraph with 4 columns stripped (marked's list-loop
          // code merge, which also applies to lazy lines inside
          // blockquotes). Absorbed blanks before it become empty lines.
          if (para.pendingBlanksAfterCode) {
            for (let k = 0; k < para.pendingBlanksAfterCode; k++) para.lines.push('');
            para.noSetext = true;
            para.pendingBlanksAfterCode = 0;
          }
          para.codeMergeOrig = para.codeMergeOrig || [];
          para.codeMergeOrig[para.lines.length] = content;
          para.lines.push(sliceFromCol(content, 4, contentBase));
          para.lastWasCodeMerge = true;
          para.lastWasLazy = true;
        } else {
          // A code-merged line followed by a non-code line contributes
          // an extra empty line before it.
          if (para.lastWasCodeMerge) { para.lines.push(''); para.noSetext = true; }
          if (para.pendingBlanksAfterCode) {
            for (let k = 0; k < para.pendingBlanksAfterCode; k++) para.lines.push('');
            para.noSetext = true;
            para.pendingBlanksAfterCode = 0;
          }
          para.lastWasCodeMerge = false;
          // A lazy line that looks like a setext underline cannot be
          // one, so it is kept as paragraph text with 4 spaces
          // prepended — but only when the previous line was also a lazy
          // line and the paragraph sits in a blockquote (in a list item
          // the prepend is undone by the code merge, so it nets to nil).
          const parentIsBq = top().type === 'blockquote';
          para.lines.push(SETEXT_RE.test(content) && para.lastWasLazy && parentIsBq ? '    ' + content : content);
          para.lastWasLazy = true;
        }
        continue;
      }
      if (!blank && !blockStart && inListAtMismatch && tip && tip.type === 'code' && tip.fenced && tip.lines.length > 0) {
        // Lazy fenced-code content: the line is kept unstripped (past
        // the containers that did match), with the fence's own
        // indentation stripped as usual.
        blankStack = null;
        tip.lines.push(stripFenceIndent(content, tip.fenceIndent || 0, tip.fenceChar === '`'));
        continue;
      }
      if (!blank && !blockStart && inListAtMismatch && tip && tip.type === 'html' && tip.lines.length > 1) {
        // Lazy HTML content.
        blankStack = null;
        tip.lines.push(content);
        tip.endLine = li;
        if (tip.htmlType <= 5 && htmlBlockEnd(tip.htmlType, content)) closeLeaf();
        continue;
      }
      if (!blank && !blockStart && inListAtMismatch && tip && tip.type === 'table') {
        // A lazy line after a table is another row.
        blankStack = null;
        tip.rows.push(splitTableRow(content));
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
      // A blank line also ends a multi-line label, and a multi-line
      // single-quote title — but " and ( titles may span blank lines.
      //
      // Exception: a whitespace-only remainder line is paragraph
      // CONTENT when it is the last line of its container's text — for
      // a blockquote, when the next line does not re-enter the
      // blockquote; at the top level, when it is the last line of input
      // and the source has no trailing newline. Inside a list item it
      // is never content.
      if (tip && tip.type === 'paragraph' && content !== '') {
        const parent = top();
        let isContent = false;
        if (parent.type === 'blockquote') {
          if (li + 1 >= lines.length) isContent = true;
          else {
            const next = matchContainers(lines[li + 1]);
            if (next.depth <= stack.length - 1) isContent = true;
          }
        } else if (parent.type === 'document' && li === lines.length - 1 && !src.endsWith('\n')) {
          isContent = true;
        }
        if (isContent) {
          tip.lines.push(content);
          tip.lastWasLazy = false;
          continue;
        }
      }
      if (pendingLabelPartial) {
        tip = addChild(top(), { type: 'paragraph', lines: pendingLabelPartial.parts, inItem: top().type === 'item' });
        pendingLabelPartial = null;
      }
      if (pendingTitle && pendingTitle.quote === "'") {
        if (pendingTitle.registered) delete refs[pendingTitle.label];
        tip = addChild(top(), { type: 'paragraph', lines: pendingTitle.rawLines, inItem: top().type === 'item' });
        pendingTitle = null;
      } else if (pendingTitle) {
        pendingTitle.buf += '\n' + content;
        pendingTitle.rawLines.push(content);
        continue;
      }
      if (pendingLabel) {
        tip = addChild(top(), { type: 'paragraph', lines: pendingLabel.raw, inItem: top().type === 'item' });
        pendingLabel = null;
      }
      if (pendingDef) pendingDef = null;
      if (tip && tip.type === 'code') {
        // A blank line inside fenced code keeps its content past the
        // fence's indentation; inside indented code it keeps the spaces
        // past the 4-column indent.
        tip.lines.push(tip.fenced ? stripFenceIndent(content, tip.fenceIndent || 0, tip.fenceChar === '`') : stripIndent(content, 4, contentBase));
        continue;
      }
      if (tip && tip.type === 'html') {
        if (tip.htmlType === 6 || tip.htmlType === 7) { tip.endedAtBlank = true; closeLeaf(); }
        else { tip.lines.push(content); tip.endLine = li; }
        continue;
      }
      // A blank after a code-merged line is absorbed when the next
      // non-blank line is another code line inside the same item: it
      // becomes an empty line in the paragraph (no close, no loose
      // marking). Exactly one blank before a sibling item leaves a
      // trailing empty line on the code-merged paragraph instead.
      if (tip && tip.type === 'paragraph' && tip.lastWasCodeMerge && tip.inItem) {
        const ahead = lookAheadFrom(li);
        if (ahead && ahead.isCodeLine) {
          tip.pendingBlanksAfterCode = (tip.pendingBlanksAfterCode || 0) + 1;
          continue;
        }
        if (ahead && ahead.blanks === 1 && ahead.isSiblingItem) tip.lines.push('');
      }
      if (tip && tip.type === 'paragraph') closeLeaf();
      if (tip && tip.type === 'table') closeLeaf();
      // An empty item ends at a blank line (its content, if any, sits
      // outside the list).
      while (stack.length > 1 && top().type === 'item' && top().children.length === 0) stack.pop();
      // Only the containers the blank line is actually blank inside
      // (a `>` line counts for its blockquote, not for the item).
      blankStack = blankNodes;
      continue;
    }

    // --- 3. Open leaf blocks: fenced code, indented code, HTML block.
    if (tip && tip.type === 'code' && tip.fenced) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
      if (m && m[1][0] === tip.fenceChar && m[1].length >= tip.fenceLen) {
        closeLeaf();
        continue;
      }
      // Backtick fences strip up to the opening fence's indentation
      // (counted in CHARACTERS, spaces or tabs) from each line; tilde
      // fences strip nothing.
      tip.lines.push(stripFenceIndent(content, tip.fenceIndent || 0, tip.fenceChar === '`'));
      blankStack = null;
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
        blankStack = null;
        continue;
      }
      tip.lines.push(content);
      tip.endLine = li;
      blankStack = null;
      continue;
    }

    // --- 4. Open (or continue) blocks at this line.
    lineWasDef = false;
    processContent(content, li, contentBase);
    if (!lineWasDef) blankStack = null;
  }

  // EOF: a definition that never completed becomes paragraph text
  // ([foo]: at the end of input renders as <p>[foo]:</p>). A title
  // that never closed fails the whole definition, so an already
  // registered one is unregistered again.
  if (pendingLabelPartial) {
    tip = addChild(top(), { type: 'paragraph', lines: pendingLabelPartial.parts, inItem: top().type === 'item' });
    pendingLabelPartial = null;
  }
  if (pendingLabel) {
    tip = addChild(top(), { type: 'paragraph', lines: pendingLabel.raw, inItem: top().type === 'item' });
    pendingLabel = null;
  }
  if (pendingTitle) {
    if (pendingTitle.registered) delete refs[pendingTitle.label];
    tip = addChild(top(), { type: 'paragraph', lines: pendingTitle.rawLines, inItem: top().type === 'item' });
    pendingTitle = null;
  }

  // Process one line's content as the start or continuation of blocks
  // inside the currently open containers. Called once per physical line
  // and recursively for a list item's or blockquote's first-line
  // remainder. Returns when the line is consumed.
  function processContent(content, lineIdx, base) {
    base = base || 0;
    // A definition whose label spans lines: look for the closing ] on
    // this line. An unescaped [ kills it; a blank line already did
    // (handled in the blank branch).
    if (pendingLabelPartial) {
      const parts = pendingLabelPartial.parts;
      let j = 0;
      let closeIdx = -1;
      let bad = false;
      while (j < content.length) {
        const ch = content[j];
        if (ch === '\\' && j + 1 < content.length) { j += 2; continue; }
        if (ch === '[') { bad = true; break; }
        if (ch === ']') { closeIdx = j; break; }
        j++;
      }
      if (bad) {
        tip = addChild(top(), { type: 'paragraph', lines: [...parts, content], inItem: top().type === 'item' });
        pendingLabelPartial = null;
        return;
      }
      if (closeIdx < 0) {
        parts.push(content);
        lineWasDef = true;
        return;
      }
      const labelText = parts.join('\n') + '\n' + content.slice(0, closeIdx);
      const label = labelText.replace(/^ {0,3}\[/, '');
      pendingLabelPartial = null;
      let k = closeIdx + 1;
      if (content[k] !== ':' || label.trim() === '') {
        tip = addChild(top(), { type: 'paragraph', lines: [...parts, content], inItem: top().type === 'item' });
        return;
      }
      k++;
      while (k < content.length && (content[k] === ' ' || content[k] === '\t')) k++;
      const rawLines = [...parts, content];
      if (k >= content.length) {
        pendingLabel = { label: normLabel(label), raw: rawLines };
        lineWasDef = true;
        return;
      }
      const res = parseDestAndTitle(content, k);
      if (!res) {
        tip = addChild(top(), { type: 'paragraph', lines: rawLines, inItem: top().type === 'item' });
        return;
      }
      if (res.titlePartial) {
        pendingTitle = { label: normLabel(label), dest: res.dest, quote: res.titlePartial.quote, buf: res.titlePartial.text, rawLines };
        lineWasDef = true;
        return;
      }
      const stored = !refs[normLabel(label)];
      if (stored) refs[normLabel(label)] = { dest: res.dest, title: res.title };
      if (res.maybeTitle && stored) pendingDef = { label: normLabel(label), rawLines };
      closeLeaf();
      lineWasDef = true;
      return;
    }
    // A definition whose title spans lines: accumulate this line and
    // look for the closing quote. Anything but spaces/tabs after the
    // closing quote kills the definition.
    if (pendingTitle) {
      const q = pendingTitle.quote;
      const closeQ = q === '(' ? ')' : q;
      let j = 0;
      let buf = pendingTitle.buf + '\n';
      let ok = false;
      while (j < content.length) {
        const c = content[j];
        if (c === '\\' && j + 1 < content.length && isAsciiPunct(content[j + 1])) { buf += content[j + 1]; j += 2; continue; }
        if (c === closeQ) { ok = true; break; }
        if (q === '(' && c === '(') break;
        buf += c; j++;
      }
      pendingTitle.rawLines.push(content);
      if (!ok) {
        if (q === '(' && j < content.length && content[j] === '(') {
          if (pendingTitle.registered) delete refs[pendingTitle.label];
          tip = addChild(top(), { type: 'paragraph', lines: pendingTitle.rawLines, inItem: top().type === 'item' });
          pendingTitle = null;
          return;
        }
        pendingTitle.buf = buf;
        lineWasDef = true;
        return;
      }
      j++;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      if (j < content.length) {
        if (pendingTitle.registered) delete refs[pendingTitle.label];
        tip = addChild(top(), { type: 'paragraph', lines: pendingTitle.rawLines, inItem: top().type === 'item' });
        pendingTitle = null;
        return;
      }
      if (!refs[pendingTitle.label]) refs[pendingTitle.label] = { dest: pendingTitle.dest, title: decodeEntities(buf) };
      pendingTitle = null;
      closeLeaf();
      lineWasDef = true;
      return;
    }
    // A definition awaiting its destination or title on this line.
    if (pendingLabel) {
      const res = parseDestLine(content);
      if (res) {
        if (res.titlePartial) {
          pendingTitle = { label: pendingLabel.label, dest: res.dest, quote: res.titlePartial.quote, buf: res.titlePartial.text, rawLines: [...pendingLabel.raw, content] };
        } else {
          const stored = !refs[pendingLabel.label];
          if (stored) refs[pendingLabel.label] = { dest: res.dest, title: res.title };
          if (res.maybeTitle && stored) pendingDef = { label: pendingLabel.label, rawLines: [...pendingLabel.raw, content] };
        }
        pendingLabel = null;
        lineWasDef = true;
        return;
      }
      // Not a destination: the label line becomes paragraph text.
      const rawLines = pendingLabel.raw;
      pendingLabel = null;
      tip = addChild(top(), { type: 'paragraph', lines: rawLines, inItem: top().type === 'item' });
      // Fall through: this line follows that paragraph.
    }
    if (pendingDef) {
      const t = parseTitleLine(content);
      if (t !== null) {
        if (typeof t === 'object') {
          // The title runs onto following lines. The definition is
          // already registered (without a title); if the title fails
          // to close cleanly, the whole definition fails and must be
          // unregistered (flagged by `registered`).
          pendingTitle = { label: pendingDef.label, dest: refs[pendingDef.label].dest, quote: t.partial.quote, buf: t.partial.text, rawLines: [...pendingDef.rawLines, content], registered: true };
          pendingDef = null;
          lineWasDef = true;
          return;
        }
        const rec = refs[pendingDef.label];
        if (rec) rec.title = decodeEntities(t);
        pendingDef = null;
        lineWasDef = true;
        return;
      }
      pendingDef = null; // the definition stands without a title
    }
    // Setext heading: converts the open paragraph — unless an empty
    // line got into the paragraph (from a code merge), which marked's
    // lheading pattern cannot span. A code-merged line reverts to its
    // un-merged form when a setext heading converts (the lheading token
    // claims the lines before the code merge applies).
    if (tip && tip.type === 'paragraph') {
      const sm = SETEXT_RE.exec(content);
      if (sm && !tip.noSetext) {
        const level = sm[1][0] === '=' ? 1 : 2;
        if (tip.codeMergeOrig) {
          for (let k = 0; k < tip.lines.length; k++) {
            if (tip.codeMergeOrig[k] !== undefined) tip.lines[k] = tip.codeMergeOrig[k];
          }
        }
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
      lineWasDef = false; // the blockquote itself is a block
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
    const opened = tryOpenList(content, stack, tip, base, blankStack);
    if (opened !== null) {
      closeLeaf();
      if (opened.rest !== '' && !isBlankLine(opened.rest)) processContent(opened.rest, lineIdx, opened.base);
      lineWasDef = false; // the list item itself is a block
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
      // Code-merge (list items only): a continuation line that is
      // code-indented after the item indent merges into the paragraph
      // with 4 columns stripped, instead of starting a code block.
      // (In blockquotes and at the top level the line keeps its spaces:
      // marked lexes those with state.top=true, where the paragraph
      // token wins.) A code-merged line followed by a non-code line
      // contributes an extra empty line before it.
      if (tip.inItem && indentOf(content, base).col >= 4) {
        if (tip.pendingBlanksAfterCode) {
          for (let k = 0; k < tip.pendingBlanksAfterCode; k++) tip.lines.push('');
          tip.noSetext = true;
          tip.pendingBlanksAfterCode = 0;
        }
        tip.codeMergeOrig = tip.codeMergeOrig || [];
        tip.codeMergeOrig[tip.lines.length] = content;
        tip.lines.push(sliceFromCol(content, 4, base));
        tip.lastWasCodeMerge = true;
        tip.lastWasLazy = false;
        return;
      }
      if (tip.lastWasCodeMerge) { tip.lines.push(''); tip.noSetext = true; }
      if (tip.pendingBlanksAfterCode) {
        for (let k = 0; k < tip.pendingBlanksAfterCode; k++) tip.lines.push('');
        tip.noSetext = true;
        tip.pendingBlanksAfterCode = 0;
      }
      tip.lastWasCodeMerge = false;
      tip.lastWasLazy = false;
      tip.lines.push(content);
      return;
    }
    // New paragraph: first consume any link reference definitions.
    const def = tryParseRefDef(content);
    if (def) {
      if (def.labelPartial) {
        pendingLabelPartial = { parts: [content] };
      } else if (def.awaitingDest) {
        pendingLabel = def;
      } else if (def.titlePartial) {
        pendingTitle = { label: def.label, dest: def.dest, quote: def.titlePartial.quote, buf: def.titlePartial.text, rawLines: [content] };
      } else {
        const stored = !refs[def.label];
        if (stored) refs[def.label] = { dest: def.dest, title: def.title };
        if (def.maybeTitle && stored) pendingDef = { label: def.label, rawLines: [content] };
      }
      closeLeaf();
      lineWasDef = true;
      return;
    }
    tip = addChild(top(), { type: 'paragraph', lines: [content], inItem: top().type === 'item' });
  }

  // Finalise: drop trailing blank lines from code blocks (marked's code
  // text is the lines joined with '\n' plus a trailing '\n', or '' when
  // nothing remains), and compute each HTML block's raw text from its
  // container-stripped lines.
  const walk = (node, isTop, hasNext) => {
    if (node.type === 'code') {
      // Fenced code drops exactly ONE trailing empty line (a line of
      // spaces is kept, spec example 129); indented code drops any
      // trailing whitespace-only line.
      if (node.fenced) {
        if (node.lines.length && node.lines[node.lines.length - 1] === '') node.lines.pop();
      } else {
        while (node.lines.length && /^[ \t]*$/.test(node.lines[node.lines.length - 1])) node.lines.pop();
      }
    }
    if (node.type === 'html') {
      let text = node.lines.join('\n');
      // The text carries a trailing '\n' unless the block ended at a
      // blank line (types 6-7), the following line is exactly empty
      // (the raw then ends with two newlines, which marked's trailing
      // blank-line rule strips entirely), or the block is the last one
      // in a container (a container's text is newline-stripped). At the
      // top level, a final block keeps the '\n' when the source ends
      // with one.
      const next = node.endLine + 1 < lines.length ? lines[node.endLine + 1] : null;
      const nextEmpty = next === '';
      const atEofNoNl = next === null && !src.endsWith('\n');
      if (!node.endedAtBlank && !nextEmpty && !atEofNoNl && (hasNext || isTop)) text += '\n';
      node.text = text;
    }
    if (node.children) node.children.forEach((child, i) => walk(child, node.type === 'document', i < node.children.length - 1));
  };
  walk(root, false, false);
  return root.children;
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
function tryOpenList(content, stack, tip, base, blankStack) {
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
  // A list interrupts a paragraph only under the usual conditions —
  // except inside a list item, where marked lexes the item text with
  // state.top=false: the list tokenizer runs before the text
  // tokenizer, so ANY list line (any start number, even an empty
  // item) interrupts the paragraph and opens a nested list.
  if (tip && tip.type === 'paragraph' && !tip.inItem) {
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
    openItem(stack, ordered, startNum, ordered ? delim : markerText, indent, '', base + markerCol, blankStack);
    return { rest: '', base };
  }
  if (spaces >= 1 && spaces <= 4) {
    indent = markerEndCol + spaces;
  } else {
    // 5+ spaces: the content starts one space after the marker.
    indent = markerEndCol + 1;
  }
  const rest = openItem(stack, ordered, startNum, ordered ? delim : markerText, indent, sliceFromCol(content, indent, base), base + markerCol, blankStack);
  return { rest, base: base + indent };
}

// Create (or continue) the list and append a new item to it. `remainder`
// is the item's first-line content. Whether this is a sibling item or a
// nested list is decided by the marker's absolute column against the
// parent list's marker column: the same column continues the list, a
// deeper column nests under the open item. A nested list reuses the
// item's last child when it is a list of the same kind and column
// (a blank line between two runs of nested items does not split the
// list). `blankStack` is the container snapshot at the last blank line:
// a list it contains, with at least one item already, is loose.
function openItem(stack, ordered, startNum, wantDelim, indent, remainder, absMarkerCol, blankStack) {
  const topNode = stack[stack.length - 1];
  let parent;
  let existingList = null;
  if (topNode.type === 'item') {
    // A list line that reached this item matched it, so its marker
    // sits at or beyond the item's content indent — marked's
    // nextBulletRegex only treats a marker BELOW the item indent as
    // a sibling, so this line always nests under the open item.
    // (Siblings arrive with the list itself on top, after the item
    // was closed for not matching.)
    parent = topNode;
  } else if (topNode.type === 'list') {
    existingList = topNode;
    parent = stack[stack.length - 2];
  } else {
    parent = topNode;
  }
  let list = null;
  if (existingList && existingList.ordered === ordered && existingList.delim === wantDelim) list = existingList;
  if (!list && parent.type === 'item' && parent.children.length > 0) {
    // Reuse a previously closed nested list under this item.
    const last = parent.children[parent.children.length - 1];
    if (last.type === 'list' && last.ordered === ordered && last.delim === wantDelim && last.markerCol === absMarkerCol) {
      list = last;
      stack.push(list);
    }
  }
  if (!list) {
    list = { type: 'list', ordered, start: startNum, delim: wantDelim, tight: true, children: [], markerCol: absMarkerCol };
    parent.children.push(list);
    stack.push(list);
    // A new nested list in an item that a blank line passed through,
    // after the item already had a child: the blank separates two
    // blocks inside the item, so the parent list is loose.
    if (blankStack && parent.type === 'item' && blankStack.indexOf(parent) >= 0 && parent.children.length > 1) {
      const pl = stack[stack.indexOf(parent) - 1];
      if (pl && pl.type === 'list') pl.tight = false;
    }
  }
  if (blankStack && blankStack.indexOf(list) >= 0 && list.children.length >= 1) list.tight = false;
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
