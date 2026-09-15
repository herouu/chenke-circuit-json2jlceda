#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { Command } from "commander"
import { convertCircuitJsonToEproFiles } from "./convert"
import { packEproFiles } from "./pack"
import type { ConvertOptions, EproDiagnostic, EproFile, ProjectJson } from "./types"

function reportDiagnostics(diagnostics: EproDiagnostic[]): boolean {
  let hasError = false
  for (const diagnostic of diagnostics) {
    console.error(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`)
    if (diagnostic.severity === "error") hasError = true
  }
  return hasError
}

function countDevices(project: ProjectJson): number {
  const devices = project.devices
  if (devices && typeof devices === "object") {
    return Object.keys(devices as Record<string, unknown>).length
  }
  return 0
}

function buildSummary(
  target: string,
  files: EproFile[],
  project: ProjectJson,
): string {
  const symbolCount = files.filter((f) => f.path.startsWith("SYMBOL/")).length
  const footprintCount = files.filter((f) => f.path.startsWith("FOOTPRINT/")).length
  return [
    `已生成 ${target}`,
    `  symbols: ${symbolCount}`,
    `  footprints: ${footprintCount}`,
    `  devices: ${countDevices(project)}`,
    `  files: ${files.length}`,
  ].join("\n")
}

async function main(): Promise<void> {
  const program = new Command()
  program
    .name("circuit-json-to-epro2")
    .description("将 tscircuit circuit-json 转换为嘉立创EDA专业版 V2 .epro 工程")
    .argument("<input.json>", "circuit-json 输入文件")
    .option("-o, --output <path>", "输出 .epro 文件或目录（配合 --files）")
    .option("--title <title>", "工程标题")
    .option("--no-pcb", "不生成 PCB")
    .option("--no-schematic", "不生成原理图")
    .option("--no-deterministic", "关闭确定性 UUID 与编号（默认开启）")
    .option("--strict", "严格模式：出现 error 级诊断立即抛错")
    .option("--files", "输出为文件目录而非单个 .epro")
    .option("--flip-sch-y", "翻转原理图 Y 轴")
    .option("--no-sch-fit", "禁用原理图缩放适配（仅平移，保持 1:1）")
    .parse()

  const opts = program.opts()
  const inputPath = program.args[0]
  if (!inputPath) {
    console.error("错误：缺少输入文件")
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(resolve(inputPath), "utf8"))
  } catch (error) {
    console.error(`错误：无法读取或解析输入文件 ${inputPath}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
    return
  }
  if (!Array.isArray(parsed)) {
    console.error("错误：输入 JSON 必须是 circuit-json 数组")
    process.exit(1)
  }

  // 仅写入用户显式提供的选项；未提供时交由 context 的默认值处理，
  // 不传 `undefined`，避免显式 undefined 覆盖默认值。
  const options: ConvertOptions = {
    includePcb: opts.pcb !== false,
    includeSchematic: opts.schematic !== false,
    deterministic: opts.deterministic !== false,
    strict: opts.strict === true,
    axis: {
      schematicFlipY: opts.flipSchY === true,
    },
    schematicFit: opts.schFit !== false,
  }
  if (typeof opts.title === "string" && opts.title.length > 0) {
    options.title = opts.title
  }

  const { files, diagnostics, manifest } = convertCircuitJsonToEproFiles(
    parsed as AnyCircuitElement[],
    options,
  )

  if (reportDiagnostics(diagnostics)) {
    process.exit(1)
  }

  const output: unknown = opts.output
  if (opts.files) {
    const outDir = resolve(
      typeof output === "string" && output.length > 0 ? output : "epro-project",
    )
    for (const file of files) {
      const target = join(outDir, ...file.path.split("/"))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content, "utf8")
    }
    console.log(buildSummary(outDir, files, manifest))
  } else {
    const outFile = resolve(
      typeof output === "string" && output.length > 0 ? output : "circuit.epro",
    )
    const data = packEproFiles(files)
    await mkdir(dirname(outFile), { recursive: true })
    await writeFile(outFile, data)
    console.log(buildSummary(outFile, files, manifest))
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
