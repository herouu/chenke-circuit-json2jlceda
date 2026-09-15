import { describe, expect, it } from "vitest"
import type { AnyCircuitElement } from "circuit-json"
import { createConversionContext } from "../src/context"
import { convertCircuitJsonToEproFiles } from "../src/index"
import {
  MAX_FIT,
  USABLE_BOX,
  computeSchematicContentBBox,
  getSchematicLayout,
} from "../src/schematic/layout"
import { SCH_UNITS_PER_MM, transformPoint } from "../src/units"

type Vec = { x: number; y: number }

const parseLines = (content: string): unknown[][] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown[])

const byPath = (files: { path: string; content: string }[]): Map<string, string> =>
  new Map(files.map((file) => [file.path, file.content] as const))

const within = (point: Vec, tolerance = 1): boolean =>
  point.x >= USABLE_BOX.minX - tolerance &&
  point.x <= USABLE_BOX.maxX + tolerance &&
  point.y >= USABLE_BOX.minY - tolerance &&
  point.y <= USABLE_BOX.maxY + tolerance

// --- circuit-json builders -------------------------------------------------

const sourceComponent = (id: string, name: string, ftype = "simple_thing"): AnyCircuitElement =>
  ({
    type: "source_component",
    source_component_id: id,
    name,
    ftype,
  }) as unknown as AnyCircuitElement

const sourcePort = (
  id: string,
  componentId: string,
  pinNumber: number,
  hints: string[],
): AnyCircuitElement =>
  ({
    type: "source_port",
    source_port_id: id,
    name: `pin${pinNumber}`,
    pin_number: pinNumber,
    port_hints: [String(pinNumber), ...hints],
    source_component_id: componentId,
  }) as unknown as AnyCircuitElement

const schematicComponent = (
  id: string,
  componentId: string,
  center: Vec,
  size: { width: number; height: number },
): AnyCircuitElement =>
  ({
    type: "schematic_component",
    schematic_component_id: id,
    center,
    size,
    source_component_id: componentId,
    is_box_with_pins: true,
  }) as unknown as AnyCircuitElement

const schematicPort = (
  id: string,
  componentId: string,
  sourcePortId: string,
  center: Vec,
  facing: "left" | "right" | "up" | "down",
  pinNumber: number,
  distanceFromEdge = 0.4,
): AnyCircuitElement =>
  ({
    type: "schematic_port",
    schematic_port_id: id,
    schematic_component_id: componentId,
    center,
    source_port_id: sourcePortId,
    facing_direction: facing,
    distance_from_component_edge: distanceFromEdge,
    pin_number: pinNumber,
  }) as unknown as AnyCircuitElement

const schematicTrace = (id: string, edges: Array<{ from: Vec; to: Vec }>): AnyCircuitElement =>
  ({
    type: "schematic_trace",
    schematic_trace_id: id,
    source_trace_id: id,
    edges,
    junctions: [],
  }) as unknown as AnyCircuitElement

/** 一个带左右两个引脚的元件。 */
function twoPinComponent(
  index: number,
  center: Vec,
  size: { width: number; height: number },
): {
  elements: AnyCircuitElement[]
  left: Vec
  right: Vec
  componentId: string
} {
  const componentId = `source_component_${index}`
  const left = { x: center.x - size.width / 2, y: center.y }
  const right = { x: center.x + size.width / 2, y: center.y }
  return {
    componentId,
    left,
    right,
    elements: [
      sourceComponent(componentId, `U${index}`, "simple_box"),
      sourcePort(`source_port_${index}_a`, componentId, 1, ["left", "pos"]),
      sourcePort(`source_port_${index}_b`, componentId, 2, ["right", "neg"]),
      schematicComponent(`schematic_component_${index}`, componentId, center, size),
      schematicPort(
        `schematic_port_${index}_a`,
        `schematic_component_${index}`,
        `source_port_${index}_a`,
        left,
        "left",
        1,
      ),
      schematicPort(
        `schematic_port_${index}_b`,
        `schematic_component_${index}`,
        `source_port_${index}_b`,
        right,
        "right",
        2,
      ),
    ],
  }
}

/** 从 `schematic_component` 元素数组推导包围盒（mm），用于对照布局计算。 */
const boxFromComponents = (
  components: Array<{ center: Vec; size: { width: number; height: number } }>,
): { minX: number; minY: number; maxX: number; maxY: number } => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const component of components) {
    minX = Math.min(minX, component.center.x - component.size.width / 2)
    minY = Math.min(minY, component.center.y - component.size.height / 2)
    maxX = Math.max(maxX, component.center.x + component.size.width / 2)
    maxY = Math.max(maxY, component.center.y + component.size.height / 2)
  }
  return { minX, minY, maxX, maxY }
}

describe("原理图布局（schematic layout）", () => {
  it("内容与本体角点全部落在可用区（不出框）", () => {
    const positions = [
      { x: -40, y: 40 },
      { x: -40, y: 0 },
      { x: -40, y: -40 },
      { x: 0, y: 40 },
      { x: 0, y: -40 },
      { x: 40, y: 40 },
      { x: 40, y: -40 },
    ]
    const size = { width: 3, height: 2 }
    const parts = positions.map((center, index) => twoPinComponent(index, center, size))
    const cj: AnyCircuitElement[] = parts.flatMap((part) => part.elements)
    // 一条跨越全图的导线，纳入内容包围盒。
    cj.push(schematicTrace("schematic_trace_span", [
      { from: parts[1]!.left, to: parts[6]!.right },
    ]))

    const ctx = createConversionContext(cj, { includePcb: false })
    const layout = getSchematicLayout(ctx)
    const contentBox = computeSchematicContentBBox(ctx)

    // 布局包围盒完整覆盖所有元件本体范围。
    const bodyBox = boxFromComponents(positions.map((center) => ({ center, size })))
    expect(contentBox.minX).toBeLessThanOrEqual(bodyBox.minX)
    expect(contentBox.minY).toBeLessThanOrEqual(bodyBox.minY)
    expect(contentBox.maxX).toBeGreaterThanOrEqual(bodyBox.maxX)
    expect(contentBox.maxY).toBeGreaterThanOrEqual(bodyBox.maxY)

    // 生成 .esch 并核对所有非图框 COMPONENT 中心。
    const { files } = convertCircuitJsonToEproFiles(cj, {
      includePcb: false,
      title: "layout-fit",
    })
    const esch = [...byPath(files)].find(
      ([path]) => path.startsWith("SHEET/") && path.endsWith(".esch"),
    )?.[1]
    expect(esch).toBeDefined()

    const componentRows = parseLines(esch!).filter((row) => row[0] === "COMPONENT")
    // 首行恒为 A4 图框 COMPONENT（0,0）。
    const contentRows = componentRows.slice(1)
    expect(contentRows.length).toBe(positions.length)

    for (let index = 0; index < positions.length; index++) {
      const rowIndex = index
      const expected = transformPoint(positions[rowIndex]!, layout)
      const row = contentRows[rowIndex]!
      expect(Number(row[3])).toBeCloseTo(expected.x, 6)
      expect(Number(row[4])).toBeCloseTo(expected.y, 6)
      expect(within({ x: Number(row[3]), y: Number(row[4]) }), `组件 ${rowIndex} 中心出框`).toBe(true)

      // 本体四角（中心 ± size/2 × scale）。
      const halfW = (size.width / 2) * layout.scale
      const halfH = (size.height / 2) * layout.scale
      const center = { x: Number(row[3]), y: Number(row[4]) }
      for (const corner of [
        { x: center.x - halfW, y: center.y - halfH },
        { x: center.x + halfW, y: center.y - halfH },
        { x: center.x - halfW, y: center.y + halfH },
        { x: center.x + halfW, y: center.y + halfH },
      ]) {
        expect(within(corner), `组件 ${rowIndex} 本体角点出框`).toBe(true)
      }
    }
  })

  it("引脚端点与导线端点严格对位", () => {
    const a = twoPinComponent(0, { x: 0, y: 0 }, { width: 2, height: 2 })
    const b = twoPinComponent(1, { x: 20, y: 0 }, { width: 2, height: 2 })
    const cj: AnyCircuitElement[] = [
      ...a.elements,
      ...b.elements,
      schematicTrace("schematic_trace_0", [{ from: a.right, to: b.left }]),
      schematicTrace("schematic_trace_1", [{ from: a.left, to: b.right }]),
    ]

    const { files, manifest } = convertCircuitJsonToEproFiles(cj, {
      includePcb: false,
      title: "layout-pins",
    })
    const paths = byPath(files)
    const esch = [...paths].find(
      ([path]) => path.startsWith("SHEET/") && path.endsWith(".esch"),
    )?.[1]
    expect(esch).toBeDefined()

    const rows = parseLines(esch!)
    const centers = new Map<string, Vec>()
    const deviceByComponent = new Map<string, string>()
    let current = ""
    const wireVertices: Vec[] = []
    for (const row of rows) {
      if (row[0] === "COMPONENT") {
        current = String(row[1])
        centers.set(current, { x: Number(row[3]), y: Number(row[4]) })
      } else if (row[0] === "ATTR" && row[2] === current && row[3] === "Device") {
        deviceByComponent.set(current, String(row[4]))
      } else if (row[0] === "WIRE") {
        for (const polyline of (row[2] as number[][]) ?? []) {
          for (let i = 0; i + 1 < polyline.length; i += 2) {
            wireVertices.push({ x: polyline[i]!, y: polyline[i + 1]! })
          }
        }
      }
    }

    const devices = manifest.devices as Record<string, { attributes?: Record<string, string> }>
    const layout = getSchematicLayout(
      createConversionContext(cj, { includePcb: false }),
    )
    const positions = [a, b]
    let checkedPins = 0

    // 按中心查找每个 COMPONENT 的 Device → Symbol → .esym。
    for (const part of positions) {
      const componentCenter = transformPoint(
        { x: (part.left.x + part.right.x) / 2, y: part.left.y },
        layout,
      )
      const match = [...centers.entries()].find(
        ([, center]) =>
          Math.abs(center.x - componentCenter.x) < 1e-6 &&
          Math.abs(center.y - componentCenter.y) < 1e-6,
      )
      expect(match, `找不到中心 ${JSON.stringify(componentCenter)} 的 COMPONENT`).toBeDefined()
      const [componentId, center] = match!
      const deviceUuid = deviceByComponent.get(componentId)
      expect(deviceUuid).toBeDefined()
      const symbolUuid = devices[deviceUuid!]?.attributes?.Symbol
      expect(symbolUuid).toBeDefined()
      const esym = paths.get(`SYMBOL/${symbolUuid}.esym`)
      expect(esym).toBeDefined()
      const pins = parseLines(esym!).filter((row) => row[0] === "PIN")
      expect(pins.length).toBe(2)
      for (const pin of pins) {
        const endpoint = { x: center.x + Number(pin[4]), y: center.y + Number(pin[5]) }
        const aligned = wireVertices.some(
          (vertex) =>
            Math.abs(vertex.x - endpoint.x) < 0.01 &&
            Math.abs(vertex.y - endpoint.y) < 0.01,
        )
        expect(aligned, `引脚端点 ${JSON.stringify(endpoint)} 未与导线对齐`).toBe(true)
        checkedPins++
      }
    }
    expect(checkedPins).toBe(4)
  })

  it("引脚长度不横穿本体且大于 0", () => {
    const part = twoPinComponent(0, { x: 0, y: 0 }, { width: 6, height: 4 })
    const cj = part.elements
    const { files, manifest } = convertCircuitJsonToEproFiles(cj, {
      includePcb: false,
      title: "layout-pin-length",
    })
    const paths = byPath(files)

    // 找到唯一符号（+ A4 图框符号）。
    const devices = manifest.devices as Record<string, { attributes?: Record<string, string> }>
    const symbolUuid = Object.values(devices)
      .map((device) => device.attributes?.Symbol)
      .find((uuid) => uuid && uuid !== "6644fff3ec4746afad9f4bc9616a8eee")
    expect(symbolUuid).toBeDefined()
    const esym = paths.get(`SYMBOL/${symbolUuid}.esym`)
    expect(esym).toBeDefined()

    const rows = parseLines(esym!)
    const pins = rows.filter((row) => row[0] === "PIN")
    const rect = rows.find((row) => row[0] === "RECT") as unknown[] | undefined
    expect(rect).toBeDefined()
    const bodyMinX = Math.min(Number(rect![2]), Number(rect![4]))
    const bodyMaxX = Math.max(Number(rect![2]), Number(rect![4]))

    const ctx = createConversionContext(cj, { includePcb: false })
    const layout = getSchematicLayout(ctx)
    const expectedPinLength = 0.4 * layout.scale

    expect(pins.length).toBe(2)
    for (const pin of pins) {
      const x = Number(pin[4])
      const rotation = Number(pin[7])
      const length = Number(pin[6])
      expect(length).toBeGreaterThan(0)
      // 不再硬编码 10：应≈ distance_from_component_edge × scale。
      expect(length).toBeCloseTo(expectedPinLength, 4)
      // 连接点 → 本体边缘的实际距离不小于引脚长度（不横穿本体）。
      const bodyEdge = rotation === 0 ? bodyMinX : bodyMaxX
      const distanceToBody = Math.abs(x - bodyEdge)
      expect(length).toBeLessThanOrEqual(distanceToBody + 0.01)
    }
  })

  it("超宽内容触发等比缩小，并发出 fit 诊断，且仍在可用区内", () => {
    const a = twoPinComponent(0, { x: -200, y: 0 }, { width: 4, height: 4 })
    const b = twoPinComponent(1, { x: 200, y: 0 }, { width: 4, height: 4 })
    const cj: AnyCircuitElement[] = [...a.elements, ...b.elements]

    const ctx = createConversionContext(cj, { includePcb: false })
    const layout = getSchematicLayout(ctx)
    expect(layout.fit).toBeLessThan(1)
    expect(layout.fit).toBeGreaterThanOrEqual(0.05)

    const { files, diagnostics } = convertCircuitJsonToEproFiles(cj, {
      includePcb: false,
      title: "layout-shrink",
    })
    const fitDiagnostic = diagnostics.find((d) => d.code === "layout-scaled")
    expect(fitDiagnostic).toBeDefined()
    expect(fitDiagnostic?.severity).toBe("info")

    const esch = [...byPath(files)].find(
      ([path]) => path.startsWith("SHEET/") && path.endsWith(".esch"),
    )?.[1]
    const contentRows = parseLines(esch!).filter((row) => row[0] === "COMPONENT").slice(1)
    expect(contentRows.length).toBe(2)
    for (const row of contentRows) {
      const center = { x: Number(row[3]), y: Number(row[4]) }
      expect(within(center), `缩放后组件中心 ${JSON.stringify(center)} 出框`).toBe(true)
      const halfW = 2 * layout.scale
      const halfH = 2 * layout.scale
      for (const corner of [
        { x: center.x - halfW, y: center.y - halfH },
        { x: center.x + halfW, y: center.y + halfH },
      ]) {
        expect(within(corner), `缩放后本体角点 ${JSON.stringify(corner)} 出框`).toBe(true)
      }
    }
  })

  it("内容很小时等比放大（fit > 1，scale = 基准 × fit）", () => {
    const part = twoPinComponent(0, { x: 0, y: 0 }, { width: 1, height: 1 })
    const ctx = createConversionContext(part.elements, { includePcb: false })
    const layout = getSchematicLayout(ctx)
    // 内容远小于可用区：允许放大填满，但不超过 MAX_FIT。
    expect(layout.fit).toBeGreaterThan(1)
    expect(layout.fit).toBeLessThanOrEqual(MAX_FIT)
    expect(layout.scale).toBeCloseTo(SCH_UNITS_PER_MM * layout.fit, 12)

    const { diagnostics } = convertCircuitJsonToEproFiles(part.elements, {
      includePcb: false,
      title: "layout-tiny",
    })
    const fitDiagnostic = diagnostics.find((d) => d.code === "layout-scaled")
    expect(fitDiagnostic).toBeDefined()
    expect(fitDiagnostic?.severity).toBe("info")
  })
})
