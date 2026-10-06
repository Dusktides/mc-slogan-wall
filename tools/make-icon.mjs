/**
 * 生成应用图标 assets/icon.ico（红底白字，与工具产出的标语墙同款配色）。
 *
 * 优先用 Unifont 的「标」字，其次用 Mojangles 的「M」，都没有就画个砖块图案。
 * 纯 Node 实现：自写 PNG 编码器 + ICO 封装，无第三方依赖。
 *
 * 用法：node tools/make-icon.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, deflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const BG = [0x8e, 0x21, 0x21]   // minecraft:red_concrete
const FG = [0xcf, 0xd5, 0xd6]   // minecraft:white_concrete

/* ---------------- 取字形 ---------------- */
/** 返回 16x16 的布尔矩阵，或 null */
function loadUnifontGlyph (cp) {
  const p = join(ROOT, 'data', 'glyphs', 'unifont.bin.gz')
  if (!existsSync(p)) return null
  const buf = gunzipSync(readFileSync(p))
  const count = buf.readUInt32LE(5)
  const cpStart = 9
  const bitsStart = cpStart + count * 4 + count
  let lo = 0
  let hi = count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = buf.readUInt32LE(cpStart + mid * 4)
    if (v === cp) {
      const off = bitsStart + mid * 32
      return [0, 1, 2, 3].map(() => 0) && grid16(buf.subarray(off, off + 32))
    }
    if (v < cp) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

function grid16 (bytes) {
  const g = []
  for (let y = 0; y < 16; y++) {
    const row = []
    for (let x = 0; x < 16; x++) {
      row.push((bytes[y * 2 + (x >> 3)] & (0x80 >> (x & 7))) !== 0)
    }
    g.push(row)
  }
  return g
}

/** Mojangles 8x8 字形放大成 16x16 */
function loadMojanglesGlyph (ch) {
  const p = join(ROOT, 'data', 'glyphs', 'mojangles.json')
  if (!existsSync(p)) return null
  const data = JSON.parse(readFileSync(p, 'utf8'))
  const g = data.glyphs[ch.codePointAt(0)]
  if (!g) return null
  const sheet = data.sheets[g.s]
  const rowBytes = Math.ceil(sheet.cellW / 8)
  const src = Buffer.from(g.bits, 'hex')
  const out = []
  for (let y = 0; y < 16; y++) {
    const row = []
    for (let x = 0; x < 16; x++) {
      const sy = y >> 1
      const sx = x >> 1
      row.push((src[sy * rowBytes + (sx >> 3)] & (0x80 >> (sx & 7))) !== 0)
    }
    out.push(row)
  }
  return out
}

/** 兜底：砖块图案 */
function brickPattern () {
  const out = []
  for (let y = 0; y < 16; y++) {
    const row = []
    for (let x = 0; x < 16; x++) {
      const mortar = y % 8 === 0 || (x + (y < 8 ? 0 : 8)) % 8 === 0
      row.push(!mortar)
    }
    out.push(row)
  }
  return out
}

let glyph = loadUnifontGlyph('标'.codePointAt(0))
let source = 'Unifont 标'
if (!glyph) {
  glyph = loadMojanglesGlyph('M')
  source = 'Mojangles M'
}
if (!glyph) {
  glyph = brickPattern()
  source = '内置砖块图案'
}
console.log(`图标字形来源：${source}`)

/* ---------------- 合成 20x20 基础图（2 像素红边 + 16 像素字） ---------------- */
const BASE = 20
const base = []
for (let y = 0; y < BASE; y++) {
  const row = []
  for (let x = 0; x < BASE; x++) {
    const inside = x >= 2 && x < 18 && y >= 2 && y < 18
    const on = inside && glyph[y - 2][x - 2]
    row.push(on ? FG : BG)
  }
  base.push(row)
}

/** 最近邻放大到 size×size */
function scale (size) {
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sy = Math.min(BASE - 1, Math.floor((y * BASE) / size))
      const sx = Math.min(BASE - 1, Math.floor((x * BASE) / size))
      const [r, g, b] = base[sy][sx]
      const o = (y * size + x) * 4
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255
    }
  }
  return px
}

/* ---------------- 最小 PNG 编码器 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng (size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------------- 封装 ICO ---------------- */
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const images = SIZES.map((s) => ({ size: s, png: encodePng(s, scale(s)) }))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // ICO
header.writeUInt16LE(images.length, 4)

let offset = 6 + images.length * 16
const entries = []
for (const img of images) {
  const e = Buffer.alloc(16)
  e[0] = img.size >= 256 ? 0 : img.size
  e[1] = img.size >= 256 ? 0 : img.size
  e[2] = 0 // palette
  e[3] = 0
  e.writeUInt16LE(1, 4)   // planes
  e.writeUInt16LE(32, 6)  // bpp
  e.writeUInt32LE(img.png.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += img.png.length
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
mkdirSync(join(ROOT, 'assets'), { recursive: true })
const outPath = join(ROOT, 'assets', 'icon.ico')
writeFileSync(outPath, ico)
console.log(`已生成：${outPath}（${SIZES.join('/')} 共 ${(ico.length / 1024).toFixed(1)} KB）`)
