/**
 * 从客户端 jar 的方块模型判定「是否为完整方块（满格立方体）」。
 *
 * 判定依据不是名字，而是真实模型：
 *   blockstates/<name>.json → variants/multipart 里的模型
 *   models/block/<x>.json → 沿 parent 链找到 elements
 *   完整方块 = 恰好 1 个 element、无 rotation、from [0,0,0] 到 [16,16,16]
 *
 * 产出 data/block-shapes.json：
 *   { shapes: { "<name>": { all: bool, any: bool, reason: string } } }
 *   all = 所有变体都是完整方块（可安全用作墙面）
 *   any = 至少有一个变体是完整方块
 *
 * 用法：node tools/build-block-shapes.mjs [--jar <客户端jar>]
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { openJar } from './lib/zip.mjs'

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

const jar = openJar(findClientJar())
console.log(`客户端 jar：${jar.list('assets/minecraft/models/block/').length} 个模型`)

const modelCache = new Map()
function loadModel (id) {
  const path = `assets/minecraft/models/${String(id).replace(/^minecraft:/, '')}.json`
  if (modelCache.has(path)) return modelCache.get(path)
  let model = null
  if (jar.has(path)) {
    try {
      model = JSON.parse(jar.readText(path))
    } catch { model = null }
  }
  modelCache.set(path, model)
  return model
}

/** elements 是否恰好填满 0..16 的立方体 */
function isFullCubeElements (elements) {
  if (!Array.isArray(elements) || elements.length !== 1) return false
  const e = elements[0]
  if (!e || e.rotation) return false
  const f = e.from
  const t = e.to
  if (!Array.isArray(f) || !Array.isArray(t)) return false
  return f[0] === 0 && f[1] === 0 && f[2] === 0 && t[0] === 16 && t[1] === 16 && t[2] === 16
}

/** 沿 parent 链判断模型是否是完整方块；返回 true/false/null（模型缺失） */
function modelShape (id, depth = 0) {
  if (depth > 12) return false
  const model = loadModel(id)
  if (!model) return null
  if (model.elements) return isFullCubeElements(model.elements)
  if (model.parent) return modelShape(model.parent, depth + 1)
  return false
}

/** 从 blockstate 里取出一个变体引用的所有模型名 */
function modelsOfBlockstate (name) {
  const path = `assets/minecraft/blockstates/${name}.json`
  if (!jar.has(path)) return null
  let bs
  try {
    bs = JSON.parse(jar.readText(path))
  } catch { return null }
  const models = []
  const push = (v) => {
    if (!v) return
    if (Array.isArray(v)) {
      for (const item of v) if (item?.model) models.push(item.model)
    } else if (v.model) {
      models.push(v.model)
    }
  }
  if (bs.variants) {
    for (const v of Object.values(bs.variants)) push(v)
  }
  if (Array.isArray(bs.multipart)) {
    for (const part of bs.multipart) push(part.apply)
  }
  return models
}

const blockList = JSON.parse(readFileSync(join(ROOT, 'data', 'blocks-by-version.json'), 'utf8'))
const all = Object.keys(blockList.blocks)
console.log(`方块目录 ${all.length} 个`)

const shapes = {}
let countAll = 0
let countAny = 0
let noBlockstate = 0
for (const name of all) {
  const models = modelsOfBlockstate(name)
  if (models === null) {
    shapes[name] = { all: false, any: false, reason: 'no-blockstate' }
    noBlockstate++
    continue
  }
  if (models.length === 0) {
    shapes[name] = { all: false, any: false, reason: 'no-model' }
    noBlockstate++
    continue
  }
  const results = models.map((m) => modelShape(m))
  const known = results.filter((r) => r !== null)
  const isAll = known.length > 0 && results.every((r) => r === true)
  const isAny = results.some((r) => r === true)
  shapes[name] = {
    all: isAll,
    any: isAny,
    reason: isAll ? 'full-cube' : (isAny ? 'partial' : 'not-cube'),
    variants: models.length
  }
  if (isAll) countAll++
  else if (isAny) countAny++
}

mkdirSync(join(ROOT, 'data'), { recursive: true })
const outPath = join(ROOT, 'data', 'block-shapes.json')
writeFileSync(outPath, JSON.stringify({
  source: 'Minecraft 客户端 jar 的 blockstates + models',
  generatedAt: new Date().toISOString(),
  shapes
}))
console.log(`\n完成：${outPath}`)
console.log(`  完整方块（所有变体都是满格立方体）：${countAll}`)
console.log(`  部分变体是完整方块：${countAny}`)
console.log(`  无 blockstate / 无模型（空气、技术方块等）：${noBlockstate}`)
console.log(`  其余（台阶/栅栏/植物/需依附等）：${all.length - countAll - countAny - noBlockstate}`)

const check = ['red_concrete', 'white_concrete', 'oak_planks', 'oak_log', 'stone', 'cobblestone', 'deepslate',
  'basalt', 'blackstone', 'tuff', 'andesite', 'diorite', 'granite', 'prismarine', 'quartz_block',
  'obsidian', 'iron_block', 'gold_block', 'diamond_block', 'copper_block', 'oxidized_copper',
  'white_glazed_terracotta', 'white_terracotta', 'white_wool',
  'oak_slab', 'oak_stairs', 'oak_fence', 'oak_door', 'oak_trapdoor', 'oak_shelf', 'oak_sign',
  'torch', 'flower_pot', 'cake', 'campfire', 'dandelion', 'cactus', 'vine', 'amethyst_cluster',
  'oak_button', 'player_head', 'skeleton_skull']
console.log('\n抽样核对：')
for (const n of check) {
  const s = shapes[n]
  console.log(`  ${n.padEnd(24)} ${s ? (s.all ? '✅ 完整' : (s.any ? '⚠ 部分' : '❌ 非完整')) + '  (' + s.reason + ')' : '(不在目录里)'}`)
}
