/** 「全部下载」按平台分流的行为核验（2026-10-22 两份下载合并成一份）。
 *
 * ## 背景（为什么有这条测试）
 *
 * 「一键下载」与「全部下载」原本是两份成员相同、只有子工作流顺序相反的存档。
 * 用户决定**删掉「一键下载」、只留一份**，并把「跑哪一份」交给开始节点的
 * `平台` 参数：`全部`（默认）/ `天猫` / `抖音`。
 *
 * 于是「分流画对没画对」成了这条链上最容易做错、且**做错了不报错**的地方：
 * 条件写反 → 选天猫却跑了抖音；条件写严 → 一份都不跑，界面上只看得到
 * 「跑完了」。静态看一眼 JSON 是猜不出这些的（`notIn` / `in`、`true` / `false`
 * 出口、两个 IF 的串联顺序，任何一处反了都长得差不多），所以这里**真跑调度器**。
 *
 * ## 钉哪几条
 *
 * ① 存档结构：只有一份「全部下载」、旧的「一键下载」已不在；
 * ② 开始节点声明了 `平台`，三个可选值写在说明里，默认「全部」；
 * ③ `flow.if` 的接法与现有存档一致（出口 `true` / `false`，不发明新接法）；
 * ④ **三次真跑**：平台 = 天猫 / 抖音 / 全部，各只看该跑的子工作流被调用；
 * ⑤ 一份都没漏：每个「跑另一份工作流」节点至少在一种平台下会被执行。
 *
 * ## 怎么跑
 *
 * `DSH_HOME=F:/AGENTS/agent-chat-dsh node scripts/run-tests.mjs download-merge`
 *
 * 只读真实存档；`flow.if` 用**真实现**（`branchFn`），所以「调度器解析左边的值」
 * 那条路也一起被覆盖。子工作流用桩替代 —— 不真的开浏览器、不写文件。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'
import { runGraph } from '../src/workflow/run.ts'
import { branchFn } from '../src/dispatch/builtins.ts'
import { parseInputFields } from '../src/workflow/io-fields.ts'
import { deriveWorkflowId } from '../src/workflow/ids.ts'

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

const WF_DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
const lib = [...(Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : NODE_LIBRARY.values())]

console.log('=== 「全部下载」按平台分流（合并后的组合层）===')
console.log('存档目录：' + WF_DIR)
console.log('')

/* ⚠️ 找不到真实存档就**跳过**（不算失败）：这条依赖本机数据，
 * 换机器 / 换测试 profile 时不该因为「没有那份存档」而红。
 * 与 `tests/real-archive-if.mjs` 同一条纪律。 */
if (!existsSync(join(WF_DIR, '全部下载.json'))) {
  console.log('（本机没有「全部下载.json」，跳过 —— 先跑 node scripts/build-patrol-workflows.mjs）')
  console.log('')
  console.log('结论：没有可核对的存档（跳过）✓')
  process.exit(0)
}

/** 子工作流编号（与生成器同一条派生规则）。 */
const TMALL_ID = deriveWorkflowId('取数-天猫生意参谋')
const DOUYIN_ID = deriveWorkflowId('取数-抖音电商罗盘')

/**
 * 读存档并翻成调度器要的形状（与画布、宿主半同一份映射）。
 * @param name - 存档名。
 * @returns 存档与 specs。
 */
function load(name) {
  const doc = JSON.parse(readFileSync(join(WF_DIR, name + '.json'), 'utf8'))
  const specs = toRunSpecsFromCanvas(
    doc.nodes.map(n => ({
      id: n.id,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      data: {
        def: lib.find(d => d.id === n.defId),
        params: n.params,
        onError: n.onError,
        skipped: n.skipped === true,
        label: n.label,
      },
    })),
    doc.edges,
  )
  return { doc, specs }
}

/* ── ① 结构：只留一份，旧的删掉了 ─────────────────────────────── */
console.log('① 存档结构（合并成一份）')
const merged = load('全部下载')
check('★ 只剩一份「全部下载」', merged.doc.nodes.length > 0, String(merged.doc.nodes.length) + ' 节点')
check('★★ 旧的「一键下载.json」已删除', !existsSync(join(WF_DIR, '一键下载.json')))

/* 节点数不写死：按 defId 统计，再与连线互相对上（写死一个数会在加节点时假红）。 */
const ifNodes = merged.doc.nodes.filter(n => n.defId === 'flow.if')
const subNodes = merged.doc.nodes.filter(n => n.defId === 'flow.workflow')
const startNodes = merged.doc.nodes.filter(n => n.defId === 'flow.start')
const endNodes = merged.doc.nodes.filter(n => n.defId === 'flow.end')
check('一个开始节点', startNodes.length === 1, String(startNodes.length))
/* ⚠️ 2026-10-25 反向改了：用户决定**存档里不再有结束节点**，所以这条从
 * 「有一个结束节点」改成「一个都没有」。判据方向跟着用户决定走，不是放松。 */
check('★ 没有结束节点（用户 2026-10-25 定：存档里去掉它）',
  endNodes.length === 0, String(endNodes.length))
check('★ 有「跑另一份工作流」节点（天猫 + 抖音各一个）', subNodes.length === 2, String(subNodes.length))
check('★ 有「条件判断」节点（用现成节点分流，不发明新节点）', ifNodes.length >= 1, String(ifNodes.length))
check('引用的正是天猫 / 抖音两份（按编号）',
  [TMALL_ID, DOUYIN_ID].every(id => subNodes.some(n => n.params.workflowId === id)),
  subNodes.map(n => String(n.params.workflowId)).join(','))

/* ── ② 开始节点：平台字段 ─────────────────────────────────────── */
console.log('')
console.log('② 开始节点的「平台」参数')
{
  const fields = parseInputFields(startNodes[0]?.params.fields)
  const plat = fields.find(f => f.name === '平台')
  check('★★ 声明了「平台」', plat !== undefined, fields.map(f => f.name).join(' / '))
  if (plat !== undefined) {
    check('★★ 默认值是「全部」（不填就跑全部）', plat.default === '全部', String(plat.default))
    check('★ 三种可选值都写在说明里',
      ['全部', '天猫', '抖音'].every(v => plat.description.includes(v)), plat.description)
    check('★ 不是必填（不填按说明走默认）', plat.required === false, String(plat.required))
    /* R6：不用第二人称、不用疑问句。 */
    check('R6：说明里没有第二人称与问号',
      !/[你您]/.test(plat.description) && !/[？?]/.test(plat.description), plat.description)
  }
  /* 另外三项（抖音那份的参数）照旧保留 —— 合并不能把它们弄丢。 */
  check('modules / from / to 还在（合并没弄丢透传参数）',
    ['modules', 'from', 'to'].every(n => fields.some(f => f.name === n)), fields.map(f => f.name).join(' / '))
}

/* ── ③ flow.if 的接法与现有存档一致 ──────────────────────────── */
console.log('')
console.log('③ 分流接法（照现有存档：出口 only true / false）')
{
  const ifIds = new Set(ifNodes.map(n => n.id))
  const outOfIf = merged.doc.edges.filter(e => ifIds.has(e.source))
  check('★ 条件节点的出边都写了出口名（true / false）',
    outOfIf.every(e => e.sourceHandle === 'true' || e.sourceHandle === 'false'),
    outOfIf.map(e => String(e.sourceHandle)).join(','))
  /* ⚠️ 2026-10-25 改判据：原来判「两个出口都接了下游」，依据是
   * 「不成立也不能悬空」，当时是把它们汇到结束节点。
   *
   * 结束节点被去掉之后，**「③ 判断抖音」的不成立出口（平台=天猫）到此为止** ——
   * 这正好是 `flow.if` 自己的既定语义（它的注意事项写着「没接的那条路会断在这里，
   * 流程到此结束」），不是漏接。所以判据改成两头都钉：
   *   · 边不能指向不存在的节点（这是真悬空）；
   *   · 没接的出口**只能有一处**，且必须是 ③ 的不成立出口 ——
   *     别的地方也空着就说明是漏接了。 */
  const ids = new Set(merged.doc.nodes.map(n => n.id))
  check('★ 没有指向不存在节点的边（那才是真悬空）',
    merged.doc.edges.every(e => ids.has(e.source) && ids.has(e.target)),
    merged.doc.edges.filter(e => !ids.has(e.source) || !ids.has(e.target)).map(e => e.id).join(','))
  const openOutlets = ifNodes.flatMap(n =>
    ['true', 'false']
      .filter(h => !outOfIf.some(e => e.source === n.id && e.sourceHandle === h))
      .map(h => n.id + ':' + h))
  /* ③ 是「平台不为天猫」那个判断，它的 false = 平台为天猫 → 只跑天猫，到此结束。 */
  const askDouyin = ifNodes.find(n => JSON.stringify(n.params?.conditions ?? '').includes('天猫'))
  check('★★ 没接的出口只有一处，且是「平台为天猫」那条到此为止',
    openOutlets.length === 1 && askDouyin !== undefined && openOutlets[0] === askDouyin.id + ':false',
    openOutlets.join(',') || '没有未接的出口')
  /* 入边一律接 `in`（与现有存档一致；`flow.workflow` / `flow.end` 的入端口就叫 in）。 */
  const intoTargets = merged.doc.edges.filter(e => e.target !== undefined)
  check('★ 所有连线都指明了入端口 in',
    intoTargets.every(e => e.targetHandle === 'in'),
    intoTargets.filter(e => e.targetHandle !== 'in').map(e => e.id).join(',') || '全部是 in')
  /* 没有并行节点：原本三支汇到同一个 end 走的是普通连线，现在各自收尾，都不是并行。 */
  check('★★ 没有用 flow.parallel（避开跨路汇合限制）',
    !merged.doc.nodes.some(n => n.defId === 'flow.parallel'))
}

/* ── ④ 三次真跑：每次只看该跑的那份被调用 ─────────────────────── */
console.log('')
console.log('④ 真跑调度器：平台 = 天猫 / 抖音 / 全部')

/**
 * 按平台跑一次，返回被调用的子工作流编号列表。
 *
 * `flow.if` 用**真实现** `branchFn`（不是桩）—— 这样「调度器解析左边 → 比 →
 * 报出口」整条路都被覆盖；只有子工作流被换成记录桩。
 *
 * @param platform - 平台取值（`undefined` = 不填）。
 * @returns 被调用的子工作流编号（按调用顺序）。
 */
async function runWith(platform) {
  const calls = []
  const runWorkflow = async (ref, _signal, inputs) => {
    calls.push({ ref, inputs })
    return { ok: true, ran: ['s1'] }
  }
  const dispatch = async (req) => {
    /* 条件判断走真实现；其余节点给一个成功空输出（本测试不关心它们的数据）。 */
    if (req.command?.node === 'flow.if' || req.defId === 'flow.if') {
      return { ok: true, status: 'success', output: branchFn(req.command, { nodeId: req.nodeId, workdir: '', upstream: req.context.upstream }) }
    }
    return { ok: true, status: 'success', output: {} }
  }
  const out = await runGraph(
    {
      nodes: merged.specs.nodes,
      edges: merged.specs.edges,
      workdir: WF_DIR,
      inputs: platform === undefined ? {} : { 平台: platform },
      runWorkflow,
    },
    dispatch,
    { onEvent: () => { /* 不要日志 */ } },
  )
  return { calls, out, ranIds: out.ran ?? [] }
}

{
  const onlyTmall = await runWith('天猫')
  const tmallIds = onlyTmall.calls.map(c => c.ref?.id)
  check('★ 平台=天猫 → 没有中断', onlyTmall.out.aborted !== true, String(onlyTmall.out.error ?? ''))
  check('★★ 平台=天猫 → 调用了天猫那份',
    tmallIds.includes(TMALL_ID), tmallIds.join(','))
  check('★★ 平台=天猫 → **没有**调用抖音那份',
    !tmallIds.includes(DOUYIN_ID), tmallIds.join(','))
  check('平台=天猫 → 只调用了一次子工作流', tmallIds.length === 1, String(tmallIds.length))

  const onlyDouyin = await runWith('抖音')
  const douyinIds = onlyDouyin.calls.map(c => c.ref?.id)
  check('★ 平台=抖音 → 没有中断', onlyDouyin.out.aborted !== true, String(onlyDouyin.out.error ?? ''))
  check('★★ 平台=抖音 → 调用了抖音那份',
    douyinIds.includes(DOUYIN_ID), douyinIds.join(','))
  check('★★ 平台=抖音 → **没有**调用天猫那份',
    !douyinIds.includes(TMALL_ID), douyinIds.join(','))
  check('平台=抖音 → 只调用了一次子工作流', douyinIds.length === 1, String(douyinIds.length))

  const both = await runWith('全部')
  const bothIds = both.calls.map(c => c.ref?.id)
  check('★ 平台=全部 → 没有中断', both.out.aborted !== true, String(both.out.error ?? ''))
  check('★★ 平台=全部 → 两份都调用了',
    bothIds.includes(TMALL_ID) && bothIds.includes(DOUYIN_ID), bothIds.join(','))
  check('★★ 平台=全部 → 天猫在前、抖音在后（顺序照原「全部下载」）',
    bothIds.indexOf(TMALL_ID) < bothIds.indexOf(DOUYIN_ID), bothIds.join(','))

  /* 不填平台 = 默认「全部」（开始节点里写的默认值要真生效）。 */
  const blank = await runWith(undefined)
  const blankIds = blank.calls.map(c => c.ref?.id)
  check('★★ 不填平台 → 按默认「全部」跑两份',
    blankIds.includes(TMALL_ID) && blankIds.includes(DOUYIN_ID), blankIds.join(','))

  /* ── ⑤ 一份都没漏（静态 + 动态两头对账）───────────────────────── */
  console.log('')
  console.log('⑤ 一份都没漏')
  const covered = new Set([...tmallIds, ...douyinIds, ...bothIds])
  const declared = new Set(subNodes.map(n => n.params.workflowId))
  check('★★ 存档里声明的每份子工作流都至少被跑过一次',
    [...declared].every(id => covered.has(id)),
    '声明 ' + [...declared].join(',') + ' / 实跑 ' + [...covered].join(','))
  check('★ 除「开始 / 结束」外，每个节点至少在一种平台下被执行',
    merged.doc.nodes
      .filter(n => n.defId !== 'flow.start' && n.defId !== 'flow.end')
      .every(n => [...onlyTmall.ranIds, ...onlyDouyin.ranIds, ...both.ranIds].includes(n.id)),
    merged.doc.nodes.filter(n => n.defId !== 'flow.start' && n.defId !== 'flow.end')
      .filter(n => ![...onlyTmall.ranIds, ...onlyDouyin.ranIds, ...both.ranIds].includes(n.id))
      .map(n => n.id + ':' + n.label).join(' / ') || '全部覆盖')
  /* ⚠️ 2026-10-25 改判据：原来判「三种平台下都跑到结束节点（不是死路）」，
   * 结束节点已被去掉。这一条想守的是**「每支都没死路、该跑的都跑到了」**，
   * 所以改判「每支都跑到了它该跑的那个子工作流节点」—— 比原来更贴题：
   *   · 平台=天猫 → ② 天猫那份；
   *   · 平台=抖音 → ④ 抖音那份；
   *   · 平台=全部 → 两份都跑到。
   * 而且顺带把「结束节点收尾」这件事的替代品钉住了：链尾就是子工作流节点。 */
  const subOf = (platform) => subNodes.find(n => n.params.workflowId ===
    (platform === TMALL_ID ? TMALL_ID : DOUYIN_ID))?.id
  check('★ 平台=天猫 → 跑到了天猫那个节点（链尾就是它）',
    onlyTmall.ranIds.includes(subOf(TMALL_ID)), onlyTmall.ranIds.join(','))
  check('★ 平台=抖音 → 跑到了抖音那个节点',
    onlyDouyin.ranIds.includes(subOf(DOUYIN_ID)), onlyDouyin.ranIds.join(','))
  check('★★ 平台=全部 → 两个节点都跑到了，而且抖音那个是最后一个',
    both.ranIds.includes(subOf(TMALL_ID))
    && both.ranIds.includes(subOf(DOUYIN_ID))
    && both.ranIds[both.ranIds.length - 1] === subOf(DOUYIN_ID),
    both.ranIds.join(','))
}

/* ── ⑥ 连带：「0一键更新」不能再指向已删除的那份 ───────────────── */
console.log('')
console.log('⑥ 连带改动：0一键更新 指向合并后的那一份')
{
  if (!existsSync(join(WF_DIR, '0一键更新.json'))) {
    console.log('  （跳过：本机没有「0一键更新.json」）')
  } else {
    const upd = load('0一键更新')
    const refs = upd.doc.nodes
      .filter(n => n.defId === 'flow.workflow')
      .map(n => String(n.params.workflowId ?? ''))
    check('★★ 不再引用已删除的「一键下载」编号',
      !refs.includes(deriveWorkflowId('一键下载')), refs.join(','))
    check('★ 第一份引用的是「全部下载」',
      refs[0] === merged.doc.id, JSON.stringify({ 引用: refs[0], 实际: merged.doc.id }))
    check('★ 引用的每一份都能在本机找到对应存档',
      refs.every(id => {
        const name = id === merged.doc.id ? '全部下载'
          : id === deriveWorkflowId('清洗入库') ? '清洗入库' : ''
        return name !== '' && existsSync(join(WF_DIR, name + '.json'))
      }), refs.join(','))
  }
}

console.log('')
console.log(failed === 0 ? '结论：平台分流全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
