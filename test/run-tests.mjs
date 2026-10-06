/**
 * 自动化测试：结构断言 + 自回读 + 第三方（litemapy）解析。
 * 运行：npm test   （或 node test/run-tests.mjs）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadData, generateSlogan, needsUnifont } from '../src/node/generate.mjs'
import { createGlyphSet, hexToBytes } from '../src/core/glyphs.mjs'
import { layoutText } from '../src/core/layout.mjs'
import { packBlockStates, unpackBlockStates, bitsForPalette } from '../src/core/schematic.mjs'
import { inspectLitematic } from '../src/core/reader.mjs'
import { readNbt, compoundToObject, TAG } from '../src/core/nbt.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const data = loadData()

let passed = 0
let failed = 0
const failures = []

const pending = []

function test (name, fn) {
  const ok = () => { passed++; console.log(`  ✓ ${name}`) }
  const bad = (err) => {
    failed++
    failures.push({ name, message: err.message })
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      pending.push(result.then(ok, bad)) // 异步用例：结果稍后结算
      return
    }
    ok()
  } catch (err) {
    bad(err)
  }
}

function assert (cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertEqual (actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}：期望 ${expected}，实际 ${actual}`)
}

/* ================================================================== */
console.log('\n[1] Mojangles 字形与字宽')
/* ================================================================== */

// 原版字宽对照表（Mojangles 各字符的 advance）
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

test('ASCII 0x20–0x7E 每个字符都有字形或宽度', () => {
  const missing = []
  for (let cp = 32; cp <= 126; cp++) {
    const ch = String.fromCharCode(cp)
    if (data.mojangles.glyphs[cp] === undefined && data.mojangles.advances?.[cp] === undefined) missing.push(ch)
  }
  assertEqual(missing.length, 0, `缺字形：${missing.join('')}`)
})

test('每个 ASCII 字符的字宽与原版对照表一致', () => {
  const bad = []
  for (let cp = 32; cp <= 126; cp++) {
    const ch = String.fromCharCode(cp)
    const g = data.mojangles.glyphs[cp]
    const adv = g ? g.adv : data.mojangles.advances[cp]
    if (adv !== REFERENCE[ch]) bad.push(`${ch}: ${adv} != ${REFERENCE[ch]}`)
  }
  assertEqual(bad.length, 0, bad.join(', '))
})

test('字宽规则 = 裁剪宽 + 1（与原版 BitmapProvider 一致）', () => {
  const bad = []
  for (let cp = 32; cp <= 126; cp++) {
    const g = data.mojangles.glyphs[cp]
    if (!g) continue
    const sheet = data.mojangles.sheets[g.s]
    const rowBytes = Math.ceil(sheet.cellW / 8)
    const bits = hexToBytes(g.bits)
    let rightmost = -1
    for (let x = sheet.cellW - 1; x >= 0; x--) {
      let ink = false
      for (let y = 0; y < sheet.cellH; y++) {
        if (bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7))) { ink = true; break }
      }
      if (ink) { rightmost = x; break }
    }
    if (g.adv !== rightmost + 2) bad.push(`${String.fromCharCode(cp)}: adv=${g.adv} 裁剪宽=${rightmost + 1}`)
  }
  assertEqual(bad.length, 0, bad.join(', '))
})

test('字形几何抽样正确（i / g / 空格 / A）', () => {
  const set = createGlyphSet({ mojangles: data.mojangles, unifontLookup: data.unifont.lookup, latinDots: 1 })
  assertEqual(set.lookup('i'.codePointAt(0)).advance, 2, 'i 的字宽')
  assertEqual(set.lookup(' '.codePointAt(0)).advance, 4, '空格的字宽')
  assertEqual(set.lookup('A'.codePointAt(0)).height, 8, 'A 的格高')
  assertEqual(set.lookup('A'.codePointAt(0)).top, 0, 'ascii 表的 top')
  const g = set.lookup('g'.codePointAt(0))
  const rowBytes = g.rowBytes
  let descender = false
  for (let x = 0; x < g.width; x++) if (g.bits[7 * rowBytes + (x >> 3)] & (0x80 >> (x & 7))) descender = true
  assert(descender, 'g 应有第 8 行（降部）墨迹')
  const cjk = set.lookup('科'.codePointAt(0))
  assertEqual(cjk.width, 16, '汉字点阵宽')
  assertEqual(cjk.height, 16, '汉字点阵高')
  assertEqual(cjk.top, 0, '汉字 top')
})

/* ================================================================== */
console.log('\n[2] 汉字字形（Unifont）')
/* ================================================================== */

test('常用汉字与中文标点都有字形', () => {
  const chars = '科学技术是第一生产力，。！？：；（）《》—…'
  const set = createGlyphSet({ mojangles: data.mojangles, unifontLookup: data.unifont.lookup, latinDots: 2 })
  const miss = [...chars].filter((ch) => !set.has(ch.codePointAt(0)))
  assertEqual(miss.length, 0, `缺字形：${miss.join('')}`)
  // 这些应来自 Unifont（Mojangles 里没有汉字）
  assertEqual(set.lookup('科'.codePointAt(0)).source, 'unifont', '汉字应来自 Unifont')
  assertEqual(set.lookup('A'.codePointAt(0)).source, 'mojangles', '拉丁字母应来自 Mojangles')
})

test('全宽汉字 advance = 数据宽 + 2 点（= 原版 9 游戏像素换算）', () => {
  const set = createGlyphSet({ mojangles: data.mojangles, unifontLookup: data.unifont.lookup, latinDots: 2 })
  assertEqual(set.lookup('科'.codePointAt(0)).advance, 18, '全宽汉字')
})

test('latinDots=auto：纯 ASCII 用 1，含汉字用 2（拉丁与汉字等高）', () => {
  assertEqual(needsUnifont('Hello 123', data.mojangles), false, '纯 ASCII 不应需要 Unifont')
  assertEqual(needsUnifont('Hello 世界', data.mojangles), true, '含汉字应需要 Unifont')
})

/* ================================================================== */
console.log('\n[3] 排版尺寸')
/* ================================================================== */

function makeSet (latinDots = 1) {
  return createGlyphSet({ mojangles: data.mojangles, unifontLookup: data.unifont.lookup, latinDots })
}

/** 实际墨迹边距（方块数） */
function inkMargins (layout) {
  const { width, height, grid } = layout
  let left = width; let right = -1; let top = height; let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!grid[y * width + x]) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return { left, right: width - 1 - right, top, bottom: height - 1 - bottom }
}

/** 同一行内相邻字形之间的实际空格数 */
function inkGaps (layout, line = 0) {
  const boxes = layout.inkBoxes.filter((b) => b.line === line)
  const out = []
  for (let i = 1; i < boxes.length; i++) out.push(boxes[i].x0 - boxes[i - 1].x1)
  return out
}

test('尺寸 = 2×边框 + 各字推进宽 + 字间距，且随参数精确变化', () => {
  const text = 'AB'
  const set = makeSet(1)
  // advance 模式：内容宽 = 首字墨迹左沿 → 末字墨迹右沿
  for (const border of [0, 1, 3]) {
    for (const spacing of [0, 1, 2]) {
      const l = layoutText(text, { glyphSet: set, border, spacing, spacingMode: 'advance', align: 'left' })
      const gA = set.lookup('A'.codePointAt(0))
      const gB = set.lookup('B'.codePointAt(0))
      const expectContent = gA.advance + spacing + gB.ink.right - gA.ink.left
      assertEqual(l.width, 2 * border + expectContent, `border=${border} spacing=${spacing} 宽度`)
      assertEqual(l.depth, 1, '厚度')
    }
  }
  // 尺寸随 spacing 单调增加
  const w0 = layoutText(text, { glyphSet: set, spacing: 0, spacingMode: 'advance' }).width
  const w5 = layoutText(text, { glyphSet: set, spacing: 5, spacingMode: 'advance' }).width
  assertEqual(w5 - w0, 5, 'spacing 每 +1，宽度 +1')
})

test('【缺陷修复】gap 模式下字间距 = 相邻字形实际墨迹空格数', () => {
  const set = makeSet(2)
  for (const text of ['科学技术', 'Hello', '科学ABC', 'ABC科学']) {
    for (const spacing of [0, 1, 2, 4]) {
      const l = layoutText(text, { glyphSet: set, spacing, spacingMode: 'gap', border: 0 })
      const gaps = inkGaps(l)
      assertEqual(gaps.length, [...text].length - 1, `${text} 的间隔数`)
      for (const g of gaps) assertEqual(g, spacing, `${text} spacing=${spacing} 的实际空格`)
    }
  }
})

test('【缺陷修复】border=0 时四周边距为 0（字迹贴边，不再受字体留白影响）', () => {
  const set = makeSet(2)
  for (const text of ['科学技术是第一生产力', 'Hello Minecraft 123!', '科学ABC', 'ABC科学']) {
    const l = layoutText(text, { glyphSet: set, border: 0, spacing: 1, spacingMode: 'gap' })
    const m = inkMargins(l)
    assertEqual(`${m.left},${m.right},${m.top},${m.bottom}`, '0,0,0,0', `「${text}」的边距`)
  }
})

test('border=N 时四周边距恰为 N', () => {
  const set = makeSet(2)
  for (const text of ['科学技术', 'Hello', 'ABC科学']) {
    for (const border of [0, 1, 2, 5]) {
      const l = layoutText(text, { glyphSet: set, border, spacing: 1, spacingMode: 'gap' })
      const m = inkMargins(l)
      assertEqual(`${m.left},${m.right},${m.top},${m.bottom}`, `${border},${border},${border},${border}`, `「${text}」border=${border}`)
    }
  }
})

test('【缺陷修复】多行支持左/中/右对齐', () => {
  const set = makeSet(2)
  const text = '短\n长一些的一行'
  const w = (align) => layoutText(text, { glyphSet: set, align, spacing: 1, border: 0 })
  const left = w('left')
  const center = w('center')
  const right = w('right')
  const lineStarts = (l, line) => Math.min(...l.inkBoxes.filter((b) => b.line === line).map((b) => b.x0))
  const lineEnds = (l, line) => Math.max(...l.inkBoxes.filter((b) => b.line === line).map((b) => b.x1))
  // 短行在第 0 行
  assertEqual(lineStarts(left, 0), 0, 'left：短行贴左')
  assertEqual(lineEnds(right, 0), right.width, 'right：短行贴右')
  const cl = lineStarts(center, 0)
  const cr = lineEnds(center, 0)
  assert(Math.abs((cl + cr) / 2 - center.width / 2) <= 1, `center：短行应居中（${cl}..${cr} / ${center.width}）`)
  assert(cl > 0 && cr < center.width, 'center：短行两侧都应有留白')
  // 三行尺寸一致（只是行内位移不同）
  assertEqual(left.width, right.width, '左右对齐宽度一致')
  assertEqual(left.height, right.height, '高度一致')
})

test('dotBlocks 等比放大内容尺寸（边框不放大）', () => {
  const set = makeSet(1)
  const a = layoutText('M', { glyphSet: set, dotBlocks: 1, border: 1, spacingMode: 'advance' })
  const b = layoutText('M', { glyphSet: set, dotBlocks: 3, border: 1, spacingMode: 'advance' })
  const inkW = set.lookup('M'.codePointAt(0)).ink.right - set.lookup('M'.codePointAt(0)).ink.left
  assertEqual(a.width, inkW + 2, 'dotBlocks=1 宽')
  assertEqual(b.width, inkW * 3 + 2, 'dotBlocks=3 宽')
  assertEqual(b.height, (set.lookup('M'.codePointAt(0)).ink.bottom) * 3 + 2, 'dotBlocks=3 高')
})

test('多行：行距按字体行高累计', () => {
  const set = makeSet(1)
  const cellH = set.lookup('A'.codePointAt(0)).height // 8
  const one = layoutText('A', { glyphSet: set, lineGap: 0 })
  const two = layoutText('A\nA', { glyphSet: set, lineGap: 2 })
  assertEqual(two.lines.length, 2, '行数')
  assertEqual(two.height - one.height, cellH + 2, '第二行带来的高度增量 = 字体行高 + 行距')
  const three = layoutText('A\nA\nA', { glyphSet: set, lineGap: 0 })
  assertEqual(three.height - one.height, 2 * cellH, '三行无行距')
})

test('厚度恒为 1 格', () => {
  const r = generateSlogan({ text: 'THICKNESS', border: 2 })
  assertEqual(r.layout.depth, 1, 'layout 厚度')
  const info = inspectLitematic(r.nbt)
  assertEqual(info.size.z, 1, 'Region.Size.z')
})

test('混排（ASCII + 汉字）高度对齐且无缺字', () => {
  const r = generateSlogan({ text: 'MC 我的世界 2026' })
  assertEqual(r.latinDots, 2, '含汉字时 latinDots 应为 2')
  assertEqual(r.layout.missing.length, 0, '不应有缺字')
  const set = makeSet(2)
  assertEqual(set.lookup('科'.codePointAt(0)).height * 1, 16, '汉字点阵高')
  assertEqual(set.lookup('A'.codePointAt(0)).height, 16, 'latinDots=2 时拉丁字形高应与汉字一致')
})

/* ================================================================== */
console.log('\n[4] 位打包与 NBT 结构')
/* ================================================================== */

test('pack/unpack 往返一致（多种 bits 与体积）', () => {
  for (const bits of [1, 2, 3, 4, 5, 7, 8, 9, 16, 32]) {
    for (const n of [1, 2, 7, 31, 32, 33, 64, 65, 100, 1000]) {
      const max = Math.min(2 ** Math.min(bits, 8), 200)
      const values = Array.from({ length: n }, (_, i) => (i * 7 + 3) % max)
      const packed = packBlockStates(values, bits)
      const back = unpackBlockStates(packed, n, bits)
      assertEqual(back.join(','), values.join(','), `bits=${bits} n=${n}`)
      assertEqual(packed.length, Math.ceil((n * bits) / 64), `bits=${bits} n=${n} 的 long 数`)
    }
  }
})

test('bits 由调色板大小决定：2 色与 3 色都是 2bit', () => {
  assertEqual(bitsForPalette(2), 2, '2 色')
  assertEqual(bitsForPalette(3), 2, '3 色')
  assertEqual(bitsForPalette(4), 2, '4 色')
  assertEqual(bitsForPalette(5), 3, '5 色')
})

test('NBT 根标签与字段类型符合 Litematica 规范', () => {
  const r = generateSlogan({ text: 'NBT' })
  const root = readNbt(r.nbt)
  assertEqual(root.name, '', '根标签名必须为空字符串')
  const obj = compoundToObject(root.entries)
  const types = new Map(root.entries.map(([k, v]) => [k, v.tag]))
  assertEqual(types.get('MinecraftDataVersion'), TAG.INT, 'MinecraftDataVersion')
  assertEqual(types.get('Version'), TAG.INT, 'Version')
  assertEqual(types.get('SubVersion'), TAG.INT, 'SubVersion')
  assertEqual(types.get('Metadata'), TAG.COMPOUND, 'Metadata')
  assertEqual(types.get('Regions'), TAG.COMPOUND, 'Regions')
  assertEqual(obj.Version, 7, 'Version 值')
  assertEqual(obj.SubVersion, 1, 'SubVersion 值')
  assertEqual(obj.MinecraftDataVersion, 5023, 'data_version（26.3）')

  const md = obj.Metadata
  for (const k of ['Name', 'Author', 'Description', 'RegionCount', 'TotalVolume', 'TotalBlocks', 'TimeCreated', 'TimeModified', 'EnclosingSize']) {
    assert(md[k] !== undefined, `Metadata 缺字段 ${k}`)
  }
  assert(typeof md.EnclosingSize.x === 'number', 'EnclosingSize 应为 {x,y,z}')

  const region = obj.Regions[Object.keys(obj.Regions)[0]]
  assert(typeof region.Position.x === 'number', 'Position 应为 {x,y,z} 复合标签')
  assert(typeof region.Size.x === 'number', 'Size 应为 {x,y,z} 复合标签')
  assertEqual(region.Size.z, 1, '厚度')
  const regionTypes = new Map(root.entries.find(([k]) => k === 'Regions')[1].value[0][1].value.map(([k, v]) => [k, v.tag]))
  assertEqual(regionTypes.get('BlockStates'), TAG.LONG_ARRAY, 'BlockStates 必须是 LongArray')
  assertEqual(regionTypes.get('BlockStatePalette'), TAG.LIST, 'BlockStatePalette 必须是 List')
  assertEqual(regionTypes.get('TileEntities'), TAG.LIST, 'TileEntities 必须是 List')
})

test('BlockStates 长度与体积、bits 自洽', () => {
  const r = generateSlogan({ text: 'PACKING TEST' })
  const info = inspectLitematic(r.nbt)
  assertEqual(info.bits, 2, 'bits')
  const volume = info.size.x * info.size.y * info.size.z
  assertEqual(info.volume, volume, '体积')
})

test('回读位图与原位图完全一致（Y 轴翻转正确）', () => {
  const r = generateSlogan({ text: 'FLIP\nOK', border: 1 })
  const info = inspectLitematic(r.nbt, { fontBlock: r.fg })
  assertEqual(info.grid.length, r.layout.grid.length, '位图长度')
  let diff = 0
  let firstAt = null
  for (let i = 0; i < info.grid.length; i++) {
    if (info.grid[i] !== r.layout.grid[i]) { diff++; if (firstAt === null) firstAt = i }
  }
  assertEqual(diff, 0, `不一致的格子数（首个位置 ${firstAt}）`)
})

test('跨 long 边界的打包/解包（负 long 高位不能污染结果）', () => {
  // bits=2 时字段永不跨 long；用会跨越的位宽做压力测试
  for (const bits of [3, 5, 6, 7, 9, 11, 13, 17, 32]) {
    const n = 200
    const values = Array.from({ length: n }, (_, i) => (i * 37 + 5) % (2 ** Math.min(bits, 8)))
    const packed = packBlockStates(values, bits)
    const back = unpackBlockStates(packed, n, bits)
    assertEqual(back.join(','), values.join(','), `bits=${bits}`)
  }
})

/* ================================================================== */
console.log('\n[5] 材质替换与版本一致性')
/* ================================================================== */

test('更换材质后调色板与方块同步替换', () => {
  const r = generateSlogan({ text: 'AB', bg: 'minecraft:black_concrete', fg: 'minecraft:yellow_concrete', border: 1 })
  const info = inspectLitematic(r.nbt)
  assert(info.palette.includes('minecraft:black_concrete'), '调色板应含黑混凝土')
  assert(info.palette.includes('minecraft:yellow_concrete'), '调色板应含黄混凝土')
  assertEqual(info.blocks(0, 0, 0), 'minecraft:black_concrete', '有边框时角点应为背景材质')
  const fgCells = []
  for (let y = 0; y < info.size.y; y++) {
    for (let x = 0; x < info.size.x; x++) if (info.blocks(x, y, 0) === 'minecraft:yellow_concrete') fgCells.push(`${x},${y}`)
  }
  assertEqual(fgCells.length, r.layout.fontBlocks, '字体材质格子数')
})

test('border=0 时墙的四条边都应有字体方块（字迹贴边）', () => {
  const r = generateSlogan({ text: 'AB', border: 0 })
  const info = inspectLitematic(r.nbt, { fontBlock: r.fg })
  const W = info.size.x
  const H = info.size.y
  const at = (x, y) => info.blocks(x, y, 0)
  let edges = 0
  for (let x = 0; x < W; x++) if (at(x, 0) === r.fg || at(x, H - 1) === r.fg) edges++
  for (let y = 0; y < H; y++) if (at(0, y) === r.fg || at(W - 1, y) === r.fg) edges++
  assert(edges > 0, '四条边上应能见到字体材质')
  // 左/右边缘各自至少有一个字体方块
  let leftHit = false; let rightHit = false
  for (let y = 0; y < H; y++) { if (at(0, y) === r.fg) leftHit = true; if (at(W - 1, y) === r.fg) rightHit = true }
  assert(leftHit && rightHit, '左右边缘都应有字体材质')
})

test('data_version 随所选版本变化', () => {
  assertEqual(generateSlogan({ text: 'V', version: '26.3' }).dataVersion, 5023, '26.3')
  assertEqual(generateSlogan({ text: 'V', version: '1.20.4' }).dataVersion, 3700, '1.20.4')
  assertEqual(generateSlogan({ text: 'V', version: '1.21.4' }).dataVersion, 4189, '1.21.4')
})

test('版本过滤：新版本方块不能用于旧版本（用户新增需求）', () => {
  const catalog = data.catalog
  // 找一个只在最新版本里存在的方块
  const lateOnly = Object.entries(data.blocksRaw.blocks)
    .find(([, ranges]) => ranges.length === 1 && ranges[0][0] === data.blocksRaw.versions.length - 1)
  assert(lateOnly, '数据里应存在「仅最新版本」的方块')
  const [name] = lateOnly
  assert(catalog.existsIn(name, catalog.latest), `${name} 应存在于 ${catalog.latest}`)
  assert(!catalog.existsIn(name, '1.20.4'), `${name} 不应存在于 1.20.4`)

  let threw = false
  try {
    generateSlogan({ text: 'X', version: '1.20.4', bg: `minecraft:${name}` })
  } catch (err) {
    threw = true
    assert(/不存在/.test(err.message), `错误信息应说明不存在：${err.message}`)
  }
  assert(threw, '用不存在的方块生成应当报错')

  // 常用方块在所有版本都存在
  for (const b of ['red_concrete', 'white_concrete', 'oak_planks']) {
    for (const v of ['1.20', '1.21.4', '26.3']) {
      assert(catalog.existsIn(b, v), `${b} 应存在于 ${v}`)
    }
  }
})

test('--list-blocks 结果随版本变化', () => {
  const old = data.catalog.listFor('1.20')
  const now = data.catalog.listFor('26.3')
  assert(now.length > old.length, `26.3 (${now.length}) 的方块数应多于 1.20 (${old.length})`)
  assert(!old.includes('pale_oak_planks'), '1.20 不应有苍白橡木木板')
  assert(now.includes('pale_oak_planks'), '26.3 应有苍白橡木木板')
  assert(old.includes('red_concrete') && now.includes('red_concrete'), '红混凝土应一直存在')
})

test('不支持的版本号给出可读错误', () => {
  let msg = ''
  try { generateSlogan({ text: 'X', version: '1.19.4' }) } catch (err) { msg = err.message }
  assert(/不支持的版本/.test(msg), `错误信息应提示不支持的版本：${msg}`)
})

test('方块名支持中文 / 裸名 / 带命名空间三种写法', () => {
  const a = generateSlogan({ text: 'X', bg: '红色混凝土', fg: '白色混凝土' })
  const b = generateSlogan({ text: 'X', bg: 'red_concrete', fg: 'white_concrete' })
  const c = generateSlogan({ text: 'X', bg: 'minecraft:red_concrete', fg: 'minecraft:white_concrete' })
  assertEqual(a.bg, 'minecraft:red_concrete', '中文名解析')
  assertEqual(b.bg, 'minecraft:red_concrete', '裸名解析')
  assertEqual(c.bg, 'minecraft:red_concrete', '带命名空间解析')
  assertEqual(a.layout.width, b.layout.width, '三种写法结果一致')
})

test('方块中文名可用（来自游戏 zh_cn 语言文件）', () => {
  const catalog = data.catalog
  assert(catalog.hasZhNames, '应加载了中文名数据')
  assertEqual(catalog.zhNameOf('red_concrete'), '红色混凝土', '红混凝土中文名')
  assertEqual(catalog.zhNameOf('white_concrete'), '白色混凝土', '白混凝土中文名')
  // 墙旗没有独立词条，应回退到基名
  assertEqual(catalog.zhNameOf('black_wall_banner'), catalog.zhNameOf('black_banner'), '墙旗回退')
  let zhCount = 0
  for (const id of Object.keys(data.blocksRaw.blocks)) if (catalog.zhNameOf(id)) zhCount++
  assert(zhCount / Object.keys(data.blocksRaw.blocks).length > 0.99, `中文名覆盖率应 >99%，实际 ${zhCount}`)
})

test('方块名拼错时给出建议', () => {
  const catalog = data.catalog
  const zh = catalog.suggest('红色混凝士', '26.3')
  assert(zh.length > 0, '中文拼错应有建议')
  assertEqual(zh[0], 'red_concrete', `中文拼错应首选 red_concrete，实际 ${zh[0]}`)
  const en = catalog.suggest('ored_concrete', '26.3')
  assert(en.length > 0, '英文拼错应有建议')
  assertEqual(en[0], 'red_concrete', `英文拼错应首选 red_concrete，实际 ${en[0]}`)
})

/* ================================================================== */
console.log('\n[5b] 完整方块筛选（墙面材质候选表）')
/* ================================================================== */

test('完整方块判定：可直接用作墙面的方块', () => {
  const catalog = data.catalog
  const complete = [
    'red_concrete', 'white_concrete', 'black_concrete', 'white_wool', 'white_terracotta',
    'white_glazed_terracotta', 'quartz_block', 'stone', 'cobblestone', 'deepslate', 'basalt',
    'blackstone', 'tuff', 'andesite', 'diorite', 'granite', 'prismarine', 'obsidian',
    'iron_block', 'gold_block', 'diamond_block', 'copper_block', 'oxidized_copper',
    'oak_log', 'oak_planks', 'spruce_planks', 'stone_bricks', 'smooth_stone'
  ]
  const bad = complete.filter((n) => catalog.shapeOf(n) !== 'complete')
  assertEqual(bad.length, 0, `这些应是完整方块：${bad.join(', ')}`)
})

test('完整方块判定：不完整 / 需依附的方块一律排除', () => {
  const catalog = data.catalog
  const excluded = [
    // 不完整方块
    'oak_stairs', 'oak_fence', 'oak_fence_gate', 'oak_wall', 'iron_bars', 'glass_pane',
    'oak_door', 'oak_trapdoor', 'oak_shelf', 'oak_button', 'oak_pressure_plate',
    'player_head', 'skeleton_skull', 'flower_pot', 'cake', 'campfire', 'soul_campfire',
    // 植物
    'dandelion', 'poppy', 'cactus', 'vine', 'oak_sapling', 'grass', 'fern', 'sugar_cane',
    // 需依附其它方块
    'torch', 'soul_torch', 'oak_sign', 'oak_wall_sign', 'oak_hanging_sign',
    'amethyst_cluster', 'small_amethyst_bud', 'lantern', 'lever', 'ladder'
  ]
  const survivors = excluded.filter((n) => catalog.shapeOf(n) === 'complete')
  assertEqual(survivors.length, 0, `这些不该被判为完整方块：${survivors.join(', ')}`)
  // 台阶是「部分状态」而不是完全不可用，但同样不能进推荐列表
  assertEqual(catalog.shapeOf('oak_slab'), 'partial', '台阶应为 partial')
  assert(!catalog.isFullCube('oak_slab'), '台阶不应算作完整方块')
})

test('推荐候选只包含完整方块，并按给定清单分类', () => {
  const catalog = data.catalog
  const groups = catalog.groupedFor('26.3', { scope: 'recommended' })
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.ids]))
  // 每种颜色各 16 个
  for (const key of ['concrete', 'wool', 'glazed', 'terracotta']) {
    assertEqual(byKey[key]?.length, 16, `${key} 应有 16 种颜色`)
  }
  assert(byKey.stone.length >= 40, `石材类应 >=40，实际 ${byKey.stone.length}`)
  assert(byKey.metal.includes('obsidian'), '黑曜石应在金属矿物类')
  assert(byKey.metal.includes('oxidized_copper'), '氧化铜应在金属矿物类')
  assert(byKey.wood.includes('oak_log') && byKey.wood.includes('oak_planks'), '原木与木板')
  // 所有推荐项都必须存在且是完整方块
  for (const g of groups) {
    for (const id of g.ids) {
      assert(catalog.existsIn(id, '26.3'), `${id} 应存在于 26.3`)
      assertEqual(catalog.shapeOf(id), 'complete', `${id} 应是完整方块`)
    }
  }
  // 台阶/栅栏/植物绝不出现在推荐里
  const all = groups.flatMap((g) => g.ids)
  for (const bad of ['oak_slab', 'oak_stairs', 'oak_fence', 'dandelion', 'torch', 'oak_door']) {
    assert(!all.includes(bad), `${bad} 不该出现在推荐候选里`)
  }
})

test('候选范围随版本变化（低版本没有新方块）', () => {
  const catalog = data.catalog
  const old = catalog.listFor('1.20', { scope: 'recommended' })
  const now = catalog.listFor('26.3', { scope: 'recommended' })
  assert(now.length > old.length, `26.3(${now.length}) 应多于 1.20(${old.length})`)
  assert(old.includes('red_concrete') && now.includes('red_concrete'), '红混凝土一直都在')
  assert(!old.includes('pale_oak_planks'), '1.20 不该有苍白橡木木板')
})

test('使用不完整方块时给出警告（不阻断，但明示）', () => {
  const r = generateSlogan({ text: 'X', bg: 'oak_slab', fg: 'torch' })
  assertEqual(r.warnings.length, 2, `应产生 2 条警告，实际 ${r.warnings.length}`)
  assert(/不是完整方块/.test(r.warnings[1]), '火把应提示不是完整方块')
  assert(/部分状态/.test(r.warnings[0]), '台阶应提示部分状态')
  const ok = generateSlogan({ text: 'X', bg: 'red_concrete', fg: 'white_concrete' })
  assertEqual(ok.warnings.length, 0, '正常材质不应有警告')
})

/* ================================================================== */
console.log('\n[6] 第三方解析（litemapy）与整体验收')
/* ================================================================== */

const venvPython = process.platform === 'win32'
  ? join(ROOT, '.venv', 'Scripts', 'python.exe')
  : join(ROOT, '.venv', 'bin', 'python')

if (!existsSync(venvPython)) {
  console.log('  ⚠ 未找到 .venv，跳过 litemapy 验证（可运行：python -m venv .venv && .venv/Scripts/pip install litemapy）')
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'slogan-test-'))
  try {
    const cases = [
      { name: 'ascii', text: 'Hello, Minecraft 123!', border: 1 },
      { name: 'cjk', text: '科学技术是第一生产力', border: 2, spacing: 1 },
      { name: 'mixed', text: 'MC 我的世界 2026 OK', dotBlocks: 1 },
      { name: 'materials', text: 'RED', bg: 'minecraft:black_concrete', fg: 'minecraft:lime_concrete', version: '1.20.4' }
    ]
    for (const c of cases) {
      const r = generateSlogan(c)
      const file = join(tmp, `${c.name}.litematic`)
      const gridFile = join(tmp, `${c.name}.json`)
      writeFileSync(file, r.gzip())
      writeFileSync(gridFile, JSON.stringify({
        width: r.layout.width,
        height: r.layout.height,
        bg: r.bg,
        fg: r.fg,
        grid: Array.from(r.layout.grid).join('')
      }))
      test(`litemapy 逐格校验：${c.name}（${c.text}）`, () => {
        const out = execFileSync(venvPython, [join(ROOT, 'test', 'verify-litemapy.py'), file, gridFile], {
          encoding: 'utf8',
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        })
        assert(/PASS:/.test(out), `未通过：\n${out}`)
        const m = out.match(/PASS: (\d+) 格全部匹配/)
        assert(m, '未找到 PASS 行')
        assertEqual(Number(m[1]), r.layout.width * r.layout.height, '比对格数')
      })
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/* ================================================================== */
console.log('\n[7] 边界与错误处理')
/* ================================================================== */

test('空文本报错', () => {
  let threw = false
  try { generateSlogan({ text: '' }) } catch { threw = true }
  assert(threw, '空文本应报错')
})

test('背景与字体材质相同时报错', () => {
  let threw = false
  try { generateSlogan({ text: 'X', bg: 'minecraft:red_concrete', fg: 'minecraft:red_concrete' }) } catch { threw = true }
  assert(threw, '相同材质应报错')
})

test('超大尺寸被拦截', () => {
  let threw = false
  try { generateSlogan({ text: 'W'.repeat(500), dotBlocks: 4 }) } catch (err) { threw = /过大/.test(err.message) }
  assert(threw, '超大墙应报错')
})

test('未知字符用占位方框并报告', () => {
  const r = generateSlogan({ text: 'A\u{1F600}B' }) // emoji 不在 Mojangles/Unifont 范围内
  assert(r.layout.missing.length === 1, `应报告 1 个缺字，实际 ${r.layout.missing.length}`)
})

/* ================================================================== */
console.log('\n[8] 预览页打包产物（浏览器端代码路径）')
/* ================================================================== */

const previewPath = join(ROOT, 'web', 'slogan-tool.html')

test('预览页已生成且内嵌全部数据', () => {
  assert(existsSync(previewPath), 'web/slogan-tool.html 不存在，请运行 node tools/build-preview.mjs')
  const html = readFileSync(previewPath, 'utf8')
  for (const token of ['data-versions', 'data-mojangles', 'data-unifont', '__CORE__', '__UNIFONT__']) {
    assert(!html.includes(token) || token.startsWith('data-'), `模板占位符未替换：${token}`)
  }
  assert(!html.includes('__CORE__'), '核心库占位符未替换')
  assert(!html.includes('__MOJANGLES__'), '字形占位符未替换')
  assert(!html.includes('__UNIFONT__'), 'Unifont 占位符未替换')
  assert(/下载 \.litematic/.test(html), '缺少下载按钮')
})

test('打包后的核心代码可直接运行，且生成的投影通过 litemapy 校验', async () => {
  const html = readFileSync(previewPath, 'utf8')
  const marker = '/* ===================== 预览界面 ===================== */'
  const start = html.indexOf('<script type="module">')
  assert(start >= 0, '找不到 module script')
  const bodyStart = html.indexOf('\n', start) + 1
  const end = html.indexOf(marker, bodyStart)
  assert(end > bodyStart, '找不到预览界面分隔标记')
  const coreSrc = html.slice(bodyStart, end)
  assert(!/^\s*(import|export)\s/m.test(coreSrc), '打包后的核心仍含模块级 import/export 语句')

  // 在独立作用域里执行打包产物（等价于浏览器里跑的那份代码）
  const factory = new Function(`${coreSrc}
    return { createGlyphSet, parseUnifontBuffer, layoutText, buildLitematic, createBlockCatalog, packBlockStates, unpackBlockStates, bitsForPalette }`)
  const core = factory()

  const { gunzipSync } = await import('node:zlib')
  const moj = JSON.parse(readFileSync(join(ROOT, 'data', 'glyphs', 'mojangles.json'), 'utf8'))
  const uni = core.parseUnifontBuffer(gunzipSync(readFileSync(join(ROOT, 'data', 'glyphs', 'unifont.bin.gz'))))
  const blocksData = JSON.parse(readFileSync(join(ROOT, 'data', 'blocks-by-version.json'), 'utf8'))
  const catalog = core.createBlockCatalog(blocksData)

  const text = 'Minecraft 我的世界 2026!'
  const glyphSet = core.createGlyphSet({ mojangles: moj, unifontLookup: uni.lookup, latinDots: 2 })
  const layout = core.layoutText(text, { glyphSet, dotBlocks: 1, spacing: 1, border: 2 })
  const built = core.buildLitematic({
    layout,
    bgBlock: 'minecraft:red_concrete',
    fgBlock: 'minecraft:white_concrete',
    dataVersion: catalog.dataVersionOf('26.3'),
    name: 'browser-bundle-test',
    author: 'test'
  })
  assert(built.bytes.length > 0, '未生成字节')

  // 与浏览器一致的 gzip 路径：CompressionStream
  assert(typeof CompressionStream !== 'undefined', '当前 Node 不支持 CompressionStream')
  const gz = new Uint8Array(await new Response(
    new Blob([built.bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer())

  const tmp2 = mkdtempSync(join(tmpdir(), 'slogan-bundle-'))
  try {
    const file = join(tmp2, 'bundle.litematic')
    writeFileSync(file, gz)
    // 自回读
    const info = inspectLitematic(built.bytes, { fontBlock: 'minecraft:white_concrete' })
    let diff = 0
    for (let i = 0; i < info.grid.length; i++) if (info.grid[i] !== layout.grid[i]) diff++
    assertEqual(diff, 0, '自回读不一致格数')
    // 第三方（若装了 litemapy）
    if (existsSync(venvPython)) {
      const gridFile = join(tmp2, 'grid.json')
      writeFileSync(gridFile, JSON.stringify({
        width: layout.width, height: layout.height,
        bg: 'minecraft:red_concrete', fg: 'minecraft:white_concrete',
        grid: Array.from(layout.grid).join('')
      }))
      const out = execFileSync(venvPython, [join(ROOT, 'test', 'verify-litemapy.py'), file, gridFile], {
        encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })
      assert(/PASS:/.test(out), `litemapy 校验未通过：\n${out}`)
    }
  } finally {
    rmSync(tmp2, { recursive: true, force: true })
  }
})

/* ================================================================== */
if (pending.length) await Promise.all(pending)
console.log(`\n${'='.repeat(60)}`)
console.log(`测试结果：${passed} 通过 / ${failed} 失败`)
if (failed) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`)
  process.exit(1)
}
