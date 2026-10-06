/**
 * 从 Minecraft 客户端 jar 提取 Mojangles（原版像素字体）字形。
 *
 * 依据（26.3 客户端字节码实测）：
 *   BitmapProvider.load():
 *     glyphWidth  = image.width  / chars[0].length      // 列数，通常 16
 *     glyphHeight = image.height / chars.length         // 行数
 *     单元格 (row, col) 位于 (col*glyphWidth, row*glyphHeight)
 *   BitmapProvider$Definition 构造 Glyph 时：
 *     advance = (int)(getActualGlyphWidth(...) * scale + 0.5) + 1     // scale=1 → 裁剪宽 + 1
 *   getActualGlyphWidth(): 从右往左找到第一个非空列，返回 列号+1
 *   GlyphBitmap 几何：getTop() = 7 - bearingTop(=7) = 0，单元格顶端对齐行顶；ascent=7
 *
 * 用法：node tools/extract-mojangles.mjs [--jar <客户端jar>]
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { openJar } from './lib/zip.mjs'
import { decodePng } from './lib/png.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

/* ------------------------------------------------------------------ */
/* 定位客户端 jar                                                      */
/* ------------------------------------------------------------------ */
function findClientJar () {
  const argIdx = process.argv.indexOf('--jar')
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    const p = process.argv[argIdx + 1]
    if (!existsSync(p)) throw new Error(`指定的 jar 不存在：${p}`)
    return p
  }
  const mcDir = process.env.MC_DIR || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '.minecraft')
  const versionsDir = join(mcDir, 'versions')
  if (!existsSync(versionsDir)) throw new Error(`找不到 .minecraft/versions：${versionsDir}`)
  const candidates = []
  for (const name of readdirSync(versionsDir)) {
    const dir = join(versionsDir, name)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jar')) candidates.push({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })
    }
  }
  if (candidates.length === 0) throw new Error('没有找到任何客户端 jar')
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].path
}

/* ------------------------------------------------------------------ */
/* 字体 provider 解析                                                  */
/* ------------------------------------------------------------------ */
const FONT_DIR = 'assets/minecraft/font'
const TEX_DIR = 'assets/minecraft/textures/font'

function resolveId (id) {
  // "minecraft:include/default" → 路径
  const [ns, path] = id.includes(':') ? id.split(':') : ['minecraft', id]
  if (ns !== 'minecraft') throw new Error(`只支持 minecraft 命名空间：${id}`)
  return path
}

function loadFontJson (jar, id) {
  const path = resolveId(id)
  const candidates = [`${FONT_DIR}/${path}.json`, `${FONT_DIR}/${path}/default.json`]
  for (const c of candidates) {
    if (jar.has(c)) return JSON.parse(jar.readText(c))
  }
  throw new Error(`找不到字体定义 ${id}`)
}

/** 收集所有 bitmap provider（按顺序；顺序即优先级） */
function collectProviders (jar, id, seen = new Set(), out = { bitmaps: [], spaces: [] }) {
  if (seen.has(id)) return out
  seen.add(id)
  const json = loadFontJson(jar, id)
  for (const provider of json.providers || []) {
    if (provider.type === 'reference') {
      collectProviders(jar, provider.id, seen, out)
    } else if (provider.type === 'bitmap') {
      out.bitmaps.push(provider)
    } else if (provider.type === 'space') {
      out.spaces.push(provider.advances || {})
    } else if (provider.type === 'unihex' || provider.type === 'ttf') {
      out.skipped = out.skipped || []
      out.skipped.push(provider.type)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 位图打包                                                            */
/* ------------------------------------------------------------------ */
/** 单元格 → 每行 ceil(cellW/8) 字节的位图，返回 hex 字符串 */
function packCell (rgba, imgW, x0, y0, cellW, cellH) {
  const rowBytes = Math.ceil(cellW / 8)
  const out = Buffer.alloc(rowBytes * cellH)
  let opaque = 0
  for (let y = 0; y < cellH; y++) {
    for (let x = 0; x < cellW; x++) {
      const a = rgba[((y0 + y) * imgW + (x0 + x)) * 4 + 3]
      if (a === 0) continue
      opaque++
      out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return { hex: out.toString('hex'), opaque }
}

/** 从右向左找第一个非空列 → 裁剪宽（对应 getActualGlyphWidth） */
function actualGlyphWidth (rgba, imgW, x0, y0, cellW, cellH) {
  for (let x = cellW - 1; x >= 0; x--) {
    for (let y = 0; y < cellH; y++) {
      if (rgba[((y0 + y) * imgW + (x0 + x)) * 4 + 3] !== 0) return x + 1
    }
  }
  return 0
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const jarPath = findClientJar()
console.log(`客户端 jar：${jarPath}`)
const jar = openJar(jarPath)

let version = 'unknown'
let dataVersion = null
if (jar.has('version.json')) {
  const v = JSON.parse(jar.readText('version.json'))
  version = v.id ?? v.name ?? 'unknown'
  dataVersion = v.world_version ?? null
}
console.log(`游戏版本：${version}（data_version ${dataVersion}）`)

const providers = collectProviders(jar, 'minecraft:default')
console.log(`bitmap provider ${providers.bitmaps.length} 个，space provider ${providers.spaces.length} 个` +
  (providers.skipped ? `，跳过 ${[...new Set(providers.skipped)].join('/')}` : ''))

const sheets = []
const glyphs = new Map()
const advances = new Map()

for (const provider of providers.bitmaps) {
  const texPath = `${TEX_DIR}/${resolveId(provider.file).replace(/^font\//, '')}`
  if (!jar.has(texPath)) {
    console.warn(`  ! 跳过缺失贴图 ${provider.file}（${texPath}）`)
    continue
  }
  const img = decodePng(jar.read(texPath))
  const rows = provider.chars
  const cols = rows[0].length
  const cellW = img.width / cols
  const cellH = img.height / rows.length
  if (!Number.isInteger(cellW) || !Number.isInteger(cellH)) {
    throw new Error(`${provider.file} 尺寸 ${img.width}x${img.height} 与 ${cols}x${rows.length} 网格不匹配`)
  }
  const ascent = provider.ascent ?? 7
  const height = provider.height ?? cellH
  const sheetIndex = sheets.length
  sheets.push({ file: provider.file, cellW, cellH, ascent, height, cols, rows: rows.length })

  let added = 0
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const cp = rows[r].codePointAt(c)
      if (!cp) continue
      if (glyphs.has(cp)) continue // 先出现的 provider 优先
      const x0 = c * cellW
      const y0 = r * cellH
      const w = actualGlyphWidth(img.rgba, img.width, x0, y0, cellW, cellH)
      if (w === 0) continue // 空格这类无形像素的字形不建条目，advance 由 space provider 提供
      const { hex, opaque } = packCell(img.rgba, img.width, x0, y0, cellW, cellH)
      glyphs.set(cp, { s: sheetIndex, adv: w + 1, bits: hex, opaque })
      added++
    }
  }
  console.log(`  ${provider.file.padEnd(28)} ${cols}x${rows.length} 格，每格 ${cellW}x${cellH}，ascent=${ascent} → 新增 ${added} 个字形`)
}

for (const adv of providers.spaces) {
  for (const [ch, width] of Object.entries(adv)) {
    advances.set(ch.codePointAt(0), width)
  }
}
console.log(`space provider 提供 ${advances.size} 个宽度（空格 = ${advances.get(32)}）`)

/* ------------------------------------------------------------------ */
/* 校验：ASCII 全字符 + 与原版字宽对照表比对                              */
/* ------------------------------------------------------------------ */
const REFERENCE = (() => {
  const w = {}
  const set = (chars, n) => { for (const ch of chars) w[ch] = n }
  set(' ', 4)
  set('!', 2); set('"', 4); set('#', 6); set('$', 6); set('%', 6); set('&', 6); set("'", 2)
  set('(', 4); set(')', 4); set('*', 4); set('+', 6); set(',', 2); set('-', 6); set('.', 2); set('/', 6)
  set('0123456789', 6)
  set(':', 2); set(';', 2); set('<', 5); set('=', 6); set('>', 5); set('?', 6); set('@', 7)
  set('ABCDEFGHJKLMNOPQRSTUVWXYZ', 6); set('I', 4)
  set('[', 4); set('\\', 6); set(']', 4); set('^', 6); set('_', 6); set('`', 3)
  set('abcdeghjmnopqrsuvwxyz', 6); set('f', 5); set('i', 2); set('k', 5); set('l', 3); set('t', 4)
  set('{', 4); set('|', 2); set('}', 4); set('~', 7)
  return w
})()

const mismatch = []
for (let cp = 32; cp <= 126; cp++) {
  const ch = String.fromCharCode(cp)
  const g = glyphs.get(cp)
  const adv = g ? g.adv : advances.get(cp)
  const ref = REFERENCE[ch]
  if (adv === undefined) { mismatch.push(`${ch} 缺字形`); continue }
  if (ref !== undefined && ref !== adv) mismatch.push(`${ch} 实际 ${adv} / 对照表 ${ref}`)
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */
const out = {
  source: { jar: jarPath, gameVersion: version, dataVersion },
  ascent: 7,
  sheets,
  advances: Object.fromEntries([...advances.entries()].map(([cp, n]) => [cp, n])),
  glyphs: Object.fromEntries([...glyphs.entries()].sort((a, b) => a[0] - b[0]))
}

const outPath = join(ROOT, 'data', 'glyphs', 'mojangles.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out))

console.log(`\n字形 ${glyphs.size} 个 → ${outPath}（${(JSON.stringify(out).length / 1024).toFixed(1)} KB）`)
if (mismatch.length === 0) {
  console.log('✅ ASCII 0x20–0x7E 全部字形存在，且字宽与对照表完全一致')
} else {
  console.log(`⚠️  与对照表有 ${mismatch.length} 处差异（前 20 条）：`)
  for (const m of mismatch.slice(0, 20)) console.log(`    ${m}`)
  const missing = mismatch.filter((m) => m.includes('缺字形'))
  console.log(`    其中缺字形 ${missing.length} 个`)
}
