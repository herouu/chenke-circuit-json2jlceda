import type { ConversionContext } from "../types"
import {
  computeTransform,
  round6,
  SCH_UNITS_PER_MM,
  type Transform2D,
} from "../units"

/** 页内矩形（SCH 单位）。 */
export interface SchematicBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 原理图正文可用区（SCH 单位）。
 *
 * A4 图框：原点在页面左下角，X 向右 0..1170，Y 向上 0..825；
 * 右下角标题栏占据底部 `y < ~200` 且 `x > ~460` 的区域，加上页面边框
 * 与留边，正文可用区取 `minX 20 / minY 220 / maxX 1150 / maxY 810`。
 */
export const USABLE_BOX: SchematicBox = {
  minX: 20,
  minY: 220,
  maxX: 1150,
  maxY: 810,
}

/** 适配系数下限，防止内容极端退化时 `scale` 归零。 */
export const MIN_FIT = 0.05

/** 适配系数上限，防止内容极小时放大到荒谬比例。 */
export const MAX_FIT = 50

/** 布局结果：在 `Transform2D` 之上附带适配系数与内容包围盒。 */
export interface SchematicLayout extends Transform2D {
  /** 等比适配系数，`1` 表示不缩放。 */
  fit: number
  /** 内容包围盒（mm）。 */
  contentBBox: SchematicBox
}

/**
 * 计算原理图内容的**完整**包围盒（mm）。
 *
 * 覆盖：
 * - 每个 `schematic_component` 的中心；
 * - 每个元件的**本体范围**（中心 ± `size/2`，`size` 为含引脚的整体包围盒）；
 * - 每个 `schematic_port` 的连接点中心；
 * - 每条 `schematic_trace` 折线的全部端点。
 */
export function computeSchematicContentBBox(ctx: ConversionContext): SchematicBox {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const add = (x: number | undefined, y: number | undefined): void => {
    if (typeof x !== "number" || typeof y !== "number") return
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  for (const component of ctx.schematic.componentById.values()) {
    const center = component?.center
    add(center?.x, center?.y)
    const width = Number(component?.size?.width)
    const height = Number(component?.size?.height)
    if (
      typeof center?.x === "number" &&
      typeof center?.y === "number" &&
      Number.isFinite(width) &&
      Number.isFinite(height)
    ) {
      add(center.x - width / 2, center.y - height / 2)
      add(center.x + width / 2, center.y + height / 2)
    }
  }

  for (const port of ctx.schematic.portById.values()) {
    add(port?.center?.x, port?.center?.y)
  }

  for (const trace of ctx.schematic.traces as Array<{
    edges?: Array<{ from?: PointLike; to?: PointLike }>
  }>) {
    for (const edge of trace?.edges ?? []) {
      add(edge?.from?.x, edge?.from?.y)
      add(edge?.to?.x, edge?.to?.y)
    }
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  return { minX, minY, maxX, maxY }
}

interface PointLike {
  x: number
  y: number
}

/**
 * 计算原理图统一布局变换。
 *
 * - `scale = 基准(单位/毫米) × fit`；
 * - `fit = min(可用宽/(内容宽×基准), 可用高/(内容高×基准))`，即按可用区**等比适配**
 *   （内容大可缩小、内容小可放大），并夹在 `[MIN_FIT, MAX_FIT]` 内；
 * - 平移把内容包围盒中心对齐到可用区中心；
 * - `flipY` 沿用 `options.axis.schematicFlipY`。
 */
export function computeSchematicLayout(
  ctx: ConversionContext,
  opts?: { fit?: boolean },
): SchematicLayout {
  const contentBBox = computeSchematicContentBBox(ctx)
  const baseScale =
    typeof ctx.options.units.schematicPerMm === "number" &&
    Number.isFinite(ctx.options.units.schematicPerMm) &&
    ctx.options.units.schematicPerMm > 0
      ? ctx.options.units.schematicPerMm
      : SCH_UNITS_PER_MM
  const flipY = ctx.options.axis.schematicFlipY === true

  const usableW = USABLE_BOX.maxX - USABLE_BOX.minX
  const usableH = USABLE_BOX.maxY - USABLE_BOX.minY
  const contentW = Math.max(contentBBox.maxX - contentBBox.minX, 1e-9)
  const contentH = Math.max(contentBBox.maxY - contentBBox.minY, 1e-9)

  const fitEnabled = opts?.fit ?? ctx.options.schematicFit !== false
  let fit = 1
  if (fitEnabled) {
    fit = Math.min(
      usableW / (contentW * baseScale),
      usableH / (contentH * baseScale),
    )
    if (!Number.isFinite(fit) || fit <= 0) fit = MIN_FIT
    fit = Math.max(fit, MIN_FIT)
    fit = Math.min(fit, MAX_FIT)
  }

  const scale = baseScale * fit
  const transform = computeTransform({
    scale,
    flipY,
    contentBBox,
    targetBox: USABLE_BOX,
  })
  return { ...transform, fit, contentBBox }
}

const LAYOUT_CACHE = new WeakMap<ConversionContext, SchematicLayout>()
const FIT_WARNED = new WeakSet<ConversionContext>()

/**
 * 取（并缓存）当前上下文的原理图布局；`fit !== 1` 时只发一条诊断。
 *
 * 缓存保证 `.esch` 与 `SYMBOL/*.esym` 使用**同一个** `scale`，否则缩放后
 * 引脚局部坐标与元件中心将使用不同比例，导致引脚与导线脱节。
 */
export function getSchematicLayout(ctx: ConversionContext): SchematicLayout {
  const cached = LAYOUT_CACHE.get(ctx)
  if (cached) return cached

  const layout = computeSchematicLayout(ctx)
  LAYOUT_CACHE.set(ctx, layout)

  if (layout.fit !== 1 && ctx.options.schematicFit !== false && !FIT_WARNED.has(ctx)) {
    FIT_WARNED.add(ctx)
    const direction = layout.fit < 1 ? "缩小" : "放大"
    const reason =
      layout.fit < 1 ? "内容超出可用区" : "内容小于可用区"
    ctx.diagnostics.push({
      code: "layout-scaled",
      severity: "info",
      message: `原理图${reason}，已等比${direction}适配：fit=${round6(layout.fit)}，scale=${round6(layout.scale)} 单位/毫米`,
      circuitElementType: "schematic_component",
    })
  }
  return layout
}
