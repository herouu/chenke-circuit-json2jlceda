import type { AnyCircuitElement } from "circuit-json"
import { buildPcbIndex } from "./analysis/pcb-index"
import { buildSchematicIndex } from "./analysis/schematic-index"
import { buildSourceIndex } from "./analysis/source-index"
import { createIdAllocator, createUuidFactory } from "./ids"
import type { ConversionContext, ConvertOptions, EproDiagnostic } from "./types"
import { PCB_UNITS_PER_MM, SCH_UNITS_PER_MM } from "./units"

const DEFAULT_OPTIONS: Required<ConvertOptions> = {
  title: "circuit",
  sheetName: "P1",
  includeSchematic: true,
  includePcb: true,
  editorVersion: "2.2.48.10",
  deterministic: true,
  strict: false,
  uuidSalt: "circuit-json-to-epro2",
  axis: { schematicFlipY: false },
  units: { schematicPerMm: SCH_UNITS_PER_MM, pcbPerMm: PCB_UNITS_PER_MM },
  schematicFit: true,
}

/**
 * 剔除值为 `undefined` 的自有键。
 *
 * `{ ...DEFAULT, ...{ title: undefined } }` 会让 `undefined` 覆盖默认值，
 * 因此「省略该键」与「显式传 undefined」都必须回到默认值。
 */
function omitUndefined<T extends object>(input: T): T {
  const result = {} as T
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      ;(result as Record<string, unknown>)[key] = value
    }
  }
  return result
}

/**
 * 创建转换上下文，合并默认选项并建立三套索引。
 */
export function createConversionContext(
  cj: AnyCircuitElement[],
  options?: ConvertOptions,
): ConversionContext {
  const overrides = omitUndefined(options ?? {})
  const axisOverride = omitUndefined(options?.axis ?? {})
  const unitsOverride = omitUndefined(options?.units ?? {})
  const merged: Required<ConvertOptions> = {
    ...DEFAULT_OPTIONS,
    ...overrides,
    axis: { ...DEFAULT_OPTIONS.axis, ...axisOverride },
    units: { ...DEFAULT_OPTIONS.units, ...unitsOverride },
  }

  const diagnostics: EproDiagnostic[] = []
  const strict = merged.strict

  const pcb = buildPcbIndex(cj)

  // PCB 索引层产生的“不得静默丢弃”诊断。
  for (const fallbackId of pcb.unindexedComponentIds ?? []) {
    diagnostics.push({
      code: "missing-component-id",
      severity: "warning",
      message: `pcb_component 缺少 pcb_component_id，已合成回退 id ${fallbackId} 并保留`,
      circuitElementType: "pcb_component",
      circuitElementId: fallbackId,
    })
  }
  for (const element of pcb.orphanElements ?? []) {
    const elementId =
      element?.pcb_smtpad_id ?? element?.pcb_plated_hole_id ?? element?.pcb_hole_id
    const elementType = String(element?.type ?? "unknown")
    diagnostics.push({
      code: "orphan-pad",
      severity: "warning",
      message: `${elementType} ${String(elementId ?? "")} 无法归属到任何 pcb_component，已作为独立 PAD 写入 .epcb`,
      circuitElementType: elementType,
      circuitElementId: typeof elementId === "string" ? elementId : undefined,
    })
  }

  const ctx: ConversionContext = {
    circuitJson: cj,
    options: merged,
    ids: createIdAllocator(),
    uuid: createUuidFactory(merged.uuidSalt, merged.deterministic),
    diagnostics,
    source: buildSourceIndex(cj),
    schematic: buildSchematicIndex(cj),
    pcb,
    symbols: new Map(),
    footprints: new Map(),
    devices: new Map(),
    footprintUuidByPcbComponentId: new Map(),
    warn(d: EproDiagnostic): void {
      diagnostics.push({ ...d, severity: "warning" })
    },
    error(d: EproDiagnostic): void {
      diagnostics.push({ ...d, severity: "error" })
      if (strict) {
        throw new Error(d.message)
      }
    },
  }

  return ctx
}
