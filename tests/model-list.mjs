/** 配置板块 · 模型清单（票 75，2026-10-29；票 76 改成三类）—— 按渠道分组、每行直接三个勾选框。
 *
 * ## 用户原话（三条一起看）
 *
 * > 不用担心模型多……就每行一条**不要点开看渠道类型，直接按渠道划分模型**，
 * > 每个模型直接可以勾选类型。
 *
 * > 模型清单就是**先渠道**，然后每个渠道几个模型，每个模型下面 4 个选项，
 * > 文本，图片，视频，音频。手动勾选就行了。
 *
 * ⚠️ 票 76（2026-10-29）把「文本」去掉了（文本统一走 dsh），所以现在是**三个**选项。
 *
 * > dsh模型目录现在不是选择备用模型了，是**增加到模型清单**。
 *
 * ## 这份文件替换的是票 68 那一版
 *
 * 旧版验的是「一份平铺清单 + 点行展开改类型」。用户把那个形态推翻了，
 * 所以旧版里「展开区里的多选框」那些断言**整段作废** ——
 * 不是放宽，是**被验的东西不存在了**。新版逐条对应票 75 的十三条验收。
 *
 * ## 判据分组
 *
 * | 段 | 验什么 |
 * |---|---|
 * | ① | 纯函数：摊平、分组、存盘请求体 |
 * | ② | 清单按渠道分组（判据 1）+ 模型格里没有 ComfyUI（判据 13） |
 * | ③ | 每行**直接**三个勾选框（图片 / 视频 / 音频）、不需要点开（判据 2、4） |
 * | ④ | 勾选立刻发 `POST /channels`、回包后状态保持（判据 3） |
 * | ⑤ | 渠道级信息在渠道小标题那一行（判据 5） |
 * | ⑥ | 默认模型块状 + 那段说明已删（判据 6、7） |
 * | ⑦ | 「dsh 内置」组：加进来、不走 `POST /channels`（判据 8、9） |
 * | ⑧ | 三格 `模型 / ComfyUI / 其它`；ComfyUI 格没有四类勾选框（判据 11、12） |
 *
 * 跑法：node scripts/run-tests.mjs model-list
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

/* ── 桩：四条渠道、五条模型，覆盖这一票要认的所有形状 ──────────────────
 *
 * | 渠道 | 协议 | 模型 | 这条要验什么 |
 * |---|---|---|---|
 * | `ch.local` | openai | `flux-pro`（caps image）/ `sdxl-i2i`（手标 image） | 分组、勾选框 |
 * | `ch.net` | gemini | `gpt-4o`（text）/ `veo-3`（video） | 第二组 |
 * | `ch.old` | openai | `legacy-1`（caps 空、没 types） | **四类一个都没勾**的老模型仍在清单里 |
 * | `ch.comfy` | **comfyui** | **空数组** | **判据 13 的靶子**：它不许出现在模型清单里 |
 */
const CHANNELS = [
  {
    id: 'ch.local', name: '本地渠道', protocol: 'openai', baseUrl: 'https://local.example.com',
    maxConcurrency: 2, hasKey: false,
    models: [
      { id: 'flux-pro', label: 'Flux Pro', caps: ['image'] },
      { id: 'sdxl-i2i', label: 'SDXL 图生图', caps: ['image'], types: ['image'] },
    ],
  },
  {
    id: 'ch.net', name: '网络渠道', protocol: 'gemini', baseUrl: 'https://api.example.com',
    maxConcurrency: 5, hasKey: true,
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', caps: ['text'] },
      { id: 'veo-3', label: 'Veo 3', caps: ['video'] },
    ],
  },
  {
    id: 'ch.old', name: '老渠道', protocol: 'openai', baseUrl: 'https://old.example.com',
    maxConcurrency: 1, hasKey: false,
    models: [{ id: 'legacy-1', label: '老模型', caps: [] }],
  },
  {
    /* ★ 这条是判据 13 的靶子：它**不许**出现在模型清单里。
     *
     * ## ⚠️ 桩里给了它一条模型，虽然真实数据里是空的
     *
     * 真实 `channels.json` 里那条 ComfyUI 渠道的 `models` **确实是空数组**
     * （它的类型由 12 份工作流绑定决定，不需要模型）。
     *
     * 但**空数组当不了靶子**：`rowsOf` 对空 `models` 一条行都产不出来，
     * 于是「代码忘了筛 comfyui」与「筛了」在界面上**完全一样** ——
     * 我第一版就是空数组，自证注入「不滤 comfyui」时判据 13 **没红**（实测）。
     *
     * 而用户是**可能**给它填模型的（那张表单里就有「拉取模型」按钮）。
     * 判据要防的是「代码忘了筛」，那就得让桩里有东西可筛。
     * 所以这里放一条 —— 如果实现真忘了筛，它会冒到模型清单里，判据立刻红。 */
    id: 'ch.comfy', name: '本地 comfyui', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    maxConcurrency: 5, hasKey: false,
    models: [{ id: 'comfy-t2i', label: 'ComfyUI 文生图', caps: ['image'] }],
  },
]

/** 收到的 `POST /channels`。 */
const channelPosts = []
/** 收到的 `POST /models/prefs`（dsh 那组）。 */
const prefsPosts = []
/** dsh 目录回什么。 */
const dshProviders = [
  { id: 'p-deepseek', name: 'DeepSeek', models: [{ id: 'ds-chat', name: 'deepseek-chat' }, { id: 'ds-reason', name: 'deepseek-reasoner' }] },
  { id: 'p-openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'gpt-4o' }] },
]
/** 当前 picks（dsh 已加进清单的）。测试会改它。 */
let picksNow = []

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  /**
   * 回包（**深拷贝**）。
   *
   * ⚠️ 必须深拷贝：直接把自己的对象交给界面的话，`POST` 改了它之后
   * 界面**不重读也能看到新值** —— 「存完重读」那条判据就红不了（票 68 踩过）。
   */
  const json = (b, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => JSON.parse(JSON.stringify(b)),
  })
  if (p === '/api/ecom-workbench/channels' && method === 'GET') {
    return json({ ok: true, channels: CHANNELS })
  }
  if (p === '/api/ecom-workbench/channels' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'))
    channelPosts.push(body)
    const i = CHANNELS.findIndex(c => c.id === body.id)
    if (i >= 0) {
      CHANNELS[i] = {
        ...CHANNELS[i],
        models: (body.models ?? []).map(m => ({
          id: m.id,
          label: m.label ?? m.id,
          caps: Array.isArray(m.caps) ? m.caps : [],
          ...Array.isArray(m.types) ? { types: m.types } : {},
        })),
      }
    }
    return json({ ok: true, channel: CHANNELS[i] })
  }
  if (p.startsWith('/api/ecom-workbench/channels/') && p.endsWith('/test') && method === 'POST') {
    return json({ ok: true, result: { ok: true, message: '通了' } })
  }
  if (p === '/api/ecom-workbench/models' && method === 'GET') {
    return json({
      ok: true,
      providers: dshProviders,
      prefs: { default: null, picks: picksNow },
      current: null,
    })
  }
  if (p === '/api/ecom-workbench/models/prefs' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'))
    prefsPosts.push(body)
    if (Array.isArray(body.picks)) picksNow = body.picks
    return json({ ok: true, prefs: { default: null, picks: picksNow } })
  }
  if (p === '/api/ecom-workbench/model-defaults' && method === 'GET') {
    return json({
      ok: true,
      defaults: {},
      status: { text: false, image: false, video: false, audio: false },
      broken: {},
    })
  }
  if (p.startsWith('/api/ecom-workbench/gen-models') && method === 'GET') {
    return json({ ok: true, models: [], items: [] })
  }
  if (p === '/api/ecom-workbench/browser-prefs' && method === 'GET') {
    return json({ ok: true, prefs: {} })
  }
  return json({ ok: true, items: [] })
}
window.fetch = host
globalThis.fetch = host

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

/**
 * 点一下。
 * @param {Element|null} el - 目标。
 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await settle() })
}

/**
 * 勾 / 取消一个 checkbox。
 * @param {Element|null} el - checkbox。
 * @param {boolean} on - 目标状态。
 */
async function setChecked(el, on) {
  if (el === null || el === undefined) return
  if (el.checked === on) return
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set
  await act(async () => {
    setter.call(el, on)
    el.dispatchEvent(new window.Event('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

const mod = await import('../src/client/workbench/ModelListSection.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：摊平、分组、存盘请求体
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 纯函数：摊平与按渠道分组 ===')
{
  const rows = mod.rowsOf(CHANNELS)
  /* ⚠️ `rowsOf` 是**纯函数，不筛协议** —— 筛是组件的事（`ModelListSection` 里
   * `channels.filter(c => c.protocol !== 'comfyui')`）。
   * 所以这里 6 条（含 ComfyUI 那条），组件里只会用 5 条。
   * 判据 13 的两个方向各验一半：纯函数「摊平不筛」、组件「渲染筛掉了」。 */
  check('★★ 四条渠道的 6 条模型全摊平出来（`rowsOf` 不筛协议，筛是组件的事）',
    rows.length === 6, '实际 ' + String(rows.length))
  check('★ 每行带齐渠道那几样（渠道名 / 协议 / 地址 / 并发 / 密钥布尔）',
    rows.every(r => typeof r.channelName === 'string' && r.channelName !== ''
      && typeof r.protocol === 'string' && typeof r.baseUrl === 'string'
      && typeof r.maxConcurrency === 'number' && typeof r.hasKey === 'boolean'))
  check('★ 键是「渠道 + 模型 id」两条一起（模型 id 只在渠道内唯一）',
    mod.rowKey({ channelId: 'ch.local', modelId: 'flux-pro' }) === 'ch.local/flux-pro')

  const groups = mod.groupRows(rows)
  check('★★ 判据 1：纯函数按渠道归并成 4 组（含 comfyui 那条，组件里会滤掉它）',
    groups.length === 4, groups.map(g => g.channel.channelId).join(','))
  check('★★ 判据 1：每组名就是渠道名',
    JSON.stringify(groups.map(g => g.channel.channelName))
      === JSON.stringify(['本地渠道', '网络渠道', '老渠道', '本地 comfyui']),
    groups.map(g => g.channel.channelName).join(','))
  check('★ 判据 1：每组下模型数（2 / 2 / 1 / 1）',
    JSON.stringify(groups.map(g => g.models.length)) === JSON.stringify([2, 2, 1, 1]),
    groups.map(g => g.models.length).join(','))
  check('★ 判据 1：同一组的模型渠道 id 一致（分组没串）',
    groups.every(g => g.models.every(x => x.channelId === g.channel.channelId)))

  const flux = rows.find(r => r.modelId === 'flux-pro')
  check('★★ 四类之后 caps=image 只推 image（不再拆 t2i / i2i）',
    JSON.stringify(flux?.types) === JSON.stringify(['image']), JSON.stringify(flux?.types))
  const legacy = rows.find(r => r.modelId === 'legacy-1')
  check('★★ caps 空 + 没 types → 这一条一个类型都没有（不瞎猜）',
    Array.isArray(legacy?.types) && legacy.types.length === 0, JSON.stringify(legacy?.types))
  check('★★ 但它**仍在清单里**（不在任何下拉里 ≠ 从清单里消失）', legacy !== undefined)

  const body = mod.saveBodyOf(CHANNELS[2], rows.filter(r => r.channelId === 'ch.old'))
  check('★ 存盘请求体带 id / name / protocol / baseUrl / maxConcurrency / models',
    body.id === 'ch.old' && body.name === '老渠道' && body.protocol === 'openai'
    && body.maxConcurrency === 1 && Array.isArray(body.models))
  check('★★ **不发** apiKey（空串在宿主那边的语义是「要清掉」）', body.apiKey === undefined)
  check('★★ **不发**那 15 个 ComfyUI 工作流字段（不发 = 沿用旧值）',
    Object.keys(body).every(k => !k.startsWith('comfyui')))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 判据 1 / 13：按渠道分组、模型格里没有 ComfyUI
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 判据 1 / 13：按渠道分组、模型格里没有 ComfyUI ===')
let m = await mount(React.createElement(mod.ModelListSection, { active: true }))
{
  const groups = [...m.el.querySelectorAll('[data-ewb-model-group]')]
  check('★★ 判据 1：清单里 3 个渠道分组', groups.length === 3,
    '实际 ' + String(groups.length) + '：' + groups.map(g => g.getAttribute('data-ewb-model-group')).join(','))
  check('★★ 判据 1：分组顺序与渠道表一致（本地渠道 / 网络渠道 / 老渠道）',
    groups.map(g => g.querySelector('[data-ewb-model-group-name]')?.textContent ?? '').join('|')
      === '本地渠道|网络渠道|老渠道',
    groups.map(g => g.querySelector('[data-ewb-model-group-name]')?.textContent ?? '').join('|'))
  const counts = groups.map(g => g.querySelectorAll('[data-ewb-model-item]').length)
  check('★ 判据 1：每组下模型数（2 / 2 / 1）',
    JSON.stringify(counts) === JSON.stringify([2, 2, 1]), counts.join(','))
  check('★★ 判据 13：模型清单里**没有** ComfyUI 那条渠道',
    m.el.querySelector('[data-ewb-model-group="ch.comfy"]') === null)
  check('★★ 判据 13：整份清单里没有「本地 comfyui」那几个字',
    !(m.el.textContent ?? '').includes('本地 comfyui'))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 判据 2 / 4：每行直接三个勾选框、不需要点开
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 判据 2 / 4：每行直接三个勾选框 ===')
{
  const items = [...m.el.querySelectorAll('[data-ewb-model-item]')]
  check('★★ 判据 2：清单里 5 行（一条模型一行）', items.length === 5, '实际 ' + String(items.length))
  const perRow = items.map(it => ({
    key: it.getAttribute('data-ewb-model-item'),
    boxes: it.querySelectorAll('[data-ewb-model-type]').length,
    labels: [...it.querySelectorAll('[data-ewb-model-types] label')].map(l => (l.textContent ?? '').trim()),
  }))
  /* ⚠️ **2026-10-29（票 76）四个框 → 三个**：渠道里去掉「文本」这一类
   * （文本统一走 dsh），`MODEL_TYPES` 只剩 图片 / 视频 / 音频。
   *
   * **这不是放宽判据**：改的是**类数**，守的事情一个字没变 ——
   * 「每一行直接摆着每一类的勾选框，不需要点开」。
   * 三类就是三个框；写成「3 或 4 都行」才是放宽。 */
  check('★★ 判据 2：**每一行**都有三个勾选框（图片 / 视频 / 音频）',
    perRow.every(r => r.boxes === 3), perRow.map(r => r.key + '=' + r.boxes).join(' '))
  check('★★ 判据 2：三个框的文字就是 图片 / 视频 / 音频',
    perRow.every(r => r.labels.join(',') === '图片,视频,音频'),
    perRow[0]?.labels.join(',') ?? '')
  check('★★ 判据 4：`data-open` 零命中（点行展开那个交互已删）',
    m.el.querySelector('[data-open]') === null)
  check('★★ 判据 4：展开区（`data-ewb-model-item-body`）零命中',
    m.el.querySelectorAll('[data-ewb-model-item-body]').length === 0)
  check('★★ 判据 4：行上那颗 toggle 按钮零命中（`data-ewb-model-item-toggle`）',
    m.el.querySelectorAll('[data-ewb-model-item-toggle]').length === 0)
  check('★★ 判据 2：只读类型小签（`data-ewb-model-tag`）零命中（换成勾选框了）',
    m.el.querySelectorAll('[data-ewb-model-tag]').length === 0)

  const checkedOf = (key) => [...m.el.querySelectorAll('[data-ewb-model-item="' + key + '"] [data-ewb-model-type]')]
    .filter(b => b.checked)
    .map(b => b.getAttribute('data-ewb-model-type').split(':')[1])
  check('★★ 判据 2：caps=image 的那条只勾「图片」',
    JSON.stringify(checkedOf('ch.local/flux-pro')) === JSON.stringify(['image']),
    checkedOf('ch.local/flux-pro').join(','))
  /* ★ 票 76：`caps: ['text']` 的模型**三个框全不勾**。
   *
   * ## 为什么这才是对的
   *
   * 文本已经从「界面上的类型」里拿掉了（`MODEL_TYPES` 三类）。
   * `typesOfCap('text')` 现在返回**空数组** —— 那条模型物理上能做文本，
   * 但界面上它不属于图片 / 视频 / 音频任何一格。
   *
   * 所以它在清单里是「一个类型都没有」，与 `caps: []` 的老模型同一种表现。
   * 这条断言正是票 76 判据 2（`typesOfCap('text')` 返回空数组）在界面上的落点。 */
  check('★★ 票 76：`caps: [text]` 的模型三个框全不勾（文本不再是一类）',
    checkedOf('ch.net/gpt-4o').length === 0,
    checkedOf('ch.net/gpt-4o').join(','))
  check('★★ 票 76：它仍在清单里看得见（不在任何一格 ≠ 从清单里消失）',
    m.el.querySelector('[data-ewb-model-item="ch.net/gpt-4o"]') !== null)
  check('★★ 四类一个都没有的老模型：**四个框全空**，但它仍在清单里',
    checkedOf('ch.old/legacy-1').length === 0
    && m.el.querySelector('[data-ewb-model-item="ch.old/legacy-1"]') !== null,
    checkedOf('ch.old/legacy-1').join(','))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 3：勾选立刻发 POST /channels、回包后状态保持
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 判据 3：勾选立刻写回 ===')
{
  channelPosts.length = 0
  const key = 'ch.local/flux-pro'
  const boxVideo = m.el.querySelector('[data-ewb-model-type="' + key + ':video"]')
  check('★ 前提：图片那条的「视频」框原来是没勾的', boxVideo?.checked === false)
  await setChecked(boxVideo, true)
  check('★★ 判据 3：勾上之后**立刻**发了 POST /channels（不用点保存）',
    channelPosts.length === 1, '实际 ' + String(channelPosts.length))
  const sent = channelPosts[0]
  check('★ 判据 3：发的是**整条渠道**的模型清单（不是只发这一条）',
    Array.isArray(sent?.models) && sent.models.length === 2,
    '模型 ' + String(sent?.models?.length))
  check('★★ 判据 3：那一条的 types 变成 [image, video]（按 MODEL_TYPES 顺序）',
    JSON.stringify(sent?.models?.find(x => x.id === 'flux-pro')?.types)
      === JSON.stringify(['image', 'video']),
    JSON.stringify(sent?.models?.find(x => x.id === 'flux-pro')?.types))
  check('★ 同一渠道里的**另一条**没被改',
    JSON.stringify(sent?.models?.find(x => x.id === 'sdxl-i2i')?.types) === JSON.stringify(['image']),
    JSON.stringify(sent?.models?.find(x => x.id === 'sdxl-i2i')?.types))
  check('★★ 判据 3：只发了那**一条**渠道（没把别的渠道一起发）',
    channelPosts.every(b => b.id === 'ch.local'),
    channelPosts.map(b => b.id).join(','))
  await m.settle()
  check('★★ 判据 3：回包后状态保持（那个框还是勾着的）',
    m.el.querySelector('[data-ewb-model-type="' + key + ':video"]')?.checked === true)
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 判据 5：渠道级信息在渠道小标题那一行
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 判据 5：渠道级信息在小标题行 ===')
{
  const head = m.el.querySelector('[data-ewb-model-group-head="ch.local"]')
  const t = head?.textContent ?? ''
  check('★★ 判据 5：渠道小标题行里有密钥状态', t.includes('未配置密钥') || t.includes('已配置密钥'), t.trim())
  check('★★ 判据 5：渠道小标题行里有并发', t.includes('并发 2'), t.trim())
  check('★ 判据 5：有密钥那条说「已配置密钥」',
    (m.el.querySelector('[data-ewb-model-group-head="ch.net"]')?.textContent ?? '').includes('已配置密钥'))
  const rowText = (m.el.querySelector('[data-ewb-model-item="ch.local/flux-pro"]')?.textContent ?? '').replace(/\s+/g, '')
  check('★★ 判据 5 反面：模型行里**没有**密钥状态与并发（那些在渠道小标题上）',
    !rowText.includes('密钥') && !rowText.includes('并发'), rowText)
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 判据 6 / 7：默认模型块状 + 那段说明已删
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 判据 6 / 7：默认模型块状、说明文字已删 ===')
{
  const { DefaultsSettings } = await import('../src/client/workbench/DefaultsSettings.tsx')
  const d = await mount(React.createElement(DefaultsSettings, { active: true }))
  const grid = d.el.querySelector('[data-ewb-defaults-grid]')
  check('★★ 判据 6：默认模型在一个 grid 容器里（不是一行一个竖排）', grid !== null)
  const style = grid?.getAttribute('style') ?? ''
  check('★★ 判据 6：用的是 `repeat(auto-fill, minmax(…))`（按容器宽度自动排）',
    /repeat\(auto-fill,\s*minmax\(/.test(style), style)
  check('★★ 判据 6：**没有** Tailwind 断点变体（`lg:` / `2xl:` 这类，本仓库不发射）',
    !/(^|\s)(lg|xl|2xl|md|sm):/.test(grid?.className ?? ''), grid?.className ?? '')
  check('★ 判据 6：四块都在（每类一块）',
    d.el.querySelectorAll('[data-ewb-defaults-row]').length === 4,
    String(d.el.querySelectorAll('[data-ewb-defaults-row]').length))
  check('★★ 判据 7：那段总说明已删（`data-ewb-defaults-note` 零命中）',
    d.el.querySelector('[data-ewb-defaults-note]') === null)
  check('★★ 判据 7：全文不再有「留空表示这一类不设默认」',
    !(d.el.textContent ?? '').includes('留空表示这一类不设默认'))
  const unsetTexts = [...d.el.querySelectorAll('[data-ewb-defaults-phase="unset"] [data-ewb-defaults-state]')]
    .map(e => e.textContent ?? '')
  check('★★ 说明删了但「没设会报错」还在（在每行状态文字里）',
    unsetTexts.length > 0 && unsetTexts.every(x => x.includes('报错')),
    unsetTexts[0]?.slice(0, 50) ?? '（一行未设的都没有）')
  d.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 判据 8 / 9：「dsh 内置」组
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑦ 判据 8 / 9：dsh 目录加进清单 ===')
{
  picksNow = []
  channelPosts.length = 0
  prefsPosts.length = 0
  m.unmount()
  const { ModelSettings } = await import('../src/client/workbench/WorkspaceSettings.tsx')
  const dsh = await mount(React.createElement(ModelSettings, {}))
  const det = dsh.el.querySelector('[data-ewb-dsh-catalog]')
  check('★★ 判据 8：dsh 目录仍是 `<details>` 且默认收起',
    det !== null && det.tagName.toLowerCase() === 'details' && !det.hasAttribute('open'),
    det === null ? '(没有)' : (det.hasAttribute('open') ? 'open 在' : '收起'))
  const addBtns = [...dsh.el.querySelectorAll('[data-ewb-model-toggle]')]
  check('★★ 判据 8：每个 dsh 模型一颗「加入清单」按钮', addBtns.length === 3,
    '实际 ' + String(addBtns.length))
  check('★★ 判据 8：按钮文字是「加入清单」（不再是「加入备选」）',
    addBtns.every(b => (b.textContent ?? '').trim() === '加入清单'),
    addBtns.map(b => (b.textContent ?? '').trim()).join(' / '))

  channelPosts.length = 0
  prefsPosts.length = 0
  await click(addBtns[0])
  check('★★ 判据 9：加进清单发的是 `POST /models/prefs`（不是 `/channels`）',
    prefsPosts.length === 1, 'prefs ' + String(prefsPosts.length))
  check('★★ 判据 9（本票最要紧）：加进清单**一次都没**发 `POST /channels`',
    channelPosts.length === 0, 'channels ' + String(channelPosts.length))
  check('★ 判据 8：发出去的是 picks（`{provider, model}` 两条）',
    Array.isArray(prefsPosts[0]?.picks) && prefsPosts[0].picks.length === 1
    && typeof prefsPosts[0].picks[0]?.provider === 'string'
    && typeof prefsPosts[0].picks[0]?.model === 'string',
    JSON.stringify(prefsPosts[0]?.picks))
  dsh.unmount()

  const m2 = await mount(React.createElement(mod.ModelListSection, { active: true }))
  const dshGroup = m2.el.querySelector('[data-ewb-model-group="dsh"]')
  check('★★ 判据 8：「dsh 内置」那一组出现在清单里', dshGroup !== null)
  check('★★ 判据 8：组名就是「dsh 内置」',
    (dshGroup?.querySelector('[data-ewb-model-group-name]')?.textContent ?? '') === 'dsh 内置')
  const dshRows = [...(dshGroup?.querySelectorAll('[data-ewb-dsh-row]') ?? [])]
  check('★ 判据 8：加进来的那条在组里', dshRows.length === 1,
    dshRows.map(r => r.getAttribute('data-ewb-dsh-row')).join(','))
  /* ★ 票 76：dsh 那行**不再画勾选框**，改成一句话。
   *
   * ## 为什么
   *
   * 票 75 那版给它画了一排只读框、标着「文本」并勾上 —— 意图是
   * 「它是文本模型，类型不用改」。票 76 把「文本」从类型里去掉之后，
   * 这个做法就没有落点了：三个框全不勾，用户会问「为什么它什么都不是」。
   *
   * 所以改成一句话说明（`ModelListSection.tsx` 里那句
   * 「文本模型（走 dsh，不属于图片 / 视频 / 音频任何一类）」）。
   *
   * ⚠️ 这条断言**没有放宽**，反而更严：改前只要「有一个禁用框」就算过，
   * 改后要求「一个框都没有，且写清了为什么」。 */
  const dshBoxes = [...(dshRows[0]?.querySelectorAll('[data-ewb-model-type]') ?? [])]
  check('★★ 票 76：「dsh 内置」那行**没有**勾选框（不画三个全空的灰框）',
    dshBoxes.length === 0, String(dshBoxes.length) + ' 个')
  const dshRowText = dshRows[0]?.textContent ?? ''
  check('★★ 票 76：它改写成一句话，说清了「走 dsh、不属于这三类」',
    dshRowText.includes('走 dsh') && dshRowText.includes('不属于'),
    dshRowText.replace(/\s+/g, ' ').trim().slice(0, 80))
  /* 反面对照：渠道模型那几行**仍然**有三个框（别把两件事一起改没）。 */
  check('★★ 票 76 反面：渠道模型那几行仍然有三个勾选框',
    [...m2.el.querySelectorAll('[data-ewb-model-item="ch.local/flux-pro"] [data-ewb-model-type]')].length === 3)

  channelPosts.length = 0
  prefsPosts.length = 0
  await setChecked(dshBoxes[0], false)
  check('★★ 判据 9（本票最要紧）：点「dsh 内置」的勾选框**不发** `POST /channels`',
    channelPosts.length === 0, 'channels ' + String(channelPosts.length))

  channelPosts.length = 0
  prefsPosts.length = 0
  await click(dshRows[0]?.querySelector('[data-ewb-dsh-remove]'))
  check('★★ 判据 9：移出清单也走 `POST /models/prefs`',
    prefsPosts.length === 1 && channelPosts.length === 0,
    'prefs ' + String(prefsPosts.length) + ' / channels ' + String(channelPosts.length))
  m2.unmount()
  picksNow = []
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 判据 11 / 12 / 13：三格 + ComfyUI 格
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑧ 判据 11 / 12 / 13：配置板块三格、ComfyUI 格 ===')
{
  const { CONFIG_BOARD_TABS, normalizeConfigTab, ConfigBoard } = await import('../src/client/workbench/ConfigBoard.tsx')
  check('★★ 判据 11：配置板块是**三格**，顺序 模型 / ComfyUI / 其它',
    JSON.stringify([...CONFIG_BOARD_TABS]) === JSON.stringify(['model', 'comfyui', 'other']),
    [...CONFIG_BOARD_TABS].join(','))
  check('★★ 判据 11：`normalizeConfigTab` 认得 comfyui（不打回 model）',
    normalizeConfigTab('comfyui') === 'comfyui', normalizeConfigTab('comfyui'))
  check('★ 判据 11：坏值仍回 model', normalizeConfigTab('乱写的') === 'model')

  const cf = await mount(React.createElement(ConfigBoard, { active: true, tab: 'comfyui' }))
  check('★★ 判据 12：ComfyUI 格挂上了（渠道列表在那儿）',
    cf.el.querySelector('[data-ewb-channels]') !== null)
  check('★★ 判据 12：有新建渠道的入口（地址 / 密钥 / 并发在表单里）',
    cf.el.querySelector('[data-ewb-channel-new]') !== null)
  check('★★ 判据 12：标题说的是 ComfyUI（不是「内容渠道与并发」）',
    (cf.el.querySelector('[data-ewb-channel-head]')?.textContent ?? '').includes('ComfyUI'),
    cf.el.querySelector('[data-ewb-channel-head]')?.textContent ?? '')
  check('★★ 判据 12（本票核心）：ComfyUI 格里**没有**四类勾选框',
    cf.el.querySelectorAll('[data-ewb-model-type]').length === 0,
    '实际 ' + String(cf.el.querySelectorAll('[data-ewb-model-type]').length) + ' 个')
  check('★★ 判据 12：也没有模型清单（那是模型格的东西）',
    cf.el.querySelector('[data-ewb-model-list]') === null)
  /* 反面：模型格的东西**一个都不许**混进来。 */
  check('★★ 判据 12：也没有四类默认模型块（那在模型格）',
    cf.el.querySelector('[data-ewb-defaults]') === null)
  cf.unmount()

  const mv = await mount(React.createElement(ConfigBoard, { active: true, tab: 'model' }))
  check('★★ 判据 13：模型格里没有 ComfyUI 那条渠道',
    mv.el.querySelector('[data-ewb-model-group="ch.comfy"]') === null)
  check('★★ 判据 13：模型格里有模型清单', mv.el.querySelector('[data-ewb-model-list]') !== null)
  check('★ 判据 11：模型格里没有 ComfyUI 格的东西（渠道列表那套）',
    mv.el.querySelector('[data-ewb-channels]') === null)
  mv.unmount()
}

console.log('')
console.log(failed === 0 ? '结论：模型清单按渠道分组接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
