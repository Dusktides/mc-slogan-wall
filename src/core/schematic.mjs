/**
 * 组装 Litematica .litematic 文件（未压缩的 NBT 字节；gzip 由调用方处理）。
 *
 * 格式依据（Litematica 源码 + 26.3 客户端实测）：
 *   根：MinecraftDataVersion(Int) / Version(Int)=7 / SubVersion(Int)=1 / Metadata(Compound) / Regions(Compound)
 *   区域：Position(Compound{x,y,z}) / Size(Compound{x,y,z}) / BlockStatePalette(List<Compound>) /
 *         BlockStates(LongArray) / TileEntities / Entities / PendingBlockTicks / PendingFluidTicks (List)
 *   位打包：bits = max(2, 32 - numberOfLeadingZeros(paletteSize - 1))，低位优先、跨 long 连续
 *   索引：index = y * (sizeX * sizeZ) + z * sizeX + x
 */
import { nbt, writeNbt, TAG } from './nbt.mjs'

export const LITEMATIC_VERSION = 7
export const LITEMATIC_SUBVERSION = 1

const AIR = 'minecraft:air'

/**
 * Litematica 的位数组打包（逐位对应 LitematicaBitArray.setAt）
 * 注意：Java 的 long 移位会在 64 位处截断，且 `>>>` 为零填充；
 *       BigInt 是无限精度、`>>` 为算术移位，因此每步都显式按 64 位归一化。
 */
export function packBlockStates (values, bits) {
  if (bits < 1 || bits > 32) throw new Error(`bitsPerEntry 必须在 1..32，收到 ${bits}`)
  const total = values.length
  const longCount = Math.ceil((total * bits) / 64)
  const longs = new BigInt64Array(longCount)
  const mask = (1n << BigInt(bits)) - 1n
  const bBits = BigInt(bits)
  for (let i = 0; i < total; i++) {
    const v = BigInt(values[i]) & mask
    const startOffset = BigInt(i) * bBits
    const startIdx = Number(startOffset >> 6n)
    const startBit = Number(startOffset & 63n)
    const shift = BigInt(startBit)
    // 与 Java 一致：掩码先按 64 位截断再取反
    const clearMask = ~BigInt.asUintN(64, mask << shift)
    const cur = BigInt.asUintN(64, longs[startIdx])
    longs[startIdx] = BigInt.asIntN(64, (cur & clearMask) | BigInt.asUintN(64, v << shift))
    const endIdx = Number((BigInt(i + 1) * bBits - 1n) >> 6n)
    if (startIdx !== endIdx) {
      const endOffset = 64 - startBit
      const j1 = BigInt(bits - endOffset)
      const e = BigInt.asUintN(64, longs[endIdx])
      longs[endIdx] = BigInt.asIntN(64, (e >> j1 << j1) | (v >> BigInt(endOffset)))
    }
  }
  return longs
}

/** 与 packBlockStates 对应的读取实现（逐位对应 LitematicaBitArray.getAt） */
export function unpackBlockStates (longs, count, bits) {
  const out = new Array(count)
  const mask = (1n << BigInt(bits)) - 1n
  const bBits = BigInt(bits)
  for (let i = 0; i < count; i++) {
    const startOffset = BigInt(i) * bBits
    const startIdx = Number(startOffset >> 6n)
    const startBit = Number(startOffset & 63n)
    const endIdx = Number((BigInt(i + 1) * bBits - 1n) >> 6n)
    const lo = BigInt.asUintN(64, longs[startIdx])
    let v
    if (startIdx === endIdx) {
      v = (lo >> BigInt(startBit)) & mask
    } else {
      const endOffset = 64 - startBit
      const hi = BigInt.asUintN(64, longs[endIdx])
      v = ((lo >> BigInt(startBit)) | (hi << BigInt(endOffset))) & mask
    }
    out[i] = Number(v)
  }
  return out
}

/** 依据 Litematica 的规则计算每格位数 */
export function bitsForPalette (paletteSize) {
  return Math.max(2, 32 - Math.clz32(paletteSize - 1))
}

/**
 * @param {object} opts
 * @param {{width:number,height:number,depth:number,grid:Uint8Array}} opts.layout
 * @param {string} opts.bgBlock 背景方块（含命名空间）
 * @param {string} opts.fgBlock 字体方块
 * @param {number} opts.dataVersion 所选游戏版本的 MinecraftDataVersion
 * @param {string} [opts.name] 投影名（同时作为区域名）
 * @param {string} [opts.author]
 * @param {string} [opts.description]
 * @param {number} [opts.time] 时间戳（毫秒）
 * @param {boolean} [opts.flipY] 位图第 0 行放到最高 Y（默认 true，符合 MC 的 Y 向上）
 * @param {boolean} [opts.includeAir] palette 里保留空气（默认 true，与 Litematica 自身输出一致）
 */
export function buildLitematic ({
  layout,
  bgBlock,
  fgBlock,
  dataVersion,
  name = 'slogan',
  author = 'mc-slogan-wall',
  description = '',
  time = Date.now(),
  flipY = true,
  includeAir = true
}) {
  const { width: sizeX, height: sizeY, depth: sizeZ, grid } = layout
  if (!Number.isInteger(sizeX) || !Number.isInteger(sizeY) || !Number.isInteger(sizeZ)) {
    throw new Error('区域尺寸必须是整数')
  }
  if (grid.length !== sizeX * sizeY * sizeZ) {
    throw new Error(`位图长度 ${grid.length} 与区域体积 ${sizeX * sizeY * sizeZ} 不一致`)
  }
  for (const [label, id] of [['背景', bgBlock], ['字体', fgBlock]]) {
    if (typeof id !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) {
      throw new Error(`${label}方块 ID 不合法：${id}`)
    }
  }
  if (!Number.isInteger(dataVersion) || dataVersion <= 0) {
    throw new Error(`MinecraftDataVersion 不合法：${dataVersion}`)
  }

  const palette = includeAir ? [AIR, bgBlock, fgBlock] : [bgBlock, fgBlock]
  const bgIndex = palette.indexOf(bgBlock)
  const fgIndex = palette.indexOf(fgBlock)
  const bits = bitsForPalette(palette.length)

  // index = y * (sizeX * sizeZ) + z * sizeX + x
  const values = new Uint8Array(sizeX * sizeY * sizeZ)
  for (let y = 0; y < sizeY; y++) {
    const srcRow = flipY ? sizeY - 1 - y : y
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) {
        const on = grid[srcRow * sizeX + x]
        values[y * (sizeX * sizeZ) + z * sizeX + x] = on ? fgIndex : bgIndex
      }
    }
  }

  const longs = packBlockStates(values, bits)
  const volume = sizeX * sizeY * sizeZ
  let totalBlocks = 0
  for (const v of values) if (palette[v] !== AIR) totalBlocks++

  const paletteEntries = palette.map((id) => nbt.compound([['Name', nbt.string(id)]]))

  const region = nbt.compound([
    ['Position', nbt.compound([['x', nbt.int(0)], ['y', nbt.int(0)], ['z', nbt.int(0)]])],
    ['Size', nbt.compound([['x', nbt.int(sizeX)], ['y', nbt.int(sizeY)], ['z', nbt.int(sizeZ)]])],
    ['BlockStatePalette', nbt.list(paletteEntries, TAG.COMPOUND)],
    ['BlockStates', nbt.longArray(longs)],
    ['TileEntities', nbt.list([], TAG.COMPOUND)],
    ['Entities', nbt.list([], TAG.COMPOUND)],
    ['PendingBlockTicks', nbt.list([], TAG.COMPOUND)],
    ['PendingFluidTicks', nbt.list([], TAG.COMPOUND)]
  ])

  const metadata = nbt.compound([
    ['Name', nbt.string(name)],
    ['Author', nbt.string(author)],
    ['Description', nbt.string(description)],
    ['RegionCount', nbt.int(1)],
    ['TotalVolume', nbt.int(volume)],
    ['TotalBlocks', nbt.int(totalBlocks)],
    ['TimeCreated', nbt.long(time)],
    ['TimeModified', nbt.long(time)],
    ['EnclosingSize', nbt.compound([['x', nbt.int(sizeX)], ['y', nbt.int(sizeY)], ['z', nbt.int(sizeZ)]])]
  ])

  const root = [
    ['MinecraftDataVersion', nbt.int(dataVersion)],
    ['Version', nbt.int(LITEMATIC_VERSION)],
    ['SubVersion', nbt.int(LITEMATIC_SUBVERSION)],
    ['Metadata', metadata],
    ['Regions', nbt.compound([[name, region]])]
  ]

  return {
    bytes: writeNbt('', root),
    bits,
    palette,
    volume,
    totalBlocks,
    longCount: longs.length,
    values
  }
}
