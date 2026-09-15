import type { AnyCircuitElement } from "circuit-json"

export type EproPrimitive = unknown[]
export interface EproFile { path: string; content: string }

export type DiagnosticCode =
  | "unsupported-element"
  | "missing-source-component" | "missing-symbol" | "missing-footprint"
  | "missing-component-id" | "orphan-pad"
  | "duplicate-id"
  | "layout-scaled"
  /** 走线 route 结构异常（如相邻 wire 点跨层却无 via/through_pad）。 */
  | "invalid-trace"
  /** route 内含 via 点但缺少对应 `pcb_via` 元素，已回退生成 VIA 行。 */
  | "missing-via"

export interface EproDiagnostic {
  code: DiagnosticCode
  severity: "info" | "warning" | "error"
  message: string
  circuitElementType?: string
  circuitElementId?: string
}

export interface ConvertOptions {
  title?: string
  sheetName?: string
  includeSchematic?: boolean
  includePcb?: boolean
  editorVersion?: string
  deterministic?: boolean
  strict?: boolean
  uuidSalt?: string
  /** 坐标轴翻转；`schematicFlipY` 由原理图 writer 消费。 */
  axis?: { schematicFlipY?: boolean }
  /** 单位换算系数；`pcbPerMm` 由 PCB writer 消费。 */
  units?: { schematicPerMm?: number; pcbPerMm?: number }
  /**
   * 是否启用原理图缩放适配。为 `false` 时只做平移（保持 1:1），
   * 内容可能超出可用区。默认 `true`。
   */
  schematicFit?: boolean
}

export interface IdAllocator {
  next(): string
  reserve(id: string): void
  peekMaxId(): number
}
export interface UuidFactory { uuid(kind: string, key: string): string }

export interface SymbolPinBlueprint {
  sourcePortId?: string
  pinNumber: string
  name: string
  x: number; y: number
  length: number
  rotation: 0 | 90 | 180 | 270
  elecType: 0 | 1 | 2 | 3
  display: boolean
}
export interface SymbolBlueprint {
  uuid: string
  title: string
  symbolType: number
  partName: string
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
  primitives: EproPrimitive[]
  pins: SymbolPinBlueprint[]
}

export interface FootprintPadBlueprint {
  sourcePortId?: string
  padNumber: string
  x: number; y: number
  rotation: number
  layer: 1 | 2 | 12
  padShape: EproPrimitive
  hole: EproPrimitive | null
  plated: 0 | 1
  isTestpoint?: boolean
}
export interface FootprintBlueprint {
  uuid: string
  title: string
  pads: FootprintPadBlueprint[]
  graphics: EproPrimitive[]
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface DeviceRecord {
  uuid: string
  title: string
  symbolUuid: string
  footprintUuid: string
  attributes: Record<string, string>
}

export interface SourceIndex {
  componentById: Map<string, any>
  portById: Map<string, any>
  netById: Map<string, any>
  traceById: Map<string, any>
  netNameForSourceTrace(sourceTraceId: string): string | undefined
  pinNumberForSourcePort(sourcePortId: string): string | undefined
}
export interface SchematicIndex {
  componentById: Map<string, any>
  portById: Map<string, any>
  portsByComponentId: Map<string, any[]>
  traces: any[]
  netLabels: any[]
  /**
   * 两个 id 都缺失、被合成索引键保留的 schematic_component 键列表（用于诊断）。
   * `buildSchematicIndex` 必然返回该字段，故为必填，由 tsc 强制生产方提供。
   */
  unindexedSchematicComponentIds: string[]
  /**
   * 索引键冲突（不同元素撞同一键）而未被保留的键列表（用于诊断）。
   * `buildSchematicIndex` 必然返回该字段，故为必填，由 tsc 强制生产方提供。
   */
  duplicateSchematicComponentKeys: string[]
}
export interface PcbIndex {
  board?: any
  componentById: Map<string, any>
  portById: Map<string, any>
  smtPadsByComponentId: Map<string, any[]>
  platedHolesByComponentId: Map<string, any[]>
  standaloneHoles: any[]
  /**
   * 无任何 pcb_component 归属（或归属组件不存在）的 SMT 焊盘。
   * 这些焊盘仍会作为独立 PAD 写入 `.epcb`，不静默丢弃。
   */
  standalonePads?: any[]
  /** 缺少 `pcb_component_id` 而被赋予回退 id 的组件 id 列表。 */
  unindexedComponentIds?: string[]
  /** 被判为孤儿、转为独立 PAD 的焊盘/孔原始元素（用于诊断）。 */
  orphanElements?: any[]
  traces: any[]
  vias: any[]
  /**
   * 板内挖槽（`pcb_cutout`）原始元素。
   *
   * 当前 `.epcb` 尚无经规范/官方样例确证的内槽表达方式，故仅收集用于
   * 发诊断，不静默丢弃也不猜测几何。
   */
  cutouts: any[]
  /**
   * 板级丝印别名，与 `boardSilkscreen` **等价**（保留旧字段兼容）。
   * 新代码请使用 `boardSilkscreen`。
   */
  silkscreen: any[]
  /** 无元件归属、由 `.epcb` 输出到板级的丝印图元。 */
  boardSilkscreen: any[]
  /** 按 pcb_component_id 归属的丝印图元，由所属封装的 `.efoo` 消费。 */
  silkscreenByPcbComponentId: Map<string, any[]>
  netNameForPcbPort(pcbPortId: string): string | undefined
}

export interface ConversionContext {
  circuitJson: AnyCircuitElement[]
  options: Required<ConvertOptions>
  ids: IdAllocator
  uuid: UuidFactory
  diagnostics: EproDiagnostic[]
  source: SourceIndex
  schematic: SchematicIndex
  pcb: PcbIndex
  symbols: Map<string, SymbolBlueprint>
  footprints: Map<string, FootprintBlueprint>
  devices: Map<string, DeviceRecord>
  /**
   * `pcb_component_id` → 封装 uuid 的映射（由 `synthesizeLibrary` 填充）。
   *
   * 供 `.epcb` 与 `FOOTPRINT/*.efoo` 共享同一封装 uuid，避免两处各自重算
   * 签名导致引用不一致。`createConversionContext` 必然初始化为空 Map，
   * 因此为必填字段，由 tsc 强制生产方提供。
   */
  footprintUuidByPcbComponentId: Map<string, string>
  warn(d: EproDiagnostic): void
  error(d: EproDiagnostic): void
}

export interface SchematicDocResult { docId: string; sheetUuid: string; esch: string }
export interface PcbDocResult { docId: string; epcb: string }
export interface ProjectJson { [k: string]: unknown }
