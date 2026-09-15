import type { AnyCircuitElement } from "circuit-json"
import type { PcbIndex } from "../types"
import { buildSourceIndex } from "./source-index"

function pushGrouped(
  map: Map<string, any[]>,
  componentId: unknown,
  element: any,
): boolean {
  if (typeof componentId !== "string" || componentId.length === 0) return false
  const list = map.get(componentId) ?? []
  list.push(element)
  map.set(componentId, list)
  return true
}

const SILKSCREEN_PREFIX = "pcb_silkscreen_"

/**
 * 经 `pcb_port_id` 回退解析元件归属：用于焊盘/孔未直接携带
 * `pcb_component_id` 的情况。
 */
function componentIdViaPort(
  element: any,
  portById: Map<string, any>,
): string | undefined {
  const portId = element?.pcb_port_id
  if (typeof portId !== "string" || portId.length === 0) return undefined
  const port = portById.get(portId)
  const componentId = port?.pcb_component_id
  if (typeof componentId === "string" && componentId.length > 0) return componentId
  return undefined
}

/** 生成不与已有/真实组件 id 冲突的确定性回退 id。 */
function makeFallbackComponentId(
  counter: number,
  reserved: Set<string>,
): string {
  let n = counter
  let candidate = `pcb_component_auto_${n}`
  while (reserved.has(candidate)) {
    n += 1
    candidate = `pcb_component_auto_${n}`
  }
  return candidate
}

/**
 * 建立 PCB（pcb_*）元素索引。
 *
 * 设计目标：**任何 `pcb_component` / 焊盘 / 孔都不得静默丢弃**。
 * - 缺少 `pcb_component_id` 的组件被赋予稳定回退 id 并进入 `componentById`。
 * - 无法归属到任何真实组件的 `pcb_smtpad` 进入 `standalonePads`；
 *   `pcb_plated_hole` / `pcb_hole` 进入 `standaloneHoles`。
 * - 所有孤儿元素同时记录于 `orphanElements` 供上层发诊断。
 *
 * `netNameForPcbPort` 经 `pcb_port.source_port_id` → 所属 `source_trace`
 * 的网络名解析，解析不出时返回 undefined。
 */
export function buildPcbIndex(cj: AnyCircuitElement[]): PcbIndex {
  const sourceIndex = buildSourceIndex(cj)

  // 预计算 source_port_id → 网络名。
  const netNameBySourcePortId = new Map<string, string>()
  for (const element of cj as any[]) {
    if (element?.type !== "source_trace") continue
    const name = sourceIndex.netNameForSourceTrace(element.source_trace_id)
    if (name === undefined) continue
    const portIds = element.connected_source_port_ids
    if (!Array.isArray(portIds)) continue
    for (const portId of portIds) {
      if (typeof portId === "string" && !netNameBySourcePortId.has(portId)) {
        netNameBySourcePortId.set(portId, name)
      }
    }
  }

  const componentById = new Map<string, any>()
  const portById = new Map<string, any>()
  const rawSmtPads: any[] = []
  const rawPlatedHoles: any[] = []
  const rawPcbHoles: any[] = []
  const unindexedComponentIds: string[] = []
  const traces: any[] = []
  const vias: any[] = []
  const cutouts: any[] = []
  const rawSilkscreen: any[] = []
  let board: any | undefined

  // 先收集所有真实组件 id，避免回退 id 与后出现的真实 id 冲突。
  const reservedComponentIds = new Set<string>()
  for (const element of cj as any[]) {
    if (
      element?.type === "pcb_component" &&
      typeof element.pcb_component_id === "string" &&
      element.pcb_component_id.length > 0
    ) {
      reservedComponentIds.add(element.pcb_component_id)
    }
  }

  let fallbackCounter = 0
  for (const element of cj as any[]) {
    const type: unknown = element?.type
    if (typeof type !== "string") continue

    if (type === "pcb_board") {
      if (board === undefined) board = element
      continue
    }
    if (type === "pcb_component") {
      const id = element.pcb_component_id
      if (typeof id === "string" && id.length > 0) {
        componentById.set(id, element)
      } else {
        fallbackCounter += 1
        const fallbackId = makeFallbackComponentId(
          fallbackCounter,
          reservedComponentIds,
        )
        fallbackCounter = Number(fallbackId.slice("pcb_component_auto_".length))
        reservedComponentIds.add(fallbackId)
        // 不修改输入：使用浅拷贝并写入回退 id，保证多次转换结果一致。
        const clone = { ...element, pcb_component_id: fallbackId }
        componentById.set(fallbackId, clone)
        unindexedComponentIds.push(fallbackId)
      }
      continue
    }
    if (type === "pcb_port") {
      if (typeof element.pcb_port_id === "string") {
        portById.set(element.pcb_port_id, element)
      }
      continue
    }
    if (type === "pcb_smtpad") {
      rawSmtPads.push(element)
      continue
    }
    if (type === "pcb_plated_hole") {
      rawPlatedHoles.push(element)
      continue
    }
    if (type === "pcb_hole") {
      rawPcbHoles.push(element)
      continue
    }
    if (type === "pcb_trace") {
      traces.push(element)
      continue
    }
    if (type === "pcb_via") {
      vias.push(element)
      continue
    }
    if (type === "pcb_cutout") {
      cutouts.push(element)
      continue
    }
    if (type.startsWith(SILKSCREEN_PREFIX)) {
      rawSilkscreen.push(element)
      continue
    }
  }

  const smtPadsByComponentId = new Map<string, any[]>()
  const platedHolesByComponentId = new Map<string, any[]>()
  const standaloneHoles: any[] = []
  const standalonePads: any[] = []
  const orphanElements: any[] = []

  /** 归属解析：直接 pcb_component_id（须为真实组件）优先，其次经 pcb_port 回退。 */
  const resolveOwner = (element: any): string | undefined => {
    const direct = element?.pcb_component_id
    if (
      typeof direct === "string" &&
      direct.length > 0 &&
      componentById.has(direct)
    ) {
      return direct
    }
    const viaPort = componentIdViaPort(element, portById)
    if (viaPort !== undefined && componentById.has(viaPort)) return viaPort
    return undefined
  }

  for (const pad of rawSmtPads) {
    const owner = resolveOwner(pad)
    if (owner !== undefined) {
      pushGrouped(smtPadsByComponentId, owner, pad)
    } else {
      standalonePads.push(pad)
      orphanElements.push(pad)
    }
  }
  for (const hole of rawPlatedHoles) {
    const owner = resolveOwner(hole)
    if (owner !== undefined) {
      pushGrouped(platedHolesByComponentId, owner, hole)
    } else {
      standaloneHoles.push(hole)
      orphanElements.push(hole)
    }
  }
  for (const hole of rawPcbHoles) {
    const owner = resolveOwner(hole)
    if (owner !== undefined) {
      pushGrouped(platedHolesByComponentId, owner, hole)
    } else {
      standaloneHoles.push(hole)
      orphanElements.push(hole)
    }
  }

  // 丝印按归属拆分：有真实元件归属的交给封装（`.efoo`）消费，
  // 无归属（缺失 `pcb_component_id` 或指向不存在组件）的才是板级丝印，
  // 由 `.epcb` 输出。避免同一图元在两处各写一次。
  const boardSilkscreen: any[] = []
  const silkscreenByPcbComponentId = new Map<string, any[]>()
  for (const element of rawSilkscreen) {
    const owner = resolveOwner(element)
    if (owner !== undefined) {
      pushGrouped(silkscreenByPcbComponentId, owner, element)
    } else {
      boardSilkscreen.push(element)
    }
  }

  // 直接返回结构化对象（不再经 `any` + `as PcbIndex`），使 PcbIndex 的
  // 缺失/多余字段能被 tsc 直接捕获。
  return {
    board,
    componentById,
    portById,
    smtPadsByComponentId,
    platedHolesByComponentId,
    standaloneHoles,
    standalonePads,
    unindexedComponentIds,
    orphanElements,
    traces,
    vias,
    cutouts,
    // `silkscreen` 语义为「板级丝印」，与 `boardSilkscreen` 等价，保留旧字段兼容。
    silkscreen: boardSilkscreen,
    boardSilkscreen,
    silkscreenByPcbComponentId,
    netNameForPcbPort(pcbPortId: string): string | undefined {
      const port = portById.get(pcbPortId)
      if (!port) return undefined
      const sourcePortId = port.source_port_id
      if (typeof sourcePortId !== "string") return undefined
      return netNameBySourcePortId.get(sourcePortId)
    },
  }
}
