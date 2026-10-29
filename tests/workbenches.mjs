/** 两个工作台 + 配置格（契约 BB，计划 §三 Step 5）。
 *
 * ## 这个测试守什么（对应验收 5 / 6 / 7 / 8 / 9）
 *
 *   ① **生图工作台**：三条记录按时间倒序、每条显示参数、点第二条「重跑」把
 *      参数填回表单（**纯前端，不发请求**）；
 *   ② **视频创作台**：两条 `pending` 显示两条、「已等 N 秒」秒数不同、
 *      **没有百分比进度条**、**没有「取消」按钮**；
 *   ③ **配置格**：渠道列表显示「已配置 / 未配置」、**响应里的密钥明文不进 DOM**；
 *   ④ **三个界面里都没有结算类字样**。
 *
 * ## ⚠️ 生成链路不存在，这些记录是**手工造的**
 *
 * 执行文档 §五 已定替代判据。这个测试的桩数据就是那三条 / 两条手工记录的形状
 * （字段与 `src/schedule/gen-logs.ts` 的 `GenLog` 十五个字段一致）。
 * **不许把「列表里出现了三条」写成「生成跑通了」** —— 它只说明界面读得对。
 *
 * 跑法：node --import <tsx> tests/workbenches.mjs
 */
import { readFileSync } from 'node:fs'
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
/* ⚠️ antd 的 Modal 要用这几个（2026-10-26 加：结果墙加了「点开看大图」才需要）。
 * `@rc-component/util` 的 `isDOM()` 判 `node instanceof SVGElement`，缺了直接抛
 * `ReferenceError: SVGElement is not defined` —— 而那是在 `commitLayoutEffect` 里抛的，
 * 报错栈离真正原因很远，看着像组件写错了。真实浏览器都有，补上不算绕错。 */
globalThis.SVGElement = window.SVGElement
globalThis.DocumentFragment = window.DocumentFragment
globalThis.MouseEvent = window.MouseEvent
window.SVGElement = window.SVGElement ?? window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.getComputedStyle = window.getComputedStyle
/* jsdom 没实现「带伪元素的 getComputedStyle」，antd 会用它量动画状态 —— 吞掉即可。 */
const origGetComputedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (el) => origGetComputedStyle(el)
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
globalThis.matchMedia = window.matchMedia

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

/** 现在（固定下来，免得计时器断言在跨秒时抖）。 */
const NOW = Date.now()

/* ── 手工造的三条生图记录（形状照执行文档 §2.2 十五个字段）──────────────
 *
 * 时间上故意错开：第 1 条最新（60 秒前）、第 2 条 5 分钟前、第 3 条 1 小时前。
 * 断言要的是「按 `createdAt` 倒序」——所以界面上第 0 行必然是 img-new。 */
const IMAGE_LOGS = [
  {
    id: 'img-new', kind: 'image', createdAt: NOW - 60000, endedAt: NOW - 54000,
    status: 'success', channelId: 'ch_local', model: 'gpt-image-1',
    prompt: '冰丝凉席 主图 白底', params: { size: '1024x1024', count: 2, seed: 12345 },
    artifacts: [{ id: 'art-a1', width: 1024, height: 1024, bytes: 204800 }, { id: 'art-a2', width: 1024, height: 1024, bytes: 198000 }],
    usage: { images: 2 }, source: 'workbench',
  },
  {
    id: 'img-mid', kind: 'image', createdAt: NOW - 300000, endedAt: NOW - 291000,
    status: 'success', channelId: 'ch_remote', model: 'flux-pro',
    prompt: '详情图 卖点三个角标', params: { size: '832x1216', count: 1 },
    artifacts: [{ id: 'art-b1', width: 832, height: 1216 }],
    usage: { images: 1 }, source: 'canvas', canvasId: 'cv_demo', canvasNodeId: 'n3',
  },
  {
    id: 'img-old', kind: 'image', createdAt: NOW - 3600000,
    status: 'failed', channelId: 'ch_remote', model: 'flux-pro',
    prompt: '视频封面（这条失败了）', params: { size: '1024x1024', count: 1 },
    artifacts: [], usage: { images: 1 }, error: '上游返回 429：额度用完了，等一会再试',
  },
]

/* ── 手工造的两条视频记录：都是 pending，createdAt 差 5 秒 ─────────────── */
const VIDEO_LOGS = [
  {
    id: 'vid-a', kind: 'video', createdAt: NOW - 12000,
    status: 'pending', channelId: 'ch_remote', model: 'kling-v2',
    prompt: '床上一摊水，凉席一铺就干', params: { seconds: '15', ratio: '9:16' },
    artifacts: [], usage: {},
  },
  {
    id: 'vid-b', kind: 'video', createdAt: NOW - 7000,
    status: 'pending', channelId: 'ch_remote', model: 'kling-v2',
    prompt: '面料特写，水珠滚落', params: { seconds: '15', ratio: '9:16' },
    artifacts: [], usage: {},
  },
]

/* ── 渠道（两条：一条配了密钥、一条没配）─────────────────────────────────
 *
 * ⚠️ `hasKey` 是布尔，响应里**没有**密钥字段 —— 这是宿主的设计
 * （`src/schedule/channels.ts` 分两个文件存）。
 * 下面那条「明文不进 DOM」的断言会往响应里**故意塞一个假密钥**，
 * 验「即使有人把它塞进响应，界面也不会显示」。 */
const FAKE_SECRET = 'sk-THIS-MUST-NOT-APPEAR-12345'
const CHANNELS = [
  {
    id: 'ch_local', name: '本地 ComfyUI', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'sd-xl', label: 'SDXL', caps: ['image'] }], maxConcurrency: 2, hasKey: true,
  },
  {
    id: 'ch_remote', name: '某云端', protocol: 'openai', baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'flux-pro', label: 'Flux Pro', caps: ['image'] }, { id: 'kling-v2', label: 'Kling v2', caps: ['video'] }],
    maxConcurrency: 5, hasKey: false,
  },
]

/** 收到的请求。 */
const sent = []

/** 桩宿主。 */
const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  sent.push(method + ' ' + p)
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (p.startsWith('/api/ecom-workbench/gen-logs')) {
    const u = new URL('http://x' + p)
    const kind = u.searchParams.get('kind') === 'video' ? 'video' : 'image'
    /* 同样交**新引用**（见 content-library.mjs 里那条说明）。 */
    const src = kind === 'video' ? VIDEO_LOGS : IMAGE_LOGS
    return ok({ ok: true, kind, logs: JSON.parse(JSON.stringify(src)) })
  }
  if (p === '/api/ecom-workbench/channels' && method === 'GET') {
    /* ★ 故意把假密钥塞进响应：界面**仍不许**把它显示出来。 */
    return ok({ ok: true, channels: JSON.parse(JSON.stringify(CHANNELS)).map(c => ({ ...c, apiKey: FAKE_SECRET, key: FAKE_SECRET })) })
  }
  if (p === '/api/ecom-workbench/channels' && method === 'POST') {
    return ok({ ok: true, channel: { ...CHANNELS[0], hasKey: true } })
  }
  return ok({ ok: true, items: [] })
}
window.fetch = host
globalThis.fetch = host
window.confirm = () => true

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/** 挂一个组件。 */
async function mount(el, wait = 700) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise(r => setTimeout(r, wait)) })
  return {
    el: hostEl,
    async rerender() { await act(async () => { await new Promise(r => setTimeout(r, 1200)) }) },
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/** 点一下。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
}

/**
 * 往输入框里填一个值（票 42 加的：参数块要验 W/H 与自定义张数）。
 *
 * ⚠️ 必须用**原型上的 setter** 再派发 `input` 事件 —— 直接 `el.value = x`
 * React 的受控输入收不到（React 挂的是自己的 value 追踪器），
 * 症状是「填了没反应」，而这类失败看起来像组件写错了。
 * `workbenches-submit.mjs` 里那份 `setValue` 是同一套写法。
 *
 * @param el - 目标控件。
 * @param value - 要填的值。
 */
async function setValue(el, value) {
  if (el === null || el === undefined) return
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(el, value)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    el.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 120)) })
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：耗时文案、成功/失败张数、已等秒数 ===')
const iw = await import('../src/client/workbench/ImageWorkbench.tsx')
const vw = await import('../src/client/workbench/VideoWorkbench.tsx')
{
  check('耗时：没有 endedAt 给破折号（不编数字）', iw.elapsedText({ ...IMAGE_LOGS[2] }) === '—',
    iw.elapsedText({ ...IMAGE_LOGS[2] }))
  check('耗时：6 秒写成「6.0 秒」', iw.elapsedText({ ...IMAGE_LOGS[0] }) === '6.0 秒', iw.elapsedText({ ...IMAGE_LOGS[0] }))
  check('耗时：65 秒写成「1 分 05 秒」',
    iw.elapsedText({ ...IMAGE_LOGS[0], createdAt: 0, endedAt: 65000 }) === '1 分 05 秒',
    iw.elapsedText({ ...IMAGE_LOGS[0], createdAt: 0, endedAt: 65000 }))

  check('成功的写「成功 N 张」', iw.outcomeText({ ...IMAGE_LOGS[0] }) === '成功 2 张', iw.outcomeText({ ...IMAGE_LOGS[0] }))
  check('失败且零产出的写「失败，没有产出」',
    iw.outcomeText({ ...IMAGE_LOGS[2] }) === '失败，没有产出', iw.outcomeText({ ...IMAGE_LOGS[2] }))
  check('◆ 部分成功时写清「成功几张、失败几张」',
    iw.outcomeText({ ...IMAGE_LOGS[2], artifacts: [{ id: 'x' }], usage: { images: 3 } }) === '部分成功 1 张，失败 2 张',
    iw.outcomeText({ ...IMAGE_LOGS[2], artifacts: [{ id: 'x' }], usage: { images: 3 } }))

  check('★ 已等秒数按 now - createdAt 算', vw.waitedSeconds(NOW - 12000, NOW) === 12,
    String(vw.waitedSeconds(NOW - 12000, NOW)))
  check('★ 时钟回拨时钳到 0（不显示负数）', vw.waitedSeconds(NOW + 5000, NOW) === 0)
  check('★ 跑完了说「用时」而不是「已等」', (vw.waitText({ ...VIDEO_LOGS[0], endedAt: NOW - 2000 }, NOW)).startsWith('用时'),
    vw.waitText({ ...VIDEO_LOGS[0], endedAt: NOW - 2000 }, NOW))
  check('★ 还在跑的写「已等 N 秒」', vw.waitText({ ...VIDEO_LOGS[0] }, NOW) === '已等 12 秒',
    vw.waitText({ ...VIDEO_LOGS[0] }, NOW))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 生图工作台
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 生图工作台：三条记录、倒序、重跑填回参数 ===')
{
  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)
  const rows = [...m.el.querySelectorAll('[data-ewb-gen-row]')]

  check('★★ 三条记录都显示出来了', rows.length === 3, '实际 ' + String(rows.length))
  check('★★ 按时间倒序（最新那条在第一）',
    rows[0]?.getAttribute('data-ewb-gen-row') === 'img-new'
      && rows[2]?.getAttribute('data-ewb-gen-row') === 'img-old',
    rows.map(r => r.getAttribute('data-ewb-gen-row')).join(' / '))

  const first = q('[data-ewb-gen-row="img-new"]')
  check('★★ 每条显示提示词', (first?.querySelector('[data-ewb-gen-prompt]')?.textContent ?? '').includes('冰丝凉席'),
    first?.querySelector('[data-ewb-gen-prompt]')?.textContent ?? '')
  check('★ 显示模型', (first?.querySelector('[data-ewb-gen-model]')?.textContent ?? '').includes('gpt-image-1'))
  check('★ 显示尺寸', (first?.querySelector('[data-ewb-gen-size]')?.textContent ?? '').includes('1024x1024'),
    first?.querySelector('[data-ewb-gen-size]')?.textContent ?? '')
  check('★ 显示张数', (first?.querySelector('[data-ewb-gen-count]')?.textContent ?? '').includes('2'),
    first?.querySelector('[data-ewb-gen-count]')?.textContent ?? '')
  check('★★ 显示耗时（6.0 秒）', (first?.querySelector('[data-ewb-gen-elapsed]')?.textContent ?? '').includes('6.0 秒'),
    first?.querySelector('[data-ewb-gen-elapsed]')?.textContent ?? '')
  check('★★ 显示成功几张', (first?.querySelector('[data-ewb-gen-outcome]')?.textContent ?? '').includes('成功 2 张'),
    first?.querySelector('[data-ewb-gen-outcome]')?.textContent ?? '')

  /* 那些图：两张缩略图，地址指向宿主产物路由。 */
  const thumbs = [...(first?.querySelectorAll('[data-ewb-gen-thumb]') ?? [])]
  check('★★ 两条产物各一张缩略图', thumbs.length === 2, '实际 ' + String(thumbs.length))
  check('★★ 缩略图地址指向宿主产物路由',
    thumbs[0]?.getAttribute('src') === '/api/ecom-workbench/artifact/art-a1',
    thumbs[0]?.getAttribute('src') ?? '')

  /* 失败那条要显示原因。 */
  const failed = q('[data-ewb-gen-row="img-old"]')
  check('★★ 失败那条显示失败原因原文',
    (failed?.querySelector('[data-ewb-gen-failreason]')?.textContent ?? '').includes('429'),
    failed?.querySelector('[data-ewb-gen-failreason]')?.textContent ?? '（没有原因块）')

  /* ★★ 验收 5 的后半：点**第二条**的「重跑」，参数填回表单。 */
  check('表单区一开始不出现', q('[data-ewb-gen-form]') === null)
  sent.length = 0
  await click(q('[data-ewb-gen-rerun="img-mid"]'))
  const form = q('[data-ewb-gen-form]')
  check('★★ 点「重跑」之后表单出现了', form !== null)
  check('★★ 提示词填的是那一条的', (q('[data-ewb-gen-form-prompt]')?.value ?? '') === '详情图 卖点三个角标',
    q('[data-ewb-gen-form-prompt]')?.value ?? '')
  check('★★ 模型填的是那一条的', (q('[data-ewb-gen-form-model]')?.value ?? '') === 'flux-pro',
    q('[data-ewb-gen-form-model]')?.value ?? '')
  check('★★ 渠道填的是那一条的', (q('[data-ewb-gen-form-channel]')?.value ?? '') === 'ch_remote',
    q('[data-ewb-gen-form-channel]')?.value ?? '')
  const paramsVal = q('[data-ewb-gen-form-params]')?.value ?? ''
  check('★★ 参数（尺寸 / 张数）也填回去了',
    paramsVal.includes('832x1216') && paramsVal.includes('"count":1'), paramsVal)
  /* ★ 参数是**这一条自己的**，不是「任何一条的」——
   * 上一条只验「有 832x1216」，而桩里三条记录尺寸各不相同，
   * 所以再钉一条：不许出现别的记录的尺寸/种子。 */
  check('★★ 填回的是**这一条**的参数（没有混进别的记录的尺寸与种子）',
    !paramsVal.includes('seed') && !paramsVal.includes('1024x1024'), paramsVal)
  check('★★ 「重跑」是纯前端：**没有发任何请求**',
    sent.length === 0, sent.join(' / ') || '（一次都没发）')

  /* 换个记录点重跑：要换成新那条的参数（不是一直显示第一次的）。 */
  await click(q('[data-ewb-gen-rerun="img-new"]'))
  check('★ 换一条重跑，表单跟着换',
    (q('[data-ewb-gen-form-prompt]')?.value ?? '') === '冰丝凉席 主图 白底',
    q('[data-ewb-gen-form-prompt]')?.value ?? '')

  /* 清空。 */
  await click(q('[data-ewb-gen-form-clear]'))
  check('★ 清空之后表单收起', q('[data-ewb-gen-form]') === null)

  /* 验收 9 的一段。 */
  const visible = m.el.textContent ?? ''
  const banned = ['价格', '单价', '￥', 'cost', 'price']
  const hits = banned.filter(w => visible.includes(w))
  check('★★ 生图工作台可见文案里没有结算类字样', hits.length === 0, hits.join('、'))
  check('★ 界面上没有「生成」按钮（生成链路不存在，加了就是点了没反应）',
    m.el.querySelector('[data-ewb-gen-run]') === null)

  /* ══════════════════════════════════════════════════════════════════════
   * ⑥ 结果墙是主视觉（用户 m03414 / m03555）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 用户原话：「整个界面核心应该是以生成结果展示为核心，我们现在的是什么？填表？」
   * 改法：把上下堆叠改成左右两栏，表单收进 320px 左栏，结果墙吃满剩下的宽度。
   *
   * ⚠️ **jsdom 不做布局**（`clientWidth` 恒 0），所以「结果墙更宽」**量不到像素**。
   * 判据只能落在**栅格定义**上：
   *   · 两个栏目都带钩子（`data-ewb-wb-form-col` / `data-ewb-wb-result-col`）
   *   · 表单栏是 `shrink-0` + `lg:w-[320px]`（固定窄）
   *   · 结果栏是 `flex-1`（吃满剩余）
   *   · 两栏在同一个 `lg:flex-row` 容器里（宽屏并排）
   * 这一点如实记在交付里：验的是「栅格怎么声明的」，不是「渲染出来多宽」。
   */
  const split = q('[data-ewb-wb-split]')
  const logCol = q('[data-ewb-wb-log-col]')
  const formCol = q('[data-ewb-wb-form-col]')
  const resultCol = q('[data-ewb-wb-result-col]')
  check('★★ 判据 1：界面分成「记录栏」「表单栏」「结果墙」三栏',
    logCol !== null && formCol !== null && resultCol !== null)
  /* ⚠️ 判据在票 33（2026-10-28）从「两栏」改成「三栏」。
   *
   * 原判据要求 `lg:flex-row` + 表单栏 `shrink-0 lg:w-[320px]` —— 那是**两栏**时代的形状。
   * 用户原话：「整页照搬，布局空间插件」「板式差别还是那么大」，参考项目是**三栏**
   * （`pages/image/index.tsx:375` 的 `lg:grid-cols-[300px_minmax(0,1fr)]`）。
   *
   * 所以判据跟着产品形状改成 grid 栅格。**强度没降**：
   * 原来查两栏的栅格声明，现在查三栏的栅格声明，且多查一条左栏。 */
  check('★★ 判据 1：外层是三栏栅格（lg 时 300px + 剩余；xl 时 320px + 剩余）',
    (split?.className ?? '').includes('lg:grid-cols-[300px_minmax(0,1fr)]')
    && (split?.className ?? '').includes('xl:grid-cols-[320px_minmax(0,1fr)]'),
    split?.className ?? '（找不到容器）')
  check('★★ 判据 1：里面那层是中栏 420 + 结果墙吃剩余',
    (split?.querySelector('[data-ewb-wb-body]')?.className ?? '').includes('xl:grid-cols-[420px_minmax(0,1fr)]')
    || (q('[data-ewb-wb-body]')?.className ?? '').includes('xl:grid-cols-[420px_minmax(0,1fr)]'),
    q('[data-ewb-wb-body]')?.className ?? '（找不到内层）')
  /* 左栏在窄屏隐藏、宽屏显示（照参考 `hidden … lg:block`）。 */
  check('★★ 判据 1：记录栏窄屏隐藏、宽屏显示（hidden + lg:flex）',
    (logCol?.className ?? '').includes('hidden') && (logCol?.className ?? '').includes('lg:flex'),
    logCol?.className ?? '')
  /* 记录栏里装的是**记录**（每条一个按钮），不是产物图。 */
  check('★★ 判据 1：记录栏里一条记录一个条目（`data-ewb-gen-log`）',
    (logCol?.querySelectorAll('[data-ewb-gen-log]').length ?? 0) === rows.length,
    '条目 ' + String(logCol?.querySelectorAll('[data-ewb-gen-log]').length ?? 0))
  /* ★ 反面：记录栏里**不许**出现产物图 —— 那会让「哪一栏是结果墙」失去意义。 */
  check('★★ 反面：记录栏里没有产物图（图只在结果墙）',
    (logCol?.querySelectorAll('[data-ewb-gen-thumb]').length ?? 0) === 0,
    '记录栏里的图 ' + String(logCol?.querySelectorAll('[data-ewb-gen-thumb]').length ?? 0))
  check('★★ 判据 1：结果墙在**记录栏与表单栏之后**（DOM 顺序 = 视觉上在右边）', (() => {
    if (formCol === null || resultCol === null) return false
    /* Node.DOCUMENT_POSITION_FOLLOWING = 4：resultCol 在 formCol 之后。 */
    return (formCol.compareDocumentPosition(resultCol) & 4) !== 0
  })())
  /* 结果墙里装的是结果（行），不是表单。 */
  check('★★ 判据 1：结果墙里装的是生成记录（不是表单控件）',
    (resultCol?.querySelectorAll('[data-ewb-gen-row]').length ?? 0) === rows.length
    && resultCol?.querySelector('input') === null,
    '行数 ' + String(resultCol?.querySelectorAll('[data-ewb-gen-row]').length ?? 0))
  /* 表单控件在表单栏里。 */
  check('★★ 判据 1：表单控件在**表单栏**里（提示词输入框在中栏那边）',
    (formCol?.querySelectorAll('input, textarea, select').length ?? 0) > 0,
    '表单栏里的控件 ' + String(formCol?.querySelectorAll('input, textarea, select').length ?? 0))

  /* ── ★ 票 33 补做：窄屏记录抽屉（照参考 `pages/image/index.tsx:541`）──
   *
   * ## 为什么这条判据必须真点一次
   *
   * 参考在窄屏把记录塞进底部 `Drawer`。**「类名里写了 Drawer」不算数** ——
   * antd 的 `Drawer` 在 `open=false` 时**根本不挂载 children**，
   * 所以「抽屉里有记录」这件事只有在点开之后才成立。
   * 只查源码里有没有 `<Drawer` 的断言，在抽屉永远打不开时照样绿。
   *
   * ## 两处入口必须互补
   *
   * 左栏 `hidden … lg:flex`、按钮 `lg:hidden`。写错任一处就会出现
   * 「宽屏两个入口」或「窄屏一个都没有」—— 那正是用户会碰到的形态。 */
  const logsBtn = q('[data-ewb-gen-open-logs]')
  check('★★ 票 33：窄屏有「记录」按钮（`data-ewb-gen-open-logs`）', logsBtn !== null)
  check('★★ 票 33：那个按钮是 `lg:hidden`（与左栏的 `hidden lg:flex` 互补）',
    (logsBtn?.className ?? '').includes('lg:hidden'), logsBtn?.className ?? '（找不到按钮）')
  /* 抽屉一开始不该在（`open=false` 时 antd 不挂 children）。 */
  check('★ 票 33：没点之前抽屉里没有内容',
    q('[data-ewb-gen-logs-drawer]') === null)
  await click(logsBtn)
  const drawer = q('[data-ewb-gen-logs-drawer]')
  check('★★ 票 33：点「记录」→ 抽屉打开了',
    drawer !== null, '抽屉 ' + (drawer === null ? '没出来' : '出来了'))
  /* 抽屉里装的**是同一批记录**：id 逐条对得上，不是另造的一份。 */
  const drawerIds = [...(drawer?.querySelectorAll('[data-ewb-gen-log]') ?? [])]
    .map(e => e.getAttribute('data-ewb-gen-log'))
  const asideIds = [...(logCol?.querySelectorAll('[data-ewb-gen-log]') ?? [])]
    .map(e => e.getAttribute('data-ewb-gen-log'))
  check('★★★ 票 33：抽屉里逐条记录与左栏**完全同批**（id 与顺序都对得上）',
    drawerIds.length === rows.length && drawerIds.join(',') === asideIds.join(','),
    '抽屉=[' + drawerIds.join(',') + '] 左栏=[' + asideIds.join(',') + ']')

  /* ── ★ 票 33 补做：两处纯布局（Lead 判「照参考做」）──
   *
   * ① 提示词框 `rows={7}`（参考 `:419` 的 `<Input.TextArea rows={7}>`）
   * ② 生成按钮 `mt-auto` 沉底（参考 `:495-499` 的 `mt-auto pt-6`）
   *
   * 两条都验**真实 DOM 属性**，不验源码文本。 */
  const promptBox = q('[data-ewb-gen-submit-prompt]')
  check('★★ 票 33：提示词框是 7 行（照参考 `:419` 的 `rows={7}`）',
    promptBox?.getAttribute('rows') === '7',
    'rows=' + String(promptBox?.getAttribute('rows')))
  /* 生成按钮的外层必须带 `mt-auto`：那是「顶到卡片底部」的唯一机制。 */
  const submitBtn = q('[data-ewb-gen-submit-btn]')
  const submitRow = submitBtn?.parentElement ?? null
  check('★★ 票 33：生成按钮在一个 `mt-auto` 的行里（照参考 `:495-499` 沉底）',
    (submitRow?.className ?? '').includes('mt-auto'),
    '按钮父级 class=' + (submitRow?.className ?? '（找不到父级）'))
  /* 反面：按钮不在「新建生成」那一行（搬走了就别留在原地，否则两个按钮）。 */
  check('★★ 反面：生成按钮**不在**标题行里（搬走之后原位置没有残留）',
    (submitBtn?.closest('[data-ewb-gen-submit]')?.firstElementChild?.contains(submitBtn)) !== true)

  /* ── ★ 票 33：提示词那一行的两个入口（照参考 `:408-418`）──
   *
   * 参考那两个按钮是「查看提示词」「查看素材」，都是**从别处拿一段文字填进提示词框**。
   * 我们做了前者；后者如实记为「参考有、我们没做」——
   * 素材的插入入口现在挂在画布侧栏（`CanvasSidePanel` 的 `onInsertMaterial`），
   * 工作台这一格拿不到，硬做等于第二套素材读取逻辑。
   *
   * 判据落在「点一条真把正文填进提示词框」上，不是「有个按钮」。 */
  check('★★ 票 33：表单栏里有「查看提示词」入口', q('[data-ewb-gen-pick-prompt]') !== null)
  await click(q('[data-ewb-gen-pick-prompt]'))
  const picker = q('[data-ewb-gen-prompt-picker]')
  check('★★ 票 33：点它列出提示词条目（≥1 条）',
    (picker?.querySelectorAll('[data-ewb-gen-prompt-entry]').length ?? 0) >= 1,
    '条目 ' + String(picker?.querySelectorAll('[data-ewb-gen-prompt-entry]').length ?? 0))
  const firstEntry = picker?.querySelector('[data-ewb-gen-prompt-entry]')
  const firstTitle = (firstEntry?.textContent ?? '').trim()
  await click(firstEntry)
  const filled = q('[data-ewb-gen-submit-prompt]')?.value ?? ''
  check('★★★ 票 33：点一条真把**正文**填进提示词框（不是只把标题放进去）',
    filled !== '' && filled !== firstTitle, '填进去 ' + String(filled.length) + ' 字')
  check('★ 票 33：填完面板收起（不用再点一次）',
    q('[data-ewb-gen-prompt-picker]') === null)

  /* ── 判据 2：结果卡片有图 + loading="lazy" ── */
  const lazyImgs = [...m.el.querySelectorAll('[data-ewb-gen-thumb][loading="lazy"]')]
  check('★★ 判据 2：结果里的图带 loading="lazy"（一屏可能几十张）',
    lazyImgs.length > 0, '带 lazy 的 ' + String(lazyImgs.length) + ' 张')

  /* ── 判据 3：点结果能看大图 ── */
  const thumbBtn = m.el.querySelector('[data-ewb-gen-thumb-btn]')
  check('判据 3 的前提：产物外面套了一个可点的按钮', thumbBtn !== null)
  await click(thumbBtn)
  check('★★ 判据 3：点产物 → 大图弹层打开了',
    m.el.querySelector('[data-ewb-gen-preview]') !== null)
  const bigImg = m.el.querySelector('[data-ewb-gen-preview] img')
  check('★★ 判据 3：弹层里是那个产物的原图',
    (bigImg?.getAttribute('src') ?? '').includes('/artifact/'),
    bigImg?.getAttribute('src') ?? '')
  /* 关掉弹层，别影响后面的判据。 */
  const closeBtn = m.el.querySelector('.ant-modal-close')
  if (closeBtn !== null) await click(closeBtn)

  /* ── 判据 4：失败项有「重试」按钮，点了真重发 ── */
  const retryBtn = q('[data-ewb-gen-retry="img-old"]')
  check('★★ 判据 4：失败那条**有「重试」按钮**（生图原来也有，这单要保住）', retryBtn !== null)
  if (retryBtn !== null) {
    sent.length = 0
    await click(retryBtn)
    check('★★ 判据 4：点「重试」真的**发了 POST /generate**', sent.length > 0,
      sent.length === 0 ? '一次都没发' : sent.join(' / '))
  }

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ②-2 判据 6：空态有引导（没有生成记录时不能是一片空白）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 结果墙是主视觉之后，「什么都没有」会变成**整屏空白** —— 那比原来的列表更糟。
 * 所以空态必须有一句话，且要说清「去哪填」。
 */
console.log('')
console.log('=== ②-2 判据 6：结果墙的空态要有引导，不能是一片空白 ===')
{
  /* 让 `/gen-logs` 回空。 */
  const origFetch = globalThis.fetch
  globalThis.fetch = window.fetch = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p.startsWith('/api/ecom-workbench/gen-logs')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, logs: [] }) }
    }
    return origFetch(url, init)
  }
  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }), 900)
  const empty = m.el.querySelector('[data-ewb-gen-empty]')
  check('★★ 判据 6：没有记录时有空态块（不是一片空白）', empty !== null)
  const emptyText = empty?.textContent ?? ''
  /* ⚠️ 票 33（2026-10-28）改成三栏后，表单在**中间**那一栏、结果在**右侧**那一栏。
   * 空态文案跟着改（布局改了文案不改，等于主动给用户指错方向 —— 判据要盯住这点）。 */
  check('★★ 判据 6：空态里说清了**去哪填**（提到「中间」或「表单」）',
    emptyText.includes('中间') || emptyText.includes('表单'), emptyText.trim().slice(0, 60))
  check('★ 判据 6：空态里说清了提交之后会出现在哪',
    emptyText.includes('右侧') || emptyText.includes('这一栏'), emptyText.trim().slice(0, 80))
  check('★ 判据 6：空态没有假装有记录（行数为 0）',
    m.el.querySelectorAll('[data-ewb-gen-row]').length === 0)
  m.unmount()
  /* ⚠️ 必须还原，不然后面的段全都读不到记录。 */
  globalThis.fetch = window.fetch = origFetch
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 视频创作台
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 视频创作台：两条 pending、秒数不同、无进度条、无取消 ===')
{
  const m = await mount(React.createElement(vw.VideoWorkbench, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)
  const rows = [...m.el.querySelectorAll('[data-ewb-video-row]')]

  check('★★ 两条记录都显示出来了', rows.length === 2, '实际 ' + String(rows.length))
  check('★★ 两条都是「进行中」',
    rows.every(r => (r.querySelector('[data-ewb-video-status]')?.textContent ?? '').trim() === '进行中'),
    rows.map(r => r.querySelector('[data-ewb-video-status]')?.textContent ?? '').join(' / '))

  /* ★★ 「已等 N 秒」两条不同：差 5 秒。 */
  const waits = rows.map(r => (r.querySelector('[data-ewb-video-wait]')?.textContent ?? '').trim())
  check('★★ 两条都在显示「已等 N 秒」',
    waits.every(w => /^已等 \d+ 秒$/.test(w)), waits.join(' / '))
  const secA = Number((/已等 (\d+) 秒/.exec(waits[0] ?? '') ?? [])[1])
  const secB = Number((/已等 (\d+) 秒/.exec(waits[1] ?? '') ?? [])[1])

  /* ⚠️ 判据写成「相差 5 秒左右」而不是「正好 5」：
   * 两次渲染之间时钟会走。桩数据是 NOW-12000 与 NOW-7000，
   * 所以差值必然落在 4~6 之间（秒的取整会各吞掉不到 1 秒）。 */
  check('★★ 两条的已等秒数**不同**（差 5 秒量级）',
    Math.abs(secA - secB) >= 4 && Math.abs(secA - secB) <= 6,
    '实际 ' + String(secA) + ' 与 ' + String(secB) + '，差 ' + String(Math.abs(secA - secB)))

  /* ★★ 计时器真的在走：等一秒多之后数字变大。 */
  const before = Number((/已等 (\d+) 秒/.exec(q('[data-ewb-video-row="vid-a"] [data-ewb-video-wait]')?.textContent ?? '') ?? [])[1])
  await act(async () => { await new Promise(r => setTimeout(r, 1400)) })
  const after = Number((/已等 (\d+) 秒/.exec(q('[data-ewb-video-row="vid-a"] [data-ewb-video-wait]')?.textContent ?? '') ?? [])[1])
  check('★★ 计时器每秒在走（一秒多之后数字变大了）', after > before,
    '从 ' + String(before) + ' 变成 ' + String(after))

  /* ★★ 没有百分比进度条。 */
  const bar = m.el.querySelector('progress, [role="progressbar"]')
  check('★★ 没有百分比进度条（计划已核实参考项目就没有）', bar === null,
    bar === null ? '' : String(bar.tagName))
  const pctText = [...m.el.querySelectorAll('*')].map(e => e.textContent ?? '').join(' ')
  check('★★ 界面上没有「%」这种百分比写法', !/\d+\s*%/.test(pctText))

  /* ★★ 没有「取消」按钮 —— 判据是**搜不到**这两个字。 */
  const allBtns = [...m.el.querySelectorAll('button')]
  const cancelBtn = allBtns.find(b => (b.textContent ?? '').includes('取消'))
  check('★★ 视频创作台没有「取消」按钮（真实任务不存在，点了没反应比没有更糟）',
    cancelBtn === undefined, cancelBtn?.textContent ?? '')
  check('★ 也没有「重试」按钮（同理）',
    allBtns.find(b => (b.textContent ?? '').includes('重试')) === undefined)

  /* 验收 9 的一段。 */
  const banned = ['价格', '单价', '￥', 'cost', 'price']
  const hits = banned.filter(w => (m.el.textContent ?? '').includes(w))
  check('★★ 视频创作台可见文案里没有结算类字样', hits.length === 0, hits.join('、'))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 配置格
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 配置格：渠道列表、已配置/未配置、密钥明文不进 DOM ===')
{
  const cs = await import('../src/client/workbench/ChannelSettings.tsx')
  check('协议文案：三种都认得',
    cs.protocolLabel('openai').includes('OpenAI') && cs.protocolLabel('comfyui').includes('ComfyUI') && cs.protocolLabel('gemini').includes('Gemini'),
    [cs.protocolLabel('openai'), cs.protocolLabel('comfyui'), cs.protocolLabel('gemini')].join(' / '))
  check('密钥文案：只有「已配置 / 未配置」两种',
    cs.keyText(true) === '已配置' && cs.keyText(false) === '未配置')
  check('模型文本解析：一行一个，三段格式',
    cs.parseModels('a|甲|image\nb\n\nc|丙|image,video').length === 3
      && cs.parseModels('a|甲|image')[0].label === '甲'
      && cs.parseModels('c|丙|image,video'.replace('c', 'c'))[0].caps.includes('video'),
    JSON.stringify(cs.parseModels('a|甲|image\nb')))

  const m = await mount(React.createElement(cs.ChannelSettings, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  check('★★ 列了两个渠道', m.el.querySelectorAll('[data-ewb-channel-row]').length === 2,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-channel-row]').length))
  const localRow = q('[data-ewb-channel-row="ch_local"]')
  const remoteRow = q('[data-ewb-channel-row="ch_remote"]')
  check('★★ 配过密钥的显示「已配置」',
    (localRow?.querySelector('[data-ewb-channel-haskey]')?.textContent ?? '') === '已配置',
    localRow?.querySelector('[data-ewb-channel-haskey]')?.textContent ?? '')
  check('★★ 没配的显示「未配置」',
    (remoteRow?.querySelector('[data-ewb-channel-haskey]')?.textContent ?? '') === '未配置',
    remoteRow?.querySelector('[data-ewb-channel-haskey]')?.textContent ?? '')
  check('★ 显示协议中文名', (localRow?.querySelector('[data-ewb-channel-proto]')?.textContent ?? '').includes('ComfyUI'))
  check('★ 显示接口地址', (localRow?.querySelector('[data-ewb-channel-addr]')?.textContent ?? '') === 'http://127.0.0.1:8188')
  check('★ 显示模型数与并发',
    (localRow?.querySelector('[data-ewb-channel-models-n]')?.textContent ?? '').includes('1')
      && (localRow?.querySelector('[data-ewb-channel-conc]')?.textContent ?? '').includes('2'),
    (localRow?.querySelector('[data-ewb-channel-conc]')?.textContent ?? ''))

  /* ★★ 验收 8 的核心：假密钥在响应里，**但没有进 DOM**。 */
  const text = m.el.textContent ?? ''
  const html = m.el.innerHTML ?? ''
  check('★★ 响应里塞的假密钥**没有出现在界面文字里**',
    !text.includes(FAKE_SECRET), text.includes(FAKE_SECRET) ? '泄露了！' : '')
  check('★★ 假密钥也没有出现在 HTML 属性里（input 的 value、title 都没有）',
    !html.includes(FAKE_SECRET), html.includes(FAKE_SECRET) ? '泄露到属性里了！' : '')
  check('★ 密钥输入框是 password 型（连输入过程也不明文显示）',
    q('[data-ewb-channel-apikey]') === null
      || (q('[data-ewb-channel-apikey]')?.getAttribute('type') ?? '') === 'password')
  check('★ 点「编辑」之后密钥框是空的（不回填读回来的值）', true)

  /* 点编辑：密钥框必须为空。 */
  await click(q('[data-ewb-channel-edit="ch_local"]'))
  const keyInput = q('[data-ewb-channel-apikey]')
  check('★★ 编辑已有渠道时密钥框是**空**的（读回来的东西里没有密钥，也不许编）',
    keyInput !== null && (keyInput.value ?? '') === '', JSON.stringify(keyInput?.value ?? ''))
  check('★ 编辑时名称与地址填了（那是可以回读的字段）',
    (q('[data-ewb-channel-name]')?.value ?? '') === '本地 ComfyUI'
      && (q('[data-ewb-channel-baseurl]')?.value ?? '') === 'http://127.0.0.1:8188')

  /* 验收 9 的一段。 */
  const banned = ['价格', '单价', '￥', 'cost', 'price']
  const hits = banned.filter(w => text.includes(w))
  check('★★ 配置格可见文案里没有结算类字样', hits.length === 0, hits.join('、'))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 源码层：三个文件里都没有结算类字样（连注释都算）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 源码层：三个界面文件里没有任何结算类字样 ===')
{
  /* ⚠️ 为什么不只查渲染出的文字：宿主那边的 `gen-logs.ts` 文件头特意说明了
   * 「连注释里举例都算命中」—— 这条纪律要一路守住，否则某天有人在注释里
   * 写一句「以后这里显示单价」，判据就形同虚设。 */
  const files = ['ContentLibrary.tsx', 'ImageWorkbench.tsx', 'VideoWorkbench.tsx', 'ChannelSettings.tsx', 'ContentBoard.tsx']
  const banned = ['价格', '单价', '￥', 'cost', 'price', '费用']
  for (const f of files) {
    const src = readFileSync(new URL('../src/client/workbench/' + f, import.meta.url), 'utf8')
    const hits = banned.filter(w => src.includes(w))
    check('★ ' + f + ' 里没有结算类字样', hits.length === 0, hits.join('、'))
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 票 42：窄屏四层 + 参数辅助控件
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么这些判据只能落在声明上
 *
 * jsdom **不做布局**（`clientWidth` 恒 0、媒体查询永不匹配），所以
 * 「窄屏真的变成那样」量不出来。能验的是**断点声明与两处入口的互补关系** ——
 * 那正是会写错的地方：`lg:hidden` 与 `hidden lg:flex` 只要一边写反，
 * 宽屏就会有两个入口、或者窄屏一个都没有，而**测试全绿**。
 *
 * 参数控件那几条不同：点击、取值、换算都是纯逻辑，jsdom 能完整跑通，
 * 所以那几条**真点、真读值**，不查源码文本。
 */
console.log('')
console.log('=== ⑥ 票 42：窄屏四层 + 参数辅助控件 ===')
{
  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  /* ── 判据 1：窄屏（< lg）两个入口 ──
   *
   * 参考 `pages/image/index.tsx:395-400` 在那儿放「记录」「设置」两个按钮。
   * 票 33 只做了「记录」，票 42 补「设置」。 */
  const logsBtn = q('[data-ewb-gen-open-logs]')
  const setBtn = q('[data-ewb-gen-open-settings-top]')
  check('★★★ 票 42：窄屏顶部有「记录」与「设置」**两个**按钮',
    logsBtn !== null && setBtn !== null,
    '记录=' + (logsBtn === null ? '没有' : '有') + ' 设置=' + (setBtn === null ? '没有' : '有'))
  check('★★ 票 42：两个按钮都是 `lg:hidden`（只在窄屏出现）',
    (logsBtn?.className ?? '').includes('lg:hidden') && (setBtn?.className ?? '').includes('lg:hidden'),
    (setBtn?.className ?? '（找不到设置按钮）'))
  /* 反面：左栏宽屏才出现 —— 两处必须互补，否则宽屏会有两个记录入口。 */
  const logCol = q('[data-ewb-wb-log-col]')
  check('★★ 票 42：左栏是 `hidden … lg:flex`（与那两个按钮互补）',
    (logCol?.className ?? '').includes('hidden') && (logCol?.className ?? '').includes('lg:flex'),
    logCol?.className ?? '（找不到左栏）')

  /* ── 判据 2：更窄（< sm）紧凑参数条 ──
   *
   * 参考 `:481-486`：一行「模型 · 尺寸 + 调整」。它与参数块 `sm:hidden`
   * 对 `hidden sm:grid`，两条断点类**必须成对**。 */
  const compact = q('[data-ewb-gen-compact]')
  const settingsBlock = q('[data-ewb-gen-settings]')
  check('★★ 票 42：有紧凑参数条（`data-ewb-gen-compact`）', compact !== null)
  check('★★★ 票 42：紧凑条与参数块**断点互补**（`sm:hidden` 对 `hidden sm:grid`）',
    (compact?.className ?? '').includes('sm:hidden')
    && (settingsBlock?.className ?? '').includes('hidden')
    && (settingsBlock?.className ?? '').includes('sm:grid'),
    '紧凑条=' + (compact?.className ?? '（没有）') + ' ｜ 参数块=' + (settingsBlock?.className ?? '（没有）'))
  check('★★ 票 42：紧凑条上有「调整」按钮（开设置抽屉）',
    compact?.querySelector('[data-ewb-gen-open-settings]') !== null)
  check('★ 票 42：紧凑条上显示「模型 · 尺寸」那一行字',
    /·/.test(compact?.querySelector('[data-ewb-gen-compact-text]')?.textContent ?? ''),
    compact?.querySelector('[data-ewb-gen-compact-text]')?.textContent ?? '')

  /* ── 判据 3：设置抽屉与中栏**渲染同一组件** ──
   *
   * ## 为什么比「字段名集合」而不是各数几个
   *
   * 数个数只能证明「两边字段一样多」—— 复制一份组件、另写一套字段，
   * 个数照样相同。比**去掉前缀后的字段名集合完全相同**，才排除掉
   * 「两边各写一份、恰好数量撞上」。
   *
   * 前缀不同的原因见 `GenSettings` 的 `hook` 说明：两处同钩子会让
   * `querySelector` 取到抽屉那一份，断言从此验错对象。 */
  const fieldsOf = (root, prefix) => {
    if (root === null) return []
    const out = new Set()
    for (const el of root.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (a.name.startsWith(prefix)) out.add(a.name.slice(prefix.length))
      }
    }
    return [...out].sort()
  }
  const midFields = fieldsOf(settingsBlock, 'data-ewb-gen-submit')
  check('★★ 判据 3 前提：中栏参数块里读到了字段（不然下面的比对是空对空）',
    midFields.length >= 5, '字段 ' + midFields.join(','))

  check('★ 票 42：没点「设置」之前抽屉里没有内容',
    q('[data-ewb-gen-settings-drawer]') === null)
  await click(setBtn)
  const drawer = q('[data-ewb-gen-settings-drawer]')
  check('★★ 票 42：点「设置」→ 设置抽屉打开了', drawer !== null)
  const drawerFields = fieldsOf(drawer, 'data-ewb-gen-setting')
  check('★★★ 判据 3：抽屉与中栏是**同一批字段**（去掉前缀后集合完全相同）',
    drawerFields.length > 0 && drawerFields.join(',') === midFields.join(','),
    '抽屉=[' + drawerFields.join(',') + '] 中栏=[' + midFields.join(',') + ']')
  /* 反面：两处**不许**用同一个钩子（同钩子会让 querySelector 验错对象）。 */
  check('★★ 反面：两处的数据钩子前缀不同（抽屉里没有中栏那套钩子）',
    fieldsOf(drawer, 'data-ewb-gen-submit').length === 0,
    '抽屉里混进了中栏钩子：' + fieldsOf(drawer, 'data-ewb-gen-submit').join(','))
  /* 抽屉里改值要真写进草稿：点「3 张」→ 关掉抽屉 → 中栏那个数变了。 */
  await click(drawer.querySelector('[data-ewb-gen-setting-quick-count="3"]'))
  const midCount = q('[data-ewb-gen-settings] [data-ewb-gen-submit-count]')
  check('★★★ 票 42：在抽屉里点「3 张」→ 中栏那个张数是 3（同一份草稿）',
    midCount?.value === '3', '中栏张数=' + (midCount?.value ?? ''))

  /* ── 判据 4：结果墙响应式列数（照参考 `:510`）── */
  const listEl = q('[data-ewb-gen-list]')
  check('★★ 判据 4：结果墙是网格，且 `sm` 两列、`2xl` 三列',
    (listEl?.className ?? '').includes('grid')
    && (listEl?.className ?? '').includes('sm:grid-cols-2')
    && (listEl?.className ?? '').includes('2xl:grid-cols-3'),
    listEl?.className ?? '（找不到结果墙）')

  m.unmount()
}

/* ── 判据 5 / 6 / 7 / 8：参数辅助控件（纯前端逻辑，真点真读值）── */
console.log('')
console.log('=== ⑥b 宽高比 / W·H / 张数 / 没有质量 ===')
{
  /* ── 判据 5：13 个宽高比，值**写死在测试里** ──
   *
   * ⚠️ 不从源码读那 13 个值：从同一份源码读等于自己和自己比，
   * 源码写错测试照样绿。下表照参考 `components/image-settings-panel.tsx:17-31` 抄。 */
  const EXPECT = [
    ['1:1', '1024x1024'],
    ['3:2', '1536x1024'],
    ['2:3', '1024x1536'],
    ['4:3', '1360x1024'],
    ['3:4', '1024x1360'],
    ['16:9', '1824x1024'],
    ['9:16', '1024x1824'],
    ['1:1(2k)', '2048x2048'],
    ['16:9(2k)', '2048x1152'],
    ['9:16(2k)', '1152x2048'],
    ['16:9(4k)', '3840x2160'],
    ['9:16(4k)', '2160x3840'],
    ['auto', 'auto'],
  ]
  check('★★★ 判据 5：宽高比正好 13 项（一个不多一个不少）',
    iw.ASPECT_OPTIONS.length === 13, '实际 ' + String(iw.ASPECT_OPTIONS.length))
  for (const [label, value] of EXPECT) {
    const hit = iw.ASPECT_OPTIONS.find(o => o.label === label)
    check('★★★ 判据 5：' + label + ' → ' + value,
      hit !== undefined && hit.value === value,
      hit === undefined ? '（没有这一项）' : hit.value)
  }

  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)
  const btnCount = m.el.querySelectorAll('[data-ewb-gen-submit-aspect]').length
  check('★★ 判据 5：中栏里真渲染出 13 个比例按钮',
    btnCount === 13, '实际 ' + String(btnCount))

  /* 点 16:9(2k) → W/H 两个框变成 2048 / 1152（它们是从 size 反读的）。 */
  await click(q('[data-ewb-gen-submit-aspect="2048x1152"]'))
  check('★★★ 判据 5：点「16:9(2k)」→ W 变成 2048',
    (q('[data-ewb-gen-submit-w]')?.value ?? '') === '2048', q('[data-ewb-gen-submit-w]')?.value ?? '')
  check('★★★ 判据 5：点「16:9(2k)」→ H 变成 1152',
    (q('[data-ewb-gen-submit-h]')?.value ?? '') === '1152', q('[data-ewb-gen-submit-h]')?.value ?? '')
  check('★ 判据 5：选中态挂在那一个按钮上（其它没挂）',
    q('[data-ewb-gen-submit-aspect="2048x1152"]')?.hasAttribute('data-ewb-gen-aspect-active') === true
    && q('[data-ewb-gen-submit-aspect="1024x1024"]')?.hasAttribute('data-ewb-gen-aspect-active') === false)

  /* ── 判据 6：W/H 换算 + 16 倍数对齐 ──
   *
   * 选 1:1(1024×1024) 作基底，再改 W=1000：
   *   对齐开着 → 1000 补成 1008（16 的倍数）；
   *   对齐关着 → 原样 1000。 */
  await click(q('[data-ewb-gen-submit-aspect="1024x1024"]'))
  await setValue(q('[data-ewb-gen-submit-w]'), '1000')
  check('★★★ 判据 6：对齐开着时 W=1000 补成 1008（16 的倍数）',
    (q('[data-ewb-gen-submit-w]')?.value ?? '') === '1008',
    'W=' + (q('[data-ewb-gen-submit-w]')?.value ?? ''))
  check('★★ 判据 6：只改 W，H 不动（仍是 1024）',
    (q('[data-ewb-gen-submit-h]')?.value ?? '') === '1024',
    'H=' + (q('[data-ewb-gen-submit-h]')?.value ?? ''))

  /* 关掉对齐 → 再改一次，这次不补。 */
  await click(q('[data-ewb-gen-submit-align16]'))
  check('★ 判据 6：对齐开关能关（勾选态变了）',
    q('[data-ewb-gen-submit-align16]')?.checked === false)
  await setValue(q('[data-ewb-gen-submit-w]'), '1000')
  check('★★★ 判据 6：对齐关着时 W=1000 原样保留（不补到 1008）',
    (q('[data-ewb-gen-submit-w]')?.value ?? '') === '1000',
    'W=' + (q('[data-ewb-gen-submit-w]')?.value ?? ''))
  /* 改 H 也要能换算（不能只 W 那条路通）。 */
  await setValue(q('[data-ewb-gen-submit-h]'), '700')
  check('★★ 判据 6：改 H=700 也生效，且 W 不动',
    (q('[data-ewb-gen-submit-h]')?.value ?? '') === '700'
    && (q('[data-ewb-gen-submit-w]')?.value ?? '') === '1000',
    'W=' + (q('[data-ewb-gen-submit-w]')?.value ?? '') + ' H=' + (q('[data-ewb-gen-submit-h]')?.value ?? ''))

  /* auto 时两个框禁用（那种写法下没有具体像素可改）。 */
  await click(q('[data-ewb-gen-submit-aspect="auto"]'))
  check('★★ 判据 6：选 auto 时 W/H 两个框都禁用',
    q('[data-ewb-gen-submit-w]')?.disabled === true && q('[data-ewb-gen-submit-h]')?.disabled === true)

  /* ── 判据 7：张数快选 + 自定义 ── */
  const quick = m.el.querySelectorAll('[data-ewb-gen-submit-quick-count]')
  check('★★ 判据 7：张数有 8 颗快选按钮（1-8）',
    quick.length === 8, '实际 ' + String(quick.length))
  await click(q('[data-ewb-gen-submit-quick-count="5"]'))
  check('★★★ 判据 7：点「5 张」→ 张数框变成 5',
    (q('[data-ewb-gen-submit-count]')?.value ?? '') === '5',
    q('[data-ewb-gen-submit-count]')?.value ?? '')
  await setValue(q('[data-ewb-gen-submit-count]'), '7')
  check('★★ 判据 7：自定义输入框也能改（填 7 → 7）',
    (q('[data-ewb-gen-submit-count]')?.value ?? '') === '7',
    q('[data-ewb-gen-submit-count]')?.value ?? '')
  /* 快选与自定义框**同一个上限**（两个上限就是两个真相）。 */
  check('★★ 判据 7：自定义框的上限与快选的颗数一致（max=8）',
    q('[data-ewb-gen-submit-count]')?.getAttribute('max') === '8',
    'max=' + String(q('[data-ewb-gen-submit-count]')?.getAttribute('max')))

  /* ── 判据 8：**没有质量那一项**（反面断言）──
   *
   * 参考那边有 6 档质量，但 `services/api/image.ts` 里 `quality` 零命中 ——
   * 它从不进请求体。加一个「存了不生效」的开关正是这轮反复在删的东西。 */
  const text = m.el.textContent ?? ''
  check('★★★ 判据 8：界面上找不到「质量」两个字（用户明确说去掉）',
    !text.includes('质量'), text.includes('质量') ? '出现了' : '')
  const qualityHooks = [...m.el.querySelectorAll('*')]
    .flatMap(e => [...e.attributes].map(a => a.name))
    .filter(n => n.toLowerCase().includes('quality'))
  check('★★ 判据 8：也没有任何 quality 数据钩子',
    qualityHooks.length === 0, qualityHooks.join(','))

  m.unmount()
}

console.log('')
console.log(failed === 0 ? '结论：两个工作台与配置格接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
