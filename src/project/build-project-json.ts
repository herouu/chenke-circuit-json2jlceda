import { A4_DEVICE_UUID, A4_SYMBOL_UUID, a4DeviceRecord } from "../symbol/a4-frame"
import type {
  ConversionContext,
  DeviceRecord,
  PcbDocResult,
  ProjectJson,
  SchematicDocResult,
} from "../types"

/** A4 图框符号标题，需与 lane A 生成的 `.esym` 保持一致。 */
const A4_SYMBOL_TITLE = "Drawing-Symbol_A4"

function serializeDevice(device: DeviceRecord): Record<string, unknown> {
  return {
    title: device.title,
    description: "",
    images: [""],
    tags: { parent_tag: [], child_tag: [] },
    custom_tags: "[]",
    source: "",
    version: "1",
    attributes: { ...device.attributes },
  }
}

/**
 * 组装嘉立创EDA专业版 V2 的 `project.json` 结构。
 *
 * - `symbols` / `footprints` / `devices` 三级解耦。
 * - 仅 `includeSchematic` 时写 `schematics` 与 `boards.schematic`。
 * - 仅 `includePcb` 时写 `pcbs` 与 `boards.pcb`。
 * - 始终注入 A4 图框符号（type 20）与 A4 图框 device，作为默认图框。
 */
export function buildProjectJson(
  ctx: ConversionContext,
  docs: { schematic?: SchematicDocResult; pcb?: PcbDocResult },
): ProjectJson {
  // 空字符串标题同样回退，避免 `pcbs` / `config.title` 出现空名字。
  const title =
    ctx.options.title && ctx.options.title.length > 0 ? ctx.options.title : "circuit"
  const includeSchematic = ctx.options.includeSchematic && docs.schematic !== undefined
  const includePcb = ctx.options.includePcb && docs.pcb !== undefined
  const sheetCount = docs.schematic ? 1 : 0

  const project: ProjectJson = {}

  if (includeSchematic && docs.schematic) {
    project.schematics = {
      [docs.schematic.docId]: {
        name: title,
        sheets: [
          {
            name: ctx.options.sheetName,
            id: 1,
            uuid: docs.schematic.sheetUuid,
          },
        ],
      },
    }
  }

  if (includePcb && docs.pcb) {
    project.pcbs = { [docs.pcb.docId]: title }
  }

  project.panels = {}

  // A4 图框符号 + 通用符号。
  const symbols: Record<string, unknown> = {
    [A4_SYMBOL_UUID]: {
      source: "",
      desc: "",
      tags: { parent_tag: [], child_tag: [] },
      custom_tags: "[]",
      title: A4_SYMBOL_TITLE,
      version: "1",
      type: 20,
    },
  }
  for (const blueprint of ctx.symbols.values()) {
    symbols[blueprint.uuid] = {
      source: "",
      desc: "",
      tags: { parent_tag: [], child_tag: [] },
      custom_tags: "[]",
      title: blueprint.title,
      version: "1",
      type: blueprint.symbolType,
    }
  }
  project.symbols = symbols

  const footprints: Record<string, unknown> = {}
  for (const blueprint of ctx.footprints.values()) {
    footprints[blueprint.uuid] = {
      source: "",
      desc: "",
      tags: { parent_tag: [], child_tag: [] },
      custom_tags: "[]",
      title: blueprint.title,
      version: "1",
      type: 4,
    }
  }
  project.footprints = footprints

  const devices: Record<string, unknown> = {
    [A4_DEVICE_UUID]: serializeDevice(a4DeviceRecord(title, sheetCount)),
  }
  for (const device of ctx.devices.values()) {
    devices[device.uuid] = serializeDevice(device)
  }
  project.devices = devices

  const board: Record<string, unknown> = {}
  if (includeSchematic && docs.schematic) {
    board.schematic = docs.schematic.docId
  }
  if (includePcb && docs.pcb) {
    board.pcb = docs.pcb.docId
  }
  project.boards = Object.keys(board).length > 0 ? { Board1: board } : {}

  project.config = {
    title,
    cbbProject: false,
    defaultSheet: A4_DEVICE_UUID,
    editorVersion: ctx.options.editorVersion,
  }

  return project
}
