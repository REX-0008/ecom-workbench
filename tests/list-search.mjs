/** 三处列表加搜索（票 45，2026-10-28）。
 *
 * # 用户原话
 *
 * 「给这三个都增加搜索功能，他们都是可能会很多的东西需要搜索功能」
 *
 * 三处：工作流管理、素材库、画布库。提示词库已经有了，这一单是对齐过去。
 *
 * # 这一份盯什么
 *
 * 搜索最容易「看起来对了」的两件事：
 *
 * | 坏法 | 抓它的断言 |
 * |---|---|
 * | 输入即筛，但**清空不恢复** | 清空后条数回到全量 |
 * | 「搜不到」与「本来就没有」共用一句话 | 两句话不同，且搜不到时**不**显示「还没有」 |
 *
 * 还有一条是本票特别要盯的：**工作流的搜索与类型筛选是「与」关系**。
 * 写成「或」或者「搜索时清掉类型」都会让「在某一类里搜」消失。
 *
 * 跑法：`node scripts/run-tests.mjs list-search`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, act, S, mkDoc, mount, click, settle, check } = env

/**
 * 造一条工作流列表行（形状照 `src/index.ts:2989` 那条 GET 回的）。
 * @param {string} name - 名字。
 * @param {string[]} types - 类型。
 * @param {string} [description] - 说明。
 * @returns {object} 一行。
 */
function wfRow(name, types, description = '') {
  return { name, id: 'wf-' + name, nodes: 1, edges: 0, types, at: Date.now(), startType: 'manual', description }
}

/**
 * 给一个元素派 `input` 事件（React 的受控输入要这么驱动）。
 * @param {object} el - 输入框。
 * @param {string} v - 新值。
 */
async function typeInto(el, v) {
  /* ⚠️ 必须先改 `value` 再派事件：React 会读 `e.target.value`。
   * 只派事件不改值的话，受控输入会把值「弹回去」—— 那时断言看到的是
   * 「搜索没生效」，而错在测试自己。 */
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await act(async () => { await settle() })
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 工作流管理：搜名字 + 说明，与类型筛选是「与」
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 工作流管理：搜名字与说明，与类型筛选取「与」 ===')
{
  const rows = [
    wfRow('天猫取数', ['采集'], '每天拉一次生意参谋的访客数'),
    wfRow('抖音表单下载', ['采集', '下载'], '把表单导出的订单捞回来'),
    wfRow('千川日报', ['报表'], '生成投放日报'),
  ]
  const realFetch = window.fetch
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p === '/api/ecom-workbench/workflows' && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ dir: '/tmp', items: rows }) }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub

  const { WorkflowList } = await import('../src/client/workbench/WorkflowList.tsx')
  const m = await mount(React.createElement(WorkflowList, { onOpen: () => {}, onGoCanvas: () => {} }), 800)
  const q = sel => m.el.querySelector(sel)
  const names = () => [...m.el.querySelectorAll('[data-ewb-card-actions]')].length

  check('★★ 有搜索框', q('[data-ewb-wf-search]') !== null)
  check('★ 一开始三份都在', names() === 3, String(names()))

  /* 搜名字。 */
  await typeInto(q('[data-ewb-wf-search]'), '抖音')
  check('★★★ 搜「抖音」→ 只剩那一份', names() === 1, String(names()))
  check('★★ 计数跟着变（显示 1 份）',
    (q('[data-ewb-wf-hit-count]')?.textContent ?? '').includes('1'),
    String(q('[data-ewb-wf-hit-count]')?.textContent))

  /* ★★ 搜**说明**（这是票面要求的第二个字段，容易漏）。 */
  await typeInto(q('[data-ewb-wf-search]'), '访客')
  check('★★★ 搜说明里的词也能命中（「访客数」在说明里，不在名字里）',
    names() === 1, String(names()))

  /* 搜不到 → 单独一句。 */
  await typeInto(q('[data-ewb-wf-search]'), '不存在的东西')
  check('★★★ 搜不到时一份都不显示', names() === 0, String(names()))
  const noHit = q('[data-ewb-wf-no-hit]')?.textContent ?? ''
  check('★★★ 搜不到时显示「没搜到」那句，并带上搜索词',
    noHit.includes('没有名字或说明含') && noHit.includes('不存在的东西'), noHit)
  check('★★ 而且**不说**「这一组类型下没有工作流」（那是另一种原因）',
    !noHit.includes('类型下没有'), noHit)

  /* ★★ 「与」关系：先选类型「采集」，再搜「抖音」/「千川」。
   *
   * ⚠️ 按**按钮上的字**找，不按「第一个按钮」找 —— `allTypes` 是按 Unicode
   * 码元排序的（下载 < 报表 < 采集），第一个不是「采集」。第一版按位置点，
   * 点到了「下载」，于是「只剩 2 份」变成 1 份，红的是测试的假设不是产品。 */
  await typeInto(q('[data-ewb-wf-search]'), '')
  check('★ 清空搜索 → 三份回来了', names() === 3, String(names()))
  const typeBtn = [...m.el.querySelectorAll('[data-ewb-type-filter] button')].find(b => b.textContent === '采集')
  check('★ 找得到「采集」那颗类型胶囊', typeBtn !== undefined,
    [...m.el.querySelectorAll('[data-ewb-type-filter] button')].map(b => b.textContent).join(' / '))
  await click(typeBtn)
  check('★ 选了「采集」之后只剩 2 份（天猫取数 / 抖音表单下载）', names() === 2, String(names()))
  await typeInto(q('[data-ewb-wf-search]'), '千川')
  check('★★★ 「与」关系：类型是「采集」而「千川日报」是「报表」→ 交集为空',
    names() === 0, String(names()))
  await typeInto(q('[data-ewb-wf-search]'), '天猫')
  check('★★★ 「与」关系：两个条件都满足时才有内容（天猫取数是采集类）',
    names() === 1, String(names()))

  /* 一键全清。 */
  check('★★ 有「清空条件」按钮（搜索与类型都能清）', q('[data-ewb-wf-clear]') !== null)
  await click(q('[data-ewb-wf-clear]'))
  check('★★★ 点「清空条件」→ 三份全回来', names() === 3, String(names()))
  check('★★ 点完之后「清空条件」按钮自己消失（没条件可清了）', q('[data-ewb-wf-clear]') === null)

  m.unmount()
  window.fetch = realFetch
  globalThis.fetch = realFetch
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 画布库：搜标题
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 画布库：搜标题 ===')
{
  S.mem.clear()
  S.mem.set('cv_1', mkDoc('cv_1', '商品图流程'))
  S.mem.set('cv_2', mkDoc('cv_2', '商品视频流程'))
  S.mem.set('cv_3', mkDoc('cv_3', '日报'))

  const { ContentBoard } = await import('../src/client/workbench/ContentBoard.tsx')
  const m = await mount(React.createElement(ContentBoard, {
    active: true, tab: 'lib', apiBase: '/api/ecom-workbench', topHidden: false,
    onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
    keptTabs: ['canvas'], onTabsChange: () => {},
  }), 800)
  const q = sel => m.el.querySelector(sel)
  const rows = () => [...m.el.querySelectorAll('[data-ewb-canvas-row]')].length

  check('★★ 有搜索框', q('[data-ewb-canvas-search]') !== null)
  check('★ 一开始三份都在', rows() === 3, String(rows()))

  await typeInto(q('[data-ewb-canvas-search]'), '商品')
  check('★★★ 搜「商品」→ 两份（商品图流程 / 商品视频流程）', rows() === 2, String(rows()))
  check('★★ 计数跟着变',
    (q('[data-ewb-canvas-hit-count]')?.textContent ?? '').includes('2'),
    String(q('[data-ewb-canvas-hit-count]')?.textContent))

  await typeInto(q('[data-ewb-canvas-search]'), '日报')
  check('★★ 搜「日报」→ 一份', rows() === 1, String(rows()))

  await typeInto(q('[data-ewb-canvas-search]'), '没有这份')
  check('★★★ 搜不到 → 一份都不显示', rows() === 0, String(rows()))
  const noHit = q('[data-ewb-canvas-no-hit]')?.textContent ?? ''
  check('★★★ 搜不到时说「没有匹配的画布」，并报出总数',
    noHit.includes('没有匹配的画布') && noHit.includes('3'), noHit)
  check('★★★ 搜不到时**不**显示「还没有画布」（两种原因不共用一句话）',
    q('[data-ewb-canvas-empty]') === null)

  await click(q('[data-ewb-canvas-clear]'))
  check('★★★ 点「清空搜索」→ 三份回来了', rows() === 3, String(rows()))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 素材库：搜文件名 + 文本素材标题
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 素材库：纯函数先验范围，DOM 再验那条路通 ===')
{
  const { matchesMaterial, filterMaterials } = await import('../src/client/workbench/ContentLibrary.tsx')

  const img = { name: '商品主图.png', bytes: 10, mtime: 1, url: '/a', kind: 'image' }
  const txt = { name: '文案-小红书.text.json', bytes: 20, mtime: 2, url: '/b', kind: 'text', title: '小红书开箱文案', content: '今天开箱……' }
  const vid = { name: 'promo.mp4', bytes: 30, mtime: 3, url: '/c', kind: 'video' }

  check('★★ 空词命中一切（不筛）',
    matchesMaterial(img, '') && matchesMaterial(txt, '') && matchesMaterial(vid, ''))
  check('★★ 搜图片的文件名命中', matchesMaterial(img, '商品'))
  check('★★ 搜视频的文件名命中（英文名也要能搜）', matchesMaterial(vid, 'promo'))
  check('★★★ 搜**文本素材的标题**命中（标题与文件名不同）', matchesMaterial(txt, '开箱'),
    txt.name + ' / title=' + txt.title)
  check('★★ 搜文本素材的正文**不**命中（按票定：只搜标题）', !matchesMaterial(txt, '今天开箱'),
    '正文里有「今天开箱」但标题没有')
  check('★★ 大小写不敏感（PROMO 也能搜到 promo.mp4）', matchesMaterial(vid, 'PROMO'))

  const all = [img, txt, vid]
  check('★★★ filterMaterials 空词返回全部', filterMaterials(all, '').length === 3)
  check('★★★ filterMaterials 搜词返回命中项', filterMaterials(all, '商品').length === 1)
  check('★★ filterMaterials 全不命中返回空', filterMaterials(all, 'zzz').length === 0)
  check('★ filterMaterials 前后空格不影响（trim）', filterMaterials(all, '  开箱  ').length === 1)
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 素材库 DOM：搜到了 / 搜不到两句不同
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 素材库界面：输入即筛、两句空态分开 ===')
{
  const { ContentLibrary } = await import('../src/client/workbench/ContentLibrary.tsx')

  /* 桩宿主：素材列表给三条（照 `GET /materials` 的形状，带 `kind` / `title`）。 */
  const realFetch = window.fetch
  const mats = [
    { name: '商品主图.png', bytes: 10, mtime: Date.now(), url: '/api/ecom-workbench/material/a.png', kind: 'image' },
    { name: 'promo.mp4', bytes: 30, mtime: Date.now(), url: '/api/ecom-workbench/material/b.mp4', kind: 'video' },
    { name: '文案.text.json', bytes: 20, mtime: Date.now(), url: '/api/ecom-workbench/material/c.text.json', kind: 'text', title: '小红书开箱文案', content: '……' },
  ]
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p === '/api/ecom-workbench/materials' && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, materials: mats, items: mats }) }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub

  const m = await mount(React.createElement(ContentLibrary, { active: true }), 800)
  const q = sel => m.el.querySelector(sel)
  const cards = () => [...m.el.querySelectorAll('[data-ewb-material]')].length

  check('★★ 有搜索框', q('[data-ewb-mat-search]') !== null)
  check('★ 一开始三个素材都在', cards() === 3, String(cards()))

  await typeInto(q('[data-ewb-mat-search]'), '商品')
  check('★★★ 搜「商品」→ 一张（商品主图.png）', cards() === 1, String(cards()))

  await typeInto(q('[data-ewb-mat-search]'), '开箱')
  check('★★★ 搜文本素材的标题 → 一张（界面上真的按标题筛了）', cards() === 1, String(cards()))

  await typeInto(q('[data-ewb-mat-search]'), '没有这个')
  check('★★★ 搜不到 → 一张都不显示', cards() === 0, String(cards()))
  const noHit = q('[data-ewb-mat-no-hit]')?.textContent ?? ''
  check('★★★ 搜不到时说「没有匹配的素材」', noHit.includes('没有匹配的素材'), noHit)
  check('★★★ 搜不到时**不**显示「素材目录是空的」', q('[data-ewb-mat-empty]') === null)

  await click(q('[data-ewb-mat-clear]'))
  check('★★★ 清空 → 三个回来了', cards() === 3, String(cards()))

  m.unmount()
  window.fetch = realFetch
  globalThis.fetch = realFetch
}

console.log('')
console.log('=== ⑤ 搜标题命中时，列表里看得见那个标题（票 51 的端到端）===')
{
  const { ContentLibrary } = await import('../src/client/workbench/ContentLibrary.tsx')

  const realFetch = window.fetch
  const mats = [
    { name: '图片.png', bytes: 10, mtime: Date.now(), url: '/api/ecom-workbench/material/a.png', kind: 'image' },
    { name: '文案-甲.text.json', bytes: 20, mtime: Date.now(), url: '/api/ecom-workbench/material/b.text.json', kind: 'text', title: '小红书开箱文案', content: '……' },
    { name: '文案-乙.text.json', bytes: 20, mtime: Date.now(), url: '/api/ecom-workbench/material/c.text.json', kind: 'text', title: '天猫主图文案', content: '……' },
  ]
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p === '/api/ecom-workbench/materials' && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, materials: mats, items: mats }) }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub

  const m = await mount(React.createElement(ContentLibrary, { active: true }), 800)
  const q = sel => m.el.querySelector(sel)

  await typeInto(q('[data-ewb-mat-search]'), '开箱')
  const label = q('[data-ewb-material="文案-甲.text.json"] [data-ewb-material-label]')?.textContent ?? ''
  /* ★★★ 这条是本票与票 51 的接缝：搜索靠标题命中，而列表上**必须能看见**
   * 那个命中的词 —— 否则用户不知道为什么这条被搜出来了。 */
  check('★★★ 搜「开箱」命中之后，那张卡上**看得见**「开箱」两个字',
    label.includes('开箱'), '卡片主文字＝' + label)
  check('★★ 看得见的是标题（不是文件名）', label === '小红书开箱文案', label)

  m.unmount()
  window.fetch = realFetch
  globalThis.fetch = realFetch
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：三处搜索都接上了 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
