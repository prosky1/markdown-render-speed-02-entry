// parse.js — CommonMark + GFM renderer, byte-identical to marked 18.1.3.
// Written from scratch in this session from the competition kit's practice
// data and from probing the reference renderer. No dependency on marked.
// Exported entry point: parse(markdown) -> HTML string.
// (Guardrail: this comment is the second-message revision touch; the
// renderer output is unchanged by it.)

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isHex(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}
function isLetter(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
function isAlnum(ch) { return isLetter(ch) || isDigit(ch); }
function isWord(ch) { return isAlnum(ch) || ch === '_'; }
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isBlankLine(s) {
  for (let k = 0; k < s.length; k++) if (s[k] !== ' ' && s[k] !== '\t') return false;
  return true;
}

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  return PUNCT_RE.test(ch);
}
// Backslash escapes only work before ASCII punctuation (CommonMark:
// "any ASCII punctuation character may be backslash-escaped").
function isAsciiPunct(ch) {
  return !!ch && ch.charCodeAt(0) < 128 && ASCII_PUNCT.has(ch);
}
const WS_RE = /\s/;
function isWSChar(ch) {
  if (!ch) return true;
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return WS_RE.test(ch);
}

// Unescape backslash escapes: \ + punctuation -> the punctuation char.
function unescapeStr(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += ch;
  }
  return out;
}

// Entity-aware text escape. Named entities pass through unchanged; numeric
// entities decode (invalid code points become U+FFFD) and the result is
// escaped if it is one of the five special characters.
function escText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      let j = i + 1;
      if (j < n && s[j] === '#') {
        j++;
        let hex = false;
        if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
        const ds = j;
        if (hex) { while (j < n && isHex(s[j])) j++; }
        else { while (j < n && isDigit(s[j])) j++; }
        const len = j - ds;
        if (len > 0 && ((hex && len <= 6) || (!hex && len <= 7)) && j < n && s[j] === ';') {
          let cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
          if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
          const decoded = String.fromCodePoint(cp);
          out += ESC[decoded] || decoded;
          i = j + 1;
          continue;
        }
      } else {
        let k = j;
        while (k < n && isWord(s[k])) k++;
        if (k > j && k < n && s[k] === ';') { out += s.slice(i, k + 1); i = k + 1; continue; }
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (ch === '<') { out += '&lt;'; i++; continue; }
    if (ch === '>') { out += '&gt;'; i++; continue; }
    if (ch === '"') { out += '&quot;'; i++; continue; }
    if (ch === "'") { out += '&#39;'; i++; continue; }
    let k = i + 1;
    while (k < n) {
      const d = s[k];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      k++;
    }
    out += s.slice(i, k);
    i = k;
  }
  return out;
}

// Escape for code spans / code blocks: all five characters, no entities.
function escCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    const rep = ESC[ch];
    if (rep) { out += rep; i++; continue; }
    let k = i + 1;
    while (k < n && !ESC[s[k]]) k++;
    out += s.slice(i, k);
    i = k;
  }
  return out;
}

// encodeURI, or null when the value cannot be encoded (lone surrogate).
function cleanUrl(href) {
  // encodeURI percent-encodes '%', so restore it: a valid %XX escape in
  // the input must survive, and a literal '%' stays a literal '%'.
  try { return encodeURI(href).replace(/%25/g, '%'); } catch (e) { return null; }
}

// Escape an already-encoded href. Entities (named or numeric) are kept
// literally; a bare & becomes &amp;. Quotes and angle brackets are escaped.
function escHref(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      let j = i + 1;
      let kept = false;
      if (j < n && s[j] === '#') {
        j++;
        let hex = false;
        if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
        const ds = j;
        if (hex) { while (j < n && isHex(s[j])) j++; }
        else { while (j < n && isDigit(s[j])) j++; }
        const len = j - ds;
        if (len > 0 && ((hex && len <= 6) || (!hex && len <= 7)) && j < n && s[j] === ';') kept = true;
      } else {
        let k = j;
        while (k < n && isWord(s[k])) k++;
        if (k > j && k < n && s[k] === ';') kept = true;
      }
      if (kept) {
        let k = i + 1;
        if (s[k] === '#') {
          k++;
          if (s[k] === 'x' || s[k] === 'X') k++;
          while (k < n && isHex(s[k])) k++;
          if (s[k] === ';') k++;
        } else {
          while (k < n && isWord(s[k])) k++;
          if (s[k] === ';') k++;
        }
        out += s.slice(i, k);
        i = k;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (ch === '<') { out += '&lt;'; i++; continue; }
    if (ch === '>') { out += '&gt;'; i++; continue; }
    if (ch === '"') { out += '&quot;'; i++; continue; }
    if (ch === "'") { out += '&#39;'; i++; continue; }
    let k = i + 1;
    while (k < n) {
      const d = s[k];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      k++;
    }
    out += s.slice(i, k);
    i = k;
  }
  return out;
}

// ---------- inline parsing ----------

function isEmailLocal(ch) {
  return isAlnum(ch) || ch === '.' || ch === '_' || ch === '+' || ch === '-';
}
// True when the most recent '_' delimiter atom is a pure opener (can open
// but not close): an underscore emphasis is open, so a '_' run after an
// email domain is that emphasis's closer, not domain text.
function hasOpenUnderscore(atoms) {
  for (let k = atoms.length - 1; k >= 0; k--) {
    const a = atoms[k];
    if (a.k === 'd' && a.c === '_') return a.o === true && a.cl === false;
  }
  return false;
}

function isDomainChar(ch) {
  return isAlnum(ch) || ch === '-' || ch === '_';
}

// Advance j over domain characters, but stop before a run of underscores
// that sits at a word boundary (followed by a character that is neither a
// domain character nor a dot) when an underscore emphasis is open: such a
// run is the emphasis's closer, not part of the domain. Without an open
// emphasis the underscores are domain text (a label ending in '_' is
// invalid, so the email fails instead).
function scanDomainChars(src, j, n, openU) {
  while (j < n && isDomainChar(src[j])) {
    if (src[j] === '_' && openU) {
      let k = j;
      while (k < n && src[k] === '_') k++;
      if (k >= n || (!isDomainChar(src[k]) && src[k] !== '.')) break;
      j = k;
    } else {
      j++;
    }
  }
  return j;
}
function isCMEmailLocal(ch) {
  return isAlnum(ch) || '.!#$%&\'*+/=?^_`{|}~-'.indexOf(ch) !== -1;
}

// Domain for a GFM email autolink, starting after '@' at atPos.
// First label is loose ([A-Za-z0-9_-]+); later labels must end with an
// alphanumeric character. Requires at least one dot. Returns the end index
// (exclusive) of the domain, or -1 when invalid. The domain's last
// character must be alphanumeric (a label ending in '-' or '_' is not a
// valid end), so a trailing run of '_' or '-' is excluded by the scan.
function matchEmailDomain(src, atPos, n, openU) {
  let j = atPos + 1;
  const start = j;
  j = scanDomainChars(src, j, n, openU);
  if (j === start) return -1;
  let dots = 0;
  while (j < n && src[j] === '.') {
    let k = j + 1;
    k = scanDomainChars(src, k, n, openU);
    if (k === j + 1) break;
    if (!isAlnum(src[k - 1])) break;
    dots++;
    j = k;
  }
  if (dots === 0) return -1;
  return j;
}

function isCommonMarkEmail(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  for (let k = 0; k < at; k++) if (!isCMEmailLocal(s[k])) return false;
  const domain = s.slice(at + 1);
  if (!domain || domain.charCodeAt(domain.length - 1) === 46) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const lab of labels) {
    if (!lab) return false;
    if (!isAlnum(lab[0]) || !isAlnum(lab[lab.length - 1])) return false;
    for (let k = 0; k < lab.length; k++) {
      if (!isAlnum(lab[k]) && lab[k] !== '-') return false;
    }
  }
  return true;
}

// End index (exclusive) of a <...> CommonMark autolink starting at src[i],
// or -1. The content must be a scheme (2-32 chars) or a valid email, with
// no space or '<' before the closing '>'.
function autolinkEnd(src, i, n) {
  let j = i + 1;
  while (j < n && src[j] !== '>' && src[j] !== '<' && !isSpace(src[j])) j++;
  if (j >= n || src[j] !== '>') return -1;
  const content = src.slice(i + 1, j);
  if (/^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):(.+)$/.test(content)) return j + 1;
  if (isCommonMarkEmail(content)) return j + 1;
  return -1;
}

// Find the ']' matching the '[' at position i. Bracket-depth aware,
// code-span aware, escape aware. Fails when a blank line intervenes.
function findClosingBracket(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunct(src[j + 1])) { j += 2; continue; }
    if (ch === '`') {
      // A code span in link text is `+ [^`]*? `+ (the two runs need
      // not match in length), so it ends at the FIRST later backtick
      // run. With no later run, a run of 2+ backticks immediately
      // before the closing ] is consumed instead; anything else is
      // not a link (a lone backtick, or a backtick run that cannot
      // close, makes the label unmatchable).
      let run = 0;
      while (j + run < n && src[j + run] === '`') run++;
      let k = j + run;
      while (k < n && src[k] !== '`') {
        if (src[k] === '\n') {
          let m2 = k + 1;
          while (m2 < n && (src[m2] === ' ' || src[m2] === '\t')) m2++;
          if (m2 < n && src[m2] === '\n') return -1;
        }
        k++;
      }
      if (k < n) {
        let run2 = 0;
        while (k + run2 < n && src[k + run2] === '`') run2++;
        j = k + run2;
        continue;
      }
      if (run >= 2 && j + run < n && src[j + run] === ']') return j + run;
      return -1;
    }
    if (ch === '\n') {
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n && src[k] === '\n') return -1;
      j++;
      continue;
    }
    if (ch === '[') { depth++; j++; continue; }
    if (ch === ']') {
      if (depth === 0) return j;
      depth--;
      j++;
      continue;
    }
    // A '<' that opens a valid autolink or tag swallows it (including
    // any ']' inside), so it cannot close the link text. An autolink
    // whose '>' lies past the ']' swallows the ']' itself.
    if (ch === '<') {
      const ae = autolinkEnd(src, j, n);
      if (ae !== -1) { j = ae; continue; }
      const te = parseInlineTag(src, j, n);
      if (te !== -1) { j = te; continue; }
    }
    j++;
  }
  return -1;
}

// Find the ']' ending a link label (the second [...] of a full reference
// or a definition's label). Unlike the link-text scan this takes the FIRST
// unescaped ']' — labels cannot contain nested brackets, so a label whose
// content holds an unescaped '[' is invalid.
function findLabelEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  let hasOpen = false;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunct(src[j + 1])) { j += 2; continue; }
    if (ch === '`') {
      let run = 0;
      while (j + run < n && src[j + run] === '`') run++;
      let k = j + run;
      let found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let r = 0;
          while (k + r < n && src[k + r] === '`') r++;
          if (r === run) { found = k; break; }
          k += r;
        } else k++;
      }
      if (found === -1) { j++; continue; }
      j = found + run;
      continue;
    }
    if (ch === '\n') {
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n && src[k] === '\n') return -1;
      j++;
      continue;
    }
    if (ch === '[') { hasOpen = true; j++; continue; }
    if (ch === ']') return hasOpen ? -1 : j;
    if (ch === '<') {
      const te = parseInlineTag(src, j, n);
      if (te !== -1) { j = te; continue; }
    }
    j++;
  }
  return -1;
}

// Parse the (destination "title") part of an inline link, src[j] === '('.
// Returns { href, title, end } with href/title already escaped, or null.
function parseInlineDest(src, j, n) {
  let k = j + 1;
  while (k < n && isSpace(src[k])) k++;
  if (k >= n) return null;
  let dest;
  if (src[k] === '<') {
    let m = k + 1;
    while (m < n && src[m] !== '>' && src[m] !== '\n') {
      if (src[m] === '<') return null;
      if (src[m] === '\\' && m + 1 < n && isAsciiPunct(src[m + 1])) m += 2;
      else m++;
    }
    if (m >= n || src[m] !== '>') return null;
    dest = unescapeStr(src.slice(k + 1, m));
    k = m + 1;
  } else {
    let depth = 0;
    let m = k;
    while (m < n) {
      const ch = src[m];
      if (ch === '(') { depth++; m++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        m++;
        continue;
      }
      if (isSpace(ch) || ch.charCodeAt(0) < 32) break;
      if (ch === '\\' && m + 1 < n && isAsciiPunct(src[m + 1])) { m += 2; continue; }
      m++;
    }
    if (depth > 0) return null;
    dest = unescapeStr(src.slice(k, m));
    k = m;
  }
  let t = k;
  while (t < n && isSpace(src[t])) t++;
  let title = null;
  if (t < n && (src[t] === '"' || src[t] === "'" || src[t] === '(')) {
    const q = src[t];
    if (q === '(') {
      const e = src.indexOf(')', t + 1);
      if (e === -1) return null;
      title = unescapeStr(src.slice(t + 1, e));
      t = e + 1;
    } else {
      let m = t + 1;
      while (m < n && src[m] !== q) {
        if (src[m] === '\\' && m + 1 < n && isAsciiPunct(src[m + 1])) m += 2;
        else m++;
      }
      if (m >= n) return null;
      title = unescapeStr(src.slice(t + 1, m));
      t = m + 1;
    }
    while (t < n && isSpace(src[t])) t++;
    if (t >= n || src[t] !== ')') return null;
    t++;
  } else {
    if (t >= n || src[t] !== ')') return null;
    t++;
  }
  const cleaned = cleanUrl(dest);
  if (cleaned === null) return null;
  return { href: escHref(cleaned), title: title === null ? null : escText(title), end: t };
}

// Label normalization: collapse whitespace (including newlines) to a
// single space, trim, and Unicode case-fold. Backslash escapes are NOT
// processed (a label 'foo\!' does not match a definition '[foo!]').
// Case folding covers ß/ẞ -> ss and final sigma ς -> σ.
function normalizeLabel(s) {
  let out = '';
  let pending = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (isSpace(ch)) { pending = true; continue; }
    if (pending && out.length > 0) out += ' ';
    pending = false;
    out += ch;
  }
  return out.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Attempt a link (or image when isImage) whose '[' is at src[i].
// Returns { end, atom } or null. The atom is a link node, an image node,
// or (for images) an image node whose alt is plain text of the link text.
function tryLink(src, i, defs, isImage) {
  const n = src.length;
  const close = findClosingBracket(src, i);
  if (close === -1) return null;
  const rawText = src.slice(i + 1, close);
  const j = close + 1;
  let href = null;
  let title = null;
  let end = -1;
  const fromDef = (def) => {
    if (!def) return null;
    const cleaned = cleanUrl(def.dest);
    if (cleaned === null) return null;
    return { href: escHref(cleaned), title: def.title === null ? null : escText(def.title) };
  };
  if (j < n && src[j] === '(') {
    const res = parseInlineDest(src, j, n);
    if (res) {
      href = res.href;
      title = res.title;
      end = res.end;
    } else {
      // A malformed inline destination falls back to the shortcut
      // reference using the link text as the label.
      const d = fromDef(defs.get(normalizeLabel(rawText)));
      if (!d) return null;
      href = d.href;
      title = d.title;
      end = j;
    }
  } else if (j < n && src[j] === '[') {
    const labelEnd = findLabelEnd(src, j);
    if (labelEnd === -1) return null;
    const label = labelEnd === j + 1 ? normalizeLabel(rawText)
      : normalizeLabel(src.slice(j + 1, labelEnd));
    const d = fromDef(defs.get(label));
    if (!d) return null;
    href = d.href;
    title = d.title;
    end = labelEnd + 1;
  } else {
    const d = fromDef(defs.get(normalizeLabel(rawText)));
    if (!d) return null;
    href = d.href;
    title = d.title;
    end = j;
  }
  const inner = parseInline(rawText, defs, { noGfm: true });
  // An explicit link inside link text rejects the outer link; images
  // are exempt (links in an image's text become plain alt text), and an
  // autolink inside link text does not reject it.
  if (!isImage && inner.hasExplicitLink) return null;
  if (isImage) {
    return { end, atom: { k: 'i', src: href, title, alt: plainOf(inner.atoms) } };
  }
  return { end, atom: { k: 'l', href, title, ch: inner.atoms } };
}

// Parse an inline HTML tag starting at src[i] === '<'.
// Returns the end index (exclusive) or -1.
function parseInlineTag(src, i, n) {
  if (i + 1 >= n) return -1;
  const c = src[i + 1];
  if (c === '!') {
    if (src.startsWith('<!--', i)) {
      // <!--> and <!---> are complete comments on their own. Otherwise
      // a comment is <!-- ... --> up to the first -->; the content may
      // contain -- or end with -, but it must not start with '>' or
      // '->' (those are the complete forms above).
      if (src.startsWith('<!-->', i)) return i + 5;
      if (src.startsWith('<!--->', i)) return i + 6;
      const end = src.indexOf('-->', i + 4);
      if (end === -1) return -1;
      return end + 3;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1) return -1;
      return end + 3;
    }
    if (isLetter(src[i + 2])) {
      const end = src.indexOf('>', i + 2);
      if (end === -1) return -1;
      return end + 1;
    }
    return -1;
  }
  if (c === '?') {
    const end = src.indexOf('?>', i + 2);
    if (end === -1) return -1;
    return end + 2;
  }
  if (c === '/') {
    let j = i + 2;
    if (j >= n || !isLetter(src[j])) return -1;
    while (j < n && (isAlnum(src[j]) || src[j] === '-')) j++;
    while (j < n && isSpace(src[j])) j++;
    if (j < n && src[j] === '>') return j + 1;
    return -1;
  }
  if (isLetter(c)) {
    let j = i + 1;
    while (j < n && (isAlnum(src[j]) || src[j] === '-')) j++;
    for (;;) {
      if (j >= n) return -1;
      const ch = src[j];
      if (ch === '>') return j + 1;
      if (ch === '/' && j + 1 < n && src[j + 1] === '>') return j + 2;
      // An attribute must be preceded by whitespace (a tag name followed
      // directly by ':' or a letter is not a tag, and an attribute value
      // followed directly by another attribute is invalid).
      if (!isSpace(ch)) return -1;
      let k = j;
      while (k < n && isSpace(src[k])) k++;
      if (k >= n) return -1;
      if (src[k] === '>') return k + 1;
      if (src[k] === '/' && k + 1 < n && src[k + 1] === '>') return k + 2;
      if (!(isLetter(src[k]) || src[k] === '_' || src[k] === ':')) return -1;
      j = k;
      while (j < n && (isAlnum(src[j]) || src[j] === '_' || src[j] === '.' || src[j] === ':' || src[j] === '-')) j++;
      const nameEnd = j;
      let m = j;
      while (m < n && isSpace(src[m])) m++;
      if (m < n && src[m] === '=') {
        m++;
        while (m < n && isSpace(src[m])) m++;
        if (m >= n) return -1;
        if (src[m] === '"') {
          m++;
          while (m < n && src[m] !== '"') m++;
          if (m >= n) return -1;
          m++;
        } else if (src[m] === "'") {
          m++;
          while (m < n && src[m] !== "'") m++;
          if (m >= n) return -1;
          m++;
        } else {
          if (isSpace(src[m]) || src[m] === '"' || src[m] === "'" || src[m] === '=' || src[m] === '<' || src[m] === '>' || src[m] === '`') return -1;
          while (m < n && !isSpace(src[m]) && src[m] !== '"' && src[m] !== "'" && src[m] !== '=' && src[m] !== '<' && src[m] !== '>' && src[m] !== '`') m++;
        }
        j = m;
      } else {
        // A valueless attribute: resume just past its name so the loop
        // top can skip the whitespace and find the next attribute.
        j = nameEnd;
      }
    }
  }
  return -1;
}

// Try a <...> CommonMark autolink or inline HTML tag at src[i] === '<'.
// Returns { end, atom } or null.
function tryAngle(src, i, n) {
  let j = i + 1;
  while (j < n && src[j] !== '>' && src[j] !== '<' && !isSpace(src[j])) j++;
  if (j < n && src[j] === '>') {
    const content = src.slice(i + 1, j);
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):(.+)$/.exec(content);
    if (m) {
      const href = cleanUrl(content);
      if (href !== null) {
        return { end: j + 1, atom: { k: 'l', href: escHref(href), title: null, ch: [{ k: 0, s: content }] } };
      }
    } else if (isCommonMarkEmail(content)) {
      const href = cleanUrl('mailto:' + content);
      if (href !== null) {
        return { end: j + 1, atom: { k: 'l', href: escHref(href), title: null, ch: [{ k: 0, s: content }] } };
      }
    }
  }
  const tagEnd = parseInlineTag(src, i, n);
  if (tagEnd !== -1) return { end: tagEnd, atom: { k: 1, s: src.slice(i, tagEnd), p: src.slice(i, tagEnd) } };
  return null;
}

// Trim a GFM autolink candidate: unmatched '(' truncation, ';' entity
// rule, paren balancing, trailing punctuation.
function trimAutolink(c) {
  const openStack = [];
  for (let k = 0; k < c.length; k++) {
    if (c[k] === '(') openStack.push(k);
    else if (c[k] === ')') { if (openStack.length) openStack.pop(); }
  }
  if (openStack.length) c = c.slice(0, openStack[0]);
  if (c.charCodeAt(c.length - 1) === 59) {
    const amp = c.lastIndexOf('&');
    if (amp !== -1) {
      const ent = c.slice(amp + 1, c.length - 1);
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(ent)) c = c.slice(0, amp);
      else c = c.slice(0, -1);
    } else {
      c = c.slice(0, -1);
    }
  }
  // Paren balancing and trailing punctuation, repeated until stable:
  // trimming punctuation can expose a ')' that must go, and trimming
  // a ')' can expose punctuation. Parens are counted only after the
  // last ']' in the candidate: a ']' resets the balance, so a ')' that
  // precedes it does not unbalance a ')' that follows it.
  for (;;) {
    const before = c;
    let opens = 0;
    let closes = 0;
    const segStart = c.lastIndexOf(']') + 1;
    for (let k = segStart; k < c.length; k++) {
      if (c[k] === '(') opens++;
      else if (c[k] === ')') closes++;
    }
    while (c.length && c.charCodeAt(c.length - 1) === 41 && closes > opens) { c = c.slice(0, -1); closes--; }
    while (c.endsWith('))')) { c = c.slice(0, -1); closes--; }
    while (c.length) {
      const last = c.charCodeAt(c.length - 1);
      if (last === 63 || last === 33 || last === 46 || last === 44 || last === 58 || last === 59 ||
          last === 42 || last === 95 || last === 126 || last === 39 || last === 34) c = c.slice(0, -1);
      else break;
    }
    if (c === before) break;
  }
  return c;
}

function bufEndsWithCI(buf, word) {
  if (buf.length < word.length) return false;
  const off = buf.length - word.length;
  for (let k = 0; k < word.length; k++) {
    if (buf[off + k].toLowerCase() !== word[k]) return false;
  }
  return true;
}

// GFM email at '@' (src[i] === '@'); local part is a suffix of buf.
function tryEmailAt(src, i, n, buf, openU) {
  let s = buf.length;
  while (s > 0 && isEmailLocal(buf[s - 1])) s--;
  if (s === buf.length) return null;
  const domEnd = matchEmailDomain(src, i, n, openU);
  if (domEnd === -1) return null;
  const email = buf.slice(s) + src.slice(i, domEnd);
  const href = cleanUrl('mailto:' + email);
  if (href === null) return null;
  return {
    buf: buf.slice(0, s),
    end: domEnd,
    atom: { k: 'l', href: escHref(href), title: null, ch: [{ k: 0, s: email }] },
  };
}

// GFM scheme autolink at ':' where src[i+1..i+2] === '//'.
function trySchemeAt(src, i, n, buf) {
  let schemeLen = 0;
  if (bufEndsWithCI(buf, 'https')) schemeLen = 5;
  else if (bufEndsWithCI(buf, 'http')) schemeLen = 4;
  else if (bufEndsWithCI(buf, 'ftp')) schemeLen = 3;
  else return null;
  const start = i - schemeLen;
  let j = start;
  while (j < n && !isSpace(src[j]) && src[j] !== '<') j++;
  let cand = trimAutolink(src.slice(start, j));
  if (!cand || cand.length <= schemeLen + 3) return null;
  const href = cleanUrl(cand);
  if (href === null) return null;
  return {
    buf: buf.slice(0, buf.length - schemeLen),
    end: start + cand.length,
    atom: { k: 'l', href: escHref(href), title: null, ch: [{ k: 0, s: cand }] },
  };
}

// GFM www. autolink at src[i] ('www.' starts here).
function tryWwwAt(src, i, n) {
  if (i > 0) {
    const p = src[i - 1];
    if (!(isSpace(p) || p === '*' || p === '_' || p === '~' || p === '(')) return null;
  }
  let j = i;
  while (j < n && !isSpace(src[j]) && src[j] !== '<') j++;
  let cand = src.slice(i, j);
  if (cand.length < 5 || cand[4] === undefined || !isAlnum(cand[4]) && cand[4] !== '-') return null;
  if (!/^www\./.test(cand)) return null;
  cand = trimAutolink(cand);
  if (!cand || cand.length <= 4) return null;
  const href = cleanUrl('http://' + cand);
  if (href === null) return null;
  return { end: i + cand.length, atom: { k: 'l', href: escHref(href), title: null, ch: [{ k: 0, s: cand }] } };
}

// mailto: autolink at src[i] ('mailto:' starts here, lowercase).
function tryMailtoAt(src, i, n, openU) {
  let j = i + 7;
  const ls = j;
  while (j < n && isEmailLocal(src[j])) j++;
  if (j === ls || j >= n || src[j] !== '@') return null;
  const domEnd = matchEmailDomain(src, j, n, openU);
  if (domEnd === -1) return null;
  const email = src.slice(i, domEnd);
  const href = cleanUrl(email);
  if (href === null) return null;
  return { end: domEnd, atom: { k: 'l', href: escHref(href), title: null, ch: [{ k: 0, s: email }] } };
}

// xmpp: autolink at src[i] ('xmpp:' starts here, lowercase only).
// The address is xmpp: + email + an optional single path segment.
function tryXmppAt(src, i, n, openU) {
  let j = i + 5;
  const ls = j;
  while (j < n && isEmailLocal(src[j])) j++;
  if (j === ls || j >= n || src[j] !== '@') return null;
  const domEnd = matchEmailDomain(src, j, n, openU);
  if (domEnd === -1) return null;
  let end = domEnd;
  if (end < n && src[end] === '/') {
    let k = end + 1;
    while (k < n && !isSpace(src[k]) && src[k] !== '<' && src[k] !== '/') k++;
    if (k > end + 1) end = k;
  }
  const cand = trimAutolink(src.slice(i, end));
  if (!cand || cand.length <= 5 || cand.indexOf('@') === -1) return null;
  const href = cleanUrl(cand);
  if (href === null) return null;
  return { end: i + cand.length, atom: { k: 'l', href: escHref(href), title: null, ch: [{ k: 0, s: cand }] } };
}

// Flanking for a delimiter run: prev/next are the adjacent source chars
// ('' at a boundary, treated as whitespace). Returns [canOpen, canClose].
function flanking(ch, prev, next) {
  const prevWS = prev === '' || isWSChar(prev);
  const nextWS = next === '' || isWSChar(next);
  const prevPunct = prev !== '' && isPunct(prev);
  const nextPunct = next !== '' && isPunct(next);
  const left = !nextWS && (!nextPunct || prevWS || prevPunct);
  const right = !prevWS && (!prevPunct || nextWS || nextPunct);
  if (ch === '_') return [left && (!right || prevPunct), right && (!left || nextPunct)];
  return [left, right];
}

function isPlainCode(c) {
  return c !== 96 && c !== 42 && c !== 95 && c !== 126 && c !== 91 && c !== 60 &&
    c !== 92 && c !== 10 && c !== 33 && c !== 64 && c !== 58 && c !== 119 && c !== 109 && c !== 120;
}

// Rule of 3: skip this opener when either side can both open and close and
// the length sum is divisible by 3 without both lengths being divisible.
function ruleOf3(opener, closer) {
  if (!((opener.o && opener.cl) || (closer.o && closer.cl))) return false;
  if ((opener.n + closer.n) % 3 !== 0) return false;
  if (opener.n % 3 === 0 && closer.n % 3 === 0) return false;
  return true;
}

function findOpener(atoms, closerIdx) {
  const closer = atoms[closerIdx];
  let seenNode = false;
  let passedDelim = false;
  let blockNode = null;
  let fallback = -1;
  for (let k = closerIdx - 1; k >= 0; k--) {
    const o = atoms[k];
    if (o.k === 'e') {
      seenNode = true;
      // The nearest emphasis node of the same character, whose opener
      // was a pure opener and which runs straight into following word
      // text, blocks an opener beyond it whose match would use a
      // different number of delimiters than the node itself used.
      // (A delimiter between the node and the closer breaks the block.)
      if (!blockNode && !passedDelim && o.c === closer.c && o.oc === false) {
        const nx = atoms[k + 1];
        if (nx && nx.k === 0 && nx.s.length && isAlnum(nx.s[0])) blockNode = o;
      }
      continue;
    }
    if (o.k !== 'd') continue;
    if (o.c === closer.c) passedDelim = true;
    if (o.c !== closer.c || !o.o) continue;
    // Strikethrough matches exact lengths only (1 with 1, 2 with 2).
    if (closer.c === '~') {
      if (o.n !== closer.n || o.n > 2) continue;
      return k;
    }
    if (o.n > closer.n && o.cl) continue;
    // A single closer cannot take one delimiter from a longer opener
    // once an emphasis node already sits between them: the opener is
    // reserved for a later closer of its own length (a strong).
    if (o.n > closer.n && seenNode) continue;
    if (ruleOf3(o, closer)) continue;
    // A recorded blocking node vetoes an opener whose match would use
    // a different delimiter count than the node used — unless the
    // closer carries more delimiters than the opener (a spare), which
    // breaks the block.
    if (blockNode && closer.n <= o.n) {
      const use = Math.min(o.n, closer.n, 2);
      if (use !== blockNode.dl) continue;
    }
    // Prefer an opener that lets the closer use all its delimiters
    // (a strong over an em); a shorter opener is only a fallback.
    if (o.n >= closer.n) return k;
    if (fallback === -1) fallback = k;
  }
  return fallback;
}

// Single left-to-right pass over closers. Each closer matches the
// nearest qualifying opener and consumes min(opener, closer, 2)
// delimiters (1 = em, 2 = strong). Processing closers in order resolves
// inner pairs before outer ones, so no second pass or recursion is needed.
function resolveEmphasis(atoms) {
  let idx = 0;
  while (idx < atoms.length) {
    const a = atoms[idx];
    if (a.k !== 'd' || !a.cl) { idx++; continue; }
    const oi = findOpener(atoms, idx);
    if (oi === -1) { idx++; continue; }
    const opener = atoms[oi];
    const use = a.c === '~' ? opener.n : Math.min(opener.n, a.n, 2);
    const tag = a.c === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const node = { k: 'e', tag, ch: atoms.slice(oi + 1, idx), c: a.c, dl: use, oc: opener.cl };
    const repl = [];
    if (opener.n > use) repl.push({ k: 'd', c: opener.c, n: opener.n - use, o: opener.o, cl: opener.cl });
    const nodeIdx = oi + repl.length;
    repl.push(node);
    if (a.n > use) repl.push({ k: 'd', c: a.c, n: a.n - use, o: a.o, cl: a.cl });
    atoms.splice(oi, idx - oi + 1, ...repl);
    idx = nodeIdx + 1;
  }
}

function renderAtoms(atoms) {
  let out = '';
  for (const a of atoms) {
    if (a.k === 0) out += escText(a.s);
    else if (a.k === 1) out += a.s;
    else if (a.k === 2) out += ESC[a.s] || a.s;
    else if (a.k === 'd') out += a.c.repeat(a.n);
    else if (a.k === 'b') out += '<br>';
    else if (a.k === 'e') out += '<' + a.tag + '>' + renderAtoms(a.ch) + '</' + a.tag + '>';
    else if (a.k === 'l') {
      out += '<a href="' + a.href + '"';
      if (a.title) out += ' title="' + a.title + '"';
      out += '>' + renderAtoms(a.ch) + '</a>';
    } else if (a.k === 'i') {
      out += '<img src="' + a.src + '" alt="' + escText(a.alt) + '"';
      if (a.title) out += ' title="' + a.title + '"';
      out += '>';
    }
  }
  return out;
}

// Plain-text rendering of resolved atoms (for image alt text).
function plainOf(atoms) {
  let out = '';
  for (const a of atoms) {
    if (a.k === 0) out += a.s;
    else if (a.k === 1) out += a.p;
    else if (a.k === 2) out += a.s;
    else if (a.k === 'd') out += a.c.repeat(a.n);
    else if (a.k === 'b') out += '\n';
    else if (a.k === 'e') out += plainOf(a.ch);
    else if (a.k === 'l') out += plainOf(a.ch);
    else if (a.k === 'i') out += a.alt;
  }
  return out;
}

// Parse inline content into atoms, resolve emphasis, render to HTML.
// Returns { atoms, html, hasLink, hasExplicitLink } where hasLink is true
// when a link (not an image) occurs anywhere in the content, excluding
// links inside images, and hasExplicitLink is true only for a link made
// by [...] syntax (an autolink inside link text does not block the
// outer link).
// True when a ')' closes the paren group opened at src[j] === '('
// (the destination/title inside may be malformed; only the closing
// ')' matters). Paren depth is tracked, and a ')' inside an angle
// destination cannot close the group.
function inlineParenCloses(src, j, n) {
  let depth = 1;
  let k = j + 1;
  while (k < n) {
    const ch = src[k];
    if (ch === '\\' && k + 1 < n && isAsciiPunct(src[k + 1])) { k += 2; continue; }
    if (ch === '<') {
      // An angle destination: skip to its '>' so a ')' inside it
      // cannot close the paren. With no '>' the '<...>' never
      // terminates, so keep scanning (a later ')' closes the paren).
      let m = k + 1;
      while (m < n && src[m] !== '>' && src[m] !== '\n') {
        if (src[m] === '<') break;
        if (src[m] === '\\' && m + 1 < n && isAsciiPunct(src[m + 1])) m += 2;
        else m++;
      }
      if (m < n && src[m] === '>') { k = m + 1; continue; }
    }
    if (ch === '\n') {
      let m = k + 1;
      while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
      if (m < n && src[m] === '\n') return false;
      k++;
      continue;
    }
    if (ch === '(') { depth++; k++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) return true;
      k++;
      continue;
    }
    k++;
  }
  return false;
}

// Returns the index of ']' when src has a [...](...) shape at i whose
// link does not form because the destination is malformed or the link
// text fails the backtick rule; otherwise -1. A failure caused by an
// explicit link inside the text does not count (its emphasis still
// renders), and neither does a group whose '(' is never closed.
function failedInlineLinkClose(src, i) {
  const n = src.length;
  const close = findClosingBracket(src, i);
  if (close !== -1) {
    if (close + 1 >= n || src[close + 1] !== '(') return -1;
    if (!inlineParenCloses(src, close + 1, n)) return -1;
    // A good destination means the failure is an inner explicit link.
    if (parseInlineDest(src, close + 1, n)) return -1;
    return close;
  }
  // findClosingBracket failed: maybe the backtick rule rejected the ']'.
  // Scan leniently for a ']' followed by '(': code spans are skipped
  // (a ']' inside one is not a closing bracket), but a malformed
  // backtick run is ordinary text, so scanning continues past it.
  let depth = 0;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < n && isAsciiPunct(src[j + 1])) { j += 2; continue; }
    if (ch === '`') {
      let run = 0;
      while (j + run < n && src[j + run] === '`') run++;
      let k = j + run;
      while (k < n && src[k] !== '`') {
        if (src[k] === '\n') {
          let m2 = k + 1;
          while (m2 < n && (src[m2] === ' ' || src[m2] === '\t')) m2++;
          if (m2 < n && src[m2] === '\n') return -1;
        }
        k++;
      }
      if (k < n) {
        let run2 = 0;
        while (k + run2 < n && src[k + run2] === '`') run2++;
        j = k + run2;
        continue;
      }
      // No later backtick run. A run of 2+ backticks immediately
      // before ']' is consumed, so that ']' is the closing bracket.
      if (run >= 2 && j + run < n && src[j + run] === ']') {
        if (j + run + 1 < n && src[j + run + 1] === '(' && inlineParenCloses(src, j + run + 1, n)) return j + run;
        return -1;
      }
      j++;
      continue;
    }
    if (ch === '\n') {
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n && src[k] === '\n') return -1;
      j++;
      continue;
    }
    if (ch === '[') { depth++; j++; continue; }
    if (ch === ']') {
      if (depth === 0) {
        if (j + 1 < n && src[j + 1] === '(' && inlineParenCloses(src, j + 1, n)) return j;
        return -1;
      }
      depth--;
      j++;
      continue;
    }
    if (ch === '<') {
      const ae = autolinkEnd(src, j, n);
      if (ae !== -1) { j = ae; continue; }
      const te = parseInlineTag(src, j, n);
      if (te !== -1) { j = te; continue; }
    }
    j++;
  }
  return -1;
}

function parseInline(src, defs, opts) {
  const noGfm = !!(opts && opts.noGfm);
  const noEmphasis = !!(opts && opts.noEmphasis);
  const n = src.length;
  const atoms = [];
  let buf = '';
  let hasLink = false;
  let hasExplicitLink = false;
  let i = 0;
  function flush() { if (buf) { atoms.push({ k: 0, s: buf }); buf = ''; } }
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isPlainCode(c)) {
      let k = i + 1;
      while (k < n && isPlainCode(src.charCodeAt(k))) k++;
      buf += src.slice(i, k);
      i = k;
      continue;
    }
    const ch = src[i];
    if (ch === '`') {
      let run = 0;
      while (i + run < n && src[i + run] === '`') run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (src[j] === '`') {
          let r = 0;
          while (j + r < n && src[j + r] === '`') r++;
          if (r === run) { found = j; break; }
          j += r;
        } else j++;
      }
      if (found === -1) {
        // No run of the same length: the whole run is literal text.
        buf += src.slice(i, i + run);
        i += run;
        continue;
      }
      let content = src.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      atoms.push({ k: 1, s: '<code>' + escCode(content) + '</code>', p: content });
      i = found + run;
    } else if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (i + run < n && src[i + run] === ch) run++;
      if (noEmphasis) { buf += src.slice(i, i + run); i += run; continue; }
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + run < n ? src[i + run] : '';
      const fl = flanking(ch, prev, next);
      if (!fl[0] && !fl[1]) { buf += src.slice(i, i + run); i += run; continue; }
      flush();
      atoms.push({ k: 'd', c: ch, n: run, o: fl[0], cl: fl[1] });
      i += run;
    } else if (ch === '[') {
      const res = tryLink(src, i, defs, false);
      if (res) {
        flush();
        atoms.push(res.atom);
        if (res.atom.k === 'l') { hasLink = true; hasExplicitLink = true; }
        i = res.end;
      } else {
        // A failed [...](...) link (malformed destination, or a link
        // text the backtick rule rejects): emphasis inside the [...]
        // text stays literal, while code spans and autolinks inside
        // are still processed.
        const failClose = failedInlineLinkClose(src, i);
        if (failClose !== -1) {
          const rawText = src.slice(i + 1, failClose);
          flush();
          atoms.push({ k: 0, s: '[' });
          const inner = parseInline(rawText, defs, { noEmphasis: true });
          for (const a of inner.atoms) atoms.push(a);
          if (inner.hasLink) hasLink = true;
          i = failClose;
        } else { buf += '['; i++; }
      }
    } else if (ch === '!') {
      if (i + 1 < n && src[i + 1] === '[') {
        const res = tryLink(src, i + 1, defs, true);
        if (res) { flush(); atoms.push(res.atom); i = res.end; continue; }
      }
      buf += '!';
      i++;
    } else if (ch === '<') {
      const res = tryAngle(src, i, n);
      if (res) {
        flush();
        atoms.push(res.atom);
        if (res.atom.k === 'l') hasLink = true;
        i = res.end;
      } else { buf += '<'; i++; }
    } else if (ch === '\\') {
      if (i + 1 < n && src[i + 1] === '\n') {
        flush();
        atoms.push({ k: 'b' });
        i += 2;
        // A hard break swallows the next line's leading whitespace.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      }
      else if (i + 1 < n && isAsciiPunct(src[i + 1])) {
        // Every escaped character is its own atom, so it can never
        // start (or continue) a GFM autolink: the buffer scan-back
        // stops at the atom boundary.
        flush();
        atoms.push({ k: 2, s: src[i + 1] });
        i += 2;
      }
      else { buf += '\\'; i++; }
    } else if (ch === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        atoms.push({ k: 'b' });
        i++;
        // A hard break swallows the next line's leading whitespace.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      buf += '\n';
      i++;
    } else if (ch === '@') {
      if (!noGfm) {
        const res = tryEmailAt(src, i, n, buf, hasOpenUnderscore(atoms));
        if (res) {
          buf = res.buf;
          flush();
          atoms.push(res.atom);
          hasLink = true;
          i = res.end;
          continue;
        }
      }
      buf += '@'; i++;
    } else if (ch === ':') {
      if (!noGfm && i + 2 < n && src[i + 1] === '/' && src[i + 2] === '/') {
        const res = trySchemeAt(src, i, n, buf);
        if (res) {
          buf = res.buf;
          flush();
          atoms.push(res.atom);
          hasLink = true;
          i = res.end;
          continue;
        }
      }
      buf += ':';
      i++;
    } else if (ch === 'w') {
      if (!noGfm && src.startsWith('www.', i)) {
        const res = tryWwwAt(src, i, n);
        if (res) {
          flush();
          atoms.push(res.atom);
          hasLink = true;
          i = res.end;
          continue;
        }
      }
      buf += 'w';
      i++;
    } else if (ch === 'm') {
      if (!noGfm && src.startsWith('mailto:', i)) {
        const res = tryMailtoAt(src, i, n, hasOpenUnderscore(atoms));
        if (res) {
          flush();
          atoms.push(res.atom);
          hasLink = true;
          i = res.end;
          continue;
        }
      }
      buf += 'm';
      i++;
    } else if (ch === 'x') {
      // xmpp: only starts an autolink when not preceded by a letter or
      // digit (unlike mailto:, which fires mid-word).
      if (!noGfm && src.startsWith('xmpp:', i) && !(i > 0 && isAlnum(src[i - 1]))) {
        const res = tryXmppAt(src, i, n, hasOpenUnderscore(atoms));
        if (res) {
          flush();
          atoms.push(res.atom);
          hasLink = true;
          i = res.end;
          continue;
        }
      }
      buf += 'x';
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  if (!noEmphasis) resolveEmphasis(atoms);
  return { atoms, html: renderAtoms(atoms), hasLink, hasExplicitLink };
}

// ---------- block parsing ----------

// Column of char index idx in a line (a tab advances to the next multiple of 4).
function colOf(line, idx) {
  let col = 0;
  for (let k = 0; k < idx && k < line.length; k++) col += line[k] === '\t' ? 4 - (col % 4) : 1;
  return col;
}
function leadCols(line) {
  let col = 0;
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
  }
  return col;
}

// Remove up to n leading whitespace characters (spaces and tabs, each
// counting as one character) — the fenced-code dedent: a leading tab is
// consumed whole by the fence indent, never expanded to spaces.
function stripChars(line, n) {
  let k = 0;
  while (k < n && k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}

// Remove n columns of leading whitespace (code-content form: a tab that
// straddles the cut becomes spaces for its remainder; a tab entirely past
// the cut stays raw).
function stripCols(line, n) {  let col = 0;
  let k = 0;
  while (k < line.length) {
    const ch = line[k];
    if (ch !== ' ' && ch !== '\t') break;
    if (col >= n) break;
    if (ch === ' ') { col++; k++; }
    else {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; k++; }
      else return ' '.repeat(col + w - n) + line.slice(k + 1);
    }
  }
  return line.slice(k);
}

// Content of a line after a container marker: the substring starting at
// char index `from` (whose column is `fromCol`), with `extra` further
// columns removed. Leading tabs are expanded to spaces using their
// original columns, so the result's leading whitespace is spaces.
function extractAfter(line, from, fromCol, extra) {
  const sub = line.slice(from);
  let col = fromCol;
  let k = 0;
  let out = '';
  while (k < sub.length && (sub[k] === ' ' || sub[k] === '\t')) {
    if (sub[k] === ' ') { out += ' '; col++; k++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; k++; }
  }
  if (extra >= out.length) return sub.slice(k);
  return out.slice(extra) + sub.slice(k);
}

// The content of a blockquote line, or null when the line has no '>' marker
// within 3 columns of indent.
function matchQuoteMarker(line) {
  let col = 0;
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return null;
  }
  if (k >= line.length || line[k] !== '>') return null;
  const afterCol = col + 1;
  const from = k + 1;
  let extra = 0;
  if (from < line.length && (line[from] === ' ' || line[from] === '\t')) extra = 1;
  return extractAfter(line, from, afterCol, extra);
}

// Parse a list marker at the start of a line (indent <= 3). Returns null
// when the line does not start a list item.
function parseListMarker(line) {
  let col = 0;
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return null;
  }
  if (k >= line.length) return null;
  const ch = line[k];
  let type;
  let bullet = '';
  let delim = '';
  let start = 1;
  let markerCols;
  if (ch === '-' || ch === '+' || ch === '*') {
    type = 'bullet';
    bullet = ch;
    markerCols = col + 1;
    k++;
  } else if (isDigit(ch)) {
    let d = k;
    while (d < line.length && isDigit(line[d])) d++;
    if (d - k > 9) return null;
    if (d >= line.length || (line[d] !== '.' && line[d] !== ')')) return null;
    type = 'ordered';
    delim = line[d];
    start = parseInt(line.slice(k, d), 10);
    markerCols = col + (d - k) + 1;
    k = d + 1;
  } else return null;
  const from = k;
  const fromCol = markerCols;
  let wcol = fromCol;
  let w = k;
  while (w < line.length && (line[w] === ' ' || line[w] === '\t')) {
    wcol += line[w] === '\t' ? 4 - (wcol % 4) : 1;
    w++;
  }
  const wsCols = wcol - fromCol;
  if (w >= line.length) {
    return { type, bullet, delim, start, markerCols, contentIndent: markerCols + 1, content: '', empty: true };
  }
  if (wsCols === 0) return null;
  const contentIndent = wsCols >= 5 ? markerCols + 1 : markerCols + wsCols;
  const content = extractAfter(line, from, fromCol, contentIndent - fromCol);
  return { type, bullet, delim, start, markerCols, contentIndent, content, empty: false };
}

// Skip spaces/tabs and single newlines while parsing a definition, never
// crossing a blank line. Returns the new position.
function skipDefWs(s, p) {
  let q = p;
  for (;;) {
    while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    if (q < s.length && s[q] === '\n') {
      let k = q + 1;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= s.length || s[k] === '\n') return q;
      q = k;
      continue;
    }
    return q;
  }
}

// Try to parse a link reference definition starting at lines[i].
// Returns { label, dest, title, next } or null.
function tryDef(lines, i, end) {
  const first = lines[i];
  let col = 0;
  let k = 0;
  while (k < first.length && (first[k] === ' ' || first[k] === '\t')) {
    col += first[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return null;
  }
  if (k >= first.length || first[k] !== '[') return null;
  // Join the lines up to the next blank line: a definition's title may
  // span several lines, but it never crosses a blank line.
  let joined = first;
  let avail = 1;
  while (i + avail < end && !isBlankLine(lines[i + avail])) {
    joined += '\n' + lines[i + avail];
    avail++;
  }
  // The label is scanned to the FIRST unescaped ']' (labels cannot
  // contain nested brackets).
  const close = findLabelEnd(joined, k);
  if (close === -1) return null;
  const label = normalizeLabel(joined.slice(k + 1, close));
  if (!label) return null;
  let p = close + 1;
  if (p >= joined.length || joined[p] !== ':') return null;
  p++;
  p = skipDefWs(joined, p);
  if (p >= joined.length) return null;
  const lineOf = (pos) => { let l = 0; for (let t = 0; t < pos; t++) if (joined[t] === '\n') l++; return l; };
  let dest;
  if (joined[p] === '<') {
    let m = p + 1;
    while (m < joined.length && joined[m] !== '>' && joined[m] !== '\n') {
      if (joined[m] === '<') return null;
      if (joined[m] === '\\' && m + 1 < joined.length && isAsciiPunct(joined[m + 1])) m += 2;
      else m++;
    }
    if (m >= joined.length || joined[m] !== '>') return null;
    dest = unescapeStr(joined.slice(p + 1, m));
    p = m + 1;
  } else {
    let depth = 0;
    let m = p;
    while (m < joined.length) {
      const ch = joined[m];
      if (ch === '(') { depth++; m++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        m++;
        continue;
      }
      if (isSpace(ch) || ch.charCodeAt(0) < 32) break;
      if (ch === '\\' && m + 1 < joined.length && isAsciiPunct(joined[m + 1])) { m += 2; continue; }
      m++;
    }
    if (depth > 0 || m === p) return null;
    dest = unescapeStr(joined.slice(p, m));
    p = m;
  }
  const destEndLine = lineOf(p);
  // A title may follow, separated from the destination by whitespace.
  // A title on the same line as the destination must be followed by
  // nothing but whitespace (junk invalidates the whole definition); a
  // title on a later line is optional (junk leaves a destination-only
  // definition, and the title line stays a paragraph).
  let title = null;
  let titleEnd = p;
  const q = skipDefWs(joined, p);
  if (q > p && q < joined.length && (joined[q] === '"' || joined[q] === "'" || joined[q] === '(')) {
    const qc = joined[q];
    let tEnd = -1;
    let tVal = null;
    if (qc === '(') {
      const e = joined.indexOf(')', q + 1);
      if (e !== -1) { tVal = unescapeStr(joined.slice(q + 1, e)); tEnd = e + 1; }
    } else {
      let m = q + 1;
      while (m < joined.length && joined[m] !== qc) {
        if (joined[m] === '\\' && m + 1 < joined.length && isAsciiPunct(joined[m + 1])) m += 2;
        else m++;
      }
      if (m < joined.length) { tVal = unescapeStr(joined.slice(q + 1, m)); tEnd = m + 1; }
    }
    if (tEnd !== -1) {
      let r = tEnd;
      while (r < joined.length && (joined[r] === ' ' || joined[r] === '\t')) r++;
      if (r >= joined.length || joined[r] === '\n') {
        title = tVal;
        titleEnd = tEnd;
      } else if (lineOf(q) === destEndLine) {
        return null;
      }
    } else if (lineOf(q) === destEndLine) {
      return null;
    }
  }
  const endPos = title === null ? p : titleEnd;
  let r = endPos;
  while (r < joined.length && (joined[r] === ' ' || joined[r] === '\t')) r++;
  if (r < joined.length && joined[r] !== '\n') return null;
  let linesUsed = 1;
  for (let t = 0; t < r; t++) if (joined[t] === '\n') linesUsed++;
  return { label, dest, title, next: i + linesUsed };
}

// Split a table row line into trimmed cells (escape-aware '|').
function splitTableRow(line) {
  let s = line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    // An escaped pipe is a literal pipe in the cell (the escape is
    // processed here, before inline parsing, so `\|` inside a code span
    // still renders as '|').
    if (ch === '\\' && k + 1 < s.length && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Parse a table delimiter row. Returns an array of alignments
// ('left' | 'center' | 'right' | null) or null when not a delimiter row.
function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) aligns.push('center');
    else if (cell.startsWith(':')) aligns.push('left');
    else if (cell.endsWith(':')) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// Setext underline: 1 for '=' (h1), 2 for '-' (h2), 0 otherwise.
function isSetext(line) {
  let k = 0;
  let col = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return 0;
  }
  if (k >= line.length) return 0;
  const ch = line[k];
  if (ch !== '=' && ch !== '-') return 0;
  let j = k;
  while (j < line.length && line[j] === ch) j++;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j !== line.length) return 0;
  return ch === '=' ? 1 : 2;
}

function isATX(line) {
  let k = 0;
  let col = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return 0;
  }
  let hashes = 0;
  while (k < line.length && line[k] === '#') { hashes++; k++; }
  if (hashes === 0 || hashes > 6) return 0;
  if (k >= line.length) return hashes;
  if (line[k] === ' ' || line[k] === '\t') return hashes;
  return 0;
}

function parseATXText(line, level) {
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  k += level;
  let raw = line.slice(k);
  raw = raw.replace(/[ \t]+$/, '');
  raw = raw.replace(/[ \t]+#+$/, '');
  raw = raw.replace(/^[ \t]+/, '');
  return raw;
}

function isHR(line) {
  let k = 0;
  let col = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return false;
  }
  if (k >= line.length) return false;
  const ch = line[k];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let count = 0;
  while (k < line.length) {
    if (line[k] === ch) { count++; k++; }
    else if (line[k] === ' ' || line[k] === '\t') k++;
    else return false;
  }
  return count >= 3;
}

function parseFence(line) {
  let k = 0;
  let col = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return null;
  }
  if (k >= line.length) return null;
  const ch = line[k];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (k + len < line.length && line[k + len] === ch) len++;
  if (len < 3) return null;
  const info = line.slice(k + len);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, indent: col, info };
}

function fenceLang(info) {
  const t = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (!t) return null;
  const sp = t.search(/[ \t]/);
  // The info string's backslash escapes are processed (ASCII punctuation).
  return unescapeStr(sp === -1 ? t : t.slice(0, sp));
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start type (1-7) or 0. Types 1-6 can interrupt a paragraph;
// type 7 cannot.
function htmlBlockStart(line) {
  let k = 0;
  let col = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return 0;
  }
  if (k >= line.length || line[k] !== '<') return 0;
  const rest = line.slice(k);
  const low = rest.toLowerCase();
  if (/^<(script|pre|style|textarea)([\s>]|$)/.test(low)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![a-zA-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)([\s>]|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
  const tagEnd = parseInlineTag(line, k, line.length);
  if (tagEnd !== -1) {
    let t = tagEnd;
    while (t < line.length && (line[t] === ' ' || line[t] === '\t')) t++;
    if (t === line.length) return 7;
  }
  return 0;
}

// ---- block parsing ----
// A node: {t:'p'|'h'|'code'|'html'|'hr'|'quote'|'list'|'table'}
// state: {defs: Map<label, {dest, title}>} — shared across the whole document.

function listInterrupts(line, inList) {
  const m = parseListMarker(line);
  if (!m || m.empty) return false;
  if (m.type === 'bullet') return true;
  // Inside a list item any ordered marker starts a nested list; at the
  // top level (or in a blockquote) only a marker starting with 1 does.
  return inList ? true : m.start === 1;
}

function htmlInterrupts(line) {
  const hb = htmlBlockStart(line);
  return hb >= 1 && hb <= 6;
}

function parseFenceClose(line, fence) {
  let k = 0, col = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    col += line[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
    if (col > 3) return false;
  }
  if (k >= line.length || line[k] !== fence.ch) return false;
  let len = 0;
  while (k + len < line.length && line[k + len] === fence.ch) len++;
  if (len < fence.len) return false;
  let t = k + len;
  while (t < line.length && (line[t] === ' ' || line[t] === '\t')) t++;
  return t === line.length;
}

function parseFenced(lines, i, end, fence) {
  let j = i + 1;
  let closeIdx = -1;
  while (j < end) {
    if (parseFenceClose(lines[j], fence)) { closeIdx = j; break; }
    j++;
  }
  const contentLines = closeIdx === -1 ? lines.slice(i + 1, end) : lines.slice(i + 1, closeIdx);
  // Blank lines keep their spaces. Only backtick fences dedent content
  // by the fence indent (character-based, so a leading tab is consumed
  // whole); tilde fences keep their content lines verbatim.
  const dedented = fence.ch === '`'
    ? contentLines.map(l => stripChars(l, fence.indent))
    : contentLines;
  let text = dedented.join('\n');
  if (dedented.length) text += '\n';
  // Only a truly empty last line drops the trailing newline (a line
  // holding only spaces is content and keeps it).
  if (dedented.length && dedented[dedented.length - 1] === '') text = text.slice(0, -1);
  return { text, next: closeIdx === -1 ? end : closeIdx + 1 };
}

function parseIndentedCode(lines, i, end) {
  const content = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) { content.push(stripCols(line, 4)); j++; continue; }
    if (leadCols(line) >= 4) { content.push(stripCols(line, 4)); j++; continue; }
    break;
  }
  while (content.length && content[content.length - 1].trim() === '') content.pop();
  return { text: content.length ? content.join('\n') + '\n' : '', next: j };
}

function parseHtmlBlock(lines, i, end, type, term) {
  let j = i;
  if (type === 1) {
    const tag = /<(script|pre|style|textarea)/i.exec(lines[i])[1].toLowerCase();
    const endRe = new RegExp('</' + tag + '\\s*>', 'i');
    while (j < end) {
      if (endRe.test(lines[j])) { j++; break; }
      j++;
    }
  } else if (type === 2) {
    while (j < end) { if (lines[j].indexOf('-->') !== -1) { j++; break; } j++; }
  } else if (type === 3) {
    while (j < end) { if (lines[j].indexOf('?>') !== -1) { j++; break; } j++; }
  } else if (type === 4) {
    while (j < end) { if (lines[j].indexOf('>') !== -1) { j++; break; } j++; }
  } else if (type === 5) {
    while (j < end) { if (lines[j].indexOf(']]>') !== -1) { j++; break; } j++; }
  } else {
    j = i + 1;
    while (j < end && !isBlankLine(lines[j])) j++;
  }
  let text = lines.slice(i, j).join('\n');
  // A trailing newline is added when the block is followed by a
  // non-blank line, or when the source ends with a newline (at the end
  // of the top-level document). Inside a container the source never
  // ends with a newline, so a block at the container's end gets none.
  // Types 1-5 end at a terminator line, so only a truly empty next line
  // suppresses the newline; types 6-7 end at a blank line, so any
  // whitespace-only next line suppresses it.
  const nextBlank = type <= 5 ? (j < end && lines[j] === '') : (j < end && isBlankLine(lines[j]));
  if (!nextBlank && (j < end || term)) text += '\n';
  return { text, next: j };
}

function tableBodyContinues(line) {
  // A line of only 0-3 spaces and a single tab is a (blank) body row,
  // not a blank line: it expands to exactly one indent level.
  if (/^ {0,3}\t$/.test(line)) return true;
  if (isBlankLine(line)) return false;
  if (leadCols(line) >= 4) return false;
  if (isATX(line) || parseFence(line) || isHR(line)) return false;
  if (matchQuoteMarker(line) !== null) return false;
  if (parseListMarker(line) !== null) return false;
  if (htmlInterrupts(line)) return false;
  return true;
}

function tryTable(lines, i, end) {
  if (i + 1 >= end) return null;
  const headerLine = lines[i];
  const delimLine = lines[i + 1];
  if (leadCols(headerLine) > 3 || leadCols(delimLine) > 3) return null;
  if (isSetext(delimLine)) return null;
  const align = parseDelimiterRow(delimLine);
  if (!align) return null;
  const headCells = splitTableRow(headerLine);
  if (headCells.length !== align.length) return null;
  if (headerLine.indexOf('|') === -1 && !/^\s*\|/.test(delimLine)) return null;
  const rows = [];
  let j = i + 2;
  while (j < end && tableBodyContinues(lines[j])) {
    rows.push(splitTableRow(lines[j]));
    j++;
  }
  return { node: { t: 'table', align, head: headCells, rows }, next: j };
}

function parseParagraph(lines, i, end, state, term, inList) {
  const plines = [lines[i]];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // A whitespace-only line that is the last line of a string not
      // terminated by a newline belongs to the paragraph (the trailing
      // space of a blockquote's last line). A truly empty line does not.
      if (j === end - 1 && !term && line !== '') { plines.push(line); j++; continue; }
      break;
    }
    const setext = isSetext(line);
    if (setext) {
      // A setext heading's text has its leading and trailing
      // whitespace stripped.
      const text = plines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      return { node: { t: 'h', level: setext, text }, next: j + 1 };
    }
    if (parseDelimiterRow(line) !== null) {
      if (plines.length >= 2) {
        return { node: { t: 'p', text: plines.slice(0, -1).join('\n') }, next: j - 1 };
      }
    }
    if (isATX(line) || parseFence(line) || isHR(line)) break;
    if (matchQuoteMarker(line) !== null) break;
    if (listInterrupts(line, inList)) break;
    if (htmlInterrupts(line)) break;
    plines.push(line);
    j++;
  }
  return { node: { t: 'p', text: plines.join('\n') }, next: j };
}

function parseBlocks(lines, start, end, state, top, term, inList) {
  const nodes = [];
  let i = start;
  // Record each block's line span so a list can tell whether two of an
  // item's direct blocks are separated by a blank line. The span ends
  // after the block's last non-blank line (trailing blank lines a block
  // consumed are separators, not part of the block).
  const add = (node, next) => {
    let e = next;
    while (e > i && isBlankLine(lines[e - 1])) e--;
    node._s = i;
    node._e = e;
    nodes.push(node);
    i = next;
  };
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const def = tryDef(lines, i, end);
    if (def) {
      if (!state.defs.has(def.label)) state.defs.set(def.label, { dest: def.dest, title: def.title });
      i = def.next;
      continue;
    }
    const atx = isATX(line);
    if (atx) { add({ t: 'h', level: atx, text: parseATXText(line, atx) }, i + 1); continue; }
    const fence = parseFence(line);
    if (fence) {
      const res = parseFenced(lines, i, end, fence);
      add({ t: 'code', lang: fenceLang(fence.info), text: res.text }, res.next);
      continue;
    }
    if (leadCols(line) >= 4) {
      const res = parseIndentedCode(lines, i, end);
      add({ t: 'code', lang: null, text: res.text }, res.next);
      continue;
    }
    if (isHR(line)) { add({ t: 'hr' }, i + 1); continue; }
    if (matchQuoteMarker(line) !== null) {
      const res = parseBlockquote(lines, i, end, state);
      add(res.node, res.next);
      continue;
    }
    const marker = parseListMarker(line);
    if (marker) {
      const res = parseList(lines, i, end, state);
      add(res.node, res.next);
      continue;
    }
    const hb = htmlBlockStart(line);
    if (hb >= 1 && hb <= 7) {
      const res = parseHtmlBlock(lines, i, end, hb, term);
      add({ t: 'html', text: res.text }, res.next);
      continue;
    }
    const table = tryTable(lines, i, end);
    if (table) {
      add(table.node, table.next);
      continue;
    }
    const para = parseParagraph(lines, i, end, state, term, inList);
    add(para.node, para.next);
  }
  return nodes;
}

// ---- blockquote / list ----

function lastBlockIsParagraph(nodes) {
  if (!nodes.length) return false;
  const last = nodes[nodes.length - 1];
  if (last.t === 'p') return true;
  if (last.t === 'quote') return lastBlockIsParagraph(last.ch);
  if (last.t === 'list') {
    const items = last.items;
    if (!items.length) return false;
    return lastBlockIsParagraph(items[items.length - 1].ch);
  }
  return false;
}

function endsWithOpenParagraph(itemLines, state, inList) {
  if (!itemLines.length) return false;
  // A trailing blank line closes the paragraph.
  if (isBlankLine(itemLines[itemLines.length - 1])) return false;
  const inner = parseBlocks(itemLines, 0, itemLines.length, state, false, false, inList);
  return lastBlockIsParagraph(inner);
}

// Like endsWithOpenParagraph, but only the item's own last block counts
// (a paragraph nested inside a list or quote does not make this item's
// continuation a paragraph continuation).
function endsWithOpenParagraphDirect(itemLines, state, inList) {
  if (!itemLines.length) return false;
  if (isBlankLine(itemLines[itemLines.length - 1])) return false;
  const inner = parseBlocks(itemLines, 0, itemLines.length, state, false, false, inList);
  return inner.length > 0 && inner[inner.length - 1].t === 'p';
}

function canContinueParagraph(line, inList) {
  if (isATX(line) || parseFence(line) || isHR(line)) return false;
  if (matchQuoteMarker(line) !== null) return false;
  if (listInterrupts(line, inList)) return false;
  if (htmlInterrupts(line)) return false;
  // A setext underline is a lazy continuation (the caller neutralizes
  // it); an hr is not.
  return true;
}

function parseBlockquote(lines, i, end, state) {
  const qlines = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    const content = matchQuoteMarker(line);
    if (content !== null) { qlines.push(content); j++; continue; }
    if (isBlankLine(line)) break;
    if (endsWithOpenParagraph(qlines, state, false) && canContinueParagraph(line, false)) {
      // A lazy line is merged into the open paragraph (it can never start
      // a new block of its own). It is stripped by 4 columns when
      // indented that far; a setext underline is neutralized with 4
      // spaces so it cannot become a heading.
      let stripped;
      if (isSetext(line) && !isHR(line)) stripped = '    ' + line;
      else if (leadCols(line) >= 4) stripped = stripCols(line, 4);
      else stripped = line;
      qlines[qlines.length - 1] += '\n' + stripped;
      j++;
      continue;
    }
    break;
  }
  const inner = parseBlocks(qlines, 0, qlines.length, state, false, false, false);
  return { node: { t: 'quote', ch: inner }, next: j };
}

function parseList(lines, i, end, state) {
  const first = parseListMarker(lines[i]);
  const listType = first.type;
  const key = listType === 'bullet' ? first.bullet : first.delim;
  const startNum = first.start;
  const items = [];
  let j = i;
  let loose = false;
  while (j < end) {
    // Blank lines between items belong to the list when the next
    // non-blank line is a marker of this list; they loosen it.
    let blanks = 0;
    while (j < end && isBlankLine(lines[j])) { blanks++; j++; }
    if (j >= end) break;
    const line = lines[j];
    if (isHR(line)) break;
    const m = parseListMarker(line);
    if (!m) break;
    if (m.type !== listType) break;
    if (listType === 'bullet' && m.bullet !== key) break;
    if (listType === 'ordered' && m.delim !== key) break;
    if (blanks > 0 && items.length > 0) items[items.length - 1].trailingBlanks += blanks;
    const itemLines = [];
    if (!m.empty) itemLines.push(m.content);
    const contentIndent = m.contentIndent;
    let hasContent = !m.empty;
    // A fenced code block opened inside the item only captures lines
    // that are not indented to the content indent once it has content:
    // a non-indented line right after the opening fence ends the item
    // (the fence is empty), but after one indented content line the
    // fence runs until its closing fence, whatever the indentation.
    let openFence = null;
    let fencePending = null;
    if (!m.empty) { const f0 = parseFence(m.content); if (f0) fencePending = f0; }
    j++;
    while (j < end) {
      const cl = lines[j];
      if (openFence) {
        // Inside a fenced code block with content: every line belongs
        // to the item until the closing fence, regardless of indentation.
        const dl = extractAfter(cl, 0, 0, contentIndent);
        itemLines.push(dl);
        if (parseFenceClose(dl, openFence)) openFence = null;
        hasContent = true;
        j++;
        continue;
      }
      if (isBlankLine(cl)) {
        // A blank line after an empty marker ends the item.
        if (!hasContent) break;
        itemLines.push('');
        // A blank line is fence content: it establishes a pending fence.
        if (fencePending) { openFence = fencePending; fencePending = null; }
        j++;
        continue;
      }
      // An indented line belongs to this item (a nested block or a
      // paragraph continuation). It is checked before the new-item
      // test, so an indented marker nests instead of starting a sibling.
      if (leadCols(cl) >= contentIndent) {
        // A paragraph continuation at code-block depth is merged into
        // the paragraph (stripped by four more columns); it can never
        // start a new block of its own. Only the item's own paragraph
        // counts (a paragraph nested inside a list does not).
        if (leadCols(cl) >= contentIndent + 4 && hasContent && canContinueParagraph(cl, true) &&
            endsWithOpenParagraphDirect(itemLines, state, true)) {
          itemLines[itemLines.length - 1] += '\n' + stripCols(cl, contentIndent + 4);
          j++;
          continue;
        }
        const dl = extractAfter(cl, 0, 0, contentIndent);
        itemLines.push(dl);
        // This indented line is the fence's first content line: it
        // establishes a pending fence (and may itself close it).
        if (fencePending) { openFence = fencePending; fencePending = null; }
        if (openFence && parseFenceClose(dl, openFence)) openFence = null;
        else if (!openFence && !fencePending) { const f = parseFence(dl); if (f) fencePending = f; }
        hasContent = true;
        j++;
        continue;
      }
      // Any list marker at this level ends the item (a new item of this
      // list, or a different list altogether).
      if (parseListMarker(cl) !== null) break;
      if (hasContent && endsWithOpenParagraph(itemLines, state, true) && canContinueParagraph(cl, true)) {
        // A lazy line is merged into the open paragraph (it can never
        // start a new block of its own). It is stripped by 4 columns
        // when indented that far; a setext underline is merged as-is so
        // it cannot become a heading.
        let stripped;
        if (isSetext(cl) && !isHR(cl)) stripped = cl;
        else if (leadCols(cl) >= 4) stripped = stripCols(cl, 4);
        else stripped = cl;
        itemLines[itemLines.length - 1] += '\n' + stripped;
        j++;
        continue;
      }
      break;
    }
    let trailingBlanks = 0;
    while (itemLines.length && itemLines[itemLines.length - 1] === '') { itemLines.pop(); trailingBlanks++; }
    items.push({ lines: itemLines, trailingBlanks });
  }
  // Parse each item and determine looseness from the parsed blocks: an
  // item is loose when a blank line separates two of its direct blocks
  // (a blank gap between consecutive blocks, or a blank line after its
  // last block), and a list is loose when a non-last item ends with
  // blank lines.
  const parsedItems = items.map((it, idx) => {
    const ch = parseBlocks(it.lines, 0, it.lines.length, state, false, false, true);
    for (let b = 1; b < ch.length; b++) {
      for (let k = ch[b - 1]._e; k < ch[b]._s; k++) {
        if (isBlankLine(it.lines[k])) { loose = true; break; }
      }
      if (loose) break;
    }
    if (!loose && ch.length) {
      const lastEnd = ch[ch.length - 1]._e;
      for (let k = lastEnd; k < it.lines.length; k++) {
        if (isBlankLine(it.lines[k])) { loose = true; break; }
      }
    }
    if (it.trailingBlanks > 0 && idx < items.length - 1) loose = true;
    const item = { ch };
    if (ch.length && ch[0].t === 'p') {
      const tm = /^\[( |x|X)\](?:[ \t]+|$)/.exec(ch[0].text);
      if (tm) {
        item.hasTask = true;
        item.checked = tm[1] === 'x' || tm[1] === 'X';
        ch[0].text = ch[0].text.slice(tm[0].length);
      }
    }
    return item;
  });
  return { node: { t: 'list', ordered: listType === 'ordered', start: startNum, tight: !loose, items: parsedItems }, next: j };
}

// ---- rendering ----

function renderBlocks(nodes, state) {
  let out = '';
  for (const n of nodes) out += renderBlock(n, state);
  return out;
}

function renderBlock(n, state) {
  switch (n.t) {
    case 'p': return '<p>' + parseInline(n.text, state.defs).html + '</p>\n';
    case 'h': return '<h' + n.level + '>' + parseInline(n.text, state.defs).html + '</h' + n.level + '>\n';
    case 'code': return '<pre><code' + (n.lang ? ' class="language-' + escText(n.lang) + '"' : '') + '>' + escCode(n.text) + '</code></pre>\n';
    case 'html': return n.text;
    case 'hr': return '<hr>\n';
    case 'quote': return '<blockquote>\n' + renderBlocks(n.ch, state) + '</blockquote>\n';
    case 'list': return renderList(n, state);
    case 'table': return renderTable(n, state);
    default: return '';
  }
}

function renderItemChildren(it, tight, state) {
  let out = '';
  for (let k = 0; k < it.ch.length; k++) {
    const c = it.ch[k];
    const taskPrefix = (k === 0 && it.hasTask)
      ? '<input ' + (it.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
      : '';
    if (tight && c.t === 'p') {
      out += taskPrefix + parseInline(c.text, state.defs).html;
    } else if (c.t === 'p') {
      out += '<p>' + taskPrefix + parseInline(c.text, state.defs).html + '</p>\n';
    } else {
      out += renderBlock(c, state);
    }
  }
  return out;
}

function renderList(n, state) {
  let out = n.ordered
    ? '<ol' + (n.start !== 1 ? ' start="' + n.start + '"' : '') + '>\n'
    : '<ul>\n';
  for (const it of n.items) {
    out += '<li>' + renderItemChildren(it, n.tight, state) + '</li>\n';
  }
  out += n.ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

function renderTable(n, state) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < n.head.length; k++) {
    const a = n.align[k];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(n.head[k], state.defs).html + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (n.rows.length) {
    out += '<tbody>';
    for (const row of n.rows) {
      out += '<tr>\n';
      for (let k = 0; k < n.head.length; k++) {
        const a = n.align[k];
        const cell = k < row.length ? row[k] : '';
        out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(cell, state.defs).html + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

// ---- public entry point ----

export function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const term = src.endsWith('\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const state = { defs: new Map() };
  const nodes = parseBlocks(lines, 0, lines.length, state, true, term, false);
  return renderBlocks(nodes, state);
}
