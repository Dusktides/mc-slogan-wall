/**
 * 打包单文件 HTML 预览页：web/slogan-tool.html
 *   - 内联核心库（core/*.mjs，去掉 import/export 后按依赖顺序拼接）
 *   - 内联 Mojangles 字形 JSON、方块目录 JSON、方块颜色表 JSON
 *   - 内联 Unifont 二进制（gzip + base64，浏览器用 DecompressionStream 解压）
 *
 * 用法：node tools/build-preview.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const CORE_ORDER = ['glyphs.mjs', 'nbt.mjs', 'schematic.mjs', 'layout.mjs', 'blocks.mjs']

function bundleCore () {
  const parts = []
  for (const file of CORE_ORDER) {
    let src = readFileSync(join(ROOT, 'src', 'core', file), 'utf8')
    // 去掉 import 语句与 export 关键字（同处一个作用域，无需模块系统）
    src = src.replace(/^\s*import\s[^\n]*\n/gm, '')
    src = src.replace(/^export\s+(const|let|function|class)\s/gm, '$1 ')
    src = src.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    parts.push(`/* ---- ${file} ---- */\n${src.trim()}`)
  }
  return parts.join('\n\n')
}

function readJson (relPath, label) {
  const p = join(ROOT, relPath)
  if (!existsSync(p)) throw new Error(`缺少 ${relPath}（${label}），请先运行对应的构建脚本`)
  return readFileSync(p, 'utf8')
}

/** 内联到 <script type="application/json"> 时的安全转义 */
function safeJson (text) {
  return text.replace(/<\//g, '<\\/')
}

const template = readFileSync(join(ROOT, 'web', 'template.html'), 'utf8')

const mojangles = readJson('data/glyphs/mojangles.json', 'Mojangles 字形')
const blocks = readJson('data/blocks-by-version.json', '版本化方块目录')
const zhNames = readJson('data/block-names-zh.json', '方块中文名')
const shapes = readJson('data/block-shapes.json', '方块形状（完整方块判定）')
const colors = readJson('data/block-colors.json', '方块颜色表')
const unifontGz = readFileSync(join(ROOT, 'data', 'glyphs', 'unifont.bin.gz')).toString('base64')

// 版本数据只保留 UI 需要的字段
const blocksRaw = JSON.parse(blocks)
const versionsForUi = {
  source: blocksRaw.source,
  generatedAt: blocksRaw.generatedAt,
  versions: blocksRaw.versions,
  blocks: blocksRaw.blocks
}

const html = template
  .replace('__CORE__', () => bundleCore())
  .replace('__MOJANGLES__', () => safeJson(mojangles))
  .replace('__VERSIONS__', () => safeJson(JSON.stringify(versionsForUi)))
  .replace('__ZH_NAMES__', () => safeJson(zhNames))
  .replace('__BLOCK_SHAPES__', () => safeJson(shapes))
  .replace('__BLOCK_COLORS__', () => colors.trim())
  .replace('__UNIFONT__', () => unifontGz)

const outPath = join(ROOT, 'web', 'slogan-tool.html')
writeFileSync(outPath, html)

const kb = (n) => (n / 1024).toFixed(0) + ' KB'
console.log(`已生成：${outPath}`)
console.log(`  总大小      ${kb(Buffer.byteLength(html))}`)
console.log(`  Unifont     ${kb(Buffer.byteLength(unifontGz))}（base64，运行时解压）`)
console.log(`  Mojangles   ${kb(Buffer.byteLength(mojangles))}`)
console.log(`  方块目录    ${kb(Buffer.byteLength(JSON.stringify(versionsForUi)))}`)
console.log(`  中文名      ${kb(Buffer.byteLength(zhNames))}`)
console.log(`  方块形状    ${kb(Buffer.byteLength(shapes))}`)
console.log(`  颜色表      ${kb(Buffer.byteLength(colors))}`)
console.log('\n直接用浏览器打开即可（双击文件，无需服务器）。')
