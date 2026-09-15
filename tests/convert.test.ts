import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { convertCircuitJsonToEpro, convertCircuitJsonToEproFiles } from "../src/index"
import type { AnyCircuitElement } from "circuit-json"

const fixturePath = fileURLToPath(new URL("./fixtures/simple-rc-circuit.json", import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as AnyCircuitElement[]

const parseLines = (content: string): unknown[][] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown[])

const DOCTYPE_BY_EXT: Record<string, string> = {
  ".esch": "SCH",
  ".esym": "SYMBOL",
  ".efoo": "FOOTPRINT",
  ".epcb": "PCB",
}

describe("convertCircuitJsonToEproFiles", () => {
  const { files, manifest } = convertCircuitJsonToEproFiles(fixture, { title: "smoke" })
  const byPath = new Map(files.map((f) => [f.path, f.content]))

  it("emits every required top-level entry", () => {
    expect(byPath.has("project.json")).toBe(true)
    expect([...byPath.keys()].some((p) => p.startsWith("SHEET/") && p.endsWith(".esch"))).toBe(true)
    expect([...byPath.keys()].some((p) => p.endsWith(".esym"))).toBe(true)
    expect([...byPath.keys()].some((p) => p.endsWith(".efoo"))).toBe(true)
    expect([...byPath.keys()].some((p) => p.endsWith(".epcb"))).toBe(true)
  })

  it("every non-json file is array-based JSON-lines with a DOCTYPE first line", () => {
    for (const file of files) {
      if (file.path.endsWith(".json")) continue
      const lines = parseLines(file.content)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(Array.isArray(line)).toBe(true)

      const ext = file.path.slice(file.path.lastIndexOf("."))
      const expected = DOCTYPE_BY_EXT[ext]
      expect(expected, `unexpected extension ${ext} for ${file.path}`).toBeDefined()
      expect(lines[0]?.[0]).toBe("DOCTYPE")
      expect(lines[0]?.[1]).toBe(expected)
    }
  })

  it("project.json cross-references resolve to emitted files", () => {
    const symbols = (manifest.symbols ?? {}) as Record<string, unknown>
    const footprints = (manifest.footprints ?? {}) as Record<string, unknown>
    const devices = (manifest.devices ?? {}) as Record<string, unknown>

    for (const uuid of Object.keys(symbols)) {
      expect(byPath.has(`SYMBOL/${uuid}.esym`), `missing SYMBOL/${uuid}.esym`).toBe(true)
    }
    for (const uuid of Object.keys(footprints)) {
      expect(byPath.has(`FOOTPRINT/${uuid}.efoo`), `missing FOOTPRINT/${uuid}.efoo`).toBe(true)
    }

    const config = manifest.config as { defaultSheet?: string } | undefined
    expect(config?.defaultSheet).toBeTruthy()
    expect(Object.keys(devices)).toContain(config?.defaultSheet)

    for (const dev of Object.values(devices)) {
      const attrs = (dev as { attributes?: Record<string, string> }).attributes ?? {}
      if (attrs.Symbol) expect(symbols[attrs.Symbol]).toBeDefined()
      if (attrs.Footprint) expect(footprints[attrs.Footprint]).toBeDefined()
    }

    const schematics = (manifest.schematics ?? {}) as Record<string, unknown>
    for (const uuid of Object.keys(schematics)) {
      expect([...byPath.keys()].some((p) => p.startsWith(`SHEET/${uuid}/`))).toBe(true)
    }
    const pcbs = (manifest.pcbs ?? {}) as Record<string, unknown>
    for (const uuid of Object.keys(pcbs)) {
      expect(byPath.has(`PCB/${uuid}.epcb`)).toBe(true)
    }
  })

  it("HEAD.maxId is not smaller than the largest element id", () => {
    for (const file of files) {
      if (file.path.endsWith(".json")) continue
      const lines = parseLines(file.content)
      const head = lines.find((line) => line[0] === "HEAD") as [string, Record<string, number>] | undefined
      if (!head || typeof head[1]?.maxId !== "number") continue
      let maxId = 0
      for (const line of lines) {
        const id = line[1]
        if (typeof id !== "string") continue
        const match = /^e(\d+)$/.exec(id)
        if (match) maxId = Math.max(maxId, Number(match[1]))
      }
      expect(head[1].maxId, `maxId too small in ${file.path}`).toBeGreaterThanOrEqual(maxId)
    }
  })

  it("is deterministic for the same input", () => {
    const a = convertCircuitJsonToEproFiles(fixture, { title: "smoke" })
    const b = convertCircuitJsonToEproFiles(fixture, { title: "smoke" })
    expect(a.files).toEqual(b.files)
  })
})

describe("convertCircuitJsonToEpro", () => {
  it("produces a valid .epro zip archive", () => {
    const { data } = convertCircuitJsonToEpro(fixture, { title: "smoke" })
    expect(data).toBeInstanceOf(Uint8Array)
    expect(data.length).toBeGreaterThan(0)

    const entries = unzipSync(data)
    const names = Object.keys(entries)
    expect(names).toContain("project.json")
    const projectJson = JSON.parse(strFromU8(entries["project.json"]!)) as Record<string, unknown>
    expect(projectJson.config).toBeTruthy()
  })
})

describe("convertCircuitJsonToEproFiles 选项契约（显式 undefined 必须回退默认值）", () => {
  it("title: undefined 回退为默认标题，且 pcbs 不为空", () => {
    const { manifest } = convertCircuitJsonToEproFiles(fixture, {
      title: undefined,
      deterministic: undefined,
    })

    const config = manifest.config as { title?: string } | undefined
    expect(config?.title).toBe("circuit")

    // 原始对象
    expect(Object.keys((manifest.pcbs ?? {}) as Record<string, unknown>).length).toBe(1)
    // 序列化后仍需保留（防 `undefined` 键被 JSON.stringify 丢弃）
    const serialized = JSON.parse(JSON.stringify(manifest)) as {
      pcbs?: Record<string, unknown>
    }
    expect(Object.keys(serialized.pcbs ?? {}).length).toBe(1)
  })

  it("deterministic: undefined 与 deterministic: true 产出完全一致（uuid 稳定）", () => {
    const withUndefined = convertCircuitJsonToEproFiles(fixture, {
      deterministic: undefined,
    })
    const withTrue = convertCircuitJsonToEproFiles(fixture, { deterministic: true })
    expect(withUndefined.files).toEqual(withTrue.files)
  })
})
