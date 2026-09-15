/**
 * 走线（LINE）与过孔（VIA）行构造。
 *
 * 走线由 `pcb_trace.route` 的相邻同层 wire 点生成多段 LINE；via 点本身不在此
 * 处输出，统一由 `buildViaRows` 依据 `pcb_via` 列表写出，避免重复。
 */
import {
  round6,
  toMil,
  netNameForSourceTrace,
  netNameForPcbVia,
} from "./board"
import { layerIdForCircuitLayer } from "./layers"

/** 生成所有走线的 LINE 行。 */
export function buildTraceRows(
  ctx: any,
  traces: any[],
  eid: () => string,
): unknown[][] {
  const rows: unknown[][] = []
  for (const trace of traces) {
    const net = netNameForSourceTrace(ctx, trace?.source_trace_id)
    const route = Array.isArray(trace?.route) ? trace.route : []
    let prev: { x: number; y: number; layer: number } | null = null
    for (const point of route) {
      if (!point) continue
      if (point.route_type === "wire") {
        const layer = layerIdForCircuitLayer(point.layer)
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
        }
        prev = {
          x: Number(point.x ?? 0),
          y: Number(point.y ?? 0),
          layer,
        }
      } else if (point.route_type === "through_pad") {
        const width = toMil(Number(point.width ?? 0.15))
        rows.push([
          "LINE",
          eid(),
          0,
          net,
          12,
          round6(toMil(Number(point.start?.x ?? 0))),
          round6(toMil(Number(point.start?.y ?? 0))),
          round6(toMil(Number(point.end?.x ?? 0))),
          round6(toMil(Number(point.end?.y ?? 0))),
          width,
          0,
        ])
        prev = null
      } else {
        // route_type === "via"：过孔由 pcb_via 列表统一输出。
        prev = null
      }
    }
  }
  return rows
}

/** 生成所有过孔的 VIA 行（14 元素）。 */
export function buildViaRows(
  ctx: any,
  vias: any[],
  eid: () => string,
): unknown[][] {
  const rows: unknown[][] = []
  for (const via of vias) {
    const net = netNameForPcbVia(ctx, via)
    rows.push([
      "VIA",
      eid(),
      0,
      net,
      "",
      round6(toMil(Number(via?.x ?? 0))),
      round6(toMil(Number(via?.y ?? 0))),
      round6(toMil(Number(via?.hole_diameter ?? 0.25))),
      round6(toMil(Number(via?.outer_diameter ?? 0.6))),
      0,
      null,
      null,
      0,
      [],
    ])
  }
  return rows
}
