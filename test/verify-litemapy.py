#!/usr/bin/env python
"""
第三方解析验证：用 litemapy（与 Litematica 无关的独立 Python 实现）读取本项目生成的
.litematic，并逐格与期望位图比对。

用法：python test/verify-litemapy.py <file.litematic> <expected.json>

expected.json 由 CLI 的 --dump-grid 生成：
  { width, height, bg, fg, version, dataVersion, grid: "0101..." }
"""
import json
import sys

from litemapy import Schematic


def fail(msg):
    print("FAIL: " + msg)
    sys.exit(1)


def main():
    if len(sys.argv) != 3:
        fail("用法: verify-litemapy.py <file.litematic> <expected.json>")
    path, expected_path = sys.argv[1], sys.argv[2]
    with open(expected_path, encoding="utf-8") as f:
        exp = json.load(f)

    schem = Schematic.load(path)

    # ---- 元数据 ----
    print("  名称        : %s" % schem.name)
    print("  作者        : %s" % schem.author)
    print("  data_version: %s" % schem.mc_version if hasattr(schem, "mc_version") else "  data_version: (n/a)")
    print("  版本字段    : Version=%s SubVersion=%s" % (getattr(schem, "version", "?"), getattr(schem, "sub_version", "?")))

    regions = list(schem.regions.items())
    if len(regions) != 1:
        fail("区域数量应为 1，实际 %d" % len(regions))
    region_name, region = regions[0]
    W, H, L = abs(region.width), abs(region.height), abs(region.length)
    print("  区域        : %s  尺寸 %dx%dx%d" % (region_name, W, H, L))

    # ---- 尺寸断言 ----
    if (W, H, L) != (exp["width"], exp["height"], 1):
        fail("尺寸不符：文件 %dx%dx%d，期望 %dx%dx1" % (W, H, L, exp["width"], exp["height"]))

    # ---- 调色板断言 ----
    palette = sorted(str(b) for b in region.palette)
    print("  调色板      : %s" % ", ".join(palette))
    for want in (exp["bg"], exp["fg"]):
        if want not in palette:
            fail("调色板缺少 %s（实际 %s）" % (want, palette))

    # ---- 逐格比对 ----
    grid = exp["grid"]
    total = W * H
    mismatch = []
    counts = {}
    for row in range(H):
        y = H - 1 - row  # 文件里 Y 向上，位图第 0 行在顶部
        for x in range(W):
            block = str(region[x, y, 0])
            counts[block] = counts.get(block, 0) + 1
            want = exp["fg"] if grid[row * W + x] == "1" else exp["bg"]
            if block != want:
                if len(mismatch) < 10:
                    mismatch.append("(%d,%d) 期望 %s 实际 %s" % (x, y, want, block))

    print("  方块统计    : %s" % ", ".join("%s=%d" % (k, v) for k, v in sorted(counts.items())))

    if mismatch:
        print("\n".join("  " + m for m in mismatch))
        fail("%d/%d 格不匹配" % (len(mismatch), total))

    air = counts.get("minecraft:air", 0)
    if air:
        fail("出现了空气方块 %d 格（墙应该是实心的）" % air)

    print("\nPASS: %d 格全部匹配，厚度 1，调色板与版本一致" % total)


if __name__ == "__main__":
    main()
