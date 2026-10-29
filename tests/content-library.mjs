/** 内容库：产物库 + 素材库两段（契约 BB，计划 §三 Step 4）。
 *
 * ## 这个测试守什么（对应验收 1 / 2 / 3 / 4 / 9）
 *
 *   ① **产物库列出产物**，显示缩略图、尺寸、字节、时间；
 *   ② **引用计数**显示「引用 N」，点开列到「画布名 + 节点」；
 *   ③ **删被引用的产物**时弹确认框，文案含「被 N 个画布引用」；确认后真发 DELETE；
 *   ④ **素材库读目录**：往沙箱 `materials/` 里丢一个文件，列表里就有；
 *   ⑤ **上传 >6 MB 被拦下并说清原因**；
 *   ⑥ **用户可见文案里没有任何结算类字样**（验收 9 的其中一段）。
 *
 * ## ⚠️ 宿主是**桩**，但素材那一段**真的读磁盘**
 *
 * 产物 / 引用 / 素材这三条路由在 `src/index.ts` 里，这个测试跑在 Node 里、
 * 没有那个 HTTP server。所以桩实现了同样的行为。
 *
 * 但「往目录里丢一个文件，界面就列出来」这条**必须碰真磁盘**才算验到
 * （它验的正是「不建索引」这个决定）。所以桩的 `/materials` 是**真去 `readdir`
 * 一个临时沙箱目录** —— 文件是测试真的写进去的。
 *
 * ⚠️ 沙箱用 `EWB_TEST_HOME` 下面另开的临时目录，跑完删掉，**不碰真实数据**。
 *
 * 跑法：node --import <tsx> tests/content-library.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
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

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：上传把关、字节文案
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 纯函数：上传把关、字节文案 ===')
const lib = await import('../src/client/workbench/ContentLibrary.tsx')
{
  const { checkUpload, humanBytes, MAX_UPLOAD_BYTES } = lib
  check('上限是 6 MB', MAX_UPLOAD_BYTES === 6 * 1024 * 1024, String(MAX_UPLOAD_BYTES))
  check('图片能过', checkUpload('a.png', 1024).ok)
  check('视频能过', checkUpload('a.mp4', 1024).ok)
  check('★ 名字大小写不影响判类型', checkUpload('A.PNG', 1024).ok)

  const big = checkUpload('big.png', 7 * 1024 * 1024)
  check('★★ 超过 6 MB 被拦下', !big.ok)
  check('★★ 拦下时说清了「太大」与实际上限',
    (big.why ?? '').includes('文件太大') && (big.why ?? '').includes('6.00 MB'),
    big.why ?? '')
  /* 这一段是这条断言的关键：不写清「为什么是 6 MB」，用户会以为程序坏了。 */
  check('★★ 拦下时说明了根因（文本编码的请求体 / 约 1.33 倍）',
    (big.why ?? '').includes('1.33') && (big.why ?? '').includes('8 MB'), big.why ?? '')

  check('★ 类型不对被拦下（不是图片也不是视频）',
    !checkUpload('a.txt', 100).ok && (checkUpload('a.txt', 100).why ?? '').includes('只收图片与视频'))
  check('★ 没有扩展名被拦下', !checkUpload('afile', 100).ok)
  check('★ 0 字节被拦下', !checkUpload('a.png', 0).ok)

  check('字节文案：B / KB / MB 三档都对',
    humanBytes(512) === '512 B' && humanBytes(2048) === '2.0 KB' && humanBytes(6 * 1024 * 1024) === '6.00 MB',
    [humanBytes(512), humanBytes(2048), humanBytes(6 * 1024 * 1024)].join(' / '))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 真挂：产物库 + 素材库
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 真挂：产物库（含引用计数与删除）+ 素材库（真读目录）===')

/* 沙箱：素材真的写在这里，桩真的 readdir 它。跑完删掉。 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-content-lib-'))
const MATERIALS = join(SANDBOX, 'materials')
mkdirSync(MATERIALS, { recursive: true })

/** 沙箱里放一个真文件（1×1 png，够验「目录里有就能列出来」）。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
writeFileSync(join(MATERIALS, '参考图一.png'), PNG_1PX)
writeFileSync(join(MATERIALS, '演示视频.mp4'), Buffer.from([0, 0, 0, 24]))

/** 产物清单（桩数据）。 */
const ARTIFACTS = [
  { id: 'art-used', ext: 'png', mime: 'image/png', bytes: 204800, createdAt: Date.now() - 600000, width: 1024, height: 1024, source: 'gen-image', params: { prompt: '参考' }, url: '/api/ecom-workbench/artifact/art-used' },
  { id: 'art-free', ext: 'png', mime: 'image/png', bytes: 4096, createdAt: Date.now() - 60000, width: 512, height: 512, source: 'gen-image', params: {}, url: '/api/ecom-workbench/artifact/art-free' },
]
/** 引用表（桩数据）：`art-used` 被两份画布引用 —— 正是验收 1 那条形状。 */
const USAGE = {
  'art-used': [
    { canvasId: 'cv_one', canvasTitle: '第一份画布', nodeId: 'n1' },
    { canvasId: 'cv_two', canvasTitle: '第二份画布', nodeId: 'n7' },
  ],
}

/** 收到的请求（断言直接查它，比查界面文字准）。 */
const sent = []
/** confirm 收到的文案（断言「弹了没有、说了什么」）。 */
const confirms = []
/** 下一次 confirm 返回什么。 */
let confirmAnswer = true
window.confirm = (text) => { confirms.push(String(text)); return confirmAnswer }

/** 桩宿主（形状照 `src/index.ts` 那几条路由）。 */
const host = async (url, init) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  const method = String(init?.method ?? 'GET').toUpperCase()
  sent.push(method + ' ' + p)
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (p === '/api/ecom-workbench/artifacts' && method === 'GET') {
    /* ⚠️ **必须交一份新的数组/对象**：真实 HTTP 每次 `JSON.parse` 都产生新引用，
     * 而 React 按引用判断「变了没有」。直接回 `ARTIFACTS` 会让删除之后
     * `setArts(同一个引用)` 被当成「没变」→ 界面不刷新（我第一次就是这么假红的）。 */
    return ok({ ok: true, dir: SANDBOX, total: ARTIFACTS.length, items: ARTIFACTS.map(a => ({ ...a })) })
  }
  if (p === '/api/ecom-workbench/artifacts/usage' && method === 'GET') {
    return ok({ ok: true, usage: JSON.parse(JSON.stringify(USAGE)) })
  }
  if (p.startsWith('/api/ecom-workbench/artifact/') && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/ecom-workbench/artifact/'.length))
    const i = ARTIFACTS.findIndex(a => a.id === id)
    if (i >= 0) ARTIFACTS.splice(i, 1)
    return ok({ ok: true })
  }
  if (p === '/api/ecom-workbench/materials' && method === 'GET') {
    /* ★ 真读目录 —— 这条是「读目录就有、不建索引」的判据所在。 */
    const { readdirSync, statSync } = require('node:fs')
    const names = readdirSync(MATERIALS)
    const materials = names.map(n => ({
      name: n,
      bytes: statSync(join(MATERIALS, n)).size,
      mtime: statSync(join(MATERIALS, n)).mtimeMs,
      url: '/api/ecom-workbench/material/' + encodeURIComponent(n),
    }))
    return ok({ ok: true, dir: MATERIALS, materials })
  }
  if (p === '/api/ecom-workbench/materials' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'))
    writeFileSync(join(MATERIALS, body.name), Buffer.from(body.base64, 'base64'))
    return ok({ ok: true, material: { name: body.name, bytes: 1, mtime: Date.now(), url: '/api/ecom-workbench/material/' + body.name } })
  }
  if (p.startsWith('/api/ecom-workbench/materials/') && method === 'DELETE') {
    const name = decodeURIComponent(p.slice('/api/ecom-workbench/materials/'.length))
    try { require('node:fs').unlinkSync(join(MATERIALS, name)) } catch { /* 没有就算了 */ }
    return ok({ ok: true })
  }
  return ok({ ok: true, items: [] })
}
window.fetch = host
globalThis.fetch = host

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

/** 挂一个组件，等副作用跑完。 */
async function mount(el, wait = 600) {
  const hostEl = window.document.createElement('div')
  window.document.body.appendChild(hostEl)
  const root = createRoot(hostEl)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise(r => setTimeout(r, wait)) })
  return {
    el: hostEl,
    unmount() { act(() => { root.unmount() }); hostEl.remove() },
  }
}

/** 点一下。 */
async function click(el) {
  if (el === null || el === undefined) return
  await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
}

{
  const { ContentLibrary } = lib
  const m = await mount(React.createElement(ContentLibrary, { active: true }), 900)
  const q = sel => m.el.querySelector(sel)

  /* ── 产物库 ── */
  check('★★ 产物库列出了两条产物',
    m.el.querySelectorAll('[data-ewb-artifact]').length === 2,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-artifact]').length))
  const img = q('[data-ewb-artifact="art-free"] [data-ewb-artifact-img]')
  check('★★ 产物显示缩略图，地址指向宿主产物路由',
    img !== null && img.getAttribute('src') === '/api/ecom-workbench/artifact/art-free',
    img?.getAttribute('src') ?? '（没有 img）')
  check('★ 显示尺寸', (q('[data-ewb-artifact="art-free"] [data-ewb-artifact-dims]')?.textContent ?? '') === '512×512',
    q('[data-ewb-artifact="art-free"] [data-ewb-artifact-dims]')?.textContent ?? '')
  check('★ 显示字节', (q('[data-ewb-artifact="art-free"] [data-ewb-artifact-bytes]')?.textContent ?? '') === '4.0 KB',
    q('[data-ewb-artifact="art-free"] [data-ewb-artifact-bytes]')?.textContent ?? '')
  check('★ 显示时间（不是空白）',
    (q('[data-ewb-artifact="art-free"] [data-ewb-artifact-time]')?.textContent ?? '').trim() !== '')

  /* ── 引用计数 ── */
  const usageBtn = q('[data-ewb-artifact-usage="art-used"]')
  check('★★ 被引用的产物显示「引用 2」',
    (usageBtn?.textContent ?? '').trim() === '引用 2', (usageBtn?.textContent ?? '').trim())
  const freeBtn = q('[data-ewb-artifact-usage="art-free"]')
  check('★ 没被引用的显示「引用 0」', (freeBtn?.textContent ?? '').trim() === '引用 0',
    (freeBtn?.textContent ?? '').trim())

  /* 点开引用明细：必须列到「画布名 + 节点」。 */
  check('展开前没有明细块', q('[data-ewb-artifact-refs="art-used"]') === null)
  await click(usageBtn)
  const refsBox = q('[data-ewb-artifact-refs="art-used"]')
  check('★★ 点「引用 2」之后列出了两处引用',
    refsBox !== null && refsBox.querySelectorAll('[data-ewb-artifact-ref]').length === 2,
    refsBox === null ? '（没有明细块）' : String(refsBox.querySelectorAll('[data-ewb-artifact-ref]').length) + ' 处')
  const refsText = refsBox?.textContent ?? ''
  check('★★ 明细里带画布名', refsText.includes('第一份画布') && refsText.includes('第二份画布'), refsText)
  check('★★ 明细里带节点 id', refsText.includes('n1') && refsText.includes('n7'), refsText)

  /* ── 删除被引用的产物：必须弹确认框，文案含「被 N 个画布引用」 ── */
  confirms.length = 0
  confirmAnswer = false
  sent.length = 0
  await click(q('[data-ewb-artifact-del="art-used"]'))
  check('★★ 删被引用的产物时弹了确认框', confirms.length === 1, '实际弹了 ' + String(confirms.length) + ' 次')
  const box = confirms[0] ?? ''
  check('★★ 文案写明「被 2 个画布引用」', box.includes('被 2 个画布引用'), box.slice(0, 100))
  check('★★ 文案写明那两处会显示「图已删除」', box.includes('图已删除'), box.slice(0, 160))
  check('★★ 文案里点出是哪两个画布', box.includes('第一份画布') && box.includes('第二份画布'), box.slice(0, 200))
  check('★★ 用户点了「取消」就**没有**发删除请求',
    !sent.some(s => s.startsWith('DELETE')), sent.join(' / ') || '（没有请求）')
  check('★ 取消之后那条产物还在列表里', q('[data-ewb-artifact="art-used"]') !== null)

  /* 确认删除 → 真发 DELETE → 列表少一条。 */
  confirmAnswer = true
  sent.length = 0
  await click(q('[data-ewb-artifact-del="art-used"]'))
  await act(async () => { await new Promise(r => setTimeout(r, 500)) })
  check('★★ 确认之后发了 DELETE',
    sent.some(s => s === 'DELETE /api/ecom-workbench/artifact/art-used'), sent.join(' / '))
  check('★★ 删完之后列表里没有了', q('[data-ewb-artifact="art-used"]') === null)

  /* 删没被引用的：**不该弹**确认框（计划只要求被引用时提醒）。 */
  confirms.length = 0
  await click(q('[data-ewb-artifact-del="art-free"]'))
  await act(async () => { await new Promise(r => setTimeout(r, 400)) })
  check('★ 删没被引用的产物不弹确认框（直接删）', confirms.length === 0,
    confirms.join(' / '))
  check('★ 没被引用的也确实删掉了', q('[data-ewb-artifact="art-free"]') === null)

  /* ── 素材库：读目录就有 ── */
  check('★★ 素材库列出了目录里那两个文件',
    m.el.querySelectorAll('[data-ewb-material]').length === 2,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-material]').length))
  check('★ 图片素材渲染成 <img>', q('[data-ewb-material="参考图一.png"] [data-ewb-material-img]') !== null)
  check('★ 视频素材渲染成 <video> 且带播放控件',
    q('[data-ewb-material="演示视频.mp4"] [data-ewb-material-video]')?.hasAttribute('controls') === true)

  /* ★★ 验收 3 的判据：**再往目录里丢一个文件，刷新就出现**。
   * 这一步不经过任何「注册」动作 —— 它验的正是「读目录就有、不建索引」。 */
  writeFileSync(join(MATERIALS, '后来放进去的.webp'), PNG_1PX)
  await click(q('[data-ewb-mat-refresh]'))
  await act(async () => { await new Promise(r => setTimeout(r, 500)) })
  check('★★ 往目录里新丢一个文件，点刷新就出现在列表里',
    m.el.querySelectorAll('[data-ewb-material]').length === 3,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-material]').length))
  check('★ 新文件认得出名字', q('[data-ewb-material="后来放进去的.webp"]') !== null)

  /* 删素材：弹确认框（删文件是不可逆的），确认后列表少一个。 */
  confirms.length = 0
  confirmAnswer = true
  await click(q('[data-ewb-material-del="后来放进去的.webp"]'))
  await act(async () => { await new Promise(r => setTimeout(r, 500)) })
  check('★ 删素材也先问一句（文件不可恢复）', confirms.length === 1)
  check('★★ 素材真被删掉了（磁盘上也没有了）',
    !existsSync(join(MATERIALS, '后来放进去的.webp')))
  check('★ 列表同步少了那一个', m.el.querySelectorAll('[data-ewb-material]').length === 2,
    '实际 ' + String(m.el.querySelectorAll('[data-ewb-material]').length))

  /* ── 验收 9 的一段：可见文案里没有结算类字样 ── */
  const visible = m.el.textContent ?? ''
  const banned = ['价格', '单价', '￥', 'cost', 'price']
  const hits = banned.filter(w => visible.includes(w))
  check('★★ 内容库可见文案里没有任何结算类字样', hits.length === 0, hits.join('、'))

  m.unmount()
}

/* ── 验收 4：>6 MB 时界面真的拦下并显示原因 ────────────────────────────
 *
 * 真机上这一步发生在 `input.onchange` 里。jsdom 造不出「带文件的 FileList」
 * （`DataTransfer` 没实现），所以分两段验：
 *   ① 纯函数（上面那段）—— 拦截逻辑本身；
 *   ② 这里直接调组件的上传路径做不到，于是退到「把把关的结论接到界面上」
 *      那一段源码：确认 `uploadOne` 在调用接口前先过 `prepareUpload`（契约 CG
 *      把它从 `checkUpload` 换成更严的那一份：连 base64 一起查），
 *      且失败时 `setUploadErr`。
 * ② 是**源码层**判据，如实说：界面那一格的真实点击没有被自动化走过。
 * （`upload-file.mjs` 补了真正能跑的纯函数断言，覆盖「选文件之后」那半段。） */
{
  const srcText = readFileSync(new URL('../src/client/workbench/ContentLibrary.tsx', import.meta.url), 'utf8')
  /* ⚠️ 切片终点要在**起点之后**找：文件里更早还有一处 `call('/materials')`（加载列表），
   * 用 `indexOf` 全局找会把终点切到起点之前、block 变空、断言假红。
   * 记这一笔：`indexOf` 切片的两个端点必须都从同一个起点之后再算。 */
  const startAt = srcText.indexOf('const uploadOne')
  const endAt = srcText.indexOf("/materials", startAt)
  const uploadBlock = endAt > startAt ? srcText.slice(startAt, endAt) : ''
  check('★ 切片拿到了上传函数体（端点顺序对）', uploadBlock.length > 100, String(uploadBlock.length))
  /* ⚠️ 判据是「先把关、再发请求」，不是某个具体函数名。
   * 契约 CG 把 `checkUpload(file.name, file.size)` 换成了
   * `prepareUpload({name, size, type, base64})`（能一起查 base64），
   * 原来那条断言盯名字，换实现就假红 —— 而功能是变强了。 */
  check('★★ 上传路径里先把关再发请求（prepareUpload / checkUpload 都算）',
    uploadBlock.includes('prepareUpload(') || uploadBlock.includes('checkUpload('))
  /* 把关在函数体里出现过，且**整份源码里**它排在发请求之前。
   * ⚠️ 判据不能只在 `uploadBlock` 里比：切片终点本来就在 `/materials` 之前，
   * 于是在 block 里找 `/materials` 永远是 -1，那条断言会一直假红（第一次就写错了）。 */
  check('★★★★ 把关**排在发请求之前**（不是先传上去再检查）',
    uploadBlock.includes('prepareUpload(')
    && srcText.indexOf('prepareUpload(', startAt) < srcText.indexOf("call<unknown>('/materials'"))
  check('★★ 不通过时把原因写进界面（setUploadErr），不是静默 return',
    uploadBlock.includes('setUploadErr') && uploadBlock.includes('return'))
  check('★ 界面上有显示上传错误的钩子', srcText.includes('data-ewb-mat-upload-error'))
  check('★ 界面上写着上限（用户传之前就能看到）', srcText.includes('上传上限'))
}

/* 清沙箱。 */
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 清不掉不致命 */ }
check('★ 测试自己的沙箱已清理', !existsSync(SANDBOX))

console.log('')
console.log(failed === 0 ? '结论：内容库接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
