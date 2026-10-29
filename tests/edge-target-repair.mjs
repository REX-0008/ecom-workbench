/** 老存档接入端口名对不上的自动纠正（票 04，画布错误 008）。
 *
 * ## 这一段守的是什么（用户报的原现象）
 *
 * > 工作流管理的工作流在画布打开会报错，显示画布错误 008：
 * > Couldn't create edge for target handle id: "in", edge id: e1.
 *
 * 那句话的意思是：这条线要接一个叫 `in` 的口，目标节点上没有。
 * 根因是**端口改过名**（`sys.fs.read` 现在是 `path`、`sys.fs.write` 是 `content`），
 * 而老存档里的连线还指着旧名字。实测真实存档里 166 条带 `targetHandle` 的边有 10 条这样。
 *
 * ## 判据分两层，各守一件事
 *
 * ① **纯函数层**（`repairEdgeTargets`）：怎么修、什么不许修。
 *    这一层能脱离磁盘单测，所以「多入端口不许猜」那条能单独钉死。
 * ② **真盘层**（`store.ts` 的 `loadWorkflow` / `listWorkflows`）：
 *    真写进沙箱、真读回来、真看修改时间。这一层守「幂等」与「写回失败不影响打开」。
 *
 * ⚠️ 全程在 `EWB_TEST_HOME` 沙箱里（`workflowsDir` 优先读它），**绝不碰真实数据目录**。
 *
 * ## 判据编号对应票面
 *
 * 票面 7 条判据在本文件里的位置写在每条断言上方，形如「判据 4」。
 * 这样改判据的人能一下看出漏了哪条。
 *
 * 跑法：node tests/edge-target-repair.mjs（需要 tsx loader，见 `scripts/run-tests.mjs`）
 */
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ⚠️ 沙箱必须在**载入任何 src 模块之前**设好（`workflowsDir()` 读环境变量定目录）。 */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-edge-'))

const { repairEdgeTargets, scanBadEdgeTargets } = await import('../src/workflow/edge-targets.ts')
const { loadWorkflow, saveWorkflow, listWorkflows, workflowsDir, safeName } = await import('../src/workflow/store.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 造一份最小存档。
 * @param {string} defId - 目标节点类型。
 * @param {string|null} targetHandle - 边上写的接入端口（null = 不写这个键）。
 * @returns {object} 存档。
 */
function doc(defId, targetHandle) {
  return {
    version: 1,
    name: '端口测试',
    nodes: [
      { id: 'n1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' },
      { id: 'n2', defId, position: { x: 200, y: 0 }, params: {}, onError: 'stop' },
    ],
    edges: [targetHandle === null
      ? { id: 'e1', source: 'n1', target: 'n2' }
      : { id: 'e1', source: 'n1', target: 'n2', targetHandle }],
  }
}

console.log('=== 老存档接入端口名的自动纠正（票 04 / 画布错误 008）===')
console.log('沙箱：' + process.env.EWB_TEST_HOME)
console.log('')

/* ── ① `sys.fs.read` 的 in → path、`sys.fs.write` 的 in → content ─────
 *
 * 判据 1。这是本次要修的**那 10 条**的形状 —— 真实存档里 8 条是 read、2 条是 write。
 *
 * ⚠️ 映射方向写反（path ↔ content）这条就红，见本文件的「自证」段。 */
console.log('① 判据 1：`in` 按节点类型换成它唯一那个入口')
{
  const r1 = repairEdgeTargets(doc('sys.fs.read', 'in'), NODE_LIBRARY)
  check('★★ sys.fs.read 的 in → path',
    r1.changed.length === 1 && r1.changed[0].to === 'path',
    JSON.stringify(r1.changed))
  check('★ 改完之后那条边上写的就是 path',
    r1.doc.edges[0].targetHandle === 'path', JSON.stringify(r1.doc.edges[0]))
  check('★ 其余边字段一个不动（id / source / target 原样）',
    r1.doc.edges[0].id === 'e1' && r1.doc.edges[0].source === 'n1' && r1.doc.edges[0].target === 'n2',
    JSON.stringify(r1.doc.edges[0]))

  const r2 = repairEdgeTargets(doc('sys.fs.write', 'in'), NODE_LIBRARY)
  check('★★ sys.fs.write 的 in → content（不是 path）',
    r2.changed.length === 1 && r2.changed[0].to === 'content',
    JSON.stringify(r2.changed))
  check('★ 两者映射没写反（read→path / write→content 不同）',
    r1.changed[0].to !== r2.changed[0].to,
    r1.changed[0].to + ' vs ' + r2.changed[0].to)

  /* 修正记录要能对上「哪条边、哪个节点、从什么改成什么」—— 日志靠它说话。 */
  check('★ 修正记录带边号 / 节点号 / 节点类型 / 原值 / 新值',
    r1.changed[0].edgeId === 'e1' && r1.changed[0].target === 'n2'
    && r1.changed[0].defId === 'sys.fs.read' && r1.changed[0].from === 'in',
    JSON.stringify(r1.changed[0]))
}

/* ── ② 本来就对的边：一个字节不动 ─────────────────────────────────
 *
 * 判据 2。这条防的是「修的时候顺手把合法的也改了」——
 * 没改动的判据是 `changed` 为空**且返回的是同一个对象**。 */
console.log('')
console.log('② 判据 2：本来就合法的 targetHandle 不动')
{
  const before = doc('sys.fs.read', 'path')
  const r = repairEdgeTargets(before, NODE_LIBRARY)
  check('★★ 合法的 path → changed 为空', r.changed.length === 0, JSON.stringify(r.changed))
  check('★★ 没改动时返回的是**同一个对象**（不是重建一份）', r.doc === before,
    r.doc === before ? '同一个引用' : '被重建了')
  check('★ 那条边上一字未改', r.doc.edges[0].targetHandle === 'path', JSON.stringify(r.doc.edges[0]))
}

/* ── ③ 没写 targetHandle 的边不动 ─────────────────────────────────
 *
 * 判据 3。真实存档 166 条里绝大多数是这种（156 条）。
 * 它们本来就没有「接哪个口」这回事，凭定义去补一个反而会改变运行时的接线行为。 */
console.log('')
console.log('③ 判据 3：没写 targetHandle 的边不动（真实存档里 156 条是这种）')
{
  const before = doc('sys.fs.read', null)
  const r = repairEdgeTargets(before, NODE_LIBRARY)
  check('★★ 没写 targetHandle → changed 为空', r.changed.length === 0, JSON.stringify(r.changed))
  check('★★ 也没被「补上」一个（键仍然不存在）', !('targetHandle' in r.doc.edges[0]),
    JSON.stringify(Object.keys(r.doc.edges[0])))
  check('★ 返回的仍是同一个对象', r.doc === before, r.doc === before ? '同一个引用' : '被重建了')

  /* 混合：一份里既有坏的也有好的，只该动坏的那条。 */
  const mixed = {
    version: 1, name: '混合',
    nodes: [
      { id: 'n1', defId: 'code.js' },
      { id: 'n2', defId: 'sys.fs.read' },
      { id: 'n3', defId: 'sys.fs.write' },
    ],
    edges: [
      { id: 'ok', source: 'n1', target: 'n2', targetHandle: 'path' },
      { id: 'bad', source: 'n1', target: 'n3', targetHandle: 'in' },
      { id: 'plain', source: 'n1', target: 'n2' },
    ],
  }
  const rm = repairEdgeTargets(mixed, NODE_LIBRARY)
  check('★★ 混合里只动坏的那一条', rm.changed.length === 1 && rm.changed[0].edgeId === 'bad',
    JSON.stringify(rm.changed.map(c => c.edgeId)))
  check('★ 好的那条原样、没写的那条原样',
    rm.doc.edges[0].targetHandle === 'path' && !('targetHandle' in rm.doc.edges[2]),
    JSON.stringify(rm.doc.edges))
}

/* ── ④ 多入端口：不猜 ─────────────────────────────────────────────
 *
 * 判据 4，票面点名的**核心约束**。
 *
 * `flow.merge` 有两个入口（a / b）。老值 `in` 到底该落哪个？没有依据。
 * 猜错会把数据接到另一路上 —— 流程照样跑完、结果是错的，比报错更难查。 */
console.log('')
console.log('④ 判据 4：多入端口不猜（记进 unfixed、原值保留）')
{
  const before = doc('flow.merge', 'in')
  const r = repairEdgeTargets(before, NODE_LIBRARY)
  check('★★ 多入端口节点上的错值：一条都不修', r.changed.length === 0, JSON.stringify(r.changed))
  check('★★ 记进 unfixed 并说明是多入口', r.unfixed.length === 1 && r.unfixed[0].reason === 'multiple-inputs',
    JSON.stringify(r.unfixed))
  check('★★ 原值保留（还是 in，不是 a 也不是 b）', r.doc.edges[0].targetHandle === 'in',
    String(r.doc.edges[0].targetHandle))
  check('★ 返回的仍是同一个对象', r.doc === before, r.doc === before ? '同一个引用' : '被重建了')

  /* 先确认前提：flow.merge 真是多入口 —— 否则上面三条在验空气。 */
  const merge = NODE_LIBRARY.find(d => d.id === 'flow.merge')
  check('（前置）flow.merge 确实有多个入口', Array.isArray(merge?.inputs) && merge.inputs.length > 1,
    String(merge?.inputs?.length))
}

/* ── ⑤ 未知 defId：不动 ───────────────────────────────────────────
 *
 * 判据 5。存档里可能引用别的机器上烤的节点、或我们删掉的节点（票 21 删过六个）。
 * 那种节点的端口表我们不知道，**猜就等于编**。 */
console.log('')
console.log('⑤ 判据 5：未知节点类型不动（记进 unfixed）')
{
  const before = doc('some.deleted.node', 'in')
  const r = repairEdgeTargets(before, NODE_LIBRARY)
  check('★★ 未知类型：一条都不修', r.changed.length === 0, JSON.stringify(r.changed))
  check('★★ 记进 unfixed 并说明是未知类型',
    r.unfixed.length === 1 && r.unfixed[0].reason === 'unknown-def', JSON.stringify(r.unfixed))
  check('★ 原值保留', r.doc.edges[0].targetHandle === 'in', String(r.doc.edges[0].targetHandle))
  check('★ 返回的仍是同一个对象', r.doc === before, r.doc === before ? '同一个引用' : '被重建了')

  /* 反向：目标节点在存档里根本不存在（边指向一个不存在的节点）→ 不动。 */
  const ghost = {
    version: 1, name: '幽灵边',
    nodes: [{ id: 'n1', defId: 'code.js' }],
    edges: [{ id: 'e1', source: 'n1', target: 'nope', targetHandle: 'in' }],
  }
  const rg = repairEdgeTargets(ghost, NODE_LIBRARY)
  check('★ 目标节点不存在的边也一个字不动（那是另一类坏图，不归这里修）',
    rg.changed.length === 0 && rg.doc === ghost, JSON.stringify(rg.changed))
}

/* ── ⑥ 真盘：写回 + 幂等 ──────────────────────────────────────────
 *
 * 判据 6，票面要求「第二次打开不再产生修正，文件修改时间不变」。
 *
 * 为什么必须动真盘：`changed` 为空只是纯函数的话。**真正要让用户受益的是写回**，
 * 而写回与幂等是 `store.ts` 那一层的事 —— 只验纯函数会把这一层漏掉。 */
console.log('')
console.log('⑥ 判据 6：真盘写回 + 第二次打开不再修（修改时间不变）')
{
  const bad = doc('sys.fs.read', 'in')
  await saveWorkflow(bad, '端口待修', {})
  const file = join(workflowsDir(), safeName('端口待修') + '.json')

  const mtimeBefore = (await stat(file)).mtimeMs
  /* 让时间戳能分辨：等一会儿再读，否则两次读在同一毫秒内、判据假绿。 */
  await new Promise(r => setTimeout(r, 30))

  const first = await loadWorkflow('端口待修', {})
  check('★★ 第一次打开：读出来的边已经是 path',
    first?.edges?.[0]?.targetHandle === 'path', JSON.stringify(first?.edges?.[0]))
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  check('★★ 修正**写回了磁盘**（不是只在内存里）',
    onDisk.edges[0].targetHandle === 'path', JSON.stringify(onDisk.edges[0]))
  const mtimeAfter = (await stat(file)).mtimeMs
  check('★ 文件确实被写过（修改时间变了）', mtimeAfter > mtimeBefore,
    String(mtimeBefore) + ' → ' + String(mtimeAfter))

  /* 第二次打开：一个字都不该改。 */
  await new Promise(r => setTimeout(r, 30))
  const mtimeFixed = (await stat(file)).mtimeMs
  const second = await loadWorkflow('端口待修', {})
  check('★★ 第二次打开读出来一样', second?.edges?.[0]?.targetHandle === 'path',
    JSON.stringify(second?.edges?.[0]))
  check('★★ 第二次打开**没有再写盘**（修改时间不变）',
    (await stat(file)).mtimeMs === mtimeFixed,
    String(mtimeFixed) + ' → ' + String((await stat(file)).mtimeMs))
  const onDisk2 = JSON.parse(await readFile(file, 'utf8'))
  check('★ 文件内容仍然对（第二次没把它改坏）', onDisk2.edges[0].targetHandle === 'path',
    JSON.stringify(onDisk2.edges[0]))
}

/* ── ⑥b 列表那条路也修（与 loadWorkflow 各读各的，只修一处会「换个入口就不对」）── */
console.log('')
console.log('⑥b 列表那条路（listWorkflows）同样吃到修正')
{
  const bad = doc('sys.fs.write', 'in')
  await saveWorkflow(bad, '列表待修', {})
  const items = await listWorkflows()
  const hit = items.find(x => x.name === '列表待修')
  check('★★ 列表读出来的边已经是 content',
    hit?.doc?.edges?.[0]?.targetHandle === 'content', JSON.stringify(hit?.doc?.edges?.[0]))
  const file = join(workflowsDir(), safeName('列表待修') + '.json')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  check('★★ 列表那条路也写回了磁盘', onDisk.edges[0].targetHandle === 'content',
    JSON.stringify(onDisk.edges[0]))
}

/* ── ⑦ 写回失败不许让打开失败 ───────────────────────────────────
 *
 * 判据 7。用户打不开的代价远大于「这次没存回去」（下次打开还会重试）。
 *
 * 注入方式：把文件设成只读？Windows 上不够可靠。**用一个同名目录占住写回目标**
 * 更稳 —— `writeFile` 必然失败，而 `readFile` 已经读完了（读发生在写之前）。
 *
 * ⚠️ 这条不能省：`loadWorkflow` 的老实现整段包在 try 里，读坏了返回 null。
 * 若写回失败也被那个 try 兜住返回 null，用户就**打不开任何一份待修的存档** ——
 * 那比 008 严重得多。 */
console.log('')
console.log('⑦ 判据 7：写回失败时打开照旧成功')
{
  /* 造一份待修的存档（先用 saveWorkflow 正常写出来）。 */
  await saveWorkflow(doc('sys.fs.read', 'in'), '写回会失败', {})
  const file = join(workflowsDir(), safeName('写回会失败') + '.json')
  /* 把它改成只读 —— Windows 上 `writeFile` 对只读文件会失败。
   * 这条路比「换成目录」温和（目录会让 readFile 也失败，验不到「读到了但写不进去」）。 */
  const { chmod } = await import('node:fs/promises')
  await chmod(file, 0o444)

  let threw = false
  let got = null
  try {
    got = await loadWorkflow('写回会失败', {})
  } catch {
    threw = true
  }
  check('★★ 写回失败时**不抛错**', threw === false, threw ? '抛了' : '没抛')
  check('★★ 内容照常读出来了（没返回 null）', got !== null && got !== undefined,
    String(got === null ? 'null' : '有内容'))
  check('★★ 而且读出来的已经是修好的（内存里修了，只是没存回去）',
    got?.edges?.[0]?.targetHandle === 'path', JSON.stringify(got?.edges?.[0]))

  const { chmod: chmodBack } = await import('node:fs/promises')
  await chmodBack(file, 0o644)
}

/* ── ⑧ 扫盘：修完之后不该再有不合法的 ─────────────────────────────
 *
 * 这一段是「真数据验证」的可重复版本：`scanBadEdgeTargets` 与
 * `repairEdgeTargets` 共用同一个判据（`pickPort`），所以扫出来是空就说明修干净了。
 *
 * ⚠️ 它验的是**沙箱里的合成存档**，不是用户真实那 13 份 —— 真实那批在交付里
 * 另外贴一次只读扫描的结果（那是票面的「真数据验证」）。 */
console.log('')
console.log('⑧ 扫盘：修前有、修后没有')
{
  const before = doc('sys.fs.read', 'in')
  const bad0 = scanBadEdgeTargets(before, NODE_LIBRARY)
  check('（前置）修之前扫得出这条坏边', bad0.length === 1, JSON.stringify(bad0))
  const fixed = repairEdgeTargets(before, NODE_LIBRARY)
  const bad1 = scanBadEdgeTargets(fixed.doc, NODE_LIBRARY)
  check('★★ 修完之后扫出来是空的', bad1.length === 0, JSON.stringify(bad1))

  /* 反向：多入口那条修不了，扫出来还应该在 —— 说明「扫」没有为了好看而放过它。 */
  const merge = doc('flow.merge', 'in')
  check('★★ 多入口那条扫出来仍然不合法（没被当成修好）',
    scanBadEdgeTargets(merge, NODE_LIBRARY).length === 1,
    JSON.stringify(scanBadEdgeTargets(merge, NODE_LIBRARY)))
}

/* ── ⑨ 纯函数：不读盘、不改入参 ───────────────────────────────────
 *
 * 「纯函数」是票面点名要求的（要能脱离画布单测）。两件事都要验：
 * 不偷偷读盘（那会让单测依赖环境）、不改传进来的对象（那会让调用方莫名其妙变了）。 */
console.log('')
console.log('⑨ 纯函数：不改入参、不碰环境')
{
  const before = doc('sys.fs.read', 'in')
  const snapshot = JSON.stringify(before)
  repairEdgeTargets(before, NODE_LIBRARY)
  check('★★ 不改传进来的那份存档（原对象一个字没变）',
    JSON.stringify(before) === snapshot, JSON.stringify(before))
  check('★ 边数组也没被就地改（原数组里还是 in）',
    before.edges[0].targetHandle === 'in', String(before.edges[0].targetHandle))
  /* 坏形状不崩：给它各种乱七八糟的东西。 */
  for (const junk of [null, undefined, 42, 'x', [], {}, { nodes: 'x' }, { edges: 'x' }, { edges: [null, 1] }]) {
    const r = repairEdgeTargets(junk, NODE_LIBRARY)
    check('★ 坏形状不崩（' + JSON.stringify(junk) + '）', r.changed.length === 0, JSON.stringify(r.changed))
  }
}

/* ── 收尾 ──────────────────────────────────────────────────────── */
const { rm } = await import('node:fs/promises')
await rm(process.env.EWB_TEST_HOME, { recursive: true, force: true })

console.log('')
console.log(failed === 0
  ? '结论：接入端口纠正全部通过 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
