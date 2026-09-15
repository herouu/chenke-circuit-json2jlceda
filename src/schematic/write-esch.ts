import { refdesFor } from "../analysis/source-index"
import { synthesizeSymbol } from "../symbol/synthesize-symbol"
import type {
  ConversionContext,
  EproPrimitive,
  SchematicDocResult,
} from "../types"
import { round6, transformPoint } from "../units"
import { JsonLinesWriter } from "../writer"
import { getSchematicLayout } from "./layout"

interface PointLike {
  x: number
  y: number
}

interface TraceEdgeLike {
  from: PointLike
  to: PointLike
}

interface TraceLike {
  schematic_trace_id: string
  source_trace_id?: string
  edges?: TraceEdgeLike[]
}

interface NetLabelLike {
  schematic_net_label_id?: string
}

/** 位号与品名相对符号实际范围的间距（SCH 单位）。 */
const DESIGNATOR_GAP = 6
const NAME_GAP = 6

/**
 * 官方 `1.esch` 第 3–41 行（A4 图框 COMPONENT 及其 ATTR）原文，
 * 每行一条数组 JSON。
 */
const A4_FRAME_JSON: string = "[\"COMPONENT\",\"e1\",\"\",0,0,0,0,{},0]\n[\"FONTSTYLE\",\"st1\",null,null,null,20,null,null,null,null,1,1]\n[\"ATTR\",\"e35\",\"e1\",\"Symbol\",\"6644fff3ec4746afad9f4bc9616a8eee\",null,null,null,null,null,\"st1\",0]\n[\"ATTR\",\"e3\",\"e1\",\"Company\",\"嘉立创EDA\",null,null,null,null,null,\"st1\",0]\n[\"FONTSTYLE\",\"st2\",null,null,null,15,null,null,null,null,1,0]\n[\"ATTR\",\"e4\",\"e1\",\"Drawed\",\"\",null,null,null,null,null,\"st2\",0]\n[\"ATTR\",\"e5\",\"e1\",\"Reviewed\",\"\",null,null,null,null,null,\"st2\",0]\n[\"ATTR\",\"e6\",\"e1\",\"Part Number\",\"\",null,null,null,null,null,\"st2\",0]\n[\"FONTSTYLE\",\"st3\",null,null,null,15,null,null,null,null,1,1]\n[\"ATTR\",\"e7\",\"e1\",\"Version\",\"V1.0\",null,null,null,null,null,\"st3\",0]\n[\"ATTR\",\"e8\",\"e1\",\"Page Size\",\"A4\",null,null,null,null,null,\"st3\",0]\n[\"ATTR\",\"e9\",\"e1\",\"@Project Name\",\"\",null,null,null,null,null,\"st1\",0]\n[\"ATTR\",\"e10\",\"e1\",\"@Page Count\",\"\",null,null,null,null,null,\"st3\",0]\n[\"ATTR\",\"e11\",\"e1\",\"@Update Date\",\"\",null,null,null,null,null,\"st2\",0]\n[\"ATTR\",\"e12\",\"e1\",\"@Create Date\",\"\",null,null,null,null,null,\"st2\",0]\n[\"ATTR\",\"e13\",\"e1\",\"@Schematic Name\",\"\",null,null,null,null,null,\"st1\",0]\n[\"ATTR\",\"e14\",\"e1\",\"@Page No\",\"\",null,null,null,null,null,\"st3\",0]\n[\"ATTR\",\"e15\",\"e1\",\"@Page Name\",\"\",null,null,null,null,null,\"st3\",0]\n[\"FONTSTYLE\",\"st4\",null,null,null,null,null,null,null,null,null,null]\n[\"ATTR\",\"e16\",\"e1\",\"@Board Name\",\"\",0,0,null,null,0,\"st4\",0]\n[\"ATTR\",\"e17\",\"e1\",\"@Create Time\",\"\",0,0,null,null,0,\"st4\",0]\n[\"ATTR\",\"e18\",\"e1\",\"@Update Time\",\"\",0,0,null,null,0,\"st4\",0]\n[\"ATTR\",\"e19\",\"e1\",\"@Assembly Variant\",\"\",0,0,null,null,0,\"st4\",0]\n[\"ATTR\",\"e20\",\"e1\",\"Border\",\"1\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e21\",\"e1\",\"Title Block Position\",\"3\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e22\",\"e1\",\"Size\",\"A4\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e23\",\"e1\",\"Width\",\"1170\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e24\",\"e1\",\"Height\",\"825\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e25\",\"e1\",\"Region Start\",\"1\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e26\",\"e1\",\"X Region Count\",\"6\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e27\",\"e1\",\"Y Region Count\",\"4\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e28\",\"e1\",\"Blade Width\",\"10\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e29\",\"e1\",\"Color\",\"\",0,0,null,null,0,\"st4\",0]\n[\"ATTR\",\"e30\",\"e1\",\"Title Block\",\"1\",null,null,null,null,null,\"st4\",0]\n[\"ATTR\",\"e31\",\"e1\",\"Name\",\"\",0,0,null,null,0,\"st4\",0]\n[\"ATTR\",\"e32\",\"e1\",\"Footprint\",\"\",0,0,null,null,0,\"st4\",0]\n[\"ATTR\",\"e33\",\"e1\",\"Description\",\"\",0,0,null,null,0,\"st4\",0]\n[\"FONTSTYLE\",\"st5\",null,null,null,\"8\",null,null,null,null,null,null]\n[\"ATTR\",\"e34\",\"e1\",\"Device\",\"9bb222e758404bf989041750f60ffeef\",0,0,null,null,0,\"st5\",0]"

const A4_FRAME_LINES: EproPrimitive[] = A4_FRAME_JSON.split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as EproPrimitive)

/** 本工程图框板名（与 project.json 的 `boards.Board1` 保持一致）。 */
const BOARD_NAME = "Board1"

/**
 * 构造本工程的 A4 图框 ATTR 行：模板里由运行时输入决定的属性在此覆盖为真实值，
 * 其余（Symbol/Company/Version/Page Size/Border/Width/Height/区域排版等）为图框固有常量。
 *
 * 日期与时间无输入来源，统一留空，保证确定性输出（不写样例日期）。
 */
function buildA4FrameLines(ctx: ConversionContext): EproPrimitive[] {
  const title = String(ctx.options.title ?? "")
  const sheetName = String(ctx.options.sheetName ?? "")
  const overrides: Record<string, string> = {
    "@Project Name": title,
    // 图名 = 工程标题（与 project.json 的 schematics[docId].name 一致）。
    "@Schematic Name": title,
    "@Page Name": sheetName,
    "@Page No": "1",
    "@Page Count": "1",
    "@Board Name": BOARD_NAME,
    "@Create Date": "",
    "@Update Date": "",
    "@Create Time": "",
    "@Update Time": "",
  }
  return A4_FRAME_LINES.map((line) => {
    if (line[0] !== "ATTR") return line
    const key = line[3]
    if (typeof key !== "string" || !(key in overrides)) return line
    const next = line.slice()
    next[4] = overrides[key]
    return next
  })
}

function samePoint(a: PointLike, b: PointLike): boolean {
  return a.x === b.x && a.y === b.y
}

/** 将首尾相接的边合并为若干折线。 */
function buildPolylines(edges: readonly TraceEdgeLike[]): PointLike[][] {
  const lines: PointLike[][] = []
  for (const edge of edges) {
    const { from, to } = edge
    if (!from || !to) continue
    let appended = false
    for (const line of lines) {
      const first = line[0]!
      const last = line[line.length - 1]!
      if (samePoint(last, from)) {
        line.push(to)
        appended = true
        break
      }
      if (samePoint(last, to)) {
        line.push(from)
        appended = true
        break
      }
      if (samePoint(first, from)) {
        line.unshift(to)
        appended = true
        break
      }
      if (samePoint(first, to)) {
        line.unshift(from)
        appended = true
        break
      }
    }
    if (!appended) lines.push([from, to])
  }
  return lines.filter((line) => line.length >= 2)
}

/**
 * 生成原理图页 `.esch` 文档。无任何 schematic_component 时返回 `null`。
 */
export function buildSchematicDoc(
  ctx: ConversionContext,
): SchematicDocResult | null {
  const schematicComponents = Array.from(ctx.schematic.componentById.values())
  if (schematicComponents.length === 0) return null

  const title = ctx.options.title
  const docId = ctx.uuid.uuid("schematic", title)
  const sheetUuid = ctx.uuid.uuid("sheet", `${docId}:1`)

  const writer = new JsonLinesWriter(["DOCTYPE", "SCH", "1.1"], {
    originX: 0,
    originY: 0,
    version: "2",
    maxId: 0,
  })

  // 图框内已有编号全部登记，后续 `ctx.ids.next()` 不会与其冲突。
  for (const line of A4_FRAME_LINES) {
    const id = line[1]
    if (typeof id === "string" && /^e\d+$/.test(id)) ctx.ids.reserve(id)
  }
  for (const line of buildA4FrameLines(ctx)) writer.push(line)

  // 生成图元需要的额外样式（图框块已内联 st1–st5）。
  writer.push([
    "FONTSTYLE",
    "st6",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    2,
    0,
  ])
  writer.push(["LINESTYLE", "st9", null, null, null, null, null])

  const layout = getSchematicLayout(ctx)
  const transform = layout

  // 索引层暴露的「不得静默丢弃」名单（`SchematicIndex` 的契约字段）。
  // 诊断归属：留在消费点 `write-esch.ts`（与方案 A 一致），`context.ts` 不接入
  // 这两个列表，避免同一元件对同一问题重复告警。
  for (const key of ctx.schematic.unindexedSchematicComponentIds) {
    ctx.warn({
      code: "missing-component-id",
      severity: "warning",
      message: `schematic_component 缺少 source_component_id 与 schematic_component_id，已合成稳定索引键 ${key} 并保留`,
      circuitElementType: "schematic_component",
      circuitElementId: key,
    })
  }
  for (const key of ctx.schematic.duplicateSchematicComponentKeys) {
    ctx.warn({
      code: "duplicate-id",
      severity: "warning",
      message: `schematic_component 索引键 ${key} 与已有元件冲突，保留首个元件，其余已跳过`,
      circuitElementType: "schematic_component",
      circuitElementId: key,
    })
  }

  for (const [componentKey, schematicComponent] of ctx.schematic.componentById) {
    // 以索引键为身份贯穿绘制 / 符号 / 器件查询：正常元件为 source_component_id，
    // 缺 source_component_id 的元件为 schematic_component_id 回退键。
    const sourceComponentId = schematicComponent.source_component_id
    const schematicComponentId = schematicComponent.schematic_component_id
    const hasSourceComponentId =
      typeof sourceComponentId === "string" && sourceComponentId.length > 0
    const hasSchematicComponentId =
      typeof schematicComponentId === "string" && schematicComponentId.length > 0
    // 两个 id 都缺失的元件已由上面的 unindexed 名单统一发诊断，这里避免重复。
    if (!hasSourceComponentId && hasSchematicComponentId) {
      ctx.warn({
        code: "missing-component-id",
        severity: "warning",
        message: `schematic_component ${schematicComponentId} 缺少 source_component_id，已用 schematic_component_id ${componentKey} 作为索引键回退并保留`,
        circuitElementType: "schematic_component",
        circuitElementId: schematicComponentId,
      })
    }

    const blueprint = synthesizeSymbol(ctx, componentKey, layout)
    const center = transformPoint(
      schematicComponent.center ?? { x: 0, y: 0 },
      transform,
    )
    const componentId = ctx.ids.next()
    writer.push([
      "COMPONENT",
      componentId,
      blueprint.partName,
      round6(center.x),
      round6(center.y),
      0,
      0,
      {},
      0,
    ])

    const sourceComponent = ctx.source.componentById.get(componentKey)
    // 位号与 Device 共用同一口径，保证非空且互不冲突。
    const designator = refdesFor(componentKey, sourceComponent)
    // 位号置于符号上方左侧，品名置于符号下方左侧，避免压在符号上。
    const anchorX = round6(center.x + blueprint.bbox.minX)
    writer.push([
      "ATTR",
      ctx.ids.next(),
      componentId,
      "Designator",
      designator,
      null,
      1,
      anchorX,
      round6(center.y + blueprint.bbox.maxY + DESIGNATOR_GAP),
      null,
      "st4",
      0,
    ])
    writer.push([
      "ATTR",
      ctx.ids.next(),
      componentId,
      "Name",
      null,
      null,
      1,
      anchorX,
      round6(center.y + blueprint.bbox.minY - NAME_GAP),
      null,
      "st4",
      0,
    ])

    const device = ctx.devices.get(componentKey)
    if (device) {
      writer.push([
        "ATTR",
        ctx.ids.next(),
        componentId,
        "Device",
        device.uuid,
        0,
        0,
        null,
        null,
        0,
        "st5",
        0,
      ])
    }
  }

  for (const trace of ctx.schematic.traces as TraceLike[]) {
    const polylines = buildPolylines(trace.edges ?? [])
    if (polylines.length === 0) continue

    const points = polylines.map((line) =>
      line.flatMap((point) => {
        const mapped = transformPoint(point, transform)
        return [round6(mapped.x), round6(mapped.y)]
      }),
    )

    const wireId = ctx.ids.next()
    writer.push(["WIRE", wireId, points, "st9", 0])

    const netName = trace.source_trace_id
      ? ctx.source.netNameForSourceTrace(trace.source_trace_id)
      : undefined
    if (netName) {
      const firstLine = polylines[0]!
      const anchor = firstLine[Math.floor(firstLine.length / 2)]!
      const anchorPoint = transformPoint(anchor, transform)
      writer.push([
        "ATTR",
        ctx.ids.next(),
        wireId,
        "NET",
        netName,
        0,
        0,
        round6(anchorPoint.x),
        round6(anchorPoint.y),
        0,
        "st4",
        0,
      ])
    }
  }

  for (const netLabel of ctx.schematic.netLabels as NetLabelLike[]) {
    ctx.warn({
      code: "unsupported-element",
      severity: "warning",
      message: `schematic_net_label ${netLabel.schematic_net_label_id ?? "?"} is not supported yet; skipped.`,
      circuitElementType: "schematic_net_label",
      circuitElementId: netLabel.schematic_net_label_id ?? "",
    })
  }

  // 回填 HEAD.maxId 为文档内最大数字 id。
  writer.setHeadValue("maxId", writer.maxNumericId)
  return { docId, sheetUuid, esch: writer.toString() }
}
