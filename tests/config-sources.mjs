/** 配置页 · 提示词源（P3 第 4 块，用户 m03414）。
 *
 * ## 这一块是什么
 *
 * 后端把提示词源做成可配置的（`docs/机制-配置面接口.md` §四）：五个内置源能改名 /
 * 改地址 / 停用（**删不掉**），用户还能加自己的源。而界面原来一个入口都没有。
 *
 * ## 判据（lead 的十条）
 *
 * 1 列表显示全部源，**标出哪些是内置**
 * 2 内置源的删除按钮**不存在**，且**明确说明原因**（选了「不存在 + 一句话」这个方案）
 * 3 停用内置 → 确认提示 → 真发 PUT → **提示词库里真没有它了**（跨层）
 * 4 加自定义源 → 真发 POST → 列表里出现，名字用用户给的
 * 5 改名字 → 真发 PUT → 界面显示新值
 * 6 删自定义源 → 真发 DELETE → 列表里没了
 * 7 测连通 → 真发 probe → 显示结果
 * 8 **全部停用 → 空态要有一句话**
 * 9 **刷新入口不存在**（反面判据，防止后来有人顺手加一个坏掉的）
 * 10 自证：至少 3 处变红
 *
 * ## 判据 2 为什么选「不存在 + 一句话」而不是「灰按钮」
 *
 * 灰按钮的语义是「现在不能点，但条件满足就能点」—— 而内置源**永远不能删**。
 * 一个永远灰的按钮只会让用户一直试点。所以内置那几行**不渲染删除按钮**，
 * 换成一句「内置 · 只能停用」，旁边给「停用」按钮。
 *
 * ## 判据 9：**刷新按钮必须有**（2026-10-26 第二次改口，如实记录）
 *
 * 这个判据前后翻过两次，两次都写清在这里，免得下一个人以为有人随手改判据：
 *
 * | 版本 | 断言 | 当时的理由 |
 * |---|---|---|
 * | 第一版（`50797ab`） | **断言没有**刷新按钮 | 当时 `docs §四` 写着「界面还没有入口」，我读成「这条链路没验过，不做半成品」 |
 * | 现在（`9a`–`9f`） | **断言有**，且点了真发请求 | lead 核了 `refreshSource`（`prompt-cache.ts:311-325`）：地址取 `cfg.url`，**自定义源照样能拉**。文档那句「界面还没有入口」说的是界面缺入口，不是后端没实现 |
 *
 * 那次是我读漏了：把「界面缺入口」读成「后端没实现」。lead 说他自己也读漏过一次。
 * **所以这一版是「补上一个本该有的功能」，不是「放宽判据」。**
 *
 * ## ⚠️ 假宿主必须桩上四条（lead 提醒的坑）
 *
 * `/channels`（配置格会拉）、`/prompt-sources/config`（本块主数据）、
 * `/prompt-sources`（跨层验停用）、`/storage` 与 `/model-defaults`（另两块会拉）。
 * 少桩一条就会让「配置格其他部分还在」那类断言假红 —— 前两块各踩过一次。
 *
 * 跑法：node scripts/run-tests.mjs config-sources
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
/* `window.confirm` 在 jsdom 里是「永远 false」的桩 —— 停用要先确认，
 * 所以这里换成可拨的：默认同意，某一条用例里临时改成拒绝。 */
let confirmAnswer = true
const confirmCalls = []
window.confirm = (msg) => { confirmCalls.push(String(msg)); return confirmAnswer }

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
/** 发出的请求（断言「点了真发」）。 */
const sent = []
/** `/prompt-sources/config` 回什么（测试逐段改）。 */
let sourcesReply = [
  { id: 'awesome-gpt-image', name: 'Awesome GPT Image', url: 'https://x/a.json', homepage: 'https://github.com/x/a', license: 'MIT', enabled: true, builtin: true },
  { id: 'youmind-nano-banana-pro', name: 'YouMind Nano Banana Pro', url: 'https://x/b.json', homepage: 'https://github.com/x/b', license: 'CC BY 4.0', enabled: true, builtin: true },
  { id: 'my-own-src', name: '我自己的源', url: 'https://x/mine.json', homepage: '', license: '', enabled: true, builtin: false },
]
/** 提示词库那边（`GET /prompt-sources`）回什么 —— 跨层验停用要用。 */
let libraryReply = { ok: true, sources: [], items: [], emptyNote: '' }
/** probe 回什么。 */
let probeReply = { ok: true, count: 53, status: 200, url: 'https://x/a.json' }
/** DELETE 回什么。 */
let deleteReply = { status: 200, body: { ok: true } }
/** 刷新回什么（测试逐段改）。 */
let refreshReply = { status: 200, body: { ok: true, count: 53 } }

/** 按当前 `sourcesReply` 重算「提示词库里应该有哪些」。 */
function rebuildLibrary() {
  const live = sourcesReply.filter(s => s.enabled).map(s => ({ id: s.id, name: s.name }))
  libraryReply = live.length === 0
    ? { ok: true, sources: [], items: [], emptyNote: '提示词源全被停用了。到「工作台设置 → 提示词源」里启用至少一个，或加一个自己的源。' }
    : { ok: true, sources: live, items: live, emptyNote: '' }
}
rebuildLibrary()

const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  sent.push(method + ' ' + p)
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))

  /* ── 提示词源五条路由 ── */
  if (p === '/api/ecom-workbench/prompt-sources/config' && method === 'GET') {
    return { ok: true, status: 200, json: async () => ({ ok: true, sources: sourcesReply }) }
  }
  if (p === '/api/ecom-workbench/prompt-sources/config' && method === 'POST') {
    const id = 'my-' + String(sourcesReply.length + 1)
    sourcesReply = [...sourcesReply, {
      id, name: body?.name ?? '', url: body?.url ?? '', homepage: '', license: '', enabled: true, builtin: false,
    }]
    rebuildLibrary()
    return { ok: true, status: 200, json: async () => ({ ok: true, source: sourcesReply[sourcesReply.length - 1] }) }
  }
  if (p.startsWith('/api/ecom-workbench/prompt-sources/config/') && p.endsWith('/probe') && method === 'POST') {
    return { ok: true, status: 200, json: async () => probeReply }
  }
  if (p.startsWith('/api/ecom-workbench/prompt-sources/config/') && method === 'PUT') {
    const id = decodeURIComponent(p.slice('/api/ecom-workbench/prompt-sources/config/'.length))
    sourcesReply = sourcesReply.map(s => s.id !== id ? s : {
      ...s,
      enabled: typeof body?.enabled === 'boolean' ? body.enabled : s.enabled,
      name: typeof body?.name === 'string' && body.name !== '' ? body.name : s.name,
      url: typeof body?.url === 'string' && body.url !== '' ? body.url : s.url,
    })
    rebuildLibrary()
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  if (p.startsWith('/api/ecom-workbench/prompt-sources/config/') && method === 'DELETE') {
    if (deleteReply.status !== 200) {
      return { ok: false, status: deleteReply.status, json: async () => deleteReply.body }
    }
    const id = decodeURIComponent(p.slice('/api/ecom-workbench/prompt-sources/config/'.length))
    sourcesReply = sourcesReply.filter(s => s.id !== id)
    rebuildLibrary()
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  /* 刷新（`POST /prompt-sources/:id/refresh`）—— 要放在 config 那几条**之前**判，
   * 否则 `/prompt-sources/config/xxx` 会被下面那条 `PUT/DELETE` 的 startsWith 吃掉。 */
  if (p.startsWith('/api/ecom-workbench/prompt-sources/') && p.endsWith('/refresh') && method === 'POST') {
    return { ok: refreshReply.status === 200, status: refreshReply.status, json: async () => refreshReply.body }
  }
  /* 提示词库那边（跨层验停用）。 */
  if (p === '/api/ecom-workbench/prompt-sources' && method === 'GET') {
    return { ok: true, status: 200, json: async () => libraryReply }
  }
  /* 配置格另外三块会拉的路由 —— 提前桩上，免得「别的部分还在」假红。 */
  if (p === '/api/ecom-workbench/channels' && method === 'GET') {
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, channels: [{ id: 'ch-a', name: '渠道甲', protocol: 'openai', baseUrl: 'http://x', hasKey: true, models: [{ id: 'm1', label: 'M1', caps: ['image'] }], maxConcurrency: 3 }] }),
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

/** 在输入框里打字（受控 input 要走原生 setter + input 事件）。 */
async function type(el, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

const mod = await import('../src/client/workbench/PromptSourcesSettings.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：状态字、能不能删、409 怎么翻、全停用的话
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 纯函数：状态字 / 能不能删 / 409 翻译 / 全停用 ===')
{
  const builtin = { id: 'b', name: '内置', url: 'u', homepage: '', license: 'MIT', enabled: true, builtin: true }
  const custom = { id: 'c', name: '自定义', url: 'u', homepage: '', license: '', enabled: true, builtin: false }

  check('★★ 判据 1：状态字能表达「在用」', mod.stateText(builtin) === '在用', mod.stateText(builtin))
  check('★★ 判据 1：状态字能表达「已停用」',
    mod.stateText({ ...builtin, enabled: false }) === '已停用', mod.stateText({ ...builtin, enabled: false }))

  check('★★ 判据 2：内置源**不能删**', mod.rowActions(builtin).canDelete === false)
  check('★★ 判据 2：自定义源**能删**', mod.rowActions(custom).canDelete === true)
  check('★★ 判据 2：内置源**能停用**（不能删不等于什么都不能做）',
    mod.rowActions(builtin).canToggle === true)
  check('★★ 判据 2：两种源都能改名', mod.rowActions(builtin).canEdit && mod.rowActions(custom).canEdit)

  /* 409 翻译：必须说「只能停用」并说清内容不会丢。 */
  const refusal = mod.deleteRefusal({ ok: false, builtin: true, error: '「b」是内置源，删不掉' })
  check('★★ 判据 2：409 被翻成「内置源，删不掉」',
    refusal.includes('内置') && refusal.includes('删不掉'), refusal.slice(0, 40))
  check('★★ 判据 2：翻出来那句**指出了下一步**（用停用代替）',
    refusal.includes('停用'), refusal.slice(0, 60))
  check('★★ 判据 2：并说清「内容不会丢」',
    refusal.includes('内容不会丢'), refusal.slice(0, 80))
  check('★ 非内置的失败原样透传后端那句',
    mod.deleteRefusal({ ok: false, error: '没有这个源：x' }) === '没有这个源：x')

  /* 全停用的空态。 */
  check('★★ 判据 8：还有启用时不显示「全停用」那句话',
    mod.allDisabledNote([builtin, { ...custom, enabled: false }]) === '')
  const allOff = mod.allDisabledNote([{ ...builtin, enabled: false }, { ...custom, enabled: false }])
  check('★★ 判据 8：全停用时有话说，且说清「提示词库里一份都没有」',
    allOff.includes('全被停用') && allOff.includes('提示词库'), allOff)
  check('★★ 判据 8：话说清「怎么办」（启用一个 或 加一个）',
    allOff.includes('启用') && allOff.includes('加'), allOff)
  check('★ 一个源都没有时说「还没有任何提示词源」（与「停光了」不同）',
    mod.allDisabledNote([]).includes('还没有任何提示词源'), mod.allDisabledNote([]))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 真挂：列表 / 内置标记 / 删除按钮不存在 / 停用的确认
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 真挂：列表、内置标记、内置无删除按钮、停用要确认 ===')
{
  sent.length = 0
  confirmCalls.length = 0
  confirmAnswer = true
  sourcesReply = [
    { id: 'awesome-gpt-image', name: 'Awesome GPT Image', url: 'https://x/a.json', homepage: '', license: 'MIT', enabled: true, builtin: true },
    { id: 'my-own-src', name: '我自己的源', url: 'https://x/mine.json', homepage: '', license: '', enabled: true, builtin: false },
  ]
  rebuildLibrary()
  const m = await mount(React.createElement(mod.PromptSourcesSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)

  /* 判据 1：列表 + 内置标记。 */
  check('★★ 判据 1：两个源都列出来了',
    m.el.querySelectorAll('[data-ewb-sources-row]').length === 2,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-sources-row]').length))
  check('★★ 判据 1：**标出了内置**（内置那条带 data-ewb-sources-builtin）',
    q('[data-ewb-sources-row="awesome-gpt-image"]')?.hasAttribute('data-ewb-sources-builtin') === true)
  check('★★ 判据 1：自定义那条**没有**内置标记',
    q('[data-ewb-sources-row="my-own-src"]')?.hasAttribute('data-ewb-sources-builtin') === false)
  check('★ 判据 1：「内置」两个字看得见（不只靠属性）',
    (q('[data-ewb-sources-kind="awesome-gpt-image"]')?.textContent ?? '').includes('内置'),
    q('[data-ewb-sources-kind="awesome-gpt-image"]')?.textContent ?? '')
  check('★ 判据 1：自定义那条写「自定义」',
    (q('[data-ewb-sources-kind="my-own-src"]')?.textContent ?? '').includes('自定义'))

  /* 判据 2：内置**没有**删除按钮，但有一句话 + 停用按钮。 */
  check('★★ 判据 2：内置那条**没有**删除按钮（不是灰按钮 —— 它永远不能删）',
    q('[data-ewb-sources-delete="awesome-gpt-image"]') === null)
  check('★★ 判据 2：内置那条**有一句话说明为什么**（「内置 · 只能停用」）',
    (q('[data-ewb-sources-nodelete="awesome-gpt-image"]')?.textContent ?? '').includes('只能停用'),
    q('[data-ewb-sources-nodelete="awesome-gpt-image"]')?.textContent ?? '')
  check('★★ 判据 2：内置那条**有停用按钮**（不能删 ≠ 什么都不能做）',
    q('[data-ewb-sources-toggle="awesome-gpt-image"]') !== null)
  check('★★ 判据 2：自定义那条**有**删除按钮',
    q('[data-ewb-sources-delete="my-own-src"]') !== null)

  /* 判据 9a：每一行都有刷新按钮（内置的也要有 —— 只要它配了地址就能刷）。 */
  check('★★ 判据 9a：**每一行**都有刷新按钮（内置的也有）',
    q('[data-ewb-sources-refresh="awesome-gpt-image"]') !== null
    && q('[data-ewb-sources-refresh="my-own-src"]') !== null)

  /* 判据 9b / 9c：点了真发 POST、成功显示条数。 */
  sent.length = 0
  refreshReply = { status: 200, body: { ok: true, count: 53, fetchedAt: Date.now() } }
  await click(q('[data-ewb-sources-refresh="awesome-gpt-image"]'))
  check('★★ 判据 9b：点刷新真的发了 POST /prompt-sources/:id/refresh',
    sent.includes('POST /api/ecom-workbench/prompt-sources/awesome-gpt-image/refresh'),
    sent.filter(s => s.includes('refresh')).join(' / ') || '（没发）')
  check('★★ 判据 9c：成功时显示条数（后端回的 count）',
    (q('[data-ewb-sources-done]')?.textContent ?? '').includes('53'),
    q('[data-ewb-sources-done]')?.textContent ?? '')

  /* 判据 9d：三种失败各显示后端原话（不自己编）。 */
  for (const [label, errorText] of [
    ['连不上', '连不上：ENOTFOUND。检查地址写对没有、网络通不通。'],
    ['上游 500', '上游返回 HTTP 500：Internal Server Error'],
    ['没配地址', '这个源没有配上游地址（它只用内置副本）'],
  ]) {
    refreshReply = { status: 200, body: { ok: false, error: errorText } }
    await click(q('[data-ewb-sources-refresh="awesome-gpt-image"]'))
    check('★★ 判据 9d：' + label + ' 时显示后端原话',
      (q('[data-ewb-sources-error]')?.textContent ?? '').includes(errorText.slice(0, 12)),
      (q('[data-ewb-sources-error]')?.textContent ?? '').slice(0, 50))
  }

  /* 判据 9f：刷新之后界面要**重新读一次配置**。
   *
   * ⚠️ 这里验的是**界面侧**那一半：刷新会改 `count` / `fetchedAt`，
   * 界面必须重新拉 `GET /prompt-sources/config`，否则还挂着旧的条数。
   *
   * **「提示词库那边内容变了」这一半验不了** —— 那要真跑后端
   * （`refreshSource` 拉上游 → 写 `prompt-cache/<id>.json` → `readSource` 读缓存），
   * 属于 `tests/prompt-cache.mjs` 那一侧。本文件只钉「界面做了它该做的那一步」。
   */
  {
    const before = sent.filter(s => s === 'GET /api/ecom-workbench/prompt-sources/config').length
    refreshReply = { status: 200, body: { ok: true, count: 9, fetchedAt: Date.now() } }
    await click(q('[data-ewb-sources-refresh="my-own-src"]'))
    const after = sent.filter(s => s === 'GET /api/ecom-workbench/prompt-sources/config').length
    check('★★ 判据 9f（界面侧）：刷新之后**重新读了一次配置**（否则条数还是旧的）',
      after > before, '刷新前 ' + String(before) + ' 次 → 刷新后 ' + String(after) + ' 次')
    check('★ 判据 9f：界面上显示的是新条数',
      (q('[data-ewb-sources-done]')?.textContent ?? '').includes('9'),
      q('[data-ewb-sources-done]')?.textContent ?? '')
  }


  /* 判据 9e：刷新中按钮禁用（防空点）。
   *
   * 做法：让 refresh 的响应**挂住不返回**，此时按钮的文案应该变成「刷新中…」
   * 且带 disabled。释放之后再断言恢复。
   */
  refreshReply = { status: 200, body: { ok: true, count: 7 } }
  {
    /* 用一个可以手动 resolve 的闸门把那次请求卡住。 */
    let release = () => {}
    const gate = new Promise((r) => { release = r })
    const origHost = globalThis.fetch
    globalThis.fetch = window.fetch = async (url, init) => {
      const p = String(url)
      if (p.includes('/refresh')) { await gate; return origHost(url, init) }
      return origHost(url, init)
    }
    /* 点下去但不等它完成。 */
    await act(async () => {
      q('[data-ewb-sources-refresh="awesome-gpt-image"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const mid = q('[data-ewb-sources-refresh="awesome-gpt-image"]')
    check('★★ 判据 9e：刷新进行中按钮**禁用**（防空点）',
      mid?.hasAttribute('disabled') === true, 'disabled=' + String(mid?.hasAttribute('disabled')))
    check('★ 判据 9e：进行中按钮文案变「刷新中…」',
      (mid?.textContent ?? '').includes('刷新中'), mid?.textContent ?? '')
    release()
    await act(async () => { await settle() })
    globalThis.fetch = window.fetch = origHost
  }


  /* 判据 3：停用要确认 → 真发 PUT。 */
  await click(q('[data-ewb-sources-toggle="awesome-gpt-image"]'))
  check('★★ 判据 3：停用前**弹了确认**', confirmCalls.length === 1, '实际 ' + String(confirmCalls.length) + ' 次')
  const msg = confirmCalls[0] ?? ''
  check('★★ 判据 3：确认里说清「提示词库里就没有它了」',
    msg.includes('提示词库'), msg)
  check('★★ 判据 3：确认里说清「内容不会丢」（不然用户以为数据没了）',
    msg.includes('不会丢'), msg)
  check('★★ 判据 3：确认里说清「随时能开回来」',
    msg.includes('开回来') || msg.includes('启用'), msg)
  check('★★ 判据 3：确认之后真发了 PUT',
    sent.some(s => s === 'PUT /api/ecom-workbench/prompt-sources/config/awesome-gpt-image'),
    sent.filter(s => s.startsWith('PUT')).join(' / ') || '（一次都没发）')
  check('★★ 判据 3：那条状态变成「已停用」',
    (q('[data-ewb-sources-state="awesome-gpt-image"]')?.textContent ?? '') === '已停用',
    q('[data-ewb-sources-state="awesome-gpt-image"]')?.textContent ?? '')
  check('★ 停用之后有一句结果说明', q('[data-ewb-sources-done]') !== null,
    q('[data-ewb-sources-done]')?.textContent ?? '')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 判据 3 的跨层部分：停用之后**提示词库里真没有它了**
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 跨层：停用之后提示词库那边就没有它了 ===')
{
  /* 上面 ② 已经把 awesome-gpt-image 停掉了，`libraryReply` 由宿主桩同步重算。 */
  const lib = libraryReply
  check('★★ 判据 3（跨层）：提示词库清单里**没有**停用掉的那个源',
    !lib.sources.some(s => s.id === 'awesome-gpt-image'),
    lib.sources.map(s => s.id).join(' / ') || '（空）')
  check('★★ 判据 3（跨层）：配置页那边**仍列着**它（停用不是删除，要能再开回来）',
    sourcesReply.some(s => s.id === 'awesome-gpt-image'),
    sourcesReply.map(s => s.id).join(' / '))
  check('★ 判据 3（跨层）：配置页上它是 enabled:false',
    sourcesReply.find(s => s.id === 'awesome-gpt-image')?.enabled === false)
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 4 / 5 / 6 / 7：加、改、删、测连通
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 加 / 改 / 删 / 测连通 ===')
{
  sent.length = 0
  confirmAnswer = true
  const m = await mount(React.createElement(mod.PromptSourcesSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)

  /* 判据 4：加一个自定义源。 */
  await click(q('[data-ewb-sources-add]'))
  check('★ 判据 4：点「新增源」出表单', q('[data-ewb-sources-new]') !== null)
  await type(q('[data-ewb-sources-new-name]'), '我的新源')
  await type(q('[data-ewb-sources-new-url]'), 'https://x/new.json')
  await click(q('[data-ewb-sources-new-save]'))
  check('★★ 判据 4：真发了 POST /prompt-sources/config',
    sent.includes('POST /api/ecom-workbench/prompt-sources/config'),
    sent.filter(s => s.startsWith('POST')).join(' / ') || '（没发）')
  check('★★ 判据 4：列表里出现了，**名字用用户给的**',
    (q('[data-ewb-sources-name="my-3"]')?.textContent ?? '') === '我的新源',
    q('[data-ewb-sources-name="my-3"]')?.textContent ?? '')
  check('★ 判据 4：新加的是「自定义」（不是内置）',
    (q('[data-ewb-sources-kind="my-3"]')?.textContent ?? '').includes('自定义'))

  /* 判据 5：改名字。 */
  sent.length = 0
  await click(q('[data-ewb-sources-edit="my-3"]'))
  check('★ 判据 5：点「改名」出输入框', q('[data-ewb-sources-edit-name]') !== null)
  await type(q('[data-ewb-sources-edit-name]'), '改过的名字')
  await click(q('[data-ewb-sources-edit-save]'))
  check('★★ 判据 5：真发了 PUT',
    sent.some(s => s === 'PUT /api/ecom-workbench/prompt-sources/config/my-3'),
    sent.filter(s => s.startsWith('PUT')).join(' / ') || '（没发）')
  check('★★ 判据 5：界面显示新名字',
    (q('[data-ewb-sources-name="my-3"]')?.textContent ?? '') === '改过的名字',
    q('[data-ewb-sources-name="my-3"]')?.textContent ?? '')

  /* 判据 7：测连通。 */
  sent.length = 0
  probeReply = { ok: true, count: 53, status: 200, url: 'https://x/new.json' }
  await click(q('[data-ewb-sources-probe="my-3"]'))
  check('★★ 判据 7：真发了 probe',
    sent.some(s => s === 'POST /api/ecom-workbench/prompt-sources/config/my-3/probe'),
    sent.filter(s => s.includes('probe')).join(' / ') || '（没发）')
  check('★★ 判据 7：显示「有几条」（成功时）',
    (q('[data-ewb-sources-probed="my-3"]')?.textContent ?? '').includes('53'),
    q('[data-ewb-sources-probed="my-3"]')?.textContent ?? '')
  check('★ 判据 7：并说清「没有落盘，只是数了一下」（测连通不等于刷新）',
    (q('[data-ewb-sources-probed="my-3"]')?.textContent ?? '').includes('没有落盘'),
    q('[data-ewb-sources-probed="my-3"]')?.textContent ?? '')

  /* 测不通要说清原因。 */
  probeReply = { ok: false, error: '连不上：ENOTFOUND。检查地址写对没有、网络通不通。', url: 'https://x/new.json' }
  await click(q('[data-ewb-sources-probe="my-3"]'))
  check('★★ 判据 7：失败时显示后端那句原因',
    (q('[data-ewb-sources-probed="my-3"]')?.textContent ?? '').includes('ENOTFOUND'),
    (q('[data-ewb-sources-probed="my-3"]')?.textContent ?? '').slice(0, 60))

  /* 判据 6：删自定义源。 */
  sent.length = 0
  await click(q('[data-ewb-sources-delete="my-3"]'))
  check('★★ 判据 6：真发了 DELETE',
    sent.some(s => s === 'DELETE /api/ecom-workbench/prompt-sources/config/my-3'),
    sent.filter(s => s.startsWith('DELETE')).join(' / ') || '（没发）')
  check('★★ 判据 6：列表里没了', q('[data-ewb-sources-row="my-3"]') === null)

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 判据 2 的另一半：后端真回 409 时，界面翻成「只能停用」
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 后端回 409（用户从别的入口触发）→ 界面也要说「只能停用」 ===')
{
  sourcesReply = [
    { id: 'a', name: '内置甲', url: 'https://x/a.json', homepage: '', license: 'MIT', enabled: true, builtin: false },
  ]
  deleteReply = { status: 409, body: { ok: false, builtin: true, error: '「a」是内置源，删不掉' } }
  const m = await mount(React.createElement(mod.PromptSourcesSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)
  /* 这条源在列表里被写成 builtin:false（模拟「列表与后端不一致」），所以有删除按钮。 */
  await click(q('[data-ewb-sources-delete="a"]'))
  const errText = q('[data-ewb-sources-error]')?.textContent ?? ''
  check('★★ 判据 2：409 被翻成「内置源，删不掉」（不是把后端那句原样甩出来）',
    errText.includes('内置') && errText.includes('删不掉'), errText.slice(0, 50))
  check('★★ 判据 2：并指出下一步「用停用代替」', errText.includes('停用'), errText.slice(0, 70))
  check('★ 判据 2：那条**没被删掉**（409 之后列表不变）',
    q('[data-ewb-sources-row="a"]') !== null)
  m.unmount()
  deleteReply = { status: 200, body: { ok: true } }
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 判据 8：全部停用 → 空态要有一句话
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 判据 8：全部停用时必须有话说 ===')
{
  sourcesReply = [
    { id: 'a', name: '甲', url: 'https://x/a.json', homepage: '', license: 'MIT', enabled: false, builtin: true },
    { id: 'b', name: '乙', url: 'https://x/b.json', homepage: '', license: 'MIT', enabled: false, builtin: true },
  ]
  rebuildLibrary()
  const m = await mount(React.createElement(mod.PromptSourcesSettings, { active: true }))
  const q = sel => m.el.querySelector(sel)
  const txt = q('[data-ewb-sources-alldisabled]')?.textContent ?? ''
  check('★★ 判据 8：全停用时有一块提示（不是静默空着）', txt !== '')
  check('★★ 判据 8：说清「提示词库里一份都没有」', txt.includes('提示词库'), txt.slice(0, 60))
  check('★★ 判据 8：说清怎么办（启用一个 / 加一个）',
    txt.includes('启用') && txt.includes('加'), txt.slice(0, 80))
  check('★ 判据 8：与「一个源都没有」长得不一样（两种空态不能混）',
    txt !== mod.allDisabledNote([]), txt)
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
  * ⑦ 从配置页点得到（提示词源那个 tab）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑦ 从提示词源 tab 点得到，别的块不在这一页 ===')
{
  sent.length = 0
  sourcesReply = [
    { id: 'awesome-gpt-image', name: 'Awesome GPT Image', url: 'https://x/a.json', homepage: '', license: 'MIT', enabled: true, builtin: true },
  ]
  rebuildLibrary()
  /* 2026-10-27 改（票 10）：配置页分成五个 tab，提示词源是其中一个。
   * 原来挂 `ChannelSettings` 就能看到四块，现在它只负责「渠道」tab。
   * 断言条数不变；「另外三块还在」那三条改判「它们不在这一页」——
   * 五个 tab 一起渲染等于一进配置页发五路请求，那是不该发生的事。 */
  const { ConfigTabs } = await import('../src/client/workbench/ConfigTabs.tsx')
  const m = await mount(React.createElement(ConfigTabs, { active: true, initialTab: 'prompt-sources' }))
  check('★★ 判据 1：配置页里点得到提示词源（有一条源行）',
    m.el.querySelectorAll('[data-ewb-sources-row]').length > 0,
    '源行 ' + String(m.el.querySelectorAll('[data-ewb-sources-row]').length))
  check('★ 存储目录那块不在这一页', m.el.querySelectorAll('[data-ewb-storage-input]').length === 0,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-storage-input]').length))
  check('★ 默认模型那块不在这一页', m.el.querySelectorAll('[data-ewb-defaults-select]').length === 0,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-defaults-select]').length))
  check('★ 渠道列表也不在这一页', m.el.querySelectorAll('[data-ewb-channel-row]').length === 0,
    '渠道行 ' + String(m.el.querySelectorAll('[data-ewb-channel-row]').length))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 源码层：刷新入口**接上了** + 文案守 R6
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑧ 源码层：刷新入口接上了、文案守 R6 ===')
{
  const src = readFileSync(new URL('../src/client/workbench/PromptSourcesSettings.tsx', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★★ 判据 9a（源码）：**渲染了**刷新按钮（`data-ewb-sources-refresh` 在代码里）',
    /data-ewb-sources-refresh=\{s\.id\}/.test(code), /data-ewb-sources-refresh/.test(code) ? '在' : '找不到')
  check('★★ 判据 9b（源码）：刷新调的是宿主的 `refresh` 路由（`/prompt-sources/` + id + `/refresh`，POST）',
    /'\/prompt-sources\/' \+ encodeURIComponent\(s\.id\) \+ '\/refresh'/.test(code)
    && /method: 'POST'/.test(code))
  /* 与「测连通」必须分开：测连通不落盘，刷新落盘 —— 两个按钮两种语义。 */
  check('★★ 判据 9（语义）：刷新与测连通是**两个不同的按钮**',
    /data-ewb-sources-probe=/.test(code) && /data-ewb-sources-refresh=/.test(code))
  check('★★ 文案守 R6：没有第二人称（你 / 您）出现在字符串里', !/'[^']*[你您][^']*'/.test(code))
  check('★ 没有裸 `import antd`（按需引入）', !/import\s+\w+\s+from\s+'antd'/.test(code))
  check('★ 用户可见文案里没有 markdown 加粗标记', !/['"][^'"]*\*\*[^'"]*['"]/.test(code))
}

console.log('')
console.log(failed === 0 ? '结论：提示词源接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
