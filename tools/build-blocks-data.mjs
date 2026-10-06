/**
 * 构建版本化方块目录（data/blocks-by-version.json）
 *
 * 数据源：misode/mcmeta（GitHub，逐版本 tag）
 *   - summary/versions/data.json        → 全部版本 + data_version（写进 litematic 的 MinecraftDataVersion）
 *   - <version>-registries/block/data.json → 该版本的方块 ID 列表
 *
 * 产出结构：
 * {
 *   source, generatedAt,
 *   versions: [{ id, dataVersion, releaseTime }],        // 版本从小到大
 *   blocks:   { "<name>": [[startIdx, endIdx], ...] }    // 该方块存在于哪些版本（闭区间）
 * }
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const CDN = 'https://cdn.jsdelivr.net/gh/misode/mcmeta@'
const SUMMARY_VERSIONS = `${CDN}summary/versions/data.json`

/** 支持范围：从 1.20 起，到 manifest 里的最新正式版为止 */
const MIN_VERSION = process.env.MC_MIN_VERSION || '1.20'

/** 版本号排序键：把 "1.20.4" / "26.3" 变成可比较的数组 */
function versionKey (id) {
  const m = id.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

function compareVersions (a, b) {
  const ka = versionKey(a)
  const kb = versionKey(b)
  if (!ka || !kb) return 0
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i]
  }
  return 0
}

async function fetchJson (url, { retries = 4 } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'mc-slogan-wall/1.0' } })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 400 * attempt))
    }
  }
  throw new Error(`fetch failed: ${url} (${lastErr?.message})`)
}

console.log(`[1/3] 读取版本清单 …`)
const allVersions = await fetchJson(SUMMARY_VERSIONS)
if (!Array.isArray(allVersions)) throw new Error('版本清单格式异常')

const releases = allVersions
  .filter((v) => v.type === 'release' && versionKey(v.id))
  .filter((v) => compareVersions(v.id, MIN_VERSION) >= 0)
  .sort((a, b) => compareVersions(a.id, b.id))

console.log(`      共 ${allVersions.length} 个版本，落在 [${MIN_VERSION}, 最新] 的正式版 ${releases.length} 个`)
console.log(`      最新：${releases.at(-1)?.id}（data_version ${releases.at(-1)?.data_version}）`)

console.log(`[2/3] 拉取各版本方块注册表 …`)
const perVersion = []
for (const v of releases) {
  const url = `${CDN}${v.id}-registries/block/data.json`
  let list = null
  try {
    list = await fetchJson(url, { retries: 3 })
  } catch (err) {
    console.warn(`      ! ${v.id} 拉取失败：${err.message}`)
  }
  if (!Array.isArray(list) || list.length === 0) {
    console.warn(`      ! ${v.id} 无方块数据，跳过`)
    continue
  }
  perVersion.push({ id: v.id, dataVersion: v.data_version, releaseTime: v.release_time, blocks: list })
  console.log(`      ${v.id.padEnd(9)} ${String(list.length).padStart(4)} 个方块  (data_version ${v.data_version})`)
}

if (perVersion.length === 0) throw new Error('没有任何版本拿到方块数据')

console.log(`[3/3] 归并为「方块 → 版本区间」 …`)
const versions = perVersion.map((v) => ({ id: v.id, dataVersion: v.dataVersion, releaseTime: v.releaseTime }))
const indexOf = new Map(versions.map((v, i) => [v.id, i]))

/** name -> 版本索引数组（升序） */
const presence = new Map()
for (const v of perVersion) {
  const idx = indexOf.get(v.id)
  for (const name of v.blocks) {
    if (!presence.has(name)) presence.set(name, [])
    presence.get(name).push(idx)
  }
}

/** 连续索引 → 闭区间 */
function toRanges (indexes) {
  const ranges = []
  let start = indexes[0]
  let prev = indexes[0]
  for (let i = 1; i < indexes.length; i++) {
    const cur = indexes[i]
    if (cur === prev + 1) { prev = cur; continue }
    ranges.push([start, prev])
    start = prev = cur
  }
  ranges.push([start, prev])
  return ranges
}

const blocks = {}
for (const [name, indexes] of [...presence.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  blocks[name] = toRanges(indexes)
}

const out = {
  source: 'misode/mcmeta (github.com/misode/mcmeta)',
  generatedAt: new Date().toISOString(),
  versionRange: [versions[0].id, versions.at(-1).id],
  versions,
  blocks
}

const outPath = join(ROOT, 'data', 'blocks-by-version.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out))

const total = Object.keys(blocks).length
const allVersion = Object.values(blocks).filter((r) => r.length === 1 && r[0][0] === 0 && r[0][1] === versions.length - 1).length
console.log(`\n完成：${outPath}`)
console.log(`  版本 ${versions.length} 个：${versions[0].id} … ${versions.at(-1).id}`)
console.log(`  方块 ${total} 个（其中 ${allVersion} 个全版本通用）`)
console.log(`  体积 ${(JSON.stringify(out).length / 1024).toFixed(1)} KB`)
