# 第三方组件与数据来源

本项目**不包含**任何 Minecraft 游戏资源。所有数据在用户本机生成，仅供本机使用。

## 运行时依赖

| 组件 | 用途 | 许可 | 是否随仓库分发 |
|---|---|---|---|
| Node.js 18+ | 运行环境 | MIT | 否（需自行安装） |

代码本体**零 npm 依赖**，只用 Node 内置模块。

## 数据来源

| 数据 | 来源 | 生成脚本 | 说明 |
|---|---|---|---|
| `data/glyphs/mojangles.json` | **本机 Minecraft 客户端 jar**（`assets/minecraft/textures/font/*.png` + `font/include/default.json`） | `tools/extract-mojangles.mjs` | Mojangles 字形为 Mojang 版权资源。**仅在用户本机提取与本机使用，不入库、不再分发** |
| `data/block-names-zh.json` | **本机 Minecraft 资源库**（`assets/objects` 中的 `minecraft/lang/zh_cn.json`） | `tools/build-block-names.mjs` | 中文方块名为 Mojang 本地化文本，同上，不入库 |
| `data/block-colors.json` | **本机客户端 jar** 的方块贴图（取平均色） | `tools/build-block-colors.mjs` | 贴图像素为 Mojang 版权资源，同上，不入库 |
| `data/block-shapes.json` | **本机客户端 jar** 的 `blockstates/*.json` + `models/block/*.json` | `tools/build-block-shapes.mjs` | 由模型数据推导的"是否完整方块"判定，不入库 |
| `data/blocks-by-version.json` | [misode/mcmeta](https://github.com/misode/mcmeta) 的逐版本 block 注册表 | `tools/build-blocks-data.mjs` | 仓库未声明 LICENSE；本项目只把它当作可再生成的公开数据集使用，不入库 |
| `data/glyphs/unifont.bin.gz` | [GNU Unifont](https://unifoundry.com/unifont/) 的 `.hex` 点阵 | `tools/extract-unifont.mjs` | GNU Unifont 采用 **GPLv2+ 并附字体嵌入例外**（部分版本另提供 OFL-1.1）。本项目只在用户本机提取、按需使用，不入库。若你要在自己的发行版里内置该数据，请同时附带 Unifont 的许可证全文 |

## 格式与算法参考

| 项目 | 用途 | 许可 |
|---|---|---|
| [Litematica](https://github.com/maruohon/litematica) | `.litematic` 文件格式、位打包规则、字段定义（本项目仅参考格式，未复制其代码） | LGPL-3.0 |
| [litemapy](https://github.com/SmylerMC/litemapy) | **仅用于测试**：作为独立的第三方实现校验生成的文件（开发依赖，不随发行版分发） | GPL-3.0 |

## 商标声明

Minecraft 是 Mojang Studios 的商标。本项目为社区非官方工具，与 Mojang Studios、
Microsoft 及 Litematica 作者均无关联，也未获其背书。
