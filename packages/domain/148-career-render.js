/* CA-02 — resume document rendering + parse-check (Spec 3 v2 §10.4, §2.5;
   render rules §2.2 R1–R11).
   ONE source: the resume JSON the tailor (123) assembles from the fact
   bank. From that single JSON this module renders:
     - PDF  — a hand-built, text-based PDF 1.4 (standard Helvetica /
              Helvetica-Bold, real selectable text, single column). No
              HTML-to-image, no external dependency (zlib is Node core,
              with a vendored pure-JS fallback for the require-less Deno
              bundle — see the LANE F block at the top of the module).
     - DOCX — a hand-built minimal OOXML package (own ZIP writer + CRC32,
              adapted from the reverted career/rq-docx renderer de0f634,
              re-audited against current 123/133 and R1–R11: R6 sizes,
              R8 filename, no header/footer parts).
   Plus the existing plain text/markdown from 123. Every rendered line is
   line.text from the source JSON — the renderer adds NO content, and fact
   IDs / audit metadata never enter the documents.
   TRUTH GATE (same as APPE-002): a resume the truth audit refused
   (ok === false or refused === true, at either level of a tailor result)
   renders NOTHING here: { ok:false, refused:true, buffer:null }.
   PARSE-CHECK (§2.5): extract the text back out of the produced files
   with TWO independent parsers per format and diff reading order +
   content against the source JSON. PDF: (A) a content-stream operator
   parser, (B) a raw string scan of the inflated streams (or poppler
   pdftotext when the caller opts into external parsers). DOCX: (A) a
   ZIP + document.xml paragraph walk, (B) an independent regex text-run
   scan (or python-docx when opted in). Verdict is PASS / WARN / FAIL
   with reasons — NEVER a numeric "ATS score".
   Determinism: fixed ZIP timestamps, no PDF /ID or dates — the same
   resume JSON renders byte-identical files (§10.5 snapshot proof).
   Pure: resume object / buffers in, results out. UMD like the others. */
const CareerRender = (() => {
  // WO-028: the runtime is injectable. Node loads zlib/crypto/Buffer with require; a host without CommonJS require (the
  // Deno edge bundle) gets none of them. CareerRender.withRuntime({ zlib, crypto, Buffer }) returns an instance over the
  // host's own node: built-ins, with the same code path and the same bytes as Node.
  // WO-060 (port of the deployed line's Lane F): when the host supplies no zlib/crypto, make(rt) falls back to the
  // vendored pure-JS codec below, so a render reached without an injected runtime (the router's own tailor turn inside
  // the bundle) still produces a valid PDF. `runtime.zlib`/`runtime.crypto` keep reporting what the HOST provided (the
  // WO-028 contract: renderWith refuses on a host without them); `runtime.codec` says which codec actually runs.
  const nodeReq = (m) => (typeof require !== "undefined" ? (() => { try { return require(m); } catch { return null; } })() : null);
  const NODE_RUNTIME = { zlib: nodeReq("zlib"), crypto: nodeReq("node:crypto"), cp: nodeReq("node:child_process"), fs: nodeReq("node:fs"), os: nodeReq("node:os"), Buffer: typeof Buffer !== "undefined" ? Buffer : null };
  function make(rt) {
  const { cp, fs, os } = rt;
    // ================= byte layer (MUSE-F-011) =================
  // This module's byte plumbing used to read the bare Node Buffer
  // global in ~30 places (alloc / from / concat / isBuffer, the
  // write/read UInt accessors, copy, toString encodings). In the Deno
  // ESM bundle that global does not exist (Supabase Edge Runtime,
  // Deno 2.1.4), so the first render on every tailor turn threw
  // "ReferenceError: Buffer is not defined" (first executed read:
  // renderPdf) and module 143's containment served the generic
  // failure — while Node and Deno 2.9.7, which both expose a Buffer
  // global, masked it in every local test. The fix is ONE module-local
  // byte type over Uint8Array/DataView — bundle-legal primitives
  // only, no require, no node:buffer — selected once, here: where a
  // Buffer global exists (Node), Bytes IS the platform Buffer, so the
  // Node path's bytes and types stay exactly what they were
  // (golden-pinned in tests/career-render-edge-pdf.test.cjs); where
  // none exists, Bytes is the shim below, whose instances carry the
  // semantics this module uses.
  const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_LOOKUP = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i; return t; })();
  function b64Encode(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64_ALPHABET[a >> 2] + B64_ALPHABET[((a & 3) << 4) | (b >> 4)];
      out += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
      out += i + 2 < bytes.length ? B64_ALPHABET[c & 63] : "=";
    }
    return out;
  }
  function b64Decode(text) {
    const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const a = B64_LOOKUP[clean.charCodeAt(i)], b = B64_LOOKUP[clean.charCodeAt(i + 1)];
      const c = clean[i + 2] === "=" || clean[i + 2] === undefined ? -1 : B64_LOOKUP[clean.charCodeAt(i + 2)];
      const d = clean[i + 3] === "=" || clean[i + 3] === undefined ? -1 : B64_LOOKUP[clean.charCodeAt(i + 3)];
      out.push(((a << 2) | (b >> 4)) & 0xff);
      if (c >= 0) out.push((((b & 15) << 4) | (c >> 2)) & 0xff);
      if (d >= 0) out.push((((c & 3) << 6) | d) & 0xff);
    }
    return out;
  }
  // Manual UTF-8 codec: the byte layer depends on nothing beyond
  // Uint8Array/DataView — not even TextEncoder, which a sandboxed
  // realm is not guaranteed to expose.
  function utf8Encode(text) {
    const out = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return out;
  }
  function utf8Decode(bytes) {
    let out = "";
    const cps = [];
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      if (b < 0x80) { cps.push(b); i += 1; }
      else if ((b & 0xe0) === 0xc0 && i + 1 < bytes.length) { cps.push(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
      else if ((b & 0xf0) === 0xe0 && i + 2 < bytes.length) { cps.push(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
      else if ((b & 0xf8) === 0xf0 && i + 3 < bytes.length) { cps.push(((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)); i += 4; }
      else { cps.push(0xfffd); i += 1; }
    }
    for (let j = 0; j < cps.length; j += 8192) out += String.fromCodePoint(...cps.slice(j, j + 8192));
    return out;
  }
  class ByteBuf extends Uint8Array {
    static alloc(size) { return new ByteBuf(size); }
    static from(input, enc) {
      if (typeof input === "string") {
        const e = String(enc || "utf8").toLowerCase();
        if (e === "hex") {
          const out = new ByteBuf(input.length >> 1);
          for (let i = 0; i < out.length; i++) out[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16) || 0;
          return out;
        }
        if (e === "latin1" || e === "binary") {
          const out = new ByteBuf(input.length);
          for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i) & 0xff;
          return out;
        }
        if (e === "base64") { const arr = b64Decode(input); const out = new ByteBuf(arr.length); for (let i = 0; i < arr.length; i++) out[i] = arr[i]; return out; }
        const encoded = utf8Encode(input);
        const out = new ByteBuf(encoded.length);
        for (let i = 0; i < encoded.length; i++) out[i] = encoded[i];
        return out;
      }
      if (input instanceof Uint8Array) { const out = new ByteBuf(input.length); out.set(input); return out; }
      if (input instanceof ArrayBuffer) return new ByteBuf(new Uint8Array(input));
      const arr = Array.from(input || []);
      const out = new ByteBuf(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = arr[i] & 0xff;
      return out;
    }
    static concat(list) {
      let total = 0;
      for (const part of list) total += part.length;
      const out = new ByteBuf(total);
      let off = 0;
      for (const part of list) { out.set(part, off); off += part.length; }
      return out;
    }
    static isBuffer(x) { return x instanceof Uint8Array; }
    _view() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
    writeUInt16LE(value, offset) { this._view().setUint16(offset, value, true); return offset + 2; }
    writeUInt32LE(value, offset) { this._view().setUint32(offset, value, true); return offset + 4; }
    writeUInt32BE(value, offset) { this._view().setUint32(offset, value, false); return offset + 4; }
    readUInt16LE(offset) { return this._view().getUint16(offset, true); }
    readUInt32LE(offset) { return this._view().getUint32(offset, true); }
    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
      const n = Math.max(0, Math.min(sourceEnd - sourceStart, target.length - targetStart));
      if (n > 0) target.set(this.subarray(sourceStart, sourceStart + n), targetStart);
      return n;
    }
    toString(enc, start, end) {
      const e = String(enc || "utf8").toLowerCase();
      const view = this.subarray(start == null ? 0 : start, end == null ? this.length : end);
      if (e === "latin1" || e === "binary") {
        let out = "";
        for (let i = 0; i < view.length; i += 8192) out += String.fromCharCode(...view.subarray(i, i + 8192));
        return out;
      }
      if (e === "base64") return b64Encode(view);
      if (e === "hex") { let out = ""; for (const b of view) out += b.toString(16).padStart(2, "0"); return out; }
      return utf8Decode(view);
    }
  }
  // Merge of WO-028/WO-060 (injectable runtime) with MUSE-F-011 (no bare Buffer global): the host's Buffer when it
  // supplies one, otherwise the module-local ByteBuf, so the Deno edge runtime never reads an undefined global.
  const Buffer = rt.Buffer || ByteBuf;
  const Bytes = Buffer;
  // ================= pure-JS zlib + SHA-256 (edge fallback) =================
  // LANE F (the CHANNEL-DOC-1 blocker; Lane B record
  // docs/career/channel-doc-1-record-2026-10-20.md §5): in the Deno ESM
  // bundle there is no `require`, so the Node captures below come back
  // null and every render used to refuse ("zlib is unavailable in this
  // runtime; PDF rendering needs Node") — live tailor turns rendered
  // text-only while the reply claimed an attachment. The staged-entry
  // guards pin, as deliberate law, that the handler graph links and
  // executes with NO require at all, so the fix cannot be a require
  // shim; and the render API is synchronous (123 calls renderPdf
  // synchronously), so async platform compression cannot serve it
  // either. The bundle-legal primitive is plain JS, vendored here as
  // ordinary source: an RFC 1950/1951 codec plus SHA-256.
  //   - DEFLATE writer: stored (uncompressed) blocks — always-valid
  //     deflate, fully deterministic; the streams it serves are a few
  //     KB of PDF text operators / DOCX parts.
  //   - Inflater: a full RFC 1951 decoder (stored + fixed + dynamic
  //     Huffman), so parse-check also reads Node-produced files.
  // These run ONLY when the Node captures are absent. On Node, `zlib`
  // and `crypto` below ARE the platform modules and rendered bytes stay
  // byte-identical (golden-pinned in tests/career-render-edge-pdf.test.cjs;
  // staged-bundle proof in tests/edge/edge-pdf-renderer.test.ts).
  function adler32(data) {
    let a = 1, b = 0;
    for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }
  function deflateStored(data) {
    const chunks = [];
    let off = 0;
    do {
      const len = Math.min(65535, data.length - off);
      const head = Bytes.alloc(5);
      head[0] = off + len >= data.length ? 1 : 0; // BFINAL, BTYPE=00, then byte-aligned
      head.writeUInt16LE(len, 1);
      head.writeUInt16LE((~len) & 0xffff, 3);
      chunks.push(head, Bytes.from(data.subarray(off, off + len)));
      off += len;
    } while (off < data.length);
    return Bytes.concat(chunks);
  }
  function zlibDeflate(data) {
    const body = deflateStored(data);
    const out = Bytes.alloc(2 + body.length + 4);
    out[0] = 0x78; out[1] = 0x01; // CMF/FLG: deflate, 32K window; (0x78*256+0x01) % 31 === 0
    body.copy(out, 2);
    out.writeUInt32BE(adler32(data), 2 + body.length);
    return out;
  }
  function inflateRaw(data, opts) { return inflateRawCore(data, opts && opts.maxOutputLength).buffer; }
  // Returns the decoded bytes plus `end`: the offset just past the
  // deflate stream. Callers slice streams out of larger buffers (a PDF
  // stream is followed by "\nendstream"), so trailing bytes after the
  // final block are normal and must not be read as part of the stream —
  // Node's zlib tolerates them the same way.
  // maxOut (FEATURE 16, review of PR #194): stop with a RangeError once the output passes it, as Node's maxOutputLength
  // does, so a small compressed stream can never expand without bound.
  function inflateRawCore(data, maxOut) {
    let pos = 0, bitbuf = 0, bitcnt = 0;
    const cap = Number.isFinite(maxOut) && maxOut > 0 ? maxOut : Infinity;
    const out = [];
    const over = () => { if (out.length > cap) { const e = new RangeError("inflated output exceeds maxOutputLength"); e.code = "ERR_BUFFER_TOO_LARGE"; throw e; } };
    const getBits = (n) => {
      while (bitcnt < n) {
        if (pos >= data.length) throw new Error("deflate stream ends early");
        bitbuf |= data[pos++] << bitcnt; bitcnt += 8;
      }
      const v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v;
    };
    const buildHuffman = (lengths) => {
      const counts = new Array(16).fill(0);
      for (const l of lengths) if (l) counts[l]++;
      const offs = new Array(16).fill(0);
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
      const symbols = new Array(lengths.length);
      lengths.forEach((l, i) => { if (l) symbols[offs[l]++] = i; });
      return { counts, symbols };
    };
    const decode = (huff) => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= getBits(1);
        const count = huff.counts[len];
        if (code - first < count) return huff.symbols[index + (code - first)];
        index += count; first = (first + count) << 1; code <<= 1;
      }
      throw new Error("invalid huffman code in deflate stream");
    };
    const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    let last = 0;
    do {
      last = getBits(1);
      const type = getBits(2);
      if (type === 0) {
        pos -= bitcnt >> 3; bitbuf = 0; bitcnt = 0; // align to the byte boundary
        if (pos + 4 > data.length) throw new Error("stored block header overruns the stream");
        const len = data[pos] | (data[pos + 1] << 8);
        const nlen = data[pos + 2] | (data[pos + 3] << 8);
        if (((~len) & 0xffff) !== nlen) throw new Error("stored block length check failed");
        pos += 4;
        if (pos + len > data.length) throw new Error("stored block overruns the stream");
        for (let i = 0; i < len; i++) out.push(data[pos++]);
        over();
      } else if (type === 1 || type === 2) {
        let lit, dist;
        if (type === 1) {
          const litLen = [];
          for (let i = 0; i < 288; i++) litLen.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
          lit = buildHuffman(litLen);
          dist = buildHuffman(new Array(32).fill(5));
        } else {
          const hlit = getBits(5) + 257, hdist = getBits(5) + 1, hclen = getBits(4) + 4;
          const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
          const codeLen = new Array(19).fill(0);
          for (let i = 0; i < hclen; i++) codeLen[ORDER[i]] = getBits(3);
          const codeHuff = buildHuffman(codeLen);
          const lengths = new Array(hlit + hdist).fill(0);
          let i = 0;
          while (i < lengths.length) {
            const sym = decode(codeHuff);
            if (sym < 16) lengths[i++] = sym;
            else if (sym === 16) { if (!i) throw new Error("repeat code with no previous length"); const prev = lengths[i - 1]; const rep = 3 + getBits(2); for (let j = 0; j < rep; j++) lengths[i++] = prev; }
            else if (sym === 17) { i += 3 + getBits(3); }
            else { i += 11 + getBits(7); }
            if (i > lengths.length) throw new Error("code length repeat overruns the table");
          }
          lit = buildHuffman(lengths.slice(0, hlit));
          dist = buildHuffman(lengths.slice(hlit));
        }
        for (;;) {
          const sym = decode(lit);
          if (sym < 256) { out.push(sym); continue; }
          if (sym === 256) break;
          const li = sym - 257;
          if (li >= LEN_BASE.length) throw new Error("invalid literal/length symbol");
          const len = LEN_BASE[li] + getBits(LEN_EXT[li]);
          const dsym = decode(dist);
          if (dsym >= DIST_BASE.length) throw new Error("invalid distance symbol");
          const d = DIST_BASE[dsym] + getBits(DIST_EXT[dsym]);
          if (d > out.length) throw new Error("deflate distance too far back");
          for (let j = 0; j < len; j++) out.push(out[out.length - d]);
          if (out.length > cap) over();
        }
      } else throw new Error("invalid deflate block type");
    } while (!last);
    return { buffer: Bytes.from(out), end: pos - (bitcnt >> 3) };
  }
  function zlibInflate(data, opts) {
    if (data.length < 6) throw new Error("zlib stream too short");
    const cmf = data[0], flg = data[1];
    if ((cmf * 256 + flg) % 31 !== 0 || (cmf & 0x0f) !== 8) throw new Error("invalid zlib header");
    if (flg & 0x20) throw new Error("preset dictionary not supported");
    const core = inflateRawCore(data.subarray(2), opts && opts.maxOutputLength);
    const at = 2 + core.end; // the Adler-32 sits right after the deflate stream
    if (at + 4 > data.length) throw new Error("zlib stream truncated before its checksum");
    const stored = ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
    if (stored !== adler32(core.buffer)) throw new Error("zlib adler32 mismatch");
    return core.buffer;
  }
  const pureZlib = {
    deflateSync: (data) => zlibDeflate(data),
    deflateRawSync: (data) => deflateStored(data),
    inflateSync: (data, opts) => zlibInflate(data, opts),
    inflateRawSync: (data, opts) => inflateRaw(data, opts),
  };
  function sha256HexPure(data) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const total = ((data.length + 9 + 63) >> 6) << 6;
    const msg = new Uint8Array(total);
    msg.set(data);
    msg[data.length] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(total - 4, (data.length << 3) >>> 0);
    dv.setUint32(total - 8, Math.floor(data.length / 0x20000000));
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const w = new Array(64);
    for (let block = 0; block < total; block += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(block + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + s1 + ch + K[i] + w[i]) | 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
  }
  const pureCrypto = {
    createHash: (alg) => {
      if (alg !== "sha256") throw new Error(`pure crypto fallback supports sha256 only, not ${alg}`);
      let buf = Bytes.alloc(0);
      return {
        update(data) { buf = Bytes.concat([buf, Bytes.from(data)]); return this; },
        digest(enc) { const hex = sha256HexPure(buf); return enc === "hex" ? hex : Bytes.from(hex, "hex"); },
      };
    },
  };

  // The renderers below read these two names. With the host's modules (Node, or Deno's node: built-ins via
  // withRuntime) they are the platform codec (byte-identical output); otherwise they are the vendored pure-JS
  // implementations above (they need a Buffer). The `if (!zlib)` refusal branches in the renderers stay as defense
  // in depth — they fire only when there is no Buffer either.
  const zlib = rt.zlib || (Buffer ? pureZlib : null);
  const crypto = rt.crypto || (Buffer ? pureCrypto : null);

  const PDF_CONTENT_TYPE = "application/pdf";
  const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const HEADING_ALLOWLIST = ["EXPERIENCE", "EDUCATION", "SKILLS", "PROJECTS", "LEADERSHIP", "SUMMARY", "CERTIFICATIONS", "AWARDS", "PUBLICATIONS", "COURSEWORK", "ACTIVITIES", "RESEARCH", "ADDITIONAL"];

  // ================= shared document model =================
  // The single block list both renderers consume and sourceLines() reports.
  // Only `text` is ever read off a resume line — factIds stay outside.
  function toBlocks(resume) {
    const blocks = [];
    const header = (resume && resume.header) || {};
    if (header.name) blocks.push({ style: "name", kind: "name", text: String(header.name) });
    const contact = [header.email, header.location].filter(Boolean).join(" | ");
    if (contact) blocks.push({ style: "contact", kind: "contact", text: contact });
    const links = Object.values(header.links || {}).filter(Boolean).join(" | ");
    if (links) blocks.push({ style: "links", kind: "links", text: links });
    const addLine = (line) => {
      if (!line || line.text == null || !String(line.text).trim()) return;
      const kind = line.type || line.kind || "line";
      if (kind === "bullet") blocks.push({ style: "bullet", kind: "bullet", text: String(line.text) });
      else if (kind === "entry") blocks.push({ style: "entry", kind: "entry", text: String(line.text) });
      else if (kind === "heading") blocks.push({ style: "heading", kind: "heading", text: String(line.text).toUpperCase() });
      else blocks.push({ style: "line", kind: "line", text: String(line.text) });
    };
    if (Array.isArray(resume && resume.sections) && resume.sections.length) {
      for (const s of resume.sections) {
        if (!s) continue;
        if (s.heading) blocks.push({ style: "heading", kind: "heading", text: String(s.heading).toUpperCase(), section: String(s.heading) });
        for (const l of s.lines || []) addLine(l);
      }
    } else if (Array.isArray(resume && resume.lines)) {
      let currentSection = null;
      for (const l of resume.lines) {
        if (l && l.section && l.section !== currentSection) {
          currentSection = l.section;
          blocks.push({ style: "heading", kind: "heading", text: String(l.section).toUpperCase(), section: String(l.section) });
        }
        addLine(l);
      }
    }
    return blocks;
  }
  // Expected content lines, in render order. Bullets carry no glyph here;
  // extraction normalisation strips the glyph the renderers print.
  function sourceLines(resume) {
    return toBlocks(resume).map((b) => ({ text: b.text, kind: b.kind }));
  }

  // R8: FirstName_LastName_Resume.<ext> — parenthetical markers dropped.
  function filenameFor(name, ext) {
    const clean = String(name || "").replace(/\([^)]*\)/g, " ").trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    const first = (parts[0] || "Resume").replace(/[^A-Za-z'-]/g, "");
    const last = (parts.length > 1 ? parts[parts.length - 1] : "").replace(/[^A-Za-z'-]/g, "");
    return `${first}${last ? `_${last}` : ""}_Resume.${ext}`;
  }

  function refusedCheck(input) {
    let resume = input;
    if (resume && typeof resume === "object" && !resume.lines && !resume.sections && resume.resume) resume = resume.resume;
    if (!input || typeof input !== "object" || input.ok === false || input.refused === true || !resume || resume.ok === false || resume.refused === true) {
      return { resume: null, refusal: { ok: false, refused: true, reason: "resume was refused by the truth audit (or is missing); no document is rendered from an unaudited resume", buffer: null, filename: null } };
    }
    return { resume, refusal: null };
  }

  // ================= ZIP (writer + reader; DOCX package) =================
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
    return table;
  })();
  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  const DOS_TIME = 0; const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01: deterministic bytes
  function zipBuffer(entries) {
    const chunks = []; const central = []; let offset = 0;
    for (const entry of entries) {
      const nameBuf = Bytes.from(entry.name, "utf8");
      const data = Bytes.isBuffer(entry.data) ? entry.data : Bytes.from(String(entry.data), "utf8");
      const compressed = zlib.deflateRawSync(data);
      const crc = crc32(data);
      const local = Bytes.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(8, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
      chunks.push(local, nameBuf, compressed);
      const cd = Bytes.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(8, 10); cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14);
      cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
      central.push(cd, nameBuf);
      offset += local.length + nameBuf.length + compressed.length;
    }
    const cdSize = central.reduce((n, b) => n + b.length, 0);
    const eocd = Bytes.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
    return Bytes.concat([...chunks, ...central, eocd]);
  }
  // Central-directory reader: part name -> inflated Bytes. Independent of
  // the writer (walks the EOCD + central directory, verifies CRC on read).
  // FEATURE 16 (review of PR #194: a 783 KB .docx reached 1.7 GB): only the parts `want` names are inflated (all, when
  // absent), each to at most PART_MAX bytes (Node's maxOutputLength; the pure-JS inflater the same), and all of them
  // together to at most TOTAL_MAX; a part past either is left out, never inflated whole. `namesOnly` lists the names and
  // inflates nothing.
  const PART_MAX = 5 * 1024 * 1024, TOTAL_MAX = 20 * 1024 * 1024, MAX_STREAMS = 400;
  function unzipParts(buf, want, namesOnly) {
    const parts = new Map();
    if (!Bytes.isBuffer(buf) || buf.length < 22) return parts;
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) return parts;
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16), total = 0;
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const crc = buf.readUInt32LE(p + 16);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
      const localOff = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (namesOnly) { parts.set(name, null); continue; }
      if (want && !want(name)) continue;
      if (localOff + 30 > buf.length) continue;
      const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      const room = Math.min(PART_MAX, TOTAL_MAX - total);
      if (room <= 0) break;
      let data = null;
      try { data = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: room }) : (raw.length <= room ? Bytes.from(raw) : null); } catch { data = null; }
      if (data && crc32(data) === crc) { parts.set(name, data); total += data.length; }
      else total += room; // a part that failed or went past its cap still cost up to its room: charged, so bombs cannot be retried for free
    }
    return parts;
  }

  const docxPartNames = (buf) => [...unzipParts(buf, null, true).keys()];
  function docxPart(buf, name) { return unzipParts(buf, (n) => n === name).get(name) || null; }
  // Rebuild a DOCX with some parts replaced (audit-mode mutants in tests).
  function rebuildDocx(buf, replacements) {
    const parts = unzipParts(buf);
    const entries = [];
    for (const [name, data] of parts) entries.push({ name, data: replacements && replacements[name] !== undefined ? replacements[name] : data });
    return zipBuffer(entries);
  }

  // ================= DOCX renderer =================
  function escXml(text) {
    return String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function paragraph(style, text, opts) {
    const o = opts || {};
    const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
    const rPr = o.bold ? "<w:rPr><w:b/></w:rPr>" : "";
    return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;
  }
  const DOCX_CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const DOCX_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  // R6: one standard font (Calibri), every size inside 10–12pt
  // (w:sz is half-points: 22 = 11pt body, 24 = 12pt name).
  const DOCX_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:caps/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="180"/></w:pPr></w:style></w:styles>`;
  function docxDocumentXml(resume) {
    const body = toBlocks(resume).map((b) => {
      if (b.style === "name") return paragraph("Title", b.text);
      if (b.style === "heading") return paragraph("Heading1", b.text);
      if (b.style === "bullet") return paragraph("ListBullet", `\u2022 ${b.text}`);
      if (b.style === "entry") return paragraph(null, b.text, { bold: true });
      return paragraph(null, b.text);
    }).join("");
    const sectPr = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${sectPr}</w:body></w:document>`;
  }
  function renderDocx(input) {
    const { resume, refusal } = refusedCheck(input);
    if (refusal) return { ...refusal, contentType: DOCX_CONTENT_TYPE };
    if (!zlib) return { ok: false, refused: false, reason: "zlib is unavailable in this runtime; DOCX rendering needs Node", buffer: null, contentType: DOCX_CONTENT_TYPE, filename: null };
    if (!toBlocks(resume).length) return { ok: false, refused: true, reason: "resume has no renderable lines", buffer: null, contentType: DOCX_CONTENT_TYPE, filename: null };
    const buffer = zipBuffer([
      { name: "[Content_Types].xml", data: DOCX_CONTENT_TYPES_XML },
      { name: "_rels/.rels", data: DOCX_RELS_XML },
      { name: "word/document.xml", data: docxDocumentXml(resume) },
      { name: "word/styles.xml", data: DOCX_STYLES_XML },
    ]);
    return { ok: true, buffer, contentType: DOCX_CONTENT_TYPE, filename: filenameFor(resume.header && resume.header.name, "docx"), bytes: buffer.length };
  }

  // ================= WinAnsi codec (PDF text) =================
  // Chars outside WinAnsi are replaced with '?' and REPORTED — never
  // silently mangled (the renderer returns them in `unencodable`).
  const WINANSI_EXTRA = new Map([["\u20AC", 0x80], ["\u2026", 0x85], ["\u2018", 0x91], ["\u2019", 0x92], ["\u201C", 0x93], ["\u201D", 0x94], ["\u2022", 0x95], ["\u2013", 0x96], ["\u2014", 0x97], ["\u02DC", 0x98], ["\u2122", 0x99], ["\u0153", 0x9c], ["\u0178", 0x9f]]);
  const WINANSI_DECODE = new Map([...WINANSI_EXTRA].map(([ch, b]) => [b, ch]));
  function encodeWinAnsi(text, unencodable) {
    const bytes = [];
    for (const ch of String(text)) {
      const code = ch.codePointAt(0);
      if (code >= 0x20 && code <= 0x7e) bytes.push(code);
      else if (code >= 0xa0 && code <= 0xff) bytes.push(code);
      else if (WINANSI_EXTRA.has(ch)) bytes.push(WINANSI_EXTRA.get(ch));
      else { bytes.push(0x3f); if (unencodable && !unencodable.includes(ch)) unencodable.push(ch); }
    }
    return Bytes.from(bytes);
  }
  function decodeWinAnsi(buf) {
    let out = "";
    for (const b of buf) {
      if (b >= 0x80 && b <= 0x9f && WINANSI_DECODE.has(b)) out += WINANSI_DECODE.get(b);
      else out += String.fromCharCode(b);
    }
    return out;
  }
  function pdfLiteral(bytes) {
    let s = "";
    for (const b of bytes) {
      if (b === 0x28) s += "\\("; else if (b === 0x29) s += "\\)"; else if (b === 0x5c) s += "\\\\";
      else if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
      else s += `\\${b.toString(8).padStart(3, "0")}`;
    }
    return `(${s})`;
  }

  // ================= PDF layout + writer =================
  const PAGE = { w: 612, h: 792, margin: 54, top: 738, bottom: 56 };
  const FONT_FOR = { name: "F2", heading: "F2", entry: "F2", contact: "F1", links: "F1", bullet: "F1", line: "F1" };
  const SIZE_FOR = { name: 12, heading: 11, entry: 11, contact: 11, links: 11, bullet: 11, line: 11 };
  const LEAD_FOR = { name: 16, heading: 15, entry: 13.8, contact: 13.5, links: 13.5, bullet: 13.8, line: 13.8 };
  const GAP_BEFORE = { heading: 9 };
  // Conservative Helvetica advance estimate (em fractions by char class);
  // the wrap budget stays well inside the column so nothing overflows.
  function estWidthPt(text, sizePt) {
    let em = 0;
    for (const ch of String(text)) {
      if (ch === " " || ch === "i" || ch === "l" || ch === "j" || ch === "." || ch === "," || ch === ":" || ch === ";" || ch === "'" || ch === "!") em += 0.28;
      else if (ch === "m" || ch === "w" || ch === "M" || ch === "W" || ch === "\u2022") em += 0.85;
      else if (ch >= "A" && ch <= "Z") em += 0.67;
      else if (ch >= "0" && ch <= "9") em += 0.556;
      else em += 0.5;
    }
    return em * sizePt;
  }
  const COLUMN_PT = PAGE.w - PAGE.margin * 2; // 504
  function wrapLine(text, sizePt, firstPrefix) {
    const budget = COLUMN_PT - 14; // safety margin
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = firstPrefix || "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (estWidthPt(next, sizePt) <= budget || !cur || cur === (firstPrefix || "")) cur = next;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }
  // The exact layout lines the PDF writer emits (bullets get their glyph;
  // long lines wrap at word boundaries). This is the PDF ground truth the
  // parse-check diffs extraction against — the DOCX truth stays logical.
  function layoutLines(resume) {
    const out = [];
    for (const b of toBlocks(resume)) {
      const display = b.style === "bullet" ? `\u2022 ${b.text}` : b.text;
      for (const piece of wrapLine(display, SIZE_FOR[b.style] || 11)) out.push({ text: piece, kind: b.kind });
    }
    return out;
  }
  function paginate(blocks) {
    const pages = [[]];
    let y = PAGE.top;
    for (const b of blocks) {
      const size = SIZE_FOR[b.style] || 11;
      const lead = LEAD_FOR[b.style] || 13.8;
      const display = b.style === "bullet" ? `\u2022 ${b.text}` : b.text;
      const pieces = wrapLine(display, size);
      const gap = pieces.length && pages[pages.length - 1].length ? (GAP_BEFORE[b.style] || 0) : 0;
      if (y - gap - lead < PAGE.bottom && pages[pages.length - 1].length) { pages.push([]); y = PAGE.top; }
      y -= gap;
      for (const piece of pieces) {
        if (y - lead < PAGE.bottom && pages[pages.length - 1].length) { pages.push([]); y = PAGE.top; }
        y -= lead;
        pages[pages.length - 1].push({ text: piece, font: FONT_FOR[b.style] || "F1", size, x: PAGE.margin, y: Math.round(y * 100) / 100 });
      }
    }
    return pages;
  }
  function renderPdf(input) {
    const { resume, refusal } = refusedCheck(input);
    if (refusal) return { ...refusal, contentType: PDF_CONTENT_TYPE };
    if (!zlib) return { ok: false, refused: false, reason: "zlib is unavailable in this runtime; PDF rendering needs Node", buffer: null, contentType: PDF_CONTENT_TYPE, filename: null };
    const blocks = toBlocks(resume);
    if (!blocks.length) return { ok: false, refused: true, reason: "resume has no renderable lines", buffer: null, contentType: PDF_CONTENT_TYPE, filename: null };
    const unencodable = [];
    const pages = paginate(blocks);
    const objects = []; // [id, Bytes]
    const pageIds = pages.map((_, i) => 5 + i * 2);
    const contentIds = pages.map((_, i) => 6 + i * 2);
    objects.push([1, Bytes.from("<< /Type /Catalog /Pages 2 0 R >>")]);
    objects.push([2, Bytes.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`)]);
    objects.push([3, Bytes.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")]);
    objects.push([4, Bytes.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")]);
    pages.forEach((lines, i) => {
      objects.push([pageIds[i], Bytes.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentIds[i]} 0 R >>`)]);
      const ops = lines.map((l) => `BT /${l.font} ${l.size} Tf 1 0 0 1 ${l.x} ${l.y} Tm ${pdfLiteral(encodeWinAnsi(l.text, unencodable))} Tj ET`).join("\n");
      const stream = zlib.deflateSync(Bytes.from(ops, "latin1"));
      const head = Bytes.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1");
      objects.push([contentIds[i], Bytes.concat([head, stream, Bytes.from("\nendstream", "latin1")])]);
    });
    objects.sort((a, b) => a[0] - b[0]);
    const chunks = [Bytes.from("%PDF-1.4\n", "latin1")];
    const offsets = new Map();
    let pos = chunks[0].length;
    for (const [id, body] of objects) {
      const head = Bytes.from(`${id} 0 obj\n`, "latin1");
      const tail = Bytes.from("\nendobj\n", "latin1");
      offsets.set(id, pos);
      chunks.push(head, body, tail);
      pos += head.length + body.length + tail.length;
    }
    const xrefPos = pos;
    const maxId = Math.max(...objects.map(([id]) => id));
    let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= maxId; id++) xref += `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    chunks.push(Bytes.from(xref, "latin1"));
    const buffer = Bytes.concat(chunks);
    return { ok: true, buffer, contentType: PDF_CONTENT_TYPE, filename: filenameFor(resume.header && resume.header.name, "pdf"), bytes: buffer.length, pages: pages.length, unencodable };
  }

  // ================= PDF extraction — parser A (content-stream operators) =================
  function pdfStreams(buf) {
    const streams = [];
    let total = 0;
    const s = buf.toString("latin1");
    let idx = 0;
    while (true) {
      const st = s.indexOf("stream", idx);
      if (st < 0) break;
      let start = st + 6;
      if (s[start] === "\r" && s[start + 1] === "\n") start += 2; else if (s[start] === "\n") start += 1;
      const en = s.indexOf("endstream", start);
      if (en < 0) break;
      const raw = buf.subarray(start, en);
      // FEATURE 16: each stream to at most PART_MAX, all of them to TOTAL_MAX, at most MAX_STREAMS of them; one past a cap
      // is left out, never inflated whole.
      const room = Math.min(PART_MAX, TOTAL_MAX - total);
      if (room <= 0 || streams.length >= MAX_STREAMS) break;
      try { const out = zlib.inflateSync(raw, { maxOutputLength: room }); streams.push(out); total += out.length; } catch { total += room; /* not a flate stream, or past the cap: charged what it could cost; parser B still scans it raw */ }
      idx = en + 9;
    }
    return streams;
  }
  function readPdfLiteral(s, i) {
    // s[i] === '(' ; returns [decodedString, nextIndex]
    const bytes = [];
    let depth = 1; i++;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === "\\") {
        const n = s[i + 1];
        if (n >= "0" && n <= "7") { let oct = n; let j = i + 1; while (j < i + 3 && s[j + 1] >= "0" && s[j + 1] <= "7") { j++; oct += s[j]; } bytes.push(parseInt(oct, 8)); i = j + 1; }
        else if (n === "n") { bytes.push(10); i += 2; } else if (n === "r") { bytes.push(13); i += 2; }
        else if (n === "t") { bytes.push(9); i += 2; } else if (n === "(") { bytes.push(40); i += 2; }
        else if (n === ")") { bytes.push(41); i += 2; } else if (n === "\\") { bytes.push(92); i += 2; }
        else if (n === "\n") { i += 2; } else if (n === "\r") { i += 2; if (s[i] === "\n") i++; }
        else { bytes.push(s.charCodeAt(i + 1) & 0xff); i += 2; }
      } else if (c === "(") { depth++; bytes.push(40); i++; }
      else if (c === ")") { depth--; if (depth > 0) bytes.push(41); i++; }
      else { bytes.push(s.charCodeAt(i) & 0xff); i++; }
    }
    return [decodeWinAnsi(Bytes.from(bytes)), i];
  }
  // Full operator walk: returns [{ text, x, y, size, font, page }] in
  // reading order (page order, then y descending, then x ascending).
  function extractPdfRuns(buf) {
    const runs = [];
    if (!Bytes.isBuffer(buf) || !zlib) return runs;
    const streams = pdfStreams(buf);
    streams.forEach((streamBuf, page) => {
      const s = streamBuf.toString("latin1");
      let font = null, size = 0, x = 0, y = 0, pendingText = null;
      let i = 0;
      const numBefore = (pos) => { const m = s.slice(Math.max(0, pos - 40), pos).match(/(-?[\d.]+)\s*(-?[\d.]+)\s*$/); return m ? [parseFloat(m[1]), parseFloat(m[2])] : null; };
      while (i < s.length) {
        const c = s[i];
        if (c === "(") { const [txt, ni] = readPdfLiteral(s, i); pendingText = txt; i = ni; continue; }
        if (c === "/" ) { const m = s.slice(i).match(/^\/(\S+)\s+([\d.]+)\s+Tf/); if (m) { font = m[1]; size = parseFloat(m[2]); i += m[0].length; continue; } i++; continue; }
        if (s.startsWith("Tj", i) || s.startsWith("TJ", i) || s.startsWith("'", i) || s.startsWith('"', i)) {
          if (pendingText !== null && pendingText !== "") runs.push({ text: pendingText, x, y, size, font, page });
          pendingText = null; i += 2; continue;
        }
        if (s.startsWith("Tm", i)) { const nums = s.slice(Math.max(0, i - 60), i).match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/); if (nums) { x = parseFloat(nums[5]); y = parseFloat(nums[6]); } i += 2; continue; }
        if (s.startsWith("Td", i) || s.startsWith("TD", i)) { const pair = numBefore(i); if (pair) { x += pair[0]; y += pair[1]; } i += 2; continue; }
        i++;
      }
    });
    return runs.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  }
  const extractPdfLines = (buf) => extractPdfRuns(buf).map((r) => r.text);
  // Parser B: raw string scan of every inflated stream, operator-blind.
  function extractPdfStrings(buf) {
    const out = [];
    if (!Bytes.isBuffer(buf) || !zlib) return out;
    for (const streamBuf of pdfStreams(buf)) {
      const s = streamBuf.toString("latin1");
      let i = 0;
      while (i < s.length) {
        if (s[i] === "(") { const [txt, ni] = readPdfLiteral(s, i); if (txt.trim()) out.push(txt); i = ni; }
        else i++;
      }
    }
    return out;
  }
  function pdfStructure(buf) {
    const s = Bytes.isBuffer(buf) ? buf.toString("latin1") : "";
    const fonts = [...new Set([...s.matchAll(/\/BaseFont\s*\/([A-Za-z0-9-]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, "")))];
    const images = (s.match(/\/Subtype\s*\/Image/g) || []).length;
    const pages = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
    const runs = extractPdfRuns(buf);
    const sizes = [...new Set(runs.map((r) => r.size).filter(Boolean))].sort((a, b) => a - b);
    const xs = [...new Set(runs.map((r) => Math.round(r.x)))];
    return { bytes: Bytes.isBuffer(buf) ? buf.length : 0, pages, fonts, fontSizesPt: sizes, images, singleColumn: runs.length > 0 && xs.every((x) => x <= 100), headings: [] };
  }
  // External parser B (poppler) — used when the caller opts in.
  function extractPdfPoppler(buf) {
    if (!cp || !fs || !os) return null;
    const tmp = `${os.tmpdir()}/ca02-poppler-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`;
    try {
      fs.writeFileSync(tmp, buf);
      const out = cp.execFileSync("pdftotext", [tmp, "-"], { encoding: "utf8", timeout: 15000 });
      return out.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
    } catch { return null; } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  }

  // ================= DOCX extraction — parser A (paragraph walk) =================
  function unescXml(s) {
    return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  function extractDocxLines(buf) {
    const xmlBuf = docxPart(buf, "word/document.xml");
    if (!xmlBuf) return [];
    const xml = xmlBuf.toString("utf8");
    const lines = [];
    for (const pm of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
      const runs = [...pm[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unescXml(m[1]));
      const text = runs.join("");
      if (text.trim()) lines.push(text);
    }
    return lines;
  }
  // Parser B: independent regex scan of every <w:t> run in document order,
  // grouped by paragraph end tags — shares no code path with parser A's
  // block iteration beyond the ZIP reader.
  function extractDocxRuns(buf) {
    const xmlBuf = docxPart(buf, "word/document.xml");
    if (!xmlBuf) return [];
    const xml = xmlBuf.toString("utf8");
    const lines = [];
    const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>/g;
    let cur = "";
    let m;
    while ((m = tokenRe.exec(xml))) {
      if (m[1] !== undefined) cur += unescXml(m[1]);
      else { if (cur.trim()) lines.push(cur); cur = ""; }
    }
    if (cur.trim()) lines.push(cur);
    return lines;
  }
  function docxStructure(buf) {
    const parts = unzipParts(buf, (n) => n === "word/document.xml" || n === "word/styles.xml");
    const names = [...unzipParts(buf, null, true).keys()];
    const docXml = (parts.get("word/document.xml") || Bytes.alloc(0)).toString("utf8");
    const stylesXml = (parts.get("word/styles.xml") || Bytes.alloc(0)).toString("utf8");
    const fonts = [...new Set([...stylesXml.matchAll(/w:ascii="([^"]+)"/g)].map((m) => m[1]))];
    const sizes = [...new Set([...stylesXml.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => parseInt(m[1], 10) / 2))].sort((a, b) => a - b);
    const mediaParts = names.filter((k) => k.startsWith("word/media/")).length;
    const images = mediaParts + (docXml.match(/<w:drawing|<a:blip|<w:pict/g) || []).length;
    const tables = (docXml.match(/<w:tbl[\s>]/g) || []).length;
    const textFrames = (docXml.match(/txbxContent/g) || []).length;
    const headerFooterParts = names.filter((k) => /word\/(header|footer)\d*\.xml/.test(k)).length;
    return { bytes: Bytes.isBuffer(buf) ? buf.length : 0, fonts, fontSizesPt: sizes, images, tables, textFrames, headerFooterParts, headings: [] };
  }
  // External parser B (python-docx) — used when the caller opts in.
  function extractDocxPython(buf) {
    if (!cp || !fs || !os) return null;
    const tmp = `${os.tmpdir()}/ca02-pydocx-${process.pid}-${Math.random().toString(36).slice(2)}.docx`;
    try {
      fs.writeFileSync(tmp, buf);
      const out = cp.execFileSync("python3", ["-c", "import docx,sys; d=docx.Document(sys.argv[1]); print('\\n'.join(p.text for p in d.paragraphs))", tmp], { encoding: "utf8", timeout: 15000 });
      return out.split(/\r?\n/).filter((l) => l.trim());
    } catch { return null; } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  }

  // ================= parse-check (Spec 3 §2.5) =================
  // Normalisation for extraction diffs: whitespace is collapsed and
  // spaces adjacent to punctuation are dropped — real parsers (poppler
  // included) disagree on glyph-gap spacing around punctuation, and that
  // is not a content difference. Word-internal spaces are preserved.
  const normLine = (s) => String(s || "").replace(/\u2022/g, " ").replace(/\s+/g, " ").trim().toLowerCase().replace(/\s*([^\p{L}\p{N}\s])\s*/gu, "$1");
  const normSeq = (lines) => (lines || []).map(normLine).filter(Boolean);
  const yearOfStr = (v) => { const m = String(v == null ? "" : v).match(/\d{4}/); return m ? m[0] : null; };
  const PLACEHOLDER_PATTERNS = [
    { re: /\bfirst last\b/i, label: '"First Last"' }, { re: /\bcompany\s*\d+\b/i, label: '"Company N"' },
    { re: /\bany company\b/i, label: '"Any Company"' }, { re: /\byour name\b/i, label: '"Your Name"' },
    { re: /\bjohn doe\b|\bjane doe\b/i, label: '"John/Jane Doe"' }, { re: /lorem/i, label: "lorem ipsum" },
    { re: /\[[^\]]{1,40}\]/, label: "bracketed placeholder [..]" }, { re: /\bTBD\b/, label: "TBD" },
    { re: /\bXXX+\b/, label: "XXX" }, { re: /placeholder/i, label: "the word 'placeholder'" },
  ];
  const NUMERIC_DATE_RES = [/\b\d{1,2}\/\d{4}\b/g, /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, /\b\d{4}-\d{2}(?:-\d{2})?\b/g, /\b\d{1,2}-\d{4}\b/g];
  function diffSequences(expected, actual) {
    // returns { missing:[], extra:[], moved:bool }
    const exp = [...expected], act = [...actual];
    const actCount = new Map(); for (const l of act) actCount.set(l, (actCount.get(l) || 0) + 1);
    const missing = [];
    for (const l of exp) { if (actCount.get(l) > 0) actCount.set(l, actCount.get(l) - 1); else missing.push(l); }
    const expCount = new Map(); for (const l of exp) expCount.set(l, (expCount.get(l) || 0) + 1);
    const extra = [];
    for (const l of act) { if (expCount.get(l) > 0) expCount.set(l, expCount.get(l) - 1); else extra.push(l); }
    const sameMultiset = missing.length === 0 && extra.length === 0;
    const sameOrder = sameMultiset && exp.length === act.length && exp.every((l, i) => l === act[i]);
    return { missing, extra, moved: sameMultiset && !sameOrder };
  }
  function parseCheck(input, opts) {
    const o = opts || {};
    const inp = input || {};
    const resume = inp.resume || null;
    const expected = resume ? sourceLines(resume) : (inp.sourceLines || null);
    const expectedNorm = expected ? normSeq(expected.map((l) => l.text)) : null;
    const expectedLayoutNorm = resume ? normSeq(layoutLines(resume).map((l) => l.text)) : expectedNorm;
    const expectedHeadings = expected ? expected.filter((l) => l.kind === "heading").map((l) => l.text.toUpperCase()) : null;
    const email = resume && resume.header && resume.header.email ? String(resume.header.email) : null;
    const reasons = [];
    const checks = {};
    const formats = {};
    const add = (check, level, detail) => reasons.push({ check, level, detail });

    // BUG-2026-10-14-NDER (brief B6): two source-level FAILs.
    // (1) duplicate_line — a content line belongs in exactly one section;
    //     the same normalized line twice in the source document fails.
    // (2) missing_dates — an entry whose cited fact carries start/end
    //     dates must render them. Fact-aware: runs only when the caller
    //     threads the profile in (123's render path does); skipped
    //     otherwise, so profile-free callers see no behavior change.
    if (expected) {
      const seenLine = new Set();
      for (const l of expected) {
        if (l.kind === "heading") continue;
        const k = normLine(l.text);
        if (!k) continue;
        if (seenLine.has(k)) add("duplicate_line", "fail", `the same line appears more than once in the document: "${String(l.text).slice(0, 80)}" — a line belongs in exactly one section`);
        else seenLine.add(k);
      }
    }
    // BUG-210 (enforcement half): a SKILLS section that is PRESENT but
    // whose body carries no alphanumeric skill token (empty, or
    // punctuation-only like ", , ") is a content-empty document wearing a
    // valid format — it must FAIL, not pass. The honest shapes are a
    // skills body naming proven skills, or no SKILLS section at all.
    // MI-024 (Depth Lane C): the floor is every section, not SKILLS
    // alone — the original audit's defect class was "a present section
    // with no content passes parse-check", and a punctuation-only
    // EXPERIENCE or EDUCATION body is the same shipped defect in a
    // different heading. The SKILLS check keeps its name (pinned by
    // BUG-210's guard); every other heading fails as empty_section.
    if (resume) {
      const secs = (Array.isArray(resume.sections) && resume.sections.length) ? resume.sections
        : (() => { const grouped = new Map(); for (const l of resume.lines || []) { const h = l.section || ""; if (!grouped.has(h)) grouped.set(h, { heading: h, lines: [] }); grouped.get(h).lines.push(l); } return [...grouped.values()]; })();
      for (const s of secs) {
        if (!s) continue;
        const heading = String(s.heading || "").toUpperCase();
        const body = (s.lines || []).map((l) => String((l && l.text) || "")).join(" ").replace(/technical skills:/i, "");
        if (/[a-z0-9]/i.test(body)) continue;
        if (heading === "SKILLS") add("empty_skills_section", "fail", `SKILLS section is present but its body names no skill (body: "${body.trim().slice(0, 40) || "(empty)"}") — a present-but-empty skills section fails; omit the section or list proven skills`);
        else if (heading) add("empty_section", "fail", `${heading} section is present but its body carries no content (body: "${body.trim().slice(0, 40) || "(empty)"}") — a present-but-empty section fails; omit the section or fill it from the record`);
      }
    }
    const profIn = inp.profile || o.profile || null;
    if (profIn && resume) {
      const factsById = new Map((profIn.facts || []).map((f) => [f.id, f]));
      const docLines = (resume.sections || []).length ? (resume.sections || []).flatMap((s) => s.lines || []) : (resume.lines || []);
      for (const l of docLines) {
        if (!l || l.type !== "entry") continue;
        const fact = (l.factIds || []).map((id) => factsById.get(id)).find((f) => f && (f.start || f.end));
        if (!fact) continue;
        const sy = yearOfStr(fact.start), ey = yearOfStr(fact.end);
        const missing = [];
        if (sy && !String(l.text).includes(sy)) missing.push(sy);
        if (/^present$/i.test(String(fact.end || "").trim())) { if (!/present/i.test(String(l.text))) missing.push("Present"); }
        else if (ey && ey !== sy && !String(l.text).includes(ey)) missing.push(ey);
        if (missing.length) add("missing_dates", "fail", `entry "${String(l.text).slice(0, 60)}" drops the date(s) ${missing.join(", ")} held by its fact (${fact.id}) — a dated entry renders its range`);
      }
    }

    const checkFormat = (fmt, buf, extractA, extractB, struct, expectedForFmt) => {
      if (!buf) return;
      const st = struct(buf);
      checks[fmt] = st;
      if (st.bytes > 2_500_000) add("file_size", "fail", `${fmt} is ${st.bytes} bytes — Greenhouse cannot parse files over 2.5MB (Spec 3 §2.1)`);
      else if (st.bytes > 1_000_000) add("file_size", "warn", `${fmt} is ${st.bytes} bytes — over the R8 1MB guidance`);
      if (fmt === "pdf") {
        if (st.images > 0) add("images", "fail", `PDF contains ${st.images} image XObject(s) — R2: real text, never an image`);
        if (!st.singleColumn) add("single_column", "fail", "PDF text does not start in a single column — R1");
        const badFonts = st.fonts.filter((f) => !["Helvetica", "Helvetica-Bold", "Times-Roman", "Times-Bold", "Courier", "Courier-Bold"].includes(f));
        if (badFonts.length) add("fonts", "fail", `non-standard PDF font(s): ${badFonts.join(", ")} — R6`);
        const badSizes = st.fontSizesPt.filter((s) => s < 10 || s > 12);
        if (badSizes.length) add("fonts", "fail", `PDF font size(s) outside 10–12pt: ${badSizes.join(", ")} — R6`);
        if (o.pageLimit && st.pages > o.pageLimit) add("page_count", "warn", `PDF runs ${st.pages} pages; this role family's limit is ${o.pageLimit} (123 conventions)`);
      } else {
        if (st.images > 0) add("images", "fail", `DOCX contains ${st.images} image/media part(s) — R2`);
        if (st.tables > 0) add("tables", "fail", `DOCX uses ${st.tables} layout table(s) — R1: no layout tables`);
        if (st.textFrames > 0) add("text_frames", "fail", `DOCX contains ${st.textFrames} text frame(s) — R1: no text boxes/frames`);
        if (st.headerFooterParts > 0) add("contact_in_body", "warn", `DOCX has ${st.headerFooterParts} header/footer part(s); contact info belongs in the body — R4`);
        const badSizes = st.fontSizesPt.filter((s) => s < 10 || s > 12);
        if (badSizes.length) add("fonts", "fail", `DOCX font size(s) outside 10–12pt: ${badSizes.join(", ")} — R6`);
      }
      const aLines = extractA(buf);
      let bLines = extractB(buf);
      let bName = fmt === "pdf" ? "in-repo string scan" : "in-repo run scan";
      if (o.useExternalParsers) {
        const ext = fmt === "pdf" ? extractPdfPoppler(buf) : extractDocxPython(buf);
        if (ext) { bLines = ext; bName = fmt === "pdf" ? "poppler pdftotext" : "python-docx"; }
        else add("second_parser", "warn", `external second parser for ${fmt} unavailable in this runtime; in-repo fallback used`);
      }
      const aNorm = normSeq(aLines), bNorm = normSeq(bLines);
      formats[fmt] = { parsers: 2, parserA: fmt === "pdf" ? "in-repo content-stream operators" : "in-repo paragraph walk", parserB: bName, bytes: st.bytes, ...(fmt === "pdf" ? { pages: st.pages } : {}) };
      const ab = diffSequences(aNorm, bNorm);
      if (ab.missing.length || ab.extra.length) add("parser_disagreement", "fail", `${fmt}: the two parsers disagree (A-only: ${ab.missing.slice(0, 2).join(" | ") || "none"}; B-only: ${ab.extra.slice(0, 2).join(" | ") || "none"})`);
      else if (ab.moved) add("parser_disagreement", "warn", `${fmt}: the two parsers recover the same lines in a different order`);
      if (expectedForFmt) {
        const d = diffSequences(expectedForFmt, aNorm);
        if (d.missing.length) add("missing_content", "fail", `${fmt}: ${d.missing.length} source line(s) missing from the file, first: "${d.missing[0].slice(0, 80)}"`);
        if (d.extra.length) add("extra_content", "fail", `${fmt}: ${d.extra.length} line(s) in the file are not in the source, first: "${d.extra[0].slice(0, 80)}"`);
        if (d.moved) add("reading_order", "warn", `${fmt}: all source lines are present but the reading order differs from the source JSON`);
        checks[fmt].headings = expectedHeadings ? aNorm.map((l) => l.toUpperCase()).filter((l) => expectedHeadings.includes(l)) : [];
        if (expectedHeadings) {
          const bad = checks[fmt].headings.filter((h) => !HEADING_ALLOWLIST.includes(h));
          if (bad.length) add("heading_allowlist", "fail", `${fmt}: non-standard heading(s): ${[...new Set(bad)].join(", ")} — R3`);
        }
        if (email && !aNorm.some((l) => l.includes(email.toLowerCase()))) add("contact_in_body", "fail", `${fmt}: the contact email is not in the extracted body text — R4`);
      }
      // Placeholder + date scans run on extracted text whenever we have it.
      const joined = aLines.join("\n");
      for (const p of PLACEHOLDER_PATTERNS) if (p.re.test(joined)) add("placeholder", "fail", `${fmt}: placeholder data found (${p.label}) — R11: Greenhouse's parser skips placeholders; never submit them`);
      const numericDates = new Set();
      for (const re of NUMERIC_DATE_RES) for (const m of joined.matchAll(re)) numericDates.add(m[0]);
      if (numericDates.size) add("date_format", "warn", `${fmt}: date(s) not in the single 'Mon YYYY' format (R7): ${[...numericDates].slice(0, 5).join(", ")}`);
    };

    checkFormat("pdf", inp.pdf || null, extractPdfLines, extractPdfStrings, pdfStructure, expectedLayoutNorm);
    checkFormat("docx", inp.docx || null, extractDocxLines, extractDocxRuns, docxStructure, expectedNorm);
    if (!inp.pdf && !inp.docx) add("no_files", "fail", "no rendered file was supplied to check");
    const status = reasons.some((r) => r.level === "fail") ? "FAIL" : reasons.some((r) => r.level === "warn") ? "WARN" : "PASS";
    return { status, reasons, checks, formats };
  }

  const sha256 = (buf) => (crypto ? crypto.createHash("sha256").update(buf).digest("hex") : null);
  function artifact(format, rendered) {
    if (!rendered || !rendered.ok) return null;
    return { format, filename: rendered.filename, contentType: rendered.contentType, bytes: rendered.buffer.length, sha256: sha256(rendered.buffer), base64: rendered.buffer.toString("base64") };
  }

  const runtime = { zlib: !!rt.zlib, crypto: !!rt.crypto, Buffer: !!Buffer, codec: rt.zlib && rt.crypto ? "platform" : zlib && crypto ? "vendored" : "none" };
  return { renderPdf, renderDocx, parseCheck, sourceLines, layoutLines, filenameFor, extractPdfLines, extractPdfStrings, extractPdfRuns, extractPdfPoppler, extractDocxLines, extractDocxRuns, extractDocxPython, docxPart, docxPartNames, rebuildDocx, artifact, sha256, crc32, PDF_CONTENT_TYPE, DOCX_CONTENT_TYPE, HEADING_ALLOWLIST, runtime, toBuffer: (bytes) => (Buffer ? Buffer.from(bytes) : null), withRuntime: (r) => make({ ...NODE_RUNTIME, ...(r || {}) }) };
  }
  return make(NODE_RUNTIME);
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerRender;
