/**
 * PCB 元件实例（COMPONENT / ATTR / PAD_NET）行构造。
 *
 * 注意：.epcb 的元件实例不内嵌 PAD，焊盘来自同 uuid 的 `FOOTPRINT/*.efoo`。
 * 这里只输出实例、属性与焊盘-网络映射。
 */
import {
  round6,
  toMil,
  uuidFor,
  netNameForPcbPort,
  getSourceComponent,
  getSchematicComponentId,
  warn,
} from "./board"
import { layerIdForCircuitLayer } from "./layers"

export type EidGenerator = () => string

/** 构造单条 22 元素 ATTR 行。 */
export function makeAttrRow(params: {
  id: string
  parentId: string
  layer: number
  x: number | null
  y: number | null
  key: string
  value: string
  showKey: number
  showValue: number
  align?: number
}): unknown[] {
  return [
    "ATTR",
    params.id,
    0,
    params.parentId,
    params.layer,
    params.x,
    params.y,
    params.key,
    params.value,
    params.showKey,
    params.showValue,
    "default",
    45,
    6,
    0,
    0,
    params.align ?? 3,
    0,
    0,
    0,
    0,
    0,
  ]
}

/**
 * 生成某元件的 COMPONENT + ATTR + PAD_NET 行。
 *
 * @param bp 由 `synthesizeFootprint` 产生的封装蓝图（提供 uuid/title/pads）。
 */
export function buildComponentRows(
  ctx: any,
  comp: any,
  bp: any,
  compEid: string,
  eid: EidGenerator,
): unknown[][] {
  const rows: unknown[][] = []
  const layer = layerIdForCircuitLayer(comp?.layer)
  const center = comp?.center ?? { x: 0, y: 0 }
  const x = toMil(Number(center.x ?? 0))
  const y = toMil(Number(center.y ?? 0))
  const rotation = round6(Number(comp?.rotation ?? 0))

  const attrs: Record<string, string> = {
    "Reuse Block": "",
    "Group ID": "",
    "Channel ID": `$1e${getSchematicComponentId(ctx, comp?.source_component_id ?? "") ?? comp?.source_component_id ?? ""}`,
    "Unique ID": `gge${String(compEid).replace(/^e/, "")}`,
  }
  rows.push(["COMPONENT", compEid, 0, layer, x, y, rotation, attrs, 0, null])

  const attrLayer = layer === 2 ? 4 : 3
  const sourceComponentId =
    typeof comp?.source_component_id === "string" ? comp.source_component_id : ""
  const source = getSourceComponent(ctx, sourceComponentId)
  // 位号必须取「本实例自己」的 refdes，而非封装分组标题（bp.title 是封装名）。
  // 回退顺序：source.name → bp.title → source_component_id。
  const designator = String(source?.name ?? bp?.title ?? sourceComponentId)
  const footprintUuid = String(bp?.uuid ?? "")
  // 无对应 device 时 Device 留空并告警；Footprint 仍填真实 uuid。
  const hasDevice =
    sourceComponentId.length > 0 &&
    typeof ctx?.devices?.has === "function" &&
    ctx.devices.has(sourceComponentId)
  if (!hasDevice) {
    warn(
      ctx,
      `pcb_component ${compEid} 无对应 device（source_component_id=${sourceComponentId || "缺失"}），Device 属性留空`,
      "missing-source-component",
    )
  }
  const deviceUuid = hasDevice ? uuidFor(ctx, "device", sourceComponentId) : ""

  rows.push(
    makeAttrRow({
      id: eid(),
      parentId: compEid,
      layer: attrLayer,
      x: null,
      y: null,
      key: "Footprint",
      value: footprintUuid,
      showKey: 0,
      showValue: 0,
    }),
  )
  rows.push(
    makeAttrRow({
      id: eid(),
      parentId: compEid,
      layer: attrLayer,
      x,
      y,
      key: "Designator",
      value: designator,
      showKey: 0,
      showValue: 1,
    }),
  )
  rows.push(
    makeAttrRow({
      id: eid(),
      parentId: compEid,
      layer: attrLayer,
      x: null,
      y: null,
      key: "Device",
      value: deviceUuid,
      showKey: 0,
      showValue: 0,
    }),
  )

  for (const pad of bp?.pads ?? []) {
    const net = netNameForPcbPort(ctx, pad?.pcbPortId)
    rows.push(["PAD_NET", compEid, String(pad?.padNumber ?? ""), net, pad?.id])
  }

  return rows
}
