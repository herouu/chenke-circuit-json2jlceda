import type { AnyCircuitElement } from "circuit-json"
import type { SchematicIndex } from "../types"

/**
 * 建立原理图（schematic_*）元素索引，并按元件分组端口。
 *
 * `componentById` 以 `source_component_id` 为键（并行 lane 以此为查询键），
 * 缺少 source_component_id 时退回 `schematic_component_id`；两者都缺失时
 * 合成稳定键 `schematic_component#<数组下标>` 并记入
 * `unindexedSchematicComponentIds`，**不静默丢弃**。
 *
 * 键冲突（不同元素落到同一键）时保留首个，其余记入
 * `duplicateSchematicComponentKeys` 供上层发 `duplicate-id` 诊断。
 *
 * `portsByComponentId` 按 `schematic_component_id` 分组。
 */
export function buildSchematicIndex(cj: AnyCircuitElement[]): SchematicIndex {
  const componentById = new Map<string, any>()
  const portById = new Map<string, any>()
  const portsByComponentId = new Map<string, any[]>()
  const traces: any[] = []
  const netLabels: any[] = []
  const unindexedSchematicComponentIds: string[] = []
  const duplicateSchematicComponentKeys: string[] = []

  const elements = cj as any[]
  for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
    const element = elements[elementIndex]
    switch (element?.type) {
      case "schematic_component": {
        const sourceComponentId = element.source_component_id
        const schematicComponentId = element.schematic_component_id
        let key: string
        let synthesized = false
        if (typeof sourceComponentId === "string" && sourceComponentId.length > 0) {
          key = sourceComponentId
        } else if (
          typeof schematicComponentId === "string" &&
          schematicComponentId.length > 0
        ) {
          key = schematicComponentId
        } else {
          // 两个 id 都缺失：合成稳定键，保证元件进入索引并被绘制。
          key = `schematic_component#${elementIndex}`
          synthesized = true
        }
        const existing = componentById.get(key)
        if (existing !== undefined && existing !== element) {
          // 键冲突：保留首个，其余跳过并记录（不静默覆盖）。
          duplicateSchematicComponentKeys.push(key)
          break
        }
        componentById.set(key, element)
        if (synthesized) unindexedSchematicComponentIds.push(key)
        break
      }
      case "schematic_port": {
        if (typeof element.schematic_port_id !== "string") break
        portById.set(element.schematic_port_id, element)
        const componentId = element.schematic_component_id
        if (typeof componentId === "string") {
          const list = portsByComponentId.get(componentId) ?? []
          list.push(element)
          portsByComponentId.set(componentId, list)
        }
        break
      }
      case "schematic_trace": {
        traces.push(element)
        break
      }
      case "schematic_net_label": {
        netLabels.push(element)
        break
      }
      default:
        break
    }
  }

  // 直接返回结构化对象（不再经 `any` + 断言），使 `SchematicIndex` 的
  // 缺失/多余字段能被 tsc 直接捕获（与 `pcb-index.ts` 同一写法）。
  return {
    componentById,
    portById,
    portsByComponentId,
    traces,
    netLabels,
    unindexedSchematicComponentIds,
    duplicateSchematicComponentKeys,
  }
}
