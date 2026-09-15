import { describe, expect, it } from "vitest"
import type { AnyCircuitElement } from "circuit-json"
import { convertCircuitJsonToEproFiles } from "../src/index"

type EproFiles = { path: string; content: string }[]

const convertPcb = (cj: AnyCircuitElement[]) =>
  convertCircuitJsonToEproFiles(cj, { title: "preserve", includeSchematic: false })

const byPath = (files: EproFiles): Map<string, string> =>
  new Map(files.map((file) => [file.path, file.content] as const))

const parseLines = (content: string): unknown[][] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown[])

const findEpcb = (files: EproFiles): string => {
  const file = files.find((entry) => entry.path.endsWith(".epcb"))
  if (!file) throw new Error("未找到 .epcb 文件")
  return file.content
}

/** 取 `.epcb` 中每条 COMPONENT 的 `Footprint` ATTR 值（按出现顺序）。 */
const footprintUuidsFromEpcb = (epcb: string): string[] => {
  const uuids: string[] = []
  for (const row of parseLines(epcb)) {
    if (
      row[0] === "ATTR" &&
      row[7] === "Footprint" &&
      typeof row[8] === "string" &&
      row[8].length > 0
    ) {
      uuids.push(row[8])
    }
  }
  return uuids
}

const sourceComponent = (
  id: string,
  name: string,
  ftype: string,
): AnyCircuitElement =>
  ({
    type: "source_component",
    source_component_id: id,
    name,
    ftype,
  }) as unknown as AnyCircuitElement

const pcbComponent = (
  id: string,
  sourceComponentId: string | undefined,
  center: { x: number; y: number },
): AnyCircuitElement =>
  ({
    type: "pcb_component",
    pcb_component_id: id,
    source_component_id: sourceComponentId,
    center,
    layer: "top",
    rotation: 0,
    width: 1,
    height: 1,
  }) as unknown as AnyCircuitElement

const pcbPort = (
  id: string,
  componentId: string | undefined,
  x: number,
  y: number,
): AnyCircuitElement =>
  ({
    type: "pcb_port",
    pcb_port_id: id,
    pcb_component_id: componentId,
    layers: ["top"],
    x,
    y,
  }) as unknown as AnyCircuitElement

const smtPad = (
  id: string,
  componentId: string | undefined,
  portId: string,
  x: number,
  y: number,
  width = 0.6,
  height = 0.6,
): AnyCircuitElement =>
  ({
    type: "pcb_smtpad",
    pcb_smtpad_id: id,
    pcb_component_id: componentId,
    pcb_port_id: portId,
    layer: "top",
    shape: "rect",
    width,
    height,
    x,
    y,
  }) as unknown as AnyCircuitElement

const twoComponentCircuit = (): AnyCircuitElement[] => [
  sourceComponent("source_component_0", "R1", "simple_resistor"),
  sourceComponent("source_component_1", "C1", "simple_capacitor"),
  pcbComponent("pcb_component_0", "source_component_0", { x: 0, y: 0 }),
  pcbComponent("pcb_component_1", "source_component_1", { x: 10, y: 0 }),
  pcbPort("pcb_port_0", "pcb_component_0", -1, 0),
  pcbPort("pcb_port_1", "pcb_component_0", 1, 0),
  pcbPort("pcb_port_2", "pcb_component_1", 9, 0),
  pcbPort("pcb_port_3", "pcb_component_1", 11, 0),
  smtPad("pcb_smtpad_0", "pcb_component_0", "pcb_port_0", -1, 0, 0.6, 0.6),
  smtPad("pcb_smtpad_1", "pcb_component_0", "pcb_port_1", 1, 0, 0.6, 0.6),
  smtPad("pcb_smtpad_2", "pcb_component_1", "pcb_port_2", 9, 0, 0.4, 1.2),
  smtPad("pcb_smtpad_3", "pcb_component_1", "pcb_port_3", 11, 0, 0.4, 1.2),
]

describe("封装不丢（footprint preservation）", () => {
  it("每个 pcb_component 的 Footprint 引用都能在 .efoo / project.json 中闭合", () => {
    const { files, manifest } = convertPcb(twoComponentCircuit())
    const paths = byPath(files)
    const footprints = (manifest.footprints ?? {}) as Record<string, unknown>
    const epcb = findEpcb(files)

    const componentCount = parseLines(epcb).filter((row) => row[0] === "COMPONENT").length
    expect(componentCount).toBe(2)

    const uuids = footprintUuidsFromEpcb(epcb)
    expect(uuids.length).toBe(2)
    for (const uuid of uuids) {
      expect(paths.has(`FOOTPRINT/${uuid}.efoo`), `缺少 FOOTPRINT/${uuid}.efoo`).toBe(
        true,
      )
      expect(footprints[uuid], `project.json.footprints 缺少 ${uuid}`).toBeDefined()
    }
  })

  it("无 source_component_id 的元件仍产出 .efoo + COMPONENT，并告警", () => {
    const cj = [
      pcbComponent("pcb_component_orphan", undefined, { x: 0, y: 0 }),
    ]
    const { files, diagnostics } = convertPcb(cj)
    const paths = byPath(files)
    const epcb = findEpcb(files)

    expect(parseLines(epcb).some((row) => row[0] === "COMPONENT")).toBe(true)

    const uuids = footprintUuidsFromEpcb(epcb)
    expect(uuids.length).toBe(1)
    expect(paths.has(`FOOTPRINT/${uuids[0]}.efoo`)).toBe(true)

    expect(
      diagnostics.some((d) => d.code === "missing-source-component"),
    ).toBe(true)
  })

  it("0 焊盘 / 0 孔元件仍产出 .efoo 并告警 missing-footprint", () => {
    const cj = [
      sourceComponent("source_component_z", "Z1", "simple_thing"),
      pcbComponent("pcb_component_z", "source_component_z", { x: 0, y: 0 }),
    ]
    const { files, diagnostics } = convertPcb(cj)
    const paths = byPath(files)
    const uuids = footprintUuidsFromEpcb(findEpcb(files))

    expect(uuids.length).toBe(1)
    expect(paths.has(`FOOTPRINT/${uuids[0]}.efoo`)).toBe(true)
    expect(diagnostics.some((d) => d.code === "missing-footprint")).toBe(true)
  })

  it("不同焊盘几何的两个元件产出两个不同的 .efoo", () => {
    const cj = [
      sourceComponent("source_component_a", "A1", "simple_a"),
      sourceComponent("source_component_b", "B1", "simple_b"),
      pcbComponent("pcb_component_a", "source_component_a", { x: 0, y: 0 }),
      pcbComponent("pcb_component_b", "source_component_b", { x: 10, y: 0 }),
      pcbPort("pcb_port_a", "pcb_component_a", 0, 0),
      pcbPort("pcb_port_b", "pcb_component_b", 10, 0),
      smtPad("pcb_smtpad_a", "pcb_component_a", "pcb_port_a", 0, 0, 0.6, 0.6),
      smtPad("pcb_smtpad_b", "pcb_component_b", "pcb_port_b", 10, 0, 1.6, 0.4),
    ]
    const { files } = convertPcb(cj)
    const uuids = footprintUuidsFromEpcb(findEpcb(files))

    expect(uuids.length).toBe(2)
    expect(uuids[0]).not.toBe(uuids[1])
    expect(new Set(uuids).size).toBe(2)
  })

  it("焊盘缺 pcb_component_id 仅有 pcb_port_id 时仍归属到组件封装", () => {
    // pcb_port 故意排在焊盘之后，验证 pcb-index 的二次回填。
    const cj = [
      sourceComponent("source_component_p", "P1", "simple_p"),
      pcbComponent("pcb_component_p", "source_component_p", { x: 0, y: 0 }),
      smtPad("pcb_smtpad_p0", undefined, "pcb_port_p0", -1, 0),
      smtPad("pcb_smtpad_p1", undefined, "pcb_port_p1", 1, 0),
      pcbPort("pcb_port_p0", "pcb_component_p", -1, 0),
      pcbPort("pcb_port_p1", "pcb_component_p", 1, 0),
    ]
    const { files } = convertPcb(cj)
    const paths = byPath(files)
    const uuids = footprintUuidsFromEpcb(findEpcb(files))

    expect(uuids.length).toBe(1)
    const efoo = paths.get(`FOOTPRINT/${uuids[0]}.efoo`)
    expect(efoo).toBeDefined()
    const padRows = parseLines(efoo!).filter((row) => row[0] === "PAD")
    expect(padRows.length).toBe(2)
  })

  it("同一输入两次运行结果深度相等（确定性）", () => {
    const cj = twoComponentCircuit()
    const a = convertPcb(cj)
    const b = convertPcb(cj)
    expect(a.files).toEqual(b.files)
    expect(a.manifest).toEqual(b.manifest)
    expect(a.diagnostics).toEqual(b.diagnostics)
  })
})

// ---------------------------------------------------------------------------
// 对抗性加固：任何 pcb_component / 焊盘 / 孔都不得静默丢弃
// ---------------------------------------------------------------------------

const mil = (mm: number): number => Math.round((mm / 0.0254) * 1e6) / 1e6

const pcbPlatedHole = (
  id: string,
  componentId: string | undefined,
  x: number,
  y: number,
  outerDiameter = 0.8,
  holeDiameter = 0.4,
): AnyCircuitElement =>
  ({
    type: "pcb_plated_hole",
    pcb_plated_hole_id: id,
    pcb_component_id: componentId,
    shape: "circle",
    x,
    y,
    outer_diameter: outerDiameter,
    hole_diameter: holeDiameter,
    layers: ["top", "bottom"],
  }) as unknown as AnyCircuitElement

const pcbHole = (
  id: string,
  componentId: string | undefined,
  x: number,
  y: number,
  holeDiameter = 0.5,
): AnyCircuitElement =>
  ({
    type: "pcb_hole",
    pcb_hole_id: id,
    pcb_component_id: componentId,
    hole_shape: "circle",
    hole_diameter: holeDiameter,
    x,
    y,
  }) as unknown as AnyCircuitElement

const noIdPcbComponent = (center: { x: number; y: number }): AnyCircuitElement =>
  ({
    type: "pcb_component",
    center,
    width: 1,
    height: 1,
    layer: "top",
    rotation: 0,
  }) as unknown as AnyCircuitElement

/**
 * 按文件路径收集 `.efoo` / `.epcb` 的 PAD 行坐标键（`x,y`，mil）。
 *
 * 分文件收集而非合并，才能检测「同一几何同时出现在封装与板级」的重复。
 */
const padCoordinateKeysByFile = (files: EproFiles): Map<string, Set<string>> => {
  const byFile = new Map<string, Set<string>>()
  for (const file of files) {
    if (!file.path.endsWith(".efoo") && !file.path.endsWith(".epcb")) continue
    const keys = new Set<string>()
    for (const row of parseLines(file.content)) {
      if (row[0] !== "PAD") continue
      keys.add(`${row[6]},${row[7]}`)
    }
    byFile.set(file.path, keys)
  }
  return byFile
}

/** 所有 `.efoo` 与 `.epcb` 的 PAD 行坐标键并集（`x,y`，mil）。 */
const padCoordinateKeys = (files: EproFiles): Set<string> => {
  const keys = new Set<string>()
  for (const perFile of padCoordinateKeysByFile(files).values()) {
    for (const key of perFile) keys.add(key)
  }
  return keys
}

/**
 * 丝印层（TOP_SILK=3 / BOT_SILK=4）几何顶点键（`x,y`，mil）。
 *
 * 同时收集 POLY 顶点与 LINE 端点：板级 line 图元写成 `LINE`，
 * 封装内 line 图元烘成 `POLY`。
 */
const silkscreenGeometryKeys = (content: string): Set<string> => {
  const keys = new Set<string>()
  for (const row of parseLines(content)) {
    if (row[4] !== 3 && row[4] !== 4) continue
    if (row[0] === "POLY") {
      const points = Array.isArray(row[6]) ? (row[6] as unknown[]) : []
      for (let i = 0; i + 1 < points.length; ) {
        const x = points[i]
        const y = points[i + 1]
        if (typeof x === "number" && typeof y === "number") {
          keys.add(`${x},${y}`)
          i += 2
        } else {
          i += 1 // 跳过 "L" 分隔符
        }
      }
    } else if (row[0] === "LINE") {
      const [x1, y1, x2, y2] = [row[5], row[6], row[7], row[8]]
      if (typeof x1 === "number" && typeof y1 === "number") keys.add(`${x1},${y1}`)
      if (typeof x2 === "number" && typeof y2 === "number") keys.add(`${x2},${y2}`)
    }
  }
  return keys
}

const epcbPadCoordinateKeys = (files: EproFiles): Set<string> => {
  const keys = new Set<string>()
  const epcb = files.find((file) => file.path.endsWith(".epcb"))
  if (!epcb) return keys
  for (const row of parseLines(epcb.content)) {
    if (row[0] !== "PAD") continue
    keys.add(`${row[6]},${row[7]}`)
  }
  return keys
}

describe("对抗性：无 id / 孤儿元素不得静默丢弃", () => {
  it("无 pcb_component_id 的 pcb_component 仍产生 COMPONENT 并告警 missing-component-id", () => {
    const cj = [
      sourceComponent("source_component_keep", "K1", "simple_k"),
      pcbComponent("pcb_component_keep", "source_component_keep", { x: 0, y: 0 }),
      noIdPcbComponent({ x: 5, y: 0 }),
    ]
    const { files, diagnostics } = convertPcb(cj)
    const epcb = findEpcb(files)
    const componentRows = parseLines(epcb).filter((row) => row[0] === "COMPONENT")

    expect(componentRows.length).toBe(2)
    expect(diagnostics.some((d) => d.code === "missing-component-id")).toBe(true)

    // 两个 COMPONENT 都有可解析的 Footprint 引用。
    const uuids = footprintUuidsFromEpcb(epcb)
    expect(uuids.length).toBe(2)
    const paths = byPath(files)
    for (const uuid of uuids) {
      expect(paths.has(`FOOTPRINT/${uuid}.efoo`)).toBe(true)
    }
  })

  it("仅 pcb_port_id 归属但 pcb_port 无组件的焊盘作为独立 PAD 写入并告警 orphan-pad", () => {
    const cj = [
      sourceComponent("source_component_owner", "O1", "simple_o"),
      pcbComponent("pcb_component_owner", "source_component_owner", { x: 0, y: 0 }),
      pcbPort("pcb_port_orphan", undefined, 5, 5),
      smtPad("pcb_smtpad_orphan", undefined, "pcb_port_orphan", 5, 5, 0.5, 0.5),
    ]
    const { files, diagnostics } = convertPcb(cj)

    expect(epcbPadCoordinateKeys(files).has(`${mil(5)},${mil(5)}`)).toBe(true)
    expect(diagnostics.some((d) => d.code === "orphan-pad")).toBe(true)
  })

  it("pcb_component_id 指向不存在组件的孤儿焊盘作为独立 PAD 写入并告警 orphan-pad", () => {
    const cj = [
      sourceComponent("source_component_owner2", "O2", "simple_o"),
      pcbComponent("pcb_component_owner2", "source_component_owner2", { x: 0, y: 0 }),
      smtPad("pcb_smtpad_ghost", "pcb_component_ghost", "pcb_port_x", 7, 7, 0.7, 0.7),
    ]
    const { files, diagnostics } = convertPcb(cj)

    expect(epcbPadCoordinateKeys(files).has(`${mil(7)},${mil(7)}`)).toBe(true)
    expect(diagnostics.some((d) => d.code === "orphan-pad")).toBe(true)
  })

  it("总不变量：每个输入焊盘/孔至少出现在某个 .efoo 或 .epcb 的 PAD 行中", () => {
    const cj = [
      sourceComponent("source_component_b", "B1", "simple_b"),
      pcbComponent("pcb_component_b", "source_component_b", { x: 0, y: 0 }),
      pcbPort("pcb_port_b", "pcb_component_b", -1, 0),
      smtPad("pcb_smtpad_b", "pcb_component_b", "pcb_port_b", -1, 0, 0.6, 0.6),
      pcbPort("pcb_port_orphan2", undefined, 5, 5),
      smtPad("pcb_smtpad_orphan2", undefined, "pcb_port_orphan2", 5, 5, 0.5, 0.5),
      smtPad("pcb_smtpad_ghost2", "pcb_component_ghost2", "pcb_port_y", 7, 7, 0.7, 0.7),
      pcbPlatedHole("pcb_plated_hole_orphan", undefined, 9, 9),
      pcbHole("pcb_hole_orphan", undefined, 11, 11),
    ]
    const { files } = convertPcb(cj)
    const keys = padCoordinateKeys(files)

    const expectedCoordinates = [
      { x: -1, y: 0 }, // 归属组件的 SMT 焊盘（.efoo）
      { x: 5, y: 5 }, // 经 pcb_port 无组件的孤儿焊盘（.epcb）
      { x: 7, y: 7 }, // 指向 ghost 组件的孤儿焊盘（.epcb）
      { x: 9, y: 9 }, // 孤儿金属化孔（.epcb）
      { x: 11, y: 11 }, // 孤儿非金属化孔（.epcb）
    ]
    for (const coordinate of expectedCoordinates) {
      expect(
        keys.has(`${mil(coordinate.x)},${mil(coordinate.y)}`),
        `坐标 ${coordinate.x},${coordinate.y} 的焊盘/孔未出现在任何 PAD 行`,
      ).toBe(true)
    }
  })

  it("空封装且存在孤儿焊盘时，missing-footprint 文案提示已转为独立 PAD", () => {
    const cj = [
      sourceComponent("source_component_empty", "E1", "simple_e"),
      pcbComponent("pcb_component_empty", "source_component_empty", { x: 0, y: 0 }),
      pcbPort("pcb_port_e", undefined, 5, 5),
      smtPad("pcb_smtpad_e", undefined, "pcb_port_e", 5, 5, 0.5, 0.5),
    ]
    const { diagnostics } = convertPcb(cj)
    const missingFootprint = diagnostics.find((d) => d.code === "missing-footprint")
    expect(missingFootprint).toBeDefined()
    expect(missingFootprint?.message).toContain("独立 PAD")
  })
})

// ---------------------------------------------------------------------------
// 回归：丝印归属拆分（不得 .efoo/.epcb 双写）、椭圆丝印几何、孤儿焊盘网络
// ---------------------------------------------------------------------------

const pcbBoard = (
  width = 20,
  height = 20,
): AnyCircuitElement =>
  ({
    type: "pcb_board",
    pcb_board_id: "pcb_board_0",
    center: { x: 0, y: 0 },
    width,
    height,
    thickness: 1.6,
    num_layers: 2,
  }) as unknown as AnyCircuitElement

const silkLine = (
  id: string,
  componentId: string | undefined,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): AnyCircuitElement =>
  ({
    type: "pcb_silkscreen_line",
    pcb_silkscreen_line_id: id,
    pcb_component_id: componentId,
    layer: "top",
    x1,
    y1,
    x2,
    y2,
    stroke_width: 0.1,
  }) as unknown as AnyCircuitElement

const silkOval = (
  id: string,
  componentId: string | undefined,
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
): AnyCircuitElement =>
  ({
    type: "pcb_silkscreen_oval",
    pcb_silkscreen_oval_id: id,
    pcb_component_id: componentId,
    layer: "top",
    center: { x: cx, y: cy },
    radius_x: radiusX,
    radius_y: radiusY,
    ccw_rotation: 0,
  }) as unknown as AnyCircuitElement

const sourcePort = (
  id: string,
  componentId: string,
  pinNumber: number,
): AnyCircuitElement =>
  ({
    type: "source_port",
    source_port_id: id,
    source_component_id: componentId,
    pin_number: pinNumber,
    name: String(pinNumber),
  }) as unknown as AnyCircuitElement

const sourceNet = (id: string, name: string): AnyCircuitElement =>
  ({ type: "source_net", source_net_id: id, name }) as unknown as AnyCircuitElement

const sourceTraceElems = (
  id: string,
  portIds: string[],
  netIds: string[],
): AnyCircuitElement =>
  ({
    type: "source_trace",
    source_trace_id: id,
    connected_source_port_ids: portIds,
    connected_source_net_ids: netIds,
  }) as unknown as AnyCircuitElement

const pcbPortWithSource = (
  id: string,
  componentId: string | undefined,
  sourcePortId: string,
  x: number,
  y: number,
): AnyCircuitElement =>
  ({
    type: "pcb_port",
    pcb_port_id: id,
    pcb_component_id: componentId,
    source_port_id: sourcePortId,
    layers: ["top"],
    x,
    y,
  }) as unknown as AnyCircuitElement

/** 从顶点键集合计算包围盒跨度。 */
const keySpan = (keys: Set<string>): { width: number; height: number } => {
  const xs: number[] = []
  const ys: number[] = []
  for (const key of keys) {
    const [x, y] = key.split(",").map(Number)
    if (x !== undefined && Number.isFinite(x)) xs.push(x)
    if (y !== undefined && Number.isFinite(y)) ys.push(y)
  }
  if (xs.length === 0 || ys.length === 0) return { width: 0, height: 0 }
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

const findPadRow = (
  content: string,
  x: number,
  y: number,
): unknown[] | undefined =>
  parseLines(content).find(
    (row) => row[0] === "PAD" && row[6] === x && row[7] === y,
  )

describe("回归：椭圆丝印几何", () => {
  it("板级 pcb_silkscreen_oval 使用 radius_x/radius_y，产出非退化 POLY", () => {
    const cj = [
      pcbBoard(),
      silkOval("pcb_silkscreen_oval_0", "pcb_component_missing", 0, 0, 1, 0.5),
    ]
    const { files } = convertPcb(cj)
    const epcb = findEpcb(files)
    const span = keySpan(silkscreenGeometryKeys(epcb))

    expect(span.width).toBeCloseTo(mil(2), 3)
    expect(span.height).toBeCloseTo(mil(1), 3)
    expect(span.width).toBeGreaterThan(0)
    expect(span.height).toBeGreaterThan(0)
  })

  it("元件归属的 pcb_silkscreen_oval 烘入 .efoo 且非退化", () => {
    const cj = [
      sourceComponent("source_component_oval", "O1", "simple_o"),
      pcbComponent("pcb_component_oval", "source_component_oval", { x: 0, y: 0 }),
      silkOval("pcb_silkscreen_oval_1", "pcb_component_oval", 0, 0, 1, 0.5),
    ]
    const { files } = convertPcb(cj)
    const paths = byPath(files)
    const uuid = footprintUuidsFromEpcb(findEpcb(files))[0]!
    const efoo = paths.get(`FOOTPRINT/${uuid}.efoo`)!

    const span = keySpan(silkscreenGeometryKeys(efoo))
    expect(span.width).toBeCloseTo(mil(2), 3)
    expect(span.height).toBeCloseTo(mil(1), 3)
  })

  it("尺寸非法的 rect/oval/pill 不写退化几何且发 unsupported-element 告警", () => {
    const cj = [
      pcbBoard(),
      {
        type: "pcb_silkscreen_oval",
        pcb_silkscreen_oval_id: "pcb_silkscreen_oval_bad",
        pcb_component_id: "pcb_component_missing",
        layer: "top",
        center: { x: 0, y: 0 },
        radius_x: 0,
        radius_y: 0,
      } as unknown as AnyCircuitElement,
    ]
    const { files, diagnostics } = convertPcb(cj)
    const epcb = findEpcb(files)

    expect(keySpan(silkscreenGeometryKeys(epcb))).toEqual({ width: 0, height: 0 })
    expect(
      diagnostics.some((d) => d.code === "unsupported-element"),
    ).toBe(true)
  })
})

describe("回归：丝印不得同时写入 .efoo 与 .epcb", () => {
  it("元件归属的丝印只在 .efoo，板级丝印只在 .epcb", () => {
    const cj = [
      pcbBoard(),
      sourceComponent("source_component_silk", "S1", "simple_s"),
      pcbComponent("pcb_component_silk", "source_component_silk", { x: 0, y: 0 }),
      // 元件归属线：(0,0)-(5,5)mm
      silkLine("pcb_silkscreen_line_owned", "pcb_component_silk", 0, 0, 5, 5),
      // 板级线：(10,0)-(12,3)mm，无归属
      silkLine("pcb_silkscreen_line_board", undefined, 10, 0, 12, 3),
    ]
    const { files } = convertPcb(cj)
    const paths = byPath(files)
    const uuid = footprintUuidsFromEpcb(findEpcb(files))[0]!
    const efooKeys = silkscreenGeometryKeys(paths.get(`FOOTPRINT/${uuid}.efoo`)!)
    const epcbKeys = silkscreenGeometryKeys(findEpcb(files))

    const ownedKey = `${mil(5)},${mil(5)}`
    const boardKey = `${mil(10)},${mil(0)}`

    expect(efooKeys.has(ownedKey), "元件丝印应烘入 .efoo").toBe(true)
    expect(epcbKeys.has(ownedKey), "元件丝印不应出现在 .epcb").toBe(false)
    expect(epcbKeys.has(boardKey), "板级丝印应写入 .epcb").toBe(true)
    expect(efooKeys.has(boardKey), "板级丝印不应出现在 .efoo").toBe(false)
  })
})

describe("回归：孤儿焊盘网络字段", () => {
  it("已知网络的孤儿焊盘 PAD 第 4 字段非空且与 PAD_NET 网名一致", () => {
    const cj = [
      sourceComponent("source_component_net", "R1", "simple_resistor"),
      pcbComponent("pcb_component_net", "source_component_net", { x: 0, y: 0 }),
      sourcePort("source_port_net0", "source_component_net", 1),
      sourcePort("source_port_net1", "source_component_net", 2),
      sourceNet("source_net_vcc", "VCC"),
      sourceTraceElems(
        "source_trace_net",
        ["source_port_net0", "source_port_net1"],
        ["source_net_vcc"],
      ),
      pcbPortWithSource("pcb_port_net0", "pcb_component_net", "source_port_net0", 0, 0),
      smtPad("pcb_smtpad_net0", "pcb_component_net", "pcb_port_net0", 0, 0),
      pcbPortWithSource(
        "pcb_port_net_orphan",
        undefined,
        "source_port_net1",
        5,
        5,
      ),
      smtPad("pcb_smtpad_net_orphan", undefined, "pcb_port_net_orphan", 5, 5, 0.5, 0.5),
    ]
    const { files } = convertPcb(cj)
    const epcb = findEpcb(files)

    const padRow = findPadRow(epcb, mil(5), mil(5))
    expect(padRow).toBeDefined()
    expect(padRow?.[3]).toBe("VCC")

    const padNetNames = new Set(
      parseLines(epcb)
        .filter((row) => row[0] === "PAD_NET")
        .map((row) => row[3]),
    )
    expect(padNetNames.has("VCC")).toBe(true)
    expect(padNetNames.has(padRow?.[3] as string)).toBe(true)
  })

  it("无法确定网络的孤儿焊盘 PAD 第 4 字段留空并发告警", () => {
    const cj = [
      pcbPort("pcb_port_nonet", undefined, 7, 7),
      smtPad("pcb_smtpad_nonet", undefined, "pcb_port_nonet", 7, 7, 0.5, 0.5),
    ]
    const { files, diagnostics } = convertPcb(cj)

    const padRow = findPadRow(findEpcb(files), mil(7), mil(7))
    expect(padRow).toBeDefined()
    expect(padRow?.[3]).toBe("")
    expect(
      diagnostics.some((d) => d.message.includes("无法确定网络")),
    ).toBe(true)
  })
})

const silkText = (
  id: string,
  componentId: string | undefined,
  text: string,
  x: number,
  y: number,
  anchorAlignment = "center",
): AnyCircuitElement =>
  ({
    type: "pcb_silkscreen_text",
    pcb_silkscreen_text_id: id,
    pcb_component_id: componentId,
    layer: "top",
    anchor_position: { x, y },
    anchor_alignment: anchorAlignment,
    font_size: 0.4,
    text,
    ccw_rotation: 0,
  }) as unknown as AnyCircuitElement

/** 取某份文档里指定文本的 STRING 行。 */
const findStringRow = (
  content: string,
  text: string,
): unknown[] | undefined =>
  parseLines(content).find((row) => row[0] === "STRING" && row[6] === text)

describe("回归：位号承载形态（Designator ATTR，不得重复 STRING）", () => {
  it("位号经 .epcb 的 Designator ATTR（showValue=1）承载，且不再有重复 STRING", () => {
    // 输入含一条与该元件位号同名的 pcb_silkscreen_text（此前会在板级重复渲染）。
    const cj = [
      sourceComponent("source_component_ref", "R1", "simple_resistor"),
      pcbComponent("pcb_component_ref", "source_component_ref", { x: 0, y: 0 }),
      silkText("pcb_silkscreen_text_ref", "pcb_component_ref", "R1", 0, -1),
    ]
    const { files } = convertPcb(cj)
    const epcb = findEpcb(files)

    // 位号必须存在且唯一，并显式可见（showValue=1），否则 EDA 不渲染位号。
    const designators = parseLines(epcb).filter(
      (row) => row[0] === "ATTR" && row[7] === "Designator" && row[8] === "R1",
    )
    expect(designators.length).toBe(1)
    expect(designators[0]?.[10]).toBe(1)

    // 位号不得再以 STRING 形式重复渲染（.epcb 与 .efoo 皆然）。
    const refdesStrings: unknown[][] = []
    for (const file of files) {
      if (!file.path.endsWith(".efoo") && !file.path.endsWith(".epcb")) continue
      for (const row of parseLines(file.content)) {
        if (row[0] === "STRING" && row[6] === "R1") refdesStrings.push(row)
      }
    }
    expect(refdesStrings).toEqual([])
  })
})

/**
 * circuit-json `NinePointAnchor` 全 9 枚举 → 规范 `text/string.md` 第 13 字段
 * （0-based 12）期望值，顺序同规范：0 左顶 … 8 右底。
 */
const ANCHOR_CASES: Array<[string, number]> = [
  ["top_left", 0],
  ["top_center", 1],
  ["top_right", 2],
  ["center_left", 3],
  ["center", 4],
  ["center_right", 5],
  ["bottom_left", 6],
  ["bottom_center", 7],
  ["bottom_right", 8],
]

describe("回归：丝印文字对齐（九宫格全枚举，板级与封装侧同口径）", () => {
  it("板级文字 align 覆盖全部 9 个 anchor_alignment，且未知值回退 4", () => {
    const cj: AnyCircuitElement[] = [pcbBoard()]
    // ghost 归属 → 板级丝印；逐条放在不同 y 便于区分。
    ANCHOR_CASES.forEach(([anchor], i) => {
      cj.push(
        silkText(`t_${anchor}`, "pcb_component_missing", `T${i}`, 0, i, anchor),
      )
    })
    // 非法/未知取值 → 兜底 4（中）。
    cj.push(
      silkText("t_unknown", "pcb_component_missing", "T9", 0, 9, "not_an_anchor"),
    )

    const { files } = convertPcb(cj)
    const epcb = findEpcb(files)

    ANCHOR_CASES.forEach(([anchor, expected], i) => {
      expect(findStringRow(epcb, `T${i}`)?.[12], `板级 ${anchor}`).toBe(expected)
    })
    expect(findStringRow(epcb, "T9")?.[12], "未知值回退").toBe(4)
  })

  it("封装侧同一 anchor_alignment 取值与板级一致（全 9 枚举）", () => {
    const cj: AnyCircuitElement[] = [
      sourceComponent("source_component_logo", "S1", "simple_s"),
      pcbComponent("pcb_component_logo", "source_component_logo", { x: 0, y: 0 }),
    ]
    // 文本非位号（不会被 refdes 过滤），逐条不同 y。
    ANCHOR_CASES.forEach(([anchor], i) => {
      cj.push(silkText(`t_logo_${anchor}`, "pcb_component_logo", `L${i}`, 0, i, anchor))
    })

    const { files } = convertPcb(cj)
    const uuid = footprintUuidsFromEpcb(findEpcb(files))[0]!
    const efoo = byPath(files).get(`FOOTPRINT/${uuid}.efoo`)!

    ANCHOR_CASES.forEach(([anchor, expected], i) => {
      expect(findStringRow(efoo, `L${i}`)?.[12], `封装侧 ${anchor}`).toBe(expected)
    })
  })
})

describe("回归：焊盘模板/实例分工（文档化不变量）", () => {
  // 官方样例证据：
  // - `21bf3cb7…epcb`：3 COMPONENT / 2 PAD / 6 PAD_NET，2 条 PAD 均为
  //   无元件归属的独立焊盘（layer 12 / 测试点 TP1）；`de0a8…epcb`：0 PAD / 6 PAD_NET。
  // - 官方 3 个 `.efoo` 各含 2 条 PAD（封装模板）。
  // 即：元件焊盘只作为 `.efoo` 模板存在，`.epcb` 经 `PAD_NET` 引用；
  // `PAD` 行仅写无归属的独立/孤儿焊盘。两处**不应**为同一焊盘各写一次。
  it("元件焊盘只在 .efoo，孤儿焊盘只在 .epcb，二者不重复", () => {
    const cj = [
      pcbBoard(),
      sourceComponent("source_component_pad", "R1", "simple_resistor"),
      pcbComponent("pcb_component_pad", "source_component_pad", { x: 0, y: 0 }),
      pcbPort("pcb_port_pad", "pcb_component_pad", 1, 0),
      smtPad("pcb_smtpad_pad", "pcb_component_pad", "pcb_port_pad", 1, 0, 0.6, 0.6),
      // 无归属独立焊盘
      pcbPort("pcb_port_free", undefined, 8, 8),
      smtPad("pcb_smtpad_free", undefined, "pcb_port_free", 8, 8, 0.6, 0.6),
    ]
    const { files } = convertPcb(cj)
    const byFile = padCoordinateKeysByFile(files)
    const epcbPath = files.find((f) => f.path.endsWith(".epcb"))!.path
    const efooPath = files.find((f) => f.path.endsWith(".efoo"))!.path
    const epcbKeys = byFile.get(epcbPath)!
    const efooKeys = byFile.get(efooPath)!

    // 元件焊盘（center=0,0 → 局部坐标等于世界坐标）只出现在 .efoo 模板。
    expect(efooKeys.has(`${mil(1)},${mil(0)}`)).toBe(true)
    expect(epcbKeys.has(`${mil(1)},${mil(0)}`)).toBe(false)
    // 孤儿焊盘只出现在 .epcb 实例。
    expect(epcbKeys.has(`${mil(8)},${mil(8)}`)).toBe(true)
    expect(efooKeys.has(`${mil(8)},${mil(8)}`)).toBe(false)
    // .epcb 以 PAD_NET 引用封装内焊盘，而非复制 PAD 行。
    expect(parseLines(findEpcb(files)).some((row) => row[0] === "PAD_NET")).toBe(
      true,
    )
  })
})
