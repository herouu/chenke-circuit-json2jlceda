import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { AnyCircuitElement } from "circuit-json"
import { buildSourceIndex } from "../src/analysis/source-index"
import { convertCircuitJsonToEproFiles } from "../src/index"

const fixturePath = fileURLToPath(
  new URL("./fixtures/simple-rc-circuit.json", import.meta.url),
)
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as AnyCircuitElement[]

const parseLines = (content: string): unknown[][] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown[])

const byPath = (
  files: { path: string; content: string }[],
): Map<string, string> => new Map(files.map((file) => [file.path, file.content] as const))

const eschOf = (files: { path: string; content: string }[]): string => {
  const entry = [...byPath(files)].find(
    ([path]) => path.startsWith("SHEET/") && path.endsWith(".esch"),
  )
  expect(entry, "未生成 SHEET/*/1.esch").toBeDefined()
  return entry![1]
}

const epcbOf = (files: { path: string; content: string }[]): string => {
  const entry = [...byPath(files)].find(
    ([path]) => path.startsWith("PCB/") && path.endsWith(".epcb"),
  )
  expect(entry, "未生成 PCB/*.epcb").toBeDefined()
  return entry![1]
}

/** `.esch` 里所有 NET ATTR 的网名。 */
const netNamesOf = (esch: string): string[] =>
  parseLines(esch)
    .filter((row) => row[0] === "ATTR" && row[3] === "NET")
    .map((row) => String(row[4]))

/** `.epcb` 里所有网络引用值（LINE / VIA / PAD_NET 的第 4 列）。 */
const pcbNetNamesOf = (epcb: string): string[] => {
  const out: string[] = []
  for (const row of parseLines(epcb)) {
    if (row[0] !== "LINE" && row[0] !== "VIA" && row[0] !== "PAD_NET") continue
    const value = row[3]
    if (typeof value === "string" && value.length > 0) out.push(value)
  }
  return out
}

/** `.esch` 正文 COMPONENT 的位号（跳过 A4 图框首行）。 */
const designatorsOf = (esch: string): string[] => {
  const rows = parseLines(esch)
  const contentIds = rows
    .filter((row) => row[0] === "COMPONENT")
    .slice(1)
    .map((row) => String(row[1]))
  return contentIds.map((id) => {
    const attr = rows.find(
      (row) => row[0] === "ATTR" && row[2] === id && row[3] === "Designator",
    )
    return String(attr?.[4] ?? "")
  })
}

const contentComponentCount = (esch: string): number =>
  parseLines(esch).filter((row) => row[0] === "COMPONENT").length - 1

const cloneFixture = (): any[] => JSON.parse(JSON.stringify(fixture)) as any[]

const findElement = (cj: any[], type: string, idField: string, id: string): any =>
  cj.find((element) => element?.type === type && element[idField] === id)

// --- 构件辅助 --------------------------------------------------------------

const orphanSchematicComponent = (): AnyCircuitElement[] =>
  [
    {
      type: "schematic_component",
      schematic_component_id: "schematic_component_orphan_0",
      center: { x: 0, y: 0 },
      size: { width: 2, height: 1 },
      is_box_with_pins: true,
    },
    {
      type: "schematic_port",
      schematic_port_id: "schematic_port_orphan_0",
      schematic_component_id: "schematic_component_orphan_0",
      center: { x: -1, y: 0 },
      facing_direction: "left",
      distance_from_component_edge: 0.4,
      pin_number: 1,
    },
  ] as unknown as AnyCircuitElement[]

// --- Fix A/C/D：元件绑定 ---------------------------------------------------

describe("原理图元件绑定（schematic binding）", () => {
  it("缺 source_component_id 的 schematic_component 仍被绘制", () => {
    const { files } = convertCircuitJsonToEproFiles(orphanSchematicComponent(), {
      includePcb: false,
      title: "binding-orphan",
    })
    const contentComponents = parseLines(eschOf(files))
      .filter((row) => row[0] === "COMPONENT")
      .slice(1)
    expect(contentComponents).toHaveLength(1)
    expect(contentComponents[0]![1]).toBeTruthy()
  })

  it("缺 source_component_id 时发出 warning 诊断（missing-component-id）", () => {
    const { diagnostics } = convertCircuitJsonToEproFiles(orphanSchematicComponent(), {
      includePcb: false,
      title: "binding-orphan",
    })
    const warning = diagnostics.find((d) => d.code === "missing-component-id")
    expect(warning).toBeDefined()
    expect(warning?.severity).toBe("warning")
    expect(warning?.message).toContain("source_component_id")
    expect(warning?.circuitElementId).toBe("schematic_component_orphan_0")
  })

  it("缺 source_component_id 的元件 Device 引用闭合（.esch → project.json / .esym）", () => {
    const { files, manifest } = convertCircuitJsonToEproFiles(
      orphanSchematicComponent(),
      { includePcb: false, title: "binding-orphan" },
    )
    const paths = byPath(files)
    const rows = parseLines(eschOf(files))
    const contentComponents = rows.filter((row) => row[0] === "COMPONENT").slice(1)
    expect(contentComponents).toHaveLength(1)
    const componentId = String(contentComponents[0]![1])

    const deviceAttr = rows.find(
      (row) => row[0] === "ATTR" && row[2] === componentId && row[3] === "Device",
    )
    expect(deviceAttr, "COMPONENT 缺少 Device ATTR").toBeDefined()
    const deviceUuid = String(deviceAttr![4])
    const devices = manifest.devices as Record<
      string,
      { attributes?: Record<string, string> }
    >
    expect(devices[deviceUuid], "Device ATTR 指向的 uuid 不在 project.json.devices").toBeDefined()
    const symbolUuid = devices[deviceUuid]?.attributes?.Symbol
    expect(symbolUuid, "Device 缺少 Symbol 绑定").toBeTruthy()
    expect(paths.has(`SYMBOL/${symbolUuid}.esym`), "引用的 .esym 缺失").toBe(true)
    const symbols = (manifest.symbols ?? {}) as Record<string, unknown>
    expect(symbols[symbolUuid!], "Symbol uuid 不在 project.json.symbols").toBeDefined()
  })

  it("孤儿元件位号非空、稳定，且与正常元件位号不同（真实对比）", () => {
    const normalAndOrphan = [
      {
        type: "source_component",
        source_component_id: "source_component_normal",
        name: "R1",
        ftype: "simple_resistor",
      },
      {
        type: "schematic_component",
        schematic_component_id: "schematic_component_normal",
        source_component_id: "source_component_normal",
        center: { x: 20, y: 0 },
        size: { width: 2, height: 1 },
      },
      ...orphanSchematicComponent(),
    ] as unknown as AnyCircuitElement[]

    const first = convertCircuitJsonToEproFiles(normalAndOrphan, {
      includePcb: false,
      title: "binding-designator",
    })
    const second = convertCircuitJsonToEproFiles(normalAndOrphan, {
      includePcb: false,
      title: "binding-designator",
    })
    const a = designatorsOf(eschOf(first.files))
    const b = designatorsOf(eschOf(second.files))
    expect(a).toHaveLength(2)
    // 全部非空、互不相同。
    for (const designator of a) expect(designator.length).toBeGreaterThan(0)
    expect(new Set(a).size).toBe(2)
    expect(a).toEqual(b)
    // 正常元件位号 = source_component.name；孤儿位号 = schematic_component_id。
    expect(new Set(a)).toEqual(
      new Set(["R1", "schematic_component_orphan_0"]),
    )
  })

  it("两个都缺 id 的元件：合成稳定键、仍被绘制并发出诊断（Case5）", () => {
    const cj = [
      {
        type: "schematic_component",
        center: { x: 0, y: 0 },
        size: { width: 2, height: 1 },
      },
      {
        type: "schematic_component",
        center: { x: 20, y: 0 },
        size: { width: 2, height: 1 },
      },
    ] as unknown as AnyCircuitElement[]

    const { files, diagnostics } = convertCircuitJsonToEproFiles(cj, {
      includePcb: false,
      title: "binding-no-ids",
    })
    expect(contentComponentCount(eschOf(files))).toBe(2)
    const warnings = diagnostics.filter((d) => d.code === "missing-component-id")
    // 不变量：同一元件对同一问题只发一条诊断（两个元件 ⇒ 恰好两条，而非 2N 条）。
    expect(warnings).toHaveLength(2)
    expect(warnings.some((d) => d.circuitElementId === "schematic_component#0")).toBe(true)
    expect(warnings.some((d) => d.circuitElementId === "schematic_component#1")).toBe(true)
    for (const designator of designatorsOf(eschOf(files))) {
      expect(designator.length).toBeGreaterThan(0)
    }
  })

  it("诊断不重复：同一元件同一问题恰好一条（Case5/11 计数断言）", () => {
    // 场景 1：两个都缺 id 的元件 —— 每个元件恰好一条 missing-component-id。
    const bothMissing = [
      { type: "schematic_component", center: { x: 0, y: 0 }, size: { width: 2, height: 1 } },
      { type: "schematic_component", center: { x: 20, y: 0 }, size: { width: 2, height: 1 } },
    ] as unknown as AnyCircuitElement[]
    const case5 = convertCircuitJsonToEproFiles(bothMissing, {
      includePcb: false,
      title: "dedup-no-ids",
    })
    expect(
      case5.diagnostics.filter((d) => d.code === "missing-component-id"),
    ).toHaveLength(2)

    // 场景 2：索引键冲突 —— 恰好一条 duplicate-id（不是「每条元素一条」）。
    const collide = [
      {
        type: "schematic_component",
        schematic_component_id: "collide",
        center: { x: 0, y: 0 },
        size: { width: 2, height: 1 },
      },
      {
        type: "schematic_component",
        schematic_component_id: "sch_other",
        source_component_id: "collide",
        center: { x: 20, y: 0 },
        size: { width: 2, height: 1 },
      },
    ] as unknown as AnyCircuitElement[]
    const case11 = convertCircuitJsonToEproFiles(collide, {
      includePcb: false,
      title: "dedup-collide",
    })
    expect(
      case11.diagnostics.filter((d) => d.code === "duplicate-id"),
    ).toHaveLength(1)
  })

  it("source_component 存在但无 name：两个元件位号非空且不同（Case6）", () => {
    const cj = [
      { type: "source_component", source_component_id: "sc_a", ftype: "simple_box" },
      { type: "source_component", source_component_id: "sc_b", ftype: "simple_box" },
      {
        type: "schematic_component",
        schematic_component_id: "sch_a",
        source_component_id: "sc_a",
        center: { x: 0, y: 0 },
        size: { width: 2, height: 1 },
      },
      {
        type: "schematic_component",
        schematic_component_id: "sch_b",
        source_component_id: "sc_b",
        center: { x: 20, y: 0 },
        size: { width: 2, height: 1 },
      },
    ] as unknown as AnyCircuitElement[]

    const { files, manifest } = convertCircuitJsonToEproFiles(cj, {
      includePcb: false,
      title: "binding-no-name",
    })
    const designators = designatorsOf(eschOf(files))
    expect(designators).toHaveLength(2)
    for (const designator of designators) expect(designator.length).toBeGreaterThan(0)
    expect(new Set(designators).size).toBe(2)

    // Device 的 Designator 与 `.esch` 同口径（Fix D 单一 helper）。
    const devices = manifest.devices as Record<
      string,
      { attributes?: Record<string, string> }
    >
    const deviceDesignators = Object.values(devices)
      .map((device) => device.attributes?.Designator)
      .filter((value): value is string => typeof value === "string")
    expect(new Set(deviceDesignators)).toEqual(new Set(designators))
  })

  it("索引键冲突：保留首个并发出 duplicate-id 诊断（Case11）", () => {
    const cj = [
      {
        type: "schematic_component",
        schematic_component_id: "collide",
        center: { x: 0, y: 0 },
        size: { width: 2, height: 1 },
      },
      {
        type: "schematic_component",
        schematic_component_id: "sch_other",
        source_component_id: "collide",
        center: { x: 20, y: 0 },
        size: { width: 2, height: 1 },
      },
    ] as unknown as AnyCircuitElement[]

    const { files, diagnostics } = convertCircuitJsonToEproFiles(cj, {
      includePcb: false,
      title: "binding-collide",
    })
    // 冲突不静默：只保留首个，且必须有诊断。
    expect(contentComponentCount(eschOf(files))).toBe(1)
    const duplicate = diagnostics.find((d) => d.code === "duplicate-id")
    expect(duplicate).toBeDefined()
    expect(duplicate?.severity).toBe("warning")
    expect(duplicate?.circuitElementId).toBe("collide")
  })

  it("includeSchematic:false 时不再产出无人引用的符号与 Device（Case2b）", () => {
    const { files, manifest } = convertCircuitJsonToEproFiles(
      orphanSchematicComponent(),
      { includeSchematic: false, includePcb: false, title: "no-schematic" },
    )
    expect([...byPath(files).keys()].some((path) => path.startsWith("SHEET/"))).toBe(false)

    const symbols = (manifest.symbols ?? {}) as Record<string, unknown>
    const devices = (manifest.devices ?? {}) as Record<string, unknown>
    // 只剩 A4 图框符号与 A4 器件。
    expect(Object.keys(symbols)).toHaveLength(1)
    expect(Object.keys(devices)).toHaveLength(1)
    const symbolFiles = [...byPath(files).keys()].filter((path) =>
      path.startsWith("SYMBOL/"),
    )
    expect(symbolFiles).toHaveLength(1)
  })
})

// --- Fix A/B：网名与网络分组 ----------------------------------------------

describe("网名解析（net name）", () => {
  const syntheticNetPattern = /^N\$[0-9a-f]{8,16}$/
  const legalNetPattern = /^[A-Za-z0-9_$.-]+$/

  it("fixture 的 .esch 不再出现描述文本当网名", () => {
    const { files } = convertCircuitJsonToEproFiles(fixture, { title: "net-name" })
    const names = netNamesOf(eschOf(files))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name).not.toContain(".R1 > .pin2")
      expect(name).not.toContain(">")
      expect(name).not.toContain(" ")
      expect(name).toMatch(legalNetPattern)
    }
  })

  it("同一物理网络（共享端口）的多条 trace 得到同一网名", () => {
    const index = buildSourceIndex([
      {
        type: "source_trace",
        source_trace_id: "t1",
        connected_source_port_ids: ["p1"],
        connected_source_net_ids: [],
      },
      {
        type: "source_trace",
        source_trace_id: "t2",
        connected_source_port_ids: ["p1"],
        connected_source_net_ids: [],
      },
    ] as unknown as AnyCircuitElement[])

    const name = index.netNameForSourceTrace("t1")
    expect(name).toBeDefined()
    expect(index.netNameForSourceTrace("t2")).toBe(name)
  })

  it("同一物理网络（传递闭包：端口 + source_net）合并为同一网名", () => {
    const index = buildSourceIndex([
      {
        type: "source_trace",
        source_trace_id: "t1",
        connected_source_port_ids: ["p1"],
        connected_source_net_ids: [],
      },
      {
        type: "source_trace",
        source_trace_id: "t2",
        connected_source_port_ids: ["p1"],
        connected_source_net_ids: ["n1"],
      },
      {
        type: "source_trace",
        source_trace_id: "t3",
        connected_source_port_ids: ["p2"],
        connected_source_net_ids: ["n1"],
      },
    ] as unknown as AnyCircuitElement[])

    const name = index.netNameForSourceTrace("t1")
    expect(name).toBeDefined()
    expect(index.netNameForSourceTrace("t2")).toBe(name)
    expect(index.netNameForSourceTrace("t3")).toBe(name)
  })

  it("不同物理网络不碰撞（取代旧的「不同 trace 不碰撞」）", () => {
    const index = buildSourceIndex([
      {
        type: "source_trace",
        source_trace_id: "trace_a",
        connected_source_port_ids: ["p1"],
        connected_source_net_ids: [],
      },
      {
        type: "source_trace",
        source_trace_id: "trace_b",
        connected_source_port_ids: ["p2"],
        connected_source_net_ids: [],
      },
    ] as unknown as AnyCircuitElement[])
    const a = index.netNameForSourceTrace("trace_a")
    const b = index.netNameForSourceTrace("trace_b")
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
  })

  it("相同 subcircuit_connectivity_map_key 视为同一网络（连通域级标识）", () => {
    const index = buildSourceIndex([
      {
        type: "source_trace",
        source_trace_id: "trace_key_a",
        connected_source_port_ids: [],
        connected_source_net_ids: [],
        subcircuit_connectivity_map_key: "conn_1",
      },
      {
        type: "source_trace",
        source_trace_id: "trace_key_b",
        connected_source_port_ids: [],
        connected_source_net_ids: [],
        subcircuit_connectivity_map_key: "conn_1",
      },
    ] as unknown as AnyCircuitElement[])

    const name = index.netNameForSourceTrace("trace_key_a")
    expect(name).toBeDefined()
    expect(index.netNameForSourceTrace("trace_key_b")).toBe(name)
  })

  it("不同 subcircuit_connectivity_map_key 不合并（不跨连通域）", () => {
    const index = buildSourceIndex([
      {
        type: "source_trace",
        source_trace_id: "trace_key_c",
        connected_source_port_ids: [],
        connected_source_net_ids: [],
        subcircuit_connectivity_map_key: "conn_2",
      },
      {
        type: "source_trace",
        source_trace_id: "trace_key_d",
        connected_source_port_ids: [],
        connected_source_net_ids: [],
        subcircuit_connectivity_map_key: "conn_3",
      },
    ] as unknown as AnyCircuitElement[])

    const c = index.netNameForSourceTrace("trace_key_c")
    const d = index.netNameForSourceTrace("trace_key_d")
    expect(c).toBeDefined()
    expect(d).toBeDefined()
    expect(c).not.toBe(d)
  })

  it("无 source_net.name 且无 trace.name 时合成 N$ + 短哈希（组代表键）", () => {
    const index = buildSourceIndex([
      {
        type: "source_trace",
        source_trace_id: "source_trace_x",
        connected_source_port_ids: [],
        connected_source_net_ids: [],
        display_name: ".R1 > .pin2 to .C1 > .pin2",
      },
    ] as unknown as AnyCircuitElement[])

    const name = index.netNameForSourceTrace("source_trace_x")
    expect(name).toBeDefined()
    expect(name).toMatch(syntheticNetPattern)
    expect(index.netNameForSourceTrace("source_trace_x")).toBe(name)
  })

  it("存在 source_net.name 时优先使用真实网名", () => {
    const index = buildSourceIndex([
      { type: "source_net", source_net_id: "source_net_0", name: "VCC" },
      {
        type: "source_trace",
        source_trace_id: "source_trace_0",
        connected_source_port_ids: [],
        connected_source_net_ids: ["source_net_0"],
        display_name: ".U1 > .pin1 to .U2 > .pin1",
      },
    ] as unknown as AnyCircuitElement[])
    expect(index.netNameForSourceTrace("source_trace_0")).toBe("VCC")
  })

  it("source_trace.name 在无 source_net.name 时生效（Fix B，Case9）", () => {
    const index = buildSourceIndex([
      {
        type: "source_trace",
        source_trace_id: "source_trace_named",
        connected_source_port_ids: [],
        connected_source_net_ids: [],
        name: "VCC",
      },
    ] as unknown as AnyCircuitElement[])
    expect(index.netNameForSourceTrace("source_trace_named")).toBe("VCC")
  })

  it("真实 source_net.name 优先于 source_trace.name", () => {
    const index = buildSourceIndex([
      { type: "source_net", source_net_id: "n1", name: "GND" },
      {
        type: "source_trace",
        source_trace_id: "t1",
        connected_source_port_ids: [],
        connected_source_net_ids: ["n1"],
        name: "VCC",
      },
    ] as unknown as AnyCircuitElement[])
    expect(index.netNameForSourceTrace("t1")).toBe("GND")
  })

  it("未知 source_trace_id 返回 undefined（调用方省略 NET attr）", () => {
    const index = buildSourceIndex([] as AnyCircuitElement[])
    expect(index.netNameForSourceTrace("does_not_exist")).toBeUndefined()
  })

  it("同一 source_trace_id 的两段 schematic_trace 得到同一 NET 名（Case7）", () => {
    const cj = cloneFixture()
    const source = findElement(cj, "schematic_trace", "schematic_trace_id", "schematic_trace_0")
    cj.push({
      ...source,
      schematic_trace_id: "schematic_trace_0_dup",
      edges: [
        { from: { x: 3.5, y: 0.4 }, to: { x: 3.5, y: 0.6 } },
      ],
    })
    const { files } = convertCircuitJsonToEproFiles(cj, { title: "net-dup-trace" })
    const names = netNamesOf(eschOf(files))
    const counts = new Map<string, number>()
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
    expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(2)
  })

  it(".esch NET ⊆ .epcb NET/PAD_NET（两条同端口重复 trace 下仍闭合，Case8）", () => {
    const cj = cloneFixture()
    const trace0 = findElement(cj, "source_trace", "source_trace_id", "source_trace_0")
    const schematic0 = findElement(
      cj,
      "schematic_trace",
      "schematic_trace_id",
      "schematic_trace_0",
    )
    // 与 source_trace_0 端口相同、display_name 逐字相同的重复 trace。
    cj.push({ ...trace0, source_trace_id: "source_trace_dup" })
    cj.push({
      ...schematic0,
      schematic_trace_id: "schematic_trace_dup",
      source_trace_id: "source_trace_dup",
    })

    const { files } = convertCircuitJsonToEproFiles(cj, { title: "net-closure" })
    const eschNets = new Set(netNamesOf(eschOf(files)))
    const pcbNets = new Set(pcbNetNamesOf(epcbOf(files)))
    expect(eschNets.size).toBe(2)
    for (const name of eschNets) {
      expect(pcbNets.has(name), `.epcb 缺少 .esch 网名 ${name}`).toBe(true)
    }
    // 重复 trace 不再制造第三个假网络。
    expect(pcbNets.size).toBeGreaterThanOrEqual(eschNets.size)
  })

  it("网名对元素顺序不敏感（逆序输入得到同一集合）", () => {
    const forward = convertCircuitJsonToEproFiles(fixture, { title: "net-order" })
    const reversed = convertCircuitJsonToEproFiles([...fixture].reverse(), {
      title: "net-order",
    })
    const a = netNamesOf(eschOf(forward.files)).slice().sort()
    const b = netNamesOf(eschOf(reversed.files)).slice().sort()
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })
})
