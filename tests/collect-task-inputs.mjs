/** 任务中心：读开始节点声明、展开可选项再执行（票 05 第 7 条，2026-10-30）。
 *
 * # 用户原话
 *
 * 「我们的开始节点我记得是加了可设置内容的，这些东西要在任务中心体现，
 * 任务创建后读取开始节点的设置项目，然后点击任务中心的某个任务可以展开
 * 可选项执行。这个逻辑之前有没有做我忘了，应该需要开始节点声明可以加入
 * 什么参数，然后前端的任务是按照模板读取。」
 *
 * # 这一份盯什么
 *
 * | 判据 | 坏法 | 抓它的断言 |
 * |---|---|---|
 * | ⑤ | 不管有没有输入项都长表单 | `inputs` 为空时**没有** `[data-ewb-collect-input]` |
 * | ⑥ | 填的值没带进运行 | 提交后 SSE 的查询串里必须有填的值 |
 * | ⑦ | 必填没填也跑了 | 清空必填再提交 → 不发请求、屏上说清差哪项 |
 * | ⑧ | `startType === 'called'` 照样给执行按钮 | 不给按钮，改贴「只可被调用」并说原因 |
 *
 * 还有一条反向的：**查不到 `workflow/io` 时不许拦**（老存档没这条路由），
 * 照 `WorkflowList.startRun` 的做法直接跑 —— 拦下来的话「执行」会因为
 * 一个附加能力不可用而整个坏掉。
 *
 * 跑法：`node scripts/run-tests.mjs collect-task-inputs`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, mount, check } = env

/**
 * 装一个假 `EventSource`（两处都要设，见 `collect-live-report.mjs` 的说明）。
 * @returns {object[]} 开过的连接。
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

/** 桩里那两份采集工作流（名字必须是白名单里的，否则卡片根本不出来）。 */
const WF_ROWS = [
  { name: '全部下载', id: 'wf-a', nodes: 5, description: '天猫 + 抖音 + 千川', startType: 'manual', at: Date.now() },
  { name: '清洗入库', id: 'wf-b', nodes: 3, description: '清洗后入库', startType: 'manual', at: Date.now() },
]

/**
 * 挂任务中心，`/workflow/io` 的答复由 `ioReply` 决定。
 *
 * @param {object} opts - `{ io: (name) => object | null }`，`null` = 当作路由不存在（404）。
 * @returns {Promise<object>} 挂载句柄 + 收到的请求记录。
 */
async function mountCenter(opts) {
  const seen = { io: [], runs: [] }
  const realFetch = window.fetch
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    const method = String(init?.method ?? 'GET').toUpperCase()
    if (p === '/api/ecom-workbench/workflows' && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, dir: '/tmp', items: WF_ROWS, workflows: WF_ROWS }) }
    }
    if (p === '/api/ecom-workbench/collect/records') {
      return { ok: true, status: 200, json: async () => ({ ok: true, records: [] }) }
    }
    if (p.startsWith('/api/ecom-workbench/workflow/io')) {
      const name = decodeURIComponent(new URL('http://x' + p).searchParams.get('name') ?? '')
      seen.io.push(name)
      const reply = opts.io(name)
      if (reply === null) {
        return { ok: false, status: 404, json: async () => ({ ok: false, error: '没有这份工作流' }) }
      }
      return { ok: true, status: 200, json: async () => reply }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub

  const { CollectBoard } = await import('../src/client/workbench/CollectBoard.tsx')
  const m = await mount(React.createElement(CollectBoard, {
    active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
    onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
  }))
  const raw = m.unmount
  m.unmount = () => { raw(); window.fetch = realFetch; globalThis.fetch = realFetch }
  return { m, seen }
}

/**
 * 点一张卡片的执行按钮。
 * @param {object} m - 挂载句柄。
 * @param {string} name - 工作流名。
 */
async function clickRun(m, name) {
  const btn = m.el.querySelector('[data-ewb-collect-run="' + name + '"]')
  if (btn !== null) {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await env.settle()
  }
  return btn
}

/**
 * 往表单的某个输入框里填值（React 受控输入必须改 value 再派 input）。
 * @param {object} el - 输入框。
 * @param {string} v - 新值。
 */
async function typeInto(el, v) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, v)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
  await env.settle()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 没有输入项 → 不长表单，直接跑
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑤ inputs 为空时不给入口（不长一块空表单） ===')
{
  const opened = installFakeEs()
  const { m, seen } = await mountCenter({
    io: () => ({ ok: true, startType: 'manual', inputs: [], outputs: [] }),
  })
  await clickRun(m, '全部下载')

  check('★ 点执行时真的去读了开始节点声明', seen.io.includes('全部下载'), JSON.stringify(seen.io))
  check('★★★ inputs 为空时**没有**长出输入表单（`[data-ewb-collect-input]` 不存在）',
    m.el.querySelector('[data-ewb-collect-input]') === null)
  check('★★ 而是直接开跑了（开了一条 SSE）', opened.length === 1, String(opened.length))
  check('★★ 那一跑带的是空输入', opened.length > 0 && decodeURIComponent(opened[0].url).includes('inputs={}'),
    opened[0]?.url.slice(0, 120))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 有输入项 → 展开表单，填完提交，值进运行
 * ⑦ 必填没填 → 当场拦住
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑥⑦ 有输入项：展开表单、必填拦得住、填的值进运行 ===')
{
  const opened = installFakeEs()
  const { m } = await mountCenter({
    io: () => ({
      ok: true,
      startType: 'manual',
      inputs: [
        { name: '日期', description: '拉哪一天的数据', required: true, default: '2026-10-30' },
        { name: '店铺', description: '目标店铺名', required: false, default: '' },
      ],
      outputs: [],
    }),
  })
  await clickRun(m, '全部下载')

  const box = m.el.querySelector('[data-ewb-collect-input="全部下载"]')
  check('★★★ 有输入项时长出了填输入的入口，而且就在那张卡片内部',
    box !== null && box.closest('[data-ewb-collect-card]')?.getAttribute('data-ewb-collect-card') === '全部下载',
    box === null ? '(没有)' : String(box.closest('[data-ewb-collect-card]')?.getAttribute('data-ewb-collect-card')))
  check('★★ 用的是现成的 RunInputForm（不是另写一套）', box?.querySelector('[data-ewb-run-input]') !== null)
  check('★★ 还没提交之前**不开跑**（一条 SSE 都没有）', opened.length === 0, String(opened.length))
  check('★★ 表单标题带着工作流名', (box?.textContent ?? '').includes('全部下载'))

  const inputs = [...(box?.querySelectorAll('input') ?? [])]
  check('★ 两项输入各一个框', inputs.length === 2, String(inputs.length))
  check('★ 默认值预填了', inputs.some(i => i.value === '2026-10-30'),
    JSON.stringify(inputs.map(i => i.value)))
  check('★ 必填标出来了', (box?.textContent ?? '').includes('必填'))

  /* ── ⑦ 清空必填再提交 → 拦住，且说清差哪一项 ── */
  const req = inputs[0]
  await typeInto(req, '')
  const form = box?.querySelector('[data-ewb-run-input]')
  form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await env.settle()
  check('★★★ 必填清空时拦住了（一条 SSE 都没开）', opened.length === 0, String(opened.length))
  check('★★ 并且点名说清差哪一项（不是只说「有必填项没填」）',
    (m.el.textContent ?? '').includes('日期'), (m.el.textContent ?? '').slice(0, 160))

  /* ── ⑥ 填好再提交 → 真开跑，值进查询串 ── */
  await typeInto(req, '2026-10-31')
  await typeInto(inputs[1], '我的店')
  box?.querySelector('[data-ewb-run-input]')
    ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await env.settle()

  check('★★★ 填好再提交就开跑了', opened.length === 1, String(opened.length))
  const qs = decodeURIComponent(opened[0]?.url ?? '')
  check('★★★ 填的值进了运行的查询串', qs.includes('2026-10-31') && qs.includes('我的店'), qs.slice(0, 200))
  check('★★ 提交之后表单收起来了（不会一直挂在卡片上）',
    m.el.querySelector('[data-ewb-collect-input]') === null)
  check('★★ 输出区出现了（跑起来的样子）',
    m.el.querySelector('[data-ewb-collect-runpanel="全部下载"]') !== null)

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * 反向：查不到开始节点声明时**不许拦**
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== 反向：/workflow/io 404 时照旧能跑（附加能力不可用不该拖垮执行） ===')
{
  const opened = installFakeEs()
  const { m } = await mountCenter({ io: () => null })
  await clickRun(m, '全部下载')
  check('★★ 读不到声明时**没有**拦下执行', opened.length === 1, String(opened.length))
  check('★★ 也没有长一块空表单', m.el.querySelector('[data-ewb-collect-input]') === null)
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 只可被调用 → 不给执行按钮
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑧ 开始节点是「只可被调用」时不给执行按钮，且说清原因 ===')
{
  /* 复刻 `WorkflowList` 那一套：`called` 拦，`null`（老存档）照旧给。 */
  for (const [startType, want, label] of [['called', false, 'called'], [null, true, '老存档没有开始节点']]) {
    const rows = WF_ROWS.map(r => ({ ...r, startType }))
    const realFetch = window.fetch
    const stub = async (url, init) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '')
      const method = String(init?.method ?? 'GET').toUpperCase()
      if (p === '/api/ecom-workbench/workflows' && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ ok: true, dir: '/tmp', items: rows, workflows: rows }) }
      }
      if (p === '/api/ecom-workbench/collect/records') {
        return { ok: true, status: 200, json: async () => ({ ok: true, records: [] }) }
      }
      return realFetch(url, init)
    }
    window.fetch = stub
    globalThis.fetch = stub
    const { CollectBoard } = await import('../src/client/workbench/CollectBoard.tsx')
    const m = await mount(React.createElement(CollectBoard, {
      active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
      onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
    }))

    const btn = m.el.querySelector('[data-ewb-collect-run="全部下载"]')
    check('★★ ' + label + '：执行按钮' + (want ? '在' : '不显示'),
      want ? btn !== null : btn === null, btn === null ? '(没有)' : '(有)')

    if (!want) {
      const tag = m.el.querySelector('[data-ewb-collect-called="全部下载"]')
      check('★★★ 改贴「只可被调用」', (tag?.textContent ?? '').includes('只可被调用'), tag?.textContent ?? '')
      check('★★ 且说明白为什么（不是只不给按钮）',
        (tag?.getAttribute('title') ?? '').includes('缺输入'), tag?.getAttribute('title') ?? '')
    }

    m.unmount()
    window.fetch = realFetch
    globalThis.fetch = realFetch
  }
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：任务中心能读开始节点声明、展开可选项再执行 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
