/** 存档往返测试（画布节点 ↔ 工作流文档）。
 *
 * 为什么必须有它：存档格式**最需要单测**，而原先它住在画布组件里、无法单测 ——
 * 格式一错，用户辛苦连的流程保存后打开就对不上，而构建、类型检查、界面渲染
 * **全都不报错**。
 *
 * ⚠️ 顺带守住一个**既有缺陷的修复**（2026-10-12 查出）：
 * 分组框节点的 defId 是 `__group`，而它**不在节点库里**；原先读回时它被判「缺类型」
 * 直接丢弃 → **编组存了也白存**（保存后重新打开，编组全没了，且没有任何提示）。
 *
 * 跑法：node tests/workflow-doc.mjs
 */
import { readFileSync } from 'node:fs'
import { toWorkflowDoc, fromWorkflowDoc, docFingerprint, GROUP_DEF_ID } from '../src/client/workbench/workflow-doc.ts'

/** 累计失败数。 */
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

/** 一个最小节点定义。 */
function def(id, params = {}) {
  return { id, label: id, executor: 'builtin', inputs: [], outputs: [], params, onError: 'stop' }
}

/** 造一个画布节点。 */
function node(id, opts = {}) {
  const n = {
    id,
    type: opts.type ?? 'v1',
    position: opts.position ?? { x: 10, y: 20 },
    data: {
      def: opts.def ?? def(opts.defId ?? 'code.js'),
      params: opts.params ?? {},
      onError: 'stop',
      skipped: opts.skipped === true,
    },
  }
  if (opts.parentId !== undefined) n.parentId = opts.parentId
  if (opts.label !== undefined) n.data.label = opts.label
  if (opts.note !== undefined) n.data.note = opts.note
  if (opts.groupLabel !== undefined) n.data.groupLabel = opts.groupLabel
  if (opts.groupId !== undefined) n.data.groupId = opts.groupId
  return n
}

/** 节点库（测试用的小表）。 */
const LIB = new Map([['code.js', def('code.js')], ['flow.loop', def('flow.loop')]])

/** 合成分组框占位定义（与画布传的同一个形状）。 */
const makeGroup = () => ({ id: GROUP_DEF_ID, label: '分组', executor: 'builtin', inputs: [], outputs: [] })

console.log('=== 存档往返（toWorkflowDoc / fromWorkflowDoc）===')

console.log('① 基本信息往返：坐标 / 参数 / 失败策略 / 跳过')
{
  const nodes = [node('a', { position: { x: 5, y: 6 }, params: { k: 1 }, skipped: true })]
  const doc = toWorkflowDoc(nodes, [], 'w1')
  check('文档带名字与版本', doc.name === 'w1' && doc.version === 1, JSON.stringify({ n: doc.name, v: doc.version }))
  check('坐标原样', doc.nodes[0].position.x === 5 && doc.nodes[0].position.y === 6)
  check('参数原样', doc.nodes[0].params.k === 1)
  check('跳过原样', doc.nodes[0].skipped === true)

  const back = fromWorkflowDoc(doc, LIB, makeGroup)
  check('读回节点数一致', back.nodes.length === 1, String(back.nodes.length))
  check('读回坐标一致', back.nodes[0].position.x === 5 && back.nodes[0].position.y === 6)
  check('读回参数一致', back.nodes[0].data.params.k === 1)
  check('读回跳过一致', back.nodes[0].data.skipped === true)
  check('无缺失类型', back.missingTypes.length === 0, JSON.stringify(back.missingTypes))
}

console.log('')
console.log('② type 字段必须落盘（否则容器读不回来）')
{
  const doc = toWorkflowDoc([node('a'), node('g', { type: 'group', defId: GROUP_DEF_ID, groupLabel: '我的组' })], [])
  check('普通节点写 type=v1', doc.nodes[0].type === 'v1', String(doc.nodes[0].type))
  check('容器写 type=group', doc.nodes[1].type === 'group', String(doc.nodes[1].type))
}

console.log('')
console.log('③ 编组：新格式往返（框是节点 + 成员 groupId）—— 契约 CE')
{
  /* ⚠️ **判据整段换过两次，这是第三次**。三次分别对应三种存档格式：
   *
   *   1. 2026-10-12 前：框是节点 + 成员 `parentId`（相对坐标）；
   *   2. 2026-10-13 ~ 10-25：`nodeGroups` 名单（框**不是**节点，绝对坐标）；
   *   3. 2026-10-26 起（本次，用户 m01076「编组照参考项目」）：
   *      框**又是**节点了，但成员靠 `groupId` 指回去（绝对坐标）。
   *
   * 为什么又改回「框是节点」：参考项目的组能被选中、能拖、能改大小 ——
   * 这些都要求它本身是个节点。旧断言「框不该出现在 nodes 里」正是格式 2 的判据，
   * 现在是**错的**，所以整段重写（这是判据跟着产品意图改，不是放宽）。 */
  const nodes = [
    node('g-1', { type: 'group', defId: GROUP_DEF_ID, position: { x: 0, y: 0 }, groupLabel: '组一', note: '这两个一起改' }),
    node('a', { position: { x: 30, y: 40 }, groupId: 'g-1' }),
    node('b', { position: { x: 60, y: 40 }, groupId: 'g-1' }),
  ]
  /* ⚠️ 第三个参数以前传的是名单，现在传不传都无所谓（不再写盘）。传空数组，
   * 意在证明「就算调用方还在传，也不会写进存档」—— 那是下面那条断言的用意。 */
  const doc = toWorkflowDoc(nodes, [{ id: 'e1', source: 'a', target: 'b' }], '', [{ id: 'g-1', name: '组一', nodeIds: ['a', 'b'] }])
  check('★★ 不再写 nodeGroups 键（组只存一次，不存两份）', doc.nodeGroups === undefined,
    JSON.stringify(doc.nodeGroups))
  const frame = doc.nodes.find(n => n.id === 'g-1')
  check('★★ 框是 nodes 里的一项', frame !== undefined && frame.type === 'group',
    JSON.stringify(frame?.type))
  check('★★ 框带名字与备注', frame?.label === '组一' && frame?.note === '这两个一起改',
    JSON.stringify({ l: frame?.label, n: frame?.note }))
  check('★★ 成员用 groupId 指回框',
    doc.nodes.find(n => n.id === 'a')?.groupId === 'g-1'
    && doc.nodes.find(n => n.id === 'b')?.groupId === 'g-1')
  check('成员坐标是绝对的（没被改写）',
    doc.nodes.find(n => n.id === 'a')?.position.x === 30,
    JSON.stringify(doc.nodes.find(n => n.id === 'a')?.position))
  check('★ 成员不带 parentId（分组不走父子容器）', doc.nodes.find(n => n.id === 'a')?.parentId === undefined)

  const back = fromWorkflowDoc(doc, LIB, makeGroup)
  check('★★ 读回框还在（不是被迁移掉了）', back.nodes.some(n => n.id === 'g-1' && n.type === 'group'),
    back.nodes.map(n => n.id + ':' + n.type).join(','))
  check('★★ 读回成员归属还在',
    back.nodes.find(n => n.id === 'a')?.data.groupId === 'g-1',
    JSON.stringify(back.nodes.find(n => n.id === 'a')?.data.groupId))
  check('读回框名', back.nodes.find(n => n.id === 'g-1')?.data.label === '组一')
  check('★ 框排在成员之前（渲染时框在底下，不挡成员）',
    back.nodes.findIndex(n => n.id === 'g-1') < back.nodes.findIndex(n => n.id === 'a'),
    back.nodes.map(n => n.id).join(','))
}

console.log('')
console.log('③a 存一次再读一次，组不丢（契约 CE 的核心——这次阻塞就出在这）')
{
  /* 这一条是契约 CE 的**核心验收**：之前保存一次再打开，组节点会被
   * `fromWorkflowDoc` 当成旧格式**去掉**，用户看到的编组全消失。
   * 现在要求「读 → 写 → 再读」三趟下来组与归属都还在。 */
  const src = [
    node('gx', { type: 'group', defId: GROUP_DEF_ID, position: { x: 100, y: 200 }, groupLabel: '我的组', note: '说明' }),
    node('m1', { position: { x: 150, y: 260 }, groupId: 'gx' }),
    node('m2', { position: { x: 400, y: 260 }, groupId: 'gx' }),
  ]
  src[0].width = 700
  src[0].height = 300
  const d1 = toWorkflowDoc(src, [])
  const r1 = fromWorkflowDoc(d1, LIB, makeGroup)
  const d2 = toWorkflowDoc(r1.nodes, [])
  const r2 = fromWorkflowDoc(d2, LIB, makeGroup)
  check('★★ 两趟之后框仍在（存一次别把组弄丢）',
    r2.nodes.some(n => n.id === 'gx' && n.type === 'group'),
    r2.nodes.map(n => n.id + ':' + n.type).join(','))
  check('★★ 两趟之后成员归属仍在',
    r2.nodes.filter(n => n.data.groupId === 'gx').map(n => n.id).sort().join(',') === 'm1,m2',
    r2.nodes.map(n => n.id + '->' + String(n.data.groupId)).join(' '))
  check('★★ 框的宽高往返（用户拉过的尺寸不被冲掉）',
    r2.nodes.find(n => n.id === 'gx')?.width === 700 && r2.nodes.find(n => n.id === 'gx')?.height === 300,
    JSON.stringify({ w: r2.nodes.find(n => n.id === 'gx')?.width, h: r2.nodes.find(n => n.id === 'gx')?.height }))
  check('两趟之后成员坐标没动',
    r2.nodes.find(n => n.id === 'm1')?.position.x === 150
    && r2.nodes.find(n => n.id === 'm2')?.position.x === 400,
    r2.nodes.filter(n => n.id.startsWith('m')).map(n => n.id + '@' + String(n.position.x)).join(' '))
}

console.log('')
console.log('③b 老格式自动迁移（框是节点 + 成员 parentId + 相对坐标）')
{
  /* 老格式（2026-10-13 前）：分组框是一个 `type: 'group'` 的**节点**，
   * 成员挂在子节点的 `parentId` 上，成员坐标是**相对框**的。
   *
   * ⚠️ 与 2026-10-13 ~ 10-25 那一版**最大的差别**：框节点**要保留下来**。
   * 那一版会把它从图里去掉（那时框只是渲染出来的），现在它是真节点。 */
  const oldDoc = {
    version: 1,
    name: '旧档',
    nodes: [
      /* 成员故意排在框之前（旧档的顺序不保证）。 */
      { id: 'a', type: 'v1', defId: 'code.js', position: { x: 30, y: 40 }, parentId: 'g' },
      { id: 'b', type: 'v1', defId: 'code.js', position: { x: 60, y: 40 }, parentId: 'g' },
      { id: 'g', type: 'group', defId: GROUP_DEF_ID, position: { x: 500, y: 500 }, label: '老组' },
    ],
    edges: [],
  }
  const back = fromWorkflowDoc(oldDoc, LIB, makeGroup)
  /* ★ 坐标必须**相对→绝对**（加回框的原点）—— 不转的话成员会全挤到画布左上角附近
   * （500+30 才是它原来的位置）。 */
  const a = back.nodes.find(n => n.id === 'a')
  check('★ 成员坐标已转成绝对（加回框的原点）',
    a.position.x === 530 && a.position.y === 540, JSON.stringify(a.position))
  check('★★ 成员的 parentId 被摘掉（分组不走父子容器）', a.parentId === undefined)
  check('★★ 成员打上了 groupId', a.data.groupId === 'g', String(a.data.groupId))
  /* ★ **框节点保留**（与格式 2 那一版相反 —— 那一版会去掉它）。 */
  check('★★ 分组框仍然是节点（契约 CE 之后它不再被去掉）',
    back.nodes.some(n => n.id === 'g' && n.type === 'group'),
    back.nodes.map(n => n.id + ':' + n.type).join(','))
  check('缺类型里没有分组框（它是被迁移，不是缺类型）',
    !back.missingTypes.includes(GROUP_DEF_ID), JSON.stringify(back.missingTypes))
  check('★ 读回 groups 名单是空的（组只存在 nodes 里，不再存第二份）',
    back.groups.length === 0, JSON.stringify(back.groups))

  /* ⚠️ 循环的归属**不许被迁走**（循环仍是 `parentId` 容器）。
   *
   * ⚠️ **这个场景里必须同时有分组框**（第一版没有，所以那条断言**永远是绿的**、
   * 等于没测 —— 已用「改坏必红」抓到）：迁移只在有分组框时启动，
   * 没有分组框就整段不跑，循环的 `parentId` 当然不动。
   * 加上框之后，若迁移写成了「见 parentId 就摘」，这条立刻红。 */
  const withLoop = fromWorkflowDoc({
    version: 1, name: 'x',
    nodes: [
      /* 一个普通分组框（触发迁移）。 */
      { id: 'a2', type: 'v1', defId: 'code.js', position: { x: 5, y: 5 }, parentId: 'g2' },
      { id: 'g2', type: 'group', defId: GROUP_DEF_ID, position: { x: 100, y: 100 }, label: '组二' },
      /* 一个循环 + 它的循环体（**不该被迁移**）。 */
      { id: 'L', type: 'v1', defId: 'flow.loop', position: { x: 0, y: 0 } },
      { id: 'body', type: 'v1', defId: 'code.js', position: { x: 20, y: 20 }, parentId: 'L' },
    ],
    edges: [],
  }, LIB, makeGroup)
  check('分组框确实触发了迁移（前提条件）',
    withLoop.nodes.some(n => n.id === 'g2' && n.type === 'group'),
    withLoop.nodes.map(n => n.id + ':' + n.type).join(','))
  check('★ 循环的归属**不迁移**（循环仍是 parentId 容器）',
    withLoop.nodes.find(n => n.id === 'body')?.parentId === 'L',
    JSON.stringify(withLoop.nodes.find(n => n.id === 'body')?.parentId))
  check('★ 循环体的坐标**不动**（没被加框的原点）',
    withLoop.nodes.find(n => n.id === 'body')?.position.x === 20,
    JSON.stringify(withLoop.nodes.find(n => n.id === 'body')?.position))
  check('循环体没被误打 groupId', withLoop.nodes.find(n => n.id === 'body')?.data.groupId === undefined)
  check('循环节点本身还在图里', withLoop.nodes.some(n => n.id === 'L'))
}

console.log('')
console.log('③c 名单格式迁移（nodeGroups → 造一个框节点）')
{
  /* 格式 2（2026-10-13 ~ 10-25）：只有 `nodeGroups`，框**不是**节点。
   * 现在要替它**造一个框节点**，位置尺寸按成员包围盒算。 */
  const back = fromWorkflowDoc({
    version: 1, name: 'x',
    nodes: [{ id: 'a', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 } }],
    edges: [],
    nodeGroups: [
      { id: 'g-1', name: '好组', nodeIds: ['a', 'ghost'] },   // ghost 不存在 → 丢掉
      { id: '', name: '没 id', nodeIds: ['a'] },               // 缺 id → 丢
      { id: 'g-3', name: '', nodeIds: ['a'] },                 // 缺名 → 丢
      { id: 'g-4', name: '空组', nodeIds: [] },                // 空 → 丢
    ],
  }, LIB, makeGroup)
  check('★★ 造出 1 个框节点（合法的那个）',
    back.nodes.filter(n => n.type === 'group').map(n => n.id).join(',') === 'g-1',
    back.nodes.map(n => n.id + ':' + n.type).join(','))
  check('★★ 框名沿用名单里的名字',
    back.nodes.find(n => n.id === 'g-1')?.data.label === '好组',
    String(back.nodes.find(n => n.id === 'g-1')?.data.label))
  check('★★ 幽灵成员被剔除（没给不存在的节点造归属）',
    back.nodes.find(n => n.id === 'a')?.data.groupId === 'g-1',
    String(back.nodes.find(n => n.id === 'a')?.data.groupId))
  check('★★ 框有尺寸（迁移时按成员包围盒算出来的）',
    (back.nodes.find(n => n.id === 'g-1')?.width ?? 0) > 0
    && (back.nodes.find(n => n.id === 'g-1')?.height ?? 0) > 0,
    JSON.stringify({ w: back.nodes.find(n => n.id === 'g-1')?.width, h: back.nodes.find(n => n.id === 'g-1')?.height }))
  check('★ 脏名单一条都没迁进来（缺 id / 缺名 / 空组都丢）',
    back.nodes.filter(n => n.type === 'group').length === 1,
    back.nodes.filter(n => n.type === 'group').map(n => n.id).join(','))
}

console.log('')
console.log('④ 实例级名字与备注（label / note）往返')
{
  const doc = toWorkflowDoc([node('a', { label: '我的下载节点', note: '这里为什么这么写' })], [])
  check('label 落盘', doc.nodes[0].label === '我的下载节点', String(doc.nodes[0].label))
  check('note 落盘', doc.nodes[0].note === '这里为什么这么写', String(doc.nodes[0].note))
  const back = fromWorkflowDoc(doc, LIB, makeGroup)
  check('label 读回', back.nodes[0].data.label === '我的下载节点')
  check('note 读回', back.nodes[0].data.note === '这里为什么这么写')
  /* 空值不写进文档（免得存档里全是无意义的空键）。 */
  const doc2 = toWorkflowDoc([node('b', { label: '' })], [])
  check('空 label 不落盘', doc2.nodes[0].label === undefined)
}

console.log('')
console.log('⑤ 分组框标题的字段归一化（旧档用 groupLabel）')
{
  /* 旧存档把分组框标题存在 data.groupLabel；新格式统一到 label。 */
  const doc = toWorkflowDoc([node('g', { type: 'group', defId: GROUP_DEF_ID, groupLabel: '老组名' })], [])
  check('groupLabel 归一化到 label', doc.nodes[0].label === '老组名', String(doc.nodes[0].label))
}

console.log('')
console.log('⑥ 脏数据（外部存档不可信）')
{
  check('不是工作流 → null', fromWorkflowDoc(null, LIB, makeGroup) === null)
  check('没有 nodes → null', fromWorkflowDoc({ edges: [] }, LIB, makeGroup) === null)
  check('nodes 不是数组 → null', fromWorkflowDoc({ nodes: 'x' }, LIB, makeGroup) === null)

  /* 认不出的类型：**跳过它，但保住其余**（缺一个就整份打不开 = 用户丢掉整份工作）。 */
  const back = fromWorkflowDoc({
    nodes: [{ id: 'a', defId: 'code.js' }, { id: 'x', defId: 'no.such.type' }],
  }, LIB, makeGroup)
  check('认不出的被跳过、其余保住', back.nodes.length === 1 && back.nodes[0].id === 'a', back.nodes.map(n => n.id).join(','))
  check('缺失类型被记下', back.missingTypes.includes('no.such.type'), JSON.stringify(back.missingTypes))

  /* 父不存在的归属要丢掉（否则坐标会算错）。 */
  const orphan = fromWorkflowDoc({
    nodes: [{ id: 'a', defId: 'code.js', parentId: 'ghost' }],
  }, LIB, makeGroup)
  check('父不存在 → 丢掉归属', orphan.nodes[0].parentId === undefined, JSON.stringify(orphan.nodes[0].parentId))

  /* 端点在已丢节点上的边要一起丢掉。 */
  const edgeDrop = fromWorkflowDoc({
    nodes: [{ id: 'a', defId: 'code.js' }],
    edges: [{ id: 'e1', source: 'a', target: 'ghost' }],
  }, LIB, makeGroup)
  check('指向已丢节点的边被丢掉', edgeDrop.edges.length === 0, String(edgeDrop.edges.length))

  /* 缺坐标给兜底值，不崩。 */
  const noPos = fromWorkflowDoc({ nodes: [{ id: 'a', defId: 'code.js' }] }, LIB, makeGroup)
  check('缺坐标给兜底', noPos.nodes[0].position.x === 60 && noPos.nodes[0].position.y === 60,
    JSON.stringify(noPos.nodes[0].position))
}

console.log('')
console.log('⑦ 旧存档兼容（没写 type 的分组框）')
{
  /* 早期版本不写 `type`，只有 `defId='__group'` —— 必须仍能**认出它是分组框**。
   *
   * ⚠️ 判据 2026-10-26 又改回来（契约 CE，用户 m01076「编组照参考项目」）：
   * 分组框**又是**节点了，所以「它还在 nodes 里」重新成立。
   * 中间那一版（10-13 ~ 10-25）把它渲染成计算出来的框、从图里去掉 —— 那是格式 2，
   * 现在已经不是我们要的形状。这里测的是**认得出**：
   * 只靠 `defId`（旧档不写 `type`）也得认出它是框，并且成员归到它名下。 */
  const withMember = fromWorkflowDoc({
    nodes: [
      { id: 'a', defId: 'code.js', position: { x: 10, y: 20 }, parentId: 'g' },
      { id: 'g', defId: GROUP_DEF_ID, position: { x: 100, y: 100 } },
    ],
  }, LIB, makeGroup)
  check('★★ 旧档（只靠 defId）也能认出分组框',
    withMember.nodes.some(n => n.id === 'g' && n.type === 'group'),
    withMember.nodes.map(n => n.id + ':' + n.type).join(','))
  check('★★ 成员归到它名下（groupId 指回去）',
    withMember.nodes.find(n => n.id === 'a')?.data.groupId === 'g',
    String(withMember.nodes.find(n => n.id === 'a')?.data.groupId))
  check('★★ 那个框作为节点留下（契约 CE 之后框是真节点）',
    withMember.nodes.some(n => n.id === 'g'), withMember.nodes.map(n => n.id).join(','))
  check('★ 成员升成绝对坐标（旧档是相对框的）',
    withMember.nodes.find(n => n.id === 'a')?.position.x === 110
    && withMember.nodes.find(n => n.id === 'a')?.position.y === 120,
    JSON.stringify(withMember.nodes.find(n => n.id === 'a')?.position))

  /* 没有成员的孤立框：仍然要**认得出来**（不报缺类型）、并且作为节点**留着**
   * —— 用户刚拖出一个框、还没往里放节点，这是真实存在的一瞬间。 */
  const lone = fromWorkflowDoc({
    nodes: [{ id: 'g', defId: GROUP_DEF_ID, position: { x: 1, y: 2 } }],
  }, LIB, makeGroup)
  check('孤立的分组框不报缺类型', !lone.missingTypes.includes(GROUP_DEF_ID), JSON.stringify(lone.missingTypes))
  check('孤立的分组框不产生名单里的组', lone.groups.length === 0)
  check('★★ 孤立的框本身留在图里（它是真节点）',
    lone.nodes.some(n => n.id === 'g'), lone.nodes.map(n => n.id).join(','))
}

console.log('')
console.log('⑧ 连线手柄往返')
{
  const doc = toWorkflowDoc([node('a'), node('b')], [
    { id: 'e1', source: 'a', target: 'b', sourceHandle: 'true', targetHandle: 'in' },
    { id: 'e2', source: 'a', target: 'b' },
  ])
  check('手柄落盘', doc.edges[0].sourceHandle === 'true' && doc.edges[0].targetHandle === 'in')
  check('没有手柄时不留空键', doc.edges[1].sourceHandle === undefined && doc.edges[1].targetHandle === undefined)
  const back = fromWorkflowDoc(doc, LIB, makeGroup)
  check('手柄读回', back.edges[0].sourceHandle === 'true' && back.edges[0].targetHandle === 'in')
}

console.log('')
console.log('⑨ 转换是纯函数（不依赖 DOM / React / 画布）')
{
  /* 判据：源码里不出现 `window` / `document` / `react` / `@xyflow`。 */
  const src = readFileSync(new URL('../src/client/workbench/workflow-doc.ts', import.meta.url), 'utf8')
  const banned = ['window.', 'document.', "from 'react'", '@xyflow/react']
  const hits = banned.filter(b => src.includes(b))
  check('无浏览器 / React / 画布依赖', hits.length === 0, hits.join('、'))
}

console.log('')
console.log(failed === 0 ? '结论：存档往返全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')

console.log('')
console.log('⑩ 工作流类型（用户 m00861）往返')
{
  /* 类型是**显示与筛选**用的字段，与「能不能被调用」无关（用户 m00901）。
   * 两条判据：
   *   ① 写进去、读回来都不丢（否则「打开 → 保存」一趟会把列表里填的类型冲掉）；
   *   ② 没填过时不写空数组（存档干净），读回时给空数组。 */
  const doc = toWorkflowDoc([], [], '带类型的', [], '', ['采集', '组合'])
  check('类型写进存档', JSON.stringify(doc.types) === JSON.stringify(['采集', '组合']), JSON.stringify(doc.types))
  const back = fromWorkflowDoc(doc, {})
  check('★ 读回来不丢', JSON.stringify(back.types) === JSON.stringify(['采集', '组合']), JSON.stringify(back.types))
  /* ★ 这条守的是「打开 → 保存」那一趟：拿读回的结果再写一遍，类型还在。 */
  const again = toWorkflowDoc([], [], back.description, [], '', back.types)
  check('★ 往返一趟仍在（打开→保存不会冲掉）',
    JSON.stringify(again.types) === JSON.stringify(['采集', '组合']), JSON.stringify(again.types))

  const empty = toWorkflowDoc([], [], '没类型')
  check('没填过 → 存档里不出现这个键', !('types' in empty), JSON.stringify(empty))
  check('读不到 → 空数组（不是 undefined）', Array.isArray(fromWorkflowDoc({ version: 1, nodes: [], edges: [] }, {}).types))
  /* 脏数据：手改成字符串 / 塞进非字符串 → 只留干净的，不炸。 */
  const dirty = fromWorkflowDoc({ version: 1, nodes: [], edges: [], types: '采集' }, {})
  check('存档里是字符串（脏）→ 当没填，不炸', Array.isArray(dirty.types) && dirty.types.length === 0, JSON.stringify(dirty.types))
  const dirty2 = fromWorkflowDoc({ version: 1, nodes: [], edges: [], types: ['采集', 42, '', ' 组合 '] }, {})
  check('数组里混了非字符串 → 只留干净的并去空白',
    JSON.stringify(dirty2.types) === JSON.stringify(['采集', '组合']), JSON.stringify(dirty2.types))
  /* ⚠️ 类型**进指纹**（它是内容）。改类型必须被认作「有改动」。 */
  const f1 = docFingerprint({ version: 1, nodes: [], edges: [], types: ['a'] })
  const f2 = docFingerprint({ version: 1, nodes: [], edges: [], types: ['b'] })
  check('★ 改类型会被认作内容改动（进指纹）', f1 !== f2)
}

process.exit(failed === 0 ? 0 : 1)