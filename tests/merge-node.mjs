/** `flow.merge` 的实现（票 21：七个「未完善」节点里唯一补实现的那个）。
 *
 * ## 为什么补它、为什么其余六个删了
 *
 * 判定写在票 21 的评论里。这里只留结论与最要紧的一条理由：
 *
 * 引擎里**有两处报错文案把用户指向这个节点** ——
 *   · `src/workflow/run.ts`：并行框内多路汇到同一个节点时报
 *     「请先用「合并」节点把这几路并成一路，或改成串联」；
 *   · `src/workflow/parallel.ts` 文件头：「靠显式合并节点做 —— 我们有 `flow.merge`」。
 *
 * 节点不存在的话，那两句就是在让人去找一个不存在的东西。**比「点了报错」更糟**：
 * 报错至少说清了自己不行，而这两句是保证「有这么个节点、用它就行」。
 *
 * ## 这一段守什么
 *
 * 三种合并方式各自的真结果、去重、以及三条边界：
 *   · 一路都没收到 → **明确报错**（不返回空数组）；
 *   · 非对象 / 非数组的输入不许丢（挂到 `a` / `b` 底下）；
 *   · 多于两路时的行为是确定的一件（并进数组那一种）。
 *
 * ⚠️ **真跑实现函数，不是只验定义存在** —— 票的判据第 2 条要的就是这个。
 * 走 `createBuiltinExecutor` 而不是直接调：顺带验「执行方按 `flow.merge` 查得到它」，
 * 那正是「派发报没有这个内置节点」这个病的反面。
 *
 * 跑法：node --import <tsx> tests/merge-node.mjs
 */
const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
const { NODE_IMPLS } = await import('../src/nodes/impls.ts')
const { NODE } = await import('../src/nodes/flow/merge/node.ts')

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

console.log('=== flow.merge（票 21：补上实现的那个节点）===')
console.log('')

/**
 * 真跑一次合并（走执行方，与产品里那条路一致）。
 * @param {object} params - 合并参数。
 * @param {unknown[]} upstream - 上游数据（按连线顺序）。
 * @returns {Promise<object>} 执行方结果。
 */
async function runMerge(params, upstream) {
  const exec = createBuiltinExecutor(NODE_IMPLS)
  return exec.run({
    runId: 'merge-test', nodeId: 'm1', executor: 'builtin',
    command: { node: 'flow.merge', params },
    context: { workflowId: 'w', upstream, workdir: process.cwd() },
  })
}

/* ── ① 节点定义本身：不再带「未完善」 ─────────────────────────────── */
console.log('① 定义：标签干净、实现表里查得到')
{
  check('★★ 标签里没有「未完善」了', !NODE.label.includes('未完善'), NODE.label)
  check('★ 标签就叫「合并」', NODE.label === '合并', NODE.label)
  /* 这一条是「派发报没有这个内置节点」那个病的反面。 */
  check('★★ 实现表里查得到它（派发不会再报「没有这个内置节点」）',
    NODE_IMPLS.has('flow.merge'), String(NODE_IMPLS.has('flow.merge')))
  check('★ 它仍是流程控制分类', NODE.category === 'flow', String(NODE.category))
}

/* ── ② 拼成数组（默认）───────────────────────────────────────────── */
console.log('')
console.log('② 拼成一个数组（默认）')
{
  const r = await runMerge({ mode: 'array' }, [[1, 2], [3, 4]])
  check('★ 真跑成功了', r.status === 'success', JSON.stringify(r.status))
  check('★★ 两个数组各自摊开接上', JSON.stringify(r.output) === JSON.stringify([1, 2, 3, 4]),
    JSON.stringify(r.output))

  /* 非数组的输入**不许丢**：当成一个元素接上。 */
  const scalar = await runMerge({ mode: 'array' }, ['甲', '乙'])
  check('★★ 两段文本也能接（不是「只有数组才支持」）',
    JSON.stringify(scalar.output) === JSON.stringify(['甲', '乙']), JSON.stringify(scalar.output))

  /* 数组 + 单个值混着也接得住。 */
  const mixed = await runMerge({ mode: 'array' }, [[1, 2], 9])
  check('★ 数组与单个值混着接', JSON.stringify(mixed.output) === JSON.stringify([1, 2, 9]),
    JSON.stringify(mixed.output))

  /* 多于两路：一并接上（这是如实的行为，节点说明里写了）。 */
  const three = await runMerge({ mode: 'array' }, [[1], [2], [3]])
  check('★ 三路也一并接上', JSON.stringify(three.output) === JSON.stringify([1, 2, 3]),
    JSON.stringify(three.output))
}

/* ── ③ 合并成一个对象 ────────────────────────────────────────────── */
console.log('')
console.log('③ 合并成一个对象')
{
  const r = await runMerge({ mode: 'object' }, [{ 甲: 1 }, { 乙: 2 }])
  check('★★ 两边的字段拼一起', JSON.stringify(r.output) === JSON.stringify({ 甲: 1, 乙: 2 }),
    JSON.stringify(r.output))

  /* 同名冲突：**以后一路为准**（与 n8n 的「Clash 时优先 Input 2」同一个取向）。 */
  const clash = await runMerge({ mode: 'object' }, [{ x: 'A' }, { x: 'B' }])
  check('★★ 同名字段以后一路为准', clash.output?.x === 'B', JSON.stringify(clash.output))

  /* 非对象输入挂到 a / b 底下，**不丢**。 */
  const odd = await runMerge({ mode: 'object' }, ['一段文本', { 乙: 2 }])
  check('★★ 非对象输入挂到 a 底下（不丢数据）', odd.output?.a === '一段文本', JSON.stringify(odd.output))
  check('★ 对象那一路照常铺开', odd.output?.乙 === 2, JSON.stringify(odd.output))
}

/* ── ④ 文本首尾相接 ─────────────────────────────────────────────── */
console.log('')
console.log('④ 文本首尾相接')
{
  const r = await runMerge({ mode: 'concat' }, ['第一段。', '第二段。'])
  check('★★ 两段接成一段', r.output === '第一段。第二段。', JSON.stringify(r.output))

  /* 对象接文本：`JSON.stringify`，不是 `[object Object]`（后者拿去做任何事都没用）。 */
  const obj = await runMerge({ mode: 'concat' }, [{ a: 1 }, '结尾'])
  check('★ 对象接文本时用 JSON 文本（不是 [object Object]）',
    obj.output === '{"a":1}结尾', JSON.stringify(obj.output))
}

/* ── ⑤ 去重 ─────────────────────────────────────────────────────── */
console.log('')
console.log('⑤ 去重（只在「拼成数组」时生效）')
{
  const off = await runMerge({ mode: 'array', dedupe: false }, [[1, 2], [2, 3]])
  check('★ 默认不去重', JSON.stringify(off.output) === JSON.stringify([1, 2, 2, 3]),
    JSON.stringify(off.output))

  const on = await runMerge({ mode: 'array', dedupe: true }, [[1, 2], [2, 3]])
  check('★★ 打开去重后剩 [1,2,3]', JSON.stringify(on.output) === JSON.stringify([1, 2, 3]),
    JSON.stringify(on.output))

  /* 对象也能去重 —— 用 `Set` 直接放对象永远不相等，所以按值的文本判。 */
  const objs = await runMerge({ mode: 'array', dedupe: true }, [[{ a: 1 }], [{ a: 1 }, { b: 2 }]])
  check('★★ 对象也能去重（同一份对象只留一个）', objs.output?.length === 2,
    JSON.stringify(objs.output))
}

/* ── ⑥ 边界：一路都没收到 ───────────────────────────────────────── */
console.log('')
console.log('⑥ 一路都没收到：明确报错，不给空结果')
{
  const r = await runMerge({ mode: 'array' }, [])
  check('★★ 没有上游时判失败（不返回空数组）', r.status === 'failed',
    JSON.stringify({ status: r.status, output: r.output }))
  check('★★ 说清是「没有收到任何上游数据」', String(r.error ?? '').includes('没有收到任何上游数据'),
    String(r.error ?? ''))
  check('★ 还说清了可能是走了别的分支',
    String(r.error ?? '').includes('分支'), String(r.error ?? '').slice(0, 100))
}

/* ── ⑦ 参数缺失时走默认（与节点定义的默认值一致）──────────────────── */
console.log('')
console.log('⑦ 参数缺失时与定义默认值一致')
{
  const r = await runMerge({}, [[1], [2]])
  check('★ 什么都不填 → 按「拼成数组」且不去重',
    JSON.stringify(r.output) === JSON.stringify([1, 2]), JSON.stringify(r.output))
  check('★ 与节点定义的默认值一致', NODE.params?.mode === 'array' && NODE.params?.dedupe === false,
    JSON.stringify(NODE.params))
}

console.log('')
console.log(failed === 0
  ? '结论：合并节点三种方式、去重、边界全部真跑通 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
