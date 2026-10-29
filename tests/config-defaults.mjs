/** 配置页 · 五类默认模型（P3 第 2 块，用户 m03414；票 68 四类扩五类）。
 *
 * ## 这一块是什么
 *
 * 用户直接问过「生图 / 视频 / 文本 / 音频的模型设置在哪」。后端三层规则
 * （`ce8c81c`）的 ② ③ 两层全靠 `model-defaults.json`，而界面原来一个下拉都没有 ——
 * 所以 ② 永远走不到，③ 那句「去设置里选一个」用户永远看不到（因为没法设）。
 *
 * ## 判据（lead 的六条通用 + 补的三条）
 *
 * 1 能点到 —— 四个下拉 + 保存按钮
 * 2 点了真发 —— 断言发 `PUT /model-defaults`
 * 3 回包反映到界面 —— 存完再读，下拉里是新值、状态文字变「已设」
 * 4 失败要说清 —— 后端错误原话要显示
 * 5 不许自己挑模型 —— 源码断言：没有回落「清单第一个」
 * 6 自证 —— 见下
 * 7 **「未设」与「设了但坏了」必须长得不一样** —— `broken` 有值时标红 + 原话，
 *   不许与「未设」混同（混同的后果：用户以为没设，去设第二个，坏的引用还在）
 * 8 **下拉只列 caps 对得上的模型** —— 断言按 `kind` 拉、且用完选不能做的那条就没有
 * 9 「设完之后生成能用上它」—— **这条做不了跨层验**，见下面 `③` 段末尾的说明
 *
 * 跑法：node scripts/run-tests.mjs config-defaults
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
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'DocumentFragment', 'MouseEvent']) globalThis[k] = window[k]
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
/** 发出的 PUT（断言「点了真发」）。 */
const puts = []
/** 收到的 `/gen-models?kind=` 请求（断言「按 kind 筛」）。 */
const kindRequests = []
/** `GET /model-defaults` 回什么（测试逐段改）。
 *
 * ⚠️ **2026-10-29（票 68）四类 → 五类**：`image` 拆成 `t2i` / `i2i`。
 * 键名照 `src/schedule/model-defaults.ts` 的 `DEFAULT_KEYS`。 */
let defaultsReply = {
  defaults: {},
  status: { text: false, t2i: false, i2i: false, video: false, audio: false },
  broken: {},
}
/** 每类各回哪些模型（模拟后端按 kind 筛过）。
 *
 * ⚠️ 票 68：五类各一条，且 `t2i` 与 `i2i` 是**两条不同的模型** ——
 * 用同一条会验不出「下拉里选到的是这一类那一条」这件事。 */
const modelsByKind = {
  text: [{ channelId: 'ch-b', channelName: '渠道乙', modelId: 'txt-1', modelLabel: '文本一号' }],
  image: [{ channelId: 'ch-a', channelName: '渠道甲', modelId: 'img-1', modelLabel: '文生图一号' }],
  video: [{ channelId: 'ch-a', channelName: '渠道甲', modelId: 'vid-1', modelLabel: '视频一号' }],
  audio: [{ channelId: 'ch-b', channelName: '渠道乙', modelId: 'aud-1', modelLabel: '音频一号' }],
}
/** `PUT` 回什么。 */
let putReply = { status: 200, body: { ok: true } }

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  if (p.startsWith('/api/ecom-workbench/gen-models') && method === 'GET') {
    /* ⚠️ `[a-z0-9]+` 不是 `[a-z]+`：票 68 之后有一类叫 `t2i`，
     * 用 `[a-z]+` 会把它截成 `t`（实测踩过，表现是 kindRequests 里出现 `t`）。 */
    const kind = /kind=([a-z0-9]+)/.exec(p)?.[1] ?? ''
    kindRequests.push(kind)
    const list = modelsByKind[kind] ?? []
    return { ok: true, status: 200, json: async () => ({ ok: true, models: list, items: list }) }
  }
  if (p === '/api/ecom-workbench/model-defaults' && method === 'GET') {
    return { ok: true, status: 200, json: async () => ({ ok: true, ...defaultsReply }) }
  }
  if (p === '/api/ecom-workbench/model-defaults' && method === 'PUT') {    const body = JSON.parse(String(init?.body ?? '{}'))
    puts.push(body)
    if (putReply.status !== 200) {
      return { ok: false, status: putReply.status, json: async () => putReply.body }
    }
    /* 成功：把发来的（整份）写回，模拟后端整份覆盖。
     *
     * ⚠️ 键名用**显式表**，不能靠「首字母大写」拼 —— `t2i` 拼出来是
     * `defaultT2iModel`，而后端（`model-defaults.ts` 的 `DEFAULT_KEYS`）
     * 是 `defaultT2IModel`。差一个字母，桩就会把界面发来的正确键当成「不认识的键」
     * 丢掉，然后断言全红在「存完了却没生效」这种误导性的地方。
     * 这是本票实测踩到的一个真 bug（界面侧的 `keyOf` 也是同一个错）。 */
    const keys = {
      text: 'defaultTextModel',
      image: 'defaultImageModel',
      video: 'defaultVideoModel',
      audio: 'defaultAudioModel',
    }
    const defaults = {}
    const status = { text: false, image: false, video: false, audio: false }
    for (const [kind, key] of Object.entries(keys)) {
      const v = body?.[key]
      if (v !== null && typeof v === 'object' && typeof v.channelId === 'string' && typeof v.modelId === 'string') {
        defaults[key] = v
        status[kind] = true
      }
    }
    defaultsReply = { defaults, status, broken: {} }
    putReply = { status: 200, body: { ok: true } }
    return { ok: true, status: 200, json: async () => putReply.body }
  }
  /* ⑥ 段要挂整个「配置格」，它会拉渠道表 —— 给一条最小回包，
   * 否则断言「渠道列表还在」会红，而那不是代码的问题。 */
  if (p === '/api/ecom-workbench/channels' && method === 'GET') {
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        channels: [{
          id: 'ch-a', name: '渠道甲', protocol: 'openai', baseUrl: 'http://127.0.0.1:8188',
          hasKey: true, models: [{ id: 'img-1', label: '生图一号', caps: ['image'] }], maxConcurrency: 3,
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
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/** 点一下。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await settle() })
}

/** 给 `<select>` 选一个值（受控 select 要走原生 setter + change 事件）。 */
async function choose(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

const mod = await import('../src/client/workbench/DefaultsSettings.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：三态判定、整份覆盖、按 kind 摊平
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 纯函数：三态、整份覆盖、按能力摊平 ===')
{
  /* ⚠️ **2026-10-29（票 74）五类 → 四类**：用户否掉了「文生图 / 图生图」的拆分。
   * 改的是类数与键名，守的事情没变：类数固定、顺序照 `MODEL_TYPES`、
   * 键名与后端 `DEFAULT_KEYS` 逐字一致。 */
  check('四类键序固定（文本/图片/视频/音频）',
    JSON.stringify(mod.DEFAULT_KINDS) === JSON.stringify(['text', 'image', 'video', 'audio']),
    mod.DEFAULT_KINDS.join(','))
  check('★★ 四类中文名与后端 MODEL_TYPE_LABEL 逐字一致',
    mod.KIND_LABEL.text === '文本' && mod.KIND_LABEL.image === '图片'
    && mod.KIND_LABEL.video === '视频' && mod.KIND_LABEL.audio === '音频',
    Object.values(mod.KIND_LABEL).join(' / '))
  check('★ 存储键名照后端的 DEFAULT_KEYS（四类）',
    mod.keyOf('text') === 'defaultTextModel' && mod.keyOf('image') === 'defaultImageModel'
    && mod.keyOf('video') === 'defaultVideoModel' && mod.keyOf('audio') === 'defaultAudioModel',
    mod.DEFAULT_KINDS.map(k => mod.keyOf(k)).join(','))

  /* ── 判据 7 的核心：三态必须分得开 ── */
  const unset = mod.kindState({ defaults: {}, status: { image: false }, broken: {} }, 'image')
  check('★★ 判据 7：没设 → phase=unset，且**说清没设会报错**',
    unset.phase === 'unset' && unset.text.includes('未设') && unset.text.includes('报错'), unset.text)

  const set = mod.kindState({
    defaults: { defaultImageModel: { channelId: 'ch-a', modelId: 'img-1' } },
    status: { image: true }, broken: {},
  }, 'image')
  check('★★ 判据 7：设了 → phase=set，显示渠道与模型',
    set.phase === 'set' && set.text.includes('ch-a') && set.text.includes('img-1'), set.text)

  const broken = mod.kindState({
    defaults: { defaultImageModel: { channelId: 'gone', modelId: 'x' } },
    status: { image: true },
    broken: { image: '这条默认指向的渠道已经不在了：gone' },
  }, 'image')
  check('★★ 判据 7：设了但坏了 → phase=broken（**不是** unset），且带原因',
    broken.phase === 'broken' && broken.text.includes('已经不在了'), broken.phase + ' | ' + broken.text)
  check('★★ 判据 7：broken 优先于 status（设了但坏了不许显示成「设好了」）',
    broken.phase !== 'set')
  check('★★ 判据 7：broken 不许显示成「未设」（那会让用户以为没设过）',
    broken.phase !== 'unset' && !broken.text.includes('未设'))

  /* ── 判据：整份覆盖，五类全发 ── */
  const body = mod.toSaveBody({ image: { channelId: 'ch-a', modelId: 'img-1' } })
  check('★★ 整份覆盖：四类**全部**要发（只发一类会把别的三类清掉）',
    Object.keys(body).length === 4, Object.keys(body).join(','))
  check('★★ 没选的那几类发 `null`（显式表示「清掉」，不是省略）',
    body.defaultVideoModel === null && body.defaultTextModel === null
    && body.defaultAudioModel === null,
    JSON.stringify(body))
  check('★ 选了的那一类是两条都有的引用',
    body.defaultImageModel?.channelId === 'ch-a' && body.defaultImageModel?.modelId === 'img-1')

  /* 半条引用不许造出来。 */
  const half = mod.toSaveBody({ image: { channelId: 'ch-a', modelId: '' } })
  check('★★ 半条引用（只有渠道没有模型）不发，发 null（比没有更糟）',
    half.defaultImageModel === null, JSON.stringify(half.defaultImageModel))

  /* 按 kind 摊平。 */
  const choices = mod.toChoices({ models: modelsByKind.image })
  check('★ 摊平出选项（渠道名 + 模型名都在）',
    choices.length === 1 && choices[0].channelName === '渠道甲' && choices[0].modelLabel === '文生图一号')
  check('★ 同渠道同模型去重', mod.toChoices({
    models: [modelsByKind.image[0], modelsByKind.image[0]],
  }).length === 1)
  check('★ `models` 与 `items` 两种回包都认（后端两种都回过）',
    mod.toChoices({ items: modelsByKind.image }).length === 1)
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 真挂：四个下拉、按 kind 拉模型、保存真发、回包反映
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 真挂：四个下拉、按 kind 拉、保存真发、回包反映 ===')
{
  puts.length = 0
  kindRequests.length = 0
  defaultsReply = {
    defaults: {},
    status: { text: false, t2i: false, i2i: false, video: false, audio: false },
    broken: {},
  }
  const m = await mount(React.createElement(mod.DefaultsSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)

  /* 判据 1：能点到。 */
  const selects = [...m.el.querySelectorAll('[data-ewb-defaults-select]')]
  /* ⚠️ **2026-10-29（票 74）五类 → 四类**：用户否掉了拆分，后端 `MODEL_TYPES`
   * 也回到 `text / image / video / audio`。判据改的是**类数**，守的事情没变：
   * 「每类一个下拉、顺序照 `MODEL_TYPES`」。 */
  check('★★ 判据 1：四类各一个下拉', selects.length === 4, '实际 ' + String(selects.length))
  check('★★ 判据 1：四类的 kind 都在（顺序照 MODEL_TYPES）',
    selects.map(s => s.getAttribute('data-ewb-defaults-select')).join(',') === 'text,image,video,audio',
    selects.map(s => s.getAttribute('data-ewb-defaults-select')).join(','))
  check('★★ 判据 1：有保存按钮', q('[data-ewb-defaults-save]') !== null)
  check('★★ 判据 1：「未设」是下拉里的一个**真实选项**（不是占位）',
    [...m.el.querySelectorAll('option')].some(o => (o.textContent ?? '').includes('未设')))
  /* ⚠️ **2026-10-29（票 75）换了锚点，守的事情没变**。
   *
   * 用户原话：「当前默认模型说明文字太多了」—— 那段总说明被删了
   * （`data-ewb-defaults-note` 这个钩子随之消失）。
   *
   * 但「没设会报错」这句话**不能跟着消失**：那句话本来告诉用户
   * 「留空不是省事，留空生成会失败」。它原来在总说明里，
   * 现在在**每一行未设时的状态文字**里（`kindState` 的 `unset` 文案）。
   *
   * 所以判据从「总说明里有『报错』」改成「**未设的那些行**里有『报错』」——
   * 后者比前者更强：它逼着那句话跟着**每一格的状态**走，
   * 而不是挂在一段可能被删的总说明上（这次就是被删了）。
   *
   * ⚠️ 这条**不是放宽**：改前只要任一处出现「报错」就算过（那段总说明是常量，
   * 永远在），改后要求**每一行未设的行自己说出来**。条数一样多，强度更高。 */
  const unsetTexts = [...m.el.querySelectorAll('[data-ewb-defaults-phase="unset"] [data-ewb-defaults-state]')]
    .map(e => (e.textContent ?? ''))
  check('★★ 判据 1：未设的那几行自己写清了「没设会报错」',
    unsetTexts.length > 0 && unsetTexts.every(t => t.includes('报错')),
    unsetTexts.length === 0 ? '一行未设的都没有（前提不成立）' : unsetTexts[0].slice(0, 60))

  /* ── 判据 8：按 kind 拉，不是拉一份全量的自己筛 ── */
  check('★★ 判据 8：四类各按自己的 kind 拉模型（`?kind=` 都带上了）',
    ['text', 'image', 'video', 'audio'].every(k => kindRequests.includes(k)),
    kindRequests.join(','))
  /* ★ 票 68 新增：**文生图与图生图各是各的下拉**，选项不许互通。
   *
   * 这是「五类」这个改动真正的价值 —— 四类时两者共用一个 `image`，
   * 一条只会文生图的模型也能被选成图生图默认，那要到生成时才报错。 */
  check('★★ 判据 8：图片那一类里只有能出图的模型（不会出现视频模型）',
    [...m.el.querySelectorAll('[data-ewb-defaults-select="image"] option')]
      .every(o => o.getAttribute('value') === '' || o.getAttribute('value') === 'ch-a/img-1'),
    [...m.el.querySelectorAll('[data-ewb-defaults-select="image"] option')].map(o => o.getAttribute('value')).join(' '))

  /* 判据 7（真挂层面）：四类一开始都是「未设」。 */
  check('★★ 判据 7：四类一开始都显示「未设」',
    [...m.el.querySelectorAll('[data-ewb-defaults-phase]')].every(e => e.getAttribute('data-ewb-defaults-phase') === 'unset'),
    [...m.el.querySelectorAll('[data-ewb-defaults-phase]')].map(e => e.getAttribute('data-ewb-defaults-phase')).join(','))

  /* 判据 2 + 3：选一类、保存、回包反映。 */
  await choose(q('[data-ewb-defaults-select="image"]'), 'ch-a/img-1')
  await click(q('[data-ewb-defaults-save]'))
  check('★★ 判据 2：点保存真的发了 PUT /model-defaults', puts.length === 1, '实际 ' + String(puts.length))
  check('★★ 判据 2：发的是四类整份（不是只发选过那一类）',
    Object.keys(puts[0] ?? {}).length === 4, Object.keys(puts[0] ?? {}).join(','))
  check('★★ 判据 2：选过的那一类是那两条',
    puts[0]?.defaultImageModel?.channelId === 'ch-a' && puts[0]?.defaultImageModel?.modelId === 'img-1')
  check('★★ 判据 2：没选的另三类发的是 null（整份覆盖，会把它们清掉）',
    puts[0]?.defaultVideoModel === null && puts[0]?.defaultTextModel === null
    && puts[0]?.defaultAudioModel === null)

  await m.settle()
  check('★★ 判据 3：存完下拉里就是那个值',
    q('[data-ewb-defaults-select="image"]')?.value === 'ch-a/img-1',
    q('[data-ewb-defaults-select="image"]')?.value ?? '')
  check('★★ 判据 3：那一类的状态文字变成「已设」',
    (q('[data-ewb-defaults-state="image"]')?.textContent ?? '').includes('已设'),
    q('[data-ewb-defaults-state="image"]')?.textContent ?? '')
  check('★★ 判据 3：那一类的 phase 变成 set',
    q('[data-ewb-defaults-row="image"]')?.getAttribute('data-ewb-defaults-phase') === 'set')
  check('★ 存完有一句结果说明', q('[data-ewb-defaults-saved]') !== null)
  check('★ 其余三类仍是「未设」（没被误改）',
    q('[data-ewb-defaults-row="video"]')?.getAttribute('data-ewb-defaults-phase') === 'unset'
    && q('[data-ewb-defaults-row="text"]')?.getAttribute('data-ewb-defaults-phase') === 'unset')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 判据 7 的真挂部分：设了但坏了 → 标红 + 原话，不许与「未设」混同
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 判据 7：设了但坏了，界面要标红并说清 ===')
{
  defaultsReply = {
    defaults: { defaultImageModel: { channelId: 'gone-ch', modelId: 'gone-m' } },
    status: { text: false, image: true, video: false, audio: false },
    broken: { image: '这条默认指向的渠道已经不在了：gone-ch' },
  }
  const m = await mount(React.createElement(mod.DefaultsSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)
  const row = q('[data-ewb-defaults-row="image"]')
  check('★★ 判据 7：坏了的那一类 phase=broken（不是 unset、不是 set）',
    row?.getAttribute('data-ewb-defaults-phase') === 'broken',
    row?.getAttribute('data-ewb-defaults-phase') ?? '')
  check('★★ 判据 7：状态文字是后端那句原因（不是「未设」）',
    (q('[data-ewb-defaults-state="image"]')?.textContent ?? '').includes('已经不在了'),
    q('[data-ewb-defaults-state="image"]')?.textContent ?? '')
  check('★★ 判据 7：那一行**边框标红**（肉眼可辨）',
    (row?.className ?? '').includes('border-[#ff5f6d]'), row?.className ?? '')
  check('★ 没坏的另外三类不受影响（仍是正常边框）',
    !(q('[data-ewb-defaults-row="video"]')?.className ?? '').includes('border-[#ff5f6d]')
    && !(q('[data-ewb-defaults-row="text"]')?.className ?? '').includes('border-[#ff5f6d]'))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 4：保存失败要说清原因
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 判据 4：后端拒绝时显示原话 ===')
{
  puts.length = 0
  defaultsReply = {
    defaults: {},
    status: { text: false, image: false, video: false, audio: false },
    broken: {},
  }
  putReply = {
    status: 400,
    body: { ok: false, error: 'defaultImageModel 只有 channelId 没有 modelId —— 半条引用比没有更糟' },
  }
  const m = await mount(React.createElement(mod.DefaultsSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)
  await choose(q('[data-ewb-defaults-select="image"]'), 'ch-a/img-1')
  await click(q('[data-ewb-defaults-save]'))
  check('★★ 判据 4：失败时显示后端那句原因',
    (q('[data-ewb-defaults-error]')?.textContent ?? '').includes('半条引用'),
    (q('[data-ewb-defaults-error]')?.textContent ?? '').slice(0, 70))
  check('★★ 判据 4：失败时**不显示**「已保存」',
    q('[data-ewb-defaults-saved]') === null)
  m.unmount()
  putReply = { status: 200, body: { ok: true } }
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 判据 8 的另一半：某类一条模型都没有时要说清为什么
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 某类没有可用模型 → 说清原因，不是空下拉 ===')
{
  defaultsReply = {
    defaults: {},
    status: { text: false, image: false, video: true, audio: false },
    broken: {},
  }
  const origVideo = modelsByKind.video
  modelsByKind.video = []
  const m = await mount(React.createElement(mod.DefaultsSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)
  /* ⚠️ 认的字从「能力」换成「这一类型」：票 68 把这句改成了
   * 「还没有这一类型的模型 —— 先在下面的清单里给模型标上「文生视频」」。
   * 改的原因是**说法的对象变了** —— 以前是「给模型标上 caps 能力」，
   * 现在界面上那个东西叫「类型」。守的事情没变：空下拉要给一句为什么。 */
  check('★★ 判据 8：没有可用模型时给一句「为什么」',
    (q('[data-ewb-defaults-empty="video"]')?.textContent ?? '').includes('这一类型'),
    q('[data-ewb-defaults-empty="video"]')?.textContent ?? '')
  check('★ 有模型的类别**不显示**那句（不是每行都挂一个）',
    q('[data-ewb-defaults-empty="image"]') === null)
  m.unmount()
  modelsByKind.video = origVideo
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 接进界面
 *
 * ## 2026-10-27（票 10）：那时是「默认模型」一个 tab
 *
 * 挂 `ChannelSettings` 已经看不到这一块了，所以改成挂 `ConfigTabs` 并落到那个 tab。
 *
 * ## ★ 2026-10-28（票 38）：四类默认模型**上收到工作台设置**，配置页不再有它
 *
 * 用户原话（票 37 条目一）：「渠道、默认模型应该放到工作台设置中。其他三项
 * 提示词源、存储、偏好保留在内容板块」。
 *
 * 所以这一段**改挂点、不断言数**：原来 3 条断言，现在还 3 条，只是第一条换了对象：
 *
 * | 原断言 | 现在断言什么 | 为什么 |
 * |---|---|---|
 * | 配置页里能点到四个下拉 | **工作台设置里**能点到四个下拉 | 这四个下拉搬过去了 |
 * | 存储目录不在这一页 | 配置页里**没有**四个下拉（搬走之后这里必须干净） | 反过来钉同一件事：两处不许都有 |
 * | 渠道列表也不在这一页 | 配置页里没有渠道列表（渠道也搬走了） | 同上 |
 *
 * ⚠️ 「两处不许都有」这一条是搬家类改动**唯一**能防住「搬了但没删干净」的判据。
 * 只验新位置有、不验旧位置没有，会出现「两处都能改、改一处另一处不生效」。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 默认模型现在在**配置板块**里，配置页里没有 ===')
{
  /* ① 新位置：配置板块的「模型」那一格里能点到四个下拉。
   *
   * ⚠️ 票 66 改了挂载对象：原来是 `WorkspaceSettings({ open: true })` 那个抽屉，
   * 抽屉已删、内容搬进 `ConfigBoard` 的两格 tab。
   *
   * **判据的意思一个字没改** —— 仍是「这四个下拉住在这个设置页里，
   * 而且四类默认那一节与前面几节分得开」。只换挂谁。
   *
   * ⚠️ `tab` 必须给 `'model'`：`ConfigBoard` 只渲染当前那一格，
   * 给 `'other'` 就一个下拉都挂不出来（那正是判据 6 要的行为）。 */
  const { ConfigBoard } = await import('../src/client/workbench/ConfigBoard.tsx')
  const ws = await mount(React.createElement(ConfigBoard, { active: true, tab: 'model' }))
  check('★★ 配置板块的模型格里能点到四类默认模型的四个下拉（票 38 搬到设置里，票 66 搬进板块，票 74 退回四类）',
    ws.el.querySelectorAll('[data-ewb-defaults-select]').length === 4,
    '实际 ' + String(ws.el.querySelectorAll('[data-ewb-defaults-select]').length))
  check('★ 而且它包在「内容默认模型」那一节里（与「模型」那一节分得开）',
    ws.el.querySelector('[data-ewb-content-defaults-section]') !== null)
  /* 反面：同一次挂载里，「其它」那一格的东西**不在** —— 见票 66 判据 6。
   * 这里顺带钉一句，免得将来有人为了让下拉挂出来而把两格一起渲染。 */
  check('★★ 反面：同一次挂载里「其它」那一格的内容不在（只渲染当前格）',
    ws.el.querySelector('[data-ewb-notify-section]') === null,
    '实际 ' + String(ws.el.querySelectorAll('[data-ewb-notify-section]').length) + ' 个')
  ws.unmount()

  /* ② 旧位置：配置页里必须**一个都不剩**（搬干净了）。 */
  const { ConfigTabs } = await import('../src/client/workbench/ConfigTabs.tsx')
  const m = await mount(React.createElement(ConfigTabs, { active: true, initialTab: 'storage' }))
  check('★★ 配置页里**没有**四类默认模型的下拉了（搬走之后不留第二处入口）',
    m.el.querySelectorAll('[data-ewb-defaults-select]').length === 0,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-defaults-select]').length))
  check('★ 配置页里也没有渠道列表（渠道与四类一起搬走的）',
    m.el.querySelectorAll('[data-ewb-channel-row]').length === 0,
    '渠道行 ' + String(m.el.querySelectorAll('[data-ewb-channel-row]').length))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 判据 5：源码里不许自己挑模型
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑦ 判据 5：不许自己挑模型 / 不许回落清单第一个 ===')
{
  const src = readFileSync(new URL('../src/client/workbench/DefaultsSettings.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★ 判据 5：源码里没有「取清单第一个」的回落',
    !/\[0\]\s*\?\.\s*(channelId|modelId)/.test(code) && !/\.at\(0\)\s*\?\./.test(code))
  check('★★ 判据 5：没设时**不给**任何默认值（不给 items[0]）',
    !/choices\[kind\]\s*\[\s*0\s*\]\s*\)/.test(code) && !/list\[0\]/.test(code.replace(/list\.map/g, '')))
  check('★ 没有裸 `import antd`（按需引入）', !/import\s+\w+\s+from\s+'antd'/.test(code))
  /* 判据 9：这条跨层断言做不了，如实写明。 */
  console.log('   ⚠️ 判据 9（设完之后生成真能用上它）**本文件没有验**：')
  console.log('      那要真跑一次生成（POST /generate → 后端按默认模型解析 → 轮询出图），')
  console.log('      属于 content-canvas-ops / workbenches-submit 那一侧的端到端，不是配置页的职责。')
  console.log('      这里只验「设得进去」与「读得回来」；后端三层规则由 src/schedule 的')
  console.log('      generate.ts 单测守着（gen-model-target.mjs）。')
}

console.log('')
console.log(failed === 0 ? '结论：四类默认模型接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
