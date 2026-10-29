/** 任务中心：跑的时候显示**任务记录（汇报）**，不是节点运行历史（票 05，2026-10-30）。
 *
 * # 用户原话
 *
 * 「自动化任务中心，工作流在跑的时候下半部分显示不是任务记录类型的工作输出，
 * 而是运行历史类型的。并且跑完了之后只显示是否成功，这个逻辑不对，应该是
 * 跑的时候一遍跑一边汇报任务记录，直接在那个任务的 tab 下显示，跑完了不清楚
 * 而是直接显示，下次重新跑才清理上一次的记录。」
 *
 * # 这一份盯什么
 *
 * | 判据 | 坏法 | 抓它的断言 |
 * |---|---|---|
 * | ① | 只收 `report` 写漏了 → 节点级事件照样刷进来 | 推 6 种事件，屏上只该有 2 条 |
 * | ② | 汇报的 `message` 没取出来 → 显示成「n1 report」 | 每条的文字必须等于 `entry.message` |
 * | ③ | `done` 一到就把汇报换成一句成败 | `done` 之后汇报条数不变，且结论行是**追加** |
 * | ④ | 重跑不清上一次 → 两次的汇报叠在一起 | 换一次输入（= 重跑）后条数归零重新长 |
 * | ⑤ | 顺手改了默认模式 → 画布与列表页画面变了 | 同一批事件喂进默认模式，逐行字面量比对 |
 *
 * ⑤ 是这一单最要紧的防回归：票面要求「画布与列表页一个字不变」。
 * 判据不是「看起来差不多」，而是**每一行的文字拼起来逐字相等**。
 *
 * 跑法：`node scripts/run-tests.mjs collect-live-report`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, mount, check } = env

/**
 * 装一个假 `EventSource`。
 *
 * ⚠️ **两处都要设**：源码里判的是 `typeof EventSource === 'undefined'`（全局那个名字），
 * 而 jsdom 里 `globalThis` 与 `window` 不是同一个对象 —— 只设 `window.EventSource`
 * 的话代码仍然走「这个环境不支持实时推送」那条退路，几条断言全验不到。
 *
 * @returns {object[]} 收到连接的数组（每开一条往里 push 一个）。
 */
function installFakeEs() {
  const opened = []
  class FakeEs {
    constructor(url) {
      this.url = String(url)
      this.handlers = {}
      this.closed = false
      opened.push(this)
    }
    addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn) }
    close() { this.closed = true }
  }
  window.EventSource = FakeEs
  globalThis.EventSource = FakeEs
  return opened
}

/**
 * 往一条假连接上推一帧 `step`。
 * @param {object} es - 假连接。
 * @param {object} payload - 帧内容。
 */
function emitStep(es, payload) {
  for (const fn of (es?.handlers.step ?? [])) fn({ data: JSON.stringify(payload) })
}

/**
 * 往一条假连接上推 `done`。
 * @param {object} es - 假连接。
 * @param {object} payload - 收尾信息。
 */
function emitDone(es, payload) {
  for (const fn of (es?.handlers.done ?? [])) fn({ data: JSON.stringify(payload) })
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 只显示汇报：节点级事件一条都不进
 * ② 每一条的文字就是 `entry.message`（不是 nodeId + kind）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 只显示汇报：推 6 种事件，屏上只该有 2 条汇报 ===')
{
  const opened = installFakeEs()
  const { FlowRunPanel } = await import('../src/client/workbench/FlowRunPanel.tsx')
  const m = await mount(React.createElement(FlowRunPanel, {
    name: '全部下载', inputs: {}, reportsOnly: true, onClose: () => {},
  }))
  const es = opened[opened.length - 1]
  check('★ 传了 reportsOnly 仍然只开一条 SSE（没有多开第二条路）',
    opened.length === 1, String(opened.length))

  /* 六种节点级事件 + 两条汇报，混在一起推 —— 真实引擎就是这样交错的。 */
  const nodewise = [
    { kind: 'queued', nodeId: 'n1' },
    { kind: 'started', nodeId: 'n1', label: '① 天猫下载' },
    { kind: 'log', nodeId: 'n1', line: '这是节点自己的日志，任务中心不该显示' },
    { kind: 'success', nodeId: 'n1' },
    { kind: 'skipped', nodeId: 'n2' },
    { kind: 'failed', nodeId: 'n3', error: '这是节点级失败原因，任务中心不该显示' },
  ]
  for (const f of nodewise) emitStep(es, f)
  await env.settle()

  const reports = () => [...m.el.querySelectorAll('[data-ewb-flow-report]')]
  check('★★★ 节点级事件一条都没进来（六种全推了，条数仍是 0）',
    reports().length === 0, String(reports().length))
  const cardText = m.el.textContent ?? ''
  check('★★ 节点级日志的文字没漏到屏上', !cardText.includes('这是节点自己的日志'))
  check('★★ 节点级失败原因没漏到屏上', !cardText.includes('这是节点级失败原因'))

  emitStep(es, { kind: 'report', nodeId: 'n1', entry: { message: '已下载天猫订单 128 条', type: 'info' } })
  emitStep(es, { kind: 'report', nodeId: 'n2', entry: { message: '已清洗入库 128 条', type: 'success' } })
  await env.settle()

  check('★★★ 两条汇报都进来了', reports().length === 2, String(reports().length))
  check('★★★ 每条的文字就是 entry.message（不是「n1 report」那种认不出的东西）',
    reports()[0]?.textContent?.includes('已下载天猫订单 128 条') === true
    && reports()[1]?.textContent?.includes('已清洗入库 128 条') === true,
    JSON.stringify(reports().map(e => e.textContent)))
  check('★★ 屏上没有 nodeId 冒充的文字', !(m.el.textContent ?? '').includes('report'))

  /* 空 message 的汇报要丢掉（一条空白行比不显示更糟）。 */
  emitStep(es, { kind: 'report', nodeId: 'n1', entry: { message: '' } })
  emitStep(es, { kind: 'report', nodeId: 'n1', entry: {} })
  emitStep(es, { kind: 'report', nodeId: 'n1' })
  await env.settle()
  check('★★ 空 message 的汇报不占一行（仍是 2 条）', reports().length === 2, String(reports().length))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ done 到了**不替换**汇报，结论是追加在下面
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ③ 跑完不清空：汇报留着，结论一行追加在下面 ===')
{
  const opened = installFakeEs()
  const { FlowRunPanel } = await import('../src/client/workbench/FlowRunPanel.tsx')
  const m = await mount(React.createElement(FlowRunPanel, {
    name: '全部下载', inputs: {}, reportsOnly: true, onClose: () => {},
  }))
  const es = opened[opened.length - 1]
  emitStep(es, { kind: 'report', nodeId: 'n1', entry: { message: '第一句汇报' } })
  emitStep(es, { kind: 'report', nodeId: 'n2', entry: { message: '第二句汇报' } })
  await env.settle()
  const beforeDone = m.el.querySelectorAll('[data-ewb-flow-report]').length
  emitDone(es, { ok: true, ran: ['n1', 'n2'], declaredOutputs: {} })
  await env.settle()

  const afterDone = m.el.querySelectorAll('[data-ewb-flow-report]').length
  check('★★★ done 之后汇报条数不变（2 → ' + String(afterDone) + '），没有被换成一句成败',
    afterDone === beforeDone && afterDone === 2, String(beforeDone) + ' → ' + String(afterDone))
  const text = m.el.textContent ?? ''
  check('★★ 汇报正文还在屏上', text.includes('第一句汇报') && text.includes('第二句汇报'))
  check('★★ 结论那行也在（追加，不是替换）', text.includes('执行完成'), text.slice(0, 120))

  /* 失败时同理：汇报留着，结论说清为什么。 */
  const m2 = await mount(React.createElement(FlowRunPanel, {
    name: '清洗入库', inputs: {}, reportsOnly: true, onClose: () => {},
  }))
  const es2 = opened[opened.length - 1]
  emitStep(es2, { kind: 'report', nodeId: 'n1', entry: { message: '失败前那句汇报' } })
  await env.settle()
  emitDone(es2, { ok: false, aborted: true, ran: ['n1'], error: '登录态失效' })
  await env.settle()
  const t2 = m2.el.textContent ?? ''
  check('★★ 失败时汇报也留着', m2.el.querySelectorAll('[data-ewb-flow-report]').length === 1
    && t2.includes('失败前那句汇报'), String(m2.el.querySelectorAll('[data-ewb-flow-report]').length))
  check('★★ 失败时结论写明原因', t2.includes('执行中断') && t2.includes('登录态失效'), t2.slice(0, 120))

  m.unmount()
  m2.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 下一次重跑才清上一次
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ④ 重跑才清上一次（换一次输入 = 重跑） ===')
{
  const opened = installFakeEs()
  const { FlowRunPanel } = await import('../src/client/workbench/FlowRunPanel.tsx')
  const props = { name: '全部下载', inputs: {}, reportsOnly: true, onClose: () => {} }
  const m = await mount(React.createElement(FlowRunPanel, props))
  const es1 = opened[opened.length - 1]
  emitStep(es1, { kind: 'report', nodeId: 'n1', entry: { message: '上一次的第一句' } })
  emitStep(es1, { kind: 'report', nodeId: 'n2', entry: { message: '上一次的第二句' } })
  await env.settle()
  check('★★ 重跑之前有 2 条', m.el.querySelectorAll('[data-ewb-flow-report]').length === 2)

  /* 换输入 = 用户又点了一次执行并填了不同的值 → 同一条 effect 重跑。 */
  await m.rerender(React.createElement(FlowRunPanel, { ...props, inputs: { day: '2026-10-31' } }))
  const es2 = opened[opened.length - 1]
  check('★ 重跑开了新连接', opened.length === 2 && es2 !== es1, String(opened.length))
  check('★★★ 上一次的两句被清掉了（新的一轮从零开始）',
    m.el.querySelectorAll('[data-ewb-flow-report]').length === 0,
    String(m.el.querySelectorAll('[data-ewb-flow-report]').length))
  check('★★ 屏上不再有上一次的文字',
    !(m.el.textContent ?? '').includes('上一次的第一句'))

  emitStep(es2, { kind: 'report', nodeId: 'n1', entry: { message: '这一次的汇报' } })
  await env.settle()
  const now = [...m.el.querySelectorAll('[data-ewb-flow-report]')].map(e => e.textContent ?? '')
  check('★★ 新一轮的汇报单独显示', now.length === 1 && now[0].includes('这一次的汇报'), JSON.stringify(now))

  /* 填的值要真的进查询串（不然「重跑」用的还是上一次的空输入）。 */
  check('★★ 填的输入进了 SSE 的查询串', es2.url.includes('inputs=') && decodeURIComponent(es2.url).includes('2026-10-31'),
    es2.url.slice(0, 160))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 默认模式（画布 / 列表页）逐字不变
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑤ 不传 reportsOnly 时，同一批事件渲染出来的每一行逐字不变 ===')
{
  const opened = installFakeEs()
  const { FlowRunPanel } = await import('../src/client/workbench/FlowRunPanel.tsx')
  /* ⚠️ **不传 reportsOnly** —— 这就是画布与列表页那条路。 */
  const m = await mount(React.createElement(FlowRunPanel, {
    name: '抖音商品流水线', inputs: {}, onClose: () => {},
  }))
  const es = opened[opened.length - 1]
  const frames = [
    { kind: 'queued', nodeId: 'n1' },
    { kind: 'started', nodeId: 'n1', label: '① 天猫下载' },
    { kind: 'log', nodeId: 'n1', line: '一条日志' },
    { kind: 'success', nodeId: 'n1' },
    { kind: 'report', nodeId: 'n2', entry: { message: '一条汇报' } },
    { kind: 'failed', nodeId: 'n3', error: '坏了' },
  ]
  for (const f of frames) { emitStep(es, f); await env.settle() }

  /* ⚠️ 这里**故意用字面量**，不照着源码现算一遍 ——
   * 照源码算的话，我把源码改了、断言也跟着变，等于没钉。
   *
   * 行首那个标记来自 `MARK`（`:87`），`report` 不在表里 → 落回一个空格，
   * 所以那一行是「空格 + n2 report」。这个观感不好，但它是**改动之前就有的行为**，
   * 本单要求「一个字不变」，所以断的就是这个字面量。 */
  const lines = [...(m.el.querySelectorAll('[data-ewb-flow-panel] > div:nth-of-type(2) > div') ?? [])]
    .map(el => el.textContent ?? '')
  const want = [
    '▸n1 ① 天猫下载',
    ' 一条日志',
    '✓n1 success',
    ' n2 report',
    '✕n3：坏了',
  ]
  check('★★★ 默认模式的五行**逐字**等于改动前的样子', JSON.stringify(lines) === JSON.stringify(want),
    JSON.stringify(lines))
  check('★★ 默认模式里没有出现汇报专用容器（那一支没被误开）',
    m.el.querySelector('[data-ewb-flow-reports]') === null)
  check('★★ 默认模式里也没有 [data-ewb-flow-report]（那是另一支的钩子）',
    m.el.querySelector('[data-ewb-flow-report]') === null)
  /* `queued` 照旧不显示（既有行为，`worthShowing`）。 */
  check('★ queued 照旧被过滤掉', !lines.some(l => l.includes('queued')), JSON.stringify(lines))

  m.unmount()
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：跑的时候显示的是任务记录，跑完留着不清 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
