/**
 * 构建 `.epcb`（PCB）文档。
 *
 * 单位：mil（`toPcbLength(mm) = mm / 0.0254`）；角度逆时针为正；布尔 1/0。
 * 元件实例不内嵌 PAD，焊盘来自同 uuid 的 `FOOTPRINT/*.efoo`。
 */
import type { ConversionContext, PcbDocResult } from "../types"
import { JsonLinesWriter } from "../writer"
import {
  buildBoardOutlineRow,
  elementsByType,
  getFirstBoard,
  getStandaloneHoles,
  getStandalonePads,
  netNameForPcbPort,
  padLayerId,
  popPcbUnits,
  pushPcbUnitsFor,
  resolveFootprintForPcbComponent,
  round6,
  toMil,
  uuidFor,
  warn,
} from "./board"
import { pcbLayerLines, tryLayerIdForCircuitLayer } from "./layers"
import { buildComponentRows, type EidGenerator } from "./components"
import { buildTraceRows, buildViaRows } from "./traces"
import { buildSilkscreenRows } from "./silkscreen"
import {
  buildPcbPadRow,
  pcbHoleGeometry,
  platedHoleGeometry,
  smtPadGeometry,
  type EproPadBlueprint,
} from "./pads"

function createEidGenerator(start = 0): EidGenerator {
  let counter = start
  return () => {
    const id = `e${counter}`
    counter += 1
    return id
  }
}

/** 从上下文读取集合；优先 core 提供的索引，缺失时回退空数组。 */
function pcbCollection(ctx: any, key: string, fallback: any[]): any[] {
  const value = ctx?.pcb?.[key]
  if (Array.isArray(value)) return value
  return fallback
}

/**
 * 收集文档实际引用到的铜层号，用于**按需**补写内层 `LAYER` 声明。
 *
 * 仅走线（wire / through_pad）会引用内层编号；未引用内层的 2/4 层板
 * 结果集合为空，`pcbLayerLines` 输出与静态骨架逐元素一致。
 */
function usedCopperLayerIds(c: any): Set<number> {
  const ids = new Set<number>()
  for (const trace of pcbCollection(c, "traces", [])) {
    const route = Array.isArray(trace?.route) ? trace.route : []
    for (const point of route) {
      if (!point) continue
      if (point.route_type === "wire") {
        const id = tryLayerIdForCircuitLayer(point.layer)
        if (id !== undefined) ids.add(id)
      } else if (point.route_type === "through_pad") {
        for (const value of [point.start_layer, point.end_layer]) {
          const id = tryLayerIdForCircuitLayer(value)
          if (id !== undefined) ids.add(id)
        }
      }
    }
  }
  return ids
}

/**
 * 构建 `.epcb` 文档。
 *
 * 入口以 `pushPcbUnitsFor`/`popPcbUnits` 作用域化 `units.pcbPerMm`：正常返回、
 * 提前 `return null`、或抛错都会恢复进入前的换算比例，避免按次选项泄漏。
 */
export function buildPcbDoc(ctx: ConversionContext): PcbDocResult | null {
  const previousUnits = pushPcbUnitsFor(ctx)
  try {
    return buildPcbDocInner(ctx)
  } finally {
    popPcbUnits(previousUnits)
  }
}

function buildPcbDocInner(ctx: ConversionContext): PcbDocResult | null {
  const c = ctx as any
  const board = getFirstBoard(c)
  const components =
    c?.pcb?.componentById instanceof Map
      ? Array.from(c.pcb.componentById.values())
      : elementsByType(c, "pcb_component")
  const standaloneHoles = getStandaloneHoles(c)
  const standalonePads = getStandalonePads(c)
  // 板级丝印：仅无元件归属的图元；有归属者由封装（`.efoo`）输出，避免重复。
  // 经类型化字段读取，避免 `any` 边界掩盖契约缺口。
  const boardSilkscreen = Array.isArray(ctx.pcb.boardSilkscreen)
    ? ctx.pcb.boardSilkscreen
    : pcbCollection(c, "silkscreen", [])
  if (
    !board &&
    components.length === 0 &&
    standaloneHoles.length === 0 &&
    standalonePads.length === 0
  ) {
    return null
  }

  const title = String(c?.options?.title ?? "PCB")
  const editorVersion = String(c?.options?.editorVersion ?? "2.2.48.10")
  const docId = uuidFor(c, "pcb", title)

  const writer = new JsonLinesWriter(["DOCTYPE", "PCB", "1.8"], {
    editorVersion,
    importFlag: 0,
  })

  writer.push(["CANVAS", 0, 0, "mil", 5, 5, 5, 5, 1, 1, 2, 0, 5])
  // 仅补写被引用的内层声明，未用内层的 2/4 层板输出不变。
  for (const layerLine of pcbLayerLines(usedCopperLayerIds(c))) {
    writer.push(layerLine)
  }

  const eid = createEidGenerator()

  // 板内挖槽（pcb_cutout）：未找到经规范或官方样例**确证**的 2D 板内挖槽表达方式，
  // 故仅收集并告警，不猜测几何、也不静默丢弃。
  //
  // 已排查的候选（均未确证）：
  //   ① layer-11 内环 POLY —— `polygon-system/poly.md:19` 明确 POLY 第 7 字段为
  //      「单多边形」（不能直接带洞）；只有 `fill.md:18` 的「复杂多边形」支持带洞，
  //      而板框用的是 POLY。
  //   ② 无铜 PAD + 同形孔 —— 本仓库 `pcb_hole` 已是非金属化孔先例
  //      （见下方 standaloneHoles 分支），但多边形/路径槽无法用 PAD 孔形状表达。
  //   ③ `SHELL_ENTITY(SLOT)` —— 见 `.refs/format-skill/` 对象格式文档（非 `.epcb` 行格式）。
  //   ④ 官方 PRIMITIVE 清单含 `"SLOTREGION"`：`21bf3cb7…epcb:142` 与
  //      `de0a8…epcb:151` 均为 `["PRIMITIVE","SLOTREGION",1,1]`，但两样本**零使用行**。
  // 查证范围：`.refs/v2spec/docs/zh/pcb/{primitives/index.md,pcb-file.md,primitives/pad.md,
  //   primitives/{line,via,attr,string}.md, polygon-system/*.md}`、
  //   `.refs/v2spec/examples/**/.epcb`、`.refs/format-skill/**`、`.refs/cj-to-easyeda-std/**`。
  // 关键词：cutout / slot / SLOT / 挖槽 / 槽孔 / SLOTREGION / SHELLCUT / OUTLINE。
  // 待 EDA 实测确证后单独开单实现。
  const cutouts = Array.isArray(ctx.pcb.cutouts) ? ctx.pcb.cutouts : []
  if (cutouts.length > 0) {
    const ids = cutouts
      .map((cut: any) => String(cut?.pcb_cutout_id ?? cut?.shape ?? ""))
      .join(", ")
    warn(
      c,
      `pcb_cutout 未找到经规范/官方样例确证的 2D 板内挖槽表达方式，暂不写出：已跳过 ${cutouts.length} 个（${ids}）`,
      "unsupported-element",
    )
  }

  // 板框：layer 11 闭合 POLY。
  if (board) writer.push(buildBoardOutlineRow(board, eid()))

  // 元件实例 + 属性 + 焊盘网络映射。
  // 无 source_component_id 的元件同样输出 COMPONENT，封装经统一访问器解析。
  for (const component of components) {
    const blueprint = resolveFootprintForPcbComponent(c, component)
    const componentEid = eid()
    for (const row of buildComponentRows(c, component, blueprint, componentEid, eid)) {
      writer.push(row)
    }
  }

  // 走线。
  const traces = pcbCollection(c, "traces", [])
  for (const row of buildTraceRows(c, traces, eid)) {
    writer.push(row)
  }

  // 过孔：pcb_via 为权威来源；route 内缺失对应 pcb_via 的 via 点回退补齐。
  const vias = pcbCollection(c, "vias", [])
  for (const row of buildViaRows(c, vias, traces, eid)) {
    writer.push(row)
  }

  // 丝印（板级）。
  for (const row of buildSilkscreenRows(c, boardSilkscreen, eid)) {
    writer.push(row)
  }

  // 独立孔（无归属组件或归属组件不存在）：pcb_hole 非金属化、pcb_plated_hole 金属化。
  for (const hole of standaloneHoles) {
    const isPlatedHole = hole?.type === "pcb_plated_hole"
    const geometry = isPlatedHole ? platedHoleGeometry(hole) : pcbHoleGeometry(hole)
    // 独立孔的网名：pcb_plated_hole / pcb_hole 均无 source_trace_id 等字段，
    // 只能经 pcb_port 解析（`netNameForPcbVia` 对其恒为 ""，故不再回退）。
    const holeNet = isPlatedHole ? netNameForPcbPort(c, hole?.pcb_port_id) : ""
    if (isPlatedHole && holeNet === "") {
      warn(
        c,
        `独立金属化孔 ${String(hole?.pcb_plated_hole_id ?? "")} 无法确定网络，PAD 网络字段留空`,
        "orphan-pad",
      )
    }
    const pad: EproPadBlueprint = {
      id: eid(),
      net: holeNet,
      padNumber: "",
      layer: 12,
      x: toMil(Number(hole?.x ?? 0)),
      y: toMil(Number(hole?.y ?? 0)),
      rotation: 0,
      padShape: geometry.padShape,
      hole: geometry.hole,
      plated: isPlatedHole ? 1 : 0,
      specialPads: [],
      holeOffsetX: 0,
      holeOffsetY: 0,
      holeRotation: 0,
      padType: 0,
      locked: 0,
      width: geometry.width,
      height: geometry.height,
    }
    writer.push(buildPcbPadRow(pad))
  }

  // 孤儿 SMT 焊盘：作为独立 PAD 写入，保证几何不丢。
  for (const smtPad of standalonePads) {
    const geometry = smtPadGeometry(smtPad)
    // 独立/孤儿焊盘只能靠 PAD 第 4 字段绑网；解析不出时明确告警，不静默丢网。
    // `pcb_smtpad` 无 source_trace_id 等字段，只能经 pcb_port 解析。
    const net = netNameForPcbPort(c, smtPad?.pcb_port_id)
    if (net === "") {
      warn(
        c,
        `独立焊盘 ${String(smtPad?.pcb_smtpad_id ?? "")} 无法确定网络，PAD 网络字段留空`,
        "orphan-pad",
      )
    }
    const pad: EproPadBlueprint = {
      id: eid(),
      net,
      pcbPortId: smtPad?.pcb_port_id,
      padNumber: String(smtPad?.pad_number ?? smtPad?.port_hints?.[0] ?? ""),
      layer: padLayerId(smtPad?.layer),
      x: toMil(geometry.center.x),
      y: toMil(geometry.center.y),
      rotation: round6(geometry.rotation),
      padShape: geometry.padShape,
      hole: null,
      plated: 1,
      specialPads: [],
      holeOffsetX: 0,
      holeOffsetY: 0,
      holeRotation: 0,
      padType: 0,
      locked: 0,
      width: geometry.width,
      height: geometry.height,
    }
    writer.push(buildPcbPadRow(pad))
  }

  return { docId, epcb: writer.toString() }
}
