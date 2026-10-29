/** 「跑另一份工作流」节点（`flow.workflow`）的行为核验。
 *
 * ## 为什么单独一个测试
 *
 * 这个节点**不派发**，由调度器解释执行（照 `flow.loop`）。它有两个容易做错、
 * 且做错了不报错的地方：
 *
 *   ① **把上游数据带进子工作流** —— bat 的 `call` 是纯顺序、两份之间没有数据流。
 *      若顺手把上游当输入传进去，子工作流的起点会拿到一份它不认识的东西。
 *   ② **套娃没有上限** —— `A 调 B、B 调 A` 会一直转，界面上只显示「一直在跑」。
 *
 * 所以这里钉的是这两条 + 三条正常路径（跑通 / 跑不通 / 名字没填）。
 *
 * ## 怎么跑（不需要真实工作流、不碰磁盘）
 *
 * 用**假存档目录**（`EWB_TEST_HOME`）+ 真正的工作流文件读写（`saveWorkflow`），
 * 派发桩按节点类型给假输出。全程在临时目录里。
 *
 * 跑法：node --import <tsx> tests/sub-workflow.mjs
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ⚠️ 必须在 import 存档层**之前**设好沙箱 —— `workflowsDir()` 在调用时读它，
 * 但把沙箱设在最前面最保险（与其它端到端测试一致）。 */
const HOME = mkdtempSync(join(tmpdir(), 'ewb-subwf-'))
process.env.EWB_TEST_HOME = HOME
mkdirSync(join(HOME, 'workflows'), { recursive: true })

const { runWorkflowFile } = await import('../src/workflow/run-file.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
const { saveWorkflow } = await import('../src/workflow/store.ts')

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== 「跑另一份工作流」节点（flow.workflow）===')
console.log('沙箱：' + HOME)
console.log('')

/**
 * 派发桩：按节点类型给假输出，并记下每一次调用。
 * @param {Set<string>} calls - 调用记录。
 * @returns {Function} 派发函数。
 */
function stub(calls) {
  return async (req) => {
    const type = String(req.command?.node ?? req.nodeId)
    calls.add(req.nodeId)
    return { ok: true, status: 'success', output: { node: req.nodeId, type, upstream: req.context.upstream } }
  }
}

/**
 * 造一份最简工作流：起点 `code.js`，可选地在后面接一个 `flow.workflow`。
 * @param {string} name - 存档名。
 * @param {object|null} sub - `{ name }` 或用 null 表示不接子工作流节点。
 * @returns {object} 存档对象。
 */
function makeDoc(name, sub) {
  const nodes = [
    { id: 'a', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return "A"' }, onError: 'stop' },
  ]
  const edges = []
  if (sub !== null) {
    nodes.push({
      id: 'b', type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 },
      params: { name: sub.name }, onError: sub.onError ?? 'stop',
    })
    edges.push({ id: 'e1', source: 'a', target: 'b', targetHandle: 'in' })
  }
  return { version: 1, name, nodes, edges }
}

/* ── ① 正常路径：子工作流跑通，父流程继续 ───────────────────────── */
console.log('① 子工作流跑通（父流程往下走）')
{
  await saveWorkflow({ version: 1, name: '子流程', nodes: [{ id: 's1', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' }], edges: [] }, '子流程', {})
  await saveWorkflow(makeDoc('父流程', { name: '子流程' }), '父流程', {})

  const calls = new Set()
  const res = await runWorkflowFile('父流程', NODE_LIBRARY, stub(calls), { workdir: HOME })
  check('父流程整体成功', res.ok === true && res.aborted === false, res.error ?? '')
  check('父流程两个节点都跑了', res.ran.length === 2 && res.ran.includes('a') && res.ran.includes('b'), res.ran.join(','))
  check('起点 a 被派发过', calls.has('a'), [...calls].join(','))
  /* ⚠️ `b`（flow.workflow 那个节点）**不该**出现在派发记录里 ——
   * 它由调度器解释执行（照 flow.loop），不是「派发一个节点」那类东西。
   * 第一版我把它也写进了这里，于是断言假红。 */
  check('子工作流那个节点不经过派发器（是调度器解释的）', !calls.has('b'), [...calls].join(','))
  check('子工作流里的 s1 也跑了（它不在父流程的 ran 里）', calls.has('s1'), [...calls].join(','))
}

/* ── ② 不把上游数据带进子工作流 ─────────────────────────────────── */
console.log('')
console.log('② 子工作流的起点拿不到父流程的上游数据（bat 的 call 是纯顺序）')
{
  /* 父流程 a → b(子工作流)。子工作流的起点是 s1，它没有入边 ——
   * 若我们错误地把父流程的 upstream 传进去，s1 的 upstream 就不为空。 */
  const seen = []
  const spy = async (req) => {
    seen.push({ id: req.nodeId, upstream: req.context.upstream, workflowId: req.context.workflowId })
    return { ok: true, status: 'success', output: { node: req.nodeId } }
  }
  await runWorkflowFile('父流程', NODE_LIBRARY, spy, { workdir: HOME })
  const s1 = seen.find(x => x.id === 's1')
  check('子工作流的起点被派发过', s1 !== undefined)
  if (s1 !== undefined) {
    check('它的 upstream 是空的', Array.isArray(s1.upstream) && s1.upstream.length === 0, JSON.stringify(s1.upstream))
  }
  const b = seen.find(x => x.id === 'b')
  check('父流程那一环没被派发（它是调度器解释的，不走派发器）', b === undefined,
    '派发过的：' + seen.map(x => x.id).join(','))
  check('子工作流的上下文用的是子工作流自己的名字',
    s1 !== undefined && s1.workflowId === '子流程', s1 === undefined ? '' : String(s1.workflowId))
}

/* ── ③ 名字没填 / 名字写错 ─────────────────────────────────────── */
console.log('')
console.log('③ 参数不对时明确报错（不静默跳过）')
{
  /* ⚠️ 这里要看的是 **`aborted` + 日志里的原因**，不是 `ok`：
   * `RunFileResult.ok` 的语义是「这份档读得出来、真的跑了」——
   * 跑起来之后中途失败，`ok` 照样是 `true`，失败体现在 `aborted: true` 与事件里。
   * 第一版我把断言写成 `ok === false`，于是**假红**（功能是好的，断言写错了）。 */
  const lines = []
  const spyLog = (nodeId, line) => { lines.push(line) }

  await saveWorkflow(makeDoc('没填名字', { name: '' }), '没填名字', {})
  const res = await runWorkflowFile('没填名字', NODE_LIBRARY, stub(new Set()), { workdir: HOME, onLog: spyLog })
  check('名字没填 → 整份中断', res.aborted === true, JSON.stringify({ ok: res.ok, aborted: res.aborted }))
  check('名字没填 → 报出了原因（不是静默跳过）',
    lines.some(l => l.includes('没填要跑哪份工作流')), lines.join(' | '))

  await saveWorkflow({ version: 1, name: '空壳', nodes: [{ id: 'x', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' }], edges: [] }, '空壳', {})
  await saveWorkflow(makeDoc('名字写错', { name: '根本没有这份' }), '名字写错', {})
  const res2 = await runWorkflowFile('名字写错', NODE_LIBRARY, stub(new Set()), { workdir: HOME })
  check('名字写错 → 报「没有这份工作流」（可读，不是崩了）',
    res2.aborted === true, JSON.stringify({ ok: res2.ok, aborted: res2.aborted }))
}

/* ── ④ 子工作流失败 → 父流程按失败策略处理 ───────────────────────── */
console.log('')
console.log('④ 子工作流失败时父流程的表现')
{
  /* 让子工作流里那个节点失败：派发桩对它返回失败。 */
  await saveWorkflow({ version: 1, name: '会失败的子流程', nodes: [{ id: 'bad', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'x' }, onError: 'stop' }], edges: [] }, '会失败的子流程', {})
  await saveWorkflow(makeDoc('父流程2', { name: '会失败的子流程' }), '父流程2', {})

  const failing = async (req) => (req.nodeId === 'bad'
    ? { ok: false, status: 'failed', error: '子流程里这个节点炸了' }
    : { ok: true, status: 'success', output: {} })

  const res = await runWorkflowFile('父流程2', NODE_LIBRARY, failing, { workdir: HOME })
  check('父流程被判为中断', res.aborted === true && res.ok === true, JSON.stringify({ ok: res.ok, aborted: res.aborted }))
  check('父流程的 a 跑过、b 也进去过（b 记在 ran 里）', res.ran.includes('a'), res.ran.join(','))

  /* onError: 'continue' 时父流程要继续往下走。 */
  await saveWorkflow(makeDoc('父流程3', { name: '会失败的子流程', onError: 'continue' }), '父流程3', {})
  const res3 = await runWorkflowFile('父流程3', NODE_LIBRARY, failing, { workdir: HOME })
  check('策略为「继续」时父流程不中断', res3.aborted === false, JSON.stringify({ aborted: res3.aborted }))
}

/* ── ⑤ 套娃上限（互相调用必须被拦下）───────────────────────────── */
console.log('')
console.log('⑤ 套娃保护（A 调 A / A 调 B 调 A）')
{
  /* 自己调自己：必须明确报错，而不是一直转下去。 */
  await saveWorkflow({ version: 1, name: '自恋', nodes: [{ id: 'self', type: 'v1', defId: 'flow.workflow', position: { x: 0, y: 0 }, params: { name: '自恋' }, onError: 'stop' }], edges: [] }, '自恋', {})

  const t0 = Date.now()
  const res = await runWorkflowFile('自恋', NODE_LIBRARY, stub(new Set()), { workdir: HOME })
  const ms = Date.now() - t0
  check('自己调自己 → 被拦下（不是一直转）', res.ok === false || res.aborted === true,
    JSON.stringify({ ok: res.ok, aborted: res.aborted, ms }))
  check('拦下得很快（说明没真的递归到底）', ms < 5000, String(ms) + 'ms')

  /* 互相调用：A → B → A。 */
  await saveWorkflow({ version: 1, name: '环B', nodes: [{ id: 'b1', type: 'v1', defId: 'flow.workflow', position: { x: 0, y: 0 }, params: { name: '环A' }, onError: 'stop' }], edges: [] }, '环B', {})
  await saveWorkflow({ version: 1, name: '环A', nodes: [{ id: 'a1', type: 'v1', defId: 'flow.workflow', position: { x: 0, y: 0 }, params: { name: '环B' }, onError: 'stop' }], edges: [] }, '环A', {})
  const res2 = await runWorkflowFile('环A', NODE_LIBRARY, stub(new Set()), { workdir: HOME })
  check('互相调用 → 被拦下', res2.ok === false || res2.aborted === true,
    JSON.stringify({ ok: res2.ok, aborted: res2.aborted }))
}

/* ── ⑥ 节点定义本身 ─────────────────────────────────────────────── */
console.log('')
console.log('⑥ 节点定义（在节点库里、名字对得上）')
{
  const def = NODE_LIBRARY.find(d => d.id === 'flow.workflow')
  check('节点库里真有 flow.workflow', def !== undefined)
  if (def !== undefined) {
    /* ⚠️ **2026-10-19 改判据**：参数键从 `name` 换成了 `workflowId`
     * （用户：「引用用的应该是编号而不是名称」）。这里查的必须是
     * **执行层真读的那个键** —— 继续查旧名字会假绿（控件没了也照样通过）。 */
    check('它有「跑哪一份」参数（存编号）', (def.paramDefs ?? []).some(p => p.key === 'workflowId'), (def.paramDefs ?? []).map(p => p.key).join(','))
    const idDef = (def.paramDefs ?? []).find(p => p.key === 'workflowId')
    check('★ 它是「选一份工作流」的控件（不是自由文本）', idDef?.kind === 'workflowRef', String(idDef?.kind))
    check('它有「传给它的输入」参数', (def.paramDefs ?? []).some(p => p.key === 'inputs'), (def.paramDefs ?? []).map(p => p.key).join(','))
    check('它有进出端口（与循环不同）', def.inputs.length === 1 && def.outputs.length === 1,
      String(def.inputs.length) + '入/' + String(def.outputs.length) + '出')
    check('默认失败策略是 stop', def.onError === 'stop', String(def.onError))
  }
}

/* ── ⑦ 按编号引用：改名不断引用（用户 2026-10-19 的要求）───────────── */
console.log('')
console.log('⑦ 引用认编号，不认名字')
{
  const { deriveWorkflowId } = await import('../src/workflow/ids.ts')
  const { loadWorkflow } = await import('../src/workflow/store.ts')

  /* 子流程存一份带编号的：编号按「老名字」派生（与生成器同一条规则）。 */
  const subId = deriveWorkflowId('老名字子流程')
  await saveWorkflow({
    version: 1, id: subId, name: '老名字子流程',
    nodes: [{ id: 's9', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 9' }, onError: 'stop' }],
    edges: [],
  }, '老名字子流程', {})

  /* 父流程引用**编号**。 */
  const parent = {
    version: 1, name: '按编号调用',
    nodes: [{ id: 'w1', type: 'v1', defId: 'flow.workflow', position: { x: 0, y: 0 }, params: { workflowId: subId }, onError: 'stop' }],
    edges: [],
  }
  await saveWorkflow(parent, '按编号调用', {})
  const calls = new Set()
  const r1 = await runWorkflowFile('按编号调用', NODE_LIBRARY, stub(calls), { workdir: HOME })
  check('★ 按编号能跑到子流程', r1.aborted === false && calls.has('s9'), JSON.stringify({ aborted: r1.aborted, calls: [...calls] }))

  /* ★ 改名（= 用新名存一份、删旧的，与列表页的「改名」同一套动作）：
   * 编号跟着文件走 → 父流程**一个字都不用改**就还能跑到它。 */
  const saved = await loadWorkflow('老名字子流程')
  await saveWorkflow(saved, '改过名的子流程', {})
  const { deleteWorkflow } = await import('../src/workflow/store.ts')
  await deleteWorkflow('老名字子流程', {})
  const calls2 = new Set()
  const r2 = await runWorkflowFile('按编号调用', NODE_LIBRARY, stub(calls2), { workdir: HOME })
  check('★ 子流程改名之后，父流程照样跑到它（引用没断）',
    r2.aborted === false && calls2.has('s9'), JSON.stringify({ aborted: r2.aborted, calls: [...calls2], err: r2.error }))

  /* 老写法（只给名字）仍然能跑 —— 兼容层不能因为改成编号就消失。 */
  const legacy = {
    version: 1, name: '按名字调用',
    nodes: [{ id: 'w2', type: 'v1', defId: 'flow.workflow', position: { x: 0, y: 0 }, params: { name: '改过名的子流程' }, onError: 'stop' }],
    edges: [],
  }
  await saveWorkflow(legacy, '按名字调用', {})
  const calls3 = new Set()
  const r3 = await runWorkflowFile('按名字调用', NODE_LIBRARY, stub(calls3), { workdir: HOME })
  check('★ 老存档（参数里还是名字）照样能跑', r3.aborted === false && calls3.has('s9'),
    JSON.stringify({ aborted: r3.aborted, calls: [...calls3], err: r3.error }))

  /* 编号写错 → 明确报错，且报错里带的是**编号**（用户要用编号排查）。 */
  const bad = {
    version: 1, name: '编号写错',
    nodes: [{ id: 'w3', type: 'v1', defId: 'flow.workflow', position: { x: 0, y: 0 }, params: { workflowId: 'wf-nope' }, onError: 'stop' }],
    edges: [],
  }
  await saveWorkflow(bad, '编号写错', {})
  const lines = []
  const r4 = await runWorkflowFile('编号写错', NODE_LIBRARY, stub(new Set()), { workdir: HOME, onLog: (n, l) => lines.push(l) })
  check('编号写错 → 明确报错（不静默）', r4.aborted === true, JSON.stringify({ ok: r4.ok, aborted: r4.aborted }))
  check('报错里带着那个编号（好让人对着查）', lines.some(l => l.includes('wf-nope')), lines.join(' | '))
}

/* ── ⑧ 父子同名节点不撞车（2026-10-23，契约 E）─────────────────────────
 *
 * ## 这条 bug 长什么样（用户实际遇到）
 *
 * 跑「全部下载」时：父流程的「② 跑取数-天猫生意参谋」那个节点显示成**失败**，
 * 标题变成「①b 打开罗盘首页（查登录用）」—— 那是**抖音子流程**里的节点。
 * 根因是收集层只按裸 nodeId 归并，而子流程的节点 id 各自从 `n1` 起，必然重名。
 *
 * 所以这里造一份**故意同名**的父子（都用 `n3`），钉住两件事：
 *   ① 事件带 `depth`：父节点 0、子流程节点 1（再深一层就 2）；
 *   ② `nodeKeyOf` 算出来的键**不相等** —— 收集层照它归并就不会合并。 */
console.log('')
console.log('⑧ 父子同名节点靠 depth 与 nodeKeyOf 分开（不撞车）')
{
  const { nodeKeyOf } = await import('../src/workflow/run.ts')

  /* 子流程只有 n3 一个节点（故意的：与父流程的 n3 同名）。 */
  await saveWorkflow({
    version: 1, name: '同名子流程',
    nodes: [{ id: 'n3', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 3' }, onError: 'stop' }],
    edges: [],
  }, '同名子流程', {})

  /* 父流程也用一个叫 n3 的节点，再接一个 n4 去跑子流程。 */
  await saveWorkflow({
    version: 1, name: '同名父流程',
    nodes: [
      { id: 'n3', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' },
      { id: 'n4', type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 }, params: { name: '同名子流程' }, onError: 'stop' },
    ],
    edges: [{ id: 'e1', source: 'n3', target: 'n4', targetHandle: 'in' }],
  }, '同名父流程', {})

  const events = []
  const res = await runWorkflowFile('同名父流程', NODE_LIBRARY, stub(new Set()), {
    workdir: HOME,
    onEvent: (e) => { events.push(e) },
  })
  check('这份工作流跑通了（不然下面的事件不全）', res.aborted === false, res.error ?? '')

  /* ⚠️ 判据要用 `started` / `success`（**节点级**事件），不用 `log`：
   * 日志里也混着流程级提示，逐条判层级容易误伤。 */
  const started = events.filter(e => e.kind === 'started')
  const parentN3 = started.find(e => e.nodeId === 'n3' && e.depth === 0)
  const childN3 = started.find(e => e.nodeId === 'n3' && e.depth === 1)
  check('★ 父流程的 n3 事件 depth = 0', parentN3 !== undefined,
    started.map(e => e.nodeId + '@' + String(e.depth)).join(', '))
  check('★ 子流程的 n3 事件 depth = 1', childN3 !== undefined,
    started.map(e => e.nodeId + '@' + String(e.depth)).join(', '))

  /* 父流程自己那两个节点（n3 / n4）。⚠️ 不能简单按 id 过滤 —— 子流程也有个 n3，
   * 第一版写成 `filter(nodeId === 'n3' || 'n4')` 把子流程那条也算进来了，假红一次。
   * 正确的判据：
   *   · `n4` 只存在于父流程 → 它出现的每一层都必须是 0；
   *   · `n3` 在父层**恰好一次**（子层另有一条，那是应该的）。 */
  const n4Events = started.filter(e => e.nodeId === 'n4')
  check('★ 只属于父流程的 n4 一律 depth = 0',
    n4Events.length > 0 && n4Events.every(e => e.depth === 0),
    n4Events.map(e => e.nodeId + '@' + String(e.depth)).join(', '))
  check('★ 父层的 n3 恰好一条（子层那条另算）',
    started.filter(e => e.nodeId === 'n3' && e.depth === 0).length === 1,
    started.filter(e => e.nodeId === 'n3').map(e => 'n3@' + String(e.depth)).join(', '))

  /* ★ 核心：同名节点的键必须不同（收集层照这个归并才不会合并）。 */
  const kp = nodeKeyOf(0, 'n3')
  const kc = nodeKeyOf(1, 'n3')
  check('★★ 父子同名的 n3 键不相等', kp !== kc, kp + ' vs ' + kc)
  check('★ 顶层键不带前缀（与老记录逐字一致）', kp === 'n3', kp)
  check('★ depth 缺省按 0（老调用方不用改）', nodeKeyOf(undefined, 'n3') === kp, nodeKeyOf(undefined, 'n3'))
  check('★ 非法 depth 也按 0', nodeKeyOf(-3, 'n3') === kp && nodeKeyOf(Number.NaN, 'n3') === kp)
  /* 反过来：不同层的同名不同键，但同层同名**必须**同键（否则同一次运行里
   * 同一个节点会散成好几条明细）。 */
  check('★ 同层同名仍然是同一个键', nodeKeyOf(1, 'n3') === nodeKeyOf(1, 'n3'))
  check('★ 不同节点 id 在同一层也不撞', nodeKeyOf(1, 'n3') !== nodeKeyOf(1, 'n4'))

  /* ★ 老行为不退：不关心 depth 的老调用方读到的字段一个字没变。 */
  const anyEvent = started[0]
  check('★ 老的字段照旧在（nodeId / label / executor）',
    typeof anyEvent?.nodeId === 'string' && typeof anyEvent?.label === 'string' && typeof anyEvent?.executor === 'string',
    JSON.stringify(anyEvent))
}

/* ── ⑨ 子流程沿用父流程选的模型（`__model` 继承，2026-10-23，计划 §2.6）───
 *
 * ## 这一条守的是「链路断在半路」那种错
 *
 * 父流程开始节点选了模型，子流程自己没选 —— 用户期望沿用父流程那个。
 * 而 `resolveInputs` 的纪律是「只认声明过的字段，其余一律丢掉」：
 * 子流程没把 `__model` 写进「输入项」，于是它**会被静默丢掉**，子流程走回落链。
 * 症状是「父流程明明选了模型，子流程却用了默认」—— 不报错、只是不对。
 *
 * ## 怎么观测（不能用「子流程的日志」——那里被特意剥掉了）
 *
 * `__model` 特意**不给用户看**（不进输入日志、不进开始节点输出、条件判断里也选不到）。
 * 所以唯一诚实的观测点是**父流程交给子流程的那一次 `inputs`** ——
 * 那正是本条要钉的那一次传递，不多不少。用 `runGraph` 的 `runWorkflow` 拦它。 */
console.log('')
console.log('⑨ 子流程沿用父流程选的模型（__model 继承）')
{
  const { MODEL_KEY } = await import('../src/workflow/variables.ts')
  const { runGraph } = await import('../src/workflow/run.ts')
  const { toRunSpecsFromCanvas } = await import('../src/workflow/specs.ts')
  const { loadWorkflow } = await import('../src/workflow/store.ts')

  /** 子流程只有普通节点，**自己不选模型**。 */
  await saveWorkflow({
    version: 1, name: '不选模型的子流程',
    nodes: [{ id: 'x1', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' }],
    edges: [],
  }, '不选模型的子流程', {})

  /**
   * 造一份「开始节点型号 = model，后面接子工作流」的父流程并跑一遍。
   * @param {string} name - 存档名。
   * @param {string} model - 开始节点上填的模型（空串 = 不选）。
   * @returns {object|null} 父流程交给子流程的那份 inputs。
   */
  async function runParentAndCapture(name, model) {
    await saveWorkflow({
      version: 1, name,
      nodes: [
        {
          id: 'p1', type: 'v1', defId: 'flow.start', position: { x: 0, y: 0 },
          /* `fields` 空 → 父流程没有用户输入，走「原样透传本层输入」那条路。 */
          params: { type: 'manual', fields: [], model }, onError: 'stop',
        },
        {
          id: 'p2', type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 },
          params: { name: '不选模型的子流程' }, onError: 'stop',
        },
      ],
      edges: [{ id: 'e1', source: 'p1', target: 'p2', targetHandle: 'in' }],
    }, name, {})
    const doc = await loadWorkflow(name)
    const specs = toRunSpecsFromCanvas(
      doc.nodes.map(n => ({
        id: n.id,
        ...n.parentId === undefined ? {} : { parentId: n.parentId },
        data: { def: NODE_LIBRARY.find(d => d.id === n.defId), params: n.params, onError: n.onError, skipped: n.skipped === true },
      })),
      doc.edges,
    )
    let handed = null
    await runGraph(
      {
        nodes: specs.nodes, edges: specs.edges, workdir: HOME,
        /* ⚠️ `runWorkflow` 是 **`RunGraphInput` 的字段**，不是第三参（options）。
         * 放错地方不报错，只会「跑子工作流时发现没有这个能力」而失败 —— 第一版就栽在这。 */
        runWorkflow: async (_ref, _signal, inputs) => { handed = inputs ?? {}; return { ok: true, ran: ['x1'] } },
      },
      async () => ({ ok: true, status: 'success', output: {}, logs: [] }),
      { onEvent: () => { /* 不要日志 */ } },
    )
    return handed
  }

  const withModel = await runParentAndCapture('选了模型的父流程', 'deepseek-official/deepseek-v4-flash')
  check('★★ 父流程选了模型 → 交给子流程的 inputs 里有 __model',
    withModel !== null && withModel[MODEL_KEY] === 'deepseek-official/deepseek-v4-flash',
    JSON.stringify(withModel))
  /* 反向：不该「顺手把整个运行现场塞进去」—— 父流程没有用户输入，就只该有 __model。 */
  check('★ 除 __model 外没有别的键被塞进子流程',
    withModel !== null && Object.keys(withModel).join(',') === MODEL_KEY,
    JSON.stringify(Object.keys(withModel ?? {})))

  /* 再反向一次：父流程**没选**模型时，不许凭空造一个 `__model` 传下去。 */
  const noModel = await runParentAndCapture('没选模型的父流程', '')
  check('★★ 父流程没选模型时，不凭空造 __model',
    noModel !== null && !(MODEL_KEY in noModel), JSON.stringify(noModel))

  /* ★★ 最关键的一条：**子流程自己收到了 `__model`，并继续往下传**。
   *
   * 上面那条只证明「父流程把它交出去了」—— 交出去不等于子流程收得下。
   * `resolveInputs` 的纪律是「只认声明过的字段，其余一律丢掉」，而子流程**没**声明
   * `__model`；所以这一条必须单独验：造一份**自己还要再调孙流程**的子流程，
   * 直接以 `inputs: { __model }` 跑它，看它交给孙流程的那一份里有没有。
   *
   * 这是「子流程的 resolvedInputs 里读得到」最诚实的观测点 —— 因为它读得到，
   * 才会出现在它往下交的那一份里。把 `run.ts` 的 `reservedKeysOf(input.inputs)` 去掉，
   * 这条就会红。 */
  await saveWorkflow({
    version: 1, name: '孙流程',
    nodes: [{ id: 'g1', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 9' }, onError: 'stop' }],
    edges: [],
  }, '孙流程', {})
  await saveWorkflow({
    version: 1, name: '还要再调孙流程的子流程',
    nodes: [
      /* 自己也放一个开始节点，但**不选模型** —— 靠继承。 */
      { id: 'c1', type: 'v1', defId: 'flow.start', position: { x: 0, y: 0 }, params: { type: 'manual', fields: [], model: '' }, onError: 'stop' },
      { id: 'c2', type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 }, params: { name: '孙流程' }, onError: 'stop' },
    ],
    edges: [{ id: 'e1', source: 'c1', target: 'c2', targetHandle: 'in' }],
  }, '还要再调孙流程的子流程', {})
  const childDoc = await loadWorkflow('还要再调孙流程的子流程')
  const childSpecs = toRunSpecsFromCanvas(
    childDoc.nodes.map(n => ({
      id: n.id,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      data: { def: NODE_LIBRARY.find(d => d.id === n.defId), params: n.params, onError: n.onError, skipped: n.skipped === true },
    })),
    childDoc.edges,
  )
  let handedToGrand = null
  await runGraph(
    {
      nodes: childSpecs.nodes, edges: childSpecs.edges, workdir: HOME,
      /* 子流程「收到」的那一份：父流程交下来的 `__model`。 */
      inputs: { [MODEL_KEY]: 'deepseek-official/deepseek-v4-flash' },
      runWorkflow: async (_ref, _signal, inputs) => { handedToGrand = inputs ?? {}; return { ok: true, ran: ['g1'] } },
    },
    async () => ({ ok: true, status: 'success', output: {}, logs: [] }),
    { onEvent: () => { /* 不要日志 */ } },
  )
  check('★★ 子流程收到了 __model，并继续交给孙流程',
    handedToGrand !== null && handedToGrand[MODEL_KEY] === 'deepseek-official/deepseek-v4-flash',
    JSON.stringify(handedToGrand))

  /* 子流程自己的开始节点选了模型 → **它自己那个**说了算（覆盖继承来的）。 */
  await saveWorkflow({
    version: 1, name: '自己选了模型的子流程',
    nodes: [
      { id: 'y1', type: 'v1', defId: 'flow.start', position: { x: 0, y: 0 }, params: { type: 'manual', fields: [], model: 'vendor/own-model' }, onError: 'stop' },
      { id: 'y2', type: 'v1', defId: 'code.js', position: { x: 200, y: 0 }, params: { code: 'return 2' }, onError: 'stop' },
    ],
    edges: [{ id: 'e1', source: 'y1', target: 'y2' }],
  }, '自己选了模型的子流程', {})
  await saveWorkflow({
    version: 1, name: '调自己选了模型的子流程',
    nodes: [
      { id: 'z1', type: 'v1', defId: 'flow.start', position: { x: 0, y: 0 }, params: { type: 'manual', fields: [], model: 'parent/model' }, onError: 'stop' },
      { id: 'z2', type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 }, params: { name: '自己选了模型的子流程' }, onError: 'stop' },
    ],
    edges: [{ id: 'e2', source: 'z1', target: 'z2', targetHandle: 'in' }],
  }, '调自己选了模型的子流程', {})
  /* 这一份走真跑：子流程那次 `runGraph` 会把继承来的 `__model` 和它自己选的那个合并，
   * 我们只验「跑得通、不报错」—— 覆盖规则本身在 `run.ts` 里由 `ownModel` 那几行保证，
   * 且 `start-end-params` ③ 已钉住「自己的模型优先」。 */
  const ownRun = await runWorkflowFile('调自己选了模型的子流程', NODE_LIBRARY, stub(new Set()), { workdir: HOME })
  check('★ 子流程自己也选了模型时照常跑通（不因继承冲突而报错）', ownRun.aborted === false, ownRun.error ?? '')
}

/* ── ⑩ 浏览器偏好逐层传下去（父 → 子 → 孙）────────────────────────
 *
 * 现场（用户 2026-10-23）：跑「全部下载」时 CDP 浏览器明明开着，却报
 * 「这一条要连一个已经开着的浏览器，但没有填调试端口」。
 *
 * 根因：`run-file.ts` 补端口只作用在**这一份**工作流的节点上，而子工作流是
 * 另一次 `runWorkflowFile` 调用 —— 那次没拿到 `prefs`，里面 `browser.act`
 * 的 `port` 就没人补。存档里的 `n5` 参数**本来就没有 `port`**（设计如此）。
 *
 * 这里钉三件事：
 *   ① 子工作流拿得到；
 *   ② **孙**工作流也拿得到（只验两层就说「递归没问题」是这次要避免的）；
 *   ③ 用户显式填过 `port` 的节点不被覆盖（既有语义不变）。
 *
 * 观测点选**派发时拿到的命令体**（`req.command.params.port`），不是存档 ——
 * 存档本来就没那个值，改了存档才是错的（`applyPrefsToSpecs` 是就地改内存里的规格）。 */
console.log('')
console.log('⑩ 浏览器偏好传到子 / 孙工作流（CDP 报「没填端口」的根因）')
{
  /* 一个浏览器节点，参数里**故意不写 `port`** —— 与真实存档同形。 */
  const browserNode = (id, x, extra = {}) => ({
    id, type: 'v1', defId: 'browser.act', position: { x, y: 0 },
    params: { action: 'goto', session: '默认', url: 'https://example.com/', ...extra },
    onError: 'stop',
  })

  await saveWorkflow({
    version: 1, name: '孙流程-浏览器',
    nodes: [browserNode('g1', 0)], edges: [],
  }, '孙流程-浏览器', {})
  await saveWorkflow({
    version: 1, name: '子流程-浏览器',
    nodes: [
      browserNode('c1', 0),
      { id: 'c2', type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 }, params: { name: '孙流程-浏览器' }, onError: 'stop' },
    ],
    edges: [{ id: 'e1', source: 'c1', target: 'c2', targetHandle: 'in' }],
  }, '子流程-浏览器', {})
  await saveWorkflow({
    version: 1, name: '父流程-浏览器',
    nodes: [
      browserNode('p1', 0),
      /* ③ 的对照：这一个**用户显式填过** `port`，不该被偏好覆盖。 */
      browserNode('p2', 150, { port: '9333' }),
      { id: 'p3', type: 'v1', defId: 'flow.workflow', position: { x: 300, y: 0 }, params: { name: '子流程-浏览器' }, onError: 'stop' },
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'p2', targetHandle: 'in' },
      { id: 'e2', source: 'p2', target: 'p3', targetHandle: 'in' },
    ],
  }, '父流程-浏览器', {})

  const ports = new Map()
  const portSpy = async (req) => {
    const p = req.command?.params?.port
    if (typeof p === 'string' || typeof p === 'number') ports.set(req.nodeId, String(p))
    return { ok: true, status: 'success', output: { node: req.nodeId } }
  }

  /* 与真实入口同形的偏好（宿主半从 `browser-prefs.json` 读到的那一份）。 */
  const PREFS = {
    defaultBrowserId: '',
    defaultSource: 'cdp',
    defaultPort: '9222',
    defaultOpenMode: 'headed',
    defaultLauncher: 'cdp',
    tags: {},
  }
  const res = await runWorkflowFile('父流程-浏览器', NODE_LIBRARY, portSpy, { workdir: HOME, prefs: PREFS })
  check('★★ 父流程照常跑通（补偏好不影响执行）', res.ok === true && res.aborted === false, res.error ?? '')

  check('★★ 父流程里的浏览器节点补到了端口', ports.get('p1') === '9222', ports.get('p1'))
  check('★★ 子工作流里的浏览器节点也补到了端口（根因所在）', ports.get('c1') === '9222', ports.get('c1'))
  check('★★ 孙工作流里的浏览器节点也补到了（递归成立，不是只传一层）', ports.get('g1') === '9222', ports.get('g1'))
  check('★★ 用户显式填过 port 的节点没被覆盖', ports.get('p2') === '9333', ports.get('p2'))

  /* 反向：同一个 `<prefs>` 逐层是**同一份**，不是各层重新读盘（那会中途漂）。 */
  check('★ 三层都补到，说明传的是同一份偏好（无一层自造）',
    ports.get('p1') === ports.get('c1') && ports.get('c1') === ports.get('g1'),
    [ports.get('p1'), ports.get('c1'), ports.get('g1')].join(' / '))

  /* 再反向：**不传 prefs 时一个都不补** —— 证明上面那些 9222 确实来自偏好，
   * 不是节点定义里的默认值（`port` 的默认是空串，见 `browser/act/node.ts`）。 */
  ports.clear()
  await runWorkflowFile('父流程-浏览器', NODE_LIBRARY, portSpy, { workdir: HOME })
  check('★★ 不传偏好时三层的 port 都是空的（9222 确实来自偏好）',
    ports.get('p1') === '' && ports.get('c1') === '' && ports.get('g1') === '',
    JSON.stringify([ports.get('p1'), ports.get('c1'), ports.get('g1')]))
}

/* ── ⑪ 中断后「没跑到」的节点在**每一层**都被收干净（契约 AB）──────────────
 *
 * ## 这一段守的是什么
 *
 * 真实存档 `全部下载.json` 那条记录里，**子层**留着 20 多个 `queued` 且全都没有
 * `startedAt` —— 一个都没跑，却一直显示「排队中」。根因是中断后没人把「排着队、
 * 这次不会跑」的节点撤掉。
 *
 * 引擎的补发在 `runGraph` 收尾，而子工作流是**另一次** `runGraph`，
 * 所以理论上每层各自收干净。**但「理论上」不算验过** —— 这里用三层嵌套
 * （父 → 子 → 孙）实测，逐层检查 `cancelled` 落在**自己那一层**（`depth` 对得上）。
 *
 * ## 为什么每一层都留一个「排在失败节点后面、永远没轮到」的节点
 *
 * 那正是要收干净的那批。若只在最里层放，外面两层就无从验起 ——
 * 而用户看到的乱象恰恰横跨三层。 */
console.log('')
console.log('⑪ 中断后没跑到的节点在每一层都收到 cancelled（三层嵌套）')
{
  const codes = (id, code) => ({ id, type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code }, onError: 'stop' })
  const calls = (id, name) => ({ id, type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 }, params: { name }, onError: 'stop' })

  await saveWorkflow({
    version: 1, name: 'AB孙流程',
    nodes: [codes('g1', 'return 1'), codes('g2', 'boom'), codes('g3', 'return 3')],
    edges: [{ id: 'e1', source: 'g1', target: 'g2' }, { id: 'e2', source: 'g2', target: 'g3' }],
  }, 'AB孙流程', {})
  await saveWorkflow({
    version: 1, name: 'AB子流程',
    nodes: [codes('s1', 'return 1'), calls('s2', 'AB孙流程'), codes('s3', 'return 3')],
    edges: [{ id: 'e1', source: 's1', target: 's2' }, { id: 'e2', source: 's2', target: 's3' }],
  }, 'AB子流程', {})
  await saveWorkflow({
    version: 1, name: 'AB父流程',
    nodes: [codes('p1', 'return 1'), calls('p2', 'AB子流程'), codes('p3', 'return 3')],
    edges: [{ id: 'e1', source: 'p1', target: 'p2' }, { id: 'e2', source: 'p2', target: 'p3' }],
  }, 'AB父流程', {})

  const events = []
  /* 只让孙流程中间那个炸：三层都会因此中断，每层都留下「没轮到」的节点。 */
  const boom = async (req) => (req.nodeId === 'g2'
    ? { ok: false, status: 'failed', error: '孙流程这一步炸了' }
    : { ok: true, status: 'success', output: { node: req.nodeId } })
  const res = await runWorkflowFile('AB父流程', NODE_LIBRARY, boom, {
    workdir: HOME,
    onEvent: (e) => { events.push(e) },
  })
  check('★ 前提：这份真中断了', res.aborted === true, JSON.stringify({ ok: res.ok, aborted: res.aborted }))

  /** 取某一层的 cancelled 节点 id。 */
  const cancelledAt = (d) => events.filter(e => e.kind === 'cancelled' && e.depth === d).map(e => e.nodeId).sort().join(',')
  check('★★ 父层（depth 0）没跑到的 p3 收到 cancelled', cancelledAt(0) === 'p3', cancelledAt(0))
  check('★★ 子层（depth 1）没跑到的 s3 收到 cancelled', cancelledAt(1) === 's3', cancelledAt(1))
  check('★★ 孙层（depth 2）没跑到的 g3 收到 cancelled', cancelledAt(2) === 'g3', cancelledAt(2))

  /* 反向：跑过的（含失败的那个）一个都不许被改写成「没跑」。 */
  const allCancelled = events.filter(e => e.kind === 'cancelled').map(e => e.nodeId)
  check('★★ 跑过的 p1 / p2 / s1 / s2 / g1 一个都没收到 cancelled',
    ['p1', 'p2', 's1', 's2', 'g1'].every(id => !allCancelled.includes(id)),
    allCancelled.join(','))
  check('★★ 失败的那个 g2 自己是 failed，不是 cancelled（别混成一个）',
    events.some(e => e.kind === 'failed' && e.nodeId === 'g2') && !allCancelled.includes('g2'),
    events.filter(e => e.kind === 'failed').map(e => e.nodeId).join(','))
  check('★ 三层各只补一条（没重复发）', allCancelled.length === 3, allCancelled.join(','))

  /* ── 反向：挂起（`flow.wait`）时一条 cancelled 都不许发 ─────────────
   *
   * 挂起不是中断：`aborted` 为假，那些「还没轮到」的节点**真的会继续跑**。
   * 这时发 `cancelled` 会把「等人点继续」误报成「没跑」，恢复后界面全对不上。 */
  await saveWorkflow({
    version: 1, name: 'AB挂起流程',
    nodes: [
      codes('w1', 'return 1'),
      {
        id: 'w2', type: 'v1', defId: 'flow.wait', position: { x: 200, y: 0 },
        params: { mode: 'duration', ms: 60000 }, onError: 'stop',
      },
      codes('w3', 'return 3'),
      codes('w4', 'return 4'),
    ],
    edges: [
      { id: 'e1', source: 'w1', target: 'w2' },
      { id: 'e2', source: 'w2', target: 'w3' },
      { id: 'e3', source: 'w3', target: 'w4' },
    ],
  }, 'AB挂起流程', {})
  const waitEvents = []
  const wres = await runWorkflowFile('AB挂起流程', NODE_LIBRARY, async () => ({ ok: true, status: 'success', output: {} }), {
    workdir: HOME,
    runId: 'ab-wait-1',
    workflowId: 'AB挂起流程',
    onEvent: (e) => { waitEvents.push(e) },
  })
  check('★ 前提：这份是挂起（不是中断）', wres.paused !== undefined && wres.aborted === false,
    JSON.stringify({ paused: wres.paused !== undefined, aborted: wres.aborted }))
  check('★★ 挂起时**一条 cancelled 都不许发**（那些节点恢复后会真的跑）',
    !waitEvents.some(e => e.kind === 'cancelled'),
    waitEvents.filter(e => e.kind === 'cancelled').map(e => e.nodeId).join(','))
}

/* ── ⑪b 跑成功时主动报一条（票 30 乙）────────────────────────────────
 *
 * ## 这一段守的是什么
 *
 * 「跑另一份工作流」这类节点原来**一句话都不报**。后果不是「记录里少一行」，
 * 而是 `records.ts:219` 那条「成功 + 没有产出声明 + 没有汇报 → 不写记录」：
 * 真实存档 `0一键更新`（`flow.start → flow.workflow ×2`）与 `全部下载`
 * （`flow.start → flow.if → flow.workflow → …`）跑成功了**彻底不留任务记录**。
 *
 * ## 判据挑在哪
 *
 * 不判「有汇报」——那句「完成」也能过。判**那句话里有没有可核对的量**：
 * 哪一份子工作流、跑了几个节点、成没成。
 *
 * ⚠️ 观测点选**引擎的事件流**（`onEvent`），不是 `runWorkflowFile` 的返回值：
 * 汇报走的是 `emit({kind:'report'})`，它只出现在事件流里，
 * 而落盘那一侧（`mergeNodeEvent` → `reports`）在 `run-history.mjs` 里另有验。 */
console.log('')
console.log('⑪b 跑成功 / 失败各报一条（票 30 乙）')
{
  const events = []
  const res = await runWorkflowFile('父流程', NODE_LIBRARY, stub(new Set()), {
    workdir: HOME,
    onEvent: (e) => { events.push(e) },
  })
  check('（前置）这一趟跑通了', res.ok === true && res.aborted === false, res.error ?? '')

  const reps = events.filter(e => e.kind === 'report')
  check('★★ 跑成功时推了一条汇报', reps.length === 1, JSON.stringify(reps.map(e => e.entry?.message)))
  /* 汇报必须挂在**这个节点**名下（`b` 是那份父流程里的 flow.workflow 节点）。 */
  check('★★ 汇报挂在自己这个节点名下', reps[0]?.nodeId === 'b', String(reps[0]?.nodeId))

  const msg = String(reps[0]?.entry?.message ?? '')
  console.log('   真实汇报：' + msg)
  /* ① 哪一份：⚠️ **不能把名字写死**。`saveWorkflow` 会把 `params.name` 迁成编号
   * （`migrateWorkflowRefs`），于是 `runSubWorkflow` 里 `shownRef` 取的是编号。
   * 所以判据改成「那句话里那个引用，就是存档里这份子工作流的编号」——
   * 换个写法（名字 / 编号）都不会误判，而「没写是哪一份」照样会红。 */
  const { deriveWorkflowId } = await import('../src/workflow/ids.ts')
  const SUB_ID = deriveWorkflowId('子流程')
  check('★★ 汇报里写着跑的是哪一份子工作流（引用对得上存档里那份）',
    msg.includes(SUB_ID) || msg.includes('子流程'), msg + ' / 期望引用 ' + SUB_ID)
  /* ② 跑了几个节点：子流程只有 s1 一个节点。 */
  check('★★ 汇报里写着跑了几个节点（1）', msg.includes('1'), msg)
  check('★ 节点数也在 metrics 里（可直接核对，不用解析句子）',
    reps[0]?.entry?.metrics?.nodes === 1, JSON.stringify(reps[0]?.entry?.metrics))
  /* ③ 成没成。 */
  check('★★ 汇报里写着成没成（成功）', msg.includes('成功'), msg)
  /* ④ 防空话：必须命中「数字 / 文件名 / 路径 / 成功失败」之一。 */
  const HAS_QUANTITY = /\d|个|条|成功|失败|跳过/.test(msg)
  check('★★ 这句话带业务量（不是「完成」那种空话）', HAS_QUANTITY && msg !== '完成', msg)

  /* ⑤ 汇报**不进 outputs**（纪律 1：下游 `{{变量}}` 取不到它）。 */
  check('★★ 汇报不进 outputs（节点输出仍是那个信号对象）',
    JSON.stringify(res).includes('"ran"'), '见上一段的返回结构')

  /* ── ⑥ 失败那一趟也报一条，且是 danger ─────────────────────────
   *
   * 纪律 3：「失败也要能汇报 —— 失败前推的那条要留着」，
   * 而失败这一刻报的往往正是最需要看的那条。 */
  const failEvents = []
  const failing = async (req) => (req.nodeId === 'bad'
    ? { ok: false, status: 'failed', error: '子流程里这个节点炸了' }
    : { ok: true, status: 'success', output: {} })
  await runWorkflowFile('父流程2', NODE_LIBRARY, failing, {
    workdir: HOME,
    onEvent: (e) => { failEvents.push(e) },
  })
  const failReps = failEvents.filter(e => e.kind === 'report')
  check('★★ 子工作流失败时也推了一条汇报', failReps.length === 1,
    JSON.stringify(failReps.map(e => e.entry?.message)))
  const failMsg = String(failReps[0]?.entry?.message ?? '')
  console.log('   失败那句：' + failMsg)
  check('★★ 失败那句写着失败与原因（不是笼统一句「没成」）',
    failMsg.includes('失败') && failMsg.includes('子流程里这个节点炸了'), failMsg)
  check('★ 失败那条的级别是 danger（界面上配红）', failReps[0]?.entry?.type === 'danger',
    String(failReps[0]?.entry?.type))
  /* 汇报必须**早于**这个节点自己的 failed 事件 —— 与 `run.ts` 里普通节点那段同一个顺序：
   * 汇报在成功 / 失败分叉之前发，界面才来得及把那条挂上去。
   *
   * ⚠️ 判据要**按 nodeId 收窄**：子工作流里那个失败节点（`bad`，depth 1）也会发一条
   * `failed`，而且它**必然早于**父层这一条 —— 拿全局下标比大小，比的是两件不同的事。 */
  const repAt = failEvents.findIndex(e => e.kind === 'report' && e.nodeId === 'b')
  const failAt = failEvents.findIndex(e => e.kind === 'failed' && e.nodeId === 'b')
  check('★★ 汇报早于本节点的 failed 事件（界面才挂得上去）', repAt >= 0 && failAt >= 0 && repAt < failAt,
    'report@' + String(repAt) + ' / failed@' + String(failAt))

  /* ── ⑦ 没跑到子流程时不许凭空冒一条汇报 ───────────────────────
   *
   * 「跳过」「未走的分支」这两种情况一句话都不该报 ——
   * 报了会让用户以为它跑过。 */
  const skipEvents = []
  await runWorkflowFile('没填名字', NODE_LIBRARY, stub(new Set()), {
    workdir: HOME,
    onEvent: (e) => { skipEvents.push(e) },
  })
  check('★★ 参数不对（没填哪一份）时一条汇报都不发',
    !skipEvents.some(e => e.kind === 'report'),
    JSON.stringify(skipEvents.filter(e => e.kind === 'report').map(e => e.entry?.message)))
}

/* ── ⑫ 失败原因能透到「整次运行」这一层（契约 AH）────────────────────────
 *
 * ## 这一段守的是什么
 *
 * 板块记录（`collect/`）只记整次运行、不记节点。而这条路以前只回
 * `aborted: true`，不回原因 —— 于是 4 条失败记录里一条 `error` 都没有。
 *
 * 三层都要验，缺一层就有一层是哑的：
 *   ① **子工作流**里失败 → 子层 `runWorkflowFile` 的 `res.error` 有值；
 *   ② **父层**拿到的不是子层那句原话，而是 `runSubWorkflow` 拼的那句
 *      「子工作流「xxx」失败：…」（它在父层看来是「一个节点失败了」）；
 *   ③ `runWorkflowFile` 的返回值透传（宿主半四处读的就是它）。
 *
 * ⚠️ ②的判据要**逐字**核那句话的形状，不能只判 `includes('失败')` ——
 * 那样「子工作流里有节点失败并中断了」这种笼统话也会通过。 */
console.log('')
console.log('⑫ 失败原因透到整次运行这一层（子层原话 / 父层拼句 / runWorkflowFile 透传）')
{
  const CHILD_REASON = '这一条要「连一个已经开着的浏览器」，但没有填调试端口。'
  await saveWorkflow({
    version: 1, name: 'AH失败子流程',
    nodes: [{ id: 'cbad', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'x' }, onError: 'stop' }],
    edges: [],
  }, 'AH失败子流程', {})
  await saveWorkflow({
    version: 1, name: 'AH失败父流程',
    nodes: [
      { id: 'pa', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' },
      { id: 'pb', type: 'v1', defId: 'flow.workflow', position: { x: 200, y: 0 }, params: { name: 'AH失败子流程' }, onError: 'stop' },
      { id: 'pc', type: 'v1', defId: 'code.js', position: { x: 400, y: 0 }, params: { code: 'return 3' }, onError: 'stop' },
    ],
    edges: [
      { id: 'e1', source: 'pa', target: 'pb', targetHandle: 'in' },
      { id: 'e2', source: 'pb', target: 'pc', targetHandle: 'in' },
    ],
  }, 'AH失败父流程', {})

  const failDispatch = async (req) => (req.nodeId === 'cbad'
    ? { ok: false, status: 'failed', error: CHILD_REASON }
    : { ok: true, status: 'success', output: { node: req.nodeId } })

  /* ① 子层：直接跑那份（它就是「子工作流那一层」）。
   * ② 父层：跑父流程，看它把子层的失败翻成了什么。 */
  const child = await runWorkflowFile('AH失败子流程', NODE_LIBRARY, failDispatch, { workdir: HOME })
  check('★ 前提：子层确实中断了', child.aborted === true, JSON.stringify({ ok: child.ok, aborted: child.aborted }))
  check('★★ 子层的返回值里带着那句原话',
    child.error === CHILD_REASON, String(child.error))

  const parent = await runWorkflowFile('AH失败父流程', NODE_LIBRARY, failDispatch, { workdir: HOME })
  check('★ 前提：父层也中断了', parent.aborted === true, JSON.stringify({ ok: parent.ok, aborted: parent.aborted }))
  check('★★ 父层带 error（不是又一个哑掉的 aborted）', typeof parent.error === 'string', JSON.stringify(parent.error))
  check('★★ 父层那句是「子工作流「谁」失败：子层原话」的形状',
    /^子工作流「[^」]+」失败：/.test(String(parent.error)), String(parent.error))
  check('★ 父层那句里带着子层的原话（不是笼统的「有节点失败」）',
    typeof parent.error === 'string' && parent.error.includes(CHILD_REASON), String(parent.error))
  /* ⚠️ 括起来那个「谁」**可能是编号而不是名字**（这条我刚踩过，写清楚免得下个人再踩）：
   * `saveWorkflow` 会把 `params.name` 迁成编号（`migrateWorkflowRefs`），于是
   * `runSubWorkflow` 里 `refId` 非空、`shownRef` 取的是编号。
   * 所以这条断言只能验**形状 + 子层原话在里面**，不能把名字写死 ——
   * 写死名字的话，验的是「存储层给没给编号」，与本次改动无关。 */

  /* ③ 成功时**没有** error 键（两个入口各一条）。 */
  await saveWorkflow({
    version: 1, name: 'AH成功子流程',
    nodes: [{ id: 'cok', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' }],
    edges: [],
  }, 'AH成功子流程', {})
  const okres = await runWorkflowFile('AH成功子流程', NODE_LIBRARY, async () => ({ ok: true, status: 'success', output: {} }), { workdir: HOME })
  check('★★ 成功跑完时 runWorkflowFile 的返回值里没有 error 键', !('error' in okres),
    JSON.stringify(Object.keys(okres)))
}

rmSync(HOME, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? '结论：跑另一份工作流全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
