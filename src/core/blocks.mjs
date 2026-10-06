/**
 * 版本化方块目录：回答「这个方块在所选版本里存在吗」。
 *
 * 数据由 tools/build-blocks-data.mjs 生成（来源 misode/mcmeta，逐版本 block 注册表）：
 *   versions: [{ id, dataVersion, releaseTime }]   // 由旧到新
 *   blocks:   { "<name>": [[startIdx, endIdx], ...] } // 闭区间
 */

/** 不适合作为墙面的方块（仍保留在数据里，仅默认从候选列表中隐藏） */
const NON_PLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'fire', 'soul_fire',
  'nether_portal', 'end_portal', 'end_gateway', 'bubble_column', 'light',
  'moving_piston', 'piston_head', 'tall_seagrass', 'frosted_ice',
  'powder_snow', 'barrier', 'structure_void', 'jigsaw', 'light_block',
  'spawner', 'trial_spawner', 'vault', 'budding_amethyst', 'reinforced_deepslate'
])

export function createBlockCatalog (data, zhNames = null, shapeData = null) {
  if (!data || !Array.isArray(data.versions) || !data.blocks) throw new Error('方块目录数据格式不正确')
  const versions = data.versions
  const indexOf = new Map(versions.map((v, i) => [v.id, i]))
  const blocks = data.blocks
  const shapes = shapeData?.shapes ?? null

  /** 去掉命名空间，得到数据里的裸名 */
  const bare = (id) => String(id).replace(/^minecraft:/, '')

  /** 形状：complete = 所有变体都是满格立方体；usable = 至少有一个变体是 */
  function shapeOf (blockId) {
    if (!shapes) return 'unknown'
    const s = shapes[bare(blockId)]
    if (!s) return 'unknown'
    if (s.all) return 'complete'
    if (s.any) return 'partial'
    return 'incomplete'
  }
  const isFullCube = (id) => shapeOf(id) === 'complete'

  /* ---------------- 中文名 ---------------- */
  const names = zhNames?.names ?? null
  const reverse = new Map()
  if (names) {
    for (const [id, name] of Object.entries(names)) {
      if (!reverse.has(name)) reverse.set(name, id)
    }
  }

  /** 取中文名（含墙旗等派生回退），没有则返回 null */
  function zhNameOf (blockId) {
    if (!names) return null
    const id = bare(blockId)
    if (names[id]) return names[id]
    // block.minecraft.<x>_wall_banner 在语言文件里没有独立词条，用 <x>_banner 的名字
    const stripped = id.replace(/_wall_banner$/, '_banner')
    if (names[stripped]) return names[stripped]
    return null
  }

  /** 展示用标签：中文名（id） */
  function labelOf (blockId) {
    const id = bare(blockId)
    const zh = zhNameOf(id)
    return zh ? `${zh}（${id}）` : id
  }

  /** 把用户输入解析成规范 id：支持 中文名 / 裸名 / 带命名空间 */
  function resolveId (input) {
    const raw = String(input).trim()
    if (!raw) return null
    const id = bare(raw)
    if (blocks[id]) return `minecraft:${id}`
    if (reverse.has(raw)) return `minecraft:${reverse.get(raw)}`
    // 允许「中文名（id）」这种展示格式
    const m = raw.match(/^(.+?)（(.+?)）$/)
    if (m) {
      const inner = bare(m[2])
      if (blocks[inner]) return `minecraft:${inner}`
      if (reverse.has(m[1])) return `minecraft:${reverse.get(m[1])}`
    }
    return null
  }

  function covers (ranges, idx) {
    return ranges.some(([a, b]) => idx >= a && idx <= b)
  }

  /* ---------------- 墙面材质分类 ---------------- */
  const DYE_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

  // 石材族：按名字里的「词」匹配，避免 sandstone / end_stone 被误收
  const STONE_TOKENS = new Set(['quartz', 'stone', 'cobblestone', 'deepslate', 'basalt', 'blackstone',
    'tuff', 'andesite', 'diorite', 'granite', 'prismarine'])

  const METAL_MINERAL = new Set([
    'obsidian', 'crying_obsidian', 'iron_block', 'gold_block', 'diamond_block', 'emerald_block',
    'lapis_block', 'redstone_block', 'coal_block', 'netherite_block', 'amethyst_block',
    'raw_iron_block', 'raw_copper_block', 'raw_gold_block',
    'copper_block', 'exposed_copper', 'weathered_copper', 'oxidized_copper',
    'cut_copper', 'exposed_cut_copper', 'weathered_cut_copper', 'oxidized_cut_copper',
    'waxed_copper_block', 'waxed_exposed_copper', 'waxed_weathered_copper', 'waxed_oxidized_copper',
    'waxed_cut_copper', 'waxed_exposed_cut_copper', 'waxed_weathered_cut_copper', 'waxed_oxidized_cut_copper'
  ])

  const isWoodFamily = (name) =>
    name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_planks') ||
    name.endsWith('_hyphae') || name.endsWith('_stem') || name.endsWith('_mosaic') ||
    name === 'bamboo_block' || name === 'bamboo_mosaic'

  /** 分类判定顺序即展示顺序 */
  const CATEGORIES = [
    { key: 'concrete', label: '混凝土', test: (n) => n.endsWith('_concrete') },
    { key: 'wool', label: '羊毛', test: (n) => n.endsWith('_wool') },
    { key: 'glazed', label: '带釉陶瓦', test: (n) => n.endsWith('_glazed_terracotta') },
    { key: 'terracotta', label: '陶瓦', test: (n) => n.endsWith('_terracotta') && !n.endsWith('_glazed_terracotta') },
    { key: 'stone', label: '石英与石材', test: (n) => n.split('_').some((t) => STONE_TOKENS.has(t)) },
    { key: 'metal', label: '金属与矿物块', test: (n) => METAL_MINERAL.has(n) },
    { key: 'wood', label: '原木与木板', test: (n) => isWoodFamily(n) },
    { key: 'other', label: '其它完整方块', test: () => true }
  ]

  function categoryOf (name) {
    for (const c of CATEGORIES) if (c.test(name)) return c.key
    return 'other'
  }

  /** 取指定范围内、指定版本可用的方块（裸名） */
  function collect (versionId, { search = '', scope = 'recommended' } = {}) {
    const i = indexOf.get(versionId)
    if (i === undefined) throw new Error(unknownVersionMessage(versionId, versions.map((v) => v.id)))
    const needle = String(search).trim().toLowerCase()
    const pool = new Set(
      Object.keys(blocks).filter((n) => {
        if (NON_PLACEABLE.has(n)) return false // 空气/水/火一类的技术方块永不可用
        if (!covers(blocks[n], i)) return false
        if (scope === 'all') return true
        // full-cubes 与 recommended 都只保留完整方块：
        // 台阶/楼梯/围墙、门/栅栏/活板门/展示架、植物、以及需要依附的火把/告示牌/按钮/藤蔓等一律排除
        return isFullCube(n)
      })
    )
    if (!needle) return pool
    const filtered = new Set()
    for (const n of pool) {
      const zh = zhNameOf(n) || ''
      if (n.includes(needle) || zh.includes(needle)) filtered.add(n)
    }
    return filtered
  }

  return {
    versions,
    versionIds: versions.map((v) => v.id),
    latest: versions[versions.length - 1].id,
    hasZhNames: names !== null,
    hasShapes: shapes !== null,
    zhNameOf,
    labelOf,
    resolveId,
    shapeOf,
    isFullCube,
    categoryOf,
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label })),

    /** 按分类分组（用于选择器）；空组会被丢弃 */
    groupedFor (versionId, options = {}) {
      const pool = collect(versionId, options)
      const buckets = new Map(CATEGORIES.map((c) => [c.key, []]))
      for (const n of pool) buckets.get(categoryOf(n)).push(n)
      const out = []
      for (const c of CATEGORIES) {
        const ids = buckets.get(c.key)
        if (!ids.length) continue
        out.push({ key: c.key, label: c.label, ids: ids.sort() })
      }
      return out
    },

    /** 版本是否存在（支持 1.20.4 / 26.3 这类 id） */
    hasVersion (id) {
      return indexOf.has(id)
    },

    /** 版本 → MinecraftDataVersion */
    dataVersionOf (id) {
      const i = indexOf.get(id)
      if (i === undefined) throw new Error(unknownVersionMessage(id, versions.map((v) => v.id)))
      return versions[i].dataVersion
    },

    /** 该方块在指定版本是否存在 */
    existsIn (blockId, versionId) {
      const i = indexOf.get(versionId)
      if (i === undefined) throw new Error(unknownVersionMessage(versionId, versions.map((v) => v.id)))
      const ranges = blocks[bare(blockId)]
      if (!ranges) return false
      return covers(ranges, i)
    },

    /** 模糊匹配方块名（含中文名），用于拼错时给建议 */
    suggest (input, versionId, limit = 8) {
      const raw = String(input).trim()
      const needle = raw.replace(/^minecraft:/, '').toLowerCase()
      if (!raw) return []
      const pool = versionId
        ? this.listFor(versionId, { scope: 'all' })
        : Object.keys(blocks).filter((n) => !NON_PLACEABLE.has(n))
      const scored = []
      for (const id of pool) {
        const zh = zhNameOf(id) || ''
        let score = 0
        if (id === needle) score = 1000
        else if (id.startsWith(needle)) score = 500 - id.length
        else if (needle && id.includes(needle)) score = 300 - Math.abs(id.length - needle.length)
        else if (needle && /^[\x20-\x7e]+$/.test(needle) && needle.length >= 5) {
          // 英文拼错：有界编辑距离
          const d = boundedDistance(id, needle, 3)
          if (d >= 0) score = Math.max(score, 260 - d * 60)
        }
        if (zh) {
          const lenPenalty = Math.abs(zh.length - raw.length) * 3
          if (zh === raw) score = Math.max(score, 900)
          else if (zh.includes(raw)) score = Math.max(score, 420 - lenPenalty)
          else if (raw.includes(zh)) score = Math.max(score, 200)
          else {
            let prefix = 0
            while (prefix < raw.length && prefix < zh.length && raw[prefix] === zh[prefix]) prefix++
            const pool2 = new Set([...zh])
            let shared = 0
            for (const ch of raw) if (pool2.has(ch)) shared++
            if (prefix >= 1 || shared >= 2) {
              score = Math.max(score, prefix * 20 + shared * 5 - lenPenalty)
            }
          }
        }
        if (score > 0) scored.push([score, id])
      }
      scored.sort((a, b) => b[0] - a[0])
      return scored.slice(0, limit).map(([, id]) => id)
    },

    /** 该方块适用的版本区间（用于报错提示） */
    versionsOf (blockId) {
      const ranges = blocks[bare(blockId)]
      if (!ranges) return []
      const out = []
      for (const [a, b] of ranges) {
        for (let i = a; i <= b; i++) out.push(versions[i].id)
      }
      return out
    },

    /** 指定版本可用的方块名（裸名，按字典序） */
    listFor (versionId, options = {}) {
      const { limit = 0 } = options
      const pool = [...collect(versionId, options)].sort()
      return limit ? pool.slice(0, limit) : pool
    },

    /** 该方块在哪些版本「不存在」（用于提示降版本会用不了） */
    invalidVersions (blockId) {
      const ranges = blocks[bare(blockId)]
      if (!ranges) return versions.map((v) => v.id)
      return versions.filter((v, i) => !covers(ranges, i)).map((v) => v.id)
    },

    /** 统计各范围内的方块数（供 UI 显示） */
    countFor (versionId, options = {}) {
      return collect(versionId, options).size
    }
  }
}

function unknownVersionMessage (id, available) {
  const near = available.filter((v) => v.startsWith(String(id).split('.')[0]))
  const hint = near.length ? `；同系列可用：${near.slice(-6).join(', ')}` : ''
  return `不支持的版本「${id}」${hint}（可用范围 ${available[0]} … ${available[available.length - 1]}）`
}

/** 有界编辑距离：超过 limit 直接返回 -1，避免无谓计算 */
function boundedDistance (a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return -1
  const prev = new Array(b.length + 1)
  const cur = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > limit) return -1
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length] <= limit ? prev[b.length] : -1
}
