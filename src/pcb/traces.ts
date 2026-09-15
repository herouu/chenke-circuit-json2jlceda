/**
 * 走线（LINE）与过孔（VIA）行构造。
 *
 * 走线由 `pcb_trace.route` 的相邻同层 wire 点生成多段 LINE；route 内的 via 点
 * 优先由 `pcb_via` 列表输出，若缺少对应 `pcb_via` 则回退用 via 点字段生成 VIA。
 */
import {
  round6,
  toMil,
  netNameForSourceTrace,
  netNameForPcbVia,
  warn,
} from "./board"
import { tryLayerIdForCircuitLayer } from "./layers"

/** 构造 14 元素 VIA 行（结构与官方 `.epcb` 样例一致）。 */
function viaRow(
  eid: string,
  net: string,
  x: number,
  y: number,
  holeDiameter: number,
  outerDiameter: number,
): unknown[] {
  return [
    "VIA",
    eid,
    0,
    net,
    "",
    round6(toMil(x)),
    round6(toMil(y)),
    round6(toMil(holeDiameter)),
    round6(toMil(outerDiameter)),
    0,
    null,
    null,
    0,
    [],
  ]
}

/** 用于告警时展示原始层值，区分 `undefined` 与字符串。 */
function describeLayer(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value)
}

/** 生成所有走线的 LINE 行。 */
export function buildTraceRows(
  ctx: any,
  traces: any[],
  eid: () => string,
): unknown[][] {
  const rows: unknown[][] = []
  for (const trace of traces) {
    const traceId = String(trace?.pcb_trace_id ?? "")
    const net = netNameForSourceTrace(ctx, trace?.source_trace_id)
    const route = Array.isArray(trace?.route) ? trace.route : []
    let prev: { x: number; y: number; layer: number } | null = null
    for (const point of route) {
      if (!point) continue
      if (point.route_type === "wire") {
        const layer = tryLayerIdForCircuitLayer(point.layer)
        if (layer === undefined) {
          // 缺层 / 非法层：不能回退成 TOP，否则会把连接画到错误铜层。
          warn(
            ctx,
            `pcb_trace ${traceId} 的 wire 点 (${Number(point.x ?? 0)}, ${Number(point.y ?? 0)}) 缺少或非法 layer（layer=${describeLayer(point.layer)}），已跳过该点`,
            "invalid-trace",
          )
          prev = null
          continue
        }
        if (prev && prev.layer === layer) {
          const width = toMil(Number(point.width ?? 0.15))
          rows.push([
            "LINE",
            eid(),
            0,
            net,
            layer,
            round6(toMil(prev.x)),
            round6(toMil(prev.y)),
            round6(toMil(Number(point.x ?? 0))),
            round6(toMil(Number(point.y ?? 0))),
            width,
            0,
          ])
        } else if (prev && prev.layer !== layer) {
          // 相邻 wire 点换层只能经 via / through_pad；直接换层属输入异常，
          // 连接段无法确定几何，明确告警而非静默丢弃。
          warn(
            ctx,
            `pcb_trace ${traceId} 相邻 wire 点跨层（layer ${prev.layer} -> ${layer}）但缺少 via/through_pad 过渡，连接段已丢弃`,
            "invalid-trace",
          )
        }
        prev = {
          x: Number(point.x ?? 0),
          y: Number(point.y ?? 0),
          layer,
        }
      } else if (point.route_type === "through_pad") {
        // `through_pad` 表示穿过焊盘/金属化孔的铜连接：导体本身由该 PAD/孔
        // （MULTI 层）实现，走线铜只应出现在 `start_layer` / `end_layer`
        // 这两个铜层上，不能画到 layer 12(MULTI)。
        // 依据：pcb_trace.ts:38-39 提供 start_layer/end_layer；line.md 第 5 字段
        // 为「层」；layer.md:39-40 定义 11=OUTLINE、12=MULTI；官方 .epcb 的
        // LINE 只出现在 1/2 铜层（实测 21bf3cb7…epcb）。
        const width = round6(toMil(Number(point.width ?? 0.15)))
        const x1 = round6(toMil(Number(point.start?.x ?? 0)))
        const y1 = round6(toMil(Number(point.start?.y ?? 0)))
        const x2 = round6(toMil(Number(point.end?.x ?? 0)))
        const y2 = round6(toMil(Number(point.end?.y ?? 0)))
        const startLayer = tryLayerIdForCircuitLayer(point.start_layer)
        const endLayer = tryLayerIdForCircuitLayer(point.end_layer)
        if (startLayer === undefined || endLayer === undefined) {
          const bad: string[] = []
          if (startLayer === undefined) {
            bad.push(`start_layer=${describeLayer(point.start_layer)}`)
          }
          if (endLayer === undefined) {
            bad.push(`end_layer=${describeLayer(point.end_layer)}`)
          }
          warn(
            ctx,
            `pcb_trace ${traceId} 的 through_pad 点 (${x1}, ${y1})->(${x2}, ${y2}) 缺少或非法层（${bad.join(", ")}），已跳过该段`,
            "invalid-trace",
          )
          prev = null
          continue
        }
        rows.push(["LINE", eid(), 0, net, startLayer, x1, y1, x2, y2, width, 0])
        if (endLayer !== startLayer) {
          rows.push(["LINE", eid(), 0, net, endLayer, x1, y1, x2, y2, width, 0])
        }
        prev = null
      } else {
        // route_type === "via"：过孔由 `buildViaRows` 输出。
        prev = null
      }
    }
  }
  return rows
}

/** route 内 via 点的归一化信息。 */
interface RouteVia {
  x: number
  y: number
  hole: number
  outer: number
  hasHole: boolean
  hasOuter: boolean
  net: string
  traceId: string
}

/**
 * 生成所有过孔 VIA 行。
 *
 * 分工：
 * - `pcb_via` 元素是**权威来源**：每个元素各输出一行；其自身解析不出网名
 *   （空串）时，用同坐标 route via 所属 `source_trace` 的网名回填。
 * - route 内 via 点若在 `pcb_via` 中已存在（按坐标视为同一物理过孔）→ 不重复
 *   输出，但 route 侧网名/孔径与权威值不一致时发 warning（不静默丢信息）。
 * - 没有 `pcb_via` 的 route via 点 → 回退生成 VIA 行；去重按「坐标 + 孔径」
 *   完整身份进行（同坐标不同孔径视为不同物理过孔，各自输出）。
 */
export function buildViaRows(
  ctx: any,
  vias: any[],
  traces: any[],
  eid: () => string,
): unknown[][] {
  const rows: unknown[][] = []
  const existingVias = Array.isArray(vias) ? vias : []
  const traceList = Array.isArray(traces) ? traces : []
  const coordKey = (x: number, y: number): string => `${round6(x)},${round6(y)}`

  const routeVias: RouteVia[] = []
  for (const trace of traceList) {
    const traceId = String(trace?.pcb_trace_id ?? "")
    const net = netNameForSourceTrace(ctx, trace?.source_trace_id)
    const route = Array.isArray(trace?.route) ? trace.route : []
    for (const point of route) {
      if (point?.route_type !== "via") continue
      routeVias.push({
        x: Number(point.x ?? 0),
        y: Number(point.y ?? 0),
        hole: Number(point.hole_diameter ?? 0.25),
        outer: Number(point.outer_diameter ?? 0.6),
        hasHole: point.hole_diameter !== undefined && point.hole_diameter !== null,
        hasOuter:
          point.outer_diameter !== undefined && point.outer_diameter !== null,
        net,
        traceId,
      })
    }
  }

  // 坐标 -> 权威 pcb_via（同坐标只取第一个用于冲突比对）。
  const existingByCoord = new Map<string, any>()
  for (const via of existingVias) {
    const key = coordKey(Number(via?.x ?? 0), Number(via?.y ?? 0))
    if (!existingByCoord.has(key)) existingByCoord.set(key, via)
  }

  // 权威 pcb_via 自身解析出的网名；空串表示无法解析。
  const existingNetByCoord = new Map<string, string>()
  for (const [key, via] of existingByCoord) {
    existingNetByCoord.set(key, netNameForPcbVia(ctx, via))
  }

  // route 侧网名（按坐标），用于回填空网名与冲突告警。
  const routeNetByCoord = new Map<string, string>()
  for (const rv of routeVias) {
    if (rv.net === "") continue
    const key = coordKey(rv.x, rv.y)
    const prev = routeNetByCoord.get(key)
    if (prev === undefined) routeNetByCoord.set(key, rv.net)
    else if (prev !== rv.net) {
      warn(
        ctx,
        `同一坐标 (${rv.x}, ${rv.y}) 的 route via 出现不同网名（${prev} vs ${rv.net}），已保留 ${prev}`,
        "invalid-trace",
      )
    }
  }

  // 1) pcb_via 权威行：空网名用 route 网名回填（仅在能恢复出非空网名时）。
  for (const via of existingVias) {
    const key = coordKey(Number(via?.x ?? 0), Number(via?.y ?? 0))
    const net = existingNetByCoord.get(key) || routeNetByCoord.get(key) || ""
    rows.push(
      viaRow(
        eid(),
        net,
        Number(via?.x ?? 0),
        Number(via?.y ?? 0),
        Number(via?.hole_diameter ?? 0.25),
        Number(via?.outer_diameter ?? 0.6),
      ),
    )
  }

  // 2) route via 与既有 pcb_via 同坐标 = 同一物理过孔：不重复输出；
  //    但若 route 侧网名/孔径与权威值不一致，明确告警说明被忽略的字段。
  for (const rv of routeVias) {
    const key = coordKey(rv.x, rv.y)
    const via = existingByCoord.get(key)
    if (!via) continue
    const existingNet = existingNetByCoord.get(key) ?? ""
    if (rv.net !== "" && existingNet !== "" && rv.net !== existingNet) {
      warn(
        ctx,
        `pcb_trace ${rv.traceId} 的 route via 点 (${rv.x}, ${rv.y}) 与既有 pcb_via 同坐标合并，route 网名 ${rv.net} 被忽略（保留 ${existingNet}）`,
        "invalid-trace",
      )
    }
    const viaHole = Number(via?.hole_diameter ?? 0.25)
    const viaOuter = Number(via?.outer_diameter ?? 0.6)
    if (rv.hasHole && round6(rv.hole) !== round6(viaHole)) {
      warn(
        ctx,
        `pcb_trace ${rv.traceId} 的 route via 点 (${rv.x}, ${rv.y}) 与既有 pcb_via 同坐标合并，route 孔径 hole=${rv.hole} 被忽略（保留 ${viaHole}）`,
        "invalid-trace",
      )
    }
    if (rv.hasOuter && round6(rv.outer) !== round6(viaOuter)) {
      warn(
        ctx,
        `pcb_trace ${rv.traceId} 的 route via 点 (${rv.x}, ${rv.y}) 与既有 pcb_via 同坐标合并，route 孔径 outer=${rv.outer} 被忽略（保留 ${viaOuter}）`,
        "invalid-trace",
      )
    }
  }

  // 3) 无 pcb_via 的 route via 回退行：按「坐标+孔径」完整身份去重，
  //    同坐标不同孔径视为不同过孔，各自输出。
  const emittedIdentity = new Map<string, RouteVia>()
  for (const rv of routeVias) {
    const key = coordKey(rv.x, rv.y)
    if (existingByCoord.has(key)) continue
    const identity = `${key}|${round6(rv.hole)}|${round6(rv.outer)}`
    const prev = emittedIdentity.get(identity)
    if (prev) {
      // 同坐标同孔径的重复 route via：合并为一条，但不静默。
      if (prev.net !== rv.net) {
        warn(
          ctx,
          `同坐标 (${rv.x}, ${rv.y}) 同孔径的 route via 已合并，网名 ${rv.net || '""'} 被忽略（保留 ${prev.net || '""'}）`,
          "invalid-trace",
        )
      } else {
        warn(
          ctx,
          `同坐标 (${rv.x}, ${rv.y}) 同孔径的 route via 重复，已合并为一条 VIA 行`,
          "invalid-trace",
        )
      }
      continue
    }
    emittedIdentity.set(identity, rv)
    warn(
      ctx,
      `pcb_trace ${rv.traceId} 的 via 点 (${rv.x}, ${rv.y}) 缺少对应 pcb_via，已回退生成 VIA 行`,
      "missing-via",
    )
    rows.push(viaRow(eid(), rv.net, rv.x, rv.y, rv.hole, rv.outer))
  }
  return rows
}
