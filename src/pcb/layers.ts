/**
 * PCB 层号映射与静态层骨架。
 *
 * 关键事实（由官方 EasyEDA Pro V2 示例实测裁决）：
 * - PCB / FOOTPRINT 文档中的长度单位是 mil（0.001 inch），毫米转 mil 由 `toPcbLength` 负责。
 * - 层号：1=TOP 铜，2=BOTTOM 铜，3=TOP_SILK，4=BOT_SILK，5/6=阻焊，7/8=锡膏，
 *   11=OUTLINE 板框，12=MULTI 多层（通孔），15..46=内层，47=HOLE，48=COMPONENT_SHAPE，
 *   49=COMPONENT_MARKING，50=PIN_SOLDERING。
 */

/** 从任意入参中推断顶层铜层号；出现 bottom 时返回 2，否则默认 1。 */
export function topCopperLayerIndex(...args: any[]): number {
  for (const arg of args) {
    const name = typeof arg === "string" ? arg : (arg as any)?.name
    if (name === "bottom") return 2
  }
  return 1
}

/** 将 circuit-json 的层引用映射为 EPro 的铜层号。 */
export function layerIdForCircuitLayer(layer: string | undefined): 1 | 2 | number {
  const name = typeof layer === "string" ? layer : (layer as any)?.name
  if (name === "bottom") return 2
  if (name === "top") return 1
  // inner1 -> 15, inner2 -> 16 ...
  const match = /^inner(\d+)$/.exec(String(name ?? ""))
  if (match && match[1]) return 14 + Number(match[1])
  return 1
}

/**
 * 可失败的层解析：缺失、非字符串、或无法识别为已知层时返回 `undefined`。
 *
 * 供「必须校验后再使用」的调用点（如 `pcb_trace` 的 wire / through_pad 层）
 * 使用；`layerIdForCircuitLayer` 的默认回退语义保持不动，避免波及既有调用点。
 */
export function tryLayerIdForCircuitLayer(layer: unknown): number | undefined {
  const name = typeof layer === "string" ? layer : (layer as any)?.name
  if (typeof name !== "string" || name.length === 0) return undefined
  if (name === "top") return 1
  if (name === "bottom") return 2
  const match = /^inner(\d+)$/.exec(name)
  if (match && match[1]) return 14 + Number(match[1])
  return undefined
}

/** 顶层/底层丝印层号。 */
export function silkscreenLayerId(layer: string | undefined): 3 | 4 {
  const name = typeof layer === "string" ? layer : (layer as any)?.name
  return name === "bottom" ? 4 : 3
}

/** 是否底层。 */
export function isBottomLayer(layer: string | undefined): boolean {
  const name = typeof layer === "string" ? layer : (layer as any)?.name
  return name === "bottom"
}

/**
 * FOOTPRINT (.efoo) 的静态层骨架，逐行照抄官方 R0603 示例
 * `7e30682893f74f5f9297a8d0e547deba.efoo` 的第 2..20 行（共 19 条 LAYER）。
 */
export const EFOO_LAYER_LINES: unknown[][] = [
  ["LAYER", 1, "TOP", "Top Layer", 3, "#FF0000", 1, "#7F0000", 1],
  ["LAYER", 2, "BOTTOM", "Bottom Layer", 3, "#0000FF", 1, "#00007F", 1],
  ["LAYER", 3, "TOP_SILK", "Top Silkscreen Layer", 3, "#FFCC00", 1, "#7F6600", 1],
  ["LAYER", 4, "BOT_SILK", "Bottom Silkscreen Layer", 3, "#66CC33", 1, "#336619", 1],
  ["LAYER", 7, "TOP_PASTE_MASK", "Top Paste Mask Layer", 3, "#808080", 1, "#404040", 1],
  ["LAYER", 8, "BOT_PASTE_MASK", "Bottom Paste Mask Layer", 3, "#800000", 1, "#400000", 1],
  ["LAYER", 5, "TOP_SOLDER_MASK", "Top Solder Mask Layer", 3, "#800080", 1, "#400040", 1],
  ["LAYER", 6, "BOT_SOLDER_MASK", "Bottom Solder Mask Layer", 3, "#AA00FF", 1, "#55007F", 1],
  ["LAYER", 13, "DOCUMENT", "Document Layer", 3, "#FFFFFF", 1, "#7F7F7F", 1],
  ["LAYER", 11, "OUTLINE", "Board Outline Layer", 3, "#FF00FF", 1, "#7F007F", 1],
  ["LAYER", 12, "MULTI", "Multi-Layer", 3, "#C0C0C0", 1, "#606060", 1],
  ["LAYER", 9, "TOP_ASSEMBLY", "Top Assembly Layer", 3, "#33CC99", 1, "#19664C", 1],
  ["LAYER", 10, "BOT_ASSEMBLY", "Bottom Assembly Layer", 3, "#5555FF", 1, "#2A2A7F", 1],
  ["LAYER", 14, "MECHANICAL", "Mechanical Layer", 3, "#F022F0", 1, "#781178", 1],
  ["LAYER", 52, "COMPONENT_MODEL", "Component Model Layer", 3, "#FFFFFF", 1, "#7F7F7F", 1],
  ["LAYER", 48, "COMPONENT_SHAPE", "Component Shape Layer", 3, "#00CCCC", 1, "#006666", 1],
  ["LAYER", 51, "PIN_FLOATING", "Pin Floating Layer", 3, "#FF99FF", 1, "#7F4C7F", 1],
  ["LAYER", 49, "COMPONENT_MARKING", "Component Marking Layer", 3, "#66FFCC", 1, "#337F66", 1],
  ["LAYER", 50, "PIN_SOLDERING", "Pin Soldering Layer", 3, "#CC9999", 1, "#664C4C", 1],
]

/**
 * PCB (.epcb) 的静态骨架。取自官方示例 `21bf3cb7badf4afaad0dd41b43ce6d3b.epcb`
 * 的第 4..176 行，按任务允许保留必要子集（LAYER 1..16/47..52、LAYER_PHYS、
 * ACTIVE_LAYER、SILK_OPTS、PREFERENCE）。颜色值一律照抄官方。
 */
export const PCB_LAYER_LINES: unknown[][] = [
  ["LAYER", 1, "TOP", "Top Layer", 3, "#ff0000", 1, "#7f0000", 0.5],
  ["LAYER", 2, "BOTTOM", "Bottom Layer", 3, "#0000ff", 1, "#00007f", 0.5],
  ["LAYER", 3, "TOP_SILK", "Top Silkscreen Layer", 3, "#ffcc00", 1, "#7f6600", 0.5],
  ["LAYER", 4, "BOT_SILK", "Bottom Silkscreen Layer", 3, "#66cc33", 1, "#336619", 0.5],
  ["LAYER", 5, "TOP_SOLDER_MASK", "Top Solder Mask Layer", 3, "#800080", 0.7, "#400040", 0.5],
  ["LAYER", 6, "BOT_SOLDER_MASK", "Bottom Solder Mask Layer", 3, "#aa00ff", 0.7, "#55007f", 0.5],
  ["LAYER", 7, "TOP_PASTE_MASK", "Top Paste Mask Layer", 3, "#808080", 1, "#404040", 0.5],
  ["LAYER", 8, "BOT_PASTE_MASK", "Bottom Paste Mask Layer", 3, "#800000", 1, "#400000", 0.5],
  ["LAYER", 9, "TOP_ASSEMBLY", "Top Assembly Layer", 3, "#33cc99", 1, "#19664c", 0.5],
  ["LAYER", 10, "BOT_ASSEMBLY", "Bottom Assembly Layer", 3, "#5555ff", 1, "#2a2a7f", 0.5],
  ["LAYER", 11, "OUTLINE", "Board Outline Layer", 3, "#ff00ff", 1, "#7f007f", 0.5],
  ["LAYER", 12, "MULTI", "Multi-Layer", 3, "#c0c0c0", 1, "#606060", 0.5],
  ["LAYER", 13, "DOCUMENT", "Document Layer", 3, "#ffffff", 1, "#7f7f7f", 0.5],
  ["LAYER", 14, "MECHANICAL", "Mechanical Layer", 3, "#f022f0", 1, "#781178", 0.5],
  ["LAYER", 15, "SIGNAL", "Inner1", 3, "#999966", 1, "#4c4c33", 0.5],
  ["LAYER", 16, "PLANE", "Inner2", 3, "#008000", 1, "#004000", 0.5],
  ["LAYER", 47, "HOLE", "Hole Layer", 3, "#222222", 1, "#111111", 0.5],
  ["LAYER", 48, "COMPONENT_SHAPE", "Component Shape Layer", 1, "#00cccc", 1, "#006666", 0.5],
  ["LAYER", 49, "COMPONENT_MARKING", "Component Marking Layer", 1, "#66ffcc", 1, "#337f66", 0.5],
  ["LAYER", 50, "PIN_SOLDERING", "Pin Soldering Layer", 1, "#cc9999", 1, "#664c4c", 0.5],
  ["LAYER", 51, "PIN_FLOATING", "Pin Floating Layer", 1, "#ff99ff", 1, "#7f4c7f", 0.5],
  ["LAYER", 52, "COMPONENT_MODEL", "Component Model Layer", 0, "#ffffff", 1, "#7f7f7f", 0.5],
  // 物理堆叠：顶层铜 -> 介质 -> 内层 -> 介质 -> 底层铜。数值照抄官方 4 层板示例。
  ["LAYER_PHYS", 3, "", 0, 0, 0, 1],
  ["LAYER_PHYS", 7, "", 0, 0, 0, 1],
  ["LAYER_PHYS", 5, "", 0.394, 3.3, 0.02, 1],
  ["LAYER_PHYS", 1, "", 1.378, 0, 0, 1],
  ["LAYER_PHYS", 361, "PP", 18.898, 4.5, 0, 1],
  ["LAYER_PHYS", 15, "", 1.378, 0, 0, 1],
  ["LAYER_PHYS", 362, "FR4", 18.898, 4.5, 0, 1],
  ["LAYER_PHYS", 16, "", 1.378, 0, 0, 1],
  ["LAYER_PHYS", 363, "PP", 18.898, 4.5, 0, 1],
  ["LAYER_PHYS", 2, "", 1.378, 0, 0, 1],
  ["LAYER_PHYS", 6, "", 0.394, 3.3, 0.02, 1],
  ["LAYER_PHYS", 8, "", 0, 0, 0, 1],
  ["LAYER_PHYS", 4, "", 0, 0, 0, 1],
  ["ACTIVE_LAYER", 1],
  ["SILK_OPTS", 3, "#000000", "#FFFFFF"],
  ["SILK_OPTS", 4, "#000000", "#FFFFFF"],
  [
    "PREFERENCE",
    0,
    10,
    0,
    12.0078,
    24.0158,
    1,
    2,
    "L45",
    1,
    0,
    0,
    1,
    "",
    0,
    3,
    "OPTIMIZA_OPEN",
    0,
    "OPTIMIZA_WEAK",
    true,
    true,
  ],
]

/**
 * 官方 `.epcb` 中内层 `Inner3..Inner32`（层号 17..46）的 `LAYER` 声明，
 * 逐行照抄官方示例 `21bf3cb7badf4afaad0dd41b43ce6d3b.epcb`。
 *
 * 仅在文档实际引用到某内层时才补写对应声明（见 `pcbLayerLines`），
 * 避免无条件铺满 17..46 而改变 2/4 层板（如测试夹具）的输出。
 */
export const PCB_INNER_LAYER_LINES: Record<number, unknown[]> = {
  17: ["LAYER", 17, "SIGNAL", "Inner3", 0, "#00ff00", 1, "#007f00", 0.5],
  18: ["LAYER", 18, "SIGNAL", "Inner4", 0, "#bc8e00", 1, "#5e4700", 0.5],
  19: ["LAYER", 19, "SIGNAL", "Inner5", 0, "#70dbfa", 1, "#386d7d", 0.5],
  20: ["LAYER", 20, "SIGNAL", "Inner6", 0, "#00cc66", 1, "#006633", 0.5],
  21: ["LAYER", 21, "SIGNAL", "Inner7", 0, "#9966ff", 1, "#4c337f", 0.5],
  22: ["LAYER", 22, "SIGNAL", "Inner8", 0, "#800080", 1, "#400040", 0.5],
  23: ["LAYER", 23, "SIGNAL", "Inner9", 0, "#008080", 1, "#004040", 0.5],
  24: ["LAYER", 24, "SIGNAL", "Inner10", 0, "#15935f", 1, "#a.492f", 0.5],
  25: ["LAYER", 25, "SIGNAL", "Inner11", 0, "#000080", 1, "#000040", 0.5],
  26: ["LAYER", 26, "SIGNAL", "Inner12", 0, "#00b400", 1, "#005a00", 0.5],
  27: ["LAYER", 27, "SIGNAL", "Inner13", 0, "#2e4756", 1, "#17232b", 0.5],
  28: ["LAYER", 28, "SIGNAL", "Inner14", 0, "#99842f", 1, "#4c4217", 0.5],
  29: ["LAYER", 29, "SIGNAL", "Inner15", 0, "#ffffaa", 1, "#7f7f55", 0.5],
  30: ["LAYER", 30, "SIGNAL", "Inner16", 0, "#99842f", 1, "#4c4217", 0.5],
  31: ["LAYER", 31, "SIGNAL", "Inner17", 0, "#2e4756", 1, "#17232b", 0.5],
  32: ["LAYER", 32, "SIGNAL", "Inner18", 0, "#3535ff", 1, "#1a1a7f", 0.5],
  33: ["LAYER", 33, "SIGNAL", "Inner19", 0, "#8000bc", 1, "#40005e", 0.5],
  34: ["LAYER", 34, "SIGNAL", "Inner20", 0, "#43ae5f", 1, "#21572f", 0.5],
  35: ["LAYER", 35, "SIGNAL", "Inner21", 0, "#c3ecce", 1, "#617667", 0.5],
  36: ["LAYER", 36, "SIGNAL", "Inner22", 0, "#728978", 1, "#39443c", 0.5],
  37: ["LAYER", 37, "SIGNAL", "Inner23", 0, "#39503f", 1, "#1c281f", 0.5],
  38: ["LAYER", 38, "SIGNAL", "Inner24", 0, "#0c715d", 1, "#06382e", 0.5],
  39: ["LAYER", 39, "SIGNAL", "Inner25", 0, "#5a8a80", 1, "#2d4540", 0.5],
  40: ["LAYER", 40, "SIGNAL", "Inner26", 0, "#2b937e", 1, "#15493f", 0.5],
  41: ["LAYER", 41, "SIGNAL", "Inner27", 0, "#23999d", 1, "#114c4e", 0.5],
  42: ["LAYER", 42, "SIGNAL", "Inner28", 0, "#45b4e3", 1, "#225a71", 0.5],
  43: ["LAYER", 43, "SIGNAL", "Inner29", 0, "#215da1", 1, "#102e50", 0.5],
  44: ["LAYER", 44, "SIGNAL", "Inner30", 0, "#4564d7", 1, "#22326b", 0.5],
  45: ["LAYER", 45, "SIGNAL", "Inner31", 0, "#6969e9", 1, "#343474", 0.5],
  46: ["LAYER", 46, "SIGNAL", "Inner32", 0, "#9069e9", 1, "#483474", 0.5],
}

/**
 * 返回 PCB 层骨架，并在 `LAYER 47` 之前按升序插入**被引用**的内层声明。
 *
 * 未传 / 传空集合时返回与 `PCB_LAYER_LINES` 逐元素相同的内容，
 * 保证不使用内层的 2/4 层板产物不变。
 */
export function pcbLayerLines(
  usedLayerIds: Iterable<number> = [],
): unknown[][] {
  const requested = [...new Set(usedLayerIds)]
    .filter((id) => Object.prototype.hasOwnProperty.call(PCB_INNER_LAYER_LINES, id))
    .sort((a, b) => a - b)
  const lines: unknown[][] = []
  for (const line of PCB_LAYER_LINES) {
    if (
      Array.isArray(line) &&
      line[0] === "LAYER" &&
      line[1] === 47 &&
      requested.length > 0
    ) {
      for (const id of requested) lines.push(PCB_INNER_LAYER_LINES[id]!)
    }
    lines.push(line)
  }
  return lines
}
