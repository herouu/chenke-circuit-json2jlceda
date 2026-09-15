# chenke-circuit-json2jlceda

将 [tscircuit](https://tscircuit.com) 的 `circuit-json`（`AnyCircuitElement[]`）转换为
**嘉立创EDA专业版（EasyEDA Pro）V2 `.epro` 工程文件**。

产出内容包括：器件库（Device）、符号库（`SYMBOL/*.esym`）、封装库（`FOOTPRINT/*.efoo`）、
原理图文档（`.esch`）与 PCB 文档（`.epcb`），并打包为单个 `.epro` 归档，
可直接导入嘉立创EDA专业版做 DRC / DFM 校验。

## 环境要求

- Node.js >= 20（纯 ESM 包，`exports` 仅提供 `import` 入口）

## 安装

```sh
# 推荐：从 GitHub 安装并锁定版本（可复现，无需 registry 与 token）
npm i -D github:herouu/chenke-circuit-json2jlceda#v0.1.0

# 跟随 main 分支（拿最新，但不可复现）
npm i -D github:herouu/chenke-circuit-json2jlceda

# 或本地 tarball / 目录
npm i -D ../chenke-circuit-json2jlceda/chenke-circuit-json2jlceda-0.1.0.tgz
npm i -D ../chenke-circuit-json2jlceda
```

git 依赖安装时会自动执行 `prepare`（`tsup` 构建），因此首次安装约需 30–50 秒；
tarball 与目录安装包含预构建产物时更快。

## 命令行

```sh
npx chenke-circuit-json2jlceda input.json -o board.epro
npx chenke-circuit-json2jlceda input.json --files -o epro-project
npx chenke-circuit-json2jlceda --help
```

输出示例：

```text
已生成 board.epro
  symbols: 3
  footprints: 2
  devices: 3
  files: 8
```

| 选项 | 说明 |
|---|---|
| `-o, --output <path>` | 输出 `.epro` 文件；配合 `--files` 时为输出目录 |
| `--title <title>` | 工程标题 |
| `--no-pcb` | 不生成 PCB |
| `--no-schematic` | 不生成原理图 |
| `--no-deterministic` | 关闭确定性 UUID 与编号（默认开启） |
| `--strict` | 严格模式：出现 error 级诊断立即以非零码退出 |
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

### 导出符号

| 符号 | 说明 |
|---|---|
| `convertCircuitJsonToEproFiles(cj, options?)` | 返回 `{ files, diagnostics, manifest }`，`files` 为路径/内容文本列表 |
| `convertCircuitJsonToEpro(cj, options?)` | 一步返回 `{ data: Uint8Array, diagnostics }`，即打包好的 `.epro` 字节 |
| `packEproFiles(files, opts?)` | 将 `files` 打包为 `.epro`，`opts.level` 为 0–9 压缩级别 |
| `ConvertOptions` / `EproFile` / `EproDiagnostic` | 类型定义 |

### `ConvertOptions`

| 字段 | 默认 | 说明 |
|---|---|---|
| `title` / `sheetName` | — | 工程标题与原理图页名 |
| `includePcb` / `includeSchematic` | `true` | 是否生成对应文档 |
| `deterministic` | `true` | 确定性 UUID 与编号，保证同输入同输出 |
| `strict` | `false` | 遇 error 级诊断抛错 |
| `uuidSalt` | 包内固定值 | 派生 UUID 的盐值；改动会导致全部 UUID 变化 |
| `axis.schematicFlipY` | `false` | 翻转原理图 Y 轴 |
| `units.schematicPerMm` / `units.pcbPerMm` | 包内默认 | 各文档的单位换算系数 |
| `schematicFit` | `true` | 原理图缩放适配；`false` 时仅平移，保持 1:1 |

### 诊断

`EproDiagnostic` 含 `code`、`severity`（`info` / `warning` / `error`）、`message`，
以及可选的 `circuitElementType` / `circuitElementId` 用于溯源。

常见 `code`：`unsupported-element`、`missing-source-component`、`missing-symbol`、
`missing-footprint`、`missing-component-id`、`orphan-pad`、`duplicate-id`、
`invalid-trace`、`missing-via`、`layout-scaled`。

## 在 tscircuit 工程中使用

tscircuit 目前**没有**第三方导出的插件/注册点：`tsci export -f` 的格式表是固定白名单，
`tscircuit.config.json` 的 schema（`additionalProperties: false`）也不允许自定义 exporter，
`@tscircuit/cli/lib` 未导出内部的格式分派函数。可行路径是**脚本桥接**：

```json
{
  "devDependencies": {
    "chenke-circuit-json2jlceda": "github:herouu/chenke-circuit-json2jlceda#v0.1.0"
  },
  "scripts": {
    "build:epro": "tsci build && chenke-circuit-json2jlceda dist/src/blink/circuit.json -o board.epro"
  }
}
```

`tsci build` 会在 `dist/**/circuit.json` 写出 `AnyCircuitElement[]`，再由本包转为 `.epro`。

若需在 tscircuit 云端 CI 构建中产出 `.epro`，用官方唯一扩展位 `tscircuit.config.json`：

```json
{ "buildCommand": "tsci build && chenke-circuit-json2jlceda dist/src/blink/circuit.json -o board.epro" }
```

`buildCommand`（及其 `prebuildCommand`）仅在 `tsci build --ci` 下执行，
CLI 会设置 `TSCIRCUIT_INSIDE_BUILD_COMMAND=1` 以避免递归。

## 开发

```sh
npm install      # prepare 钩子会自动执行 tsup 构建
npm test         # vitest
npm run typecheck
npm run cli -- tests/fixtures/simple-rc-circuit.json -o out/test.epro
npm run build    # 产出 dist/（index.js + cli.js + d.ts）
```

## 发布新版本

```sh
# 1. 更新 package.json 的 version
# 2. 提交并打标签
git add -A && git commit -m "chore: 发布 vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z
```

消费侧锁版本：`github:herouu/chenke-circuit-json2jlceda#vX.Y.Z`。

## License

MIT
