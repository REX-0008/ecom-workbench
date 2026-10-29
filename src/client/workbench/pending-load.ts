/** 跨 tab 传「要打开的工作流」（工作流列表 → 画布）。
 *
 * 为什么需要它：列表在「工作流」tab，画布在「画布」tab，两者是兄弟组件，
 * 没有父子关系可以传参。而列表点开一份工作流后，需要：① 切到画布 tab；② 让画布加载那份内容。
 *
 * 做法：一个**模块级的小持有处**。列表写入，画布读取并清空。
 * 为什么不用全局状态库：这是一个「一次性交接」，用完即弃，
 * 放进 store 反而要处理「什么时候清、要不要订阅」。
 */

/** 待加载的内容（null 表示没有）。 */
let pending: { doc: unknown, name: string } | null = null

/** 监听者（画布挂载时注册，被通知后自己去取）。 */
const listeners = new Set<() => void>()

/**
 * 放一份「待画布加载」的工作流。
 * @param doc - 内容。
 * @param name - 名字（画布上提示用）。
 */
export function requestOpen(doc: unknown, name: string): void {
  pending = { doc, name }
  for (const fn of listeners) fn()
}

/**
 * 取走待加载的内容（取完即清，避免重复加载）。
 * @returns 内容与名字；没有则 null。
 */
export function takePending(): { doc: unknown, name: string } | null {
  const p = pending
  pending = null
  return p
}

/**
 * 订阅「有东西待加载」。
 * @param fn - 通知回调。
 * @returns 取消订阅的函数。
 */
export function onPending(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
