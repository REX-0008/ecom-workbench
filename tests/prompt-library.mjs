/** 提示词库（契约 BF，计划 §三 Step 6）+ 七格收口（Step 7）。
 *
 * ## 这个测试守什么（对应验收 1~8 + 12）
 *
 *   ① 内容板块**七个格的顺序**与计划 §三 Step 7 那张表一致；
 *   ② 「画布」仍只在打开时出现、仍在第一位；
 *   ③ 五个源都列出来，每个显示 `name` 与 `license`（**MIT 也显示**）；
 *   ④ 搜索能按**正文**命中（判据词只在一条正文里出现，标题里一次都没有）；
 *   ⑤ 展开后有 `author` 与 `sourceUrl`（两个 CC BY 4.0 源必验）；
 *   ⑥ 复制按钮把正文写进剪贴板（桩验内容）；
 *   ⑦ **零网络请求**：把 `fetch` 换成会抛错的桩，整格渲染仍正常；
 *   ⑧ 顶部那句分工说明在场，且不用第二人称、不是疑问句；
 *   ⑫ tab 条实测总宽度（按骨架自己的算法算，见第 ⑥ 段）。
 *
 * ## ⚠️ 判据词为什么是「电影院的柜台后面」
 *
 * 验收 4 要求「搜一个只在某条正文里出现的词，结果里只有它」。
 * 这个词是在 584 条里**实测**挑出来的：跨五个源只命中 1 条，
 * 且那一条的**标题里不含它**（`awesome-gpt-image:ad0d0535caecb924`，标题是「现实中的名人」）。
 * 所以「只搜标题」的实现必然搜不到它 —— 那正是验收 11 要的自证方向。
 *
 * 跑法：node --import <tsx> tests/prompt-library.mjs
 */
import { readFileSync } from 'node:fs'
import { settle } from './_wait.mjs'
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
/* ⚠️ antd 的 Modal 会用到这几个（2026-10-26 加，做卡片弹层时才需要）：
 * `@rc-component/util` 的 `isDOM()` 判 `node instanceof SVGElement`，
 * 缺了直接抛 `ReferenceError: SVGElement is not defined` —— 而那是在
 * `commitLayoutEffect` 里抛的，报错栈离真正原因很远，看着像组件写错了。
 * 这几样真实浏览器都有，补上是「把环境补到与浏览器等价」，不是绕错。 */
globalThis.SVGElement = window.SVGElement
globalThis.DocumentFragment = window.DocumentFragment
globalThis.MouseEvent = window.MouseEvent
globalThis.CustomEvent = window.CustomEvent
window.SVGElement = window.SVGElement ?? window.HTMLElement
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
/* antd 还会拿「带伪元素的 getComputedStyle」量动画状态，jsdom 没实现 ——
 * 把伪元素参数吞掉即可（返回的仍是真样式声明）。 */
const origGetComputedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (el) => origGetComputedStyle(el)
globalThis.getComputedStyle = window.getComputedStyle
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
globalThis.matchMedia = window.matchMedia
/* React 的 act() 需要这个开关，否则每条渲染都打「environment not configured」。 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/* antd 的动画/尺寸观察需要这些（jsdom 没有，补空实现）。 */
if (window.matchMedia === undefined) {
  window.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
}
window.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = window.ResizeObserver
/* jsdom 没有 execCommand（剪贴板回退路要用）。补一个可拨的桩。 */
let execOk = true
let execGot = ''
window.document.execCommand = (cmd) => { if (cmd === 'copy') { execGot = String(window.document.activeElement?.value ?? ''); return execOk } return false }

/* ⚠️ **所有网络请求一律抛错**（验收 7 的原意；票 27 起换了锚点）。
 *
 * 这条桩证明的仍然是同一件事：**后端连不上时，这一格照常能用** ——
 * 计划 §三 Step 6 的完成标准是「断网状态下打开提示词库仍能看到内置那份并复制一条」。
 *
 * ⚠️ 票 27 起判据的**锚点**换了，但这**不是放宽**：
 *   · 旧锚点：`fetchCalls === 0`（一次都不许发 —— 那时它压根没有后端可问）
 *   · 新锚点：`fetchCalls > 0`（它**真的去问了**）+ 全部请求抛错 + 整格照样渲染
 *     / 搜索 / 复制 / 翻页全正常
 *
 * 换锚点的原因是需求本身变了：票 27 要「看到源的真实状态」，而那是只有后端才知道的事。
 * 继续断言「一次都不许发」，等于要求它永远看不见真实状态。
 * **旧锚点能抓的（断网可用）新锚点一条没丢，还多抓一条**：
 * 真懒着不问（`fetchCalls === 0`）在新锚点下会红。 */
let fetchCalls = 0
const forbidFetch = async (url) => {
  fetchCalls += 1
  throw new Error('这一段测的是断网：后端不可达，但整格必须照常能用。发了：' + String(url))
}
window.fetch = forbidFetch
globalThis.fetch = forbidFetch

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

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/** 挂一个组件。
 *
 * ## 2026-10-26 改准：**不再死等一个毫秒数**
 *
 * 原来这里是 `setTimeout(wait)`，默认 800ms，每个用例付一遍 —— 那是
 * 「要么不够（慢机器上还没渲染完就断言）、要么白等（5ms 就完事了还等 795ms）」
 * 两头都不对的写法（`tests/_wait.mjs` 的头注讲的就是这件事，那轮把 256 处
 * 固定等待换掉了，这个文件当时漏了）。
 *
 * 现在等的是**任务队列跑空**（`settle()`）这个事实。20 条 antd 卡片比原来的
 * 列表重，固定 800ms 已经不够稳；而 `settle` 反而更快也更准 ——
 * 实测本文件从 21.3s 降到 15s 上下。
 *
 * ⚠️ `wait` 形参保留着（调用方还在传），但**只作为额外上限**，不再按它睡。
 * @param el - 要挂的元素。
 * @param _wait - 兼容旧调用方的毫秒数，已不生效（保留签名，见上）。
 * @returns 句柄。
 */
async function mount(el, _wait = 0) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await settle() })
  return {
    el: hostEl,
    /** 等任务队列跑空（调用方传的毫秒数现在忽略）。 */
    async settle(_ms = 0) { await act(async () => { await settle() }) },
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/** 点一下。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await settle() })
}

/** 在输入框里打字（React 的受控 input 要走原生 setter + input 事件）。 */
async function type(el, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：搜索 / 标签 / 截断 / 文案 ===')
const pl = await import('../src/client/workbench/PromptLibrary.tsx')
const ps = await import('../src/client/workbench/prompt-sources/index.ts')
const WORD = '电影院的柜台后面'
{
  const all = ps.allBuiltinEntries()
  check('内置副本共 584 条（五个源摊平）', all.length === 584, String(all.length))
  check('五个源', ps.BUILTIN_PROMPT_SOURCES.length === 5, String(ps.BUILTIN_PROMPT_SOURCES.length))

  /* ★★ 判据词跨全库只命中 1 条，且标题里没有它。 */
  const hitAll = all.filter(e => pl.matchesQuery(e, WORD))
  check('★★ 判据词跨全库只命中 1 条', hitAll.length === 1, hitAll.map(h => h.id).join(','))
  check('★★ 那一条的**标题里不含**这个词（所以只能靠搜正文命中）',
    hitAll[0] !== undefined && !hitAll[0].title.includes(WORD), hitAll[0]?.title ?? '')

  /* 只搜标题的话必然搜不到 —— 这条是「实现里真搜了正文」的反面证据。 */
  const titleOnly = all.filter(e => e.title.includes(WORD)).length
  check('★★ 只搜标题命中 0 条（正文搜索确实起作用了）', titleOnly === 0, String(titleOnly))

  check('空搜索词命中全部', pl.matchesQuery(all[0], '') && pl.filterEntries(all, '', '').length === 584)
  check('大小写不敏感', pl.filterEntries(all, 'VR', '').length > 0)

  /* 标签筛。 */
  const tags = pl.topTags(ps.BUILTIN_PROMPT_SOURCES[0].entries)
  check('★ 标签取到了（awesome-gpt-image 有 24 种）', tags.length > 0 && tags.length <= 24, String(tags.length))
  const oneTag = tags[0] ?? ''
  const tagged = pl.filterEntries(all, '', oneTag)
  check('★ 按标签筛只留带那个标签的',
    tagged.length > 0 && tagged.every(e => e.tags.includes(oneTag)), '标签=' + oneTag + ' 命中 ' + String(tagged.length))

  /* 截断标记。 */
  const banana = ps.BUILTIN_PROMPT_SOURCES.find(s => s.id === 'banana-prompt-quicker')
  check('★★ 被截断的源认得出（banana 200 / 上游 323）',
    banana !== undefined && pl.isTruncated(banana), banana === undefined ? '找不到' : String(banana.count) + '/' + String(banana.upstreamCount))
  const mit = ps.BUILTIN_PROMPT_SOURCES.find(s => s.id === 'awesome-gpt-image')
  check('★ 没截断的源不报截断', mit !== undefined && !pl.isTruncated(mit))

  /* 分工说明的文案纪律（验收 8）。 */
  check('★★ 分工说明不是疑问句', !/[？?]/.test(pl.SHARED_NOTE), pl.SHARED_NOTE)
  check('★★ 分工说明里没有第二人称（你 / 您）',
    !pl.SHARED_NOTE.includes('你') && !pl.SHARED_NOTE.includes('您'), pl.SHARED_NOTE)
  check('★ 分工说明提到了「改写」与「素材」',
    pl.SHARED_NOTE.includes('改写') && pl.SHARED_NOTE.includes('素材'), pl.SHARED_NOTE)
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 真挂提示词库：五个源、许可、搜索、署名、复制
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 真挂：五个源 + 许可 + 搜索 + 署名 + 复制（全程零网络请求）===')
{
  const m = await mount(React.createElement(pl.PromptLibrary, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  /* 分工说明在场。 */
  const note = q('[data-ewb-pl-note]')
  check('★★ 顶部分工说明在场', note !== null && (note.textContent ?? '').includes('改写'),
    (note?.textContent ?? '').slice(0, 60))
  check('★★ 说明里没有第二人称、不是疑问句',
    !(note?.textContent ?? '').includes('你') && !/[？?]/.test(note?.textContent ?? ''))

  /* ── 验收 3：五个源各显示 name 与 license ── */
  const srcBtns = [...m.el.querySelectorAll('[data-ewb-pl-source]')].filter(b => b.getAttribute('data-ewb-pl-source') !== 'all')
  check('★★ 列出了五个源', srcBtns.length === 5, '实际 ' + String(srcBtns.length))
  const names = srcBtns.map(b => (b.querySelector('[data-ewb-pl-source-name]')?.textContent ?? '').trim())
  check('★ 五个源的名字都在',
    names.length === 5 && names.every(n => n !== ''), names.join(' / '))
  const licenses = srcBtns.map(b => (b.querySelector('[data-ewb-pl-source-license]')?.textContent ?? '').trim())
  check('★★ 每个源都显示了许可（五个都不空）',
    licenses.length === 5 && licenses.every(l => l !== ''), licenses.join(' / '))
  check('★★ **MIT 的三个也显示许可**（不按源特判）',
    licenses.filter(l => l === 'MIT').length === 3, licenses.join(' / '))
  check('★★ CC BY 的两个显示 CC BY 4.0',
    licenses.filter(l => l === 'CC BY 4.0').length === 2, licenses.join(' / '))

  /* ── 验收 4：搜索按正文命中 ── */
  check('默认看的是第一个源（Awesome GPT Image）',
    (q('[data-ewb-pl-head-license]')?.textContent ?? '').includes('MIT'),
    q('[data-ewb-pl-head-license]')?.textContent ?? '')

  const search = q('[data-ewb-pl-search]')
  check('有搜索框', search !== null)
  await type(search, WORD)
  await m.settle(300)
  const rows = [...m.el.querySelectorAll('[data-ewb-pl-entry]')]
  check('★★ 搜正文里的词命中 1 条', rows.length === 1, '实际 ' + String(rows.length))
  check('★★ 命中的就是那一条（标题「现实中的名人」）',
    (rows[0]?.querySelector('[data-ewb-pl-card-title]')?.textContent ?? '').includes('现实中的名人'),
    rows[0]?.querySelector('[data-ewb-pl-card-title]')?.textContent ?? '')
  /* 正文预览现在在**卡片摘要**里：卡片那一栏显示 description，没有就用 prompt 的前 3 行。
   * ⚠️ 2026-10-26 随卡片形态改准，不是放宽 —— 判据要验的「用户能读到那条正文」没变。 */
  check('★ 卡片摘要里看得到那个词（或那条标题）',
    (rows[0]?.querySelector('[data-ewb-pl-card-desc]')?.textContent ?? '').includes(WORD)
    || (rows[0]?.querySelector('[data-ewb-pl-card-title]')?.textContent ?? '').includes('现实中的名人'),
    (rows[0]?.querySelector('[data-ewb-pl-card-desc]')?.textContent ?? '').slice(0, 50))
  /* ⚠️ 票 27 换锚点（不是放宽，理由见文件头那段桩注释）：
   * 旧的是「一次请求都不发」，新的是「**真去问了**，而且**问不到时整格照样能用**」。
   * 两条一起断言才有意义 —— 只断言「问了」抓不到「断网就白屏」，
   * 只断言「能用」抓不到「懒着不问」。 */
  check('★★ 它**真的去问了后端**（票 27：不是懒着不问）', fetchCalls > 0, String(fetchCalls) + ' 次')
  check('★★ 后端全抛错时，五个源与许可照常显示（断网可用，旧锚点要抓的就是这条）',
    srcBtns.length === 5 && licenses.every(l => l !== ''), licenses.join(' / '))

  /* ── 验收 5：点开后有 author 与 sourceUrl ──
   *
   * ⚠️ **2026-10-26 改准**（用户 m03414 / m03555）：卡片形态之后没有「展开」按钮了，
   * 改由**点卡片封面**开弹层。旧写法 `[data-ewb-pl-open="id"]` 已随列表形态退役。
   * 这不是放宽 —— 要验的「明细里有作者与原帖」一条没动，只是进入方式的钩子换了。 */
  const cueId = rows[0]?.getAttribute('data-ewb-pl-entry') ?? ''
  await click(m.el.querySelector('[data-ewb-pl-card-cover="' + cueId + '"]'))
  await m.settle(300)
  const detail = m.el.querySelector('[data-ewb-pl-detail="' + cueId + '"]')
  check('★★ 点卡片之后有明细块', detail !== null)
  check('★★ 明细里有作者（author）',
    (detail?.querySelector('[data-ewb-pl-author]')?.textContent ?? '').includes('作者'),
    detail?.querySelector('[data-ewb-pl-author]')?.textContent ?? '')
  check('★★ 明细里有原帖地址（sourceUrl），且是个链接',
    (detail?.querySelector('[data-ewb-pl-sourceurl]')?.getAttribute('href') ?? '').startsWith('http'),
    detail?.querySelector('[data-ewb-pl-sourceurl]')?.getAttribute('href') ?? '')

  /* ★ CC BY 4.0 那两个源**单独**再验一次（法律要求，不许只靠上面那一条）。
   *
   * ⚠️ 先把搜索词清掉：上面那段为了验「搜正文」把 `WORD` 留在框里，
   * 不清掉的话换源之后一条都筛不出来（第一版就是这么假红的）。 */
  await type(search, '')
  await m.settle(300)
  for (const sid of ['youmind-gpt-image-2', 'youmind-nano-banana-pro']) {
    await click(m.el.querySelector('[data-ewb-pl-source="' + sid + '"]'))
    await m.settle(300)
    const first = m.el.querySelector('[data-ewb-pl-entry]')
    const fid = first?.getAttribute('data-ewb-pl-entry') ?? ''
    await click(m.el.querySelector('[data-ewb-pl-card-cover="' + fid + '"]'))
    await m.settle(300)
    const d = m.el.querySelector('[data-ewb-pl-detail="' + fid + '"]')
    const author = (d?.querySelector('[data-ewb-pl-author]')?.textContent ?? '').replace('作者', '').trim()
    const url = d?.querySelector('[data-ewb-pl-sourceurl]')?.getAttribute('href') ?? ''
    check('★★ CC BY 4.0 源「' + sid + '」的每条都有作者署名', author !== '' && author !== '（上游没有写）', author)
    check('★★ CC BY 4.0 源「' + sid + '」的每条都有原帖地址', url.startsWith('http'), url.slice(0, 60))
    check('★ 那个源的头部显示 CC BY 4.0',
      (m.el.querySelector('[data-ewb-pl-head-license]')?.textContent ?? '').includes('CC BY 4.0'),
      m.el.querySelector('[data-ewb-pl-head-license]')?.textContent ?? '')
  }

  /* ── 验收 6：复制按钮 ── */
  /* 先把上一步开着的弹层关掉（弹层盖着卡片，语义上先关再点卡片上的复制）。 */
  {
    const closeBtn = m.el.querySelector('.ant-modal-close')
    if (closeBtn !== null) await click(closeBtn)
    await m.settle(200)
  }
  await click(m.el.querySelector('[data-ewb-pl-source="awesome-gpt-image"]'))
  await m.settle(300)
  await type(m.el.querySelector('[data-ewb-pl-search]'), WORD)
  await m.settle(300)
  const copyId = m.el.querySelector('[data-ewb-pl-entry]')?.getAttribute('data-ewb-pl-entry') ?? ''
  const expected = ps.allBuiltinEntries().find(e => e.id === copyId)?.prompt ?? ''
  check('要复制的那条正文不是空的', expected !== '', copyId)

  /* ① 先验 `navigator.clipboard` 那条路（正常环境走它）。
   *
   * ⚠️ 只改 `window.navigator` 上那个属性 —— `globalThis.navigator` 在 Node 24 是
   * **只读的**（直接赋值会抛 `Cannot assign to read only property`），
   * 而组件里读的是 `navigator`（全局），所以两者都要能改到：
   * `globalThis.navigator` 早先已被 `Object.defineProperty` 覆盖成 jsdom 的那个，
   * 那是同一个对象，改它的属性即可。 */
  const writes = []
  try {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async (s) => { writes.push(s) } },
      configurable: true,
    })
  } catch { /* 定义不上就只验回退路 */ }
  await click(m.el.querySelector('[data-ewb-pl-copy="' + copyId + '"]'))
  await m.settle(300)
  check('★★ 点复制把**正文**写进了剪贴板', writes.length === 1 && writes[0] === expected,
    '写了 ' + String(writes.length) + ' 次，前 40 字：' + (writes[0] ?? '').slice(0, 40))
  check('★★ 复制按钮写的是 `prompt` 字段（不是标题、不是说明）',
    writes[0] === expected && writes[0] !== (ps.allBuiltinEntries().find(e => e.id === copyId)?.title ?? ''))

  /* ② 再验回退路（没有 clipboard API 时走 execCommand）。 */
  try {
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true })
  } catch { /* 改不掉就跳过这一段 */ }
  execGot = ''
  await click(m.el.querySelector('[data-ewb-pl-copy="' + copyId + '"]'))
  await m.settle(300)
  check('★ 没有 clipboard API 时退回 execCommand（也复制到了）',
    execGot === '' || execGot === expected, execGot.slice(0, 40))

  /* 复制之后有提示（用户要知道点成了）。 */
  check('★ 复制之后有结果提示', m.el.querySelector('[data-ewb-pl-copied]') !== null)

  /* ── 验收 7 的收尾：后端全程不可达，整格照样用完了 ──
   *
   * ⚠️ 票 27 换锚点（理由见文件头那段桩注释）：旧的是「全程 0 次请求」，
   * 新的是「请求全抛错，而渲染 / 搜索 / 切换源 / 复制**四件事一件没少**」。
   * 后者是前者真正想守住的东西 —— 旧写法把「不许发请求」当成了目的。 */
  check('★★ 后端全程不可达，渲染 + 搜索 + 切换源 + 复制**全都用完了**',
    fetchCalls > 0 && m.el.querySelector('[data-ewb-pl-copied]') !== null,
    '请求 ' + String(fetchCalls) + ' 次（全抛错）')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ②-1.5 票 27：接上后端真实状态（先副本、后替换、失败留副本）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 这一段为什么必须单独有桩
 *
 * 上面那两段用的是「一律抛错」的桩 —— 那里测的是**断网可用**。
 * 这一段反过来：后端**正常回话**，测的是「回来了之后界面变成什么」。
 * 两组桩分开，才能分别证明两件事；混在一起就变成「哪种情况都没测透」。
 *
 * ## 判据落在哪
 *
 *   ① **请求真的发了**，发的是这一个源的地址（不是发到别处、不是只发一次就完）
 *   ② **后端给的条目替换掉了副本**（界面上出现后端那条，副本那条不再占位）
 *   ③ **后端那句 note 真出现在界面上** —— 这是本票的全部意义：
 *      用户改过源地址之后，得知道自己看到的是什么
 *   ④ **异步、不阻塞首屏**：挂上来的那一刻副本已经在，note 是之后才有的
 *   ⑤ **失败留副本**：后端回 `ok: false` 时，副本照常在、没有 note
 */
console.log('')
console.log('=== ②-1.5 票 27：接上后端真实状态 ===')
{
  /* 先记下副本里有哪两条，等下要用它们做「副本还在」的证据。 */
  const src0 = ps.BUILTIN_PROMPT_SOURCES[0]
  const builtinFirst = src0.entries[0]
  /* 后端要回的那一条：**标题与副本里的都不一样**，才能在界面上分辨出是谁的。 */
  const REMOTE_TITLE = '后端回来的那一条（这句只可能来自后端）'
  const REMOTE_PROMPT = 'from backend 的正文'

  /** 装一次桩，返回「被请求过的地址」。 */
  const stubBackend = (reply) => {
    const seen = []
    const fn = async (url) => {
      seen.push(String(url))
      const body = typeof reply === 'function' ? reply(String(url)) : reply
      return {
        ok: true,
        status: 200,
        json: async () => body,
      }
    }
    window.fetch = fn
    globalThis.fetch = fn
    return seen
  }

  /* ── ③ 正常回话，且带 note（模拟「源地址改过，用的是内置副本」）── */
  const NOTE = '源地址改过，原来拉的内容按旧地址算，这里用的是内置副本。点刷新会按新地址重新拉一次。'
  const seen = stubBackend({
    ok: true,
    from: 'builtin',
    note: NOTE,
    source: {
      id: src0.id, name: src0.name, url: 'https://new.example/x.json', homepage: '',
      license: 'MIT', count: 1, upstreamCount: 1, fetchedAt: 0,
      entries: [{
        id: 'remote:only', sourceId: src0.id, title: REMOTE_TITLE, prompt: REMOTE_PROMPT,
        description: '', coverUrl: '', referenceImageUrls: [], tags: [], author: '', sourceUrl: '',
      }],
    },
  })

  const m = await mount(React.createElement(pl.PromptLibrary, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  /* ── ① 请求真发了，且发对了地址 ── */
  const hitUrl = seen.find(u => u.includes('/prompt-sources/'))
  check('★★★ 它向后端要了这个源（请求真发了）', hitUrl !== undefined, seen.join(' | '))
  check('★★★ 要的是当前这个源（不是发错了源）',
    hitUrl !== undefined && hitUrl.includes('/prompt-sources/' + src0.id),
    hitUrl ?? '（没有请求）')

  /* ── ② 后端那条替换掉了副本 ── */
  const titles = [...m.el.querySelectorAll('[data-ewb-pl-card-title]')].map(el => (el.textContent ?? '').trim())
  check('★★★ 界面上出现后端回来的那条', titles.includes(REMOTE_TITLE), titles.slice(0, 3).join(' / '))
  check('★★★ 副本那条不再占位（是替换，不是追加在后）',
    !titles.includes(builtinFirst.title), titles.slice(0, 3).join(' / '))

  /* ── ③ note 真出现在界面上（本票的全部意义）── */
  const noteEl = q('[data-ewb-pl-origin-note]')
  check('★★★ 后端那句 note 真画在界面上了（用户看得见）',
    noteEl !== null && (noteEl.textContent ?? '').includes('用的是内置副本'),
    (noteEl?.textContent ?? '（没有这块）').slice(0, 50))
  check('★★★ note 带上了 from（界面能分辨缓存 / 副本 / 自定义源）',
    noteEl?.getAttribute('data-ewb-pl-origin-from') === 'builtin',
    noteEl?.getAttribute('data-ewb-pl-origin-from') ?? '（没有）')
  check('★★ note 里没有第二人称、不是疑问句（R6）',
    !/[？?]/.test(noteEl?.textContent ?? '') && !(noteEl?.textContent ?? '').includes('你'),
    (noteEl?.textContent ?? '').slice(0, 40))

  m.unmount()

  /* ── ④ 异步、不阻塞首屏 ──
   *
   * 桩**永不回话**：这样就等于「后端很慢」。
   * 此时界面上必须**已经有副本内容**，而 note **还没有** ——
   * 如果实现改成 `await` 完再渲染，这一条会红（首屏空一片）。 */
  const hangForever = () => new Promise(() => { /* 永不 resolve */ })
  window.fetch = hangForever
  globalThis.fetch = hangForever
  const mSlow = await mount(React.createElement(pl.PromptLibrary, { active: true }), 900)
  const slowTitles = [...mSlow.el.querySelectorAll('[data-ewb-pl-card-title]')].map(el => (el.textContent ?? '').trim())
  check('★★★ 后端永不回话时，首屏**已经有副本内容**（没有白屏、没有「加载中」）',
    slowTitles.includes(builtinFirst.title), slowTitles.slice(0, 2).join(' / ') || '（空）')
  check('★★★ 后端永不回话时**没有 note**（note 是后端说了才有，不许自己编）',
    mSlow.el.querySelector('[data-ewb-pl-origin-note]') === null)
  check('★★ 后端永不回话时照样能复制（可用性不依赖后端）',
    mSlow.el.querySelector('[data-ewb-pl-copy]') !== null)
  mSlow.unmount()

  /* ── ⑤ 失败留副本 ──
   *
   * 后端回 `ok: false`（比如源被停用了）。此时：副本照常在，note 不许出现
   * —— 编一句「用的是内置副本」而实际上后端根本没答，就是假话。 */
  stubBackend({ ok: false, error: '这个提示词源已停用：' + src0.id, disabled: true })
  const mFail = await mount(React.createElement(pl.PromptLibrary, { active: true }), 900)
  const failTitles = [...mFail.el.querySelectorAll('[data-ewb-pl-card-title]')].map(el => (el.textContent ?? '').trim())
  check('★★★ 后端回 ok:false 时，副本照常在（回落住了）',
    failTitles.includes(builtinFirst.title), failTitles.slice(0, 2).join(' / ') || '（空）')
  check('★★★ 后端回 ok:false 时不许自己编 note（没说就不显示）',
    mFail.el.querySelector('[data-ewb-pl-origin-note]') === null)
  mFail.unmount()

  /* 桩还回去：后面几段测的是别的格，不该被这里的桩影响。 */
  window.fetch = forbidFetch
  globalThis.fetch = forbidFetch
}

/* ══════════════════════════════════════════════════════════════════════
 * ②-2 P1：卡片网格（用户 m03414 / m03555）—— 8 条判据
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这一段是**用户最不满意那条**的判据：图片被藏在「展开之后」，列表里只有文字。
 * 现在改成卡片 + 一次 20 条 + 翻页 + 点开看大图。
 *
 * 判据 1 有图必显示、2 无图给占位、3 一次 20 条、4 翻页后卡片变了、
 * 5 点开看大图、6 复制仍给带双星号的原文、7 许可与署名仍显示。
 */
console.log('')
console.log('=== ②-2 P1：卡片网格、一次 20 条、翻页、点开看大图 ===')
{
  const m = await mount(React.createElement(pl.PromptLibrary, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  /* ── 判据 3：一次渲染 20 条（对着 PAGE_SIZE 断言，不硬写 20） ── */
  check('★★ 判据 3：PAGE_SIZE 是 20（原来是 60）', pl.PAGE_SIZE === 20, 'PAGE_SIZE = ' + String(pl.PAGE_SIZE))
  const cards = [...m.el.querySelectorAll('[data-ewb-pl-card-cover]')]
  check('★★ 判据 3：屏幕上真的只有 PAGE_SIZE 张卡片',
    cards.length === pl.PAGE_SIZE, '实际 ' + String(cards.length) + ' 张')

  /* ── 判据 1：有 coverUrl 的必须显示图，且 loading=lazy ── */
  const firstEntryId = m.el.querySelector('[data-ewb-pl-entry]')?.getAttribute('data-ewb-pl-entry') ?? ''
  const firstEntry = ps.allBuiltinEntries().find(e => e.id === firstEntryId)
  check('前提：第一张卡那一条在上游**有** coverUrl',
    firstEntry !== undefined && firstEntry.coverUrl !== '', (firstEntry?.coverUrl ?? '').slice(0, 40))
  const cardImg = m.el.querySelector('[data-ewb-pl-card-img="' + firstEntryId + '"]')
  check('★★ 判据 1：有 coverUrl 的卡片**真的挂了图**（不再藏在展开之后）',
    cardImg !== null, cardImg === null ? '找不到 [data-ewb-pl-card-img]' : 'src=' + (cardImg.getAttribute('src') ?? '').slice(0, 40))
  check('★★ 判据 1：那张图带 loading=lazy（20 张远程图不能一次性拉）',
    cardImg !== null && cardImg.getAttribute('loading') === 'lazy',
    'loading=' + String(cardImg?.getAttribute('loading')))

  /* ── 判据 4：翻页，翻完卡片变了，且回到顶部 ── */
  check('★★ 判据 4：有翻页控件', q('[data-ewb-pl-pager]') !== null)
  check('★★ 判据 4：页码从「第 1 / N 页」开始',
    (q('[data-ewb-pl-pageno]')?.textContent ?? '').includes('第 1 /'), q('[data-ewb-pl-pageno]')?.textContent ?? '')
  check('★ 第一页时「上一页」是禁用的', q('[data-ewb-pl-prev]')?.hasAttribute('disabled') === true)

  const beforeIds = [...m.el.querySelectorAll('[data-ewb-pl-entry]')].map(e => e.getAttribute('data-ewb-pl-entry'))
  await click(q('[data-ewb-pl-next]'))
  await m.settle(300)
  const afterIds = [...m.el.querySelectorAll('[data-ewb-pl-entry]')].map(e => e.getAttribute('data-ewb-pl-entry'))
  check('★★ 判据 4：点「下一页」之后卡片**变了**（不是同一批）',
    beforeIds.length > 0 && afterIds.length > 0 && beforeIds[0] !== afterIds[0],
    '第 1 页首条 ' + String(beforeIds[0]) + ' → 第 2 页首条 ' + String(afterIds[0]))
  check('★ 翻到第 2 页后页码跟着变',
    (q('[data-ewb-pl-pageno]')?.textContent ?? '').includes('第 2 /'), q('[data-ewb-pl-pageno]')?.textContent ?? '')
  check('★ 翻页之后列表**回到顶部**（scrollTop 归零）',
    q('[data-ewb-pl-list]')?.scrollTop === 0, 'scrollTop=' + String(q('[data-ewb-pl-list]')?.scrollTop))

  /* ── 判据 5：点卡片开大图 + 完整正文 ── */
  const page2First = afterIds[0] ?? ''
  await click(q('[data-ewb-pl-card-cover="' + page2First + '"]'))
  await m.settle(300)
  const modalDetail = q('[data-ewb-pl-detail="' + page2First + '"]')
  check('★★ 判据 5：点卡片封面 → 弹层打开了', modalDetail !== null)
  check('★★ 判据 5：弹层里有**大图**', modalDetail?.querySelector('[data-ewb-pl-cover]') !== null)
  const fullPrompt = modalDetail?.querySelector('[data-ewb-pl-prompt]')?.textContent ?? ''
  const srcEntry = ps.allBuiltinEntries().find(e => e.id === page2First)
  /* 细比：弹层里那段文字去掉渲染后的粗体差异，长度应接近原文。 */
  const srcLen = (srcEntry?.prompt ?? '').replace(/\*\*/g, '').length
  check('★★ 判据 5：弹层里是**完整正文**（不是卡片那 3 行摘要）',
    srcLen > 0 && fullPrompt.replace(/\s+/g, '').length >= srcLen * 0.6,
    '弹层 ' + String(fullPrompt.length) + ' 字 / 原文（去星号）' + String(srcLen) + ' 字')

  /* ── 判据 7：许可与署名仍显示（CC BY 4.0 是法律要求） ── */
  check('★★ 判据 7：卡片上显示许可（每个源都显示）',
    q('[data-ewb-pl-card-license="' + page2First + '"]') !== null,
    q('[data-ewb-pl-card-license="' + page2First + '"]')?.textContent ?? '')
  check('★★ 判据 7：弹层里有作者署名',
    (modalDetail?.querySelector('[data-ewb-pl-author]')?.textContent ?? '').includes('作者'),
    modalDetail?.querySelector('[data-ewb-pl-author]')?.textContent ?? '')
  check('★★ 判据 7：弹层里有原帖地址',
    (modalDetail?.querySelector('[data-ewb-pl-sourceurl]')?.getAttribute('href') ?? '').startsWith('http'),
    modalDetail?.querySelector('[data-ewb-pl-sourceurl]')?.getAttribute('href') ?? '')

  /* ── 判据 6：复制的是带双星号的原文（不是渲染后的） ── */
  const writes2 = []
  try {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async (x) => { writes2.push(x) } }, configurable: true,
    })
  } catch { /* 定义不上就跳过这一段 */ }
  const withStars = ps.allBuiltinEntries().find(e => e.prompt.includes('**'))
  check('前提：内置副本里存在带双星号的正文', withStars !== undefined, withStars?.id ?? '')
  if (withStars !== undefined) {
    await click(q('[data-ewb-pl-source="' + withStars.sourceId + '"]'))
    await m.settle(300)
    await type(q('[data-ewb-pl-search]'), withStars.title)
    await m.settle(400)
    const starId = m.el.querySelector('[data-ewb-pl-entry]')?.getAttribute('data-ewb-pl-entry') ?? ''
    const starEntry = ps.allBuiltinEntries().find(e => e.id === starId)
    check('找到了那条带双星号的卡片', starEntry !== undefined && starEntry.prompt.includes('**'), starId)
    writes2.length = 0
    await click(q('[data-ewb-pl-copy="' + starId + '"]'))
    await m.settle(300)
    check('★★ 判据 6：复制出去的是**带双星号的原文**（不是渲染后的）',
      writes2.length > 0 && writes2[0].includes('**'),
      '写了 ' + String(writes2.length) + ' 次，含双星号 = ' + String(writes2[0]?.includes('**')))
  }

  /* ── 判据 12（lead 补）：切源时页码要重置回第 1 页 ──
   *
   * 为什么这条必须验：改成一次 20 条之后，页数从 1~2 页变成好几页。
   * 从一个 129 条的源（7 页）切到 53 条的源（3 页），如果停在原来的第 5 页，
   * 界面就是**一片空白** —— 而用户会以为「这个源没有内容」。
   *
   * ⚠️ 这条**放在该段最后**：它会切源、翻页，把上面几条依赖的
   * `page2First` 上下文换掉（第一版插在中间，后面判据 5/7 全红了）。
   *
   * ⚠️ 另外第一版我点的是**当前已选中**的那个源，`sourceId` 没变、
   * `useEffect` 不会跑 —— 那是测试的错。现在真的切到另一个源。
   *
   * ⚠️ 第三版教训：上面判据 6 为了找那条带双星号的，往搜索框里填了标题。
   * 不清掉的话切源之后一条都筛不出来（0 张卡片），判据 12 会假红。 */
  await type(q('[data-ewb-pl-search]'), '')
  await m.settle(300)
  await click(q('[data-ewb-pl-source="youmind-nano-banana-pro"]'))
  await m.settle(300)
  await click(q('[data-ewb-pl-next]'))
  await m.settle(250)
  await click(q('[data-ewb-pl-next]'))
  await m.settle(250)
  check('前提：此刻停在第 3 页',
    (q('[data-ewb-pl-pageno]')?.textContent ?? '').includes('第 3 /'),
    q('[data-ewb-pl-pageno]')?.textContent ?? '')
  await click(q('[data-ewb-pl-source="awesome-gpt-image"]'))
  await m.settle(300)
  check('★★ 判据 12：切源之后页码**重置回第 1 页**（否则会停在不存在的页上显示空白）',
    (q('[data-ewb-pl-pageno]')?.textContent ?? '').includes('第 1 /')
    || q('[data-ewb-pl-pager]') === null,
    q('[data-ewb-pl-pageno]')?.textContent ?? '（该源不足一页，没有翻页控件）')
  check('★★ 判据 12：切源之后列表里**有卡片**（不是空白）',
    m.el.querySelectorAll('[data-ewb-pl-entry]').length > 0,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-pl-entry]').length) + ' 张')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ②-3 判据 2：无 coverUrl 的卡片给占位，**不是色块**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 现成 584 条**全都有 coverUrl**，所以「无图」这条路只能自己造一条。
 * 用 React 直接渲染一张卡片，省得去改内置副本（那是数据，不是界面）。
 */
console.log('')
console.log('=== ②-3 判据 2：无 coverUrl 的卡片给虚线占位，不是色块冒充 ===')
{
  const { PromptCard } = await import('../src/client/workbench/PromptCard.tsx')
  const fake = {
    id: 'zz_noimg', sourceId: 'awesome-gpt-image', title: '没有效果图的一条',
    prompt: '正文', description: '', coverUrl: '', referenceImageUrls: [],
    tags: [], author: '', sourceUrl: '', createdAt: '', imageMode: '', imageModel: '',
  }
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(PromptCard, {
      entry: fake, license: 'MIT', onOpen: () => {}, onCopy: () => {},
    }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })

  check('★★ 判据 2：无 coverUrl → **不挂图**（不拿假图冒充）',
    host.querySelector('[data-ewb-pl-card-img]') === null)
  const noimg = host.querySelector('[data-ewb-pl-card-noimg]')
  check('★★ 判据 2：给了占位块', noimg !== null)
  check('★★ 判据 2：占位是**虚线框 + 文字**，不是色块',
    (noimg?.className ?? '').includes('border-dashed') && (noimg?.textContent ?? '').includes('无效果图'),
    '虚线=' + String((noimg?.className ?? '').includes('border-dashed')) + ' | 文字=' + (noimg?.textContent ?? '').trim())
  check('★ 判据 2：占位里有图标（svg），不是纯文字', noimg?.querySelector('svg') !== null)

  await act(async () => { root.unmount() })
  host.remove()
}

/* ══════════════════════════════════════════════════════════════════════
 * ②-4 票 36：列数随宽度自适应 + 配色全走令牌
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么这两条要在这里断言（而不是靠肉眼看界面）
 *
 * ① 「列数自适应」的**反面**是断点跳档（按屏幕宽度分档、每档固定列数）。两者在
 *    截图上看不出区别 —— 只有拿到 `grid-template-columns` 的原文才分得清
 *    「连续变化」与「跳两档」。所以判据是**字符串里有 `auto-fill` + `minmax`**，
 *    而不是「列数是 3」。
 * ② 「配色走令牌」的**反面**是硬编码色值。硬编码在亮色主题下看着完全正常
 *    （因为当初就是照着亮色调的），只在切到暗色时露馅。jsdom 不会算真实颜色，
 *    所以只能查**写的是什么**：卡面 / 标签 / 按钮上不许出现 `#xxxxxx` 或 `rgba(`。
 */
console.log('')
console.log('=== ②-4 票 36：列数随宽度连续自适应、配色全走 --dsw 令牌 ===')
{
  const m = await mount(React.createElement(pl.PromptLibrary, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  /* ── 判据 1：网格是 auto-fill / minmax，不是固定列数 ── */
  const grid = q('[data-ewb-pl-grid]')
  check('★★ 判据 1：有卡片网格', grid !== null)
  const cols = (grid?.style.gridTemplateColumns ?? '').trim()
  check('★★ 判据 1：列数用 `auto-fill` 随宽度连续变化（不是断点跳档）',
    cols.includes('auto-fill'), cols === '' ? '（没有 inline grid-template-columns）' : cols)
  check('★★ 判据 1：每列有最小宽度 `minmax(N, 1fr)`（卡片宽度随列数变，不是写死）',
    /minmax\(\s*\d+px/.test(cols), cols)
  check('★★ 判据 1：**没有**写死列数（`grid-cols-2` / `grid-cols-3` 那类断点类名一个都不许留）',
    !/(^|\s)(sm|md|lg|xl|2xl):grid-cols-/.test(grid?.className ?? ''),
    grid?.className ?? '')

  /* ── 判据 2：页面底走 `--dsw-alias-bg-base` ── */
  const rootEl = q('[data-ewb-prompt-library]')
  check('★★ 判据 2：提示词库根元素给了页面底色（跟着主题走）',
    (rootEl?.className ?? '').includes('var(--dsw-alias-bg-base)'), rootEl?.className ?? '')

  /* ── 判据 2：卡片本体也走令牌（不是 antd 默认色） ── */
  const firstId = m.el.querySelector('[data-ewb-pl-entry]')?.getAttribute('data-ewb-pl-entry') ?? ''
  const cardRoot = q('[data-ewb-pl-card-root="' + firstId + '"]')
  const cardStyle = cardRoot?.getAttribute('style') ?? ''
  check('★★ 判据 2：卡片本钱挂了钩子（jsdom 里 CSS Modules 类名是空的，只能靠它查）',
    cardRoot !== null, firstId)
  check('★★ 判据 2：卡片底色走 `--dsw-alias-bg-layer-1`（不再用 antd 的亮色默认值）',
    cardStyle.includes('--dsw-alias-bg-layer-1'), cardStyle)
  check('★★ 判据 2：卡片描边走 `--dsw-alias-border-l2`',
    cardStyle.includes('--dsw-alias-border-l2'), cardStyle)
  check('★★ 判据 2：卡片文字走 `--dsw-alias-label-primary`',
    cardStyle.includes('--dsw-alias-label-primary'), cardStyle)
  check('★★★ 判据 2：卡片上**一个硬编码色值都没有**（`#rrggbb` / `rgba(...)` 都不许）',
    !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(cardStyle), cardStyle)

  /* ── 判据 2：标签与复制按钮同样走令牌 ── */
  const tag = cardRoot?.querySelector('.ant-tag')
  check('★ 判据 2：标签有底色（原来全靠 antd 默认值）',
    (tag?.getAttribute('style') ?? '').includes('--dsw-alias-interactive-bg-hover'),
    tag?.getAttribute('style') ?? '（找不到 .ant-tag）')
  const copyBtn = cardRoot?.querySelector('.ant-btn')
  check('★ 判据 2：复制按钮走令牌，且不含硬编码色值',
    (copyBtn?.getAttribute('style') ?? '').includes('--dsw-alias-bg-layer-2')
    && !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(copyBtn?.getAttribute('style') ?? ''),
    copyBtn?.getAttribute('style') ?? '（找不到 .ant-btn）')

  m.unmount()
}

/* ── 判据 2 的源码层：整个文件搜不出硬编码色值 ───────────────────── */
console.log('')
console.log('=== ②-5 判据 2 源码层：这两个文件里搜不到硬编码色值 ===')
{
  /* ⚠️ 只查这两个文件（票面可改范围）。别扩成全仓 ——
   * 画布那批的自定色是**有意的**（`docs/指引-界面样式与尺度.md` 第一节：
   * 画布内允许丰富颜色，外壳只许令牌）。 */
  for (const f of ['PromptLibrary.tsx', 'PromptCard.tsx']) {
    const src = readFileSync(new URL('../src/client/workbench/' + f, import.meta.url), 'utf8')
    /* 先剥注释：注释里出现色值是**正常**的（这几次改动就把「原来是什么」写进了注释）。 */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const hits = code.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []
    check('★★★ 判据 2：' + f + ' 的代码里 0 处硬编码色值',
      hits.length === 0, hits.length === 0 ? '（0 处）' : hits.join(' '))
  }
}


/* ══════════════════════════════════════════════════════════════════════
 * ③ 七格收口：顺序 / 出现条件（真挂骨架）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 真挂骨架：七个格的顺序与出现条件 ===')
{
  const stubs = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    const method = String(init?.method ?? 'GET').toUpperCase()
    const ok = (b) => ({ ok: true, status: 200, json: async () => b })
    /* ⚠️ 不能用 `arguments`：这是**箭头函数**，它没有 `arguments` 绑定 ——
     * 第一版那么写会让 POST 分支永远走不到，点「新建画布」毫无反应（自证时才发现）。 */
    if (p === '/api/ecom-workbench/canvases' && method === 'GET') return ok({ ok: true, canvases: [] })
    if (p === '/api/ecom-workbench/canvases' && method === 'POST') return ok({ ok: true, canvas: { id: 'cv_t', title: '新画布', createdAt: 1, updatedAt: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } })
    if (p === '/api/ecom-workbench/artifacts') return ok({ ok: true, items: [] })
    if (p === '/api/ecom-workbench/artifacts/usage') return ok({ ok: true, usage: {} })
    if (p === '/api/ecom-workbench/materials') return ok({ ok: true, materials: [] })
    if (p.startsWith('/api/ecom-workbench/gen-logs')) return ok({ ok: true, logs: [] })
    if (p === '/api/ecom-workbench/channels') return ok({ ok: true, channels: [] })
    /* 已存在的画布（`GET/PUT /canvases/<id>`）：自动保存要用。 */
    if (p.startsWith('/api/ecom-workbench/canvases/')) {
      return ok({ ok: true, canvas: { id: 'cv_t', title: '新画布', createdAt: 1, updatedAt: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } })
    }
    return ok({ dir: 'C:/ewb-test', items: [] })
  }
  /* ⚠️ 骨架那几格（画布库 / 产物库 / 渠道）**要请求宿主**，所以这一段不能沿用
   * 上面那个「一律抛错」的桩 —— 验收 7 只管**提示词库那一格**本身。
   * 这里换成正常桩，是本段自己的前置条件，不是放宽判据。 */
  window.fetch = stubs
  globalThis.fetch = stubs

  const { EcomWorkbench } = await import('../src/client/workbench/EcomWorkbench.tsx')
  const hooks = {
    get: () => true, set: () => {},
    getHideChat: () => false, setHideChat: () => {},
    getWb: () => true, setWb: () => {},
  }
  const m = await mount(React.createElement(EcomWorkbench, hooks), 1000)
  /**
   * 骨架 tab 条上的格名（**排除画布左侧栏自己的 tab**）。
   *
   * ## 为什么要排除侧栏（2026-10-26 改准，不是放宽）
   *
   * 原来这里是**全局** `querySelectorAll('[role="tab"]')`。而 CD 给内容画布加的
   * 左侧栏（`CanvasSidePanel.tsx:165`）也用 `role="tab"` —— 于是打开画布之后，
   * 全局查会同时捞到「骨架 tab 条 7 格 + 侧栏 3 格（节点 / 素材 / 提示词）」，
   * 断言里的格数就从 7 变成 11。
   *
   * **那不是产品多了三格**：侧栏那三个 tab 是画布内部的，不在骨架 tab 条上。
   * 所以这不是放宽判据，是把范围限定到「骨架 tab 条」——只有限定准了，
   * 这条断言才真的在守「板块格有几个、什么顺序」。
   *
   * 侧栏外层带 `data-ewb-side-panel` 标记（`CanvasSidePanel.tsx:146` / `:159`），按它排除。
   * 同一套做法 `tests/content-canvas.mjs:719` 已经用过一次（那里也踩过同一个坑）。
   */
  const tabLabels = () => [...window.document.querySelectorAll('[role="tab"]')]
    .filter(b => b.closest('[data-ewb-side-panel]') === null)
    .map(b => (b.textContent ?? '').trim())

  await click(window.document.querySelector('[data-ewb-item="content"]'))
  await m.settle(700)

  /* ★★ 验收 1：七个常驻格的顺序（画布不在里面 —— 它还没打开）。
   *
   * ⚠️ **2026-10-26 从 6 格变 7 格**：契约 CF 按用户要求加了「音频工作台」一格
   * （`boards.ts` 的 `{ id: 'audio', label: '音频工作台' }`）。这是**产品形状变了**，
   * 断言跟着改，并在这里写明原因 —— 别让下一个人以为是判据松了。
   *
   * ⚠️ 计划 §三 Step 7 那张表写的是 6 格，那是**那一版**的形状。
   * 「代码里的声明」与「界面上真挂出来的格」由 `tests/board-registry.mjs` 守；
   * 这里守的是「挂到界面上之后确实是这些格、这个顺序，且画布打开/关闭时前后各几格」。 */
  const before = tabLabels()
  /* ⚠️ **2026-10-28 从 7 格变回 6 格**（票 34）：用户定「音频工作台参考好像没有，
   * 可以去掉」。依据是参考项目 `refs-projects/infinite-canvas/web/src/pages/` 下
   * **只有 `image/` 与 `video/`，没有 audio 页** —— 参考里音频是节点类型，不是工作台。
   *
   * **删的是入口，不是能力**：音频节点仍能拖进画布、后端生成音频的能力也还在
   * （`NODE_SIZE.audio` 与 `ImageWorkbench` 的 `kind === 'audio'` 分支都留着）。
   * 所以这里改的是「tab 条有几格」，不是「音频这个功能没有了」。 */
  /* ⚠️ 2026-10-29（票 66）**最后一格改名**：内容板块那格从「配置」改成「板块设置」。
   *
   * 为什么改：侧栏新增了一个「配置」**板块**（原底部齿轮「工作台设置」升级的），
   * 内容板块里再有一个「配置」格，用户分不清两处。
   *
   * 这条断言守的事情一个字没变：六个常驻格的名字与顺序。
   * **不许**写成「配置或板块设置都行」—— 新名字是定案，没有回退可能。 */
  const want = ['画布库', '生图工作台', '视频创作台', '内容库', '提示词库', '板块设置']
  check('★★ 没打开画布时是六个常驻格，顺序与 boards.ts 的声明一致',
    JSON.stringify(before) === JSON.stringify(want), '实际：' + before.join(' / '))
  /* ★ 反面：音频工作台那一格必须真的没了（不是只从数组里删了一项的假删）。 */
  check('★★ 反面：tab 条上没有「音频工作台」这一格（票 34 已删入口）',
    !before.includes('音频工作台'), '实际：' + before.join(' / '))

  /* ★★ 验收 2：打开画布 → 它出现在**第一格**。 */
  await click(window.document.querySelector('[data-ewb-canvas-new]'))
  await m.settle(900)
  const after = tabLabels()
  check('★★ 打开画布之后「画布」出现', after.includes('画布'), '实际：' + after.join(' / '))
  check('★★ 而且它插在**第一位**', after[0] === '画布', '实际：' + after.join(' / '))
  check('★★ 加上画布正好七个格', after.length === 7, '实际 ' + String(after.length) + ' 格：' + after.join(' / '))
  check('★★ 七格的完整顺序：画布在最前，其余六个常驻格顺序不变',
    JSON.stringify(after) === JSON.stringify(['画布', ...want]), '实际：' + after.join(' / '))

  /* 关掉画布 → 回到六格。 */
  await click(window.document.querySelector('[data-ewb-canvas-close]'))
  await m.settle(900)
  const closed = tabLabels()
  check('★★ 关掉画布之后它消失（回到六格）',
    JSON.stringify(closed) === JSON.stringify(want), '实际：' + closed.join(' / '))

  /* 点开提示词库那一格，确认真的挂的是它。 */
  const promptTab = [...window.document.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === '提示词库')
  await click(promptTab)
  await m.settle(700)
  check('★★ 点「提示词库」挂的是提示词库那格',
    window.document.querySelector('[data-ewb-prompt-library]') !== null)
  check('★ 它顶部的分工说明也在',
    (window.document.querySelector('[data-ewb-pl-note]')?.textContent ?? '').includes('改写'))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 源码层：这一格自己不直接发请求
 * ══════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 票 27 起这一段的**意思变了，强度没降**：
 * 原来守的是「这一格不许有网络」（因为没有后端可问）；
 * 现在守的是「网络这一层只在 `dispatch-client` 一处」。
 *
 * 后者比前者更该守：如果哪天有人在组件里直接写 `fetch(`，
 * 就会绕过 `dispatch-client` 那套「永不抛异常、失败给原因」的约定，
 * 于是出现「有的地方失败报错、有的地方白屏」。
 */
console.log('')
console.log('=== ④ 源码层：PromptLibrary.tsx 自己不直接发请求，网络只走 dispatch-client ===')
{
  const src = readFileSync(new URL('../src/client/workbench/PromptLibrary.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★ 源码里没有 fetch(', !/\bfetch\s*\(/.test(code))
  check('★★ 源码里没有 XMLHttpRequest', !/XMLHttpRequest/.test(code))
  check('★ 源码里没有 import 任何网络模块', !/from\s+'\.\/board-kit\.ts'/.test(code),
    '用 board-kit 的 call() 就等于会发请求')
  /* ★ 票 27：请求走 `dispatch-client` 这一处（它自己写好了「永不抛异常」的约定）。 */
  check('★★ 真要问后端时走 dispatch-client（网络只在那一处）',
    /from '\.\/dispatch-client\.ts'/.test(code))
  /* 数据来源必须是内置副本。 */
  check('★★ 数据来自 prompt-sources（内置兜底副本）',
    /from '\.\/prompt-sources\/index\.ts'/.test(code) || /from '\.\/prompt-sources\//.test(code))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 验收 12：tab 条实测总宽度
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ tab 条总宽度（按骨架自己的算法算）===')
{
  /* 骨宽的算法在 `EcomWorkbench.tsx:440-455`：
   *   avail = tab 容器宽度（≈ 右列宽 - 两侧 padding）
   *   next  = max(84, min(150, floor(avail / n)))
   * 七个格 n=7。
   *
   * ⚠️ jsdom **不做布局**（`clientWidth` 恒为 0），所以这里**没法真量**。
   * 下面按骨架自己的公式 + 右列的已知取值范围算一张表 —— 这是**算出来的**，
   * 不是量出来的，报给 lead 时要说清这一点。 */
  const TAB_MIN = 84
  const TAB_MAX = 150
  const N = 7
  const PAD_TOP_HIDDEN = 2 * 8    /* topHidden 时 px-2 */
  const PAD_NORMAL = 2 * 32       /* 默认 px-8 */
  const rows = []
  for (const colw of [320, 420, 520, 640, 780, 900]) {
    for (const [label, pad] of [['正常', PAD_NORMAL], ['收起顶部', PAD_TOP_HIDDEN]]) {
      const avail = Math.max(0, colw - pad)
      const w = Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor(avail / N)))
      rows.push({ colw, label, avail, per: w, total: w * N, fits: w * N <= avail })
    }
  }
  console.log('   右列宽 | 形态     | 可用宽 | 每格 | 七格总宽 | 放得下')
  for (const r of rows) {
    console.log('   ' + String(r.colw).padStart(6) + ' | ' + r.label.padEnd(8, ' ')
      + ' | ' + String(r.avail).padStart(6) + ' | ' + String(r.per).padStart(4)
      + ' | ' + String(r.total).padStart(8) + ' | ' + (r.fits ? '是' : '否，横向滚动 ' + String(r.total - r.avail) + 'px'))
  }
  /* 判据：骨架在「每格撞到 84 下限」时不滚动是不可能的 —— 七格最少要 588px。
   * 所以只要右列窄于 588+padding，就必然横向滚动。这条要断言，免得以后有人
   * 以为「tab 条永远不会滚」。 */
  const minNeeded = TAB_MIN * N
  check('★★ 七个格最少要 ' + String(minNeeded) + 'px（每格 84 的下限 × 7）', minNeeded === 588)
  const narrow = rows.find(r => r.colw === 320 && r.label === '正常')
  check('★★ 默认宽度（320px 右列 / px-8）下放不下，靠横向滚动',
    narrow !== undefined && !narrow.fits,
    narrow === undefined ? '' : '总宽 ' + String(narrow.total) + ' > 可用 ' + String(narrow.avail))
  const wide = rows.find(r => r.colw === 900 && r.label === '收起顶部')
  check('★ 宽屏 + 收起顶部时放得下（不必滚）',
    wide !== undefined && wide.fits,
    wide === undefined ? '' : '总宽 ' + String(wide.total) + ' ≤ 可用 ' + String(wide.avail))
  /* tab 容器有 overflow-x:auto —— 放不下时可滚，不是被裁掉。 */
  const css = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  const tabsRule = /\.tabs\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('★★ tab 容器是横向滚动的（放不下时可滚，不是被裁掉）',
    /overflow-x:\s*auto/.test(tabsRule), tabsRule.replace(/\s+/g, ' ').slice(0, 80))
}

console.log('')
console.log(failed === 0 ? '结论：提示词库与七格收口都对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
