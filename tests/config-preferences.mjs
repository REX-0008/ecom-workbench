/** 配置页 · 偏好（票 05，用户 m00109）。
 *
 * ## 这一份盯什么
 *
 * 1. **偏好能改、能存、刷新后还在**（存 localStorage，键 `ewb.workbenchPrefs`）；
 * 2. **改了「一次生成几张」→ 生图工作台打开时那个数真的是新值**。
 *    判据落在「工作台读到了它」，不是「存进去了」—— 存进去没人读是本项目
 *    反复踩过的假绿（`pitfalls/假防线-看着写了其实不生效.md`）；
 * 3. **两项不支持的如实写在界面上**（音频三项 / 系统提示词）。
 *    这两条是**反面判据**：抓「造了个假开关」与「悄悄能配但不生效」。
 *
 * ## ⚠️ 票面与事实的差
 *
 * 票面写「生图/视频工作台打开时按它填」。**核过：视频工作台没有张数这一项** ——
 * `formFields('video')`（`ImageWorkbench.tsx:330`）是
 * `['prompt','model','seconds','size','ref','submit']`，没有 `count`；
 * `submitBody` 也只在 `kind === 'image'` 时才发 `count`（`:373`）。
 * 所以预填只对生图（与走同一份实现的音频格）有意义，视频那个数根本没地方显示。
 * **这不是漏做**：给视频加一个不生效的张数框，就是本票明令禁止的假开关。
 *
 * ## 跑法
 *
 * ```
 * node scripts/run-tests.mjs config-preferences
 * ```
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
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.SVGElement = window.SVGElement
globalThis.DocumentFragment = window.DocumentFragment
globalThis.MouseEvent = window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const origGCS = window.getComputedStyle.bind(window)
window.getComputedStyle = (el) => origGCS(el)
globalThis.getComputedStyle = window.getComputedStyle
window.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = window.ResizeObserver
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

/* 假宿主：工作台要的那几条。**换成会抛错的桩也不该影响偏好** ——
 * 偏好是本地存储，一个请求都不该为它发。 */
const hits = []
const host = async (url) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  hits.push(p)
  if (p.startsWith('/api/ecom-workbench/gen-logs')) return { ok: true, status: 200, json: async () => ({ ok: true, logs: [] }) }
  if (p.startsWith('/api/ecom-workbench/gen-models')) return { ok: true, status: 200, json: async () => ({ ok: true, models: [], items: [] }) }
  if (p.startsWith('/api/ecom-workbench/generate')) return { ok: true, status: 200, json: async () => ({ ok: true, tasks: [], items: [] }) }
  if (p === '/api/ecom-workbench/model-defaults') return { ok: true, status: 200, json: async () => ({ ok: true, defaults: {}, status: {}, broken: {} }) }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}
window.fetch = host
globalThis.fetch = host

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/** 挂一个组件，等副作用跑完。 */
async function mount(el) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await settle() })
  return {
    el: hostEl,
    async settle() { await act(async () => { await settle() }) },
    async rerender(next) { await act(async () => { root.render(next) }); await act(async () => { await settle() }) },
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/** 在输入框里打字（受控 input 要走原生 setter + input 事件）。 */
async function type(el, text) {
  if (el === null || el === undefined) return
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

/** 失焦（张数是在失焦时定型的）。
 *
 * ⚠️ React 17 起 `onBlur` 实际挂在 **`focusout`** 上（它冒泡，`blur` 不冒泡）——
 * 所以这里派发的是 `focusout`。派 `blur` 的话 React 收不到，断言会假红。 */
async function blur(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })) })
  await act(async () => { await settle() })
}

const wp = await import('../src/client/workbench/lib/workbench-prefs.ts')
const { PreferencesSettings } = await import('../src/client/workbench/PreferencesSettings.tsx')
const iw = await import('../src/client/workbench/ImageWorkbench.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：默认值 / 容错读 / 夹范围 / 写回
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：默认值、容错读、夹范围 ===')
{
  check('★★ 默认张数是 1（与改动前写死的 EMPTY_DRAFT.count 逐字相同）',
    wp.DEFAULT_PREFS.count === 1 && iw.EMPTY_DRAFT.count === '1',
    String(wp.DEFAULT_PREFS.count) + ' / ' + iw.EMPTY_DRAFT.count)
  check('★★ 默认系统提示词是空串（空 = 不发这个字段）', wp.DEFAULT_PREFS.systemPrompt === '')
  check('★ 张数上下限是 1–4', wp.COUNT_MIN === 1 && wp.COUNT_MAX === 4)

  /* 容错读：坏值一律退回默认，**不抛** —— 抛了整个配置页打不开。 */
  check('★★ 空串读回默认', wp.readPrefs('').count === 1)
  check('★★ 不是 JSON 也退回默认（不抛）', wp.readPrefs('{坏掉的').count === 1)
  check('★★ 是数组也退回默认', wp.readPrefs('[1,2]').count === 1)
  check('★★ null 也退回默认', wp.readPrefs(null).count === 1)
  check('★★ 张数超上界夹到 4', wp.readPrefs('{"count":999}').count === 4)
  check('★★ 张数低于下界夹到 1', wp.readPrefs('{"count":-5}').count === 1)
  check('★★ 张数写成字符串时退回默认（不把 "3" 当 3）',
    wp.readPrefs('{"count":"3"}').count === 1, String(wp.readPrefs('{"count":"3"}').count))
  check('★ 系统提示词不是字符串时退回空串',
    wp.readPrefs('{"systemPrompt":123}').systemPrompt === '')
  check('★ 系统提示词超长被截断（防塞几 MB 进 localStorage）',
    wp.readPrefs(JSON.stringify({ systemPrompt: 'x'.repeat(wp.SYSTEM_PROMPT_MAX + 100) })).systemPrompt.length === wp.SYSTEM_PROMPT_MAX)

  check('★★ isDefaultPrefs 认得出默认', wp.isDefaultPrefs(wp.DEFAULT_PREFS))
  check('★ 改过就不是默认', !wp.isDefaultPrefs(wp.patchPrefs(wp.DEFAULT_PREFS, { count: 3 })))

  /* 写 → 读回来。 */
  wp.writePrefs({ count: 3, systemPrompt: '按写实风格' })
  const back = wp.readPrefs()
  check('★★ 写进去再读回来是同一份',
    back.count === 3 && back.systemPrompt === '按写实风格',
    String(back.count) + ' / ' + back.systemPrompt)
  check('★★ 用的键是 ewb.workbenchPrefs（不与 canvasPrefs 撞）',
    wp.PREFS_KEY === 'ewb.workbenchPrefs' && window.localStorage.getItem(wp.PREFS_KEY) !== null,
    wp.PREFS_KEY)

  /* 清掉，下面每段自己设。 */
  window.localStorage.removeItem(wp.PREFS_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 边界：两项不支持的如实写在界面上
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 两项不支持的：不许造开关，要如实说明 ===')
{
  check('★★ 音频三项判定为不支持', wp.AUDIO_EXTRAS_SUPPORTED === false)
  check('★★ 系统提示词判定为还没接进调用', wp.SYSTEM_PROMPT_WIRED === false)

  const m = await mount(React.createElement(PreferencesSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)

  /* 音频：有说明、**没有控件**。 */
  const audioNote = q('[data-ewb-prefs-audio-note]')
  check('★★★ 音频那块显示了「不支持」的说明',
    audioNote !== null && (audioNote.textContent ?? '').includes('暂不支持'),
    (audioNote?.textContent ?? '（没有）').slice(0, 40))
  check('★★★ 说明里说清了为什么（内置音频是音乐生成，没有这三项）',
    (audioNote?.textContent ?? '').includes('音乐生成')
    && (audioNote?.textContent ?? '').includes('音色'),
    (audioNote?.textContent ?? '').slice(0, 60))
  check('★★★ 说明里指了下一步（要接得先加字段）',
    (audioNote?.textContent ?? '').includes('先在生成请求与 ComfyUI 槽位里加上对应字段'))
  /* ★ 反面：这一块里**不许有任何输入控件**（灰掉的也不行）。 */
  const audioSection = q('[data-ewb-prefs-section="audio"]')
  check('★★★ 音频那块里一个控件都没有（灰框会被当成加载中）',
    audioSection !== null
    && audioSection.querySelectorAll('input, select, textarea').length === 0,
    '控件数 ' + String(audioSection?.querySelectorAll('input, select, textarea').length ?? -1))

  /* 系统提示词：有文本框（要存），但**必须写明没接上**。 */
  const sysNote = q('[data-ewb-prefs-system-note]')
  check('★★★ 系统提示词那块写明了「还没接进模型调用」',
    sysNote !== null && (sysNote.textContent ?? '').includes('还没有接进模型调用'),
    (sysNote?.textContent ?? '（没有）').slice(0, 40))
  check('★★★ 说明里说了怎么才能生效（引擎侧加回落）',
    (sysNote?.textContent ?? '').includes('回落'))
  check('★★ 但文本框本身在（存还是要存的）', q('[data-ewb-prefs-system]') !== null)

  /* 文案纪律 R6。 */
  const allText = m.el.textContent ?? ''
  check('★★ 这一格的文案里没有第二人称', !allText.includes('你') && !allText.includes('您'),
    allText.includes('你') ? '出现了「你」' : '')
  check('★★ 这一格的文案里没有 markdown 加粗标记', !allText.includes('**'),
    allText.includes('**') ? '出现了 **' : '')
  check('★★ 这一格的文案里没有疑问句', !/[？?]/.test(allText))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 能改、能存、刷新后还在
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 能改、能存、刷新后还在 ===')
{
  window.localStorage.removeItem(wp.PREFS_KEY)
  const m = await mount(React.createElement(PreferencesSettings, { active: true }))

  /* 默认 1。 */
  check('★ 一进来张数框是 1', m.el.querySelector('[data-ewb-prefs-count]')?.value === '1',
    m.el.querySelector('[data-ewb-prefs-count]')?.value ?? '')

  /* 改成 3（打字 + 失焦定型）。 */
  await type(m.el.querySelector('[data-ewb-prefs-count]'), '3')
  await blur(m.el.querySelector('[data-ewb-prefs-count]'))
  check('★★ 改成 3 之后输入框是 3', m.el.querySelector('[data-ewb-prefs-count]')?.value === '3',
    m.el.querySelector('[data-ewb-prefs-count]')?.value ?? '')
  check('★★ 已经真的落进 localStorage 了',
    wp.readPrefs().count === 3, String(wp.readPrefs().count))

  /* 超界要夹回来（打 99 → 失焦变 4）。 */
  await type(m.el.querySelector('[data-ewb-prefs-count]'), '99')
  await blur(m.el.querySelector('[data-ewb-prefs-count]'))
  check('★★ 打 99 失焦后夹到 4（不是存了个 99）',
    m.el.querySelector('[data-ewb-prefs-count]')?.value === '4' && wp.readPrefs().count === 4,
    (m.el.querySelector('[data-ewb-prefs-count]')?.value ?? '') + ' / ' + String(wp.readPrefs().count))

  /* 系统提示词。 */
  const sysEl = m.el.querySelector('[data-ewb-prefs-system]')
  const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  await act(async () => {
    taSetter.call(sysEl, '按写实风格，不要卡通')
    sysEl.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await settle() })
  check('★★ 系统提示词也存进去了',
    wp.readPrefs().systemPrompt === '按写实风格，不要卡通', wp.readPrefs().systemPrompt)

  m.unmount()

  /* ★ 刷新：重新挂一次（等价于关掉再打开这一格）。 */
  const m2 = await mount(React.createElement(PreferencesSettings, { active: true }))
  check('★★★ 重新挂上之后，张数还是 4（刷新后还在）',
    m2.el.querySelector('[data-ewb-prefs-count]')?.value === '4',
    m2.el.querySelector('[data-ewb-prefs-count]')?.value ?? '')
  check('★★★ 重新挂上之后，系统提示词还在',
    m2.el.querySelector('[data-ewb-prefs-system]')?.value === '按写实风格，不要卡通',
    m2.el.querySelector('[data-ewb-prefs-system]')?.value ?? '')
  m2.unmount()

  window.localStorage.removeItem(wp.PREFS_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 2：改了偏好 → **生图工作台打开时那个数真的是新值**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这一段是本票最重要的一条：判据落在「工作台读到了它」，
 * 不是「存进去了」。存进去没人读正是这一整类的病。
 */
console.log('')
console.log('=== ④ 工作台真读到了（不是只存进去） ===')
{
  const countBox = m => m.el.querySelector('[data-ewb-gen-submit-count]')

  /* ── 默认（没存过任何偏好）：张数框是 1 ── */
  window.localStorage.removeItem(wp.PREFS_KEY)
  const m0 = await mount(React.createElement(iw.ImageWorkbench, { active: true, kind: 'image', title: '生图工作台' }))
  check('★★ 没设偏好时，生图工作台张数框是 1（默认不变）',
    countBox(m0)?.value === '1', countBox(m0)?.value ?? '')
  m0.unmount()

  /* ── 设成 3：打开就是 3 ── */
  wp.writePrefs({ count: 3, systemPrompt: '' })
  const m1 = await mount(React.createElement(iw.ImageWorkbench, { active: true, kind: 'image', title: '生图工作台' }))
  check('★★★ 偏好设成 3 → 生图工作台打开时张数框就是 3（判据落在读到了没有）',
    countBox(m1)?.value === '3', countBox(m1)?.value ?? '')
  m1.unmount()

  /* ── 设成 4：打开就是 4（换一个值再验一次，防「碰巧是默认」） ── */
  wp.writePrefs({ count: 4, systemPrompt: '' })
  const m2 = await mount(React.createElement(iw.ImageWorkbench, { active: true, kind: 'image', title: '生图工作台' }))
  check('★★★ 偏好设成 4 → 打开时就是 4', countBox(m2)?.value === '4', countBox(m2)?.value ?? '')

  /* ── 用户在表单里手填过的数，切走再切回来不许被盖掉 ──
   *
   * 做法：先把手填成 2，然后 active 变成 false 再变 true（等价于切到别的格再回来）。 */
  await type(countBox(m2), '2')
  await m2.rerender(React.createElement(iw.ImageWorkbench, { active: false, kind: 'image', title: '生图工作台' }))
  await m2.rerender(React.createElement(iw.ImageWorkbench, { active: true, kind: 'image', title: '生图工作台' }))
  check('★★★ 手填过 2 的草稿，切走再回来**不被偏好盖掉**',
    countBox(m2)?.value === '2', countBox(m2)?.value ?? '')
  m2.unmount()

  /* ── 视频工作台没有张数这一项：如实断言，不许凭空造一个框 ── */
  const { VideoWorkbench } = await import('../src/client/workbench/VideoWorkbench.tsx')
  wp.writePrefs({ count: 4, systemPrompt: '' })
  const mv = await mount(React.createElement(VideoWorkbench, { active: true }))
  check('★★ 视频工作台**没有**张数框（票面写「生图/视频」，但视频这一项本来就没有）',
    mv.el.querySelector('[data-ewb-gen-submit-count]') === null)
  check('★★ 视频工作台确实挂了（不是整格没渲染）',
    mv.el.querySelector('[data-ewb-gen-submit-seconds]') !== null)
  mv.unmount()

  window.localStorage.removeItem(wp.PREFS_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 源码层：三处接线真的在
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 源码层：工作台真的读了偏好（不是碰巧）===')
{
  const { readFileSync } = await import('node:fs')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const workbench = strip(readFileSync(new URL('../src/client/workbench/ImageWorkbench.tsx', import.meta.url), 'utf8'))
  check('★★ 工作台里真调了读偏好的函数',
    /readWorkbenchPrefs\s*\(/.test(workbench) || /readPrefs\s*\(/.test(workbench))
  check('★★ 读到的值真进了草稿的 count（不是读了不用）',
    /count:\s*String\(p\.count\)/.test(workbench))
  check('★★ 预填只在草稿还是默认值时发生（不盖用户手填的）',
    /cur\.count === EMPTY_DRAFT\.count/.test(workbench))

  const tabs = strip(readFileSync(new URL('../src/client/workbench/ConfigTabs.tsx', import.meta.url), 'utf8'))
  check('★★ 配置页真的挂了偏好组件（不是还留着空壳）',
    /PreferencesSettings/.test(tabs) && /tab === 'preferences'/.test(tabs))
  check('★★★ 那个「暂无设置项」的空壳已经删了',
    !/暂无设置项/.test(tabs))
}

console.log('')
console.log(failed === 0 ? '结论：偏好三项都对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
