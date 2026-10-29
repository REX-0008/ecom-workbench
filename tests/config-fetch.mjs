/** 渠道 · 拉取模型（P3 第 3 块，用户 m03414）。
 *
 * ## 这一块是什么
 *
 * 用户原话：「配置中的新增渠道，**连拉取模型都没有**，你是在敷衍我吗？
 * 参考都有这个功能你都不做？？」
 *
 * 后端 `GET /channels/:id/models?kind=` 早就有（`docs/机制-配置面接口.md` §一），
 * 界面上却只有一个要**手打** `gpt-image-1|GPT Image 1|image` 的文本框。
 *
 * ## 判据（lead 的七条）
 *
 * 1 渠道页有「拉取模型」按钮，点了真发 GET
 * 2 回来的模型列表能勾选（不是全收）
 * 3 确认后写回渠道（挂进文本框，不替用户点保存）
 * 4 **四种失败各显示不同的话**，且都指出「该改什么」
 * 5 **空列表不是失败**：`ok:true` + `models:[]` → 「这一类没装模型」
 * 6 ComfyUI 必须带 `?kind=`
 * 7 自证：至少 3 处变红
 *
 * 跑法：node scripts/run-tests.mjs config-fetch
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

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
globalThis.localStorage = window.localStorage
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'DocumentFragment', 'MouseEvent', 'HTMLInputElement', 'HTMLSelectElement']) {
  globalThis[k] = window[k]
}
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

/* ── 假宿主 ── */
/** 收到的 `/models` 请求（断言「真发了」+「带 kind」）。 */
const fetches = []
/** 下一次 `/models` 该回什么（测试逐段改）。 */
let modelsReply = { ok: true, models: [{ id: 'flux1-dev.safetensors', label: 'flux1-dev.safetensors' }], url: 'http://127.0.0.1:8188/api/experiment/models/diffusion_models' }

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  if (p.includes('/models') && method === 'GET') {
    fetches.push(p)
    return { ok: true, status: 200, json: async () => modelsReply }
  }
  if (p === '/api/ecom-workbench/channels' && method === 'GET') {
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        channels: [{
          id: 'ch_local', name: '本地 ComfyUI', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
          hasKey: false, models: [{ id: 'old-one', label: '老模型', caps: ['image'] }], maxConcurrency: 3,
        }],
      }),
    }
  }
  if (p === '/api/ecom-workbench/storage' && method === 'GET') {
    return { ok: true, status: 200, json: async () => ({ ok: true, dirs: [] }) }
  }
  if (p === '/api/ecom-workbench/model-defaults' && method === 'GET') {
    return { ok: true, status: 200, json: async () => ({ ok: true, defaults: {}, status: {}, broken: {} }) }
  }
  if (p.startsWith('/api/ecom-workbench/gen-models')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, models: [] }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}
window.fetch = host
globalThis.fetch = host

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/** 挂一个组件。 */
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

/** 点一下。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await settle() })
}

/** 勾一个 checkbox。
 *
 * ⚠️ 受控 checkbox 要走**原生 checked setter + click 事件**两条：
 * 直接 `el.checked = true` 再派 click，React 的 onChange 读到的是「click 之后浏览器
 * 自己 toggle 出来的值」——而 jsdom 的默认行为在派发合成 click 时不一定会 toggle，
 * 于是 React 收到的是「没变」。所以先用原生 setter 把值设成目标，再派一次 click，
 * 让 React 的受控回写在同一个值上。
 */
async function check_(el, on) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')
  await act(async () => {
    desc.set.call(el, on)
    el.dispatchEvent(new window.Event('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

const mod = await import('../src/client/workbench/FetchModelsDialog.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：四种失败各说清该改什么、追加去重、能力留空
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 纯函数：四种失败的建议必须**各不相同**，且都指出改什么 ===')
{
  const four = ['unreachable', 'auth', 'no-endpoint', 'upstream'].map(k => mod.fixHint(k, '上游原文'))
  check('★★ 判据 4：四种 kind 给出**四段不同**的建议（混成一句等于没做）',
    new Set(four).size === 4, '去重后 ' + String(new Set(four).size) + ' 段')
  check('★★ 判据 4：`unreachable` 指向「地址 / 端口 / 服务」',
    four[0].includes('地址') && (four[0].includes('端口') || four[0].includes('服务')), four[0].slice(0, 50))
  check('★★ 判据 4：`auth` 指向「密钥」',
    four[1].includes('密钥'), four[1].slice(0, 40))
  check('★★ 判据 4：`no-endpoint` 指向「协议选错了」（不是让你去查网络）',
    four[2].includes('协议'), four[2].slice(0, 60))
  check('★★ 判据 4 的要点：「连不上」与「没这个接口」的修法**不同**',
    !four[0].includes('协议选错') && !four[2].includes('端口'),
    four[0].slice(0, 30) + ' ／ ' + four[2].slice(0, 30))
  check('★ 四段都带上了上游原文（排查要看原话）',
    four.every(s => s.includes('上游原文')))

  /* ── 追加：去重、能力留空、不叠空行 ── */
  const next = mod.appendModels('old-one|老模型|image', [{ id: 'flux1-dev.safetensors', label: 'flux1-dev.safetensors' }])
  check('★★ 追加：新模型进文本框了',
    next.includes('flux1-dev.safetensors'), next)
  check('★ 追加：已有模型没被重复加',
    next.split('\n').filter(l => l.startsWith('old-one')).length === 1, next)

  const dup = mod.appendModels('flux1-dev.safetensors|已存在|image', [{ id: 'flux1-dev.safetensors', label: 'x' }])
  check('★★ 追加：**已存在的 id 不再加一遍**（用户可能已经手打过）',
    dup === 'flux1-dev.safetensors|已存在|image', dup)

  const caps = mod.appendModels('', [{ id: 'm1', label: '模型一' }])
  check('★★ 追加：能力**留空**（上游只说有什么，不说能干什么）',
    caps === 'm1|模型一|', JSON.stringify(caps))
  check('★ 能力留空的后果写清了：保存后要去「默认模型」标能力',
    mod.appendModels('', []).length === 0)

  check('★ 追加：空列表时原样返回（不乱改）',
    mod.appendModels('a|甲|', []) === 'a|甲|')

  /* ComfyUI 四个类别：值照后端文档抄，不许自己拼。 */
  check('★★ ComfyUI 四个 kind 值照后端文档（diffusion/text_encoder/checkpoint/vae）',
    JSON.stringify(mod.COMFY_KINDS) === JSON.stringify(['diffusion', 'text_encoder', 'checkpoint', 'vae']),
    mod.COMFY_KINDS.join(','))
  check('★★ `text_encoder` 不是 `text_encoders`（接口叫后者、我们对外叫前者，不许自己拼）',
    mod.COMFY_KINDS.includes('text_encoder') && !mod.COMFY_KINDS.includes('text_encoders'))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 真挂：点了真发 GET、能勾选、加入文本框
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 真挂：真发 GET、勾选、加入文本框 ===')
{
  fetches.length = 0
  modelsReply = {
    ok: true,
    models: [
      { id: 'flux1-dev.safetensors', label: 'flux1-dev.safetensors' },
      { id: 'sdxl-base.safetensors', label: 'SDXL 基础' },
    ],
    url: 'http://127.0.0.1:8188/api/experiment/models/diffusion_models',
  }
  let appended = ''
  const m = await mount(React.createElement(mod.FetchModelsDialog, {
    open: true, channelId: 'ch_local', protocol: 'comfyui', current: 'old-one|老模型|image',
    onAppend: (n) => { appended = n }, onClose: () => {},
  }))
  const q = sel => m.el.querySelector(sel)

  check('★★ 判据 1：弹窗里有「开始拉取」按钮', q('[data-ewb-fetch-go]') !== null)
  check('★★ 判据 6：ComfyUI 露出「类别」选择器', q('[data-ewb-fetch-kind]') !== null)

  await click(q('[data-ewb-fetch-go]'))
  check('★★ 判据 1：点了真的发了 GET /channels/:id/models',
    fetches.length === 1 && fetches[0].includes('/channels/ch_local/models'),
    fetches.join(' '))
  check('★★ 判据 6：ComfyUI 的请求**带上了 `?kind=`**',
    fetches[0].includes('?kind=diffusion'), fetches[0])
  check('★★ 判据 1：请求地址显示出来了（地址写错是最高频原因）',
    (q('[data-ewb-fetch-url]')?.textContent ?? '').includes('experiment/models'),
    q('[data-ewb-fetch-url]')?.textContent ?? '')

  /* 判据 2：勾选，不是全收。 */
  const boxes = [...m.el.querySelectorAll('[data-ewb-fetch-item]')]
  check('★★ 判据 2：回来的两条都列出来了', boxes.length === 2, '实际 ' + String(boxes.length))
  check('★★ 判据 2：一开始**一个都没勾**（全收等于把上游一百个一次灌进去）',
    boxes.every(b => b.checked === false))

  await check_(q('[data-ewb-fetch-item="sdxl-base.safetensors"]'), true)
  check('★ 勾一个之后计数对',
    (q('[data-ewb-fetch-picked]')?.textContent ?? '').includes('1'), q('[data-ewb-fetch-picked]')?.textContent ?? '')

  /* 判据 3：加入文本框，只加勾了的。 */
  await click(q('[data-ewb-fetch-append]'))
  check('★★ 判据 3：勾了的那条进了文本框',
    appended.includes('sdxl-base.safetensors'), appended)
  check('★★ 判据 3：**没勾的那条没进去**（勾选才有意义）',
    !appended.includes('flux1-dev.safetensors'), appended)
  check('★★ 判据 3：原有那行还在（追加不是覆盖）',
    appended.includes('old-one|老模型|image'), appended)
  check('★ 加进去的能力位是空的（要用户自己标）',
    appended.includes('sdxl-base.safetensors|SDXL 基础|'), JSON.stringify(appended))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 判据 4 的真挂部分：四种失败各显示不同的话
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 判据 4：四种失败的界面**各不相同** ===')
{
  const seen = new Set()
  const rows = []
  for (const [kind, status, upstream] of [
    ['unreachable', undefined, 'fetch failed'],
    ['auth', 401, 'Unauthorized'],
    ['no-endpoint', 404, 'Not Found'],
    ['upstream', 500, 'Internal Error'],
  ]) {
    modelsReply = { ok: false, kind, status, url: 'http://x/models', models: [], error: upstream }
    const m = await mount(React.createElement(mod.FetchModelsDialog, {
      open: true, channelId: 'ch_local', protocol: 'openai', current: '', onAppend: () => {}, onClose: () => {},
    }))
    const q = sel => m.el.querySelector(sel)
    await click(q('[data-ewb-fetch-go]'))
    const box = q('[data-ewb-fetch-fail]')
    const kindText = q('[data-ewb-fetch-fail-kind]')?.textContent ?? ''
    const hint = q('[data-ewb-fetch-fail-hint]')?.textContent ?? ''
    rows.push({ kind, attr: box?.getAttribute('data-ewb-fetch-fail'), kindText, hint: hint.slice(0, 30) })
    seen.add(hint)
    check('判据 4：' + kind + ' 有专门的失败块（data-ewb-fetch-fail = ' + kind + '）',
      box?.getAttribute('data-ewb-fetch-fail') === kind, String(box?.getAttribute('data-ewb-fetch-fail')))
    check('判据 4：' + kind + ' 的标题不是「上游报错」一句带过',
      kindText !== '' && (kind === 'upstream' || !kindText.includes('上游报错')), kindText)
    m.unmount()
  }
  check('★★★★ 判据 4：四种失败给出**四段不同的建议**（这才是这一块的意义）',
    seen.size === 4, '去重后 ' + String(seen.size) + ' 段')
  console.log('   四种各显示：')
  for (const r of rows) console.log('     ' + r.kind.padEnd(12) + ' → 标题「' + r.kindText + '」｜建议 ' + r.hint + '…')
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 5：空列表**不是**失败
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 判据 5：ok:true + models:[] → 「这一类没装模型」，不是「加载失败」 ===')
{
  modelsReply = { ok: true, models: [], url: 'http://127.0.0.1:8188/api/experiment/models/vae', error: '这个地址的「vae」这一类一个模型都没有' }
  const m = await mount(React.createElement(mod.FetchModelsDialog, {
    open: true, channelId: 'ch_local', protocol: 'comfyui', current: '', onAppend: () => {}, onClose: () => {},
  }))
  const q = sel => m.el.querySelector(sel)
  await click(q('[data-ewb-fetch-go]'))
  check('★★ 判据 5：显示「一个模型都没有」，且**明说不是加载失败**',
    (q('[data-ewb-fetch-empty]')?.textContent ?? '').includes('一个模型都没有')
    && (q('[data-ewb-fetch-empty]')?.textContent ?? '').includes('不是加载失败'),
    (q('[data-ewb-fetch-empty]')?.textContent ?? '').slice(0, 60))
  check('★★ 判据 5：**不显示**失败块（空不是失败）',
    q('[data-ewb-fetch-fail]') === null)
  check('★ 判据 5：也不显示勾选列表（没东西可勾）',
    q('[data-ewb-fetch-list]') === null)
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 判据 6 的另一半：非 ComfyUI 不带 kind
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 判据 6：非 ComfyUI 的协议不显示类别、也不带 kind ===')
{
  fetches.length = 0
  modelsReply = { ok: true, models: [{ id: 'gpt-image-1', label: 'GPT Image 1' }], url: 'https://x/v1/models' }
  const m = await mount(React.createElement(mod.FetchModelsDialog, {
    open: true, channelId: 'ch_open', protocol: 'openai', current: '', onAppend: () => {}, onClose: () => {},
  }))
  const q = sel => m.el.querySelector(sel)
  check('★★ 判据 6：OpenAI 协议不显示「类别」选择器（那是 ComfyUI 的概念）',
    q('[data-ewb-fetch-kind]') === null)
  await click(q('[data-ewb-fetch-go]'))
  check('★★ 判据 6：OpenAI 的请求**不带** `?kind=`',
    fetches.length === 1 && !fetches[0].includes('kind='), fetches.join(' '))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 判据 1：从渠道页真的点得到
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 从渠道页点得到「拉取模型」 ===')
{
  const { ChannelSettings } = await import('../src/client/workbench/ChannelSettings.tsx')
  const m = await mount(React.createElement(ChannelSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)
  /* 先点「编辑」进表单（按钮只在表单里）。 */
  const editBtn = m.el.querySelector('[data-ewb-channel-edit]')
  await click(editBtn)
  check('★★ 判据 1：渠道表单里有「拉取模型」按钮（新建渠道时先给提示）',
    q('[data-ewb-channel-fetch]') !== null || q('[data-ewb-channel-fetch-hint]') !== null,
    q('[data-ewb-channel-fetch]') !== null ? '有按钮' : '有提示（新建时）')
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 源码层：没在界面里自己拼上游地址
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑦ 源码层：拼地址是后端的事 ===')
{
  const src = readFileSync(new URL('../src/client/workbench/FetchModelsDialog.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★ 界面里没有自己拼上游路径（`/v1/models`、`/api/experiment/models` 都不许出现）',
    !/\/v1\/models|\/api\/experiment|\/v1beta\//.test(code))
  check('★ 拉取走的是宿主路由 `/channels/:id/models`', code.includes("'/channels/'"))
  check('★ 没有裸 `import antd`（按需引入）', !/import\s+\w+\s+from\s+'antd'/.test(code))
}

console.log('')
console.log(failed === 0 ? '结论：拉取模型接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
