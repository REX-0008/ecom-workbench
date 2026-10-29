/** 复制画布（票 46，2026-10-28）。
 *
 * # 用户原话
 *
 * 「执行和内容的工作流管理与画布库都增加复制功能。」
 *
 * # 这一份盯什么
 *
 * 画布这一侧的风险与工作流那边**不是同一个**：
 *
 * | | 工作流 | 画布 |
 * |---|---|---|
 * | 撞名 | 会**覆盖写**，毁存档（最大风险） | 后端本来防撞（`canvases.ts:151`） |
 * | 真正的风险 | — | 副本**丢了节点**（空壳副本） |
 *
 * 所以这里重点是「副本里真的带着节点、连线、视口」，以及
 * 「节点 id / 边 id 原样保留时**引用仍然自洽**」。
 *
 * # 节点 id 为什么不重生成（核实过的三条）
 *
 * 写在 `src/client/workbench/content-canvas-store.ts` 的 `duplicateCanvas` 上面。
 * 一句话：节点 id 只在一个画布内部被引用，**跨画布没有反查**
 * （`canvasNodeId` 只写进生成记录、不拿来查），而重生成却漏改 `edges` 或
 * `data.groupId` 才会把引用指空 —— 那才是真正的坏。
 *
 * 所以这里的断言方向是**相反**的：不验「id 变了」，而验「id 没变、引用还对得上」。
 *
 * 跑法：`node scripts/run-tests.mjs canvas-duplicate`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { S, mkDoc, check } = env

const store = await import('../src/client/workbench/content-canvas-store.ts')
const { copyNameOf, duplicateCanvas, createCanvas, listCanvases } = store

console.log('=== ① 副本名的规则（与工作流那边同一套）===')
{
  check('★★ 没有占用 → 「X 副本」', copyNameOf('商品图流程', new Set()) === '商品图流程 副本',
    copyNameOf('商品图流程', new Set()))
  check('★ 已有「X 副本」→ 「X 副本 2」',
    copyNameOf('商品图流程', new Set(['商品图流程 副本'])) === '商品图流程 副本 2')
  check('★★ 中间有空位就用空位',
    copyNameOf('商品图流程', new Set(['商品图流程 副本', '商品图流程 副本 3'])) === '商品图流程 副本 2',
    copyNameOf('商品图流程', new Set(['商品图流程 副本', '商品图流程 副本 3'])))
  check('★★ 从副本再复制 → 往后数，不叠后缀',
    copyNameOf('商品图流程 副本', new Set(['商品图流程 副本'])) === '商品图流程 副本 2',
    copyNameOf('商品图流程 副本', new Set(['商品图流程 副本'])))
}

/* 原件：三个节点、两条边、一个组归属 —— 足够验「引用有没有指空」。
 * 组节点 `g1` 存在，`n3` 的 `data.groupId` 指向它（`group-geometry.ts:15` 的机制）。 */
const NODES = [
  { id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: '一只白猫' } },
  { id: 'n2', type: 'image', position: { x: 320, y: 0 }, data: { artifact: 'a-1' } },
  { id: 'g1', type: 'group', position: { x: -80, y: -80 }, width: 400, height: 300, data: {} },
  { id: 'n3', type: 'config', position: { x: -40, y: 40 }, data: { model: 'gpt-image-1', groupId: 'g1' } },
]
const EDGES = [
  { id: 'e1', source: 'n1', target: 'n2' },
  { id: 'e2', source: 'n3', target: 'n2' },
]
const VIEWPORT = { x: -120, y: 40, zoom: 0.8 }

console.log('')
console.log('=== ② 复制出一份：节点 / 连线 / 视口都带过去 ===')
let srcId = ''
let copyId = ''
{
  S.mem.clear()
  srcId = 'cv_src'
  S.mem.set(srcId, mkDoc(srcId, '商品图流程', structuredClone(NODES), structuredClone(EDGES), { ...VIEWPORT }))

  const r = await duplicateCanvas(srcId, new Set(['商品图流程']))
  copyId = r.data?.id ?? ''
  check('★★ 复制成功', r.ok === true && copyId !== '', r.ok ? '' : String(r.error))
  check('★★★ 副本 id 与原件不同（后端现造，`canvases.ts:151`）', copyId !== srcId,
    '原件 ' + srcId + ' / 副本 ' + copyId)
  check('★★ 副本标题是「商品图流程 副本」', r.data?.title === '商品图流程 副本', String(r.data?.title))
  check('★★★ 副本人节点数与原件一样（4 个）', r.data?.nodes?.length === 4,
    String(r.data?.nodes?.length))
  check('★★★ 副本边数与原件一样（2 条）', r.data?.edges?.length === 2,
    String(r.data?.edges?.length))
  check('★★ 副本视口也跟着过去（不是重置成原点）',
    JSON.stringify(r.data?.viewport) === JSON.stringify(VIEWPORT),
    JSON.stringify(r.data?.viewport))

  /* ★★ 原件一个字节没动 —— 复制不该碰原件。 */
  const srcNow = S.mem.get(srcId)
  check('★★★ 原件原样（标题、节点数、视口都没变）',
    srcNow?.title === '商品图流程' && srcNow?.nodes?.length === 4
    && JSON.stringify(srcNow?.viewport) === JSON.stringify(VIEWPORT),
    JSON.stringify({ t: srcNow?.title, n: srcNow?.nodes?.length }))

  const list = (await listCanvases()).data ?? []
  check('★★ 列表里多了一份（从 1 变 2）', list.length === 2, list.map(x => x.title).join(','))
  check('★ 副本的 nodeCount 也是 4（列表页看得出它带着内容）',
    list.find(x => x.id === copyId)?.nodeCount === 4,
    String(list.find(x => x.id === copyId)?.nodeCount))
}

console.log('')
console.log('=== ③ 副本内部引用自洽（这是「要不要重生成节点 id」的反向断言）===')
{
  const copy = S.mem.get(copyId)
  const ids = new Set((copy?.nodes ?? []).map(n => n.id))

  /* 节点 id 原样保留 —— 这是**刻意的**，理由在 `duplicateCanvas` 的注释里。 */
  check('★★ 节点 id 原样保留（不重生成；理由见 duplicateCanvas 注释）',
    (copy?.nodes ?? []).every(n => NODES.some(o => o.id === n.id)),
    (copy?.nodes ?? []).map(n => n.id).join(','))

  /* ★★★ 这一条要抓的是「重生成节点 id 但没改边」。 */
  check('★★★ 副本里每条边的 source / target 都指得到副本自己的节点',
    (copy?.edges ?? []).every(e => ids.has(e.source) && ids.has(e.target)),
    (copy?.edges ?? []).map(e => e.source + '→' + e.target).join(' '))

  /* ★★★ 这一条要抓的是「重生成节点 id 但没改组归属」。 */
  const groupIds = new Set((copy?.nodes ?? []).filter(n => n.type === 'group').map(n => n.id))
  const members = (copy?.nodes ?? []).filter(n => n.data?.groupId !== undefined)
  check('★★★ 副本里成员的 groupId 都指得到副本自己的组节点',
    members.length === 1 && members.every(n => groupIds.has(n.data.groupId)),
    members.map(n => n.id + '→' + String(n.data.groupId)).join(' '))
  check('★★ 抄过来的组归属没丢（成员还是 1 个）', members.length === 1, String(members.length))
}

console.log('')
console.log('=== ④ 撞名：标题自动往后数，不覆盖已有画布 ===')
{
  /* 把「商品图流程 副本」这个名字占掉（② 段已经建了一份，这里再造一份同名的不可能 ——
   * 所以直接再复制一次，验证它算出的是「副本 2」）。 */
  const again = await duplicateCanvas(srcId, new Set(['商品图流程', '商品图流程 副本']))
  check('★★★ 标题撞了 → 自动变成「商品图流程 副本 2」',
    again.ok === true && again.data?.title === '商品图流程 副本 2', String(again.data?.title))

  /* ★★★ 已有的那份副本**逐字没变**。 */
  const prev = S.mem.get(copyId)
  check('★★★ 先前那份副本原样（没有被新副本盖掉）',
    prev?.title === '商品图流程 副本' && prev?.nodes?.length === 4,
    JSON.stringify({ t: prev?.title, n: prev?.nodes?.length }))
  check('★★ 列表里现在是 3 份（原件 + 2 份副本）', ((await listCanvases()).data ?? []).length === 3,
    String(((await listCanvases()).data ?? []).length))
}

console.log('')
console.log('=== ⑤ 边界：原件不存在 → 什么也不留下 ===')
{
  const before = S.mem.size
  const miss = await duplicateCanvas('cv_不存在', new Set())
  check('★★ 原件不存在 → 失败', miss.ok === false, String(miss.error))
  check('★★★ 失败之后存量没变（没凭空多一份空画布）', S.mem.size === before,
    String(before) + ' → ' + String(S.mem.size))
}

console.log('')
console.log('=== ⑥ createCanvas 不带快照时请求体不变（老调用方不受影响）===')
{
  const plain = await createCanvas('只有标题')
  const doc = S.mem.get(plain.data?.id ?? '')
  check('★ 只给标题 → 建得出来，节点空着',
    plain.ok === true && Array.isArray(doc?.nodes) && doc.nodes.length === 0,
    String(plain.data?.id))
  check('★ 视口是原点（不是 undefined）',
    JSON.stringify(doc?.viewport) === JSON.stringify({ x: 0, y: 0, zoom: 1 }),
    JSON.stringify(doc?.viewport))
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：画布复制全部通过 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
