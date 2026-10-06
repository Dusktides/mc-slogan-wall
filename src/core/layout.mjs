/**
 * 排版：文本 → 方块位图。
 *
 * 坐标系：以「方块」为单位；所有尺寸都由【字形墨迹的实际外接矩形】决定，
 * 而不是字形的方格（cell）。这一点很关键：
 *   - 距边框 = 0 时，字迹会真正贴到墙边（不会因字体自带的留白而多出几格）
 *   - 字间距 = 0 时，相邻字的墨迹正好相邻
 *
 * 两种字距模式：
 *   gap（默认）  spacing = 相邻字形【墨迹之间】的空格数，0 = 紧贴，直观可控
 *   advance      spacing 叠加在原版字体 advance 之上（保留原版字距节奏）
 */

/**
 * @param {string} text
 * @param {object} opts
 * @param {ReturnType<import('./glyphs.mjs').createGlyphSet>} opts.glyphSet
 * @param {number}  [opts.dotBlocks]   每个点占几个方块（默认 1）
 * @param {number}  [opts.spacing]     字间距，方块数（默认 1）
 * @param {'gap'|'advance'} [opts.spacingMode] 字间距语义（默认 gap）
 * @param {number}  [opts.border]      距边框距离，方块数（默认 0）
 * @param {number}  [opts.lineGap]     行距，方块数（默认 1）
 * @param {'left'|'center'|'right'} [opts.align] 多行对齐（默认 center）
 * @param {boolean} [opts.trimEmpty]   去掉四周全空的边（默认 false）
 */
export function layoutText (text, {
  glyphSet,
  dotBlocks = 1,
  spacing = 1,
  spacingMode = 'gap',
  border = 0,
  lineGap = 1,
  align = 'center',
  trimEmpty = false
} = {}) {
  if (!glyphSet) throw new Error('layoutText 需要 glyphSet')
  if (!Number.isInteger(dotBlocks) || dotBlocks < 1) throw new Error('dotBlocks 必须是 ≥1 的整数')
  if (!['gap', 'advance'].includes(spacingMode)) throw new Error(`spacingMode 只能是 gap 或 advance，收到「${spacingMode}」`)
  if (!['left', 'center', 'right'].includes(align)) throw new Error(`align 只能是 left/center/right，收到「${align}」`)
  for (const [k, v] of [['spacing', spacing], ['border', border], ['lineGap', lineGap]]) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} 必须是 ≥0 的整数`)
  }

  const scale = dotBlocks
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const missing = new Set()

  /* ---------------- 第一遍：逐行测量（与水平位置无关的纵向信息） ---------------- */
  const measured = []
  for (const rawLine of rawLines) {
    const cps = [...rawLine].map((ch) => ch.codePointAt(0))
    const glyphs = cps.map((cp) => {
      if (!glyphSet.has(cp)) missing.add(String.fromCodePoint(cp))
      return glyphSet.lookup(cp)
    })

    // 方格纵向范围（用于行高与堆叠，保持字体自身的行节奏）
    let cellTop = Infinity
    let cellBottom = -Infinity
    let inkTop = Infinity
    let inkBottom = -Infinity
    let hasInk = false
    for (const g of glyphs) {
      const t = g.top * scale
      cellTop = Math.min(cellTop, t)
      cellBottom = Math.max(cellBottom, t + g.height * scale)
      if (!g.ink.empty) {
        hasInk = true
        inkTop = Math.min(inkTop, t + g.ink.top * scale)
        inkBottom = Math.max(inkBottom, t + g.ink.bottom * scale)
      }
    }
    if (!Number.isFinite(cellTop)) { cellTop = 0; cellBottom = 0 }
    if (!hasInk) { inkTop = cellTop; inkBottom = cellBottom }

    measured.push({ glyphs, cellTop, cellHeight: cellBottom - cellTop, inkTop, inkBottom, hasInk })
  }

  /* ---------------- 第二遍：水平排布，得到每行的墨迹范围 ---------------- */
  for (const line of measured) {
    const placed = []
    let cursor = 0
    let inkLeft = Infinity
    let inkRight = -Infinity
    let inkBottom = line.inkBottom

    line.glyphs.forEach((g, i) => {
      const inkL = g.ink.left * scale
      const inkR = g.ink.right * scale
      const drawX = spacingMode === 'advance' ? cursor : cursor - inkL
      if (spacingMode === 'advance') {
        cursor += g.advance * scale
      } else {
        cursor += inkR - inkL
      }
      if (i < line.glyphs.length - 1) cursor += spacing
      if (!g.ink.empty) {
        inkLeft = Math.min(inkLeft, drawX + inkL)
        inkRight = Math.max(inkRight, drawX + inkR)
      }
      placed.push({ glyph: g, drawX })
    })

    line.placed = placed
    if (Number.isFinite(inkLeft)) {
      line.inkLeft = inkLeft
      line.inkRight = inkRight
    } else {
      // 整行没有墨迹（空行或纯空格）：用推进宽度占位
      line.inkLeft = 0
      line.inkRight = cursor
      line.inkTop = line.cellTop
    }
    line.width = line.inkRight - line.inkLeft
  }

  /* ---------------- 第三遍：堆叠 + 对齐，得到整块内容尺寸 ---------------- */
  let y = 0
  for (const line of measured) {
    line.y = y
    y += line.cellHeight
    if (line !== measured[measured.length - 1]) y += lineGap
  }

  const contentWidth = Math.max(...measured.map((l) => l.width), 1)
  const inkTopGlobal = Math.min(...measured.map((l) => l.y + l.inkTop))
  const inkBottomGlobal = Math.max(...measured.map((l) => l.y + l.inkBottom))
  const contentHeight = Math.max(1, inkBottomGlobal - inkTopGlobal)

  for (const line of measured) {
    if (align === 'left') line.offsetX = -line.inkLeft
    else if (align === 'right') line.offsetX = contentWidth - line.width - line.inkLeft
    else line.offsetX = (contentWidth - line.width) / 2 - line.inkLeft
  }

  /* ---------------- 画到网格 ---------------- */
  const width = Math.round(contentWidth) + border * 2
  const height = Math.round(contentHeight) + border * 2
  if (width < 1 || height < 1) throw new Error('排版结果为空：请检查文本与参数')
  if (width > 8192 || height > 8192) {
    throw new Error(`标语墙尺寸 ${width}x${height} 过大（单边上限 8192）；请减小 dotBlocks、字间距或文本长度`)
  }

  const grid = new Uint8Array(width * height)
  const blit = (glyph, ox, oy) => {
    const { bits, rowBytes, width: gw, height: gh } = glyph
    if (gh === 0) return
    for (let sy = 0; sy < gh; sy++) {
      const dy0 = oy + sy * scale
      for (let sx = 0; sx < gw; sx++) {
        if (!(bits[sy * rowBytes + (sx >> 3)] & (0x80 >> (sx & 7)))) continue
        const dx0 = ox + sx * scale
        for (let dy = 0; dy < scale; dy++) {
          const yy = dy0 + dy
          if (yy < 0 || yy >= height) continue
          for (let dx = 0; dx < scale; dx++) {
            const xx = dx0 + dx
            if (xx < 0 || xx >= width) continue
            grid[yy * width + xx] = 1
          }
        }
      }
    }
  }

  for (const line of measured) {
    const baseY = border + line.y - inkTopGlobal
    for (const { glyph, drawX } of line.placed) {
      blit(glyph, Math.round(border + line.offsetX + drawX), Math.round(baseY + glyph.top * scale))
    }
  }

  // 每个字形墨迹在墙坐标里的范围（供预览/测试量化间距与边距）
  const inkBoxes = []
  measured.forEach((line, lineIndex) => {
    const baseY = border + line.y - inkTopGlobal
    line.placed.forEach(({ glyph, drawX }, index) => {
      if (glyph.ink.empty) return
      const x0 = Math.round(border + line.offsetX + drawX + glyph.ink.left * scale)
      const x1 = Math.round(border + line.offsetX + drawX + glyph.ink.right * scale)
      inkBoxes.push({
        line: lineIndex,
        index,
        cp: glyph.cp ?? null,
        source: glyph.source,
        x0,
        x1,
        y0: Math.round(baseY + glyph.top * scale + glyph.ink.top * scale),
        y1: Math.round(baseY + glyph.top * scale + glyph.ink.bottom * scale)
      })
    })
  })

  let finalGrid = grid
  let finalWidth = width
  let finalHeight = height
  if (trimEmpty) {
    const trimmed = trimGrid(grid, width, height)
    finalGrid = trimmed.grid
    finalWidth = trimmed.width
    finalHeight = trimmed.height
  }

  let fontBlocks = 0
  for (const v of finalGrid) if (v) fontBlocks++

  return {
    width: finalWidth,
    height: finalHeight,
    depth: 1,
    grid: finalGrid,
    fontBlocks,
    backgroundBlocks: finalWidth * finalHeight - fontBlocks,
    contentWidth: Math.round(contentWidth),
    contentHeight,
    spacingMode,
    align,
    inkBoxes,
    lines: measured.map((l) => ({ width: l.width, height: l.cellHeight, glyphs: l.placed.length })),
    missing: [...missing]
  }
}

function trimGrid (grid, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grid[y * width + x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { grid, width, height }
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = grid[(y + minY) * width + (x + minX)]
  }
  return { grid: out, width: w, height: h }
}

/** 终端 ASCII 预览（1 方块 = 1 字符；宽墙自动抽样） */
export function renderAscii (layout, { fg = '#', bg = '.', maxWidth = 160 } = {}) {
  const { width, height, grid } = layout
  const stepX = Math.max(1, Math.ceil(width / maxWidth))
  const stepY = Math.max(1, Math.ceil((height * stepX) / width / 2) || 1)
  const out = []
  for (let y = 0; y < height; y += stepY) {
    let line = ''
    for (let x = 0; x < width; x += stepX) line += grid[y * width + x] ? fg : bg
    out.push(line)
  }
  return out.join('\n')
}
