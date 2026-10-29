/** 画布库与工作流列表上的「复制」按钮（票 46，2026-10-28）。
 *
 * # 前面两个测试文件验的是「复制这件事做对没有」
 *
 * | 文件 | 验什么 |
 * |---|---|
 * | `tests/workflow-duplicate.mjs` | 工作流复制：名字查重、编号不同、撞名不覆盖（真磁盘） |
 * | `tests/canvas-duplicate.mjs` | 画布复制：节点带过去、引用自洽 |
 * | **本文件** | **按钮真的出现在界面上、点了真的会复制** |
 *
 * 前两个是「引擎」，这一份是「按键接着引擎」。分开的理由：
 * 引擎那两份不挂 DOM（快、好定位），而按钮必须在真渲染里才验得到
 * —— 一个 `<button>` 写在组件里但被 `{cond && …}` 挡住，引擎测试看不见。
 *
 * 跑法：`node scripts/run-tests.mjs duplicate-ui`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, act, S, mkDoc, mount, click, settle, check } = env

/* ── ① 画布库每一行有「复制」按钮，点了多一份 ────────────────────── */
console.log('=== ① 画布库：每行有「复制」，点了多一份 ===')
{
  S.mem.clear()
  S.mem.set('cv_a', mkDoc('cv_a', '商品图流程',
    [{ id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: '猫' } }],
    [{ id: 'e?', source: 'n1', target: 'n1' }]))

  const { ContentBoard } = await import('../src/client/workbench/ContentBoard.tsx')
  const props = {
    active: true,
    tab: 'lib',
    apiBase: '/api/ecom-workbench',
    topHidden: false,
    onToggleTop: () => {},
    onSelectTab: () => {},
    onRunWorkflow: () => {},
    keptTabs: ['canvas'],
    onTabsChange: () => {},
  }
  const m = await mount(React.createElement(ContentBoard, props), 800)
  const q = sel => m.el.querySelector(sel)

  check('★★ 画布库里那一行有「复制」按钮', q('[data-ewb-canvas-duplicate="cv_a"]') !== null)
  check('★ 按钮上的字是「复制」（不是符号）',
    (q('[data-ewb-canvas-duplicate="cv_a"]')?.textContent ?? '') === '复制',
    String(q('[data-ewb-canvas-duplicate="cv_a"]')?.textContent))
  check('★ 复制排在「改名」与「删除」之间（同类动作聚在一起）',
    (() => {
      const row = q('[data-ewb-canvas-row="cv_a"]')
      if (row === null) return false
      const order = [...row.querySelectorAll('button')].map(b => b.textContent ?? '')
      const iRen = order.indexOf('改名')
      const iDup = order.indexOf('复制')
      const iDel = order.indexOf('删除')
      return iRen >= 0 && iDup > iRen && iDel > iDup
    })(),
    (() => {
      const row = q('[data-ewb-canvas-row="cv_a"]')
      return row === null ? '（没有那一行）' : [...row.querySelectorAll('button')].map(b => b.textContent).join(' / ')
    })())

  /* 点它 → 多一份。 */
  await click(q('[data-ewb-canvas-duplicate="cv_a"]'))
  await act(async () => { await settle() })

  check('★★★ 点完之后有了两份', S.mem.size === 2, String(S.mem.size) + ' 份')
  const titles = [...S.mem.values()].map(d => d.title).sort()
  check('★★★ 新那份叫「商品图流程 副本」', titles.includes('商品图流程 副本'), titles.join(' / '))
  check('★★ 原件还在、标题没变', S.mem.get('cv_a')?.title === '商品图流程', String(S.mem.get('cv_a')?.title))

  const copy = [...S.mem.values()].find(d => d.title === '商品图流程 副本')
  check('★★★ 副本带着节点（不是空壳）', (copy?.nodes ?? []).length === 1, String((copy?.nodes ?? []).length))

  m.unmount()
}

/* ── ② 工作流列表每一行有「复制」按钮 ───────────────────────────── */
console.log('')
console.log('=== ② 工作流列表：主行动作区里有「复制」 ===')
{
  /* 工作流列表走 `/api/ecom-workbench/workflows`。桩宿主那条路由默认回空列表
   * （`_canvas-harness.mjs` 末尾的兜底），这里临时接管一次，喂两份工作流进去。
   *
   * ⚠️ **两个都要换**：`window.fetch` 与 `globalThis.fetch`。被验的代码里写的是裸
   * `fetch(...)`，在 Node 里解析到 `globalThis.fetch`；只换 `window.fetch` 的话
   * 请求照旧走桩宿主、列表是空的，于是「按钮找不到」—— 而真正的原因在测试自己身上。 */
  const realFetch = window.fetch
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p === '/api/ecom-workbench/workflows' && (init?.method ?? 'GET') === 'GET') {
      return {
        ok: true, status: 200,
        json: async () => ({
          dir: '/tmp/workflows',
          items: [
            { name: '示例流程', id: 'wf-1', nodes: 2, edges: 1, types: [], at: Date.now(), startType: 'manual' },
            { name: '另一份', id: 'wf-2', nodes: 1, edges: 0, types: [], at: Date.now(), startType: 'manual' },
          ],
        }),
      }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub

  const { WorkflowList } = await import('../src/client/workbench/WorkflowList.tsx')
  const m = await mount(React.createElement(WorkflowList, { onOpen: () => {}, onGoCanvas: () => {} }), 800)
  const q = sel => m.el.querySelector(sel)

  check('★★ 主行动作区里能找到该行的「复制」按钮', q('[data-ewb-wf-duplicate="示例流程"]') !== null)
  check('★ 按钮上的字是「复制」',
    (q('[data-ewb-wf-duplicate="示例流程"]')?.textContent ?? '') === '复制',
    String(q('[data-ewb-wf-duplicate="示例流程"]')?.textContent))
  check('★★ 每一行都有（不是只给第一行加）',
    q('[data-ewb-wf-duplicate="另一份"]') !== null)

  /* ★ 它必须与「打开到画布 / 打开目录」在**同一个动作区**里 ——
   * 另起一套会让用户以为它是另一种东西。 */
  const dupBtn = q('[data-ewb-wf-duplicate="示例流程"]')
  const actions = dupBtn?.closest('[data-ewb-card-actions]')
  check('★★ 它与「打开到画布」在同一个动作区（不是另起一套）',
    actions !== null && actions !== undefined
    && [...actions.querySelectorAll('button')].some(b => b.textContent === '打开到画布'),
    actions === null || actions === undefined
      ? '（不在 data-ewb-card-actions 里）'
      : [...actions.querySelectorAll('button')].map(b => b.textContent).join(' / '))

  /* ★ 点了不能崩（真实复制要连宿主半，这里只验「点了不出事、按钮不消失」）。 */
  await click(dupBtn)
  await act(async () => { await settle() })
  check('★★ 点「复制」之后按钮还在（没把列表搞崩）', q('[data-ewb-wf-duplicate="示例流程"]') !== null)

  m.unmount()
  window.fetch = realFetch
  globalThis.fetch = realFetch
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：复制按钮已接上 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
