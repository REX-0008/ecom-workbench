/** 画布那条派发通道里的「先开订阅、再发 /run」（票 28 第二步，2026-10-27）。
 *
 * ## 为什么这一条不能用真 `EventSource`
 *
 * Node 里没有浏览器那个 API。所以这里给全局装两个替身：
 * `EventSource`（假的事件源，可控地吐帧）与 `fetch`（不真发请求，只记下
 * 「调它的时候订阅是否已经建立」）。
 *
 * ## 这一条盯的是什么
 *
 * ① **顺序**：`fetch('/run')` 被调时，订阅必须**已经开好**（`open` 已经到）。
 *    写反了的话前几片字会丢 —— 症状是「有时候吐字、有时候不吐」。
 * ② `__runId` / `__nodeId` 真的塞进命令体了（宿主半靠这两个查表、贴字）。
 * ③ 一次调用一个订阅，用完就关（重试才不串台）。
 * ④ 拿到结果后 `EventSource` 已 `close()`（不关的话浏览器会自动重连）。
 * ⑤ 环境里没有 `EventSource` 时**不许炸**、照常派发（订阅是增强，不是前置条件）。
 *
 * 跑法：`node --import <tsx loader> tests/dispatch-stream.mjs`
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-dispatch-stream-'))
process.env.EWB_TEST_HOME = SANDBOX
process.env.EWB_TEST_SKILLS = join(SANDBOX, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

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

/* ══════════════════════════════════════════════════════════════════════
 * 替身：EventSource
 * ══════════════════════════════════════════════════════════════════════ */

/** 造过的每一个假订阅（按造出来的顺序）。 */
const made = []

/** 一个假的 `EventSource`。 */
class FakeEventSource {
  /**
   * @param url - 订阅地址。
   */
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    /** 构造之后**立刻**算「已连接」：真实实现里本机回环也是毫秒级，
     * 这里这样定是为了让「等就绪」那段有确定的结局（不需要等真网络）。 */
    this.readyState = 1
    made.push(this)
    /* 下一个微任务发 `open` —— 与真实实现「握手完成后触发」同形。 */
    Promise.resolve().then(() => { this.emit('open', {}) })
  }

  /**
   * 登记监听。
   * @param name - 事件名。
   * @param fn - 处理函数。
   */
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(fn)
  }

  /**
   * 触发事件（测试用）。
   * @param name - 事件名。
   * @param ev - 事件对象。
   */
  emit(name, ev) {
    for (const fn of this.listeners.get(name) ?? []) fn(ev)
  }

  /** 关掉（真实实现会停止重连）。 */
  close() { this.closed = true; this.readyState = 2 }
}

/** 造过的订阅里，`open` 已经派发过的那些（用来判顺序）。 */
let openFired = 0
const origEmit = FakeEventSource.prototype.emit
FakeEventSource.prototype.emit = function patchedEmit(name, ev) {
  if (name === 'open') openFired += 1
  return origEmit.call(this, name, ev)
}

/* ══════════════════════════════════════════════════════════════════════
 * 替身：fetch —— 记下「被调时 open 了几次」，然后回一个正常的派发结果
 * ══════════════════════════════════════════════════════════════════════ */

/** `fetch` 被调时的现场记录。 */
const fetchCalls = []

/**
 * 假 fetch。
 * @param url - 地址。
 * @param init - 选项。
 * @returns 假响应。
 */
async function fakeFetch(url, init) {
  fetchCalls.push({
    url: String(url),
    body: init?.body,
    /* ★ 关键：这一行就是「顺序」的判据 —— 发 /run 时订阅开好了没有。 */
    opensWhenCalled: openFired,
    madeWhenCalled: made.length,
  })
  /* 回应之前让出一拍，模拟宿主半在跑（期间订阅应该已经在听）。 */
  await new Promise(r => setTimeout(r, 10))
  return {
    ok: true,
    status: 200,
    async json() { return { results: [{ status: 'success', output: '好了' }] } },
  }
}

globalThis.EventSource = FakeEventSource
globalThis.fetch = fakeFetch

const { dispatchNode } = await import('../src/client/workbench/dispatch-client.ts')

/* ══════════════════════════════════════════════════════════════════════
 * ① 顺序 + 命令体 + 关订阅
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 先开订阅、再发 /run ===')
{
  made.length = 0
  fetchCalls.length = 0
  openFired = 0
  /** 收到的分片。 */
  const got = []
  const out = await dispatchNode(
    { runId: 'run-n-1', nodeId: 'ag9', executor: 'agent', command: { prompt: '甲' }, context: { workflowId: 'w', upstream: [], workdir: SANDBOX } },
    undefined,
    (c) => { got.push(c) },
  )

  check('★★ 派发成功', out.ok === true && out.status === 'success', JSON.stringify(out.status))
  check('★★ 开了 1 条订阅', made.length === 1, String(made.length) + ' 条')
  check('★★ 订阅地址带上了 runId',
    made[0]?.url === '/api/ecom-workbench/run-node-stream?runId=run-n-1', String(made[0]?.url))

  /* ★ 顺序判据：`fetch` 被调的那一刻，`open` 已经派发过。 */
  check('★★★ 判据：发 /run 时订阅已经 open（顺序不能反）',
    fetchCalls[0]?.opensWhenCalled === 1,
    'fetch 被调时 open 次数 = ' + String(fetchCalls[0]?.opensWhenCalled))

  const body = JSON.parse(String(fetchCalls[0]?.body))
  check('★★ 命令体里塞了 __runId', body[0]?.command?.__runId === 'run-n-1', String(body[0]?.command?.__runId))
  check('★★ 命令体里塞了 __nodeId（界面靠它把字贴到那个节点上）',
    body[0]?.command?.__nodeId === 'ag9', String(body[0]?.command?.__nodeId))
  check('★★ 没把 prompt 弄丢', body[0]?.command?.prompt === '甲', String(body[0]?.command?.prompt))

  /* 收帧：模拟宿主半往这条流推。 */
  made[0].emit('step', { data: JSON.stringify({ kind: 'stream', nodeId: 'ag9', text: '甲' }) })
  made[0].emit('step', { data: JSON.stringify({ kind: 'stream', nodeId: 'ag9', text: '乙' }) })
  check('★★ 分片交给了消费方', got.length === 2 && got[0].text === '甲', JSON.stringify(got))

  /* 坏帧不许炸。 */
  made[0].emit('step', { data: '不是 JSON' })
  made[0].emit('step', { data: JSON.stringify({ kind: 'log' }) })
  check('★★ 坏帧 / 别的事件被跳过（没有多出分片）', got.length === 2, String(got.length) + ' 条')

  check('★★ 拿到结果后订阅已关（不关的话浏览器会自动重连）',
    made[0]?.closed === true, String(made[0]?.closed))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 一次调用一个订阅（连派发两次 → 两条订阅，各自关掉）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 每次调用各开一条（重试不共用） ===')
{
  made.length = 0
  fetchCalls.length = 0
  openFired = 0
  /** 第一次收到的分片数。 */
  let first = 0
  /** 第二次收到的分片数。 */
  let second = 0
  await dispatchNode(
    { runId: 'run-a', nodeId: 'agA', executor: 'agent', command: { prompt: '甲' }, context: { workflowId: 'w', upstream: [], workdir: SANDBOX } },
    undefined,
    () => { first += 1 },
  )
  await dispatchNode(
    { runId: 'run-b', nodeId: 'agB', executor: 'agent', command: { prompt: '甲' }, context: { workflowId: 'w', upstream: [], workdir: SANDBOX } },
    undefined,
    () => { second += 1 },
  )
  check('★★ 两次派发开了两条订阅（不是共用一条）', made.length === 2, String(made.length) + ' 条')
  check('★★ 两条都关了', made.every(m => m.closed), JSON.stringify(made.map(m => m.closed)))
  check('★★ 各自的 runId 不一样',
    made[0]?.url !== made[1]?.url, String(made[0]?.url) + ' | ' + String(made[1]?.url))

  /* 往第一条推：只该进第一次那个消费方。 */
  made[0].emit('step', { data: JSON.stringify({ kind: 'stream', nodeId: 'agA', text: 'x' }) })
  check('★★ 往第一条推只进第一次那个消费方', first === 1 && second === 0,
    String(first) + ' / ' + String(second))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 没有消费方 / 没有 EventSource → 不开订阅，照常派发
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 订阅是增强，不是前置条件 ===')
{
  made.length = 0
  fetchCalls.length = 0
  const out = await dispatchNode(
    { runId: 'run-c', nodeId: 'agC', executor: 'agent', command: { prompt: '甲' }, context: { workflowId: 'w', upstream: [], workdir: SANDBOX } },
  )
  check('★★ 不传消费方 → 不开订阅', made.length === 0, String(made.length) + ' 条')
  check('★★ 照常派发成功', out.ok === true && out.status === 'success', JSON.stringify(out.status))
  const body = JSON.parse(String(fetchCalls[0]?.body))
  check('★★ 没订阅时不许往命令体里塞 __runId（那是「有人在听」才需要的东西）',
    body[0]?.command?.__runId === undefined, String(body[0]?.command?.__runId))

  /* 环境里没有 EventSource（jsdom / 老浏览器）。 */
  const saved = globalThis.EventSource
  delete globalThis.EventSource
  made.length = 0
  fetchCalls.length = 0
  try {
    const out2 = await dispatchNode(
      { runId: 'run-d', nodeId: 'agD', executor: 'agent', command: { prompt: '甲' }, context: { workflowId: 'w', upstream: [], workdir: SANDBOX } },
      undefined,
      () => { /* 收不到是正常的 */ },
    )
    check('★★ 没有 EventSource 时不炸、照常派发', out2.ok === true, JSON.stringify(out2.status))
    check('★★ 没有 EventSource 时也不塞 __runId',
      JSON.parse(String(fetchCalls[0]?.body))[0]?.command?.__runId === undefined, '')
  } finally {
    globalThis.EventSource = saved
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 派发失败也要关订阅
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 派发失败也关订阅 ===')
{
  made.length = 0
  fetchCalls.length = 0
  globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return {} } })
  try {
    const out = await dispatchNode(
      { runId: 'run-e', nodeId: 'agE', executor: 'agent', command: { prompt: '甲' }, context: { workflowId: 'w', upstream: [], workdir: SANDBOX } },
      undefined,
      () => { /* 不会有分片 */ },
    )
    check('★★ 失败如实返回', out.ok === false, String(out.error))
    check('★★ 失败时订阅也关了', made[0]?.closed === true, String(made[0]?.closed))
  } finally {
    globalThis.fetch = fakeFetch
  }
}

console.log('')
console.log(failed === 0
  ? '结论：先开订阅再发 /run、命令体带上两个键、用完就关 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
