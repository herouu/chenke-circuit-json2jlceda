/**
 * 焊盘几何与 PAD 行构造。
 *
 * 所有长度在 blueprint 中以 mil 存储（已通过 `toMil` 转换）。
 * `padShape` 仅使用 `{ELLIPSE, RECT, OVAL}`：
 * - `["RECT",w,h,cornerRadius]`
 * - `["ELLIPSE",w,h]`（圆 / 椭圆）
 * - `["OVAL",w,h]`（长圆 / pill）
 * 位置式（数组式）22 字段 PAD 记录在 V3.2.186 **不落地多边形焊盘**
 * （`["POLY",…]` 与 `["POLYGON",…]` 均被导入器丢弃），因此多边形焊盘按
 * 其外接矩形 `RECT` 降级（本板 J1 脚 13–16 为实心矩形，面积偏差 <0.02%，
 * 零损失）。
 * 孔：`null`（SMD）或 `["ROUND",w,h]` / `["RECT",w,h]`；`ROUND`/`RECT` 仅用于 hole 字段。
 */
import { toMil, round6 } from "./board"

export interface EproPadBlueprint {
  id: string
  sourcePortId?: string
  pcbPortId?: string
  /** 焊盘网络名；仅独立/孤儿焊盘在 `.epcb` 的 PAD 行第 4 字段使用。 */
  net?: string
  padNumber: string
  /** EPro 层号：1/2 SMD，12 通孔。 */
  layer: number
  x: number
  y: number
  rotation: number
  padShape: unknown[]
  hole: unknown[] | null
  plated: 0 | 1
  specialPads: unknown[][]
  holeOffsetX: number
  holeOffsetY: number
  holeRotation: number
  padType: number
  locked: number
  /** 焊盘外框宽/高（mil），用于生成可焊区 FILL。 */
  width: number
  height: number
}

function num(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** SMT 焊盘几何 -> padShape（mil）。 */
export function smtPadGeometry(pad: any): {
  padShape: unknown[]
  rotation: number
  width: number
  height: number
  center: { x: number; y: number }
} {
  const shape = pad?.shape
  if (shape === "circle") {
    const diameter = num(pad.radius) * 2
    return {
      padShape: ["ELLIPSE", toMil(diameter), toMil(diameter)],
      rotation: 0,
      width: toMil(diameter),
      height: toMil(diameter),
      center: { x: num(pad.x), y: num(pad.y) },
    }
  }
  if (shape === "polygon") {
    const rawPoints = Array.isArray(pad.points) ? pad.points : []
    const cx =
      rawPoints.reduce((sum: number, p: any) => sum + num(p.x), 0) /
      Math.max(rawPoints.length, 1)
    const cy =
      rawPoints.reduce((sum: number, p: any) => sum + num(p.y), 0) /
      Math.max(rawPoints.length, 1)
    const relPoints = rawPoints.map((p: any) => ({
      x: toMil(num(p.x) - cx),
      y: toMil(num(p.y) - cy),
    }))
    const width =
      Math.max(...relPoints.map((p: any) => p.x), 0) -
      Math.min(...relPoints.map((p: any) => p.x), 0)
    const height =
      Math.max(...relPoints.map((p: any) => p.y), 0) -
      Math.min(...relPoints.map((p: any) => p.y), 0)
    return {
      padShape: ["RECT", round6(width), round6(height), 0],
      rotation: 0,
      width,
      height,
      center: { x: num(pad.x) || cx, y: num(pad.y) || cy },
    }
  }
  const width = num(pad.width)
  const height = num(pad.height)
  const rotation = num(pad.ccw_rotation)
  if (shape === "pill" || shape === "rotated_pill") {
    return {
      padShape: ["OVAL", toMil(width), toMil(height)],
      rotation,
      width: toMil(width),
      height: toMil(height),
      center: { x: num(pad.x), y: num(pad.y) },
    }
  }
  const corner = num(pad.corner_radius ?? pad.rect_border_radius ?? 0)
  return {
    padShape: ["RECT", toMil(width), toMil(height), toMil(corner)],
    rotation,
    width: toMil(width),
    height: toMil(height),
    center: { x: num(pad.x), y: num(pad.y) },
  }
}

/** 金属化孔几何 -> padShape + hole（mil）。 */
export function platedHoleGeometry(platedHole: any): {
  padShape: unknown[]
  hole: unknown[]
  rotation: number
  width: number
  height: number
} {
  const shape = platedHole?.shape
  if (shape === "circle") {
    const outer = num(platedHole.outer_diameter)
    const hole = num(platedHole.hole_diameter)
    return {
      padShape: ["ELLIPSE", toMil(outer), toMil(outer)],
      hole: ["ROUND", toMil(hole), toMil(hole)],
      rotation: 0,
      width: toMil(outer),
      height: toMil(outer),
    }
  }
  if (shape === "oval" || shape === "pill") {
    return {
      padShape: [
        "OVAL",
        toMil(num(platedHole.outer_width)),
        toMil(num(platedHole.outer_height)),
      ],
      hole: [
        "ROUND",
        toMil(num(platedHole.hole_width)),
        toMil(num(platedHole.hole_height)),
      ],
      rotation: num(platedHole.ccw_rotation),
      width: toMil(num(platedHole.outer_width)),
      height: toMil(num(platedHole.outer_height)),
    }
  }
  if (
    shape === "circular_hole_with_rect_pad" ||
    shape === "pill_hole_with_rect_pad" ||
    shape === "rotated_pill_hole_with_rect_pad"
  ) {
    const padWidth = toMil(num(platedHole.rect_pad_width))
    const padHeight = toMil(num(platedHole.rect_pad_height))
    const hole =
      shape === "circular_hole_with_rect_pad"
        ? (["ROUND", toMil(num(platedHole.hole_diameter)), toMil(num(platedHole.hole_diameter))] as unknown[])
        : ([
            "ROUND",
            toMil(num(platedHole.hole_width)),
            toMil(num(platedHole.hole_height)),
          ] as unknown[])
    return {
      padShape: [
        "RECT",
        padWidth,
        padHeight,
        toMil(num(platedHole.rect_border_radius ?? 0)),
      ],
      hole,
      rotation: num(platedHole.rect_ccw_rotation ?? platedHole.ccw_rotation),
      width: padWidth,
      height: padHeight,
    }
  }
  // hole_with_polygon_pad
  const outline = Array.isArray(platedHole?.pad_outline)
    ? platedHole.pad_outline
    : []
  const cx =
    outline.reduce((sum: number, p: any) => sum + num(p.x), 0) /
    Math.max(outline.length, 1)
  const cy =
    outline.reduce((sum: number, p: any) => sum + num(p.y), 0) /
    Math.max(outline.length, 1)
  const relPoints = outline.map((p: any) => ({
    x: toMil(num(p.x) - cx),
    y: toMil(num(p.y) - cy),
  }))
  const holeWidth =
    platedHole.hole_diameter ??
    platedHole.hole_width ??
    platedHole.hole_height ??
    0
  const width =
    Math.max(...relPoints.map((p: any) => p.x), 0) -
    Math.min(...relPoints.map((p: any) => p.x), 0)
  const height =
    Math.max(...relPoints.map((p: any) => p.y), 0) -
    Math.min(...relPoints.map((p: any) => p.y), 0)
  return {
    padShape: ["RECT", round6(width), round6(height), 0],
    hole: ["ROUND", toMil(num(holeWidth)), toMil(num(holeWidth))],
    rotation: num(platedHole.ccw_rotation),
    width,
    height,
  }
}

/** 独立 pcb_hole（非金属化）几何。 */
export function pcbHoleGeometry(hole: any): {
  padShape: unknown[]
  hole: unknown[]
  width: number
  height: number
} {
  const shape = hole?.hole_shape
  if (shape === "circle" || shape === "square") {
    const d = num(hole.hole_diameter)
    return {
      padShape: ["ELLIPSE", toMil(d), toMil(d)],
      hole: ["ROUND", toMil(d), toMil(d)],
      width: toMil(d),
      height: toMil(d),
    }
  }
  if (shape === "rect") {
    const w = num(hole.hole_width)
    const h = num(hole.hole_height)
    return {
      padShape: ["RECT", toMil(w), toMil(h), 0],
      hole: ["RECT", toMil(w), toMil(h)],
      width: toMil(w),
      height: toMil(h),
    }
  }
  // oval / pill / rotated_pill
  const w = num(hole.hole_width)
  const h = num(hole.hole_height)
  return {
    padShape: ["OVAL", toMil(w), toMil(h)],
    hole: ["ROUND", toMil(w), toMil(h)],
    width: toMil(w),
    height: toMil(h),
  }
}

/** 构造 22 元素的 .efoo PAD 行。 */
export function buildEfooPadRow(pad: EproPadBlueprint): unknown[] {
  return [
    "PAD",
    pad.id,
    0,
    "",
    pad.layer,
    pad.padNumber,
    round6(pad.x),
    round6(pad.y),
    round6(pad.rotation),
    pad.hole,
    pad.padShape,
    pad.specialPads ?? [],
    round6(pad.holeOffsetX),
    round6(pad.holeOffsetY),
    round6(pad.holeRotation),
    pad.plated,
    pad.padType,
    null,
    null,
    null,
    null,
    pad.locked,
  ]
}

/** 构造 27 元素的 .epcb PAD 行（含热焊扩展位，MVP 置 null）。 */
export function buildPcbPadRow(pad: EproPadBlueprint): unknown[] {
  return [
    "PAD",
    pad.id,
    0,
    pad.net ?? "",
    pad.layer,
    pad.padNumber,
    round6(pad.x),
    round6(pad.y),
    round6(pad.rotation),
    pad.hole,
    pad.padShape,
    pad.specialPads ?? [],
    round6(pad.holeOffsetX),
    round6(pad.holeOffsetY),
    round6(pad.holeRotation),
    pad.plated,
    pad.padType,
    null,
    null,
    null,
    null,
    pad.locked,
    null,
    null,
    null,
    null,
    [],
  ]
}
