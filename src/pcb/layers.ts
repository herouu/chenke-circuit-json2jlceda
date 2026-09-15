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
