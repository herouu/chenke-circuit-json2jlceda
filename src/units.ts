/**
 * 单位与坐标变换工具。
 *
 * - 原理图（SCH）单位：0.01 inch，即 0.254 mm。
 * - PCB 单位：mil，即 0.0254 mm。
 * - 角度以逆时针为正（本文件只处理平移/镜像，旋转由各文档 writer 处理）。
 */

/** 每毫米对应的 SCH 单位数（1 / 0.254）。 */
export const SCH_UNITS_PER_MM = 1 / 0.254

/** 每毫米对应的 PCB 单位数（1 / 0.0254）。 */
export const PCB_UNITS_PER_MM = 1 / 0.0254

/** 保留 6 位小数，消除浮点噪声。 */
export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

/** 毫米 → SCH 单位。 */
export function toSchLength(mm: number): number {
  return round6(mm * SCH_UNITS_PER_MM)
}

/**
 * 当前生效的 PCB 每毫米单位数覆盖值。
 *
 * `undefined` 表示使用默认常量 `PCB_UNITS_PER_MM`。由 PCB 写入器/封装合成
 * 在入口处按 `ctx.options.units.pcbPerMm` 设置，使底层 `toMil` 等换算无需
 * 逐个透传 ctx。默认未设置，保证默认选项下产物与修复前逐字节一致。
 *
 * 该值必须**作用域化**：写入/合成入口用 `pushPcbUnits` 设置、`finally` 中
 * `popPcbUnits` 恢复进入前的值，异常/提前返回也能恢复，避免跨转换状态泄漏。
 */
let activePcbUnitsPerMm: number | undefined

/** 解析 `units.pcbPerMm`；非法（非有限正数）时回退默认常量。 */
export function resolvePcbUnitsPerMm(perMm: unknown): number {
  return typeof perMm === "number" && Number.isFinite(perMm) && perMm > 0
    ? perMm
    : PCB_UNITS_PER_MM
}

/**
 * 进入 PCB 换算作用域：设置比例并返回进入前的值（供 `popPcbUnits` 恢复）。
 *
 * `undefined` 入参表示使用默认常量。返回值可能是 `undefined`（进入前即默认），
 * 因此必须原样回传给 `popPcbUnits`，不能用真值判断。
 */
export function pushPcbUnits(perMm?: unknown): number | undefined {
  const previous = activePcbUnitsPerMm
  activePcbUnitsPerMm =
    perMm === undefined ? undefined : resolvePcbUnitsPerMm(perMm)
  return previous
}

/** 退出 PCB 换算作用域：恢复 `pushPcbUnits` 返回的进入前值。 */
export function popPcbUnits(previous: number | undefined): void {
  activePcbUnitsPerMm = previous
}

/** 毫米 → PCB 单位（mil）。 */
export function toPcbLength(mm: number): number {
  return round6(mm * (activePcbUnitsPerMm ?? PCB_UNITS_PER_MM))
}

export interface Transform2D {
  scale: number
  offsetX: number
  offsetY: number
  flipY: boolean
}

/** 对单点应用缩放、Y 轴镜像与平移。 */
export function transformPoint(
  p: { x: number; y: number },
  t: Transform2D,
): { x: number; y: number } {
  return {
    x: p.x * t.scale + t.offsetX,
    y: t.flipY ? -(p.y * t.scale) + t.offsetY : p.y * t.scale + t.offsetY,
  }
}

/**
 * 计算坐标变换。
 *
 * 给定 `targetBox` 时，把 `contentBBox` 平移居中到目标框：变换不缩放内容
 * （内容尺寸由 `scale` 表达，居中只贡献平移量）。未给定 `targetBox` 时
 * 仅返回 `scale`/`flipY`，平移量为 0。
 */
export function computeTransform(params: {
  scale: number
  flipY: boolean
  contentBBox: { minX: number; minY: number; maxX: number; maxY: number }
  targetBox?: { minX: number; minY: number; maxX: number; maxY: number }
}): Transform2D {
  const { scale, flipY, contentBBox, targetBox } = params
  if (!targetBox) {
    return { scale, flipY, offsetX: 0, offsetY: 0 }
  }
  const contentCenterX = (contentBBox.minX + contentBBox.maxX) / 2
  const contentCenterY = (contentBBox.minY + contentBBox.maxY) / 2
  const targetCenterX = (targetBox.minX + targetBox.maxX) / 2
  const targetCenterY = (targetBox.minY + targetBox.maxY) / 2
  const offsetX = targetCenterX - scale * contentCenterX
  const offsetY = flipY
    ? targetCenterY + scale * contentCenterY
    : targetCenterY - scale * contentCenterY
  return { scale, flipY, offsetX, offsetY }
}
