/** 「开始 / 结束」节点与「子流程传参」的执行语义（起真调度器，喂假派发器）。
 *
 * ## 为什么单独一个测试文件（而不是并进 run-graph）
 *
 * `run-graph` 钉的是**调度器本身的通用语义**（顺序 / 跳过 / 失败 / 环 / 循环）。
 * 这一份钉的是**新加的两类节点**（`flow.start` / `flow.end`）与**传参通道** ——
 * 它们是「对工作流的输入输出」这件事的执行侧，改坏了表现是
 * 「填了输入没生效 / 产出取不到」，而那种问题在通用调度语义的测试里看不出来。
 *
 * 判据一律按用户 m00901 定的三条：
 *   ① 输入 = 开始节点（不是「发给第一个节点」）；
 *   ② 没有开始节点 = 接不进来（**明确说清**，不是静默丢）；
 *   ③ 两个开始节点 = 配置错误（**明确报错**，不是随便挑一个）。
 *
 * 跑法：node --import <tsx> tests/io-run.mjs
 */
import { runGraph } from '../src/workflow/run.ts'

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 通过与否。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 造一个节点规格。
 * @param {string} id - 节点 id。
 * @param {string} defId - 节点定义 id。
 * @param {object} [params] - 参数。
 * @returns {object} 规格。
 */
function spec(id, defId, params = {}) {
  return {
    id,
    def: {
      id: defId,
      label: defId,
      executor: 'builtin',
      inputs: [{ id: 'in', label: '入', type: 'any' }],
      outputs: [{ id: 'out', label: '出', type: 'any' }],
    },
    params,
    onError: 'stop',
    skipped: false,
  }
}

/**
 * 假派发器：记录调用，按脚本给结果。
 * @param {object} script - nodeId → 结果。
 * @returns {{fn: Function, calls: object[]}} 派发器与调用记录。
 */
function fakeDispatch(script = {}) {
  const calls = []
  const fn = async (req) => {
    calls.push({ nodeId: req.nodeId, command: req.command, upstream: req.context.upstream })
    const r = script[req.nodeId]
    if (r !== undefined) return r
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  return { fn, calls }
}

/**
 * 造一条边。
 * @param {string} source - 起点。
 * @param {string} target - 终点。
 * @returns {object} 边。
 */
function edge(source, target) {
  return { id: source + '->' + target, source, target }
}

console.log('=== 开始 / 结束节点与传参（runGraph）===')

console.log('')
console.log('① 开始节点：声明的输入**每个节点都能取**（不必先连一条线过来）')
{
  const nodes = [
    spec('S', 'flow.start', { fields: ['日期 | 要采集哪一天 | 必填', '店铺'] }),
    spec('n2', 'code.js', { code: 'echo {{日期}}' }),
  ]
  const d = fakeDispatch()
  const r = await runGraph(
    { nodes, edges: [edge('S', 'n2')], inputs: { 日期: '2026-10-17', 店铺: 'DemoShop' } },
    d.fn,
  )
  const cmd = JSON.stringify(d.calls.find(c => c.nodeId === 'n2')?.command ?? {})
  check('★ 下游用 {{日期}} 直接取到外部给的值', cmd.includes('2026-10-17'), cmd)
  check('开始节点自己跑过了', r.ran.includes('S'), r.ran.join(','))
  check('★ 本次生效的输入回报给调用方',
    JSON.stringify(r.inputs) === JSON.stringify({ 日期: '2026-10-17', 店铺: 'DemoShop' }),
    JSON.stringify(r.inputs))
}

console.log('')
console.log('② 外部没给时用开始节点声明的**默认值**')
{
  const nodes = [spec('S', 'flow.start', { fields: ['日期 | | | 默认日'] }), spec('n2', 'code.js', { code: 'x={{日期}}' })]
  const d = fakeDispatch()
  await runGraph({ nodes, edges: [edge('S', 'n2')] }, d.fn)
  const cmd = JSON.stringify(d.calls.find(c => c.nodeId === 'n2')?.command ?? {})
  check('默认值生效', cmd.includes('默认日'), cmd)
}

console.log('')
console.log('③ ★ 没有开始节点 = **接不进来**（不是「发给第一个节点」）')
{
  /* 这是用户 m00901 明确要的语义 —— 这条断言就是那句话的可执行版本。 */
  const nodes = [spec('n1', 'code.js', { code: 'x={{日期}}' }), spec('n2', 'code.js', {})]
  const d = fakeDispatch()
  const events = []
  await runGraph(
    { nodes, edges: [edge('n1', 'n2')], inputs: { 日期: '2026-10-17' } },
    d.fn,
    { onEvent: e => events.push(e) },
  )
  const cmd = JSON.stringify(d.calls.find(c => c.nodeId === 'n1')?.command ?? {})
  check('★ 值没有悄悄发给第一个节点（占位符原样保留）',
    cmd.includes('{{日期}}') && !cmd.includes('2026-10-17'), cmd)
  const said = events.filter(e => e.kind === 'log' && e.line.includes('没有「开始」节点'))
  check('★ 明确说清了「接不进来」', said.length === 1, said.map(e => e.line).join(' / '))
  check('并且说明了不是发给了第一个节点', said[0]?.line.includes('不是发给了第一个节点'),
    said[0]?.line ?? '(无)')
}

console.log('')
console.log('④ ★ 两个开始节点 = 配置错误（明确报错，不随便挑一个）')
{
  const nodes = [spec('S1', 'flow.start', {}), spec('S2', 'flow.start', {}), spec('n2', 'code.js', {})]
  let err = ''
  try {
    await runGraph({ nodes, edges: [edge('S1', 'n2')] }, fakeDispatch().fn)
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check('★ 抛错', err !== '', err || '(没抛)')
  check('★ 说清是哪几个节点', err.includes('S1') && err.includes('S2'), err)
}

console.log('')
console.log('⑤ 开始节点：没声明输入项时不报错（它就是个「从这开始跑」的标记）')
{
  const nodes = [spec('S', 'flow.start', { fields: [] }), spec('n2', 'code.js', {})]
  const d = fakeDispatch()
  const r = await runGraph({ nodes, edges: [edge('S', 'n2')] }, d.fn)
  check('照常跑完', r.ran.join(',') === 'S,n2', r.ran.join(','))
  check('输入表是空的', Object.keys(r.inputs).length === 0, JSON.stringify(r.inputs))
}

console.log('')
console.log('⑥ ★ 结束节点：产出按声明取（跑完后统一收）')
{
  const nodes = [
    spec('n1', 'code.js', {}),
    spec('E', 'flow.end', { fields: ['汇总 = n1.out', '整份 = n1'] }),
  ]
  const d = fakeDispatch({ n1: { ok: true, status: 'success', output: { out: '甲', other: '乙' } } })
  /* 结束节点也接在 n1 后面（顺序依赖）。 */
  const r = await runGraph({ nodes, edges: [edge('n1', 'E')] }, d.fn)
  check('★ 取到指定字段', r.declaredOutputs['汇总'] === '甲', JSON.stringify(r.declaredOutputs))
  check('★ 不带字段 → 取整体输出',
    JSON.stringify(r.declaredOutputs['整份']) === JSON.stringify({ out: '甲', other: '乙' }),
    JSON.stringify(r.declaredOutputs))
  check('结束节点自己跑过了（顺序与状态要走完）', r.ran.includes('E'), r.ran.join(','))
}

console.log('')
console.log('⑦ 结束节点：声明了但取不到 → **照旧列出来**（不静默丢）')
{
  const nodes = [spec('n1', 'code.js', {}), spec('E', 'flow.end', { fields: ['缺 = 没这个节点.x'] })]
  const r = await runGraph({ nodes, edges: [edge('n1', 'E')] }, fakeDispatch().fn)
  check('★ 名字在结果里（值是 undefined）', '缺' in r.declaredOutputs, JSON.stringify(r.declaredOutputs))
  check('值确实是 undefined', r.declaredOutputs['缺'] === undefined)
}

console.log('')
console.log('⑧ 没有结束节点 → 空对象（不报错，这份工作流没有对外产出）')
{
  const r = await runGraph({ nodes: [spec('n1', 'code.js', {})], edges: [] }, fakeDispatch().fn)
  check('declaredOutputs 是空对象', JSON.stringify(r.declaredOutputs) === '{}', JSON.stringify(r.declaredOutputs))
}

console.log('')
console.log('⑨ ★ 子流程传参：父流程给的输入真的到了子流程手里')
{
  const nodes = [
    spec('S', 'flow.start', { fields: ['日期'] }),
    spec('n1', 'code.js', {}),
    spec('W', 'flow.workflow', { name: '子流程', inputs: ['日期 = 2026-10-18'] }),
  ]
  const seen = []
  /* ⚠️ `runWorkflow` 是 **RunGraphInput 的字段**（不是第三个参数里的选项）——
   * 第一版塞错位置，于是「入口没提供这个能力」被当成失败（假红）。 */
  const r = await runGraph(
    {
      nodes,
      edges: [edge('S', 'n1'), edge('n1', 'W')],
      inputs: { 日期: '被覆盖的' },
      runWorkflow: async (name, _signal, inputs) => { seen.push({ name, inputs }); return { ok: true, ran: [] } },
    },
    fakeDispatch().fn,
  )
  void r
  check('★ 子流程拿到的输入含「日期」', seen[0]?.inputs?.['日期'] !== undefined, JSON.stringify(seen))
  check('★ 手填的值优先于「原样透传」（参数优先，同循环那条纪律）',
    seen[0]?.inputs?.['日期'] === '2026-10-18', JSON.stringify(seen[0]?.inputs))
}

console.log('')
console.log('⑩ 子流程没填 inputs → **本层输入原样透传**（组合层靠这条）')
{
  /* ⚠️ **必须有开始节点**（2026-10-17 实测纠正过一次写法）：
   * 「外面喂的值」要进得来，前提是这份工作流**声明了它要**（开始节点）。
   * 没有开始节点时 `resolvedInputs` 是空的 —— 那不是 bug，正是用户 m00901
   * 定的语义（「没有开始节点 = 没法接外部输入」）。
   * 所以「组合层把参数透下去」这条，前提是组合层也放了开始节点。 */
  const nodes = [
    spec('S', 'flow.start', { fields: ['日期', '店铺'] }),
    spec('W', 'flow.workflow', { name: '子流程' }),
  ]
  const seen = []
  await runGraph(
    {
      nodes,
      edges: [edge('S', 'W')],
      inputs: { 日期: '2026-10-19', 店铺: 'DemoShop' },
      runWorkflow: async (name, _s, inputs) => { seen.push(inputs); return { ok: true, ran: [] } },
    },
    fakeDispatch().fn,
  )
  check('★ 两个字段都透传下去了（组合层「把外面喂的传下去」）',
    seen[0]?.['日期'] === '2026-10-19' && seen[0]?.['店铺'] === 'DemoShop',
    JSON.stringify(seen))
}

console.log('')
console.log('⑪ 子流程的 inputs 值里可以写 {{变量}}（能引用本层输入与上游）')
{
  const nodes = [
    spec('S', 'flow.start', { fields: ['日期'] }),
    spec('n1', 'code.js', {}),
    spec('W', 'flow.workflow', { name: '子流程', inputs: ['哪一天 = {{日期}}'] }),
  ]
  const seen = []
  await runGraph(
    {
      nodes,
      edges: [edge('S', 'n1'), edge('n1', 'W')],
      inputs: { 日期: '2026-10-20' },
      runWorkflow: async (_n, _s, inputs) => { seen.push(inputs); return { ok: true, ran: [] } },
    },
    fakeDispatch({ n1: { ok: true, status: 'success', output: { k: 'v' } } }).fn,
  )
  check('★ 变量替换后传下去', seen[0]?.['哪一天'] === '2026-10-20', JSON.stringify(seen))
}

console.log('')
console.log('⑫ 子流程失败时把原因抛出去（与普通节点失败的语义一致）')
{
  const nodes = [spec('W', 'flow.workflow', { name: '子流程' })]
  const events = []
  await runGraph(
    { nodes, edges: [], runWorkflow: async () => ({ ok: false, error: '子流程里第 3 步炸了' }) },
    fakeDispatch().fn,
    { onEvent: e => events.push(e) },
  )
  const failed = events.filter(e => e.kind === 'failed')
  check('报了失败', failed.length > 0, failed.map(e => e.error).join(' / '))
  check('带上了子流程给的原始原因', failed.some(e => String(e.error).includes('第 3 步炸了')),
    failed.map(e => e.error).join(' / '))
}

/* ── 汇报（契约 AM）：引擎把 `report()` 推上来的条目挂到当前节点名下 ─────────
 *
 * ## 这一段守的是什么
 *
 * 节点在跑的**过程中**说一句「我这次交出了什么」，原先没有地方说。
 * 现在节点实现通过 `ctx.report()` 推，派发结果带回 `reports`，
 * 调度器转成事件、收集层挂到节点明细上。
 *
 * 这里只验**调度器那一层**：条目有没有转成事件、能不能带失败、会不会漏进数据流。
 * 收集层与落盘在 `run-history.mjs` 里验。 */
console.log('')
console.log('⑬ 节点汇报：转成事件、不去重、不进 outputs')
{
  /* ① 一条汇报 → 一条 report 事件，内容原样。 */
  const nodes = [spec('w', 'sys.fs.write', { path: 'x.json' }), spec('after', 'code.js')]
  const REPORT = {
    message: '写到 D:\\数据\\x.json，128 字节', type: 'info', location: 'ndv',
    metrics: { bytes: 128 }, files: ['D:\\数据\\x.json'],
  }
  const d = {
    calls: [],
    fn: async (req) => {
      d.calls.push({ nodeId: req.nodeId })
      return req.nodeId === 'w'
        ? { ok: true, status: 'success', output: { path: 'x.json', bytes: 128 }, reports: [REPORT] }
        : { ok: true, status: 'success', output: 'done' }
    },
  }
  const events = []
  const r = await runGraph({ nodes, edges: [edge('w', 'after')] }, d.fn, { onEvent: (e) => events.push(e) })
  const rep = events.filter(e => e.kind === 'report')
  check('★★ 汇报被转成 report 事件', rep.length === 1, String(rep.length))
  check('★★ 事件带节点 id 与整条内容（原样，不重造）',
    rep[0]?.nodeId === 'w' && JSON.stringify(rep[0]?.entry) === JSON.stringify(REPORT),
    JSON.stringify(rep[0] ?? null))
  check('★ report 事件带 depth（收集层要靠它分层次）', rep[0]?.depth === 0, String(rep[0]?.depth))

  /* ② 不进数据流：节点的输出仍是返回值，不是那句人话。 */
  check('★★ 汇报**不进 outputs**（下游取不到）',
    !JSON.stringify(r.outputs.get('w') ?? null).includes('写到'),
    JSON.stringify(r.outputs.get('w') ?? null))

  /* ③ 多条 → 全部保留，按到达顺序（循环里每轮一条就是这种形状）。 */
  const multi = [
    { message: '第 1 条', type: 'info' },
    { message: '第 2 条', type: 'warning' },
    { message: '第 3 条', type: 'danger' },
  ]
  const ev2 = []
  await runGraph({ nodes: [spec('w', 'sys.fs.write', {})], edges: [] },
    async () => ({ ok: true, status: 'success', output: {}, reports: multi }),
    { onEvent: (e) => ev2.push(e) })
  const got2 = ev2.filter(e => e.kind === 'report').map(e => e.entry.message)
  check('★★ 多条汇报全部保留（记录层不去重）', got2.length === 3, got2.join(' / '))
  check('★★ 顺序是到达顺序（不是倒序、不是随机）',
    got2.join(',') === '第 1 条,第 2 条,第 3 条', got2.join(','))

  /* ④ 失败也要能汇报（纪律 3）：失败前推的那条要留着。 */
  const ev3 = []
  await runGraph({ nodes: [spec('bad', 'sys.fs.write', {})], edges: [] },
    async () => ({
      ok: false, status: 'failed', error: '磁盘满了',
      reports: [{ message: '写到一半失败：磁盘满了', type: 'danger' }],
    }),
    { onEvent: (e) => ev3.push(e) })
  const rep3 = ev3.filter(e => e.kind === 'report')
  check('★★ 节点失败时它推的那条也留着', rep3.length === 1, String(rep3.length))
  check('★ 失败与汇报两件事都在（failed 事件没被吞）',
    ev3.some(e => e.kind === 'failed' && String(e.error).includes('磁盘满了'))
    && rep3[0]?.entry.type === 'danger',
    JSON.stringify({ failed: ev3.filter(e => e.kind === 'failed').map(e => e.error) }))

  /* ⑤ 没汇报 → 一条 report 事件都没有（不写空的东西）。 */
  const ev4 = []
  await runGraph({ nodes: [spec('plain', 'code.js')], edges: [] }, fakeDispatch().fn,
    { onEvent: (e) => ev4.push(e) })
  check('★★ 节点没汇报时一条 report 事件都没有',
    !ev4.some(e => e.kind === 'report'),
    ev4.filter(e => e.kind === 'report').length + ' 条')
}

/* ── ⑪ `sys.fs.write` 真跑时推出内容（契约 AM 验收 5）─────────────────────
 *
 * 直接调那个内置实现、塞一个假的 `report`，看它到底推了什么。
 * 判据是「那句话里必须有路径与字节数」—— **只报「完成」两个字的按没做算**
 * （用户明确说过）。 */
console.log('')
console.log('⑭ sys.fs.write 真跑时会汇报「写到哪、多大」')
{
  const { writeFileFn } = await import('../src/dispatch/builtins.ts')
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'ewb-rep-'))
  try {
    const got = []
    const target = join(dir, 'out.json')
    const out = await writeFileFn(
      { node: 'sys.fs.write', params: { path: target, mode: 'overwrite' } },
      { nodeId: 'w', workdir: dir, upstream: [{ hello: '世界' }], report: (e) => got.push(e) },
    )
    check('★ 文件真写下去了', (await readFile(target, 'utf8')).includes('世界'))
    check('★ 返回值仍是「路径 + 字节数」（数据流不变）',
      out?.path === target && typeof out?.bytes === 'number' && out.bytes > 0,
      JSON.stringify(out))
    check('★★ 推了一条汇报', got.length === 1, String(got.length))
    check('★★ 那句话里有**文件路径**', String(got[0]?.message ?? '').includes(target),
      String(got[0]?.message ?? ''))
    check('★★ 那句话里有**字节数**', String(got[0]?.message ?? '').includes(String(out.bytes)),
      String(got[0]?.message ?? ''))
    check('★★ 不是「完成」这类空话', String(got[0]?.message ?? '') !== '完成'
      && String(got[0]?.message ?? '').length > 6, String(got[0]?.message ?? ''))
    check('★ 结构化字段齐（bytes 指标 + files 路径）',
      got[0]?.metrics?.bytes === out.bytes && got[0]?.files?.[0] === target,
      JSON.stringify(got[0]))

    /* 追加模式的话术要不同（同样是写文件，但「原内容还在」这件事必须说清）。 */
    const got2 = []
    await writeFileFn(
      { node: 'sys.fs.write', params: { path: target, mode: 'append' } },
      { nodeId: 'w', workdir: dir, upstream: '第二段', report: (e) => got2.push(e) },
    )
    check('★ 追加模式的话术与覆盖不同（说清原内容还在）',
      String(got2[0]?.message ?? '').includes('追加') && String(got2[0]?.message ?? '').includes('原内容保留'),
      String(got2[0]?.message ?? ''))

    /* 纪律 5：没有 `report` 的场景（编译器 / 预览）照样要能跑。 */
    const out2 = await writeFileFn(
      { node: 'sys.fs.write', params: { path: join(dir, 'b.txt') } },
      { nodeId: 'w', workdir: dir, upstream: 'x' },
    )
    check('★★ 不传 report 时照样跑得通（它必须是可缺省的）',
      out2?.bytes === 1, JSON.stringify(out2))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('')
console.log(failed === 0 ? '结论：开始/结束节点与传参的语义全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
