import { describe, expect, it } from "vitest"
import type { AnyCircuitElement } from "circuit-json"
import { convertCircuitJsonToEproFiles } from "../src/index"

type EproFiles = { path: string; content: string }[]

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

const convertPcb = (cj: AnyCircuitElement[]) =>
  convertCircuitJsonToEproFiles(cj, { title: "traces", includeSchematic: false })

const board = (): AnyCircuitElement =>
  ({
    type: "pcb_board",
    pcb_board_id: "pcb_board_0",
    center: { x: 0, y: 0 },
    width: 40,
    height: 40,
    thickness: 1.6,
    num_layers: 2,
  }) as unknown as AnyCircuitElement

const mil = (mm: number): number => Math.round((mm / 0.0254) * 1e6) / 1e6

const rowsOfType = (epcb: string, type: string): unknown[][] =>
  parseLines(epcb).filter((row) => row[0] === type)

const layer11PolyCount = (epcb: string): number =>
  rowsOfType(epcb, "POLY").filter((row) => row[4] === 11).length

/** `.epcb` 中已声明的 LAYER 层号集合。 */
const declaredLayerIds = (epcb: string): Set<number> =>
  new Set(
    rowsOfType(epcb, "LAYER")
      .map((row) => row[1])
      .filter((id): id is number => typeof id === "number"),
  )

// --- 网表构造用 helper -----------------------------------------------------

const sourceNet = (id: string, name: string): AnyCircuitElement =>
  ({ type: "source_net", source_net_id: id, name }) as unknown as AnyCircuitElement

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

const pcbTrace = (id: string, route: unknown[], sourceTraceId?: string) =>
  ({
    type: "pcb_trace",
    pcb_trace_id: id,
    source_trace_id: sourceTraceId,
    route,
  }) as unknown as AnyCircuitElement

const wire = (x: number, y: number, layer?: string) => ({
  route_type: "wire",
  x,
  y,
  width: 0.2,
  ...(layer === undefined ? {} : { layer }),
})

const viaPoint = (
  x: number,
  y: number,
  opts: { hole?: number; outer?: number } = {},
) => ({
  route_type: "via",
  x,
  y,
  from_layer: "top",
  to_layer: "bottom",
  ...(opts.hole === undefined ? {} : { hole_diameter: opts.hole }),
  ...(opts.outer === undefined ? {} : { outer_diameter: opts.outer }),
})

const throughPad = (
  start: { x: number; y: number },
  end: { x: number; y: number },
  startLayer?: unknown,
  endLayer?: unknown,
  width = 0.2,
) => ({
  route_type: "through_pad",
  start,
  end,
  width,
  ...(startLayer === undefined ? {} : { start_layer: startLayer }),
  ...(endLayer === undefined ? {} : { end_layer: endLayer }),
})

describe("pcb_trace through_pad：铜层不得落到 MULTI(12)", () => {
  it("through_pad 在 start_layer/end_layer 输出 LINE，且无 layer 12", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_tp", [
        throughPad({ x: 0, y: 0 }, { x: 2, y: 0 }, "top", "bottom"),
      ]),
    ]
    const lines = rowsOfType(findEpcb(convertPcb(cj).files), "LINE")

    expect(lines.map((row) => row[4]).sort()).toEqual([1, 2])
    expect(lines.some((row) => row[4] === 12)).toBe(false)
  })

  it("start_layer 与 end_layer 相同则只输出一段 LINE", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_tp_same", [
        throughPad({ x: 0, y: 0 }, { x: 1, y: 0 }, "top", "top"),
      ]),
    ]
    const lines = rowsOfType(findEpcb(convertPcb(cj).files), "LINE")
    expect(lines.length).toBe(1)
    expect(lines[0]?.[4]).toBe(1)
  })
})

describe("N1 through_pad 缺层/非法层：告警并跳过，不得回退 TOP", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["两字段都缺", undefined, undefined],
    ["只缺 end_layer", "top", undefined],
    ["两字段非法", "foo", "bar"],
    ["start 非法、end 合法", "foo", "bottom"],
  ]

  for (const [label, startLayer, endLayer] of cases) {
    it(`${label} → invalid-trace 告警且不产出 LINE`, () => {
      const cj = [
        board(),
        pcbTrace("pcb_trace_bad_layer", [
          throughPad({ x: 0, y: 0 }, { x: 2, y: 0 }, startLayer, endLayer),
        ]),
      ]
      const { files, diagnostics } = convertPcb(cj)

      expect(rowsOfType(findEpcb(files), "LINE").length).toBe(0)
      expect(diagnostics.some((d) => d.code === "invalid-trace")).toBe(true)
      // 明确点出字段与原始值，便于定位。
      expect(
        diagnostics.some((d) => d.message.includes("through_pad")),
      ).toBe(true)
    })
  }
})

describe("N5 wire 缺层/非法层：措辞准确，不得当作 layer 1", () => {
  it("wire 缺 layer → 告警表述为「缺少或非法 layer」，不误报跨层", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_no_layer", [wire(0, 0, "bottom"), wire(1, 0)]),
    ]
    const { files, diagnostics } = convertPcb(cj)

    expect(rowsOfType(findEpcb(files), "LINE").length).toBe(0)
    expect(
      diagnostics.some((d) => d.message.includes("缺少或非法 layer")),
    ).toBe(true)
    // 修复前会误报「跨层（layer 2 -> 1）」。
    expect(diagnostics.some((d) => d.message.includes("跨层"))).toBe(false)
  })
})

describe("N2 内层引用：按需补写 LAYER 声明", () => {
  it("inner3/inner5 被引用时补写 LAYER 17/19，且声明覆盖所有 LINE 层", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_inner", [
        throughPad({ x: 0, y: 0 }, { x: 2, y: 0 }, "inner3", "inner5"),
      ]),
    ]
    const epcb = findEpcb(convertPcb(cj).files)
    const declared = declaredLayerIds(epcb)
    const lineLayers = rowsOfType(epcb, "LINE").map((row) => row[4] as number)

    expect(lineLayers.sort()).toEqual([17, 19])
    expect(declared.has(17)).toBe(true)
    expect(declared.has(19)).toBe(true)
    for (const layer of lineLayers) {
      expect(declared.has(layer), `LINE 引用的 layer ${layer} 未声明`).toBe(true)
    }
  })

  it("不使用内层时不额外声明 17..46（保持输出不变）", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_outer", [wire(0, 0, "top"), wire(1, 0, "top")]),
    ]
    const declared = declaredLayerIds(findEpcb(convertPcb(cj).files))
    expect(declared.has(17)).toBe(false)
    expect(declared.has(46)).toBe(false)
  })
})

describe("E2 跨层告警后 prev 复位：后续同层段仍保留", () => {
  it("top->bottom 告警后，bottom 相邻段正常产出", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_reset", [
        wire(0, 0, "top"),
        wire(1, 0, "bottom"),
        wire(2, 0, "bottom"),
      ]),
    ]
    const { files, diagnostics } = convertPcb(cj)
    const lines = rowsOfType(findEpcb(files), "LINE")

    expect(lines.length).toBe(1)
    expect(lines[0]?.[4]).toBe(2)
    expect(lines[0]?.[5]).toBe(mil(1))
    expect(lines[0]?.[7]).toBe(mil(2))
    expect(diagnostics.some((d) => d.code === "invalid-trace")).toBe(true)
  })
})

describe("route 内 via 点缺少 pcb_via：回退生成 VIA 行", () => {
  it("无 pcb_via 时用 via 点字段回退生成一条 VIA 并告警 missing-via", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_v", [
        wire(0, 0, "top"),
        viaPoint(1, 0, { hole: 0.3, outer: 0.7 }),
        wire(1, 0, "bottom"),
      ]),
    ]
    const { files, diagnostics } = convertPcb(cj)
    const vias = rowsOfType(findEpcb(files), "VIA")

    expect(vias.length).toBe(1)
    expect(vias[0]?.[5]).toBe(mil(1))
    expect(vias[0]?.[7]).toBe(mil(0.3))
    expect(vias[0]?.[8]).toBe(mil(0.7))
    expect(diagnostics.some((d) => d.code === "missing-via")).toBe(true)
  })

  it("有 pcb_via 时不重复生成（对照组：去掉 pcb_via 必须回退生成）", () => {
    const route = [viaPoint(1, 0, { hole: 0.3, outer: 0.7 })]
    const withVia = convertPcb([
      board(),
      pcbTrace("pcb_trace_v2", route),
      {
        type: "pcb_via",
        pcb_via_id: "pcb_via_1",
        x: 1,
        y: 0,
        hole_diameter: 0.3,
        outer_diameter: 0.7,
        layers: ["top", "bottom"],
        pcb_trace_id: "pcb_trace_v2",
      } as unknown as AnyCircuitElement,
    ])
    const withoutVia = convertPcb([board(), pcbTrace("pcb_trace_v2", route)])

    // 对照组：无 pcb_via 必须回退出一条（旧实现为 0，故本断言有鉴别力）。
    expect(rowsOfType(findEpcb(withoutVia.files), "VIA").length).toBe(1)
    expect(withoutVia.diagnostics.some((d) => d.code === "missing-via")).toBe(
      true,
    )
    // 有 pcb_via：恰好一条，且不产生 missing-via。
    expect(rowsOfType(findEpcb(withVia.files), "VIA").length).toBe(1)
    expect(withVia.diagnostics.some((d) => d.code === "missing-via")).toBe(false)
  })
})

describe("E3/N3 route via 去重：完整身份（坐标+孔径）", () => {
  it("同坐标不同孔径（无 pcb_via）→ 两条 VIA，各自孔径正确", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_multi", [
        viaPoint(1, 0, { hole: 0.3, outer: 0.7 }),
        viaPoint(1, 0, { hole: 0.6, outer: 1.2 }),
      ]),
    ]
    const { files } = convertPcb(cj)
    const vias = rowsOfType(findEpcb(files), "VIA")

    expect(vias.length).toBe(2)
    expect(vias.map((row) => row[7]).sort((a, b) => Number(a) - Number(b))).toEqual([
      mil(0.3),
      mil(0.6),
    ])
    expect(vias.map((row) => row[8]).sort((a, b) => Number(a) - Number(b))).toEqual([
      mil(0.7),
      mil(1.2),
    ])
  })

  it("不同坐标（无 pcb_via）→ 两条 VIA", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_two_coords", [
        viaPoint(1, 0, { hole: 0.3, outer: 0.7 }),
        viaPoint(5, 0, { hole: 0.3, outer: 0.7 }),
      ]),
    ]
    expect(rowsOfType(findEpcb(convertPcb(cj).files), "VIA").length).toBe(2)
  })

  it("跨 trace 同坐标同孔径被合并时发出告警（不静默）", () => {
    const cj = [
      board(),
      pcbTrace("pcb_trace_a", [viaPoint(1, 0, { hole: 0.3, outer: 0.7 })]),
      pcbTrace("pcb_trace_b", [viaPoint(1, 0, { hole: 0.3, outer: 0.7 })]),
    ]
    const { files, diagnostics } = convertPcb(cj)
    expect(rowsOfType(findEpcb(files), "VIA").length).toBe(1)
    expect(
      diagnostics.some(
        (d) => d.code === "invalid-trace" && d.message.includes("已合并"),
      ),
    ).toBe(true)
  })
})

describe("N4 via 网名：回填与冲突", () => {
  // 注意：两条 source_trace 必须使用**不同**端口，否则会被 source-index 按
  // 物理连通域合并为同一网络（同一组内命名取排序最小，会得到 GND）。
  const netCircuit = (viaNetTraceId: string, routeTraceId: string): AnyCircuitElement[] => [
    board(),
    sourceComponent("source_component_n", "R1", "simple_resistor"),
    sourcePort("source_port_n0", "source_component_n", 1),
    sourcePort("source_port_n1", "source_component_n", 2),
    sourceNet("source_net_vcc", "VCC"),
    sourceNet("source_net_gnd", "GND"),
    sourceTraceElems("source_trace_vcc", ["source_port_n0"], ["source_net_vcc"]),
    sourceTraceElems("source_trace_gnd", ["source_port_n1"], ["source_net_gnd"]),
    pcbTrace(
      routeTraceId,
      [viaPoint(1, 0, { hole: 0.3, outer: 0.7 })],
      "source_trace_vcc",
    ),
    {
      type: "pcb_via",
      pcb_via_id: "pcb_via_net",
      x: 1,
      y: 0,
      hole_diameter: 0.3,
      outer_diameter: 0.7,
      layers: ["top", "bottom"],
      ...(viaNetTraceId ? { source_trace_id: viaNetTraceId } : {}),
    } as unknown as AnyCircuitElement,
  ]

  it("pcb_via 无网信息 + route 有网名 → VIA 网名回填为 route 的网名", () => {
    const { files } = convertPcb(netCircuit("", "pcb_trace_net"))
    const vias = rowsOfType(findEpcb(files), "VIA")

    expect(vias.length).toBe(1)
    expect(vias[0]?.[3]).toBe("VCC")
  })

  it("pcb_via 网名与 route 网名冲突 → 告警说明被忽略的字段", () => {
    const { files, diagnostics } = convertPcb(
      netCircuit("source_trace_gnd", "pcb_trace_net"),
    )
    const vias = rowsOfType(findEpcb(files), "VIA")

    expect(vias.length).toBe(1)
    expect(vias[0]?.[3]).toBe("GND")
    expect(
      diagnostics.some(
        (d) => d.code === "invalid-trace" && d.message.includes("网名"),
      ),
    ).toBe(true)
  })
})

describe("pcb_cutout：收集并告警，不猜测几何", () => {
  const cutout = (id: string, shape: string, extra: Record<string, unknown>) =>
    ({
      type: "pcb_cutout",
      pcb_cutout_id: id,
      shape,
      ...extra,
    }) as unknown as AnyCircuitElement

  it("四种 shape 均触发 unsupported-element 告警且不额外产出 layer 11 环", () => {
    const cj = [
      board(),
      cutout("pcb_cutout_rect", "rect", {
        center: { x: 0, y: 0 },
        width: 5,
        height: 3,
      }),
      cutout("pcb_cutout_circle", "circle", {
        center: { x: 10, y: 0 },
        radius: 2,
      }),
      cutout("pcb_cutout_polygon", "polygon", {
        points: [
          { x: 0, y: 10 },
          { x: 2, y: 10 },
          { x: 2, y: 12 },
        ],
      }),
      cutout("pcb_cutout_path", "path", {
        route: [
          { x: 0, y: 20 },
          { x: 5, y: 20 },
        ],
        slot_width: 1,
      }),
    ]
    const { files, diagnostics } = convertPcb(cj)
    const epcb = findEpcb(files)

    const cutoutDiagnostics = diagnostics.filter(
      (d) => d.code === "unsupported-element" && d.message.includes("pcb_cutout"),
    )
    expect(cutoutDiagnostics.length).toBe(1)
    for (const shape of ["rect", "circle", "polygon", "path"]) {
      expect(cutoutDiagnostics[0]?.message).toContain(`pcb_cutout_${shape}`)
    }
    // 只有板框那一个 layer 11 环；未凭猜测写出内槽几何。
    expect(layer11PolyCount(epcb)).toBe(1)
  })
})
