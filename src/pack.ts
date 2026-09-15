import { zipSync } from "fflate"
import type { EproFile } from "./types"

/** `.epro` 容器内需要显式创建的空目录（zip 需要条目来保留目录）。 */
const EMPTY_DIRECTORIES = ["INSTANCE/", "BLOB/", "POUR/", "PANEL/", "FONT/"]

/**
 * 把一组文件打包为 `.epro`（ZIP 容器，内含数组 JSON-lines 文本文件）。
 *
 * 路径统一使用 `/`；额外写入空目录条目；默认压缩级别 6。
 */
export function packEproFiles(
  files: EproFile[],
  opts?: { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
): Uint8Array {
  const encoder = new TextEncoder()
  const zippable: Record<string, Uint8Array> = {}

  for (const file of files) {
    const path = file.path.replace(/\\/g, "/")
    zippable[path] = encoder.encode(file.content)
  }
  for (const dir of EMPTY_DIRECTORIES) {
    if (!(dir in zippable)) {
      zippable[dir] = new Uint8Array(0)
    }
  }

  return zipSync(zippable, { level: opts?.level ?? 6 })
}
