/** 工作流级并发：排队而不是拒绝（计划 Step 11）。
 *
 * ## 为什么必须有上限
 *
 * 「同时启动多份」放开之后，第二个问题立刻出现：十份采集同时开，
 * 浏览器 / 子进程全被挤爆。所以要有上限 —— 而且是**排队**不是**拒绝**
 * （用户点了三份就该三份都跑完，第三份不该报「忙」）。
 *
 * ## 盯的四件事
 *
 *   ① 并发度**真的**不超过上限（用「同时在跑几个」实测，不看代码）；
 *   ② 超出的**进队列**，前面跑完后自动开跑（不是丢弃、不是报错）；
 *   ③ 同一份不许叠着开（否则同一批浏览器标签上互相踩）；
 *   ④ 调小上限**不砍正在跑的**（砍正在跑属于「中断」，那是另一件事）。
 *
 * 跑法：node --import <tsx> tests/run-queue.mjs
 */
import { createRunQueue } from '../src/workflow/run-queue.ts'

let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 造一份「跑一会儿」的活，并记录同时在跑的最高水位。
 * @param tracker - 水位记录。
 * @param ms - 跑多久。
 * @param key - 名字（结果里带回来）。
 */
function slowJob(tracker, ms, key) {
  return async () => {
    tracker.now += 1
    tracker.peak = Math.max(tracker.peak, tracker.now)
    await new Promise(resolve => setTimeout(resolve, ms))
    tracker.now -= 1
    return 'done:' + key
  }
}

console.log('=== 工作流级并发（排队而不是拒绝）===')

console.log('① 并发上限是真的（同时最多跑 limit 份）')
{
  const q = createRunQueue(2)
  const t = { now: 0, peak: 0 }
  const jobs = ['A', 'B', 'C', 'D', 'E'].map(k => q.run(k, slowJob(t, 40, k)))
  const results = await Promise.all(jobs)
  check('★ 同时在跑的最高水位 = 上限 2', t.peak === 2, String(t.peak))
  check('五份**全部**跑完了（没有丢弃、没有拒绝）', results.length === 5 && results.every(r => r.startsWith('done:')),
    results.join(','))
  check('跑完后队列空了', q.stats().running === 0 && q.stats().queued === 0,
    JSON.stringify(q.stats()))
}

console.log('')
console.log('② 超出的在**排队**（不是报错、不是直接开跑）')
{
  const q = createRunQueue(1)
  const t = { now: 0, peak: 0 }
  const p1 = q.run('A', slowJob(t, 50, 'A'))
  /* 立刻看队列：A 在跑，B / C 应当排队中。 */
  const p2 = q.run('B', slowJob(t, 10, 'B'))
  const p3 = q.run('C', slowJob(t, 10, 'C'))
  const mid = q.stats()
  check('★ 跑起来之后立刻排队（running=1、queued=2）',
    mid.running === 1 && mid.queued === 2, JSON.stringify(mid))
  const all = await Promise.all([p1, p2, p3])
  check('三份都跑完了（排队不是丢弃）', all.length === 3, all.join(','))
  check('★ 并发 1 时水位从不超过 1', t.peak === 1, String(t.peak))
}

console.log('')
console.log('③ 同一份不许叠着开')
{
  const q = createRunQueue(2)
  const t = { now: 0, peak: 0 }
  const p1 = q.run('同名', slowJob(t, 30, 'x'))
  let rejected = ''
  try {
    await q.run('同名', slowJob(t, 10, 'y'))
  } catch (e) {
    rejected = e instanceof Error ? e.message : String(e)
  }
  check('★ 同名第二次被拒（不是悄悄又跑一份）', rejected !== '', rejected)
  check('拒的理由说清了是「同一份」', rejected.includes('同一份') || rejected.includes('已经在跑'), rejected)
  await p1
  check('第一份照常跑完（拒绝不影响它）', t.peak === 1, String(t.peak))
  /* 跑完之后同一个名字可以再用（不是永久占位）。 */
  const again = await q.run('同名', async () => 'again')
  check('★ 跑完之后同名可以再用（不是永久锁死）', again === 'again', String(again))
}

console.log('')
console.log('④ 调小上限不砍正在跑的（砍正在跑属于「中断」，另一件事）')
{
  const q = createRunQueue(3)
  const t = { now: 0, peak: 0 }
  const jobs = ['A', 'B', 'C'].map(k => q.run(k, slowJob(t, 60, k)))
  await new Promise(resolve => setTimeout(resolve, 10))
  q.setLimit(1)
  const after = q.stats()
  check('★ 三份已经在跑的不会被砍（running 仍是 3）', after.running === 3, JSON.stringify(after))
  await Promise.all(jobs)
  check('三份都跑完了', t.peak <= 3, String(t.peak))
  /* 之后新进来的按新上限走。 */
  const t2 = { now: 0, peak: 0 }
  const more = ['D', 'E', 'F'].map(k => q.run(k, slowJob(t2, 20, k)))
  await Promise.all(more)
  check('★ 之后新进来的按新上限（1）跑', t2.peak === 1, String(t2.peak))
}

console.log('')
console.log('⑤ 失败不卡队列（一份挂了，后面的照跑）')
{
  const q = createRunQueue(1)
  const p1 = q.run('会挂', async () => { throw new Error('炸了') })
  const p2 = q.run('正常', async () => 'ok')
  let err = ''
  try { await p1 } catch (e) { err = e instanceof Error ? e.message : String(e) }
  check('失败的那份把错传出来了', err === '炸了', err)
  const ok = await p2
  check('★ 后面那份照常跑（失败没卡住队列）', ok === 'ok', String(ok))
  check('队列已清空', q.stats().running === 0 && q.stats().queued === 0, JSON.stringify(q.stats()))
}

console.log('')
console.log('⑥ 上限非法值有兜底（不会变成「无限并发」）')
{
  const q = createRunQueue(0)
  check('上限 0 → 当 1（不是无限）', q.stats().limit === 1, String(q.stats().limit))
  const q2 = createRunQueue(NaN)
  check('上限 NaN → 当 2', q2.stats().limit === 2, String(q2.stats().limit))
  q2.setLimit(-5)
  check('改成负数 → 当 1', q2.stats().limit === 1, String(q2.stats().limit))
}

console.log('')
console.log(failed === 0 ? '结论：工作流级并发全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
