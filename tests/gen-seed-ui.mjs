/** 生成工作台接上种子（票 09，2026-10-30）。
 *
 * # 起因（票面原话）
 *
 * 票 08 把后端接通了：`GenerateInput.seed` 有了，不给就随机，实际用的那个写进
 * `task.seed` 与记录的 `params.seed`。票 08 交付时提了一句：
 *
 * > 界面既没地方显示这次用的种子，也没有填种子的框 —— 用户想「用同一个种子再来一张」拿不到。
 *
 * 改前那一层核实过的现状：**看得见、但填不了、也用不上**。
 *
 * # 这一份盯什么
 *
 * | 判据 | 坏法 | 抓它的断言 |
 * |---|---|---|
 * | 1 | `formFields` 漏了 seed → 框都不出现 | 两个 kind 的字段表都含 `seed` |
 * | 2 | 框没有钩子 | `[data-ewb-gen-submit-seed]` 在 |
 * | 3 | 空着也发（发空串或 0） | 请求体里**没有** `seed` 这个键 |
 * | 4 | 发成字符串 | 请求体里是数字 `12345` |
 * | 5 | 非法值静默变「没填」 | 拦住、不发请求、说清 |
 * | 6/7 | 重跑拿不回种子 | 点重跑 → 框里有值 → 提交带上 |
 * | 8 | `paramsLine` 被改坏 | 那一行仍显示「种子 …」 |
 *
 * 跑法：`node scripts/run-tests.mjs gen-seed-ui`
 */
import { createRequire, register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
globalThis.localStorage = window.localStorage
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
/* `SVGElement` 必须挂**全局**：antd 的 Modal 读裸名，缺了整个进程直接崩。 */
globalThis.SVGElement = window.SVGElement
globalThis.DocumentFragment = window.DocumentFragment
globalThis.MouseEvent = window.MouseEvent
window.SVGElement = window.SVGElement ?? window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
globalThis.matchMedia = window.matchMedia
window.confirm = () => true

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

const NOW = Date.now()

/**
 * 两条生图记录：一条**带种子**（后端当时随机出来写进去的），一条老记录没有种子。
 *
 * 这两条同时验两件事：有种子的能读回来，没有的落到「不填」。
 */
const IMAGE_LOGS = [
  {
    id: 'img-seeded', kind: 'image', createdAt: NOW - 60000, endedAt: NOW - 54000,
    status: 'success', channelId: 'ch_local', model: 'qwen-image',
    prompt: '冰丝凉席 主图 白底', params: { size: '1024x1024', count: 1, seed: 987654321 },
    artifacts: [{ id: 'art-a1', width: 1024, height: 1024 }], usage: { images: 1 },
  },
  {
    id: 'img-old', kind: 'image', createdAt: NOW - 300000, endedAt: NOW - 291000,
    status: 'success', channelId: 'ch_local', model: 'qwen-image',
    prompt: '老记录，当初没有种子', params: { size: '1024x1024', count: 1 },
    artifacts: [{ id: 'art-b1', width: 1024, height: 1024 }], usage: { images: 1 },
  },
]

const MODELS = [
  { channelId: 'ch_local', channelName: '本地 ComfyUI', protocol: 'comfyui', modelId: 'qwen-image', modelLabel: 'Qwen Image', caps: ['image', 'video'] },
]

/** 收到的 `POST /generate` 请求体。 */
const bodies = []

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (p.startsWith('/api/ecom-workbench/gen-models')) {
    const kind = new URL('http://x' + p).searchParams.get('kind') ?? ''
    return ok({ ok: true, models: kind === '' ? MODELS : MODELS.filter(m => m.caps.includes(kind)) })
  }
  if (p.startsWith('/api/ecom-workbench/gen-logs')) {
    return ok({ ok: true, kind: 'image', logs: JSON.parse(JSON.stringify(IMAGE_LOGS)) })
  }
  if (p === '/api/ecom-workbench/generate' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'))
    bodies.push(body)
    const id = 'task-' + String(bodies.length)
    return ok({
      ok: true, id,
      task: {
        id, kind: 'image', status: 'submitted', stage: 'submitted',
        prompt: body.prompt ?? '', model: body.model ?? '', channelId: body.channelId ?? '',
        channelName: '本地 ComfyUI', createdAt: Date.now(), waitedMs: 0, artifacts: [],
      },
    })
  }
  return ok({ ok: true, items: [] })
}
window.fetch = host
globalThis.fetch = host

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/**
 * 挂一个组件，等副作用跑完。
 * @param el - 组件元素。
 * @returns 挂载句柄。
 */
async function mount(el) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise(r => setTimeout(r, 700)) })
  return { el: hostEl, unmount() { act(() => { root.unmount() }); hostEl.remove() } }
}

/**
 * 点一下。
 * @param el - 目标。
 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
}

/**
 * 改受控输入框的值（React 要原生 setter，直接赋 `value` 不触发 `onChange`）。
 * @param el - 输入框。
 * @param v - 新值。
 */
async function setValue(el, v) {
  if (el === null || el === undefined) return
  /* ⚠️ 按**实例**判该用哪个原型：提示词是 `<textarea>`，模型是 `<select>`。
   * 判错的话 jsdom 会抛「called on an object that is not a valid instance」——
   * 看着像源码写错了，其实是测试拿错了 setter。 */
  const proto =
    el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype
      : el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    el.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 120)) })
}

const iw = await import('../src/client/workbench/ImageWorkbench.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数层：字段表、种子的三档、请求体
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：formFields 含 seed / seedValue 三档 / submitBody 发不发 ═==')
{
  /* 判据 1 */
  check('★★★ formFields(image) 含 seed', iw.formFields('image').includes('seed'),
    iw.formFields('image').join(','))
  check('★★★ formFields(video) 含 seed', iw.formFields('video').includes('seed'),
    iw.formFields('video').join(','))
  /* 音频不做种子：它走的是音乐工作流，那条链路没有 seed 这个槽位。 */
  check('★★ formFields(audio) 不含 seed（那条链路不认它）', !iw.formFields('audio').includes('seed'),
    iw.formFields('audio').join(','))
  check('★★ GenDraft 上有 seed 字段（空草稿里是空串）', typeof iw.EMPTY_DRAFT.seed === 'string' && iw.EMPTY_DRAFT.seed === '',
    JSON.stringify(iw.EMPTY_DRAFT.seed))
  check('★★ 视频与音频的空草稿也带 seed', typeof iw.emptyDraftOf('video').seed === 'string'
    && typeof iw.emptyDraftOf('audio').seed === 'string')

  /* 三档（判据 3 / 4 / 5 的纯函数那一半）。 */
  check('★★★ 空串 → null（不填）', iw.seedValue('') === null, String(iw.seedValue('')))
  check('★★ 只有空格也算没填', iw.seedValue('   ') === null, String(iw.seedValue('   ')))
  check('★★★ 12345 → 数字 12345', iw.seedValue('12345') === 12345, String(iw.seedValue('12345')))
  check('★★★ abc → NaN（非法，不是「没填」）', Number.isNaN(iw.seedValue('abc')), String(iw.seedValue('abc')))
  check('★★ 负数与小数都算非法', Number.isNaN(iw.seedValue('-1')) && Number.isNaN(iw.seedValue('1.5')),
    String(iw.seedValue('-1')) + ' / ' + String(iw.seedValue('1.5')))
  check('★★ 带空格的 12345 也认（用户复制粘贴常带空格）', iw.seedValue(' 12345 ') === 12345,
    String(iw.seedValue(' 12345 ')))

  /* 报错文案三段式。 */
  const bad = iw.seedProblem('abc')
  check('★★★ 非法值有话说，且说清了「要什么」', bad.includes('非负整数'), bad)
  check('★★ 也说清了「留空会怎样」', bad.includes('随机'), bad)
  check('★★ 合法值不报错（空串也不报）', iw.seedProblem('12345') === '' && iw.seedProblem('') === '')

  /* 请求体（判据 3 / 4）。 */
  const none = iw.submitBody('image', { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm', seed: '' })
  check('★★★ 空种子时请求体里**没有** seed 这个键',
    !('seed' in none), JSON.stringify(none))
  const withNum = iw.submitBody('image', { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm', seed: '12345' })
  check('★★★ 填了 12345 时请求体里 seed 就是数字 12345', withNum.seed === 12345, JSON.stringify(withNum))
  check('★★★ 不是字符串（发字符串后端会当没给）', typeof withNum.seed === 'number', typeof withNum.seed)
  const withBad = iw.submitBody('image', { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm', seed: 'abc' })
  check('★★ 非法值不会被发出去（等价于没填，拦在提交前那道闸）', !('seed' in withBad), JSON.stringify(withBad))

  /* 判据 8：`paramsLine` 那条路没被破坏。 */
  check('★★★ paramsLine 仍显示「种子 987654321」',
    iw.paramsLine({ size: '1024x1024', count: 1, seed: 987654321 }).includes('种子 987654321'),
    iw.paramsLine({ size: '1024x1024', count: 1, seed: 987654321 }))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② draftFromRow：记录里有种子就读回来，没有就落回「不填」
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ② draftFromRow：params.seed → 表单值 ═==')
{
  const row = {
    id: 'x', kind: 'image', createdAt: NOW, status: 'success',
    prompt: 'p', model: 'm', channelId: 'c', paramsText: '', artifacts: [], live: false,
    raw: IMAGE_LOGS[0],
  }
  check('★★★ 有种子的记录读回成字符串 "987654321"',
    iw.draftFromRow('image', row).seed === '987654321', JSON.stringify(iw.draftFromRow('image', row).seed))

  const oldRow = { ...row, raw: IMAGE_LOGS[1] }
  check('★★ 老记录（没有 params.seed）落回空串 = 不填',
    iw.draftFromRow('image', oldRow).seed === '', JSON.stringify(iw.draftFromRow('image', oldRow).seed))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 界面层：框在、空着不发、填了发、非法拦住、重跑带回
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ③ 界面：种子框 + 提交行为 + 重跑带回 ═==')
{
  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true, kind: 'image', title: '生图工作台' }))
  const q = sel => m.el.querySelector(sel)

  /* 判据 2 */
  const box = q('[data-ewb-gen-submit-seed]')
  check('★★★ 表单里有种子输入框（钩子 data-ewb-gen-submit-seed）', box !== null)
  check('★★ 框默认是空的（不填 = 随机）', (box?.value ?? '') === '', JSON.stringify(box?.value))
  check('★★ 占位提示写了「留空则随机」', (box?.getAttribute('placeholder') ?? '').includes('留空'),
    box?.getAttribute('placeholder') ?? '(没有)')
  check('★★ 框上没写第二人称、没有疑问句（R6）',
    !/[你您?？]/.test(box?.getAttribute('placeholder') ?? ''), box?.getAttribute('placeholder') ?? '')

  /* 先把必填项填好，才轮得到种子那一层。
   *
   * ⚠️ **每次提交前都要重新填一遍**：提交成功之后表单会被清空
   * （那是既有行为，`doSubmit` 里 `setDraft(emptyDraftOf(kind))`，防重复提交）。
   * 不重填的话第二次提交会倒在「还差：提示词 / 模型」那道闸上，
   * 看起来像「种子没发出去」，其实是测试自己没把必填填够。 */
  const fillBase = async (prompt) => {
    await setValue(q('[data-ewb-gen-submit-prompt]'), prompt)
    await setValue(q('[data-ewb-gen-submit-model]'), 'qwen-image')
  }
  await fillBase('白底主图')

  /* 判据 3：空着提交 → 请求体里没有 seed。 */
  await click(q('[data-ewb-gen-submit-btn]'))
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
  check('★★ 空着种子也提交得出去（它不是必填）', bodies.length === 1, String(bodies.length))
  check('★★★ 空种子时请求体里**没有** seed 这个键（不是空串、不是 0）',
    bodies.length === 1 && !('seed' in bodies[0]), JSON.stringify(bodies[0] ?? {}))

  /* 判据 5：非法值 → 拦住、不发请求、说清。 */
  const before = bodies.length
  await setValue(q('[data-ewb-gen-submit-seed]'), 'abc')
  await fillBase('再一张')
  await click(q('[data-ewb-gen-submit-btn]'))
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
  check('★★★ 填了 abc 时拦住了（没有发请求）', bodies.length === before, String(bodies.length - before) + ' 条')
  const errText = q('[data-ewb-gen-error]')?.textContent ?? ''
  check('★★★ 并且说清了为什么（提到「非负整数」）', errText.includes('非负整数'), errText)
  check('★★ 也说清了「留空则随机」这条路', errText.includes('随机'), errText)
  check('★★ 框旁边也当场标了（不等提交才说）', q('[data-ewb-gen-submit-seed-bad]') !== null,
    q('[data-ewb-gen-submit-seed-bad]')?.textContent ?? '(没有)')

  /* 判据 4：填了 12345 → 真的发出去，且是数字。 */
  await setValue(q('[data-ewb-gen-submit-seed]'), '12345')
  check('★★ 改回合法值之后框旁边的告警消失', q('[data-ewb-gen-submit-seed-bad]') === null)
  await fillBase('第三张')
  await click(q('[data-ewb-gen-submit-btn]'))
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
  const lastBody = bodies[bodies.length - 1] ?? {}
  check('★★★ 填了 12345 就发出去了', bodies.length === before + 1, String(bodies.length))
  check('★★★ 而且 seed 是**数字** 12345，不是字符串', lastBody.seed === 12345, JSON.stringify(lastBody.seed))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 重跑：把记录里的种子填回**表单**，再提交时带上它
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ④ 重跑带回种子（判据 6 / 7）===')
{
  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true, kind: 'image', title: '生图工作台' }))
  const q = sel => m.el.querySelector(sel)

  const rerunBtn = q('[data-ewb-gen-rerun="img-seeded"]')
  check('★★ 那条带种子的记录上有「重跑」', rerunBtn !== null)
  const before = bodies.length
  await click(rerunBtn)
  check('★★ 「重跑」是纯前端：点了不发请求', bodies.length === before, String(bodies.length - before) + ' 条')

  /* 判据 6：表单里那个框要有值。 */
  check('★★★ 点「重跑」之后种子框里是那一条的 987654321',
    (q('[data-ewb-gen-submit-seed]')?.value ?? '') === '987654321',
    JSON.stringify(q('[data-ewb-gen-submit-seed]')?.value))
  check('★★ 历史那一行的参数串里本来就显示着种子（判据 8 的界面侧）',
    (q('[data-ewb-gen-row="img-seeded"]')?.textContent ?? '').includes('种子 987654321'),
    (q('[data-ewb-gen-row="img-seeded"]')?.textContent ?? '').slice(0, 120))

  /* 判据 7：填回之后再提交，请求体带着那个种子。 */
  await click(q('[data-ewb-gen-submit-btn]'))
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
  const last = bodies[bodies.length - 1] ?? {}
  check('★★★ 重跑之后提交，请求体带着读回来的种子',
    last.seed === 987654321, JSON.stringify(last.seed))
  check('★★ 提示词也是那一条的（重跑回填是整份，不只是种子）',
    String(last.prompt ?? '').includes('冰丝凉席'), String(last.prompt ?? ''))

  /* 老记录：点重跑后种子框回到空（不是留着上一条的）。 */
  await click(q('[data-ewb-gen-rerun="img-old"]'))
  check('★★ 点老记录（没有种子）重跑，种子框回到空',
    (q('[data-ewb-gen-submit-seed]')?.value ?? '') === '',
    JSON.stringify(q('[data-ewb-gen-submit-seed]')?.value))

  m.unmount()
}

console.log('')
console.log(envFailed() === 0 ? '结论：种子能填、不填就随机、重跑带得回 ✓' : '结论：有 ' + String(envFailed()) + ' 条不通过 ✗')

/**
 * 失败的断言条数。
 * @returns 条数。
 */
function envFailed() { return failed }
process.exit(failed === 0 ? 0 : 1)
