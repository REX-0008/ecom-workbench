/** 按渠道限流（契约 AX，2026-10-25）。
 *
 * ## 这一段守的是什么
 *
 * 计划 §三 2.2 的两条：**同一渠道不超过它的上限**、**全场不超过全局上限**，
 * 而且**超出的排队不拒绝**（6 个请求进、6 个都要跑完）。
 *
 * ## 判据为什么是「实测同时在跑的最大值」
 *
 * 「实现里有一个计数器」这种判据挡不住真 bug：计数器加错了、`finally` 漏了，
 * 那份源码看着还是对的。所以这里在任务内部**真的数一次**进来几个人，
 * 记下峰值，再断言峰值 ≤ 上限。
 *
 * 跑法：node --import <tsx> tests/channel-queue.mjs
 */
const {
  runInChannel, resetChannelQueueForTest, runningOf, runningTotal, waitingCount,
  GLOBAL_LIMIT, DEFAULT_CHANNEL_LIMIT,
} = await import('../src/schedule/channel-queue.ts')

let bad = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} detail - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/**
 * 造一个能记录「同时在跑几个」的任务。
 *
 * @param {object} counter - 共享计数器（`{ now, peak }`）。
 * @param {number} ms - 每个任务占多久。
 * @returns {Function} 任务函数。
 */
function task(counter, ms) {
  return async () => {
    counter.now += 1
    counter.peak = Math.max(counter.peak, counter.now)
    await new Promise(r => setTimeout(r, ms))
    counter.now -= 1
    return 'ok'
  }
}

/* ── ① 同一渠道上限：2，连发 6 个 ─────────────────────────────────── */
console.log('① 同一渠道 maxConcurrency=2，连发 6 个')
{
  resetChannelQueueForTest()
  const counter = { now: 0, peak: 0 }
  const t0 = Date.now()
  const results = await Promise.all(
    Array.from({ length: 6 }, () => runInChannel('ch_a', 2, task(counter, 40))),
  )
  const spent = Date.now() - t0
  check('★★ 同时在跑的最大值 ≤ 2', counter.peak <= 2, String(counter.peak))
  check('★ 而且真的并发到了 2（不是退化成串行）', counter.peak === 2, String(counter.peak))
  check('★★ 6 个全部完成（没有拒绝）',
    results.length === 6 && results.every(r => r === 'ok'), String(results.length))
  /* 6 个 / 2 并发 × 40ms ≈ 120ms。串行会 > 240ms，这里给宽松上限。 */
  check('★ 总耗时接近「6 个分 3 批」（约 120ms）', spent < 240, String(spent) + 'ms')
  check('★ 跑完之后计数归零', runningOf('ch_a') === 0 && runningTotal() === 0 && waitingCount() === 0,
    JSON.stringify({ of: runningOf('ch_a'), total: runningTotal(), wait: waitingCount() }))
}

/* ── ② 全局上限：两个渠道各 3 个，全局 4 ─────────────────────────── */
console.log('')
console.log('② 两个渠道各 3 个，全局上限 ' + String(GLOBAL_LIMIT) + ' → 同时在跑 ≤ 全局上限')
{
  resetChannelQueueForTest()
  const counter = { now: 0, peak: 0 }
  /* 全局上限是常量 20，这里要验「它真的在起作用」，所以把两个渠道的上限设得很宽
   * （各 3 个不够触发全局闸门）—— 于是另造一个只有全局能挡住的情形：
   * 4 个渠道各 6 个共 24 个，超过全局 20。 */
  const jobs = []
  for (let ch = 0; ch < 4; ch += 1) {
    for (let i = 0; i < 6; i += 1) jobs.push(runInChannel('ch_g' + String(ch), 6, task(counter, 20)))
  }
  const results = await Promise.all(jobs)
  check('★★ 全场同时在跑 ≤ 全局上限 ' + String(GLOBAL_LIMIT),
    counter.peak <= GLOBAL_LIMIT, String(counter.peak))
  check('★★ 24 个全部完成（排队不拒绝）', results.length === 24, String(results.length))
  check('★ 峰值确实顶到了全局上限附近（闸门真的在工作）',
    counter.peak >= GLOBAL_LIMIT - 1, String(counter.peak))

  resetChannelQueueForTest()
  const c2 = { now: 0, peak: 0 }
  const jobs2 = []
  for (let ch = 0; ch < 2; ch += 1) {
    for (let i = 0; i < 3; i += 1) jobs2.push(runInChannel('ch_h' + String(ch), 3, task(c2, 30)))
  }
  await Promise.all(jobs2)
  check('★★ 两个渠道各 3 个（共 6 个）不超过全局上限',
    c2.peak <= GLOBAL_LIMIT && c2.peak === 6, String(c2.peak))
}

/* ── ③ 出错也要还槽位 ─────────────────────────────────────────────── */
console.log('')
console.log('③ 任务抛错也不吃掉名额')
{
  resetChannelQueueForTest()
  let errMsg = ''
  try {
    await runInChannel('ch_err', 1, async () => { throw new Error('上游 500') })
  } catch (e) { errMsg = e instanceof Error ? e.message : String(e) }
  check('★ 错误原样抛给调用方（不被吞）', errMsg === '上游 500', errMsg)
  check('★★ 抛错之后槽位已归还', runningOf('ch_err') === 0 && runningTotal() === 0,
    JSON.stringify({ of: runningOf('ch_err'), total: runningTotal() }))

  /* 再跑一个：名额没被占用的话它应该立刻能开跑。 */
  const after = await runInChannel('ch_err', 1, async () => 'ok')
  check('★★ 之后还能正常跑（名额真的回来了）', after === 'ok', after)
}

/* ── ④ 非法上限按默认值处理 ───────────────────────────────────────── */
console.log('')
console.log('④ 上限参数不合法时按默认值（不炸）')
{
  resetChannelQueueForTest()
  const counter = { now: 0, peak: 0 }
  const r = await runInChannel('ch_def', 0, task(counter, 10))
  check('★★ 上限传 0 不会让任务永不执行', r === 'ok', r)
  check('★ 0 按默认上限 ' + String(DEFAULT_CHANNEL_LIMIT) + ' 处理', counter.peak === 1, String(counter.peak))
  resetChannelQueueForTest()
}

console.log('')
console.log(bad === 0 ? '结论：渠道限流（渠道层 + 全局层）全部通过 ✓' : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
