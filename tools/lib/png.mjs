/**
 * 极简 PNG 解码器（只支持 Minecraft 字体贴图用到的形态）
 * 支持：位深 1/2/4/8，颜色类型 0(灰度)/2(真彩)/3(调色板)/4(灰度+A)/6(RGBA)，非隔行。
 * 输出：{ width, height, rgba(Uint8Array) }
 */
import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePng (buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件')
  let p = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let transparency = null
  const idat = []

  while (p < buffer.length) {
    const len = buffer.readUInt32BE(p)
    const type = buffer.toString('ascii', p + 4, p + 8)
    const data = buffer.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[10] !== 0) throw new Error('不支持压缩方式非 0 的 PNG')
      if (data[11] !== 0) throw new Error('不支持带 filter 方式的 PNG')
      interlace = data[12]
      if (interlace !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    p += 12 + len
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < (stride + 1) * height) {
    throw new Error('IDAT 数据长度不足')
  }

  // 反滤波
  const out = Buffer.alloc(stride * height)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      switch (filter) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + b) & 0xff; break
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break
        case 4: v = (v + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`未知的滤波器类型 ${filter}`)
      }
      cur[x] = v
    }
  }

  // 展开为 RGBA
  const rgba = new Uint8Array(width * height * 4)
  const sample = (row, index) => readSubByte(out, row * stride, index, bitDepth)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 3) {
        const idx = sample(y, x)
        rgba[o] = palette[idx * 3]
        rgba[o + 1] = palette[idx * 3 + 1]
        rgba[o + 2] = palette[idx * 3 + 2]
        rgba[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255
      } else if (colorType === 0 || colorType === 4) {
        const g = sample(y, x)
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g
        rgba[o + 3] = colorType === 4 ? sample(y, width + x) : 255
      } else if (colorType === 2 || colorType === 6) {
        const base = y * stride + x * channels * (bitDepth / 8)
        rgba[o] = out[base]
        rgba[o + 1] = out[base + 1]
        rgba[o + 2] = out[base + 2]
        rgba[o + 3] = colorType === 6 ? out[base + 3] : 255
      }
    }
  }

  return { width, height, bitDepth, colorType, rgba }
}

function readSubByte (buf, rowStart, index, bitDepth) {
  if (bitDepth === 8) return buf[rowStart + index]
  const perByte = 8 / bitDepth
  const byte = buf[rowStart + Math.floor(index / perByte)]
  const shift = 8 - bitDepth * ((index % perByte) + 1)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

function paeth (a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}
