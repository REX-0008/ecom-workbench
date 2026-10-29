/** 变量替换（把参数里的 `{{名字}}` 换成实际值）。
 *
 * 为什么需要它：节点说明里承诺了 7 处「可用 {{变量}} 引用上游输出」，
 * 但此前**一行实现都没有**——用户照着写，字符串会原样发出去（不报错、结果不对），
 * 用户只会以为自己写错了。这个文件把承诺兑现。
 *
 * 放在哪一层：**在「节点 → 派发命令」之前**。
 * 因为所有参数最终都要经过那一步才变成命令，放这里就一处生效，不用改 26 个节点。
 *
 * 三种取值来源，按优先级：
 *   1. `{{字段}}`     —— 上游节点输出的字段（也支持 `{{item.title}}` 点号取值）
 *   2. `{{env.名字}}` —— 环境变量
 *   3. `{{vars.名字}}`—— 工作流全局变量
 *
 * 找不到时**不抛错、不中断**：原样保留占位符，并产出一条警告。
 * 理由：用户最怕「什么都没发生」。原样保留 + 警告，能让他从结果和日志里看出问题在哪。
 */

/** 变量取值来源（调用方按运行现场组装）。 */
export interface VariableScope {
  /** 上游输出的字段表（键名 → 值）。 */
  fields?: Record<string, unknown>
  /** 环境变量。 */
  env?: Record<string, string>
  /** 工作流全局变量。 */
  vars?: Record<string, unknown>
}

/**
 * 「保留键」的前缀：**以两个下划线开头**的键不参与变量替换，也不给用户看。
 *
 * ## 为什么需要这个概念（2026-10-23 引入）
 *
 * 有些值要在各层之间传递，但**不是用户输入**：用户既不该在开始节点的
 * 「输入项」里声明它，也不该用 `{{名字}}` 把它当普通变量取出来 ——
 * 那些值属于**运行上下文**，不是这份工作流的公开输入。
 *
 * 第一个（也是目前唯一一个）成员是 `__model`（见 {@link MODEL_KEY}）：
 * 开始节点上选的模型，要能被子工作流沿用（计划 §2.6），
 * 但它不该出现在输入清单里、也不该被 `{{__model}}` 取到。
 *
 * ## 判据是前缀，不是白名单
 *
 * 用「以 `__` 开头」当判据，而不是维护一张名单：加第二个保留键时，
 * 双下划线是**一眼能认出来**的约定（与 Python 的 `__` 前缀同一个直觉），
 * 不需要有人记得回来改这里。用户自己声明的输入项**不该**用这个前缀 ——
 * 真用了也会被当成保留键挡掉，那是可以接受的小代价（且它本来就不是好名字）。
 */
export const RESERVED_KEY_PREFIX = '__'

/**
 * 这份工作流「用哪个模型」的保留键（开始节点选了就写进运行输入表）。
 *
 * 值形状是 `"provider/model"`（见 `model.ts` 的 `encodeModelPick`）。
 * 它随 `given` 传进子工作流，子流程自己没选时沿用父流程那个。
 */
export const MODEL_KEY = '__model'

/**
 * 这个键是不是保留键（不该给用户看、也不参与 `{{变量}}` 替换）。
 *
 * @param key - 键名。
 * @returns 是保留键就 true。
 */
export function isReservedKey(key: string): boolean {
  return key.startsWith(RESERVED_KEY_PREFIX)
}

/**
 * 从一张键值表里去掉保留键（**复制一份**，不改入参）。
 *
 * 用户可见的地方（开始节点的输出、输入日志、运行记录里的输入）都该走它 ——
 * 少一处就是「用户突然看到一个叫 `__model` 的输入项」，而那不是他填的。
 *
 * @param table - 原表。
 * @returns 只含普通键的新表。
 */
export function withoutReservedKeys(table: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(table)) {
    if (isReservedKey(k)) continue
    out[k] = v
  }
  return out
}

/**
 * 从一张表里**只挑出**保留键（用于「把运行上下文带过一层」）。
 *
 * 与 {@link withoutReservedKeys} 正好互补：那个给用户看的，这个给引擎自己传递用。
 *
 * ⚠️ 空值一律不带（`undefined` / `null` / 空串）：带了等于「明确说要清空」，
 * 而语义是「上一层没选就往下走回落链」。少一个键比带一个空值安全。
 *
 * @param table - 原表（可能是 undefined）。
 * @returns 只含有效保留键的新表（没有就是空对象）。
 */
export function reservedKeysOf(table: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (table === undefined) return out
  for (const [k, v] of Object.entries(table)) {
    if (!isReservedKey(k)) continue
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    out[k] = v
  }
  return out
}

/** 一次替换的结果。 */
export interface SubstituteResult {
  /** 替换后的值（类型与输入一致）。 */
  value: unknown
  /** 没能替换的变量名（空数组表示全部替换成功）。 */
  missing: string[]
}

/** 匹配 `{{任意内容}}`（内容不含花括号，避免贪婪跨段）。 */
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

/**
 * 按点号路径从对象里取值（`item.title` → obj.item.title）。
 *
 * 路径任意一段取不到就返回 undefined。数组用数字下标取值。
 *
 * @param source - 取值来源。
 * @param path - 点号路径。
 * @returns 取到的值，或 undefined。
 */
function readPath(source: unknown, path: string): unknown {
  let cur: unknown = source
  for (const seg of path.split('.')) {
    if (seg === '') return undefined
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const i = Number(seg)
      if (!Number.isInteger(i)) return undefined
      cur = cur[i]
      continue
    }
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * 取一个变量的值（按 `env.` / `vars.` 前缀分流，其余走上游字段）。
 *
 * @param name - 变量名（已去掉花括号与两端空白）。
 * @param scope - 取值来源。
 * @returns 取到的值，或 undefined（表示没找到）。
 */
function lookup(name: string, scope: VariableScope): unknown {
  if (name.startsWith('env.')) return scope.env?.[name.slice(4)]
  if (name.startsWith('vars.')) return readPath(scope.vars, name.slice(5))
  /* ★ 保留键（`__` 开头）**不参与替换**（2026-10-23）。
   * 它们属于运行上下文，不是给用户取的值 —— 所以 `{{__model}}` 取不到，
   * 会走「没找到」那条路（原样保留 + 一条警告）。判据见 `RESERVED_KEY_PREFIX`。 */
  const head = name.split('.')[0] ?? ''
  if (isReservedKey(head)) return undefined
  /* 上游字段：先整体命中，再按点号路径取 */
  const direct = scope.fields?.[name]
  if (direct !== undefined) return direct
  return readPath(scope.fields, name)
}

/**
 * 值 → 替换文本。
 *
 * 字符串原样；数字与布尔转文本；对象与数组转 JSON。
 *
 * @param v - 要转的值。
 * @returns 文本。
 */
function toText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * 替换一个字符串里的全部占位符。
 *
 * @param text - 原始文本。
 * @param scope - 取值来源。
 * @returns 替换后的文本，与没找到的名字。
 */
export function substituteText(text: string, scope: VariableScope): SubstituteResult {
  const missing: string[] = []
  const value = text.replace(PLACEHOLDER, (whole, rawName: string) => {
    const name = rawName.trim()
    const got = lookup(name, scope)
    if (got === undefined) {
      /* 找不到：原样保留 + 记一笔，让用户能从结果和日志里看出来 */
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return toText(got)
  })
  return { value, missing }
}

/**
 * 递归替换一个值里的全部占位符（对象与数组会逐层走）。
 *
 * 非字符串原样返回；字符串走替换；对象/数组递归；其余原样。
 *
 * @param input - 要处理的值（通常是整个参数表）。
 * @param scope - 取值来源。
 * @returns 替换后的值，与全部没找到的名字（去重）。
 */
export function substituteDeep(input: unknown, scope: VariableScope): SubstituteResult {
  const missing: string[] = []
  /** 收集没找到的名字（跨层去重）。 */
  const collect = (names: readonly string[]): void => {
    for (const n of names) if (!missing.includes(n)) missing.push(n)
  }
  /** 递归主体。 */
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = substituteText(v, scope)
      collect(r.missing)
      return r.value
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
      return out
    }
    return v
  }
  return { value: walk(input), missing }
}

/**
 * 从一批上游输出里拼出「可用字段表」。
 *
 * 多个上游时，能合成数组就合成数组（同名键合并成数组）；
 * 只有对象才贡献字段名，其余忽略（避免把字符串当字段表）。
 *
 * ## ⚠️ 这里曾经有一个**静默改坏上游数据**的 bug（2026-10-14 修）
 *
 * 原写法是 `(out[k] as unknown[]).push(v)` —— 看起来只是「把同名字段并成数组」，
 * 但 **`out[k]` 是上游输出里那个数组的引用**（第 170 行 `out[k] = v` 直接赋的），
 * 于是那个 `push` **改到了上游节点自己的输出**。
 *
 * **实测症状**（排查了很久，最后靠给数组装陷阱才抓到）：
 * 「巡查-shop」里 `n10`（天猫解析）与 `n14`（抖音解析）都有 `blocks` 字段，
 * 于是 `fieldsFromUpstream` 把 `n14.blocks` **push 进 `n10.blocks`** ——
 * `n10` 的输出从 3 个块变成 4 个（第 4 项还是**数组**），
 * 最终合并出 7 个块（正常 6 个），而**日志里一条错都没有**。
 *
 * 调用链：`runNode` → `buildCommand` → `fieldsFromUpstream`（每一次派发都会走）。
 * 所以只要「两个上游字段同名且都是数组」，它就会被触发。
 *
 * **修法**：合并成数组时**先复制**，绝不 push 进原数组。
 * 复制是浅的 —— 够用，因为这边只读不写这些元素。
 *
 * @param upstream - 上游节点的输出（按连线顺序）。
 * @returns 字段表。
 */
export function fieldsFromUpstream(upstream: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of upstream) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      /* 非对象上游：给一个通用名字，让 {{input}} 能取到它 */
      if (out.input === undefined) out.input = item
      continue
    }
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (out[k] === undefined) out[k] = v
      /* ⚠️ **必须复制**（理由见上面那段）—— 直接 `push` 会改到上游节点的输出。 */
      else if (Array.isArray(out[k])) out[k] = [...(out[k] as unknown[]), v]
      else out[k] = [out[k], v]
    }
  }
  return out
}
