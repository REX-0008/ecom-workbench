/** 按渠道限并发（宿主半，契约 AX，2026-10-25）。
 *
 * ## 为什么要有它
 *
 * 生图 / 生视频是**长任务**（一条十几秒到十几分钟）。前端连点几下、或者画布上
 * 一次生成五个节点，请求就会瞬间打满上游的限流配额 —— 结果不是快，而是
 * 一片 429。计划 §三 2.2 定的是「超出的排队，不拒绝」：用户体验上宁可等，
 * 也不要看到失败。
 *
 * ## 两层上限
 *
 * ```
 * 渠道层：每个渠道自己的 maxConcurrency（默认 5）
 * 全局层：所有渠道加起来的上限（默认 20）
 * ```
 *
 * 为什么要全局那一层：渠道上限管得住「一家不被打爆」，管不住「五家一起开火时本机
 * 同时跑二十个 HTTP + 落二十个文件」。全局层是给本机兜底的。
 *
 * ## 为什么不直接引 p-queue
 *
 * 项目里已经有 `p-queue`（派发器用着），但它一个实例只管一个并发数。
 * 这里要的是「每个渠道一个队列 + 一个总闸」，用它得建 N 个实例再手写总闸 ——
 * 四十行的事，多一层依赖关系不值得。所以手写，逻辑就三个数：
 * `running`（本渠道在跑几个）、`total`（全场在跑几个）、`waiters`（排队的）。
 *
 * ## 已知代价（写下来免得以后当成 bug）
 *
 * 排队是**先来先服务**，没有优先级：一条视频排在五张图后面就得等五张图。
 * 等有了「画布上点了立即想看」这种需求再谈优先级。
 */

/** 全局同时最多跑几个（计划定的 20）。 */
export const GLOBAL_LIMIT = 20

/** 一条渠道的默认上限（计划定的 5）。 */
export const DEFAULT_CHANNEL_LIMIT = 5

/** 各渠道的在跑数。 */
const running = new Map<string, number>()
/** 全场在跑数。 */
let total = 0
/** 排队的人（每个是一个「可以开始了」的唤醒函数）。 */
const waiters: (() => void)[] = []

/**
 * 现在全场在跑几个（测试与自检用）。
 * @returns 数量。
 */
export function runningTotal(): number {
  return total
}

/**
 * 某个渠道现在在跑几个。
 * @param channelId - 渠道 id。
 * @returns 数量。
 */
export function runningOf(channelId: string): number {
  return running.get(channelId) ?? 0
}

/**
 * 现在有几个人在排队。
 * @returns 数量。
 */
export function waitingCount(): number {
  return waiters.length
}

/**
 * 试着占一个槽位：占到了返回 true，占不到返回 false。
 *
 * @param channelId - 渠道 id。
 * @param max - 这个渠道的上限。
 * @returns 占到了就 true。
 */
function tryAcquire(channelId: string, max: number): boolean {
  const cur = running.get(channelId) ?? 0
  if (cur >= max) return false
  if (total >= GLOBAL_LIMIT) return false
  running.set(channelId, cur + 1)
  total += 1
  return true
}

/**
 * 还一个槽位，并唤醒**所有**排队的人重新竞争。
 *
 * 为什么唤醒全部而不是唤醒队首：队首那个人可能属于一个已经满了的渠道
 * （它的渠道上限没腾出来），只叫醒他的话整个队伍就卡住了。
 * 全部叫醒、各自再试一次，是最短的写法，也是不会卡死的写法
 * （代价是一次醒来可能有 N 个人白试一下，N 是排队人数，几十的量级无所谓）。
 *
 * ⚠️ **两个计数都要还**（`running` 与 `total`）。只还 `total` 的后果是：
 * 渠道计数永远停在上限，那个渠道此后再也开不了新任务 —— 而且是**静默卡死**，
 * 不报错、不超时，看起来就是「点了生成没反应」。这条第一次实现时就踩了。
 *
 * @param channelId - 渠道 id。
 */
function release(channelId: string): void {
  const cur = running.get(channelId) ?? 0
  if (cur <= 1) running.delete(channelId)
  else running.set(channelId, cur - 1)
  total -= 1
  const wake = waiters.splice(0, waiters.length)
  for (const w of wake) w()
}

/**
 * 在某个渠道里跑一件事，超过该渠道或全局上限就排队。
 *
 * @param channelId - 渠道 id（同一个 id 共用一个槽位池）。
 * @param max - 这个渠道的上限（`>=1`；非法值按默认 5）。
 * @param fn - 真要做的事。
 * @returns `fn` 的结果；`fn` 抛错就原样抛出去（**不影响**槽位归还）。
 */
export async function runInChannel<T>(channelId: string, max: number, fn: () => Promise<T>): Promise<T> {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_CHANNEL_LIMIT
  /* 排队直到占到一个槽位。`waiters` 里放的是「轮到你试了」的唤醒函数，
   * 外面套一层 Promise 把它变成可 await 的。 */
  while (!tryAcquire(channelId, limit)) {
    await new Promise<void>(resolve => { waiters.push(resolve) })
  }
  try {
    return await fn()
  } finally {
    /* ⚠️ `finally` 而不是 `then`：`fn` 抛错也必须把槽位还回去，
     * 否则一次失败就永久吃掉一个名额（跑几次之后整条渠道就不动了）。 */
    release(channelId)
  }
}

/**
 * 清空排队与计数（**只给测试用**）。
 *
 * 为什么需要：模块级的计数是长寿命的，一个测试文件里前一段留下的排队会让后一段
 * 的断言数不对。这不是「给生产代码开后门」，它只是把状态重置回进程刚起来的样子。
 */
export function resetChannelQueueForTest(): void {
  running.clear()
  total = 0
  const wake = waiters.splice(0, waiters.length)
  for (const w of wake) w()
}
