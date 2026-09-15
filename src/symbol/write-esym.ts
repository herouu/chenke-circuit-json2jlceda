import type { SymbolBlueprint } from "../types"
import { round6 } from "../units"
import { JsonLinesWriter } from "../writer"

/**
 * 将符号蓝图序列化为 `.esym` 文本（数组 JSON-lines）。
 *
 * 结构：`DOCTYPE` + `HEAD` + `PART` + 图元。
 */
export function writeEsym(bp: SymbolBlueprint): string {
  const writer = new JsonLinesWriter(["DOCTYPE", "SYMBOL", "1.1"], {
    originX: 0,
    originY: 0,
    version: "2",
    symbolType: bp.symbolType,
    maxId: 0,
  })

  const { minX, minY, maxX, maxY } = bp.bbox
  writer.push([
    "PART",
    bp.partName,
    { BBOX: [round6(minX), round6(minY), round6(maxX), round6(maxY)] },
  ])

  for (const primitive of bp.primitives) {
    writer.push(primitive)
  }

  // 回填 HEAD.maxId 为文档内最大数字 id。
  writer.setHeadValue("maxId", writer.maxNumericId)
  return writer.toString()
}
