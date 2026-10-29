/** 「整次运行」的历史记录（用户 m03287：「运行历史应该根据工作流做分组」）。
 *
 * ## 为什么要它
 *
 * 原有的 `/runs` 是**节点级**记录，一行一个节点 —— 跑一次工作流在列表里散成十几行。
 * 新增的这一层是「整次运行」：每次跑一份工作流记一条，点开才看节点明细。
 *
 * 这个测试盯**存储层**（`src/workflow/workflow-runs.ts`）的四件事：
 *   ① 按工作流分文件（分组是文件级的事，不必每次读全量再 group）；
 *   ② 新的在前 + 上限截断（不然文件会一直长大）；
 *   ③ 读坏了**不抛**（历史是附带能力，它坏不该让整个页面打不开）；
 *   ④ 日志按节点截断（一份大工作流的日志能上兆）。
 *
 * 全程在 `EWB_TEST_HOME` 沙箱里 —— **绝不碰真实数据目录**（红线）。
 */
const TN = 'run-history'
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const sandbox = await mkdtemp(join(tmpdir(), 'ewb-runs-'))
process.env.EWB_TEST_HOME = join(sandbox, 'home')

const {
  appendRun, loadRuns, clearRuns, listRunNames, runsDir, newRunId,
} = await import('../src/workflow/workflow-runs.ts')

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

console.log('=== 运行历史（整次运行层）===')

console.log('① 按工作流分文件（分组）')
{
  await appendRun({ id: 'r1', name: 'A', startedAt: 1000, ok: true, ran: ['n1'], nodes: [] })
  await appendRun({ id: 'r1', name: 'B', startedAt: 2000, ok: true, ran: ['n1'], nodes: [] })
  const a = await loadRuns('A')
  const b = await loadRuns('B')
  check('A 只有自己的 1 条', a.length === 1 && a[0].name === 'A', String(a.length))
  check('B 只有自己的 1 条', b.length === 1 && b[0].name === 'B', String(b.length))
  const names = await listRunNames()
  check('列出有记录的工作流（给分组切换条用）', names.sort().join(',') === 'A,B', names.join(','))
  check('目录名是 runs（与 workflows 同级）', runsDir().endsWith('runs'), runsDir())
}

console.log('')
console.log('② 新的在前 + 上限截断')
{
  for (let i = 0; i < 5; i++) {
    await appendRun({ id: 'x' + String(i), name: 'C', startedAt: 3000 + i, ok: true, ran: [], nodes: [] })
  }
  const c = await loadRuns('C')
  check('读回来是 5 条', c.length === 5, String(c.length))
  check('新的在前（第一条是最后追加的）', c[0].id === 'x4', c[0].id)
  /* 上限 60 —— 追加 70 次看会不会砍。 */
  for (let i = 0; i < 70; i++) {
    await appendRun({ id: 'y' + String(i), name: 'D', startedAt: 4000 + i, ok: true, ran: [], nodes: [] })
  }
  const d = await loadRuns('D')
  check('超过上限会截断（不无限长）', d.length === 60, String(d.length))
  check('留下的是最新的那批', d[0].id === 'y69', d[0].id)
}

console.log('')
console.log('③ 日志按节点截断（防一份大工作流把文件撑爆）')
{
  const many = Array.from({ length: 200 }, (_, i) => 'line ' + String(i))
  await appendRun({
    id: 'big', name: 'E', startedAt: 5000, ok: true, ran: ['n1'],
    nodes: [{ nodeId: 'n1', state: 'success', logs: many }],
  })
  const e = await loadRuns('E')
  const logs = e[0].nodes[0].logs ?? []
  check('每个节点的日志留 40 行', logs.length === 40, String(logs.length))
  check('留的是**最后**那 40 行（最新的才有用）', logs[logs.length - 1] === 'line 199', logs[logs.length - 1])
}

console.log('')
console.log('④ 读坏了不抛（历史是附带能力）')
{
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(runsDir(), { recursive: true })
  await writeFile(join(runsDir(), '坏档.json'), '{ 这不是 JSON', 'utf8')
  const bad = await loadRuns('坏档')
  check('内容坏掉时返回空数组（不是抛异常）', Array.isArray(bad) && bad.length === 0, String(bad.length))
  const none = await loadRuns('根本不存在')
  check('文件不存在时也返回空数组', Array.isArray(none) && none.length === 0)
}

console.log('')
console.log('⑤ 清空与 id 生成')
{
  check('清空返回成功', await clearRuns('C') === true)
  check('清空后读不到', (await loadRuns('C')).length === 0)
  check('清一份不存在的不报错', await clearRuns('根本没这份') === true)
  const id = newRunId(1750000000000)
  check('id 形如 日期-时间-随机', /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id), id)
  check('两次生成的 id 不同（同一毫秒也不撞）', newRunId(1750000000000) !== newRunId(1750000000000))
}

console.log('')
console.log('⑥ 模型痕迹（llm）落盘：二次截断、坏形状不连累记录、没有就不写这个键')
{
  const { readFile } = await import('node:fs/promises')
  const { TRACE_TEXT_PREVIEW } = await import('../src/dispatch/llm-trace.ts')

  /* ① 上游**故意漏截**（给 2000 字），落盘必须被截到上限。
   * 这是本段最重要的一条：`src/index.ts` 那层也截，但落盘这道闸是最后的保险。 */
  const long = 'x'.repeat(2000)
  await appendRun({
    id: 'llm1', name: 'F', startedAt: 6000, ok: true, ran: ['n1'],
    nodes: [{
      nodeId: 'n1', state: 'success',
      llm: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'stop',
        inputTokens: 120, outputTokens: 45,
        promptPreview: long, outputPreview: long,
      },
    }],
  })
  const f = await loadRuns('F')
  const line = f[0].nodes[0]
  check('★ 提示词摘要落盘时被截到上限', line.llm.promptPreview.length === TRACE_TEXT_PREVIEW,
    String(line.llm.promptPreview.length) + ' / 上限 ' + String(TRACE_TEXT_PREVIEW))
  check('★ 回答摘要落盘时也被截到上限', line.llm.outputPreview.length === TRACE_TEXT_PREVIEW,
    String(line.llm.outputPreview.length))
  check('★★ 截过了 → truncated 写 true（同步了）', line.llm.truncated === true, String(line.llm.truncated))
  check('token 数照旧带着', line.llm.inputTokens === 120 && line.llm.outputTokens === 45,
    String(line.llm.inputTokens) + '/' + String(line.llm.outputTokens))

  /* ② 没超上限 → **不写** `truncated` 键（不是写 false）。
   * 与 `LlmTrace.truncated` 的注释同一条纪律：少一个键就少一份要靠读代码才知道含义的状态。 */
  await appendRun({
    id: 'llm2', name: 'G', startedAt: 7000, ok: true, ran: ['n1'],
    nodes: [{
      nodeId: 'n1', state: 'success',
      llm: { provider: 'p', model: 'm', finish: 'stop', promptPreview: '短的', outputPreview: '也短' },
    }],
  })
  const g = await loadRuns('G')
  check('★ 没截就不写 truncated 键', !('truncated' in g[0].nodes[0].llm),
    JSON.stringify(g[0].nodes[0].llm))

  /* ③ 上游已标 truncated: true（它真截过），这里没有可截的也要保住这个标记。 */
  await appendRun({
    id: 'llm3', name: 'H', startedAt: 8000, ok: true, ran: ['n1'],
    nodes: [{
      nodeId: 'n1', state: 'success',
      llm: { provider: 'p', model: 'm', finish: 'stop', promptPreview: '短', truncated: true },
    }],
  })
  const h = await loadRuns('H')
  check('★ 上游标过 truncated 就保留（不被这里算没）', h[0].nodes[0].llm.truncated === true,
    String(h[0].nodes[0].llm.truncated))

  /* ④ **坏形状不能连累整条记录**。这里塞三种：非对象、缺必填、数组。 */
  const junk = [
    ['字符串', 'not-an-object'],
    ['缺 provider', { model: 'm', finish: 'stop' }],
    ['数组', [1, 2, 3]],
    ['数字', 42],
  ]
  for (const [why, bad] of junk) {
    const name = 'J-' + why
    const okSaved = await appendRun({
      id: 'llm4', name, startedAt: 9000, ok: true, ran: ['n1', 'n2'],
      nodes: [
        { nodeId: 'n1', state: 'success', llm: bad },
        { nodeId: 'n2', state: 'success' },
      ],
    })
    check('★ llm 坏了（' + why + '）记录照样落盘', okSaved === true, String(okSaved))
    const back = await loadRuns(name)
    check('★ 那条记录真的读得回来', back.length === 1 && back[0].nodes.length === 2,
      String(back.length) + ' 条 / ' + String(back[0]?.nodes?.length) + ' 个节点')
    check('★ 坏掉的 llm 被丢掉（不写这个键）', !('llm' in back[0].nodes[0]),
      JSON.stringify(back[0].nodes[0]))
    check('★ 同一份记录里另一个节点不受影响', back[0].nodes[1].state === 'success',
      back[0].nodes[1].state)
  }

  /* ⑤ 一条**不带** llm 的明细，落盘后不出现这个键（不是 null、不是 {}）。
   * 直接读**文件原文**判 —— 读回来再判 `'llm' in obj` 抓不到「写成了 null」。 */
  await appendRun({
    id: 'llm5', name: 'K', startedAt: 10000, ok: true, ran: ['n1'],
    nodes: [{ nodeId: 'n1', state: 'success' }],
  })
  const text = await readFile(join(runsDir(), 'K.json'), 'utf8')
  check('★★ 文件原文里根本没有 "llm" 这个键', !text.includes('"llm"'), text.slice(0, 200))
  const back = await loadRuns('K')
  check('★ 读回来也没有这个键', !('llm' in back[0].nodes[0]), JSON.stringify(back[0].nodes[0]))

  /* ⑥ 老记录（没有 llm / depth 字段）读回来不报错、字段一个不少。 */
  check('★ 老记录读回来不报错', f.length > 0 && h.length > 0)
  check('★ 老记录的原有字段照旧在', typeof line.nodeId === 'string' && line.state === 'success',
    JSON.stringify({ nodeId: line.nodeId, state: line.state }))
  /* ⑦ **失败**节点的痕迹也要能完整读回来（契约 B2）。
   *
   * `normalizeLlmLine` 只按 `llm` 的形状判，**不看 `state`** —— 这一条钉住它：
   * 一个 failed 的明细，痕迹该带的字段一个不少。 */
  await appendRun({
    id: 'llm6', name: 'L', startedAt: 11000, ok: false, aborted: true, ran: ['n1'],
    nodes: [{
      nodeId: 'n1', state: 'failed', error: '模型调用失败：速率超限',
      llm: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'error',
        inputTokens: 800, outputTokens: 0,
        promptPreview: '改一下标题', outputPreview: '',
      },
    }],
  })
  const l = await loadRuns('L')
  const fl = l[0].nodes[0]
  check('★ 失败状态的痕迹完整读得回来', fl.llm?.provider === 'deepseek-official'
    && fl.llm?.model === 'deepseek-v4-flash' && fl.llm?.finish === 'error',
    JSON.stringify(fl.llm))
  check('★ 失败的 trace 里 outputTokens 为 0 也保留（0 是实测值）', fl.llm?.outputTokens === 0,
    String(fl.llm?.outputTokens))
  check('★ 节点状态仍是 failed（痕迹没把它改掉）', fl.state === 'failed', fl.state)
  check('★ 失败原因照旧在', fl.error === '模型调用失败：速率超限', String(fl.error))
  check('★ 空串摘要不写这个键（与既有纪律一致）', !('outputPreview' in (fl.llm ?? {})),
    JSON.stringify(Object.keys(fl.llm ?? {})))
}

/* ── ⑦ 中断后「没跑到」的节点，记录里是 cancelled 而不是 queued（契约 AB）───
 *
 * ## 这一段守的是什么
 *
 * 用户原话：「报错了，但是后续还在执行。」—— 实际没执行。是**记录**把「排队中」
 * 当成了还在跑：引擎一开跑就把每个节点发成 `queued`，中断后没人撤，收不到事件
 * 的收集层就永远停在 `queued`。
 *
 * 引擎那边补发了 `cancelled`（`run.ts` 的收尾），这里钉**下游两段**：
 *   ① 收集层（`mergeNodeEvent`）收到它就改成 `cancelled`；
 *   ② 落盘再读回来还是 `cancelled` —— 不是被白名单挡住、也不是被写成 `queued`。
 *
 * ⚠️ ①②必须一起验：只验收集层的话，存储层不认这个值就白验了。 */
console.log('')
console.log('⑦ 中断后没跑到的节点：收集层认 cancelled、落盘也还是 cancelled')
{
  const { mergeNodeEvent } = await import('../src/index.ts')

  const byNode = new Map()
  /* 一段真实形状的事件流：三个节点排队 → 前两个跑过 → 第三个失败中断 → 后两个被撤。 */
  for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) {
    mergeNodeEvent(byNode, { kind: 'queued', nodeId: id, depth: 0 })
  }
  mergeNodeEvent(byNode, { kind: 'started', nodeId: 'n1', depth: 0, nodeLabel: '第一步', defId: 'code.js' })
  mergeNodeEvent(byNode, { kind: 'success', nodeId: 'n1', depth: 0 })
  mergeNodeEvent(byNode, { kind: 'started', nodeId: 'n2', depth: 0, nodeLabel: '第二步', defId: 'browser.act' })
  mergeNodeEvent(byNode, { kind: 'failed', nodeId: 'n2', depth: 0, error: '炸了' })
  mergeNodeEvent(byNode, { kind: 'aborted', nodeId: 'n2', depth: 0 })
  mergeNodeEvent(byNode, { kind: 'cancelled', nodeId: 'n3', depth: 0 })
  mergeNodeEvent(byNode, { kind: 'cancelled', nodeId: 'n4', depth: 0 })
  mergeNodeEvent(byNode, { kind: 'cancelled', nodeId: 'n5', depth: 0 })

  const lines = [...byNode.values()]
  check('★ 收集层认 cancelled（不是留在 queued）',
    lines.filter(l => l.state === 'cancelled').length === 3,
    JSON.stringify(lines.map(l => l.nodeId + ':' + l.state)))
  check('★★ 那条明细的 state 就是字符串 cancelled（与 NodeState 同一个词）',
    lines.find(l => l.nodeId === 'n3')?.state === 'cancelled',
    String(lines.find(l => l.nodeId === 'n3')?.state))
  check('★ 失败的那个仍是 failed（没被 cancelled 那条改掉）',
    lines.find(l => l.nodeId === 'n2')?.state === 'failed',
    String(lines.find(l => l.nodeId === 'n2')?.state))
  check('★ 没跑到的那些也写了 endedAt（界面按它算时长）',
    lines.find(l => l.nodeId === 'n3')?.endedAt !== undefined,
    JSON.stringify(lines.find(l => l.nodeId === 'n3')))
  check('★ 一个 queued 都不剩（正是用户看到的那一幕）',
    lines.every(l => l.state !== 'queued'),
    JSON.stringify(lines.map(l => l.nodeId + ':' + l.state)))

  /* ② 落盘 → 读回来。存储层若白名单挡住了这个值，这里会露出别的状态。 */
  const okSaved = await appendRun({
    id: 'ab1', name: 'AB', startedAt: 12000, ok: false, aborted: true, ran: ['n1', 'n2'],
    nodes: lines,
  })
  check('★ 这份记录落盘成功', okSaved === true, String(okSaved))
  const abBack = await loadRuns('AB')
  const abNodes = abBack[0]?.nodes ?? []
  check('★★ 读回来还是 cancelled（存储层没把它改成别的）',
    abNodes.filter(n => n.state === 'cancelled').length === 3,
    JSON.stringify(abNodes.map(n => n.nodeId + ':' + n.state)))
  check('★ 读回来 queued 与 cancelled 分得开（不是一律压成一个）',
    abNodes.find(n => n.nodeId === 'n1')?.state === 'success'
    && abNodes.find(n => n.nodeId === 'n3')?.state === 'cancelled',
    JSON.stringify(abNodes.map(n => n.nodeId + ':' + n.state)))
}

/* ── 三个启动入口的节点明细必须同形（契约 AJ）────────────────────
 *
 * ## 这一段守的是什么
 *
 * 实测过的真 bug：从**工作流列表**点「执行」，跑完的记录里 `nodes[]` 每一条都停在
 * `queued`（`runs/提示词优化.json` 的 `20261023-083041-mpr7`：`ok: true`、
 * `ran` 三个节点、`outputs` 2067 字，而 `nodes` 三条全是 `queued`）。
 *
 * 根因是三个入口里只有两个把节点事件交给了记录：
 *
 * | 入口 | 位置 | 有 `onEvent` |
 * | --- | --- | --- |
 * | 流式 | `src/index.ts` 的 SSE 那条 | 有 |
 * | 定时 | `src/schedule/runner.ts` | 有 |
 * | **列表** | `src/index.ts` 的 `/workflow/run` | **原来没有** |
 *
 * 那三处都在 `src/index.ts` / `runner.ts` 里，直接跑起来要起整套 HTTP + 真跑工作流；
 * 所以这一段用**读源码**的方式钉住「三处都传了 onEvent」，不假装跑过端到端。
 * 端到端那一层由 `schedule-notify`（定时）与画布那套（流式）各自覆盖。
 * ⚠️ 这不是偷懒的替代品，是这两处的**唯一**可行验法（列表那条要真跑一份工作流）。
 */
{
  const { readFileSync } = await import('node:fs')
  const root = new URL('../src/', import.meta.url)
  const idx = readFileSync(new URL('index.ts', root), 'utf8')
  const runner = readFileSync(new URL('schedule/runner.ts', root), 'utf8')

  /**
   * 取某一处调用块（从 `marker` 开始的一段）。
   * @param src - 源码。
   * @param start - 起点标记。
   * @param end - 终点标记（取它在前者之后的位置）。
   * @returns 那一段文本。
   */
  const slice = (src, start, end) => {
    const a = src.indexOf(start)
    if (a < 0) return ''
    const b = src.indexOf(end, a)
    return src.slice(a, b < 0 ? a + 2000 : b)
  }

  /* 三个入口各自的块：列表（`/workflow/run`）、流式（`run-stream`）、定时（runner）。
   *
   * ⚠️ 终点标记**不能带尾引号**（第一版就栽在这）：原文是
   * `if (path === '/api/ecom-workbench/schedule/tasks' && ...)`，
   * 写成 `.../schedule'` 找不到、于是退回「只切 2000 字」的兜底，
   * 而流式那块的 `onEvent` 在第 4009 个字符处 —— 切不到，断言假红。
   * 用裸路径当终点就不会有这个问题。 */
  const listBlock = slice(idx, "if (path === '/api/ecom-workbench/workflow/run' && r.method === 'POST')",
    "if (path === '/api/ecom-workbench/workflow/paused'")
  const streamBlock = slice(idx, "if (path === '/api/ecom-workbench/workflow/run-stream' && r.method === 'GET')",
    '/api/ecom-workbench/schedule')

  check('★★ 列表入口真的把节点事件交给记录了（onEvent）',
    /onEvent:\s*\(e\)\s*=>/.test(listBlock), '列表那块里没找到 onEvent')
  check('★★ 列表入口用的是同一个 feed（不另写归并）',
    /rec\.feed\(/.test(listBlock), '没找到 rec.feed(')
  check('★ 流式入口也有 onEvent（对照，证明这块切片切对了）',
    /onEvent:\s*\(e\)\s*=>/.test(streamBlock), '流式那块里没找到 onEvent')
  check('★ 定时入口也有 onEvent（第三处对照）',
    /onEvent:\s*\(e\)\s*=>/.test(runner), 'runner.ts 里没找到 onEvent')

  /* 归并逻辑只有一份 —— 三处都不许自己写分支。 */
  check('★★ 列表入口没有自己写归并分支（只调 mergeNodeEvent / rec.feed）',
    !/byNode\.(set|get)\(/.test(listBlock), '列表那块里出现了自己操作 byNode')
}

/* ── ⑧ 节点汇报（`reports`）落盘：多条全留、没报不写键（契约 AM）───────────
 *
 * ## 这一段守的是什么
 *
 * 节点在跑的**过程中**主动报的事（写到哪个文件、多大）要能进运行记录。
 * 这里只验**存储层**两件事：
 *   ① 多条按到达顺序全留（记录层**不去重** —— 折叠显示是界面的事）；
 *   ② 没汇报的记录里**没有这个键**（不是 `[]`、不是 `null`）。
 *
 * ⚠️ 收集层（`mergeNodeEvent` 把 `report` 事件挂到明细上）住在 `src/index.ts`，
 * 那是后端地盘、本轮不在可改范围 —— 所以这里从**记录对象**出发验存储，
 * 不从事件流出发。事件那一层在 `tests/io-run.mjs` 的 ①⓪ 验过。 */
console.log('')
console.log('⑧ 节点汇报落盘：多条全留、没报不写键')
{
  const R1 = { message: '写到 D:\\数据\\a.json，128 字节', type: 'info', location: 'ndv', metrics: { bytes: 128 }, files: ['D:\\数据\\a.json'] }
  const R2 = { message: '写到 D:\\数据\\b.json，64 字节', type: 'info', location: 'ndv', metrics: { bytes: 64 }, files: ['D:\\数据\\b.json'] }
  const R3 = { message: '这次一个文件都没写', type: 'warning' }
  await appendRun({
    id: 'rep1', name: 'REP', startedAt: 13000, ok: true, ran: ['n1', 'n2'],
    nodes: [
      /* 同一个节点两条（循环里每轮一条就是这种形状）。 */
      { nodeId: 'n1', state: 'success', reports: [R1, R2] },
      /* 没汇报的节点 —— 记录里不许出现这个键。 */
      { nodeId: 'n2', state: 'success' },
      { nodeId: 'n3', state: 'failed', error: '磁盘满了', reports: [R3] },
    ],
  })
  const reps = await loadRuns('REP')
  const n1 = reps[0]?.nodes?.find(n => n.nodeId === 'n1')
  const n2 = reps[0]?.nodes?.find(n => n.nodeId === 'n2')
  const n3 = reps[0]?.nodes?.find(n => n.nodeId === 'n3')

  check('★★ 一个节点的多条汇报全部留下（不去重）', n1?.reports?.length === 2,
    JSON.stringify(n1?.reports?.length))
  check('★★ 顺序是到达顺序', (n1?.reports ?? []).map(r => r.message).join('|')
    === R1.message + '|' + R2.message,
    (n1?.reports ?? []).map(r => r.message).join(' | '))
  check('★ 结构化字段完整（类型 / 位置 / 数量 / 文件路径）',
    n1?.reports?.[0]?.type === 'info' && n1?.reports?.[0]?.location === 'ndv'
    && n1?.reports?.[0]?.metrics?.bytes === 128 && n1?.reports?.[0]?.files?.[0] === 'D:\\数据\\a.json',
    JSON.stringify(n1?.reports?.[0]))
  check('★★ 没汇报的节点**没有** reports 这个键（不是 []、不是 null）',
    n2 !== undefined && !('reports' in n2), JSON.stringify(n2))
  check('★★ 失败节点推的那条也留下了（失败也要能汇报）',
    n3?.state === 'failed' && n3?.reports?.[0]?.type === 'warning',
    JSON.stringify(n3))

  /* 直接读**文件原文**判「没汇报时连这个键都不出现」——
   * 读回来再判 `'reports' in obj` 抓不到「写成了空数组」。
   * 判据：`n2` 那条明细里**紧跟着** `"state"` 的片段不带 `reports`。 */
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(join(runsDir(), 'REP.json'), 'utf8')
  const n2Block = /\{[^{}]*"nodeId": "n2"[^{}]*\}/.exec(raw)?.[0] ?? ''
  check('★★ 文件原文里 n2 那条没有 reports 键', n2Block !== '' && !n2Block.includes('"reports"'),
    n2Block)
  check('★ 文件原文里有 reports 的只有那两条（n1 / n3）',
    (raw.match(/"reports"/g) ?? []).length === 2, String((raw.match(/"reports"/g) ?? []).length))
}

/* ── ⑨ 汇报事件必须被收集层接住（契约 AN 验收第 10 项）────────────
 *
 * ## 这一段守的是什么
 *
 * 引擎把汇报 emit 成 `{ kind: 'report', nodeId, entry }` 事件之后，
 * **收集层必须有人接**。原来 `mergeNodeEvent` 的 else-if 链里没有这个分支，
 * 于是汇报到了这一步就静静丢掉 —— 而「三处入口都传了 onEvent」之类的断言
 * 照样是绿的（那只证明事件发出去了，不证明事件被用上了）。
 *
 * 这里直接喂 `report` 事件给那个纯函数，验三件事：
 *   ① 挂得到节点明细上；
 *   ② 多条按到达顺序全留、不去重；
 *   ③ 没推的节点**没有** `reports` 键。
 *
 * ⚠️ 走的是 `mergeNodeEvent` 本身（`src/index.ts` 导出的纯函数），
 * 不是另造一个模拟 —— 那样测的是夹具不是产品。
 */
console.log('')
console.log('⑨ 汇报事件被收集层接住（report → 节点明细）')
{
  const { mergeNodeEvent } = await import('../src/index.ts')
  const R1 = { message: '写到 a.json，128 字节', type: 'info', metrics: { bytes: 128 }, files: ['a.json'] }
  const R2 = { message: '写到 b.json，64 字节', type: 'info', metrics: { bytes: 64 } }

  const map = new Map()
  mergeNodeEvent(map, { kind: 'started', nodeId: 'n1' })
  mergeNodeEvent(map, { kind: 'report', nodeId: 'n1', entry: R1 })
  mergeNodeEvent(map, { kind: 'report', nodeId: 'n1', entry: R2 })
  mergeNodeEvent(map, { kind: 'success', nodeId: 'n1' })
  /* 另一个节点一条都没报。 */
  mergeNodeEvent(map, { kind: 'started', nodeId: 'n2' })
  mergeNodeEvent(map, { kind: 'success', nodeId: 'n2' })

  const n1 = [...map.values()].find(l => l.nodeId === 'n1')
  const n2 = [...map.values()].find(l => l.nodeId === 'n2')

  check('★★ report 事件挂到了节点明细上（收集层接住了）',
    Array.isArray(n1?.reports) && n1.reports.length === 2, JSON.stringify(n1?.reports))
  check('★★ 多条按到达顺序全留、不去重',
    (n1?.reports ?? []).map(r => r.message).join('|') === R1.message + '|' + R2.message,
    (n1?.reports ?? []).map(r => r.message).join(' | '))
  check('★ 汇报不碰节点状态（还是 success）', n1?.state === 'success', String(n1?.state))
  check('★★ 没推汇报的节点没有 reports 键',
    n2 !== undefined && !('reports' in n2), JSON.stringify(Object.keys(n2 ?? {})))

  /* ★★ 汇报**不进 outputs**（纪律 1：下游 `{{变量}}` 必须取不到它）。
   * 收集层本来就不碰 `outputs`，这里钉住这个事实。 */
  check('★★ 汇报不进 outputs（下游取不到）', n1 !== undefined && !('outputs' in n1),
    JSON.stringify(Object.keys(n1 ?? {})))
}

/* ── ⑩ 删干净了没有：`makeDispatchNode` 的 sink 已不存在（验收第 11 项）───
 *
 * 先前为了「从派发结果直接攒汇报」写过一个 sink，与引擎的事件流**两条路并存**。
 * 那会让运行历史与任务记录各拿一份数据（迟早出现「历史三条、记录两条」）。
 * 现在统一走事件流，sink 必须删净 —— 这条读源码钉住它别被后人加回来。
 */
console.log('')
console.log('⑩ 汇报只有一条通道（事件流），没有第二条 sink')
{
  const { readFileSync: readSrc } = await import('node:fs')
  const idx = readSrc(new URL('../src/index.ts', import.meta.url), 'utf8')
  const runner = readSrc(new URL('../src/schedule/runner.ts', import.meta.url), 'utf8')

  check('★★ index.ts 里没有 makeDispatchNode 那个工厂了',
    !/makeDispatchNode/.test(idx), '仍然存在')
  check('★★ index.ts 里没有「往 sink 里 push 派发结果」的写法',
    !/sink\.push\(|sink: NodeReport\[\]/.test(idx), '仍然存在')
  check('★★ runner.ts 里也没有那个 collect 包装了',
    !/const collect: ScheduleDispatch|collect\.push\(/.test(runner), '仍然存在')
  /* 两条都从「节点明细」汇总 —— 那是唯一来源。 */
  check('★★ index.ts 的汇报取自节点明细（collectReports）',
    /collectReports\(/.test(idx), '没找到 collectReports(')
  check('★★ runner.ts 的汇报也取自节点明细（byNode.values）',
    /byNode\.values\(\)/.test(runner), '没找到 byNode.values(')
}

await rm(sandbox, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? '结论：运行历史（整次运行层）全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
