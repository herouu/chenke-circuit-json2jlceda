import { createHash } from "node:crypto"
import type { AnyCircuitElement } from "circuit-json"
import type { SourceIndex } from "../types"

/** 合成网名中哈希的长度（十六进制字符数）。 */
const SYNTHETIC_NET_HASH_LENGTH = 12

/** `md5` 短哈希（小写十六进制）。 */
function shortHash(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, SYNTHETIC_NET_HASH_LENGTH)
}

/**
 * 元件位号（refdes）的**唯一**口径：`source_component.name`（非空字符串）→ 索引键。
 *
 * `write-esch.ts`（`.esch` 的 Designator）与 `convert.ts`（Device 的 Designator）
 * 共用此函数，避免两处回退口径不一致（曾出现两处空串位号）。
 */
export function refdesFor(componentKey: string, sourceComponent: any): string {
  const name = sourceComponent?.name
  if (typeof name === "string" && name.length > 0) return name
  return componentKey
}

/**
 * 并查集：把「同属一个物理网络」的 trace 合并成连通分量。
 *
 * 合并结果与遍历顺序无关（分量集合唯一），保证确定性。
 */
class UnionFind {
  private parents = new Map<string, string>()

  find(key: string): string {
    let cursor = key
    for (;;) {
      const parent = this.parents.get(cursor)
      if (parent === undefined) {
        this.parents.set(cursor, cursor)
        return cursor
      }
      if (parent === cursor) return cursor
      const grandparent = this.parents.get(parent)
      if (grandparent !== undefined && grandparent !== parent) {
        // 路径减半，压缩长链。
        this.parents.set(cursor, grandparent)
      }
      cursor = parent
    }
  }

  union(a: string, b: string): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    // 固定按字典序选根，保证与调用顺序无关。
    if (rootA < rootB) this.parents.set(rootB, rootA)
    else this.parents.set(rootA, rootB)
  }
}

/**
 * 建立 source_* 元素索引。
 *
 * `netNameForSourceTrace`：**以物理网络（连通分量）为身份**，
 * 而不是单个 `source_trace` —— circuit-json 允许一条物理网络拆成多段 trace。
 * 同组内命名优先级：
 * 1. 组内任一 trace 的 `connected_source_net_ids` 解析出非空 `source_net.name`
 *    （多个不同名字时取排序后最小）；
 * 2. 否则组内 `source_trace.name` 非空（多个时取排序后最小）；
 * 3. 否则用组的稳定代表键（组内 trace id 排序后拼接）经 md5 生成
 *    `N$` + 12 位十六进制。
 *
 * **绝不**回退 `source_trace.display_name`（那是描述文本，形如
 * `.R1 > .pin2 to .C1 > .pin2`，含空格 / `>`，不是合法网名）。
 *
 * 分组依据（任一成立即同网，传递闭包）：共享 `connected_source_net_ids` /
 * 共享 `connected_source_port_ids` / 相同 `subcircuit_connectivity_map_key`。
 *
 * 关于 `subcircuit_connectivity_map_key` 的合并依据（已核对 `.refs/circuit-json`）：
 * 该字段是「子电路内连通域」的跨域标识，而非子电路级标识——
 *   - `.refs/circuit-json/src/source/source_trace.ts:9-10`、`source_net.ts:15-16`、
 *     `source_port.ts:18-19`、`src/pcb/pcb_via.ts:12-13`、
 *     `src/schematic/schematic_trace.ts:29-31`
 *     均为 `subcircuit_id` 与 `subcircuit_connectivity_map_key` **并列**两个字段；
 *     若是子电路级，则与 `subcircuit_id` 重复，无存在必要。
 *   - 同一 key 同时挂在 net / port / trace / via 上（source / schematic / pcb 三个域），
 *     即「同一连通域内的各类元素共享同一 key」——语义为网络级连通分量。
 * 故按 key 合并与按「共享端口 / 共享 net」合并同属网络级判据，保持现状。
 * 若真实数据出现「同一 key 分组内存在多个具名且名字不同的 source_net」，
 * 属数据自身的不一致（连通域自称同一网络却有两个名字），命名按排序取最小，
 * 不增加额外合并。
 *
 * `pinNumberForSourcePort`：优先 `source_port.pin_number`，其次从
 * `port_hints` 中找纯数字，最后回退该端口在其元件内的顺序号。
 */
export function buildSourceIndex(cj: AnyCircuitElement[]): SourceIndex {
  const componentById = new Map<string, any>()
  const portById = new Map<string, any>()
  const netById = new Map<string, any>()
  const traceById = new Map<string, any>()
  const portsByComponentId = new Map<string, any[]>()

  for (const element of cj as any[]) {
    switch (element?.type) {
      case "source_component": {
        if (typeof element.source_component_id === "string") {
          componentById.set(element.source_component_id, element)
        }
        break
      }
      case "source_port": {
        if (typeof element.source_port_id !== "string") break
        portById.set(element.source_port_id, element)
        const componentId = element.source_component_id
        if (typeof componentId === "string") {
          const list = portsByComponentId.get(componentId) ?? []
          list.push(element)
          portsByComponentId.set(componentId, list)
        }
        break
      }
      case "source_net": {
        if (typeof element.source_net_id === "string") {
          netById.set(element.source_net_id, element)
        }
        break
      }
      case "source_trace": {
        if (typeof element.source_trace_id === "string") {
          traceById.set(element.source_trace_id, element)
        }
        break
      }
      default:
        break
    }
  }

  const netNameByTraceId = buildNetNames(traceById, netById)

  return {
    componentById,
    portById,
    netById,
    traceById,
    netNameForSourceTrace(sourceTraceId: string): string | undefined {
      if (typeof sourceTraceId !== "string" || sourceTraceId.length === 0) {
        return undefined
      }
      return netNameByTraceId.get(sourceTraceId)
    },
    pinNumberForSourcePort(sourcePortId: string): string | undefined {
      const port = portById.get(sourcePortId)
      if (!port) return undefined
      if (port.pin_number !== undefined && port.pin_number !== null) {
        return String(port.pin_number)
      }
      const hints = port.port_hints
      if (Array.isArray(hints)) {
        for (const hint of hints) {
          if (typeof hint === "string" && /^\d+$/.test(hint)) return hint
        }
      }
      const componentId = port.source_component_id
      if (typeof componentId === "string") {
        const siblings = portsByComponentId.get(componentId)
        const index = siblings ? siblings.indexOf(port) : -1
        if (index >= 0) return String(index + 1)
      }
      return undefined
    },
  }
}

/** 非空字符串判断。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/**
 * 依据物理网络连通分量给每个 trace 定名。
 */
function buildNetNames(
  traceById: Map<string, any>,
  netById: Map<string, any>,
): Map<string, string> {
  const uf = new UnionFind()
  const traceNode = (id: string): string => `trace:${id}`

  for (const trace of traceById.values()) {
    const traceId = trace?.source_trace_id
    if (!isNonEmptyString(traceId)) continue
    const node = traceNode(traceId)
    uf.find(node)

    const netIds = trace.connected_source_net_ids
    if (Array.isArray(netIds)) {
      for (const netId of netIds) {
        if (isNonEmptyString(netId)) uf.union(node, `net:${netId}`)
      }
    }
    const portIds = trace.connected_source_port_ids
    if (Array.isArray(portIds)) {
      for (const portId of portIds) {
        if (isNonEmptyString(portId)) uf.union(node, `port:${portId}`)
      }
    }
    const connectivityKey = trace.subcircuit_connectivity_map_key
    if (isNonEmptyString(connectivityKey)) {
      uf.union(node, `conn:${connectivityKey}`)
    }
  }

  const groups = new Map<string, string[]>()
  for (const trace of traceById.values()) {
    const traceId = trace?.source_trace_id
    if (!isNonEmptyString(traceId)) continue
    const root = uf.find(traceNode(traceId))
    const list = groups.get(root) ?? []
    list.push(traceId)
    groups.set(root, list)
  }

  const nameByTraceId = new Map<string, string>()
  for (const traceIds of groups.values()) {
    const sortedIds = traceIds.slice().sort()
    const name = resolveGroupName(sortedIds, traceById, netById)
    for (const traceId of sortedIds) nameByTraceId.set(traceId, name)
  }
  return nameByTraceId
}

/** 组内命名：真实 source_net.name → source_trace.name → 组代表键的合成名。 */
function resolveGroupName(
  sortedTraceIds: string[],
  traceById: Map<string, any>,
  netById: Map<string, any>,
): string {
  const netNames = new Set<string>()
  const traceNames = new Set<string>()
  for (const traceId of sortedTraceIds) {
    const trace = traceById.get(traceId)
    if (!trace) continue
    const netIds = trace.connected_source_net_ids
    if (Array.isArray(netIds)) {
      for (const netId of netIds) {
        const net = netById.get(netId)
        if (isNonEmptyString(net?.name)) netNames.add(net.name)
      }
    }
    if (isNonEmptyString(trace.name)) traceNames.add(trace.name)
  }
  if (netNames.size > 0) return [...netNames].sort()[0]!
  if (traceNames.size > 0) return [...traceNames].sort()[0]!
  // 组代表键 = 组内全部 trace id 排序拼接；禁止用单个 trace_id 作身份。
  return `N$${shortHash(sortedTraceIds.join("|"))}`
}
