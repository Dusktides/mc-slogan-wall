/**
 * Node 侧装配：加载数据文件 → 排版 → 生成投影字节。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

import { createGlyphSet, parseUnifontBuffer } from '../core/glyphs.mjs'
import { layoutText } from '../core/layout.mjs'
import { createBlockCatalog } from '../core/blocks.mjs'
import { buildLitematic } from '../core/schematic.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PACKAGE_ROOT = resolve(__dirname, '..', '..')
export const DATA_DIR = join(PACKAGE_ROOT, 'data')

let cache = null

const MISSING_HELP = (p) => `缺少数据文件：${p}

这个项目不携带任何 Minecraft 数据（字形、方块名等都是 Mojang 的资源），
首次使用需要在本机生成一次：

    node tools/setup.mjs        （或双击 start.cmd）

需要本机装过并至少启动过一次 Minecraft，另外方块目录与 Unifont 需要联网。
游戏装在别处时可以设置环境变量 MC_DIR 指向 .minecraft 目录。`

/** 载入并缓存所有数据文件 */
export function loadData (dataDir = DATA_DIR) {
  if (cache && cache.dataDir === dataDir) return cache
  const mojanglesPath = join(dataDir, 'glyphs', 'mojangles.json')
  const unifontPath = join(dataDir, 'glyphs', 'unifont.bin.gz')
  const blocksPath = join(dataDir, 'blocks-by-version.json')
  const namesPath = join(dataDir, 'block-names-zh.json')
  const colorsPath = join(dataDir, 'block-colors.json')
  const shapesPath = join(dataDir, 'block-shapes.json')
  for (const p of [mojanglesPath, unifontPath, blocksPath]) {
    if (!existsSync(p)) throw new Error(MISSING_HELP(p))
  }
  const mojangles = JSON.parse(readFileSync(mojanglesPath, 'utf8'))
  const unifont = parseUnifontBuffer(gunzipSync(readFileSync(unifontPath)))
  const blocks = JSON.parse(readFileSync(blocksPath, 'utf8'))
  const zhNames = existsSync(namesPath) ? JSON.parse(readFileSync(namesPath, 'utf8')) : null
  const colors = existsSync(colorsPath) ? JSON.parse(readFileSync(colorsPath, 'utf8')) : null
  const shapes = existsSync(shapesPath) ? JSON.parse(readFileSync(shapesPath, 'utf8')) : null
  cache = {
    dataDir,
    mojangles,
    unifont,
    catalog: createBlockCatalog(blocks, zhNames, shapes),
    blocksRaw: blocks,
    zhNames,
    colors,
    shapes
  }
  return cache
}

/** 文本里是否含需要 Unifont 的字符 */
export function needsUnifont (text, mojangles) {
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === 10) continue
    if (mojangles.glyphs[cp] !== undefined) continue
    if (mojangles.advances?.[cp] !== undefined) continue
    return true
  }
  return false
}

/**
 * 生成标语墙投影
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} [opts.version]      目标游戏版本
 * @param {string} [opts.bg]           背景方块
 * @param {string} [opts.fg]           字体方块
 * @param {number} [opts.spacing]
 * @param {number} [opts.border]
 * @param {number} [opts.lineGap]
 * @param {number} [opts.dotBlocks]
 * @param {number|'auto'} [opts.latinDots]
 * @param {boolean} [opts.trim]
 * @param {string} [opts.name]
 * @param {string} [opts.author]
 * @param {string} [opts.description]
 * @param {boolean} [opts.includeAir]
 * @param {number} [opts.time]
 */
export function generateSlogan (opts) {
  const {
    text,
    version,
    bg = 'minecraft:red_concrete',
    fg = 'minecraft:white_concrete',
    spacing = 1,
    spacingMode = 'gap',
    border = 0,
    lineGap = 1,
    align = 'center',
    dotBlocks = 1,
    latinDots = 'auto',
    trim = false,
    name,
    author = 'mc-slogan-wall',
    description = '',
    includeAir = true,
    time = Date.now()
  } = opts

  if (typeof text !== 'string' || text.length === 0) throw new Error('文本不能为空')
  const data = loadData(opts.dataDir)
  const catalog = data.catalog
  const targetVersion = version || catalog.latest
  const dataVersion = catalog.dataVersionOf(targetVersion)

  // 方块名解析（支持中文名 / 裸名 / 带命名空间）与存在性校验
  const resolved = {}
  for (const [label, input] of [['背景', bg], ['字体', fg]]) {
    const id = catalog.resolveId(input)
    if (!id) {
      const hints = catalog.suggest(input, targetVersion)
      throw new Error(`${label}方块「${input}」无法识别。` +
        (hints.length ? `\n  你是不是想用：${hints.map((h) => catalog.labelOf(h)).join('、')}` : '\n  用 --list-blocks 查看可用方块'))
    }
    if (!catalog.existsIn(id, targetVersion)) {
      const where = catalog.versionsOf(id.replace(/^minecraft:/, ''))
      const hint = where.length
        ? `该方块存在于：${where[0]} … ${where[where.length - 1]}（共 ${where.length} 个版本）`
        : '数据里没有这个方块，请用 --list-blocks 查看可用方块'
      throw new Error(`${label}方块「${catalog.labelOf(id)}」在 Minecraft ${targetVersion} 中不存在。\n  ${hint}`)
    }
    resolved[label] = id
  }
  const bgId = resolved['背景']
  const fgId = resolved['字体']
  if (bgId === fgId) throw new Error('背景材质与字体材质不能相同')

  // 非完整方块（台阶/栅栏/植物/需依附等）不拦，但要提醒
  const warnings = []
  for (const [label, id] of [['背景', bgId], ['字体', fgId]]) {
    const shape = catalog.shapeOf(id)
    if (shape === 'incomplete') warnings.push(`${label}方块「${catalog.labelOf(id)}」不是完整方块（台阶/栅栏/植物/需依附等），用作墙面会留下空隙`)
    else if (shape === 'partial') warnings.push(`${label}方块「${catalog.labelOf(id)}」只有在部分状态下才是满格方块，默认状态可能留空隙`)
  }

  // 汉字存在 → 默认让拉丁字母与汉字等高（latinDots = 2）
  const hasCjk = needsUnifont(text, data.mojangles)
  const resolvedLatinDots = latinDots === 'auto' ? (hasCjk ? 2 : 1) : Number(latinDots)
  if (![1, 2, 3, 4].includes(resolvedLatinDots)) throw new Error('latinDots 只能是 1/2/3/4 或 auto')

  const glyphSet = createGlyphSet({
    mojangles: data.mojangles,
    unifontLookup: data.unifont.lookup,
    latinDots: resolvedLatinDots
  })

  const layout = layoutText(text, {
    glyphSet, dotBlocks, spacing, spacingMode, border, lineGap, align, trimEmpty: trim
  })

  const schematicName = name || defaultName(text)
  const built = buildLitematic({
    layout,
    bgBlock: bgId,
    fgBlock: fgId,
    dataVersion,
    name: schematicName,
    author,
    description: description || `Minecraft 标语墙：${text.replace(/\n/g, ' / ')}`,
    time,
    includeAir
  })

  return {
    layout,
    name: schematicName,
    version: targetVersion,
    dataVersion,
    bg: bgId,
    fg: fgId,
    latinDots: resolvedLatinDots,
    dotBlocks,
    spacing,
    spacingMode,
    border,
    lineGap,
    align,
    hasCjk,
    warnings,
    bits: built.bits,
    palette: built.palette,
    longCount: built.longCount,
    nbt: built.bytes,
    gzip: () => gzipSync(built.bytes, { level: 9 })
  }
}

function defaultName (text) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 32)
  return clean.length ? clean : 'slogan'
}
