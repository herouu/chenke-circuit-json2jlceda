import type { AnyCircuitElement } from "circuit-json"
import { refdesFor } from "./analysis/source-index"
import { createConversionContext } from "./context"
import { synthesizeFootprint } from "./footprint/synthesize-footprint"
import { writeEfoo } from "./footprint/write-efoo"
import { packEproFiles } from "./pack"
import { buildPcbDoc } from "./pcb/write-epcb"
import { buildProjectJson } from "./project/build-project-json"
import { getSchematicLayout } from "./schematic/layout"
import { buildSchematicDoc } from "./schematic/write-esch"
import { A4_SYMBOL_UUID, a4SymbolEsym } from "./symbol/a4-frame"
import { synthesizeSymbol } from "./symbol/synthesize-symbol"
import { writeEsym } from "./symbol/write-esym"
import type {
  ConversionContext,
  ConvertOptions,
  DeviceRecord,
  EproDiagnostic,
  EproFile,
  PcbDocResult,
  ProjectJson,
  SchematicDocResult,
} from "./types"

/** 从 source_component 派生器件显示值。 */
function deviceValue(sourceComponent: any): string | undefined {
  const candidates = [
    sourceComponent?.display_value,
    sourceComponent?.display_resistance,
    sourceComponent?.display_capacitance,
    sourceComponent?.display_inductance,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  if (sourceComponent?.value !== undefined && sourceComponent?.value !== null) {
    return String(sourceComponent.value)
  }
  return undefined
}

/**
 * 合成符号库、封装库与器件库。
 *
 * - 符号：针对每个 `schematic_component` 的**索引键**（正常为
 *   `source_component_id`，缺 `source_component_id` 时为 `schematic_component_id`
 *   回退键），按返回的 uuid 去重。
 * - 封装：针对拥有 `pcb_component` 的 source_component，按返回的 uuid 去重。
 * - 器件：每个 source_component / 每个原理图索引键一个，uuid 由
 *   `uuid("device", 索引键)` 派生（与 lane B 的 `uuidFor` 保持一致）。
 */
function synthesizeLibrary(ctx: ConversionContext): void {
  const symbolByComponentKey = new Map<string, string>()
  // 同一套布局变换用于符号与 `.esch`，避免缩放后引脚与导线脱节。
  const layout = ctx.options.includeSchematic ? getSchematicLayout(ctx) : undefined
  // 原理图关闭时不得产出无人引用的符号：符号与（仅原理图侧存在的）器件一并受约束。
  if (ctx.options.includeSchematic) {
    // 以原理图索引键为身份：无 source_component_id 的元件也能获得符号，
    // 不再因 source 索引缺失而被静默丢弃。
    for (const [componentKey, schematicComponent] of ctx.schematic.componentById) {
      if (!schematicComponent) continue
      const blueprint = synthesizeSymbol(ctx, componentKey, layout)
      const symbolUuid = String(blueprint.uuid)
      if (!ctx.symbols.has(symbolUuid)) {
        ctx.symbols.set(symbolUuid, blueprint)
      }
      symbolByComponentKey.set(componentKey, symbolUuid)
    }
  }

  const footprintBySourceComponentId = new Map<string, string>()
  const footprintUuidByPcbComponentId = new Map<string, string>()
  for (const pcbComponent of ctx.pcb.componentById.values()) {
    const sourceComponentId =
      typeof pcbComponent?.source_component_id === "string" &&
      pcbComponent.source_component_id.length > 0
        ? pcbComponent.source_component_id
        : undefined
    const pcbComponentId = String(pcbComponent?.pcb_component_id ?? "")
    if (sourceComponentId === undefined && pcbComponentId.length === 0) continue

    // 缺少 source_component_id 的元件仍须合成封装（以 pcb_component_id 为键）。
    const blueprint = synthesizeFootprint(
      ctx,
      sourceComponentId ?? "",
      pcbComponentId.length > 0 ? pcbComponentId : undefined,
    )
    const footprintUuid = String(blueprint.uuid)
    if (!ctx.footprints.has(footprintUuid)) {
      ctx.footprints.set(footprintUuid, blueprint)
    }
    if (pcbComponentId.length > 0) {
      footprintUuidByPcbComponentId.set(pcbComponentId, footprintUuid)
    }
    if (sourceComponentId !== undefined) {
      footprintBySourceComponentId.set(sourceComponentId, footprintUuid)
    } else {
      ctx.warn({
        code: "missing-source-component",
        severity: "warning",
        message: `pcb_component ${pcbComponentId} 缺少 source_component_id，已以 pcb_component_id 为键合成封装`,
        circuitElementType: "pcb_component",
        circuitElementId: pcbComponentId,
      })
    }
  }
  // 供 `.epcb` 与封装库共享，避免两处各自重算签名导致 uuid 不一致。
  ctx.footprintUuidByPcbComponentId = footprintUuidByPcbComponentId

  // 器件身份键 = source_component_id（有 source_component 者）∪ 原理图索引键
  // （含缺 source_component_id 的回退键），两者都派生出稳定的 Device。
  const deviceIdentities: Array<[string, any | undefined]> = [
    ...ctx.source.componentById.entries(),
  ]
  const deviceKeys = new Set(deviceIdentities.map(([key]) => key))
  for (const componentKey of ctx.schematic.componentById.keys()) {
    if (deviceKeys.has(componentKey)) continue
    deviceKeys.add(componentKey)
    deviceIdentities.push([componentKey, undefined])
  }

  for (const [componentKey, sourceComponent] of deviceIdentities) {
    const symbolUuid = symbolByComponentKey.get(componentKey)
    const footprintUuid = footprintBySourceComponentId.get(componentKey)
    if (symbolUuid === undefined && footprintUuid === undefined) continue
    if (ctx.devices.has(componentKey)) continue

    const refdes = refdesFor(componentKey, sourceComponent)
    // 与 lane B 的 `uuidFor(ctx, "device", 索引键)` 保持同一派生方式，
    // 确保原理图 / PCB / project.json 三处的 Device 绑定指向同一 uuid。
    const deviceUuid = ctx.uuid.uuid("device", componentKey)

    const value = deviceValue(sourceComponent)
    const title =
      typeof sourceComponent?.display_name === "string" &&
      sourceComponent.display_name.length > 0
        ? sourceComponent.display_name
        : refdes

    const record: DeviceRecord = {
      uuid: deviceUuid,
      title,
      symbolUuid: symbolUuid ?? "",
      footprintUuid: footprintUuid ?? "",
      attributes: {
        "Convert to PCB": "yes",
        "Add into BOM": "yes",
        Designator: refdes,
        Symbol: symbolUuid ?? "",
        Footprint: footprintUuid ?? "",
        Value: value ?? "",
        Name: value !== undefined ? "={Value}" : refdes,
        Description: "",
      },
    }
    ctx.devices.set(componentKey, record)
  }
}

/** 解析 JSON-lines 文档为行数组。 */
function parseJsonLines(content: string): unknown[][] {
  const rows: unknown[][] = []
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) rows.push(parsed as unknown[])
    } catch {
      // 非法行忽略，校验不因单行解析失败而中断。
    }
  }
  return rows
}

/** 按 strict 选项走 error 通道（抛错），否则走 warning 通道。 */
function reportMissing(
  ctx: ConversionContext,
  code: "missing-footprint" | "missing-source-component",
  message: string,
): void {
  const diagnostic: EproDiagnostic = { code, severity: "warning", message }
  if (ctx.options.strict) {
    ctx.error(diagnostic)
  } else {
    ctx.warn(diagnostic)
  }
}

/**
 * 三方一致性校验：`.epcb` / `project.json` / `FOOTPRINT/*.efoo` 引用必须闭合。
 *
 * 1. `.epcb` 每条非空 `Footprint` ATTR 必须有对应 `.efoo` 与 `project.json.footprints` 项。
 * 2. 非空 `Device` ATTR 必须存在于 `project.json.devices`。
 * 3. 兜底：`ctx.footprints` 中未被 manifest 收录的 uuid 自动补录。
 */
function validateEproReferences(
  ctx: ConversionContext,
  docs: { schematic?: SchematicDocResult; pcb?: PcbDocResult },
  manifest: ProjectJson,
): void {
  const footprints =
    manifest.footprints !== null && typeof manifest.footprints === "object"
      ? (manifest.footprints as Record<string, unknown>)
      : {}
  const devices =
    manifest.devices !== null && typeof manifest.devices === "object"
      ? (manifest.devices as Record<string, unknown>)
      : {}

  // 兜底：任何生成了 `.efoo` 的 uuid 若未被 project.json 收录，补录。
  for (const blueprint of ctx.footprints.values()) {
    const uuid = String(blueprint.uuid)
    if (Object.prototype.hasOwnProperty.call(footprints, uuid)) continue
    footprints[uuid] = {
      source: "",
      desc: "",
      tags: { parent_tag: [], child_tag: [] },
      custom_tags: "[]",
      title: blueprint.title,
      version: "1",
      type: 4,
    }
    reportMissing(
      ctx,
      "missing-footprint",
      `封装 ${uuid} 未收录于 project.json，已自动补录`,
    )
  }
  manifest.footprints = footprints

  if (!docs.pcb) return
  const emittedFootprints = new Set(
    [...ctx.footprints.values()].map((blueprint) => String(blueprint.uuid)),
  )

  for (const row of parseJsonLines(docs.pcb.epcb)) {
    if (row[0] !== "ATTR") continue
    const key = row[7]
    const value = row[8]
    if (typeof key !== "string" || typeof value !== "string" || value.length === 0) {
      continue
    }
    if (key === "Footprint") {
      const hasFile = emittedFootprints.has(value)
      const hasManifest = Object.prototype.hasOwnProperty.call(footprints, value)
      if (!hasFile || !hasManifest) {
        reportMissing(
          ctx,
          "missing-footprint",
          `元件引用的封装 ${value} 缺失（${hasFile ? "" : "FOOTPRINT/*.efoo 文件"}${!hasFile && !hasManifest ? "、" : ""}${hasManifest ? "" : "project.json.footprints 条目"}）`,
        )
      }
    } else if (key === "Device") {
      if (!Object.prototype.hasOwnProperty.call(devices, value)) {
        reportMissing(
          ctx,
          "missing-source-component",
          `元件引用的器件 ${value} 不在 project.json.devices 中`,
        )
      }
    }
  }
}

/**
 * circuit-json → `.epro` 内的文件列表 + 诊断 + project.json manifest。
 */
export function convertCircuitJsonToEproFiles(
  cj: AnyCircuitElement[],
  options?: ConvertOptions,
): { files: EproFile[]; diagnostics: EproDiagnostic[]; manifest: ProjectJson } {
  const ctx = createConversionContext(cj, options)
  synthesizeLibrary(ctx)

  const docs: { schematic?: SchematicDocResult; pcb?: PcbDocResult } = {}
  if (ctx.options.includeSchematic) {
    const schematic = buildSchematicDoc(ctx)
    if (schematic) docs.schematic = schematic
  }
  if (ctx.options.includePcb) {
    const pcb = buildPcbDoc(ctx)
    if (pcb) docs.pcb = pcb
  }

  const manifest = buildProjectJson(ctx, docs)
  validateEproReferences(ctx, docs, manifest)

  const files: EproFile[] = [
    { path: "project.json", content: JSON.stringify(manifest, null, 2) },
  ]
  if (docs.schematic) {
    files.push({
      path: `SHEET/${docs.schematic.docId}/1.esch`,
      content: docs.schematic.esch,
    })
  }
  if (docs.pcb) {
    files.push({ path: `PCB/${docs.pcb.docId}.epcb`, content: docs.pcb.epcb })
  }
  for (const blueprint of ctx.symbols.values()) {
    files.push({ path: `SYMBOL/${blueprint.uuid}.esym`, content: writeEsym(blueprint) })
  }
  files.push({ path: `SYMBOL/${A4_SYMBOL_UUID}.esym`, content: a4SymbolEsym() })
  for (const blueprint of ctx.footprints.values()) {
    files.push({
      path: `FOOTPRINT/${blueprint.uuid}.efoo`,
      content: writeEfoo(blueprint),
    })
  }

  return { files, diagnostics: ctx.diagnostics, manifest }
}

/**
 * circuit-json → `.epro` 二进制（ZIP）。
 */
export function convertCircuitJsonToEpro(
  cj: AnyCircuitElement[],
  options?: ConvertOptions,
): { data: Uint8Array; diagnostics: EproDiagnostic[] } {
  const { files, diagnostics } = convertCircuitJsonToEproFiles(cj, options)
  const data = packEproFiles(files)
  return { data, diagnostics }
}
