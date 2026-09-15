import { createHash, randomUUID } from "node:crypto"
import type { IdAllocator, UuidFactory } from "./types"

/**
 * 递增的文件内唯一编号分配器。编号形如 `e1`、`e2`……
 * `reserve` 可把外部已有的编号纳入计数，避免冲突。
 */
export function createIdAllocator(start = 1): IdAllocator {
  let counter = start
  return {
    next(): string {
      const id = `e${counter}`
      counter += 1
      return id
    },
    reserve(id: string): void {
      const match = /^e?(\d+)$/.exec(id)
      if (!match) return
      const n = Number(match[1])
      if (Number.isFinite(n) && n >= counter) {
        counter = n + 1
      }
    },
    peekMaxId(): number {
      return counter - 1
    },
  }
}

/**
 * UUID 工厂。
 *
 * - `deterministic` 为 true 时：`md5(`${salt}:${kind}:${key}`)` 的 32 位小写 hex。
 * - 否则：随机 UUID（去掉连字符）。
 *
 * 相同 kind/key 结果在工厂内缓存，保证确定性模式稳定。
 */
export function createUuidFactory(salt: string, deterministic: boolean): UuidFactory {
  const cache = new Map<string, string>()
  return {
    uuid(kind: string, key: string): string {
      const cacheKey = `${kind}:${key}`
      const cached = cache.get(cacheKey)
      if (cached !== undefined) return cached
      const id = deterministic
        ? createHash("md5").update(`${salt}:${kind}:${key}`).digest("hex")
        : randomUUID().replace(/-/g, "")
      cache.set(cacheKey, id)
      return id
    },
  }
}
