/** 渠道配置：挂 ComfyUI 工作流 + 测试连接（契约 CF，用户 m01076）。
 *
 * ## 这个测试守什么（对应验收 9 / 10 / 11）
 *
 *   ⑨ ComfyUI 渠道显示 12 个类别的下拉；**非 ComfyUI 渠道不显示**；
 *   ⑩ 下拉的选项**来自 `registry.ts` 的导出**（选项数跟着 `WORKFLOW_CATEGORIES`
 *      与 `listBuiltinWorkflows(cat)` 走，不是界面里硬编码一份名单）；
 *   ⑪ 「测试连接」调 `POST /channels/:id/test`，成功/失败两色都验。
 *
 * ## 为什么单开一个文件
 *
 * `tests/workbenches.mjs` 守的是**契约 BB 那批判据**（密钥不回显、已配置未配置）。
 * 这一批是**新能力**（挂工作流、测连接），混进去会让「红一条时分不清是哪一单坏了」。
 *
 * 跑法：node --import <tsx> tests/channels-workflow.mjs
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
/* ⚠️ `SVGElement` / `DocumentFragment` / `MouseEvent` / `CustomEvent` + 伪元素版
 * `getComputedStyle`：票 36 起这一段会挂 `FetchModelsDialog`（antd 的 Modal），
 * 而 `@rc-component/util` 的 `isDOM()` 会判 `node instanceof SVGElement` ——
 * jsdom 没往 globalThis 上挂这几个，缺了直接抛 `ReferenceError: SVGElement is not defined`，
 * 而且报错栈落在 `commitLayoutEffect` 里，看着像组件写错了。
 * 与 `tests/prompt-library.mjs` 顶部那段是同一套补齐（那边 2026-10-26 踩过同一次）。 */
for (const k of ['SVGElement', 'DocumentFragment', 'MouseEvent', 'CustomEvent']) {
  globalThis[k] = window[k]
}
const origGetComputedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (el) => origGetComputedStyle(el)
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.IS_REACT_ACT_ENVIRONMENT = true
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

/** 收到的请求。 */
const sent = []
/** 收到的请求体。 */
const bodies = []
/** 收到的预检请求体（票 36）。 */
const probes = []

/** 一条 ComfyUI 渠道、一条 OpenAI 渠道。 */
const CHANNELS = [
  {
    id: 'ch_comfy', name: '本地 ComfyUI', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'qwen-image', label: 'Qwen Image', caps: ['image'] }],
    maxConcurrency: 2, hasKey: false,
    /* 已经挂了一份：界面编辑时该显示成选中它。 */
    comfyuiT2iWorkflow: { id: 't2i-z-image-turbo', name: 'Z-Image-Turbo 文生图' },
  },
  {
    id: 'ch_openai', name: '某云端', protocol: 'openai', baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'flux-pro', label: 'Flux Pro', caps: ['image'] }],
    maxConcurrency: 5, hasKey: true,
  },
]

/** 测试连接的两种结论：按 id 决定。 */
const TEST_RESULT = {
  ch_comfy: { ok: true, message: '连得上（200）', status: 200 },
  ch_openai: { ok: false, message: '连不上：ECONNREFUSED', status: 0 },
}

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  sent.push(method + ' ' + p)
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })

  if (p === '/api/ecom-workbench/channels' && method === 'GET') {
    return ok({ ok: true, channels: JSON.parse(JSON.stringify(CHANNELS)) })
  }
  if (p === '/api/ecom-workbench/channels' && method === 'POST') {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return ok({ ok: true })
  }
  if (p.startsWith('/api/ecom-workbench/channels/') && p.endsWith('/test')) {
    const id = decodeURIComponent(p.slice('/api/ecom-workbench/channels/'.length, -'/test'.length))
    const r = TEST_RESULT[id] ?? { ok: false, message: '没有这个渠道：' + id, status: 0 }
    /* ⚠️ 宿主那条路由失败也回 200（「测试结果」不是「接口失败」），这里照抄。 */
    return ok({ ok: r.ok, result: r, error: r.ok ? undefined : r.message })
  }
  if (p === '/api/ecom-workbench/channels/probe' && method === 'POST') {
    /* 票 36：预检那条路。回包形状与 `/channels/:id/models` 一模一样
     * （它本来就是同一个 `fetchChannelModels` 出的）。 */
    probes.push(JSON.parse(String(init?.body ?? '{}')))
    return ok({ ok: true, models: [{ id: 'probe-model', label: '预检来的模型' }], url: 'https://api.example.com/v1/models' })
  }
  return ok({ ok: true, items: [] })
}
window.fetch = host
globalThis.fetch = host

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/** 挂一个组件。 */
async function mount(el, wait = 800) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise(r => setTimeout(r, wait)) })
  return {
    el: hostEl,
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/** 点一下。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise(r => setTimeout(r, 220)) })
}

const cs = await import('../src/client/workbench/ChannelSettings.tsx')
const reg = await import('../src/schedule/comfyui-workflows/registry.ts')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：类别 → 字段名、下拉选项来自注册表
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：12 个类别、下拉选项跟着注册表走 ===')
{
  check('★★ 类别正好 12 个（与宿主 generate.ts 的 CATEGORY_FIELD 同一份清单）',
    Object.keys(cs.CATEGORY_FIELD).length === 12 && reg.WORKFLOW_CATEGORIES.length === 12,
    String(Object.keys(cs.CATEGORY_FIELD).length) + ' / ' + String(reg.WORKFLOW_CATEGORIES.length))
  check('★★ 每个类别都有中文名',
    reg.WORKFLOW_CATEGORIES.every(c => (cs.CATEGORY_LABEL[c] ?? '') !== ''),
    reg.WORKFLOW_CATEGORIES.map(c => cs.CATEGORY_LABEL[c]).join(' / '))
  /* 字段名必须与宿主一致 —— 差一个字就是「保存了但读不到」。 */
  const wrong = reg.WORKFLOW_CATEGORIES.filter(c => !/^comfyui[A-Z].*Workflow$/.test(cs.CATEGORY_FIELD[c]))
  check('★★ 字段名都是 comfyui*Workflow 的形状（与宿主 CHANNEL_WORKFLOW_KEYS 同族）',
    wrong.length === 0, wrong.join('、') || '（全对）')

  const t2i = cs.workflowOptions('t2i')
  const builtinT2i = reg.listBuiltinWorkflows('t2i')
  check('★★ 文生图的下拉选项 = 「用内置默认」+ 注册表里这一类的全部候选',
    t2i.length === builtinT2i.length + 1,
    '选项 ' + String(t2i.length) + ' vs 注册表 ' + String(builtinT2i.length))
  check('★★ 第一项是「用内置默认」，值是空串（空值有语义：不填就用默认）',
    t2i[0]?.value === '' && t2i[0]?.label.startsWith('用内置默认'), t2i[0]?.label ?? '')
  check('★ 「用内置默认」那个标签写出了默认是哪一份',
    (t2i[0]?.label ?? '').includes(reg.listBuiltinWorkflows('t2i').find(w => w.isDefault)?.name ?? '（没有）'),
    t2i[0]?.label ?? '')
  /* 没有内置工作流的三类：只剩「用内置默认」，且标签说明这一类没有。 */
  const sr = cs.workflowOptions('superResolve')
  check('★★ 超分这一类没有内置工作流时只剩一项（标签说明没有）',
    sr.length === 1 && sr[0].label.includes('没有内置'), sr.map(o => o.label).join(' / '))
  check('★ 放大 / 多角度同样只有一项',
    cs.workflowOptions('upscale').length === 1 && cs.workflowOptions('angle').length === 1)

  /* 兜底：全部类别的选项加起来 = 注册表的 16 份 + 12 个「默认项」。 */
  const total = reg.WORKFLOW_CATEGORIES.reduce((n, c) => n + cs.workflowOptions(c).length, 0)
  check('★★ 12 个类别的选项总数 = 注册表 16 份 + 12 个「用内置默认」',
    total === reg.BUILTIN_WORKFLOWS.length + 12,
    '实际 ' + String(total) + ' vs ' + String(reg.BUILTIN_WORKFLOWS.length + 12))

  check('★★ 认得存下来的 `{ id, name }` 形状',
    cs.workflowIdOf({ id: 't2i-z-image-turbo', name: '随便' }) === 't2i-z-image-turbo')
  check('★ 也认得只有 name 的旧形状（按名字反查）',
    cs.workflowIdOf({ name: 'Z-Image-Turbo 文生图' }) === 't2i-z-image-turbo')
  check('★ 认不出来时给空串（不编一个 id）', cs.workflowIdOf({ name: '我自己的工作流' }) === '')
  check('★ 什么都不是时也不炸', cs.workflowIdOf(undefined) === '' && cs.workflowIdOf('字符串') === '')
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 界面：ComfyUI 渠道显示 12 个下拉，非 ComfyUI 不显示
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 界面：ComfyUI 才有工作流那一块 ===')
{
  sent.length = 0
  const { ChannelSettings } = cs
  const m = await mount(React.createElement(ChannelSettings, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  check('★★ 两条渠道都列出来了',
    m.el.querySelectorAll('[data-ewb-channel-row]').length === 2,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-channel-row]').length))

  /* 编辑 ComfyUI 那条 → 工作流块出现。 */
  await click(q('[data-ewb-channel-edit="ch_comfy"]'))
  const block = q('[data-ewb-channel-workflows]')
  check('★★ ComfyUI 渠道的表单里有工作流那一块', block !== null)
  const selects = [...m.el.querySelectorAll('[data-ewb-channel-workflow]')]
  check('★★ 12 个类别各一个下拉', selects.length === 12, '实际 ' + String(selects.length))
  check('★★ 下拉的类别 id 就是注册表那 12 个',
    selects.map(s => s.getAttribute('data-ewb-channel-workflow')).join(',') === reg.WORKFLOW_CATEGORIES.join(','),
    selects.map(s => s.getAttribute('data-ewb-channel-workflow')).join(','))
  /* 验收 10：选项来自注册表。 */
  const t2iSel = q('[data-ewb-channel-workflow="t2i"]')
  check('★★ 文生图下拉的选项数与注册表一致（不是界面硬编码的名单）',
    t2iSel?.querySelectorAll('option').length === reg.listBuiltinWorkflows('t2i').length + 1,
    '实际 ' + String(t2iSel?.querySelectorAll('option').length)
    + ' vs ' + String(reg.listBuiltinWorkflows('t2i').length + 1))
  check('★★ 那条渠道已挂的 t2i 工作流被选中了（编辑时不回落到默认）',
    t2iSel?.value === 't2i-z-image-turbo', '实际=' + String(t2iSel?.value))
  check('★ 代理地址 / token 两个输入框也在',
    q('[data-ewb-channel-proxyurl]') !== null && q('[data-ewb-channel-proxytoken]') !== null)
  check('★ 代理 token 是 password 型（不明文显示）',
    q('[data-ewb-channel-proxytoken]')?.getAttribute('type') === 'password')

  /* 切到 OpenAI 协议 → 工作流块消失。 */
  const protoSel = q('[data-ewb-channel-protocol]')
  const setProto = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  await act(async () => {
    setProto?.call(protoSel, 'openai')
    protoSel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
  check('★★ 协议改成 openai 之后工作流那一块**不显示了**',
    q('[data-ewb-channel-workflows]') === null)
  check('★ 12 个下拉也跟着消失（不是只藏了外壳）',
    m.el.querySelectorAll('[data-ewb-channel-workflow]').length === 0)

  /* 切回来 → 又出现（说明是「按协议显示」，不是「一开始才判断一次」）。 */
  await act(async () => {
    setProto?.call(protoSel, 'comfyui')
    protoSel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
  check('★ 协议改回 comfyui 之后又出现了',
    m.el.querySelectorAll('[data-ewb-channel-workflow]').length === 12)

  /* 保存时把选中的工作流带进请求体。 */
  const i2iSel = q('[data-ewb-channel-workflow="i2i"]')
  const setSel = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  await act(async () => {
    setSel?.call(i2iSel, 'i2i-flux2-dev')
    i2iSel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 150)) })
  await click(q('[data-ewb-channel-save]'))
  const saved = bodies[bodies.length - 1] ?? {}
  check('★★ 保存时把选中的工作流带进请求体（comfyuiI2iWorkflow）',
    saved.comfyuiI2iWorkflow !== undefined
    && saved.comfyuiI2iWorkflow.id === 'i2i-flux2-dev',
    JSON.stringify(saved.comfyuiI2iWorkflow ?? null))
  check('★ 没选（用内置默认）的那几类**不发那个键**（空值不等于「明确选了空」）',
    saved.comfyuiAudioWorkflow === undefined && saved.comfyuiUpscaleWorkflow === undefined,
    Object.keys(saved).filter(k => k.startsWith('comfyui')).join(','))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 测试连接：成功绿、失败红
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 测试连接：调 /channels/:id/test，成功/失败两色 ===')
{
  sent.length = 0
  const { ChannelSettings } = cs
  const m = await mount(React.createElement(ChannelSettings, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  check('★★ 每条渠道都有「测试连接」按钮',
    q('[data-ewb-channel-test="ch_comfy"]') !== null && q('[data-ewb-channel-test="ch_openai"]') !== null)
  check('★ 没点过时**不显示任何结论**（不显示假结论）',
    q('[data-ewb-channel-testresult="ch_comfy"]') === null)

  /* 成功那条。 */
  await click(q('[data-ewb-channel-test="ch_comfy"]'))
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
  check('★★ 点了之后调了 POST /channels/ch_comfy/test',
    sent.some(s => s === 'POST /api/ecom-workbench/channels/ch_comfy/test'),
    sent.filter(s => s.includes('/test')).join(' / ') || '（一次都没发）')
  const okEl = q('[data-ewb-channel-testresult="ch_comfy"]')
  check('★★ 成功时把返回的 message 显示出来',
    (okEl?.textContent ?? '').includes('连得上'), okEl?.textContent ?? '（没有结论块）')
  check('★★ 成功时带 data-ok（绿色那一支）', okEl?.getAttribute('data-ok') === '', okEl?.getAttribute('data-ok') ?? '（没有）')

  /* 失败那条。 */
  await click(q('[data-ewb-channel-test="ch_openai"]'))
  await act(async () => { await new Promise(r => setTimeout(r, 300)) })
  check('★★ 点了失败那条也调了 /test',
    sent.some(s => s === 'POST /api/ecom-workbench/channels/ch_openai/test'),
    sent.filter(s => s.includes('/test')).join(' / '))
  const badEl = q('[data-ewb-channel-testresult="ch_openai"]')
  check('★★ 失败时显示失败原因',
    (badEl?.textContent ?? '').includes('ECONNREFUSED'), badEl?.textContent ?? '（没有结论块）')
  check('★★ 失败时**不带** data-ok（红色那一支）', badEl?.getAttribute('data-ok') === null,
    String(badEl?.getAttribute('data-ok')))
  check('★ 成功与失败是两块不同的结论（没有串）',
    (okEl?.textContent ?? '') !== (badEl?.textContent ?? ''))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 票 36：填了密钥、还没保存，也能先验一遍并看到上游有哪些模型
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么这条必须验在**界面**层
 *
 * 后端那条 `POST /channels/probe` 由 `tests/channels.mjs` ⑩ 段验（真发请求、不落盘、
 * 回包不带密钥）。但那只能证明「接口通」—— 用户实际点的是渠道表单里那个按钮。
 * 两个环节任一处没接上，用户看到的就是「点了没反应」：
 *   · 新建渠道时按钮根本不出现（改之前就是这样：只给一句「保存之后再说」）
 *   · 按钮出现但走的是 `/channels//models`（空 id），必然 404
 *
 * ## 判据的三条反面
 *
 * | 验什么 | 反面 |
 * |---|---|
 * | 新建时按钮在、点了就发 | 只给一句「先保存」，等于这个能力不存在 |
 * | 发的是**表单里那三样** | 发了空 id、或发了盘上别的渠道的地址 —— 问错了对象 |
 * | 模型列出来 | 「验过了」但看不到上游有什么，用户还得手抄 id |
 */
console.log('')
console.log('=== ④ 票 36：没保存的渠道也能「测连通并列出模型」===')
{
  sent.length = 0
  probes.length = 0
  const { ChannelSettings } = cs
  const m = await mount(React.createElement(ChannelSettings, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  /* 进「新建」表单（不是编辑某条）。 */
  await click(q('[data-ewb-channel-new]'))
  check('★ 进了新建表单（有名称输入框）', q('[data-ewb-channel-name]') !== null)

  /* ★ 这一条是改动的核心：新建时按钮也得在。 */
  const fetchBtn = q('[data-ewb-channel-fetch]')
  check('★★★ 新建渠道时**也有**按钮（改之前这里只有一句「保存之后再说」）',
    fetchBtn !== null, fetchBtn?.textContent ?? '（没有按钮）')
  check('★★ 新建时按钮写的是「测连通并列出模型」（不是「拉取模型」—— 那时没有 id 可拉）',
    (fetchBtn?.textContent ?? '').includes('测连通'), fetchBtn?.textContent ?? '')
  check('★ 旁边那句说明点出了「不需要先保存」',
    (q('[data-ewb-channel-fetch-hint]')?.textContent ?? '').includes('不需要先保存'),
    q('[data-ewb-channel-fetch-hint]')?.textContent ?? '')

  /* 把地址与密钥填进去，模拟用户刚填完就想验。 */
  const setInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setInput?.call(q('[data-ewb-channel-baseurl]'), 'https://draft.example.com/v1')
    q('[data-ewb-channel-baseurl]').dispatchEvent(new window.Event('input', { bubbles: true }))
    setInput?.call(q('[data-ewb-channel-apikey]'), 'sk-just-typed')
    q('[data-ewb-channel-apikey]').dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })

  await click(q('[data-ewb-channel-fetch]'))
  const go = m.el.querySelector('[data-ewb-fetch-go]')
  check('★★ 点开弹窗，里面有执行按钮', go !== null, go?.textContent ?? '')
  check('★★ 弹窗里那个按钮标了 data-ewb-fetch-probe（走预检那条路）',
    go?.getAttribute('data-ewb-fetch-probe') === '')

  await click(go)
  check('★★★ 点下去发的是 POST /channels/probe（不是带空 id 的 /models）',
    sent.some(s => s === 'POST /api/ecom-workbench/channels/probe'),
    sent.filter(s => s.includes('channels')).join(' / ') || '（一次都没发）')
  check('★★ 而且**没有**发 `/channels//models` 那种带空 id 的请求',
    !sent.some(s => s.includes('/channels//models')),
    sent.filter(s => s.includes('models')).join(' / ') || '（没有 models 请求）')

  const pr = probes[0] ?? {}
  check('★★★ 发出去的是**表单里刚填的那三样**（协议 / 地址 / 密钥）',
    pr.protocol === 'openai' && pr.baseUrl === 'https://draft.example.com/v1' && pr.apiKey === 'sk-just-typed',
    JSON.stringify({ protocol: pr.protocol, baseUrl: pr.baseUrl, apiKey: pr.apiKey === 'sk-just-typed' ? '（对）' : '（不对）' }))
  check('★ 非 ComfyUI 不带 kind', pr.kind === undefined)

  const items = [...m.el.querySelectorAll('[data-ewb-fetch-item]')]
  check('★★★ 上游有哪些模型直接列出来了（不用先存、不用手抄 id）',
    items.length === 1 && items[0].getAttribute('data-ewb-fetch-item') === 'probe-model',
    items.map(i => i.getAttribute('data-ewb-fetch-item')).join(',') || '（一条都没有）')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log(failed === 0 ? '结论：渠道能挂工作流、能测连接、没保存也能先验 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
