/**
 * 字形集：把「Mojangles（原版像素字体）」与「GNU Unifont（汉字）」统一到同一套度量。
 *
 * 长度单位统一为「点(dot)」：1 点 = Unifont 的 1 个像素 = Mojangles 的半个像素。
 *
 * 原版度量（26.3 客户端字节码实测）：
 *   BitmapProvider：单元格 cellW×cellH，advance = 裁剪宽 + 1，
 *                   bearingTop = provider.ascent，getTop() = 7 - ascent
 *   UnihexProvider：16×16，oversample = 2，advance = dataWidth/2 + 1，getTop() = 0
 *   基线固定在行顶下方 7 个 Mojangles 像素处。
 *
 * 因此：Mojangles 字形在「点」空间里宽高各 ×latinDots（默认 2 ⇒ 与汉字等高），
 *      汉字保持 16×16 原生点阵（可读性远好于原版的 2:1 降采样）。
 */

/** 从位图算墨迹外接矩形（right/bottom 为开区间）；无墨迹时 empty = true */
function computeInk (bits, rowBytes, width, height) {
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!(bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)))) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return { left: 0, right: 0, top: 0, bottom: 0, empty: true }
  return { left, right: right + 1, top, bottom: bottom + 1, empty: false }
}

/** 原版基线：行顶下方 7 个 Mojangles 像素 */
export const BASELINE_PX = 7

/** hex 字符串 → Uint8Array（浏览器/Node 通用） */
export function hexToBytes (hex) {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/** 缺字占位（仿原版 notdef 方框） */
function placeholderGlyph (latinDots) {
  const w = 5
  const h = 7
  const dots = Math.max(1, latinDots)
  const rowBytes = Math.ceil((w * dots) / 8)
  const bits = new Uint8Array(rowBytes * h * dots)
  const px = (x, y, on) => {
    if (!on) return
    for (let dy = 0; dy < dots; dy++) {
      for (let dx = 0; dx < dots; dx++) {
        const xx = x * dots + dx
        const yy = y * dots + dy
        bits[yy * rowBytes + (xx >> 3)] |= 0x80 >> (xx & 7)
      }
    }
  }
  for (let x = 0; x < w; x++) { px(x, 0, true); px(x, h - 1, true) }
  for (let y = 0; y < h; y++) { px(0, y, true); px(w - 1, y, true) }
  return {
    source: 'placeholder',
    width: w * dots,
    height: h * dots,
    advance: (w + 1) * dots,
    top: 0,
    rowBytes,
    bits,
    pixelScale: dots,
    ink: { left: 0, right: w * dots, top: 0, bottom: h * dots, empty: false }
  }
}

/**
 * @param {object} opts
 * @param {object} opts.mojangles  tools/extract-mojangles.mjs 的产物
 * @param {(cp:number)=>{bits:Uint8Array,width:number,height:number,dataWidth:number}|null} [opts.unifontLookup]
 * @param {number} [opts.latinDots] Mojangles 每个像素占几个点（1 或 2，默认 2）
 */
export function createGlyphSet ({ mojangles, unifontLookup = null, latinDots = 2 }) {
  if (!mojangles || !mojangles.glyphs) throw new Error('缺少 Mojangles 字形数据')
  const cache = new Map()
  const dots = Math.max(1, Math.floor(latinDots))

  function buildMojangles (cp, g) {
    const sheet = mojangles.sheets[g.s]
    const rowBytes = Math.ceil(sheet.cellW / 8)
    const src = hexToBytes(g.bits)
    // 按 dots 倍最近邻放大
    const width = sheet.cellW * dots
    const height = sheet.cellH * dots
    const outRowBytes = Math.ceil(width / 8)
    const bits = new Uint8Array(outRowBytes * height)
    for (let y = 0; y < height; y++) {
      const sy = (y / dots) | 0
      for (let x = 0; x < width; x++) {
        const sx = (x / dots) | 0
        if (src[sy * rowBytes + (sx >> 3)] & (0x80 >> (sx & 7))) {
          bits[y * outRowBytes + (x >> 3)] |= 0x80 >> (x & 7)
        }
      }
    }
    return {
      source: 'mojangles',
      sheet: sheet.file,
      width,
      height,
      advance: g.adv * dots,
      top: (BASELINE_PX - sheet.ascent) * dots,
      rowBytes: outRowBytes,
      bits,
      pixelScale: dots,
      ink: computeInk(bits, outRowBytes, width, height)
    }
  }

  function buildUnifont (cp, raw) {
    // 8 宽字形左对齐存放，advance 用「数据宽」而非墨迹宽（与原版一致，保证等宽）
    return {
      source: 'unifont',
      width: 16,
      height: 16,
      advance: raw.dataWidth + 2,
      top: 0,
      rowBytes: 2,
      bits: raw.bits,
      pixelScale: 1,
      ink: computeInk(raw.bits, 2, 16, 16)
    }
  }

  return {
    latinDots: dots,
    /** 是否含汉字等需要 Unifont 的字符 */
    hasUnifont: () => unifontLookup !== null,
    /**
     * @param {number} cp 码位
     * @returns {{source:string,width:number,height:number,advance:number,top:number,rowBytes:number,bits:Uint8Array}}
     */
    lookup (cp) {
      if (cache.has(cp)) return cache.get(cp)
      let result = null
      const g = mojangles.glyphs[cp]
      if (g) {
        result = buildMojangles(cp, g)
      } else {
        const adv = mojangles.advances?.[cp]
        if (adv !== undefined) {
          // space 一类没有任何墨迹、但有明确推进宽度的字符：
          // 横向占位 = advance，纵向不贡献墨迹范围
          result = {
            source: 'advance-only',
            width: 0,
            height: 0,
            advance: adv * dots,
            top: 0,
            rowBytes: 0,
            bits: new Uint8Array(0),
            pixelScale: dots,
            ink: { left: 0, right: adv * dots, top: 0, bottom: 0, empty: true }
          }
        } else if (unifontLookup) {
          const raw = unifontLookup(cp)
          if (raw) result = buildUnifont(cp, raw)
        }
      }
      if (!result) result = placeholderGlyph(dots)
      cache.set(cp, result)
      return result
    },
    /** 该码位是否有真实字形（用于缺字提示） */
    has (cp) {
      if (mojangles.glyphs[cp] !== undefined) return true
      if (mojangles.advances?.[cp] !== undefined) return true
      return unifontLookup ? unifontLookup(cp) !== null : false
    }
  }
}

/** 解析 tools/extract-unifont.mjs 产出的 MCUW1 二进制（Uint8Array 输入） */
export function parseUnifontBuffer (input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input)
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4])
  if (magic !== 'MCUW1') throw new Error('Unifont 数据魔数不正确：' + magic)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = view.getUint32(5, true)
  const cpStart = 9
  const widthStart = cpStart + count * 4
  const bitsStart = widthStart + count
  const key = new Uint32Array(count)
  const widths = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    key[i] = view.getUint32(cpStart + i * 4, true)
    widths[i] = buf[widthStart + i]
  }
  return {
    count,
    lookup (cp) {
      let lo = 0
      let hi = count - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const v = key[mid]
        if (v === cp) {
          const off = bitsStart + mid * 32
          return { bits: buf.subarray(off, off + 32), width: 16, height: 16, dataWidth: widths[mid] }
        }
        if (v < cp) lo = mid + 1
        else hi = mid - 1
      }
      return null
    }
  }
}
