/** 循环计划与迭代展开的纯逻辑测试（不需要派发器）。
 *
 * 为什么单独测：循环最容易错的是**图运算**那一半（谁属于循环、从哪进从哪出、
 * 容器内外怎么分流）—— 它在派发器里出错时表现得像「数据莫名其妙不对」，
 * 极难查。这一半可以脱离执行直接钉死。
 *
 * 跑法：node --import <tsx> tests/loop-plan.mjs
 */
import { loopPlan, containerMap, nestedLoops, loopChainDepth, loopVarFields, scopedOutputOf, readBreakConditions, shouldBreakLoop, iterationItems, collectRound, LOOP_DEF_ID, readNodeField, resolveNodeField, buildLoopOutput } from '../src/workflow/loop.ts'

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

/** 造节点。 */
function n(id, defId = 'code.js', parentId) {
  const out = { id, defId }
  if (parentId !== undefined) out.parentId = parentId
  return out
}
/** 造边。 */
function e(source, target) {
  return { id: source + '>' + target, source, target }
}

console.log('=== 循环计划（loop.ts）===')

console.log('① containerMap：只认「父是循环节点」的归属')
{
  const nodes = [
    n('L', LOOP_DEF_ID),
    n('a', 'code.js', 'L'),          // 循环体
    n('G', 'group'),                  // 分组框
    n('b', 'code.js', 'G'),           // 属分组框，**不**属循环
    n('c'),                           // 无归属
  ]
  const m = containerMap(nodes)
  check('循环的子节点被认出来', m.get('a') === 'L', JSON.stringify([...m]))
  check('分组框的子节点不算循环体', !m.has('b'), JSON.stringify([...m]))
  check('无归属的不算', !m.has('c'))
  check('只登记一个', m.size === 1, String(m.size))
}

console.log('')
console.log('② 计划：首尾识别 + 容器内外分流')
{
  /* 形状：  outside → h → m → t → outside2
   *         全部 h/m/t 都在循环 L 里                              */
  const nodes = [n('L', LOOP_DEF_ID), n('outside'), n('h', 'code.js', 'L'), n('m', 'code.js', 'L'), n('t', 'code.js', 'L'), n('outside2')]
  const edges = [e('outside', 'h'), e('h', 'm'), e('m', 't'), e('t', 'outside2')]
  const p = loopPlan(nodes, edges, 'L')
  check('计划的出（循环存在）', p !== null)
  check('体是三个节点', p.bodyIds.length === 3, p.bodyIds.join(','))
  check('顺序 h→m→t', p.order.join('') === 'hmt', p.order.join('→'))
  check('入口是 h', p.heads.join('') === 'h', p.heads.join(','))
  check('出口是 t', p.tails.join('') === 't', p.tails.join(','))
  check('体内边一条（h→m、m→t 是两条）', p.innerEdges.length === 2, String(p.innerEdges.length))
  check('入边是外部来的那条', p.outerIn.length === 1 && p.outerIn[0].source === 'outside', JSON.stringify(p.outerIn))
  check('出边是流向外部那条', p.outerOut.length === 1 && p.outerOut[0].target === 'outside2', JSON.stringify(p.outerOut))
}

console.log('')
console.log('③ 计划：不需要用户连「循环→头」和「尾→循环」')
{
  /* 只有体内两条边，**没有任何**连到循环节点本身的边 ——
   * 这正是用户要的形态（边界隐式补，画布上不画）。 */
  const nodes = [n('L', LOOP_DEF_ID), n('a', 'code.js', 'L'), n('b', 'code.js', 'L')]
  const edges = [e('a', 'b')]
  const p = loopPlan(nodes, edges, 'L')
  check('没连循环节点也算得出计划', p !== null)
  check('入口 a / 出口 b', p.heads.join('') === 'a' && p.tails.join('') === 'b',
    p.heads.join(',') + ' / ' + p.tails.join(','))
}

console.log('')
console.log('④ 计划：多个入口 / 多个出口都允许')
{
  const nodes = [n('L', LOOP_DEF_ID), n('a', 'code.js', 'L'), n('b', 'code.js', 'L'), n('c', 'code.js', 'L')]
  const edges = [e('a', 'c'), e('b', 'c')]
  const p = loopPlan(nodes, edges, 'L')
  check('两个入口 a、b', p.heads.length === 2, p.heads.join(','))
  check('一个出口 c', p.tails.join('') === 'c', p.tails.join(','))
}

console.log('')
console.log('⑤ 计划：单节点循环体（它既是头也是尾）')
{
  const nodes = [n('L', LOOP_DEF_ID), n('only', 'code.js', 'L')]
  const p = loopPlan(nodes, [], 'L')
  check('既是入口也是出口', p.heads.join('') === 'only' && p.tails.join('') === 'only')
  check('顺序只有一个', p.order.join('') === 'only')
}

console.log('')
console.log('⑥ 计划：空体 / 不存在的循环 → null（由调用方报错）')
{
  check('空体返回 null', loopPlan([n('L', LOOP_DEF_ID)], [], 'L') === null)
  check('循环不存在返回 null', loopPlan([n('a')], [], 'L') === null)
  check('id 存在但不是循环节点 → null', loopPlan([n('L', 'code.js'), n('a', 'code.js', 'L')], [], 'L') === null)
}

console.log('')
console.log('⑦ 嵌套循环：**21 起允许执行**，nestedLoops 现在只作结构查询')
{
  /* ⚠️ 这一段原先断的是「嵌套被识别（执行时会明确报错）」。2026-10-19 放开嵌套后，
   * 执行期不再靠它拦，改为「层数上限 5」（见 ⑦b）。
   * `nestedLoops` 仍保留 —— 它是有用的结构查询（「这个循环里有没有套着循环」），
   * 而它自己的正确性值得继续钉住（不然哪天它算错了，画布侧的提示会静默错）。 */
  const nodes = [n('L1', LOOP_DEF_ID), n('L2', LOOP_DEF_ID, 'L1'), n('a', 'code.js', 'L2')]
  check('查出内层循环', nestedLoops(nodes, 'L1').join('') === 'L2', nestedLoops(nodes, 'L1').join(','))
  check('外层无嵌套时为空', nestedLoops([n('L1', LOOP_DEF_ID), n('a', 'code.js', 'L1')], 'L1').length === 0)
}

console.log('')
console.log('⑦b 循环层数：沿 parentId 链数，数的是「自己在第几层」')
{
  /* 判据必须是**自己嵌在几层里**，不是「体内还有没有循环」——
   * 后者对 `L1 ⊃ L2 ⊃ L3` 里的 L1 只看得到 L2，算不出 3 层。 */
  check('顶层循环 = 1 层', loopChainDepth([n('L1', LOOP_DEF_ID)], 'L1') === 1)
  check('两层时内层 = 2', loopChainDepth([n('L1', LOOP_DEF_ID), n('L2', LOOP_DEF_ID, 'L1')], 'L2') === 2)
  check('三层时最内层 = 3',
    loopChainDepth([n('L1', LOOP_DEF_ID), n('L2', LOOP_DEF_ID, 'L1'), n('L3', LOOP_DEF_ID, 'L2')], 'L3') === 3)
  /* 中间夹了非循环容器（分组框）不该多算一层 —— 只数**循环**节点。 */
  check('夹一个分组框不多算', loopChainDepth([
    n('L1', LOOP_DEF_ID), n('G', 'group', 'L1'), n('L2', LOOP_DEF_ID, 'G'),
  ], 'L2') === 2)
  check('id 不存在 → 0', loopChainDepth([n('L1', LOOP_DEF_ID)], 'nope') === 0)
  /* 存档被手改成环时不能死循环（防环）。判据只要求「停下来 + 有限」——
   * 环里的「层数」本身没有正确值可谈，那是坏数据。 */
  const cyc = [n('A', LOOP_DEF_ID, 'B'), n('B', LOOP_DEF_ID, 'A')]
  const cycDepth = loopChainDepth(cyc, 'A')
  check('parentId 成环时不死循环（有限就够）',
    Number.isFinite(cycDepth) && cycDepth <= cyc.length + 1, String(cycDepth))
}

console.log('')
console.log('⑦c 变量作用域：{{item}} 取最内层、{{outer.item}} 往外一层（逐层都成立）')
{
  /* 顶层：**没有 outer 这个键**（留着会把 `{{outer}}` 从「未找到+警告」变成「空串」）。 */
  const top = loopVarFields({})
  check('顶层返回空对象', Object.keys(top).length === 0, JSON.stringify(top))
  check('顶层没有 outer 键', !('outer' in top), JSON.stringify(top))
  check('undefined 也安全', Object.keys(loopVarFields(undefined)).length === 0)

  /* 一层：与改动前的 `{ ...ctx.loopVars }` **逐字一致**（老存档硬判据）。 */
  const one = loopVarFields({ loopVars: { item: 'A', index: 0 } })
  check('★ 一层时就是 { item, index }（老存档行为不变）',
    JSON.stringify(one) === JSON.stringify({ item: 'A', index: 0 }), JSON.stringify(one))

  /* 两层：item/index 取最内层，outer 指向外层那一份。 */
  const two = loopVarFields({
    loopVars: { item: 'inner', index: 1 },
    parent: { loopVars: { item: 'outer', index: 9 } },
  })
  check('★ 两层时 {{item}} = 最内层', two.item === 'inner', JSON.stringify(two))
  check('★ 两层时 {{index}} = 最内层的 index', two.index === 1, JSON.stringify(two))
  check('★ 两层时 {{outer.item}} = 往外一层', two.outer?.item === 'outer', JSON.stringify(two))
  check('两层时 {{outer.index}} = 往外一层的 index', two.outer?.index === 9, JSON.stringify(two))

  /* 三层：`outer.outer` 自然成立 —— 这就是「逐层拼」比「换成数组」强的地方。 */
  const three = loopVarFields({
    loopVars: { item: 3, index: 0 },
    parent: {
      loopVars: { item: 2, index: 0 },
      parent: { loopVars: { item: 1, index: 0 } },
    },
  })
  check('★ 三层时 {{outer.outer.item}} 取到第 1 层', three.outer?.outer?.item === 1, JSON.stringify(three))
  check('三层时最内层仍是 {{item}}', three.item === 3, JSON.stringify(three))

  /* 外层的 parent 没有 loopVars（比如顶层是 `{}`）时，不该在中间留一个空 outer。 */
  const emptyMid = loopVarFields({ loopVars: { item: 'x', index: 0 }, parent: {} })
  check('外层没有 loopVars 时不留空 outer', !('outer' in emptyMid), JSON.stringify(emptyMid))

  /* ★★ **变量替换的端到端**：`{{outer.item}}` 必须真能替换出来。
   * 这一段是「自证」的反面 —— 把 `loopVarFields` 改成「只取最内层」时，
   * 上面那几条 `outer` 断言会先红。 */
  check('变量表里能取到 outer.item（给替换器用）',
    two.outer !== undefined && typeof two.outer === 'object' && two.outer.item === 'outer')
}

console.log('')
console.log('⑦d 数据读取：按**归属层**取，绝不「本地没有就往外回落」')
{
  /* 造两层现场：
   *   外层本轮：op 有输出（'外层本轮'）
   *   内层本轮：op 没有输出（还没跑到）—— 但 op 属于**外层** → 只该读外层本轮
   * 这一条就是「不读上一轮」的纯逻辑版本（执行期那条在 run-graph 里）。 */
  const outerLocal = new Map([['op', '外层本轮']])
  const innerLocal = new Map([['k', '内层']])
  const scope = {
    local: innerLocal,
    bodyIds: new Set(['k', 'L2']),
    parent: { local: outerLocal, bodyIds: new Set(['op']) },
  }
  const global = new Map([['op', '外层上一轮残留'], ['ghost', '顶层的值']])

  check('★ 起点在外层体里 → 读外层本轮', scopedOutputOf('op', scope, global).value === '外层本轮',
    JSON.stringify(scopedOutputOf('op', scope, global)))
  check('起点在内层体里 → 读内层本轮', scopedOutputOf('k', scope, global).value === '内层')
  check('起点在顶层 → 读全局表', scopedOutputOf('ghost', scope, global).value === '顶层的值')
  check('谁都不属于 → 找全局', scopedOutputOf('nope', scope, global).found === false)

  /* ★★ 串味回归：**内层体里的节点本轮没跑**时，绝不能回落到全局（= 上一轮残留）。 */
  const innerScope = {
    local: new Map(),               /* 本轮什么都没跑 */
    bodyIds: new Set(['k']),
    parent: { local: outerLocal, bodyIds: new Set(['op']) },
  }
  const dirt = new Map([['k', '上一轮残留']])
  const got = scopedOutputOf('k', innerScope, dirt)
  check('★★ 内层本轮没跑 → 不读上一轮（found=false）', got.found === false, JSON.stringify(got))
  check('★★ 内层本轮没跑 → 值是 undefined（不是残留值）', got.value === undefined, JSON.stringify(got))

  /* 同理：外层体里的节点在本轮没跑时也不回落全局。 */
  const outerMissScope = {
    local: new Map(),
    bodyIds: new Set(['k']),
    parent: { local: new Map(), bodyIds: new Set(['op']) },
  }
  const got2 = scopedOutputOf('op', outerMissScope, dirt)
  check('★ 外层本轮没跑 → 不读全局残留', got2.found === false, JSON.stringify(got2))

  /* 顶层（scope 没有 bodyIds）→ 行为与改动前一致：直接查全局表。 */
  check('顶层行为不变', scopedOutputOf('ghost', {}, global).value === '顶层的值')
  check('顶层 undefined scope 也安全', scopedOutputOf('ghost', undefined, global).found === true)
}

console.log('')
console.log('⑦e resolveNodeField 的可选 scope（不传时行为与改动前逐字一致）')
{
  const outs = new Map([['n1', { list: [1, 2] }]])
  /* 不传 scope：老行为 —— 只看传入的那张表。 */
  check('不传 scope → 只看那张表', JSON.stringify(resolveNodeField({ nodeId: 'n1', field: 'list' }, outs)) === '[1,2]')
  check('不传 scope → 表里没有就是 undefined',
    resolveNodeField({ nodeId: 'zz', field: '' }, outs) === undefined)

  /* 传 scope：按归属层找。内层选的「外层体里的节点」要能取到外层本轮那份。 */
  const outerLocal = new Map([['op', { list: ['外层本轮'] }]])
  const scope = { local: new Map(), bodyIds: new Set(['k']), parent: { local: outerLocal, bodyIds: new Set(['op']) } }
  check('★ 传 scope → 内层能选到外层体里的节点',
    JSON.stringify(resolveNodeField({ nodeId: 'op', field: 'list' }, new Map(), scope)) === '["外层本轮"]')
  check('传 scope 但归属层本轮没跑 → undefined',
    resolveNodeField({ nodeId: 'k', field: '' }, new Map([['k', '残留']]), scope) === undefined)
  /* 起点在顶层时仍落回 outputs（scope 里没有它）。 */
  const topScope = { local: new Map(), bodyIds: new Set(['k']) }
  check('起点在顶层 → 落回 outputs',
    JSON.stringify(resolveNodeField({ nodeId: 'n1', field: 'list' }, outs, topScope)) === '[1,2]')
}

console.log('')
console.log('⑦f 跳出条件：读参数（容错 / 空数组不等于「永远成立」）')
{
  /* ⚠️ 这一条与 `flow.if` 那边「0 条条件 ≠ 永远成立」是**同一条纪律**。
   * 若把空数组当成成立，循环会静默只跑一轮 —— 用户会以为「循环坏了」。 */
  const empty = readBreakConditions([])
  check('★ 空数组 → 0 条（没配，不跳）', empty.conds.length === 0, JSON.stringify(empty))
  check('空数组没有丢弃项', empty.dropped === 0, String(empty.dropped))

  /* 老存档：根本没有这个键（`undefined` / null / 不是数组）。 */
  check('★ undefined → 没配', readBreakConditions(undefined).conds.length === 0)
  check('null → 没配', readBreakConditions(null).conds.length === 0)
  check('不是数组（存档被手改）→ 没配，不抛错', readBreakConditions('x').conds.length === 0)

  /* 合法的一条：三种左边来源都认。 */
  const ok = readBreakConditions([
    { left: { kind: 'loop', name: 'item' }, op: 'is', value: 'x' },
    { left: { kind: 'field', nodeId: 'n1', field: 'ok' }, op: 'is', value: 'false', valueType: 'boolean' },
    { left: { kind: 'input', name: '日期' }, op: 'notEmpty' },
  ])
  check('★ 三种左边来源都读得出来', ok.conds.length === 3, JSON.stringify(ok.conds))
  check('loop 来源', ok.conds[0].left.kind === 'loop' && ok.conds[0].left.name === 'item')
  check('field 来源带字段名', ok.conds[1].left.nodeId === 'n1' && ok.conds[1].left.field === 'ok')
  check('valueType 被保留（真假要按真假比）', ok.conds[1].valueType === 'boolean', String(ok.conds[1].valueType))
  check('单目比较符不带值也合法', ok.conds[2].op === 'notEmpty')

  /* 坏项要**丢掉并报数**，不整份报错、也不静默。 */
  const bad = readBreakConditions([
    { left: { kind: 'loop', name: 'item' }, op: 'is', value: 'x' },
    null,
    'string',
    { left: null, op: 'is' },
    { op: 'is', value: 'x' },                                  // 没有 left
    { left: { kind: 'loop', name: '' }, op: 'is' },            // name 空
    { left: { kind: 'field', nodeId: '' }, op: 'is' },         // nodeId 空
    { left: { kind: 'nope', name: 'x' }, op: 'is' },           // 不认识的 kind
  ])
  check('★ 只有 1 条合法', bad.conds.length === 1, JSON.stringify(bad.conds))
  check('★ 丢弃了 7 条并报了数', bad.dropped === 7, String(bad.dropped))

  /* 比较符缺省 → notEmpty（与 `readIfConditions` 同一个默认）。 */
  const noOp = readBreakConditions([{ left: { kind: 'loop', name: 'item' } }])
  check('比较符缺省 → notEmpty', noOp.conds[0].op === 'notEmpty', noOp.conds[0].op)

  /* 全部是坏项 → 0 条合法 = 没配（不能在坏数据上越界跳）。 */
  const allBad = readBreakConditions([null, 1, { left: {} }])
  check('★★ 全是坏项 → 当作没配（不跳）', allBad.conds.length === 0, JSON.stringify(allBad))
  check('坏项也报数了', allBad.dropped === 3, String(allBad.dropped))
}

console.log('')
console.log('⑦g 跳出条件：判定（and / or / 没配 / 比较符写错要报错）')
{
  /* 没配 → 永远不跳（`null` 与「空条件」都算没配）。 */
  check('★ null → 不跳', shouldBreakLoop(null).break === false)
  check('空条件 → 不跳', shouldBreakLoop({ conds: [], logic: 'and' }).break === false)

  const mk = (conds, logic) => ({
    conds: conds.map(c => ({ left: c.left, op: c.op ?? 'is', ...c.value === undefined ? {} : { value: c.value }, ...c.valueType === undefined ? {} : { valueType: c.valueType } })),
    logic,
  })

  /* and：全部成立才跳。 */
  const both = mk([{ left: 'a', value: 'a' }, { left: 1, value: '1', valueType: 'number' }], 'and')
  check('★ and 两条都成立 → 跳', shouldBreakLoop(both).break === true, JSON.stringify(both))
  const oneFail = mk([{ left: 'a', value: 'a' }, { left: 'b', value: 'a' }], 'and')
  check('★ and 有一条不成立 → 不跳', shouldBreakLoop(oneFail).break === false)
  /* or：任一成立就跳。 */
  check('★ or 有一条成立 → 跳', shouldBreakLoop(mk([{ left: 'b', value: 'a' }, { left: 'a', value: 'a' }], 'or')).break === true)
  check('★ or 全都不成立 → 不跳', shouldBreakLoop(mk([{ left: 'x', value: 'a' }, { left: 'y', value: 'a' }], 'or')).break === false)

  /* 逐条说明（日志用）：每条一句话，含「成立 / 不成立」。 */
  const d = shouldBreakLoop(mk([{ left: 'a', value: 'a' }, { left: 'b', value: 'a' }], 'and')).detail
  check('★ 逐条给出说明（两条）', d.length === 2, JSON.stringify(d))
  check('说明里写了成立 / 不成立', d[0].includes('成立') && d[1].includes('不成立'), JSON.stringify(d))

  /* ★ 不认识的比较符 → **抛错**，不静默当「不跳」。
   * 静默的话表现为「跳出永远不生效」，界面上看着一切正常，极难查。 */
  let thrown = ''
  try { shouldBreakLoop({ conds: [{ left: 'a', op: 'nonsense' }], logic: 'and' }) } catch (e) { thrown = String(e.message) }
  check('★★ 比较符写错 → 明确报错（不静默当「不跳」）', thrown.includes('不认识的比较符'), thrown)
}

console.log('')
console.log('⑧ 迭代展开：items 模式（**输入由参数选择器给出**，2026-10-13 改）')
{
  /* ⚠️ 判据 2026-10-13 改过。原来 `iterationItems(params, upstreamArray)` 会从
   * 上游数组里**猜**一个数组出来（`find(u => Array.isArray(u))`）；
   * 拆掉循环端口之后那个来源没了，改成 `iterationItems(params, value)` ——
   * `value` 是调用方按 `items` 选择器解析出来的**唯一那个值**。
   * 同时「取到的不是数组」从「包成一项继续跑」改成**明确报错**：
   * 选择器是用户明确选的，选错就该说清，静默按一条跑会让人以为「循环只处理了一条」。 */
  const r = iterationItems({ mode: 'items', maxIters: 100 }, [1, 2, 3])
  check('数组逐项展开', r.items.length === 3 && r.items[0] === 1, JSON.stringify(r.items))
  check('无警告', r.warning === '', r.warning)

  /* 空数组 → 零项（合法：这批没有数据）。 */
  const empty = iterationItems({ mode: 'items' }, [])
  check('空数组 → 零项', empty.items.length === 0)

  /* 没选数据来源（undefined）→ 明确报错，并说清怎么办。 */
  let msg1 = ''
  try { iterationItems({ mode: 'items' }, undefined) } catch (e) { msg1 = String(e.message) }
  check('没选数据来源 → 明确报错', msg1.includes('遍历哪个数据'), msg1)

  /* 选到的不是数组 → 明确报错（并提示改用「固定重复几次」）。 */
  let msg2 = ''
  try { iterationItems({ mode: 'items' }, '单值') } catch (e) { msg2 = String(e.message) }
  check('选到的不是列表 → 明确报错', msg2.includes('不是一个列表'), msg2)
  check('报错里给了怎么改', msg2.includes('固定重复几次'), msg2)
}

console.log('')
console.log('⑨ 迭代展开：count 模式 + 上限截断')
{
  const c = iterationItems({ mode: 'count', count: 3 }, undefined)
  check('固定次数 3 项', c.items.length === 3, JSON.stringify(c.items))
  check('每项带 index', c.items[0].index === 0 && c.items[2].index === 2, JSON.stringify(c.items))
  check('count=0 → 零项', iterationItems({ mode: 'count', count: 0 }, undefined).items.length === 0)
  /* count 模式**不看**选择器（用不上数据来源）—— 传了值也不影响。 */
  check('count 模式忽略数据来源', iterationItems({ mode: 'count', count: 2 }, [9, 9]).items.length === 2)

  /* 上限：这是防死循环的硬拦，不能省。 */
  const big = iterationItems({ mode: 'items', maxIters: 3 }, [1, 2, 3, 4, 5])
  check('超过上限被截断', big.items.length === 3, JSON.stringify(big.items))
  check('截断有警告（不能静默）', big.warning.includes('5') && big.warning.includes('3'), big.warning)

  /* count 模式也受上限约束。 */
  const bigC = iterationItems({ mode: 'count', count: 500, maxIters: 10 }, undefined)
  check('count 也受上限约束', bigC.items.length === 10, String(bigC.items.length))

  /* 参数非法时的兜底（不能 NaN 或崩）。 */
  const bad = iterationItems({ mode: 'items', maxIters: Number.NaN }, [1, 2])
  check('maxIters 非法 → 用默认 100', bad.items.length === 2)
  const badC = iterationItems({ mode: 'count', count: 'x' }, undefined)
  check('count 非法 → 用默认 5', badC.items.length === 5, String(badC.items.length))
}

console.log('')
console.log('⑨b 选择器：读「选节点 + 选字段」的值（照 Dify 的 ValueSelector）')
{
  /* 形状 `{ nodeId, field }`；`field` 空串 = 取整体输出。 */
  check('读到合法值', JSON.stringify(readNodeField({ nodeId: 'n1', field: 'list' })) === '{"nodeId":"n1","field":"list"}')
  check('field 缺失 → 空串（取整体）', readNodeField({ nodeId: 'n1' })?.field === '')
  /* ⚠️ 容错：存档可能被手改，形状不对要返回 null（不抛），让调用方给可读提示。 */
  check('非对象 → null', readNodeField('x') === null && readNodeField(null) === null)
  check('缺 nodeId → null', readNodeField({ field: 'a' }) === null)
  check('nodeId 为空串 → null', readNodeField({ nodeId: '' }) === null)

  /* 取值：从「节点 id → 输出」表里取，再钻字段。 */
  const outs = new Map([['n1', { list: [1, 2], other: 9 }], ['n2', 'plain']])
  check('钻字段', JSON.stringify(resolveNodeField({ nodeId: 'n1', field: 'list' }, outs)) === '[1,2]')
  check('空字段 → 整体输出', resolveNodeField({ nodeId: 'n2', field: '' }, outs) === 'plain')
  check('节点没跑过 → undefined', resolveNodeField({ nodeId: 'n9', field: 'x' }, outs) === undefined)
  check('字段不存在 → undefined', resolveNodeField({ nodeId: 'n1', field: 'nope' }, outs) === undefined)
  /* 整体输出不是对象时钻字段 → undefined（不能抛）。 */
  check('非对象钻字段 → undefined', resolveNodeField({ nodeId: 'n2', field: 'x' }, outs) === undefined)
}

console.log('')
console.log('⑩ 一轮结果的汇总')
{
  const local = new Map([['t', '输出值']])
  check('单出口直接给它的输出', collectRound(['t'], local) === '输出值')
  const local2 = new Map([['t1', 1], ['t2', 2]])
  const r = collectRound(['t1', 't2'], local2)
  check('多出口组成对象（不丢信息）', r.t1 === 1 && r.t2 === 2, JSON.stringify(r))
}

console.log('')
console.log('⑪ 循环输出：按「结果取哪个」收窄（照 n8n + Dify，2026-10-13 补）')
{
  /* 参照物（用户指定「参考那两个工作流参考」）：
   *   n8n 官方文档原文：done 出口「combines all of the processed data」
   *     -> 把每轮结果合并，**没有「取哪个变量」这个选项**。
   *   Dify：`output_selector` 指定「从体内哪个变量取」。
   * 我们：默认照 n8n（全给，向后兼容）；选了 result 照 Dify（逐轮取那一项）。 */
  const results = ['a', 'b', 'c']
  const locals = [
    new Map([['dl', { path: '/x1' }]]),
    new Map([['dl', { path: '/x2' }]]),
    new Map([['dl', { path: '/x3' }]]),
  ]

  /* ① 没选 -> 照 n8n：每轮结果全给（**旧行为，必须向后兼容**）。 */
  const all = buildLoopOutput(results, null, locals)
  check('没选 -> 给每轮结果（向后兼容）', JSON.stringify(all.results) === '["a","b","c"]', JSON.stringify(all))
  check('没选 -> 有轮数', all.count === 3)
  check('没选 -> 不产生 picked 字段', all.picked === undefined)

  /* ② 选了 -> 照 Dify：逐轮取那个节点的那个字段。 */
  const picked = buildLoopOutput(results, { nodeId: 'dl', field: 'path' }, locals)
  check('选了 -> 逐轮取到字段值', JSON.stringify(picked.picked) === '["/x1","/x2","/x3"]',
    JSON.stringify(picked.picked))
  check('选了 -> 原来的 results 仍在（不丢信息）', JSON.stringify(picked.results) === '["a","b","c"]')
  check('选了 -> 轮数仍对', picked.count === 3)

  /* ③ 选整体输出（field 空串）。 */
  const whole = buildLoopOutput(results, { nodeId: 'dl', field: '' }, locals)
  check('选整体输出', JSON.stringify(whole.picked) === '[{"path":"/x1"},{"path":"/x2"},{"path":"/x3"}]',
    JSON.stringify(whole.picked))

  /* ④ 选的节点某轮没跑 -> 那一项是 undefined（不崩、不静默换成别的）。 */
  const gap = buildLoopOutput(results, { nodeId: 'nope', field: 'x' }, locals)
  check('选到没跑的节点 -> undefined（不崩）', gap.picked.every(v => v === undefined),
    JSON.stringify(gap.picked))

  /* ⑤ 零轮（空数组）-> picked 是空数组。 */
  const zero = buildLoopOutput([], { nodeId: 'dl', field: 'path' }, [])
  check('零轮 -> picked 是空数组', Array.isArray(zero.picked) && zero.picked.length === 0)
}

console.log('')
console.log(failed === 0 ? '结论：循环计划全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
