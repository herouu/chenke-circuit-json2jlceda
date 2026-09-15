import type { EproPrimitive } from "./types"

/**
 * 嘉立创EDA专业版 V2 的数组 JSON-lines 写入器。
 *
 * 输出格式：
 * ```
 * ["DOCTYPE","SCH","1.1"]
 * ["HEAD",{...}]
 * [...图元...]
 * ```
 * UTF-8、无 BOM、`\n` 换行、文件末尾带换行。
 *
 * `head` 对象在构造后仍可被调用方引用修改（例如回填 `maxId`），
 * 也可通过 `setHeadValue` 设置。
 */
export class JsonLinesWriter {
  private readonly doctype: [string, string, string]
  readonly head: Record<string, unknown>
  private readonly rows: EproPrimitive[] = []

  constructor(doctype: [string, string, string], head: Record<string, unknown>) {
    this.doctype = doctype
    this.head = head
  }

  /** 追加一条图元结构数组。 */
  push(line: EproPrimitive): void {
    this.rows.push(line)
  }

  /** 设置 HEAD 中的键值（例如 `maxId`）。 */
  setHeadValue(key: string, value: unknown): void {
    this.head[key] = value
  }

  /**
   * 扫描已写入行里形如 `e<数字>` 的编号，返回最大数字。
   *
   * 图元结构数组中类型标识位于第 0 位，编号紧随其后（如
   * `["COMPONENT","e1",...]`），因此取每行中第一个匹配的编号元素。
   */
  get maxNumericId(): number {
    let max = 0
    for (const line of this.rows) {
      const limit = Math.min(line.length, 2)
      for (let i = 0; i < limit; i++) {
        const candidate = line[i]
        if (typeof candidate !== "string") continue
        const match = /^e(\d+)$/.exec(candidate)
        if (!match) continue
        const n = Number(match[1])
        if (Number.isFinite(n) && n > max) max = n
        break
      }
    }
    return max
  }

  /** 已写入的图元行（不含 DOCTYPE/HEAD）。 */
  lines(): EproPrimitive[] {
    return [...this.rows]
  }

  /** 序列化为完整文档字符串。 */
  toString(): string {
    const out: string[] = []
    out.push(JSON.stringify(this.doctype))
    out.push(JSON.stringify(["HEAD", this.head]))
    for (const line of this.rows) {
      out.push(JSON.stringify(line))
    }
    return `${out.join("\n")}\n`
  }
}
