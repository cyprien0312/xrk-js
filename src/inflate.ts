// Minimal pure-TypeScript zlib/DEFLATE decompressor (RFC 1950/1951).
//
// Used to decompress XRZ files (zlib-wrapped XRK). Deliberately dependency-free
// so the library runs unchanged in browsers and Node. Mirrors libxrk's
// truncation behavior: if the stream is corrupt or cut short, the bytes
// decoded so far are returned instead of throwing (some XRZ files come from
// interrupted logging sessions).

const MAX_BITS = 15;

class BitReader {
  pos: number; // byte position
  bitBuf = 0;
  bitCnt = 0;

  constructor(
    readonly data: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }

  /** Read `need` bits LSB-first. Throws RangeError at end of input. */
  bits(need: number): number {
    let val = this.bitBuf;
    while (this.bitCnt < need) {
      if (this.pos >= this.data.length) throw new RangeError("out of input");
      val |= this.data[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    this.bitBuf = val >>> need;
    this.bitCnt -= need;
    return val & ((1 << need) - 1);
  }

  alignByte(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
}

interface Huffman {
  counts: Int32Array; // number of codes of each length
  symbols: Int32Array; // symbols ordered by code
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Int32Array(MAX_BITS + 1);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Int32Array(MAX_BITS + 1);
  for (let len = 1; len <= MAX_BITS; len++) offs[len] = offs[len - 1] + counts[len - 1];
  const symbols = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  }
  return { counts, symbols };
}

function decodeSym(br: BitReader, huff: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= br.bits(1);
    const count = huff.counts[len];
    if (code - first < count) return huff.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("invalid huffman code");
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class Output {
  buf: Uint8Array;
  len = 0;

  constructor(hint: number) {
    this.buf = new Uint8Array(Math.max(hint, 64 * 1024));
  }

  ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  copy(dist: number, length: number): void {
    if (dist > this.len) throw new Error("distance too far back");
    this.ensure(length);
    let from = this.len - dist;
    for (let i = 0; i < length; i++) this.buf[this.len++] = this.buf[from++];
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

let FIXED_LIT: Huffman | null = null;
let FIXED_DIST: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (!FIXED_LIT) {
    const litLens = new Uint8Array(288);
    litLens.fill(8, 0, 144);
    litLens.fill(9, 144, 256);
    litLens.fill(7, 256, 280);
    litLens.fill(8, 280, 288);
    FIXED_LIT = buildHuffman(litLens, 288);
    const distLens = new Uint8Array(30).fill(5);
    FIXED_DIST = buildHuffman(distLens, 30);
  }
  return [FIXED_LIT, FIXED_DIST!];
}

function inflateBlockData(br: BitReader, out: Output, lit: Huffman, dist: Huffman): void {
  for (;;) {
    const sym = decodeSym(br, lit);
    if (sym < 256) {
      out.byte(sym);
    } else if (sym === 256) {
      return; // end of block
    } else {
      const li = sym - 257;
      if (li >= LEN_BASE.length) throw new Error("invalid length symbol");
      const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
      const dsym = decodeSym(br, dist);
      if (dsym >= DIST_BASE.length) throw new Error("invalid distance symbol");
      const distance = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
      out.copy(distance, length);
    }
  }
}

function dynamicTables(br: BitReader): [Huffman, Huffman] {
  const hlit = br.bits(5) + 257;
  const hdist = br.bits(5) + 1;
  const hclen = br.bits(4) + 4;
  const clens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = br.bits(3);
  const clHuff = buildHuffman(clens, 19);

  const lengths = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < hlit + hdist) {
    const sym = decodeSym(br, clHuff);
    if (sym < 16) {
      lengths[i++] = sym;
    } else if (sym === 16) {
      if (i === 0) throw new Error("repeat with no previous length");
      const prev = lengths[i - 1];
      let rep = 3 + br.bits(2);
      while (rep-- && i < hlit + hdist) lengths[i++] = prev;
    } else if (sym === 17) {
      let rep = 3 + br.bits(3);
      while (rep-- && i < hlit + hdist) lengths[i++] = 0;
    } else {
      let rep = 11 + br.bits(7);
      while (rep-- && i < hlit + hdist) lengths[i++] = 0;
    }
  }
  return [buildHuffman(lengths, hlit), buildHuffman(lengths.subarray(hlit), hdist)];
}

/**
 * Inflate a raw DEFLATE stream starting at `start`. Returns all bytes decoded
 * before any error (truncated/corrupt input does not throw).
 */
export function inflateRaw(data: Uint8Array, start = 0, sizeHint = 0): Uint8Array {
  const br = new BitReader(data, start);
  const out = new Output(sizeHint || data.length * 4);
  try {
    let final = 0;
    do {
      final = br.bits(1);
      const type = br.bits(2);
      if (type === 0) {
        // stored block
        br.alignByte();
        if (br.pos + 4 > data.length) throw new RangeError("out of input");
        const len = data[br.pos] | (data[br.pos + 1] << 8);
        const nlen = data[br.pos + 2] | (data[br.pos + 3] << 8);
        if ((len ^ 0xffff) !== nlen) throw new Error("stored block length mismatch");
        br.pos += 4;
        if (br.pos + len > data.length) throw new RangeError("out of input");
        out.ensure(len);
        out.buf.set(data.subarray(br.pos, br.pos + len), out.len);
        out.len += len;
        br.pos += len;
      } else if (type === 1) {
        const [lit, dist] = fixedTables();
        inflateBlockData(br, out, lit, dist);
      } else if (type === 2) {
        const [lit, dist] = dynamicTables(br);
        inflateBlockData(br, out, lit, dist);
      } else {
        throw new Error("invalid block type");
      }
    } while (!final);
  } catch {
    // Truncated or corrupt stream — return what we decoded (libxrk parity).
  }
  return out.result();
}

/** True when the buffer starts with a zlib header (XRZ signature). */
export function isZlib(data: Uint8Array): boolean {
  return (
    data.length >= 2 &&
    data[0] === 0x78 &&
    (data[1] === 0x01 || data[1] === 0x9c || data[1] === 0xda)
  );
}

/** Decompress XRZ (zlib) data if detected; otherwise return the input as-is. */
export function decompressIfZlib(data: Uint8Array): Uint8Array {
  if (!isZlib(data)) return data;
  // Skip the 2-byte zlib header; ignore the adler32 trailer (may be missing
  // on truncated files).
  return inflateRaw(data, 2, data.length * 6);
}
