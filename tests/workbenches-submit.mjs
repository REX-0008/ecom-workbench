/** 三个工作台真能提交（契约 CF，用户 m01076）。
 *
 * ## 这个测试守什么（对应验收 1–8、14）
 *
 *   ① 生图工作台有提交区；模型下拉的选项**来自 `/gen-models?kind=image`**，且按渠道分组；
 *   ② 点「生成」发的是 `POST /generate`，body 带 prompt / model / channelId / size / count；
 *   ③ 提交后**立刻**回到列表，新记录是 `pending` 且在最上面（自证对象在这里）；
 *   ④ 轮询真的在跑（`GET /generate/:id` 被调了多次）；
 *   ⑤ `running` 显示「已等 N 秒」，界面上**没有百分比**；
 *   ⑥ 失败那条有「重试」，点了重新提交；
 *   ⑦ 视频的 `pending` 有「取消」，点了调 `/cancel`；
 *   ⑧ 音频工作台存在、能提交、列表里是播放器。
 *
 * ## 为什么另开一个文件而不是塞进 `workbenches.mjs`
 *
 * 那个文件守的是**契约 BB 那批判据**（读记录、计时、密钥不回显）—— 它们至今有效，
 * 一条都不该改。这一批是**新能力**（提交 / 轮询 / 取消），混进去会让「红一条时
 * 分不清是哪一单坏了」。
 *
 * ## 桩的口径（重要）
 *
 * `fetch` 全是假的，**绝不真连后端**。轮询靠真定时器（`POLL_MS` 是 800ms），
 * 所以有些断言之间**必须**等一段真时间（见「哪些等待必须保留」）。
 *
 * ## 哪些等待必须保留（2026-10-26 分轮清理，别把它们一起换掉）
 *
 * 这个文件原来有 14 处 `await settle(N)` 是实打实睡，加上 `mount` 四处 900ms、
 * `click`/`setValue` 里的固定等待，合计 18.6 秒。清理时**三类必须留**：
 *
 *   ① **否定断言的时间窗口**：`L339`「跑完之后**不再轮询**」——它证明的是
 *      「一段时间内没发生某事」，窗口一缩就假绿；
 *   ② **靠真时钟推进的断言**：`L380`「秒数在走」——秒数由 `setInterval(1000)`
 *      驱动，等再快也不会变，下限就是一秒多；
 *   ③ **轮询次数下限**：`L327`「一段时间内 GET /generate/:id 被调了多次」——
 *      `POLL_MS=800`，要 ≥2 次就得跨过约 1.6 秒。
 *
 * ## ⚠️ `act` 与「等待」的关系（三次实测，2026-10-26）
 *
 * 曾经推断「等 DOM 必须包在 `act` 里」，**实测反了**：
 *
 * | 实验 | 写法 | 结果 |
 * | --- | --- | --- |
 * | 等 `sent` 数组（不受 React 影响） | 裸 `waitUntil` | 立刻 `true`（<10ms）—— **这条不算证据**，它跟 React 无关 |
 * | 等 DOM 里的状态文本 | 裸 `waitUntil` | `true`，约 **500ms** |
 * | 等同一个 DOM 条件 | **`act` 包住** `waitUntil` | **`false`，等满 4012ms 超时** |
 *
 * 机制（推断，依据是第三行）：`act` 把 React 的更新**攒到回调结束时才刷**，
 * 回调里轮询 DOM 永远看到旧值 → 等不到。
 *
 * 所以本文件的规矩是：
 *   · **`act` 只包「制造变化」**（`click` / `setValue` 里派发事件）；
 *   · **等「某个条件成立」一律裸在外面**（`waitUntil` 不加 `act`）；
 *   · `drain()` 那种「只让队列跑空、不等任何条件」的可以留在 `act` 里
 *     —— 它不会去看 act 攒住的更新，只是把宏任务让出去，act 结束时照常 flush。
 *
 * ⚠️ 反过来把**等条件**包进 `act` 会**静默等满超时**（返回 `false`），
 * 而调用方若写成 `if (await waitUntil(...)) { 断言 }`，那一步就变成「跳过断言」。
 *
 * 跑法：node --import <tsx> tests/workbenches-submit.mjs
 */
import { createRequire, register } from 'node:module'
import { settle as drain, waitUntil } from './_wait.mjs'

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
/* ⚠️ **`SVGElement` 必须挂全局**（票 44 踩到的）。
 *
 * 票 44 的「删除确认框」用了 antd `Modal`，它的动画层
 * （`@rc-component/util` 的 `findDOMNode.js:12`）在 `isDOM` 里读了**裸名**
 * `SVGElement` —— 与 `FileReader` 同一个坑：jsdom 把它放在 `window` 上，
 * 而源码读的是 `globalThis`。不挂就是
 * `ReferenceError: SVGElement is not defined`，而且**整个测试进程直接崩**，
 * 不是一条红。 */
globalThis.SVGElement = window.SVGElement
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

/* ── 桩数据 ─────────────────────────────────────────────────────────── */

/** 收到的请求（`方法 路径`）。 */
const sent = []
/** 收到的请求体（按 id 存）。 */
const bodies = []

/** 模型清单（两个渠道，各一个图模型；视频与音频各一个）。 */
const MODELS = [
  { channelId: 'ch_local', channelName: '本地 ComfyUI', protocol: 'comfyui', modelId: 'qwen-image', modelLabel: 'Qwen Image', caps: ['image', 'video'] },
  { channelId: 'ch_remote', channelName: '某云端', protocol: 'openai', modelId: 'flux-pro', modelLabel: 'Flux Pro', caps: ['image'] },
  { channelId: 'ch_local', channelName: '本地 ComfyUI', protocol: 'comfyui', modelId: 'minimax-h3', modelLabel: 'MiniMax H3', caps: ['video'] },
  { channelId: 'ch_local', channelName: '本地 ComfyUI', protocol: 'comfyui', modelId: 'music-3', modelLabel: 'Music 3', caps: ['audio'] },
]

/** 内存里的任务（提交后往里塞）。 */
const tasks = new Map()
/** 待提交的任务排期：第几次轮询之后变成什么。 */
let tick = 0

/** 一次 `/generate` 提交的回包 id。 */
let nextId = 1

/** 一个任务的样子。 */
function mkTask(id, kind, prompt, model, channelId) {
  return {
    id, kind, status: 'submitted', stage: 'submitted',
    prompt, model, channelId, channelName: '本地 ComfyUI',
    createdAt: Date.now(), waitedMs: 0, artifacts: [],
  }
}

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  sent.push(method + ' ' + p)
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const bad = (status, body) => ({ ok: false, status, json: async () => body })

  if (p.startsWith('/api/ecom-workbench/gen-models')) {
    const u = new URL('http://x' + p)
    const kind = u.searchParams.get('kind') ?? ''
    const list = kind === '' ? MODELS : MODELS.filter(m => m.caps.includes(kind))
    return ok({ ok: true, models: list })
  }
  if (p.startsWith('/api/ecom-workbench/gen-logs')) {
    return ok({ ok: true, logs: [] })
  }
  if (p === '/api/ecom-workbench/generate' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'))
    bodies.push(body)
    const id = 'task-' + String(nextId)
    nextId += 1
    tasks.set(id, mkTask(id, body.kind ?? 'image', body.prompt ?? '', body.model ?? '', body.channelId ?? ''))
    return ok({ ok: true, id, task: tasks.get(id) })
  }
  if (p.startsWith('/api/ecom-workbench/generate/') && p.endsWith('/cancel')) {
    const id = decodeURIComponent(p.slice('/api/ecom-workbench/generate/'.length, -'/cancel'.length))
    const t = tasks.get(id)
    if (t === undefined) return bad(404, { ok: false, error: '没有这个任务' })
    t.status = 'failed'
    t.error = '已取消'
    t.endedAt = Date.now()
    return ok({ ok: true })
  }
  if (p.startsWith('/api/ecom-workbench/generate/') && method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/ecom-workbench/generate/'.length))
    const t = tasks.get(id)
    if (t === undefined) return bad(404, { ok: false, error: '没有这个任务' })
    /* 每次问到就往前走一步：第 2 次变 running，第 4 次变 success。
     * 这样「轮询真的在跑」与「跑完了不再问」两条都能验。 */
    tick += 1
    if (tick >= 2 && t.status === 'submitted') t.status = 'running'
    if (tick >= 4 && t.status === 'running') {
      t.status = 'success'
      t.endedAt = Date.now()
      t.artifacts = [{ id: 'art-' + id, mime: 'image/png' }]
    }
    return ok({ ok: true, task: { ...t } })
  }
  return ok({ ok: true, items: [] })
}
window.fetch = host
globalThis.fetch = host

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/** 挂一个组件。
 *
 * ⚠️ 2026-10-26：原来这里是 `act(() => setTimeout(wait))`，四处调用各睡 900ms，
 * 合计 3.6 秒。那 3.6 秒等的是「`GET /gen-models` 回来后首次渲染完」——
 * 而这件事**有可观察信号**（`sent` 里出现那个请求、下拉里有 optgroup），
 * 所以改成等任务队列跑空（`drain()`），由断言处自己等到条件成立。
 *
 * ⚠️ 去掉死等之后，原本靠它当窗口的那条**否定断言**（「没有去问 `/models`」）
 * 必须单独补窗口 —— 见 ② 段那处的说明。
 */
async function mount(el) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await drain() })
  return {
    el: hostEl,
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/** 等一段（让轮询跑几轮）。 */
async function settle(ms = 400) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)) })
}

/** 点一下。
 *
 * ⚠️ 2026-10-26：末尾原来是 `settle(200)`（实打实睡 200ms），六处调用合计 1.2 秒。
 * 它等的是「点击处理函数跑完 + React 把新状态刷进 DOM」，那件事的判据是
 * **任务队列空了**，不是一个猜出来的毫秒数。
 *
 * ⚠️ 必须留在 `act` 里：这是「制造变化」的动作，React 的状态更新要靠 act 刷进 DOM。
 * ⚠️ 而那一步之后的**等待**相反 —— 不能包进 act（会把更新攒住、永远等不到）。
 * 三次实测见文件头「`act` 与「等待」的关系」。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await drain() })
}

/** 改一个受控输入框的值（React 要认原生 setter，直接赋 value 不触发 onChange）。 */
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
  /* ⚠️ 2026-10-26：原来 `settle(120)`（睡 120ms），十二处调用合计 1.44 秒。
   * 等的是 onChange 跑完并重新渲染 —— 换成等任务队列空。理由同 `click`。 */
  await act(async () => { await drain() })
}

const iw = await import('../src/client/workbench/ImageWorkbench.tsx')
const { VideoWorkbench } = await import('../src/client/workbench/VideoWorkbench.tsx')
const { AudioWorkbench } = await import('../src/client/workbench/AudioWorkbench.tsx')

/**
 * 最小 `DataTransfer` 桩（票 41 拖文件那条要用）。
 *
 * jsdom **没有** `DataTransfer` 构造器，也没有 `DragEvent` 的 `dataTransfer`。
 * 这里的桩只实现我们真用到的部分：`types` / `files` / `dropEffect` / `getData`。
 * `content-canvas-ops.mjs` 里有一份同族的，但那份不带 `files` ——
 * 而「拖图片进参考图框」验的正是 `files`，所以这份必须补上。
 */
class FakeDT {
  /** @param {File[]} files 拖进来的文件。 */
  constructor(files = []) {
    this._m = new Map()
    this.files = files
    this.dropEffect = 'none'
    this.effectAllowed = 'all'
  }
  /** 有哪些类型（`onDragEnter` 里用 `types.includes('Files')` 判）。 */
  get types() {
    return this.files.length > 0 ? ['Files'] : [...this._m.keys()]
  }
  /** 放一份数据。 */
  setData(t, v) { this._m.set(String(t), String(v)) }
  /** 取一份数据。 */
  getData(t) { return this._m.get(String(t)) ?? '' }
}
window.DataTransfer = FakeDT
globalThis.DataTransfer = FakeDT

/**
 * 造一个带 `dataTransfer` 的事件。
 * @param {string} type 事件名。
 * @param {object} dt 桩。
 * @returns {Event} 事件。
 */
function dtEvent(type, dt) {
  const e = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt, configurable: true })
  return e
}

/**
 * 造一个假 `File`（只实现 `addFiles` 真读的那几个属性 + `FileReader` 能读它）。
 *
 * ## 为什么不用 `new File([...], name)` 直接造
 *
 * jsdom 的 `File` 确实存在，但 `FileReader.readAsDataURL` 对它的支持依赖
 * `Blob` 的异步实现；在本仓库的 jsdom 版本下那条路会挂住。
 * 所以直接造一个**最简对象**，只给 `name` / `type`，然后**替换 `FileReader`**——
 * 见下面的 `installFakeReader`。这样验的是「拿到文件之后做对了什么」，
 * 而不是「jsdom 的 File 实现对不对」。
 *
 * @param {string} name 文件名。
 * @param {string} type MIME。
 * @returns {object} 假文件。
 */
function fakeFile(name, type = 'image/png') {
  return { name, type }
}

/**
 * 把 `FileReader` 换成一个同步版本。
 *
 * ## 为什么必须换
 *
 * `SubmitForm` 里 `refOfFile` 用的是 `new FileReader()` + `onload` + `readAsDataURL`。
 * jsdom 那份实现在假 `File`（普通对象）上调 `readAsDataURL` 会抛
 * `TypeError: not a Blob`。我们验的是「读到之后怎么处理」，所以给一个
 * 走同一条回调契约的桩：`readAsDataURL` 立刻把 `result` 填成 data URL、调 `onload`。
 *
 * @param {(file: object) => string} toDataUrl 文件 → data URL。
 * @returns {() => void} 还原函数。
 */
function installFakeReader(toDataUrl) {
  const RealWin = window.FileReader
  const RealGlobal = globalThis.FileReader
  /* ⚠️ **两处都要装**。源码里 `new FileReader()` 用的是**裸名**，那是
   * `globalThis` 上的绑定；只装 `window.FileReader` 的话，源码那一行会抛
   * `ReferenceError: FileReader is not defined`（第一版就是这么挂的）。
   * 在 jsdom 里 `window` 与 `globalThis` 不是同一个对象 —— 这个坑本项目
   * 已经踩过（见 `pitfalls/假防线` 第 20 条「EventSource 装在 window 上源码却读全局」）。 */
  class FakeReader {
    /** 一次读取的容器。 */
    constructor() { this.result = null; this.onload = null; this.onerror = null }
    /**
     * 读成 data URL（同步回调，与真实异步的**契约相同**）。
     * @param {object} file 假文件。
     */
    readAsDataURL(file) {
      try {
        this.result = toDataUrl(file)
        if (typeof this.onload === 'function') this.onload()
      } catch (e) {
        if (typeof this.onerror === 'function') this.onerror(e)
      }
    }
  }
  window.FileReader = FakeReader
  globalThis.FileReader = FakeReader
  return () => {
    window.FileReader = RealWin
    globalThis.FileReader = RealGlobal
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：分组 / 请求体 / 缺项 / 合并
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：按渠道分组、请求体、合并历史与在跑 ===')
{
  const g = iw.groupModelsByChannel(MODELS.filter(m => m.caps.includes('image')))
  check('★★ 模型按渠道分组（两个渠道 → 两组）', g.length === 2, '实际 ' + String(g.length) + ' 组')
  check('★ 第一组是本地 ComfyUI、里面是 qwen-image',
    g[0]?.channelName === '本地 ComfyUI' && g[0]?.models[0]?.modelId === 'qwen-image',
    JSON.stringify(g.map(x => x.channelName + ':' + x.models.map(m => m.modelId).join(','))))
  check('★ 第二组是某云端、里面是 flux-pro',
    g[1]?.channelName === '某云端' && g[1]?.models[0]?.modelId === 'flux-pro')

  const body = iw.submitBody('image', {
    ...iw.EMPTY_DRAFT,
    prompt: '  白底主图  ', model: 'flux-pro', channelId: 'ch_remote',
    size: '832x1216', count: '3',
  })
  check('★★ 请求体带 kind / prompt / model / channelId',
    body.kind === 'image' && body.prompt === '白底主图' && body.model === 'flux-pro' && body.channelId === 'ch_remote',
    JSON.stringify(body))
  check('★★ 请求体带 size 与 count（数字，不是字符串）',
    body.size === '832x1216' && body.count === 3, JSON.stringify(body))
  check('★ 提示词首尾空格被去掉（不是原样发出去）', String(body.prompt) === '白底主图')

  const videoBody = iw.submitBody('video', { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm', seconds: '8' })
  check('★★ 视频的请求体带 seconds、不带 count',
    videoBody.seconds === 8 && videoBody.count === undefined, JSON.stringify(videoBody))

  /* ⚠️ 这一条票 29 起**换了喂法，判据强度没降**。
   *
   * 原意是「音频也走 `kind !== 'image'` 那条分支，所以填了的 seconds 会传下去」。
   * 它原来拿 `EMPTY_DRAFT` 当底（音频那时也默认 5），但**喂的是填过的 12** ——
   * 所以它验的从来不是「默认值」，而是「传下去了没有」。
   *
   * 票 29 之后音频的空草稿时长是空串，拿 `EMPTY_DRAFT` 当底就与界面对不上了
   * （界面此刻给的是 `emptyDraftOf('audio')`）。改成从真实基底出发，
   * **验的还是同一件事**：填了 12 → 传出去 12。
   *
   * 真正的「不填会怎样」由下面第 ②·五 段专门验，不靠这一条。 */
  const audioBody = iw.submitBody('audio', { ...iw.emptyDraftOf('audio'), prompt: 'q', model: 'm', seconds: '12' })
  check('★ 音频也走那条分支：填了 12 就传 12', audioBody.seconds === 12, JSON.stringify(audioBody))

  const noRef = iw.submitBody('image', { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm' })
  check('★★ 没选参考图就不发 refs 这个键（发空会让宿主当成真的空）',
    noRef.refs === undefined, JSON.stringify(noRef))

  /* ══ 票 41：参考图从单张改成数组（纯函数层）══════════════════════════
   *
   * ## 为什么这一组先验纯函数
   *
   * 参考图的增删调序如果写在组件里，每条断言都得挂一次组件、点一次——慢且脆。
   * 把这四件事做成纯函数（`appendRefs` / `removeRef` / `moveRef` / `splitDataUrl`），
   * 就能直接喂数据验，而**界面只负责调它们**。判据 2「顺序影响提交体的数组顺序」
   * 因此能落到「`moveRef` 换了位置 → `submitBody` 出来的顺序跟着换」这条链上。 */
  const R = (id, name) => ({ id, base64: 'B' + id, mime: 'image/png', name })

  /* ── splitDataUrl：把 data: URL 拆成 base64 + MIME ── */
  const sp1 = iw.splitDataUrl('data:image/jpeg;base64,AAAA')
  check('★★ splitDataUrl：拆出 base64', sp1.base64 === 'AAAA', JSON.stringify(sp1))
  check('★★ splitDataUrl：拆出 MIME（不是写死 png）', sp1.mime === 'image/jpeg', sp1.mime)
  const sp2 = iw.splitDataUrl('没有逗号的串')
  check('★ splitDataUrl：没有逗号时原样当 base64、MIME 走兜底',
    sp2.base64 === '没有逗号的串' && sp2.mime === 'image/png', JSON.stringify(sp2))

  /* ── appendRefs：**追加**不是替换（判据 4 的纯函数半边）── */
  const base = [R('a', 'a.png')]
  const app1 = iw.appendRefs(base, [R('b', 'b.png')])
  check('★★★ appendRefs：是**追加**，原有一张还在（两张）',
    app1.length === 2 && app1[0].id === 'a' && app1[1].id === 'b',
    app1.map(r => r.id).join(','))
  check('★★ appendRefs：不改入参（原数组仍只有一张）', base.length === 1, String(base.length))

  /* ── removeRef：**按 id 删**，不按下标（判据 2 的前半）── */
  const three = [R('a', 'a.png'), R('b', 'b.png'), R('c', 'c.png')]
  const rm = iw.removeRef(three, 'b')
  check('★★★ removeRef：删中间那张，剩 a / c（按 id 不是按下标）',
    rm.length === 2 && rm.map(r => r.id).join(',') === 'a,c',
    rm.map(r => r.id).join(','))
  check('★ removeRef：删一个不存在的 id 时原样返回（不炸）',
    iw.removeRef(three, 'zzz').length === 3)

  /* ── moveRef：前后移（判据 2 的后半）── */
  const mv1 = iw.moveRef(three, 0, 1)
  check('★★★ moveRef：第 0 张往后移 → 变成 b,a,c（真的换了位）',
    mv1.map(r => r.id).join(',') === 'b,a,c', mv1.map(r => r.id).join(','))
  const mv2 = iw.moveRef(three, 2, -1)
  check('★★ moveRef：最后一张往前移 → a,c,b',
    mv2.map(r => r.id).join(',') === 'a,c,b', mv2.map(r => r.id).join(','))
  check('★★ moveRef：第一张再往前移 → 不动（越界不炸）',
    iw.moveRef(three, 0, -1).map(r => r.id).join(',') === 'a,b,c')
  check('★★ moveRef：最后一张再往后移 → 不动（越界不炸）',
    iw.moveRef(three, 2, 1).map(r => r.id).join(',') === 'a,b,c')
  check('★ moveRef：不改入参', three.map(r => r.id).join(',') === 'a,b,c')

  /* ── 编号（照参考的「图片N」，从 1 起）── */
  check('★ refLabel：第 0 张写「图片1」（人是从 1 数的）', iw.refLabel(0) === '图片1', iw.refLabel(0))
  check('★ refLabel：第 2 张写「图片3」', iw.refLabel(2) === '图片3', iw.refLabel(2))

  /* ── 判据 2 的整条链：调序之后**提交体里的顺序跟着换** ──
   *
   * 这一条是票面「顺序影响提交体的数组顺序」的直接判据。
   * 只验 `moveRef` 换了位置不够 —— 那只证明数组变了；
   * 要证明 `submitBody` **按列表顺序原样映射**，才叫「影响提交体」。 */
  const movedDraft = { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm', refs: mv1 }
  const movedBody = iw.submitBody('image', movedDraft)
  /* `mv1` 是 `[b, a, c]`（第 0 张往后移一位，第三张没动）——
   * 所以期望值必须是三条、不是两条。第一版写成 `Bb,Ba` 漏了 c，是我不严谨。 */
  check('★★★ 判据 2：调序之后提交体里 refs 的顺序跟着换（b 在前、c 仍在最后）',
    Array.isArray(movedBody.refs) && movedBody.refs.map(r => r.base64).join(',') === 'Bb,Ba,Bc',
    JSON.stringify(movedBody.refs))

  /* ── 判据 1 的纯函数半边：多张时 refs 就是多条 ── */
  const twoDraft = { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm', refs: three }
  const twoBody = iw.submitBody('image', twoDraft)
  check('★★★ 判据 1：两张参考图 → 提交体里 refs 是两条',
    Array.isArray(twoBody.refs) && twoBody.refs.length === 3,
    '实际 ' + String(Array.isArray(twoBody.refs) ? twoBody.refs.length : '（不是数组）') + ' 条')
  /* 每一条都只有 mime + base64 两个键（宿主 `GenerateInput.refs` 的形状）。 */
  const refKeys = Object.keys(twoBody.refs[0] ?? {}).sort().join(',')
  check('★★ 提交体里每条 ref 只有 mime 与 base64（不带 name / id 这些前端字段）',
    refKeys === 'base64,mime', refKeys)
  /* MIME 为空时兜底成 image/png（老记录/剪贴板可能给空）。 */
  const emptyMime = iw.submitBody('image', {
    ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm',
    refs: [{ id: 'x', base64: 'XX', mime: '', name: 'x.png' }],
  })
  check('★ 单张时 MIME 为空也兜底成 image/png',
    emptyMime.refs?.[0]?.mime === 'image/png', JSON.stringify(emptyMime.refs))

  /* ── 判据 5：从旧记录回填草稿时，参考图是空列表（记录里不存字节）──
   *
   * ⚠️ 这一条**不是**「老记录读成一张」。票面那句写的是「老记录里只有一张时读成一张」，
   * 但落盘结构里**没有参考图的字节**（`generate.ts` 的 `logOf` 只写 size/count/seconds），
   * 所以任何人都读不出一张来。实际行为是：**老记录与新记录一样，都回填空列表**。
   * 这一条我按**事实**验，不按票面那句话验 —— 并如实报给 lead。 */
  const oldRow = {
    id: 'old', kind: 'image', createdAt: 1, endedAt: 2, status: 'success',
    channelId: 'c', model: 'm', prompt: '老记录',
    params: { size: '1024x1024', count: 1 },
    artifacts: [], usage: {},
  }
  const back = iw.draftFromRow('image', iw.mergeRows([oldRow], [])[0])
  check('★★ 判据 5 的事实版：老记录回填时参考图是**空列表**（记录里没存字节）',
    Array.isArray(back.refs) && back.refs.length === 0,
    '实际 ' + String(Array.isArray(back.refs) ? back.refs.length : '（不是数组）'))
  check('★ 回填的草稿里 refs 是**数组**（形状统一，不是 undefined）',
    Array.isArray(back.refs))

  /* ══ 票 44：成败标签的两个纯函数 ═════════════════════════════════════
   *
   * ## 这一组为什么最重要
   *
   * lead 2026-10-28 裁的落差 C：「算不出失败数就**不显示**，不许编」。
   * 而「编一个」在代码里长得非常像对的 —— `generationCount - successCount`
   * 在老记录上会算出负数或恰好等于成功数。所以这一组要逐个情形钉。 */
  const rowOf = (over) => iw.mergeRows([{
    id: 'r1', kind: 'image', createdAt: 1000, endedAt: 2000, status: 'success',
    channelId: 'c', model: 'm', prompt: 'p', params: {}, artifacts: [], usage: {},
    ...over,
  }], [])[0]

  /* ① 全成：5 张全成功 → 成功 5、失败 0。 */
  const allOk = iw.countsOf(rowOf({
    artifacts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
    usage: { images: 5 },
  }))
  check('★★★ countsOf：5 张全成 → 成功 5、失败 0',
    allOk.ok === 5 && allOk.fail === 0, JSON.stringify(allOk))

  /* ② 部分成：要了 5 张、只出 3 张 → 成功 3、失败 2。 */
  const part = iw.countsOf(rowOf({
    status: 'failed',
    artifacts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    usage: { images: 5 },
  }))
  check('★★★ countsOf：要 5 出 3 → 成功 3、失败 2',
    part.ok === 3 && part.fail === 2, JSON.stringify(part))

  /* ③ **老记录（无 `usage.images`）→ 失败数算不出，给 `null`**（落差 C 的核心）。 */
  const oldOne = iw.countsOf(rowOf({
    status: 'failed', artifacts: [{ id: 'a' }], usage: {},
  }))
  check('★★★ countsOf：老记录没有 usage.images → 失败数给 null（不许编）',
    oldOne.ok === 1 && oldOne.fail === null, JSON.stringify(oldOne))
  /* 反面：绝不能是 0（0 会被读成「一张都没失败」）。 */
  check('★★★ 反面：老记录的失败数**不是 0**（0 会被读成没有失败）',
    oldOne.fail !== 0, String(oldOne.fail))

  /* ④ `usage.images` 比产物数小（坏数据）→ 也算不出，不给负数。 */
  const bad = iw.countsOf(rowOf({
    status: 'failed',
    artifacts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    usage: { images: 1 },
  }))
  check('★★★ countsOf：usage 比产物数还小（坏数据）→ 失败数给 null，不出现负数',
    bad.fail === null && bad.ok === 3, JSON.stringify(bad))

  /* ⑤ 总张数：有 usage 用它，没有退回产物数；都没有给 null。 */
  check('★★ totalOf：有 usage.images 就用它',
    iw.totalOf(rowOf({ artifacts: [{ id: 'a' }], usage: { images: 7 } })) === 7)
  check('★★ totalOf：没 usage 时退回产物数（真的那个数，不是编的）',
    iw.totalOf(rowOf({ artifacts: [{ id: 'a' }, { id: 'b' }], usage: {} })) === 2)
  check('★★ totalOf：既没 usage 也没产物 → null（界面整个不渲染那个标签）',
    iw.totalOf(rowOf({ artifacts: [], usage: {} })) === null)

  check('★★ 缺提示词时能报出缺哪一项',
    iw.missingFields('image', { ...iw.EMPTY_DRAFT, model: 'm' }).join(',') === '提示词')
  check('★★ 缺模型时也能报出来',
    iw.missingFields('image', { ...iw.EMPTY_DRAFT, prompt: 'q' }).join(',') === '模型')

  const rows = iw.mergeRows(
    [{ id: 'a', kind: 'image', createdAt: 100, endedAt: 200, status: 'success', channelId: 'c', model: 'm', prompt: '老记录', params: { size: '1024x1024' }, artifacts: [], usage: {} }],
    [{ id: 'b', kind: 'image', status: 'running', stage: 'running', prompt: '在跑的', model: 'm', channelId: 'c', channelName: '', createdAt: 300, waitedMs: 0, artifacts: [] }],
  )
  check('★★ 历史与在跑合并到一张表（2 行）', rows.length === 2, '实际 ' + String(rows.length))
  check('★★ 按时间倒序（在跑那条新的在最上面）', rows[0]?.id === 'b', rows.map(r => r.id).join(','))
  check('★ 在跑那条 live 为真（列表据此显示取消）', rows[0]?.live === true)
  check('★ 历史那条 live 为假', rows[1]?.live === false)

  const sameId = iw.mergeRows(
    [{ id: 'x', kind: 'image', createdAt: 100, status: 'pending', channelId: 'c', model: 'm', prompt: '旧', params: {}, artifacts: [], usage: {} }],
    [{ id: 'x', kind: 'image', status: 'success', stage: 'done', prompt: '新', model: 'm', channelId: 'c', channelName: '', createdAt: 100, waitedMs: 0, artifacts: [{ id: 'z' }] }],
  )
  check('★★ 同一个 id 两边都有时以任务为准（它是活的，历史是快照）',
    sameId.length === 1 && sameId[0].status === 'success', JSON.stringify(sameId.map(r => r.status)))
}

/* ══════════════════════════════════════════════════════════════════════
 * ①·五 票 29：音频的时长默认留空、请求体不带 size
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 这一段守的是什么
 *
 * 后端 `runComfyBranch`（`generate.ts:700`）与 `applyBindings` 都守住了
 * 「没喂 `duration` 就不动 node47」这条边界，注释原话：
 * 「发 0 或 5 会把内置音频工作流里那个空串改掉，等于替用户做了个他没收到的决定」。
 *
 * 而界面原来把 `EMPTY_DRAFT.seconds` 写死成 `'5'`，音频格一打开框里就是 5 ——
 * **用户只填提示词、不碰时长，也会发出 `seconds: 5`，把后端刚守住的边界绕过去了。**
 * 参考项目那个 `audioSeconds` 是「存了不生效」（提交路径里一次都没用），
 * 我们当时是「存了、默认还发一个 5 过去」。它的无效值是不动，我们的默认值是在改数据。
 *
 * ## 为什么这几条以前是假绿
 *
 * 旧断言（本文件第 ① 段那条）喂的是**填过的**草稿（`seconds: '12'`），
 * 它验的是「传下去了没有」，压根没碰「不填会怎样」。
 * 所以「默认发 5」这件事一直没有任何断言盯着 —— 它绿着，而行为是错的。
 */
console.log('')
console.log('=== ①·五 票 29：音频时长默认留空、不带 size ===')
{
  check('★★★ 音频的空草稿时长是空串（不是 5）',
    iw.emptyDraftOf('audio').seconds === '',
    JSON.stringify(iw.emptyDraftOf('audio').seconds))
  check('★★★ 视频的空草稿时长仍是 5（视频要这个数，不许被顺手改掉）',
    iw.emptyDraftOf('video').seconds === '5',
    JSON.stringify(iw.emptyDraftOf('video').seconds))
  check('★★ 生图的空草稿也还是原来那份（不受影响）',
    iw.emptyDraftOf('image').seconds === iw.EMPTY_DRAFT.seconds
    && iw.emptyDraftOf('image').size === '1024x1024',
    JSON.stringify({ seconds: iw.emptyDraftOf('image').seconds, size: iw.emptyDraftOf('image').size }))

  /* ── 判据 2：不填 → 请求体里没有 seconds 这个键 ──
   * ★ 这是这一段的重点。它以前是假绿，因为框里永远有值。 */
  const audioNoTime = iw.submitBody('audio', { ...iw.emptyDraftOf('audio'), prompt: '钢琴', model: 'm' })
  check('★★★ 音频不填时长 → 请求体里**没有** seconds 这个键（不替用户发 5）',
    audioNoTime.seconds === undefined,
    JSON.stringify(audioNoTime))

  /* ── 判据 3：填了就要传 ── */
  const audio12 = iw.submitBody('audio', { ...iw.emptyDraftOf('audio'), prompt: '钢琴', model: 'm', seconds: '12' })
  check('★★★ 音频填 12 → 请求体 seconds: 12（数字，不是字符串）',
    audio12.seconds === 12, JSON.stringify(audio12))

  /* ── 判据 4：音频不带 size ──
   * `size` 那行原来是 `if (d.size !== '')`，不判 kind；而音频表单里根本没有 size 框，
   * 缝上 `EMPTY_DRAFT.size` 的 '1024x1024' 就发出去了 —— 界面上没有、请求里却有。 */
  check('★★★ 音频请求体里**没有** size（界面上没有这个框，就不该发）',
    audio12.size === undefined, JSON.stringify(audio12))
  check('★★ 音频不填时长时也没有 size', audioNoTime.size === undefined, JSON.stringify(audioNoTime))

  /* ── 判据 5：视频那一路一字不变 ── */
  const video8 = iw.submitBody('video', {
    ...iw.emptyDraftOf('video'), prompt: 'q', model: 'm', seconds: '8', size: '832x1216',
  })
  check('★★★ 视频照旧带 seconds: 8', video8.seconds === 8, JSON.stringify(video8))
  check('★★★ 视频照旧带 size（不许被音频那条顺手弄坏）',
    video8.size === '832x1216', JSON.stringify(video8))
  const videoDefault = iw.submitBody('video', { ...iw.emptyDraftOf('video'), prompt: 'q', model: 'm' })
  check('★★ 视频不碰时长时照旧发默认的 5（与改动前一致）',
    videoDefault.seconds === 5, JSON.stringify(videoDefault))

  /* ── 生图那一路也不许被碰 ── */
  const imageBody = iw.submitBody('image', { ...iw.EMPTY_DRAFT, prompt: 'q', model: 'm', size: '1024x1024', count: '2' })
  check('★★ 生图照旧带 size 与 count，且不带 seconds',
    imageBody.size === '1024x1024' && imageBody.count === 2 && imageBody.seconds === undefined,
    JSON.stringify(imageBody))

  /* ── 重跑一条旧记录：音频要落回空，不落回 5 ──
   *
   * 这条防的是「为了改默认值，把 draftFromRow 忘了」——
   * 那样重跑一条没有时长参数的音频记录时会编出一个它当初没有的 5。 */
  const oldAudioRow = {
    id: 'z', kind: 'audio', live: false, status: 'success',
    prompt: '老音频', model: 'm', channelId: 'c', channelName: '',
    createdAt: 1, waitedMs: 0, artifacts: [],
    raw: { id: 'z', kind: 'audio', createdAt: 1, status: 'success', channelId: 'c', model: 'm', prompt: '老音频', params: {}, artifacts: [], usage: {} },
  }
  check('★★★ 重跑一条没存时长的音频记录 → 时长落回空（不编一个 5）',
    iw.draftFromRow('audio', oldAudioRow).seconds === '',
    JSON.stringify(iw.draftFromRow('audio', oldAudioRow).seconds))
  check('★★ 重跑视频记录时仍落回 5（视频的默认没变）',
    iw.draftFromRow('video', { ...oldAudioRow, kind: 'video' }).seconds === '5',
    JSON.stringify(iw.draftFromRow('video', { ...oldAudioRow, kind: 'video' }).seconds))

  /* ── 源码层：`size` 那行是**显式**判 kind，不是拿界面布局推断 ──
   *
   * 写成「`formFields(kind)` 里有 size 才发」看着对，但那是拿布局当业务规则：
   * 将来谁把 size 从视频表单里挪走，请求体就悄悄不发 size 了。
   * 这条断言钉住「业务判断必须写在提交这一侧」。 */
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/workbench/ImageWorkbench.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★★ 提交侧显式写 kind !== \'audio\'（不靠 formFields 推断业务）',
    /kind !== 'audio' && d\.size !== ''/.test(code))
  check('★★ 没有把 formFields 用在提交判断里',
    !/formFields\(kind\)[\s\S]{0,60}(size|body\.size)/.test(code))
}
console.log('')
console.log('=== ② 生图工作台：提交、轮询、已等秒数 ===')
{
  sent.length = 0
  bodies.length = 0
  tasks.clear()
  tick = 0
  nextId = 1

  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }))
  const q = sel => m.el.querySelector(sel)

  /* ⚠️ 2026-10-26：先等到 `GET /gen-models` **真的发出**，再断言「没有去问 /models」。
   *
   * ## 为什么必须补这一等
   *
   * 下面那条否定断言（「没有去问被占用的 /models」）原来的**观察窗口**是
   * `mount(el, 900)` 死等的那 900ms —— 它证明的是「那段时间里那个请求一直没来」。
   * 挂载改成等任务队列空之后，这个窗口会跟着一起缩掉；
   * 窗口一缩，「没来」就变得几乎无条件成立 —— 那是**假绿**，不是判据放松一点点。
   *
   * ## 为什么等「gen-models 来了」这个信号
   *
   * 它才是这段真正该有的时间基准：组件该问的是 gen-models。
   * 那个请求回来了 = 「初始化该发的请求都发完了」，
   * 之后再看 `sent` 里有没有 `/models`，才是一次有意义的检查。
   *
   * ⚠️ **不许写成 `if (await waitUntil(...)) { 断言 }`**：那样等不到就等于跳过断言。
   * 这里等不到也照常往下走，由下面那条断言自己判。 */
  await waitUntil(() => sent.some(s => s === 'GET /api/ecom-workbench/gen-models?kind=image'), 3000)

  /* ── 验收 1：提交区 + 模型下拉 ── */
  check('★★ 生图工作台有提交区', q('[data-ewb-gen-submit="image"]') !== null)
  const modelAsked = sent.some(s => s === 'GET /api/ecom-workbench/gen-models?kind=image')
  check('★★ 模型清单是从 `/gen-models?kind=image` 来的（不是 `/models`）',
    modelAsked, sent.filter(s => s.includes('models')).join(' / ') || '（一次都没问）')
  check('★ 没有去问被占用的 `/models`', !sent.some(s => s.startsWith('GET /api/ecom-workbench/models')),
    sent.filter(s => s.includes('/models')).join(' / ') || '（没问过）')
  const groups = [...m.el.querySelectorAll('[data-ewb-gen-submit-model] optgroup')]
  check('★★ 模型下拉按渠道分组（两个 optgroup）', groups.length === 2, '实际 ' + String(groups.length))
  check('★★ 分组标题带渠道名',
    (groups[0]?.getAttribute('label') ?? '').includes('本地 ComfyUI'),
    groups.map(g => g.getAttribute('label')).join(' / '))
  const opts = [...m.el.querySelectorAll('[data-ewb-gen-submit-model] option')]
  check('★ 分组里有具体模型选项', opts.length >= 3, '选项数 ' + String(opts.length))

  /* ── 验收 2：点生成 → POST /generate ── */
  await setValue(q('[data-ewb-gen-submit-prompt]'), '白底主图')
  await setValue(q('[data-ewb-gen-submit-model]'), 'flux-pro')
  /* ⚠️ 票 42：尺寸从「裸下拉」改成「13 个宽高比按钮 + W/H 两个框」。
   * 这里走 W/H 那条路：填 832 / 1216，断言算出来的 `size` 是 `832x1216`。
   * 两个值都是 16 的倍数，所以「16 倍数对齐」开着（默认）也不会改写它们。 */
  await setValue(q('[data-ewb-gen-submit-w]'), '832')
  await setValue(q('[data-ewb-gen-submit-h]'), '1216')
  await setValue(q('[data-ewb-gen-submit-count]'), '2')
  await click(q('[data-ewb-gen-submit-btn]'))
  await settle(300)

  const post = sent.filter(s => s === 'POST /api/ecom-workbench/generate')
  check('★★ 点「生成」发了 POST /generate', post.length === 1, '实际 ' + String(post.length) + ' 次')
  const b0 = bodies[0] ?? {}
  check('★★ 请求体带提示词', b0.prompt === '白底主图', JSON.stringify(b0))
  check('★★ 请求体带模型', b0.model === 'flux-pro')
  check('★★ 请求体带渠道（由选中的模型带出来）', b0.channelId === 'ch_remote', JSON.stringify(b0))
  check('★★ 请求体带尺寸', b0.size === '832x1216')
  check('★★ 请求体带张数', b0.count === 2, JSON.stringify(b0))

  /* ── 验收 3：提交后立刻在列表最上面、状态 pending，且表单清空 ── */
  const row0 = m.el.querySelector('[data-ewb-gen-row]')
  check('★★ 提交后列表里立刻出现这一条', row0 !== null)
  check('★★ 它在最上面（第一行）',
    row0?.getAttribute('data-ewb-gen-row') === 'task-1',
    '第一行=' + (row0?.getAttribute('data-ewb-gen-row') ?? '（没有）'))
  check('★★ 它的状态是「进行中」（pending，不是成功也不是失败）',
    (row0?.querySelector('[data-ewb-gen-status]')?.textContent ?? '').trim() === '进行中',
    row0?.querySelector('[data-ewb-gen-status]')?.textContent ?? '')
  check('★★ 提交后表单被清空了（不清用户会以为没提交成功、再点一次）',
    (q('[data-ewb-gen-submit-prompt]')?.value ?? '') === ''
    && (q('[data-ewb-gen-submit-model]')?.value ?? '') === '',
    '提示词=' + (q('[data-ewb-gen-submit-prompt]')?.value ?? '')
    + ' 模型=' + (q('[data-ewb-gen-submit-model]')?.value ?? ''))

  /* ── 验收 4：轮询真的在跑 ── */
  const pollsBefore = sent.filter(s => s.startsWith('GET /api/ecom-workbench/generate/task-1')).length
  await settle(2200)
  const pollsAfter = sent.filter(s => s.startsWith('GET /api/ecom-workbench/generate/task-1')).length
  check('★★ 轮询真的在跑（一段时间内 GET /generate/:id 被调了多次）',
    pollsAfter - pollsBefore >= 2, '又问了 ' + String(pollsAfter - pollsBefore) + ' 次')

  /* ── 验收 4 的反面：跑完之后不再问（不然后台一直在打宿主） ── */
  await settle(2400)
  const doneRow = m.el.querySelector('[data-ewb-gen-row="task-1"]')
  check('★★ 跑完之后状态变成「成功」',
    (doneRow?.querySelector('[data-ewb-gen-status]')?.textContent ?? '').trim() === '成功',
    doneRow?.querySelector('[data-ewb-gen-status]')?.textContent ?? '')
  const pollsDone = sent.filter(s => s.startsWith('GET /api/ecom-workbench/generate/task-1')).length
  await settle(1800)
  const pollsLater = sent.filter(s => s.startsWith('GET /api/ecom-workbench/generate/task-1')).length
  check('★★ 跑完之后**不再轮询**（没有白烧请求）', pollsLater === pollsDone,
    '从 ' + String(pollsDone) + ' 变成 ' + String(pollsLater))

  /* ── 验收 5：没有百分比 ── */
  check('★★ 没有百分比进度条元素',
    m.el.querySelector('progress, [role="progressbar"]') === null)
  const pctText = [...m.el.querySelectorAll('*')].map(e => e.textContent ?? '').join(' ')
  check('★★ 界面上没有「%」这种百分比写法（参考项目也没有）', !/\d+\s*%/.test(pctText))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 「已等 N 秒」在走 + 失败那条能重试
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 已等秒数在走、失败能重试 ===')
{
  sent.length = 0
  bodies.length = 0
  tasks.clear()
  tick = 0
  nextId = 1

  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }))
  const q = sel => m.el.querySelector(sel)

  await setValue(q('[data-ewb-gen-submit-prompt]'), '在跑的一条')
  await setValue(q('[data-ewb-gen-submit-model]'), 'flux-pro')
  await click(q('[data-ewb-gen-submit-btn]'))
  await settle(250)

  const readWait = () => {
    const t = q('[data-ewb-gen-row="task-1"] [data-ewb-gen-elapsed]')?.textContent ?? ''
    const mt = /已等 (\d+) 秒/.exec(t)
    return mt === null ? -1 : Number(mt[1])
  }
  const w0 = readWait()
  check('★★ 在跑那条显示「已等 N 秒」', w0 >= 0, '实际=' + String(w0))
  await settle(1500)
  const w1 = readWait()
  check('★★ 秒数在走（一秒多之后变大了）', w1 > w0, '从 ' + String(w0) + ' 变成 ' + String(w1))

  /* 让这一条失败：直接改桩里的任务。 */
  const t = tasks.get('task-1')
  t.status = 'failed'
  t.error = '上游 429 限流'
  t.endedAt = Date.now()
  await settle(1200)
  const failRow = q('[data-ewb-gen-row="task-1"]')
  check('★★ 失败那条显示失败原因',
    (failRow?.querySelector('[data-ewb-gen-failreason]')?.textContent ?? '').includes('429'),
    failRow?.querySelector('[data-ewb-gen-failreason]')?.textContent ?? '（没有原因块）')

  /* ── 验收 6：重试 → 再发一次 POST ── */
  const retryBtn = q('[data-ewb-gen-retry="task-1"]')
  check('★★ 失败那条有「重试」按钮', retryBtn !== null)
  check('★ 成功那条没有「重试」（只有失败才用得上）',
    q('[data-ewb-gen-retry="task-2"]') === null)
  const beforeRetry = sent.filter(s => s === 'POST /api/ecom-workbench/generate').length
  await click(retryBtn)
  await settle(400)
  const afterRetry = sent.filter(s => s === 'POST /api/ecom-workbench/generate').length
  check('★★ 点「重试」重新提交了一次（第二次 POST /generate）',
    afterRetry === beforeRetry + 1, '从 ' + String(beforeRetry) + ' 变成 ' + String(afterRetry))
  check('★★ 重试带的是同一份参数（提示词与模型都对）',
    bodies[bodies.length - 1]?.prompt === '在跑的一条'
    && bodies[bodies.length - 1]?.model === 'flux-pro',
    JSON.stringify(bodies[bodies.length - 1] ?? {}))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 视频：pending 有取消，点了调 /cancel
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 视频创作台：提交 + 取消 ===')
{
  sent.length = 0
  bodies.length = 0
  tasks.clear()
  tick = 0
  nextId = 1

  const m = await mount(React.createElement(VideoWorkbench, { active: true }))
  const q = sel => m.el.querySelector(sel)

  check('★★ 视频创作台也有提交区', q('[data-ewb-gen-submit="video"]') !== null)
  check('★★ 视频问的是 kind=video 的模型',
    sent.some(s => s === 'GET /api/ecom-workbench/gen-models?kind=video'),
    sent.filter(s => s.includes('gen-models')).join(' / '))
  check('★★ 视频提交区有时长、没有张数',
    q('[data-ewb-gen-submit-seconds]') !== null && q('[data-ewb-gen-submit-count]') === null)

  await setValue(q('[data-ewb-gen-submit-prompt]'), '一段视频')
  await setValue(q('[data-ewb-gen-submit-model]'), 'minimax-h3')
  await setValue(q('[data-ewb-gen-submit-seconds]'), '8')
  await click(q('[data-ewb-gen-submit-btn]'))
  await settle(300)

  check('★★ 视频提交带 seconds',
    bodies[0]?.seconds === 8 && bodies[0]?.kind === 'video', JSON.stringify(bodies[0] ?? {}))
  const row = q('[data-ewb-video-row="task-1"]')
  check('★★ 视频那条用的是它自己的钩子（data-ewb-video-row）', row !== null)
  check('★★ 视频在跑时显示「已等 N 秒」',
    /已等 \d+ 秒/.test(row?.querySelector('[data-ewb-video-wait]')?.textContent ?? ''),
    row?.querySelector('[data-ewb-video-wait]')?.textContent ?? '')
  const cancelBtn = q('[data-ewb-gen-cancel="task-1"]')
  check('★★ 视频在跑那条有「取消」按钮', cancelBtn !== null)
  await click(cancelBtn)
  await settle(350)
  check('★★ 点「取消」调了 /generate/:id/cancel',
    sent.some(s => s === 'POST /api/ecom-workbench/generate/task-1/cancel'),
    sent.filter(s => s.includes('cancel')).join(' / ') || '（一次都没发）')
  check('★ 取消之后那条不再显示「进行中」',
    (q('[data-ewb-video-row="task-1"] [data-ewb-video-status]')?.textContent ?? '').trim() !== '进行中',
    q('[data-ewb-video-row="task-1"] [data-ewb-video-status]')?.textContent ?? '')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 音频工作台
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 音频工作台：存在、能提交、列表里是播放器 ===')
{
  sent.length = 0
  bodies.length = 0
  tasks.clear()
  tick = 0
  nextId = 1

  const m = await mount(React.createElement(AudioWorkbench, { active: true }))
  const q = sel => m.el.querySelector(sel)

  check('★★ 音频工作台存在', m.el.querySelector('[data-ewb-workbench="audio"]') !== null)
  check('★★ 音频问的是 kind=audio 的模型',
    sent.some(s => s === 'GET /api/ecom-workbench/gen-models?kind=audio'),
    sent.filter(s => s.includes('gen-models')).join(' / '))
  check('★★ 音频提交区有提示词、模型、时长，没有张数与尺寸',
    q('[data-ewb-gen-submit-prompt]') !== null
    && q('[data-ewb-gen-submit-seconds]') !== null
    && q('[data-ewb-gen-submit-count]') === null
    && q('[data-ewb-gen-submit-size]') === null)

  await setValue(q('[data-ewb-gen-submit-prompt]'), '一段配乐')
  await setValue(q('[data-ewb-gen-submit-model]'), 'music-3')
  await setValue(q('[data-ewb-gen-submit-seconds]'), '20')
  await click(q('[data-ewb-gen-submit-btn]'))
  await settle(300)
  check('★★ 音频提交带 kind=audio 与 seconds',
    bodies[0]?.kind === 'audio' && bodies[0]?.seconds === 20, JSON.stringify(bodies[0] ?? {}))

  /* 让它出结果，验列表里是播放器。 */
  const t = tasks.get('task-1')
  t.status = 'success'
  t.endedAt = Date.now()
  t.artifacts = [{ id: 'art-audio-1', mime: 'audio/mpeg' }]
  await settle(1400)
  const thumb = m.el.querySelector('[data-ewb-gen-thumb="art-audio-1"]')
  check('★★ 音频结果用播放器渲染（<audio>）', thumb !== null && thumb.tagName.toLowerCase() === 'audio',
    thumb === null ? '（没有产物块）' : thumb.tagName)
  check('★ 播放器地址指向宿主产物路由',
    (thumb?.getAttribute('src') ?? '') === '/api/ecom-workbench/artifact/art-audio-1',
    thumb?.getAttribute('src') ?? '')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 票 41 界面层：参考图多张 —— 拖文件追加 / 删单张 / 调序 / 剪贴板置灰
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 判据为什么必须真点
 *
 * 「参考图能拖、能删、能调序」这三件事的失败形态都是**按钮在那儿但点了没反应**
 * —— 只查源码有没有那段分支，全绿。所以这里一律真派发事件、真读 DOM。
 *
 * ## 那一项唯一量不了的说清
 *
 * jsdom 不做布局：`scrollWidth` / `clientWidth` 恒 0，所以「横向滚动条能不能滚」
 * 量不到。那条 `onWheel` 竖转横只保证有代码在、且不吞掉没溢出时的滚动 ——
 * 后者能验（不 preventDefault），前者如实记为验不到。
 */
console.log('')
console.log('=== ⑥ 票 41：参考图多张（拖文件 / 删 / 调序 / 剪贴板）===')
{
  /* 让假 FileReader 把每个文件读成不同的 data URL（靠文件名区分，便于断言）。 */
  const restoreReader = installFakeReader(f => 'data:image/png;base64,REF-' + f.name)

  sent.length = 0
  bodies.length = 0
  tasks.clear()
  tick = 0
  nextId = 1

  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }))
  const q = sel => m.el.querySelector(sel)
  const all = sel => [...m.el.querySelectorAll(sel)]

  /* ── 判据 1 前提：能一次选多张（`multiple`）── */
  const fileBox = q('[data-ewb-gen-submit-ref]')
  check('★★ 判据 1：文件框是 `multiple`（一次能选多张）',
    fileBox !== null && fileBox.hasAttribute('multiple'),
    fileBox === null ? '（找不到文件框）' : 'multiple=' + String(fileBox.hasAttribute('multiple')))
  check('★ 文件框只收图片（accept="image/*"）',
    (fileBox?.getAttribute('accept') ?? '') === 'image/*', fileBox?.getAttribute('accept') ?? '')

  /* ── 判据 3 的前提：剪贴板按钮在「不支持」时置灰且有说明 ──
   *
   * jsdom 里 `navigator.clipboard` **不存在**，所以默认就该是置灰态。
   * 判两件：按钮 disabled + title 说清了原因（不是空 title）。 */
  const clipBtn = q('[data-ewb-gen-ref-clipboard]')
  check('★★ 判据 3：有「剪贴板」按钮', clipBtn !== null)
  check('★★★ 判据 3：读不到剪贴板时按钮被**禁用**（点它也不该有反应）',
    clipBtn?.disabled === true, 'disabled=' + String(clipBtn?.disabled))
  const clipTitle = clipBtn?.getAttribute('title') ?? ''
  check('★★ 判据 3：禁用时**说清原因**（不是空 title）',
    clipTitle !== '' && /剪贴板/.test(clipTitle), JSON.stringify(clipTitle))

  /* ── 判据 4：拖文件进框 = **追加**，不是替换 ──
   *
   * 分两步：先拖一张进去，再拖两张进去 —— 断言「3 张都在」。
   * 只验第一次的话，「替换」与「追加」在第一张上表现一样（都是 1 张）。 */
  const box = q('[data-ewb-gen-ref-box]')
  check('★★ 有虚线参考图框（`data-ewb-gen-ref-box`）', box !== null)
  check('★ 空态里有引导文字（不是一片空白）',
    /暂无参考图|松开即可/.test(box?.textContent ?? ''), (box?.textContent ?? '').slice(0, 40))

  await act(async () => {
    box.dispatchEvent(dtEvent('dragenter', new FakeDT([fakeFile('a.png')])))
    box.dispatchEvent(dtEvent('dragover', new FakeDT([fakeFile('a.png')])))
    box.dispatchEvent(dtEvent('drop', new FakeDT([fakeFile('a.png')])))
  })
  await act(async () => { await drain() })
  check('★★★ 判据 4：拖一张进来 → 出现 1 张缩略图',
    all('[data-ewb-gen-ref-item]').length === 1,
    '实际 ' + String(all('[data-ewb-gen-ref-item]').length) + ' 张')

  await act(async () => {
    box.dispatchEvent(dtEvent('drop', new FakeDT([fakeFile('b.png'), fakeFile('c.png')])))
  })
  await act(async () => { await drain() })
  const afterDrop = all('[data-ewb-gen-ref-item]').length
  check('★★★ 判据 4：再拖两张进来 → 是**追加**成 3 张（不是替换成 2 张）',
    afterDrop === 3, '实际 ' + String(afterDrop) + ' 张')
  /* 反面：第一张还在（替换的话它会消失）。 */
  const names = all('[data-ewb-gen-ref-thumb]').map(e => e.getAttribute('src') ?? '')
  check('★★ 判据 4 反面：第一张**没有被替换掉**（a 还在）',
    names.some(x => x.includes('REF-a.png')), names.map(x => x.slice(-12)).join(' / '))

  /* ── 编号：第 1 张写「图片1」（人从 1 数）── */
  const firstItem = all('[data-ewb-gen-ref-item]')[0]
  check('★ 每张带编号（「图片1」这种）',
    /图片1/.test(firstItem?.textContent ?? ''), (firstItem?.textContent ?? '').slice(0, 20))

  /* ── 判据 2：删单张 ── */
  const idsBefore = all('[data-ewb-gen-ref-item]').map(e => e.getAttribute('data-ewb-gen-ref-item'))
  const delId = idsBefore[1]
  await click(q('[data-ewb-gen-ref-del="' + delId + '"]'))
  await act(async () => { await drain() })
  const idsAfterDel = all('[data-ewb-gen-ref-item]').map(e => e.getAttribute('data-ewb-gen-ref-item'))
  check('★★★ 判据 2：点某张的删除 → **删的正是那一张**（按 id 不按下标）',
    idsAfterDel.length === 2 && !idsAfterDel.includes(delId),
    '删前=' + idsBefore.join(',') + ' 删后=' + idsAfterDel.join(','))

  /* ── 判据 2 的另一半：调序，且**顺序影响提交体** ── */
  const beforeOrder = all('[data-ewb-gen-ref-thumb]').map(e => (e.getAttribute('src') ?? '').slice(-9))
  await click(q('[data-ewb-gen-ref-right="' + idsAfterDel[0] + '"]'))
  await act(async () => { await drain() })
  const afterOrder = all('[data-ewb-gen-ref-thumb]').map(e => (e.getAttribute('src') ?? '').slice(-9))
  check('★★★ 判据 2：点「往后移」→ 前两张真的换了位置',
    beforeOrder[0] !== afterOrder[0] && beforeOrder[0] === afterOrder[1],
    beforeOrder.join(',') + ' → ' + afterOrder.join(','))
  check('★ 调序之后没有丢张（还是 2 张）', afterOrder.length === 2, String(afterOrder.length))

  /* 真提交一次，看请求体里的 refs 顺序 = 界面上的顺序。 */
  await setValue(q('[data-ewb-gen-submit-prompt]'), '带两张参考图')
  await setValue(q('[data-ewb-gen-submit-model]'), 'flux-pro')
  await click(q('[data-ewb-gen-submit-btn]'))
  await settle(300)
  const refsSent = bodies[0]?.refs
  check('★★★ 判据 1 + 2：提交体里 refs 是两条，且顺序与界面一致',
    Array.isArray(refsSent) && refsSent.length === 2
    && refsSent[0].base64 === 'REF-' + afterOrder[0].replace('REF-', ''),
    Array.isArray(refsSent) ? refsSent.map(r => r.base64).join(',') : '（不是数组）')
  console.log('   提交的 refs:', Array.isArray(refsSent) ? refsSent.map(r => r.base64).join(' / ') : String(refsSent))

  /* ── 判据 4 补充：非图片文件被忽略（拖 PDF 进来不该变成参考图）── */
  const before4 = all('[data-ewb-gen-ref-item]').length
  await act(async () => {
    box.dispatchEvent(dtEvent('drop', new FakeDT([fakeFile('x.pdf', 'application/pdf')])))
  })
  await act(async () => { await drain() })
  check('★★ 拖非图片文件进来 → 忽略（张数不变）',
    all('[data-ewb-gen-ref-item]').length === before4,
    before4 + ' → ' + String(all('[data-ewb-gen-ref-item]').length))

  m.unmount()
  restoreReader()
}

/* ══════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 票 44 界面层：批量三按钮 / 成败标签 / 整卡回填 / 明细入口 / 查看素材
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 这一段的记录是手工造的（不走宿主）
 *
 * 因为要同时造三种记录：**新记录**（有 `usage.images`）、**老记录**（没有）、
 * **失败记录**。宿主那条路造不出「老记录」，而落差 C 的核心判据正是老记录。
 */
console.log('')
console.log('=== ⑦ 票 44：批量操作 / 五标签 / 整卡回填 / 查看素材 ===')
{
  /* 三条记录：一条新的全成、一条新的部分成、一条**老记录**（无 usage）。 */
  const LOGS = [
    {
      id: 'new-all', kind: 'image', createdAt: 3000, endedAt: 3600, status: 'success',
      channelId: 'ch_remote', model: 'flux-pro', prompt: '新的全成那条',
      params: { size: '1024x1024', count: 3 },
      artifacts: [{ id: 'art-1', width: 1024, height: 1024, bytes: 200704 }, { id: 'art-2' }, { id: 'art-3' }],
      usage: { images: 3 },
    },
    {
      id: 'new-part', kind: 'image', createdAt: 2000, endedAt: 2600, status: 'failed',
      channelId: 'ch_remote', model: 'flux-pro', prompt: '新的部分成那条',
      params: { size: '832x1216', count: 5 },
      artifacts: [{ id: 'art-4' }],
      usage: { images: 5 },
      error: '上游返回 429',
    },
    {
      id: 'old-one', kind: 'image', createdAt: 1000, endedAt: 1500, status: 'failed',
      channelId: 'ch_remote', model: 'flux-pro', prompt: '老记录没有 usage',
      params: { size: '1024x1024' },
      artifacts: [{ id: 'art-5' }],
      usage: {},
    },
  ]

  /** 让 `/gen-logs` 回这三条、其余走默认桩。 */
  const realFetch44 = globalThis.fetch
  globalThis.fetch = window.fetch = async (url, init) => {
    const u = String(url)
    const method = String(init?.method ?? 'GET')
    if (u.includes('/gen-logs') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, logs: LOGS, items: LOGS }) }
    }
    if (u.includes('/gen-logs/') && method === 'DELETE') {
      sent.push('DELETE ' + u.replace(/^.*\/api\/ecom-workbench/, '/api/ecom-workbench'))
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u.includes('/artifact/') && method === 'DELETE') {
      sent.push('DELETE ' + u.replace(/^.*\/api\/ecom-workbench/, '/api/ecom-workbench'))
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return realFetch44(url, init)
  }

  sent.length = 0
  const m = await mount(React.createElement(iw.ImageWorkbench, { active: true }))
  const q = sel => m.el.querySelector(sel)
  const all = sel => [...m.el.querySelectorAll(sel)]
  await act(async () => { await drain() })

  /* ── 判据 1：三颗批量按钮都在 ── */
  const bNew = q('[data-ewb-gen-batch-new]')
  const bAll = q('[data-ewb-gen-batch-all]')
  const bDel = q('[data-ewb-gen-batch-del]')
  check('★★★ 判据 1：三颗批量按钮都在（新建 / 全选 / 删除）',
    bNew !== null && bAll !== null && bDel !== null,
    [bNew, bAll, bDel].map(b => (b === null ? '缺' : '有')).join('/'))
  check('★ 判据 1：记录栏标题上有条数', (q('[data-ewb-gen-log-total]')?.textContent ?? '') === '3',
    q('[data-ewb-gen-log-total]')?.textContent ?? '')

  /* 禁用条件照参考：一个都没勾时删除禁用；一条记录都没有时全选禁用。 */
  check('★★ 判据 1：一个都没勾时「删除」禁用（照参考 `:708`）', bDel?.disabled === true,
    'disabled=' + String(bDel?.disabled))
  check('★ 有记录时「全选」可用', bAll?.disabled === false, 'disabled=' + String(bAll?.disabled))

  /* ── 判据 3：每张记录卡有勾选框；勾几个就几个 ── */
  const checks = all('[data-ewb-gen-log-check]')
  check('★★★ 判据 3：每张记录卡都有勾选框（3 条 → 3 个）', checks.length === 3, String(checks.length))
  await click(q('[data-ewb-gen-log-check="new-all"]'))
  await act(async () => { await drain() })
  check('★★ 判据 3：勾一个之后「删除」可用了', q('[data-ewb-gen-batch-del]')?.disabled === false,
    'disabled=' + String(q('[data-ewb-gen-batch-del]')?.disabled))

  /* 全选：勾上加剩下的。 */
  await click(q('[data-ewb-gen-batch-all]'))
  await act(async () => { await drain() })
  const checkedCount = all('[data-ewb-gen-log-check]').filter(c => c.checked).length
  check('★★★ 判据 1：点「全选」→ 三条都勾上', checkedCount === 3, String(checkedCount))
  check('★ 全勾之后按钮文字变成「取消」（照参考 `:706`）',
    (q('[data-ewb-gen-batch-all]')?.textContent ?? '') === '取消',
    q('[data-ewb-gen-batch-all]')?.textContent ?? '')

  /* ── 判据 4：五个标签 ── */
  const cardAll = q('[data-ewb-gen-log="new-all"]')
  check('★★★ 判据 4：全成那条显示「成功 3」',
    (cardAll?.querySelector('[data-ewb-gen-tag-ok]')?.textContent ?? '').includes('3'),
    cardAll?.querySelector('[data-ewb-gen-tag-ok]')?.textContent ?? '')
  check('★★ 判据 4：「失败 0」也在（有 usage 时 0 是算得出的真实值）',
    (cardAll?.querySelector('[data-ewb-gen-tag-fail]')?.textContent ?? '').includes('0'),
    cardAll?.querySelector('[data-ewb-gen-tag-fail]')?.textContent ?? '（没有失败标签）')
  check('★★ 判据 4：显示「共 3 张」',
    (cardAll?.querySelector('[data-ewb-gen-tag-total]')?.textContent ?? '').includes('3'),
    cardAll?.querySelector('[data-ewb-gen-tag-total]')?.textContent ?? '')
  check('★★ 判据 4：显示了用时（绿系那个标签存在）',
    cardAll?.querySelector('[data-ewb-gen-tag-elapsed]') !== null)
  check('★★ 判据 4：显示了时间', cardAll?.querySelector('[data-ewb-gen-tag-time]') !== null)

  /* 部分成：成功 1、失败 4。 */
  const cardPart = q('[data-ewb-gen-log="new-part"]')
  check('★★★ 判据 4：部分成那条 → 成功 1 / 失败 4',
    (cardPart?.querySelector('[data-ewb-gen-tag-ok]')?.textContent ?? '').includes('1')
    && (cardPart?.querySelector('[data-ewb-gen-tag-fail]')?.textContent ?? '').includes('4'),
    (cardPart?.querySelector('[data-ewb-gen-tag-ok]')?.textContent ?? '') + ' / '
      + (cardPart?.querySelector('[data-ewb-gen-tag-fail]')?.textContent ?? ''))

  /* ══ 落差 C 的反面断言（lead 点名要的那条）══
   *
   * 老记录没有 `usage.images` → **算不出失败数** → 那个标签整个不渲染。
   * 判据是「卡上不出现『失败』两字」，不是「标签值是 0」。 */
  const cardOld = q('[data-ewb-gen-log="old-one"]')
  const oldText = cardOld?.textContent ?? ''
  check('★★★ 落差 C：老记录（无 usage）的卡上**不出现「失败」两字**',
    !oldText.includes('失败'), oldText.slice(0, 80))
  check('★★★ 落差 C：老记录也没有失败标签那个元素（整块不渲染，不是显示 0）',
    cardOld?.querySelector('[data-ewb-gen-tag-fail]') === null)
  check('★ 落差 C 的对照：老记录仍然显示「成功 1」（能算的那半照常）',
    (cardOld?.querySelector('[data-ewb-gen-tag-ok]')?.textContent ?? '').includes('1'),
    cardOld?.querySelector('[data-ewb-gen-tag-ok]')?.textContent ?? '')

  /* ── 落差 E：整卡点击回填 + 明细入口分家（两条都要有）── */
  const pickBtn = q('[data-ewb-gen-log-pick="new-part"]')
  check('★★★ 落差 E：有「点卡片回填」的点击层', pickBtn !== null)
  await setValue(q('[data-ewb-gen-submit-prompt]'), '先写点别的')
  await click(pickBtn)
  await act(async () => { await drain() })
  check('★★★ 落差 E：点卡片主体之后，表单里的提示词**变成那条记录的**',
    (q('[data-ewb-gen-submit-prompt]')?.value ?? '') === '新的部分成那条',
    q('[data-ewb-gen-submit-prompt]')?.value ?? '')

  const detailBtn = q('[data-ewb-gen-log-detail="new-part"]')
  check('★★★ 落差 E：展开明细的入口**还在**（与整卡回填分家）', detailBtn !== null)
  check('★ 落差 E 的前提：点明细之前没有明细块',
    q('[data-ewb-gen-log-open="new-part"]') === null)
  await click(detailBtn)
  await act(async () => { await drain() })
  const openBox = q('[data-ewb-gen-log-open="new-part"]')
  check('★★★ 落差 E：点明细入口 → 明细有内容（不是空块）',
    openBox !== null && (openBox.textContent ?? '').length > 5,
    (openBox?.textContent ?? '').slice(0, 60))
  /* 反面：点明细**不该**顺手把表单也换掉（两个动作必须分开）。 */
  check('★★ 落差 E 反面：点明细入口**不会**改写表单里的提示词',
    (q('[data-ewb-gen-submit-prompt]')?.value ?? '') === '新的部分成那条',
    q('[data-ewb-gen-submit-prompt]')?.value ?? '')

  /* ── 判据 1：新建清空 ── */
  await click(q('[data-ewb-gen-batch-new]'))
  await act(async () => { await drain() })
  check('★★★ 判据 1：「新建」清空了提示词', (q('[data-ewb-gen-submit-prompt]')?.value ?? '') === '',
    JSON.stringify(q('[data-ewb-gen-submit-prompt]')?.value ?? ''))
  check('★★ 判据 1：「新建」也清掉了勾选（三个勾选框都回到未选）',
    all('[data-ewb-gen-log-check]').filter(c => c.checked).length === 0)

  /* ── 判据 1 + 2：删除要二次确认，确认后真发 DELETE ── */
  await click(q('[data-ewb-gen-log-check="old-one"]'))
  await act(async () => { await drain() })
  await click(q('[data-ewb-gen-batch-del]'))
  await act(async () => { await drain() })
  const ask = q('[data-ewb-gen-del-ask]')
  check('★★★ 判据 1：点「删除」先弹确认框（不是直接删）', ask !== null)
  check('★★ 判据 1：确认框里说清了删几条', (ask?.textContent ?? '').includes('1'),
    ask?.textContent ?? '')
  /* 此刻还没发过任何 DELETE —— 「先问再删」的直接证据。 */
  check('★★★ 判据 1：确认之前**一个 DELETE 都没发**',
    sent.filter(x => x.startsWith('DELETE')).length === 0,
    sent.filter(x => x.startsWith('DELETE')).join(' / ') || '（零）')

  /* 点确认。
   *
   * ## 为什么改用 `data-*` 钩子，不锚 `.ant-modal`
   *
   * 第一版写的是 `b.closest('.ant-modal') !== null` —— 两个问题：
   *   ① `closest()` **只往祖先找、不匹配自身**，而 `.ant-modal` 是外层 wrap，
   *      确认按钮在 `.ant-modal-content > .ant-modal-footer` 里，层级未必如设想
   *   ② 更根本的：`.ant-modal` 是**第三方生成的类名**。锚它与锚 dsh 的哈希类名
   *      是同一个病 —— 对方一升级就断，而且断得没声音（lead 2026-10-28 点的）
   *
   * 正确做法：组件那边给 `okButtonProps` 塞一个 `data-ewb-gen-del-ok`，
   * 这里直接 `querySelector`。这与本仓库一贯的 `data-ewb-*` 钩子一致。 */
  const okBtn = q('[data-ewb-gen-del-ok]')
  console.log('   确认框的确定按钮:', okBtn === null ? '（没找到）' : '找到了')
  check('★ 找得到确认框里那颗「删除」（按 data 钩子，不靠 .ant-modal）', okBtn !== null)
  await click(okBtn)
  await act(async () => { await drain() })
  const delSent = sent.filter(x => x.startsWith('DELETE'))
  check('★★★ 判据 2：确认之后真发了删记录（DELETE /gen-logs/:id）',
    delSent.some(x => x.includes('/gen-logs/old-one')), delSent.join(' / '))
  check('★★★ 判据 2：同时删掉了那条记录的**产物**（DELETE /artifact/:id）',
    delSent.some(x => x.includes('/artifact/art-5')), delSent.join(' / '))

  /* ── 判据 5 + 7：结果卡三颗按钮 + 元信息行 ── */
  const actions = q('[data-ewb-gen-actions="art-1"]')
  check('★★★ 判据 5：生图的结果卡上有三颗按钮',
    actions !== null && actions.querySelectorAll('button').length === 3,
    String(actions?.querySelectorAll('button').length ?? '（没有按钮组）'))
  check('★★ 判据 5：三颗分别是加入素材 / 加为参考图 / 下载',
    q('[data-ewb-gen-add-material="art-1"]') !== null
    && q('[data-ewb-gen-add-ref="art-1"]') !== null
    && q('[data-ewb-gen-download="art-1"]') !== null)
  const meta = q('[data-ewb-gen-artmeta="art-1"]')?.textContent ?? ''
  check('★★★ 判据 7：结果卡下方显示尺寸与体积',
    meta.includes('1024×1024') && meta.includes('196 KB'), meta)

  /* 判据 6：「加为参考图」之后**真的出现在参考图列表里**（比 id 不比个数）。
   *
   * 产物地址 `/artifact/art-1` 在这里还没有桩 —— 先把 fetch 补上，
   * 让它回一份真 PNG 的字节（1×1 透明图足够，验的是「读到了、加进去了」）。 */
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const before6 = iw.EMPTY_DRAFT.refs.length
  void before6
  await act(async () => {
    globalThis.fetch = window.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('/artifact/art-1')) {
        const bin = atob(PNG_1PX)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
        return {
          ok: true, status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => bytes.buffer,
          json: async () => ({}),
        }
      }
      return realFetch44(url, init)
    }
  })
  const refsBefore = all('[data-ewb-gen-ref-item]').length
  await click(q('[data-ewb-gen-add-ref="art-1"]'))
  await act(async () => { await drain() })
  await settle(120)
  const refsAfter = all('[data-ewb-gen-ref-item]')
  check('★★★ 判据 6：「加为参考图」之后参考图**多了一张**',
    refsAfter.length === refsBefore + 1, refsBefore + ' → ' + String(refsAfter.length))
  /* 比 id 不比个数：新出现的那一张的 id 里带着产物 id（我们拼的时候带上了）。 */
  const newId = refsAfter.map(e => e.getAttribute('data-ewb-gen-ref-item'))
    .find(id => id !== null && id.includes('art-1'))
  check('★★★ 判据 6：新那张的 id 里带着产物 id（比 id，不是数个数）',
    newId !== undefined, refsAfter.map(e => e.getAttribute('data-ewb-gen-ref-item')).join(' / '))

  /* ── 判据 8：查看素材入口 + 面板 ── */
  const assetBtn = q('[data-ewb-gen-pick-asset]')
  check('★★★ 判据 8：提示词标题行有「查看素材」按钮', assetBtn !== null)
  check('★ 判据 8：按钮文字用「素材」不是「资产」（与后端路由一致）',
    (assetBtn?.textContent ?? '').includes('素材') && !(assetBtn?.textContent ?? '').includes('资产'),
    assetBtn?.textContent ?? '')

  m.unmount()
  globalThis.fetch = window.fetch = realFetch44
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log(failed === 0 ? '结论：三个工作台真能提交 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
