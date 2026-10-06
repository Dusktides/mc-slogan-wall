/**
 * .litematic 读取器 —— 用于【独立于写入路径】的回读校验。
 * 只依赖 nbt.mjs 的读取实现与 unpackBlockStates（与 packBlockStates 互为对照）。
 */
import { readNbt, compoundToObject, TAG } from './nbt.mjs'
import { unpackBlockStates, bitsForPalette } from './schematic.mjs'

/**
 * @param {Uint8Array} bytes 未压缩的 NBT 字节
 * @param {object} [opts]
 * @param {string} [opts.fontBlock] 指定字体材质 ID；给出后 grid 中 1 = 字体材质、0 = 其它
 * @returns {{metadata:object, palette:string[], size:{x:number,y:number,z:number}, position:{x:number,y:number,z:number}, bits:number, blocks:(x,y,z)=>string, indices:Uint8Array, grid:Uint8Array, regions:string[]}}
 */
export function inspectLitematic (bytes, opts = {}) {
  const root = readNbt(bytes)
  const obj = compoundToObject(root.entries)

  if (root.name !== '') throw new Error(`根标签名应为空字符串，实际为「${root.name}」`)
  if (obj.Version === undefined) throw new Error('缺少 Version')
  if (obj.MinecraftDataVersion === undefined) throw new Error('缺少 MinecraftDataVersion')
  if (!obj.Regions || Object.keys(obj.Regions).length === 0) throw new Error('缺少 Regions')

  const regionNames = Object.keys(obj.Regions)
  const region = obj.Regions[regionNames[0]]
  const size = region.Size
  const position = region.Position
  if (!size || typeof size.x !== 'number') throw new Error('Region.Size 不是 {x,y,z} 复合标签')
  if (!position || typeof position.x !== 'number') throw new Error('Region.Position 不是 {x,y,z} 复合标签')

  const palette = (region.BlockStatePalette || []).map((e) => e.Name)
  if (palette.length === 0) throw new Error('BlockStatePalette 为空')
  const bits = bitsForPalette(palette.length)
  const volume = size.x * size.y * size.z
  const longs = region.BlockStates
  if (!longs) throw new Error('缺少 BlockStates')
  const expectedLongs = Math.ceil((volume * bits) / 64)
  if (longs.length !== expectedLongs) {
    throw new Error(`BlockStates 长度异常：应 ${expectedLongs} 个 long，实际 ${longs.length}`)
  }

  const values = unpackBlockStates(longs, volume, bits)

  // z=0 层还原成「第 0 行在顶部」的位图；indices 为调色板索引，
  // grid 为二值掩码（1 = 指定的字体材质，未指定时 1 = 非空气）
  const indices = new Uint8Array(size.x * size.y)
  const grid = new Uint8Array(size.x * size.y)
  for (let y = 0; y < size.y; y++) {
    for (let x = 0; x < size.x; x++) {
      const idx = y * (size.x * size.z) + 0 * size.x + x
      const value = values[idx]
      const row = size.y - 1 - y
      indices[row * size.x + x] = value
      grid[row * size.x + x] = opts.fontBlock
        ? (palette[value] === opts.fontBlock ? 1 : 0)
        : (palette[value] === 'minecraft:air' ? 0 : 1)
    }
  }

  return {
    version: obj.Version,
    subVersion: obj.SubVersion,
    dataVersion: obj.MinecraftDataVersion,
    metadata: obj.Metadata,
    regions: regionNames,
    regionName: regionNames[0],
    palette,
    size,
    position,
    bits,
    volume,
    indices,
    grid,
    blocks (x, y, z) {
      const v = values[y * (size.x * size.z) + z * size.x + x]
      return palette[v]
    }
  }
}

export { TAG }
