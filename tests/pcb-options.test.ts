import { describe, expect, it } from "vitest"
import type { AnyCircuitElement } from "circuit-json"
import { convertCircuitJsonToEproFiles } from "../src/index"
import type { EproFile } from "../src/types"
import { PCB_UNITS_PER_MM, round6, toPcbLength } from "../src/units"

/** 一块 10mm x 4mm 的矩形板，便于断言坐标换算。 */
const boardCircuit = (): AnyCircuitElement[] =>
  [
    {
      type: "pcb_board",
      pcb_board_id: "pcb_board_0",
      center: { x: 0, y: 0 },
      width: 10,
      height: 4,
      thickness: 1.6,
      num_layers: 2,
    },
  ] as unknown as AnyCircuitElement[]

const parseLines = (content: string): unknown[][] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown[])

const epcbOf = (files: EproFile[]): string => {
  const file = files.find((entry) => entry.path.endsWith(".epcb"))
  if (!file) throw new Error("未找到 .epcb 文件")
  return file.content
}

/** 取板框 POLY（layer 11）的数值点列表。 */
const boardOutlineNumbers = (epcb: string): number[] => {
  for (const row of parseLines(epcb)) {
    if (row[0] !== "POLY" || row[4] !== 11) continue
    const points = Array.isArray(row[6]) ? (row[6] as unknown[]) : []
    return points.filter((value): value is number => typeof value === "number")
  }
  return []
}

const mil = (mm: number): number => Math.round((mm / 0.0254) * 1e6) / 1e6

describe("units.pcbPerMm", () => {
  it("默认与显式 PCB_UNITS_PER_MM 产物一致，坐标为 mil 换算值", () => {
    const a = convertCircuitJsonToEproFiles(boardCircuit(), {
      includeSchematic: false,
      title: "units-default",
    })
    const b = convertCircuitJsonToEproFiles(boardCircuit(), {
      includeSchematic: false,
      title: "units-default",
      units: { pcbPerMm: PCB_UNITS_PER_MM },
    })

    expect(a.files).toEqual(b.files)

    const numbers = boardOutlineNumbers(epcbOf(a.files))
    expect(numbers).toContain(mil(5))
    expect(numbers).toContain(mil(2))
  })

  it("自定义 units.pcbPerMm=1 时坐标为毫米数值", () => {
    const { files } = convertCircuitJsonToEproFiles(boardCircuit(), {
      includeSchematic: false,
      title: "units-custom",
      units: { pcbPerMm: 1 },
    })
    const numbers = boardOutlineNumbers(epcbOf(files))

    expect(numbers).toContain(5)
    expect(numbers).toContain(2)
    expect(numbers).not.toContain(mil(5))
  })
})

describe("units 作用域（无状态泄漏）", () => {
  const DEFAULT_PER_MM = round6(PCB_UNITS_PER_MM)

  it("自定义 pcbPerMm 转换后，同进程默认换算恢复为 PCB_UNITS_PER_MM", () => {
    // 前置：默认换算基线。
    expect(toPcbLength(1)).toBe(DEFAULT_PER_MM)

    convertCircuitJsonToEproFiles(boardCircuit(), {
      includeSchematic: false,
      title: "units-leak",
      units: { pcbPerMm: 1 },
    })

    // 修复前此处会得到 1（泄漏）；修复后必须回默认常量 39.370079。
    expect(toPcbLength(1)).toBe(DEFAULT_PER_MM)
  })

  it("不经过 PCB writer 的转换（includePcb:false 且无 PCB 元素）也会复位", () => {
    convertCircuitJsonToEproFiles(boardCircuit(), {
      includeSchematic: false,
      title: "units-leak-2",
      units: { pcbPerMm: 1 },
    })

    // 仅 source_component，无任何 pcb_* 元素：既不进 buildPcbDoc 也不进 synthesizeFootprint。
    convertCircuitJsonToEproFiles(
      [
        {
          type: "source_component",
          source_component_id: "source_component_only",
          name: "R1",
          ftype: "simple_resistor",
        } as unknown as AnyCircuitElement,
      ],
      { includePcb: false, includeSchematic: false, title: "no-pcb" },
    )

    expect(toPcbLength(1)).toBe(DEFAULT_PER_MM)
  })
})
