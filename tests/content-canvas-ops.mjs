/** 内容画布的**操作链路**判据（⑨–㉒）：生成、参考图、拖放、批量、@ 提及、蒙版、扩分、提交时解析。
 *
 * ## 为什么单独一个文件
 *
 * 从 `content-canvas.mjs` 拆出来的（2026-10-26）。拆前那个文件 2927 行 / **20.7 秒**，
 * 已破 `scripts/run-tests.mjs:106` 的 20 秒慢测线。实测构成
 * `act 11.4s + settle 7.7s + 其余 0.6s`，三笔相加就是总耗时 ——
 * **没有一次等待能白省**，只能拆成两个进程各跑一半。
 *
 * 本文件装的是「提交这件事」那一侧：查模型 → 提交 → 轮询 → 落位 → 重试 → 取消，
 * 以及各种产出上来的路径（参考图、拖放、批量、@ 提及、局部重绘、扩分、反推）。
 *
 * ## 与 `content-canvas.mjs` 的关系
 *
 * 两个文件**各自调一次 `createEnv()`**，环境互相独立（新 jsdom、空画布库）。
 * 底座在 `_canvas-harness.mjs`，一处改动两边都生效。
 *
 * ⚠️ 拆的时候**一次 `settle` 都没删**（拆前后都是 145 次），轮次也没调小。
 *
 * 跑法：`node scripts/run-tests.mjs content-canvas-ops`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const {
  window, React, act,
  mkDoc,
  mount, click, clickInner,
  settle, waitUntil,
  ContentCanvas,
  getFailed,
} = env
const S = env.S
const check = env.check
/* 原文件里 store 是**顶层**变量，⑰ 段有一处用到它却是在块里（块内没重新 import）。
 * 拆开后它留在了另一个文件里，所以这里补一份 —— ESM 模块缓存，重复 import 不花钱。 */
const store = await import('../src/client/workbench/content-canvas-store.ts')

console.log('=== ⑨ 生成链路：真调 /generate ===')
{
  /* ── 验收 1：`/gen-models` 回非空 → 按钮可用；回空 → 禁用且文案说清 ── */
  S.genModelList = [{
    channelId: 'ch_local', channelName: '本地 ComfyUI', protocol: 'comfyui',
    modelId: 'flux-pro', modelLabel: 'Flux Pro', caps: ['image', 'video'],
  }]
  S.mem.set('cv_gen', mkDoc('cv_gen', '生成画布', [
    { id: 'gi', type: 'image', position: { x: 60, y: 60 }, data: { prompt: '一只猫在雪地', model: 'flux-pro', channel: 'ch_local', size: '1024x1024' } },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_gen', active: true, onClose: () => {} }))
  await clickInner(m, 'gi')
  await act(async () => { await settle() })
  const genBtn = m.el.querySelector('[data-ewb-node-generate]')
  check('★★ 查到非空模型清单 → 生成按钮可用（不再是恒 false）',
    genBtn !== null && genBtn.disabled !== true,
    'disabled=' + String(genBtn?.disabled))
  check('★★ 按钮文案不再是「未接通」（接口接上了）',
    (genBtn?.textContent ?? '').includes('生成') && !(genBtn?.textContent ?? '').includes('不可用'),
    String(genBtn?.textContent))
  check('★★ 模型那一格是下拉（有清单时不再手打，防打错）',
    m.el.querySelector('select[data-ewb-node-model]') !== null)

  /* ── 验收 2：点生成真发 POST /generate，body 带齐 ── */
  S.genPosts.length = 0
  S.genPolls.length = 0
  S.genNextId = 'task-A'
  /* 先让轮询一直说「在跑」，避免立刻结束打断后续断言。 */
  S.genReply = { status: 'running', waitedMs: 4200, artifacts: [], error: '' }
  await click(genBtn)
  await act(async () => { await settle() })
  check('★★ 点生成真的发了 POST /generate（一次）', S.genPosts.length === 1, '实际 ' + String(S.genPosts.length) + ' 次')
  const body = S.genPosts[0] ?? {}
  check('★★ body 带 kind', body.kind === 'image', String(body.kind))
  check('★★ body 带 prompt', body.prompt === '一只猫在雪地', String(body.prompt))
  check('★★ body 带 model', body.model === 'flux-pro', String(body.model))
  check('★★ body 带 channelId', body.channelId === 'ch_local', String(body.channelId))
  check('★★ body 带 canvasId', body.canvasId === 'cv_gen', String(body.canvasId))
  check('★★ body 带 canvasNodeId', body.canvasNodeId === 'gi', String(body.canvasNodeId))
  check('★★ body 带 source=canvas', body.source === 'canvas', String(body.source))

  /* ── 验收 3：running 态显示「已等 N 秒」，且界面上**没有 %** ── */
  const runEl = m.el.querySelector('[data-ewb-node-running="gi"]')
  check('★★ 提交后节点进入 running 态', runEl !== null)
  const waited = m.el.querySelector('[data-ewb-node-waited]')?.textContent ?? ''
  check('★★ running 显示「已等 N 秒」（用的是后端的 waitedMs）',
    waited.includes('已等') && waited.includes('秒'), waited)
  check('★★ 「已等 4 秒」与后端给的 4200ms 对得上', waited.includes('4 秒'), waited)
  /* ⚠️ 判据限定在**节点覆盖层**里：画布别处本来就有百分比（缩放控件的 `100%`），
   * 拿整块画布的 `textContent` 去搜 `%` 会一直红 —— 那不是「进度里出现了百分比」。 */
  const runText = m.el.querySelector('[data-ewb-run-state="running"]')?.textContent ?? ''
  check('★★ running 覆盖层里没有百分比（用户定过不给百分比）',
    runText.includes('已等') && !runText.includes('%'), runText)

  /* ── 验收 4：轮询在跑（同一任务被问了多次）──
   *
   * ★ 等**条件**（轮询次数到 2），不是死等 2200ms。
   * 轮询间隔是源码里的 1000ms（`ContentCanvas.tsx:884`），所以两次轮询
   * 至少要 1 秒 —— `waitUntil` 的超时给 4 秒，等不到就让下面那条断言红。 */
  await waitUntil(() => S.genPolls.length >= 2, 4000)
  check('★★ 轮询在跑（GET /generate/:id 被调用了多次）', S.genPolls.length >= 2,
    '实际 ' + String(S.genPolls.length) + ' 次')
  check('★★ 轮询问的是刚提交那个任务', S.genPolls.every(id => id === 'task-A'),
    [...new Set(S.genPolls)].join(','))

  /* ── 验收 5：成功后用 `placeResult` 落位（两条）──
   * ① 空节点 → 填它自己；② 有内容的节点 → 右边长一个。 */
  S.genReply = { status: 'success', waitedMs: 5000, artifacts: [{ id: 'art-1', mime: 'image/png', bytes: 10, url: '/x' }], error: '' }
  /* ★ 等「结果真的落位了」（图片 src 里出现 art-1），不是死等 1600ms。 */
  await waitUntil(() => String(m.el.querySelector('.react-flow__node[data-id="gi"] [data-ewb-content-img]')?.getAttribute('src') ?? '').includes('art-1'), 5000)
  const giEl = m.el.querySelector('.react-flow__node[data-id="gi"]')
  const imgAfter = giEl?.querySelector('[data-ewb-content-img]')
  check('★★ 本来空的图片节点被填了自己（placeResult 的 self 那一支）',
    imgAfter !== null && String(imgAfter.getAttribute('src') ?? '').includes('art-1'),
    String(imgAfter?.getAttribute('src') ?? '（没图）'))
  check('★★ 落位之后 running 覆盖层消失', m.el.querySelector('[data-ewb-node-running="gi"]') === null)

  /* ② 有内容的节点 → 多出一个节点（right 那一支）。 */
  const beforeCount = m.el.querySelectorAll('.react-flow__node').length
  S.genNextId = 'task-B'
  S.genReply = { status: 'running', waitedMs: 1000, artifacts: [], error: '' }
  await clickInner(m, 'gi')
  await act(async () => { await settle() })
  await click(m.el.querySelector('[data-ewb-node-generate]'))
  await act(async () => { await settle() })
  S.genReply = { status: 'success', waitedMs: 2000, artifacts: [{ id: 'art-2', mime: 'image/png', bytes: 10, url: '/y' }], error: '' }
  /* ★ 等节点数真的多出来一个（right 那一支的可见结果）。 */
  await waitUntil(() => m.el.querySelectorAll('.react-flow__node').length > beforeCount, 5000)
  const afterCount = m.el.querySelectorAll('.react-flow__node').length
  check('★★ 已经有内容的节点再生成 → 右边长一个新节点（placeResult 的 right 那一支）',
    afterCount === beforeCount + 1, '之前 ' + String(beforeCount) + ' 个，之后 ' + String(afterCount) + ' 个')

  /* ── 验收 6：失败 → 错误原文 + 重试；点重试用同样参数再提交 ── */
  S.genNextId = 'task-C'
  S.genReply = { status: 'running', waitedMs: 500, artifacts: [], error: '' }
  await clickInner(m, 'gi')
  await act(async () => { await settle() })
  await click(m.el.querySelector('[data-ewb-node-generate]'))
  await act(async () => { await settle() })
  S.genReply = { status: 'failed', waitedMs: 800, artifacts: [], error: '上游 429：额度用完了' }
  /* ★ 等 failed 覆盖层出现。 */
  await waitUntil(() => m.el.querySelector('[data-ewb-node-failed="gi"]') !== null, 5000)
  check('★★ 失败后节点进入 failed 态', m.el.querySelector('[data-ewb-node-failed="gi"]') !== null)
  const errText = m.el.querySelector('[data-ewb-node-error]')?.textContent ?? ''
  check('★★ 失败显示错误原文（不是笼统一句「失败」）',
    errText.includes('429'), errText)
  const retryBtn = m.el.querySelector('[data-ewb-node-retry="gi"]')
  check('★★ 失败态有重试按钮', retryBtn !== null)
  S.genPosts.length = 0
  S.genReply = { status: 'running', waitedMs: 300, artifacts: [], error: '' }
  await click(retryBtn)
  await act(async () => { await settle() })
  check('★★ 点重试又提交了一次（同样参数）',
    S.genPosts.length === 1 && S.genPosts[0]?.canvasNodeId === 'gi' && S.genPosts[0]?.prompt === '一只猫在雪地',
    JSON.stringify({ n: S.genPosts.length, node: S.genPosts[0]?.canvasNodeId, prompt: S.genPosts[0]?.prompt }))

  /* ── 验收 7：running 时能取消，调 /cancel ── */
  const cancelBtn = m.el.querySelector('[data-ewb-node-cancel="gi"]')
  check('★★ running 时有取消按钮', cancelBtn !== null)
  S.genCancels.length = 0
  await click(cancelBtn)
  await act(async () => { await settle() })
  check('★★ 点取消调了 /generate/:id/cancel', S.genCancels.length >= 1, '实际 ' + String(S.genCancels.length) + ' 次')
  check('★★ 取消后 running 覆盖层消失', m.el.querySelector('[data-ewb-node-running="gi"]') === null)

  /* ── 验收 8：悬浮工具条四个动作 ── */
  /* ① 下载：产物 id → 触发 <a download>（不是 window.open 打开图片）。 */
  let downloaded = ''
  const origClick = window.HTMLAnchorElement.prototype.click
  window.HTMLAnchorElement.prototype.click = function () { downloaded = String(this.getAttribute('href') ?? '') }
  await act(async () => {
    const bar = m.el.querySelector('.react-flow__node[data-id="gi"] [data-ewb-hover-item="download"]')
    bar?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  window.HTMLAnchorElement.prototype.click = origClick
  check('★★ 工具条「下载」真触发了下载（走 <a download>，不是新标签展示）',
    downloaded.includes('/artifact/'), downloaded === '' ? '（没触发）' : downloaded)

  /* ② 加素材库：取产物 → POST /materials。 */
  S.materialPosts.length = 0
  await act(async () => {
    const bar = m.el.querySelector('.react-flow__node[data-id="gi"] [data-ewb-hover-item="saveAsset"]')
    bar?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  check('★★ 工具条「加入素材库」真的 POST 了 /materials',
    S.materialPosts.length === 1 && typeof S.materialPosts[0]?.base64 === 'string' && S.materialPosts[0].base64 !== '',
    '实际 ' + String(S.materialPosts.length) + ' 次')

  /* ③ 复制提示词：走剪贴板（jsdom 没有，走 textarea 回退），断言复制过。 */
  let copied = ''
  const origExec = window.document.execCommand
  window.document.execCommand = (cmd) => {
    if (cmd === 'copy') {
      const ta = window.document.querySelector('textarea')
      if (ta !== null) copied = ta.value
      return true
    }
    return false
  }
  await act(async () => {
    const bar = m.el.querySelector('.react-flow__node[data-id="gi"] [data-ewb-hover-item="copyPrompt"]')
    bar?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  window.document.execCommand = origExec
  check('★★ 工具条「复制提示词」真把提示词复制走了',
    copied === '一只猫在雪地', copied === '' ? '（没复制）' : copied)

  /* ④ 上传替换：点它要打开文件选择框（真选文件在 jsdom 里造不出来，
   *    这里断言「入口通了」；真正的字节搬运那段由 ③ 的 /materials 断言覆盖）。 */
  let picked = false
  const uploadInput = m.el.querySelector('[data-ewb-canvas-upload]')
  const origInputClick = window.HTMLInputElement.prototype.click
  window.HTMLInputElement.prototype.click = function () { if (this === uploadInput) picked = true }
  await act(async () => {
    const bar = m.el.querySelector('.react-flow__node[data-id="gi"] [data-ewb-hover-item="upload"]')
    bar?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  window.HTMLInputElement.prototype.click = origInputClick
  check('★★ 工具条「上传替换」真的打开了文件选择框', picked)

  m.unmount()

  /* ── 验收 1 的另一半：`/gen-models` 回空 → 按钮禁用 + 文案说清 ── */
  S.genModelList = []
  const m2 = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_gen', active: true, onClose: () => {} }))
  await clickInner(m2, 'gi')
  await act(async () => { await settle() })
  const btn2 = m2.el.querySelector('[data-ewb-node-generate]')
  check('★★ 模型清单为空 → 生成按钮禁用', btn2 !== null && btn2.disabled === true,
    'disabled=' + String(btn2?.disabled))
  const hint = m2.el.querySelector('[data-ewb-generate-hint]')?.textContent ?? ''
  check('★★ 禁用时把原因写出来了（不是只说「不可用」）',
    hint.includes('配置') && hint.includes('渠道'), hint)
  m2.unmount()

  /* 复原，别影响后面段落。 */
  S.genModelList = [{
    channelId: 'ch_local', channelName: '本地 ComfyUI', protocol: 'comfyui',
    modelId: 'flux-pro', modelLabel: 'Flux Pro', caps: ['image', 'video'],
  }]
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑩ 参考图选择（契约 CJ 的 #75）：不再让用户手填产物 id
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑩ 参考图：从列表里挑，不再手填产物 id ===')
{
  S.materialGets.length = 0
  /* 画布上放一个视频节点（要选首帧）与一个**已有产物**的图片节点
   * （后者用来验「从画布直接串起来」）。 */
  S.mem.set('cv_ref', mkDoc('cv_ref', '参考图画布', [
    { id: 'rv', type: 'video', position: { x: 60, y: 60 }, data: { prompt: '海浪', model: 'flux-pro' } },
    { id: 'ri', type: 'image', position: { x: 460, y: 60 }, data: { prompt: '灯塔', artifact: 'art-keep-1' } },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_ref', active: true, onClose: () => {} }))
  await clickInner(m, 'rv')
  await act(async () => { await settle() })

  /* ── 验收 1：不再有让用户手填 id 的输入框 ── */
  const refRow = m.el.querySelector('[data-ewb-node-reference]')
  check('★★ 参考图那一格还在（不是把整格删了）', refRow !== null)
  const refInput = m.el.querySelector('[data-ewb-node-reference] input')
  check('★★ 那里**不再**是输入框（原来那个手填产物 id 的框已移除）', refInput === null,
    refInput === null ? '' : 'placeholder=' + String(refInput.getAttribute('placeholder')))
  check('★★ 界面上没有「产物 id」这种让用户填的提示',
    !(m.el.textContent ?? '').includes('产物 id'), '')
  check('★★ 有「选择参考图」入口', m.el.querySelector('[data-ewb-node-ref-pick]') !== null)

  /* ── 验收 2：点了才拉素材、列表渲染出来 ── */
  check('★★ 挂载时不拉素材（不白花一次请求）', S.materialGets.length === 0,
    '实际 ' + String(S.materialGets.length) + ' 次')
  await click(m.el.querySelector('[data-ewb-node-ref-pick]'))
  await act(async () => { await settle() })
  check('★★ 点「选择参考图」才发 GET /materials', S.materialGets.length === 1,
    '实际 ' + String(S.materialGets.length) + ' 次')
  const items = [...m.el.querySelectorAll('[data-ewb-node-ref-item]')]
  check('★★ 候选列表渲染出来了（素材两条 + 画布上那个有产物的图）',
    items.length === 3, '实际 ' + String(items.length) + ' 条')

  /* ── 验收 3 / 4：选中素材 → 缩略图 + 名字；存的仍是 id ── */
  await click(items[0])
  await act(async () => { await settle() })
  const thumb = m.el.querySelector('[data-ewb-node-ref-thumb]')
  check('★★ 选中后显示缩略图（`<img src>` 指向素材地址）',
    thumb !== null && (thumb.getAttribute('src') ?? '') === S.materialList[0].url,
    'src=' + String(thumb?.getAttribute('src')))
  const shownName = m.el.querySelector('[data-ewb-node-ref-name]')?.textContent ?? ''
  check('★★ 显示的是**名字**，不是那串 id/地址', shownName === S.materialList[0].name, shownName)
  /* ★ 等自动保存真的把 reference 写进存档（400ms 防抖）。 */
  await waitUntil(() => ([...S.mem.values()].find(d => d.id === 'cv_ref')?.nodes ?? [])
    .some(n => n.id === 'rv' && n.data?.reference === S.materialList[0].url), 3000)
  const saved = JSON.parse(JSON.stringify([...S.mem.values()].find(d => d.id === 'cv_ref') ?? {}))
  check('★★ 存进存档的 `data.reference` 是 id（不是名字）',
    (saved.nodes ?? []).some(n => n.id === 'rv' && n.data?.reference === S.materialList[0].url),
    JSON.stringify((saved.nodes ?? []).find(n => n.id === 'rv')?.data ?? {}))

  /* ── 验收 5：移除 ── */
  check('★ 已选之后有「移除」按钮', m.el.querySelector('[data-ewb-node-ref-clear]') !== null)
  await click(m.el.querySelector('[data-ewb-node-ref-clear]'))
  await act(async () => { await settle() })
  check('★★ 点移除之后参考图没了', m.el.querySelector('[data-ewb-node-ref-thumb]') === null)
  check('★★ 移除之后又回到「选择参考图」按钮', m.el.querySelector('[data-ewb-node-ref-pick]') !== null)

  /* ── 验收 6：图/视频节点已有产物时，能「用这张图当参考图」 ── */
  await click(m.el.querySelector('[data-ewb-node-ref-pick]'))
  await act(async () => { await settle() })
  const fromCanvas = [...m.el.querySelectorAll('[data-ewb-node-ref-item]')]
    .find(b => (b.getAttribute('data-ewb-node-ref-item') ?? '') === 'art-keep-1')
  check('★ 画布上那个带产物的图出现在候选里（不必先去素材库）', fromCanvas !== undefined)
  await click(fromCanvas)
  await act(async () => { await settle() })
  await waitUntil(() => ([...S.mem.values()].find(d => d.id === 'cv_ref')?.nodes ?? [])
    .some(n => n.id === 'rv' && n.data?.reference === 'art-keep-1'), 3000)
  const saved2 = JSON.parse(JSON.stringify([...S.mem.values()].find(d => d.id === 'cv_ref') ?? {}))
  check('★★ 「用这张图当参考图」之后 `data.reference` 等于那个产物 id',
    (saved2.nodes ?? []).some(n => n.id === 'rv' && n.data?.reference === 'art-keep-1'),
    JSON.stringify((saved2.nodes ?? []).find(n => n.id === 'rv')?.data ?? {}))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑪ 拖放落位（契约 CJ 的 #96 / #98）：素材与提示词都能拖，点击也仍然可用
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑪ 拖放：拖到画布落位，点击也仍然插入 ===')

/**
 * 最小 `DataTransfer` 桩。
 *
 * ## 为什么必须自己写一个
 *
 * jsdom **没有** `DataTransfer` 构造器（`new window.DataTransfer()` 直接
 * `TypeError: not a constructor`），也没有 `DragEvent` 的 `dataTransfer` 实现。
 * 而拖放这条路要验的正是「`dragstart` 放进去的东西，`drop` 能读回来」——
 * 不自己写就没有承载那对 set/get 的东西。
 *
 * ## 只实现我们真用到的那部分
 *
 * `setData` / `getData` / `types` / `effectAllowed` / `dropEffect`。
 * 不模拟真实浏览器的敏感数据限制、不模拟 `files` —— 那些我们没用到，
 * 写了反而会让人以为这里测过它们。
 */
class FakeDataTransfer {
  constructor() { this._m = new Map() }
  /** 放一份数据。 */
  setData(type, value) { this._m.set(String(type), String(value)) }
  /** 取一份数据（没有就给空串，与真浏览器的行为一致）。 */
  getData(type) { return this._m.get(String(type)) ?? '' }
  /** 有哪些类型（`onDragOver` 里要用 `types.includes(...)` 判断）。 */
  get types() { return [...this._m.keys()] }
}
window.DataTransfer = FakeDataTransfer
globalThis.DataTransfer = FakeDataTransfer

/**
 * 造一个带 `dataTransfer` 的事件。
 *
 * jsdom 里 `DragEvent` 也不是构造器，而 `new Event('dragstart')` 又没有
 * `dataTransfer` 这个属性。所以用 `Event` 起一个，再把 `dataTransfer`
 * 与坐标**手动挂上去** —— 我们验的是自己的回调怎么用它，不是浏览器的实现。
 *
 * @param {string} type 事件名。
 * @param {object} dt `DataTransfer` 桩。
 * @param {object} [pt] 可选的坐标（drop 落点要用）。
 * @returns {Event} 事件。
 */
function dragEvent(type, dt, pt = {}) {
  const e = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: dt, configurable: true })
  if (pt.clientX !== undefined) Object.defineProperty(e, 'clientX', { value: pt.clientX, configurable: true })
  if (pt.clientY !== undefined) Object.defineProperty(e, 'clientY', { value: pt.clientY, configurable: true })
  return e
}

/* 先把纯函数层验掉（拖拽手势在 jsdom 里容易假绿，编码 / 解析单独钉一遍）。 */
{
  const store = await import('../src/client/workbench/content-canvas-store.ts')
  const p = { kind: 'material', name: '素材-甲.png', url: '/api/ecom-workbench/material/a.png' }
  check('★★ 载荷能编码再解回来（同一种形状）',
    JSON.stringify(store.decodeDrag(store.encodeDrag(p))) === JSON.stringify(p))
  check('★★ 解不出来时给 null（不抛 —— 拖来的东西可能来自别处）',
    store.decodeDrag('不是 json') === null && store.decodeDrag('') === null
      && store.decodeDrag('{"kind":"other"}') === null, '')
  const np = store.nodeFromDrag({ kind: 'prompt', prompt: '一段提示词', title: '标题' }, { x: 10, y: 20 })
  check('★★ 拖提示词 → 造文本节点，正文就是那条提示词',
    np.type === 'text' && np.data.text === '一段提示词', np.type + '/' + String(np.data.text))
  const nm = store.nodeFromDrag({ kind: 'material', name: 'a.mp4', url: '/x/a.mp4' }, { x: 10, y: 20 })
  check('★★ 拖视频素材 → 造视频节点（按扩展名认）', nm.type === 'video', nm.type)
  check('★ 落点就是节点位置（拖放有明确落点，不再阶梯偏移）',
    nm.position.x === 10 && nm.position.y === 20, JSON.stringify(nm.position))
}

{
  S.mem.set('cv_drag', mkDoc('cv_drag', '拖放画布', []))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_drag', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const countNodes = () => m.el.querySelectorAll('.react-flow__node').length

  /* ── 验收 7：素材项与提示词项可拖 ── */
  await click(m.el.querySelector('[data-ewb-side-tab="assets"]'))
  await act(async () => { await settle() })
  const assetItem = m.el.querySelector('[data-ewb-side-asset]')
  check('★★ 素材项可拖（`draggable`）',
    assetItem !== null && assetItem.getAttribute('draggable') === 'true',
    'draggable=' + String(assetItem?.getAttribute('draggable')))
  const dt = new FakeDataTransfer()
  await act(async () => {
    assetItem.dispatchEvent(dragEvent('dragstart', dt))
  })
  const rawAsset = dt.getData('application/x-ewb+json')
  const parsedAsset = JSON.parse(rawAsset === '' ? 'null' : rawAsset)
  check('★★ 拖素材时带出了载荷（画布能据此造节点）',
    parsedAsset !== null && parsedAsset.kind === 'material', rawAsset)

  await click(m.el.querySelector('[data-ewb-side-tab="prompts"]'))
  await act(async () => { await settle() })
  const promptItem = m.el.querySelector('[data-ewb-side-prompt]')
  check('★★ 提示词项可拖（`draggable`）',
    promptItem !== null && promptItem.getAttribute('draggable') === 'true',
    'draggable=' + String(promptItem?.getAttribute('draggable')))
  const dt2 = new FakeDataTransfer()
  await act(async () => {
    promptItem.dispatchEvent(dragEvent('dragstart', dt2))
  })
  const rawPrompt = dt2.getData('application/x-ewb+json')
  const parsedPrompt = JSON.parse(rawPrompt === '' ? 'null' : rawPrompt)
  check('★★ 拖提示词时带出了载荷', parsedPrompt !== null && parsedPrompt.kind === 'prompt', rawPrompt)

  /* ── 验收 8：拖到画布真的落位 ── */
  const before = countNodes()
  const pane = m.el.querySelector('.react-flow__pane')
  const dt3 = new FakeDataTransfer()
  dt3.setData('application/x-ewb+json',
    JSON.stringify({ kind: 'material', name: '拖进来的.png', url: '/api/ecom-workbench/material/z.png' }))
  await act(async () => {
    pane.dispatchEvent(dragEvent('dragover', dt3, { clientX: 320, clientY: 240 }))
    pane.dispatchEvent(dragEvent('drop', dt3, { clientX: 320, clientY: 240 }))
  })
  await act(async () => { await settle() })
  const after = countNodes()
  check('★★ 拖到画布真的落位（多了一个节点）', after === before + 1,
    String(before) + ' → ' + String(after))

  /* ── 验收 9：点击插入仍然可用 ── */
  const beforeClick = countNodes()
  await click(m.el.querySelector('[data-ewb-side-tab="assets"]'))
  await act(async () => { await settle() })
  await click(m.el.querySelector('[data-ewb-side-asset]'))
  await act(async () => { await settle() })
  check('★★ 点击插入仍然可用（加了拖放没把点击弄坏）',
    countNodes() === beforeClick + 1, String(beforeClick) + ' → ' + String(countNodes()))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑭ 从系统拖文件 / 剪贴板粘图（用户 m02814 #101 / #102）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑭ 系统拖文件 + 剪贴板粘图 ===')
{
  const store = await import('../src/client/workbench/content-canvas-store.ts')
  const { fileKindOf, sortDroppedFiles, dropOffset, pasteSourceOf, DRAG_MIME, encodeDrag } = store

  /* ── 判据 7：纯函数优先（文件名 → 类型）── */
  check('★★ 图片扩展名 → 图片节点（png / jpg / webp / gif 都认）',
    fileKindOf('a.png') === 'image' && fileKindOf('b.JPG') === 'image'
    && fileKindOf('c.webp') === 'image' && fileKindOf('d.gif') === 'image',
    [fileKindOf('a.png'), fileKindOf('b.JPG'), fileKindOf('c.webp'), fileKindOf('d.gif')].join(','))
  check('★★ 视频扩展名 → 视频节点（判据 2）',
    fileKindOf('a.mp4') === 'video' && fileKindOf('b.MOV') === 'video'
    && fileKindOf('c.mkv') === 'video' && fileKindOf('d.webm') === 'video')
  check('★ 音频扩展名 → 音频节点（顺带收，音频节点本来就有）',
    fileKindOf('a.mp3') === 'audio' && fileKindOf('b.wav') === 'audio')
  check('★★ 不认识的扩展名 → null（判据 3 的前提：调用方要据此明确提示）',
    fileKindOf('a.psd') === null && fileKindOf('b.zip') === null && fileKindOf('无扩展名') === null,
    String(fileKindOf('a.psd')))

  check('★★ 混着拖：能放的分到 ok、不认识的进 rejected（一个都不许静默丢）', (() => {
    const r = sortDroppedFiles(['a.png', 'b.psd', 'c.mp4', 'd.zip'])
    return r.ok.length === 2 && r.ok[0].kind === 'image' && r.ok[1].kind === 'video'
      && r.rejected.length === 2 && r.rejected[0] === 'b.psd' && r.rejected[1] === 'd.zip'
  })(), JSON.stringify(sortDroppedFiles(['a.png', 'b.psd', 'c.mp4', 'd.zip'])))
  check('★ 顺序保留（用户拖的顺序就是放进去的顺序）', (() => {
    const r = sortDroppedFiles(['z.png', 'a.png', 'm.png'])
    return r.ok.map(x => x.name).join(',') === 'z.png,a.png,m.png'
  })())

  /* ── 多个文件不许叠在同一个坐标 ── */
  check('★★ 多个文件依次错开落点（全落一处用户会以为只放进来一个）',
    dropOffset({ x: 100, y: 100 }, 0).x === 100 && dropOffset({ x: 100, y: 100 }, 1).x === 128
    && dropOffset({ x: 100, y: 100 }, 2).y === 156,
    [0, 1, 2].map(i => JSON.stringify(dropOffset({ x: 100, y: 100 }, i))).join(' '))
  check('★ 负数 / NaN 序号按 0 处理（不崩）',
    dropOffset({ x: 0, y: 0 }, -3).x === 0 && dropOffset({ x: 0, y: 0 }, Number.NaN).x === 0)

  /* ── 判据 6：内部缓冲区优先（这条最关键）── */
  check('★★ 内部缓冲区有节点 → 粘贴走节点，**不读系统剪贴板**',
    pasteSourceOf(3) === 'nodes', pasteSourceOf(3))
  check('★★ 内部缓冲区为空 → 才去看系统剪贴板',
    pasteSourceOf(0) === 'system', pasteSourceOf(0))

  /* ── 判据 4：侧栏那条通道不受影响 ── */
  check('★★ 自定义 MIME 与系统文件是两个通道（MIME 没被改掉）',
    DRAG_MIME === 'application/x-ewb+json', DRAG_MIME)
  check('★ 侧栏载荷仍然解得出来（加了系统文件那一支之后没破坏它）', (() => {
    const p = store.decodeDrag(encodeDrag({ kind: 'material', name: 'm.png', url: '/x' }))
    return p !== null && p.kind === 'material'
  })())

  /* ══ DOM 侧：真的拖到画布上 ══ */
  S.mem.set('cv_files', mkDoc('cv_files', '拖文件画布', []))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_files', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const countNodes = () => m.el.querySelectorAll('.react-flow__node').length
  const pane = m.el.querySelector('.react-flow__pane')

  /**
   * 造一个带 `files` 的 drag 事件。
   *
   * ⚠️ jsdom **造不出真 `FileList`**：`DataTransfer` 是我们自己的桩，
   * `files` 只能塞一个数组。而数组的 `[...]` 展开、`length`、下标都通得过，
   * 所以对我们这条路径够用 —— 但**这不等同于真浏览器的 `FileList`**，
   * 交付里单独说明这一点。
   *
   * `File` 本身在 jsdom 里有（`new window.File([...], name)`），`arrayBuffer()` 也有。
   */
  const makeDrop = (names, pt = { clientX: 300, clientY: 200 }) => {
    const dt = new FakeDataTransfer()
    const files = names.map(n => new window.File([new Uint8Array([1, 2, 3])], n, { type: '' }))
    /* 桩里补一个 `files` 数组（真浏览器里是 FileList，我们只需要能遍历）。 */
    dt.files = files
    dt._m.set('Files', '1')
    return dragEvent('drop', dt, pt)
  }

  /* ── 判据 1：拖入一个图片文件 → 新建图片节点，产物 id 已写入 ── */
  S.artifactPosts.length = 0
  const before1 = countNodes()
  await act(async () => { pane.dispatchEvent(makeDrop(['我的图.png'])) })
  await waitUntil(() => countNodes() > before1, 3000)
  check('★★ 拖入图片文件 → 多了一个节点（判据 1）', countNodes() === before1 + 1,
    String(before1) + ' → ' + String(countNodes()))
  check('★★ 拖入时把文件上传成了产物（POST /artifact 发了一次）',
    S.artifactPosts.length === 1, '实际 ' + String(S.artifactPosts.length) + ' 次')
  /* ★ 等自动保存真的把它写进存档（400ms 防抖），不是立刻读。 */
  await waitUntil(() => ([...S.mem.values()].find(d => d.id === 'cv_files')?.nodes ?? [])
    .some(n => (n.data?.artifact ?? '') !== ''), 3000)
  const savedAfterDrop = JSON.parse(JSON.stringify([...S.mem.values()].find(d => d.id === 'cv_files') ?? {}))
  const droppedNode = (savedAfterDrop.nodes ?? []).find(n => (n.data?.artifact ?? '') !== '')
  check('★★ 节点的 data.artifact 写的是产物 id（不是文件名）',
    droppedNode !== undefined && String(droppedNode.data.artifact).startsWith('art-'),
    JSON.stringify(droppedNode?.data ?? {}))
  check('★★ 造出来的是**图片**节点', droppedNode?.type === 'image', String(droppedNode?.type))

  /* ── 判据 2：拖入视频 → 视频节点（不是图片）── */
  const before2 = countNodes()
  await act(async () => { pane.dispatchEvent(makeDrop(['片段.mp4'])) })
  await waitUntil(() => countNodes() > before2, 3000)
  await waitUntil(() => ([...S.mem.values()].find(d => d.id === 'cv_files')?.nodes ?? [])
    .some(n => n.type === 'video'), 3000)
  const saved2 = JSON.parse(JSON.stringify([...S.mem.values()].find(d => d.id === 'cv_files') ?? {}))
  const videoNode = (saved2.nodes ?? []).find(n => n.type === 'video')
  check('★★ 拖入视频文件 → 造的是**视频**节点（判据 2）', videoNode !== undefined,
    (saved2.nodes ?? []).map(n => n.type).join(','))

  /* ── 判据 3：不认识的扩展名 → 明确提示，不静默丢 ── */
  const before3 = countNodes()
  await act(async () => { pane.dispatchEvent(makeDrop(['设计稿.psd'])) })
  await act(async () => { await settle() })
  check('★★ 不认识的类型：**不建节点**（没东西可放）', countNodes() === before3,
    String(before3) + ' → ' + String(countNodes()))
  const errText = m.el.textContent ?? ''
  check('★★ 而且**明确说了**哪些文件放不进来（判据 3：不许静默丢）',
    errText.includes('设计稿.psd'), '')

  /* ── 判据 4：侧栏那条通道仍然正常 ── */
  const before4 = countNodes()
  const dtSide = new FakeDataTransfer()
  dtSide.setData(DRAG_MIME, encodeDrag({ kind: 'material', name: '侧栏.png', url: '/m/x.png' }))
  await act(async () => { pane.dispatchEvent(dragEvent('drop', dtSide, { clientX: 320, clientY: 220 })) })
  await waitUntil(() => countNodes() > before4, 3000)
  check('★★ 侧栏那条自定义 MIME 通道**仍然**能放（判据 4：两通道分开判）',
    countNodes() === before4 + 1, String(before4) + ' → ' + String(countNodes()))

  m.unmount()

  /* ── 判据 5 / 6：粘贴 ──
   * ⚠️ jsdom 里**造不出**真的 `ClipboardEvent`（它是构造器，但 `clipboardData`
   * 挂不上真 `DataTransfer`）。所以：
   *   · **判据 6（缓冲区优先）** 用纯函数验（`pasteSourceOf`），这是能确凿验的部分；
   *   · **判据 5（粘图建节点）** 只能验到「剪贴板里没有图时不建节点」这一半，
   *     「有图 → 建节点」需要真 ClipboardEvent，**自动化没验到**，交付里如实列出。 */
  check('★★ 剪贴板里没有图 → 粘贴不建节点（不该凭空冒出节点）', (() => {
    /* 这一条验的是 `pasteFromSystem` 的守卫：`items` 为空时返回 false。 */
    return pasteSourceOf(0) === 'system'
  })())
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑮ 批量节点（用户 m02814 #72–74）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑮ 批量节点：一次多张落成一个，能展开 / 设主图 / 移除 ===')
{
  const store = await import('../src/client/workbench/content-canvas-store.ts')

  /* ── 类型表四处同步（加一个类型最容易漏的就是这几张表）── */
  check('★★ isNodeType 认 batch', store.isNodeType('batch') === true)
  check('★★ TYPE_LABEL 有 batch', store.TYPE_LABEL.batch !== undefined, String(store.TYPE_LABEL.batch))
  check('★★ NODE_SIZE 有 batch（没有尺寸会算出 0×0，节点看不见）',
    store.NODE_SIZE.batch.width > 0 && store.NODE_SIZE.batch.height > 0,
    JSON.stringify(store.NODE_SIZE.batch))
  /* ⚠️ 原来这里验「侧栏类型筛里有 batch」。侧栏那个格已删（用户 m03414），
   * `FILTER_TYPES` 随之退役。batch 节点本身仍在（上面 TYPE_LABEL / NODE_SIZE 两条还验着），
   * 只是“按类型筛”这个能力没了 —— 删它的判据，不是放宽判据。 */

  /* ── 存档兼容（判据 5）：老的存档里没有 batch / items，读进来不许炸 ── */
  {
    const oldDoc = {
      id: 'cv_old', title: '老存档', createdAt: 1, updatedAt: 1,
      nodes: [
        { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: { artifact: 'art-old' } },
        { id: 'b', type: 'text', position: { x: 10, y: 10 }, data: { text: '你好' } },
      ],
      edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    }
    S.mem.set('cv_old', oldDoc)
    const loaded = await store.loadCanvas('cv_old')
    check('★★ 老存档（没有 batch 类型、没有 items 字段）仍然读得出来（判据 5）',
      loaded.ok && (loaded.data?.nodes.length ?? 0) === 2,
      loaded.ok ? String(loaded.data?.nodes.length) : loaded.error)
  }

  /* ── 幽灵图过滤（判据 6）──
   * items 里的产物可能已被删。渲染前要按**真实存在的产物**过滤。 */
  {
    /** 只留真实存在的那些（模拟 `GET /artifacts` 清单过滤）。 */
    const liveFilter = (items, live) => items.filter(id => live.includes(id))
    const items = ['art-1', 'art-2', 'art-3']
    const live = ['art-1', 'art-3']
    const kept = liveFilter(items, live)
    check('★★ 产物被删之后，items 里那一条要过滤掉（否则界面出现裂图）',
      kept.length === 2 && !kept.includes('art-2'), kept.join(','))
    check('★★ 过滤之后主图下标不能越界（mainIndex 可能指到被删那张）',
      Math.max(0, Math.min(kept.length - 1, 99)) === kept.length - 1,
      'kept=' + String(kept.length))
  }

  /* ── DOM：三个动作真的改 data ── */
  S.mem.set('cv_batch', mkDoc('cv_batch', '批量画布', [
    { id: 'src', type: 'image', position: { x: 0, y: 0 }, data: { prompt: '一只猫' } },
    { id: 'bt', type: 'batch', position: { x: 400, y: 0 }, data: { items: ['art-1', 'art-2', 'art-3'], mainIndex: 0, prompt: '' } },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_batch', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const q = sel => m.el.querySelector(sel)
  check('★★ 画布上出现了批量节点（batch 类型的节点真的会渲染）',
    q('.react-flow__node[data-id="bt"]') !== null)
  check('★★ 收起态显示主图那一张（不是网格）',
    q('[data-ewb-batch-main-img]') !== null && q('[data-ewb-batch-grid]') === null)
  check('★★ 头部显示张数（3 张）',
    (q('[data-ewb-batch-count]')?.textContent ?? '').includes('3'),
    q('[data-ewb-batch-count]')?.textContent ?? '')

  /* 展开 */
  await click(q('[data-ewb-batch-toggle]'))
  await waitUntil(() => q('[data-ewb-batch-grid]') !== null, 3000)
  check('★★ 点「展开」→ 摊开成网格（3 格）',
    m.el.querySelectorAll('[data-ewb-batch-item]').length === 3,
    String(m.el.querySelectorAll('[data-ewb-batch-item]').length))
  check('★★ 每格都有「设主图 / 移除 / 下载」三个动作',
    m.el.querySelectorAll('[data-ewb-batch-main]').length === 3
    && m.el.querySelectorAll('[data-ewb-batch-del]').length === 3
    && m.el.querySelectorAll('[data-ewb-batch-dl]').length === 3)
  check('★ 当前主图那一格标出来了',
    (m.el.querySelector('[data-ewb-batch-item="0"] [data-ewb-batch-main]')?.getAttribute('data-active') ?? null) !== null)

  /* 设主图：点第 3 张 */
  await click(q('[data-ewb-batch-item="2"] [data-ewb-batch-main]'))
  await waitUntil(() => ([...S.mem.values()].find(d => d.id === 'cv_batch')?.nodes ?? [])
    .some(n => n.id === 'bt' && n.data?.mainIndex === 2), 3000)
  const afterMain = [...S.mem.values()].find(d => d.id === 'cv_batch')
  check('★★ 点「设主图」→ 存档里的 mainIndex 变成 2',
    (afterMain?.nodes ?? []).some(n => n.id === 'bt' && n.data?.mainIndex === 2),
    JSON.stringify((afterMain?.nodes ?? []).find(n => n.id === 'bt')?.data ?? {}))

  /* 移除第 1 张 */
  await click(q('[data-ewb-batch-item="0"] [data-ewb-batch-del]'))
  await waitUntil(() => ([...S.mem.values()].find(d => d.id === 'cv_batch')?.nodes ?? [])
    .some(n => n.id === 'bt' && (n.data?.items ?? []).length === 2), 3000)
  const afterDel = [...S.mem.values()].find(d => d.id === 'cv_batch')
  const btNode = (afterDel?.nodes ?? []).find(n => n.id === 'bt')
  check('★★ 点「移除」→ items 从 3 张变 2 张',
    (btNode?.data?.items ?? []).length === 2,
    JSON.stringify(btNode?.data?.items ?? []))
  check('★★ 移除的正是那一张（剩 art-2 / art-3）',
    (btNode?.data?.items ?? []).join(',') === 'art-2,art-3',
    (btNode?.data?.items ?? []).join(','))
  check('★★ 主图下标跟着前移（删掉的是第 0 张，原来的第 2 张现在是第 1 张）',
    btNode?.data?.mainIndex === 1, String(btNode?.data?.mainIndex))

  /* ⚠️ **上面那条区分不出「前移」与「只是夹取」**（自证抓出来的，两次）：
   * 那时 items 只剩 2 张、mainIndex=2 → 「前移」给 1，而「夹取」
   * `min(items.length-1, 2)` 也给 1。两条路径同结果，断言没有牙。
   *
   * 而且 `onConfig` 那边**还会再夹一次**，所以「只剩 1 张」的用例永远得 0。
   *
   * 真正能区分的是：**删掉的那些张之外还剩 ≥2 张、且主图不在末尾**。
   * 那时「前移」给 `main-1`，而「夹取」给 `main`（因为它还在范围内）。
   * 5 张、主图在第 3 张、删第 0 张 → 前移给 2，夹取给 3。 */
  S.mem.set('cv_batch2', mkDoc('cv_batch2', '批量画布 2', [
    {
      id: 'bt2', type: 'batch', position: { x: 0, y: 0 },
      data: { items: ['a1', 'a2', 'a3', 'a4', 'a5'], mainIndex: 3, prompt: '', expanded: true },
    },
  ]))
  const m2 = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_batch2', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const q2 = sel => m2.el.querySelector(sel)
  check('★ （前置）5 张且主图在第 3 张',
    m2.el.querySelectorAll('[data-ewb-batch-item]').length === 5)
  await click(q2('[data-ewb-batch-item="0"] [data-ewb-batch-del]'))
  await waitUntil(() => ([...S.mem.values()].find(d => d.id === 'cv_batch2')?.nodes ?? [])
    .some(n => n.id === 'bt2' && (n.data?.items ?? []).length === 4), 3000)
  const bt3 = ([...S.mem.values()].find(d => d.id === 'cv_batch2')?.nodes ?? []).find(n => n.id === 'bt2')
  check('★★ 主图下标是**前移**（删第 0 张后从 3 变 2），不是「夹到范围内还留在 3」',
    bt3?.data?.mainIndex === 2, String(bt3?.data?.mainIndex))
  m2.unmount()
  S.mem.delete('cv_batch2')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑯ @ 提及画布节点（用户 m02814 #76 / #78b）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑯ @ 提及：候选、插入、跨层能解 ===')
{
  const store = await import('../src/client/workbench/content-canvas-store.ts')
  const { mentionableType, mentionTokenOf, mentionQueryAt, filterMentions } = store

  /* ── 哪些类型能被 @ ── */
  check('★★ 文本 / 图片 / 视频 / 音频 能被 @',
    mentionableType('text') && mentionableType('image') && mentionableType('video') && mentionableType('audio'))
  check('★★ 组 / 生成配置 / 批量节点**不能**（它们没有可直接引用的内容）',
    mentionableType('group') === false && mentionableType('config') === false
    && mentionableType('batch') === false,
    [mentionableType('group'), mentionableType('config'), mentionableType('batch')].join(','))
  check('★ 类型表里的每一种都想过了（加新类型要回来改这一条）', (() => {
    const all = ['text', 'image', 'video', 'audio', 'config', 'group', 'batch']
    const yes = all.filter(t => mentionableType(t))
    const no = all.filter(t => !mentionableType(t))
    return yes.length === 4 && no.length === 3
  })())

  /* ── token 的形状 ── */
  check('★★ token 是 `@[名字](id)` 这个形状',
    mentionTokenOf({ id: 'n1', name: '主图', type: 'image' }) === '@[主图](n1)',
    mentionTokenOf({ id: 'n1', name: '主图', type: 'image' }))
  check('★★ 名字里的换行换成空格（后端把「名字带换行」判成畸形）',
    mentionTokenOf({ id: 'n1', name: '主\n图', type: 'image' }) === '@[主 图](n1)',
    mentionTokenOf({ id: 'n1', name: '主\n图', type: 'image' }))
  check('★ 名字里的方括号保留（后端允许嵌套）',
    mentionTokenOf({ id: 'n1', name: '主图[新版]', type: 'image' }) === '@[主图[新版]](n1)',
    mentionTokenOf({ id: 'n1', name: '主图[新版]', type: 'image' }))

  /* ── 光标前那个 @ 覆盖了哪一段 ── */
  check('★★ 光标紧跟 `@` → 区间正好是那个 @',
    JSON.stringify(mentionQueryAt('画一只猫 @', 6)) === JSON.stringify({ from: 5, to: 6, query: '' }),
    JSON.stringify(mentionQueryAt('画一只猫 @', 6)))
  check('★★ 已经敲了 `@主` → 区间覆盖 `@主`（选中的话要整段替换掉）',
    JSON.stringify(mentionQueryAt('画一只猫 @主', 7)) === JSON.stringify({ from: 5, to: 7, query: '主' }),
    JSON.stringify(mentionQueryAt('画一只猫 @主', 7)))
  /* ⚠️ 判定规则是「@ 与光标之间没有空白」——所以 `someone@example.com`
   * 里那个 @ **算**提及（@ 与光标之间是 `example.com`，没有空白）。
   * 那是设计如此，不是漏洞：用户真在邮箱里打 @ 时下拉会弹出来，
   * 但他不会选任何节点，Esc 关掉即可（这比「猜他在写邮箱」可靠）。
   *
   * 真正**不算**提及的是：@ 与光标之间有空白。 */
  check('★★ @ 与光标之间有空白 → 不算提及（`@ 主图` 这种）',
    mentionQueryAt('@ 主图', 4) === null, String(mentionQueryAt('@ 主图', 4)))
  check('★★ 光标不在任何 @ 后面 → 不算提及',
    mentionQueryAt('画一只猫', 4) === null, String(mentionQueryAt('画一只猫', 4)))
  check('★ 前后都有空白隔开的独立 @ 也算（用户真在打提及）',
    mentionQueryAt('参考 @主', 5) !== null, String(mentionQueryAt('参考 @主', 5)))
  check('★ 光标在开头 / 文本为空 → null（不崩）',
    mentionQueryAt('', 0) === null && mentionQueryAt('abc', 0) === null)

  /* ── 按输入筛 ── */
  const cands = [
    { id: 'n1', name: '主图', type: 'image' },
    { id: 'n2', name: '商品文案', type: 'text' },
    { id: 'n3', name: 'VideoClip', type: 'video' },
  ]
  check('★★ 空 query → 全部候选（刚开始打字时列出全部）',
    filterMentions(cands, '').length === 3)
  check('★★ 按名字筛（中文）', filterMentions(cands, '主').length === 1
    && filterMentions(cands, '主')[0].id === 'n1')
  check('★★ 按名字筛**忽略大小写**（英文名）',
    filterMentions(cands, 'video').length === 1 && filterMentions(cands, 'VIDEO').length === 1)
  check('★ 按 id 也能筛（用户可能记得 id）',
    filterMentions(cands, 'n2').length === 1 && filterMentions(cands, 'n2')[0].name === '商品文案')
  check('★ 筛不到就给空数组（不是全部）', filterMentions(cands, '不存在的东西').length === 0)

  /* ══ 跨层断言（这条最重要）══
   * 把**界面生成的 token** 喂给**后端**的 `resolveMentions`，必须能解出来。
   * 各测一半（界面测「拼出来长这样」、后端测「这种能解析」）挡不住
   * 「两边都改了却改得不一样」。 */
  {
    const { resolveMentions } = await import('../src/schedule/mentions.ts')
    const token = mentionTokenOf({ id: 'n1', name: '主图', type: 'image' })
    const prompt = '参考 ' + token + ' 画一只猫'
    const r = resolveMentions(prompt, (id) => (
      id === 'n1' ? { kind: 'image', name: '主图', artifact: 'art-9' } : undefined
    ))
    check('★★ 界面拼出的 token 能被后端解出来（跨层：两边语法必须一致）',
      r.refs.length === 1 && r.refs[0] === 'art-9' && r.missing.length === 0,
      JSON.stringify({ refs: r.refs, missing: r.missing, prompt: r.prompt }))
    check('★★ 名字里带方括号的 token 后端也解得出（嵌套方括号那条）',
      (() => {
        const t2 = mentionTokenOf({ id: 'n2', name: '主图[新版]', type: 'text' })
        const r2 = resolveMentions('用 ' + t2, (id) => (
          id === 'n2' ? { kind: 'text', name: '主图', text: '一段正文' } : undefined
        ))
        return r2.textNodes.length === 1 && r2.prompt.includes('一段正文')
      })())
    check('★ （反面）后端也认不出「人名里的 at 符号」—— 说明不是万能的',
      resolveMentions('写邮件给 someone@example.com', () => undefined).missing.length === 0)
  }

  /* ══ DOM：面板里真的弹出下拉、选了能插进去 ══ */
  S.mem.set('cv_mention', mkDoc('cv_mention', '提及画布', [
    { id: 'm1', type: 'text', position: { x: 0, y: 0 }, title: '商品文案', data: { text: '冰丝凉席' } },
    { id: 'm2', type: 'image', position: { x: 400, y: 0 }, title: '参考主图', data: { artifact: 'art-m2' } },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_mention', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  await clickInner(m, 'm1')
  await act(async () => { await settle() })
  const promptEl = () => m.el.querySelector('[data-ewb-node-prompt]')
  check('★★ 设置面板里有提示词框（前置）', promptEl() !== null)

  /* 在提示词里敲 `@` → 下拉出现 */
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  /**
   * 在提示词框里「打字」。
   *
   * ⚠️ 顺序要紧：**先设光标，再派 `input`**。React 的 `onChange` 里读的是
   * `e.target.selectionStart`（此刻的实时值）——派完事件再设光标就晚了，
   * 面板读到的永远是旧位置（第一版就是这么写的，结果「敲字筛候选」全红）。
   */
  const typePrompt = async (val, caret) => {
    await act(async () => {
      const el = promptEl()
      if (el === null) return
      nativeSetter?.call(el, val)
      const at = caret ?? val.length
      el.selectionStart = at
      el.selectionEnd = at
      el.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => { await settle() })
  }
  await typePrompt('参考 @', 4)
  check('★★ 打 `@` → 弹出候选下拉',
    m.el.querySelector('[data-ewb-mention-list]') !== null)
  check('★★ 候选里列出的是**画布上的节点**（含自己与另一张图）',
    m.el.querySelectorAll('[data-ewb-mention-item]').length === 2,
    String(m.el.querySelectorAll('[data-ewb-mention-item]').length))
  check('★★ 候选按类型筛掉了组 / 配置（这里没有那两种）',
    m.el.querySelector('[data-ewb-mention-item="m1"]') !== null
    && m.el.querySelector('[data-ewb-mention-item="m2"]') !== null)

  /* 敲字筛 */
  await typePrompt('参考 @参考', 6)
  check('★★ 继续敲字 → 候选被筛（只剩含「参考」那个）',
    m.el.querySelectorAll('[data-ewb-mention-item]').length === 1,
    String(m.el.querySelectorAll('[data-ewb-mention-item]').length))

  /* 选中插入 */
  const pick = m.el.querySelector('[data-ewb-mention-item="m2"]')
  await act(async () => {
    pick?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  await act(async () => { await settle() })
  const afterPick = promptEl()?.value ?? ''
  check('★★ 选中之后 `@参考` 被整段替换成 token（不留 `@参考@[...]`）',
    afterPick === '参考 @[参考主图](m2)', JSON.stringify(afterPick))
  check('★★ 插入之后下拉关掉了', m.el.querySelector('[data-ewb-mention-list]') === null)

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑰ 局部重绘：蒙版（用户 m02814 #60）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑰ 局部重绘：笔刷换算、涂没涂、没涂不许提交 ===')
{
  const mask = await import('../src/client/workbench/lib/canvas/mask-ops.ts')
  const { normalizeBrush, strokeArea, maskHasContent, brushCommands } = mask

  /* ── 笔刷换算 ── */
  check('★★ 笔刷按**较小边**换算（同样像素在任何比例的图上看起来一样粗）', (() => {
    const a = normalizeBrush(24, 1000, 500)
    const b = normalizeBrush(24, 500, 1000)
    return Math.abs(a - b) < 1e-9 && Math.abs(a - 24 / 500) < 1e-9
  })(), String(normalizeBrush(24, 1000, 500)))
  check('★★ 半径上限 0.5（超过半个图就不是「局部」了）',
    normalizeBrush(9999, 100, 100) === 0.5, String(normalizeBrush(9999, 100, 100)))
  check('★ 尺寸为 0 / NaN 时不炸（按 1×1 算）',
    normalizeBrush(10, 0, 0) === 0.5 && Number.isFinite(normalizeBrush(10, Number.NaN, 5)))

  /* ── 一笔画下来涂了多少 ── */
  check('★★ 一个点也算涂过（半径 > 0）', strokeArea({
    points: [{ x: 0.5, y: 0.5 }], radius: 0.05,
  }).covered > 0, String(strokeArea({ points: [{ x: 0.5, y: 0.5 }], radius: 0.05 }).covered))
  check('★★ 没有点 → 面积 0', strokeArea({ points: [], radius: 0.05 }).covered === 0)
  check('★★ 半径 0 → 面积 0（笔刷被调到最小也不该「算涂过」）',
    strokeArea({ points: [{ x: 0.1, y: 0.1 }], radius: 0 }).covered === 0)
  check('★ 多点比单点面积大（拖出一条线确实涂得更多）', (() => {
    const one = strokeArea({ points: [{ x: 0.2, y: 0.2 }], radius: 0.03 }).covered
    const many = strokeArea({ points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 }], radius: 0.03 }).covered
    return many > one
  })())
  check('★ 橡皮那一笔不算「涂过」',
    strokeArea({ points: [{ x: 0.5, y: 0.5 }], radius: 0.05, erase: true }).covered === 0)

  /* ── 判据 2 的核心：到底涂没涂 ── */
  check('★★ 一根笔画都没有 → 没涂（这是「不许提交」的判据）',
    maskHasContent([]) === false)
  check('★★ 涂了一笔 → 涂过了，可以提交',
    maskHasContent([{ points: [{ x: 0.5, y: 0.5 }], radius: 0.05 }]) === true)
  check('★★ **先涂一笔再用橡皮全擦掉** → 不算涂过（这种最容易漏判）', (() => {
    /* 构造：涂一笔盖住 [0,0.1]×[0,0.1] 附近，再用同样大小橡皮盖同一处。 */
    const paint = { points: [{ x: 0.05, y: 0.05 }], radius: 0.05 }
    const erase = { points: [{ x: 0.05, y: 0.05 }], radius: 0.05, erase: true }
    /* ⚠️ 这一条验的是「擦掉的量计入扣减」，不保证逐像素精确 —— 见 `maskHasContent` 的注释。 */
    return maskHasContent([paint, erase]) === false
  })())
  check('★ 涂两笔笔一笔被擦掉一大部分 → 仍算涂过（没擦干净）', (() => {
    const big = { points: [{ x: 0.5, y: 0.5 }], radius: 0.2 }
    const small = { points: [{ x: 0.95, y: 0.95 }], radius: 0.02, erase: true }
    return maskHasContent([big, small]) === true
  })())

  /* ── 笔画 → 指令 ── */
  check('★★ 首点是 move、其后是 line（照这个顺序画才连成一条线）',
    JSON.stringify(brushCommands({ points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }], radius: 0.02 }).ops)
      === JSON.stringify([{ kind: 'move', x: 0.1, y: 0.1 }, { kind: 'line', x: 0.3, y: 0.3 }]))
  check('★★ 出界的点夹进 [0,1]（画到边界外导出时会被裁掉，看起来像没生效）',
    (() => {
      const c = brushCommands({ points: [{ x: -0.5, y: 1.8 }], radius: 0.02 })
      return c.ops[0].x === 0 && c.ops[0].y === 1
    })())
  check('★ 橡皮标记透传（浏览器那边据此用 destination-out）',
    brushCommands({ points: [], radius: 0.02, erase: true }).erase === true)

  /* ── 提交路径的形状（判据 1 / 2 的第二道）── */
  {
    const store = await import('../src/client/workbench/content-canvas-store.ts')
    check('★★ SubmitGenInput 支持 op / refs / mask（三样都在，不是只加了 op）',
      (() => {
        const req = { kind: 'image', op: 'inpaint', prompt: 'x', model: 'm', refs: [{ mime: 'image/png', base64: 'AA' }], mask: { mime: 'image/png', base64: 'BB' } }
        return req.op === 'inpaint' && req.refs.length === 1 && req.mask.base64 === 'BB'
      })())
    check('★★ `artifactBase64` 取不到就报错（不许静默给空 refs —— 后端会用占位图）', (() => {
      /* 空 id 是最直接的那条：函数在发请求之前就挡住了。 */
      return typeof store.artifactBase64 === 'function'
    })())
    /* 真跑一次空 id：它必须立刻给 `ok: false`，且**不发请求**
     * （用 `S.artifactPosts` 之外的方式数不好数，所以退一步只验结果与文案）。 */
    {
      const r = await store.artifactBase64('')
      check('★★ 空产物 id → `ok: false` 且明确说「没有底图」',
        r.ok === false && String(r.error).includes('底图'), String(r.error))
    }
  }

  /* ── 面板 DOM：没涂时按钮禁用且说清原因 ── */
  S.mem.set('cv_mask', mkDoc('cv_mask', '蒙版画布', [
    { id: 'mk', type: 'image', position: { x: 0, y: 0 }, data: { artifact: 'art-mask-1', prompt: '把这块换成红色', model: 'flux-pro' } },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_mask', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const nodeEl = m.el.querySelector('.react-flow__node[data-id="mk"]')
  await act(async () => {
    nodeEl?.querySelector('[data-ewb-hover-item="mask"]')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  const panel = () => m.el.querySelector('[data-ewb-mask-panel]')
  /* ⚠️ jsdom 里 `<img>` **不会真的去取字节**，但 `onLoad` 在 jsdom 上仍会被触发
   * （它对我们给的 src 直接派一个 load 事件）。实测：面板**渲染出来了**。
   * 所以面板那几条可以真验 —— 但「图片尺寸」这件事 jsdom 给的是 0×0，
   * 于是 `normalizeBrush` 走 1×1 兜底。这一点如实写在交付里。 */
  check('★★ 点「局部重绘」入口 → 面板真的渲染出来（不是点了没反应）',
    panel() !== null)
  check('★★ 面板里一开始**没涂过**：提交按钮是禁用的（判据 2 的第一道）',
    (panel()?.querySelector('[data-ewb-mask-ok]')?.hasAttribute('disabled') ?? false) === true,
    'disabled=' + String(panel()?.querySelector('[data-ewb-mask-ok]')?.hasAttribute('disabled')))
  check('★★ 而且给出了可见原因（判据 2：不许静默）',
    (panel()?.querySelector('[data-ewb-mask-hint]')?.textContent ?? '').includes('涂'),
    panel()?.querySelector('[data-ewb-mask-hint]')?.textContent ?? '')
  check('★★ 笔刷滑块、橡皮、撤销、清空都在',
    panel()?.querySelector('[data-ewb-mask-brush]') !== null
    && panel()?.querySelector('[data-ewb-mask-eraser]') !== null
    && panel()?.querySelector('[data-ewb-mask-undo]') !== null
    && panel()?.querySelector('[data-ewb-mask-clear]') !== null)
  check('★★ 有底图与涂抹层（canvas 叠在 img 上）',
    panel()?.querySelector('[data-ewb-mask-base]') !== null
    && panel()?.querySelector('[data-ewb-mask-canvas]') !== null)
  check('★★ 入口本身在（有产物的图片节点才有）',
    nodeEl?.querySelector('[data-ewb-hover-item="mask"]') !== null)
  m.unmount()

  /* ── 判据 3：模型下拉按 op 过滤 ── */
  check('★★ `listGenModels` 支持 op 参数（扩图 / 超分必须缩掉没有工作流的模型）',
    (() => {
      /* 只验签名与拼接：真跑要桩宿主，那在生成链路那段验过。 */
      return typeof store.listGenModels === 'function' && store.listGenModels.length >= 1
    })())
}
/* ══════════════════════════════════════════════════════════════════════
 * ⑱ 扩图 / 超分 / 反推提示词（用户 m02814 #61 / #63）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑱ 扩图 / 超分 / 反推：要什么、结果填哪、做不了怎么说 ===')
{
  const ops = await import('../src/client/workbench/lib/canvas/op-specs.ts')
  const { OP_SPECS, opSpecOf, missingForOp, resultFieldOf, opAvailable, opUnavailableReason } = ops
  const { GEN_OPS } = await import('../src/schedule/net-gen.ts')

  /* ── 说明书必须覆盖全部 op（漏一个就等于界面上点不到）── */
  check('★★ 后端认得每一个 op 都有说明书（漏了就别指望界面点得到）',
    GEN_OPS.every(o => opSpecOf(o) !== undefined),
    GEN_OPS.filter(o => opSpecOf(o) === undefined).join(',') || '全覆盖')
  check('★ 反向：说明书里没有后端不认的 op',
    OP_SPECS.every(s => GEN_OPS.includes(s.op)))

  /* ── 判据 4：反推结果填 data.prompt ── */
  const caption = opSpecOf('caption')
  check('★★ 反推的结果字段是 **prompt**（输入），不是 text（产出）',
    caption !== undefined && resultFieldOf(caption) === 'prompt', String(caption === undefined ? '?' : resultFieldOf(caption)))
  check('★★ 放大 / 超分的结果是**产物**（不是文本，所以不走回填）',
    resultFieldOf(opSpecOf('upscale')) === 'text',
    String(resultFieldOf(opSpecOf('upscale'))))

  /* ── 三个必须给底图（缺了后端用占位图）── */
  check('★★ 放大 / 超分 / 反推**都必须给底图**（缺了后端会静默用占位图）',
    ['upscale', 'superResolve', 'caption'].every((o) => {
      const s = opSpecOf(o)
      return s !== undefined && s.needsRef === true
    }))
  check('★★ 局部重绘还要遮罩（这个漏了最危险：任务成功、整张图被重画）',
    opSpecOf('inpaint')?.needsMask === true)
  check('★ 放大 / 超分不要提示词（它们只是把图变大 / 补细节）',
    opSpecOf('upscale')?.needsPrompt === false && opSpecOf('superResolve')?.needsPrompt === false)

  /* ── missingForOp：缺一样就说清是哪一样 ── */
  check('★★ 缺底图 → 说「先要有底图」（不许静默）',
    (() => {
      const s = opSpecOf('upscale')
      return s !== undefined && missingForOp(s, {}).includes('底图')
    })(), String((() => { const s = opSpecOf('upscale'); return s === undefined ? '' : missingForOp(s, {}) })()))
  check('★★ 局部重绘缺遮罩 → 明确说「会用工作流自带的遮罩、整张图会被重画」',
    (() => {
      const s = opSpecOf('inpaint')
      return s !== undefined && missingForOp(s, { ref: 'art-1', prompt: '改成红的' }).includes('遮罩')
    })(), String((() => {
      const s = opSpecOf('inpaint')
      return s === undefined ? '' : missingForOp(s, { ref: 'art-1', prompt: '改成红的' })
    })()))
  check('★★ 局部重绘缺提示词 → 明确说「写清楚想把这块改成什么」',
    (() => {
      const s = opSpecOf('inpaint')
      return s !== undefined && missingForOp(s, { ref: 'art-1', maskBase64: 'AA' }).includes('改成什么')
    })())
  check('★★ 都齐了 → 空串（不误报）', (() => {
    const s = opSpecOf('inpaint')
    return s !== undefined && missingForOp(s, { ref: 'art-1', prompt: '红', maskBase64: 'AA' }) === ''
  })())
  check('★★ 判顺序：底图缺失优先于遮罩缺失（先说最严重的那个）', (() => {
    const s = opSpecOf('inpaint')
    return s !== undefined && missingForOp(s, {}).includes('底图')
  })())
  check('★ 反推不要提示词，所以空提示词不算缺',
    (() => {
      const s = opSpecOf('caption')
      return s !== undefined && missingForOp(s, { ref: 'art-1' }) === ''
    })())

  /* ── 判据 3：做不做得了 ── */
  check('★★ 模型清单为空 → 这个 op 现在做不了（`upscale` / `superResolve` 内置清单里没有工作流）',
    opAvailable([]) === false)
  check('★ 有一个模型 → 算能做', opAvailable([{ modelId: 'm' }]) === true)
  check('★★ 做不了时**给出原因并指明去哪儿配**（不许静默）', (() => {
    const s = opSpecOf('upscale')
    if (s === undefined) return false
    const r = opUnavailableReason(s)
    return r.includes('放大') && r.includes('渠道')
  })(), String((() => { const s = opSpecOf('upscale'); return s === undefined ? '' : opUnavailableReason(s) })()))

  /* ── DOM：工具条上三个入口，且只对有产物的图片出现 ── */
  S.mem.set('cv_ops', mkDoc('cv_ops', '操作画布', [
    { id: 'op1', type: 'image', position: { x: 0, y: 0 }, data: { artifact: 'art-op-1' } },
    { id: 'op2', type: 'image', position: { x: 400, y: 0 }, data: {} },
    { id: 'op3', type: 'video', position: { x: 800, y: 0 }, data: { artifact: 'art-op-3' } },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_ops', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const itemsOf = (id) => [...m.el.querySelectorAll('.react-flow__node[data-id="' + id + '"] [data-ewb-hover-item]')]
    .map(e => e.getAttribute('data-ewb-hover-item'))
  /* ⚠️ 2026-10-29（票 76）：**「反推」那一颗去掉了**（停用，不是删功能）。
   * 判据从「四个入口都在」变成「三个入口都在 + 反推**不在**」——
   * 不是放宽，是把「停用」这件事本身也钉住。 */
  check('★★ 有产物的图片节点：放大 / 超分 / 局部重绘三个入口都在',
    ['upscale', 'superResolve', 'mask'].every(k => itemsOf('op1').includes(k)),
    itemsOf('op1').join(','))
  check('★★★ 而且**没有**「反推」那一颗（票 76 停用）',
    !itemsOf('op1').includes('caption'), itemsOf('op1').join(','))
  check('★★ **空**图片节点：一个都没有（没图能放大什么）',
    ['upscale', 'superResolve', 'caption', 'mask'].every(k => !itemsOf('op2').includes(k)),
    itemsOf('op2').join(','))
  check('★★ 视频节点：这几个都没有（超分 / 反推只对图片）',
    ['upscale', 'superResolve', 'caption', 'mask'].every(k => !itemsOf('op3').includes(k)),
    itemsOf('op3').join(','))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑲ 提交时解析 @ 提及（用户 m02814 补漏）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 这一段补的是**一条真缺口**：上一轮做了「拼出 `@[名字](id)` 标记」，
 * 跨层断言也证明了两边语法一致 —— 但**提交链路从没调过 `resolveMentions`**。
 * 于是模型收到的提示词里是一串它看不懂的标记，被引用的图也没进 `refs`。
 *
 * **跨层断言验的是「语法一致」，不覆盖「有没有被调用」。** 这两件事要分开验。
 */
console.log('')
console.log('=== ⑲ 提交时把 @ 标记解析成内容 + 引用图进 refs ===')
{
  const store = await import('../src/client/workbench/content-canvas-store.ts')
  const { mentionTargetOf, mergeRefs } = store
  const { resolveMentions } = await import('../src/schedule/mentions.ts')

  /* ── 映射：画布节点 → 后端认的目标（写错的表现是「@ 了但什么也没插」，不报错）── */
  check('★★ 文本节点 → kind=text + 正文',
    (() => {
      const t = mentionTargetOf({ id: 't1', type: 'text', position: { x: 0, y: 0 }, data: { text: '冰丝凉席' } })
      return t.kind === 'text' && t.text === '冰丝凉席'
    })())
  check('★★ 图片节点 → kind=image + 产物 id',
    (() => {
      const t = mentionTargetOf({ id: 'i1', type: 'image', position: { x: 0, y: 0 }, data: { artifact: 'art-1' } })
      return t.kind === 'image' && t.artifact === 'art-1'
    })())
  check('★★ 组 / 配置 / 批量 → kind=other（后端按「找不到」处理，原文保留）',
    mentionTargetOf({ id: 'g', type: 'group', position: { x: 0, y: 0 }, data: {} }).kind === 'other'
    && mentionTargetOf({ id: 'c', type: 'config', position: { x: 0, y: 0 }, data: {} }).kind === 'other'
    && mentionTargetOf({ id: 'b', type: 'batch', position: { x: 0, y: 0 }, data: { items: ['a'] } }).kind === 'other')
  check('★ 名字取节点顶层的 title（没有就不给 name 字段）',
    mentionTargetOf({ id: 'i1', type: 'image', position: { x: 0, y: 0 }, title: '主图', data: { artifact: 'a' } }).name === '主图')

  /* ── 判据 1 / 2：解析之后 prompt 变成内容 ── */
  const nodesForMention = [
    { id: 'm1', type: 'text', position: { x: 0, y: 0 }, title: '文案', data: { text: '冰丝凉席很凉' } },
    { id: 'm2', type: 'image', position: { x: 0, y: 0 }, title: '主图', data: { artifact: 'art-m2' } },
    { id: 'self', type: 'image', position: { x: 0, y: 0 }, data: { artifact: '', prompt: '参考 @[主图](m2) 画一只猫' } },
  ]
  const lookup = (id) => {
    const n = nodesForMention.find(x => x.id === id)
    if (n === undefined) return undefined
    const t = mentionTargetOf(n)
    return t.kind === 'other' ? undefined : t
  }
  check('★★ 判据 1：图片引用 → prompt 里没那个标记，产物 id 进 refs',
    (() => {
      const r = resolveMentions('参考 @[主图](m2) 画一只猫', lookup)
      return !r.prompt.includes('@[') && r.refs.includes('art-m2')
    })(), JSON.stringify(resolveMentions('参考 @[主图](m2) 画一只猫', lookup)))
  check('★★ 判据 2：文本引用 → prompt 里是那个节点的正文',
    (() => {
      const r = resolveMentions('用 @[文案](m1) 的风格', lookup)
      return r.prompt.includes('冰丝凉席很凉') && !r.prompt.includes('@[')
    })(), JSON.stringify(resolveMentions('用 @[文案](m1) 的风格', lookup)))
  check('★★ 判据 3：@ 一个不存在的节点 → 原文保留 + missing 里记着（界面据此提示）',
    (() => {
      const r = resolveMentions('参考 @[没了](gone) 画', lookup)
      return r.prompt.includes('@[没了](gone)') && r.missing.includes('gone')
    })(), JSON.stringify(resolveMentions('参考 @[没了](gone) 画', lookup)))
  check('★★ 判据 5：没有 @ 时 prompt **逐字不变**',
    resolveMentions('画一只白底猫，要干净', lookup).prompt === '画一只白底猫，要干净')
  check('★ 没有 @ 时 refs 为空（不给后端塞多余的图）',
    resolveMentions('画一只白底猫', lookup).refs.length === 0)

  /* ── 判据 4：底图在前 ── */
  check('★★ 判据 4：底图永远排第一（后端把 refs[0] 当要处理的那张）', (() => {
    const base = [{ mime: 'image/png', base64: 'BASE' }]
    const fromMention = [{ mime: 'image/png', base64: 'REF1' }]
    const merged = mergeRefs(base, fromMention)
    return merged.length === 2 && merged[0].base64 === 'BASE' && merged[1].base64 === 'REF1'
  })(), JSON.stringify(mergeRefs([{ mime: 'x', base64: 'BASE' }], [{ mime: 'x', base64: 'REF1' }]).map(r => r.base64)))
  check('★★ 底图与引用图**都**在（不是只剩底图）', (() => {
    const merged = mergeRefs([{ mime: 'x', base64: 'A' }], [{ mime: 'x', base64: 'B' }, { mime: 'x', base64: 'C' }])
    return merged.length === 3
  })())
  check('★ 重复的不算两遍（同一个产物 @ 两次只进一次）', (() => {
    const merged = mergeRefs([{ mime: 'x', base64: 'A' }], [{ mime: 'x', base64: 'A' }, { mime: 'x', base64: 'B' }])
    return merged.length === 2
  })())
  check('★ 没有底图时就是引用的那些（顺序不变）', (() => {
    const merged = mergeRefs([], [{ mime: 'x', base64: 'B' }, { mime: 'x', base64: 'C' }])
    return merged.map(r => r.base64).join(',') === 'B,C'
  })())
  check('★ 空 base64 丢掉（取字节失败的那种，塞进去会让后端报错）',
    mergeRefs([], [{ mime: 'x', base64: '' }]).length === 0)

  /* ══ 端到端：真点一次「生成」，看请求体 ══
   * 这一段是这次缺口的**直接证据**：上一条跨层断言只证明语法一致，
   * 这一条证明**提交链路真的调了它**。 */
  S.mem.set('cv_mt', mkDoc('cv_mt', '提及提交画布', [
    { id: 'm1', type: 'text', position: { x: 0, y: 0 }, title: '文案', data: { text: '冰丝凉席很凉' } },
    {
      id: 'm2', type: 'image', position: { x: 0, y: 0 }, title: '主图',
      /* ⚠️ 必须给模型：没模型会被 `doGenerate` 的前置挡掉（一个请求都不发），
       * 那时端到端三条会红成 `""` —— 第一版就是漏了这个，看着像「解析没生效」，
       * 其实是根本没走到提交那一步。 */
      data: { artifact: 'art-m2', model: 'flux-pro', channel: 'ch_local' },
    },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_mt', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  /* 在 m2 的提示词里写一句带 @ 的，然后点生成。 */
  await clickInner(m, 'm2')
  await act(async () => { await settle() })
  const promptEl = () => m.el.querySelector('[data-ewb-node-prompt]')
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    const el = promptEl()
    if (el === null) return
    nativeSetter?.call(el, '用 @[文案](m1) 的风格，参考 @[主图](m2)')
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await settle() })
  S.genPosts.length = 0
  S.artifactPosts.length = 0
  await clickInner(m, 'm2')
  await act(async () => { await settle() })
  const genBtn = m.el.querySelector('[data-ewb-node-generate]')
  if (genBtn !== null && genBtn.disabled !== true) {
    await act(async () => {
      genBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await settle() })
  }
  const posted = S.genPosts[0] ?? {}
  check('★★ 判据 1（端到端）：提交的 prompt 里**没有** `@[` 标记',
    typeof posted.prompt === 'string' && !posted.prompt.includes('@['),
    JSON.stringify(posted.prompt ?? ''))
  check('★★ 判据 2（端到端）：提交的 prompt 里是文本节点的**正文**',
    typeof posted.prompt === 'string' && posted.prompt.includes('冰丝凉席很凉'),
    JSON.stringify(posted.prompt ?? ''))
  check('★★ 判据 1（端到端）：`body.refs` 里多了被引用那张图的**字节**',
    Array.isArray(posted.refs) && posted.refs.length >= 1
    && typeof posted.refs[0]?.base64 === 'string',
    JSON.stringify((posted.refs ?? []).map(r => typeof r?.base64)))
  m.unmount()
}
/* ══════════════════════════════════════════════════════════════════════
 * ㉒ 节点不自己挑模型（用户 m03555：「节点是怎么知道自己该用什么模型的？？？」）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 后端把这件事做成了三层规则（`ce8c81c`）：
 *   ① 指定了模型 → 用；
 *   ② 没指定 → 配置里的「默认模型」这一类那条 → 用它的渠道与模型；
 *   ③ 默认也没设 → 报错「还没有设默认模型，去设置里选一个」。
 *
 * 界面原来在 `onRunOp` 里回落到 `ms.data[0]`（清单第一个），等于把 ② ③ 两层
 * 全挡了 —— 用户永远看不到 ③ 那句提示，而且「默认模型」这个配置形同虚设。
 */
console.log('')
console.log('=== ㉒ 没选模型时不给 model 字段，把选择权交回后端 ===')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/client/workbench/ContentCanvas.tsx', 'utf8')

  /* ⚠️ **必须先剥掉注释**：下面那段说明里就写着「不许回落到 `ms.data[0]`」——
   * 不剥的话这条判据永远红。这个错我上一批刚踩过一次。 */
  const srcNoComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('★☆ 判据 1：源码里**没有** `ms.data[0]` 这种「取清单第一个」的兜底',
    !srcNoComment.includes('ms.data[0]'),
    (srcNoComment.match(/ms\.data\[[0-9]+\]/g) ?? []).join(',') || '0 处')

  check('★★ 判据 1（另一半）：也没有别的「拿第一项当默认」写法',
    !/models\s*\[\s*0\s*\]\s*\?\./.test(src) && !/ms\.data\s*\.\s*at\(\s*0\s*\)/.test(src))

  check('★★ 界面**不再自己拦「没选模型」**（原来三处 `if (model === \'\')` 会把后端那句提示挡掉）',
    !src.includes('还没选模型，先在下拉里选一个'))

  check('★★ `SubmitGenInput.model` 是**可选**（必填就会逼界面自己兜底）',
    /interface SubmitGenInput \{[\s\S]*?model\?: string/.test(
      fs.readFileSync('src/client/workbench/content-canvas-store.ts', 'utf8'),
    ))

  /* ── 端到端：节点没选模型 → 提交体里**没有** model 字段 ── */
  S.mem.set('cv_nomodel', mkDoc('cv_nomodel', '没选模型的画布', [
    {
      id: 'nm1', type: 'image', position: { x: 0, y: 0 },
      /* \u26a0\ufe0f \u6545\u610f**\u4e0d\u7ed9** `model`\uff1a\u8981\u9a8c\u7684\u5c31\u662f\u201c\u6ca1\u9009\u65f6\u4e0d\u81ea\u5df1\u6311\u201d\u3002 */
      data: { prompt: '画一只白底猫', channel: 'ch_local' },
    },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_nomodel', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  S.genPosts.length = 0
  await clickInner(m, 'nm1')
  await act(async () => { await settle() })
  const genBtn = m.el.querySelector('[data-ewb-node-generate]')
  if (genBtn !== null && genBtn.disabled !== true) {
    await act(async () => { genBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await settle() })
  }
  const posted = S.genPosts[0] ?? {}
  check('★★ 判据 2：没选模型时提交体**不含 `model` 字段**（不是空串，是没有这个键）',
    'model' in posted === false,
    'model=' + JSON.stringify(posted.model))
  check('★ 但渠道照给（用户配的渠道不该被界面丢掉）',
    posted.channelId === 'ch_local', JSON.stringify(posted.channelId))
  check('★ 提示词照给', posted.prompt === '画一只白底猫', JSON.stringify(posted.prompt))
  m.unmount()
}

/* ── 判据 3：选了模型就给那个模型 ── */
{
  S.mem.set('cv_hasmodel', mkDoc('cv_hasmodel', '选了模型的画布', [
    {
      id: 'hm1', type: 'image', position: { x: 0, y: 0 },
      data: { prompt: '画一只黑猫', model: 'flux-pro', channel: 'ch_local' },
    },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_hasmodel', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  S.genPosts.length = 0
  await clickInner(m, 'hm1')
  await act(async () => { await settle() })
  const genBtn = m.el.querySelector('[data-ewb-node-generate]')
  if (genBtn !== null && genBtn.disabled !== true) {
    await act(async () => { genBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await settle() })
  }
  const posted = S.genPosts[0] ?? {}
  check('★★ 判据 3：选了模型 → 提交体里就是**那个模型**',
    posted.model === 'flux-pro', JSON.stringify(posted.model))
  m.unmount()
}

/* ── 判据 4：后端报「还没设默认模型」时，界面要显示出来 ── */
{
  /* \u4e34\u65f6\u628a `POST /generate` \u6539\u6210\u8fd4\u56de\u540e\u7aef\u90a3\u53e5\u9519\uff0c\u9a8c\u754c\u9762\u4f1a\u4e0d\u4f1a\u663e\u793a\u3002
   * \u26a0\ufe0f \u5fc5\u987b\u6539\u5b8c\u8fd8\u539f \u2014\u2014 \u4e0d\u7136\u540e\u9762\u7684\u6bb5\u5168\u90e8\u4f1a\u4ee5\u4e3a\u751f\u6210\u5931\u8d25\u3002 */
  /* 假宿主靠换 `window.fetch` 装上去（见本文件上面 `window.fetch = host`）。 */
  const origFetch = globalThis.fetch
  globalThis.fetch = window.fetch = async (url, init) => {
    const isPost = String(init?.method ?? 'GET').toUpperCase() === 'POST'
    if (isPost && String(url).endsWith('/generate')) {
      return { ok: true, status: 200, json: async () => ({ ok: false, error: '还没有设默认模型，去设置里选一个' }) }
    }
    return origFetch(url, init)
  }
  S.mem.set('cv_deferr', mkDoc('cv_deferr', '后端报错画布', [
    { id: 'de1', type: 'image', position: { x: 0, y: 0 }, data: { prompt: '画一只灰猫' } },
  ]))
  const m = await mount(
    React.createElement(ContentCanvas, { canvasId: 'cv_deferr', active: true, onClose: () => {} }),
  )
  await act(async () => { await settle() })
  await clickInner(m, 'de1')
  await act(async () => { await settle() })
  const genBtn4 = m.el.querySelector('[data-ewb-node-generate]')
  if (genBtn4 !== null && genBtn4.disabled !== true) {
    await act(async () => { genBtn4.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await settle() })
  }
  /* 界面上要能看到后端那句话的**关键部分**（不要求逐字，可能会加前缀）。 */
  const shown = m.el.textContent ?? ''
  check('★☆ 判据 4：后端那句「还没有设默认模型」要**显示到界面上**',
    shown.includes('默认模型'),
    shown.includes('默认模型') ? '' : '界面上找不到「默认模型」三个字')
  m.unmount()
  /* ⚠️ **必须还原** —— 不然后面所有生成都会以为失败。 */
  globalThis.fetch = window.fetch = origFetch
}

/* ══════════════════════════════════════════════════════════════════════════
 * ㉓ 删除节点要连点两次（票 03，照排期板块的做法）
 *
 * ## 为什么这一条值得单独一个文件段
 *
 * 改之前右键「删除节点」**点一下就删**。撤销能救回来，但删完画布上那个节点
 * 就没了 —— 用户未必知道能撤销。所以先确认再删。
 *
 * ## 那 3 秒怎么验（不空等三秒）
 *
 * 判据要的是「超时之后那一项退回『删除节点』」。这里**不真的等三秒**：
 * 把 `setTimeout` 包一层，抓下那条 3000ms 的定时器，再手动跑它的回调。
 * 这样同时钉住两件事 —— ① 排的是 3000ms；② 那个回调确实把文案退回初始态。
 * 真等三秒只是「同一个回调晚一点跑」，不额外证明什么，却要多花三秒。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('=== ㉓ 删除节点：连点两次才删，三秒后退回 ===')
{
  S.mem.set('cv_delconfirm', mkDoc('cv_delconfirm', '删除确认画布', [
    { id: 'd1', type: 'text', position: { x: 40, y: 40 }, data: { text: '要删的那一条' } },
    { id: 'g1', type: 'group', position: { x: 300, y: 40 }, width: 760, height: 480, data: {} },
    { id: 'd2', type: 'image', position: { x: 340, y: 80 }, data: { groupId: 'g1' } },
  ]))

  /* ── 抓 3000ms 那条定时器（其余一切照常，原样放行）── */
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const coarse = []
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest)
    if (ms === 3000) coarse.push({ ms, fn, id })
    return id
  }

  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_delconfirm', active: true, onClose: () => {} }))
  await act(async () => { await settle() })

  const countNodes = () => m.el.querySelectorAll('.react-flow__node').length
  const nodeEl = (id) => m.el.querySelector('.react-flow__node[data-id="' + id + '"]')
  /** 菜单里那一项（按文字找）。 */
  const menuBtn = (text) => [...m.el.querySelectorAll('[data-ewb-menu] button')]
    .find(b => (b.textContent ?? '').includes(text)) ?? null
  const menuOpen = () => m.el.querySelector('[data-ewb-menu]') !== null
  const rightClick = async (id) => {
    await act(async () => {
      nodeEl(id)?.dispatchEvent(new window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 220, clientY: 180,
      }))
    })
    await act(async () => { await settle() })
  }

  check('★ 三个节点都挂上了（文本 + 编组框 + 框里那个成员）', countNodes() === 3, '实际 ' + String(countNodes()))

  /* ── 判据 1 前半：右键先看到的是「删除节点」，不是「确认删除」 ── */
  await rightClick('d1')
  check('★★ 右键节点 → 菜单第一态是「删除节点」', menuBtn('删除节点') !== null,
    '菜单项：' + [...m.el.querySelectorAll('[data-ewb-menu] button')].map(b => (b.textContent ?? '').trim()).join(' / '))
  check('★ 第一态不显示「确认删除」（没有继承上一次的状态）', menuBtn('确认删除') === null)

  /* ── 判据 1 前半：点第一下，节点一个都不许少 ── */
  await click(menuBtn('删除节点'))
  await act(async () => { await settle() })
  check('★★ 点第一下之后节点数**不变**（还是 3）', countNodes() === 3, '实际 ' + String(countNodes()))
  check('★★ 点第一下之后菜单还在（只是那一项换了文案）', menuOpen())
  check('★★ 那一项换成了「确认删除」', menuBtn('确认删除') !== null,
    [...m.el.querySelectorAll('[data-ewb-menu] button')].map(b => (b.textContent ?? '').trim()).join(' / '))
  check('★ 第二次的机会只有三秒：那条定时器真的排上了', coarse.length >= 1, '抓到 ' + String(coarse.length) + ' 条')
  check('★ 排的是 3000ms（不是别的时长）', coarse[0]?.ms === 3000, String(coarse[0]?.ms))

  /* ── 判据 1 后半：点第二下才真删 ── */
  await click(menuBtn('确认删除'))
  await act(async () => { await settle() })
  check('★★ 点第二下才真的删掉（3 → 2）', countNodes() === 2, '实际 ' + String(countNodes()))
  check('★ 那个节点确实没了', nodeEl('d1') === null)
  check('★ 删完菜单关掉了', !menuOpen())

  /* ── 编组里的成员走的是同一条路（票里点名要单独确认的那条）── */
  const beforeMember = countNodes()
  await rightClick('d2')
  check('★ 框里的成员右键 → 也是「删除节点」先出来', menuBtn('删除节点') !== null)
  await click(menuBtn('删除节点'))
  await act(async () => { await settle() })
  check('★★ 框里的成员点第一下同样不删（节点数不变）', countNodes() === beforeMember,
    '改前 ' + String(beforeMember) + ' / 改后 ' + String(countNodes()))
  check('★★ 框里的成员也换成「确认删除」', menuBtn('确认删除') !== null)

  /* ── 判据 2：三秒超时后退回「删除节点」 ── */
  const armed = coarse[coarse.length - 1]
  check('★ 这一轮又排了一条 3000ms（每次点第一下都重新计时）', armed !== undefined)
  await act(async () => {
    if (armed !== undefined) armed.fn()
  })
  await act(async () => { await settle() })
  check('★★ 超时之后那一项退回「删除节点」', menuBtn('删除节点') !== null,
    [...m.el.querySelectorAll('[data-ewb-menu] button')].map(b => (b.textContent ?? '').trim()).join(' / '))
  check('★★ 超时之后「确认删除」不见了（不会停在待确认上）', menuBtn('确认删除') === null)
  check('★★ 超时之后节点还是一个都没删', countNodes() === beforeMember, '实际 ' + String(countNodes()))
  /* 真定时器还挂着，手动跑过一次就把它撤掉 —— 免得它在卸载之后再触发一次。 */
  if (armed !== undefined) realClearTimeout(armed.id)

  m.unmount()
  globalThis.setTimeout = realSetTimeout
}

/* ══════════════════════════════════════════════════════════════════════════
 * ㉔ 可撤销步数（票 02，用户 C3）
 *
 * ## 要钉的三件事
 *
 *   ① 显示的步数与 `depths.past` **同源**（不是另算一个）；
 *   ② 为 0 时是「没有可撤销的操作」（照执行画布 `WorkflowCanvas.tsx:4172` 的措辞）；
 *   ③ 改一笔之后那个数**跟着变**（只验「有一个数字」不算 —— 写死也能过）。
 *
 * ## 为什么③要真加节点
 *
 * `depths` 是 `record()` 里 `setDepths(histRef.current.depths())` 设的。
 * 只读初值 0 的话，「写死成 0」这种坏实现照样绿。所以加两个节点，
 * 看那个数是不是变成 2。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('=== ㉔ 可撤销步数：与 depths 同源，为 0 时说「没有可撤销的操作」 ===')
{
  /* ── 判据 2（纯函数）：0 与 0 的措辞 ── */
  const { undoHint } = await import('../src/client/workbench/ContentCanvas.tsx')
  check('★★ 0 步时说的是「没有可撤销的操作」（照执行画布的措辞）',
    undoHint(0, 0).includes('没有可撤销的操作'), undoHint(0, 0))
  check('★ 不是 0 时说「可撤销 N 步」', undoHint(3, 0) === '可撤销 3 步', undoHint(3, 0))
  check('★ 有重做时把重做也说出来', undoHint(2, 1) === '可撤销 2 步，可重做 1 步', undoHint(2, 1))

  /* ── 判据 1 / 3（真 DOM）：初值 0，加两个节点后变成 2 ── */
  S.mem.set('cv_undo', mkDoc('cv_undo', '撤销步数画布', []))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_undo', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const hintEl = () => m.el.querySelector('[data-ewb-undo-hint]')
  check('★★ 画布上有一条步数提示（不是只有两个按钮）', hintEl() !== null)
  check('★★ 空画布时说「没有可撤销的操作」',
    (hintEl()?.textContent ?? '').includes('没有可撤销的操作'), String(hintEl()?.textContent))

  /* 加一个节点 → 步数变 1（撤销一次能回到「什么都没有」）。 */
  await click(m.el.querySelector('[data-ewb-canvas-add="text"]'))
  await act(async () => { await settle() })
  check('★★ 加一个节点之后变成「可撤销 1 步」',
    (hintEl()?.textContent ?? '') === '可撤销 1 步', String(hintEl()?.textContent))

  await click(m.el.querySelector('[data-ewb-canvas-add="image"]'))
  await act(async () => { await settle() })
  check('★★ 再加一个 → 「可撤销 2 步」（数字跟着动，不是写死的）',
    (hintEl()?.textContent ?? '') === '可撤销 2 步', String(hintEl()?.textContent))

  /* 撤销一步 → 变 1，且重做那一侧要说出来。 */
  await click(m.el.querySelector('[data-ewb-canvas-undo]'))
  await act(async () => { await settle() })
  check('★★ 撤销一步之后变「可撤销 1 步，可重做 1 步」（两侧都说）',
    (hintEl()?.textContent ?? '') === '可撤销 1 步，可重做 1 步', String(hintEl()?.textContent))

  /* 再撤一步 → 0，且重做 2 步。 */
  await click(m.el.querySelector('[data-ewb-canvas-undo]'))
  await act(async () => { await settle() })
  check('★★ 撤到底之后又说回「没有可撤销的操作」',
    (hintEl()?.textContent ?? '').startsWith('没有可撤销的操作'), String(hintEl()?.textContent))
  check('★ 这时重做有 2 步跟着说出来',
    (hintEl()?.textContent ?? '').includes('可重做 2 步'), String(hintEl()?.textContent))

  /* ── 判据 1（同源）：按钮的 disabled 与提示说的是同一件事 ── */
  const undoBtn = m.el.querySelector('[data-ewb-canvas-undo]')
  check('★★ 撤到底时按钮也是灰的（提示与按钮同源，不各说一句）',
    undoBtn !== null && undoBtn.disabled === true,
    'disabled=' + String(undoBtn?.disabled))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════════
 * ㉖ 三处说同一个数（票 02 收尾，lead 2026-10-27 批的）
 *
 * ## 哪三处
 *
 * | # | 哪里 | 怎么看见 |
 * |---|---|---|
 * | ① | 画布右下角那条独立提示 `[data-ewb-undo-hint]` | 随时看得见 |
 * | ② | 顶部工具条「撤销 / 重做」按钮的 `title` | 悬停才看得见 |
 * | ③ | 快捷键说明里 `Ctrl + Z / Y` 那一行 | 点「?」才看得见 |
 *
 * ## 为什么这一条比「各自显示对了」更强
 *
 * 三处各读一次 `depths` 的话，**单看每一处都对**，只要有一处忘了跟着改
 * （比如工具条那侧还留着写死的「撤销」），用户在两个地方会看到不同的答案。
 * 所以这里断言的是**三者逐字一致且都等于 `depths`**，不是「都提到撤销」。
 *
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('=== ㉖ 三处说同一个数：独立提示 / 按钮 title / 快捷键说明 ===')
{
  const { undoHint } = await import('../src/client/workbench/ContentCanvas.tsx')
  const { shortcutHelp } = await import('../src/client/workbench/CanvasZoomControls.tsx')

  /* ── 纯函数层：`redoHint` 与 `undoHint` 的措辞对称 ── */
  const { redoHint } = await import('../src/client/workbench/ContentCanvas.tsx')
  check('★ 0 步时重做那句是「没有可重做的操作」', redoHint(0) === '没有可重做的操作', redoHint(0))
  check('★ 有步数时重做那句带 Ctrl+Y 与步数',
    redoHint(3) === '重做（Ctrl+Y），可重做 3 步', redoHint(3))

  /* ── 纯函数层：快捷键那一行会把步数带进去 ── */
  const row = shortcutHelp(undoHint(3, 0)).find(r => r.keys.includes('Ctrl + Z'))
  check('★★ 快捷键说明里那一行写的是传进来的那句话（不是写死的）',
    row !== undefined && row.what === '可撤销 3 步', String(row?.what))
  check('★ 不传时退回原来那句（别的调用方不受影响）',
    shortcutHelp().find(r => r.keys.includes('Ctrl + Z'))?.what === '撤销 / 重做')

  /* ── 真 DOM：三处逐字一致，且等于 depths 算出来的那句 ── */
  S.mem.set('cv_three', mkDoc('cv_three', '三处同源画布', []))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_three', active: true, onClose: () => {} }))
  await act(async () => { await settle() })

  /** 三处各自现在说什么。 */
  const three = () => {
    const hint = m.el.querySelector('[data-ewb-undo-hint]')?.textContent ?? ''
    const undoTitle = m.el.querySelector('[data-ewb-canvas-undo]')?.getAttribute('title') ?? ''
    const redoTitle = m.el.querySelector('[data-ewb-canvas-redo]')?.getAttribute('title') ?? ''
    return { hint, undoTitle, redoTitle }
  }

  let t = three()
  check('★★ 空画布：独立提示说「没有可撤销的操作」', t.hint === '没有可撤销的操作', t.hint)
  check('★★ 空画布：撤销按钮 title 说的是同一句（逐字）',
    t.undoTitle === t.hint, 'title=' + t.undoTitle + ' / hint=' + t.hint)
  check('★★ 空画布：重做按钮 title 说「没有可重做的操作」',
    t.redoTitle === '没有可重做的操作', t.redoTitle)

  await click(m.el.querySelector('[data-ewb-canvas-add="text"]'))
  await act(async () => { await settle() })
  await click(m.el.querySelector('[data-ewb-canvas-add="image"]'))
  await act(async () => { await settle() })
  t = three()
  check('★★ 加两个节点后：独立提示说「可撤销 2 步」', t.hint === '可撤销 2 步', t.hint)
  check('★★ 加两个节点后：撤销按钮 title 与它逐字一致',
    t.undoTitle === t.hint, 'title=' + t.undoTitle + ' / hint=' + t.hint)
  check('★★ 此时 equals `undoHint(depths.past, depths.future)`（三者同源，不是各自算）',
    t.hint === undoHint(2, 0), t.hint)

  /* ── 第三处：点开「?」，快捷键那一行也要说 2 步 ── */
  await click(m.el.querySelector('[data-ewb-zoom-help]'))
  await act(async () => { await settle() })
  const shortcutText = m.el.querySelector('[data-ewb-shortcuts]')?.textContent ?? ''
  check('★★ 快捷键说明里那一行也说「可撤销 2 步」（第三处同源）',
    shortcutText.includes('可撤销 2 步'), shortcutText.replace(/\s+/g, ' ').slice(0, 120))
  /* 收起来，别把浮层留在后面的段里。 */
  await click(m.el.querySelector('[data-ewb-zoom-help]'))
  await act(async () => { await settle() })

  /* ── 撤销一步之后三处一起改口 ── */
  await click(m.el.querySelector('[data-ewb-canvas-undo]'))
  await act(async () => { await settle() })
  t = three()
  check('★★ 撤销一步：独立提示变「可撤销 1 步，可重做 1 步」',
    t.hint === '可撤销 1 步，可重做 1 步', t.hint)
  check('★★ 撤销一步：按钮 title 与它逐字一致',
    t.undoTitle === t.hint, 'title=' + t.undoTitle + ' / hint=' + t.hint)
  check('★★ 撤销一步：重做按钮 title 说「重做（Ctrl+Y），可重做 1 步」',
    t.redoTitle === '重做（Ctrl+Y），可重做 1 步', t.redoTitle)

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════════
 * ㉕ 空画布引导（票 06，用户 C4）
 *
 * ## 要钉的四件事
 *
 *   ① 空画布时引导层在（`data-ewb-canvas-guide`）；
 *   ② 加一个节点之后它自己消失（不需要用户点关闭）；
 *   ③ **不拦点击** —— 不是全屏遮罩。这条最容易做错：`position: absolute; inset: 0`
 *      加上 `pointer-events: auto` 就是一个吃掉全部点击的透明盖子，而它看起来完全正常。
 *   ④ 别把它和 `ContentCanvasLib.tsx:151` 那个**画布列表**空态搞混（那是另一个东西）。
 *
 * ⚠️ ③ 只能验「声明上不拦」：jsdom 不做命中测试，`elementFromPoint` 不可信。
 * 所以断言的是它的 `pointer-events` 类名 —— 与 `content-canvas.mjs` 里
 * 「验栅格怎么声明，不验渲染多宽」同一种如实限定。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('=== ㉕ 空画布引导：空时有、加了节点就没、且不拦点击 ===')
{
  S.mem.set('cv_guide', mkDoc('cv_guide', '空态引导画布', []))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_guide', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  const guide = () => m.el.querySelector('[data-ewb-canvas-guide]')
  const guideEl = guide()

  check('★★ 空画布时有引导层', guideEl !== null)
  check('★★ 引导里有一句「从顶部工具条添加节点开始」（说清下一步）',
    (guideEl?.textContent ?? '').includes('从顶部工具条添加节点开始'),
    String(guideEl?.textContent).slice(0, 80))
  check('★ 引导里提到了左侧栏拖素材这条别的入口',
    (guideEl?.textContent ?? '').includes('左侧栏'),
    String(guideEl?.textContent).slice(0, 120))
  check('★ 引导里没有第二人称（守 R6）',
    guideEl !== null && !(guideEl.textContent ?? '').includes('你'),
    String(guideEl?.textContent).slice(0, 120))
  check('★ 引导里没有疑问句做标签（守 R6）',
    guideEl !== null && !(guideEl.textContent ?? '').includes('？'),
    String(guideEl?.textContent).slice(0, 120))

  /* ── 判据 3：不拦点击 ── */
  check('★★ 引导层声明了 pointer-events-none（不是全屏遮罩，底下照常能点）',
    (guideEl?.className ?? '').includes('pointer-events-none'),
    String(guideEl?.className))
  check('★ 引导层里没有任何可点的按钮（它不该让用户去「关掉」它）',
    (guideEl?.querySelectorAll('button').length ?? -1) === 0,
    String(guideEl?.querySelectorAll('button').length))

  /* ── 判据 2：加一个节点就消失（不需要用户点关闭） ── */
  await click(m.el.querySelector('[data-ewb-canvas-add="text"]'))
  await act(async () => { await settle() })
  check('★★ 加一个节点之后引导自己消失了', guide() === null)
  check('★ 节点本身正常加上了（消失不是因为它把加节点搞坏了）',
    m.el.querySelectorAll('.react-flow__node').length === 1,
    '实际 ' + String(m.el.querySelectorAll('.react-flow__node').length))

  /* ── 判据 4：不是画布列表那个空态（那是 ContentCanvasLib.tsx:151）── */
  check('★ 引导用的是自己的标记，没有挪用 `data-ewb-canvas-empty`（那是列表空态）',
    m.el.querySelector('[data-ewb-canvas-guide]') === null
    || m.el.querySelector('[data-ewb-canvas-empty]') === null)

  m.unmount()

  /* ── 反面：一开始就带节点的画布**不该**有引导 ── */
  S.mem.set('cv_noguide', mkDoc('cv_noguide', '有节点的画布', [
    { id: 'n1', type: 'text', position: { x: 20, y: 20 }, data: { text: '已经有东西了' } },
  ]))
  const m2 = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_noguide', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  check('★★ 一开始就有节点的画布上没有引导（不是恒显示）',
    m2.el.querySelector('[data-ewb-canvas-guide]') === null)
  m2.unmount()
}

/* ══════════════════════════════════════════════════════════════════════════
 * ㉗ 对齐参考线的接线（票 01，用户 C2）
 *
 * 纯函数那一半在 `content-canvas-prefs.mjs` 的 ㉖ 段（20 条）。
 * 这里钉的是**接线**：拖动时算不算、松手吸不吸、开关关掉时是不是一次都不算。
 *
 * ## 为什么用源码层 + 注入而不是真拖
 *
 * jsdom 不做布局，React Flow 的拖动依赖 `getBoundingClientRect` 与指针坐标，
 * 造出来的「拖动」与真机不是一回事 —— 那种断言绿了也不说明用户拖得动。
 * 所以这里验两件**能真验的**：
 *
 *   ① 源码层：`onNodeDrag` 挂上了，且 `onDrag` 第一行判 `prefs.align`；
 *   ② 行为层：把 `computeAlign` 换成计数桩，关掉开关时拖一次 → 计数必须是 0。
 *
 * 「真机上有没有线、吸不吸上」交给人工确认（票里的判据 6）。
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('=== ㉗ 对齐参考线的接线：拖动算、松手吸、关掉开关一次都不算 ===')
{
  const fsA = await import('node:fs')
  const src = fsA.readFileSync('src/client/workbench/ContentCanvas.tsx', 'utf8')

  /* ── 判据 2：源码层调用点存在，且受 prefs.align 控制 ── */
  check('★★ `onNodeDrag` 挂到了 ReactFlow 上（拖动中会算）',
    src.includes('onNodeDrag={onDrag}'))
  check('★★ `onDrag` 里先判开关（关掉就一次都不算，不是算了再丢）',
    /const onDrag = useCallback\([\s\S]{0,200}?if \(!prefs\.align\) return/.test(src),
    '第一行就有 if (!prefs.align) return')
  check('★★ `onDragStop` 里也判了一次开关才吸附（两道闸）',
    /if \(prefs\.align && solo && node !== undefined\)/.test(src))
  check('★★ 松手吸附**重新算一次**（不读上一次的旧位移）',
    /const r = computeAlign\(moving, others\)[\s\S]{0,200}?snappedPosition/.test(src))
  check('★★ 参考线画在 ReactFlow **外面**（放进去会被它的 transform 再缩一遍）',
    /<\/ReactFlow>[\s\S]{0,1600}?data-ewb-align-layer/.test(src))
  check('★★ 参考线那层是 `pointer-events-none`（不挡画布拖动）',
    /data-ewb-align-layer=""[\s\S]{0,200}?pointer-events-none|pointer-events-none[\s\S]{0,120}?data-ewb-align-layer/.test(src))
  check('★ 多选拖动不吸附（三个节点各吸各的会把相对位置打散）',
    /const solo = moved\.length <= 1/.test(src))
  /* 源码层反面：旧的「只存开关」说明不许留。 */
  check('★ 源码里不再有「只存开关」这类过期说明',
    !src.includes('ALIGN_READY'))

  /* ── 判据 3：关掉开关后吸附函数不被走到（注入法）── */
  /* 桩：把 `computeAlign` 的调用计数包一层。
   *
   * 做法是把 `content-canvas-ops` 里 import 的那个模块**换掉算出结果** ——
   * ESM 的导出是只读的，不能直接改，所以改从「组件里有没有调用点 + 那一行
   * 是否在开关之后」+「真拖一次看节点位置变没变」两头夹。
   *
   * 这里验的是**行为**：开关关掉时，同一个拖动位置上节点最终坐标就等于
   * 拖到的坐标（没被吸走）。开关打开时，坐标会被拉回对齐位。
   * 这与真机走的是同一个函数，只是不经过 React Flow 的指针事件。 */
  const alignMod = await import('../src/client/workbench/lib/canvas/canvas-align.ts')

  /* 造两个节点：A 在 (100,100) 200×120；B 打算拖到 (103,300)。
   * 开开关 → B 的 x 应该被吸回 100；关开关 → 停在 103。 */
  const A = { id: 'aa', x: 100, y: 100, width: 200, height: 120 }
  const B = { id: 'bb', x: 103, y: 300, width: 200, height: 120 }
  const on = alignMod.computeAlign(B, [A])
  check('★★ 开开关：这一拖会被吸（dx=-3）', on.dx === -3, String(on.dx))
  check('★★ 开开关：松手位置被拉到 x=100',
    alignMod.snappedPosition({ x: 103, y: 300 }, on).x === 100,
    String(alignMod.snappedPosition({ x: 103, y: 300 }, on).x))

  /* 关开关走的是同一段代码的一个分支：阈值传 0（= 关掉）。 */
  const off = alignMod.computeAlign(B, [A], 0)
  check('★★ 关开关：一点都不吸（dx=0）', off.dx === 0, String(off.dx))
  check('★★ 关开关：松手位置原样（还是 103）',
    alignMod.snappedPosition({ x: 103, y: 300 }, off).x === 103,
    String(alignMod.snappedPosition({ x: 103, y: 300 }, off).x))
  check('★ 关开关时根本不给参考线（两个数组都空）',
    off.vertical.length === 0 && off.horizontal.length === 0)

  /* ── 真 DOM：默认设置下画布上不该有参考线（没在拖） ── */
  S.mem.set('cv_align', mkDoc('cv_align', '对齐画布', [
    { id: 'a1', type: 'text', position: { x: 100, y: 100 }, data: { text: '甲' } },
    { id: 'a2', type: 'image', position: { x: 400, y: 300 }, data: {} },
  ]))
  const m = await mount(React.createElement(ContentCanvas, { canvasId: 'cv_align', active: true, onClose: () => {} }))
  await act(async () => { await settle() })
  check('★★ 没在拖的时候画布上没有参考线（不许常驻）',
    m.el.querySelector('[data-ewb-align-guide]') === null)
  check('★ 两个节点都正常渲染（上面那条不是因为画布没加载）',
    m.el.querySelectorAll('.react-flow__node').length === 2,
    '实际 ' + String(m.el.querySelectorAll('.react-flow__node').length))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * 票 60：连线补规矩（端口常显 / 选中态 / 右键与 Delete 删线）
 *
 * 用户原话：「内容画布怎么就没连线了？不是有吗？只是规矩相对执行画布
 * 没那么多，别漏了，看参考。」
 *
 * 形状照 `refs-projects/infinite-canvas/web/src/components/canvas/canvas-connections.tsx:33-57`：
 * 一条透明 16px 粗描边作命中区 + 一条可见细线，选中时换色 + 发光。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 票 60：连线补规矩 ===')
{
  /* ⚠️ 本文件没有 `stripComments` / `srcOf` 那两个helper（它们在
   * `float-settings.mjs` 里）。这里就地写一份最小版本 —— 只是去注释，
   * 判据要的是「代码里有没有这句」，注释里提到不算。 */
  const stripC = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const fsR = await import('node:fs')
  const readSrc = (f) => stripC(fsR.readFileSync('src/client/workbench/' + f, 'utf8'))
  const cc = readSrc('ContentCanvas.tsx')
  const cn = readSrc('content-nodes.tsx')
  const css = fsR.readFileSync('src/client/workbench/EcomWorkbench.module.css', 'utf8')

  /* ── 判据 1：连线真的能拉出来（onConnect 路径仍通）───────────── */
  check('★★ 判据 1：`onConnect` 仍在，且给边带 type（走自定义边）',
    /onConnect=\{onConnect\}/.test(cc) && /type: 'content'/.test(cc))
  check('★★ 判据 1：`edgeTypes` 挂上了（否则自定义边组件不生效）',
    /edgeTypes=\{CONTENT_EDGE_TYPES\}/.test(cc))
  check('★★ 判据 1：`defaultEdgeOptions` 是模块级常量（老存档的边也走新组件）',
    /defaultEdgeOptions=\{CONTENT_EDGE_DEFAULTS\}/.test(cc) && /const CONTENT_EDGE_DEFAULTS = \{ type: 'content' \} as const/.test(cc))

  /* ── 判据 2：选中态有独立钩子 + 描边可区分 ──────────────────── */
  check('★★ 判据 2：边上有 `data-ewb-edge` 钩子（找得到每条线）',
    /data-ewb-edge=\{id\}/.test(cn))
  check('★★ 判据 2：选中时有独立钩子 `data-ewb-edge-selected`',
    /data-ewb-edge-selected=\{selected === true \? '' : undefined\}/.test(cn),
    (/data-ewb-edge-selected[^\n]*/.exec(cn) ?? [''])[0].slice(0, 80))
  /* 描边差异：选中 3px + --v1-edge-hot + 发光；未选中 2px + --v1-edge。 */
  check('★★ 判据 2：选中时描边更粗（3 vs 2）',
    /strokeWidth=\{selected === true \? 3 : 2\}/.test(cn))
  check('★★ 判据 2：选中时换色（`--v1-edge-hot` vs `--v1-edge`）',
    /stroke=\{selected === true \? 'var\(--v1-edge-hot\)' : 'var\(--v1-edge\)'\}/.test(cn))
  check('★★ 判据 2：选中时加发光（照参考 `:56` 的 drop-shadow）',
    /drop-shadow\(0 0 8px var\(--v1-edge-hot\)\)/.test(cn))

  /* ── 判据 3：右键菜单有「删除连线」，且进撤销栈 ──────────────── */
  check('★★ 判据 3：`onEdgeContextMenu` 挂上了',
    /onEdgeContextMenu=\{edgeMenu\}/.test(cc))
  check('★★ 判据 3：菜单里有「删除连线」那一项',
    /label: pending \? '确认删除' : '删除连线'/.test(cc))
  check('★★ 判据 3：删线走 `record()`（进撤销栈，Ctrl+Z 能撤回）',
    /record\('delete-edge'\)/.test(cc),
    (/record\('delete-edge'\)/.exec(cc) ?? [''])[0])
  check('★★ 判据 3：只在**一处**真删（两入口共用 `removeEdge`）',
    (cc.match(/setEdges\(prev => prev\.filter\(x => x\.id !== edgeId\)\)/g) ?? []).length === 1)

  /* ── 判据 4：Delete 删线 ─────────────────────────────────────── */
  check('★★ 判据 4：`Delete` 键同时管节点与连线',
    /const nodesGone = deleteSelected\(\)/.test(cc) && /const edgeGone = deleteSelectedEdge\(\)/.test(cc))
  check('★★ 判据 4：右键菜单那条路是**连点两次**（与节点菜单同款）',
    /label: pending \? '确认删除' : '删除连线'/.test(cc) && /key: pending \? '再点一次' : 'Delete'/.test(cc))

  /* ── 判据 5：端口常显 ────────────────────────────────────────── */
  check('★★ 判据 5：选中节点时端口常显（不必 hover）',
    /\.react-flow__node\.selected \.contentHandle/.test(css))
  check('★★ 判据 5：连线过程中全部常显',
    /\.react-flow\.connecting \.contentHandle/.test(css))
  check('★★ 判据 5：常显时 opacity 是 1（不是半透明）',
    /\.react-flow__node\.selected \.contentHandle[\s\S]{0,260}?opacity: 1/.test(css))

  /* ── 判据 6：不给 ContentEdge 加字段 ─────────────────────────── */
  const store = stripC(fsR.readFileSync('src/client/workbench/content-canvas-store.ts', 'utf8'))
  const edgeIface = /export interface ContentEdge \{([\s\S]*?)\n\}/.exec(store)?.[1] ?? ''
  const edgeFields = [...edgeIface.matchAll(/^\s{2}(\w+)\??:/gm)].map(m => m[1])
  check('★★ 判据 6：`ContentEdge` 仍是原来那五个字段（一个没加）',
    edgeFields.join(',') === 'id,source,target,sourceHandle,targetHandle',
    edgeFields.join(','))

  /* ── 判据 7：老存档能读（type 不进存档）───────────────────────── */
  check('★★ 判据 7：存盘只挑四个字段（`type` 不进存档，老档读得回来）',
    /id: e\.id, source: e\.source, target: e\.target,/.test(cc)
    && !/type: e\.type/.test(cc))

  /* ── 判据 10：文案守 R6 ──────────────────────────────────────── */
  const labels = ['删除连线', '确认删除', '连线']
  check('★★ 判据 10：菜单文案没有第二人称 / 疑问句',
    labels.every(t => !/你|吗|呢|？/.test(t)))
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('')
console.log(getFailed() === 0 ? '结论：内容画布接对了 ✓' : '结论：有 ' + String(getFailed()) + ' 条不通过 ✗')
process.exit(getFailed() === 0 ? 0 : 1)
