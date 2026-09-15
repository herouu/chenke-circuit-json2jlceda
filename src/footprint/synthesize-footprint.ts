/**
 * 从 circuit-json 合成 EPro 封装蓝图（本地坐标系，mils）。
 *
 * 本地坐标 = 焊盘绝对坐标 − pcb_component.center，再逆旋转 `-rotation`。
 * 焊盘/图元的显示角度同样减去元件旋转，保证实例旋转后世界表现不变。
 *
 * 说明：`FootprintBlueprint.graphics` 按 core 契约存放「EPro 图元行」
 * （可直接写入 `.efoo`），因此这里直接生成 `["POLY", ...]` / `["FILL", ...]`。
 */
import type { ConversionContext, FootprintBlueprint } from "../types"
import { computeFootprintSignature } from "../analysis/signatures"
import {
  buildPolygonPoints,
  collectCircuitJson,
  ealignForAnchor,
  findById,
  getPcbComponentBySourceComponentId,
  getPlatedHolesForComponent,
  getSmtPadsForComponent,
  getSourceComponent,
  mapGet,
  padLayerId,
  popPcbUnits,
  pushPcbUnitsFor,
  round6,
  silkscreenBoxSize,
  toLocalMm,
  toMil,
  uuidFor,
  warn,
} from "../pcb/board"
import {
  pcbHoleGeometry,
  platedHoleGeometry,
  smtPadGeometry,
  type EproPadBlueprint,
} from "../pcb/pads"
import { silkscreenLayerId } from "../pcb/layers"

function num(value: any): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 清洗封装标题：替换路径/JSON 非法字符，避免生成非法文件路径或损坏 JSON。
 * 非法字符包括 `/ \ : * ? " < > |` 与控制字符。
 */
function sanitizeFootprintTitle(raw: unknown): string {
  const text = raw === undefined || raw === null ? "" : String(raw)
  const cleaned = text
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f]/g, "_")
    .trim()
  return cleaned.length > 0 ? cleaned : text.trim()
}

/** 解析焊盘编号：优先 pcb_port -> source_port.pin_number，其次顺序号。 */
function resolvePadNumber(
  ctx: any,
  pcbPortId: string | undefined,
  fallbackIndex: number,
): string {
  const pcbPort =
    mapGet(ctx?.pcb?.portById, pcbPortId) ?? findById(ctx, "pcb_port", pcbPortId)
  const sourcePortId = pcbPort?.source_port_id
  if (sourcePortId) {
    const fn = ctx?.source?.pinNumberForSourcePort
    if (typeof fn === "function") {
      const pin = fn.call(ctx.source, sourcePortId)
      if (pin !== undefined && pin !== null && pin !== "") return String(pin)
    }
    const sourcePort = findById(ctx, "source_port", sourcePortId)
    if (sourcePort?.pin_number !== undefined && sourcePort?.pin_number !== null) {
      return String(sourcePort.pin_number)
    }
    if (sourcePort?.name) return String(sourcePort.name)
  }
  return String(fallbackIndex + 1)
}

function sourcePortIdFor(ctx: any, pcbPortId: string | undefined): string | undefined {
  const pcbPort =
    mapGet(ctx?.pcb?.portById, pcbPortId) ?? findById(ctx, "pcb_port", pcbPortId)
  return typeof pcbPort?.source_port_id === "string" ? pcbPort.source_port_id : undefined
}

interface LocalPadInput {
  id: string
  pcbPortId?: string
  padNumber: string
  layer: number
  centerMm: { x: number; y: number }
  rotationDeg: number
  padShape: unknown[]
  hole: unknown[] | null
  plated: 0 | 1
  width: number
  height: number
  holeOffsetX?: number
  holeOffsetY?: number
  holeRotation?: number
}

function buildLocalPad(ctx: any, input: LocalPadInput): EproPadBlueprint {
  return {
    id: input.id,
    sourcePortId: sourcePortIdFor(ctx, input.pcbPortId),
    pcbPortId: input.pcbPortId,
    padNumber: input.padNumber,
    layer: input.layer,
    x: toMil(input.centerMm.x),
    y: toMil(input.centerMm.y),
    rotation: round6(input.rotationDeg),
    padShape: input.padShape,
    hole: input.hole,
    plated: input.plated,
    specialPads: [],
    holeOffsetX: toMil(input.holeOffsetX ?? 0),
    holeOffsetY: toMil(input.holeOffsetY ?? 0),
    holeRotation: input.holeRotation ?? 0,
    padType: 0,
    locked: 0,
    width: input.width,
    height: input.height,
  }
}

function rotateAround(
  point: { x: number; y: number },
  center: { x: number; y: number },
  rotationDeg: number,
): { x: number; y: number } {
  const theta = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  }
}

/**
 * 合成封装蓝图。
 *
 * @param sourceComponentId source_component 的 id；无对应 source 时传空串。
 * @param pcbComponentId    可选。优先按此 id 定位 `pcb_component`；
 *                          缺省时按 `source_component_id` 查找。
 *                          两者都没有时 `title` 回退 `pcb_component_id`。
 */
export function synthesizeFootprint(
  ctx: ConversionContext,
  sourceComponentId: string,
  pcbComponentId?: string,
): FootprintBlueprint {
  // 作用域化 PCB 换算比例：正常返回/提前返回都恢复进入前的值，
  // 避免按次 units.pcbPerMm 泄漏到同进程后续的默认换算。
  const previousUnits = pushPcbUnitsFor(ctx)
  try {
    return synthesizeFootprintInner(ctx, sourceComponentId, pcbComponentId)
  } finally {
    popPcbUnits(previousUnits)
  }
}

function synthesizeFootprintInner(
  ctx: ConversionContext,
  sourceComponentId: string,
  pcbComponentId?: string,
): FootprintBlueprint {
  const c = ctx as any
  let pcbComponent = pcbComponentId
    ? (mapGet(c?.pcb?.componentById, pcbComponentId) ??
      findById(c, "pcb_component", pcbComponentId))
    : undefined
  if (!pcbComponent) {
    pcbComponent = getPcbComponentBySourceComponentId(c, sourceComponentId)
  }
  const resolvedPcbComponentId = String(
    pcbComponent?.pcb_component_id ?? pcbComponentId ?? "",
  )
  const sourceComponent =
    typeof sourceComponentId === "string" && sourceComponentId.length > 0
      ? getSourceComponent(c, sourceComponentId)
      : undefined
  // 封装标题应是「器件/封装名」而非位号：优先厂商料号，其次器件种类，最后回退。
  const title = sanitizeFootprintTitle(
    sourceComponent?.manufacturer_part_number ??
      sourceComponent?.ftype ??
      sourceComponent?.name ??
      resolvedPcbComponentId ??
      sourceComponentId,
  )

  const pads: EproPadBlueprint[] = []
  const graphics: unknown[][] = []
  const bboxPoints: Array<{ x: number; y: number }> = []
  let graphicIndex = 0

  if (!pcbComponent) {
    warn(
      c,
      `synthesizeFootprint: 找不到元件 ${sourceComponentId || pcbComponentId || ""} 的 pcb_component，生成空封装`,
      "missing-footprint",
    )
    const empty: any = {
      uuid: uuidFor(c, "footprint", sourceComponentId || resolvedPcbComponentId),
      title,
      pads,
      graphics,
      bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    }
    return empty as FootprintBlueprint
  }

  const center = {
    x: num(pcbComponent.center?.x),
    y: num(pcbComponent.center?.y),
  }
  const compRotation = num(pcbComponent.rotation)

  const smtPads = getSmtPadsForComponent(c, resolvedPcbComponentId)
  const holes = getPlatedHolesForComponent(c, resolvedPcbComponentId)

  smtPads.forEach((pad: any, index: number) => {
    const geometry = smtPadGeometry(pad)
    const localMm = toLocalMm(geometry.center, center, compRotation)
    const blueprint = buildLocalPad(c, {
      id: `e${1000 + index}`,
      pcbPortId: pad.pcb_port_id,
      padNumber: resolvePadNumber(c, pad.pcb_port_id, index),
      layer: padLayerId(pad.layer) as 1 | 2 | 12,
      centerMm: localMm,
      rotationDeg: geometry.rotation - compRotation,
      padShape: geometry.padShape,
      hole: null,
      plated: 1,
      width: geometry.width,
      height: geometry.height,
    })
    pads.push(blueprint)
    addPadExtent(bboxPoints, blueprint.x, blueprint.y, geometry.width, geometry.height)
  })

  holes.forEach((hole: any, index: number) => {
    const isPlatedHole = hole?.type === "pcb_plated_hole"
    const geometry = isPlatedHole
      ? platedHoleGeometry(hole)
      : {
          padShape: pcbHoleGeometry(hole).padShape,
          hole: pcbHoleGeometry(hole).hole,
          rotation: num(hole?.ccw_rotation),
          width: pcbHoleGeometry(hole).width,
          height: pcbHoleGeometry(hole).height,
        }
    const localMm = toLocalMm(
      { x: num(hole.x), y: num(hole.y) },
      center,
      compRotation,
    )
    const blueprint = buildLocalPad(c, {
      id: `e${1000 + smtPads.length + index}`,
      pcbPortId: hole.pcb_port_id,
      padNumber: resolvePadNumber(c, hole.pcb_port_id, smtPads.length + index),
      layer: 12,
      centerMm: localMm,
      rotationDeg: geometry.rotation - compRotation,
      padShape: geometry.padShape,
      hole: geometry.hole,
      plated: isPlatedHole ? 1 : 0,
      width: geometry.width,
      height: geometry.height,
      holeOffsetX: num(hole.hole_offset_x),
      holeOffsetY: num(hole.hole_offset_y),
    })
    pads.push(blueprint)
    addPadExtent(bboxPoints, blueprint.x, blueprint.y, geometry.width, geometry.height)
  })

  // 丝印图元（仅取属于本元件的），输出为 EProPOLY/FILL 行。
  // 板级丝印（无元件归属）由 .epcb 输出，此处只消费属主为自身者，避免双份。
  const silkscreenTypes = new Set([
    "pcb_silkscreen_line",
    "pcb_silkscreen_path",
    "pcb_silkscreen_rect",
    "pcb_silkscreen_oval",
    "pcb_silkscreen_pill",
    "pcb_silkscreen_circle",
    "pcb_silkscreen_text",
  ])
  const ownedSilkscreen: any[] = (() => {
    // 经类型化字段读取（PcbIndex.silkscreenByPcbComponentId），不靠 any 偷渡。
    const grouped = ctx.pcb?.silkscreenByPcbComponentId
    if (grouped !== undefined && grouped !== null) {
      const list = mapGet(grouped, resolvedPcbComponentId)
      return Array.isArray(list) ? list : []
    }
    // 无索引时回退扫描原始 circuit-json（仅取直接归属本元件的图元）。
    return collectCircuitJson(c).filter(
      (element) =>
        element &&
        silkscreenTypes.has(element.type) &&
        element.pcb_component_id === resolvedPcbComponentId,
    )
  })()
  for (const element of ownedSilkscreen) {
    if (!element) continue
    const id = `e${2000 + graphicIndex++}`
    const layer = silkscreenLayerId(element.layer)
    if (element.type === "pcb_silkscreen_line") {
      const points = [
        { x: num(element.x1), y: num(element.y1) },
        { x: num(element.x2), y: num(element.y2) },
      ].map((p) => toMilPoint(toLocalMm(p, center, compRotation)))
      graphics.push([
        "POLY",
        id,
        0,
        "",
        layer,
        round6(toMil(num(element.stroke_width ?? 0.1))),
        buildPolygonPoints(points, false),
        0,
      ])
      bboxPoints.push(...points)
    } else if (element.type === "pcb_silkscreen_path") {
      const route = Array.isArray(element.route) ? element.route : []
      const points = route.map((p: any) =>
        toMilPoint(toLocalMm({ x: num(p.x), y: num(p.y) }, center, compRotation)),
      )
      graphics.push([
        "POLY",
        id,
        0,
        "",
        layer,
        round6(toMil(num(element.stroke_width ?? 0.1))),
        buildPolygonPoints(points, false),
        0,
      ])
      bboxPoints.push(...points)
    } else if (
      element.type === "pcb_silkscreen_rect" ||
      element.type === "pcb_silkscreen_oval" ||
      element.type === "pcb_silkscreen_pill"
    ) {
      const rectCenter = {
        x: num(element.center?.x),
        y: num(element.center?.y),
      }
      const size = silkscreenBoxSize(element)
      if (!size) {
        warn(
          c,
          `synthesizeFootprint: ${element.type} 缺少有效尺寸（oval 需 radius_x/radius_y，rect/pill 需 width/height），已跳过`,
          "unsupported-element",
        )
        continue
      }
      const { width, height } = size
      const corners = [
        { x: rectCenter.x - width / 2, y: rectCenter.y + height / 2 },
        { x: rectCenter.x + width / 2, y: rectCenter.y + height / 2 },
        { x: rectCenter.x + width / 2, y: rectCenter.y - height / 2 },
        { x: rectCenter.x - width / 2, y: rectCenter.y - height / 2 },
      ].map((p) =>
        toMilPoint(
          toLocalMm(
            rotateAround(p, rectCenter, num(element.ccw_rotation)),
            center,
            compRotation,
          ),
        ),
      )
      graphics.push([
        "POLY",
        id,
        0,
        "",
        layer,
        round6(toMil(num(element.stroke_width ?? 0.1))),
        buildPolygonPoints(corners, true),
        0,
      ])
      bboxPoints.push(...corners)
    } else if (element.type === "pcb_silkscreen_circle") {
      const localCenter = toLocalMm(
        { x: num(element.center?.x), y: num(element.center?.y) },
        center,
        compRotation,
      )
      const radius = round6(toMil(num(element.radius)))
      graphics.push([
        "FILL",
        id,
        0,
        "",
        layer,
        0.2,
        0,
        [
          [
            "CIRCLE",
            round6(toMil(localCenter.x)),
            round6(toMil(localCenter.y)),
            radius,
          ],
        ],
        0,
      ])
      bboxPoints.push({
        x: round6(toMil(localCenter.x)) - radius,
        y: round6(toMil(localCenter.y)) - radius,
      })
      bboxPoints.push({
        x: round6(toMil(localCenter.x)) + radius,
        y: round6(toMil(localCenter.y)) + radius,
      })
    } else if (element.type === "pcb_silkscreen_text") {
      // 位号类文字（text 等于该元件 source_component.name）不写入封装：
      // EDA 会用元件自身的 Designator 属性渲染位号，烘进封装几何会与自渲染重叠，
      // 共享封装时还会串号（C1..C6 全部显示 C1）。必须在收集阶段过滤，
      // 否则 graphics 参与签名会与实际写出内容不一致。
      const refdes =
        typeof sourceComponent?.name === "string" ? sourceComponent.name : ""
      if (refdes.length > 0 && String(element.text ?? "") === refdes) continue

      // 文字锚点先转元件局部 mm，再转 mil（与其它丝印分支一致）。
      const anchor = element.anchor_position ?? { x: 0, y: 0 }
      const local = toLocalMm(
        { x: num(anchor.x), y: num(anchor.y) },
        center,
        compRotation,
      )
      const px = round6(toMil(local.x))
      const py = round6(toMil(local.y))
      // 文字角度同样减去元件旋转，保证实例旋转后世界表现不变。
      const rotation = round6(num(element.ccw_rotation) - compRotation)
      const sizeMil = toMil(num(element.font_size ?? 0.2))
      // 底层文字取 BOT_SILK(4) 并镜像，顶层取 TOP_SILK(3)。
      // 以 element.layer 为主；元件自身层与 is_mirrored 作为兜底。
      const onBottom =
        element.layer === "bottom" ||
        pcbComponent?.layer === "bottom" ||
        element.is_mirrored === true
      graphics.push([
        "STRING",
        id,
        0,
        silkscreenLayerId(onBottom ? "bottom" : "top"),
        px,
        py,
        String(element.text ?? ""),
        "default",
        sizeMil,
        6,
        0,
        0,
        ealignForAnchor(element.anchor_alignment),
        rotation,
        0,
        0,
        onBottom ? 1 : 0,
        0,
      ])
      // bbox 估算：按字号与文本长度取一个矩形，避免封装外框算漏。
      const textWidth = Math.max(
        sizeMil,
        String(element.text ?? "").length * sizeMil * 0.6,
      )
      const halfH = Math.max(sizeMil, 1) / 2
      bboxPoints.push({ x: px - textWidth / 2, y: py - halfH })
      bboxPoints.push({ x: px + textWidth / 2, y: py + halfH })
    } else {
      warn(
        c,
        `synthesizeFootprint: 暂不支持封装内图元，已跳过（${element.type}）`,
      )
    }
  }

  const bbox = computeBbox(bboxPoints)

  // 空封装（无焊盘、无图元）仍需产出 `.efoo`，但要告警。
  // 区分「组件原本无焊盘」与「焊盘被判为孤儿剥离」两种情况。
  if (pads.length === 0 && graphics.length === 0) {
    const orphanElements: any[] = Array.isArray((c as any)?.pcb?.orphanElements)
      ? (c as any).pcb.orphanElements
      : []
    const strippedCount = orphanElements.length
    const suffix =
      strippedCount > 0
        ? `；检测到 ${strippedCount} 个焊盘/孔被判为孤儿，已转为独立 PAD 写入 .epcb`
        : ""
    warn(
      c,
      `synthesizeFootprint: 元件 ${resolvedPcbComponentId || sourceComponentId} 未找到焊盘与图元，生成空封装${suffix}`,
      "missing-footprint",
    )
  }

  let signature = resolvedPcbComponentId || sourceComponentId
  try {
    signature = computeFootprintSignature(pcbComponent, smtPads, holes, {
      ftype:
        typeof sourceComponent?.ftype === "string" ? sourceComponent.ftype : undefined,
      // 器件身份（ftype + 厂商料号）纳入签名，避免不同器件误合并到同一封装。
      manufacturerPartNumber:
        typeof sourceComponent?.manufacturer_part_number === "string"
          ? sourceComponent.manufacturer_part_number
          : undefined,
      graphics,
      padNumberForPad: (pad: any, index: number) =>
        resolvePadNumber(c, pad?.pcb_port_id, index),
    })
  } catch {
    // 签名不可用时退回 pcbComponentId，保证 uuid 稳定。
  }

  const blueprint: any = {
    uuid: uuidFor(c, "footprint", String(signature)),
    title,
    pads,
    graphics,
    bbox,
  }
  return blueprint as FootprintBlueprint
}

/** 转换成 mil 坐标点。 */
function toMilPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: round6(toMil(point.x)), y: round6(toMil(point.y)) }
}

function addPadExtent(
  points: Array<{ x: number; y: number }>,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  points.push({ x: x - width / 2, y: y - height / 2 })
  points.push({ x: x + width / 2, y: y + height / 2 })
}

function computeBbox(points: Array<{ x: number; y: number }>): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return {
    minX: round6(minX),
    minY: round6(minY),
    maxX: round6(maxX),
    maxY: round6(maxY),
  }
}
