// PDF compressor engine - browser port of the Python pdf_engine.py.
// Depends on global PDFLib (pdf-lib) and pdfjsLib (pdf.js), both expected
// to already be loaded when this script runs.

(function (global) {
"use strict";

// ===========================================================================
// Byte/string helpers
// ===========================================================================

function bytesToLatin1(bytes) {
  // 1:1 byte<->char mapping, safe for binary content-stream text.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return s;
}

function latin1ToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// ===========================================================================
// Matrix / bbox math (direct port of pdf_engine.py)
// ===========================================================================

const IDENTITY = [1, 0, 0, 1, 0, 0];

function matMult(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function matInvert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error("singular matrix, cannot invert");
  const ia = d / det, ib = -b / det, ic = -c / det, id_ = a / det;
  const ie = -(e * ia + f * ic);
  const if_ = -(e * ib + f * id_);
  return [ia, ib, ic, id_, ie, if_];
}

function applyPoint(m, x, y) {
  const [a, b, c, d, e, f] = m;
  return [a * x + c * y + e, b * x + d * y + f];
}

function pointsBbox(pts) {
  if (!pts || pts.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function bboxUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function bboxIntersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  if (x0 >= x1 || y0 >= y1) return [x0, y0, x0, y0];
  return [x0, y0, x1, y1];
}

function bboxArea(b) {
  if (!b) return null;
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

// Correct "no overlap at all" test - unlike bboxArea(bboxIntersect(a,b))<=0,
// this does NOT misclassify a zero-width/zero-height bbox (an axis-aligned
// stroked line, e.g. an axis line or tick mark - real visible content with
// zero *fill area*) sitting exactly on a boundary as disjoint. Bug found
// and fixed in the Python version; ported here from the start.
function bboxesDisjoint(a, b) {
  if (!a || !b) return false;
  return a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3];
}

function transformBbox(bbox, m) {
  const [x0, y0, x1, y1] = bbox;
  const pts = [applyPoint(m, x0, y0), applyPoint(m, x1, y0), applyPoint(m, x1, y1), applyPoint(m, x0, y1)];
  return pointsBbox(pts);
}

// ===========================================================================
// Content-stream tokenizer / serializer
// ===========================================================================
// Operand tokens: {t:'num', v:Number} | {t:'name', v:String (no leading /)}
// | {t:'str', v:Uint8Array (raw bytes, delim:'(' or '<')}
// | {t:'arr', v:[tokens]} | {t:'dict', v:[[keyToken,valToken],...]}
// | {t:'ref', v:{num,gen}} (rare in content streams, kept for completeness)
// Instruction: {op:String, args:[tokens]} or {op:'INLINE_IMG', raw:Uint8Array}
// (inline images are passed through as one opaque atomic instruction)

// Lookup tables instead of Set.has() in the hottest per-byte loop -
// tokenizing a multi-million-operator content stream calls these once per
// byte, and array indexing measurably beats Set membership at that volume.
const IS_WS = new Uint8Array(256);
const IS_DELIM = new Uint8Array(256);
const IS_REGULAR = new Uint8Array(256).fill(1);
for (const c of [0, 9, 10, 12, 13, 32]) { IS_WS[c] = 1; IS_REGULAR[c] = 0; }
for (const c of [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]) { IS_DELIM[c] = 1; IS_REGULAR[c] = 0; }
const WHITESPACE = { has: (c) => IS_WS[c] === 1 }; // kept for any external callers
const DELIMS = { has: (c) => IS_DELIM[c] === 1 };

function isRegularChar(c) {
  return IS_REGULAR[c] === 1;
}

function tokenizeContentStream(bytes) {
  const n = bytes.length;
  let i = 0;
  const instructions = [];
  let pending = [];

  function skipWs() {
    while (i < n) {
      const c = bytes[i];
      if (IS_WS[c]) { i++; continue; }
      if (c === 0x25) { // % comment to EOL
        while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
        continue;
      }
      break;
    }
  }

  // Parses a PDF number directly from bytes, without an intermediate
  // string - this is the single hottest path (millions of coordinate
  // operands per document).
  function readNumber() {
    let sign = 1;
    if (bytes[i] === 0x2b) { i++; }
    else if (bytes[i] === 0x2d) { sign = -1; i++; }
    let intPart = 0;
    while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) {
      intPart = intPart * 10 + (bytes[i] - 0x30);
      i++;
    }
    let value = intPart;
    if (bytes[i] === 0x2e) {
      i++;
      let frac = 0, scale = 1;
      while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) {
        frac = frac * 10 + (bytes[i] - 0x30);
        scale *= 10;
        i++;
      }
      value += frac / scale;
    }
    return { t: "num", v: sign * value };
  }

  function readName() {
    i++; // skip /
    const start = i;
    while (i < n && isRegularChar(bytes[i])) i++;
    let raw = bytesToLatin1(bytes.subarray(start, i));
    // decode #XX hex escapes
    if (raw.indexOf("#") !== -1) {
      raw = raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    return { t: "name", v: raw };
  }

  function readLiteralString() {
    // assumes bytes[i] === '('
    const start = i;
    i++;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = bytes[i];
      if (c === 0x5c) { i += 2; continue; } // backslash escapes next byte
      if (c === 0x28) depth++;
      else if (c === 0x29) depth--;
      i++;
    }
    return { t: "str", v: bytes.slice(start, i), delim: "(" };
  }

  function readHexStringOrDict() {
    if (bytes[i + 1] === 0x3c) { // '<<' dict
      i += 2;
      const entries = [];
      while (true) {
        skipWs();
        if (i >= n) break;
        if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) { i += 2; break; }
        const key = readToken();
        skipWs();
        const val = readToken();
        entries.push([key, val]);
      }
      return { t: "dict", v: entries };
    }
    const start = i;
    i++;
    while (i < n && bytes[i] !== 0x3e) i++;
    const raw = bytes.slice(start, i + 1);
    i++;
    return { t: "str", v: raw, delim: "<" };
  }

  function readArray() {
    i++; // skip [
    const items = [];
    while (true) {
      skipWs();
      if (i >= n) break;
      if (bytes[i] === 0x5d) { i++; break; }
      items.push(readToken());
    }
    return { t: "arr", v: items };
  }

  function readToken() {
    skipWs();
    const c = bytes[i];
    if (c === 0x2f) return readName();
    if (c === 0x28) return readLiteralString();
    if (c === 0x3c) return readHexStringOrDict();
    if (c === 0x5b) return readArray();
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) return readNumber();
    // bare keyword (used for true/false/null inside arrays/dicts, or R refs)
    const start = i;
    while (i < n && isRegularChar(bytes[i])) i++;
    return { t: "kw", v: bytesToLatin1(bytes.subarray(start, i)) };
  }

  while (i < n) {
    skipWs();
    if (i >= n) break;
    const c = bytes[i];

    if (c === 0x2f) { pending.push(readName()); continue; }
    if (c === 0x28) { pending.push(readLiteralString()); continue; }
    if (c === 0x3c) { pending.push(readHexStringOrDict()); continue; }
    if (c === 0x5b) { pending.push(readArray()); continue; }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      pending.push(readNumber());
      continue;
    }

    // bare keyword: operator, or true/false/null, or inline-image markers
    const start = i;
    while (i < n && isRegularChar(bytes[i])) i++;
    const kw = bytesToLatin1(bytes.subarray(start, i));

    if (kw === "true" || kw === "false" || kw === "null") {
      pending.push({ t: "kw", v: kw });
      continue;
    }
    if (kw === "R" && pending.length >= 2) {
      // indirect reference: num gen R -> collapse last two operands
      const gen = pending.pop(), num = pending.pop();
      pending.push({ t: "ref", v: { num: num.v, gen: gen.v } });
      continue;
    }
    if (kw === "BI") {
      // Inline image: BI <dict entries> ID <binary> EI
      // Parse the dict entries (key/value pairs) until 'ID'.
      const entries = [];
      while (true) {
        skipWs();
        // peek for 'ID'
        if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 &&
            (i + 2 >= n || WHITESPACE.has(bytes[i + 2]))) {
          i += 2;
          break;
        }
        const key = readToken();
        skipWs();
        const val = readToken();
        entries.push([key, val]);
      }
      i++; // single whitespace byte after ID
      const dataStart = i;
      // scan for whitespace + 'EI' + (whitespace or EOF)
      while (i < n - 1) {
        if (bytes[i] === 0x45 && bytes[i + 1] === 0x49 &&
            (i === 0 || WHITESPACE.has(bytes[i - 1])) &&
            (i + 2 >= n || WHITESPACE.has(bytes[i + 2]) || DELIMS.has(bytes[i + 2]))) {
          break;
        }
        i++;
      }
      const dataEnd = i > dataStart && WHITESPACE.has(bytes[i - 1]) ? i - 1 : i;
      const data = bytes.slice(dataStart, dataEnd);
      i += 2; // skip EI
      instructions.push({ op: "INLINE_IMG", args: [], dict: entries, data });
      pending = [];
      continue;
    }

    // real operator
    instructions.push({ op: kw, args: pending });
    pending = [];
  }

  return instructions;
}

function serializeToken(tok) {
  switch (tok.t) {
    case "num": {
      let v = tok.v;
      if (Number.isInteger(v)) return String(v);
      let s = v.toFixed(6);
      s = s.replace(/0+$/, "").replace(/\.$/, "");
      return s === "" || s === "-" ? "0" : s;
    }
    case "name":
      return "/" + tok.v.replace(/[^\x21-\x7e]/g, (c) => "#" + c.charCodeAt(0).toString(16).padStart(2, "0"));
    case "str":
      return bytesToLatin1(tok.v); // already includes original delimiters
    case "arr":
      return "[" + tok.v.map(serializeToken).join(" ") + "]";
    case "dict":
      return "<<" + tok.v.map(([k, v]) => serializeToken(k) + " " + serializeToken(v)).join(" ") + ">>";
    case "ref":
      return `${tok.v.num} ${tok.v.gen} R`;
    case "kw":
      return tok.v;
    default:
      return "";
  }
}

function serializeInstructions(instructions) {
  const parts = [];
  for (const instr of instructions) {
    if (instr.op === "INLINE_IMG") {
      parts.push("BI");
      for (const [k, v] of instr.dict) parts.push(serializeToken(k), serializeToken(v));
      parts.push("ID");
      parts.push(bytesToLatin1(instr.data));
      parts.push("EI");
      continue;
    }
    for (const a of instr.args) parts.push(serializeToken(a));
    parts.push(instr.op);
  }
  const text = parts.join("\n");
  return latin1ToBytes(text);
}

// A "str" token's `.v` is the raw source bytes *including* the outer
// delimiters and any undecoded backslash/hex escapes (kept raw on purpose
// for cheap round-trip serialization - see readLiteralString/
// readHexStringOrDict above). For the generously-conservative text-bbox
// estimate in ContentStreamWalker, an exact decoded length isn't needed,
// but the 2 delimiter bytes matter: they're not text, and leaving them in
// inflates the estimated advance for *every* Tj/TJ in a run, compounding
// across sibling text-showing ops in the same BT/ET block enough to throw
// off later boxes' computed page-space position (found via a real file
// where it caused a false "this is still on-page" for ghost text that a
// byte-exact count correctly flags as dead). Stripping the delimiters
// (and halving for hex strings, 2 hex digits per byte) matches the decoded
// length for the common escape-free case and only ever overestimates
// otherwise - never under.
function stringTokenCharCount(tok) {
  if (!tok || tok.t !== "str" || !tok.v) return 0;
  const raw = tok.v.length;
  if (tok.delim === "<") return Math.max(0, Math.floor((raw - 2) / 2));
  return Math.max(0, raw - 2);
}

// ===========================================================================
// Content-stream walker: CTM + clip + paint-event tracking
// ===========================================================================

const PAINT_OPS = new Set(["f", "F", "f*", "S", "s", "B", "B*", "b", "b*", "n"]);
const PATH_CONSTRUCTION_OPS = new Set(["m", "l", "c", "v", "y", "re", "h"]);
const CLIP_OPS = new Set(["W", "W*"]);

class ContentStreamWalker {
  constructor(initialCtm = IDENTITY, initialClip = null) {
    this.ctm = initialCtm;
    this.clipBbox = initialClip;
    this._stack = [];
    this._pendingPathPoints = [];
    this._pendingClipPoints = null;
    this._inText = false;
    this._curPoint = [0, 0];
    // Text state, tracked well enough to derive a generously-conservative
    // bbox for Tj/TJ/'/" - not exact glyph metrics (no font widths are
    // consulted), just enough to catch content whose text matrix places it
    // nowhere near its own active clip or the page (see _textPaintBbox).
    // Tm/Tlm reset on BT per spec (not part of the q/Q-saved graphics
    // state); tfs/th/trise/tl are.
    this.tm = IDENTITY;
    this.tlm = IDENTITY;
    this.tfs = 1.0;   // font size, from the 2nd operand of Tf
    this.th = 1.0;    // horizontal scaling = Tz/100 (default 100)
    this.trise = 0.0; // text rise, from Ts
    this.tl = 0.0;    // leading, from TL (used by T*)
  }

  get depth() { return this._stack.length; }
  _push() { this._stack.push([this.ctm, this.clipBbox, this.tfs, this.th, this.trise, this.tl]); }
  _pop() {
    if (this._stack.length) {
      [this.ctm, this.clipBbox, this.tfs, this.th, this.trise, this.tl] = this._stack.pop();
    }
  }

  // Generously-conservative page-space bbox for showing `charCount`
  // characters at the current text/graphics state, plus the text-space
  // advance to move Tm forward by afterward. Deliberately overestimates
  // (up to 1em advance per character, 1em ascent, 0.3em descent) so it only
  // ever flags content as off-page/dead when it truly is - the failure
  // mode to avoid is treating real, visible text as dead, not the reverse.
  _textPaintBbox(charCount) {
    if (charCount <= 0) return [null, 0];
    const advance = charCount * 1.0; // em units, generous vs typical ~0.3-0.7em/char
    const trmScale = [this.tfs * this.th, 0, 0, this.tfs, 0, this.trise];
    const full = matMult(matMult(trmScale, this.tm), this.ctm);
    const corners = [[0, -0.3], [advance, -0.3], [advance, 1.0], [0, 1.0]];
    const pts = corners.map(([x, y]) => applyPoint(full, x, y));
    return [pointsBbox(pts), advance];
  }

  walk(instructions) {
    const paintEvents = [];
    const fontUses = new Set();
    const ctmAt = new Array(instructions.length);
    const depthAt = new Int32Array(instructions.length);
    const clipAt = new Array(instructions.length);

    for (let idx = 0; idx < instructions.length; idx++) {
      const instr = instructions[idx];
      const op = instr.op;
      ctmAt[idx] = this.ctm;
      depthAt[idx] = this.depth;
      clipAt[idx] = this.clipBbox;

      if (op === "q") this._push();
      else if (op === "Q") this._pop();
      else if (op === "cm") {
        const m = instr.args.slice(0, 6).map((a) => a.v);
        this.ctm = matMult(m, this.ctm);
      } else if (op === "BT") {
        this._inText = true;
        this.tm = IDENTITY;
        this.tlm = IDENTITY;
      } else if (op === "ET") this._inText = false;
      else if (op === "Tf") {
        if (instr.args.length >= 1) fontUses.add(instr.args[0].v);
        if (instr.args.length >= 2) this.tfs = instr.args[1].v;
      } else if (op === "Tz") {
        if (instr.args.length >= 1) this.th = instr.args[0].v / 100.0;
      } else if (op === "Ts") {
        if (instr.args.length >= 1) this.trise = instr.args[0].v;
      } else if (op === "TL") {
        if (instr.args.length >= 1) this.tl = instr.args[0].v;
      } else if (op === "Tm") {
        if (instr.args.length >= 6) {
          const m = instr.args.slice(0, 6).map((a) => a.v);
          this.tm = m;
          this.tlm = m;
        }
      } else if (op === "Td" || op === "TD") {
        if (instr.args.length >= 2) {
          const tx = instr.args[0].v, ty = instr.args[1].v;
          if (op === "TD") this.tl = -ty;
          this.tlm = matMult([1, 0, 0, 1, tx, ty], this.tlm);
          this.tm = this.tlm;
        }
      } else if (op === "T*") {
        this.tlm = matMult([1, 0, 0, 1, 0, -this.tl], this.tlm);
        this.tm = this.tlm;
      } else if (PATH_CONSTRUCTION_OPS.has(op) && !this._inText) {
        this._consumePathOp(op, instr.args);
      } else if (CLIP_OPS.has(op)) {
        this._pendingClipPoints = this._pendingPathPoints.slice();
      } else if (PAINT_OPS.has(op)) {
        let bbox = pointsBbox(this._pendingPathPoints);
        if (bbox && this.clipBbox) {
          if (bboxesDisjoint(bbox, this.clipBbox)) {
            // Fully clipped away by the *approximate* (bounding-box) active
            // clip - genuinely provably dead only if that approximation is
            // exact. It isn't always: found via a real file where small
            // per-panel images legitimately inside their true (non-
            // rectangular/nested) clip got marked definitelyDead here and
            // deleted outright, because the bbox-only clip approximation
            // disagreed with the real clip shape. Unlike the text case
            // below (a deliberately generous, purpose-built estimate), this
            // reuses clip tracking that was only ever meant for heuristic
            // sizing - not safe to treat as proof. Fall back to "unknown"
            // rather than "definitely dead".
            bbox = null;
          } else {
            bbox = bboxIntersect(bbox, this.clipBbox);
          }
        }
        if (op !== "n") paintEvents.push({ index: idx, depth: this.depth, bbox, isImage: false });
        if (this._pendingClipPoints !== null) {
          const cand = pointsBbox(this._pendingClipPoints);
          if (cand && bboxArea(cand) > 0) {
            this.clipBbox = bboxIntersect(this.clipBbox, cand);
          }
          this._pendingClipPoints = null;
        }
        this._pendingPathPoints = [];
      } else if (op === "Do") {
        const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
        const pts = corners.map(([x, y]) => applyPoint(this.ctm, x, y));
        let bbox = pointsBbox(pts);
        if (bbox && this.clipBbox) {
          if (bboxesDisjoint(bbox, this.clipBbox)) {
            // See the PAINT_OPS comment above - not safe to treat as proof
            // for images either.
            bbox = null;
          } else {
            bbox = bboxIntersect(bbox, this.clipBbox);
          }
        }
        paintEvents.push({ index: idx, depth: this.depth, bbox, isImage: true, name: instr.args[0] && instr.args[0].v });
      } else if (op === "Tj" || op === "'" || op === '"') {
        // '/" first move to the next line (T*-equivalent) before showing;
        // " also takes word/char spacing operands we don't need for a bbox
        // estimate. The string is always the last operand for all three.
        if (op === "'" || op === '"') {
          this.tlm = matMult([1, 0, 0, 1, 0, -this.tl], this.tlm);
          this.tm = this.tlm;
        }
        const strTok = instr.args[instr.args.length - 1];
        const charCount = stringTokenCharCount(strTok);
        let [bbox, advance] = this._textPaintBbox(charCount);
        let dead = false;
        if (bbox && this.clipBbox) {
          if (bboxesDisjoint(bbox, this.clipBbox)) { dead = true; bbox = null; }
          else bbox = bboxIntersect(bbox, this.clipBbox);
        }
        paintEvents.push({ index: idx, depth: this.depth, bbox, isImage: false, definitelyDead: dead });
        if (advance) {
          const txAdv = advance * this.tfs * this.th;
          this.tm = matMult([1, 0, 0, 1, txAdv, 0], this.tm);
        }
      } else if (op === "TJ") {
        let charCount = 0;
        if (instr.args.length && instr.args[0].t === "arr") {
          for (const el of instr.args[0].v) {
            charCount += stringTokenCharCount(el);
          }
        }
        let [bbox, advance] = this._textPaintBbox(charCount);
        let dead = false;
        if (bbox && this.clipBbox) {
          if (bboxesDisjoint(bbox, this.clipBbox)) { dead = true; bbox = null; }
          else bbox = bboxIntersect(bbox, this.clipBbox);
        }
        paintEvents.push({ index: idx, depth: this.depth, bbox, isImage: false, definitelyDead: dead });
        if (advance) {
          const txAdv = advance * this.tfs * this.th;
          this.tm = matMult([1, 0, 0, 1, txAdv, 0], this.tm);
        }
      } else if (op === "sh") {
        paintEvents.push({ index: idx, depth: this.depth, bbox: this.clipBbox, isImage: false });
      }
    }

    return { paintEvents, fontUses, ctmAt, depthAt, clipAt };
  }

  _consumePathOp(op, args) {
    const v = args.map((a) => a.v);
    if (op === "re") {
      const [x, y, w, h] = v;
      for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
        this._pendingPathPoints.push(applyPoint(this.ctm, cx, cy));
      }
      this._curPoint = [x, y];
    } else if (op === "h") {
      // no new point
    } else if (op === "m") {
      const [x, y] = v;
      this._pendingPathPoints.push(applyPoint(this.ctm, x, y));
      this._curPoint = [x, y];
    } else if (op === "l") {
      const [x, y] = v;
      this._pendingPathPoints.push(applyPoint(this.ctm, x, y));
      this._curPoint = [x, y];
    } else if (op === "c") {
      const [x1, y1, x2, y2, x3, y3] = v;
      for (const [x, y] of [[x1, y1], [x2, y2], [x3, y3]]) {
        this._pendingPathPoints.push(applyPoint(this.ctm, x, y));
      }
      this._curPoint = [x3, y3];
    } else if (op === "v") {
      const [x2, y2, x3, y3] = v;
      this._pendingPathPoints.push(applyPoint(this.ctm, this._curPoint[0], this._curPoint[1]));
      for (const [x, y] of [[x2, y2], [x3, y3]]) {
        this._pendingPathPoints.push(applyPoint(this.ctm, x, y));
      }
      this._curPoint = [x3, y3];
    } else if (op === "y") {
      const [x1, y1, x3, y3] = v;
      for (const [x, y] of [[x1, y1], [x3, y3]]) {
        this._pendingPathPoints.push(applyPoint(this.ctm, x, y));
      }
      this._curPoint = [x3, y3];
    }
  }
}

// ===========================================================================
// Bracket matching (q/Q) + child-unit segmentation
// ===========================================================================

function matchQBrackets(instructions) {
  const stack = [];
  const pairs = new Map(); // qIdx -> QIdx
  const parentOf = new Map(); // qIdx -> parent qIdx or null
  const children = new Map(); // parentOrNull -> [qIdx,...] sorted by construction order

  const NULL_KEY = "__root__";
  const keyFor = (x) => (x === null ? NULL_KEY : x);

  for (let idx = 0; idx < instructions.length; idx++) {
    const op = instructions[idx].op;
    if (op === "q") {
      const parent = stack.length ? stack[stack.length - 1] : null;
      parentOf.set(idx, parent);
      const k = keyFor(parent);
      if (!children.has(k)) children.set(k, []);
      children.get(k).push(idx);
      stack.push(idx);
    } else if (op === "Q") {
      if (stack.length) pairs.set(stack.pop(), idx);
    }
  }
  return { pairs, parentOf, children, keyFor };
}

function childUnits(instructions, brackets, context) {
  let lo, hi;
  if (context === null) {
    lo = 0; hi = instructions.length - 1;
  } else {
    lo = context + 1; hi = brackets.pairs.get(context) - 1;
  }
  const key = brackets.keyFor(context);
  const allChildQs = brackets.children.get(key) || [];
  const childQs = allChildQs.filter((q) => q >= lo && q <= hi);
  const units = [];
  let i = lo, qi = 0;
  while (i <= hi) {
    if (qi < childQs.length && i === childQs[qi]) {
      const end = brackets.pairs.get(childQs[qi]);
      units.push([childQs[qi], end]);
      i = end + 1;
      qi++;
    } else {
      const bareEnd = qi < childQs.length ? childQs[qi] - 1 : hi;
      units.push([i, bareEnd]);
      i = bareEnd + 1;
    }
  }
  return units;
}

// ===========================================================================
// Dense-region detection (scatter/UMAP dot clouds etc.)
// ===========================================================================

const TEXT_SHOWING_OPS = new Set(["Tj", "TJ", "'", '"', "BT", "ET"]);

// Some PDF generators wrap each glyph run in its own q...Q block for
// precise positioning - structurally identical to "many small q/Q blocks"
// (the same signature a scatter-plot dot cloud has), but this is real body
// text, not decorative vector clutter. Rasterizing it would silently
// destroy large amounts of text. A block only qualifies as a "dot" if it
// contains no text-showing operators at all.
function containsText(instructions, start, end) {
  for (let i = start; i <= end; i++) {
    if (TEXT_SHOWING_OPS.has(instructions[i].op)) return true;
  }
  return false;
}

// Companion to findDenseRegions, meant to run BEFORE it. Finds the identical
// "many small q/Q siblings" signature (one shape - one scatter point,
// typically - per q...Q block; this is how R's cairo PDF device, among
// others, emits repeated marks) and, only where provably safe, collapses
// each qualifying run's individual q/Q wrappers into a single outer q...Q
// around the whole run. This removes zero visible content and changes zero
// pixels (see the safety condition below); what it removes is the specific
// bracket signature findDenseRegions uses to flag a region as a promotion
// candidate. That matters because region promotion has a still-unexplained
// rendering defect on exactly this document pattern - found via a real file
// where a dense scatter/network panel silently lost its content after
// promotion despite every input to the promotion step (the extracted
// raster, its bounding box, the placement matrix) checking out correct in
// isolation. Rather than chase that further, this defuses the trigger: a
// run that never looks dense to begin with never reaches the promotion
// path. A second real file confirmed the mechanism - the same figure,
// re-exported through Affinity, doesn't wrap each point in its own q/Q,
// never triggers findDenseRegions, and compresses correctly with the exact
// same downstream code. Ported from the Python engine's
// flatten_redundant_dot_runs after that version was verified pixel-perfect
// (two independent renderers, MuPDF and poppler) on the real files that
// motivated it.
//
// Safety condition for collapsing a run: every member block must (a)
// contain no W/W* or text-showing operator - clipping and text state
// aren't undone by anything short of the real Q, so a block that touches
// either must stay individually scoped - and (b) either every member sets
// its own complete fill/stroke color before painting, or no member sets
// color at all (the whole run shares one ambient color set before it began
// and never changes it). A member MAY contain cm. Where the block's only
// other content is plain point-based path construction (m/l/c/h), the cm
// is resolved at build time instead of at render time: every point operand
// is pre-transformed through the block's own net matrix (computed once,
// full double precision) and the cm is dropped entirely, so there is no
// runtime matrix composition left for a renderer to do at all - not even
// an exactly-cancelling one. That distinction matters in practice: an
// earlier version of this pass instead emitted a compensating cm (the
// mathematical inverse of the block's own, landing the CTM back exactly
// where the real Q would have - correct in principle, and confirmed exact
// to 1e-13 in isolation) in place of each dropped Q. On sparse content that
// was pixel-perfect, but on the densest scatter panels (tens of thousands
// of overlapping same-sized marks in one run) it produced a small but
// real, renderer-independent discrepancy - confirmed identical in kind and
// magnitude under both MuPDF and poppler, which rules out a rendering-side
// antialiasing quirk and points instead to reduced-precision CTM
// arithmetic inside the renderers themselves, invisible per-mark but
// occasionally flipping which of two overlapping marks wins a shared
// boundary pixel once repeated tens of thousands of times.
// Pre-transforming coordinates sidesteps that class of problem outright,
// since the renderer is never asked to compose or invert anything for
// these blocks. A block using any other path operator (re/v/y) falls back
// to the compensating-cm approach, which is still exact in principle and
// was previously verified pixel-perfect on every non-scatter-density case
// this pass was tested against. The run as a whole is still wrapped in one
// outer q...Q, so nothing - color included - leaks past the run's
// boundary, matching the original all-or-nothing isolation the many small
// brackets provided. A run where color usage is inconsistent across
// members is left completely untouched, dense-region heuristics included;
// this pass only ever removes/replaces/rewrites q/Q/cm/path-construction
// operators, never any color or paint instruction, and only where the
// substitution is provably inert.
function flattenRedundantDotRuns(instructions, brackets, opts) {
  const minSiblings = (opts && opts.minSiblings) || 200;
  const maxChildSize = (opts && opts.maxChildSize) || 20;
  const maxBareGap = (opts && opts.maxBareGap) || 12;
  const maxDepth = (opts && opts.maxDepth) || 6;

  const COLOR_SET_OPS = new Set(["rg", "RG", "g", "G", "k", "K", "sc", "SC", "scn", "SCN"]);
  const FILL_ONLY_PAINT_OPS = new Set(["f", "F", "f*"]);
  const STROKE_PAINT_OPS = new Set(["S", "s", "B", "B*", "b", "b*"]);
  const LOCAL_PAINT_OPS = new Set([...FILL_ONLY_PAINT_OPS, ...STROKE_PAINT_OPS]);
  // operator -> indices (into its arg list) that are (x,y) point pairs
  const REWRITABLE_PATH_OPS = { m: [0], l: [0], c: [0, 2, 4], h: [] };

  // null if not safely collapsible; else {setsColor, netCm, rewritable}.
  // rewritable additionally requires fill-only painting: line width is
  // defined in user space and scaled by whatever CTM is active at paint
  // time, so a block that strokes needs the real per-shape cm genuinely in
  // effect when it paints - not just its coordinates pre-transformed - or
  // its stroke renders at the wrong (visibly thicker, if the per-shape
  // scale was < 1) width. Found via a real file where the point-rewrite
  // path made every stroked scatter dot render fatter than the original.
  // The compensating-cm fallback keeps the real cm in place through the
  // paint call, so it stays correct for stroked shapes.
  function analyzeBlock(start, end) {
    let netCm = IDENTITY;
    let setsColor = false;
    let hasPaint = false;
    let rewritable = true;
    for (let i = start; i <= end; i++) {
      const op = instructions[i].op;
      if (CLIP_OPS.has(op) || TEXT_SHOWING_OPS.has(op)) return null;
      else if (op === "cm") {
        const m = instructions[i].args.slice(0, 6).map((a) => a.v);
        netCm = matMult(m, netCm);
      } else if (COLOR_SET_OPS.has(op)) {
        setsColor = true;
      } else if (LOCAL_PAINT_OPS.has(op)) {
        hasPaint = true;
        if (STROKE_PAINT_OPS.has(op)) rewritable = false;
      } else if (PATH_CONSTRUCTION_OPS.has(op) && !(op in REWRITABLE_PATH_OPS)) {
        rewritable = false;
      }
    }
    if (!hasPaint) return null;
    return { setsColor, netCm, rewritable };
  }

  function smallQInfo(u) {
    if (instructions[u[0]].op !== "q" || (u[1] - u[0]) > maxChildSize) return null;
    return analyzeBlock(u[0] + 1, u[1] - 1);
  }

  const qualifyingRuns = []; // [{members: [[qIdx,QIdx],...], infos: [...]}]

  function recurse(context, depth) {
    const units = childUnits(instructions, brackets, context);
    let run = [];
    let runInfos = [];
    let nonDenseBetween = [];

    function flush() {
      const ok = run.length >= minSiblings && (
        runInfos.every((info) => info.setsColor) || !runInfos.some((info) => info.setsColor)
      );
      if (ok) {
        qualifyingRuns.push({ members: run.slice(), infos: runInfos.slice() });
      } else {
        for (const u of run) if (depth < maxDepth) recurse(u[0], depth + 1);
      }
      for (const u of nonDenseBetween) {
        if (instructions[u[0]].op === "q" && depth < maxDepth) recurse(u[0], depth + 1);
      }
      run = [];
      runInfos = [];
      nonDenseBetween = [];
    }

    for (const u of units) {
      const info = smallQInfo(u);
      if (info !== null) {
        run.push(u);
        runInfos.push(info);
        nonDenseBetween = [];
      } else if (run.length && (u[1] - u[0]) <= maxBareGap) {
        nonDenseBetween.push(u);
      } else {
        flush();
        if (instructions[u[0]].op === "q" && depth < maxDepth) recurse(u[0], depth + 1);
      }
    }
    flush();
  }

  recurse(null, 0);

  if (!qualifyingRuns.length) return { instructions, collapsed: 0 };

  const drop = new Set();
  const insertQBefore = new Set();
  const compensateCm = new Map();   // Qidx -> inverse matrix to insert in place of that dropped Q
  const outerCloseAfter = new Set(); // Qidx after which to insert the run's single outer "Q"
  const rewritePoints = new Map();  // instruction idx -> new args array (pre-transformed m/l/c)
  let collapsed = 0;

  for (const { members, infos } of qualifyingRuns) {
    insertQBefore.add(members[0][0]);
    outerCloseAfter.add(members[members.length - 1][1]);
    for (let mi = 0; mi < members.length; mi++) {
      const [qIdx, QIdx] = members[mi];
      const { netCm, rewritable } = infos[mi];
      drop.add(qIdx);
      drop.add(QIdx);
      collapsed++;
      if (netCm.every((v, i) => v === IDENTITY[i])) continue;
      if (rewritable) {
        for (let i = qIdx + 1; i < QIdx; i++) {
          const op = instructions[i].op;
          if (op === "cm") {
            drop.add(i);
          } else if (op in REWRITABLE_PATH_OPS) {
            const vals = instructions[i].args.map((a) => a.v);
            for (const ptIdx of REWRITABLE_PATH_OPS[op]) {
              const [x, y] = applyPoint(netCm, vals[ptIdx], vals[ptIdx + 1]);
              vals[ptIdx] = x; vals[ptIdx + 1] = y;
            }
            rewritePoints.set(i, vals.map((n) => ({ t: "num", v: n })));
          }
        }
      } else {
        compensateCm.set(QIdx, matInvert(netCm));
      }
    }
  }

  const out = [];
  for (let i = 0; i < instructions.length; i++) {
    if (insertQBefore.has(i)) out.push({ op: "q", args: [] });
    if (rewritePoints.has(i)) {
      out.push({ op: instructions[i].op, args: rewritePoints.get(i) });
    } else if (!drop.has(i)) {
      out.push(instructions[i]);
    }
    if (compensateCm.has(i)) {
      out.push({ op: "cm", args: compensateCm.get(i).map((n) => ({ t: "num", v: n })) });
    }
    if (outerCloseAfter.has(i)) out.push({ op: "Q", args: [] });
  }

  return { instructions: out, collapsed };
}

function findDenseRegions(instructions, brackets, opts) {
  const minSiblings = (opts && opts.minSiblings) || 200;
  const maxChildSize = (opts && opts.maxChildSize) || 20;
  const maxBareGap = (opts && opts.maxBareGap) || 12;
  const maxDepth = (opts && opts.maxDepth) || 6;
  const regions = [];

  function isSmallQ(u) {
    return instructions[u[0]].op === "q" && (u[1] - u[0]) <= maxChildSize
      && !containsText(instructions, u[0], u[1]);
  }

  function recurse(context, depth) {
    const units = childUnits(instructions, brackets, context);
    let run = [];
    let nonDenseBetween = [];

    function flush() {
      if (run.length >= minSiblings) {
        regions.push([context, run[0][0], run[run.length - 1][1]]);
      } else {
        for (const u of run) if (depth < maxDepth) recurse(u[0], depth + 1);
      }
      for (const u of nonDenseBetween) {
        if (instructions[u[0]].op === "q" && depth < maxDepth) recurse(u[0], depth + 1);
      }
      run = [];
      nonDenseBetween = [];
    }

    for (const u of units) {
      if (isSmallQ(u)) {
        run.push(u);
        nonDenseBetween = [];
      } else if (run.length && (u[1] - u[0]) <= maxBareGap) {
        nonDenseBetween.push(u);
      } else {
        flush();
        if (instructions[u[0]].op === "q" && depth < maxDepth) recurse(u[0], depth + 1);
      }
    }
    flush();
  }

  recurse(null, 0);
  return regions;
}

// ===========================================================================
// Off-canvas content detection
// ===========================================================================

function findOffcanvasUnits(instructions, brackets, walkResult, pageRect, maxDepth = 3) {
  const eventsSorted = walkResult.paintEvents.slice().sort((a, b) => a.index - b.index);
  const eventIndices = eventsSorted.map((e) => e.index);

  function bisectLeft(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function bisectRight(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function eventsIn(start, end) {
    const lo = bisectLeft(eventIndices, start);
    const hi = bisectRight(eventIndices, end);
    return eventsSorted.slice(lo, hi);
  }

  // A paint event is safe to remove either because its bbox is known and
  // falls entirely outside pageRect, or because it's flagged
  // definitelyDead (its own geometry never intersected the clip active
  // when it fired - e.g. text positioned nowhere near a small clip rect
  // left behind by earlier edits - real "ghost" content, still
  // selectable/copyable but never renderable).
  function isSafeToRemove(e) {
    return e.definitelyDead || (e.bbox != null && bboxesDisjoint(e.bbox, pageRect));
  }

  const dead = [];
  function recurse(context, depth) {
    for (const [start, end] of childUnits(instructions, brackets, context)) {
      if (start === end && instructions[start].op !== "q") continue;
      const events = eventsIn(start, end);
      if (!events.length) continue;
      if (events.every(isSafeToRemove)) {
        dead.push([start, end]);
        continue;
      }
      if (events.some((e) => (e.bbox === null || e.bbox === undefined) && !e.definitelyDead)) {
        if (depth < maxDepth && instructions[start].op === "q") recurse(start, depth + 1);
        continue;
      }
      if (depth < maxDepth && instructions[start].op === "q") {
        recurse(start, depth + 1);
      }
    }
  }
  recurse(null, 0);
  return dead;
}

// ===========================================================================
// Content-stream splicing
// ===========================================================================

// replacements: [[start,end,{data,width,height}|null], ...] sorted by start.
// A non-null replacement embeds one image XObject (caller has already
// registered it in the resources dict under `xobjectName`); null deletes
// the range outright (off-canvas removal).
function spliceInstructions(instructions, replacements) {
  const sorted = replacements.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let cursor = 0;
  let counter = 0;
  const placements = []; // {name, xobjectName} for caller bookkeeping - filled by caller before calling this

  for (const [start, end, xobjName] of sorted) {
    if (start < cursor) continue;
    for (let i = cursor; i < start; i++) out.push(instructions[i]);
    if (xobjName) {
      out.push({ op: "Do", args: [{ t: "name", v: xobjName }] });
    }
    cursor = end + 1;
  }
  for (let i = cursor; i < instructions.length; i++) out.push(instructions[i]);
  return out;
}

// ===========================================================================
// pdf-lib based structure operations (clean-mode waste removal)
// ===========================================================================

function resolveObj(doc, obj) {
  return obj instanceof PDFLib.PDFRef ? doc.context.lookup(obj) : obj;
}

function getPageContentBytes(doc, page) {
  let contents = resolveObj(doc, page.node.get(PDFLib.PDFName.of("Contents")));
  const streams = contents instanceof PDFLib.PDFArray
    ? contents.asArray().map((ref) => resolveObj(doc, ref))
    : [contents];
  const parts = streams.filter(Boolean).map((s) => PDFLib.decodePDFRawStream(s).decode());
  let total = 0;
  for (const p of parts) total += p.length + 1;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; out[off] = 0x20; off++; }
  return out;
}

// PDF content streams are essentially always Flate-compressed in practice
// (text/numeric operator data compresses very well - often 70-80%).
// Writing a replacement stream without compression, even though the
// original was compressed, can make an edited page several times *larger*
// than the untouched original. Uses the browser's native Compression
// Streams API (no bundled deflate library needed) - 'deflate' specifically
// (not 'deflate-raw') since PDF's /FlateDecode expects zlib-wrapped
// (RFC 1950) output, which is what 'deflate' produces.
async function deflateBytes(bytes) {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function setPageContent(doc, page, instructions) {
  const raw = serializeInstructions(instructions);
  const compressed = await deflateBytes(raw);
  const streamDict = doc.context.obj({ Length: compressed.length, Filter: PDFLib.PDFName.of("FlateDecode") });
  const stream = PDFLib.PDFRawStream.of(streamDict, compressed);
  const ref = doc.context.register(stream);
  page.node.set(PDFLib.PDFName.of("Contents"), ref);
}

function getEffectiveResources(doc, pageOrFormDict) {
  let obj = pageOrFormDict;
  const seen = new Set();
  while (obj) {
    const key = obj instanceof PDFLib.PDFRef ? obj.toString() : obj;
    if (seen.has(key)) break;
    seen.add(key);
    const res = obj.get && obj.get(PDFLib.PDFName.of("Resources"));
    if (res) return resolveObj(doc, res);
    const parent = obj.get && obj.get(PDFLib.PDFName.of("Parent"));
    obj = parent ? resolveObj(doc, parent) : null;
  }
  return doc.context.obj({});
}

// Yield every Resources/XObject PDFDict reachable from any page, including
// ones nested inside Form XObjects (recursively).
function* iterXObjectDicts(doc) {
  const visited = new Set();
  function* walkResources(res) {
    if (!res) return;
    const xobjRef = res.get(PDFLib.PDFName.of("XObject"));
    if (!xobjRef) return;
    const xobjDict = resolveObj(doc, xobjRef);
    const dictKey = xobjRef instanceof PDFLib.PDFRef ? xobjRef.toString() : xobjDict;
    if (visited.has(dictKey)) return;
    visited.add(dictKey);
    yield xobjDict;
    for (const name of xobjDict.keys()) {
      const entryRef = xobjDict.get(name);
      const entry = resolveObj(doc, entryRef);
      if (!entry || !entry.get) continue;
      const subtype = entry.get(PDFLib.PDFName.of("Subtype"));
      if (subtype && subtype.toString() === "/Form") {
        const fKey = entryRef instanceof PDFLib.PDFRef ? entryRef.toString() : entry;
        if (!visited.has(fKey)) {
          visited.add(fKey);
          yield* walkResources(entry.get(PDFLib.PDFName.of("Resources")));
        }
      }
    }
  }
  for (const page of doc.getPages()) {
    yield* walkResources(page.node.Resources());
  }
}

async function sha256Hex(bytes) {
  const cryptoObj = (typeof crypto !== "undefined" && crypto.subtle)
    ? crypto
    : require("crypto").webcrypto;
  const digest = await cryptoObj.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function altColorSpaceName(iccStream) {
  const dict = iccStream instanceof PDFLib.PDFRawStream ? iccStream.dict : iccStream;
  const alt = dict.get(PDFLib.PDFName.of("Alternate"));
  if (alt) return alt;
  const n = dict.get(PDFLib.PDFName.of("N"));
  const nVal = n ? n.asNumber() : 3;
  return PDFLib.PDFName.of(nVal === 1 ? "DeviceGray" : nVal === 4 ? "DeviceCMYK" : "DeviceRGB");
}

function stripIccProfiles(doc) {
  let replaced = 0;
  const visited = new Set();

  function walk(obj, depth) {
    if (depth > 25 || obj === null || obj === undefined) return;
    if (obj instanceof PDFLib.PDFRef) {
      const key = obj.toString();
      if (visited.has(key)) return;
      visited.add(key);
      obj = doc.context.lookup(obj);
    }
    if (obj instanceof PDFLib.PDFDict) {
      for (const k of obj.keys()) {
        const raw = obj.get(k);
        const v = resolveObj(doc, raw);
        if (v instanceof PDFLib.PDFArray && v.size() >= 2) {
          const first = v.get(0);
          if (first instanceof PDFLib.PDFName && first.toString() === "/ICCBased") {
            const iccDict = resolveObj(doc, v.get(1));
            obj.set(k, altColorSpaceName(iccDict));
            replaced++;
            continue;
          }
        }
        walk(raw, depth + 1);
      }
    } else if (obj instanceof PDFLib.PDFArray) {
      for (let i = 0; i < obj.size(); i++) walk(obj.get(i), depth + 1);
    }
  }

  walk(doc.catalog, 0);
  for (const page of doc.getPages()) walk(page.node, 0);
  return replaced;
}

async function dedupImages(doc) {
  const hashToCanonical = new Map();
  let collapsed = 0;
  for (const xobjDict of iterXObjectDicts(doc)) {
    for (const name of xobjDict.keys()) {
      const ref = xobjDict.get(name);
      const obj = resolveObj(doc, ref);
      if (!(obj instanceof PDFLib.PDFRawStream)) continue;
      const subtype = obj.dict.get(PDFLib.PDFName.of("Subtype"));
      if (!subtype || subtype.toString() !== "/Image") continue;
      const hash = await sha256Hex(obj.contents);
      const canonical = hashToCanonical.get(hash);
      if (canonical && ref instanceof PDFLib.PDFRef && canonical instanceof PDFLib.PDFRef && canonical !== ref) {
        xobjDict.set(name, canonical);
        collapsed++;
      } else if (!canonical) {
        hashToCanonical.set(hash, ref);
      }
    }
  }
  return collapsed;
}

function removeUnusedFontsForOwner(doc, ownerDict, instructions) {
  const resources = getEffectiveResources(doc, ownerDict);
  const fontDictRef = resources && resources.get(PDFLib.PDFName.of("Font"));
  const fontDict = fontDictRef && resolveObj(doc, fontDictRef);
  if (!fontDict) return 0;
  const used = new Set();
  for (const instr of instructions) {
    if (instr.op === "Tf" && instr.args.length >= 1) used.add(instr.args[0].v);
  }
  let removed = 0;
  for (const name of fontDict.keys()) {
    if (!used.has(name.encodedName.slice(1))) {
      fontDict.delete(name);
      removed++;
    }
  }
  return removed;
}

function removeJavaScript(doc) {
  let removed = false;
  const namesRef = doc.catalog.get(PDFLib.PDFName.of("Names"));
  const names = namesRef && resolveObj(doc, namesRef);
  if (names && names.get(PDFLib.PDFName.of("JavaScript"))) {
    names.delete(PDFLib.PDFName.of("JavaScript"));
    removed = true;
  }
  const oaRef = doc.catalog.get(PDFLib.PDFName.of("OpenAction"));
  const oa = oaRef && resolveObj(doc, oaRef);
  if (oa && oa.get) {
    const s = oa.get(PDFLib.PDFName.of("S"));
    if (s && s.toString() === "/JavaScript") {
      doc.catalog.delete(PDFLib.PDFName.of("OpenAction"));
      removed = true;
    }
  }
  return removed;
}

function removeEmbeddedFiles(doc) {
  const namesRef = doc.catalog.get(PDFLib.PDFName.of("Names"));
  const names = namesRef && resolveObj(doc, namesRef);
  if (!names || !names.get(PDFLib.PDFName.of("EmbeddedFiles"))) return 0;
  names.delete(PDFLib.PDFName.of("EmbeddedFiles"));
  return 1;
}

function removeThumbnails(doc) {
  let removed = 0;
  for (const page of doc.getPages()) {
    if (page.node.get(PDFLib.PDFName.of("Thumb"))) {
      page.node.delete(PDFLib.PDFName.of("Thumb"));
      removed++;
    }
  }
  return removed;
}

function removePieceInfo(doc) {
  let removed = false;
  if (doc.catalog.get(PDFLib.PDFName.of("PieceInfo"))) {
    doc.catalog.delete(PDFLib.PDFName.of("PieceInfo"));
    removed = true;
  }
  for (const page of doc.getPages()) {
    if (page.node.get(PDFLib.PDFName.of("PieceInfo"))) {
      page.node.delete(PDFLib.PDFName.of("PieceInfo"));
      removed = true;
    }
  }
  return removed;
}

// pdf-lib does not garbage-collect unreferenced indirect objects on save
// (verified: an orphaned 2MB object survives .save() untouched unless
// explicitly deleted via context.delete()). Every technique here that
// replaces a page's Contents/Resources or a Form's guts leaves the old,
// now-unreferenced objects sitting in the object table unless we sweep
// them ourselves first - without this, "compression" would net-add bytes
// instead of removing them.
function gcUnreachable(doc) {
  const reachable = new Set();

  function visit(obj) {
    if (obj === null || obj === undefined) return;
    if (obj instanceof PDFLib.PDFRef) {
      const key = obj.toString();
      if (reachable.has(key)) return;
      reachable.add(key);
      visit(doc.context.lookup(obj));
      return;
    }
    if (obj instanceof PDFLib.PDFRawStream) {
      visit(obj.dict);
    } else if (obj instanceof PDFLib.PDFDict) {
      for (const k of obj.keys()) visit(obj.get(k));
    } else if (obj instanceof PDFLib.PDFArray) {
      for (let i = 0; i < obj.size(); i++) visit(obj.get(i));
    }
  }

  visit(doc.catalog);
  const trailerInfo = doc.context.trailerInfo;
  if (trailerInfo) {
    if (trailerInfo.Info) visit(trailerInfo.Info);
    if (trailerInfo.Root) visit(trailerInfo.Root);
  }

  let deleted = 0;
  for (const [ref] of doc.context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) {
      doc.context.delete(ref);
      deleted++;
    }
  }
  return deleted;
}

// ===========================================================================
// Rendering (pdf.js) - whole-page rasterization, Form-swap, region promotion
// ===========================================================================

// pdf.js's render pipeline schedules its drawing loop via
// requestAnimationFrame internally. Browsers fully suspend rAF callbacks
// for hidden/backgrounded tabs (not just throttle them), which would make
// a render() call that started while the tab is visible simply hang
// forever the moment a user switches away mid-compression. Since this is a
// background processing tool, not an animation, there's no reason to tie
// it to the display refresh rate at all - fall back to a plain macrotask
// so rendering keeps making progress regardless of tab visibility.
(function ensureRenderingWorksInBackgroundTabs() {
  if (typeof window === "undefined") return;
  const nativeRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    if (document.visibilityState === "hidden") return setTimeout(cb, 0);
    return nativeRaf ? nativeRaf(cb) : setTimeout(cb, 0);
  };
})();

async function renderPageToCanvas(pdfjsDoc, pageIndex1based, scale) {
  const page = await pdfjsDoc.getPage(pageIndex1based);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function canvasToJpegBytes(canvas, quality) {
  const dataUrl = canvas.toDataURL("image/jpeg", quality / 100);
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Scans pixel data for the bounding box of non-white content. Returns pixel
// coords [left, top, right, bottom] (right/bottom exclusive), or null if
// the whole canvas is blank.
function autocropCanvas(canvas, tolerance = 8) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let left = width, right = 0, top = height, bottom = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const o = rowOff + x * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      if (255 - r > tolerance || 255 - g > tolerance || 255 - b > tolerance) {
        found = true;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (!found) return null;
  return [left, top, right + 1, bottom + 1];
}

function cropCanvas(canvas, box) {
  const [l, t, r, b] = box;
  const w = r - l, h = b - t;
  const out = document.createElement("canvas");
  out.width = Math.max(1, w);
  out.height = Math.max(1, h);
  out.getContext("2d").drawImage(canvas, l, t, w, h, 0, 0, w, h);
  return out;
}

// Everything except instructions[keepStart..keepEnd] is neutralized: paint
// ops become no-ops (preserving any clip side-effect via a trailing 'W n'
// pattern, matching the Python port's leniency), text-show/Do/shading ops
// are dropped outright (none open/close a bracket). q/Q/cm/color/state/path
// -construction operators are left untouched everywhere so bracket balance
// and clip state from surrounding content still propagate correctly.
function neutralizeOutside(instructions, keepStart, keepEnd) {
  const TO_N = new Set(["f", "F", "f*", "S", "s", "B", "B*", "b", "b*"]);
  const DROP = new Set(["Tj", "TJ", "'", '"', "Do", "sh", "INLINE_IMG"]);
  const out = [];
  for (let idx = 0; idx < instructions.length; idx++) {
    if (idx >= keepStart && idx <= keepEnd) { out.push(instructions[idx]); continue; }
    const op = instructions[idx].op;
    if (TO_N.has(op)) out.push({ op: "n", args: [] });
    else if (DROP.has(op)) continue;
    else out.push(instructions[idx]);
  }
  return out;
}

// Tree-aware version of neutralizeOutside, using the already-computed
// bracket structure: a sibling q/Q block that doesn't overlap the target
// range is *entirely self-contained* (it pushes state, draws, and pops
// back to exactly what it was before) - by construction, since these are
// the same "many small q/Q blocks" find_dense_regions looks for. Deleting
// such a sibling wholesale (rather than walking into it to neutralize each
// instruction) is always safe and turns an O(whole document) cost into
// O(target size + number of siblings at each ancestor level) - critical
// for documents where the "other" dense regions account for the bulk of a
// multi-million-instruction stream. Bare (non-bracket) outside runs are
// still neutralized instruction-by-instruction, since they're usually
// small (color/state setters) and might matter.
function buildMinimalIsolated(instructions, brackets, start, end) {
  const TO_N = new Set(["f", "F", "f*", "S", "s", "B", "B*", "b", "b*"]);
  const DROP = new Set(["Tj", "TJ", "'", '"', "Do", "sh", "INLINE_IMG"]);
  const out = [];

  function emitNeutralized(idx) {
    const op = instructions[idx].op;
    if (TO_N.has(op)) out.push({ op: "n", args: [] });
    else if (DROP.has(op)) { /* drop - doesn't open/close a bracket */ }
    else out.push(instructions[idx]);
  }

  function build(context) {
    for (const [uStart, uEnd] of childUnits(instructions, brackets, context)) {
      if (uEnd < start || uStart > end) {
        if (instructions[uStart].op === "q") continue; // self-contained sibling - skip wholesale
        for (let i = uStart; i <= uEnd; i++) emitNeutralized(i);
      } else if (uStart >= start && uEnd <= end) {
        for (let i = uStart; i <= uEnd; i++) out.push(instructions[i]);
      } else {
        // ancestor q/Q block containing the target - keep its bracket,
        // recurse to build its (much smaller) reduced interior
        out.push(instructions[uStart]);
        build(uStart);
        out.push(instructions[uEnd]);
      }
    }
  }

  build(null);
  return out;
}

async function buildTempSinglePageDoc(sourceDoc, pageIndex, instructions) {
  const tempDoc = await PDFLib.PDFDocument.create();
  const [copiedPage] = await tempDoc.copyPages(sourceDoc, [pageIndex]);
  tempDoc.addPage(copiedPage);
  if (instructions) await setPageContent(tempDoc, copiedPage, instructions);
  return { tempDoc, copiedPage };
}

// copyPages (used above) copies the ENTIRE original page graph, including
// every embedded photo/Form the page has anywhere - fine for a full-page
// operation, but ruinous for region promotion: a page can have dozens of
// promoted regions, each needing its own temp doc, and copying (say) a
// 30MB set of unrelated photos 18 times over just to read a few small
// fonts is where most of this technique's real-world cost was going.
// Scan the ALREADY-REDUCED instruction set for which resource names it
// actually uses (Tf/cs/CS/gs/scn/SCN) and copy only those specific
// objects - PDFObjectCopier still pulls in each one's own full transitive
// closure (a font's descendant fonts, embedded program, etc.), just not
// everything else the page happens to also reference.
function scanReferencedResourceNames(instructions) {
  const names = { Font: new Set(), ColorSpace: new Set(), ExtGState: new Set(), Pattern: new Set(), Shading: new Set() };
  for (const instr of instructions) {
    const op = instr.op, args = instr.args;
    if (op === "Tf" && args[0]) names.Font.add(args[0].v);
    else if ((op === "cs" || op === "CS") && args[0]) names.ColorSpace.add(args[0].v);
    else if (op === "gs" && args[0]) names.ExtGState.add(args[0].v);
    else if ((op === "scn" || op === "SCN") && args.length && args[args.length - 1].t === "name") {
      names.Pattern.add(args[args.length - 1].v);
    } else if (op === "sh" && args[0]) names.Shading.add(args[0].v);
  }
  return names;
}

async function buildMinimalResourcesDoc(sourceDoc, sourceResources, instructions, mediaBoxRect) {
  const tempDoc = await PDFLib.PDFDocument.create();
  const [x0, y0, x1, y1] = mediaBoxRect;
  const tempPage = tempDoc.addPage([x1 - x0, y1 - y0]);
  tempPage.node.set(PDFLib.PDFName.of("MediaBox"), tempDoc.context.obj(mediaBoxRect));

  const wanted = scanReferencedResourceNames(instructions);
  const copier = PDFLib.PDFObjectCopier.for(sourceDoc.context, tempDoc.context);
  const resourcesOut = {};
  for (const category of Object.keys(wanted)) {
    if (wanted[category].size === 0) continue;
    const srcCategoryDict = sourceResources && resolveObj(sourceDoc, sourceResources.get(PDFLib.PDFName.of(category)));
    if (!srcCategoryDict) continue;
    const outDict = tempDoc.context.obj({});
    for (const name of wanted[category]) {
      const ref = srcCategoryDict.get(PDFLib.PDFName.of(name));
      if (!ref) continue;
      try {
        outDict.set(PDFLib.PDFName.of(name), copier.copy(ref));
      } catch (e) { /* skip anything that fails to copy rather than abort the whole render */ }
    }
    resourcesOut[category] = outDict;
  }
  tempPage.node.set(PDFLib.PDFName.of("Resources"), tempDoc.context.obj(resourcesOut));
  await setPageContent(tempDoc, tempPage, instructions);
  return { tempDoc, tempPage };
}

// Render the real page with everything except instructions[start..end]
// neutralized, so pdf.js's own correct interpreter resolves every clip and
// transform exactly as the original document intended - no hand-rolled
// CTM/clip math needed for placement. Returns {jpegBytes, width, height,
// pageBbox} with pageBbox already in page space, ready to place directly.
async function renderRegionIsolated(doc, pageIndex, instructions, brackets, start, end, dpi, quality) {
  const isolated = buildMinimalIsolated(instructions, brackets, start, end);
  const page = doc.getPage(pageIndex);
  const { width: pw, height: ph } = page.getSize();
  const sourceResources = page.node.Resources();
  const { tempDoc } = await buildMinimalResourcesDoc(doc, sourceResources, isolated, [0, 0, pw, ph]);
  const tempBytes = await tempDoc.save();

  const pdfjsDoc = await pdfjsLib.getDocument({ data: tempBytes }).promise;
  const scale = dpi / 72;
  const canvas = await renderPageToCanvas(pdfjsDoc, 1, scale);
  await pdfjsDoc.destroy();

  const box = autocropCanvas(canvas);
  if (!box) return null; // nothing visible in this region
  const cropped = cropCanvas(canvas, box);
  const jpegBytes = canvasToJpegBytes(cropped, quality);

  const sx = pw / canvas.width, sy = ph / canvas.height;
  const x0 = box[0] * sx, x1 = box[2] * sx;
  const y1 = ph - box[1] * sy, y0 = ph - box[3] * sy; // row 0 = top = page-space y-max

  return { jpegBytes, width: cropped.width, height: cropped.height, pageBbox: [x0, y0, x1, y1] };
}

// Embeds the isolated render as a new image XObject and returns a
// replacement descriptor for spliceInstructions; does not mutate the
// page's content stream itself (caller batches all replacements for a
// page and splices once).
async function promoteRegion(doc, pageIndex, instructions, brackets, start, end, dpi, quality) {
  const rawBefore = serializeInstructions(instructions.slice(start, end + 1)).length;
  const result = await renderRegionIsolated(doc, pageIndex, instructions, brackets, start, end, dpi, quality);
  if (!result) return null;
  if (result.jpegBytes.length >= rawBefore) return null; // not worth it

  const jpgImage = await doc.embedJpg(result.jpegBytes);
  const page = doc.getPage(pageIndex);
  let xobjDict = resolveObj(doc, page.node.Resources().get(PDFLib.PDFName.of("XObject")));
  if (!xobjDict) {
    xobjDict = doc.context.obj({});
    page.node.Resources().set(PDFLib.PDFName.of("XObject"), xobjDict);
  }
  const genName = `FxGen${Math.random().toString(36).slice(2, 8)}`;
  xobjDict.set(PDFLib.PDFName.of(genName), jpgImage.ref);

  const [x0, y0, x1, y1] = result.pageBbox;
  const w = x1 - x0, h = y1 - y0;
  return {
    start, end, xobjectName: genName,
    rawBytesBefore: rawBefore, rawBytesAfter: result.jpegBytes.length,
    placementInstruction: [
      { op: "q", args: [] },
      { op: "cm", args: [w, 0, 0, h, x0, y0].map((n) => ({ t: "num", v: n })) },
      { op: "Do", args: [{ t: "name", v: genName }] },
      { op: "Q", args: [] },
    ],
  };
}

// Rasterize an existing Form XObject's appearance in place. /BBox and
// /Matrix are left untouched, so every invocation of this Form (anywhere,
// with any invoker CTM) keeps working unmodified.
async function formSwap(doc, formRef, dpi, quality) {
  const formObj = resolveObj(doc, formRef);
  const bboxArr = formObj.dict.get(PDFLib.PDFName.of("BBox"));
  if (!bboxArr) return null;
  const bbox = bboxArr.asArray().map((n) => n.asNumber());
  const matrixArr = formObj.dict.get(PDFLib.PDFName.of("Matrix"));
  const matrix = matrixArr ? matrixArr.asArray().map((n) => n.asNumber()) : IDENTITY;
  const visible = transformBbox(bbox, matrix);
  const vw = visible[2] - visible[0], vh = visible[3] - visible[1];
  if (vw < 3 || vh < 3 || vw > 14400 || vh > 14400) return null;

  const rawBefore = formObj.contents.length;

  // Standalone single-page doc whose MediaBox IS the form's own visible
  // rect (BBox x Matrix) - so "q /FxTemp Do Q" with no extra cm renders
  // exactly the form's natural appearance, matching the validated Python
  // technique (mini_page.MediaBox = visible rect) rather than needing a
  // separate coordinate shift.
  const tempDoc = await PDFLib.PDFDocument.create();
  const tempPage = tempDoc.addPage([vw, vh]);
  tempPage.node.set(PDFLib.PDFName.of("MediaBox"), tempDoc.context.obj(visible));
  const copier = PDFLib.PDFObjectCopier.for(doc.context, tempDoc.context);
  const copiedFormRef = copier.copy(formRef);
  const xobjDict = tempDoc.context.obj({});
  xobjDict.set(PDFLib.PDFName.of("FxTemp"), copiedFormRef);
  tempPage.node.set(PDFLib.PDFName.of("Resources"), tempDoc.context.obj({ XObject: xobjDict }));
  await setPageContent(tempDoc, tempPage, [
    { op: "q", args: [] },
    { op: "Do", args: [{ t: "name", v: "FxTemp" }] },
    { op: "Q", args: [] },
  ]);

  const tempBytes = await tempDoc.save();
  const pdfjsDoc = await pdfjsLib.getDocument({ data: tempBytes }).promise;
  const scale = dpi / 72;
  const canvas = await renderPageToCanvas(pdfjsDoc, 1, scale);
  await pdfjsDoc.destroy();
  const jpegBytes = canvasToJpegBytes(canvas, quality);

  if (jpegBytes.length >= rawBefore) return null;

  const jpgImage = await doc.embedJpg(jpegBytes);
  const [x0, y0, x1, y1] = bbox;
  const wLocal = x1 - x0, hLocal = y1 - y0;
  const newContent = [
    { op: "q", args: [] },
    { op: "cm", args: [wLocal, 0, 0, hLocal, x0, y0].map((n) => ({ t: "num", v: n })) },
    { op: "Do", args: [{ t: "name", v: "Im0" }] },
    { op: "Q", args: [] },
  ];
  const newBytes = serializeInstructions(newContent);
  formObj.dict.set(PDFLib.PDFName.of("Length"), PDFLib.PDFNumber.of(newBytes.length));
  formObj.contents = newBytes;
  const newXobj = doc.context.obj({});
  newXobj.set(PDFLib.PDFName.of("Im0"), jpgImage.ref);
  formObj.dict.set(PDFLib.PDFName.of("Resources"), newXobj);
  formObj.dict.delete(PDFLib.PDFName.of("Group"));

  return { rawBytesBefore: rawBefore, rawBytesAfter: jpegBytes.length };
}

async function rasterizeWholePages(doc, pageIndices, dpi, quality) {
  const scale = dpi / 72;
  // pdf.js needs to read from a serialized snapshot of the CURRENT doc
  // state (earlier stages may have already mutated it in memory).
  const snapshotBytes = await doc.save();
  const pdfjsDoc = await pdfjsLib.getDocument({ data: snapshotBytes }).promise;

  for (const idx of pageIndices) {
    const canvas = await renderPageToCanvas(pdfjsDoc, idx + 1, scale);
    const jpegBytes = canvasToJpegBytes(canvas, quality);
    const jpgImage = await doc.embedJpg(jpegBytes);
    const page = doc.getPage(idx);
    const { width, height } = page.getSize();
    const content = [
      { op: "q", args: [] },
      { op: "cm", args: [width, 0, 0, height, 0, 0].map((n) => ({ t: "num", v: n })) },
      { op: "Do", args: [{ t: "name", v: "Im0" }] },
      { op: "Q", args: [] },
    ];
    await setPageContent(doc, page, content);
    page.node.set(PDFLib.PDFName.of("Resources"),
      doc.context.obj({ XObject: doc.context.obj({ Im0: jpgImage.ref }) }));
  }
  await pdfjsDoc.destroy();
}

// Decodes a /SMask (soft mask) stream to an 8-bit grayscale alpha buffer of
// exactly targetW x targetH, resizing if the mask's own resolution differs
// from the (possibly downsampled) base image it belongs to. Handles the two
// common encodings: /DCTDecode (its own grayscale JPEG - browser-decodable
// directly) and raw samples (Flate/LZW, 8 bits/component - the PDF default
// and the overwhelmingly common case for a generated soft mask). Anything
// else (different bit depth, unrecognized filter) returns null so the
// caller can decline to touch that image rather than guess wrong.
async function decodeMaskToGrayscale(smaskObj, targetW, targetH) {
  const filter = smaskObj.dict.get(PDFLib.PDFName.of("Filter"));
  const filterName = filter
    ? (filter instanceof PDFLib.PDFArray ? filter.get(filter.size() - 1).toString() : filter.toString())
    : null;

  let srcCanvas;
  if (filterName === "/DCTDecode") {
    const blob = new Blob([smaskObj.contents], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    srcCanvas = document.createElement("canvas");
    srcCanvas.width = bitmap.width;
    srcCanvas.height = bitmap.height;
    srcCanvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    const bpc = smaskObj.dict.get(PDFLib.PDFName.of("BitsPerComponent"));
    if (bpc && bpc.asNumber() !== 8) return null;
    const width = smaskObj.dict.get(PDFLib.PDFName.of("Width")).asNumber();
    const height = smaskObj.dict.get(PDFLib.PDFName.of("Height")).asNumber();
    let raw;
    try {
      raw = PDFLib.decodePDFRawStream(smaskObj).decode();
    } catch (e) {
      return null;
    }
    if (raw.length < width * height) return null;
    srcCanvas = document.createElement("canvas");
    srcCanvas.width = width;
    srcCanvas.height = height;
    const sctx = srcCanvas.getContext("2d");
    const imgData = sctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const v = raw[i];
      const p = i * 4;
      imgData.data[p] = v; imgData.data[p + 1] = v; imgData.data[p + 2] = v; imgData.data[p + 3] = 255;
    }
    sctx.putImageData(imgData, 0, 0);
  }

  let outCanvas = srcCanvas;
  if (srcCanvas.width !== targetW || srcCanvas.height !== targetH) {
    outCanvas = document.createElement("canvas");
    outCanvas.width = targetW;
    outCanvas.height = targetH;
    outCanvas.getContext("2d").drawImage(srcCanvas, 0, 0, targetW, targetH);
  }
  const data = outCanvas.getContext("2d").getImageData(0, 0, targetW, targetH).data;
  const gray = new Uint8ClampedArray(targetW * targetH);
  for (let i = 0; i < targetW * targetH; i++) gray[i] = data[i * 4];
  return gray;
}

// Downsample/re-encode oversized images as JPEG. Scoped to images already
// filtered with /DCTDecode (i.e. already JPEG) since that's what the
// browser's own image decoder can read directly without reimplementing a
// PDF-native raw-pixel/JPX/CCITT decoder - the large majority of embedded
// photos in real-world figures. Anything else is left untouched, never
// corrupted. Only commits a replacement if it's actually smaller.
async function recompressImages(doc, maxDim, quality, minSizeBytes = 8000, protectedRefs) {
  let touched = 0;
  const seen = new Set();
  const protect = protectedRefs || new Set();
  for (const xobjDict of iterXObjectDicts(doc)) {
    for (const name of xobjDict.keys()) {
      const ref = xobjDict.get(name);
      if (!(ref instanceof PDFLib.PDFRef)) continue;
      const key = ref.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      if (protect.has(key)) continue;
      const obj = resolveObj(doc, ref);
      if (!(obj instanceof PDFLib.PDFRawStream)) continue;
      const subtype = obj.dict.get(PDFLib.PDFName.of("Subtype"));
      if (!subtype || subtype.toString() !== "/Image") continue;
      const filter = obj.dict.get(PDFLib.PDFName.of("Filter"));
      const filterName = filter
        ? (filter instanceof PDFLib.PDFArray ? filter.get(filter.size() - 1).toString() : filter.toString())
        : null;
      if (filterName !== "/DCTDecode") continue;
      if (obj.contents.length < minSizeBytes) continue;

      try {
        // A separate /SMask carries this image's alpha - JPEG itself can't
        // hold one. Left unhandled, re-encoding just the opaque base JPEG
        // silently drops the mask, and whatever raw RGB sits in the
        // "transparent" region (often garbage, frequently black) becomes
        // visible. An earlier version of this fix composited onto white to
        // avoid that - correct only when the image sits directly on a plain
        // white page, and wrong for layered artwork (e.g. individual
        // BioRender icons placed over each other or over colored shapes),
        // where it replaced real transparency with a visible white box.
        // There's no backdrop color that's safe to assume, so the only
        // correct fix is to keep the transparency: recompress the base
        // color data as JPEG same as always, and re-encode the mask as its
        // own small grayscale image, reattached as this image's /SMask.
        const smaskRef = obj.dict.get(PDFLib.PDFName.of("SMask"));
        const smaskObj = smaskRef ? resolveObj(doc, smaskRef) : null;

        const blob = new Blob([obj.contents], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        const { width: w, height: h } = bitmap;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));

        let maskGray = null;
        if (smaskObj instanceof PDFLib.PDFRawStream) {
          try { maskGray = await decodeMaskToGrayscale(smaskObj, nw, nh); } catch (e) { maskGray = null; }
          if (!maskGray) { bitmap.close(); continue; } // has a mask we can't safely decode - don't risk it
        }

        const canvas = document.createElement("canvas");
        canvas.width = nw; canvas.height = nh;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, nw, nh);
        bitmap.close();
        const newBytes = canvasToJpegBytes(canvas, quality);

        let maskDeflated = null;
        if (maskGray) maskDeflated = await deflateBytes(maskGray);

        const oldTotal = obj.contents.length + (smaskObj ? smaskObj.contents.length : 0);
        const newTotal = newBytes.length + (maskDeflated ? maskDeflated.length : 0);
        if (newTotal < oldTotal) {
          let newRef;
          if (maskDeflated) {
            // doc.embedJpg() defers actually registering the object in the
            // context until doc.save() runs its pending embedders - fine
            // for the no-mask case below (nothing needs to read it back
            // before save), but useless here since /SMask has to be set on
            // this exact dict right now. Build the image object directly
            // instead (same context.register() pattern setPageContent uses
            // above) so it exists immediately and /SMask can be attached
            // synchronously. canvasToJpegBytes always encodes via
            // canvas.toDataURL, which is always 3-component (never a true
            // grayscale JPEG) - DeviceRGB is correct unconditionally.
            const maskDict = doc.context.obj({
              Type: PDFLib.PDFName.of("XObject"),
              Subtype: PDFLib.PDFName.of("Image"),
              Width: nw,
              Height: nh,
              ColorSpace: PDFLib.PDFName.of("DeviceGray"),
              BitsPerComponent: 8,
              Filter: PDFLib.PDFName.of("FlateDecode"),
              Length: maskDeflated.length,
            });
            const maskRef = doc.context.register(PDFLib.PDFRawStream.of(maskDict, maskDeflated));
            const imgDict = doc.context.obj({
              Type: PDFLib.PDFName.of("XObject"),
              Subtype: PDFLib.PDFName.of("Image"),
              Width: nw,
              Height: nh,
              ColorSpace: PDFLib.PDFName.of("DeviceRGB"),
              BitsPerComponent: 8,
              Filter: PDFLib.PDFName.of("DCTDecode"),
              Length: newBytes.length,
              SMask: maskRef,
            });
            newRef = doc.context.register(PDFLib.PDFRawStream.of(imgDict, newBytes));
          } else {
            const newImg = await doc.embedJpg(newBytes);
            newRef = newImg.ref;
          }
          xobjDict.set(name, newRef);
          touched++;
        }
      } catch (e) { /* skip anything the browser can't decode */ }
    }
  }
  return touched;
}

// Sum of raw stream bytes referenced by a page: its own content stream
// plus every XObject in its Resources (recursing into nested Forms),
// deduped within the page. Used to rank pages for the whole-page
// rasterization fallback (heaviest first).
function pageWeight(doc, page) {
  let total = 0;
  const seen = new Set();
  function add(ref) {
    const key = ref instanceof PDFLib.PDFRef ? ref.toString() : ref;
    if (seen.has(key)) return;
    seen.add(key);
    const obj = resolveObj(doc, ref);
    if (!obj) return;
    if (obj instanceof PDFLib.PDFRawStream) {
      total += obj.contents.length;
      const subtype = obj.dict.get(PDFLib.PDFName.of("Subtype"));
      if (subtype && subtype.toString() === "/Form") {
        const res = obj.dict.get(PDFLib.PDFName.of("Resources"));
        const resolved = res && resolveObj(doc, res);
        const xobj = resolved && resolved.get && resolved.get(PDFLib.PDFName.of("XObject"));
        const xobjResolved = xobj && resolveObj(doc, xobj);
        if (xobjResolved) for (const n of xobjResolved.keys()) add(xobjResolved.get(n));
      }
    }
  }
  const contents = page.node.get(PDFLib.PDFName.of("Contents"));
  if (contents instanceof PDFLib.PDFArray) {
    for (const c of contents.asArray()) add(c);
  } else if (contents) add(contents);
  const res = page.node.Resources();
  const xobj = res && res.get(PDFLib.PDFName.of("XObject"));
  const xobjResolved = xobj && resolveObj(doc, xobj);
  if (xobjResolved) for (const n of xobjResolved.keys()) add(xobjResolved.get(n));
  return total;
}

function rankHeavyPages(doc) {
  return doc.getPages()
    .map((page, i) => [i, pageWeight(doc, page)])
    .sort((a, b) => b[1] - a[1]);
}

// ===========================================================================
// Orchestration
// ===========================================================================

function log(cb, msg) { if (cb) cb(msg); }

// Parses a user-facing page spec like "1, 3, 5-8" (1-based, inclusive
// ranges, matching how pages are numbered in every PDF viewer) into a Set
// of 0-based page indices. Unparseable or out-of-range tokens are silently
// skipped rather than throwing, since this feeds a plain text input - a
// typo should never crash the run, just fail to protect that one token.
function parsePageRanges(spec, pageCount) {
  const result = new Set();
  if (!spec) return result;
  for (const part of String(spec).split(",")) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= b; p++) {
        if (p >= 1 && p <= pageCount) result.add(p - 1);
      }
    } else if (/^\d+$/.test(token)) {
      const p = parseInt(token, 10);
      if (p >= 1 && p <= pageCount) result.add(p - 1);
    }
  }
  return result;
}

// Collects the ref (as a string key) of every XObject reachable from an
// excluded page's own Resources - including nested Forms' own Resources,
// recursively - so recompressImages can leave them alone. Images shared
// with a *non*-excluded page are still protected: "exclude this page"
// means this page's own content is never touched, not "unless some other
// page also happens to use the same image."
function collectPageXObjectRefs(doc, page, out) {
  const seen = new Set();
  function walk(resDict) {
    if (!resDict) return;
    const xobjRef = resDict.get(PDFLib.PDFName.of("XObject"));
    const xobjDict = xobjRef && resolveObj(doc, xobjRef);
    if (!xobjDict || !xobjDict.keys) return;
    for (const name of xobjDict.keys()) {
      const ref = xobjDict.get(name);
      if (!(ref instanceof PDFLib.PDFRef)) continue;
      const key = ref.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.add(key);
      const obj = resolveObj(doc, ref);
      if (obj instanceof PDFLib.PDFRawStream) {
        const subtype = obj.dict.get(PDFLib.PDFName.of("Subtype"));
        if (subtype && subtype.toString() === "/Form") {
          const nestedRes = obj.dict.get(PDFLib.PDFName.of("Resources"));
          walk(nestedRes && resolveObj(doc, nestedRes));
        }
      }
    }
  }
  walk(page.node.Resources());
}

// Takes already-tokenized instructions (callers that already need to
// tokenize the page for another reason should reuse that, rather than
// paying for a second multi-second tokenize of the same content).
async function offcanvasRemovalForInstructions(doc, page, instructions) {
  const brackets = matchQBrackets(instructions);
  const walker = new ContentStreamWalker();
  const walkResult = walker.walk(instructions);
  const pageRect = page.node.MediaBox().asArray().map((n) => n.asNumber());
  const dead = findOffcanvasUnits(instructions, brackets, walkResult, pageRect);
  if (dead.length) {
    const replaced = spliceInstructions(instructions, dead.map(([s, e]) => [s, e, null]));
    await setPageContent(doc, page, replaced);
  }
  return dead.length;
}

// excludePagesSpec: a user-facing page-range string ("1, 3, 5-8") or
// already-a-Set of 0-based indices (both accepted so callers that already
// resolved it, like runCompressPipeline's later stages, don't need to
// re-parse). Returns the resolved Set alongside the usual output so callers
// can reuse it for later stages without loading the document again.
async function runCleanPipeline(inputBytes, progressCb, excludePagesSpec) {
  log(progressCb, "Loading PDF...");
  const doc = await PDFLib.PDFDocument.load(inputBytes, { updateMetadata: false });
  const actions = {};
  const skip = excludePagesSpec instanceof Set
    ? excludePagesSpec
    : parsePageRanges(excludePagesSpec, doc.getPageCount());

  log(progressCb, "Stripping ICC color profiles...");
  actions.iccProfilesStripped = stripIccProfiles(doc);

  log(progressCb, "Deduplicating identical images...");
  actions.duplicateImagesDeduped = await dedupImages(doc);

  let fontsRemoved = 0, offcanvasRemoved = 0;
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    if (skip.has(i)) {
      log(progressCb, `Skipping page ${i + 1}/${pages.length} (excluded)...`);
      continue;
    }
    log(progressCb, `Cleaning page ${i + 1}/${pages.length}...`);
    const page = pages[i];
    const cbytes = getPageContentBytes(doc, page);
    const instructions = tokenizeContentStream(cbytes);
    fontsRemoved += removeUnusedFontsForOwner(doc, page.node, instructions);
    offcanvasRemoved += await offcanvasRemovalForInstructions(doc, page, instructions);
  }
  actions.unusedFontsRemoved = fontsRemoved;
  actions.offcanvasUnitsRemoved = offcanvasRemoved;
  actions.javascriptRemoved = removeJavaScript(doc);
  actions.embeddedFilesRemoved = removeEmbeddedFiles(doc);
  actions.thumbnailsRemoved = removeThumbnails(doc);
  actions.pieceinfoRemoved = removePieceInfo(doc);

  log(progressCb, "Compacting...");
  gcUnreachable(doc);
  const outBytes = await doc.save({ useObjectStreams: true });
  return { outBytes, actions, excludePages: skip };
}

async function formSwapAndRegionsForDoc(doc, formThresholdBytes, dpi, quality, progressCb, excludePages) {
  const stats = { formsSwapped: 0, regionsPromoted: 0, bytesSaved: 0, pagesTouched: new Set() };
  const skip = excludePages || new Set();
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    if (skip.has(i)) {
      log(progressCb, `Checking page ${i + 1}/${pages.length}... skipped (excluded)`);
      continue;
    }
    log(progressCb, `Checking page ${i + 1}/${pages.length} for heavy vector content...`);
    const page = pages[i];

    // Existing heavy Form XObjects (top-level only)
    const res = page.node.Resources();
    const xobjRef = res.get(PDFLib.PDFName.of("XObject"));
    const xobjDict = xobjRef && resolveObj(doc, xobjRef);
    if (xobjDict) {
      for (const name of xobjDict.keys()) {
        const ref = xobjDict.get(name);
        const obj = ref instanceof PDFLib.PDFRef ? resolveObj(doc, ref) : null;
        if (!(obj instanceof PDFLib.PDFRawStream)) continue;
        const subtype = obj.dict.get(PDFLib.PDFName.of("Subtype"));
        if (!subtype || subtype.toString() !== "/Form") continue;
        if (obj.contents.length < formThresholdBytes) continue;
        try {
          const result = await formSwap(doc, ref, dpi, quality);
          if (result) {
            stats.formsSwapped++;
            stats.bytesSaved += result.rawBytesBefore - result.rawBytesAfter;
            stats.pagesTouched.add(i);
          }
        } catch (e) { /* leave this Form as vector on any failure */ }
      }
    }

    // Content-stream region promotion
    const cbytes = getPageContentBytes(doc, page);
    let instructions = tokenizeContentStream(cbytes);
    let brackets = matchQBrackets(instructions);
    // Defuse the "one shape per q/Q" signature (R's cairo PDF device, among
    // others, emits scatter/network points this way) BEFORE dense-region
    // detection ever sees it - findDenseRegions can't tell "thousands of
    // individually-bracketed points" apart from any other reason a region
    // might be a good promotion candidate, and region promotion has a
    // still-unexplained rendering defect on exactly that pattern. A run
    // this collapses never reaches findDenseRegions as dense in the first
    // place.
    const flattenResult = flattenRedundantDotRuns(instructions, brackets);
    if (flattenResult.collapsed) {
      instructions = flattenResult.instructions;
      brackets = matchQBrackets(instructions);
      await setPageContent(doc, page, instructions);
      stats.dotRunsFlattened = (stats.dotRunsFlattened || 0) + flattenResult.collapsed;
    }
    const regions = findDenseRegions(instructions, brackets);
    if (!regions.length) continue;

    const replacements = [];
    for (let ri = 0; ri < regions.length; ri++) {
      const [ctx, start, end] = regions[ri];
      const rt0 = performance.now();
      try {
        const result = await promoteRegion(doc, i, instructions, brackets, start, end, dpi, quality);
        console.log(`region ${ri}/${regions.length} size=${end - start + 1} took ${(performance.now() - rt0).toFixed(0)}ms result=${!!result}`);
        if (result) {
          replacements.push([result.start, result.end, result.xobjectName]);
          stats.regionsPromoted++;
          stats.bytesSaved += result.rawBytesBefore - result.rawBytesAfter;
          stats.pagesTouched.add(i);
        }
      } catch (e) {
        console.log(`region ${ri}/${regions.length} FAILED after ${(performance.now() - rt0).toFixed(0)}ms: ${e.message}`);
      }
    }
    if (replacements.length) {
      const spliced = spliceInstructions(instructions, replacements);
      await setPageContent(doc, page, spliced);
    }
  }
  stats.pagesTouched = Array.from(stats.pagesTouched);
  return stats;
}

const RASTER_LADDER = [[1600, 82], [1400, 74], [1200, 68], [1000, 60]];
const WHOLE_PAGE_LADDER = [[2, 220, 82], [4, 200, 78], [6, 180, 75], [9, 160, 70], [12, 150, 65]];

// targetBytes=null means best-effort, quality-preserving compression: run
// clean + one gentle raster pass + Form-swap/region promotion, then stop -
// never fall through to whole-page rasterization (the only stage that
// destroys selectable text, and the only one whose aggressiveness scales
// with how heavy a page is).
async function runCompressPipeline(inputBytes, targetBytes, opts, progressCb) {
  const bestEffort = targetBytes === null || targetBytes === undefined;
  const formThresholdBytes = ((opts && opts.formSwapThresholdKb) || 150) * 1024;
  const stages = [];

  function hitTarget(bytes) { return !bestEffort && bytes.length <= targetBytes; }

  log(progressCb, "Running clean pass...");
  let { outBytes, actions, excludePages } = await runCleanPipeline(inputBytes, progressCb, opts && opts.excludePages);
  stages.push({ stage: "clean", sizeBefore: inputBytes.length, sizeAfter: outBytes.length, actions });
  if (excludePages.size) stages[stages.length - 1].excludedPages = Array.from(excludePages).sort((a, b) => a - b).map((i) => i + 1);
  if (hitTarget(outBytes)) return finalize(outBytes, stages, targetBytes);

  const rasterRungs = bestEffort ? RASTER_LADDER.slice(0, 1) : RASTER_LADDER;
  for (const [maxDim, quality] of rasterRungs) {
    log(progressCb, `Recompressing images (max ${maxDim}px, quality ${quality})...`);
    const doc = await PDFLib.PDFDocument.load(outBytes, { updateMetadata: false });
    let protectedRefs;
    if (excludePages.size) {
      protectedRefs = new Set();
      for (const i of excludePages) collectPageXObjectRefs(doc, doc.getPage(i), protectedRefs);
    }
    const touched = await recompressImages(doc, maxDim, quality, undefined, protectedRefs);
    gcUnreachable(doc);
    const next = await doc.save({ useObjectStreams: true });
    stages.push({ stage: "raster_recompress", params: { maxDim, quality }, imagesTouched: touched,
                  sizeBefore: outBytes.length, sizeAfter: next.length });
    outBytes = next;
    if (hitTarget(outBytes)) return finalize(outBytes, stages, targetBytes);
  }

  log(progressCb, "Rasterizing heavy vector figures (sparing surrounding text)...");
  {
    const doc = await PDFLib.PDFDocument.load(outBytes, { updateMetadata: false });
    const fsStats = await formSwapAndRegionsForDoc(doc, formThresholdBytes, 200, 78, progressCb, excludePages);
    gcUnreachable(doc);
    const next = await doc.save({ useObjectStreams: true });
    stages.push({ stage: "form_swap_and_regions", ...fsStats, sizeBefore: outBytes.length, sizeAfter: next.length });
    outBytes = next;
    if (hitTarget(outBytes) || bestEffort) return finalize(outBytes, stages, targetBytes);
  }

  for (const [nPages, dpi, quality] of WHOLE_PAGE_LADDER) {
    log(progressCb, `Rasterizing ${nPages} heaviest remaining page(s) at ${dpi} DPI...`);
    const doc = await PDFLib.PDFDocument.load(outBytes, { updateMetadata: false });
    const ranked = rankHeavyPages(doc).filter(([i]) => !excludePages.has(i));
    const pageIndices = ranked.slice(0, nPages).map(([i]) => i);
    await rasterizeWholePages(doc, pageIndices, dpi, quality);
    gcUnreachable(doc);
    const next = await doc.save({ useObjectStreams: true });
    stages.push({ stage: "whole_page_rasterize", params: { dpi, quality }, pages: pageIndices,
                  sizeBefore: outBytes.length, sizeAfter: next.length });
    outBytes = next;
    if (hitTarget(outBytes)) return finalize(outBytes, stages, targetBytes);
  }

  return finalize(outBytes, stages, targetBytes);
}

function finalize(outBytes, stages, targetBytes) {
  const targetMet = targetBytes === null || targetBytes === undefined || outBytes.length <= targetBytes;
  return { outBytes, stages, targetMet };
}

global.PDFCompressorEngine = {
  bytesToLatin1, latin1ToBytes,
  IDENTITY, matMult, matInvert, applyPoint, pointsBbox, bboxUnion, bboxIntersect, bboxArea, bboxesDisjoint, transformBbox,
  tokenizeContentStream, serializeInstructions, serializeToken,
  ContentStreamWalker,
  matchQBrackets, childUnits,
  findDenseRegions, flattenRedundantDotRuns, containsText, findOffcanvasUnits,
  spliceInstructions,
  resolveObj, getPageContentBytes, setPageContent, deflateBytes, getEffectiveResources, iterXObjectDicts,
  sha256Hex, stripIccProfiles, dedupImages, removeUnusedFontsForOwner,
  removeJavaScript, removeEmbeddedFiles, removeThumbnails, removePieceInfo, gcUnreachable,
  renderPageToCanvas, canvasToJpegBytes, autocropCanvas, cropCanvas,
  neutralizeOutside, buildMinimalIsolated, scanReferencedResourceNames, buildMinimalResourcesDoc,
  renderRegionIsolated, promoteRegion, formSwap, rasterizeWholePages,
  recompressImages, pageWeight, rankHeavyPages,
  offcanvasRemovalForInstructions, runCleanPipeline, formSwapAndRegionsForDoc, runCompressPipeline,
  parsePageRanges, collectPageXObjectRefs,
};

})(typeof window !== "undefined" ? window : global);
