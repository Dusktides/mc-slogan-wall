/**
 * 从客户端 jar 的方块贴图生成预览用颜色表（data/block-colors.json）。
 * 做法：assets/minecraft/textures/block/<name>.png 取平均色；贴图名对不上时按
 *       常见后缀回退（_slab/_stairs/_wall/... 用基材贴图）。
 *
 * 用法：node tools/build-block-colors.mjs [--jar <客户端jar>]
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { openJar } from './lib/zip.mjs'
import { decodePng } from './lib/png.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function findClientJar () {
  const i = process.argv.indexOf('--jar')
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  const mcDir = process.env.MC_DIR || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '.minecraft')
  const versionsDir = join(mcDir, 'versions')
  const candidates = []
  for (const name of readdirSync(versionsDir)) {
    const dir = join(versionsDir, name)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) if (f.endsWith('.jar')) candidates.push({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (!candidates.length) throw new Error('找不到客户端 jar')
  return candidates[0].path
}

/** 方块名 → 候选贴图名（按优先级） */
function textureCandidates (name) {
  const out = new Set()
  const variants = (base) => {
    if (!base) return
    out.add(base)
    out.add(base + 's')
    for (const s of ['_side', '_front', '_top', '_end', '_still', '_stage0', '_planks', '_log', '_block', '_wool']) out.add(base + s)
  }
  const stems = [
    '_wall_hanging_sign', '_hanging_sign', '_wall_sign', '_sign',
    '_wall_banner', '_banner', '_fence_gate', '_fence',
    '_pressure_plate', '_button', '_trapdoor', '_door',
    '_slab', '_stairs', '_carpet', '_shelf', '_pane', '_bars', '_chain', '_bed',
    '_candle_cake', '_wall_fan', '_wall', '_wood', '_fan'
  ]
  variants(name)
  if (name.startsWith('waxed_')) variants(name.replace(/^waxed_/, ''))
  if (name.startsWith('stripped_')) variants(name.replace(/^stripped_/, ''))
  for (const suffix of stems) {
    if (!name.endsWith(suffix)) continue
    const base = name.slice(0, -suffix.length)
    variants(base)
    variants(base + '_planks')
    variants(base + '_log')
    variants(base + '_wool')
  }
  return [...out].filter(Boolean)
}

const jarPath = findClientJar()
console.log(`客户端 jar：${jarPath}`)
const jar = openJar(jarPath)

const blocksData = JSON.parse(
  (await import('node:fs')).readFileSync(join(ROOT, 'data', 'blocks-by-version.json'), 'utf8')
)
const allBlocks = Object.keys(blocksData.blocks)
console.log(`方块目录 ${allBlocks.length} 个`)

const PREFIX = 'assets/minecraft/textures/block/'
const available = new Map()
for (const entry of jar.list(PREFIX)) {
  if (!entry.endsWith('.png')) continue
  available.set(entry.slice(PREFIX.length, -4), entry)
}
console.log(`贴图 ${available.size} 张`)

const cache = new Map()
function averageColor (texName) {
  if (cache.has(texName)) return cache.get(texName)
  const entry = available.get(texName)
  if (!entry) { cache.set(texName, null); return null }
  let rgba
  try {
    rgba = decodePng(jar.read(entry)).rgba
  } catch {
    cache.set(texName, null)
    return null
  }
  let r = 0; let g = 0; let b = 0; let n = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue
    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++
  }
  const color = n === 0 ? null : '#' + [r / n, g / n, b / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  cache.set(texName, color)
  return color
}

const colors = {}
let hit = 0
let miss = []
for (const name of allBlocks) {
  let color = null
  for (const cand of textureCandidates(name)) {
    color = averageColor(cand)
    if (color) break
  }
  if (color) { colors[name] = color; hit++ } else { miss.push(name) }
}

mkdirSync(join(ROOT, 'data'), { recursive: true })
const outPath = join(ROOT, 'data', 'block-colors.json')
writeFileSync(outPath, JSON.stringify(colors))
console.log(`\n完成：${outPath}`)
console.log(`  命中贴图 ${hit}/${allBlocks.length}，未命中 ${miss.length}`)
if (miss.length) console.log(`  未命中示例：${miss.slice(0, 15).join(', ')}`)
for (const n of ['red_concrete', 'white_concrete', 'black_concrete', 'oak_planks', 'stone', 'white_wool']) {
  console.log(`  ${n.padEnd(18)} ${colors[n] ?? '(无)'}`)
}
