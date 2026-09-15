/**
 * 丝印（LINE / POLY / STRING）行构造，层号 3/4。
 */
import {
  round6,
  toMil,
  buildPolygonPoints,
  ealignForAnchor,
  silkscreenBoxSize,
  warn,
} from "./board"
import { silkscreenLayerId } from "./layers"

function rotatePoint(
  point: { x: number; y: number },
  center: { x: number; y: number },
  rotationDeg: number,
): { x: number; y: number } {
  const theta = (Number(rotationDeg ?? 0) * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}

function toMilPolygon(
  points: Array<{ x: number; y: number }>,
  close: boolean,
): unknown[] {
  return buildPolygonPoints(
    points.map((p) => ({ x: toMil(p.x), y: toMil(p.y) })),
    close,
  )
}

/** 生成所有丝印图元行。 */
export function buildSilkscreenRows(
  ctx: any,
  elements: any[],
  eid: () => string,
): unknown[][] {
  const rows: unknown[][] = []
  for (const element of elements) {
    if (!element) continue
    switch (element.type) {
      case "pcb_silkscreen_line": {
        const layer = silkscreenLayerId(element.layer)
        rows.push([
          "LINE",
          eid(),
          0,
          "",
          layer,
          round6(toMil(Number(element.x1 ?? 0))),
          round6(toMil(Number(element.y1 ?? 0))),
          round6(toMil(Number(element.x2 ?? 0))),
          round6(toMil(Number(element.y2 ?? 0))),
          round6(toMil(Number(element.stroke_width ?? 0.1))),
          0,
        ])
        break
      }
      case "pcb_silkscreen_path": {
        const layer = silkscreenLayerId(element.layer)
        const points = Array.isArray(element.route) ? element.route : []
        rows.push([
          "POLY",
          eid(),
          0,
          "",
          layer,
          round6(toMil(Number(element.stroke_width ?? 0.1))),
          toMilPolygon(points, false),
          0,
        ])
        break
      }
      case "pcb_silkscreen_rect":
      case "pcb_silkscreen_oval":
      case "pcb_silkscreen_pill": {
        const layer = silkscreenLayerId(element.layer)
        const center = element.center ?? { x: 0, y: 0 }
        const size = silkscreenBoxSize(element)
        if (!size) {
          warn(
            ctx,
            `pcb_silkscreen ${element.type} ${String(
              element.pcb_silkscreen_oval_id ??
                element.pcb_silkscreen_rect_id ??
                element.pcb_silkscreen_pill_id ??
                "",
            )} 缺少有效尺寸（oval 需 radius_x/radius_y，rect/pill 需 width/height），已跳过`,
            "unsupported-element",
          )
          break
        }
        const { width, height } = size
        const local = [
          { x: center.x - width / 2, y: center.y + height / 2 },
          { x: center.x + width / 2, y: center.y + height / 2 },
          { x: center.x + width / 2, y: center.y - height / 2 },
          { x: center.x - width / 2, y: center.y - height / 2 },
        ].map((p) => rotatePoint(p, center, Number(element.ccw_rotation ?? 0)))
        rows.push([
          "POLY",
          eid(),
          0,
          "",
          layer,
          round6(toMil(Number(element.stroke_width ?? 0.1))),
          toMilPolygon(local, true),
          0,
        ])
        break
      }
      case "pcb_silkscreen_circle": {
        const layer = silkscreenLayerId(element.layer)
        const center = element.center ?? { x: 0, y: 0 }
        rows.push([
          "FILL",
          eid(),
          0,
          "",
          layer,
          round6(toMil(Number(element.stroke_width ?? 0.1))),
          0,
          [
            [
              "CIRCLE",
              round6(toMil(Number(center.x ?? 0))),
              round6(toMil(Number(center.y ?? 0))),
              round6(toMil(Number(element.radius ?? 0))),
            ],
          ],
          0,
        ])
        break
      }
      case "pcb_silkscreen_text": {
        const layer = silkscreenLayerId(element.layer)
        const anchor = element.anchor_position ?? { x: 0, y: 0 }
        const size = toMil(Number(element.font_size ?? 0.2))
        rows.push([
          "STRING",
          eid(),
          0,
          layer,
          round6(toMil(Number(anchor.x ?? 0))),
          round6(toMil(Number(anchor.y ?? 0))),
          String(element.text ?? ""),
          "default",
          size,
          6,
          0,
          0,
          // 对齐模式（规范 string.md 第 13 字段）：与封装侧共用 ealignForAnchor。
          ealignForAnchor(element.anchor_alignment),
          round6(Number(element.ccw_rotation ?? 0)),
          0,
          0,
          element.layer === "bottom" ? 1 : 0,
          0,
        ])
        break
      }
      default:
        break
    }
  }
  return rows
}
