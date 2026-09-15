# chenke-circuit-json2jlceda

将 [tscircuit](https://tscircuit.com) 的 `circuit-json`（`AnyCircuitElement[]`）转换为
**嘉立创EDA专业版（EasyEDA Pro）V2 `.epro` 工程文件**。

产出内容包括：器件库（Device）、符号库（SYMBOL/*.esym）、封装库（FOOTPRINT/*.efoo）、
原理图文档（`.esch`）与 PCB 文档（`.epcb`），并打包为单个 `.epro` 归档。

## 安装

```sh
# 从 GitHub 直接安装（推荐，无需 registry 与 token）
npm i -D github:herouu/chenke-circuit-json2jlceda

# 或从本地 tarball / 目录
npm i -D ../chenke-circuit-json2jlceda
```

## 命令行

```sh
chenke-circuit-json2jlceda input.json -o board.epro
npx chenke-circuit-json2jlceda input.json --files -o epro-project
```

| 选项 | 说明 |
|---|---|
| `-o, --output <path>` | 输出 `.epro` 文件；配合 `--files` 时输出目录 |
| `--title <title>` | 工程标题 |
| `--no-pcb` | 不生成 PCB |
| `--no-schematic` | 不生成原理图 |
| `--no-deterministic` | 关闭确定性 UUID 与编号（默认开启） |
| `--strict` | 严格模式：出现 error 级诊断立即抛错 |
| `--files` | 输出为文件目录而非单个 `.epro` |
| `--flip-sch-y` | 翻转原理图 Y 轴 |
| `--no-sch-fit` | 禁用原理图缩放适配（仅平移，保持 1:1） |

## JS API

```js
import { convertCircuitJsonToEproFiles, packEproFiles } from "chenke-circuit-json2jlceda"
import { readFile, writeFile } from "node:fs/promises"

const circuitJson = JSON.parse(await readFile("circuit.json", "utf8"))
const { files, diagnostics, manifest } = convertCircuitJsonToEproFiles(circuitJson, {
  includePcb: true,
  includeSchematic: true,
  deterministic: true,
  title: "demo",
})

for (const d of diagnostics) console.error(`[${d.severity}] ${d.code}: ${d.message}`)
if (diagnostics.some((d) => d.severity === "error")) process.exit(1)

await writeFile("board.epro", packEproFiles(files))
```

## 在 tscircuit 工程中使用

tscircuit 目前**没有**第三方导出的插件/注册点（`tsci export -f` 的格式表是固定白名单，
`tscircuit.config.json` 的 schema 也不允许自定义 exporter）。可行路径是脚本桥接：

```json
{
  "devDependencies": {
    "chenke-circuit-json2jlceda": "github:herouu/chenke-circuit-json2jlceda"
  },
  "scripts": {
    "build:epro": "tsci build && chenke-circuit-json2jlceda dist/src/blink/circuit.json -o board.epro"
  }
}
```

`tsci build` 会在 `dist/**/circuit.json` 写出 `AnyCircuitElement[]`，再由本包转为 `.epro`，
导入嘉立创EDA专业版进行 DRC / DFM 校验。

若需在 tscircuit 云端 CI 构建中产出 `.epro`，用官方唯一扩展位 `tscircuit.config.json`：

```json
{ "buildCommand": "tsci build && chenke-circuit-json2jlceda dist/src/blink/circuit.json -o board.epro" }
```

`buildCommand` 仅在 `tsci build --ci` 下执行，并会设置 `TSCIRCUIT_INSIDE_BUILD_COMMAND=1` 防止递归。

## 开发

```sh
npm install      # prepare 钩子会自动执行 tsup 构建
npm test         # vitest
npm run typecheck
npm run cli -- tests/fixtures/simple-rc-circuit.json -o out/test.epro
```

## License

MIT
