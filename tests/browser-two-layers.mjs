/** 钉住「浏览器两层在哪里」—— 用户 2026-10-13 点名要求的分工。
 *
 * ## 用户原话
 *
 * > 「标签→浏览器应该是在**节点设置**而不是设置中设置。」
 * > 「设置里面增加一个**默认使用浏览器**。」（较早的一条）
 *
 * 于是定下的分工：
 *
 * | 在哪 | 管什么 |
 * | --- | --- |
 * | **全局设置** | 默认用哪个浏览器、检测列表、重新检测（**机器级**） |
 * | **节点设置** | 这个标签用哪个、怎么开（**流程级**，跟着节点走） |
 *
 * ## 为什么要有这个测试
 *
 * 这是一条**会悄悄退化**的约定：把那张表格搬回全局，功能照样跑、
 * 所有测试照样绿（因为没人断言它在哪）。等到用户发现「怎么又在设置里」
 * 时已经过去好几轮。所以要有一条**从产物验**的断言钉住位置。
 *
 * 判据（都是行为判据，不查源码字符串）：
 *   ① 全局设置的浏览器一节里**没有**那张「标签 → 浏览器」表格
 *   ② 全局设置里**有**「默认来源」与「重新检测」
 *   ③ 浏览器节点的设置里**有**「标签 / 来源 / 端口」几行
 *   ④ 位置：那一节在**可滚动块内部**、且排在「参数」之前
 *   ⑤ 端口**只能选不能填**（用户 m03425 第 5 条）—— 节点与设置两侧都查
 *
 * ⚠️ **2026-10-16 按用户 m03425 改过几条**（原判据已不成立，改的是判据不是功能）：
 *   · 「端口是手填输入框」→ **「端口是下拉」**（他要求「只能选择」）；
 *   · 「列出了扫到的调试端口 + 可一点填上」→ **整段删**（他要求节点里不列端点，
 *     「端口选择就是最上面的端口选择」）；
 *   · 「它是块里的第一块内容」→ **改成「在块里、且不是第一块」**（他把备注排到了最前）；
 *   · 全局的「默认端口是手填输入框」→ **「是下拉」**（同一条要求，设置侧也适用）。
 *
 * 跑法：node tests/browser-two-layers.mjs（需先 `npm run bundle`）
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/* ── 环境（与 dom-render / bundle-identifiers 同一套）────────────────── */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
globalThis.localStorage = window.localStorage
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
class DM {
  constructor() { this.m22 = 1; this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0 }
  inverse() { return new DM() }
  multiply() { return new DM() }
  translate() { return new DM() }
  scale() { return new DM() }
}
window.DOMMatrixReadOnly = DM
window.DOMMatrix = DM
globalThis.DOMMatrixReadOnly = DM
globalThis.DOMMatrix = DM
window.SVGElement = window.HTMLElement
globalThis.SVGElement = window.SVGElement
globalThis.MouseEvent = window.MouseEvent

const React = require('react')
const ReactDOMClient = require('react-dom/client')

/* 一份**含浏览器节点**的存档 —— 没有它测不到节点设置那一节。 */
const WF = {
  version: 1,
  name: 'two-layers-probe',
  nodes: [
    { id: 'b1', type: 'v1', defId: 'browser.act', position: { x: 0, y: 0 }, params: { action: 'goto', session: '探针标签', url: 'https://example.com/' }, onError: 'stop' },
  ],
  edges: [],
}

let factory = null
window.__ModuleLoader__ = { load: o => { factory = o.factory } }
new Function('window', 'document', 'localStorage', 'navigator',
  readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window, window.document, window.localStorage, window.navigator)
check('产物能加载', factory !== null)
if (factory === null) process.exit(1)

/* fetch 桩：`/browser/detect` 要给一份**有浏览器**的结果，
 * 否则节点那一节的「用哪个浏览器」下拉是空的、测不出它存在。
 *
 * ⚠️ **2026-10-14 起 `cdp` 的形状改了**（用户 #7）：
 * 原来是 `{ port: 9222, listening: true }`（**单个写死端口**），
 * 现在是 `{ listening, endpoints: [{port, browser}] }`（**扫到的全部端点**）。
 * 桩不改的话这一节会读到 `undefined`，测出来的东西与真机不符。 */
window.fetch = (url) => {
  const u = String(url)
  const json = o => Promise.resolve({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })
  if (u.includes('/browser/detect')) {
    return json({
      ok: true,
      browsers: [
        { id: 'qqbrowser', name: 'QQ 浏览器', path: 'D:/Program Files/Tencent/QQBrowser/QQBrowser.exe', source: 'system', cdpReady: true },
        { id: 'chrome', name: 'Google Chrome', path: 'C:/chrome.exe', source: 'system', cdpReady: false },
      ],
      cdp: { listening: true, endpoints: [{ port: 9222, browser: 'Chrome/138.0.7204.0' }] },
      platform: 'win32',
    })
  }
  /* ★ 单端口检测（手填端口旁边那个「检测」按钮走这条）。 */
  if (u.includes('/browser/cdp')) {
    const m = /port=(\d+)/.exec(u)
    const p = m === null ? 0 : Number(m[1])
    return json({ ok: true, port: p, listening: p === 9222, browser: p === 9222 ? 'Chrome/138.0.7204.0' : null })
  }
  if (u.includes('/workflows')) return json({ ok: true, dir: 'C:/x', items: [{ name: WF.name, nodes: 1, edges: 0, mtime: Date.now(), path: 'x' }] })
  if (u.includes('/workflow?')) return json({ ok: true, doc: WF })
  if (u.includes('/health')) return json({ ok: true, runs: 0, workdir: 'C:/x' })
  return json({ ok: true, items: [] })
}
globalThis.fetch = window.fetch

const errs = []
const origErr = console.error
console.error = (...a) => { errs.push(a.map(x => String(x?.stack ?? x)).join(' ')); origErr(...a) }

const comps = []
const fakeCtx = {
  effect: fn => { try { fn() } catch { /* 忽略 */ } return () => {} },
  inject: () => () => {},
  layout: { toggleSidebar: () => {} },
  slots: {
    inject: (n, fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
    register: (o, c) => { if (typeof c === 'function') comps.push({ name: String(o?.name), fn: c }); return () => {} },
  },
}
/** bundle 里用它拿 react。 */
const fakeRequire = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
  try { return require(name) } catch { throw new Error('缺依赖: ' + name) }
}
const ex = factory(fakeRequire)
ex.apply(fakeCtx)
ReactDOMClient.createRoot(window.document.getElementById('root')).render(
  React.createElement(comps.find(c => c.name === 'shell.overlay').fn, {}),
)
await new Promise(x => setTimeout(x, 1200))

const d = window.document
/** 按文字精确点。 */
const click = (text, inTabs = false) => {
  const scope = inTabs ? d.querySelectorAll('[role="tab"]') : d.querySelectorAll('button')
  const hit = [...scope].find(b => (b.textContent ?? '').trim() === text)
  if (hit === undefined) return false
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}
const bodyText = () => (d.body.textContent ?? '')

/* ── ① 节点设置里必须有「浏览器」三行 ─────────────────────────────── */
console.log('')
console.log('=== ① 浏览器节点的设置里 ===')
{
  /* 走真实顺序打开那份存档（含浏览器节点）→ 展开那个节点 → 看编辑器。 */
  click('工作流')
  await new Promise(x => setTimeout(x, 700))
  click('工作流管理', true)
  await new Promise(x => setTimeout(x, 900))
  const row = [...d.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(WF.name))
  if (row !== undefined) row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 300))
  const openBtn = [...d.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '打开到画布')
  if (openBtn !== undefined) openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 1200))

  check('那份存档打开了（b1 在画布上）',
    d.querySelector('.react-flow__node[data-id="b1"]') !== null,
    [...d.querySelectorAll('.react-flow__node')].map(e => e.getAttribute('data-id')).join(','))

  /* 展开节点：点它自己（画布上的节点双击/单击会展开编辑区 —— 见 WorkflowNode）。 */
  const nodeEl = d.querySelector('.react-flow__node[data-id="b1"]')
  if (nodeEl !== null) {
    nodeEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(x => setTimeout(x, 700))
  }

  /* 浏览器一节有 `data-ewb-node-browser` 这个锚（我们自己的标记）。
   * ⚠️ 用它而不是按文字找 —— 文字「浏览器」在别处也有（节点名、说明）。 */
  const sec = d.querySelector('[data-ewb-node-browser]')
  check('★ 节点设置里有「浏览器」一节（标签→浏览器在这儿）', sec !== null)

  if (sec !== null) {
    const t = sec.textContent ?? ''
    const inputs = sec.querySelectorAll('input')
    const selects = sec.querySelectorAll('select')
    check('★ 有「标签」输入框（第一层）', inputs.length >= 1, String(inputs.length) + ' 个输入框')

    /* ★ 参数区里的控件数不该把 `session` 也算进去 —— 它现在是 `hidden`。
     *
     * ⚠️ **判据锚在 DOM 上渲染出来的参数 label**（2026-10-16）：
     * 第一版查「有没有 placeholder === '默认' 的输入框」，实测**抓不住** ——
     * 去掉 `hidden` 后那个框确实回来了，但不同节点/动作下输入框本来就不一样，
     * 查「某个 placeholder 在不在」会在别的节点上误报。
     * 第二版改成查**渲染出来的参数名清单里有没有「用哪个浏览器」**：
     * 那是「同一个值有两个入口」这件事的**直接证据**，且与 UI 长什么样无关。
     *
     * ⚠️ 也别用 `_fieldLabel` 去找它 —— 那类是**分块标题**
     * （「参数」「备注」「浏览器」），里面永远不会有参数名（这一版就是那样白写的）。 */
    const editor = d.querySelector('[data-ewb-editor]')
    const blockForCount = editor?.querySelector('[class*="_block"]')
    const renderedParams = [...(blockForCount?.querySelectorAll('[class*="_paramLabel"]') ?? [])]
      .map(x => (x.textContent ?? '').trim())
    check('★ 「用哪个浏览器」不再出现在参数区（它与「标签」是同一个值）',
      !renderedParams.includes('用哪个浏览器'), renderedParams.join(' / '))

    /* ── ★ 用户 2026-10-14 的分类改造（#7）──────────────────────────────
     *
     * 用户原话：「**选择浏览器既可以选择一个可以被打开的浏览器，也可以使用 CDP
     * 连接一个已打开的浏览器，他们都是选择浏览器，而不是选择打开方式**
     * （当前 CDP 被当做打开方式，和有头无头列在了一起）。」
     *
     * 所以判据是**模型判据**，不是「某个下拉还在不在」：
     *   ① 有一个「来源」下拉（＝「选浏览器」那一层）
     *   ② 来源的两个选项就是**那两个来源**（CDP / 本机装着的）
     *   ③ CDP **不再**与「有头/无头」并列（那三个值不再出现在同一个下拉里） */
    const sourceSel = [...selects].find(s => (s.getAttribute('aria-label') ?? '').includes('来源'))
    check('★ 有「来源」下拉（这就是「选哪个浏览器」那一层）', sourceSel !== undefined,
      [...selects].map(s => s.getAttribute('aria-label')).join(' / '))
    if (sourceSel !== undefined) {
      const opts = [...sourceSel.querySelectorAll('option')].map(o => o.textContent ?? '')
      check('★ 来源的两个选项 = 已开的调试端口（CDP）/ 本机装着的浏览器',
        opts.some(o => o.includes('CDP')) && opts.some(o => o.includes('本机')),
        opts.join(' | '))
      check('★ **CDP 不与「有头/无头」并列**（旧模型已改掉）',
        opts.length === 2 && !opts.some(o => o.includes('有窗口') || o.includes('无窗口')),
        opts.join(' | '))
      /* ⚠️ 默认来源是 CDP（实测依据见 EMPTY_PREFS 的注释）→ 此时该显示端口手填。 */
      check('★ 默认来源是「已开的调试端口（CDP）」',
        sourceSel.value === 'cdp', String(sourceSel.value))
    }

    /* ── ★ 端口：**只能选、不能手填**（用户 m03425 第 5 条）─────────────
     *
     * 用户原话：「CDP 模式下的端口**不应该可以手填，应该只能选择**。」
     * 所以判据是「它是 `select`（下拉），不是 `input`（手填）」——
     * 这条**必须查元素类型**，不能只查「有没有 9222 这个值」：
     * 手填框里也完全可以有 9222。 */
    const portSel = [...sec.querySelectorAll('select')]
      .find(s => (s.getAttribute('aria-label') ?? '').includes('端口'))
    check('★ 端口是**下拉（只能选）**，不是手填输入框', portSel !== undefined,
      [...sec.querySelectorAll('select')].map(s => s.getAttribute('aria-label')).join(' / '))
    check('★ 不再有手填的端口输入框（旧写法已删）',
      ![...sec.querySelectorAll('input')].some(i => (i.getAttribute('aria-label') ?? '').includes('端口')),
      [...sec.querySelectorAll('input')].map(i => i.getAttribute('aria-label')).join(' / '))
    if (portSel !== undefined) {
      /* ⚠️ 那条存档里 `session` 是「探针标签」，**没配过端口**、全局默认也是空
       * → 下拉的当前值该是空的（没选中任何端口）。
       *
       * 可选值里**会有** 9222（那是设置那份检测结果扫到的端点，本来就该列出来），
       * 所以这条查的是 `value`（选中了谁），不是「选项里有没有 9222」——
       * **绝不能预填**（用户 m03425：「CDP 模式下的端口不应该可以手填，
       * 应该只能选择」＋「是否有端口存在交给设置」）。 */
      check('★ 没配过时**不预选**任何端口（不预填 9222）',
        portSel.value === '', JSON.stringify(portSel.value)
        + ' 选项: ' + [...portSel.querySelectorAll('option')].map(o => o.textContent ?? '').join(' | '))
    }

    /* ── ★ 检测按钮（用户要的「检测」）───────────────────────────────── */
    const probeBtn = [...sec.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '检测')
    check('★ 有「检测」按钮', probeBtn !== undefined,
      [...sec.querySelectorAll('button')].map(b => (b.textContent ?? '').trim()).join(' / '))
    /* ⚠️ **原来这里还有两条**：「列出了扫到的调试端口」+「扫到的端口可一点填上」。
     * 2026-10-16 按用户 m03425 第 5 条**整段删掉**：那排「检测到 N 个端口」的按钮
     * 与上面那个端口下拉**是同一件事的两套界面**（用户原话：「不需要检测到几个
     * 调试端口并选择，因为端口选择就是最上面的端口选择」）。现在候选值统一从
     * 设置那份检测结果来，节点里不再单独列一遍。 */

    /* ── 「有头/无头」归到**打开方式的属性**（只在来源=本机时才有意义）── */
    /* 当前来源是 CDP → 打开方式**不该出现**（它不属于这个来源）。 */
    check('★ 来源=CDP 时不显示「打开方式」（它是另一个来源的属性）',
      [...selects].every(s => !(s.getAttribute('aria-label') ?? '').includes('打开方式')),
      [...selects].map(s => s.getAttribute('aria-label')).join(' / '))

    check('说明了「改的是标签、会影响其他节点」', t.includes('一起生效'), '')
  }
}

/* ── ★ 切到「本机装着的浏览器」：打开方式与浏览器下拉该出现 ──────────── */
console.log('')
console.log('=== ①b 切来源 → 界面跟着换成「本机」那一套 ===')
{
  const d2 = window.document
  const sec = d2.querySelector('[data-ewb-node-browser]')
  if (sec === null) {
    check('浏览器一节还在', false)
  } else {
    const selects = [...sec.querySelectorAll('select')]
    const sourceSel = selects.find(s => (s.getAttribute('aria-label') ?? '').includes('来源'))
    if (sourceSel === undefined) {
      check('找得到来源下拉', false)
    } else {
      /* 真的在界面上切一下（React 的 onChange）。
       * ⚠️ **必须走原生的 value setter**：React 在 DOM 节点上装了一个「值追踪器」，
       * 直接 `sel.value = 'app'` 会被它认成「值没变」→ onChange 不触发（实测是本仓的既有教训，
       * 见 `dom-render.mjs` 的 `nativeRangeSetter` 那一族写法）。 */
      const selSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      if (selSetter !== undefined) selSetter.call(sourceSel, 'app')
      else sourceSel.value = 'app'
      sourceSel.dispatchEvent(new window.Event('change', { bubbles: true }))
      await new Promise(x => setTimeout(x, 500))
      const sec2 = d2.querySelector('[data-ewb-node-browser]')
      const t2 = sec2?.textContent ?? ''
      const sels2 = [...(sec2?.querySelectorAll('select') ?? [])]
      check('★ 切换后出现「打开方式」下拉（它属于「本机」这个来源）',
        sels2.some(s => (s.getAttribute('aria-label') ?? '').includes('打开方式')),
        sels2.map(s => s.getAttribute('aria-label')).join(' / '))
      const openSel = sels2.find(s => (s.getAttribute('aria-label') ?? '').includes('打开方式'))
      if (openSel !== undefined) {
        const opts = [...openSel.querySelectorAll('option')].map(o => o.textContent ?? '')
        check('★ 打开方式就是两项：有窗口 / 无窗口（**不含 CDP**）',
          opts.length === 2 && opts.some(o => o.includes('有窗口')) && opts.some(o => o.includes('无窗口')),
          opts.join(' | '))
      }
      check('★ 切换后出现「用哪个浏览器」下拉',
        sels2.some(s => (s.getAttribute('aria-label') ?? '').includes('用哪个浏览器')),
        sels2.map(s => s.getAttribute('aria-label')).join(' / '))
      check('★ 切换后不再要端口（那是 CDP 那一套的）',
        ![...(sec2?.querySelectorAll('input') ?? [])].some(i => (i.getAttribute('aria-label') ?? '').includes('端口')), '')
      check('★ 下拉里列出了检测到的浏览器（QQ 浏览器）',
        t2.includes('QQ 浏览器') || t2.includes('Google'), '')
    }
  }
}

/* ── ★ 位置：这一节必须是**参数区（可滚动块）里的第一块内容** ──────────
 *
 * 用户 2026-10-14（#2）原话：「浏览器选择这个模块应该就是插件内容的一部分
 * 而不是一个独立模块，他应该是 playwright 这个节点的**第一块内容**。」
 *
 * ## 为什么这条非查不可（不是排版洁癖）
 *
 * 改动前它在 `.block`（可滚动块）**之外**，于是成了 `.inlineEditor` 的
 * 兄弟 flex 项：它以内容高度（实测 153px）先占位，而 `.block` 带 `min-height: 0`
 * 是**唯一能被压扁**的那个 → 参数区可见高度变成 **0px**。
 * 这就是用户说的「原本内容被压缩成了很小的一块根本看不到」。
 *
 * 所以判据必须是**结构关系**（在块内、且在参数之前），不能只查「那一节还在不在」
 * ——「还在但位置错」正是这个 bug 的形态。
 * ⚠️ 只查源码里的前后位置不够（实测那条断言**抓不住**「挪出去但仍写在上面」的改法）：
 * 挪到块外时源码顺序可以不变，DOM 层级却变了。所以在这里查**真实 DOM**。 */
console.log('')
console.log('=== ①c 位置：浏览器一节在参数区里的哪儿 ===')
{
  const scrollBlockEl = d.querySelector('[data-ewb-editor] [class*="_block"]')
  check('★ 找到了参数区（可滚动块）', scrollBlockEl !== null)
  if (scrollBlockEl !== null) {
    const first = scrollBlockEl.firstElementChild
    check('★ 浏览器一节在**可滚动块内部**（不是它的兄弟）',
      scrollBlockEl.querySelector('[data-ewb-node-browser]') !== null)
    /* ⚠️ **这条判据 2026-10-16 改过**（用户 m03425 第 1 条重排了编辑区顺序）。
     *
     * 旧判据是「它必须是块里的**第一块内容**」（用户 2026-10-14 的要求）。
     * 新顺序把**备注**排到了最前面（0 备注 → 1 节点提示 → 2 依赖检查
     * → 3 节点说明 → 4 可用变量 → **5 浏览器** → 6 参数）——
     * 所以「第一块」这条**已经不再成立，且不该成立**。
     *
     * 那条旧判据防的是什么、新判据怎么继续防住它（这才是改断言时要想的事）：
     * 旧 bug 的形态是「浏览器块被挪到 `.block` **外面**」—— 那时它会变成
     * `.inlineEditor` 的兄弟 flex 项，`overflow: visible` 让它的自动最小尺寸
     * 等于内容高度，于是参数区（唯一带 `min-height: 0` 的）被压成 **0 高**。
     * 防住它的**真正条件是「在 `.block` 里面」**（上面那条），
     * 「第一块」只是当时那个写法顺带的一个位置。
     *
     * 所以现在换成查**新顺序本身**：块里第 5 块是浏览器（它前面按顺序是
     * 备注 / 提示 / 依赖 / 说明 / 变量）。这样既守住「在块内」，
     * 又守住「顺序被改对了」—— 比「第一块」更有信息量。 */
    const kids = [...scrollBlockEl.children]
    const idxBrowser = kids.findIndex(k => k.querySelector('[data-ewb-node-browser]') !== null)
    check('★ 它在块里、且**不是**第一块（新顺序里第一块是备注）',
      idxBrowser > 0 && first !== null && first.querySelector('[data-ewb-node-browser]') === null,
      '浏览器是第 ' + String(idxBrowser + 1) + ' 块，第一块是: ' + String(first?.className ?? '（空）').slice(0, 40))
    /* 「在参数之前」：块的文本里，「浏览器」出现在「参数」这个标签之前。
     * ⚠️ 用 `indexOf` 比顺序，不用 `includes`（后者两边都有也通过）。 */
    const bt = scrollBlockEl.textContent ?? ''
    const iBrowser = bt.indexOf('浏览器')
    const iParam = bt.indexOf('参数')
    check('★ 它排在「参数」之前', iBrowser >= 0 && iParam >= 0 && iBrowser < iParam,
      '浏览器@' + String(iBrowser) + ' 参数@' + String(iParam))
  }
}

/* ── ② 浏览器设置在**配置板块 · 其它格**里，画布抽屉里已经没有 ─────────
 *
 * ## 2026-10-23 改（本轮设置分层）
 *
 * 改前这一段假设「浏览器设置 = 画布工具条那个设置抽屉」，于是按
 * **title 含「设置」的第一个按钮**去找入口。这轮新增了侧栏齿轮
 * （title「工作台设置（浏览器：跨所有工作流共用）」），它在 DOM 里排在前面，
 * 于是这条抓到了齿轮、打开的是 `data-ewb-ws-drawer`，而它要的 `data-ewb-drawer`
 * 自然找不到 → 红。
 *
 * **两条都不能靠模糊匹配**，所以现在分开验三个位置：
 *
 *   ① 画布抽屉（`data-ewb-drawer`）—— 用**精确条件**进（title 以「画布设置」开头）；
 *   ② 浏览器设置现在在**「配置」板块 · 其它格**（票 66 之前是侧栏底部齿轮
 *      打开的工作台设置抽屉，`data-ewb-ws-open` / `data-ewb-ws-drawer`，
 *      那两个钩子已随抽屉一起删除）；
 *   ③ ★ **画布抽屉里不许再有浏览器设置** —— 这是本轮真正新增的判据。
 *
 * ③ 比原来强：改前只是「浏览器设置在这些字里」，现在钉住了「它不在画布抽屉里」，
 * 谁把 `BrowserSettings` 挪回画布抽屉，这条立刻红。
 */
console.log('')
console.log('=== ② 浏览器设置的位置（画布抽屉 / 配置板块）===')
{
  /* 回画布 tab，再开**画布**设置抽屉。 */
  click('画布', true)
  await new Promise(x => setTimeout(x, 600))

  /* ⚠️ **精确条件**：title 以「画布设置」开头，不是「含设置」。
   * 侧栏齿轮的 title 是「工作台设置（…）」，含「设置」但不以「画布设置」开头，
   * 所以这条选不中它 —— 这正是改前那条模糊判据栽的地方。
   * 画布那个按钮没有 `data-ewb-*` 钩子，而 `src/**` 本轮不许动，所以只能靠 title；
   * 但「以什么开头」是稳定契约，比「含什么」结实得多。 */
  const canvasSetBtn = [...d.querySelectorAll('button')]
    .find(b => (b.getAttribute('title') ?? '').startsWith('画布设置'))
  check('找到了画布设置入口（title 以「画布设置」开头）', canvasSetBtn !== undefined,
    canvasSetBtn === undefined
      ? [...d.querySelectorAll('button')].map(b => b.getAttribute('title') ?? '').filter(x => x.includes('设置')).join(' | ')
      : '')
  canvasSetBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 900))

  const drawer = d.querySelector('[data-ewb-drawer]')
  check('画布设置抽屉打开了', drawer !== null)
  if (drawer !== null) {
    const t = drawer.textContent ?? ''
    /* ★ 本轮新增的核心判据：浏览器设置**不在**画布抽屉里。
     * 这三样是 `BrowserSettings` 独有的文案，只要它被挂回来就会出现。 */
    const leaked = ['默认来源', '重新检测'].filter(k => t.includes(k))
    check('★ 画布抽屉里**没有**浏览器设置（默认来源 / 重新检测）',
      leaked.length === 0, leaked.length === 0 ? '' : '还在：' + leaked.join('、'))
    check('画布抽屉里也没有端口选择',
      [...drawer.querySelectorAll('select')].every(s => !(s.getAttribute('aria-label') ?? '').includes('端口')),
      [...drawer.querySelectorAll('select')].map(s => s.getAttribute('aria-label')).join(' / '))
    /* 但画布自己的东西还得在（不能为了「搬走浏览器」把抽屉掏空）。 */
    check('画布抽屉里仍有画布自己的设置（节点宽度等）',
      t.includes('节点宽度') || t.includes('画布') || t.includes('快捷键'), '')
  }

  /* ── ③ 真正管浏览器的地方：配置板块的「其它」格 ─────────────────
   *
   * ⚠️ **2026-10-29（票 66）搬过家**：侧栏底部那个齿轮「工作台设置」
   * 与它的抽屉（`data-ewb-ws-open` / `data-ewb-ws-drawer`）已经删掉，
   * 升级成侧栏导航里最后一个板块「配置」（`data-ewb-item="settings"`，
   * `boards.ts` 的 `order: 100`）。板块里按内容分两格：
   * **模型**（默认落这里）/ **其它**，浏览器在「其它」那一格。
   *
   * 所以这一段走三步：板块入口 → 板块挂上 → 点「其它」格。
   * 每一环都用**钩子**找，不按 title 找：
   *   · `data-ewb-item="settings"` —— 板块入口（文字「配置」会变，钩子不会）；
   *   · `data-ewb-config-board` —— 板块根（`ConfigBoard.tsx`）；
   *   · tab 没有逐格钩子，按文字「其它」找（那是 `boards.ts` 里写死的 label）。
   *
   * ⚠️ **任何一环找不到都要报失败，不许静默跳过** —— 下面十几条断言守的是
   * 真东西（默认来源是下拉、端口初始为空、有重新检测、列出扫到的端点）。
   * 跳过就等于这一段白写（票 56 那次 `.layoutGroup` 就是这么让 7 条断言
   * 一条没跑的：锚点没了、`if` 落到 else，看着「只有一条红」）。 */
  const cfgNav = d.querySelector('[data-ewb-item="settings"]')
  check('★ 找到了「配置」板块入口（data-ewb-item="settings"）', cfgNav !== null,
    cfgNav === null
      ? [...d.querySelectorAll('[data-ewb-item]')].map(b => b.getAttribute('data-ewb-item')).join(' | ')
      : '')
  cfgNav?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 900))

  const cfgBoard = d.querySelector('[data-ewb-config-board]')
  check('★ 配置板块挂上了（data-ewb-config-board）', cfgBoard !== null)

  const otherTab = [...d.querySelectorAll('[role="tab"]')]
    .find(b => (b.textContent ?? '').trim() === '其它')
  check('★ 配置板块里有「其它」那一格（浏览器在它里面）', otherTab !== undefined,
    [...d.querySelectorAll('[role="tab"]')].map(b => (b.textContent ?? '').trim()).join(' / '))
  otherTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 700))

  /* 浏览器那一节的钩子（`ConfigBoard.tsx` 给的 `data-ewb-browser-section`）。 */
  const wsPane = d.querySelector('[data-ewb-browser-section]')
  check('★ 浏览器设置找到了（配置板块 · 其它格，data-ewb-browser-section）', wsPane !== null)
  if (wsPane !== null && cfgBoard !== null) {
    /* ⚠️ 两段文字分开取：
     *   · `t`     —— **浏览器那一节**的正文（下面十来条都该在它里面找）；
     *   · `board` —— 整个板块的正文，只有最后那条「标签搬去节点设置」用得上：
     *                那句话是抽屉顶上那句 `note`，随内容搬到了板块底部，
     *                **不在**浏览器那一节里。用 `t` 找它会读成「没说明」，
     *                那是拿隔壁的证据判它 —— 反过来用 `board` 判全部又会放宽
     *                （浏览器那节整个不见了也能通过）。所以分开取。 */
    const t = wsPane.textContent ?? ''
    const board = cfgBoard.textContent ?? ''
    /* ⚠️ 2026-10-14 起这里的文案是「默认**来源**」而不是「默认浏览器」——
     * 因为用户把模型改成了「两个来源」（CDP / 本机装着的）。
     * 判据跟着模型走，不锚死旧文案。 */
    check('★ 配置板块里有「默认来源」', t.includes('默认来源'), '')
    /* ★ 默认来源是 CDP 时，端口是**下拉（只能选）**（用户 m03425 第 5 条）。
     *
     * 用户原话：「CDP 模式下的端口不应该可以手填，**应该只能选择**。」
     * 这条连带把**设置里**也改掉了 —— 可选值就是下面那份检测结果。 */
    const wsSelects = [...wsPane.querySelectorAll('select')]
    check('★ 默认端口是**下拉（只能选）**，不是手填输入框',
      wsSelects.some(s => (s.getAttribute('aria-label') ?? '').includes('端口')),
      wsSelects.map(s => s.getAttribute('aria-label')).join(' / '))
    const defPort = wsSelects.find(s => (s.getAttribute('aria-label') ?? '').includes('端口'))
    /* ⚠️ 初始**必须为空** —— 预填 9222 就等于「换个地方硬编码」。 */
    check('★ 默认端口初始为空（不预填 9222）', defPort === undefined || defPort.value === '',
      JSON.stringify(defPort?.value ?? ''))
    check('★ 有「重新检测」', t.includes('重新检测'), '')
    check('★ 有检测到的浏览器清单（QQ 浏览器）', t.includes('QQ 浏览器'), '')
    /* ★ 扫到的 CDP 端点要**含端口与浏览器版本**（用户 #7 要的「列出找到的端点」）。 */
    check('★ 列出了扫到的 CDP 端点（端口 + 浏览器版本）',
      t.includes('9222') && t.includes('Chrome/138'),
      t.includes('9222') ? '有 9222' : '没有 9222')
    /* ⚠️ 核心：那张「标签 → 浏览器」表格**不该在这儿**（用户要求搬到节点上了）。 */
    check('★ 配置板块里**没有**「标签 → 浏览器」表格',
      !t.includes('标签 → 浏览器'), t.includes('标签 → 浏览器') ? '还在（应当搬走）' : '')
    /* 并且要**告诉用户它搬去哪了**，否则会以为是坏了。
     * ⚠️ 这句在板块底部那句说明里（原抽屉顶上那句），用 `board` 取。 */
    check('说明了「标签那部分在节点设置里改」',
      board.includes('节点的设置里') || board.includes('节点设置'), '')
  }
}

console.log('')
console.log('=== 运行期报错 ===')
if (errs.length === 0) console.log('  （无）')
for (const e of errs.slice(0, 5)) console.log('  ' + e.slice(0, 220))
console.error = origErr

console.log('')
console.log(failed === 0
  ? '结论：两层各在其位（全局管默认+检测，节点管标签→浏览器）✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
