/** 配置页的五个 tab（票 10，2026-10-27）。
 *
 * ## 这一份盯什么
 *
 * 票 10 把配置页从「四块竖着叠一页」改成五个 tab。这份测试盯三件事：
 *
 * 1. **五个 tab 都能点开**，而且每块内容只在自己的 tab 下出现；
 * 2. **不渲染的 tab 不挂组件** —— 五个 tab 一起渲染等于一进配置页就发五路请求，
 *    其中四路用户根本没打开。这一条只看「别的块在不在」不够，还要看请求数；
 * 3. **刷新页面回到上次那个 tab**（`localStorage`，键 `ewb.configTab`）。
 *
 * ## 为什么不塞进 `config-routes`
 *
 * 那份测的是后端的路由层（HTTP），这份要挂真组件、要 jsdom。混在一起会让
 * `config-routes` 从 0.7 秒涨到几秒，而它有一条 5 秒的耗时看门狗。
 *
 * ## 跑法
 *
 * ```
 * node scripts/run-tests.mjs config-tabs
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

/* ── 假宿主：五块各自要的那几条路由 ──
 *
 * 只回形状最小的东西。**每一条都记一次**（`hits`），用来判「不渲染的 tab 不发请求」。 */
const hits = []
const storageReply = {
  ok: true,
  config: {},
  dirs: [
    { key: 'canvases', label: '画布', path: 'D:\\ecom\\canvases', isDefault: true, defaultPath: 'D:\\ecom\\canvases' },
    { key: 'artifacts', label: '产物', path: 'D:\\ecom\\artifacts', isDefault: true, defaultPath: 'D:\\ecom\\artifacts' },
    { key: 'materials', label: '素材', path: 'D:\\ecom\\materials', isDefault: true, defaultPath: 'D:\\ecom\\materials' },
    { key: 'genLogs', label: '生成记录', path: 'D:\\ecom\\genLogs', isDefault: true, defaultPath: 'D:\\ecom\\genLogs' },
    { key: 'promptCache', label: '提示词缓存', path: 'D:\\ecom\\promptCache', isDefault: true, defaultPath: 'D:\\ecom\\promptCache' },
  ],
}
const defaultsReply = { ok: true, defaults: {}, status: { image: false, video: false, text: false, audio: false }, broken: {} }
const sourcesReply = {
  ok: true,
  sources: [
    { id: 'awesome-gpt-image', name: 'Awesome GPT Image', url: 'https://x/a.json', homepage: '', license: 'MIT', enabled: true, builtin: true },
  ],
}
const channelsReply = {
  ok: true,
  channels: [{
    id: 'ch_local', name: '本地 ComfyUI', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    hasKey: true, models: [{ id: 'flux-pro', label: 'Flux Pro', caps: ['image'] }], maxConcurrency: 3,
  }],
}

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  hits.push(method + ' ' + p)
  if (p === '/api/ecom-workbench/storage') return { ok: true, status: 200, json: async () => storageReply }
  if (p === '/api/ecom-workbench/model-defaults') return { ok: true, status: 200, json: async () => defaultsReply }
  if (p.startsWith('/api/ecom-workbench/gen-models')) return { ok: true, status: 200, json: async () => ({ ok: true, models: [], items: [] }) }
  if (p === '/api/ecom-workbench/prompt-sources/config') return { ok: true, status: 200, json: async () => sourcesReply }
  if (p === '/api/ecom-workbench/channels') return { ok: true, status: 200, json: async () => channelsReply }
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

/** 点一下。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await settle() })
}

/**
 * 点某个 tab。
 *
 * antd 的 tab 是 `role="tab"` 的那一层，点它才会触发 `onChange`；
 * 里面的 label 是我们要找的锚（`data-ewb-config-tab`）。
 *
 * @param el - 挂载后的容器。
 * @param key - tab 键。
 */
async function openTab(el, key) {
  const label = el.querySelector('[data-ewb-config-tab="' + key + '"]')
  if (label === null) return
  await click(label.closest('[role="tab"]') ?? label)
}

const { ConfigTabs, CONFIG_TABS, CONFIG_TAB_LABEL, CONFIG_TAB_KEY, DEFAULT_CONFIG_TAB, readConfigTab, saveConfigTab, isConfigTab } = await import('../src/client/workbench/ConfigTabs.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：tab 清单、容错读、写回
 *
 * ## ★ 2026-10-28（票 38）：五个 tab → 三个
 *
 * 用户原话（票 37 条目一）：「渠道、默认模型应该放到工作台设置中。其他三项
 * 提示词源、存储、偏好保留在内容板块」。
 *
 * 这一段原来的 6 条断言现在**条数不变、期望值跟着改**，并各自注明搬到哪去了：
 *
 * | 原断言 | 现在 | 搬走/变化的说明 |
 * |---|---|---|
 * | 正好五个 tab，键对得上 | 正好三个 | `channels` / `defaults` 已上收到工作台设置 |
 * | 五个都有中文名 | 三个 | 同上 |
 * | 默认落在「渠道」 | 默认落在「提示词源」 | 渠道搬走后，「先配什么」的第一个变成它 |
 * | 读不出来 → 回默认 | 回「提示词源」 | 同上 |
 * | 空串 → 回默认 | 回「提示词源」 | 同上 |
 * | 存的是别的键 → 回默认 | 回「提示词源」，**并额外验存着已搬走的键也回默认** | 老会话里存着 `channels` / `defaults` 的人是真实情况 |
 * | 判据函数只认五个之一 | 只认三个，且**不认**已搬走的两个 | 反过来钉「搬干净了」 |
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：三个 tab 与容错读 ===')
{
  check('★★ 正好三个 tab（渠道与默认模型已上收到工作台设置，2026-10-28 票 38）',
    CONFIG_TABS.length === 3
    && CONFIG_TABS.join(',') === 'prompt-sources,storage,preferences',
    CONFIG_TABS.join(','))
  check('★★ 三个都有中文名', CONFIG_TABS.every(k => (CONFIG_TAB_LABEL[k] ?? '') !== ''),
    CONFIG_TABS.map(k => CONFIG_TAB_LABEL[k]).join(' / '))
  check('★ 默认落在「提示词源」（渠道搬走后它是这里的第一个）',
    DEFAULT_CONFIG_TAB === 'prompt-sources', DEFAULT_CONFIG_TAB)

  /* R6.3：tab 名不许是疑问句或感叹句。 */
  check('★★ tab 名都不是疑问句（R6.3）',
    CONFIG_TABS.every(k => !/[？?！!]/.test(CONFIG_TAB_LABEL[k])),
    CONFIG_TABS.map(k => CONFIG_TAB_LABEL[k]).join(' / '))

  check('★★ 读不出来 → 回默认（不抛错）', readConfigTab(null) === 'prompt-sources', readConfigTab(null))
  check('★★ 空串 → 回默认', readConfigTab('') === 'prompt-sources', readConfigTab(''))
  check('★★ 存的是别的键（旧版本 / 手改）→ 回默认', readConfigTab('webdav') === 'prompt-sources', readConfigTab('webdav'))
  /* ★ 票 38 补：老会话里 localStorage 可能还存着**已搬走**的两个 tab 名。
   * 那时不能落到一个"什么都不显示"的空 tab，必须回默认（不然用户进配置页看到一片空白）。 */
  check('★★★ 存着已搬走的 `channels` → 回默认（不落到一个空 tab）',
    readConfigTab('channels') === 'prompt-sources', readConfigTab('channels'))
  check('★★★ 存着已搬走的 `defaults` → 回默认（同上）',
    readConfigTab('defaults') === 'prompt-sources', readConfigTab('defaults'))
  check('★★ 存的是合法键 → 照用', readConfigTab('storage') === 'storage', readConfigTab('storage'))
  check('★ 坏 JSON 里取出来的串也不炸', readConfigTab('{"a":1}') === 'prompt-sources', readConfigTab('{"a":1}'))
  check('★ 判据函数只认三个之一，且**不认**已搬走的那两个（搬干净了）',
    isConfigTab('preferences') && !isConfigTab('channels') && !isConfigTab('defaults')
    && !isConfigTab('defaults ') && !isConfigTab(3) && !isConfigTab(null))

  /* 写回：真进 localStorage。 */
  window.localStorage.removeItem(CONFIG_TAB_KEY)
  saveConfigTab('prompt-sources')
  check('★★ 写回真的进了 localStorage（刷新后要靠它）',
    window.localStorage.getItem(CONFIG_TAB_KEY) === 'prompt-sources',
    String(window.localStorage.getItem(CONFIG_TAB_KEY)))
  check('★★ 写完再读，读到的就是它', readConfigTab() === 'prompt-sources', readConfigTab())
  window.localStorage.removeItem(CONFIG_TAB_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 三个 tab 都能点开，每块只在自己的 tab 下
 *
 * ## ★ 票 38：原来这一段的 15 条里，有 5 条要换对象
 *
 * 条数不变，逐条对应：
 *
 * | 原断言 | 现在 |
 * |---|---|
 * | 五个 tab 的导航项都在 | **三个** |
 * | 默认停在「渠道」 | 默认停在「提示词源」 |
 * | 渠道 tab 里能点到渠道列表 | **提示词源 tab 里能点到源行**（渠道那格不存在了，见下条） |
 * | 渠道 tab 下没有另外三块 | 提示词源 tab 下没有存储 / 偏好 |
 * | 点「默认模型」→ 四个下拉都在 | **配置页里点不到四类默认模型了**（已搬到工作台设置） |
 *
 * ⚠️ 「配置页里点不到四类默认模型」这一条不是"减少覆盖"，是**搬家类改动的
 * 唯一防漏网判据**：只验新位置有、不验旧位置没有，就会出现两处都能改。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 三个 tab 都能点开，每块只在自己的 tab 下 ===')
{
  window.localStorage.removeItem(CONFIG_TAB_KEY)
  hits.length = 0
  const m = await mount(React.createElement(ConfigTabs, { active: true }))
  const q = sel => m.el.querySelector(sel)
  const n = sel => m.el.querySelectorAll(sel).length

  check('★★ 三个 tab 的导航项都在（渠道与默认模型已搬走）', n('[data-ewb-config-tab]') === 3,
    '实际 ' + String(n('[data-ewb-config-tab]')))
  check('★★ 默认停在「提示词源」', q('[data-ewb-config-tabs="prompt-sources"]') !== null,
    String(q('[data-ewb-config-tabs]')?.getAttribute('data-ewb-config-tabs')))
  check('★★ 提示词源 tab 里能点到源行', n('[data-ewb-sources-row]') > 0,
    '源行 ' + String(n('[data-ewb-sources-row]')))
  check('★★ 提示词源 tab 下**没有**存储与偏好（不渲染就不挂）',
    n('[data-ewb-storage-input]') === 0 && n('[data-ewb-prefs-count]') === 0,
    'storage=' + String(n('[data-ewb-storage-input]'))
    + ' prefs=' + String(n('[data-ewb-prefs-count]')))
  /* ★ 搬家判据：那两块在配置页里**一个都不剩**。 */
  check('★★★ 配置页里没有渠道列表（已上收到工作台设置）', n('[data-ewb-channel-row]') === 0,
    '渠道行 ' + String(n('[data-ewb-channel-row]')))
  check('★★★ 配置页里没有四类默认模型（已上收到工作台设置）', n('[data-ewb-defaults-select]') === 0,
    '下拉 ' + String(n('[data-ewb-defaults-select]')))

  /* 只开了提示词源 tab：另两块的读接口不该被调。 */
  const early = hits.filter(h => h.includes('/storage') || h.includes('/model-defaults') || h.includes('/channels'))
  check('★★ 判据 1 的反面：没打开的 tab 一次请求都不发',
    early.length === 0, early.join(' / '))

  await openTab(m.el, 'storage')
  check('★★ 点「存储」→ 五个输入框', n('[data-ewb-storage-input]') === 5,
    '实际 ' + String(n('[data-ewb-storage-input]')))
  check('★★ 提示词源那块没了', n('[data-ewb-sources-row]') === 0,
    '实际 ' + String(n('[data-ewb-sources-row]')))
  check('★ 四类默认模型仍不在这里（没有 tab 能挂它）', n('[data-ewb-defaults-select]') === 0,
    '实际 ' + String(n('[data-ewb-defaults-select]')))

  await openTab(m.el, 'preferences')
  /* ⚠️ 票 05 起偏好那格有内容了（原来断言的是空壳「暂无设置项」）。
   * 这条**改了锚点，不是放宽**：
   *   · 旧锚点：偏好 tab 里有一句「暂无设置项」
   *   · 新锚点：偏好 tab 里挂的是偏好组件，而且**有可操作的控件**
   * 这条真正要守的是「点开那一格有东西、不是一片空白」—— 那句话换成了
   * 张数输入框。**判据强度没降**：旧写法只验一句固定文案，
   * 新写法验的是「那一格真的能配」（有输入框），要求更高。 */
  check('★★ 点「偏好」→ 那一格挂的是偏好组件（不是一片空白）',
    q('[data-ewb-preferences]') !== null,
    q('[data-ewb-preferences]') === null ? '(没有这一块)' : '有')
  check('★★ 偏好那一格里有可操作的控件（能配，不是只有说明）',
    q('[data-ewb-prefs-count]') !== null && q('[data-ewb-prefs-system]') !== null,
    '张数框 ' + (q('[data-ewb-prefs-count]') === null ? '无' : '有')
    + ' / 系统提示词框 ' + (q('[data-ewb-prefs-system]') === null ? '无' : '有'))
  check('★★ 偏好 tab 下其余两块都不在，搬走的两块也不在',
    n('[data-ewb-storage-input]') === 0 && n('[data-ewb-sources-row]') === 0
    && n('[data-ewb-channel-row]') === 0 && n('[data-ewb-defaults-select]') === 0,
    '全部 0 才算过')

  check('★★ 切过三个之后，当前 tab 记的是「偏好」',
    q('[data-ewb-config-tabs="preferences"]') !== null
    && window.localStorage.getItem(CONFIG_TAB_KEY) === 'preferences',
    String(window.localStorage.getItem(CONFIG_TAB_KEY)))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 刷新页面回上次那个 tab（重挂一次，模拟刷新）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 刷新之后回到上次那个 tab ===')
{
  check('★ 上一段结束时存的是偏好', window.localStorage.getItem(CONFIG_TAB_KEY) === 'preferences',
    String(window.localStorage.getItem(CONFIG_TAB_KEY)))
  const m = await mount(React.createElement(ConfigTabs, { active: true }))
  check('★★ 重新挂载（= 刷新页面）落在「偏好」（不是回到渠道）',
    m.el.querySelector('[data-ewb-config-tabs="preferences"]') !== null,
    String(m.el.querySelector('[data-ewb-config-tabs]')?.getAttribute('data-ewb-config-tabs')))
  m.unmount()

  /* 存的是坏值 → 回默认，而且**不能抛**（抛了整页白屏）。 */
  window.localStorage.setItem(CONFIG_TAB_KEY, 'webdav')
  const bad = await mount(React.createElement(ConfigTabs, { active: true }))
  check('★★ 存的是不认识的键 → 落回「提示词源」，不白屏',
    bad.el.querySelector('[data-ewb-config-tabs="prompt-sources"]') !== null
    && bad.el.querySelectorAll('[data-ewb-config-tab]').length === 3,
    String(bad.el.querySelector('[data-ewb-config-tabs]')?.getAttribute('data-ewb-config-tabs')))
  bad.unmount()
  window.localStorage.removeItem(CONFIG_TAB_KEY)

  /* ★ 票 38 补：老会话里存着**已搬走**的键（`channels` / `defaults`）——
   * 那两个 tab 现在已经不存在了，落过去会是一片空白。必须回默认。 */
  for (const gone of ['channels', 'defaults']) {
    window.localStorage.setItem(CONFIG_TAB_KEY, gone)
    const m2 = await mount(React.createElement(ConfigTabs, { active: true }))
    check('★★★ 存着已搬走的「' + gone + '」→ 落回「提示词源」，不是一片空白',
      m2.el.querySelector('[data-ewb-config-tabs="prompt-sources"]') !== null
      && m2.el.querySelector('[data-ewb-config-tabs="' + gone + '"]') === null,
      String(m2.el.querySelector('[data-ewb-config-tabs]')?.getAttribute('data-ewb-config-tabs')))
    m2.unmount()
  }
  window.localStorage.removeItem(CONFIG_TAB_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ `initialTab`：给定起点，且**不污染**用户的「上次在哪」
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ initialTab 给了就按它，不写回 localStorage ===')
{
  window.localStorage.setItem(CONFIG_TAB_KEY, 'storage')
  /* ★ 票 38：`defaults` 已不是一个 tab，换 `preferences` 当起点。 */
  const m = await mount(React.createElement(ConfigTabs, { active: true, initialTab: 'preferences' }))
  check('★ 按 initialTab 落在「偏好」',
    m.el.querySelector('[data-ewb-config-tabs="preferences"]') !== null,
    String(m.el.querySelector('[data-ewb-config-tabs]')?.getAttribute('data-ewb-config-tabs')))
  await openTab(m.el, 'storage')
  check('★★ 切换了也不写回（调用方要的是一个确定的起点）',
    window.localStorage.getItem(CONFIG_TAB_KEY) === 'storage',
    String(window.localStorage.getItem(CONFIG_TAB_KEY)))
  m.unmount()
  window.localStorage.removeItem(CONFIG_TAB_KEY)
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 源码层：挂载只在一处、按需引入 antd
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 源码层：挂载只在一处、按需引入 ===')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/workbench/ConfigTabs.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★ 没有裸 `import antd`（按需引入）', !/import\s+\w+\s+from\s+'antd'/.test(code))
  check('★★ 没有引 `@ant-design/icons`（项目用 icons.tsx）', !/@ant-design\/icons/.test(code))
  /* 三块各挂一次。判据要能变红：少挂一块、或某一挂了两处，都要红。
   *
   * ★ 票 38：原来的四块里 `ChannelSettings` / `DefaultsSettings` 已上收到
   * 工作台设置，所以这里只剩三块。**同时**再钉一条「那两块不许出现在这里」——
   * 只减不验等于给「搬了但没删干净」留了口子。 */
  const mounted = ['PromptSourcesSettings', 'StorageSettings', 'PreferencesSettings']
    .map(n => ({ n, times: (code.match(new RegExp('<' + n + '\\b', 'g')) ?? []).length }))
  check('★★ 三块都在这里挂，且各只挂一次（渠道与默认模型已搬走）',
    mounted.every(x => x.times === 1),
    mounted.map(x => x.n + '×' + String(x.times)).join(' '))
  check('★★★ 渠道与四类默认模型**不在**配置页挂载（它们在工作台设置里）',
    !/<ChannelSettings\b|<DefaultsSettings\b/.test(code),
    '源码里没有它们的 JSX')

  /* 渠道那块里**不许**再有另外三块的挂载（否则同一个设置两处入口）。 */
  const ch = readFileSync(new URL('../src/client/workbench/ChannelSettings.tsx', import.meta.url), 'utf8')
  const chCode = ch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★ 渠道那块不再挂另外三块（同一个设置不许两处入口）',
    !/<StorageSettings|<DefaultsSettings|<PromptSourcesSettings/.test(chCode),
    '源码里没有它们的 JSX')
}

console.log('')
console.log(failed === 0 ? '结论：配置页三个 tab 接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
