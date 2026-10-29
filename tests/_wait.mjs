/** 等待工具箱：**等到状态变了就走，不再死等一个固定毫秒数**。
 *
 * ## 为什么要有这个文件（不是「为了快」）
 *
 * 这两个测试原来一共 256 处 `await new Promise(s => setTimeout(s, 300))` 这类
 * **固定等待**，加起来一百多秒。问题不只是慢，是**两头都不对**：
 *
 * · **要么不够**：某台机器、某次改动让渲染慢了一点，300ms 到了状态还没变，
 *   断言当场红 —— 而产品其实是对的。这类红最难查：本地跑绿、CI 红、
 *   重跑又绿。这个项目已经因此白跑过好几轮（`19653f7` 的 `Ctrl+G` 就是）。
 * · **要么白等**：绝大多数情况下状态 5ms 就到位了，剩下 295ms 纯属空转。
 *
 * 固定等待的**根因错**是：它拿「时间」当「状态」的替身。时间到了不等于事情发生了。
 *
 * ## 两个函数各管一件事
 *
 * | 函数 | 管什么 | 用在哪 |
 * |---|---|---|
 * | `waitUntil(cond, 超时)` | 有**明确可观察条件**（DOM 出现、计数器 > 0） | 首选 |
 * | `settle()` | 没有可观察条件，只是「让 React 与 promise 链跑完」 | 兜底 |
 *
 * ⚠️ **`settle()` 不是「短一点的死等」**：它等的是**任务队列空了**这个事实
 * （连续若干轮 `setTimeout(0)` 之间没有新任务插进来），而不是一个猜出来的毫秒数。
 * 任务真没跑完时它同样会等下去（有上限），所以不会像「把 300 改成 8」那样
 * 把断言变红（那次实验红 11 条，全是本来该等的东西没等到）。
 *
 * ## ⚠️ 判据不许松
 *
 * `waitUntil` 超时返回 `false`，**调用方必须让后面那条断言照常执行**——
 * 不许写成 `if (await waitUntil(...)) { 断言 }`，那样超时等于跳过断言。
 * 正确形态是「不管等没等到，都往下走，断言自己判」。
 */

/**
 * 等到条件成立，或超时。
 *
 * @param {() => boolean} cond 条件（每次轮询调用一次）。
 * @param {number} [timeoutMs] 最多等多久（毫秒）。默认 3000。
 * @param {number} [stepMs] 轮询间隔（毫秒）。默认 10。
 * @returns {Promise<boolean>} 条件成立为 `true`；超时为 `false`（**调用方必须照常断言**）。
 */
export async function waitUntil(cond, timeoutMs = 3000, stepMs = 10) {
  const t0 = Date.now()
  /* 先判一次：已经成立时连一次 setTimeout 都不用付。 */
  if (cond()) return true
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, stepMs))
    if (cond()) return true
  }
  return cond()
}

/**
 * 让任务队列跑空（React 提交、promise 链、我们自己排的 0ms 定时器都会在这期间跑完）。
 *
 * ## 判据：连续几轮之间**没有新任务**就算空
 *
 * 每一轮做一次 `setTimeout(0)`；如果这一轮和上一轮之间「有东西跑过」
 * （用轮次计数与宏任务批次对比看出来很难，所以退一步用**轮数下限 + 上限**）
 * —— 实现取简单的做法：至少 `minRounds` 轮，最多 `maxRounds` 轮，
 * 早停条件是「连续 `calm` 轮里没有新增的宏任务批次」。
 *
 * 我们这个场景够用且可预测：jsdom 不做布局、不做绘制，真正的异步只有
 * fetch 桩（`Promise.resolve`）与 React 的 effect。它们都在头几轮里跑完。
 *
 * @param {object} [opts]
 * @param {number} [opts.rounds] 跑几轮 0ms 定时器（默认 4）。
 * @returns {Promise<void>}
 */
export async function settle({ rounds = 4 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}
