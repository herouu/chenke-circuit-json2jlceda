/**
 * PCB 文档的通用工具与访问器。
 *
 * 这些辅助函数被 `write-epcb.ts` 以及同目录的 components/traces/silkscreen 使用。
 * 由于 core lane 的 `ConversionContext` 形状与并行创建，这里对上下文采取
 * 「先查契约字段，再回退扫描原始 circuit-json」的防御式访问，避免因索引命名
 * 差异导致运行期失败。
 */
import { popPcbUnits, pushPcbUnits, toPcbLength } from "../units"
import { synthesizeFootprint } from "../footprint/synthesize-footprint"
import type { ConversionContext, FootprintBlueprint } from "../types"

export { popPcbUnits }

/** 保留 6 位小数，避免浮点噪声（如 3937.0080000000003）。 */
export function round6(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}

/** 毫米 -> mil。 */
export function toMil(mm: number): number {
  return round6(toPcbLength(mm))
}

/**
 * 从 ctx 解析 PCB 换算比例并进入作用域，返回进入前的值。
 *
 * PCB 写入/封装合成入口调用，配合 `finally { popPcbUnits(previous) }` 恢复，
 * 底层 `toMil` 自动使用该比例，无需逐个透传 ctx。异常/提前返回亦能恢复，
 * 不会把按次选项泄漏到同进程后续的默认换算。
 */
export function pushPcbUnitsFor(ctx: any): number | undefined {
  return pushPcbUnits(ctx?.options?.units?.pcbPerMm)
}

/**
 * 解析丝印矩形类图元（rect / oval / pill）的有效外框宽高（mm）。
 *
 * circuit-json 中 `pcb_silkscreen_oval` 使用 `radius_x`/`radius_y`，而
 * `pcb_silkscreen_rect` / `pcb_silkscreen_pill` 使用 `width`/`height`。
 * 尺寸非正（缺失/非法）时返回 `null`，由调用方发warning并跳过，
 * 避免写出四点重合的退化几何。
 */
export function silkscreenBoxSize(
  element: any,
): { width: number; height: number } | null {
  if (element?.type === "pcb_silkscreen_oval") {
    const width = Number(element.radius_x ?? 0) * 2
    const height = Number(element.radius_y ?? 0) * 2
    if (width > 0 && height > 0) return { width, height }
    return null
  }
  const width = Number(element?.width ?? 0)
  const height = Number(element?.height ?? 0)
  if (width > 0 && height > 0) return { width, height }
  return null
}

/**
 * circuit-json `NinePointAnchor`（九宫格对齐）→ EPro STRING 对齐模式数值。
 *
 * 与规范 `text/string.md` / `text/attr.md` 第 13 字段严格对应（同序 identity）：
 * `0` 左顶、`1` 中顶、`2` 右顶、`3` 左中、`4` 中、`5` 右中、
 * `6` 左底、`7` 中底、`8` 右底。
 *
 * key 覆盖 circuit-json `NinePointAnchor` 全部 9 个合法取值
 * （`.refs/circuit-json/src/common/NinePointAnchor.ts:4-13`）：
 * top_left / top_center / top_right / center_left / center / center_right /
 * bottom_left / bottom_center / bottom_right。
 *
 * 板级丝印（`silkscreen.ts`）与封装丝印（`synthesize-footprint.ts`）必须共用
 * 此函数，保证同一 `anchor_alignment` 在两处输出一致的 align 值。
 * 未知/非法值回退 4（中）：circuit-json 中 `pcb_silkscreen_text.anchor_alignment`
 * 默认即为 `"center"`（`.refs/circuit-json/src/pcb/pcb_silkscreen_text.ts:40`），
 * 故以「中」作为缺省是合理兜底。
 */
const ALIGN_TO_EALIGN: Record<string, number> = {
  top_left: 0,
  top_center: 1,
  top_right: 2,
  center_left: 3,
  center: 4,
  center_right: 5,
  bottom_left: 6,
  bottom_center: 7,
  bottom_right: 8,
}

/** 取文字 EAlign 对齐值；非法/未知回退 4（中）。 */
export function ealignForAnchor(anchor: unknown): number {
  if (typeof anchor !== "string") return 4
  return ALIGN_TO_EALIGN[anchor] ?? 4
}

/** 收集转换上下文里的原始 circuit-json 数组。 */
export function collectCircuitJson(ctx: any): any[] {
  if (!ctx) return []
  const direct = [
    ctx.circuitJson,
    ctx.circuit_json,
    ctx.circuit,
    ctx.elements,
    ctx.circuitElements,
    ctx.circuitJsonArray,
    ctx.rawCircuitJson,
    ctx.raw?.circuitJson,
  ]
  for (const candidate of direct) {
    if (Array.isArray(candidate)) return candidate
  }
  // 最后回退：扫描上下文中任意一个「元素对象数组」。
  for (const key of Object.keys(ctx)) {
    const value = (ctx as any)[key]
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value[0] &&
      typeof value[0] === "object" &&
      typeof value[0].type === "string"
    ) {
      return value
    }
  }
  return []
}

/** 按 type 过滤 circuit-json 元素。 */
export function elementsByType(ctx: any, type: string): any[] {
  return collectCircuitJson(ctx).filter((e) => e && e.type === type)
}

/** 从 Map 或普通对象中取值。 */
export function mapGet(container: any, key: string | undefined): any {
  if (container === undefined || container === null || key === undefined) {
    return undefined
  }
  if (typeof container.get === "function") return container.get(key)
  return container[key]
}

/** 把 Map / 数组 / 普通对象统一取值为数组。 */
export function collectionValues(container: any): any[] {
  if (!container) return []
  if (Array.isArray(container)) return container
  if (typeof container.values === "function") return Array.from(container.values())
  if (typeof container === "object") return Object.values(container)
  return []
}

/** 依据 id 字段在原始 circuit-json 中查元素。 */
export function findById(ctx: any, type: string, id: string | undefined): any {
  if (!id) return undefined
  const idField = `${type}_id`
  for (const element of collectCircuitJson(ctx)) {
    if (element && element.type === type && element[idField] === id) return element
  }
  return undefined
}

/** 找到某个 source_component 对应的 pcb_component。 */
export function getPcbComponentBySourceComponentId(
  ctx: any,
  sourceComponentId: string,
): any {
  const indexed = collectionValues(ctx?.pcb?.componentById ?? ctx?.pcb?.components)
  const fromIndex = indexed.find(
    (component: any) =>
      component?.source_component_id === sourceComponentId &&
      component?.type === "pcb_component",
  )
  if (fromIndex) return fromIndex
  return elementsByType(ctx, "pcb_component").find(
    (component) => component.source_component_id === sourceComponentId,
  )
}

/**
 * 经 `pcb_port_id` 回退解析元件归属。
 *
 * 焊盘/孔缺失 `pcb_component_id` 时，用其 `pcb_port_id` 找到 `pcb_port`，
 * 取其 `pcb_component_id` 作为归属。
 */
export function resolvePcbComponentIdFromPort(
  ctx: any,
  element: any,
): string | undefined {
  const portId = element?.pcb_port_id
  if (typeof portId !== "string" || portId.length === 0) return undefined
  const port =
    mapGet(ctx?.pcb?.portById, portId) ?? findById(ctx, "pcb_port", portId)
  const componentId = port?.pcb_component_id
  if (typeof componentId === "string" && componentId.length > 0) return componentId
  return undefined
}

/** 判断焊盘/孔是否属于指定 pcb_component（直接字段或经 pcb_port 回退）。 */
function belongsToComponent(
  ctx: any,
  element: any,
  pcbComponentId: string,
): boolean {
  if (element?.pcb_component_id === pcbComponentId) return true
  return resolvePcbComponentIdFromPort(ctx, element) === pcbComponentId
}

/** 取某个 pcb_component 的 SMT 焊盘。 */
export function getSmtPadsForComponent(ctx: any, pcbComponentId: string): any[] {
  const indexed =
    mapGet(ctx?.pcb?.smtPadsByComponentId, pcbComponentId) ??
    mapGet(ctx?.pcb?.smtPadsByPcbComponentId, pcbComponentId)
  if (Array.isArray(indexed)) return indexed
  return elementsByType(ctx, "pcb_smtpad").filter((pad) =>
    belongsToComponent(ctx, pad, pcbComponentId),
  )
}

/** 取某个 pcb_component 的金属化孔。 */
export function getPlatedHolesForComponent(
  ctx: any,
  pcbComponentId: string,
): any[] {
  const indexed =
    mapGet(ctx?.pcb?.platedHolesByComponentId, pcbComponentId) ??
    mapGet(ctx?.pcb?.platedHolesByPcbComponentId, pcbComponentId)
  if (Array.isArray(indexed)) return indexed
  return elementsByType(ctx, "pcb_plated_hole").filter((hole) =>
    belongsToComponent(ctx, hole, pcbComponentId),
  )
}

/**
 * 统一访问器：取 pcb_component 对应的封装蓝图。
 *
 * 优先命中 `ctx.footprintUuidByPcbComponentId`（由 `synthesizeLibrary` 建立），
 * 未命中时回退调用 `synthesizeFootprint`，避免 `.epcb` 与 `FOOTPRINT/*.efoo`
 * 两处各自重算签名导致 uuid 不一致。
 */
export function resolveFootprintForPcbComponent(
  ctx: ConversionContext,
  pcbComponent: any,
): FootprintBlueprint {
  const pcbComponentId = String(pcbComponent?.pcb_component_id ?? "")
  // 类型化读取契约字段（ConversionContext.footprintUuidByPcbComponentId）。
  const map = ctx.footprintUuidByPcbComponentId
  if (pcbComponentId && map !== undefined && map !== null) {
    const uuid = mapGet(map, pcbComponentId)
    if (typeof uuid === "string" && uuid.length > 0) {
      const blueprint = mapGet(ctx?.footprints, uuid)
      if (blueprint) return blueprint as FootprintBlueprint
    }
  }
  const sourceComponentId =
    typeof pcbComponent?.source_component_id === "string"
      ? pcbComponent.source_component_id
      : ""
  return synthesizeFootprint(
    ctx,
    sourceComponentId,
    pcbComponentId.length > 0 ? pcbComponentId : undefined,
  )
}

/** 取 source_component。 */
export function getSourceComponent(ctx: any, sourceComponentId: string): any {
  const indexed = mapGet(ctx?.source?.componentById, sourceComponentId)
  if (indexed) return indexed
  return findById(ctx, "source_component", sourceComponentId)
}

/** 取某个 source_component 对应的 schematic_component_id（用于 Channel ID）。 */
export function getSchematicComponentId(
  ctx: any,
  sourceComponentId: string,
): string | undefined {
  const schematicIndex = ctx?.schematic
  if (schematicIndex?.componentById instanceof Map) {
    for (const component of schematicIndex.componentById.values()) {
      if (
        component?.source_component_id === sourceComponentId &&
        typeof component.schematic_component_id === "string"
      ) {
        return component.schematic_component_id
      }
    }
  }
  for (const element of collectCircuitJson(ctx)) {
    if (
      element?.type === "schematic_component" &&
      element.source_component_id === sourceComponentId &&
      typeof element.schematic_component_id === "string"
    ) {
      return element.schematic_component_id
    }
  }
  return undefined
}

/** 解析 source_trace 的网络名。 */
export function netNameForSourceTrace(ctx: any, sourceTraceId?: string): string {
  if (!sourceTraceId) return ""
  const fn = ctx?.source?.netNameForSourceTrace
  if (typeof fn === "function") {
    const name = fn.call(ctx.source, sourceTraceId)
    if (name !== undefined && name !== null && name !== "") return String(name)
  }
  const trace = findById(ctx, "source_trace", sourceTraceId)
  if (trace) {
    if (trace.name) return String(trace.name)
    if (trace.display_name) return String(trace.display_name)
  }
  return ""
}

/** 解析 pcb_port 的网络名（优先上下文索引，回退扫描走线）。 */
export function netNameForPcbPort(ctx: any, pcbPortId?: string): string {
  if (!pcbPortId) return ""
  const fn = ctx?.pcb?.netNameForPcbPort
  if (typeof fn === "function") {
    const name = fn.call(ctx.pcb, pcbPortId)
    if (name !== undefined && name !== null && name !== "") return String(name)
  }
  for (const trace of elementsByType(ctx, "pcb_trace")) {
    const route = Array.isArray(trace.route) ? trace.route : []
    const connected = route.some(
      (point: any) =>
        point?.route_type === "wire" &&
        (point.start_pcb_port_id === pcbPortId ||
          point.end_pcb_port_id === pcbPortId),
    )
    if (connected) return netNameForSourceTrace(ctx, trace.source_trace_id)
  }
  return ""
}

/** 解析过孔的网络名。 */
export function netNameForPcbVia(ctx: any, via: any): string {
  if (via?.source_trace_id) {
    const name = netNameForSourceTrace(ctx, via.source_trace_id)
    if (name) return name
  }
  if (via?.pcb_trace_id) {
    const trace = findById(ctx, "pcb_trace", via.pcb_trace_id)
    if (trace?.source_trace_id) {
      return netNameForSourceTrace(ctx, trace.source_trace_id)
    }
  }
  if (via?.source_net_id) {
    const net = findById(ctx, "source_net", via.source_net_id)
    if (net?.name) return String(net.name)
  }
  return ""
}

/** 生成稳定 uuid，优先使用上下文注入的 uuid 服务。 */
export function uuidFor(ctx: any, kind: string, signature: string): string {
  const service = ctx?.uuid
  if (service) {
    if (typeof service.uuid === "function") return String(service.uuid(kind, signature))
    if (typeof service === "function") return String(service(kind, signature))
  }
  // 无 uuid 服务时的确定性回退（简易散列，仅保证同输入同输出）。
  let hash = 0
  const input = `${kind}:${signature}`
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0")
  return `${kind}-${hex}`
}

/** 输出告警（若上下文提供）。 */
export function warn(ctx: any, message: string, code = "unsupported-element"): void {
  const fn = ctx?.warn
  if (typeof fn === "function") {
    try {
      fn.call(ctx, { code, severity: "warning", message })
    } catch {
      // 忽略告警通道异常
    }
  }
}

/** 由点列生成单多边形点串 `[x1,y1,"L",x2,y2,...]`。 */
export function buildPolygonPoints(
  points: Array<{ x: number; y: number }>,
  close = true,
): unknown[] {
  const out: unknown[] = []
  const pts = points.filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
  )
  pts.forEach((point, index) => {
    if (index > 0) out.push("L")
    out.push(round6(point.x), round6(point.y))
  })
  if (close && pts.length >= 2) {
    const first = pts[0]!
    const last = pts[pts.length - 1]!
    if (first.x !== last.x || first.y !== last.y) {
      out.push("L", round6(first.x), round6(first.y))
    }
  }
  return out
}

/** 取第一个 pcb_board。 */
export function getFirstBoard(ctx: any): any {
  if (ctx?.pcb?.board) return ctx.pcb.board
  const indexed = collectionValues(ctx?.pcb?.boards ?? ctx?.pcb?.boardById)
  if (indexed.length > 0) return indexed[0]
  return elementsByType(ctx, "pcb_board")[0]
}

/** 判断某 pcb_component id 是否真实存在（索引或原始 circuit-json）。 */
export function pcbComponentExists(ctx: any, id: string | undefined): boolean {
  if (typeof id !== "string" || id.length === 0) return false
  if (mapGet(ctx?.pcb?.componentById, id) !== undefined) return true
  return !!findById(ctx, "pcb_component", id)
}

/** 取无元件归属的独立孔（pcb_hole / pcb_plated_hole）。 */
export function getStandaloneHoles(ctx: any): any[] {
  const indexed = ctx?.pcb?.standaloneHoles
  if (Array.isArray(indexed)) return indexed
  return collectCircuitJson(ctx).filter(
    (element) =>
      element &&
      (element.type === "pcb_hole" || element.type === "pcb_plated_hole") &&
      !pcbComponentExists(ctx, element.pcb_component_id) &&
      !pcbComponentExists(ctx, resolvePcbComponentIdFromPort(ctx, element)),
  )
}

/**
 * 取无元件归属的独立 SMT 焊盘。
 *
 * 既无法按 `pcb_component_id`（须为真实组件）归属，也无法经 `pcb_port_id`
 * 归属的 `pcb_smtpad`，将作为独立 PAD 写入 `.epcb`。
 */
export function getStandalonePads(ctx: any): any[] {
  const indexed = ctx?.pcb?.standalonePads
  if (Array.isArray(indexed)) return indexed
  return elementsByType(ctx, "pcb_smtpad").filter(
    (pad) =>
      !pcbComponentExists(ctx, pad?.pcb_component_id) &&
      !pcbComponentExists(ctx, resolvePcbComponentIdFromPort(ctx, pad)),
  )
}

/**
 * 生成板框图元：layer 11 的闭合 POLY，点列为显式 L 模式以避免 R 模式方向歧义。
 */
export function buildBoardOutlineRow(board: any, eid: string): unknown[] {
  let points: Array<{ x: number; y: number }>
  if (Array.isArray(board?.outline) && board.outline.length >= 3) {
    points = board.outline.map((p: any) => toMilPoint(p))
  } else {
    const cx = Number(board?.center?.x ?? 0)
    const cy = Number(board?.center?.y ?? 0)
    const width = Number(board?.width ?? 0)
    const height = Number(board?.height ?? 0)
    const halfW = width / 2
    const halfH = height / 2
    points = [
      { x: cx - halfW, y: cy + halfH },
      { x: cx + halfW, y: cy + halfH },
      { x: cx + halfW, y: cy - halfH },
      { x: cx - halfW, y: cy - halfH },
    ].map(toMilPoint)
  }
  const polygon = buildPolygonPoints(points, true)
  return ["POLY", eid, 0, "", 11, 10, polygon, 0]
}

/** 把 circuit-json 点（mm）转成 mil。 */
export function toMilPoint(point: { x: number; y: number }): {
  x: number
  y: number
} {
  return { x: toMil(Number(point?.x ?? 0)), y: toMil(Number(point?.y ?? 0)) }
}

/** 把一个绝对坐标点逆旋转到元件本地坐标系（单位仍为 mm）。 */
export function toLocalMm(
  point: { x: number; y: number },
  center: { x: number; y: number },
  rotationDeg: number,
): { x: number; y: number } {
  const dx = Number(point?.x ?? 0) - Number(center?.x ?? 0)
  const dy = Number(point?.y ?? 0) - Number(center?.y ?? 0)
  const theta = (-Number(rotationDeg ?? 0) * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
  }
}

/** 焊盘层号：SMT 焊盘 top->1、bottom->2，其余/多层 -> 12。 */
export function padLayerId(layer: string | undefined): number {
  const name = typeof layer === "string" ? layer : (layer as any)?.name
  if (name === "bottom") return 2
  if (name === "top") return 1
  return 12
}

export { layerIdForCircuitLayer } from "./layers"
