// parse.js — a fast, dependency-free drop-in for marked 18.1.3's
// marked.parse with marked's defaults (GFM on, breaks off, pedantic
// off, async off). Written from scratch in this session from the
// CommonMark 0.31.2 and GFM 0.29 rules plus marked's observable
// behaviour, probed case by case; no line is copied from any other
// implementation.
//
// Shape of the file: tiny character/string helpers, then the inline
// engine (an InlineScanner class plus its link/autolink helpers),
// then the block engine (a Cursor class for tab-aware columns plus a
// DocumentParser class), then the renderer, then the exported parse.
// The inline engine renders straight to a string; the block engine
// builds a small node tree and the renderer walks it.

// ------------------------------------------------------------ state --
//
// Whether an unclosed <a ...> tag is open somewhere in the document.
// marked keeps this as lexer state across the whole document: once an
// <a> tag has opened and no literal </a> has closed it, no GFM
// autolink (bare URL or e-mail) forms anywhere. Markdown links,
// emphasis and code spans are not affected. Link and image text is
// parsed with this value saved and restored, so a tag inside link
// text cannot leak out into the rest of the document.
let anchorOpen = false;

// ---------------------------------------------------------- characters --

const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

// CommonMark "Unicode punctuation": ASCII punctuation plus the Unicode
// general categories P (punctuation) and S (symbols). A £ or € counts.
function isPunctuation(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCTUATION.indexOf(ch) !== -1;
  return /[\p{P}\p{S}]/u.test(ch);
}

// Backslash escapes only work before ASCII punctuation.
function isAsciiPunctuation(ch) {
  if (!ch) return false;
  return ch.charCodeAt(0) < 128 && ASCII_PUNCTUATION.indexOf(ch) !== -1;
}

// CommonMark Unicode whitespace: the ASCII set plus U+00A0, U+1680,
// U+2000–U+200A, U+202F, U+205F and U+3000.
function isUnicodeSpace(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
  }
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f || code === 0x205f || code === 0x3000;
}

function isPlainSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

// ------------------------------------------------------------ escaping --

const TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const TEXT_NEEDS_ESCAPE = /[&<>"']/;
const TEXT_ESCAPE_ALL = /[&<>"']/g;

// Escape a text run (marked escapes quotes in text and in code spans
// too). Runs handed here never contain an entity sequence: the inline
// scanner splits those out first, so a bare & here is always literal.
function escapeText(s) {
  if (!TEXT_NEEDS_ESCAPE.test(s)) return s;
  return s.replace(TEXT_ESCAPE_ALL, (ch) => TEXT_ESCAPES[ch]);
}

// Escape an attribute value: & < > " ', except that a valid entity
// reference stays as marked renders it — a named reference verbatim,
// a numeric one decoded and then escaped again.
function escapeAttribute(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 38: { // &
        const ent = readEntityAt(s, i);
        if (ent) {
          out += ent.numeric ? escapeAttribute(ent.text) : ent.text;
          i += ent.length;
        } else {
          out += '&amp;';
          i++;
        }
        break;
      }
      case 60: out += '&lt;'; i++; break;
      case 62: out += '&gt;'; i++; break;
      case 34: out += '&quot;'; i++; break;
      case 39: out += '&#39;'; i++; break;
      default: out += s[i]; i++;
    }
  }
  return out;
}

// ------------------------------------------------------------ entities --

// If an entity reference starts at s[i], describe it: { text, length,
// numeric }. `text` is what marked outputs — a named reference
// verbatim, a numeric one decoded (an invalid code point becomes
// U+FFFD). A numeric reference holds at most 7 decimal or 6 hex
// digits; more than that is not an entity and stays literal text.
function readEntityAt(s, i) {
  const n = s.length;
  if (s[i] !== '&' || i + 1 >= n) return null;
  const first = s[i + 1];
  if (first === '#') {
    let j = i + 2;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      hex = true;
      j++;
    }
    const digitsAt = j;
    while (j < n) {
      const ch = s[j];
      const digit = ch >= '0' && ch <= '9';
      const hexDigit = hex && ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F'));
      if (!digit && !hexDigit) break;
      j++;
    }
    const digits = s.slice(digitsAt, j);
    if (digits.length === 0 || j >= n || s[j] !== ';') return null;
    if (digits.length > (hex ? 6 : 7)) return null;
    let point = parseInt(digits, hex ? 16 : 10);
    if (!point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) point = 0xfffd;
    return { text: String.fromCodePoint(point), length: j - i + 1, numeric: true };
  }
  const letter = (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z');
  if (!letter) return null;
  let j = i + 1;
  while (j < n) {
    const ch = s[j];
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
    if (!ok) break;
    j++;
  }
  if (j < n && s[j] === ';') return { text: s.slice(i, j + 1), length: j - i + 1, numeric: false };
  return null;
}

// Decode entities inside a link destination or title the way marked
// does: numeric references become the character, named ones stay
// verbatim (marked never validates a named reference against a table).
function expandEntities(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const ent = readEntityAt(s, i);
      if (ent) {
        out += ent.text;
        i += ent.length;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

// -------------------------------------------------------------- labels --

// Normalise a link reference label: trim, collapse internal runs of
// whitespace to one space, then case-fold. The lower–upper–lower
// round trip is marked's folding: it maps ẞ to ss (ß uppercases to
// SS), where a plain toLowerCase would leave ß unmatched against an
// SS label.
function foldLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Encode a link destination the way marked renders it inside href:
// encodeURI, except that an existing %XX sequence is left alone (the
// % itself is not re-escaped). Backslashes, < > " and non-ASCII all
// become percent-escapes; javascript: and vbscript: are NOT filtered.
function encodeDestination(dest) {
  try {
    return encodeURI(dest).replace(/%25/g, '%');
  } catch {
    // A lone surrogate makes encodeURI throw; escape just the ASCII
    // specials instead of failing the whole render.
    let out = '';
    for (let i = 0; i < dest.length; i++) {
      const code = dest.charCodeAt(i);
      if (code === 32) out += '%20';
      else if (code === 60) out += '%3C';
      else if (code === 62) out += '%3E';
      else if (code === 34) out += '%22';
      else out += dest[i];
    }
    return out;
  }
}

// ------------------------------------------------------- inline patterns --
//
// Emphasis and strikethrough follow marked's left-to-right scan: a
// left-delimiter match opens a run, then a right-delimiter scan walks
// the masked text with two counters (m: opener length plus opener-only
// runs minus closer runs; f: length skipped by the rule of 3). The
// span forms when m reaches 0. The scan runs on a MASKED copy of the
// text (see buildDelimiterMask), in which link spans, code spans and
// HTML tags are replaced by [aaa...] of the same length, so a
// delimiter inside a (possibly failed) link span is invisible.
//
// Flanking, per the CommonMark rules, with one GFM twist: for `*` the
// character ~ counts as non-punctuation (it is a delimiter of its
// own), while for `_` and `~` it counts as punctuation. A run's
// neighbours decide what it may do:
//   - closer-only: right-flanking but not left-flanking
//   - opener-only: left-flanking but not right-flanking
//   - both: left- and right-flanking
// The closer scans below encode those six cases as alternatives; each
// alternative consumes the character before the run and captures the
// run in a named group, so the scan loop can tell which case matched.
// The first alternative skips plain text (it stops one character
// short of a delimiter, leaving the neighbour for the next match).

// A whitespace-or-punctuation character other than * or _ (marked's
// `punctuation` rule, used when testing the character before a run).
const NON_DELIM_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

// Left-delimiter rule, sticky at the opener: a run of * or _ plus the
// following character — `ap`/`up` is punctuation after the run,
// `an`/`un` a non-space character. A run with no following character
// matches with no group, and the caller rejects it.
const EMPH_OPEN = /(?:\*+(?:(?<ap>(?!\*)(?!~)[\p{P}\p{S}])|(?<an>[^\s*]))?)|_+(?:(?<up>(?!_)(?!~)[\p{P}\p{S}])|(?<un>[^\s_]))?/uy;

// Closer scans. Named groups: `plain` is skipped text; `c1`/`c2` are
// closer-only runs, `o1`/`o2` opener-only runs, `b1`/`b2` runs that can
// both open and close. The `_` scan has no `b2`: an intraword `_` is
// never a delimiter.
const AST_CLOSE_SCAN = /(?<plain>[^*]+(?=[^*]))|(?:(?!\*)(?!~)[\p{P}\p{S}])(?<c1>\*+)(?=[\s]|$)|(?:(?:[^\s\p{P}\p{S}]|~))(?<c2>\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?:(?!\*)(?!~)[\s\p{P}\p{S}])(?<o1>\*+)(?=(?:[^\s\p{P}\p{S}]|~))|(?:[\s])(?<o2>\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:(?!\*)(?!~)[\p{P}\p{S}])(?<b1>\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:(?:[^\s\p{P}\p{S}]|~))(?<b2>\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const UND_CLOSE_SCAN = /(?<plain>[^_]+(?=[^_]))|(?:(?!_)[\p{P}\p{S}])(?<c1>_+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}])(?<c2>_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?:(?!_)[\s\p{P}\p{S}])(?<o1>_+)(?=[^\s\p{P}\p{S}])|(?:[\s])(?<o2>_+)(?!_)(?=[\p{P}\p{S}])|(?:(?!_)[\p{P}\p{S}])(?<b1>_+)(?!_)(?=[\p{P}\p{S}])/gu;

// Strikethrough delimiters: the left rule needs a following character
// (a lone ~ at the end is literal); the right rule mirrors the
// emphasis one with runs of one or two tildes.
const DEL_OPEN = /~~?(?:(?<dp>(?!~)[\p{P}\p{S}])|[^\s~])/uy;
const DEL_CLOSE_SCAN = /(?<plain>[^~]+(?=[^~]))|(?:(?!~)[\p{P}\p{S}])(?<c1>~~?)(?=[\s]|$)|(?:[^\s\p{P}\p{S}])(?<c2>~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?:(?!~)[\s\p{P}\p{S}])(?<o1>~~?)(?=[^\s\p{P}\p{S}])|(?:[\s])(?<o2>~~?)(?!~)(?=[\p{P}\p{S}])|(?:(?!~)[\p{P}\p{S}])(?<b1>~~?)(?!~)(?=[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}])(?<b2>~~?)(?=[^\s\p{P}\p{S}])/gu;

// When scanning for `*` closers, a `__...*...__` span is skipped; when
// scanning for `_` closers, a `**..._...**` span. Returns the index of
// the closing double run (the scan resumes there), or -1 when no such
// span starts at `from`. Written as a small loop rather than a regex:
// the span is a double run of the OTHER delimiter, some delimiter-free
// text, one delimiter of the kind being scanned for, more
// delimiter-free text, then the closing double run.
function skipOppositeStrong(masked, from, delim) {
  const other = delim === '*' ? '_' : '*';
  const n = masked.length;
  let i = from;
  while (i < n && masked[i] !== '*' && masked[i] !== '_') i++;
  if (i + 1 >= n || masked[i] !== other || masked[i + 1] !== other) return -1;
  i += 2;
  while (i < n && masked[i] !== '*' && masked[i] !== '_') i++;
  if (i >= n || masked[i] !== delim) return -1;
  i++;
  while (i < n && masked[i] !== '*' && masked[i] !== '_') i++;
  if (i + 1 >= n || masked[i] !== other || masked[i + 1] !== other) return -1;
  return i;
}

// ------------------------------------------------------------ the mask --
//
// Spans the emphasis scan must not see into: inline links [...](...),
// code spans, and HTML tags. Reference links whose label is defined
// are masked too (a label containing a link is masked recursively
// instead). Every replacement preserves its length, so scan indices
// in the masked copy transfer to the original text.

const MASK_SPAN_RE = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)(`+)[^`]+\2(?!`)|<(?! )[^<>]*?>/g;
const MASK_PUNCT_RE = /(?<ticks>`+)(?:[^`]|[^`][\s\S]*?[^`])\k<ticks>(?!`)|`+|\\(?<esc>[\p{P}\p{S}])/gu;

// A reference link's label may nest brackets one level, hold escapes
// and code spans, or end in a run of two or more backticks before the
// ]. A reference name is 1–999 characters with no unescaped bracket.
const REF_LABEL_INNER = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const REF_NAME_INNER = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/;
const REF_LINK_FIND = new RegExp('!?\\[' + REF_LABEL_INNER.source + '\\]\\[' + REF_NAME_INNER.source + '\\]|!?\\[' + REF_NAME_INNER.source + '\\](?:\\[\\])?(?!\\()', 'g');

// Tests whether a matched [...](...) span is a well-formed inline
// link (used to decide if a piece of text contains a link at all).
const INLINE_LINK_TEST = new RegExp('^!?\\[(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?\\]\\([ \\t\\n]*(?:<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^\\)\\\\])*\\)))?[ \\t\\n]*\\)');

// Does `text` contain a link (not an image)? A link's text may not
// contain a link, so an outer [text](...) whose text holds a link is
// not a link at all — the inner link wins and the outer brackets stay
// literal.
function textHasLink(text, refs) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(MASK_SPAN_RE)) {
    if (INLINE_LINK_TEST.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REF_LINK_FIND)) {
    const span = m[0];
    if (span.charAt(0) === '!') continue;
    const lastOpen = span.lastIndexOf('[');
    if (!Object.hasOwn(refs, foldLabel(span.slice(lastOpen + 1, -1)))) continue;
    if (lastOpen > 1 && textHasLink(span.slice(1, lastOpen - 1), refs)) continue;
    return true;
  }
  return false;
}

// Build the masked copy of `s` for the emphasis scan. The reference
// pass only runs when the text holds a bracket; the punctuation pass
// only when it holds a backtick or a backslash; the span pass only
// when it holds a bracket, a backtick or a <. Skipping a pass the text
// provably cannot match is worth a lot on plain paragraphs.
function buildDelimiterMask(s, refs) {
  let t = s;
  const hasBracket = s.includes('[');
  const hasTick = s.includes('`');
  if (refs && hasBracket) {
    const maskOne = (span) => {
      const lastOpen = span.lastIndexOf('[');
      if (!Object.hasOwn(refs, foldLabel(span.slice(lastOpen + 1, -1)))) return span;
      if (lastOpen > 1 && span.charAt(0) !== '!') {
        const label = span.slice(1, lastOpen - 1);
        if (textHasLink(label, refs)) {
          const fresh = new RegExp(REF_LINK_FIND.source, REF_LINK_FIND.flags);
          return '[' + label.replace(fresh, maskOne) + '][' + 'a'.repeat(span.length - lastOpen - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(span.length - 2) + ']';
    };
    t = t.replace(REF_LINK_FIND, maskOne);
  }
  if (hasTick || s.includes('\\')) {
    t = t.replace(MASK_PUNCT_RE, (m, ticks, esc) => esc ? '+'.repeat(m.length) : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : m);
  }
  if (hasBracket || hasTick || s.includes('<')) {
    t = t.replace(MASK_SPAN_RE, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return t;
}

// Is s[from..] only ASCII whitespace (space, tab, newline, CR, FF, VT)?
function tailIsWhitespace(s, from) {
  for (let q = from; q < s.length; q++) {
    const code = s.charCodeAt(q);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 11) return false;
  }
  return true;
}

// Find the closing backtick run of exactly `len` backticks at or after
// `from`; runs of any other length are skipped over. Returns the index
// of the run's first backtick, or -1.
function findCodeSpanClose(s, from, len) {
  const n = s.length;
  let i = from;
  while (i < n) {
    if (s[i] === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      if (j - i === len) return i;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

// Is char code `cc` an e-mail local-part character [A-Za-z0-9._+-]?
function isEmailLocalCode(cc) {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) ||
    cc === 46 || cc === 95 || cc === 43 || cc === 45;
}

// -------------------------------------------------------- inline engine --
//
// Inline parsing walks the text once, left to right, trying the
// tokenizers in marked's order at each position (escape, code span,
// emphasis, strikethrough, entity, tag/autolink, link/image, break,
// GFM autolink) and taking the first match. Emphasis, link and image
// contents are parsed by a recursive call, so an e-mail inside
// __...__ is matched only after the strong span has formed.
//
// The scanner keeps its state in one object: the text, the output
// chunks, the current index, the start of the pending text run, and
// marked's `r` — the last character of the preceding text token, or
// '' when the preceding token was not text. A text token ending in _
// does not update `r`. The `r` value decides whether a delimiter run
// may open emphasis, so it is tracked exactly.

function renderInlineText(s, refs, inLink) {
  const st = {
    s, refs, inLink: !!inLink,
    n: s.length,
    out: [],
    i: 0,
    textStart: 0,
    lastWasText: false,
    prevR: '',
    masked: null,
  };
  scanInline(st);
  return st.out.join('');
}

function getMasked(st) {
  if (st.masked === null) st.masked = buildDelimiterMask(st.s, st.refs);
  return st.masked;
}

// Emit the pending text run up to `end` as escaped text, and update
// the `r` tracking: the run's last character becomes `r`, unless it is
// _, which leaves `r` as it was (or '' when no text token preceded).
function flushText(st, end) {
  if (end <= st.textStart) return;
  st.out.push(escapeText(st.s.slice(st.textStart, end)));
  const last = st.s[end - 1];
  st.prevR = last !== '_' ? last : (st.lastWasText ? st.prevR : '');
  st.lastWasText = true;
}

// The `r` value for a tokenizer attempt at `pos`: the last character
// of the pending text run, falling back to the last emitted text
// token when the run is empty or ends in _.
function prevCharAt(st, pos) {
  if (pos > st.textStart) {
    const ch = st.s[pos - 1];
    return ch !== '_' ? ch : (st.lastWasText ? st.prevR : '');
  }
  return st.lastWasText ? st.prevR : '';
}

function scanInline(st) {
  const s = st.s;
  const n = st.n;
  while (st.i < n) {
    const code = s.charCodeAt(st.i);
    if (code === 92) { // backslash
      if (!tryBackslash(st)) st.i++;
      continue;
    }
    if (code === 96) { // backtick
      tryCodeSpan(st);
      continue;
    }
    if (code === 42 || code === 95) { // * _
      if (!tryEmphasisAt(st)) st.i++;
      continue;
    }
    if (code === 126) { // ~
      if (!tryDelAt(st)) st.i++;
      continue;
    }
    if (code === 38) { // &
      if (!tryEntityAt(st)) st.i++;
      continue;
    }
    if (code === 60) { // <
      if (!tryAngleAt(st)) st.i++;
      continue;
    }
    if (code === 91 && !st.inLink) { // [
      if (!tryLinkAt(st, false)) st.i++;
      continue;
    }
    if (code === 33 && s[st.i + 1] === '[') { // ![
      if (!tryLinkAt(st, true)) st.i++;
      continue;
    }
    if (code === 10) { // \n
      if (!tryNewline(st)) st.i++;
      continue;
    }
    // GFM extended autolinks only start at an alphanumeric or . + -,
    // and never inside a link's text or while an <a> tag is open.
    if (!st.inLink && !anchorOpen &&
      ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) || code === 46 || code === 43 || code === 45)) {
      if (!tryGfmAt(st)) st.i++;
      continue;
    }
    st.i++;
  }
  flushText(st, n);
}

// Backslash: an escape of ASCII punctuation, or a hard break before a
// newline (only when non-whitespace follows it — marked's br rule
// carries a (?!\s*$) lookahead). Anything else stays literal.
function tryBackslash(st) {
  const s = st.s;
  const i = st.i;
  const nx = s[i + 1];
  if (nx === '\n' && !tailIsWhitespace(s, i + 2)) {
    flushText(st, i);
    st.out.push('<br>');
    st.lastWasText = false;
    let j = i + 2;
    while (j < st.n && (s[j] === ' ' || s[j] === '\t')) j++;
    st.i = j;
    st.textStart = j;
    return true;
  }
  if (nx && isAsciiPunctuation(nx)) {
    flushText(st, i);
    st.out.push(escapeText(nx));
    if (nx !== '_') st.prevR = nx;
    st.lastWasText = true;
    st.i = i + 2;
    st.textStart = i + 2;
    return true;
  }
  return false;
}

// Code span: a run of backticks closed by a run of exactly the same
// length. Newlines inside become spaces; one space is stripped from
// each end when the content both starts and ends with a space and is
// not all spaces. An unclosed run stays literal text.
function tryCodeSpan(st) {
  const s = st.s;
  const n = st.n;
  const i = st.i;
  let j = i;
  while (j < n && s[j] === '`') j++;
  const len = j - i;
  const close = findCodeSpanClose(s, j, len);
  if (close < 0) {
    st.i = j;
    return;
  }
  let content = s.slice(j, close).replace(/\n/g, ' ');
  if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
    content = content.slice(1, -1);
  }
  flushText(st, i);
  st.out.push('<code>' + escapeText(content) + '</code>');
  st.lastWasText = false;
  st.i = close + len;
  st.textStart = close + len;
}

// Entity reference: a named reference goes out verbatim, a numeric
// one decoded and then escaped.
function tryEntityAt(st) {
  const s = st.s;
  const i = st.i;
  const ent = readEntityAt(s, i);
  if (!ent) return false;
  flushText(st, i);
  st.out.push(ent.numeric ? escapeText(ent.text) : ent.text);
  const last = s[i + ent.length - 1];
  if (last !== '_') st.prevR = last;
  st.lastWasText = true;
  st.i = i + ent.length;
  st.textStart = i + ent.length;
  return true;
}

// Newline: a hard break when two or more spaces precede it and
// non-whitespace follows (the spaces are dropped, the next line's
// leading spaces and tabs are stripped); otherwise a soft break,
// which is just a newline in the text run.
function tryNewline(st) {
  const s = st.s;
  const i = st.i;
  let k = i - 1;
  let spaces = 0;
  while (k >= st.textStart && s[k] === ' ') {
    spaces++;
    k--;
  }
  if (spaces >= 2 && !tailIsWhitespace(s, i + 1)) {
    flushText(st, k + 1);
    st.out.push('<br>');
    st.lastWasText = false;
    let j = i + 1;
    while (j < st.n && (s[j] === ' ' || s[j] === '\t')) j++;
    st.i = j;
    st.textStart = j;
    return true;
  }
  return false;
}

// ------------------------------------------------- emphasis / strikethrough --
//
// Try emphasis or strong at position i. `masked` is the masked copy of
// the whole text (same length as s); `prev` is marked's `r`. Returns
// {html, end} or null. The opener's run may extend left of i in the
// masked text (the scanner retries a run one delimiter at a time after
// a failed attempt), so the run's true start and the character before
// it are recovered first — flanking is judged against the whole run.
function scanEmphasis(s, masked, i, refs, inLink, prev) {
  EMPH_OPEN.lastIndex = i;
  const open = EMPH_OPEN.exec(s);
  const og = open && open.groups;
  if (!open || (!og.ap && !og.an && !og.up && !og.un)) return null;
  const delim = open[0][0];
  let before = prev;
  const sameAsPrev = before === delim;
  const off = i;
  let runStart = off;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const beforeSlice = masked.slice(Math.max(0, runStart - 2), runStart);
  const beforeRun = beforeSlice ? [...beforeSlice].at(-1) : '';
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || NON_DELIM_PUNCT.test(beforeRun);
  if (runStart < off) before = beforeRun;
  const beforePunct = runStart < off ? beforeIsPunct : NON_DELIM_PUNCT.test(before);
  // An intraword _ cannot open: an underscore followed by a non-space
  // character with an alphanumeric before it is literal.
  if (og.un && ALPHANUMERIC.test(before)) return null;
  const punctAfter = og.ap || og.up || '';
  if (!punctAfter || !before || beforePunct) {
    const openLen = [...open[0]].length - 1;
    let m = openLen;
    let f = 0;
    const totalLen = off - runStart + openLen;
    const canAlsoClose = beforeRun.trim() !== '' && (!!punctAfter || (delim === '*' && !beforeIsPunct));
    if (delim !== '*' && delim !== '_') return null;
    const closerScan = delim === '*' ? AST_CLOSE_SCAN : UND_CLOSE_SCAN;
    let scanFrom = off + openLen;
    const skipped = skipOppositeStrong(masked, scanFrom, delim);
    if (skipped >= 0) scanFrom = skipped;
    closerScan.lastIndex = scanFrom;
    let sm;
    while ((sm = closerScan.exec(masked)) !== null) {
      const g = sm.groups;
      const run = g.c1 || g.c2 || g.o1 || g.o2 || g.b1 || g.b2;
      if (!run) continue;
      const runLen = [...run].length;
      if (g.o1 || g.o2) {
        m += runLen;
        continue;
      } else if (g.b1 || g.b2 || canAlsoClose) {
        if (sameAsPrev && (g.b1 || g.b2)) break;
        if (totalLen % 3 !== 0 && (totalLen + runLen) % 3 === 0) {
          f += runLen;
          continue;
        }
      }
      m -= runLen;
      if (m > 0) continue;
      const use = Math.min(runLen, runLen + m + f);
      const leadWidth = sm[0].codePointAt(0) > 0xffff ? 2 : 1;
      const rawEnd = sm.index + leadWidth + use;
      const span = s.slice(i, rawEnd);
      if (Math.min(openLen, use) % 2 === 1) {
        return { html: '<em>' + renderInlineText(span.slice(1, -1), refs, inLink) + '</em>', end: rawEnd };
      }
      return { html: '<strong>' + renderInlineText(span.slice(2, -2), refs, inLink) + '</strong>', end: rawEnd };
    }
  }
  return null;
}

// Try strikethrough at position i. Same shape as scanEmphasis, but a
// closer must have exactly the opener's length and there is no rule
// of 3. Marked renders a single ~ pair as <del> too, not just ~~.
function scanDel(s, masked, i, refs, inLink, prev) {
  DEL_OPEN.lastIndex = i;
  const open = DEL_OPEN.exec(s);
  if (!open) return null;
  const before = prev;
  if (!(open.groups.dp || '') || !before || NON_DELIM_PUNCT.test(before)) {
    const openLen = [...open[0]].length - 1;
    let p = openLen;
    DEL_CLOSE_SCAN.lastIndex = i + openLen;
    let sm;
    while ((sm = DEL_CLOSE_SCAN.exec(masked)) !== null) {
      const g = sm.groups;
      const run = g.c1 || g.c2 || g.o1 || g.o2 || g.b1 || g.b2;
      if (!run) continue;
      const runLen = [...run].length;
      if (runLen !== openLen) continue;
      if (g.o1 || g.o2) {
        p += runLen;
        continue;
      }
      p -= runLen;
      if (p > 0) continue;
      const use = Math.min(runLen, runLen + p);
      const leadWidth = sm[0].codePointAt(0) > 0xffff ? 2 : 1;
      const rawEnd = sm.index + leadWidth + use;
      const span = s.slice(i, rawEnd);
      return { html: '<del>' + renderInlineText(span.slice(openLen, -openLen), refs, inLink) + '</del>', end: rawEnd };
    }
  }
  return null;
}

// Emphasis attempt at the scanner's position. The cheap left-delimiter
// gate runs first: only a run that can open emphasis needs the
// (expensive) mask. A leading _ that fails emphasis may still start a
// bare e-mail address — marked tries emphasis first, then the e-mail.
function tryEmphasisAt(st) {
  const s = st.s;
  const i = st.i;
  EMPH_OPEN.lastIndex = i;
  const gate = EMPH_OPEN.exec(s);
  const gg = gate && gate.groups;
  const passable = gg && (gg.ap || gg.an || gg.up || gg.un);
  const got = passable ? scanEmphasis(s, getMasked(st), i, st.refs, st.inLink, prevCharAt(st, i)) : null;
  if (got) {
    flushText(st, i);
    st.out.push(got.html);
    st.lastWasText = false;
    st.i = got.end;
    st.textStart = got.end;
    return true;
  }
  if (s[i] === '_' && !st.inLink && !anchorOpen &&
    (st.textStart === i || !isEmailLocalCode(i > 0 ? s.charCodeAt(i - 1) : -1))) {
    const em = readBareEmail(s, i);
    if (em) {
      flushText(st, i);
      st.out.push(em.html);
      st.lastWasText = false;
      st.i = em.end;
      st.textStart = em.end;
      return true;
    }
  }
  return false;
}

// Strikethrough attempt at the scanner's position.
function tryDelAt(st) {
  const s = st.s;
  const i = st.i;
  DEL_OPEN.lastIndex = i;
  const gate = DEL_OPEN.exec(s);
  const got = gate ? scanDel(s, getMasked(st), i, st.refs, st.inLink, prevCharAt(st, i)) : null;
  if (got) {
    flushText(st, i);
    st.out.push(got.html);
    st.lastWasText = false;
    st.i = got.end;
    st.textStart = got.end;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- links --

// Find the index of the `]` matching the `[` at `open` (depth-aware,
// skipping backslash escapes). Backticks follow marked's label
// pattern: a backtick run must form a complete code span with the next
// backtick run as its closer (the runs need not match in length) or
// sit immediately before the closing `]` as a run of two or more —
// an unclosed backtick anywhere else makes the whole label fail. The
// code-span reading is tried first, but if it leads nowhere (its
// closer may sit past the label's ]), the scan backtracks to the
// trailing-run alternative.
function findLabelClose(s, open) {
  return scanBracketLabel(s, open + 1, 1);
}

function scanBracketLabel(s, i, depth) {
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === ']') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const nextTick = s.indexOf('`', j);
      if (nextTick >= 0) {
        let m = nextTick;
        while (m < n && s[m] === '`') m++;
        const found = scanBracketLabel(s, m, depth);
        if (found >= 0) return found;
      }
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

function skipInlineWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Parse the tail of an inline link after `]`: (dest "title"). Returns
// {dest, title, end} or null. The destination is either <...> (no
// newline inside) or a bare run with balanced parentheses; the title
// is "..." or '...' or (...), needs whitespace before it, and may
// span lines.
function parseInlineTail(s, i) {
  const n = s.length;
  i = skipInlineWs(s, i);
  if (i >= n || s[i] !== '(') return null;
  i++;
  i = skipInlineWs(s, i);
  let dest = '';
  if (i < n && s[i] === '<') {
    let j = i + 1;
    let buf = '';
    while (j < n && s[j] !== '>') {
      if (s[j] === '\n') return null;
      if (s[j] === '\\' && j + 1 < n && isAsciiPunctuation(s[j + 1])) {
        buf += s[j + 1];
        j += 2;
        continue;
      }
      buf += s[j];
      j++;
    }
    if (j >= n) return null;
    dest = buf;
    i = j + 1;
  } else {
    let depth = 0;
    let j = i;
    let buf = '';
    while (j < n) {
      const ch = s[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
      if (ch === '\\' && j + 1 < n && isAsciiPunctuation(s[j + 1])) {
        buf += s[j + 1];
        j += 2;
        continue;
      }
      if (ch === '(') {
        depth++;
        buf += ch;
        j++;
        continue;
      }
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        buf += ch;
        j++;
        continue;
      }
      if (ch.charCodeAt(0) < 32) return null;
      buf += ch;
      j++;
    }
    dest = buf;
    i = j;
  }
  const beforeTitle = i;
  i = skipInlineWs(s, i);
  let title = null;
  if (i < n && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    if (i === beforeTitle) return null;
    const quote = s[i];
    const closeQuote = quote === '(' ? ')' : quote;
    let j = i + 1;
    let buf = '';
    let closed = false;
    while (j < n) {
      const ch = s[j];
      if (ch === '\\' && j + 1 < n && isAsciiPunctuation(s[j + 1])) {
        buf += s[j + 1];
        j += 2;
        continue;
      }
      if (ch === closeQuote) {
        closed = true;
        break;
      }
      buf += ch;
      j++;
    }
    if (!closed) return null;
    title = buf;
    i = j + 1;
    i = skipInlineWs(s, i);
  }
  if (i >= n || s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

// Does `text` contain a link (not an image)? Used to suppress an outer
// link whose text holds one — the inner link wins. Code spans are
// skipped (a [ inside `...` is not a link), and a formed image is
// skipped past so its label is not mistaken for a link.
function textContainsLink(text, refs) {
  if (text.indexOf('[') < 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (text[i] === '!' && text[i + 1] === '[') {
      const img = readLink(text, i + 1, refs, true);
      if (img) {
        i = img.end - 1;
        continue;
      }
    }
    if (text[i] === '[' && text[i - 1] !== '!') {
      if (readLink(text, i, refs, false)) return true;
    }
  }
  return false;
}

// Does `label` contain an unescaped `[`? Link reference labels (and
// shortcut labels) may not: marked's label pattern excludes `[`, so a
// label like ref[bar] can never match a definition — and a definition
// with such a label is not a definition at all.
function labelHasOpenBracket(label) {
  return label.replace(/\\[\s\S]/g, '').indexOf('[') >= 0;
}

// Does a <...> tag or autolink starting inside the link text at
// s[from..to] run past the text's end? When it does, the `]` that
// seemed to close the text is inside the tag, and marked rejects the
// whole link. Code spans and backslash escapes are skipped while
// scanning for `<`.
function labelHasRunawayTag(s, from, to) {
  let i = from;
  while (i < to) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const len = j - i;
      const close = findCodeSpanClose(s, j, len);
      if (close < 0) {
        i = j;
        continue;
      }
      i = close + len;
      continue;
    }
    if (ch === '<') {
      const got = readAngle(s, i);
      if (got && got.end > to) return true;
      if (got) {
        i = got.end;
        continue;
      }
    }
    i++;
  }
  return false;
}

// Try to parse a link or image starting at the `[` at `open`.
// Returns {html, end} or null.
function readLink(s, open, refs, isImg) {
  const close = findLabelClose(s, open);
  if (close < 0) return null;
  const rawText = s.slice(open + 1, close);
  if (labelHasRunawayTag(s, open + 1, close)) return null;
  if (!isImg && textContainsLink(rawText, refs)) return null;
  let dest = null;
  let title = null;
  let end = close + 1;
  const after = s[end];
  if (after === '(') {
    // Inline link — but if the tail fails to parse, fall back to the
    // shortcut reference lookup below ([foo](not a link) with a [foo]
    // definition links to the definition, tail left literal).
    const tail = parseInlineTail(s, end);
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
    const labelEnd = s.indexOf(']', end + 1);
    if (labelEnd >= 0) {
      const label = s.slice(end + 1, labelEnd);
      if (!labelHasOpenBracket(label)) {
        if (label === '') {
          const ref = refs[foldLabel(rawText)];
          if (ref) {
            dest = ref.dest;
            title = ref.title;
            end = labelEnd + 1;
          }
        } else {
          const ref = refs[foldLabel(label)];
          if (ref) {
            dest = ref.dest;
            title = ref.title;
            end = labelEnd + 1;
          } else {
            return null;
          }
        }
      }
    }
  }
  if (dest === null) {
    if (labelHasOpenBracket(rawText)) return null;
    const ref = refs[foldLabel(rawText)];
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = close + 1;
  }
  dest = expandEntities(dest);
  if (title !== null) title = expandEntities(title);
  if (isImg) {
    // The alt text is the link text parsed as normal inline content
    // (links and images inside it do parse) and then stripped of tags
    // — an inner image contributes its own alt text. A tag inside the
    // alt text must not leak anchorOpen out.
    const savedAnchor = anchorOpen;
    const altHtml = renderInlineText(rawText, refs, false);
    anchorOpen = savedAnchor;
    const alt = stripHtmlTags(altHtml);
    let html = '<img src="' + escapeAttribute(encodeDestination(dest)) + '" alt="' + escapeAttribute(alt) + '"';
    if (title !== null) html += ' title="' + escapeAttribute(title) + '"';
    return { html: html + '>', end };
  }
  const savedAnchor = anchorOpen;
  const kids = renderInlineText(rawText, refs, true);
  anchorOpen = savedAnchor;
  let html = '<a href="' + escapeAttribute(encodeDestination(dest)) + '"';
  if (title !== null) html += ' title="' + escapeAttribute(title) + '"';
  return { html: html + '>' + kids + '</a>', end };
}

function stripHtmlTags(html) {
  return html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, '');
}

// Link or image attempt at the scanner's position. For an image the
// `[` is one character past the `!`; a failed image leaves the `!`
// behind and the `[` is retried as a link on the next pass.
function tryLinkAt(st, isImg) {
  const s = st.s;
  const open = isImg ? st.i + 1 : st.i;
  const got = readLink(s, open, st.refs, isImg);
  if (!got) return false;
  flushText(st, st.i);
  st.out.push(got.html);
  st.lastWasText = false;
  st.i = got.end;
  st.textStart = got.end;
  return true;
}

// ------------------------------------------------------------- <angle> --

const CLOSE_TAG_AT = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;
const OPEN_TAG_AT = /<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y;
const DECL_TAG_AT = /<![A-Za-z][^>]*>/y;
const SCHEME_AT = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const EMAIL_AT = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Try <...> at position i: a comment, processing instruction,
// declaration or CDATA section, an HTML tag, or an autolink
// (<scheme:...> or <email>). Returns {html, end, isHtmlTag} or null.
// Tags are tried before autolinks, so <a href="x"> is a tag, not a
// link; closing tags take no attributes.
function readAngle(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { html: '<!-->', end: i + 5, isHtmlTag: true };
    if (s.startsWith('<!--->', i)) return { html: '<!--->', end: i + 6, isHtmlTag: true };
    const end = s.indexOf('-->', i + 4);
    if (end >= 0) return { html: s.slice(i, end + 3), end: end + 3, isHtmlTag: true };
    return null;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end >= 0) return { html: s.slice(i, end + 2), end: end + 2, isHtmlTag: true };
    return null;
  }
  if (s.startsWith('<!', i)) {
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end >= 0) return { html: s.slice(i, end + 3), end: end + 3, isHtmlTag: true };
      return null;
    }
    DECL_TAG_AT.lastIndex = i;
    const dm = DECL_TAG_AT.exec(s);
    if (dm) return { html: dm[0], end: i + dm[0].length, isHtmlTag: true };
    return null;
  }
  if (s.startsWith('</', i)) {
    CLOSE_TAG_AT.lastIndex = i;
    const cm = CLOSE_TAG_AT.exec(s);
    if (cm) return { html: cm[0], end: i + cm[0].length, isHtmlTag: true };
  } else if (/[A-Za-z]/.test(s[i + 1] || '')) {
    OPEN_TAG_AT.lastIndex = i;
    const om = OPEN_TAG_AT.exec(s);
    if (om) return { html: om[0], end: i + om[0].length, isHtmlTag: true };
  }
  const gt = s.indexOf('>', i + 1);
  if (gt > 0) {
    const inner = s.slice(i + 1, gt);
    if (inner.indexOf(' ') < 0 && inner.indexOf('<') < 0 && inner.indexOf('\n') < 0) {
      if (SCHEME_AT.test(inner)) {
        const href = encodeDestination(inner);
        return { html: '<a href="' + escapeAttribute(href) + '">' + escapeText(inner) + '</a>', end: gt + 1, isHtmlTag: false };
      }
      if (EMAIL_AT.test(inner)) {
        const href = 'mailto:' + inner;
        return { html: '<a href="' + escapeAttribute(href) + '">' + escapeText(inner) + '</a>', end: gt + 1, isHtmlTag: false };
      }
    }
  }
  return null;
}

// < attempt at the scanner's position. An opening <a tag (with a
// space after the a) opens the document-wide anchor state; a literal
// </a> closes it.
function tryAngleAt(st) {
  const s = st.s;
  const i = st.i;
  const got = readAngle(s, i);
  if (!got) return false;
  flushText(st, i);
  st.out.push(got.html);
  st.lastWasText = false;
  if (got.isHtmlTag) {
    const tag = got.html;
    if ((tag[1] === 'a' || tag[1] === 'A') && tag[2] === ' ') anchorOpen = true;
    else if (tag[1] === '/' && (tag[2] === 'a' || tag[2] === 'A') && tag[3] === '>') anchorOpen = false;
  }
  st.i = got.end;
  st.textStart = got.end;
  return true;
}

// -------------------------------------------------------- GFM autolinks --
//
// Extended autolinks, as marked implements them (probed). Schemes
// http/https/ftp match case-insensitively per letter; www. must be
// lowercase. The host is one or more alnum/hyphen labels (a dot is NOT
// required: www.foo links), then any run of non-space, non-<
// characters. The e-mail pattern's trailing (?![\w-]) lookahead is
// what makes a.b-c_d@a.b- stay literal while a.b-c_d@a.b. links.
const SCHEME_LINK_RE = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const WWW_LINK_RE = /www\.(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const BARE_EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const MAILTO_LINK_RE = /(?:mailto:|xmpp:)[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?/y;

// Trailing-punctuation trim for autolinks (marked's "backpedal"):
// the kept prefix is built from safe chunks — runs of characters that
// are not trailing punctuation, balanced (...) groups, and & not
// starting an &name; entity at the very end — plus punctuation runs
// that are not at the end. Applied repeatedly until stable, it drops
// trailing ?!.,:;*_'\"~ and unbalanced ) while keeping ] } and
// balanced parens, and drops a trailing &name; whole.
const AUTOLINK_TRIM_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

function trimAutolinkTail(url) {
  let prev;
  do {
    prev = url;
    const m = AUTOLINK_TRIM_RE.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return url;
}

// GFM extended autolink at position i. `fresh` says the position
// follows a non-text token (a code span, link, tag, break or delimiter
// run), which counts as a word boundary for www. Returns {html, end}
// or null.
function readExtendedAutolink(s, i, fresh, tryEmail) {
  const ch = s[i];
  const prev = i > 0 ? s[i - 1] : '';
  // mailto: / xmpp: (lowercase only) need a non-alphanumeric before
  // them, so xmailto: is not a scheme (its bare e-mail still links).
  if ((ch === 'm' || ch === 'x') && (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) &&
    (prev === '' || !/[A-Za-z0-9]/.test(prev))) {
    MAILTO_LINK_RE.lastIndex = i;
    const mm = MAILTO_LINK_RE.exec(s);
    if (mm) {
      const url = trimAutolinkTail(mm[0]);
      if (url) return { html: '<a href="' + escapeAttribute(encodeDestination(url)) + '">' + escapeText(url) + '</a>', end: i + url.length };
    }
  }
  // http(s):// and ftp:// link anywhere, even mid-word (xhttp://...).
  if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
    SCHEME_LINK_RE.lastIndex = i;
    const m = SCHEME_LINK_RE.exec(s);
    if (m) {
      const url = trimAutolinkTail(m[0]);
      if (url) return { html: '<a href="' + escapeAttribute(encodeDestination(url)) + '">' + escapeText(url) + '</a>', end: i + url.length };
    }
  }
  // www. needs a boundary: start, whitespace, ( * _ ~ [, or a fresh
  // token position. After " ! . : / { } ; and the like it stays text.
  if (ch === 'w' && s.startsWith('www.', i) &&
    (fresh || prev === '' || prev === ' ' || prev === '\t' || prev === '\n' ||
      prev === '(' || prev === '*' || prev === '_' || prev === '~' || prev === '[')) {
    WWW_LINK_RE.lastIndex = i;
    const m = WWW_LINK_RE.exec(s);
    if (m) {
      const url = trimAutolinkTail(m[0]);
      if (url) return { html: '<a href="' + escapeAttribute(encodeDestination('http://' + url)) + '">' + escapeText(url) + '</a>', end: i + url.length };
    }
  }
  if (tryEmail) return readBareEmail(s, i);
  return null;
}

// Bare e-mail autolink at position i. The pattern itself rejects a
// trailing - or _ (the (?![\w-]) lookahead), so a.b-c_d@a.b- is
// literal. A cheap pre-scan first: the local part must reach an @.
function readBareEmail(s, i) {
  let j = i;
  const n = s.length;
  while (j < n) {
    const code = s.charCodeAt(j);
    if (code === 64) break; // @
    if (!isEmailLocalCode(code)) return null;
    j++;
  }
  if (j >= n) return null;
  BARE_EMAIL_RE.lastIndex = i;
  const m = BARE_EMAIL_RE.exec(s);
  if (m) {
    const email = m[0];
    return { html: '<a href="mailto:' + email + '">' + escapeText(email) + '</a>', end: i + email.length };
  }
  return null;
}

// GFM autolink attempt at the scanner's position. A bare e-mail's
// local part is a maximal run of [A-Za-z0-9._+-]: the e-mail regex
// only needs trying at the run's start (a later position in the same
// run shares the @ and domain, so it cannot succeed where the run
// start failed). The run starts here when the previous character is
// not a local-part character, or when a token just ended (the run's
// start was inside the token).
function tryGfmAt(st) {
  const s = st.s;
  const i = st.i;
  const fresh = st.textStart === i && !st.lastWasText;
  const tryEmail = st.textStart === i || !isEmailLocalCode(i > 0 ? s.charCodeAt(i - 1) : -1);
  const got = readExtendedAutolink(s, i, fresh, tryEmail);
  if (!got) return false;
  flushText(st, i);
  st.out.push(got.html);
  st.lastWasText = false;
  st.i = got.end;
  st.textStart = got.end;
  return true;
}

// --------------------------------------------------------- block engine --
//
// Block parsing follows the CommonMark reference algorithm: a stack
// of open containers (block quotes, list items) is matched against
// every line, then new leaf blocks are opened at the remaining
// content. Tabs are handled by column, so a tab that straddles an
// indent boundary contributes spaces.

// A cursor over one physical line, tracking the visual column. A tab
// that is only partly consumed leaves `pending` spaces behind, which
// read as spaces until they run out.
class Cursor {
  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.col = 0;
    this.pending = 0;
  }

  clone() {
    const c = new Cursor(this.text);
    c.pos = this.pos;
    c.col = this.col;
    c.pending = this.pending;
    return c;
  }

  copyFrom(other) {
    this.pos = other.pos;
    this.col = other.col;
    this.pending = other.pending;
  }

  peek() {
    if (this.pending > 0) return ' ';
    return this.pos < this.text.length ? this.text[this.pos] : '';
  }

  // Consume `n` columns. Returns false if the line runs out first.
  advance(n) {
    while (n > 0) {
      if (this.pending > 0) {
        const take = Math.min(this.pending, n);
        this.pending -= take;
        this.col += take;
        n -= take;
      } else if (this.pos >= this.text.length) {
        return false;
      } else if (this.text[this.pos] === '\t') {
        const width = 4 - (this.col % 4);
        this.pos++;
        if (width <= n) {
          this.col += width;
          n -= width;
        } else {
          this.pending = width - n;
          this.col += n;
          n = 0;
        }
      } else {
        this.pos++;
        this.col++;
        n--;
      }
    }
    return true;
  }

  // Skip up to `maxCols` columns of spaces/tabs. Returns how many
  // columns were actually skipped.
  skipSpaces(maxCols) {
    let skipped = 0;
    while (skipped < maxCols) {
      const ch = this.peek();
      if (ch !== ' ' && ch !== '\t') break;
      this.advance(1);
      skipped++;
    }
    return skipped;
  }

  rest() {
    return ' '.repeat(this.pending) + this.text.slice(this.pos);
  }

  isBlank() {
    if (this.pending > 0) return true;
    for (let k = this.pos; k < this.text.length; k++) {
      if (this.text[k] !== ' ' && this.text[k] !== '\t') return false;
    }
    return true;
  }
}

// Visual column of the first non-space/tab character, and its char
// index. `base` is the absolute column the text starts at: tab widths
// depend on the absolute column, so a tab after a stripped container
// prefix must be measured from the line start, not from the stripped
// text's start.
function visualIndent(text, base) {
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

// The content of a line starting at visual column `col` (a tab
// straddling the boundary contributes spaces). `base` is the absolute
// column the text starts at.
function sliceAtColumn(text, col, base) {
  base = base || 0;
  let c = 0;
  let i = 0;
  while (i < text.length && c < col) {
    if (text[i] === '\t') {
      const w = 4 - ((base + c) % 4);
      if (c + w > col) return ' '.repeat(c + w - col) + text.slice(i + 1);
      c += w;
      i++;
    } else {
      c++;
      i++;
    }
  }
  return text.slice(i);
}

// Remove up to `n` columns of leading spaces/tabs (tab-aware from
// `base`). Unlike sliceAtColumn, this only removes whitespace: a line
// with no leading spaces is returned unchanged. A tab that straddles
// the cut leaves spaces for its remainder.
function stripColumns(text, n, base) {
  base = base || 0;
  let c = 0;
  let i = 0;
  while (i < text.length && c < n) {
    const ch = text[i];
    if (ch === ' ') {
      c++;
      i++;
    } else if (ch === '\t') {
      const w = 4 - ((base + c) % 4);
      if (c + w > n) return ' '.repeat(c + w - n) + text.slice(i + 1);
      c += w;
      i++;
    } else {
      break;
    }
  }
  return text.slice(i);
}

// Strip up to `n` leading whitespace CHARACTERS (spaces or tabs, each
// counting as one) from a fenced code line. Only backtick fences strip
// (marked's indentCodeCompensation); tilde fences keep every line
// untouched. `strip` is false for tilde fences.
function stripFenceColumns(text, n, strip) {
  if (!strip || n <= 0) return text;
  let i = 0;
  while (i < text.length && i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(i);
}

// Does the cursor's remainder start with whitespace containing a tab?
// Used to find the outermost container whose strip exposes a leading
// tab: marked expands such tabs (from that level's columns) before
// lexing the content, so the expansion base is the cursor column
// before that strip.
function restStartsWithTab(cur) {
  let k = cur.pos;
  while (k < cur.text.length && (cur.text[k] === ' ' || cur.text[k] === '\t')) {
    if (cur.text[k] === '\t') return true;
    k++;
  }
  return false;
}

// The cursor's remainder with leading tabs expanded to spaces, as
// marked does when it extracts a container's content. `expandBase` is
// the cursor column before the outermost strip that exposed a leading
// tab (null when no container strip exposed one, in which case the
// text is returned untouched — top-level lines keep their literal
// tabs). Expansion starts at column (cur.col - expandBase): the
// content's first character in the expansion level's text.
function expandLeadingTabs(cur, expandBase) {
  const content = cur.rest();
  if (expandBase === null) return content;
  let i = 0;
  let hasTab = false;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) {
    if (content[i] === '\t') {
      hasTab = true;
      break;
    }
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
    } else {
      out += ' ';
      col++;
    }
    j++;
  }
  return out + content.slice(j);
}

const ATX_HEAD_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const THEMATIC_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_UNDER_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const BULLET_MARK_RE = /^ {0,3}([-+*])([ \t]+|$)/;
const ORDERED_MARK_RE = /^ {0,3}(\d{1,9})([.)])([ \t]+|$)/;
const TABLE_CELL_RE = /^:?-+:?$/;

function isBlankText(text) {
  return /^[ \t]*$/.test(text);
}

// ------------------------------------------- link reference definitions --

// Parse a link destination starting at s[i], then an optional title.
// Returns {dest, title, maybeTitle} or null. `maybeTitle` means the
// line ended right after the destination: a title may still follow on
// the next line (CommonMark spec example 192). An unterminated title
// returns {dest, titlePartial} instead — the definition stays pending
// until the title closes on a following line.
function readDestTitle(s, i) {
  let dest = '';
  if (s[i] === '<') {
    let j = i + 1;
    let buf = '';
    while (j < s.length && s[j] !== '>') {
      if (s[j] === '\n') return null;
      if (s[j] === '\\' && j + 1 < s.length && isAsciiPunctuation(s[j + 1])) {
        buf += s[j + 1];
        j += 2;
        continue;
      }
      buf += s[j];
      j++;
    }
    if (j >= s.length) return null;
    dest = buf;
    i = j + 1;
  } else {
    let j = i;
    let buf = '';
    let depth = 0;
    while (j < s.length) {
      const ch = s[j];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
      if (ch === '\\' && j + 1 < s.length && isAsciiPunctuation(s[j + 1])) {
        buf += s[j + 1];
        j += 2;
        continue;
      }
      if (ch === '(') {
        depth++;
        buf += ch;
        j++;
        continue;
      }
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        buf += ch;
        j++;
        continue;
      }
      if (ch.charCodeAt(0) < 32) return null;
      buf += ch;
      j++;
    }
    if (buf === '') return null;
    dest = buf;
    i = j;
  }
  const beforeTitle = i;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  let title = null;
  let maybeTitle = false;
  if (i < s.length) {
    const quote = s[i];
    if (quote === '"' || quote === "'" || quote === '(') {
      // A title needs whitespace before it: [foo]: <bar>(baz) is not
      // a definition.
      if (i === beforeTitle) return null;
      const closeQuote = quote === '(' ? ')' : quote;
      let j = i + 1;
      let buf = '';
      let closed = false;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '\\' && j + 1 < s.length && isAsciiPunctuation(s[j + 1])) {
          buf += s[j + 1];
          j += 2;
          continue;
        }
        if (ch === closeQuote) {
          closed = true;
          break;
        }
        if (quote === '(' && ch === '(') return null;
        buf += ch;
        j++;
      }
      if (!closed) {
        return { dest: expandEntities(dest), titlePartial: { quote, text: buf }, maybeTitle: false };
      }
      title = buf;
      i = j + 1;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      if (i < s.length) return null;
    } else {
      return null;
    }
  } else {
    maybeTitle = true;
  }
  return { dest: expandEntities(dest), title: title === null ? null : expandEntities(title), maybeTitle };
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
function tryReferenceDefinition(content) {
  const m = /^ {0,3}\[/.exec(content);
  if (!m) return null;
  const openIdx = m[0].length - 1;
  let j = openIdx + 1;
  let closeIdx = -1;
  while (j < content.length) {
    const ch = content[j];
    if (ch === '\\' && j + 1 < content.length) {
      j += 2;
      continue;
    }
    if (ch === '[') return null;
    if (ch === ']') {
      closeIdx = j;
      break;
    }
    j++;
  }
  if (closeIdx < 0) return { labelPartial: true, raw: content };
  const label = content.slice(openIdx + 1, closeIdx);
  if (label.trim() === '') return null;
  let i = closeIdx + 1;
  if (content[i] !== ':') return null;
  i++;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return { label: foldLabel(label), awaitingDest: true, raw: [content] };
  const res = readDestTitle(content, i);
  if (!res) return null;
  if (res.titlePartial) return { label: foldLabel(label), dest: res.dest, titlePartial: res.titlePartial, raw: [content] };
  return { label: foldLabel(label), dest: res.dest, title: res.title, maybeTitle: res.maybeTitle };
}

// Parse a destination (+ optional title) on a definition continuation
// line. The line may be indented arbitrarily (spec example 193).
// Returns {dest, title, maybeTitle} (or a titlePartial variant) or null.
function readDestLine(content) {
  let i = 0;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return null;
  return readDestTitle(content, i);
}

// A line consisting only of a link title (for a definition whose title
// is on the following line). The line may be indented arbitrarily
// (spec example 193). Returns the title string, {partial: {quote,
// text}} when the title runs onto a following line, or null when the
// line is not a title.
function readTitleLine(content) {
  let i = 0;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return null;
  const quote = content[i];
  if (quote !== '"' && quote !== "'" && quote !== '(') return null;
  const closeQuote = quote === '(' ? ')' : quote;
  let j = i + 1;
  let buf = '';
  while (j < content.length) {
    const ch = content[j];
    if (ch === '\\' && j + 1 < content.length && isAsciiPunctuation(content[j + 1])) {
      buf += content[j + 1];
      j += 2;
      continue;
    }
    if (ch === closeQuote) {
      j++;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      return j >= content.length ? buf : null;
    }
    if (quote === '(' && ch === '(') return null;
    buf += ch;
    j++;
  }
  return { partial: { quote, text: buf } };
}

// ------------------------------------------------------------------ HTML --

// HTML block start conditions (CommonMark types 1-7). Returns the type
// (1-7) or 0 when the line does not start an HTML block. `inParagraph`
// matters only for type 7.
const HTML_TYPE1_RE = /^ {0,3}<(script|pre|style|textarea)([\s>]|$)/i;
const HTML_TYPE2_RE = /^ {0,3}<!--/;
const HTML_TYPE3_RE = /^ {0,3}<\?/;
const HTML_TYPE4_RE = /^ {0,3}<![A-Za-z]/;
const HTML_TYPE5_RE = /^ {0,3}<!\[CDATA\[/;
const HTML_TYPE6_RE = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s\/>]|$)/i;
const HTML_TYPE7_OPEN_RE = /^ {0,3}<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>[ \t]*$/;
const HTML_TYPE7_CLOSE_RE = /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/;

function htmlBlockKind(content, inParagraph) {
  // Type 1 starts with an OPENING script/pre/style/textarea tag only;
  // a closing tag such as </pre> is not an HTML block start.
  if (HTML_TYPE1_RE.test(content)) return 1;
  if (HTML_TYPE2_RE.test(content)) return 2;
  if (HTML_TYPE3_RE.test(content)) return 3;
  if (HTML_TYPE4_RE.test(content)) return 4;
  if (HTML_TYPE5_RE.test(content)) return 5;
  if (HTML_TYPE6_RE.test(content)) return 6;
  // Type 7: a complete open or close tag alone on its line. Closing
  // tags take no attributes (</a href="foo"> is not an HTML block).
  if (!inParagraph && HTML_TYPE7_OPEN_RE.test(content)) return 7;
  if (!inParagraph && HTML_TYPE7_CLOSE_RE.test(content)) return 7;
  return 0;
}

const HTML_END1_RE = /<\/(script|pre|style|textarea)>/i;
const HTML_END2_RE = /-->/;
const HTML_END3_RE = /\?>/;
const HTML_END4_RE = />/;
const HTML_END5_RE = /\]\]>/;

function htmlBlockCloses(type, content) {
  if (type === 1) return HTML_END1_RE.test(content);
  if (type === 2) return HTML_END2_RE.test(content);
  if (type === 3) return HTML_END3_RE.test(content);
  if (type === 4) return HTML_END4_RE.test(content);
  if (type === 5) return HTML_END5_RE.test(content);
  return false; // types 6 and 7 end at a blank line
}

// ---------------------------------------------------------------- tables --

// Split a table row line into cells (unescaped pipes; optional outer pipes).
function splitRowCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// If `content` is a table delimiter row, return its alignments
// (null/left/right/center per column); otherwise null.
function delimiterAlignments(content) {
  const cells = splitRowCells(content);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!TABLE_CELL_RE.test(t)) return null;
    aligns.push(t.startsWith(':') ? (t.endsWith(':') ? 'center' : 'left') : (t.endsWith(':') ? 'right' : null));
  }
  return aligns;
}

// ------------------------------------------------------- document parser --
//
// Node shapes (all plain objects):
//   document/blockquote/list/item: {type, children}
//   paragraph: {type, lines, inItem, ...code-merge bookkeeping}
//   heading: {type, level, text}
//   code: {type, fenced, fenceChar, fenceLen, info, fenceIndent, lines}
//   html: {type, htmlType, lines, startLine, endLine, endedAtBlank}
//   hr: {type}
//   table: {type, header, aligns, rows}
//   list: {type, ordered, start, delim, tight, children, markerCol}
//   item: {type, indent, children}

class DocumentParser {
  constructor(src, refs) {
    this.src = src;
    this.refs = refs;
    this.lines = src.split('\n');
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
    this.root = { type: 'document', children: [] };
    this.stack = [this.root];
    this.tip = null; // currently open leaf block, if any
    this.pendingDef = null; // a definition awaiting its title on the next line
    this.pendingLabel = null; // a definition awaiting its destination ({label, raw: [lines]})
    this.pendingLabelPartial = null; // a definition whose label spans lines ({parts: [lines]})
    this.pendingTitle = null; // a definition whose title spans lines ({label, dest, quote, buf, rawLines})
    // Snapshot of the container stack at the most recent structural
    // blank line. A list (or an item's parent list) that is still open
    // when the next block starts inside it becomes loose — but only
    // the lists the blank line actually passed through, so a blank
    // inside a nested list leaves the outer list tight.
    this.blankStack = null;
    // Set when the current line was consumed entirely as link
    // reference definition material (no block created): a definition
    // line does not consume a pending blank line's loose-marking effect.
    this.lineWasDef = false;
  }

  top() {
    return this.stack[this.stack.length - 1];
  }

  addChild(parent, node) {
    parent.children.push(node);
    // A blank line passed through this item and it already had a
    // child: the blank separates two blocks inside the item, so the
    // parent list is loose.
    if (this.blankStack && parent.type === 'item' && this.blankStack.indexOf(parent) >= 0 && parent.children.length > 1) {
      const list = this.stack[this.stack.indexOf(parent) - 1];
      if (list && list.type === 'list') list.tight = false;
    }
    return node;
  }

  closeLeaf() {
    this.tip = null;
  }

  // Close open blocks down to (but excluding) `depth` stack depth.
  closeTo(depth) {
    while (this.stack.length > depth) this.stack.pop();
    this.tip = null;
  }

  // Match the open containers against `raw`. Returns {depth,
  // allMatched, cur, blankNodes, expandBase}: `depth` is the stack
  // index where matching stopped (or stack.length when everything
  // matched), `cur` the cursor at that point (its rest is the line's
  // content there), and `blankNodes` the containers whose remainder
  // after matching is blank — a blank line only separates blocks in
  // those containers (a `>` line is blank inside its blockquote, but
  // not inside the enclosing list item).
  matchContainers(raw) {
    const cur = new Cursor(raw);
    let depth = 1; // stack index of the first container to match
    let allMatched = true;
    const blankNodes = [];
    // Cursor column before the outermost strip that exposed a leading
    // tab in the remainder (null when none did). Drives expandLeadingTabs.
    let expandBase = null;
    if (cur.isBlank()) blankNodes.push(this.stack[0]);
    while (depth < this.stack.length) {
      const node = this.stack[depth];
      if (node.type === 'list') {
        if (cur.isBlank()) blankNodes.push(node);
        depth++;
        continue;
      } // transparent
      if (node.type === 'blockquote') {
        const probe = cur.clone();
        probe.skipSpaces(3);
        if (probe.peek() === '>') {
          const colBefore = cur.col;
          probe.advance(1);
          if (probe.peek() === '\t') {
            // A tab right after `>` is expanded from its column in
            // the post-strip text (marked expands the marker
            // whitespace first, then strips the marker plus one
            // space), so the remainder starts with (width - 1)
            // spaces where width is measured from the strip's frame,
            // not the original line column.
            const tabCol = probe.col - colBefore;
            probe.advance(1);
            probe.pending = (4 - (tabCol % 4)) - 1;
          } else if (probe.peek() === ' ') {
            probe.advance(1);
          }
          cur.copyFrom(probe);
          if (expandBase === null && restStartsWithTab(cur)) expandBase = colBefore;
          if (cur.isBlank()) blankNodes.push(node);
          depth++;
          continue;
        }
        allMatched = false;
        break;
      }
      if (node.type === 'item') {
        if (cur.isBlank()) {
          // A blank line consumes up to the item's content indent, so
          // a code block inside the item sees the remainder (usually '').
          const colBefore = cur.col;
          cur.advance(node.indent);
          if (expandBase === null && restStartsWithTab(cur)) expandBase = colBefore;
          blankNodes.push(node);
          depth++;
          continue;
        }
        const rest = cur.rest();
        const ind = visualIndent(rest, cur.col);
        if (ind.col >= node.indent) {
          const colBefore = cur.col;
          cur.advance(node.indent);
          if (expandBase === null && restStartsWithTab(cur)) expandBase = colBefore;
          if (cur.isBlank()) blankNodes.push(node);
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
  lookAheadFrom(li) {
    let j = li + 1;
    while (j < this.lines.length && isBlankText(this.lines[j])) j++;
    if (j >= this.lines.length) return null;
    const blanks = j - li;
    const { depth, allMatched, cur, expandBase } = this.matchContainers(this.lines[j]);
    const content = expandLeadingTabs(cur, expandBase);
    const contentBase = cur.col;
    // A code line inside the same item: all containers matched and the
    // content starts with 4+ columns of indentation.
    const isCodeLine = allMatched && visualIndent(content, contentBase).col >= 4;
    // A sibling item: matching stopped at an item whose parent list
    // the line's marker continues (same column, same ordered/delim).
    let isSiblingItem = false;
    if (!allMatched && this.stack[depth] && this.stack[depth].type === 'item') {
      const list = this.stack[depth - 1];
      if (list && list.type === 'list') {
        const bm = BULLET_MARK_RE.exec(content);
        const om = !bm && ORDERED_MARK_RE.exec(content);
        if (bm || om) {
          const markerCol = contentBase + visualIndent(content, contentBase).col;
          const ordered = !!om;
          const delim = ordered ? om[2] : bm[1];
          if (markerCol === list.markerCol && list.ordered === ordered && list.delim === delim) isSiblingItem = true;
        }
      }
    }
    return { blanks, depth, allMatched, content, contentBase, isCodeLine, isSiblingItem };
  }

  // The main line loop. Returns the document's top-level nodes.
  run() {
    const lines = this.lines;
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];

      // --- 1. Match open containers.
      const { depth, allMatched, cur, blankNodes, expandBase } = this.matchContainers(raw);
      const content = expandLeadingTabs(cur, expandBase);
      const contentBase = cur.col; // absolute column the content starts at
      const blank = isBlankText(content);

      // --- 2. Container mismatch: lazy leaf continuation or close.
      if (!allMatched) {
        const para = this.tip && this.tip.type === 'paragraph' ? this.tip : null;
        // A line starting a block (heading, fence, HTML, HR,
        // blockquote, or a list item when inside a list item) ends the
        // containers; anything else may continue the open leaf lazily.
        // A fenced code block or HTML block only absorbs a lazy line
        // once it already has content (an opener alone does not); a
        // table always does.
        const listLine = BULLET_MARK_RE.test(content) || ORDERED_MARK_RE.test(content);
        const inItem = this.stack.some((n) => n.type === 'item');
        const bqLine = /^ {0,3}>/.test(content);
        const blockStart = !blank && (startsBlockInterrupt(content) || bqLine || (listLine && inItem));
        // A fenced code block, HTML block or table absorbs a lazy line
        // only when the tip sits inside a list item at or below the
        // mismatch point: marked's blockquote tokenizer ends the quote
        // when its last token is code/html/table, but re-lexes a list
        // — so a fence in an item in a quote absorbs, while a fence
        // directly in a quote (or in a quote in an item) does not.
        let inListAtMismatch = false;
        for (let k = depth; k < this.stack.length; k++) {
          if (this.stack[k].type === 'item') {
            inListAtMismatch = true;
            break;
          }
        }
        const lazyPara = para && !blank && !blockStart;
        if (lazyPara) {
          // Keep containers open; the line continues the paragraph.
          this.blankStack = null;
          const ind = visualIndent(content, contentBase);
          if (ind.col >= 4) {
            // Code-merge: a lazy line that is code-indented merges
            // into the paragraph with 4 columns stripped (marked's
            // list-loop code merge, which also applies to lazy lines
            // inside blockquotes). Absorbed blanks before it become
            // empty lines.
            if (para.pendingBlanksAfterCode) {
              for (let k = 0; k < para.pendingBlanksAfterCode; k++) para.lines.push('');
              para.noSetext = true;
              para.pendingBlanksAfterCode = 0;
            }
            para.codeMergeOrig = para.codeMergeOrig || [];
            para.codeMergeOrig[para.lines.length] = content;
            para.lines.push(sliceAtColumn(content, 4, contentBase));
            para.lastWasCodeMerge = true;
            para.lastWasLazy = true;
          } else {
            // A lazy non-code line after a code-merged line does NOT
            // contribute an empty line (the '' rule applies only to
            // lines that match the item container, in handleContent).
            if (para.pendingBlanksAfterCode) {
              for (let k = 0; k < para.pendingBlanksAfterCode; k++) para.lines.push('');
              para.noSetext = true;
              para.pendingBlanksAfterCode = 0;
            }
            para.lastWasCodeMerge = false;
            // A lazy line that looks like a setext underline cannot be
            // one, so it is kept as paragraph text with 4 spaces
            // prepended — but only when the previous line was also a
            // lazy line and the paragraph sits in a blockquote (in a
            // list item the prepend is undone by the code merge, so it
            // nets to nil).
            const parentIsBq = this.top().type === 'blockquote';
            para.lines.push(SETEXT_UNDER_RE.test(content) && para.lastWasLazy && parentIsBq ? '    ' + content : content);
            para.lastWasLazy = true;
          }
          continue;
        }
        if (!blank && !blockStart && inListAtMismatch && this.tip && this.tip.type === 'code' && this.tip.fenced && this.tip.lines.length > 0) {
          // Lazy fenced-code content: the line is kept unstripped
          // (past the containers that did match), with the fence's own
          // indentation stripped as usual.
          this.blankStack = null;
          this.tip.lines.push(stripFenceColumns(content, this.tip.fenceIndent || 0, this.tip.fenceChar === '`'));
          continue;
        }
        if (!blank && !blockStart && inListAtMismatch && this.tip && this.tip.type === 'html' && this.tip.lines.length > 1) {
          // Lazy HTML content.
          this.blankStack = null;
          this.tip.lines.push(content);
          this.tip.endLine = li;
          if (this.tip.htmlType <= 5 && htmlBlockCloses(this.tip.htmlType, content)) this.closeLeaf();
          continue;
        }
        if (!blank && !blockStart && inListAtMismatch && this.tip && this.tip.type === 'table') {
          // A lazy line after a table is another row.
          this.blankStack = null;
          this.tip.rows.push(splitRowCells(content));
          continue;
        }
        // Close unmatched containers (and the open leaf).
        this.closeTo(depth);
      }
      if (blank) {
        // Blank line: it may end a pending definition (the label line
        // becomes paragraph text, spec example 199), is content inside
        // code blocks and HTML blocks of types 1-5, ends HTML blocks
        // of types 6-7, paragraphs and tables, and marks a list as
        // loose. A blank line also ends a multi-line label, and a
        // multi-line single-quote title — but " and ( titles may span
        // blank lines.
        //
        // Exception: a whitespace-only remainder line is paragraph
        // CONTENT when it is the last line of its container's text —
        // for a blockquote, when the next line does not re-enter the
        // blockquote; at the top level, when it is the last line of
        // input and the source has no trailing newline. Inside a list
        // item it is never content.
        if (this.tip && this.tip.type === 'paragraph' && content !== '') {
          const parent = this.top();
          let isContent = false;
          if (parent.type === 'blockquote') {
            if (li + 1 >= lines.length) {
              isContent = true;
            } else {
              const next = this.matchContainers(lines[li + 1]);
              if (next.depth <= this.stack.length - 1) isContent = true;
            }
          } else if (parent.type === 'document' && li === lines.length - 1 && !this.src.endsWith('\n')) {
            isContent = true;
          }
          if (isContent) {
            this.tip.lines.push(content);
            this.tip.lastWasLazy = false;
            continue;
          }
        }
        if (this.pendingLabelPartial) {
          this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingLabelPartial.parts, inItem: this.top().type === 'item' });
          this.pendingLabelPartial = null;
        }
        if (this.pendingTitle && this.pendingTitle.quote === "'") {
          if (this.pendingTitle.registered) delete this.refs[this.pendingTitle.label];
          this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingTitle.rawLines, inItem: this.top().type === 'item' });
          this.pendingTitle = null;
        } else if (this.pendingTitle) {
          this.pendingTitle.buf += '\n' + content;
          this.pendingTitle.rawLines.push(content);
          continue;
        }
        if (this.pendingLabel) {
          this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingLabel.raw, inItem: this.top().type === 'item' });
          this.pendingLabel = null;
        }
        if (this.pendingDef) this.pendingDef = null;
        if (this.tip && this.tip.type === 'table' && content !== '' && !/^ *$/.test(content) && !(li === lines.length - 1 && !this.src.endsWith('\n'))) {
          // A whitespace-only line that is not spaces-only (it holds a
          // tab) is a table row, not a blank line: marked's table body
          // excludes only empty and spaces-only lines. The one
          // exception is a trailing tab-only line at EOF without a
          // newline, which marked's tableRowBlankLine strips.
          this.tip.rows.push(splitRowCells(content));
          continue;
        }
        if (this.tip && this.tip.type === 'code') {
          // A blank line inside fenced code keeps its content past the
          // fence's indentation; inside indented code it keeps the
          // spaces past the 4-column indent.
          this.tip.lines.push(this.tip.fenced ? stripFenceColumns(content, this.tip.fenceIndent || 0, this.tip.fenceChar === '`') : stripColumns(content, 4, contentBase));
          continue;
        }
        if (this.tip && this.tip.type === 'html') {
          if (this.tip.htmlType === 6 || this.tip.htmlType === 7) {
            this.tip.endedAtBlank = true;
            this.closeLeaf();
          } else {
            this.tip.lines.push(content);
            this.tip.endLine = li;
          }
          continue;
        }
        // A blank after a code-merged line is absorbed when the next
        // non-blank line is another code line inside the same item: it
        // becomes an empty line in the paragraph (no close, no loose
        // marking). Exactly one blank before a sibling item leaves a
        // trailing empty line on the code-merged paragraph instead.
        if (this.tip && this.tip.type === 'paragraph' && this.tip.lastWasCodeMerge && this.tip.inItem) {
          const ahead = this.lookAheadFrom(li);
          if (ahead && ahead.isCodeLine) {
            this.tip.pendingBlanksAfterCode = (this.tip.pendingBlanksAfterCode || 0) + 1;
            continue;
          }
          if (ahead && ahead.blanks === 1 && ahead.isSiblingItem) this.tip.lines.push('');
        }
        if (this.tip && this.tip.type === 'paragraph') this.closeLeaf();
        if (this.tip && this.tip.type === 'table') this.closeLeaf();
        // An empty item ends at a blank line (its content, if any,
        // sits outside the list).
        while (this.stack.length > 1 && this.top().type === 'item' && this.top().children.length === 0) this.stack.pop();
        // Only the containers the blank line is actually blank inside
        // (a `>` line counts for its blockquote, not for the item).
        this.blankStack = blankNodes;
        continue;
      }

      // --- 3. Open leaf blocks: fenced code, indented code, HTML block.
      if (this.tip && this.tip.type === 'code' && this.tip.fenced) {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
        if (m && m[1][0] === this.tip.fenceChar && m[1].length >= this.tip.fenceLen) {
          this.closeLeaf();
          continue;
        }
        // Backtick fences strip up to the opening fence's indentation
        // (counted in CHARACTERS, spaces or tabs) from each line;
        // tilde fences strip nothing.
        this.tip.lines.push(stripFenceColumns(content, this.tip.fenceIndent || 0, this.tip.fenceChar === '`'));
        this.blankStack = null;
        continue;
      }
      if (this.tip && this.tip.type === 'code' && !this.tip.fenced) {
        const ind = visualIndent(content, contentBase);
        if (ind.col >= 4) {
          this.tip.lines.push(sliceAtColumn(content, 4, contentBase));
          continue;
        }
        this.closeLeaf();
        // fall through: reprocess this line as a new block
      }
      if (this.tip && this.tip.type === 'html') {
        if (this.tip.htmlType <= 5 && htmlBlockCloses(this.tip.htmlType, content)) {
          // The line that ends the block is part of the block.
          this.tip.lines.push(content);
          this.tip.endLine = li;
          this.closeLeaf();
          this.blankStack = null;
          continue;
        }
        this.tip.lines.push(content);
        this.tip.endLine = li;
        this.blankStack = null;
        continue;
      }

      // --- 4. Open (or continue) blocks at this line.
      this.lineWasDef = false;
      this.handleContent(content, li, contentBase);
      if (!this.lineWasDef) this.blankStack = null;
    }

    // EOF: a definition that never completed becomes paragraph text
    // ([foo]: at the end of input renders as <p>[foo]:</p>). A title
    // that never closed fails the whole definition, so an already
    // registered one is unregistered again.
    if (this.pendingLabelPartial) {
      this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingLabelPartial.parts, inItem: this.top().type === 'item' });
      this.pendingLabelPartial = null;
    }
    if (this.pendingLabel) {
      this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingLabel.raw, inItem: this.top().type === 'item' });
      this.pendingLabel = null;
    }
    if (this.pendingTitle) {
      if (this.pendingTitle.registered) delete this.refs[this.pendingTitle.label];
      this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingTitle.rawLines, inItem: this.top().type === 'item' });
      this.pendingTitle = null;
    }

    this.finalize(this.root, false, false);
    return this.root.children;
  }

  // Process one line's content as the start or continuation of blocks
  // inside the currently open containers. Called once per physical
  // line and recursively for a list item's or blockquote's first-line
  // remainder. Returns when the line is consumed.
  handleContent(content, lineIdx, base) {
    base = base || 0;
    // A definition whose label spans lines: look for the closing ] on
    // this line. An unescaped [ kills it; a blank line already did
    // (handled in the blank branch of run()).
    if (this.pendingLabelPartial) {
      const parts = this.pendingLabelPartial.parts;
      let j = 0;
      let closeIdx = -1;
      let bad = false;
      while (j < content.length) {
        const ch = content[j];
        if (ch === '\\' && j + 1 < content.length) {
          j += 2;
          continue;
        }
        if (ch === '[') {
          bad = true;
          break;
        }
        if (ch === ']') {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (bad) {
        this.tip = this.addChild(this.top(), { type: 'paragraph', lines: [...parts, content], inItem: this.top().type === 'item' });
        this.pendingLabelPartial = null;
        return;
      }
      if (closeIdx < 0) {
        parts.push(content);
        this.lineWasDef = true;
        return;
      }
      const labelText = parts.join('\n') + '\n' + content.slice(0, closeIdx);
      const label = labelText.replace(/^ {0,3}\[/, '');
      this.pendingLabelPartial = null;
      let k = closeIdx + 1;
      if (content[k] !== ':' || label.trim() === '') {
        this.tip = this.addChild(this.top(), { type: 'paragraph', lines: [...parts, content], inItem: this.top().type === 'item' });
        return;
      }
      k++;
      while (k < content.length && (content[k] === ' ' || content[k] === '\t')) k++;
      const rawLines = [...parts, content];
      if (k >= content.length) {
        this.pendingLabel = { label: foldLabel(label), raw: rawLines };
        this.lineWasDef = true;
        return;
      }
      const res = readDestTitle(content, k);
      if (!res) {
        this.tip = this.addChild(this.top(), { type: 'paragraph', lines: rawLines, inItem: this.top().type === 'item' });
        return;
      }
      if (res.titlePartial) {
        this.pendingTitle = { label: foldLabel(label), dest: res.dest, quote: res.titlePartial.quote, buf: res.titlePartial.text, rawLines };
        this.lineWasDef = true;
        return;
      }
      const stored = !this.refs[foldLabel(label)];
      if (stored) this.refs[foldLabel(label)] = { dest: res.dest, title: res.title };
      if (res.maybeTitle) this.pendingDef = { label: foldLabel(label), rawLines, stored };
      this.closeLeaf();
      this.lineWasDef = true;
      return;
    }
    // A definition whose title spans lines: accumulate this line and
    // look for the closing quote. Anything but spaces/tabs after the
    // closing quote kills the definition.
    if (this.pendingTitle) {
      const quote = this.pendingTitle.quote;
      const closeQuote = quote === '(' ? ')' : quote;
      let j = 0;
      let buf = this.pendingTitle.buf + '\n';
      let closed = false;
      while (j < content.length) {
        const ch = content[j];
        if (ch === '\\' && j + 1 < content.length && isAsciiPunctuation(content[j + 1])) {
          buf += content[j + 1];
          j += 2;
          continue;
        }
        if (ch === closeQuote) {
          closed = true;
          break;
        }
        if (quote === '(' && ch === '(') break;
        buf += ch;
        j++;
      }
      this.pendingTitle.rawLines.push(content);
      if (!closed) {
        if (quote === '(' && j < content.length && content[j] === '(') {
          if (this.pendingTitle.registered) delete this.refs[this.pendingTitle.label];
          this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingTitle.rawLines, inItem: this.top().type === 'item' });
          this.pendingTitle = null;
          return;
        }
        this.pendingTitle.buf = buf;
        this.lineWasDef = true;
        return;
      }
      j++;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      if (j < content.length) {
        if (this.pendingTitle.registered) delete this.refs[this.pendingTitle.label];
        this.tip = this.addChild(this.top(), { type: 'paragraph', lines: this.pendingTitle.rawLines, inItem: this.top().type === 'item' });
        this.pendingTitle = null;
        return;
      }
      if (!this.refs[this.pendingTitle.label]) this.refs[this.pendingTitle.label] = { dest: this.pendingTitle.dest, title: expandEntities(buf) };
      this.pendingTitle = null;
      this.closeLeaf();
      this.lineWasDef = true;
      return;
    }
    // A definition awaiting its destination or title on this line.
    if (this.pendingLabel) {
      const res = readDestLine(content);
      if (res) {
        if (res.titlePartial) {
          this.pendingTitle = { label: this.pendingLabel.label, dest: res.dest, quote: res.titlePartial.quote, buf: res.titlePartial.text, rawLines: [...this.pendingLabel.raw, content] };
        } else {
          const stored = !this.refs[this.pendingLabel.label];
          if (stored) this.refs[this.pendingLabel.label] = { dest: res.dest, title: res.title };
          if (res.maybeTitle) this.pendingDef = { label: this.pendingLabel.label, rawLines: [...this.pendingLabel.raw, content], stored };
        }
        this.pendingLabel = null;
        this.lineWasDef = true;
        return;
      }
      // Not a destination: the label line becomes paragraph text.
      const rawLines = this.pendingLabel.raw;
      this.pendingLabel = null;
      this.tip = this.addChild(this.top(), { type: 'paragraph', lines: rawLines, inItem: this.top().type === 'item' });
      // Fall through: this line follows that paragraph.
    }
    if (this.pendingDef) {
      const t = readTitleLine(content);
      if (t !== null) {
        if (typeof t === 'object') {
          // The title runs onto following lines. The definition is
          // already registered (without a title); if the title fails
          // to close cleanly, the whole definition fails and must be
          // unregistered (flagged by `registered`).
          this.pendingTitle = { label: this.pendingDef.label, dest: this.refs[this.pendingDef.label].dest, quote: t.partial.quote, buf: t.partial.text, rawLines: [...this.pendingDef.rawLines, content], registered: this.pendingDef.stored };
          this.pendingDef = null;
          this.lineWasDef = true;
          return;
        }
        const rec = this.refs[this.pendingDef.label];
        if (rec && this.pendingDef.stored) rec.title = expandEntities(t);
        this.pendingDef = null;
        this.lineWasDef = true;
        return;
      }
      this.pendingDef = null; // the definition stands without a title
    }
    // Setext heading: converts the open paragraph — unless an empty
    // line got into the paragraph (from a code merge), which marked's
    // lheading pattern cannot span. A code-merged line reverts to its
    // un-merged form when a setext heading converts (the lheading
    // token claims the lines before the code merge applies).
    if (this.tip && this.tip.type === 'paragraph') {
      const sm = SETEXT_UNDER_RE.exec(content);
      if (sm && !this.tip.noSetext) {
        const level = sm[1][0] === '=' ? 1 : 2;
        if (this.tip.codeMergeOrig) {
          for (let k = 0; k < this.tip.lines.length; k++) {
            if (this.tip.codeMergeOrig[k] !== undefined) this.tip.lines[k] = this.tip.codeMergeOrig[k];
          }
        }
        const text = this.tip.lines.join('\n').replace(/^[ \t]+|[ \t]+$/g, '');
        const parent = this.top();
        parent.children[parent.children.length - 1] = { type: 'heading', level, text };
        this.closeLeaf();
        return;
      }
      // Table: a one-line paragraph plus a delimiter row with the same
      // number of cells (marked allows a header without pipes). The
      // delimiter row itself must be indented at most 3 spaces.
      if (this.tip.lines.length === 1 && visualIndent(content, base).col <= 3) {
        const aligns = delimiterAlignments(content);
        if (aligns) {
          const header = splitRowCells(this.tip.lines[0]);
          if (aligns.length === header.length) {
            const table = { type: 'table', header, aligns, rows: [] };
            const parent = this.top();
            parent.children[parent.children.length - 1] = table;
            this.tip = table;
            return;
          }
        }
      }
    }
    // A list open at the top is finished unless this line starts a new
    // item in it (the item is its own container; anything else belongs
    // to the list's parent). A line that is also a thematic break
    // counts as the break, not an item (the break is checked before
    // lists).
    const isListItem = (BULLET_MARK_RE.test(content) || ORDERED_MARK_RE.test(content)) && !THEMATIC_RE.test(content);
    if (!isListItem) {
      while (this.top().type === 'list') this.stack.pop();
    }
    // Blockquote: open the container, then process the remainder.
    const bq = BQ_OPEN_RE.exec(content);
    if (bq) {
      this.closeLeaf();
      const bqNode = this.addChild(this.top(), { type: 'blockquote', children: [] });
      this.stack.push(bqNode);
      const bc = new Cursor(content);
      bc.skipSpaces(3);
      bc.advance(1); // '>'
      if (bc.peek() === ' ' || bc.peek() === '\t') bc.advance(1);
      const rest = bc.rest();
      if (rest !== '' && !isBlankText(rest)) this.handleContent(rest, lineIdx, bc.col);
      this.lineWasDef = false; // the blockquote itself is a block
      return;
    }
    // ATX heading.
    const atx = ATX_HEAD_RE.exec(content);
    if (atx) {
      this.closeLeaf();
      let text = content.slice(atx[0].length).replace(/^[ \t]+|[ \t]+$/g, '');
      text = text.replace(/[ \t]+#+$/, '');
      if (/^#+$/.test(text)) text = '';
      this.addChild(this.top(), { type: 'heading', level: atx[1].length, text });
      return;
    }
    // Fenced code.
    const fence = FENCE_OPEN_RE.exec(content);
    if (fence) {
      const info = content.slice(fence[0].length).trim();
      if (fence[1][0] === '`' && info.indexOf('`') >= 0) {
        // A backtick fence cannot carry backticks in its info string:
        // treat the line as paragraph text (do not close the leaf).
      } else {
        this.closeLeaf();
        this.tip = this.addChild(this.top(), { type: 'code', fenced: true, fenceChar: fence[1][0], fenceLen: fence[1].length, info, fenceIndent: visualIndent(content, base).col, lines: [] });
        return;
      }
    }
    // HTML block.
    const inPara = !!(this.tip && this.tip.type === 'paragraph');
    const htype = htmlBlockKind(content, inPara);
    if (htype) {
      this.closeLeaf();
      this.tip = this.addChild(this.top(), { type: 'html', htmlType: htype, lines: [content], startLine: lineIdx, endLine: lineIdx, endedAtBlank: false });
      if (htype <= 5 && htmlBlockCloses(htype, content)) this.closeLeaf();
      return;
    }
    // Thematic break.
    if (THEMATIC_RE.test(content)) {
      this.closeLeaf();
      this.addChild(this.top(), { type: 'hr' });
      return;
    }
    // List item: open it, then process the remainder as its first content.
    const opened = this.tryListMarker(content, base);
    if (opened !== null) {
      this.closeLeaf();
      if (opened.rest !== '' && !isBlankText(opened.rest)) this.handleContent(opened.rest, lineIdx, opened.base);
      this.lineWasDef = false; // the list item itself is a block
      return;
    }
    // Indented code (cannot interrupt a paragraph).
    if (!this.tip || this.tip.type !== 'paragraph') {
      const ind = visualIndent(content, base);
      if (ind.col >= 4) {
        this.closeLeaf();
        this.tip = this.addChild(this.top(), { type: 'code', fenced: false, info: '', lines: [sliceAtColumn(content, 4, base)] });
        return;
      }
    }
    // Table row continuation.
    if (this.tip && this.tip.type === 'table') {
      this.tip.rows.push(splitRowCells(content));
      return;
    }
    // Paragraph start / continuation.
    if (this.tip && this.tip.type === 'paragraph') {
      // Code-merge (list items only): a continuation line that is
      // code-indented after the item indent merges into the paragraph
      // with 4 columns stripped, instead of starting a code block.
      // (In blockquotes and at the top level the line keeps its
      // spaces: marked lexes those with state.top=true, where the
      // paragraph token wins.) A code-merged line followed by a
      // non-code line contributes an extra empty line before it.
      if (this.tip.inItem && visualIndent(content, base).col >= 4) {
        if (this.tip.pendingBlanksAfterCode) {
          for (let k = 0; k < this.tip.pendingBlanksAfterCode; k++) this.tip.lines.push('');
          this.tip.noSetext = true;
          this.tip.pendingBlanksAfterCode = 0;
        }
        this.tip.codeMergeOrig = this.tip.codeMergeOrig || [];
        this.tip.codeMergeOrig[this.tip.lines.length] = content;
        this.tip.lines.push(sliceAtColumn(content, 4, base));
        this.tip.lastWasCodeMerge = true;
        this.tip.lastWasLazy = false;
        return;
      }
      if (this.tip.lastWasCodeMerge) {
        this.tip.lines.push('');
        this.tip.noSetext = true;
      }
      if (this.tip.pendingBlanksAfterCode) {
        for (let k = 0; k < this.tip.pendingBlanksAfterCode; k++) this.tip.lines.push('');
        this.tip.noSetext = true;
        this.tip.pendingBlanksAfterCode = 0;
      }
      this.tip.lastWasCodeMerge = false;
      this.tip.lastWasLazy = false;
      this.tip.lines.push(content);
      return;
    }
    // New paragraph: first consume any link reference definitions.
    const def = tryReferenceDefinition(content);
    if (def) {
      if (def.labelPartial) {
        this.pendingLabelPartial = { parts: [content] };
      } else if (def.awaitingDest) {
        this.pendingLabel = def;
      } else if (def.titlePartial) {
        this.pendingTitle = { label: def.label, dest: def.dest, quote: def.titlePartial.quote, buf: def.titlePartial.text, rawLines: [content] };
      } else {
        const stored = !this.refs[def.label];
        if (stored) this.refs[def.label] = { dest: def.dest, title: def.title };
        if (def.maybeTitle) this.pendingDef = { label: def.label, rawLines: [content], stored };
      }
      this.closeLeaf();
      this.lineWasDef = true;
      return;
    }
    this.tip = this.addChild(this.top(), { type: 'paragraph', lines: [content], inItem: this.top().type === 'item' });
  }

  // Try to open a list item at `content`. Returns the item's
  // first-line remainder (to be processed as the item's first content)
  // when a list item was opened, or null when the line is not a list
  // item.
  tryListMarker(content, base) {
    base = base || 0;
    let m = BULLET_MARK_RE.exec(content);
    let ordered = false;
    let markerText = '';
    let delim = '';
    let startNum = 1;
    if (m) {
      markerText = m[1];
    } else {
      m = ORDERED_MARK_RE.exec(content);
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
    if (this.tip && this.tip.type === 'paragraph' && !this.tip.inItem) {
      const after = content.slice(m[0].length);
      if (after.trim() === '') return null;
      if (ordered && startNum !== 1) return null;
    }
    // Columns: the marker sits after up to 3 spaces of indentation.
    const markerCol = visualIndent(content, base).col;
    const markerEndCol = markerCol + markerText.length;
    // The whitespace after the marker, counted in columns (tab-aware,
    // measured from the absolute column).
    let col = markerEndCol;
    let j = markerCol + markerText.length;
    let spaces = 0;
    while (j < content.length && (content[j] === ' ' || content[j] === '\t') && spaces < 5) {
      const w = content[j] === '\t' ? 4 - ((base + col) % 4) : 1;
      col += w;
      spaces += w;
      j++;
    }
    const afterSpaces = content.slice(j);
    let indent;
    if (afterSpaces.trim() === '') {
      // Empty item: its content starts one space after the marker.
      indent = markerEndCol + 1;
      this.appendListItem(ordered, startNum, ordered ? delim : markerText, indent, '', base + markerCol);
      return { rest: '', base };
    }
    if (spaces >= 1 && spaces <= 4) {
      indent = markerEndCol + spaces;
    } else {
      // 5+ spaces: the content starts one space after the marker.
      indent = markerEndCol + 1;
    }
    const rest = this.appendListItem(ordered, startNum, ordered ? delim : markerText, indent, sliceAtColumn(content, indent, base), base + markerCol);
    return { rest, base: base + indent };
  }

  // Create (or continue) the list and append a new item to it.
  // `remainder` is the item's first-line content. Whether this is a
  // sibling item or a nested list is decided by the marker's absolute
  // column against the parent list's marker column: the same column
  // continues the list, a deeper column nests under the open item. A
  // nested list reuses the item's last child when it is a list of the
  // same kind and column (a blank line between two runs of nested
  // items does not split the list).
  appendListItem(ordered, startNum, wantDelim, indent, remainder, absMarkerCol) {
    const topNode = this.top();
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
      parent = this.stack[this.stack.length - 2];
    } else {
      parent = topNode;
    }
    let list = null;
    if (existingList && existingList.ordered === ordered && existingList.delim === wantDelim) list = existingList;
    if (!list && existingList) {
      // The open list is finished (different bullet/delimiter): pop it
      // and any stale lists below it. A new list's parent is the first
      // non-list container under them — a list pushed as a child of
      // another list is never rendered.
      while (this.stack.length > 1 && this.stack[this.stack.length - 1].type === 'list') this.stack.pop();
      parent = this.top();
    }
    if (!list && parent.type === 'item' && parent.children.length > 0) {
      // Reuse a previously closed nested list under this item.
      const last = parent.children[parent.children.length - 1];
      if (last.type === 'list' && last.ordered === ordered && last.delim === wantDelim && last.markerCol === absMarkerCol) {
        list = last;
        this.stack.push(list);
      }
    }
    if (!list) {
      list = { type: 'list', ordered, start: startNum, delim: wantDelim, tight: true, children: [], markerCol: absMarkerCol };
      parent.children.push(list);
      this.stack.push(list);
      // A new nested list in an item that a blank line passed through,
      // after the item already had a child: the blank separates two
      // blocks inside the item, so the parent list is loose.
      if (this.blankStack && parent.type === 'item' && this.blankStack.indexOf(parent) >= 0 && parent.children.length > 1) {
        const pl = this.stack[this.stack.indexOf(parent) - 1];
        if (pl && pl.type === 'list') pl.tight = false;
      }
    }
    if (this.blankStack && this.blankStack.indexOf(list) >= 0 && list.children.length >= 1) list.tight = false;
    const item = { type: 'item', indent, children: [] };
    list.children.push(item);
    this.stack.push(item);
    return remainder;
  }

  // Finalise: drop trailing blank lines from code blocks (marked's
  // code text is the lines joined with '\n' plus a trailing '\n', or
  // '' when nothing remains), and compute each HTML block's raw text
  // from its container-stripped lines.
  finalize(node, isTop, hasNext) {
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
      // in a container (a container's text is newline-stripped). At
      // the top level, a final block keeps the '\n' when the source
      // ends with one.
      const next = node.endLine + 1 < this.lines.length ? this.lines[node.endLine + 1] : null;
      const nextEmpty = next === '';
      const atEofNoNl = next === null && !this.src.endsWith('\n');
      if (!node.endedAtBlank && !nextEmpty && !atEofNoNl && (hasNext || isTop)) text += '\n';
      node.text = text;
    }
    if (node.children) node.children.forEach((child, i) => this.finalize(child, node.type === 'document', i < node.children.length - 1));
  }
}

// ------------------------------------------------------------ rendering --

const BQ_OPEN_RE = /^ {0,3}>/;

// Whether `content` starts a block that can interrupt a paragraph
// (used to decide lazy continuation).
function startsBlockInterrupt(content) {
  if (ATX_HEAD_RE.test(content)) return true;
  const fence = FENCE_OPEN_RE.exec(content);
  if (fence && !(fence[1][0] === '`' && content.slice(fence[0].length).indexOf('`') >= 0)) return true;
  if (htmlBlockKind(content, true) > 0) return true;
  if (THEMATIC_RE.test(content)) return true;
  const bm = BULLET_MARK_RE.exec(content) || ORDERED_MARK_RE.exec(content);
  if (bm) {
    // A list interrupts a paragraph only when its first item is
    // non-empty (bullets) or starts at 1 (ordered).
    const after = content.slice(bm[0].length);
    if (after.trim() === '') return false;
    if (ORDERED_MARK_RE.test(content)) {
      const num = parseInt(ORDERED_MARK_RE.exec(content)[1], 10);
      return num === 1;
    }
    return true;
  }
  return false;
}

function renderBlockList(nodes, refs) {
  let out = '';
  for (const node of nodes) out += renderOneBlock(node, refs);
  return out;
}

function renderOneBlock(node, refs) {
  if (node.type === 'heading') {
    return '<h' + node.level + '>' + renderInlineText(node.text, refs) + '</h' + node.level + '>\n';
  }
  if (node.type === 'paragraph') {
    return '<p>' + renderInlineText(node.lines.join('\n'), refs) + '</p>\n';
  }
  if (node.type === 'code') {
    const text = node.lines.length ? node.lines.join('\n') + '\n' : '';
    // The info string's backslash escapes are decoded (``` foo\+bar
    // gives language "foo+bar"); the first word is the language.
    const lang = node.info ? node.info.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1').split(/\s+/)[0] : '';
    const cls = lang ? ' class="language-' + escapeAttribute(lang) + '"' : '';
    return '<pre><code' + cls + '>' + escapeText(text) + '</code></pre>\n';
  }
  if (node.type === 'html') return node.text;
  if (node.type === 'blockquote') {
    return '<blockquote>\n' + renderBlockList(node.children, refs) + '</blockquote>\n';
  }
  if (node.type === 'hr') return '<hr>\n';
  if (node.type === 'list') {
    const tag = node.ordered ? 'ol' : 'ul';
    const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
    let s = '<' + tag + start + '>\n';
    for (const item of node.children) if (item.type === 'item') s += renderListItem(item, node.tight, refs);
    return s + '</' + tag + '>\n';
  }
  if (node.type === 'table') {
    let s = '<table>\n<thead>\n<tr>\n';
    for (let i = 0; i < node.header.length; i++) {
      const a = node.aligns[i] ? ' align="' + node.aligns[i] + '"' : '';
      s += '<th' + a + '>' + renderInlineText(node.header[i], refs) + '</th>\n';
    }
    s += '</tr>\n</thead>\n';
    if (node.rows.length) {
      s += '<tbody>';
      for (const row of node.rows) {
        s += '<tr>\n';
        for (let i = 0; i < node.header.length; i++) {
          const cell = i < row.length ? row[i] : '';
          const a = node.aligns[i] ? ' align="' + node.aligns[i] + '"' : '';
          s += '<td' + a + '>' + renderInlineText(cell, refs) + '</td>\n';
        }
        s += '</tr>\n';
      }
      s += '</tbody>';
    }
    return s + '</table>\n';
  }
  return '';
}

// A list item. In a tight list a paragraph renders as bare inline
// text; in a loose list it keeps its <p> tags. A leading "[ ] " /
// "[x] " becomes a disabled checkbox, inside the <p> for loose lists.
function renderListItem(item, tight, refs) {
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
      if (tight) s += checkbox + renderInlineText(text, refs);
      else s += '<p>' + checkbox + renderInlineText(text, refs) + '</p>\n';
    } else {
      s += renderOneBlock(child, refs);
    }
  }
  return s + '</li>\n';
}

// --------------------------------------------------------------- export --

// The entry point: render `markdown` exactly as marked 18.1.3 does
// with its defaults. Line endings are normalised first (CR and CRLF
// become LF); link reference definitions are collected per document.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = Object.create(null);
  anchorOpen = false;
  const parser = new DocumentParser(src, refs);
  const blocks = parser.run();
  return renderBlockList(blocks, refs);
}
