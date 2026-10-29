/** 配置页 · 存储目录（P3 第 1 块，用户 m03414）。
 *
 * ## 这一块是什么
 *
 * 用户那张「什么都点不到」的表里，「本地存储目录」是四个路径 —— 后端全做好了
 * （`GET/PUT /storage`，见 `docs/机制-配置面接口.md` §三），界面上一个输入框都没有。
 *
 * ## 判据（lead 定的五条通用 + 本块特有）
 *
 * 1 界面上能点到 —— 五个输入框 + 保存按钮
 * 2 点了真发请求 —— 断言发了 `PUT /storage`
 * 3 回包反映到界面 —— 存完再读，显示新值
 * 4 失败要说清原因 —— 后端 400 带 `key`，界面要把**那一格**标出来
 * 5 不许自己挑默认 —— 不适用（这块没有模型选择）
 * 6 自证 —— 见下
 *
 * 另有本块特有的三条（都来自后端文档 §三）：
 *   · **空串 = 恢复默认**，所以「清空再存」要真的发空串（不是不发这个键）
 *   · **整份不存**：任一格不过就一格都没改，界面不许说成「部分成功」
 *   · **「默认 / 已改」两个字要有**，别只靠颜色
 *
 * 跑法：node scripts/run-tests.mjs config-storage
 */
import { readFileSync } from 'node:fs'
import { settle, waitUntil } from './_wait.mjs'
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

/* ── 假宿主：只做 /storage 两条路由 ── */
/** 发出的写请求（断言「点了真发」）。 */
const puts = []
/** `GET /storage` 回什么（测试逐段改）。 */
let storageReply = {
  ok: true,
  config: {},
  dirs: [
    { key: 'canvases', label: '画布', path: 'D:\\ecom\\data\\canvases', isDefault: true, defaultPath: 'D:\\ecom\\data\\canvases' },
    { key: 'artifacts', label: '产物', path: 'D:\\ecom\\data\\artifacts', isDefault: true, defaultPath: 'D:\\ecom\\data\\artifacts' },
    { key: 'materials', label: '素材', path: 'D:\\ecom\\data\\materials', isDefault: true, defaultPath: 'D:\\ecom\\data\\materials' },
    { key: 'genLogs', label: '生成记录', path: 'D:\\ecom\\data\\genLogs', isDefault: true, defaultPath: 'D:\\ecom\\data\\genLogs' },
    { key: 'promptCache', label: '提示词缓存', path: 'D:\\ecom\\data\\promptCache', isDefault: true, defaultPath: 'D:\\ecom\\data\\promptCache' },
  ],
}
/** `PUT /storage` 该怎么答（测试逐段改）。 */
let putReply = { ok: true, status: 200, body: { ok: true } }

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  if (p === '/api/ecom-workbench/storage' && method === 'GET') {
    return { ok: true, status: 200, json: async () => storageReply }
  }
  if (p === '/api/ecom-workbench/storage' && method === 'PUT') {
    puts.push(JSON.parse(String(init?.body ?? '{}')))
    if (putReply.status !== 200) {
      return { ok: false, status: putReply.status, json: async () => putReply.body }
    }
    /* 成功时：把新路径写回 storageReply，模拟后端存下来了。 */
    const body = puts[puts.length - 1]
    storageReply = {
      ...storageReply,
      dirs: storageReply.dirs.map(d => ({
        ...d,
        path: typeof body.dirs?.[d.key] === 'string' ? body.dirs[d.key] : d.path,
        isDefault: (body.dirs?.[d.key] ?? '') === '',
      })),
    }
    putReply = { ok: true, status: 200, body: { ok: true } }
    return { ok: true, status: 200, json: async () => putReply.body }
  }
  /* ④ 段要挂整个「配置格」，它会拉渠道表 —— 给一条最小回包，
   * 否则断言「渠道列表没被挤掉」会红，而那不是代码的问题。 */
  if (p === '/api/ecom-workbench/channels' && method === 'GET') {
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        channels: [{
          id: 'ch_local', name: '本地 ComfyUI', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
          hasKey: true, models: [{ id: 'flux-pro', label: 'Flux Pro', caps: ['image'] }], maxConcurrency: 3,
        }],
      }),
    }
  }
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

/** 在输入框里打字（受控 input 要走原生 setter + input 事件）。 */
async function type(el, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

const mod = await import('../src/client/workbench/StorageSettings.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：五格补齐、保存体（空串要发）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 纯函数：五格摊平、保存体 ===')
{
  check('五个存储键与后端 STORAGE_KEYS 一致（画布/产物/素材/生成记录/提示词缓存）',
    JSON.stringify(mod.STORAGE_KEYS) === JSON.stringify(['canvases', 'artifacts', 'materials', 'genLogs', 'promptCache']),
    mod.STORAGE_KEYS.join(','))

  /* 后端少给一格时**补齐**，不许少一行 —— 少一行会让用户以为那格不存在。 */
  const partial = mod.toDirRows({
    dirs: [{ key: 'artifacts', label: '产物', path: 'D:\\a', isDefault: false, defaultPath: 'D:\\d' }],
  })
  check('★★ 后端只回一格 → 界面补齐五格（不少行）', partial.length === 5, String(partial.length))
  check('★ 补齐的那几格标成「默认」（不是漏掉也不是乱填）',
    partial.filter(d => d.key !== 'artifacts').every(d => d.isDefault === true))
  check('★ 后端回了的那一格保持原样',
    partial.find(d => d.key === 'artifacts')?.path === 'D:\\a'
    && partial.find(d => d.key === 'artifacts')?.isDefault === false)

  /* 顺序照固定键序，不随后端数组顺序漂。 */
  check('★ 顺序固定（照 STORAGE_KEYS，不随后端数组顺序）',
    partial.map(d => d.key).join(',') === 'canvases,artifacts,materials,genLogs,promptCache',
    partial.map(d => d.key).join(','))

  /* ★ 空串要发 —— 这是「恢复默认」的约定，与渠道表单的 apiKey 正好相反。 */
  const body = mod.toSaveBody({ canvases: '', artifacts: ' D:\\x ', materials: '', genLogs: '', promptCache: '' })
  check('★★ 空串**要发出去**（空串 = 恢复默认，不发就等于用户改不了）',
    body.dirs.canvases === '', JSON.stringify(body.dirs.canvases))
  check('★★ 五格全发（整份覆盖，不是只发改过的那格）',
    Object.keys(body.dirs).length === 5, Object.keys(body.dirs).join(','))
  check('★ 前后空格去掉', body.dirs.artifacts === 'D:\\x', JSON.stringify(body.dirs.artifacts))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 真挂：五个输入框、保存真发 PUT、回包反映到界面
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 真挂：能点到、点了真发、回包反映到界面 ===')
{
  puts.length = 0
  storageReply = {
    ok: true,
    config: {},
    dirs: [
      { key: 'canvases', label: '画布', path: 'D:\\ecom\\data\\canvases', isDefault: true, defaultPath: 'D:\\ecom\\data\\canvases' },
      { key: 'artifacts', label: '产物', path: 'D:\\ecom\\data\\artifacts', isDefault: true, defaultPath: 'D:\\ecom\\data\\artifacts' },
      { key: 'materials', label: '素材', path: 'D:\\ecom\\data\\materials', isDefault: true, defaultPath: 'D:\\ecom\\data\\materials' },
      { key: 'genLogs', label: '生成记录', path: 'D:\\ecom\\data\\genLogs', isDefault: true, defaultPath: 'D:\\ecom\\data\\genLogs' },
      { key: 'promptCache', label: '提示词缓存', path: 'D:\\ecom\\data\\promptCache', isDefault: true, defaultPath: 'D:\\ecom\\data\\promptCache' },
    ],
  }
  const m = await mount(React.createElement(mod.StorageSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)

  /* 判据 1：能点到。 */
  const inputs = [...m.el.querySelectorAll('[data-ewb-storage-input]')]
  check('★★ 判据 1：五个路径输入框都在', inputs.length === 5, '实际 ' + String(inputs.length))
  check('★★ 判据 1：五个键各一格',
    inputs.map(i => i.getAttribute('data-ewb-storage-input')).join(',')
    === 'canvases,artifacts,materials,genLogs,promptCache',
    inputs.map(i => i.getAttribute('data-ewb-storage-input')).join(','))
  check('★★ 判据 1：有保存按钮', q('[data-ewb-storage-save]') !== null)
  check('★ 界面上写清了「空 = 用默认」与「整份不存」',
    (q('[data-ewb-storage-note]')?.textContent ?? '').includes('留空')
    && (q('[data-ewb-storage-note]')?.textContent ?? '').includes('整份不存'),
    (q('[data-ewb-storage-note]')?.textContent ?? '').slice(0, 60))
  check('★ 每格标了「默认 / 已改」两个字（不靠颜色）',
    [...m.el.querySelectorAll('[data-ewb-storage-default]')].every(e => ['默认', '已改'].includes((e.textContent ?? '').trim())),
    [...m.el.querySelectorAll('[data-ewb-storage-default]')].map(e => e.textContent).join(','))

  /* 判据 2：改一格再保存 → 真发 PUT。 */
  await type(q('[data-ewb-storage-input="artifacts"]'), 'E:\\ecom\\artifacts')
  await click(q('[data-ewb-storage-save]'))
  check('★★ 判据 2：点保存真的发了 PUT /storage', puts.length === 1, '实际 ' + String(puts.length) + ' 次')
  check('★★ 判据 2：发出去的是五格整份（不是只发改过那一格）',
    Object.keys(puts[0]?.dirs ?? {}).length === 5, JSON.stringify(Object.keys(puts[0]?.dirs ?? {})))
  check('★★ 判据 2：改过那一格是新值', puts[0]?.dirs?.artifacts === 'E:\\ecom\\artifacts',
    JSON.stringify(puts[0]?.dirs?.artifacts))

  /* 判据 3：回包反映到界面（存完重读，输入框里是新值）。 */
  await m.settle()
  check('★★ 判据 3：存完界面上就是新值',
    q('[data-ewb-storage-input="artifacts"]')?.value === 'E:\\ecom\\artifacts',
    q('[data-ewb-storage-input="artifacts"]')?.value ?? '')
  check('★★ 判据 3：那一格标成「已改」（不再是默认）',
    (q('[data-ewb-storage-default="artifacts"]')?.textContent ?? '').trim() === '已改',
    q('[data-ewb-storage-default="artifacts"]')?.textContent ?? '')
  check('★ 存完有一句结果说明', q('[data-ewb-storage-saved]') !== null,
    q('[data-ewb-storage-saved]')?.textContent ?? '')

  /* 「恢复默认」按钮：清空那一格（不发请求，要等保存）。 */
  puts.length = 0
  await click(q('[data-ewb-storage-reset="artifacts"]'))
  check('★ 点「恢复默认」把那一格清空', q('[data-ewb-storage-input="artifacts"]')?.value === '',
    q('[data-ewb-storage-input="artifacts"]')?.value ?? '')
  check('★★ 「恢复默认」本身不发请求（要等按保存才生效）', puts.length === 0,
    String(puts.length) + ' 次')
  await click(q('[data-ewb-storage-save]'))
  check('★★ 保存时那一格发的是**空串**（后端据此回到默认）',
    puts.length === 1 && puts[0]?.dirs?.artifacts === '',
    JSON.stringify(puts[0]?.dirs?.artifacts))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 判据 4：失败要说清是哪一格
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 判据 4：某一格写不进去 → 指到那一格，且不许说成「部分成功」 ===')
{
  puts.length = 0
  /* 后端 400 + key 指是哪一格（形状照 docs §三）。 */
  putReply = {
    ok: false, status: 400,
    body: {
      ok: false,
      key: 'artifacts',
      error: '「产物」：要写完整路径（形如 D:\\ecom\\artifacts），不要用相对路径：rel/x',
    },
  }
  const m = await mount(React.createElement(mod.StorageSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)
  await type(q('[data-ewb-storage-input="artifacts"]'), 'rel/x')
  await click(q('[data-ewb-storage-save]'))

  check('★★ 判据 4：失败时显示后端那句原因',
    (q('[data-ewb-storage-error]')?.textContent ?? '').includes('完整路径'),
    (q('[data-ewb-storage-error]')?.textContent ?? '').slice(0, 70))
  check('★★ 判据 4：**指出是哪一格**（后端回的 key 标在那一行上）',
    q('[data-ewb-storage-row="artifacts"]')?.hasAttribute('data-ewb-storage-bad') === true)
  check('★★ 判据 4：别的格**没被误标**（只有那一格红）',
    q('[data-ewb-storage-row="canvases"]')?.hasAttribute('data-ewb-storage-bad') === false
    && q('[data-ewb-storage-row="genLogs"]')?.hasAttribute('data-ewb-storage-bad') === false)
  check('★★ 判据 4：没说成「部分成功」（文案里没有「部分」或「已保存」）',
    !(q('[data-ewb-storage-error]')?.textContent ?? '').includes('部分')
    && q('[data-ewb-storage-saved]') === null,
    '已保存块 = ' + String(q('[data-ewb-storage-saved]') !== null))
  m.unmount()
  putReply = { ok: true, status: 200, body: { ok: true } }
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 接进配置页（判据 1 的「界面能点到」要从配置页进去看）
 *
 * 2026-10-27 改（票 10）：配置页分成五个 tab，存储目录是「存储」那个 tab。
 * 所以这里挂 `ConfigTabs` 并直接落到存储 tab —— 挂 `ChannelSettings` 已经看不到
 * 这一块了（它现在只负责「渠道」tab）。断言本身一条没减，只是入口换了。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 从配置页进去也能点到（不是只有一个孤立组件） ===')
{
  const { ConfigTabs } = await import('../src/client/workbench/ConfigTabs.tsx')
  const m = await mount(React.createElement(ConfigTabs, { active: true, initialTab: 'storage' }))
  const q = sel => m.el.querySelector(sel)
  check('★★ 配置页停在「存储」tab', q('[data-ewb-config-tabs="storage"]') !== null)
  check('★★ 配置页里能点到存储目录的五个输入框',
    m.el.querySelectorAll('[data-ewb-storage-input]').length === 5,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-storage-input]').length))
  /* 这一条原来判「渠道列表没被挤掉」。分成 tab 之后**它本来就不该同时出现** ——
   * 五个 tab 一起渲染等于一进配置页发五路请求。所以改判「渠道在它自己的 tab 里」。 */
  check('★★ 渠道在它自己的 tab 里（同一页不重复挂）',
    q('[data-ewb-channels]') === null,
    '存储 tab 下渠道块 = ' + String(q('[data-ewb-channels]') !== null))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 源码层：这一块不许自己挑默认、不许发相对路径的「猜测」
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 源码层：没有自作主张 ===')
{
  const src = readFileSync(new URL('../src/client/workbench/StorageSettings.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★ 不许在界面里自己造默认路径（默认路径只能来自后端 defaultPath）',
    !/D:\\\\ecom|C:\\\\Users|process\.cwd/.test(code), '源码里没写死盘符')
  check('★ 没有裸 `import antd`（按需引入）', !/import\s+\w+\s+from\s+'antd'/.test(code))
  check('★ 空串不经过任何「过滤掉空值」的处理（空串是「恢复默认」的约定）',
    !/dirs\[[^\]]+\]\s*!==\s*''/.test(code))
}

console.log('')
console.log(failed === 0 ? '结论：存储目录那块接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
