/** 内容区限宽偏好（票 69，用户 2026-10-29）。
 *
 * ## 这一块解决的是什么
 *
 * 用户原话：「内容区限宽，这个做到设置里面去吧，浏览器、提醒、内容区限宽
 * 都做为一个 tab 的内容先。」
 *
 * 改前那个数写死在 `EcomWorkbench.tsx:85` 的 `CONTENT_MAX_WIDTH = 1440`
 * （票 49 定的）。现在它进了工作台偏好，五档可选，改完立刻生效。
 *
 * ## 判据（票面七条里属于这一块的）
 *
 * | # | 判据 | 在哪一段 |
 * |---|---|---|
 * | 2 | 那一行有下拉、五个选项齐 | ② |
 * | 3 | 缺省 1440；文件不存在时也回 1440、不报错 | ① ③ |
 * | 4 | 改成 0 时铺满（不写 maxWidth）；改成 1920 时限制是 1920 | ④ |
 * | 5 | 改了下拉**立刻生效**，不用刷新 | ④ |
 * | 6 | 坏值（`"abc"`）回 1440，不白屏 | ① |
 *
 * ## 为什么「立刻生效」要单独验
 *
 * 这是最容易做歪的一条：偏好读一次塞进 `useState` 初值，改了下拉界面不动，
 * 用户以为没生效。真做法是**订阅**（本仓库既有形态：模块级状态 + 通知）。
 * 判据不能只验「存进去了」，要验**改完之后同一个组件实例上的 DOM 变了**。
 *
 * 跑法：node scripts/run-tests.mjs layout-width
 */
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

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
globalThis.localStorage = window.localStorage
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'DocumentFragment', 'MouseEvent']) globalThis[k] = window[k]
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/* ⚠️ jsdom 没有 ResizeObserver / matchMedia —— 搬 `tests/dom-render.mjs:201` 那两句。
 * `EcomWorkbench.tsx:506` 在 effect 里 new 它，不档就整个挂载抛错。 */
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
}

let failed = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} detail - 细节。
 */
function check(name, ok, detail = '') {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!ok) failed += 1
}

const P = await import('../src/client/workbench/lib/workbench-prefs.ts')

/**
 * 调一次「本该容错」的纯函数，把它抛的错**变成一条断言失败**。
 *
 * ## 为什么要包这一层
 *
 * 票面要求「把坏值处理改成抛错 → 『坏值回 1440』必须红」。
 * 不包的话，抛错会让整份测试以 `Error` 崩掉 —— 那确实也是红，
 * 但**看不出红在哪一条**，而且后面几十条一条都不跑（与票 56 那次
 * `.layoutGroup` 找不到时 7 条静默不执行是同一个形状）。
 *
 * 包一层之后：抛错 = 这一条断言红 + 把错误原话打出来，
 * 后面的断言照跑。这是**提高诊断质量**，不是放宽判据 ——
 * 判据仍然是「必须返回 1440」，抛错照样过不了。
 *
 * @param fn - 待调函数。
 * @returns `{ ok, value, err }`。
 */
function safe(fn) {
  try {
    return { ok: true, value: fn(), err: '' }
  } catch (e) {
    return { ok: false, value: undefined, err: String(e?.message ?? e) }
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：五档、缺省、坏值容错
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 纯函数：五档、缺省 1440、坏值回缺省 ===')
{
  check('★★ 判据 2：五档就是 不限宽 / 1200 / 1440 / 1680 / 1920',
    JSON.stringify([...P.CONTENT_MAX_WIDTHS]) === JSON.stringify([0, 1200, 1440, 1680, 1920]),
    [...P.CONTENT_MAX_WIDTHS].join(','))
  check('★★ 判据 3：缺省值是 1440（与票 49 那个常量同值，升级后观感不变）',
    P.DEFAULT_CONTENT_MAX_WIDTH === 1440, String(P.DEFAULT_CONTENT_MAX_WIDTH))
  check('★ 缺省值在五档里', [...P.CONTENT_MAX_WIDTHS].includes(P.DEFAULT_CONTENT_MAX_WIDTH))

  /* 文件不存在 / 空串 → 全默认。 */
  {
    const r = safe(() => P.normalizeContentMaxWidth(undefined))
    check('★★ 判据 3：localStorage 里没有这一项时回 1440（不是 undefined、不抛错）',
      r.ok && r.value === 1440, r.ok ? String(r.value) : '抛错了：' + r.err)
  }
  {
    const r = safe(() => P.normalizeContentMaxWidth(''))
    check('★ 空串也回 1440', r.ok && r.value === 1440, r.ok ? String(r.value) : '抛错了：' + r.err)
  }
  check('★ JSON 里没有这个键时，读出来是 1440',
    P.readPrefs('{}').contentMaxWidth === 1440, String(P.readPrefs('{}').contentMaxWidth))

  /* 坏值：一律回 1440，不抛错。 */
  const bads = ['abc', 999, -1, 1500, NaN, null, {}, [], '1440.5']
  {
    const results = bads.map(v => ({ v, r: safe(() => P.normalizeContentMaxWidth(v)) }))
    const badOk = results.every(({ r }) => r.ok && r.value === 1440)
    check('★★ 判据 6：坏值（abc / 999 / -1 / 1500 / NaN / null / {} / [] / "1440.5"）全回 1440，不抛错',
      badOk, results.map(({ v, r }) => JSON.stringify(v) + '→' + (r.ok ? String(r.value) : '抛错:' + r.err)).join(' '))
  }
  {
    const r = safe(() => P.readPrefs('{坏').contentMaxWidth)
    check('★★ 判据 6：整份 JSON 被写坏也不崩，回默认',
      r.ok && r.value === 1440, r.ok ? String(r.value) : '抛错了：' + r.err)
  }

  /* 五档都认。 */
  check('★★ 判据 4：五档里的值都能原样读回来（含 0 = 不限宽）',
    [0, 1200, 1440, 1680, 1920].every(v => P.normalizeContentMaxWidth(v) === v),
    [0, 1200, 1440, 1680, 1920].map(v => String(v) + '→' + String(P.normalizeContentMaxWidth(v))).join(' '))
  check('★ 字符串形式的数字也认（localStorage 手改过的那种）',
    P.normalizeContentMaxWidth('1920') === 1920, String(P.normalizeContentMaxWidth('1920')))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 读回来的偏好（`readPrefs` 走真 localStorage）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 走真 localStorage：写进去读得回来 ===')
{
  window.localStorage.removeItem(P.PREFS_KEY)
  check('★★ 判据 3：localStorage 里一次都没写过 → 1440',
    P.readPrefs().contentMaxWidth === 1440, String(P.readPrefs().contentMaxWidth))

  /* 写一份「只改了限宽」的，别的字段保持默认。 */
  P.writePrefs({ ...P.DEFAULT_PREFS, contentMaxWidth: 1920 })
  check('★★ 判据 4：写进去 1920 读得回来',
    P.readPrefs().contentMaxWidth === 1920, String(P.readPrefs().contentMaxWidth))
  check('★ 别的字段没被顺手改掉（count 仍是 1）', P.readPrefs().count === 1)

  /* 手改坏：只坏这一个字段，其余照用。 */
  window.localStorage.setItem(P.PREFS_KEY, JSON.stringify({
    count: 3, systemPrompt: '你好', canvasTheme: 'dark', contentMaxWidth: 'abc',
  }))
  {
    const r = safe(() => P.readPrefs())
    check('★★ 判据 6：只坏限宽这一项 → 它回 1440，**别的三项照用**',
      r.ok && r.value.contentMaxWidth === 1440 && r.value.count === 3
        && r.value.systemPrompt === '你好' && r.value.canvasTheme === 'dark',
      r.ok ? JSON.stringify(r.value) : '抛错了：' + r.err)
  }
  window.localStorage.removeItem(P.PREFS_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 模块级共享状态 + 订阅（「立刻生效」的机制层）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 订阅：改一次，订阅者收到通知 ===')
{
  let calls = 0
  const off = P.subscribeWorkbenchPrefs(() => { calls += 1 })
  check('★★ 判据 5：订阅之后改偏好，订阅者**收到通知**', (() => {
    P.updateWorkbenchPrefs({ contentMaxWidth: 1680 })
    return calls === 1
  })(), '收到 ' + String(calls) + ' 次')
  check('★ 改完内存里的当前值也变了（不用等下一轮读盘）',
    P.currentWorkbenchPrefs().contentMaxWidth === 1680,
    String(P.currentWorkbenchPrefs().contentMaxWidth))
  check('★★ 判据 5：同时也落盘了（刷新页面之后还在）',
    P.readPrefs().contentMaxWidth === 1680, String(P.readPrefs().contentMaxWidth))
  check('★ 快照引用稳定（同一个对象，`useSyncExternalStore` 才不会无限重渲染）',
    P.currentWorkbenchPrefs() === P.currentWorkbenchPrefs())
  off()
  P.updateWorkbenchPrefs({ contentMaxWidth: 1440 })
  check('★ 退订之后不再收到通知', calls === 1, '仍然 ' + String(calls) + ' 次')
}

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/**
 * 挂一个组件并等副作用跑完。
 * @param {object} el - React 元素。
 * @returns 句柄。
 */
async function mount(el) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await settle() })
  return {
    el: hostEl,
    async settle() { await act(async () => { await settle() }) },
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 2 / 4 / 5：设置里那一行 + 改完立刻生效
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 设置里那一行 + 改完立刻生效 ===')
{
  window.localStorage.removeItem(P.PREFS_KEY)
  /* 让模块缓存也回到默认（纯函数与缓存是两回事，这里要一起重置）。 */
  P.updateWorkbenchPrefs({ contentMaxWidth: 1440 })

  const { LayoutSettings } = await import('../src/client/workbench/WorkspaceSettings.tsx')
  const m = await mount(React.createElement(LayoutSettings, {}))
  const sel = m.el.querySelector('[data-ewb-layout-width]')
  check('★★ 判据 2：有「内容区限宽」那个下拉', sel !== null)
  const opts = [...(sel?.querySelectorAll('option') ?? [])].map(o => o.getAttribute('value'))
  check('★★ 判据 2：五个选项齐、值就是五档',
    JSON.stringify(opts) === JSON.stringify(['0', '1200', '1440', '1680', '1920']),
    opts.join(','))
  const texts = [...(sel?.querySelectorAll('option') ?? [])].map(o => (o.textContent ?? '').trim())
  check('★ 「0」那一档显示成「不限宽」（不是显示 0 让人以为没设）',
    texts[0] === '不限宽', texts.join(' / '))
  check('★★ 判据 3：界面上选中的就是 1440', sel?.value === '1440', String(sel?.value))
  /* 判据 9（票 68 定下的规矩）：看不出后果的开关才写说明；这一项看得出，所以不写。 */
  const secText = (m.el.textContent ?? '').replace(/\s+/g, '')
  check('★★ 这一块没有说明文字（拖宽窗口就看得出后果，不需要解释）',
    secText === '布局内容区限宽' || secText === '布局内容区限宽不限宽1200144016801920' || secText.length < 30,
    secText.slice(0, 60))

  /* ★ 判据 5：改下拉 → **同一个组件实例**的界面跟着变。 */
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  await act(async () => {
    setter.call(sel, '1920')
    sel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await settle() })
  check('★★ 判据 5：改了下拉，界面上的值立刻变成 1920（不用刷新）',
    m.el.querySelector('[data-ewb-layout-width]')?.value === '1920',
    String(m.el.querySelector('[data-ewb-layout-width]')?.value))
  check('★★ 判据 5：也确实存下来了', P.readPrefs().contentMaxWidth === 1920,
    String(P.readPrefs().contentMaxWidth))
  m.unmount()
  window.localStorage.removeItem(P.PREFS_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 判据 4：内容主体那一层的 maxWidth 跟着变（0 = 不写这个样式）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 内容主体的 maxWidth 跟着偏好走 ===')
{
  const { EcomWorkbench } = await import('../src/client/workbench/EcomWorkbench.tsx')
  const realFetch = window.fetch
  window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/ui/prefs')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, prefs: { topHidden: false, navCollapsed: false, libW: 260, legend: true, nodeW: 300 } }) }
    }
    return realFetch(url, init)
  }

  /**
   * 挂一次工作台，读内容主体那一层的内联 `maxWidth` 与外层容器的 `className`。
   *
   * @param topHidden - 顶部栏收不收起（`/ui/prefs` 桩按它回）。
   * @returns `{ mw, outerCls, handle }`。
   */
  const readMain = async (topHidden = false) => {
    /* ⚠️ **不能靠改 `/ui/prefs` 的桩来切态**（实测踩过）。
     *
     * `ensureUiPrefsLoaded`（`dispatch-client.ts:1153`）是**幂等**的 ——
     * 它用一个模块级 `prefsFlight` 记住第一次那次请求，之后永远不再发。
     * 所以同一个测试进程里第一次挂载就把 `topHidden: false` 固化下来了，
     * 后面几次改桩拿到的还是旧值（症状：收起态里仍然有 `px-8`）。
     *
     * 正确的切态方式是**广播**：`adoptUiPrefs`（`:1171`）就是给这个用的
     * （它内部走 `publishUiPrefs`，所有订阅者立刻收到）。
     * 这也是真实路径 —— 用户在界面上点「收起顶部」时，走的就是保存成功后广播。 */
    const { adoptUiPrefs } = await import('../src/client/workbench/dispatch-client.ts')
    adoptUiPrefs({ topHidden, navCollapsed: false, libW: 260, legend: true, nodeW: 300 })
    const m = await mount(React.createElement(EcomWorkbench, {
      get: () => true, set: () => {},
      getHideChat: () => false, setHideChat: () => {},
      getWb: () => true, setWb: () => {},
    }))
    const el = m.el.querySelector('[data-ewb-content-main]')
    /* 外层容器 = 内容主体那一层的**父节点**（票 73 的边距挂在它上面）。 */
    const outer = el?.parentElement ?? null
    const r = {
      mw: el?.style?.maxWidth ?? '',
      outerCls: typeof outer?.className === 'string' ? outer.className : '',
      handle: m,
    }
    return r
  }

  /* ① 1920。 */
  P.updateWorkbenchPrefs({ contentMaxWidth: 1920 })
  const a = await readMain()
  check('★★ 判据 4：偏好是 1920 时，内容主体的内联 maxWidth 就是 1920px',
    a.mw === '1920px', JSON.stringify(a.mw))
  a.handle.unmount()

  /* ② 0 = 不限宽 → **不写这个样式**（不是 0px、也不是 none）。 */
  P.updateWorkbenchPrefs({ contentMaxWidth: 0 })
  const b = await readMain()
  check('★★ 判据 4：偏好是 0（不限宽）时，**不写** maxWidth（铺满）',
    b.mw === '', JSON.stringify(b.mw))
  check('★★ 判据 4：而且不是 `0px` 或 `none` 那种「写了但没有」的形态',
    b.mw !== '0px' && b.mw !== 'none', JSON.stringify(b.mw))
  b.handle.unmount()

  /* ③ **立刻生效**：挂在同一个实例上改偏好 → DOM 跟着变。
   *
   * 这一条与 ④ 段那条不同：那条验的是设置面板自己，这条验的是
   * **另一个组件**（`EcomWorkbench`）跟着变 —— 跨组件才是「立刻生效」的真考场。 */
  P.updateWorkbenchPrefs({ contentMaxWidth: 1440 })
  const c = await readMain()
  check('★ 起点是 1440px', c.mw === '1440px', JSON.stringify(c.mw))
  await act(async () => {
    P.updateWorkbenchPrefs({ contentMaxWidth: 1680 })
    await settle()
  })
  const mwNow = c.handle.el.querySelector('[data-ewb-content-main]')?.style?.maxWidth ?? ''
  check('★★ 判据 5：**不重新挂载**，改偏好之后同一个实例上的 maxWidth 立刻变成 1680px',
    mwNow === '1680px', JSON.stringify(mwNow))
  await act(async () => {
    P.updateWorkbenchPrefs({ contentMaxWidth: 0 })
    await settle()
  })
  const mwNone = c.handle.el.querySelector('[data-ewb-content-main]')?.style?.maxWidth ?? ''
  check('★★ 判据 5：再改成不限宽，同一个实例上那个样式当场消失',
    mwNone === '', JSON.stringify(mwNone))
  c.handle.unmount()

  /* ══════════════════════════════════════════════════════════════════
   * ★ 票 73（2026-10-29）：收起态边距归零 + 限宽失效；展开态恢复现状
   *
   * 用户原话：「收起顶部栏后两边边距取消，内容区域宽度也不应该限制这个模式……
   * 画布使用时不该被限制宽度，而其他的界面如果不限制宽度很多内容会过宽
   * 导致视觉不好看。可能有更好的方式处理，但是先手动把。」
   *
   * ⚠️ 这一组与上面那组的**区别**：上面验「偏好变了 DOM 跟着变」，
   * 这一组验「同一个偏好值在不同顶部状态下的**表现不同**」。
   * 两条都要有 —— 只验前者的话，「收起态也照样限宽」不会被发现。
   * ══════════════════════════════════════════════════════════════════ */
  console.log('')
  console.log('=== ⑥ 票 73：收起态边距归零、限宽失效；展开态照旧 ===')

  /* ① 展开态：边距 px-8、限宽 1440px（恢复现状）。 */
  P.updateWorkbenchPrefs({ contentMaxWidth: 1440 })
  const open1 = await readMain(false)
  check('★★ 判据 3：展开态外层仍是 px-8（现状不变）',
    /(^|\s)px-8(\s|$)/.test(open1.outerCls), open1.outerCls)
  check('★★ 判据 3：展开态内容主体的 maxWidth 就是偏好值 1440px',
    open1.mw === '1440px', JSON.stringify(open1.mw))
  check('★ 判据 5：上下边距 pb-4 pt-5 一处没少（用户没要求改上下）',
    /(^|\s)pb-4(\s|$)/.test(open1.outerCls) && /(^|\s)pt-5(\s|$)/.test(open1.outerCls),
    open1.outerCls)
  open1.handle.unmount()

  /* ② 收起态：边距归零 + 限宽失效。 */
  const hidden1 = await readMain(true)
  check('★★ 判据 1：收起态外层**没有** px-8、也**没有** px-2（横向边距归零）',
    !/(^|\s)px-8(\s|$)/.test(hidden1.outerCls) && !/(^|\s)px-2(\s|$)/.test(hidden1.outerCls),
    hidden1.outerCls)
  check('★ 判据 1：而且确实是 px-0（不是「碰巧没有横向类」）',
    /(^|\s)px-0(\s|$)/.test(hidden1.outerCls), hidden1.outerCls)
  check('★★ 判据 2（本票核心）：收起态内容主体的 maxWidth 是**空串**（限宽失效）',
    hidden1.mw === '', JSON.stringify(hidden1.mw))
  check('★★ 判据 2：而且不是 `1440px` 那种「照样钳住」',
    hidden1.mw !== '1440px', JSON.stringify(hidden1.mw))
  check('★ 判据 5：收起态的上下边距同样没少',
    /(^|\s)pb-4(\s|$)/.test(hidden1.outerCls) && /(^|\s)pt-5(\s|$)/.test(hidden1.outerCls),
    hidden1.outerCls)
  hidden1.handle.unmount()

  /* ③ 判据 4：收起再展开，**偏好值本身不变**。
   *
   * ⚠️ 这一条必须验「值还在」，不能只验「展开后又限宽了」——
   * 后者有个更蠢的实现方式能满足：收起时把偏好写成 0。那样用户
   * 收起一次再展开，自己选的档位就没了（而且他可能根本没发现）。 */
  P.updateWorkbenchPrefs({ contentMaxWidth: 1680 })
  const h2 = await readMain(true)
  check('★ 收起态（偏好 1680）也不写 maxWidth', h2.mw === '', JSON.stringify(h2.mw))
  check('★★ 判据 4：收起之后偏好值**本身没被改**（仍是 1680，不是被写成 0）',
    P.readPrefs().contentMaxWidth === 1680, String(P.readPrefs().contentMaxWidth))
  h2.handle.unmount()
  const o2 = await readMain(false)
  check('★★ 判据 4：再展开，限宽**回到用户选的那一档** 1680px（不是 1440 缺省）',
    o2.mw === '1680px', JSON.stringify(o2.mw))
  o2.handle.unmount()

  /* ④ 反面：偏好选「不限宽」(0) 时，展开态也不写 maxWidth —— 与收起态**两种理由同一个结果**。
   *
   * 这条是防「把两个条件写成互斥」：如果实现成
   * `topHidden ? undefined : (contentMaxWidth === 0 ? undefined : …)` 之外的怪形状，
   * 这里会红。两个条件必须都能单独生效。 */
  P.updateWorkbenchPrefs({ contentMaxWidth: 0 })
  const z = await readMain(false)
  check('★★ 展开态 + 偏好 0（不限宽）时也不写 maxWidth（两个条件各自都能生效）',
    z.mw === '', JSON.stringify(z.mw))
  z.handle.unmount()

  window.fetch = globalThis.fetch = realFetch
  P.updateWorkbenchPrefs({ contentMaxWidth: 1440 })
  window.localStorage.removeItem(P.PREFS_KEY)
}

console.log('')
console.log(failed === 0 ? '结论：内容区限宽接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
