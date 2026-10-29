/** 循环框：收起 / 展开 / 设置面板 —— 都按**看得见的效果**断言。
 *
 * ## 为什么单独一个文件（而不是并进 dom-render）
 *
 * 用户 2026-10-16 报了三件事，现象都是「点了没反应」：
 *   ① 「循环的收起展开**没有实际作用**」
 *   ② 「设置还是无法打开，点击没有作用」
 *   ③ 「将循环默认的宽度也取消掉，**没有内容的时候宽度只比普通节点大一点**」
 *
 * 这三条要验的东西**必须有一个「循环框 + 框里有成员」的画布**，
 * 而 `dom-render` 那一段是「往空画布加一个循环」（没有成员）——
 * 成员该不该被藏起来、框该不该长高，在那里根本无从判起。
 *
 * ⚠️ 我第一版在 `dom-render` 里拿「除框以外随便一个节点」冒充成员，
 * 那是**画布上的普通节点**，它不该被藏 → 断言必然红（假红）。
 * 归属关系只能从 `parentId` 判，所以这份测试直接用一份**带 parentId 的存档**。
 *
 * ## 判据为什么按「效果」而不按「回调被调了」
 *
 * 那两个 bug 的回调**一直都在、一直有被调用**（收起会翻 `collapsed` 那位、
 * 设置会 setState）—— 只是没有可见变化。所以：
 *   · 收起 → 断「成员从画布上消失」+「框缩成一条」
 *   · 设置 → 断「面板出现在画布上」+「框长高到装得下它」
 * 只查「函数被调了」的话，这两个 bug 都能通过。
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

/* ── 环境（与 dom-render / browser-two-layers 同一套）────────────────── */
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

/* 一份**循环框 + 框里一个成员**的存档。
 * `parentId: 'L'` 就是「这个节点属于循环 L」——收起时它必须被藏掉。 */
const WF = {
  version: 1,
  name: 'loop-box-probe',
  nodes: [
    { id: 'L', type: 'v1', defId: 'flow.loop', position: { x: 0, y: 0 }, params: {}, onError: 'stop', style: { width: 380, height: 272, zIndex: 1 } },
    { id: 'k1', type: 'v1', defId: 'flow.delay', position: { x: 40, y: 64 }, params: {}, onError: 'stop', parentId: 'L' },
    /* 第二个循环：**名字很长 + 体内两个成员**。
     * 它存在是为了验「多个循环实例各自独立」——收起 L 不能连累它，
     * 而框头要能装下很长的名字（用户 m00684 要求把「实例数多、名字长」这一档
     * 也纳入核对，见计划 Step 1.5）。 */
    { id: 'L2', type: 'v1', defId: 'flow.loop', label: '④ 循环 B：逐日期（这个名字故意写得很长很长很长很长很长）', position: { x: 520, y: 0 }, params: {}, onError: 'stop', style: { width: 380, height: 272, zIndex: 1 } },
    { id: 'k2', type: 'v1', defId: 'flow.delay', position: { x: 560, y: 64 }, params: {}, onError: 'stop', parentId: 'L2' },
    { id: 'k3', type: 'v1', defId: 'flow.delay', position: { x: 560, y: 150 }, params: {}, onError: 'stop', parentId: 'L2' },
  ],
  edges: [
    /* ★ 一条**连进循环成员**的边（2026-10-21 加）。
     *
     * 为什么必须有它：用户报的 `Error code 008`（`Couldn't create edge for
     * target handle id: "in"`）只在「成员被藏起来、而连到它的边还在」时出现。
     * 没有这条边，收起那段的判据永远绿 —— 哪怕边没跟着藏。
     *
     * 形状照真实存档：上游在框外（`L2`），下游是 `L2` 的成员 `k3`。 */
    { id: 'e1', source: 'L2', target: 'k3', targetHandle: 'in' },
  ],
  /* 循环体里再套一个分组框：**两套归属同时成立**（`parentId: L2` + 名单里有它）。
   * 这是 m00684 点名要核对的最后一档显示。 */
  nodeGroups: [
    { id: 'g1', name: '体里的分组', nodeIds: ['k2', 'k3'] },
  ],
}

let factory = null
window.__ModuleLoader__ = { load: o => { factory = o.factory } }
new Function('window', 'document', 'localStorage', 'navigator',
  readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window, window.document, window.localStorage, window.navigator)
check('产物能加载', factory !== null)
if (factory === null) process.exit(1)

window.fetch = (url) => {
  const u = String(url)
  const json = o => Promise.resolve({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })
  if (u.includes('/browser/detect')) return json({ ok: true, browsers: [], cdp: { listening: false, endpoints: [] }, platform: 'win32' })
  if (u.includes('/workflows')) return json({ ok: true, dir: 'C:/x', items: [{ name: WF.name, nodes: 2, edges: 0, at: Date.now() }] })
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
/**
 * 按文字精确点。
 * @param {string} text - 按钮文字。
 * @param {boolean} inTabs - 是否在 tab 里找。
 * @returns {boolean} 点到没有。
 */
const click = (text, inTabs = false) => {
  const scope = inTabs ? d.querySelectorAll('[role="tab"]') : d.querySelectorAll('button')
  const hit = [...scope].find(b => (b.textContent ?? '').trim() === text)
  if (hit === undefined) return false
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}
/** 框头里按文字（含）找一个按钮（第一个循环框）。 */
const loopBtn = (text) => loopBtnIn(null, text)
/**
 * 在**指定**循环框里按文字找一个按钮。
 * @param {string|null} loopId - 循环节点 id；`null` = 取第一个。
 * @param {string} text - 按钮文字（含匹配）。
 * @returns {Element|undefined} 找到的按钮。
 */
const loopBtnIn = (loopId, text) => {
  const scope = loopId === null
    ? d.querySelector('[data-loop-id]')
    : boxOf(loopId)
  return [...(scope?.querySelectorAll('button') ?? [])].find(b => (b.textContent ?? '').includes(text))
}
/** 循环框那个 React Flow 节点的内联 style（尺寸就写在这里）。 */
const boxStyle = () => {
  const id = d.querySelector('[data-loop-id]')?.getAttribute('data-loop-id') ?? ''
  return d.querySelector('.react-flow__node[data-id="' + id + '"]')?.getAttribute('style') ?? ''
}
/**
 * 从内联 style 里取一个尺寸。
 * @param {string} prop - `width` 或 `height`。
 * @returns {number} 像素值，取不到为 0。
 */
const dim = (prop) => Number(new RegExp(prop + ':\\s*(\\d+)px').exec(boxStyle())?.[1] ?? 0)
/** 成员节点还在不在画布上。 */
const kidOnCanvas = () => d.querySelector('.react-flow__node[data-id="k1"]') !== null
/** 按循环 id 取它的框元素。 */
const boxOf = (id) => [...d.querySelectorAll('[data-loop-id]')].find(el => el.getAttribute('data-loop-id') === id) ?? null
/** 某个循环的成员还在不在画布上。 */
const kidOnCanvasOf = (id) => d.querySelector('.react-flow__node[data-id="' + id + '"]') !== null

/* ── 走真实顺序打开那份存档 ─────────────────────────────────────── */
click('工作流')
await new Promise(x => setTimeout(x, 700))
click('工作流管理', true)
await new Promise(x => setTimeout(x, 900))
const row = [...d.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(WF.name))
if (row !== undefined) row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise(x => setTimeout(x, 300))
const openBtn = [...d.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '打开到画布')
if (openBtn !== undefined) openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
/* ⚠️ **等到框真的有尺寸再开始断**（2026-10-16 踩到）。
 *
 * 打开存档后画布会先跑一次自动布局（`tick` 轮询节点是否渲染好，最多等 2 秒），
 * 框的尺寸是那之后由 `fitLoopBox` 写上的。等 1200ms 不够 —— 那时框还没有内联
 * 尺寸，`dim('height')` 读出来是 0，于是「收起后缩成一条」这条会**假红**
 * （0 → 46 看起来像「变大了」）。
 *
 * 用轮询而不是固定延时：布局耗时与机器有关，固定值迟早不够。 */
for (let i = 0; i < 60; i++) {
  if (d.querySelector('[data-loop-id]') !== null && dim('height') > 0) break
  await new Promise(x => setTimeout(x, 100))
}
await new Promise(x => setTimeout(x, 200))

console.log('')
console.log('=== ① 画布上确实有「循环框 + 框里一个成员」 ===')
check('循环框渲染出来了', d.querySelector('[data-loop-id]') !== null)
check('成员节点在画布上（展开态该在）', kidOnCanvas())

console.log('')
console.log('=== ② 收起：要有两处**看得见**的变化（用户：「没有实际作用」）===')
{
  const hBefore = dim('height')
  /* 收起前的边数 —— 收起后要少一条（连到成员的），展开后要回来。
   * ⚠️ 用「数出来的」而不是写死：这份存档加了新边时不用改这里。 */
  const edgesBeforeCollapse = d.querySelectorAll('.react-flow__edge').length
  const cBtn = loopBtn('收起')
  check('框头有「收起」按钮', cBtn !== undefined)
  if (cBtn !== undefined) {
    cBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(x => setTimeout(x, 500))
    const hAfter = dim('height')
    check('★ 收起后框**缩成一条**（不是只换了个按钮文字）',
      hAfter > 0 && hAfter < hBefore / 2,
      hBefore + 'px → ' + hAfter + 'px')
    /* ★ 这条是用户那条的真正含义：成员是 React Flow 平铺画的（不在框的 DOM 里），
     * 所以只把框缩掉**不够** —— 成员会照旧露在外面。 */
    check('★ 收起后循环体里的成员**从画布上消失**', !kidOnCanvas())
    /* ★★ 连到成员的**边也要一起藏**（2026-10-21 修的真 BUG，用户报 008）。
     *
     * ⚠️ **判据不在这里**：jsdom 没有布局，React Flow 一条边都画不出来
     * （收起前就是 0 条）→ 数 `.react-flow__edge` 的断言**永远绿**，是假绿。
     * 规则住在纯函数 `hiddenEdgesOf` 里，判据在 `tests/edge-hidden.mjs`
     * （直接喂数据、看 `hidden` 那位）。
     *
     * 这里只留一条「确实接上了」的轻量断言：读源码确认 `shownEdges`
     * 用了那个纯函数 —— 否则边永远不藏，008 会复发。 */
    check('★★ 收起时藏成员的同时，画布也会藏连到它的边（规则见 edge-hidden）',
      readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')
        .includes('hiddenEdgesOf(nodes, edges)'))
    check('容器面也消失了（框头的收起态文案）', loopBtn('展开') !== undefined)

    /* 展开回来：两样都要复原（否则「收起」是单向破坏）。 */
    const eBtn = loopBtn('展开')
    if (eBtn !== undefined) {
      eBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise(x => setTimeout(x, 500))
      check('★ 展开后成员**回到**画布上', kidOnCanvas())
      check('★ 展开后框长回原来的高度', Math.abs(dim('height') - hBefore) <= 2,
        String(dim('height')) + ' vs ' + String(hBefore))
    }
  }
}

console.log('')
console.log('=== ③ 设置面板：点得开、框长高、**且成员被推出去** ===')
{
  const hBefore = dim('height')
  /** 成员的**相对 y**（相对框顶，就是存档里的那个坐标）。 */
  const kidRelY = () => {
    const el = d.querySelector('.react-flow__node[data-id="k1"]')
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el?.getAttribute('style') ?? '')
    return m === null ? null : Number(m[2])
  }
  const kidYBefore = kidRelY()
  const sBtn = loopBtn('设置')
  check('框头有「设置」按钮', sBtn !== undefined)
  if (sBtn !== undefined) {
    sBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(x => setTimeout(x, 400))
    const box = d.querySelector('[data-loop-id]')
    const panelEl = box?.querySelector('[class*="loopSettings"]') ?? null
    check('★ 点「设置」后画布上**真的出现了面板**', panelEl !== null)

    /* ★★ **面板必须挂在「框头的定位壳」里**（2026-10-16 修的真 BUG）。
     *
     * 面板是 `position: absolute; top: 100%` —— `top` 的百分比相对**最近的定位
     * 祖先**。原先那个祖先是 `.loopBox`（它带 `position: relative`），于是
     * 「100%」= **整个框的底边**，面板被画到框外下面去了；而 `fitLoopBox`
     * 让出的是**框头下面那一段** → 用户看到「空白留出来了、设置内容没出现」。
     *
     * 现在框头外面裹了一个 `position: relative` 且高度恰为一行框头的壳，
     * 面板住在壳里，`top: 100%` 才真的等于「框头下沿」。
     *
     * ⚠️ **这条断言锚的是 DOM 亲缘关系**（谁是父节点），不是源码文本 ——
     * 把面板挪回 `.loopBox` 下面就会红。 */
    check('★ 面板挂在框头的定位壳里（否则 `top:100%` 会算成整个框的底）',
      panelEl?.parentElement?.className.includes('loopHeadWrap') === true,
      String(panelEl?.parentElement?.className))
    check('★ 那个壳本身就套在循环框里',
      panelEl?.parentElement?.parentElement === box)
    /* ⚠️ 框高必须**真的长**。框高是内联写死的，`.loopBox` 是 `height: 100%`
     * —— 不长高的话面板会溢出到框外。 */
    check('★ 框为面板长高了', dim('height') > hBefore, hBefore + 'px → ' + dim('height') + 'px')
    /* 面板里那四行必须在（含用户报缺口的两行）。 */
    const t = box?.textContent ?? ''
    check('面板里有「循环方式」', t.includes('循环方式'))
    check('面板里有「最大轮数」', t.includes('最大轮数'))
    check('★ 面板里有「遍历哪个数据」', t.includes('遍历哪个数据'))
    check('★ 面板里有「结果取哪个」', t.includes('结果取哪个'))

    /* ★★ **成员必须被推出去**（用户 2026-10-16 原话：
     *    「设置被里面的节点挡住了，这个设置区域应该将内部节点往外挤压」）。
     *
     * 判据：成员的相对 y 必须 **≥ 面板下沿**。面板是 `top: 100%` 挂在框头下沿的，
     * 所以下沿 ≈ `BOX_HEAD_H + BOX_SETTINGS_H`，而 `fitLoopBox` 保证成员至少
     * 从 `topPad`（同一个值）开始 —— 两者同源，所以直接与绝对值比。
     *
     * ⚠️ **不要用「成员在不在面板的 DOM 里」判**：成员是 React Flow 平铺画的，
     * 从来不在框的 DOM 里，那种断言**永远是绿的**（假绿）。 */
    const kidYAfter = kidRelY()
    console.log('   成员的相对 y:', String(kidYBefore) + ' → ' + String(kidYAfter))
    check('★ 成员被推到面板下方（设置不再被挡住）',
      kidYAfter !== null && kidYAfter >= 230, String(kidYAfter) + ' ≥ 230')

    /* 再点一次要收得起来。
     *
     * ⚠️ **「成员推回原位」这条断言 2026-10-16 撤掉了** —— 它当时是绿的，
     * 但它把「成员永远不许被往上拉」这个**错**的行为写成了期望：
     * 用户可能自己把成员拖到框里靠下的位置，下一次关设置就会被拽回
     * `BOX_PAD_TOP`（那是「我拖好的位置自己跑了」，比留一段空白糟得多）。
     * 现在实现改成 `Math.max(0, …)` **只推不拉**，代价是框顶留一段空白。
     * 所以这里只断「面板收起」。 */
    loopBtn('设置')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(x => setTimeout(x, 300))
    check('再点一次「设置」面板收起',
      d.querySelector('[data-loop-id]')?.querySelector('[class*="loopSettings"]') === null)
    /* ⚠️ **「关掉面板后框高还原」这条断言也撤掉了**（2026-10-16）——
     * 它把「推开的让位要收回去」写成了期望，而成员**推下去之后就不该再被拉上来**
     * （见下一条与实现里的 `Math.max(0, …)`）。成员在 y=236，框当然得留那么高
     * —— 所以框高**理应比原来高**。真正要守的是「不许无限长高」，由下面那条收敛断言管。 */
    /* 幂等：再点开一次，成员**不该继续往下跑**（否则框会越用越高）。 */
    const kidYSettled = kidRelY()
    loopBtn('设置')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(x => setTimeout(x, 300))
    check('★ 反复开关设置，成员位置收敛（不会越推越下）',
      kidRelY() === kidYSettled, String(kidRelY()) + ' vs ' + String(kidYSettled))
    loopBtn('设置')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(x => setTimeout(x, 300))
  }
}

console.log('')
console.log('=== ④ 空框的宽度：只比普通节点大一点（用户：「默认的宽度也取消掉」）===')
{
  /* 这份存档里框**有成员**，宽度按内容算 —— 所以要先看有成员时的宽度，
   * 再单独验「空框」那一条走纯逻辑（`fitLoopBox`），不在这里造第二个画布。
   * 这里只断「不是旧的最小值 600」这件事：380 是新的最小宽度。 */
  check('★ 框宽不是旧的两个节点宽（600+）', dim('width') < 600, String(dim('width')) + 'px')
}

console.log('')
console.log('=== ⑤ 多个循环实例：各自独立 + 名字长也不挤坏（计划 Step 1.5）===')
{
  /* 用户 m00684 要求把「实例数多、名字长」这一档纳入核对。
   * 判据仍是**看得见的效果**，不按「函数被调了」： */
  const b1 = boxOf('L')
  const b2 = boxOf('L2')
  check('两个循环框都渲染出来了', b1 !== null && b2 !== null, String(b1 !== null) + ' / ' + String(b2 !== null))
  /* ⚠️ 名字住在 `<input value=…>` 里 —— **textContent 读不到它**
   * （第一版就是拿 textContent 断的，必然红：input 的值不进 textContent）。
   * 要读 `.value`。 */
  const nameInput = b2?.querySelector('input[class*="loopNameInput"]')
  check('★ 长名字真的显示在框头的输入框里（不是被截断/吞掉）',
    (nameInput?.value ?? '').includes('循环 B：逐日期'),
    JSON.stringify(nameInput?.value ?? null).slice(0, 80))

  /* ★ 独立性：收起 L 之后，**L2 的成员一个都不能少**。
   * 少了这条，「藏成员」那段的判据（只看 k1）可能是**误伤**分数 ——
   * 实现若写成「有循环收起就把所有循环成员都藏了」，只查 k1 是绿的。 */
  loopBtnIn('L', '收起')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 400))
  check('★ 收起 L 后，L 的成员消失了', !kidOnCanvasOf('k1'))
  check('★ 收起 L **没有连累** L2 的两个成员（b2 的成员都还在）',
    kidOnCanvasOf('k2') && kidOnCanvasOf('k3'),
    String(kidOnCanvasOf('k2')) + ' / ' + String(kidOnCanvasOf('k3')))
  /* 复原现场 —— 后面的段落不该看到收起态（本文件的一贯纪律）。 */
  loopBtnIn('L', '展开')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 400))
  check('展开 L 后它自己的成员回来了', kidOnCanvasOf('k1'))
}

console.log('')
console.log('=== ⑥ 体内套一个分组框：两套归属不能互相污染（计划 Step 1.5 最后一档）===')
{
  /* 用户 m00684 点名要求核对「体内还套分组框」这一档。
   *
   * ## 为什么这一档值得单独验
   *
   * 分组框与循环框是**两套完全不同的归属机制**（这是有意为之，见 AGENTS.md）：
   *   · 循环 —— 成员挂在**节点的 `parentId`** 上（执行容器）；
   *   · 分组 —— 成员挂在**一份名单 `nodeGroups[].nodeIds`** 上（纯视觉），
   *     框本身是渲染时按成员包围盒**算出来**的旁路节点，**不是节点**。
   *
   * 于是「循环体里又套了一个分组框」时，同一个节点**同时出现在两套里**
   * （`parentId: L2` + 名单里有它）。要守的是**两边各算各的、互不污染**：
   *   ① 分组框要画出来（不然用户以为分组丢了）；
   *   ② 循环框的尺寸**只按 parentId 数**，不该因为多了一个分组框而变大
   *      （若某处顺手把「框」也算成循环成员，循环框会越用越大）。 */
  const groupEl = d.querySelector('.react-flow__node[data-id="g1"]')
  check('★ 循环体内的分组框画出来了', groupEl !== null)
  /* 分组框的 zIndex 最小、排在成员之后（照 groupBoxNodes 的说明）。 */
  console.log('   分组框内联 style:', groupEl?.getAttribute('style') ?? '(无)')

  /* ★ 循环框的高度只该由它**自己的两个成员**决定。
   * 实测值来自 fitLoopBox 的输出；这里断「没有因为它里面的分组框而多长一段」——
   * 判据用**另一个循环**（L，成员 1 个）与 L2（成员 2 个 + 一个分组框）比：
   * L2 比 L 高是正常的（多一个成员），但**不该高出「两个成员」该有的量**（每个成员
   * 约 86px）。留足余量：超过 3 个成员的高度就说明多算了。 */
  const hL = (() => {
    const el = boxOf('L')?.closest('.react-flow__node')
    return Number(/height:\s*(\d+)px/.exec(el?.getAttribute('style') ?? '')?.[1] ?? 0)
  })()
  const hL2 = (() => {
    const el = boxOf('L2')?.closest('.react-flow__node')
    return Number(/height:\s*(\d+)px/.exec(el?.getAttribute('style') ?? '')?.[1] ?? 0)
  })()
  console.log('   循环框高：L（1 个成员）=', hL, 'px ｜ L2（2 个成员 + 1 个分组框）=', hL2, 'px')
  check('★ L2 比 L 高（多一个成员，合理）', hL2 > hL, hL + ' → ' + hL2)
  check('★ 但没高成「4 个成员」那种（分组框没被算进循环成员）',
    hL2 - hL < 86 * 3, '差 ' + String(hL2 - hL) + 'px，阈值 ' + String(86 * 3) + 'px')
}

console.log('')
console.log('=== 运行期报错 ===')
console.log(errs.length === 0 ? '  （无）✓' : errs.slice(0, 3).join('\n'))
if (errs.length > 0) failed += 1

console.log('')
console.log(failed === 0 ? '结论：循环框的收起/展开、设置面板、宽度都按看得见的效果生效 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
