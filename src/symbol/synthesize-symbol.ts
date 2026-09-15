import { computeSymbolSignature } from "../analysis/signatures"
import type {
  ConversionContext,
  SymbolBlueprint,
  SymbolPinBlueprint,
} from "../types"
import { round6, SCH_UNITS_PER_MM } from "../units"

/** 默认本体尺寸（mm）。 */
const DEFAULT_SIZE_MM = 2.54
/** 默认引脚长度（SCH 单位，仅占位符号使用）。 */
const DEFAULT_PIN_LENGTH = 10
/** `distance_from_component_edge` 缺省值（mm）。 */
const DEFAULT_DISTANCE_FROM_EDGE_MM = 0.4
/** 引脚长度下限（SCH 单位），避免 0 长度。 */
const MIN_PIN = 1
/** 本体尺寸下限系数：内缩后不得小于整体尺寸的该比例。 */
const MIN_BODY_FRACTION = 0.4

type JsonLine = unknown[]
type PinRotation = 0 | 90 | 180 | 270
type PinElecType = 0 | 1 | 2 | 3
type PinSide = "left" | "right" | "up" | "down"

/** 引脚朝向 → 旋转角（Y 轴向上，旋转由引脚端点指向本体内）。 */
const FACING_ROTATION: Record<string, PinRotation> = {
  right: 180,
  left: 0,
  up: 270,
  down: 90,
}

/** 翻转 Y 轴时，上/下朝向互换。 */
const FLIPPED_FACING_ROTATION: Record<string, PinRotation> = {
  right: 180,
  left: 0,
  up: 90,
  down: 270,
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/** 依据 source_port.port_hints 推断电气类型：1=INPUT、2=OUTPUT。 */
function elecTypeForHints(hints: readonly string[] | undefined): PinElecType {
  const normalized = (hints ?? []).map((hint) => hint.toLowerCase())
  if (
    normalized.some(
      (hint) =>
        hint.includes("power") || hint === "pos" || hint.includes("input"),
    )
  ) {
    return 1
  }
  if (normalized.some((hint) => hint.includes("output"))) return 2
  return 1
}

function rotationForFacing(
  direction: string | undefined,
  flipY: boolean,
): PinRotation {
  const table = flipY ? FLIPPED_FACING_ROTATION : FACING_ROTATION
  return table[direction ?? "left"] ?? 0
}

/** 端口所属侧：优先 `facing_direction`，缺失时按局部坐标推断。 */
function sideForPort(
  facing: string | undefined,
  localX: number,
  localY: number,
): PinSide {
  if (facing === "left" || facing === "right" || facing === "up" || facing === "down") {
    return facing
  }
  if (Math.abs(localX) >= Math.abs(localY)) return localX < 0 ? "left" : "right"
  return localY < 0 ? "down" : "up"
}

/** 连接点到本体边缘的距离（mm）。 */
function distanceFromEdgeForPort(port: any): number {
  const distance = port?.distance_from_component_edge
  return typeof distance === "number" && Number.isFinite(distance) && distance > 0
    ? distance
    : DEFAULT_DISTANCE_FROM_EDGE_MM
}

/**
 * 由 circuit-json 的 schematic_component / schematic_port 合成 `.esym` 蓝图。
 *
 * 本体矩形以部件中心为原点；引脚使用相对本体的局部坐标（Y 轴向上）。
 *
 * `layout` 提供**统一**的 `scale`（单位/毫米，含适配系数）与 `flipY`；
 * 缺省退回 `SCH_UNITS_PER_MM` 且不缩放。引脚长度与本体尺寸均按同一 `scale`
 * 换算，确保缩放后引脚端点与导线严格对齐。
 */
export function synthesizeSymbol(
  ctx: ConversionContext,
  sourceComponentId: string,
  layout?: { scale: number; flipY: boolean },
): SymbolBlueprint {
  const schematicComponent = ctx.schematic.componentById.get(sourceComponentId)
  if (!schematicComponent) {
    ctx.warn({
      code: "missing-symbol",
      severity: "warning",
      message: `No schematic_component found for source_component ${sourceComponentId}; emitting placeholder symbol.`,
      circuitElementType: "source_component",
      circuitElementId: sourceComponentId,
    })
    return createPlaceholderBlueprint(ctx, sourceComponentId)
  }

  const ports =
    ctx.schematic.portsByComponentId.get(
      schematicComponent.schematic_component_id,
    ) ?? []
  const sourceComponent = ctx.source.componentById.get(sourceComponentId)
  const scale =
    typeof layout?.scale === "number" && Number.isFinite(layout.scale) && layout.scale > 0
      ? layout.scale
      : SCH_UNITS_PER_MM
  const flipY = layout?.flipY ?? ctx.options.axis.schematicFlipY === true
  const mmToSch = (mm: number): number => round6(mm * scale)

  let idCounter = 0
  const nextId = (prefix: string): string => `${prefix}${++idCounter}`

  const totalWidth = mmToSch(
    positiveOr(schematicComponent.size?.width, DEFAULT_SIZE_MM),
  )
  const totalHeight = mmToSch(
    positiveOr(schematicComponent.size?.height, DEFAULT_SIZE_MM),
  )

  const componentCenter = schematicComponent.center ?? { x: 0, y: 0 }

  // 解析端口：局部坐标、所属侧、引脚长度（连接点 → 本体边缘的距离）。
  const resolvedPorts = ports.map((port, index) => {
    const localX = (port.center?.x ?? 0) - componentCenter.x
    const localY = (port.center?.y ?? 0) - componentCenter.y
    const side = sideForPort(port.facing_direction, localX, localY)
    const pinLength = round6(Math.max(MIN_PIN, distanceFromEdgeForPort(port) * scale))
    return { port, index, localX, localY, side, pinLength }
  })

  // 每侧取该侧最大引脚长度用于本体自该侧内缩。
  const sidePin: Record<PinSide, number> = { left: 0, right: 0, up: 0, down: 0 }
  for (const resolved of resolvedPorts) {
    sidePin[resolved.side] = Math.max(sidePin[resolved.side], resolved.pinLength)
  }

  // 本体尺寸 = 整体包围盒内缩有引脚侧，且不低于整体尺寸的 MIN_BODY_FRACTION。
  let bodyWidth = totalWidth - sidePin.left - sidePin.right
  if (bodyWidth < totalWidth * MIN_BODY_FRACTION) {
    bodyWidth = totalWidth * MIN_BODY_FRACTION
  }
  let bodyHeight = totalHeight - sidePin.up - sidePin.down
  if (bodyHeight < totalHeight * MIN_BODY_FRACTION) {
    bodyHeight = totalHeight * MIN_BODY_FRACTION
  }
  const halfWidth = round6(bodyWidth / 2)
  const halfHeight = round6(bodyHeight / 2)

  const linestyleId = nextId("st")
  const nameFontstyleId = nextId("st")
  const numberFontstyleId = nextId("st")

  // 样式必须先于引用出现。
  const primitives: JsonLine[] = [
    ["LINESTYLE", linestyleId, null, null, null, null, null],
    [
      "FONTSTYLE",
      nameFontstyleId,
      null,
      null,
      null,
      null,
      0,
      0,
      0,
      null,
      2,
      2,
    ],
    [
      "FONTSTYLE",
      numberFontstyleId,
      null,
      null,
      null,
      null,
      0,
      0,
      0,
      null,
      2,
      0,
    ],
  ]

  const yTop = flipY ? -halfHeight : halfHeight
  const yBottom = flipY ? halfHeight : -halfHeight
  primitives.push([
    "RECT",
    nextId("e"),
    round6(-halfWidth),
    round6(yTop),
    round6(halfWidth),
    round6(yBottom),
    0,
    0,
    0,
    linestyleId,
    0,
  ])

  let minX = -halfWidth
  let maxX = halfWidth
  let minY = -halfHeight
  let maxY = halfHeight

  const pins: SymbolPinBlueprint[] = []

  for (const resolved of resolvedPorts) {
    const { port } = resolved
    const localX = round6(resolved.localX * scale)
    let localY = round6(resolved.localY * scale)
    if (flipY) localY = -localY

    const sourcePort = ctx.source.portById.get(port.source_port_id)
    const pinNumber =
      ctx.source.pinNumberForSourcePort(port.source_port_id) ??
      (port.pin_number != null ? String(port.pin_number) : String(resolved.index + 1))
    const pinName = sourcePort?.name ?? pinNumber
    const rotation = rotationForFacing(port.facing_direction, flipY)
    const elecType = elecTypeForHints(sourcePort?.port_hints)
    const pinLength = round6(resolved.pinLength)

    const pinId = nextId("e")
    primitives.push([
      "PIN",
      pinId,
      1,
      elecType,
      localX,
      localY,
      pinLength,
      rotation,
      null,
      0,
      0,
    ])
    primitives.push([
      "ATTR",
      nextId("e"),
      pinId,
      "NAME",
      pinName,
      0,
      0,
      null,
      null,
      0,
      nameFontstyleId,
      0,
    ])
    primitives.push([
      "ATTR",
      nextId("e"),
      pinId,
      "NUMBER",
      pinNumber,
      0,
      0,
      null,
      null,
      0,
      numberFontstyleId,
      0,
    ])

    pins.push({
      sourcePortId: port.source_port_id,
      pinNumber,
      name: pinName,
      x: localX,
      y: localY,
      length: pinLength,
      rotation,
      elecType,
      display: true,
    })

    minX = Math.min(minX, localX)
    maxX = Math.max(maxX, localX)
    minY = Math.min(minY, localY)
    maxY = Math.max(maxY, localY)
  }

  // 签名需同时体现 ftype（source_component）与尺寸（schematic_component）。
  const signatureInput = sourceComponent
    ? { ...sourceComponent, size: schematicComponent.size }
    : schematicComponent
  const signature = computeSymbolSignature(signatureInput, ports)
  const uuid = ctx.uuid.uuid("symbol", signature)

  return {
    uuid,
    title: sourceComponent?.name ?? schematicComponent.symbol_name ?? "",
    symbolType: 2,
    partName: "",
    bbox: {
      minX: round6(minX),
      minY: round6(minY),
      maxX: round6(maxX),
      maxY: round6(maxY),
    },
    primitives,
    pins,
  }
}

/** 找不到 schematic_component 时的占位符号（最小矩形）。 */
function createPlaceholderBlueprint(
  ctx: ConversionContext,
  sourceComponentId: string,
): SymbolBlueprint {
  const half = DEFAULT_PIN_LENGTH / 2
  const primitives: JsonLine[] = [
    ["LINESTYLE", "st1", null, null, null, null, null],
    ["RECT", "e1", -half, half, half, -half, 0, 0, 0, "st1", 0],
  ]
  return {
    uuid: ctx.uuid.uuid("symbol", `missing:${sourceComponentId}`),
    title: "",
    symbolType: 2,
    partName: "",
    bbox: { minX: -half, minY: -half, maxX: half, maxY: half },
    primitives,
    pins: [],
  }
}
