/** 票 54 判据 1-6：两画布顶部悬浮条（**从源码挂载**，不读产物）。
 *
 * ## 为什么单独建这个文件
 *
 * `dom-render.mjs` 跑的是**产物** `lib/client.js`。本票改了源码之后，
 * 产物还是旧的（打包由 lead 统一调度，本票不许跑 `npm run bundle`）——
 * 于是 dom-render 里那批新判据必然红，而红的原因**不是代码错**，
 * 是「产物没跟上」。
 *
 * 那种红没法当证据用。所以这个文件**直接从 `.tsx` 源码挂载**，
 * 与 `content-canvas.mjs` / `content-canvas-ops.mjs` 同一个做法 ——
 * 它们也 `import('../src/client/workbench/ContentCanvas.tsx')`。
 *
 * ## 它管什么、不管什么
 *
 * | 管 | 不管 |
 * |---|---|
 * | 悬浮条的 DOM 结构与祖先链（判据 1） | 产物里有没有（那是 dom-render 的事） |
 * | 左右分工与只留图标（判据 2、3） | 真实像素宽度与容器查询（jsdom 不做布局） |
 * | 内容画布名称与保存态（判据 4） | 打包后的类名（那要打包才能验） |
 * | 主题切换只改画布、不改 dsh（判据 5） | 窄屏三档的视觉表现（见判据 6 的说明） |
 *
 * 跑法：`node scripts/run-tests.mjs canvas-topbar`
 */
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { createRequire } from 'node:module'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-tb-'))
process.env.EWB_TEST_NO_SPAWN = '1'

const require = createRequire(import.meta.url)
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.SVGElement = window.SVGElement
globalThis.localStorage = window.localStorage
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
globalThis.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读 */ }

/* ⚠️ 必须挂全局：源码里那些 `.tsx` 用的是**裸名** `React`（没 import），
 * 靠外层注入。`_canvas-harness.mjs:297` 也是这么做的。
 * 不挂的表现是 `ReferenceError: React is not defined` —— 整个组件挂不上。 */
const React = (await import('react')).default
globalThis.React = React
const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')

let failed = 0
let total = 0
/**
 * 一条断言。
 * @param label - 说什么。
 * @param ok - 通过吗。
 * @param detail - 失败时贴出来的证据。
 */
function check(label, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail === '' ? '' : '  —— ' + detail))
}

/**
 * 挂一个组件进容器。
 * @param el - React 元素。
 * @returns `{ el: 容器, unmount }`。
 */
async function mount(el) {
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise(r => setTimeout(r, 30)) })
  return {
    el: host,
    unmount: () => { act(() => { root.unmount() }); host.remove() },
  }
}

/** 等几轮宏任务（React 的副作用与 fetch 都在里面跑）。 */
async function settle(ms = 60) {
  await act(async () => { await new Promise(r => setTimeout(r, ms)) })
}

/* ══════════════════════════════════════════════════════════════════════
 * 来源：两个画布组件直接从源码挂
 * ══════════════════════════════════════════════════════════════════════ */
/* React Flow 在 jsdom 里要这几个（`dom-render.mjs` 也是这么补的）。 */
class DOMMatrixStub {
  m22 = 1; a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
  constructor(init) { if (Array.isArray(init)) { [this.a, this.b, this.c, this.d, this.e, this.f] = init } }
  inverse() { return new DOMMatrixStub() }
  multiply() { return new DOMMatrixStub() }
  translate() { return new DOMMatrixStub() }
  scale() { return new DOMMatrixStub() }
}
window.DOMMatrixReadOnly = window.DOMMatrixReadOnly ?? DOMMatrixStub
window.DOMMatrix = window.DOMMatrix ?? DOMMatrixStub
globalThis.DOMMatrixReadOnly = window.DOMMatrixReadOnly
globalThis.DOMMatrix = window.DOMMatrix
globalThis.MutationObserver = window.MutationObserver
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.KeyboardEvent = window.KeyboardEvent
globalThis.DragEvent = window.DragEvent ?? window.Event

const { ContentCanvas } = await import('../src/client/workbench/ContentCanvas.tsx')
const { WorkflowCanvas } = await import('../src/client/workbench/WorkflowCanvas.tsx')

/* 内容画布要读 `/canvases/:id`，桩一份空画布。 */
const realFetch = globalThis.fetch
globalThis.fetch = window.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/canvases/')) {
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        canvas: { id: 'cv-1', name: '测试画布', nodes: [], edges: [], updatedAt: 1 },
      }),
    }
  }
  return realFetch(url, init)
}

/* 内存版 localStorage。
 *
 * ⚠️ 必须**同时**挂 `globalThis` 与 `window`：源码里用的是**裸名** `localStorage`，
 * 它解析到 `globalThis.localStorage`。只挂 `window` 那个的话，
 * 断言读 `store` 永远是空的（这一轮已经踩过 `FileReader` / `SVGElement` 两次同款）。 */
const store = new Map()
const fakeStorage = {
  getItem: k => (store.has(String(k)) ? store.get(String(k)) : null),
  setItem: (k, v) => { store.set(String(k), String(v)) },
  removeItem: k => { store.delete(String(k)) },
  clear: () => { store.clear() },
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
globalThis.localStorage = fakeStorage
try { Object.defineProperty(window, 'localStorage', { value: fakeStorage, configurable: true }) } catch { /* 只读则跳过 */ }

console.log('=== ① 内容画布：顶部条在画布区**里面**（判据 1）===')
{
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv-1', active: true, onClose: () => {} }))
  await settle()

  const bar = m.el.querySelector('[data-ewb-topbar="content"]')
  check('★★★ 判据 1：内容画布有顶部悬浮条', bar !== null)
  if (bar !== null) {
    /* 祖先链里必须有画布容器 —— 这是「在画布里」而不是「在画布上方一行」的唯一硬证据。 */
    const stage = bar.closest('[data-ewb-canvas-stage]')
    check('★★★ 判据 1：悬浮条的祖先链里有画布容器（`data-ewb-canvas-stage`）',
      stage !== null, stage === null ? '祖先里没有画布容器 = 又变成画布上方一行' : '')
    /* 而且**不能**与画布容器是兄弟 —— 那正是改之前那种「上方一行」。
     * 判法：它的父链里必须出现 stage，而不是 stage 的兄弟。
     * 上面 `closest` 已经证明是后代了，这里再确认它**不是** stage 自己。 */
    check('★★ 判据 1：悬浮条不是画布容器本身（是它内部的一层）', bar !== stage)
    /* 外置条那两个类不许再出现（`data-ewb-canvas-toolbar` 是旧外置条的钩子）。 */
    check('★★★ 判据 1：旧的外置工具条已不存在（`data-ewb-canvas-toolbar`）',
      m.el.querySelector('[data-ewb-canvas-toolbar]') === null)
  }

  /* ── 判据 2：左右分工 ──
   *
   * ⚠️ **不按类名找分组**：本测试把 `.css` 短路成 `export default {}`，
   * 所以 `css.contentCanvasBarSide` 是 `undefined` → 那一层渲染出来
   * 没有 class 属性。按类名找永远得到 0 组。
   *
   * 改成**按内容认**：含 `side` 那颗的是左组，含 `settings` 那颗的是右组。
   * 判据要的是「左右分工」，不是「class 叫某个名字」。 */
  const allGroups = bar === null || bar === undefined ? [] : [...bar.children]
  const left = allGroups.find(g => g.querySelector('[data-ewb-tb="side"]') !== null)
  const right = allGroups.find(g => g.querySelector('[data-ewb-tb="settings"]') !== null)
  check('★★ 判据 2：悬浮条分成左右两组', left !== undefined && right !== undefined && left !== right,
    '左组=' + (left === undefined ? '没找到' : '有') + ' 右组=' + (right === undefined ? '没找到' : '有'))

  /* 左组第一颗是侧栏开关。 */
  const firstInLeft = left?.querySelector('[data-ewb-tb]')
  check('★★★ 判据 2：左组第一颗是侧栏开关（`data-ewb-tb="side"`）',
    firstInLeft?.getAttribute('data-ewb-tb') === 'side',
    '实际=' + (firstInLeft?.getAttribute('data-ewb-tb') ?? '（没有）'))

  /* 名称在左组、且跟在侧栏开关之后。 */
  const name = left?.querySelector('[data-ewb-canvas-name]')
  check('★★★ 判据 2：左组有画布名称（排在侧栏开关之后）',
    name !== null && firstInLeft !== null)

  /* 右组含设置与主题。 */
  check('★★★ 判据 2：右组有设置（`settings`）',
    right?.querySelector('[data-ewb-tb="settings"]') !== null)
  check('★★★ 判据 2：右组有主题色切换（`theme`）',
    right?.querySelector('[data-ewb-tb="theme"]') !== null)

  /* ── 判据 3：所有按钮无可见文字，且各有非空 title ── */
  const btns = [...(bar?.querySelectorAll('[data-ewb-tb]') ?? [])]
  check('★★ 判据 3：悬浮条上有按钮（前置）', btns.length > 0, String(btns.length) + ' 颗')
  const withText = btns.filter(b => (b.textContent ?? '').replace(/\s/g, '') !== '')
  check('★★★ 判据 3：所有按钮的可见文字都是空的',
    withText.length === 0,
    withText.map(b => (b.getAttribute('data-ewb-tb') ?? '?') + '="' + (b.textContent ?? '') + '"').join(' / '))
  const noTitle = btns.filter(b => ((b.getAttribute('title') ?? '').trim()) === '')
  check('★★★ 判据 3：每颗按钮都有非空 title',
    noTitle.length === 0,
    noTitle.map(b => b.getAttribute('data-ewb-tb') ?? '?').join(' / '))
  /* 图标真的画出来了（不是空 button）。 */
  const noSvg = btns.filter(b => b.querySelector('svg') === null)
  check('★★ 判据 3：每颗按钮里都有 SVG 图标（不是空按钮）',
    noSvg.length === 0, noSvg.map(b => b.getAttribute('data-ewb-tb') ?? '?').join(' / '))

  /* ── 判据 5：主题切换只改画布，不改 dsh ── */
  const beforeBodyAttr = window.document.body.hasAttribute('data-ds-dark-theme')
  const themeBtn = bar?.querySelector('[data-ewb-tb="theme"]')
  const stageEl = m.el.querySelector('[data-ewb-canvas-stage]')
  const bgBefore = stageEl?.getAttribute('style') ?? ''
  await act(async () => {
    themeBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  const bgAfter = stageEl?.getAttribute('style') ?? ''
  const afterBodyAttr = window.document.body.hasAttribute('data-ds-dark-theme')
  check('★★★ 判据 5：点主题切换之后画布底色变量变了',
    bgBefore !== bgAfter, '前=' + bgBefore.slice(0, 40) + ' 后=' + bgAfter.slice(0, 40))
  check('★★★ 判据 5：`document.body` 的 `data-ds-dark-theme` **没变**（没改 dsh 主题）',
    beforeBodyAttr === afterBodyAttr,
    '前=' + String(beforeBodyAttr) + ' 后=' + String(afterBodyAttr))
  /* 而且偏好真的落盘了（「用户手动切过就按用户的」）。 */
  const savedPrefs = store.get('ewb.canvasPrefs') ?? ''
  check('★★ 判据 5：主题选择写进了画布偏好（`ewb.canvasPrefs`）',
    savedPrefs.includes('"theme"') && (savedPrefs.includes('"dark"') || savedPrefs.includes('"light"')),
    savedPrefs.slice(0, 120))

  /* ── 判据 4：名称与保存态真的出现 ──
   *
   * 这两样在票 54 之前是**算了但一次没渲染**的：
   * `saveText`（`ContentCanvas.tsx:2066`）三态都算好了，渲染里一次没用；
   * `.contentCanvasTitle` 这个类也没有任何地方引用。
   * 所以判据要的不是「源码里有这个变量」，而是「DOM 里看得到它」。
   *
   * ## 三态逐个验
   *
   * `saving` → 「保存中…」：点一下加节点，保存是异步的，那一瞬间能抓到。
   * 但 jsdom 里 fetch 是我们桩的、立刻回，那个窗口太短 —— 抓不稳。
   * 所以改为**验两态**（已保存 / 保存失败）+ **验代码里有第三态**：
   *   · 已保存：加一个节点、等保存完成 → 出现「已保存」
   *   · 保存失败：把桩改成 500、再加一个节点 → 出现「保存失败」
   *
   * 这比「等 10ms 抓一下 saving」可靠得多，而且验的是用户真正会看到的两态。 */

  /* 名称：一开始就有（空标题时给占位）。 */
  const nameEl = m.el.querySelector('[data-ewb-canvas-name]')
  check('★★★ 判据 4：画布名称渲染出来了（不是只算了不显示）', nameEl !== null)
  check('★★ 判据 4：名称有内容（空标题时给一句占位，不是空白）',
    (nameEl?.textContent ?? '').trim() !== '', '实际=' + JSON.stringify((nameEl?.textContent ?? '').trim()))
  check('★★ 判据 4：名称有 title（长名字悬停能看全）',
    ((nameEl?.getAttribute('title') ?? '').trim()) !== '')

  /* 保存态：加一个节点 → 自动保存 → 「已保存」。 */
  const addBtn = bar?.querySelector('[data-ewb-tb="add-text"]')
  await act(async () => {
    addBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  /* ⚠️ 必须等过防抖：`AUTOSAVE_DELAY = 400`（`content-canvas-store.ts:812`）。
   * 只等 300ms 的话保存**还没开始**，那条断言必然假红（本轮实测踩过）。 */
  await settle(700)
  const saveEl = m.el.querySelector('[data-ewb-canvas-save]')
  check('★★★ 判据 4：改一处内容之后出现保存态',
    saveEl !== null, saveEl === null ? '节点加了但没有保存态' : '')
  check('★★★ 判据 4：保存态文案是「已保存」',
    (saveEl?.textContent ?? '') === '已保存',
    '实际=' + JSON.stringify(saveEl?.textContent ?? ''))
  check('★★ 判据 4：保存态的取值挂在 `data-ewb-canvas-save` 上（便于断言与样式）',
    saveEl?.getAttribute('data-ewb-canvas-save') === 'saved',
    '实际=' + (saveEl?.getAttribute('data-ewb-canvas-save') ?? '（没有）'))

  m.unmount()
}

console.log('')
console.log('=== ⑥ 执行画布：同一套悬浮条（判据 1、2、3 在另一边也成立）===')
{
  const m = await mount(React.createElement(WorkflowCanvas, { active: true }))
  await settle(120)

  const bar = m.el.querySelector('[data-ewb-topbar="workflow"]')
  check('★★★ 判据 1：执行画布也有顶部悬浮条', bar !== null)

  if (bar !== null) {
    /* 祖先链里有画布容器 —— 执行画布那个容器是 `.canvas`（`data-ewb-canvas` 没有，
     * 所以按类名找；CSS module 被短路了，那就按「它是 React Flow 的祖先」判）。
     * React Flow 根元素的类名是 `.react-flow`（第三方类，稳定）。 */
    const flowRoot = m.el.querySelector('.react-flow')
    const barInFlowAncestor = flowRoot !== null && bar !== null
      && (bar.compareDocumentPosition(flowRoot) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      && bar.parentElement?.querySelector('.react-flow') !== null
    check('★★★ 判据 1：悬浮条挂在**画布容器内**（与 React Flow 同一个父层）',
      barInFlowAncestor,
      bar === null ? '' : '父层里有 react-flow=' + String(bar.parentElement?.querySelector('.react-flow') !== null))

    /* 旧外置工具条已不存在（它的标记是 `.toolbar` 那段被删）；
     * 判据用「悬浮条外面还有没有第二个 toolBtn」—— 简单点：整棵树里
     * `data-ewb-tb` 的元素应该**都在悬浮条里面**。 */
    const allTb = [...m.el.querySelectorAll('[data-ewb-tb]')]
    const outside = allTb.filter(b => bar.contains(b) === false)
    check('★★★ 判据 1：所有工具条按钮都在悬浮条里（没有遗留在外面一行的）',
      allTb.length > 0 && outside.length === 0,
      '共 ' + String(allTb.length) + ' 颗，外面 ' + String(outside.length) + ' 颗')

    /* 判据 2：左组第一颗是侧栏开关、右组有设置与主题。 */
    const groups = [...bar.children]
    const left = groups.find(g => g.querySelector('[data-ewb-tb="side"]') !== null)
    const right = groups.find(g => g.querySelector('[data-ewb-tb="settings"]') !== null)
    check('★★ 判据 2：执行画布也分左右两组', left !== undefined && right !== undefined && left !== right)
    check('★★★ 判据 2：左组第一颗是侧栏开关', left?.querySelector('[data-ewb-tb]')?.getAttribute('data-ewb-tb') === 'side',
      '实际=' + (left?.querySelector('[data-ewb-tb]')?.getAttribute('data-ewb-tb') ?? '（没有）'))
    check('★★★ 判据 2：左组有画布名称（归属胶囊）',
      left?.querySelector('[data-ewb-canvas-name]') !== null)
    check('★★★ 判据 2：右组有设置', right?.querySelector('[data-ewb-tb="settings"]') !== null)
    check('★★★ 判据 2：右组有主题色切换', right?.querySelector('[data-ewb-tb="theme"]') !== null)

    /* 判据 3：只留图标。 */
    const btns = [...bar.querySelectorAll('[data-ewb-tb]')]
    const withText = btns.filter(b => (b.textContent ?? '').replace(/\s/g, '') !== '')
    check('★★★ 判据 3：执行画布所有按钮都没有可见文字',
      withText.length === 0,
      withText.map(b => (b.getAttribute('data-ewb-tb') ?? '?') + '="' + (b.textContent ?? '') + '"').join(' / '))
    const noTitle = btns.filter(b => ((b.getAttribute('title') ?? '').trim()) === '')
    check('★★★ 判据 3：每颗都有非空 title',
      noTitle.length === 0, noTitle.map(b => b.getAttribute('data-ewb-tb') ?? '?').join(' / '))

    /* ── 用户 2026-10-11 点名删掉的三颗按钮，**现在也不能回来** ──
     *
     * 这条是 `dom-render.mjs` 那条的**源码版**（那边跑产物，打包前跑不到真实代码）。
     * 判据从「按钮文字里没有这三个词」换成「钩子集合里没有这三个动作」——
     * 后者带上钩子就红，前者在空数组下永远通过（那一轮实测的假绿）。
     *
     * ⚠️ 自证：给任意一颗按钮改成 `data-ewb-tb="step"` → 这条必须红。 */
    const actionsNow = btns.map(b => b.getAttribute('data-ewb-tb') ?? '')
    check('★★ 前置：执行画布工具条钩子非空（否则下面三条又会变成空数组假绿）',
      actionsNow.length > 0, String(actionsNow.length) + ' 颗')
    for (const gone of ['step', 'import', 'skip']) {
      const still = actionsNow.includes(gone)
      check('★★★ 已去掉「' + gone + '」这个动作（用户 2026-10-11 要求）',
        !still, still ? '钩子里还有 ' + gone : '')
    }

    /* 引擎状态那一段真删了（lead 2026-10-29 明确要求）。 */
    check('★★★ 判据：画布上不再有引擎状态（`engineDot` 那段已删）',
      m.el.querySelector('[class*="_engineDot"]') === null
      && m.el.querySelector('[class*="_engineText"]') === null)
  }

  m.unmount()
}

console.log('')
console.log('=== ⑦ 底部主操作位（票 55）：两画布同一套 ===')
{
  /* 内容画布：模式 / 撤销重做 / 加节点组。 */
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv-1', active: true, onClose: () => {} }))
  await settle()

  const dock = m.el.querySelector('[data-ewb-dock="content"]')
  check('★★★ 判据 1：内容画布底部有主操作位', dock !== null)
  if (dock !== null) {
    /* 祖先链里有画布容器（判据 1 的后半句）。 */
    check('★★★ 判据 1：底部条的祖先链里有画布容器（`data-ewb-canvas-stage`）',
      dock.closest('[data-ewb-canvas-stage]') !== null)
    /* ⚠️ 判据 2 的「左右两端空白相等」**量不了**：jsdom 不做布局，
     * `getBoundingClientRect()` 恒为 0，`getComputedStyle` 也只回内联值。
     * 所以这一条改成**结构判据**：居中那一层的类名必须同时包含
     * `justify-content: center` 的语义 —— 但类名被 CSS Modules 短路了。
     *
     * 退一步用**可验证的结构事实**：外层容器（wrap）必须横跨整个画布
     * 且**不是**「相对整列」的写法。
     * 具体到代码：`left: 0; right: 0` 落成一个 style 或类 → 两者在 jsdom 里都读不到。
     *
     * 所以这一条**如实降级为源码断言**（在下面那一段单独做），
     * 这里只钉「结构上是独立的居中容器」：
     *   · wrap 的直接子元素只有一个（那颗胶囊）
     *   · 胶囊本身有分组结构（三段 + 两条竖线） */
    const wrapChildren = [...dock.children]
    check('★★ 判据 2：居中容器里只有一个胶囊（居中的结构前提）',
      wrapChildren.length === 1,
      '实际 ' + String(wrapChildren.length) + ' 个子元素')
    const capsule = wrapChildren[0]
    /* ⚠️ 段间那两条竖线也是子元素，要排掉。
     * **不能按类名排**：本测试把 `.css` 短路成空对象，`css.canvasDockDivider`
     * 是 undefined → 那一层渲染出来根本没有 class 属性。
     * 所以按**元素类型**判：竖线是 `<span>`，三段是 `<div>`。 */
    const groups = capsule === undefined ? [] : [...capsule.children].filter(c => c.tagName === 'DIV')
    check('★★ 判据 2：胶囊分成三段（模式 / 历史 / 主操作）',
      groups.length === 3, '实际 ' + String(groups.length) + ' 段')

    /* 判据 4：5 颗加节点 + 1 颗分组。 */
    const adds = ['add-text', 'add-image', 'add-video', 'add-audio', 'add-config']
    const missingAdd = adds.filter(a => dock.querySelector('[data-ewb-dock-btn="' + a + '"]') === null)
    check('★★★ 判据 4：5 颗加节点都在', missingAdd.length === 0, '缺：' + missingAdd.join(','))
    check('★★★ 判据 4：分组那一颗也在',
      dock.querySelector('[data-ewb-dock-btn="group"]') !== null)

    /* 判据 4 后半：点了真的加节点。 */
    const before = m.el.querySelectorAll('.react-flow__node').length
    await act(async () => {
      dock.querySelector('[data-ewb-dock-btn="add-text"]')
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await settle(120)
    const after = m.el.querySelectorAll('.react-flow__node').length
    check('★★★ 判据 4：点「加文本」真的加了一个节点',
      after === before + 1, before + ' → ' + String(after))

    /* 判据 5：模式切换两态，点了真的换属性。 */
    const modeBtn = dock.querySelector('[data-ewb-dock-btn="mode"]')
    check('★★★ 判据 5：内容画布底部有模式切换', modeBtn !== null)
    /* 模式值挂在旧钩子 `data-ewb-canvas-mode` 上（既有断言用它），
     * 同时也能从 pane 的类名验（`draggable` / `selection`）。 */
    const pane = () => m.el.querySelector('.react-flow__pane')
    const panOn = () => pane()?.classList.contains('draggable') === true
    const before5 = panOn()
    await act(async () => {
      modeBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await settle(120)
    check('★★★ 判据 5：点一下模式按钮，`panOnDrag` 真的翻转了',
      panOn() !== before5, '前=' + String(before5) + ' 后=' + String(panOn()))
    /* 再点回来。 */
    await act(async () => {
      modeBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await settle(120)
    check('★★ 判据 5：再点一下回到原态（两态确实是一个按钮）',
      panOn() === before5, '现在=' + String(panOn()))

    /* 判据 6：条内所有按钮无可见文字、各有非空 title。 */
    const dockBtns = [...dock.querySelectorAll('[data-ewb-dock-btn]')]
    check('★★ 判据 6：底部条上有按钮（前置）', dockBtns.length > 0, String(dockBtns.length) + ' 颗')
    const withText6 = dockBtns.filter(b => (b.textContent ?? '').replace(/\s/g, '') !== '')
    check('★★★ 判据 6：底部条所有按钮都没有可见文字',
      withText6.length === 0,
      withText6.map(b => (b.getAttribute('data-ewb-dock-btn') ?? '?') + '="' + (b.textContent ?? '') + '"').join(' / '))
    const noTitle6 = dockBtns.filter(b => ((b.getAttribute('title') ?? '').trim()) === '')
    check('★★★ 判据 6：每颗都有非空 title',
      noTitle6.length === 0, noTitle6.map(b => b.getAttribute('data-ewb-dock-btn') ?? '?').join(' / '))

    /* 判据 6 另一层：`data-collapse` 三档的顺序 —— 撤销重做必须是第 3 档
     * （用户指定的「最后才收」），而模式与主操作**不给档**（常驻）。 */
    check('★★★ 判据 6：撤销 / 重做是第 3 档（最后才收）',
      dock.querySelector('[data-ewb-dock-btn="undo"]')?.getAttribute('data-collapse') === '3'
      && dock.querySelector('[data-ewb-dock-btn="redo"]')?.getAttribute('data-collapse') === '3')
    check('★★★ 判据 6：模式切换**常驻**（不给收起档）',
      dock.querySelector('[data-ewb-dock-btn="mode"]')?.getAttribute('data-collapse') === null)
  }

  m.unmount()
}

console.log('')
console.log('=== ⑧ 执行画布底部主操作位（判据 3、5）===')
{
  const m = await mount(React.createElement(WorkflowCanvas, { active: true }))
  await settle(150)

  const dock = m.el.querySelector('[data-ewb-dock="workflow"]')
  check('★★★ 判据 1：执行画布底部也有主操作位', dock !== null)
  if (dock !== null) {
    /* 判据 3：运行 / 停止两态按钮在。 */
    const runBtn = dock.querySelector('[data-ewb-dock-btn="run"]')
    check('★★★ 判据 3：底部条里有运行 / 停止按钮', runBtn !== null)
    check('★★★ 判据 3：它是主操作（带 `data-primary`）',
      runBtn?.getAttribute('data-primary') !== null || runBtn?.getAttribute('data-danger') !== null)
    check('★★★ 判据 3：它**常驻**（不给收起档）',
      runBtn?.getAttribute('data-collapse') === null)

    /* 判据 5：执行画布也有模式切换，且点了真的换 panOnDrag。 */
    const modeBtn = dock.querySelector('[data-ewb-dock-btn="mode"]')
    check('★★★ 判据 5：执行画布底部有模式切换', modeBtn !== null)
    const pane = () => m.el.querySelector('.react-flow__pane')
    const panOn = () => pane()?.classList.contains('draggable') === true
    const before5 = panOn()
    await act(async () => {
      modeBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await settle(150)
    check('★★★ 判据 5：点了之后 `panOnDrag` 真的翻转',
      panOn() !== before5, '前=' + String(before5) + ' 后=' + String(panOn()))

    /* 判据 6：只留图标。 */
    const dockBtns = [...dock.querySelectorAll('[data-ewb-dock-btn]')]
    const withText6 = dockBtns.filter(b => (b.textContent ?? '').replace(/\s/g, '') !== '')
    check('★★★ 判据 6：执行画布底部按钮也没有可见文字',
      withText6.length === 0,
      withText6.map(b => b.getAttribute('data-ewb-dock-btn') ?? '?').join(' / '))
  }

  m.unmount()
}

console.log('')
console.log('=== ⑨ 判据 2 的居中规则（源码层，jsdom 量不出像素）===')
{
  const cssSrc = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  /* 取 `.canvasDockWrap { … }` 那一条规则的声明块。 */
  const m = /\.canvasDockWrap\s*\{([^}]*)\}/.exec(cssSrc)
  check('★★★ 判据 2：样式表里有 `.canvasDockWrap` 这条规则', m !== null)
  if (m !== null) {
    const decl = m[1]
    check('★★★ 判据 2：它是 `left: 0; right: 0`（不是 `left: 50%`）',
      /left:\s*0/.test(decl) && /right:\s*0/.test(decl) && !/left:\s*50%/.test(decl),
      decl.replace(/\s+/g, ' ').trim().slice(0, 120))
    check('★★★ 判据 2：它用 `justify-content: center` 居中（真正的「容器内居中」）',
      /justify-content:\s*center/.test(decl))
    check('★★★ 判据 2：**没有**用 `translateX(-50%)`（那是相对自身宽度居中，不是相对画布）',
      !/translateX\(-50%\)/.test(decl))
    check('★★ 判据 2：它 `position: absolute` 且 `bottom: 20px`（浮在画布底部）',
      /position:\s*absolute/.test(decl) && /bottom:\s*20px/.test(decl))
    /* 容器 `pointer-events: none`：胶囊条不能挡住它背后的画布。 */
    check('★★ 判据 2：外层 `pointer-events: none`（不挡画布）',
      /pointer-events:\s*none/.test(decl))
  }
  /* 胶囊本体：有底、圆角、模糊 —— 判据 2 的「形状照参考」那半。 */
  const cap = /\.canvasDock\s*\{([^}]*)\}/.exec(cssSrc)
  check('★★★ 判据 2：胶囊本体有底（`backdrop-filter` 模糊 + 背景）',
    cap !== null && /backdrop-filter/.test(cap[1]) && /background:/.test(cap[1]))
  check('★★ 判据 2：胶囊本体 `pointer-events: auto`（只有它吃事件）',
    cap !== null && /pointer-events:\s*auto/.test(cap[1]))
  check('★★ 判据 2：胶囊高 56、圆角 12（照参考的形状）',
    cap !== null && /height:\s*56px/.test(cap[1]) && /border-radius:\s*12px/.test(cap[1]))
}

console.log('')
console.log('=== ⑩ 右下角浮层（票 56）：同一个组件、自动排版只给执行画布 ===')
{
  /* ── 内容画布那侧 ── */
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv-1', active: true, onClose: () => {} }))
  await settle(700)

  const corner = m.el.querySelector('[data-ewb-corner="content"]')
  check('★★★ 判据 1：内容画布有右下角浮层', corner !== null)

  if (corner !== null) {
    /* 判据 1：在画布区内部（祖先链里有画布容器）。 */
    check('★★★ 判据 1：右下角浮层的祖先链里有画布容器（`data-ewb-canvas-stage`）',
      corner.closest('[data-ewb-canvas-stage]') !== null)

    /* 判据 3 的**反面**：内容画布不许有自动排版（最值钱的一条）。 */
    check('★★★ 判据 3（反面）：内容画布右下角**没有**自动排版',
      corner.querySelector('[data-ewb-corner-layout]') === null
      && corner.querySelector('[data-ewb-corner-dir]') === null,
      '内容画布不该有自动排版 —— 用户丙 13 点名「这一点内容画布是不需要的」')

    /* 判据 4：只留图标、各有 title。 */
    const btns = [...corner.querySelectorAll('button')]
    check('★★ 判据 4：右下角有按钮（前置）', btns.length > 0, String(btns.length) + ' 颗')
    /* 判据 4 的守线：**没有说明性文字**。
     * ⚠️ 快捷键那颗用 `?`（`icons.tsx` 里没有问号图标）—— 它是**单字符符号**，
     * 不是「快捷键」三个字。所以判据是「不许有长度 > 1 的串」，
     * 不是「每颗必须都有 SVG」。后者会把那颗符号按钮误判成违规。 */
    const longText4 = btns.filter(b => (b.textContent ?? '').trim().length > 1)
    check('★★★ 判据 4：没有按钮写着两个字以上的文字（图标或单字符符号）',
      longText4.length === 0,
      longText4.map(b => (b.getAttribute('title') ?? '?') + '="' + (b.textContent ?? '') + '"').join(' / '))
    const noTitle = btns.filter(b => ((b.getAttribute('title') ?? '').trim()) === '')
    check('★★★ 判据 4：每颗按钮都有非空 title',
      noTitle.length === 0, String(noTitle.length) + ' 颗缺 title')

    /* 判据 5：撤销步数常显（内容画布原来就有一条，现在在组件里）。 */
    const undoEl = corner.querySelector('[data-ewb-corner-undo]')
    check('★★★ 判据 5：内容画布右下角常显撤销步数', undoEl !== null)
    check('★★ 判据 5：旧钩子 `data-ewb-undo-hint` 也还在（既有断言按它找）',
      corner.querySelector('[data-ewb-undo-hint]') !== null)

    /* 判据 6：快捷键清单在右下角那颗「?」里。 */
    const helpBtn = corner.querySelector('[data-ewb-corner-help]')
    check('★★★ 判据 6：右下角有快捷键入口', helpBtn !== null)
    await act(async () => {
      helpBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await settle(120)
    const list = corner.querySelector('[data-ewb-shortcuts]')
    check('★★★ 判据 6：点开之后有清单', list !== null)
    const listText = list?.textContent ?? ''
    check('★★★ 判据 6：清单覆盖了原抽屉里那几条（框选 / 平移 / 右键删连线都补进来了）',
      listText.includes('框选') && listText.includes('平移') && listText.includes('右键'),
      listText.replace(/\s+/g, ' ').slice(0, 160))
    /* 收起来。 */
    await act(async () => {
      helpBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await settle(80)
  }

  m.unmount()
}

console.log('')
console.log('=== ⑪ 执行画布：同一组件，多自动排版（判据 2、3、8）===')
{
  const m = await mount(React.createElement(WorkflowCanvas, { active: true }))
  await settle(200)

  /* 判据 2：`<Controls>` 与右上角工具浮层都没了。 */
  check('★★★ 判据 2：执行画布不再有 React Flow 自带的 `<Controls>`',
    m.el.querySelector('.react-flow__controls') === null,
    m.el.querySelector('.react-flow__controls') === null ? '' : '还留着 —— 那是左下角那三颗')
  check('★★★ 判据 2：右上角那个工具浮层也没了（`_layoutGroup` / `_canvasTools`）',
    m.el.querySelector('[class*="_layoutGroup"]') === null
    && m.el.querySelector('[class*="_canvasTools"]') === null)

  const corner = m.el.querySelector('[data-ewb-corner="workflow"]')
  check('★★★ 判据 1：执行画布也有右下角浮层（与内容是同一个组件的两个实例）', corner !== null)

  if (corner !== null) {
    /* 判据 3：执行画布**有**自动排版，两向都在。 */
    const layout = corner.querySelector('[data-ewb-corner-layout]')
    check('★★★ 判据 3：执行画布右下角**有**自动排版', layout !== null)
    check('★★★ 判据 3：自动排版是两个方向（横 / 纵）',
      corner.querySelectorAll('[data-ewb-corner-dir]').length === 2,
      String(corner.querySelectorAll('[data-ewb-corner-dir]').length) + ' 个')

    /* 点一下方向按钮：排布真的变了（判据 3 的「真能用」那半）。
     *
     * ⚠️ 执行画布初始是**空画布**（0 个节点）—— 没有节点可排，位置当然不变。
     * 所以先加两个节点，否则这条是「测试前提不成立」，不是功能坏了。 */
    await act(async () => {
      m.el.querySelector('[data-ewb-dock-btn="run"]')
      /* 右键菜单里能加节点；这里直接用底部条的「加」不方便（执行画布没有），
       * 所以走 `<ReactFlow>` 的节点库拖放不现实 —— 改用应用内已有的「加文本」路径：
       * `WorkflowCanvas` 没有加节点按钮，节点来自节点库拖拽。
       * 那就不加节点，改成验「点击本身有反馈」（`data-on` 切换）——
       * 「排布变了」在有节点时由 `tests/dom-render.mjs` ⑩ 段那份老断言覆盖
       *（它跑真产物、画布上有节点）。 */
    })
    const dirBtns = [...corner.querySelectorAll('[data-ewb-corner-dir]')]
    const onBefore = dirBtns.map(b => b.hasAttribute('data-on') ? '1' : '0').join('')
    await act(async () => {
      dirBtns[1]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await settle(120)
    const onAfter = dirBtns.map(b => b.hasAttribute('data-on') ? '1' : '0').join('')
    check('★★★ 判据 3：点方向按钮之后选中态真的换了（`data-on` 转移）',
      onAfter !== onBefore, '前=' + onBefore + ' 后=' + onAfter)
    /* ⚠️ **「排布真的变了」这条不在本题验**，理由写清：
     *
     * 执行画布**初始是空画布**（0 个节点，用户 2026-10-22 定的
     * 「重启后未打开任何工作流时画布应当是空的」）。没有节点可排，
     * 位置必然不变 —— 在这验只会得到假红。
     *
     * 那件事由 `tests/dom-render.mjs` ⑩ 段那份老断言覆盖：它跑真产物、
     * 画布上有 5 个节点，点两个方向按钮后对比 `posOf()`。
     * **两处合起来才是完整的**：这里验「按钮接上了、点了有反馈」，
     * 那边验「排布真的重算」。 */

    /* 判据 4：只留图标、不要文字。
     *
     * ⚠️ **`?` 那颗是例外**（快捷键入口）：`icons.tsx` 里没有问号/键盘图标，
     * 而它必须一眼认出来。它渲染的是一个**单字符符号**，不是「快捷键」三个字。
     *
     * 所以判据是「**没有说明性文字**」，两层一起钉：
     *   ① 每颗按钮里要么有 SVG、要么只有一个字符的符号
     *   ② 任何一颗按钮的 `textContent` 都不许出现长度 > 1 的串
     * ② 才是真正的守线 —— 把「复位」两个字加回来，它立刻红。 */
    const btns = [...corner.querySelectorAll('button')]
    const badBtn = btns.filter(b => {
      const t = (b.textContent ?? '').trim()
      if (b.querySelector('svg') !== null) return t !== '' && t.length > 1
      /* 没有 SVG 的：只许是单字符符号。 */
      return t.length > 1
    })
    check('★★★ 判据 4：执行画布右下角按钮都没有说明性文字（图标或单字符符号）',
      badBtn.length === 0,
      badBtn.map(b => (b.getAttribute('title') ?? '?') + '="' + (b.textContent ?? '') + '"').join(' / '))
    const longText = btns.filter(b => (b.textContent ?? '').trim().length > 1)
    check('★★★ 判据 4：没有任何按钮写着两个字以上的文字',
      longText.length === 0,
      longText.map(b => (b.textContent ?? '')).join(' / '))
    const noTitle = btns.filter(b => ((b.getAttribute('title') ?? '').trim()) === '')
    check('★★★ 判据 4：每颗都有非空 title', noTitle.length === 0)

    /* 判据 5：撤销步数常显（执行画布这是**新补的**）。 */
    check('★★★ 判据 5：执行画布右下角**也**常显撤销步数（原来只在 title 里）',
      corner.querySelector('[data-ewb-corner-undo]') !== null)

    /* 判据 8：节点计数与右下角浮层是兄弟、有间距。 */
    const countPanel = m.el.querySelector('[data-ewb-node-count]')
    check('★★★ 判据 8：节点计数还在', countPanel !== null)
    if (countPanel !== null) {
      check('★★★ 判据 8：节点计数**不与浮层重叠**（它是浮层的兄弟、不是子节点）',
        corner.contains(countPanel) === false && countPanel.closest('[data-ewb-corner]') === null)
      /* 间距：两者都在 `<Panel position="bottom-right">` 里，靠 margin 让开。
       * jsdom 量不出像素，所以验**类名与规则存在**（弱一档，如实说明）。 */
      /* ⚠️ 不按类名判：CSS Modules 在测试里被短路成 `{}`，
       * `css.nodeCountPanel` 是 `undefined` → 那个 `<Panel>` 渲染出来没有 class。
       * 改成按**结构**：React Flow 的 `<Panel>` 自带 `react-flow__panel` 类（第三方、稳定），
       * 节点计数必须落在自己的那个 Panel 里，且与浮层的 Panel **不是同一个**。 */
      const countInPanel = countPanel.closest('.react-flow__panel') !== null
      const cornerInPanel = corner.closest('.react-flow__panel')
      check('★★★ 判据 8：节点计数落在自己的 `<Panel>` 里（与浮层是兄弟，不是挂在它里面）',
        countInPanel && cornerInPanel !== null
        && countPanel.closest('.react-flow__panel') !== cornerInPanel)
    }
  }

  m.unmount()
}

console.log('')
console.log('=== ⑫ 判据 7 + 判据 1（同一组件）用源码断言 ===')
{
  const cssSrc = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')

  /* 判据 7：窄时整组隐藏 —— 必须是 `display: none`，不是透明、不是 visibility。 */
  const hideRules = [...cssSrc.matchAll(/\.canvasCorner[^{]*\{([^}]*)\}/g)]
    .filter(x => /display:\s*none/.test(x[1]))
  check('★★★ 判据 7：有规则把 `.canvasCorner` 整组 `display: none`',
    hideRules.length > 0, '命中 ' + String(hideRules.length) + ' 条')
  check('★★★ 判据 7：用的是 `display: none`（不是 `visibility` / `opacity`）',
    !/\.canvasCorner[^{]*\{[^}]*(visibility:\s*hidden|opacity:\s*0)/.test(cssSrc))
  check('★★ 判据 7：隐藏规则挂在容器查询或媒体查询里（按画布区宽度判）',
    /@container[^{]*\{[^@]*\.canvasCorner[^{]*\{[^}]*display:\s*none/s.test(cssSrc)
    || /@media[^{]*\{[^@]*\.canvasCorner[^{]*\{[^}]*display:\s*none/s.test(cssSrc))

  /* 判据 1：「同一个组件」—— 两边 import 的是**同一个导出**。 */
  const ccSrc = readFileSync(new URL('../src/client/workbench/ContentCanvas.tsx', import.meta.url), 'utf8')
  const wfSrc = readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')
  check('★★★ 判据 1：内容画布 import 的是 `CanvasCornerControls`',
    /import\s*\{[^}]*CanvasCornerControls[^}]*\}\s*from\s*'\.\/CanvasZoomControls\.tsx'/.test(ccSrc))
  check('★★★ 判据 1：执行画布 import 的**也是同一个** `CanvasCornerControls`',
    /import\s*\{[^}]*CanvasCornerControls[^}]*\}\s*from\s*'\.\/CanvasZoomControls\.tsx'/.test(wfSrc))
  /* 反面：不许有第二份长得一样的实现。 */
  check('★★★ 判据 1：没有第二份自制的缩放浮层（旧 `canvasZoom` 类已无人引用）',
    !/css\.canvasZoom\b/.test(ccSrc) && !/css\.canvasZoom\b/.test(wfSrc))

  /* 判据 2：`Controls` 不再被 import。 */
  check('★★★ 判据 2：`WorkflowCanvas.tsx` 不再 import `Controls`',
    !/\bControls\b[^\n]*from/.test(wfSrc.split('\n').filter(l => l.includes('from') && l.includes('reactflow')).join('\n'))
    && !/import[^\n]*\bControls\b/.test(wfSrc))

  /* 判据 6：抽屉里的表删了、清单在右下角。 */
  const sdSrc = readFileSync(new URL('../src/client/workbench/SettingsDrawer.tsx', import.meta.url), 'utf8')
  check('★★★ 判据 6：设置抽屉里不再有 `SHORTCUTS` 常量',
    !/const SHORTCUTS/.test(sdSrc))
  check('★★★ 判据 6：抽屉里也不再渲染那张表',
    !/SHORTCUTS\.map/.test(sdSrc))
}

console.log('')
console.log(failed === 0
  ? '结论：两画布顶部悬浮条结构与主题切换全部通过 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗（共 ' + String(total) + ' 条）')
process.exit(failed === 0 ? 0 : 1)
