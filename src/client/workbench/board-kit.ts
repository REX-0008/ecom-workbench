/** 六个板块共用的小工具：一次接口调用、时间文案、巡查类判据。
 *
 * ## 为什么要单独一份
 *
 * 六个板块都要做同一件事：打一个宿主半接口、**失败不抛**、把时间写成给人看的样子。
 * 各写一份的话，报错文案与时间格式会各走各的（见 `pitfalls/同一件事写两份迟早漂.md`）。
 *
 * ⚠️ 这里**只放纯函数与 fetch 包装**：不碰 React、不碰 `ctx`、不 import Node 内置模块
 * （客户端半的硬规矩，见 AGENTS.md 的「分层」）。
 */

/** 一次接口调用的结果（永不抛异常）。 */
export interface CallResult<T> {
  /** 拿到了 HTTP 200 就 true。 */
  ok: boolean
  /** 解析出来的响应体（失败时也可能有，宿主半的错因在 `error` 字段里）。 */
  body?: T
  /** 失败原因（给人看的一句话）。 */
  error?: string
}

/**
 * 调一个本插件的宿主半接口。
 *
 * 约定与 `dispatch-client.ts` 一致：网络失败、404、500 全部变成 `{ ok: false, error }`。
 * 由调用方决定显示成什么 —— 一个接口挂了不该让整个板块白屏。
 *
 * @param path - 前缀之后的路径（如 `/collect/records`）。
 * @param init - fetch 选项（方法、头、体）。
 * @returns 结果。
 */
export async function call<T>(path: string, init?: RequestInit): Promise<CallResult<T>> {
  try {
    const res = await fetch('/api/ecom-workbench' + path, init)
    const body = await res.json() as T & { error?: string }
    if (!res.ok) {
      const why = body !== null && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : '宿主半返回 ' + String(res.status)
      return { ok: false, body, error: why }
    }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 两位补零。
 * @param n - 数字。
 * @returns 至少两位的字符串。
 */
function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** 时间戳有效吗（0 / NaN / 负数都算「没有」）。 */
function hasTime(ms?: number): ms is number {
  return ms !== undefined && Number.isFinite(ms) && ms > 0
}

/**
 * 把时间写成给人看的一句：今天给 `今天 14:03`，其余给 `10-20 09:30`。
 *
 * 为什么不写年份：这些记录都是近期跑的，年份只会占位置。
 *
 * @param ms - 毫秒时间戳（可缺）。
 * @returns 文案；没有时间时给一个破折号。
 */
export function when(ms?: number): string {
  if (!hasTime(ms)) return '—'
  const d = new Date(ms)
  const hm = two(d.getHours()) + ':' + two(d.getMinutes())
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? '今天 ' + hm : two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + hm
}

/**
 * 这个时间戳是不是今天。
 * @param ms - 毫秒时间戳（可缺）。
 * @returns 是今天给 true。
 */
export function isToday(ms?: number): boolean {
  if (!hasTime(ms)) return false
  const d = new Date(ms)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

/**
 * 一份工作流算不算巡查类。
 *
 * ⚠️ 判据必须与宿主半**同一处**：`src/schedule/records.ts` 的 `boardOf`
 * 就是「名字以『巡查-』开头」。换成别的判据（比如看类型标签）会让界面上
 * 「算巡查的」与「记录落到 patrol/ 的」不是同一批。
 *
 * @param name - 工作流名。
 * @returns 巡查类给 true。
 */
export function isPatrol(name: string): boolean {
  return name.trim().startsWith('巡查-')
}

/**
 * 取数板块**要显示**的那几份工作流（用户 2026-10-22 定：只显示最终要用的）。
 *
 * ## 为什么不是「非巡查类的全部」
 *
 * 改前用的是 `!isPatrol(name)`，于是 6 份全进来：
 *
 * ```
 * 全部下载 / 清洗入库 / 取数-天猫生意参谋 / 取数-抖音电商罗盘 / 取数-千川全域推广
 * ```
 *
 * 后三份是 `全部下载` 的**零件**：它们各自只采一个平台，用户不需要单独点它们
 * （要点就从「全部下载」的开始节点选平台）。把它们并列摆出来，等于让用户
 * 在一堆半成品里挑 —— 而那三份跑完也不会自动清洗入库。
 *
 * ## 判据为什么写成显式白名单
 *
 * 「名字里含『下载』或『清洗』」这类模糊判据会在新增工作流时**悄悄多出卡片**
 * （或者漏掉）。白名单的代价是加新工作流要改一次这里 —— 但那正是我们要的：
 * 「哪几份该出现在取数板块」是一个**需要人决定**的产品问题，不该让命名规则替人决定。
 *
 * ⚠️ 名单里的名字要与存档里的**完全一致**（宿主半按名字读档）。
 *
 * @param name - 工作流名。
 * @returns 该出现在取数板块给 true。
 */
export function isCollectEntry(name: string): boolean {
  const n = name.trim()
  return COLLECT_ENTRIES.some(e => e.name === n)
}

/** 取数板块的入口（顺序就是卡片顺序）。 */
export const COLLECT_ENTRIES: readonly { name: string, note: string }[] = [
  {
    name: '全部下载',
    note: '天猫 + 抖音 + 千川，跑完自动清洗入库',
  },
  {
    name: '清洗入库',
    note: '把已下载的原始数据清洗后入库',
  },
]

/**
 * 从一段未知形状的 JSON 里取出一个对象（取不到给空对象）。
 *
 * 产出、判档这些都是**磁盘上读回来**的东西，形状不可信 —— 逐层判类型，
 * 缺哪层都退回空值，而不是抛错把整块界面带走。
 *
 * @param v - 任意值。
 * @returns 对象（非对象给空对象）。
 */
export function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

/**
 * 从一段未知形状的 JSON 里取出一个数组（取不到给空数组）。
 * @param v - 任意值。
 * @returns 数组（非数组给空数组）。
 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
