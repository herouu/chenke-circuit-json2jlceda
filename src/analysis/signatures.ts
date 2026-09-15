import { createHash } from "node:crypto"
import { round6 } from "../units"

/**
 * 原理图符号签名：相同签名的元件复用同一个 Symbol。
 *
 * 形如：`<ftype>|<端口数>|<pin@x,y,...>|<宽>x<高>`。
 */
export function computeSymbolSignature(c: any, ports: any[]): string {
  const ftype = c?.ftype ?? "generic"
  const size = c?.size ?? {}
  const portSignature = ports
    .map((port) => {
      const label = port?.pin_number ?? port?.name ?? ""
      const x = round6(port?.center?.x ?? 0)
      const y = round6(port?.center?.y ?? 0)
      return `${label}@${x},${y}`
    })
    .join(",")
  const width = round6(size.width ?? 0)
  const height = round6(size.height ?? 0)
  return `${ftype}|${ports.length}|${portSignature}|${width}x${height}`
}

function padShapeLabel(pad: any): string {
  if (typeof pad?.shape === "string") return pad.shape
  const shape = pad?.padShape
  if (Array.isArray(shape) && typeof shape[0] === "string") return shape[0]
  if (pad?.radius !== undefined) return "circle"
  return "rect"
}

/**
 * 封装签名可选的身份入参。
 *
 * `comp` 传入的通常是 `pcb_component`，其自身 `type` 恒为 `"pcb_component"`，
 * 无法表达器件种类，因此这里显式接收 `source_component.ftype`。
 * `graphics` 用于把丝印图元（圆整后坐标）纳入签名，避免丝印不同的器件误合并。
 */
export interface FootprintSignatureOptions {
  /** source_component 的 ftype（器件种类）。 */
  ftype?: string
  /** source_component 的 manufacturer_part_number（厂商料号），与 ftype 共同构成器件身份。 */
  manufacturerPartNumber?: string
  /** 额外的显式身份键（可选）。 */
  footprintKey?: string
  /** 丝印等图元行（数量与圆整后坐标纳入签名）。 */
  graphics?: unknown[]
  /** 焊盘编号解析器；用于按 padNumber 排序与拼串。 */
  padNumberForPad?: (pad: any, index: number) => string
}

/** 递归圆整数值，保证签名对浮点噪声不敏感。 */
function roundDeep(value: unknown): unknown {
  if (typeof value === "number") return round6(value)
  if (Array.isArray(value)) return value.map((item) => roundDeep(item))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = roundDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function padNumberLabel(
  pad: any,
  index: number,
  options?: FootprintSignatureOptions,
): string {
  if (typeof options?.padNumberForPad === "function") {
    const resolved = options.padNumberForPad(pad, index)
    if (resolved !== undefined && resolved !== null) return String(resolved)
  }
  const candidate =
    pad?.pad_number ??
    pad?.padNumber ??
    pad?.port_hints?.[0] ??
    pad?.pcb_port_id ??
    pad?.pcbPortId
  return candidate === undefined || candidate === null
    ? String(index + 1)
    : String(candidate)
}

/**
 * 封装签名：相同签名的 PCB 元件复用同一个 Footprint。
 *
 * 由「器件身份（ftype + manufacturer_part_number）、焊盘数量/形状/圆整后相对坐标（按 padNumber 排序）、
 * 孔数量/形状/位置、图元数量/圆整后坐标」共同 hash 得到，保证确定性：
 * 相同输入恒得相同结果。
 *
 * @param comp  pcb_component（取其 center 作为坐标基准）
 * @param pads  焊盘原始元素
 * @param holes 孔原始元素
 * @param options 显式身份与图元信息，旧调用可省略
 */
export function computeFootprintSignature(
  comp: any,
  pads: any[],
  holes: any[],
  options?: FootprintSignatureOptions,
): string {
  const centerX = Number(comp?.center?.x ?? 0)
  const centerY = Number(comp?.center?.y ?? 0)

  // 先按 padNumber 排序，保证焊盘顺序变化不改变签名。
  const orderedPads = (Array.isArray(pads) ? pads : []).map((pad, index) => ({
    pad,
    index,
  }))
  orderedPads.sort((a, b) => {
    const an = padNumberLabel(a.pad, a.index, options)
    const bn = padNumberLabel(b.pad, b.index, options)
    if (an < bn) return -1
    if (an > bn) return 1
    return 0
  })

  const padPart = orderedPads
    .map(({ pad, index }) => {
      const width = round6(Number(pad?.width ?? pad?.radius ?? 0))
      const height = round6(Number(pad?.height ?? pad?.radius ?? 0))
      const x = round6(Number(pad?.x ?? 0) - centerX)
      const y = round6(Number(pad?.y ?? 0) - centerY)
      return `p:${padNumberLabel(pad, index, options)}:${padShapeLabel(pad)}:${width}x${height}:${x},${y}`
    })
    .join(",")

  const orderedHoles = (Array.isArray(holes) ? holes : [])
    .slice()
    .sort((a, b) => {
      const an = String(a?.pcb_port_id ?? a?.pcb_plated_hole_id ?? a?.pcb_hole_id ?? "")
      const bn = String(b?.pcb_port_id ?? b?.pcb_plated_hole_id ?? b?.pcb_hole_id ?? "")
      if (an < bn) return -1
      if (an > bn) return 1
      return 0
    })

  const holePart = orderedHoles
    .map((hole) => {
      const diameter = round6(Number(hole?.hole_diameter ?? 0))
      const x = round6(Number(hole?.x ?? 0) - centerX)
      const y = round6(Number(hole?.y ?? 0) - centerY)
      return `h:${hole?.shape ?? "circle"}:${diameter}:${x},${y}`
    })
    .join(",")

  const graphics = options?.graphics
  const graphicsCount = Array.isArray(graphics) ? graphics.length : 0
  const graphicsPart = Array.isArray(graphics)
    ? graphics.map((graphic) => JSON.stringify(roundDeep(graphic))).join(",")
    : ""

  const ftype = options?.ftype ?? comp?.ftype ?? "generic"
  // 器件身份 = ftype + manufacturer_part_number，保证不同器件不共用封装。
  const partNumber = options?.manufacturerPartNumber ?? ""
  const identity = options?.footprintKey ?? ""

  const canonical = [
    ftype,
    partNumber,
    identity,
    orderedPads.length,
    orderedHoles.length,
    padPart,
    holePart,
    graphicsCount,
    graphicsPart,
  ].join("|")

  return createHash("md5").update(canonical).digest("hex")
}
