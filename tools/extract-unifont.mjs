/**
 * 提取 GNU Unifont 的汉字（及中文标点）点阵，输出紧凑二进制 + 元数据。
 *
 * 依据（26.3 客户端字节码实测）：
 *   UnihexProvider$Glyph：16 宽 16 高、oversample = 2，
 *     getAdvance() = width()/2 + 1            // 全宽汉字 = 16/2+1 = 9
 *     GlyphBitmap.getTop() = 7 - bearingTop(=7) = 0，getBottom() = 16
 *   即：游戏内汉字与拉丁字母占同一个 8x8 视觉格（2:1 降采样）。
 *   本工具按【原生 16x16 点阵】取样（方块墙需要可读性），并在 layout 里统一基线。
 *
 * 用法：node tools/extract-unifont.mjs [--url <hex.gz 地址>]
 * 产出：data/glyphs/unifont.bin.gz + data/glyphs/unifont.json
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DATA_DIR = join(ROOT, 'data', 'glyphs')
const CACHE = join(ROOT, 'tmp', 'unifont.hex.gz')

/** 需要的码位范围（覆盖中文标语常见字符） */
const RANGES = [
  [0x3000, 0x303f, 'CJK 标点'],
  [0x3400, 0x4dbf, 'CJK 扩展 A'],
  [0x4e00, 0x9fff, 'CJK 统一表意文字'],
  [0xf900, 0xfaff, 'CJK 兼容表意文字'],
  [0xfe10, 0xfe1f, '竖排标点'],
  [0xfe30, 0xfe4f, 'CJK 兼容形式'],
  [0xff01, 0xff60, '全角 ASCII'],
  [0xffe0, 0xffe6, '全角符号'],
  [0x2010, 0x2027, '通用标点'],
  [0x2030, 0x205e, '通用标点补充'],
  [0x2103, 0x2103, '摄氏度符号'],
  [0x2190, 0x21ff, '箭头'],
  [0x2460, 0x24ff, '带圈数字'],
  [0x25a0, 0x25ff, '几何图形'],
  [0x2600, 0x26ff, '杂项符号']
]

const inRanges = (cp) => RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */
async function discoverUrl () {
  const idx = await (await fetch('https://unifoundry.com/pub/unifont/')).text()
  const versions = [...idx.matchAll(/href="(unifont-\d+\.\d+\.\d+)\/"/g)].map((m) => m[1])
  if (versions.length === 0) throw new Error('无法从 unifoundry 索引解析版本目录')
  const newest = versions.sort((a, b) => {
    const pa = a.replace('unifont-', '').split('.').map(Number)
    const pb = b.replace('unifont-', '').split('.').map(Number)
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
    return 0
  }).at(-1)
  const builds = await (await fetch(`https://unifoundry.com/pub/unifont/${newest}/font-builds/`)).text()
  const all = [...builds.matchAll(/href="([^"]*\.hex\.gz)"/g)].map((m) => m[1])
  if (all.length === 0) throw new Error('font-builds 目录里找不到 .hex.gz')
  const plain = all.filter((f) => !/jp|csur|upper|plane|all/i.test(f))
  const pick = plain[0] ?? all[0]
  return { version: newest, url: new URL(pick, `https://unifoundry.com/pub/unifont/${newest}/font-builds/`).href }
}

let url = null
const urlIdx = process.argv.indexOf('--url')
if (urlIdx >= 0) url = process.argv[urlIdx + 1]

let sourceVersion = null
let gz
if (existsSync(CACHE) && urlIdx < 0) {
  console.log(`使用缓存：${CACHE}`)
  gz = readFileSync(CACHE)
  sourceVersion = 'cached'
} else {
  if (!url) {
    const found = await discoverUrl()
    url = found.url
    sourceVersion = found.version
    console.log(`Unifont 版本：${sourceVersion}`)
  }
  console.log(`下载：${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  gz = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(CACHE), { recursive: true })
  writeFileSync(CACHE, gz)
  console.log(`已缓存 ${(gz.length / 1024 / 1024).toFixed(2)} MB -> ${CACHE}`)
}

const text = gunzipSync(gz).toString('latin1')
console.log(`解压后 ${(text.length / 1024 / 1024).toFixed(2)} MB`)

/* ------------------------------------------------------------------ */
/* 解析 .hex：CODEPOINT:HEXDATA                                        */
/* ------------------------------------------------------------------ */
const glyphs = new Map()
let total = 0
let skipped = 0
for (const line of text.split('\n')) {
  if (!line) continue
  const colon = line.indexOf(':')
  if (colon < 0) continue
  const cp = parseInt(line.slice(0, colon), 16)
  if (!Number.isFinite(cp) || !inRanges(cp)) continue
  total++
  const hex = line.slice(colon + 1).trim()
  let bits
  let dataWidth
  if (hex.length === 32) {
    // 8x16：每行 1 字节，左对齐放入 16 宽画布
    const buf = Buffer.from(hex, 'hex')
    bits = Buffer.alloc(32)
    for (let y = 0; y < 16; y++) bits[y * 2] = buf[y]
    dataWidth = 8
  } else if (hex.length === 64) {
    bits = Buffer.from(hex, 'hex')
    dataWidth = 16
  } else {
    skipped++
    continue
  }
  glyphs.set(cp, { bits, dataWidth })
}

const codepoints = [...glyphs.keys()].sort((a, b) => a - b)
const fullWidth = codepoints.filter((cp) => glyphs.get(cp).dataWidth === 16).length
console.log(`命中范围的字形 ${codepoints.length} 个（全宽 ${fullWidth}，半宽 ${codepoints.length - fullWidth}，跳过异常行 ${skipped}）`)

/* ------------------------------------------------------------------ */
/* 打包：magic + count + codepoints(u32) + widths(u8) + bitmaps(32B)    */
/* ------------------------------------------------------------------ */
const header = Buffer.alloc(9)
header.write('MCUW1', 0, 'ascii')
header.writeUInt32LE(codepoints.length, 5)
const cpBuf = Buffer.alloc(codepoints.length * 4)
codepoints.forEach((cp, i) => cpBuf.writeUInt32LE(cp, i * 4))
const widthBuf = Buffer.from(codepoints.map((cp) => glyphs.get(cp).dataWidth))
const bitsBuf = Buffer.concat(codepoints.map((cp) => glyphs.get(cp).bits))
const packed = Buffer.concat([header, cpBuf, widthBuf, bitsBuf])
const packedGz = gzipSync(packed, { level: 9 })

mkdirSync(DATA_DIR, { recursive: true })
const binPath = join(DATA_DIR, 'unifont.bin.gz')
writeFileSync(binPath, packedGz)

const meta = {
  source: { name: 'GNU Unifont', url, version: sourceVersion, license: 'GPLv2+ with font embedding exception' },
  format: 'MCUW1: magic(5) + count(u32LE) + codepoints(u32LE x count) + widths(u8 x count) + bitmaps(32 bytes x count, 16 rows x 2 bytes, MSB first)',
  cell: { width: 16, height: 16 },
  ranges: RANGES.map(([lo, hi, label]) => ({ from: 'U+' + lo.toString(16).toUpperCase().padStart(4, '0'), to: 'U+' + hi.toString(16).toUpperCase().padStart(4, '0'), label })),
  glyphCount: codepoints.length,
  advanceRule: 'UnihexProvider: advance = dataWidth/2 + 1 (full width = 9); this tool samples the native 16x16 bitmap'
}
writeFileSync(join(DATA_DIR, 'unifont.json'), JSON.stringify(meta, null, 2))

console.log(`\n完成：${binPath}`)
console.log(`  字形 ${codepoints.length} 个，未压缩 ${(packed.length / 1024).toFixed(0)} KB，gzip 后 ${(packedGz.length / 1024).toFixed(0)} KB`)
console.log(`  元数据：${join(DATA_DIR, 'unifont.json')}`)

for (const ch of ['科', '学', '，']) {
  const g = glyphs.get(ch.codePointAt(0))
  if (!g) { console.log(`  (缺 ${ch})`); continue }
  console.log(`\n  ${ch}  U+${ch.codePointAt(0).toString(16).toUpperCase()}  dataWidth=${g.dataWidth}`)
  for (let y = 0; y < 16; y++) {
    let line = '   '
    for (let x = 0; x < 16; x++) {
      line += (g.bits[y * 2 + (x >> 3)] & (0x80 >> (x & 7))) ? '#' : '.'
    }
    console.log(line)
  }
}
