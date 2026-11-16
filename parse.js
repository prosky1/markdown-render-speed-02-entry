// parse.js — a fast drop-in for marked 18.1.3 (defaults: GFM, no breaks,
// no pedantic mode, synchronous). One public function, parse(markdown),
// returning byte-identical HTML to marked.parse for every input.
//
// How it is laid out: small string utilities first, then the inline
// renderer (a single left-to-right walker class), then the block
// reader (a tab-aware line cursor plus a document builder class),
// then the HTML renderer for the block tree, then parse() itself.
// Inline rendering writes straight into an output array; block
// reading builds a light tree of plain objects first.
//
// Speed notes, learned from measurement: the inline walker dispatches
// on the character code at each position and only builds the
// delimiter mask lazily, when a delimiter run actually passes its
// cheap opening gate. Emphasis closer scans run over the masked text
// with sticky/global regexes instead of slicing substrings, and the
// GFM autolink patterns are sticky too, tried only at positions that
// can start one. Nothing is cached between parse() calls: every call
// is a pure function of its input, so two runs over the same set
// always produce identical output.

// ------------------------------------------------------------------
// Document-wide lexer state: whether a literal <a ...> tag is
// currently open. While it is, no bare URL or e-mail autolink forms
// anywhere in the document. Markdown links and emphasis are
// unaffected. Parsing link or image text saves and restores it, so a
// tag inside link text cannot leak into the surrounding document.
let aTagOpen = false;

// ------------------------------------------------------------------
// Character classification

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

// A backslash only escapes ASCII punctuation.
function isAsciiPunct(ch) {
  return !!ch && ch.charCodeAt(0) < 128 && ASCII_PUNCT.indexOf(ch) >= 0;
}

// ------------------------------------------------------------------
// Escaping

const TEXT_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const TEXT_ESC_TEST = /[&<>"']/;
const TEXT_ESC_ALL = /[&<>"']/g;

// Escape a run of plain text (marked escapes quotes in text and in
// code spans as well). Text runs reaching here never contain an
// entity reference — the walker splits those out first — so a bare &
// is always literal.
function escText(s) {
  if (!TEXT_ESC_TEST.test(s)) return s;
  return s.replace(TEXT_ESC_ALL, (ch) => TEXT_ESC[ch]);
}

// Escape an attribute value. A valid entity reference inside it is
// kept the way marked renders it: a named one verbatim, a numeric one
// decoded and then escaped again.
function escAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const code = s.charCodeAt(i);
    if (code === 38) { // &
      const ent = entityAt(s, i);
      if (ent) {
        out += ent.num ? escAttr(ent.txt) : ent.txt;
        i += ent.len;
      } else {
        out += '&amp;';
        i++;
      }
    } else if (code === 60) { out += '&lt;'; i++; }
    else if (code === 62) { out += '&gt;'; i++; }
    else if (code === 34) { out += '&quot;'; i++; }
    else if (code === 39) { out += '&#39;'; i++; }
    else { out += s[i]; i++; }
  }
  return out;
}

// ------------------------------------------------------------------
// Entities

// If an entity reference starts at s[i], return {txt, len, num}:
// txt is what marked emits — a named reference verbatim, a numeric
// one decoded (an invalid code point becomes U+FFFD). A numeric
// reference holds at most 7 decimal or 6 hex digits; longer is not
// an entity and stays literal text.
function entityAt(s, i) {
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
    const dig0 = j;
    while (j < n) {
      const ch = s[j];
      const d = ch >= '0' && ch <= '9';
      const h = hex && ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F'));
      if (!d && !h) break;
      j++;
    }
    const digits = s.slice(dig0, j);
    if (!digits.length || j >= n || s[j] !== ';') return null;
    if (digits.length > (hex ? 6 : 7)) return null;
    let cp = parseInt(digits, hex ? 16 : 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { txt: String.fromCodePoint(cp), len: j - i + 1, num: true };
  }
  const isLetter = (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z');
  if (!isLetter) return null;
  let j = i + 1;
  while (j < n) {
    const ch = s[j];
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
    if (!ok) break;
    j++;
  }
  if (j < n && s[j] === ';') return { txt: s.slice(i, j + 1), len: j - i + 1, num: false };
  return null;
}

// Decode entities inside a link destination or title the way marked
// does: numeric references become the character, named ones stay
// verbatim (marked never checks a named reference against a table).
function decodeEnts(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const ent = entityAt(s, i);
      if (ent) {
        out += ent.txt;
        i += ent.len;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

// ------------------------------------------------------------------
// Link labels and destinations

// Normalise a link reference label: trim, collapse inner whitespace
// runs to one space, then case-fold. The lower–upper–lower round trip
// is marked's fold: it maps ẞ to ss (ß uppercases to SS), where a
// plain toLowerCase would leave ß unmatched against an SS label.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Encode a link destination the way marked renders it in href:
// encodeURI, except an existing %XX sequence is left alone (the %
// itself is not re-escaped). Backslashes, < > " and non-ASCII all
// become percent-escapes; javascript: and vbscript: are NOT filtered.
function encodeHref(dest) {
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

// ------------------------------------------------------------------
// Emphasis and strikethrough patterns.
//
// marked scans emphasis left to right: a left-delimiter match opens a
// run, then a right-delimiter scan walks the masked text with two
// counters (m: opener length plus opener-only runs minus closer runs;
// f: length skipped by the rule of 3). The span forms when m reaches
// 0. The scan runs on a MASKED copy of the text (see buildMask), in
// which link spans, code spans and HTML tags are replaced by
// [aaa...] of the same length, so a delimiter inside a (possibly
// failed) link span is invisible.
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
const PRE_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM_CH = /[\p{L}\p{N}]/u;

// Left-delimiter rule, sticky at the opener: a run of * or _ plus the
// following character — `ap`/`up` is punctuation after the run,
// `an`/`un` a non-space character. A run with no following character
// matches with no group, and the caller rejects it.
const OPEN_EMPH = /(?:\*+(?:(?<ap>(?!\*)(?!~)[\p{P}\p{S}])|(?<an>[^\s*]))?)|_+(?:(?<up>(?!_)(?!~)[\p{P}\p{S}])|(?<un>[^\s_]))?/uy;

// Closer scans. Named groups: `plain` is skipped text; `c1`/`c2` are
// closer-only runs, `o1`/`o2` opener-only runs, `b1`/`b2` runs that can
// both open and close. The `_` scan has no `b2`: an intraword `_` is
// never a delimiter.
const STAR_CLOSE = /(?<plain>[^*]+(?=[^*]))|(?:(?!\*)(?!~)[\p{P}\p{S}])(?<c1>\*+)(?=[\s]|$)|(?:(?:[^\s\p{P}\p{S}]|~))(?<c2>\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?:(?!\*)(?!~)[\s\p{P}\p{S}])(?<o1>\*+)(?=(?:[^\s\p{P}\p{S}]|~))|(?:[\s])(?<o2>\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:(?!\*)(?!~)[\p{P}\p{S}])(?<b1>\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:(?:[^\s\p{P}\p{S}]|~))(?<b2>\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const UNDER_CLOSE = /(?<plain>[^_]+(?=[^_]))|(?:(?!_)[\p{P}\p{S}])(?<c1>_+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}])(?<c2>_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?:(?!_)[\s\p{P}\p{S}])(?<o1>_+)(?=[^\s\p{P}\p{S}])|(?:[\s])(?<o2>_+)(?!_)(?=[\p{P}\p{S}])|(?:(?!_)[\p{P}\p{S}])(?<b1>_+)(?!_)(?=[\p{P}\p{S}])/gu;

// Strikethrough delimiters: the left rule needs a following character
// (a lone ~ at the end is literal); the right rule mirrors the
// emphasis one with runs of one or two tildes.
const OPEN_DEL = /~~?(?:(?<dp>(?!~)[\p{P}\p{S}])|[^\s~])/uy;
const DEL_CLOSE = /(?<plain>[^~]+(?=[^~]))|(?:(?!~)[\p{P}\p{S}])(?<c1>~~?)(?=[\s]|$)|(?:[^\s\p{P}\p{S}])(?<c2>~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?:(?!~)[\s\p{P}\p{S}])(?<o1>~~?)(?=[^\s\p{P}\p{S}])|(?:[\s])(?<o2>~~?)(?!~)(?=[\p{P}\p{S}])|(?:(?!~)[\p{P}\p{S}])(?<b1>~~?)(?!~)(?=[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}])(?<b2>~~?)(?=[^\s\p{P}\p{S}])/gu;

// When scanning for `*` closers, a `__...*...__` span is skipped; when
// scanning for `_` closers, a `**..._...**` span. Returns the index of
// the closing double run (the scan resumes there), or -1 when no such
// span starts at `from`. Written as a small loop rather than a regex:
// the span is a double run of the OTHER delimiter, some delimiter-free
// text, one delimiter of the kind being scanned for, more
// delimiter-free text, then the closing double run.
function jumpOppositeStrong(masked, from, delim) {
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

// ------------------------------------------------------------------
// The delimiter mask.
//
// Spans the emphasis scan must not see into: inline links [...](...),
// code spans, and HTML tags. Reference links whose label is defined
// are masked too (a label containing a link is masked recursively
// instead). Every replacement preserves its length, so scan indices
// in the masked copy transfer to the original text.

const SPAN_MASK_RE = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|(?<!`)(`+)[^`]+\2(?!`)|<(?! )[^<>]*?>/g;
const PUNCT_MASK_RE = /(?<ticks>`+)(?:[^`]|[^`][\s\S]*?[^`])\k<ticks>(?!`)|`+|\\(?<esc>[\p{P}\p{S}])/gu;

// A reference link's label may nest brackets one level, hold escapes
// and code spans, or end in a run of two or more backticks before the
// ]. A reference name is 1–999 characters with no unescaped bracket.
const REF_LBL_INNER = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const REF_NM_INNER = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/;
const REF_LINK_SCAN = new RegExp('!?\\[' + REF_LBL_INNER.source + '\\]\\[' + REF_NM_INNER.source + '\\]|!?\\[' + REF_NM_INNER.source + '\\](?:\\[\\])?(?!\\()', 'g');

// Tests whether a matched [...](...) span is a well-formed inline
// link (used to decide if a piece of text contains a link at all).
const INLINE_LINK_CHK = new RegExp('^!?\\[(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?\\]\\([ \\t\\n]*(?:<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^\\)\\\\])*\\)))?[ \\t\\n]*\\)');

// Does `text` contain a link (not an image)? A link's text may not
// contain a link, so an outer [text](...) whose text holds a link is
// not a link at all — the inner link wins and the outer brackets stay
// literal.
function labelHasLink(text, refs) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(SPAN_MASK_RE)) {
    if (INLINE_LINK_CHK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REF_LINK_SCAN)) {
    const span = m[0];
    if (span.charAt(0) === '!') continue;
    const lastOpen = span.lastIndexOf('[');
    if (!Object.hasOwn(refs, normLabel(span.slice(lastOpen + 1, -1)))) continue;
    if (lastOpen > 1 && labelHasLink(span.slice(1, lastOpen - 1), refs)) continue;
    return true;
  }
  return false;
}

// Build the masked copy of `s` for the emphasis scan. The reference
// pass only runs when the text holds a bracket; the punctuation pass
// only when it holds a backtick or a backslash; the span pass only
// when it holds a bracket, a backtick or a <. Skipping a pass the text
// provably cannot match is worth a lot on plain paragraphs.
function buildMask(s, refs) {
  let t = s;
  const hasBracket = s.includes('[');
  const hasTick = s.includes('`');
  if (refs && hasBracket) {
    const maskOne = (span) => {
      const lastOpen = span.lastIndexOf('[');
      if (!Object.hasOwn(refs, normLabel(span.slice(lastOpen + 1, -1)))) return span;
      if (lastOpen > 1 && span.charAt(0) !== '!') {
        const label = span.slice(1, lastOpen - 1);
        if (labelHasLink(label, refs)) {
          const fresh = new RegExp(REF_LINK_SCAN.source, REF_LINK_SCAN.flags);
          return '[' + label.replace(fresh, maskOne) + '][' + 'a'.repeat(span.length - lastOpen - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(span.length - 2) + ']';
    };
    t = t.replace(REF_LINK_SCAN, maskOne);
  }
  if (hasTick || s.includes('\\')) {
    t = t.replace(PUNCT_MASK_RE, (m, ticks, esc) => esc ? '+'.repeat(m.length) : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : m);
  }
  if (hasBracket || hasTick || s.includes('<')) {
    t = t.replace(SPAN_MASK_RE, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return t;
}

// Is s[from..] only ASCII whitespace (space, tab, newline, CR, FF, VT)?
function restIsBlank(s, from) {
  for (let q = from; q < s.length; q++) {
    const code = s.charCodeAt(q);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 11) return false;
  }
  return true;
}

// Find the closing backtick run of exactly `len` backticks at or after
// `from`; runs of any other length are skipped over. Returns the index
// of the run's first backtick, or -1.
function findTickClose(s, from, len) {
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
function isLocalMailCode(cc) {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) ||
    cc === 46 || cc === 95 || cc === 43 || cc === 45;
}

// ------------------------------------------------------------------
// Inline engine.
//
// Inline parsing walks the text once, left to right, trying the
// tokenizers in marked's order at each position (escape, code span,
// emphasis, strikethrough, entity, tag/autolink, link/image, break,
// GFM autolink) and taking the first match. Emphasis, link and image
// contents are parsed by a recursive call, so an e-mail inside
// __...__ is matched only after the strong span has formed.
//
// The walker keeps its state in one object: the text, the output
// chunks, the current index, the start of the pending text run, and
// marked's `r` — the last character of the preceding text token, or
// '' when the preceding token was not text. A text token ending in _
// does not update `r`. The `r` value decides whether a delimiter run
// may open emphasis, so it is tracked exactly.

function inlineHtml(s, refs, inLink) {
  const w = new InlineRun(s, refs, !!inLink);
  w.walk();
  return w.parts.join('');
}

class InlineRun {
  constructor(s, refs, inLink) {
    this.txt = s;
    this.refs = refs;
    this.inLink = inLink;
    this.len = s.length;
    this.parts = [];
    this.pos = 0;
    this.runStart = 0;
    this.hadText = false;
    this.prevCh = '';
    this.mask = null;
  }

  masked() {
    if (this.mask === null) this.mask = buildMask(this.txt, this.refs);
    return this.mask;
  }

  // Emit the pending text run up to `end` as escaped text, and update
  // the `r` tracking: the run's last character becomes `r`, unless it
  // is _, which leaves `r` as it was (or '' when no text token
  // preceded).
  emitRun(end) {
    if (end <= this.runStart) return;
    this.parts.push(escText(this.txt.slice(this.runStart, end)));
    const last = this.txt[end - 1];
    this.prevCh = last !== '_' ? last : (this.hadText ? this.prevCh : '');
    this.hadText = true;
  }

  // The `r` value for a tokenizer attempt at `at`: the last character
  // of the pending text run, falling back to the last emitted text
  // token when the run is empty or ends in _.
  prevAt(at) {
    if (at > this.runStart) {
      const ch = this.txt[at - 1];
      return ch !== '_' ? ch : (this.hadText ? this.prevCh : '');
    }
    return this.hadText ? this.prevCh : '';
  }

  walk() {
    const s = this.txt;
    const n = this.len;
    while (this.pos < n) {
      const code = s.charCodeAt(this.pos);
      if (code === 92) { // backslash
        if (!this.backslash()) this.pos++;
        continue;
      }
      if (code === 96) { // backtick
        this.codeSpan();
        continue;
      }
      if (code === 42 || code === 95) { // * _
        if (!this.emph()) this.pos++;
        continue;
      }
      if (code === 126) { // ~
        if (!this.del()) this.pos++;
        continue;
      }
      if (code === 38) { // &
        if (!this.entity()) this.pos++;
        continue;
      }
      if (code === 60) { // <
        if (!this.angle()) this.pos++;
        continue;
      }
      if (code === 91 && !this.inLink) { // [
        if (!this.link(false)) this.pos++;
        continue;
      }
      if (code === 33 && s[this.pos + 1] === '[') { // ![
        if (!this.link(true)) this.pos++;
        continue;
      }
      if (code === 10) { // \n
        if (!this.newline()) this.pos++;
        continue;
      }
      // GFM extended autolinks only start at an alphanumeric or . + -,
      // and never inside a link's text or while an <a> tag is open.
      if (!this.inLink && !aTagOpen &&
        ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) || code === 46 || code === 43 || code === 45)) {
        if (!this.gfm()) this.pos++;
        continue;
      }
      this.pos++;
    }
    this.emitRun(n);
  }

  // Backslash: an escape of ASCII punctuation, or a hard break before
  // a newline (only when non-whitespace follows it — marked's br rule
  // carries a (?!\s*$) lookahead). Anything else stays literal.
  backslash() {
    const s = this.txt;
    const i = this.pos;
    const nx = s[i + 1];
    if (nx === '\n' && !restIsBlank(s, i + 2)) {
      this.emitRun(i);
      this.parts.push('<br>');
      this.hadText = false;
      let j = i + 2;
      while (j < this.len && (s[j] === ' ' || s[j] === '\t')) j++;
      this.pos = j;
      this.runStart = j;
      return true;
    }
    if (nx && isAsciiPunct(nx)) {
      this.emitRun(i);
      this.parts.push(escText(nx));
      if (nx !== '_') this.prevCh = nx;
      this.hadText = true;
      this.pos = i + 2;
      this.runStart = i + 2;
      return true;
    }
    return false;
  }

  // Code span: a run of backticks closed by a run of exactly the same
  // length. Newlines inside become spaces; one space is stripped from
  // each end when the content both starts and ends with a space and is
  // not all spaces. An unclosed run stays literal text.
  codeSpan() {
    const s = this.txt;
    const n = this.len;
    const i = this.pos;
    let j = i;
    while (j < n && s[j] === '`') j++;
    const len = j - i;
    const close = findTickClose(s, j, len);
    if (close < 0) {
      this.pos = j;
      return;
    }
    let content = s.slice(j, close).replace(/\n/g, ' ');
    if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    this.emitRun(i);
    this.parts.push('<code>' + escText(content) + '</code>');
    this.hadText = false;
    this.pos = close + len;
    this.runStart = close + len;
  }

  // Entity reference: a named reference goes out verbatim, a numeric
  // one decoded and then escaped.
  entity() {
    const s = this.txt;
    const i = this.pos;
    const ent = entityAt(s, i);
    if (!ent) return false;
    this.emitRun(i);
    this.parts.push(ent.num ? escText(ent.txt) : ent.txt);
    const last = s[i + ent.len - 1];
    if (last !== '_') this.prevCh = last;
    this.hadText = true;
    this.pos = i + ent.len;
    this.runStart = i + ent.len;
    return true;
  }

  // Newline: a hard break when two or more spaces precede it and
  // non-whitespace follows (the spaces are dropped, the next line's
  // leading spaces and tabs are stripped); otherwise a soft break,
  // which is just a newline in the text run.
  newline() {
    const s = this.txt;
    const i = this.pos;
    let k = i - 1;
    let spaces = 0;
    while (k >= this.runStart && s[k] === ' ') {
      spaces++;
      k--;
    }
    if (spaces >= 2 && !restIsBlank(s, i + 1)) {
      this.emitRun(k + 1);
      this.parts.push('<br>');
      this.hadText = false;
      let j = i + 1;
      while (j < this.len && (s[j] === ' ' || s[j] === '\t')) j++;
      this.pos = j;
      this.runStart = j;
      return true;
    }
    return false;
  }

  // Emphasis attempt at the walker's position. The cheap
  // left-delimiter gate runs first: only a run that can open emphasis
  // needs the (expensive) mask. A leading _ that fails emphasis may
  // still start a bare e-mail address — marked tries emphasis first,
  // then the e-mail.
  emph() {
    const s = this.txt;
    const i = this.pos;
    OPEN_EMPH.lastIndex = i;
    const gate = OPEN_EMPH.exec(s);
    const gg = gate && gate.groups;
    const passable = gg && (gg.ap || gg.an || gg.up || gg.un);
    const got = passable ? findEmph(s, this.masked(), i, this.refs, this.inLink, this.prevAt(i)) : null;
    if (got) {
      this.emitRun(i);
      this.parts.push(got.html);
      this.hadText = false;
      this.pos = got.end;
      this.runStart = got.end;
      return true;
    }
    if (s[i] === '_' && !this.inLink && !aTagOpen &&
      (this.runStart === i || !isLocalMailCode(i > 0 ? s.charCodeAt(i - 1) : -1))) {
      const em = bareEmail(s, i);
      if (em) {
        this.emitRun(i);
        this.parts.push(em.html);
        this.hadText = false;
        this.pos = em.end;
        this.runStart = em.end;
        return true;
      }
    }
    return false;
  }

  // Strikethrough attempt at the walker's position.
  del() {
    const s = this.txt;
    const i = this.pos;
    OPEN_DEL.lastIndex = i;
    const gate = OPEN_DEL.exec(s);
    const got = gate ? findDel(s, this.masked(), i, this.refs, this.inLink, this.prevAt(i)) : null;
    if (got) {
      this.emitRun(i);
      this.parts.push(got.html);
      this.hadText = false;
      this.pos = got.end;
      this.runStart = got.end;
      return true;
    }
    return false;
  }

  // Link or image attempt at the walker's position. For an image the
  // `[` is one character past the `!`; a failed image leaves the `!`
  // behind and the `[` is retried as a link on the next pass.
  link(isImg) {
    const s = this.txt;
    const open = isImg ? this.pos + 1 : this.pos;
    const got = parseLink(s, open, this.refs, isImg);
    if (!got) return false;
    this.emitRun(this.pos);
    this.parts.push(got.html);
    this.hadText = false;
    this.pos = got.end;
    this.runStart = got.end;
    return true;
  }

  // < attempt at the walker's position. An opening <a tag (with a
  // space after the a) opens the document-wide anchor state; a literal
  // </a> closes it.
  angle() {
    const s = this.txt;
    const i = this.pos;
    const got = angleAt(s, i);
    if (!got) return false;
    this.emitRun(i);
    this.parts.push(got.html);
    this.hadText = false;
    if (got.isTag) {
      const tag = got.html;
      if ((tag[1] === 'a' || tag[1] === 'A') && tag[2] === ' ') aTagOpen = true;
      else if (tag[1] === '/' && (tag[2] === 'a' || tag[2] === 'A') && tag[3] === '>') aTagOpen = false;
    }
    this.pos = got.end;
    this.runStart = got.end;
    return true;
  }

  // GFM autolink attempt at the walker's position. A bare e-mail's
  // local part is a maximal run of [A-Za-z0-9._+-]: the e-mail regex
  // only needs trying at the run's start (a later position in the same
  // run shares the @ and domain, so it cannot succeed where the run
  // start failed). The run starts here when the previous character is
  // not a local-part character, or when a token just ended (the run's
  // start was inside the token).
  gfm() {
    const s = this.txt;
    const i = this.pos;
    const fresh = this.runStart === i && !this.hadText;
    const tryEmail = this.runStart === i || !isLocalMailCode(i > 0 ? s.charCodeAt(i - 1) : -1);
    const got = extAutolink(s, i, fresh, tryEmail);
    if (!got) return false;
    this.emitRun(i);
    this.parts.push(got.html);
    this.hadText = false;
    this.pos = got.end;
    this.runStart = got.end;
    return true;
  }
}

// ------------------------------------------------------------------
// Emphasis / strikethrough spans.
//
// Try emphasis or strong at position i. `masked` is the masked copy of
// the whole text (same length as s); `prev` is marked's `r`. Returns
// {html, end} or null. The opener's run may extend left of i in the
// masked text (the walker retries a run one delimiter at a time after
// a failed attempt), so the run's true start and the character before
// it are recovered first — flanking is judged against the whole run.
function findEmph(s, masked, i, refs, inLink, prev) {
  OPEN_EMPH.lastIndex = i;
  const open = OPEN_EMPH.exec(s);
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
  const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || PRE_PUNCT.test(beforeRun);
  if (runStart < off) before = beforeRun;
  const beforePunct = runStart < off ? beforeIsPunct : PRE_PUNCT.test(before);
  // An intraword _ cannot open: an underscore followed by a non-space
  // character with an alphanumeric before it is literal.
  if (og.un && ALNUM_CH.test(before)) return null;
  const punctAfter = og.ap || og.up || '';
  if (!punctAfter || !before || beforePunct) {
    const openLen = [...open[0]].length - 1;
    let m = openLen;
    let f = 0;
    const totalLen = off - runStart + openLen;
    const canAlsoClose = beforeRun.trim() !== '' && (!!punctAfter || (delim === '*' && !beforeIsPunct));
    const closerScan = delim === '*' ? STAR_CLOSE : UNDER_CLOSE;
    let scanFrom = off + openLen;
    const skipped = jumpOppositeStrong(masked, scanFrom, delim);
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
        return { html: '<em>' + inlineHtml(span.slice(1, -1), refs, inLink) + '</em>', end: rawEnd };
      }
      return { html: '<strong>' + inlineHtml(span.slice(2, -2), refs, inLink) + '</strong>', end: rawEnd };
    }
  }
  return null;
}

// Try strikethrough at position i. Same shape as findEmph, but a
// closer must have exactly the opener's length and there is no rule
// of 3. Marked renders a single ~ pair as <del> too, not just ~~.
function findDel(s, masked, i, refs, inLink, prev) {
  OPEN_DEL.lastIndex = i;
  const open = OPEN_DEL.exec(s);
  if (!open) return null;
  const before = prev;
  if (!(open.groups.dp || '') || !before || PRE_PUNCT.test(before)) {
    const openLen = [...open[0]].length - 1;
    let p = openLen;
    DEL_CLOSE.lastIndex = i + openLen;
    let sm;
    while ((sm = DEL_CLOSE.exec(masked)) !== null) {
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
      return { html: '<del>' + inlineHtml(span.slice(openLen, -openLen), refs, inLink) + '</del>', end: rawEnd };
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Links and images.

// Find the index of the `]` matching the `[` at `open` (depth-aware,
// skipping backslash escapes). Backticks follow marked's label
// pattern: a backtick run must form a complete code span with the next
// backtick run as its closer (the runs need not match in length) or
// sit immediately before the closing `]` as a run of two or more —
// an unclosed backtick anywhere else makes the whole label fail. The
// code-span reading is tried first, but if it leads nowhere (its
// closer may sit past the label's ]), the scan backtracks to the
// trailing-run alternative.
function labelClose(s, open) {
  return scanLabel(s, open + 1, 1);
}

function scanLabel(s, i, depth) {
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
        const found = scanLabel(s, m, depth);
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

function skipWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Parse the tail of an inline link after `]`: (dest "title"). Returns
// {dest, title, end} or null. The destination is either <...> (no
// newline inside) or a bare run with balanced parentheses; the title
// is "..." or '...' or (...), needs whitespace before it, and may
// span lines.
function inlineTail(s, i) {
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
      if (s[j] === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
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
      if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
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
  i = skipWs(s, i);
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
      if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
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
    i = skipWs(s, i);
  }
  if (i >= n || s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

// Does `text` contain a link (not an image)? Used to suppress an outer
// link whose text holds one — the inner link wins. Code spans are
// skipped (a [ inside `...` is not a link), and a formed image is
// skipped past so its label is not mistaken for a link.
function containsLink(text, refs) {
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
      const img = parseLink(text, i + 1, refs, true);
      if (img) {
        i = img.end - 1;
        continue;
      }
    }
    if (text[i] === '[' && text[i - 1] !== '!') {
      if (parseLink(text, i, refs, false)) return true;
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
// whole link. Code spans and backslash escapes are skipped while
// scanning for `<`.
function labelHasOpenTag(s, from, to) {
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
      const close = findTickClose(s, j, len);
      if (close < 0) {
        i = j;
        continue;
      }
      i = close + len;
      continue;
    }
    if (ch === '<') {
      const got = angleAt(s, i);
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
function parseLink(s, open, refs, isImg) {
  const close = labelClose(s, open);
  if (close < 0) return null;
  const rawText = s.slice(open + 1, close);
  if (labelHasOpenTag(s, open + 1, close)) return null;
  if (!isImg && containsLink(rawText, refs)) return null;
  let dest = null;
  let title = null;
  let end = close + 1;
  const after = s[end];
  if (after === '(') {
    // Inline link — but if the tail fails to parse, fall back to the
    // shortcut reference lookup below ([foo](not a link) with a [foo]
    // definition links to the definition, tail left literal).
    const tail = inlineTail(s, end);
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
      if (!labelHasBracket(label)) {
        if (label === '') {
          const ref = refs[normLabel(rawText)];
          if (ref) {
            dest = ref.dest;
            title = ref.title;
            end = labelEnd + 1;
          }
        } else {
          const ref = refs[normLabel(label)];
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
    if (labelHasBracket(rawText)) return null;
    const ref = refs[normLabel(rawText)];
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = close + 1;
  }
  dest = decodeEnts(dest);
  if (title !== null) title = decodeEnts(title);
  if (isImg) {
    // The alt text is the link text parsed as normal inline content
    // (links and images inside it do parse) and then stripped of tags
    // — an inner image contributes its own alt text. A tag inside the
    // alt text must not leak aTagOpen out.
    const savedAnchor = aTagOpen;
    const altHtml = inlineHtml(rawText, refs, false);
    aTagOpen = savedAnchor;
    const alt = stripTags(altHtml);
    let html = '<img src="' + escAttr(encodeHref(dest)) + '" alt="' + escAttr(alt) + '"';
    if (title !== null) html += ' title="' + escAttr(title) + '"';
    return { html: html + '>', end };
  }
  const savedAnchor = aTagOpen;
  const kids = inlineHtml(rawText, refs, true);
  aTagOpen = savedAnchor;
  let html = '<a href="' + escAttr(encodeHref(dest)) + '"';
  if (title !== null) html += ' title="' + escAttr(title) + '"';
  return { html: html + '>' + kids + '</a>', end };
}

function stripTags(html) {
  return html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, '');
}

// ------------------------------------------------------------------
// Angle brackets: tags and autolinks.

const CLOSE_TAG_RE = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;
const OPEN_TAG_RE = /<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y;
const DECL_TAG_RE = /<![A-Za-z][^>]*>/y;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const EMAIL_IN_TAG_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Try <...> at position i: a comment, processing instruction,
// declaration or CDATA section, an HTML tag, or an autolink
// (<scheme:...> or <email>). Returns {html, end, isTag} or null.
// Tags are tried before autolinks, so <a href="x"> is a tag, not a
// link; closing tags take no attributes.
function angleAt(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { html: '<!-->', end: i + 5, isTag: true };
    if (s.startsWith('<!--->', i)) return { html: '<!--->', end: i + 6, isTag: true };
    const end = s.indexOf('-->', i + 4);
    if (end >= 0) return { html: s.slice(i, end + 3), end: end + 3, isTag: true };
    return null;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end >= 0) return { html: s.slice(i, end + 2), end: end + 2, isTag: true };
    return null;
  }
  if (s.startsWith('<!', i)) {
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end >= 0) return { html: s.slice(i, end + 3), end: end + 3, isTag: true };
      return null;
    }
    DECL_TAG_RE.lastIndex = i;
    const dm = DECL_TAG_RE.exec(s);
    if (dm) return { html: dm[0], end: i + dm[0].length, isTag: true };
    return null;
  }
  if (s.startsWith('</', i)) {
    CLOSE_TAG_RE.lastIndex = i;
    const cm = CLOSE_TAG_RE.exec(s);
    if (cm) return { html: cm[0], end: i + cm[0].length, isTag: true };
  } else if (/[A-Za-z]/.test(s[i + 1] || '')) {
    OPEN_TAG_RE.lastIndex = i;
    const om = OPEN_TAG_RE.exec(s);
    if (om) return { html: om[0], end: i + om[0].length, isTag: true };
  }
  const gt = s.indexOf('>', i + 1);
  if (gt > 0) {
    const inner = s.slice(i + 1, gt);
    if (inner.indexOf(' ') < 0 && inner.indexOf('<') < 0 && inner.indexOf('\n') < 0) {
      if (SCHEME_RE.test(inner)) {
        const href = encodeHref(inner);
        return { html: '<a href="' + escAttr(href) + '">' + escText(inner) + '</a>', end: gt + 1, isTag: false };
      }
      if (EMAIL_IN_TAG_RE.test(inner)) {
        const href = 'mailto:' + inner;
        return { html: '<a href="' + escAttr(href) + '">' + escText(inner) + '</a>', end: gt + 1, isTag: false };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------
// GFM extended autolinks.
//
// Extended autolinks, as marked implements them (probed). Schemes
// http/https/ftp match case-insensitively per letter; www. must be
// lowercase. The host is one or more alnum/hyphen labels (a dot is NOT
// required: www.foo links), then any run of non-space, non-<
// characters. The e-mail pattern's trailing (?![\w-]) lookahead is
// what makes a.b-c_d@a.b- stay literal while a.b-c_d@a.b. links.
const SCHEME_URL_RE = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const WWW_URL_RE = /www\.(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const BARE_EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const MAILTO_URL_RE = /(?:mailto:|xmpp:)[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?/y;

// Trailing-punctuation trim for autolinks (marked's "backpedal"):
// the kept prefix is built from safe chunks — runs of characters that
// are not trailing punctuation, balanced (...) groups, and & not
// starting an &name; entity at the very end — plus punctuation runs
// that are not at the end. Applied repeatedly until stable, it drops
// trailing ?!.,:;*_'\"~ and unbalanced ) while keeping ] } and
// balanced parens, and drops a trailing &name; whole.
const TRIM_TAIL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

function trimTail(url) {
  let prev;
  do {
    prev = url;
    const m = TRIM_TAIL_RE.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return url;
}

// GFM extended autolink at position i. `fresh` says the position
// follows a non-text token (a code span, link, tag, break or delimiter
// run), which counts as a word boundary for www. Returns {html, end}
// or null.
function extAutolink(s, i, fresh, tryEmail) {
  const ch = s[i];
  const prev = i > 0 ? s[i - 1] : '';
  // mailto: / xmpp: (lowercase only) need a non-alphanumeric before
  // them, so xmailto: is not a scheme (its bare e-mail still links).
  if ((ch === 'm' || ch === 'x') && (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) &&
    (prev === '' || !/[A-Za-z0-9]/.test(prev))) {
    MAILTO_URL_RE.lastIndex = i;
    const mm = MAILTO_URL_RE.exec(s);
    if (mm) {
      const url = trimTail(mm[0]);
      if (url) return { html: '<a href="' + escAttr(encodeHref(url)) + '">' + escText(url) + '</a>', end: i + url.length };
    }
  }
  // http(s):// and ftp:// link anywhere, even mid-word (xhttp://...).
  if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
    SCHEME_URL_RE.lastIndex = i;
    const m = SCHEME_URL_RE.exec(s);
    if (m) {
      const url = trimTail(m[0]);
      if (url) return { html: '<a href="' + escAttr(encodeHref(url)) + '">' + escText(url) + '</a>', end: i + url.length };
    }
  }
  // www. needs a boundary: start, whitespace, ( * _ ~ [, or a fresh
  // token position. After " ! . : / { } ; and the like it stays text.
  if (ch === 'w' && s.startsWith('www.', i) &&
    (fresh || prev === '' || prev === ' ' || prev === '\t' || prev === '\n' ||
      prev === '(' || prev === '*' || prev === '_' || prev === '~' || prev === '[')) {
    WWW_URL_RE.lastIndex = i;
    const m = WWW_URL_RE.exec(s);
    if (m) {
      const url = trimTail(m[0]);
      if (url) return { html: '<a href="' + escAttr(encodeHref('http://' + url)) + '">' + escText(url) + '</a>', end: i + url.length };
    }
  }
  if (tryEmail) return bareEmail(s, i);
  return null;
}

// Bare e-mail autolink at position i. The pattern itself rejects a
// trailing - or _ (the (?![\w-]) lookahead), so a.b-c_d@a.b- is
// literal. A cheap pre-scan first: the local part must reach an @.
function bareEmail(s, i) {
  let j = i;
  const n = s.length;
  while (j < n) {
    const code = s.charCodeAt(j);
    if (code === 64) break; // @
    if (!isLocalMailCode(code)) return null;
    j++;
  }
  if (j >= n) return null;
  BARE_EMAIL_RE.lastIndex = i;
  const m = BARE_EMAIL_RE.exec(s);
  if (m) {
    const email = m[0];
    return { html: '<a href="mailto:' + email + '">' + escText(email) + '</a>', end: i + email.length };
  }
  return null;
}

// ------------------------------------------------------------------
// Block engine.
//
// Block parsing follows the CommonMark reference algorithm: a stack
// of open containers (block quotes, list items) is matched against
// every line, then new leaf blocks are opened at the remaining
// content. Tabs are handled by column, so a tab that straddles an
// indent boundary contributes spaces.

// A cursor over one physical line, tracking the visual column. A tab
// that is only partly consumed leaves `left` spaces behind, which
// read as spaces until they run out.
class LineCursor {
  constructor(text) {
    this.text = text;
    this.at = 0;
    this.col = 0;
    this.left = 0;
  }

  dup() {
    const c = new LineCursor(this.text);
    c.at = this.at;
    c.col = this.col;
    c.left = this.left;
    return c;
  }

  copy(other) {
    this.at = other.at;
    this.col = other.col;
    this.left = other.left;
  }

  peek() {
    if (this.left > 0) return ' ';
    return this.at < this.text.length ? this.text[this.at] : '';
  }

  // Consume `n` columns. Returns false if the line runs out first.
  step(n) {
    while (n > 0) {
      if (this.left > 0) {
        const take = Math.min(this.left, n);
        this.left -= take;
        this.col += take;
        n -= take;
      } else if (this.at >= this.text.length) {
        return false;
      } else if (this.text[this.at] === '\t') {
        const width = 4 - (this.col % 4);
        this.at++;
        if (width <= n) {
          this.col += width;
          n -= width;
        } else {
          this.left = width - n;
          this.col += n;
          n = 0;
        }
      } else {
        this.at++;
        this.col++;
        n--;
      }
    }
    return true;
  }

  // Skip up to `maxCols` columns of spaces/tabs. Returns how many
  // columns were actually skipped.
  skipWsCols(maxCols) {
    let skipped = 0;
    while (skipped < maxCols) {
      const ch = this.peek();
      if (ch !== ' ' && ch !== '\t') break;
      this.step(1);
      skipped++;
    }
    return skipped;
  }

  rest() {
    return ' '.repeat(this.left) + this.text.slice(this.at);
  }

  isBlank() {
    if (this.left > 0) return true;
    for (let k = this.at; k < this.text.length; k++) {
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
function leadIndent(text, base) {
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
function cutAtCol(text, col, base) {
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
// `base`). Unlike cutAtCol, this only removes whitespace: a line
// with no leading spaces is returned unchanged. A tab that straddles
// the cut leaves spaces for its remainder.
function stripCols(text, n, base) {
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
function stripFence(text, n, strip) {
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
function restHasTab(cur) {
  let k = cur.at;
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
function expandTabs(cur, expandBase) {
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

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HR_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const BULLET_RE = /^ {0,3}([-+*])([ \t]+|$)/;
const ORDERED_RE = /^ {0,3}(\d{1,9})([.)])([ \t]+|$)/;
const TABLE_CELL_RE = /^:?-+:?$/;
const BQ_RE = /^ {0,3}>/;

function isBlankLine(text) {
  return /^[ \t]*$/.test(text);
}

// ------------------------------------------------------------------
// Link reference definitions.

// Parse a link destination starting at s[i], then an optional title.
// Returns {dest, title, maybeTitle} or null. `maybeTitle` means the
// line ended right after the destination: a title may still follow on
// the next line (CommonMark spec example 192). An unterminated title
// returns {dest, titlePartial} instead — the definition stays pending
// until the title closes on a following line.
function destTitle(s, i) {
  let dest = '';
  if (s[i] === '<') {
    let j = i + 1;
    let buf = '';
    while (j < s.length && s[j] !== '>') {
      if (s[j] === '\n') return null;
      if (s[j] === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) {
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
      if (ch === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) {
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
        if (ch === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) {
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
        return { dest: decodeEnts(dest), titlePartial: { quote, text: buf }, maybeTitle: false };
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
  return { dest: decodeEnts(dest), title: title === null ? null : decodeEnts(title), maybeTitle };
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
function refDefAt(content) {
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
  if (i >= content.length) return { label: normLabel(label), awaitingDest: true, raw: [content] };
  const res = destTitle(content, i);
  if (!res) return null;
  if (res.titlePartial) return { label: normLabel(label), dest: res.dest, titlePartial: res.titlePartial, raw: [content] };
  return { label: normLabel(label), dest: res.dest, title: res.title, maybeTitle: res.maybeTitle };
}

// Parse a destination (+ optional title) on a definition continuation
// line. The line may be indented arbitrarily (spec example 193).
// Returns {dest, title, maybeTitle} (or a titlePartial variant) or null.
function destLine(content) {
  let i = 0;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i++;
  if (i >= content.length) return null;
  return destTitle(content, i);
}

// A line consisting only of a link title (for a definition whose title
// is on the following line). The line may be indented arbitrarily
// (spec example 193). Returns the title string, {partial: {quote,
// text}} when the title runs onto a following line, or null when the
// line is not a title.
function titleLine(content) {
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
    if (ch === '\\' && j + 1 < content.length && isAsciiPunct(content[j + 1])) {
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

// ------------------------------------------------------------------
// HTML blocks.

// HTML block start conditions (CommonMark types 1-7). Returns the type
// (1-7) or 0 when the line does not start an HTML block. `inPara`
// matters only for type 7.
const HTML_T1_RE = /^ {0,3}<(script|pre|style|textarea)([\s>]|$)/i;
const HTML_T2_RE = /^ {0,3}<!--/;
const HTML_T3_RE = /^ {0,3}<\?/;
const HTML_T4_RE = /^ {0,3}<![A-Za-z]/;
const HTML_T5_RE = /^ {0,3}<!\[CDATA\[/;
const HTML_T6_RE = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s\/>]|$)/i;
const HTML_T7_OPEN_RE = /^ {0,3}<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>[ \t]*$/;
const HTML_T7_CLOSE_RE = /^ {0,3}<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/;

function htmlKind(content, inPara) {
  // Type 1 starts with an OPENING script/pre/style/textarea tag only;
  // a closing tag such as </pre> is not an HTML block start.
  if (HTML_T1_RE.test(content)) return 1;
  if (HTML_T2_RE.test(content)) return 2;
  if (HTML_T3_RE.test(content)) return 3;
  if (HTML_T4_RE.test(content)) return 4;
  if (HTML_T5_RE.test(content)) return 5;
  if (HTML_T6_RE.test(content)) return 6;
  // Type 7: a complete open or close tag alone on its line. Closing
  // tags take no attributes (</a href="foo"> is not an HTML block).
  if (!inPara && HTML_T7_OPEN_RE.test(content)) return 7;
  if (!inPara && HTML_T7_CLOSE_RE.test(content)) return 7;
  return 0;
}

const HTML_END1_RE = /<\/(script|pre|style|textarea)>/i;
const HTML_END2_RE = /-->/;
const HTML_END3_RE = /\?>/;
const HTML_END4_RE = />/;
const HTML_END5_RE = /\]\]>/;

function htmlEnds(type, content) {
  if (type === 1) return HTML_END1_RE.test(content);
  if (type === 2) return HTML_END2_RE.test(content);
  if (type === 3) return HTML_END3_RE.test(content);
  if (type === 4) return HTML_END4_RE.test(content);
  if (type === 5) return HTML_END5_RE.test(content);
  return false; // types 6 and 7 end at a blank line
}

// ------------------------------------------------------------------
// Tables.

// Split a table row line into cells (unescaped pipes; optional outer pipes).
function rowCells(line) {
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
function delimAligns(content) {
  const cells = rowCells(content);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!TABLE_CELL_RE.test(t)) return null;
    aligns.push(t.startsWith(':') ? (t.endsWith(':') ? 'center' : 'left') : (t.endsWith(':') ? 'right' : null));
  }
  return aligns;
}

// Whether `content` starts a block that can interrupt a paragraph
// (used to decide lazy continuation).
function interruptsPara(content) {
  if (ATX_RE.test(content)) return true;
  const fence = FENCE_RE.exec(content);
  if (fence && !(fence[1][0] === '`' && content.slice(fence[0].length).indexOf('`') >= 0)) return true;
  if (htmlKind(content, true) > 0) return true;
  if (HR_RE.test(content)) return true;
  const bm = BULLET_RE.exec(content) || ORDERED_RE.exec(content);
  if (bm) {
    // A list interrupts a paragraph only when its first item is
    // non-empty (bullets) or starts at 1 (ordered).
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

// ------------------------------------------------------------------
// Document builder.
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

class DocParse {
  constructor(src, refs) {
    this.src = src;
    this.refs = refs;
    this.lines = src.split('\n');
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
    this.root = { type: 'document', children: [] };
    this.stack = [this.root];
    this.tip = null; // currently open leaf block, if any
    this.pendDef = null; // a definition awaiting its title on the next line
    this.pendLabel = null; // a definition awaiting its destination ({label, raw: [lines]})
    this.pendLabelPartial = null; // a definition whose label spans lines ({parts: [lines]})
    this.pendTitle = null; // a definition whose title spans lines ({label, dest, quote, buf, rawLines})
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

  peekTop() {
    return this.stack[this.stack.length - 1];
  }

  append(parent, node) {
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

  dropTip() {
    this.tip = null;
  }

  // Close open blocks down to (but excluding) `depth` stack depth.
  closeDown(depth) {
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
  matchOpen(raw) {
    const cur = new LineCursor(raw);
    let depth = 1; // stack index of the first container to match
    let allMatched = true;
    const blankNodes = [];
    // Cursor column before the outermost strip that exposed a leading
    // tab in the remainder (null when none did). Drives expandTabs.
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
        const probe = cur.dup();
        probe.skipWsCols(3);
        if (probe.peek() === '>') {
          const colBefore = cur.col;
          probe.step(1);
          if (probe.peek() === '\t') {
            // A tab right after `>` is expanded from its column in
            // the post-strip text (marked expands the marker
            // whitespace first, then strips the marker plus one
            // space), so the remainder starts with (width - 1)
            // spaces where width is measured from the strip's frame,
            // not the original line column.
            const tabCol = probe.col - colBefore;
            probe.step(1);
            probe.left = (4 - (tabCol % 4)) - 1;
          } else if (probe.peek() === ' ') {
            probe.step(1);
          }
          cur.copy(probe);
          if (expandBase === null && restHasTab(cur)) expandBase = colBefore;
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
          cur.step(node.indent);
          if (expandBase === null && restHasTab(cur)) expandBase = colBefore;
          blankNodes.push(node);
          depth++;
          continue;
        }
        const rest = cur.rest();
        const ind = leadIndent(rest, cur.col);
        if (ind.col >= node.indent) {
          const colBefore = cur.col;
          cur.step(node.indent);
          if (expandBase === null && restHasTab(cur)) expandBase = colBefore;
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
  peekAhead(li) {
    let j = li + 1;
    while (j < this.lines.length && isBlankLine(this.lines[j])) j++;
    if (j >= this.lines.length) return null;
    const blanks = j - li;
    const { depth, allMatched, cur, expandBase } = this.matchOpen(this.lines[j]);
    const content = expandTabs(cur, expandBase);
    const contentBase = cur.col;
    // A code line inside the same item: all containers matched and the
    // content starts with 4+ columns of indentation.
    const isCodeLine = allMatched && leadIndent(content, contentBase).col >= 4;
    // A sibling item: matching stopped at an item whose parent list
    // the line's marker continues (same column, same ordered/delim).
    let isSiblingItem = false;
    if (!allMatched && this.stack[depth] && this.stack[depth].type === 'item') {
      const list = this.stack[depth - 1];
      if (list && list.type === 'list') {
        const bm = BULLET_RE.exec(content);
        const om = !bm && ORDERED_RE.exec(content);
        if (bm || om) {
          const markerCol = contentBase + leadIndent(content, contentBase).col;
          const ordered = !!om;
          const delim = ordered ? om[2] : bm[1];
          if (markerCol === list.markerCol && list.ordered === ordered && list.delim === delim) isSiblingItem = true;
        }
      }
    }
    return { blanks, depth, allMatched, content, contentBase, isCodeLine, isSiblingItem };
  }

  // The main line loop. Returns the document's top-level nodes.
  parseAll() {
    const lines = this.lines;
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];

      // --- 1. Match open containers.
      const { depth, allMatched, cur, blankNodes, expandBase } = this.matchOpen(raw);
      const content = expandTabs(cur, expandBase);
      const contentBase = cur.col; // absolute column the content starts at
      const blank = isBlankLine(content);

      // --- 2. Container mismatch: lazy leaf continuation or close.
      if (!allMatched) {
        const para = this.tip && this.tip.type === 'paragraph' ? this.tip : null;
        // A line starting a block (heading, fence, HTML, HR,
        // blockquote, or a list item when inside a list item) ends the
        // containers; anything else may continue the open leaf lazily.
        // A fenced code block or HTML block only absorbs a lazy line
        // once it already has content (an opener alone does not); a
        // table always does.
        const listLine = BULLET_RE.test(content) || ORDERED_RE.test(content);
        const inItem = this.stack.some((n) => n.type === 'item');
        const bqLine = /^ {0,3}>/.test(content);
        const blockStart = !blank && (interruptsPara(content) || bqLine || (listLine && inItem));
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
          const ind = leadIndent(content, contentBase);
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
            para.lines.push(cutAtCol(content, 4, contentBase));
            para.lastWasCodeMerge = true;
            para.lastWasLazy = true;
          } else {
            // A lazy non-code line after a code-merged line does NOT
            // contribute an empty line (the '' rule applies only to
            // lines that match the item container, in handleLine).
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
            const parentIsBq = this.peekTop().type === 'blockquote';
            para.lines.push(SETEXT_RE.test(content) && para.lastWasLazy && parentIsBq ? '    ' + content : content);
            para.lastWasLazy = true;
          }
          continue;
        }
        if (!blank && !blockStart && inListAtMismatch && this.tip && this.tip.type === 'code' && this.tip.fenced && this.tip.lines.length > 0) {
          // Lazy fenced-code content: the line is kept unstripped
          // (past the containers that did match), with the fence's own
          // indentation stripped as usual.
          this.blankStack = null;
          this.tip.lines.push(stripFence(content, this.tip.fenceIndent || 0, this.tip.fenceChar === '`'));
          continue;
        }
        if (!blank && !blockStart && inListAtMismatch && this.tip && this.tip.type === 'html' && this.tip.lines.length > 1) {
          // Lazy HTML content.
          this.blankStack = null;
          this.tip.lines.push(content);
          this.tip.endLine = li;
          if (this.tip.htmlType <= 5 && htmlEnds(this.tip.htmlType, content)) this.dropTip();
          continue;
        }
        if (!blank && !blockStart && inListAtMismatch && this.tip && this.tip.type === 'table') {
          // A lazy line after a table is another row.
          this.blankStack = null;
          this.tip.rows.push(rowCells(content));
          continue;
        }
        // Close unmatched containers (and the open leaf).
        this.closeDown(depth);
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
          const parent = this.peekTop();
          let isContent = false;
          if (parent.type === 'blockquote') {
            if (li + 1 >= lines.length) {
              isContent = true;
            } else {
              const next = this.matchOpen(lines[li + 1]);
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
        if (this.pendLabelPartial) {
          this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendLabelPartial.parts, inItem: this.peekTop().type === 'item' });
          this.pendLabelPartial = null;
        }
        if (this.pendTitle && this.pendTitle.quote === "'") {
          if (this.pendTitle.registered) delete this.refs[this.pendTitle.label];
          this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendTitle.rawLines, inItem: this.peekTop().type === 'item' });
          this.pendTitle = null;
        } else if (this.pendTitle) {
          this.pendTitle.buf += '\n' + content;
          this.pendTitle.rawLines.push(content);
          continue;
        }
        if (this.pendLabel) {
          this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendLabel.raw, inItem: this.peekTop().type === 'item' });
          this.pendLabel = null;
        }
        if (this.pendDef) this.pendDef = null;
        if (this.tip && this.tip.type === 'table' && content !== '' && !/^ *$/.test(content) && !(li === lines.length - 1 && !this.src.endsWith('\n'))) {
          // A whitespace-only line that is not spaces-only (it holds a
          // tab) is a table row, not a blank line: marked's table body
          // excludes only empty and spaces-only lines. The one
          // exception is a trailing tab-only line at EOF without a
          // newline, which marked's tableRowBlankLine strips.
          this.tip.rows.push(rowCells(content));
          continue;
        }
        if (this.tip && this.tip.type === 'code') {
          // A blank line inside fenced code keeps its content past the
          // fence's indentation; inside indented code it keeps the
          // spaces past the 4-column indent.
          this.tip.lines.push(this.tip.fenced ? stripFence(content, this.tip.fenceIndent || 0, this.tip.fenceChar === '`') : stripCols(content, 4, contentBase));
          continue;
        }
        if (this.tip && this.tip.type === 'html') {
          if (this.tip.htmlType === 6 || this.tip.htmlType === 7) {
            this.tip.endedAtBlank = true;
            this.dropTip();
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
          const ahead = this.peekAhead(li);
          if (ahead && ahead.isCodeLine) {
            this.tip.pendingBlanksAfterCode = (this.tip.pendingBlanksAfterCode || 0) + 1;
            continue;
          }
          if (ahead && ahead.blanks === 1 && ahead.isSiblingItem) this.tip.lines.push('');
        }
        if (this.tip && this.tip.type === 'paragraph') this.dropTip();
        if (this.tip && this.tip.type === 'table') this.dropTip();
        // An empty item ends at a blank line (its content, if any,
        // sits outside the list).
        while (this.stack.length > 1 && this.peekTop().type === 'item' && this.peekTop().children.length === 0) this.stack.pop();
        // Only the containers the blank line is actually blank inside
        // (a `>` line counts for its blockquote, not for the item).
        this.blankStack = blankNodes;
        continue;
      }

      // --- 3. Open leaf blocks: fenced code, indented code, HTML block.
      if (this.tip && this.tip.type === 'code' && this.tip.fenced) {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
        if (m && m[1][0] === this.tip.fenceChar && m[1].length >= this.tip.fenceLen) {
          this.dropTip();
          continue;
        }
        // Backtick fences strip up to the opening fence's indentation
        // (counted in CHARACTERS, spaces or tabs) from each line;
        // tilde fences strip nothing.
        this.tip.lines.push(stripFence(content, this.tip.fenceIndent || 0, this.tip.fenceChar === '`'));
        this.blankStack = null;
        continue;
      }
      if (this.tip && this.tip.type === 'code' && !this.tip.fenced) {
        const ind = leadIndent(content, contentBase);
        if (ind.col >= 4) {
          this.tip.lines.push(cutAtCol(content, 4, contentBase));
          continue;
        }
        this.dropTip();
        // fall through: reprocess this line as a new block
      }
      if (this.tip && this.tip.type === 'html') {
        if (this.tip.htmlType <= 5 && htmlEnds(this.tip.htmlType, content)) {
          // The line that ends the block is part of the block.
          this.tip.lines.push(content);
          this.tip.endLine = li;
          this.dropTip();
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
      this.handleLine(content, li, contentBase);
      if (!this.lineWasDef) this.blankStack = null;
    }

    // EOF: a definition that never completed becomes paragraph text
    // ([foo]: at the end of input renders as <p>[foo]:</p>). A title
    // that never closed fails the whole definition, so an already
    // registered one is unregistered again.
    if (this.pendLabelPartial) {
      this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendLabelPartial.parts, inItem: this.peekTop().type === 'item' });
      this.pendLabelPartial = null;
    }
    if (this.pendLabel) {
      this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendLabel.raw, inItem: this.peekTop().type === 'item' });
      this.pendLabel = null;
    }
    if (this.pendTitle) {
      if (this.pendTitle.registered) delete this.refs[this.pendTitle.label];
      this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendTitle.rawLines, inItem: this.peekTop().type === 'item' });
      this.pendTitle = null;
    }

    this.finish(this.root, false, false);
    return this.root.children;
  }

  // Process one line's content as the start or continuation of blocks
  // inside the currently open containers. Called once per physical
  // line and recursively for a list item's or blockquote's first-line
  // remainder. Returns when the line is consumed.
  handleLine(content, lineIdx, base) {
    base = base || 0;
    // A definition whose label spans lines: look for the closing ] on
    // this line. An unescaped [ kills it; a blank line already did
    // (handled in the blank branch of parseAll).
    if (this.pendLabelPartial) {
      const parts = this.pendLabelPartial.parts;
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
        this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: [...parts, content], inItem: this.peekTop().type === 'item' });
        this.pendLabelPartial = null;
        return;
      }
      if (closeIdx < 0) {
        parts.push(content);
        this.lineWasDef = true;
        return;
      }
      const labelText = parts.join('\n') + '\n' + content.slice(0, closeIdx);
      const label = labelText.replace(/^ {0,3}\[/, '');
      this.pendLabelPartial = null;
      let k = closeIdx + 1;
      if (content[k] !== ':' || label.trim() === '') {
        this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: [...parts, content], inItem: this.peekTop().type === 'item' });
        return;
      }
      k++;
      while (k < content.length && (content[k] === ' ' || content[k] === '\t')) k++;
      const rawLines = [...parts, content];
      if (k >= content.length) {
        this.pendLabel = { label: normLabel(label), raw: rawLines };
        this.lineWasDef = true;
        return;
      }
      const res = destTitle(content, k);
      if (!res) {
        this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: rawLines, inItem: this.peekTop().type === 'item' });
        return;
      }
      if (res.titlePartial) {
        this.pendTitle = { label: normLabel(label), dest: res.dest, quote: res.titlePartial.quote, buf: res.titlePartial.text, rawLines };
        this.lineWasDef = true;
        return;
      }
      const stored = !this.refs[normLabel(label)];
      if (stored) this.refs[normLabel(label)] = { dest: res.dest, title: res.title };
      if (res.maybeTitle) this.pendDef = { label: normLabel(label), rawLines, stored };
      this.dropTip();
      this.lineWasDef = true;
      return;
    }
    // A definition whose title spans lines: accumulate this line and
    // look for the closing quote. Anything but spaces/tabs after the
    // closing quote kills the definition.
    if (this.pendTitle) {
      const quote = this.pendTitle.quote;
      const closeQuote = quote === '(' ? ')' : quote;
      let j = 0;
      let buf = this.pendTitle.buf + '\n';
      let closed = false;
      while (j < content.length) {
        const ch = content[j];
        if (ch === '\\' && j + 1 < content.length && isAsciiPunct(content[j + 1])) {
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
      this.pendTitle.rawLines.push(content);
      if (!closed) {
        if (quote === '(' && j < content.length && content[j] === '(') {
          if (this.pendTitle.registered) delete this.refs[this.pendTitle.label];
          this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendTitle.rawLines, inItem: this.peekTop().type === 'item' });
          this.pendTitle = null;
          return;
        }
        this.pendTitle.buf = buf;
        this.lineWasDef = true;
        return;
      }
      j++;
      while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
      if (j < content.length) {
        if (this.pendTitle.registered) delete this.refs[this.pendTitle.label];
        this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: this.pendTitle.rawLines, inItem: this.peekTop().type === 'item' });
        this.pendTitle = null;
        return;
      }
      if (!this.refs[this.pendTitle.label]) this.refs[this.pendTitle.label] = { dest: this.pendTitle.dest, title: decodeEnts(buf) };
      this.pendTitle = null;
      this.dropTip();
      this.lineWasDef = true;
      return;
    }
    // A definition awaiting its destination or title on this line.
    if (this.pendLabel) {
      const res = destLine(content);
      if (res) {
        if (res.titlePartial) {
          this.pendTitle = { label: this.pendLabel.label, dest: res.dest, quote: res.titlePartial.quote, buf: res.titlePartial.text, rawLines: [...this.pendLabel.raw, content] };
        } else {
          const stored = !this.refs[this.pendLabel.label];
          if (stored) this.refs[this.pendLabel.label] = { dest: res.dest, title: res.title };
          if (res.maybeTitle) this.pendDef = { label: this.pendLabel.label, rawLines: [...this.pendLabel.raw, content], stored };
        }
        this.pendLabel = null;
        this.lineWasDef = true;
        return;
      }
      // Not a destination: the label line becomes paragraph text.
      const rawLines = this.pendLabel.raw;
      this.pendLabel = null;
      this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: rawLines, inItem: this.peekTop().type === 'item' });
      // Fall through: this line follows that paragraph.
    }
    if (this.pendDef) {
      const t = titleLine(content);
      if (t !== null) {
        if (typeof t === 'object') {
          // The title runs onto following lines. The definition is
          // already registered (without a title); if the title fails
          // to close cleanly, the whole definition fails and must be
          // unregistered (flagged by `registered`).
          this.pendTitle = { label: this.pendDef.label, dest: this.refs[this.pendDef.label].dest, quote: t.partial.quote, buf: t.partial.text, rawLines: [...this.pendDef.rawLines, content], registered: this.pendDef.stored };
          this.pendDef = null;
          this.lineWasDef = true;
          return;
        }
        const rec = this.refs[this.pendDef.label];
        if (rec && this.pendDef.stored) rec.title = decodeEnts(t);
        this.pendDef = null;
        this.lineWasDef = true;
        return;
      }
      this.pendDef = null; // the definition stands without a title
    }
    // Setext heading: converts the open paragraph — unless an empty
    // line got into the paragraph (from a code merge), which marked's
    // lheading pattern cannot span. A code-merged line reverts to its
    // un-merged form when a setext heading converts (the lheading
    // token claims the lines before the code merge applies).
    if (this.tip && this.tip.type === 'paragraph') {
      const sm = SETEXT_RE.exec(content);
      if (sm && !this.tip.noSetext) {
        const level = sm[1][0] === '=' ? 1 : 2;
        if (this.tip.codeMergeOrig) {
          for (let k = 0; k < this.tip.lines.length; k++) {
            if (this.tip.codeMergeOrig[k] !== undefined) this.tip.lines[k] = this.tip.codeMergeOrig[k];
          }
        }
        const text = this.tip.lines.join('\n').replace(/^[ \t]+|[ \t]+$/g, '');
        const parent = this.peekTop();
        parent.children[parent.children.length - 1] = { type: 'heading', level, text };
        this.dropTip();
        return;
      }
      // Table: a one-line paragraph plus a delimiter row with the same
      // number of cells (marked allows a header without pipes). The
      // delimiter row itself must be indented at most 3 spaces.
      if (this.tip.lines.length === 1 && leadIndent(content, base).col <= 3) {
        const aligns = delimAligns(content);
        if (aligns) {
          const header = rowCells(this.tip.lines[0]);
          if (aligns.length === header.length) {
            const table = { type: 'table', header, aligns, rows: [] };
            const parent = this.peekTop();
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
    const isListItem = (BULLET_RE.test(content) || ORDERED_RE.test(content)) && !HR_RE.test(content);
    if (!isListItem) {
      while (this.peekTop().type === 'list') this.stack.pop();
    }
    // Blockquote: open the container, then process the remainder.
    const bq = BQ_RE.exec(content);
    if (bq) {
      this.dropTip();
      const bqNode = this.append(this.peekTop(), { type: 'blockquote', children: [] });
      this.stack.push(bqNode);
      const bc = new LineCursor(content);
      bc.skipWsCols(3);
      bc.step(1); // '>'
      if (bc.peek() === ' ' || bc.peek() === '\t') bc.step(1);
      const rest = bc.rest();
      if (rest !== '' && !isBlankLine(rest)) this.handleLine(rest, lineIdx, bc.col);
      this.lineWasDef = false; // the blockquote itself is a block
      return;
    }
    // ATX heading.
    const atx = ATX_RE.exec(content);
    if (atx) {
      this.dropTip();
      let text = content.slice(atx[0].length).replace(/^[ \t]+|[ \t]+$/g, '');
      text = text.replace(/[ \t]+#+$/, '');
      if (/^#+$/.test(text)) text = '';
      this.append(this.peekTop(), { type: 'heading', level: atx[1].length, text });
      return;
    }
    // Fenced code.
    const fence = FENCE_RE.exec(content);
    if (fence) {
      const info = content.slice(fence[0].length).trim();
      if (fence[1][0] === '`' && info.indexOf('`') >= 0) {
        // A backtick fence cannot carry backticks in its info string:
        // treat the line as paragraph text (do not close the leaf).
      } else {
        this.dropTip();
        this.tip = this.append(this.peekTop(), { type: 'code', fenced: true, fenceChar: fence[1][0], fenceLen: fence[1].length, info, fenceIndent: leadIndent(content, base).col, lines: [] });
        return;
      }
    }
    // HTML block.
    const inPara = !!(this.tip && this.tip.type === 'paragraph');
    const htype = htmlKind(content, inPara);
    if (htype) {
      this.dropTip();
      this.tip = this.append(this.peekTop(), { type: 'html', htmlType: htype, lines: [content], startLine: lineIdx, endLine: lineIdx, endedAtBlank: false });
      if (htype <= 5 && htmlEnds(htype, content)) this.dropTip();
      return;
    }
    // Thematic break.
    if (HR_RE.test(content)) {
      this.dropTip();
      this.append(this.peekTop(), { type: 'hr' });
      return;
    }
    // List item: open it, then process the remainder as its first content.
    const opened = this.listMarker(content, base);
    if (opened !== null) {
      this.dropTip();
      if (opened.rest !== '' && !isBlankLine(opened.rest)) this.handleLine(opened.rest, lineIdx, opened.base);
      this.lineWasDef = false; // the list item itself is a block
      return;
    }
    // Indented code (cannot interrupt a paragraph).
    if (!this.tip || this.tip.type !== 'paragraph') {
      const ind = leadIndent(content, base);
      if (ind.col >= 4) {
        this.dropTip();
        this.tip = this.append(this.peekTop(), { type: 'code', fenced: false, info: '', lines: [cutAtCol(content, 4, base)] });
        return;
      }
    }
    // Table row continuation.
    if (this.tip && this.tip.type === 'table') {
      this.tip.rows.push(rowCells(content));
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
      if (this.tip.inItem && leadIndent(content, base).col >= 4) {
        if (this.tip.pendingBlanksAfterCode) {
          for (let k = 0; k < this.tip.pendingBlanksAfterCode; k++) this.tip.lines.push('');
          this.tip.noSetext = true;
          this.tip.pendingBlanksAfterCode = 0;
        }
        this.tip.codeMergeOrig = this.tip.codeMergeOrig || [];
        this.tip.codeMergeOrig[this.tip.lines.length] = content;
        this.tip.lines.push(cutAtCol(content, 4, base));
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
    const def = refDefAt(content);
    if (def) {
      if (def.labelPartial) {
        this.pendLabelPartial = { parts: [content] };
      } else if (def.awaitingDest) {
        this.pendLabel = def;
      } else if (def.titlePartial) {
        this.pendTitle = { label: def.label, dest: def.dest, quote: def.titlePartial.quote, buf: def.titlePartial.text, rawLines: [content] };
      } else {
        const stored = !this.refs[def.label];
        if (stored) this.refs[def.label] = { dest: def.dest, title: def.title };
        if (def.maybeTitle) this.pendDef = { label: def.label, rawLines: [content], stored };
      }
      this.dropTip();
      this.lineWasDef = true;
      return;
    }
    this.tip = this.append(this.peekTop(), { type: 'paragraph', lines: [content], inItem: this.peekTop().type === 'item' });
  }

  // Try to open a list item at `content`. Returns the item's
  // first-line remainder (to be processed as the item's first content)
  // when a list item was opened, or null when the line is not a list
  // item.
  listMarker(content, base) {
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
    if (this.tip && this.tip.type === 'paragraph' && !this.tip.inItem) {
      const after = content.slice(m[0].length);
      if (after.trim() === '') return null;
      if (ordered && startNum !== 1) return null;
    }
    // Columns: the marker sits after up to 3 spaces of indentation.
    const markerCol = leadIndent(content, base).col;
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
      this.addItem(ordered, startNum, ordered ? delim : markerText, indent, '', base + markerCol);
      return { rest: '', base };
    }
    if (spaces >= 1 && spaces <= 4) {
      indent = markerEndCol + spaces;
    } else {
      // 5+ spaces: the content starts one space after the marker.
      indent = markerEndCol + 1;
    }
    const rest = this.addItem(ordered, startNum, ordered ? delim : markerText, indent, cutAtCol(content, indent, base), base + markerCol);
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
  addItem(ordered, startNum, wantDelim, indent, remainder, absMarkerCol) {
    const topNode = this.peekTop();
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
      parent = this.peekTop();
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
  finish(node, isTop, hasNext) {
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
    if (node.children) node.children.forEach((child, i) => this.finish(child, node.type === 'document', i < node.children.length - 1));
  }
}

// ------------------------------------------------------------------
// Rendering.

function renderAll(nodes, refs) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, refs);
  return out;
}

function renderBlock(node, refs) {
  if (node.type === 'heading') {
    return '<h' + node.level + '>' + inlineHtml(node.text, refs) + '</h' + node.level + '>\n';
  }
  if (node.type === 'paragraph') {
    return '<p>' + inlineHtml(node.lines.join('\n'), refs) + '</p>\n';
  }
  if (node.type === 'code') {
    const text = node.lines.length ? node.lines.join('\n') + '\n' : '';
    // The info string's backslash escapes are decoded (``` foo\+bar
    // gives language "foo+bar"); the first word is the language.
    const lang = node.info ? node.info.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1').split(/\s+/)[0] : '';
    const cls = lang ? ' class="language-' + escAttr(lang) + '"' : '';
    return '<pre><code' + cls + '>' + escText(text) + '</code></pre>\n';
  }
  if (node.type === 'html') return node.text;
  if (node.type === 'blockquote') {
    return '<blockquote>\n' + renderAll(node.children, refs) + '</blockquote>\n';
  }
  if (node.type === 'hr') return '<hr>\n';
  if (node.type === 'list') {
    const tag = node.ordered ? 'ol' : 'ul';
    const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
    let s = '<' + tag + start + '>\n';
    for (const item of node.children) if (item.type === 'item') s += renderItem(item, node.tight, refs);
    return s + '</' + tag + '>\n';
  }
  if (node.type === 'table') {
    let s = '<table>\n<thead>\n<tr>\n';
    for (let i = 0; i < node.header.length; i++) {
      const a = node.aligns[i] ? ' align="' + node.aligns[i] + '"' : '';
      s += '<th' + a + '>' + inlineHtml(node.header[i], refs) + '</th>\n';
    }
    s += '</tr>\n</thead>\n';
    if (node.rows.length) {
      s += '<tbody>';
      for (const row of node.rows) {
        s += '<tr>\n';
        for (let i = 0; i < node.header.length; i++) {
          const cell = i < row.length ? row[i] : '';
          const a = node.aligns[i] ? ' align="' + node.aligns[i] + '"' : '';
          s += '<td' + a + '>' + inlineHtml(cell, refs) + '</td>\n';
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
      if (tight) s += checkbox + inlineHtml(text, refs);
      else s += '<p>' + checkbox + inlineHtml(text, refs) + '</p>\n';
    } else {
      s += renderBlock(child, refs);
    }
  }
  return s + '</li>\n';
}

// ------------------------------------------------------------------
// Export.

// The entry point: render `markdown` exactly as marked 18.1.3 does
// with its defaults. Line endings are normalised first (CR and CRLF
// become LF); link reference definitions are collected per document.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = Object.create(null);
  aTagOpen = false;
  const doc = new DocParse(src, refs);
  const blocks = doc.parseAll();
  return renderAll(blocks, refs);
}
