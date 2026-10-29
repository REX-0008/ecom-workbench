/** 钉住「产物里没有未定义的标识符」—— 专抓我踩过的那个 bug。
 *
 * ## 为什么有它（这是用一次真机故障换来的）
 *
 * 2026-10-13 用户报：「另外两个都可以打开，就这一个不能打开」。
 * 真因：`syncBrowserLayer` 用了 `resolveTag`，但 **import 里漏了它** ——
 * 产物里那句调用是 `resolveTag(...)` 而函数根本不存在，
 * 于是**打开任何工作流都抛 `ReferenceError`**，画布换不了内容。
 *
 * 为什么「另外两个能打开」：它们打开时**也崩了**，只是画布上原来那份
 * 看起来没变，用户以为成功了 —— **故障被伪装成了「没反应」**。
 *
 * ## 为什么 check:types 没抓到
 *
 * 客户端那份类型检查**基线就是红的**（`types-react-shim.d.ts` 的既定取舍，
 * 见 AGENTS.md）。这种「漏 import」的错混在几百条既有错里，看不出来。
 *
 * ## 判据
 *
 * 1. **在真实 jsdom 里真跑一遍**：加载产物 → 挂载 → 触发「打开工作流」，
 *    看有没有 `ReferenceError`。这是**行为判据**，最可靠。
 * 2. 顺带查产物里**每个 `xxx(` 调用是否都有定义**（粗查，抓大漏）。
 *
 * 跑法：node tests/bundle-identifiers.mjs（需先 `npm run bundle`）
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

const LIB = new URL('../lib/', import.meta.url).pathname.replace(/^\//, '')

console.log('=== 产物里的未定义标识符（行为判据）===')
{
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

  /* ⚠️ 这份存档**必须含浏览器节点**（`browser.act`）——
   * 那个 bug 就在「同步第二层」里，只处理 `browser.act` / `browser.download`。
   * 若用一份没有浏览器节点的存档，这条断言就**测不到**那个 bug（假绿）。 */
  const WF = {
    version: 1,
    name: 'bundle-identifiers-probe',
    nodes: [
      { id: 'b1', type: 'v1', defId: 'browser.act', position: { x: 0, y: 0 }, params: { action: 'goto', session: '探针', url: 'https://example.com/' }, onError: 'stop' },
      { id: 'c1', type: 'v1', defId: 'code.js', position: { x: 300, y: 0 }, params: { code: 'return 1' }, onError: 'stop' },
    ],
    edges: [{ id: 'e1', source: 'b1', target: 'c1', sourceHandle: 'out', targetHandle: 'in' }],
  }

  let factory = null
  window.__ModuleLoader__ = { load: o => { factory = o.factory } }
  new Function('window', 'document', 'localStorage', 'navigator',
    readFileSync(LIB + 'client.js', 'utf8'))(window, window.document, window.localStorage, window.navigator)
  check('产物能加载', factory !== null)
  if (factory === null) { console.log('结论：没有产物 ✗'); process.exit(1) }

  const fakeRequire = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
    try { return require(name) } catch { throw new Error('缺依赖: ' + name) }
  }

  window.fetch = (url) => {
    const u = String(url)
    const json = o => Promise.resolve({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })
    if (u.includes('/workflows')) return json({ ok: true, dir: 'C:/x', items: [{ name: WF.name, nodes: 2, edges: 1, mtime: Date.now(), path: 'x' }] })
    if (u.includes('/workflow?')) return json({ ok: true, doc: WF })
    if (u.includes('/health')) return json({ ok: true, runs: 0, workdir: 'C:/x' })
    return json({ ok: true, items: [] })
  }
  globalThis.fetch = window.fetch

  /* 抓 ReferenceError（那个 bug 的形态就是它）。 */
  const runtimeErrs = []
  const origErr = console.error
  console.error = (...a) => { runtimeErrs.push(a.map(x => String(x?.stack ?? x)).join(' ')); origErr(...a) }
  window.addEventListener('error', e => { runtimeErrs.push('window.error: ' + String(e.message)) })

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
  const ex = factory(fakeRequire)
  ex.apply(fakeCtx)
  ReactDOMClient.createRoot(window.document.getElementById('root')).render(
    React.createElement(comps.find(c => c.name === 'shell.overlay').fn, {}),
  )
  await new Promise(x => setTimeout(x, 900))

  const d = window.document
  /** 按文字精确点。 */
  const click = (text, inTabs = false) => {
    const scope = inTabs ? d.querySelectorAll('[role="tab"]') : d.querySelectorAll('button')
    const hit = [...scope].find(b => (b.textContent ?? '').trim() === text)
    if (hit === undefined) return false
    hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    return true
  }
  const idsOf = () => [...d.querySelectorAll('.react-flow__node')].map(e => e.getAttribute('data-id'))

  /* 走真实顺序：左侧栏「工作流」（板块入口）→ tab「工作流管理」（清单）→ 展开 → 打开到画布。
   *
   * ⚠️ 两个都叫过「工作流」，现在 tab 改名叫「工作流管理」了 ——
   * 这正是当初被绕住的地方（点了入口以为切到列表，其实列表没挂载）。 */
  click('工作流')
  await new Promise(x => setTimeout(x, 700))

  /* ★ 顺带钉住「进板块默认显示哪一格」（2026-10-13 用户定的）：
   *   tabs[0] 就是默认（见 EcomWorkbench 的 Object.fromEntries(...tabs[0].id)），
   *   用户要求第一格是清单 —— 所以**不点 tab 就该看到列表**。
   *   这条同时守住「顺序」与「默认」两件事（顺序一改、默认就变）。 */
  {
    const tabsNow = [...d.querySelectorAll('[role="tab"]')].map(b => (b.textContent ?? '').trim())
    check('★ 板块内第一格是「工作流管理」（顺序）', tabsNow[0] === '工作流管理', tabsNow.join(' / '))
    check('★ 进板块不点 tab 就能看到列表（默认 = 第一格）',
      (d.body.textContent ?? '').includes(WF.name),
      '若看不到，说明默认 tab 不是第一格（或 tabs[0] 变了）')
  }

  click('工作流管理', true)
  await new Promise(x => setTimeout(x, 1000))

  /* ⚠️ 2026-10-14 改：那一行**不再是 `<button>`**（主行上现在有按钮了，
   * HTML 不允许按钮嵌套 → 改成 `div` + `role="button"`）。
   * 所以按 `role="button"` 找，不能按 `button` 找。 */
  const row = [...d.querySelectorAll('[role="button"]')].find(b => (b.textContent ?? '').includes(WF.name))
  check('列表里找到了探针工作流', row !== undefined)
  await new Promise(x => setTimeout(x, 200))
  /* 「打开到画布」现在**在主行上，不用展开**（用户 2026-10-14 要求）——
   * 所以这里刻意**不点开那一行**，以此顺带证明「不用展开就能点到」。 */
  const openBtn = [...d.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '打开到画布')
  check('不用展开就能找到「打开到画布」按钮', openBtn !== undefined)
  if (openBtn !== undefined) openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(x => setTimeout(x, 1200))

  /* ★ 核心断言：画布必须真的换成那份存档的内容。 */
  const got = idsOf()
  check('★ 打开后画布换成了那份存档的内容（b1/c1 都在）',
    got.includes('b1') && got.includes('c1'), got.join(','))

  /* ★ 归属：这里走的是**真的「打开到画布」那条路**（列表 → 展开 → 打开到画布），
   * 所以它是验「打开后画布记不记得自己是谁」最直接的场合。
   *
   * 用户 2026-10-14 报的 bug 就是这条链断在最后一环：
   * 内容换进来了，但画布**不知道它是谁** → 保存只能新建一个文件。
   * 这里断言工具条的归属显示**变成了那份工作流的名字**（WF.name = 'bundle-identifiers-probe'）。
   *
   * ⚠️ 按**这一块自己的文字**认（工具条上的归属胶囊），不用全页 `includes` ——
   * 列表页就在旁边、里面到处都是这个名字，全页查会「名字没显示」也判通过。 */
  {
    /* ⚠️ **两种类名并列**（票 54 之后必须这样写）。
     *
     * 票 54 把工具条上那颗归属胶囊的类从 `.chip` 改成了 `.tbChip`。
     * 但 `[class*="_chip"]` 是**子串**匹配 —— `_tbChip` 里也含 `_chip`，
     * 所以光把选择器换成 `[class*="_tbChip"]` 反而会**漏掉**别处还在用的 `.chip`
     * （比如计数条），把一条本来能过的判据改成「只认新名字」。
     * 并列写才是「两种形态都认」。
     *
     * 排除条件照旧：`_chipHot` 是悬停时临时加的那颗，`^节点 ` 是计数条。 */
    const chipsOf = () => [...d.querySelectorAll('[class*="_tbChip"], [class*="_chip"]')]
    const fileChip = chipsOf()
      .find(el => !/_chipHot\b/.test(el.className ?? '') && !/^节点\s/.test((el.textContent ?? '').trim()))
    check('★ 工具条上有「当前工作流」显示位', fileChip !== undefined,
      fileChip === undefined ? chipsOf().map(el => el.className).join(' | ').slice(0, 200) : '')
    if (fileChip !== undefined) {
      const txt = (fileChip.textContent ?? '').trim()
      const tip = fileChip.getAttribute('title') ?? ''
      /* ⚠️ 显示的是**截断后**的名字（长名字会把工具条挤垮，见 `namePreview`），
       * 所以判据是「显示文字或悬浮提示里认得出来是那一份」——
       * 悬浮提示里必须是**完整**名字（截断的显示 + 完整的提示，这才是对的做法）。 */
      check('★ 打开后它显示的是**那份工作流的名字**',
        txt.includes(WF.name) || tip.includes(WF.name), JSON.stringify(txt.slice(0, 40)))
      check('★ 悬浮提示里是**完整**名字（显示可以截断，提示不能）',
        tip.includes(WF.name), JSON.stringify(tip.slice(0, 60)))
      check('★ 且不再是「未保存的新工作流」（已经获得归属）', !txt.includes('未保存的新工作流'), JSON.stringify(txt))
      /* 打开一份已存的工作流后，磁盘上的内容与画布一致 → 不该报「未保存」。 */
      check('★ 刚打开时不该报「未保存」（内容与存档一致）',
        !/· 未保存/.test(txt), JSON.stringify(txt))
    }
  }

  /* ★ 第二个核心：不能有 ReferenceError。 */
  const refErrs = runtimeErrs.filter(e => /ReferenceError|is not defined/.test(e))
  check('★ 没有 ReferenceError（未定义标识符）', refErrs.length === 0,
    refErrs[0]?.slice(0, 220) ?? '')
  if (runtimeErrs.length > 0 && refErrs.length === 0) {
    console.log('    （有其他报错，单独看：' + runtimeErrs[0].slice(0, 160) + '）')
  }
  console.error = origErr
}

console.log('')
console.log('=== 顺带：产物里调用了但从没定义的常见标识符（粗查）===')
{
  const s = readFileSync(LIB + 'client.js', 'utf8')
  /* 只查**我们自己那几个模块**里导出的名字有没有被漏引 —— 全量静态分析不现实，
   * 但「从 browser-settings / group-roster 里用的名字」是可以列的。
   * 这里用一份**已知该有定义的名字**清单（新增模块时往这里加）。 */
  const MUST = [
    'resolveTag', 'readPrefs', 'writePrefs',   // browser-settings
    'makeGroup', 'groupBox', 'moveGroupBy', 'clampDesc',   // group-roster
    'relayoutInside', 'fitLoopBox', 'assignToContainer',   // container-ops
  ]
  const missing = []
  for (const name of MUST) {
    /* 既没被 `function name` 定义、也没出现在 import 绑定里 —— 那它要么没用到（无害），
     * 要么就是漏 import（有害）。判据：**被调用**但**没有定义**。 */
    const called = new RegExp('(?<![\\w.$])' + name + '\\s*\\(').test(s)
    const defined = new RegExp('(?:function|const|let|var)\\s+' + name + '\\b').test(s)
      || new RegExp('\\b' + name + '\\s*[=,]').test(s)
    if (called && !defined) missing.push(name)
  }
  check('★ 上面这些名字没有「被调用但没定义」的', missing.length === 0, missing.join(', '))
  console.log('    查了 ' + String(MUST.length) + ' 个名字')
}

console.log('')
console.log(failed === 0
  ? '结论：产物里没有未定义标识符，打开工作流真能换内容 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
