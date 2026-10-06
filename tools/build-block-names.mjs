/**
 * 从本机 Minecraft 资源库的 zh_cn.json 提取方块中文名 → data/block-names-zh.json
 *
 * 语言文件位置由 assets/indexes/<n>.json 的 minecraft/lang/zh_cn.json 记录，
 * 实体文件在 assets/objects/<hash 前两位>/<hash>。
 *
 * 用法：node tools/build-block-names.mjs [--mc-dir <路径>]
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const mcDirIdx = process.argv.indexOf('--mc-dir')
const MC_DIR = mcDirIdx >= 0 && process.argv[mcDirIdx + 1]
  ? process.argv[mcDirIdx + 1]
  : (process.env.MC_DIR || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '.minecraft'))

function findLangFile (langKey) {
  const indexDir = join(MC_DIR, 'assets', 'indexes')
  if (!existsSync(indexDir)) throw new Error(`找不到资源索引目录：${indexDir}`)
  const indexes = readdirSync(indexDir).filter((f) => f.endsWith('.json'))
  for (const idx of indexes) {
    let json
    try {
      json = JSON.parse(readFileSync(join(indexDir, idx), 'utf8'))
    } catch { continue }
    const entry = json.objects?.[langKey]
    if (!entry) continue
    const file = join(MC_DIR, 'assets', 'objects', entry.hash.slice(0, 2), entry.hash)
    if (existsSync(file)) return { file, index: idx }
  }
  return null
}

const found = findLangFile('minecraft/lang/zh_cn.json')
if (!found) throw new Error('资源库里找不到 minecraft/lang/zh_cn.json（游戏需至少启动过一次）')
console.log(`语言文件：${found.file}\n（来自资源索引 ${found.index}）`)

const lang = JSON.parse(readFileSync(found.file, 'utf8'))
const byId = {}
let count = 0
for (const [key, value] of Object.entries(lang)) {
  if (!key.startsWith('block.minecraft.')) continue
  const id = key.slice('block.minecraft.'.length)
  if (typeof value !== 'string' || !value.trim()) continue
  // 跳过未翻译的占位（形如 block.minecraft.xxx）
  if (value.startsWith('block.minecraft.')) continue
  byId[id] = value
  count++
}
console.log(`方块中文名 ${count} 条`)

// 与方块目录求交集，看覆盖率
const blockList = JSON.parse(readFileSync(join(ROOT, 'data', 'blocks-by-version.json'), 'utf8'))
const all = Object.keys(blockList.blocks)
const missing = all.filter((n) => !byId[n])
console.log(`方块目录 ${all.length} 个，其中有中文名 ${all.length - missing.length} 个，缺 ${missing.length} 个`)
if (missing.length) console.log(`  缺中文名示例：${missing.slice(0, 12).join(', ')}`)

mkdirSync(join(ROOT, 'data'), { recursive: true })
const outPath = join(ROOT, 'data', 'block-names-zh.json')
writeFileSync(outPath, JSON.stringify({
  source: 'Minecraft 本地资源库 minecraft/lang/zh_cn.json',
  generatedAt: new Date().toISOString(),
  names: byId
}))
console.log(`\n完成：${outPath}`)
for (const n of ['red_concrete', 'white_concrete', 'black_concrete', 'oak_slab', 'pale_oak_planks', 'quartz_block']) {
  console.log(`  ${n.padEnd(18)} ${byId[n] ?? '(无)'}`)
}
