/**
 * 写出 `.efoo`（FOOTPRINT）文档。
 *
 * `.efoo` 无 `HEAD` 行，且 core 的 `JsonLinesWriter` 会强制输出 `HEAD`，
 * 因此这里手动逐行拼装（首行 DOCTYPE + 静态 LAYER 骨架 + 图元 + CANVAS）。
 * 结构照抄官方 R0603 示例。
 */
import type { FootprintBlueprint } from "../types"
import { EFOO_LAYER_LINES } from "../pcb/layers"
import { buildEfooPadRow } from "../pcb/pads"
import { buildPolygonPoints, round6 } from "../pcb/board"

function padExtent(pad: any): { width: number; height: number } {
  const shape = pad?.padShape
  let width = Number(pad?.width ?? 0)
  let height = Number(pad?.height ?? 0)
  if ((!width || !height) && Array.isArray(shape)) {
    width = Number(shape[1] ?? 0)
    height = Number(shape[2] ?? 0)
  }
  return { width: Math.abs(width), height: Math.abs(height) }
}

export function writeEfoo(bp: FootprintBlueprint): string {
  const b = bp as any
  const lines: unknown[][] = []

  lines.push(["DOCTYPE", "FOOTPRINT", "1.8"])
  for (const layerLine of EFOO_LAYER_LINES) lines.push(layerLine)
  lines.push(["ACTIVE_LAYER", 1])
  lines.push(["ACTIVE_LAYER", 1])
  lines.push([])

  const bbox = b?.bbox ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const bodyPolygon: Array<{ x: number; y: number }> = [
    { x: Number(bbox.minX ?? 0), y: Number(bbox.maxY ?? 0) },
    { x: Number(bbox.maxX ?? 0), y: Number(bbox.maxY ?? 0) },
    { x: Number(bbox.maxX ?? 0), y: Number(bbox.minY ?? 0) },
    { x: Number(bbox.minX ?? 0), y: Number(bbox.minY ?? 0) },
  ]

  // 本体外形（COMPONENT_SHAPE 层 48）。
  lines.push(["POLY", "e1", 0, "", 48, 2, buildPolygonPoints(bodyPolygon, true), 0])

  // 封装丝印等图元（`FootprintBlueprint.graphics` 已按 EPro 图元行生成）。
  for (const graphic of b?.graphics ?? []) {
    if (Array.isArray(graphic)) lines.push(graphic as unknown[])
  }

  // 引脚可焊区（PIN_SOLDERING 层 50）。
  const pads = Array.isArray(b?.pads) ? b.pads : []
  pads.forEach((pad: any, index: number) => {
    const { width, height } = padExtent(pad)
    if (!width && !height) return
    const halfW = width / 2
    const halfH = height / 2
    const x = Number(pad.x ?? 0)
    const y = Number(pad.y ?? 0)
    const points = [
      { x: x - halfW, y: y + halfH },
      { x: x + halfW, y: y + halfH },
      { x: x + halfW, y: y - halfH },
      { x: x - halfW, y: y - halfH },
    ]
    lines.push([
      "FILL",
      `e${3000 + index}`,
      0,
      "",
      50,
      0.2,
      0,
      [buildPolygonPoints(points, true)],
      0,
    ])
  })

  // 焊盘。
  for (const pad of pads) lines.push(buildEfooPadRow(pad as any))

  // 一脚标记（COMPONENT_MARKING 层 49）：优先使用蓝图钉脚，否则取第一个焊盘。
  const firstPad = pads[0]
  const pin1 =
    b?.pin1 ??
    (firstPad ? { x: firstPad.x, y: firstPad.y } : null)
  if (pin1 && Number.isFinite(Number(pin1.x)) && Number.isFinite(Number(pin1.y))) {
    lines.push([
      "FILL",
      "e4000",
      0,
      "",
      49,
      0.2,
      0,
      [["CIRCLE", round6(Number(pin1.x)), round6(Number(pin1.y)), 2.361]],
      0,
    ])
  }

  // 封装属性。
  const footprintName = String(b?.title ?? "Footprint")
  lines.push([
    "ATTR",
    "e5000",
    0,
    "",
    3,
    null,
    null,
    "Footprint",
    footprintName,
    0,
    0,
    "default",
    67.5,
    6,
    0,
    0,
    3,
    0,
    0,
    0,
    0,
    0,
  ])
  lines.push([
    "ATTR",
    "e5001",
    0,
    "",
    3,
    null,
    null,
    "Designator",
    "U?",
    0,
    0,
    "default",
    67.5,
    6,
    0,
    0,
    3,
    0,
    0,
    0,
    0,
    0,
  ])

  lines.push(["CANVAS", 0, 0, "mm", 10, 10, 0.03937, 0.03937])

  return lines.map((line) => JSON.stringify(line)).join("\n")
}
