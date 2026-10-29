/** 「条件判断」节点的**结构化条件**（选变量 + 比较符 + 值）。
 *
 * ## 为什么单独一个文件
 *
 * 2026-10-19 用户把 `flow.if` 从「一个 JS 表达式」改成了 Dify 那种结构化条件：
 *
 *   · 「照 Dify 做成『选变量 + 比较符 + 值』的结构化条件」
 *   · 「这个节点要足够兼容且能够往下传数据（这个节点做的不只是判断，
 *      判断完了后面的节点还得知道干嘛对吧？）注意流程事件的完整性」
 *   · 「IF 前面的节点就是传入信息的……不然每一个 IF 前面都得有一个帮他区分的节点」
 *
 * `tests/branch.mjs` 钉的是「分支的通用约定」（`__handle` → 哪条边活），
 * 这个文件钉「条件本身怎么读、怎么取值、怎么比、输出带不带上游」。
 * 两者分开的理由与 `branch.ts` / `if-condition.ts` 的分工一致。
 *
 * ## 它守着四条硬要求
 *
 *   ① **老存档照旧能跑** —— 5 份巡查工作流的夜禁判断全是 `expr`（第 ⑤ 段）；
 *   ② **输出必须带上游原样** —— 用户明确点出的那一条（第 ⑥ ⑦ 段）；
 *   ③ **循环变量能选**（第 ③ ⑧ 段）；
 *   ④ **判断有交代** —— 成立 / 不成立各有日志，不静默（第 ⑨ 段）。
 *
 * 跑法：node --import <tsx> tests/if-rules.mjs
 */
import {
  IF_OPERATORS, operatorIsUnary, operatorLabel, isEmptyValue, coerceRight,
  compareOne, evaluateConditions, evaluateCondition, liveHandles,
} from '../src/workflow/branch.ts'
import {
  readIfConditions, resolveOperand, resolveIfConditions, planIf,
} from '../src/workflow/if-condition.ts'
import { branchFn } from '../src/dispatch/builtins.ts'
import { runGraph } from '../src/workflow/run.ts'

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

/** 一个两出口的定义（条件判断的形状）。 */
const IF_DEF = {
  id: 'flow.if', label: '条件判断', executor: 'builtin',
  inputs: [{ id: 'in', label: '入', type: 'any' }],
  outputs: [{ id: 'true', label: '成立', type: 'any' }, { id: 'false', label: '不成立', type: 'any' }],
}

console.log('=== 结构化条件（if-condition.ts + branch.ts）===')

console.log('')
console.log('① 比较符全集：照 Dify，一个不少、也不多发明')
{
  const ids = IF_OPERATORS.map(o => o.id)
  /* Dify 的 `ComparisonOperator` 有 21 个；我们**有意**去掉三个（理由写在
   * `branch.ts` 顶部：多分支 cases / 变量对变量 / allOf 都不在我们的场景里）。
   * 这里不逐个点名（那个清单会随 Dify 变），只钉「常用的那些都在」+
   * 「每个都有中文名」（界面上出现英文 id 就是漏了标签）。 */
  for (const id of ['is', 'isNot', 'contains', 'notContains', 'startWith', 'endWith',
    'empty', 'notEmpty', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'exists', 'notExists']) {
    check('有比较符 ' + id, ids.includes(id), ids.join(','))
  }
  check('每个比较符都有中文名（界面不出英文 id）',
    IF_OPERATORS.every(o => typeof o.label === 'string' && o.label !== '' && !/^[a-zA-Z]+$/.test(o.label)),
    IF_OPERATORS.filter(o => /^[a-zA-Z]+$/.test(o.label)).map(o => o.id).join(','))
  check('每个比较符都有说明（用户要知道怎么用）',
    IF_OPERATORS.every(o => typeof o.hint === 'string' && o.hint !== ''))
  check('单目比较符不需要右边的值',
    operatorIsUnary('empty') === true && operatorIsUnary('notEmpty') === true
    && operatorIsUnary('isNull') === true && operatorIsUnary('exists') === true)
  check('双目比较符需要右边的值',
    operatorIsUnary('is') === false && operatorIsUnary('contains') === false && operatorIsUnary('gt') === false)
  check('不认识的比较符按双目处理（不静默算单目）', operatorIsUnary('no.such.op') === false)
  check('operatorLabel 找不到时原样返回', operatorLabel('no.such.op') === 'no.such.op')
}

console.log('')
console.log('② 空值判定：比 JS 真值更宽（空对象 / 空数组也算空）')
{
  check('undefined 为空', isEmptyValue(undefined) === true)
  check('null 为空', isEmptyValue(null) === true)
  check('空串为空', isEmptyValue('') === true)
  check('只有空白的串为空', isEmptyValue('   ') === true)
  check('空数组为空', isEmptyValue([]) === true)
  check('空对象为空（{} 在 JS 里是真值，这里算空）', isEmptyValue({}) === true)
  check('0 不为空（采集里 0 是有效数据）', isEmptyValue(0) === false)
  check('false 不为空', isEmptyValue(false) === false)
  check('非空数组不为空', isEmptyValue([0]) === false)
}

console.log('')
console.log('③ 读条件：形状不对的项丢掉、但要报数（不静默）')
{
  const ok = readIfConditions([
    { left: { kind: 'field', nodeId: 'n1', field: 'count' }, op: 'gt', value: '3' },
    { left: { kind: 'loop', name: 'item.flag' }, op: 'is', value: 'true', valueType: 'boolean' },
    { left: { kind: 'input', name: '日期' }, op: 'notEmpty' },
  ])
  check('三条合法条件全读到', ok.conds.length === 3, JSON.stringify(ok.conds))
  check('没有丢条数', ok.dropped === 0, String(ok.dropped))
  check('field 左边带上了字段', ok.conds[0].left.field === 'count', JSON.stringify(ok.conds[0]))
  check('loop 左边带上了名字', ok.conds[1].left.name === 'item.flag', JSON.stringify(ok.conds[1]))
  check('valueType 读到了', ok.conds[1].valueType === 'boolean', JSON.stringify(ok.conds[1]))

  /* 坏项：不是对象 / 没有左边 / 左边 kind 不认识 / 名字是空串。 */
  const bad = readIfConditions([
    'not an object',
    { op: 'is', value: 'x' },
    { left: { kind: 'no.such.kind', name: 'x' }, op: 'is' },
    { left: { kind: 'field', nodeId: '   ', field: 'x' }, op: 'is' },
    { left: { kind: 'field', nodeId: 'n1', field: 'ok' }, op: 'is', value: 'v' },
  ])
  check('坏项被丢掉、好的那条留着', bad.conds.length === 1, JSON.stringify(bad.conds))
  check('★ 丢了 4 条要报出来（不静默）', bad.dropped === 4, String(bad.dropped))

  /* 没写 op 时按「不为空」—— 界面点「添加一条」就是这个默认值。 */
  const noOp = readIfConditions([{ left: { kind: 'loop', name: 'item' } }])
  check('没写比较符时默认「不为空」', noOp.conds[0]?.op === 'notEmpty', JSON.stringify(noOp.conds[0]))

  check('不是数组时返回空（不崩）', readIfConditions('nope').conds.length === 0)
  check('undefined 时返回空', readIfConditions(undefined).conds.length === 0)
}

console.log('')
console.log('④ 解析左边：三种来源都能取到值')
{
  const ctx = {
    outOf: (id) => (id === 'n1' ? { count: 7, nested: { deep: 'x' } } : undefined),
    labelOf: (id) => '节点' + id,
    inputs: { 日期: '2026-10-19' },
    loopVars: { item: { url: 'https://a', tags: ['x'] }, index: 2 },
  }
  const a = resolveOperand({ kind: 'field', nodeId: 'n1', field: 'count' }, ctx)
  check('节点字段取到值', a.value === 7, JSON.stringify(a))
  check('附带一句给人看的名字', a.label.includes('count'), a.label)

  const b = resolveOperand({ kind: 'field', nodeId: 'n1', field: 'nested.deep' }, ctx)
  check('点号路径能取到（nested.deep）', b.value === 'x', JSON.stringify(b))

  const whole = resolveOperand({ kind: 'field', nodeId: 'n1', field: '' }, ctx)
  check('字段为空串 = 取整个输出', typeof whole.value === 'object' && whole.value.count === 7, JSON.stringify(whole))
  check('整个输出时标签说清了', whole.label.includes('整个输出'), whole.label)

  const loopV = resolveOperand({ kind: 'loop', name: 'item.url' }, ctx)
  check('★ 循环变量能取到（item.url）', loopV.value === 'https://a', JSON.stringify(loopV))
  const loopIdx = resolveOperand({ kind: 'loop', name: 'index' }, ctx)
  check('循环变量 index 能取到', loopIdx.value === 2, JSON.stringify(loopIdx))
  const loopArr = resolveOperand({ kind: 'loop', name: 'item.tags.0' }, ctx)
  check('循环变量里数组下标能取到', loopArr.value === 'x', JSON.stringify(loopArr))

  const inp = resolveOperand({ kind: 'input', name: '日期' }, ctx)
  check('开始节点的输入能取到', inp.value === '2026-10-19', JSON.stringify(inp))

  const miss = resolveOperand({ kind: 'field', nodeId: 'nope', field: 'x' }, ctx)
  check('取不到时是 undefined，不抛错', miss.value === undefined && miss.label.includes('nope'), JSON.stringify(miss))
}

console.log('')
console.log('⑤ 比较：18 个比较符各比一遍（含边界）')
{
  /** 简短构造一条已解析条件。 */
  const c = (left, op, value, valueType) => {
    const r = { left, op }
    if (value !== undefined) r.value = value
    if (valueType !== undefined) r.valueType = valueType
    return r
  }
  check('等于（文本）', compareOne(c('abc', 'is', 'abc')) === true)
  check('等于（文本）不相等', compareOne(c('abc', 'is', 'abd')) === false)
  check('不等于', compareOne(c('abc', 'isNot', 'abd')) === true)
  check('等于（数字）', compareOne(c(7, 'is', '7', 'number')) === true)
  check('数字 7 ≠ 文本 "7" 按文本比也对（两边都是文本时）', compareOne(c('7', 'is', '7', 'text')) === true)
  check('数字比较不走字符串（"10" > "9" 按数字是成立）',
    compareOne(c(10, 'gt', '9', 'number')) === true,
    '按文本比会得到 false')
  check('等于（真假 true）', compareOne(c(true, 'is', 'true', 'boolean')) === true)
  check('等于（真假，左边是字符串 "true" 也认）', compareOne(c('true', 'is', 'true', 'boolean')) === true)
  check('包含', compareOne(c('天猫旗舰店', 'contains', '旗舰')) === true)
  check('不包含', compareOne(c('天猫旗舰店', 'notContains', '京东')) === true)
  check('开头是', compareOne(c('天猫旗舰店', 'startWith', '天猫')) === true)
  check('结尾是', compareOne(c('天猫旗舰店', 'endWith', '店')) === true)
  check('大于', compareOne(c(11, 'gt', '10', 'number')) === true)
  check('大于等于（相等时成立）', compareOne(c(10, 'gte', '10', 'number')) === true)
  check('小于', compareOne(c(9, 'lt', '10', 'number')) === true)
  check('小于等于（相等时成立）', compareOne(c(10, 'lte', '10', 'number')) === true)
  check('是其中之一（逗号分隔）', compareOne(c('b', 'in', 'a,b,c')) === true)
  check('是其中之一（中文逗号也认）', compareOne(c('b', 'in', 'a，b，c')) === true)
  check('是其中之一（换行也认）', compareOne(c('b', 'in', 'a\nb\nc')) === true)
  check('不是其中任何一个', compareOne(c('z', 'notIn', 'a,b')) === true)
  check('为空', compareOne(c('', 'empty')) === true)
  check('不为空', compareOne(c('x', 'notEmpty')) === true)
  check('有这个字段（值是空也算有）', compareOne(c('', 'exists')) === true)
  check('没有这个字段（undefined）', compareOne(c(undefined, 'notExists')) === true)
  check('是空值（undefined）', compareOne(c(undefined, 'isNull')) === true)
  check('不是空值（0 也算有值）', compareOne(c(0, 'isNotNull')) === true)

  /* ⚠️ 这两条是「别把没取到当成 0」的护栏：左边没值时大小比较一律不成立，
   * 否则「没取到 < 5」会判成立，用户完全无法理解。 */
  check('★ 左边没取到时「小于」不成立（不把 undefined 当 0）',
    compareOne(c(undefined, 'lt', '5', 'number')) === false)
  check('★ 左边没取到时「大于」也不成立',
    compareOne(c(undefined, 'gt', '0', 'number')) === false)

  /* 不认识的比较符必须**抛错**（静默当 false 会表现为「条件永远不成立」）。 */
  let msg = ''
  try { compareOne(c(1, 'no.such.op', '1')) } catch (e) { msg = String(e?.message ?? e) }
  check('★ 不认识的比较符抛错（不静默当 false）', msg.includes('不认识的比较符'), msg || '(没抛)')

  check('coerceRight：数字类型转成数', coerceRight('42', 'number') === 42)
  check('coerceRight：转不成数字时原样当文本（不给 NaN）', coerceRight('abc', 'number') === 'abc')
  check('coerceRight：真假类型认「是」「1」', coerceRight('是', 'boolean') === true && coerceRight('1', 'boolean') === true)
}

console.log('')
console.log('⑥ 多条条件：全部满足 / 满足任一')
{
  const t = (op, value, valueType) => (value === undefined ? { left: 1, op } : { left: 1, op, value, valueType })
  const and = evaluateConditions([t('is', '1', 'number'), t('gt', '0', 'number')], 'and')
  check('and：两条都成立 → 成立', and.pass === true, JSON.stringify(and))
  const and2 = evaluateConditions([t('is', '1', 'number'), t('gt', '5', 'number')], 'and')
  check('and：有一条不成立 → 不成立', and2.pass === false, JSON.stringify(and2))
  const or = evaluateConditions([t('is', '1', 'number'), t('gt', '5', 'number')], 'or')
  check('or：有一条成立 → 成立', or.pass === true, JSON.stringify(or))
  const or2 = evaluateConditions([t('is', '9', 'number'), t('gt', '5', 'number')], 'or')
  check('or：全不成立 → 不成立', or2.pass === false, JSON.stringify(or2))

  /* 逐条说明是日志的原料 —— 用户要知道「判了什么、结果是什么」。 */
  check('★ 每条条件都给一句说明（日志用）', and.detail.length === 2, JSON.stringify(and.detail))
  check('说明里带比较符的中文名', and.detail[0].includes('等于'), JSON.stringify(and.detail))
  check('说明里带「成立 / 不成立」', and.detail[0].includes('成立'), JSON.stringify(and.detail))

  /* 逻辑词写错时按「全部满足」（宁可严，不可松）。 */
  check('逻辑词写错 → 按 and（宁可严）',
    evaluateConditions([t('is', '1', 'number'), t('gt', '5', 'number')], 'XOR').pass === false)
}

console.log('')
console.log('⑦ planIf：走哪条路（老存档兼容的判据全在这里）')
{
  const ctx = { outOf: () => undefined, labelOf: () => 'x', inputs: {}, loopVars: {} }
  /* ① 老存档：`expr` 非空 → 走旧路。5 份巡查工作流就是这一种。 */
  const p1 = planIf({ expr: 'input.curfewTop !== true' }, ctx)
  check('★ 有 expr → 走旧路（5 份巡查工作流靠这条）', p1.mode === 'expr', JSON.stringify(p1))

  /* ② 新存档：只有结构化条件。 */
  const p2 = planIf({ conditions: [{ left: { kind: 'loop', name: 'item.go' }, op: 'is', value: 'true', valueType: 'boolean' }] }, ctx)
  check('只有结构化条件 → 走规则', p2.mode === 'rules', JSON.stringify(p2))
  check('规则里带了解析好的条件', p2.mode === 'rules' && p2.conds.length === 1, JSON.stringify(p2))

  /* ③ 什么都没有 → `none`（**不能**当成「永远成立」：那会让 IF 静默变成直通线）。 */
  check('★ 两条路都没内容 → none（不静默当成成立）', planIf({}, ctx).mode === 'none')
  check('空数组条件也算 none', planIf({ conditions: [] }, ctx).mode === 'none')
  check('只有空白 expr 也算 none', planIf({ expr: '   ' }, ctx).mode === 'none')

  /* ④ 两样都填 → 按 expr，并在日志里明说（这里只能验到「走了 expr」，日志由第 ⑨ 段验）。 */
  const both = planIf({ expr: 'input.a', conditions: [{ left: { kind: 'loop', name: 'item' }, op: 'notEmpty' }] }, ctx)
  check('★ 两样都填 → 走 expr（不静默二选一，日志会说明）', both.mode === 'expr', JSON.stringify(both))

  /* ⑤ 条件全是坏的 → 同上，落回 none，不静默成立。 */
  check('坏条件全被丢掉 → none', planIf({ conditions: ['garbage'] }, ctx).mode === 'none')

  check('dropped 计数能穿过 planIf',
    planIf({ conditions: [{ left: { kind: 'loop', name: 'a' }, op: 'notEmpty' }, 'garbage'] }, ctx).dropped === 1)
}

console.log('')
console.log('⑧ branchFn：输出必须带**上游原样**（用户 2026-10-19 明确要求）')
{
  /** 跑一次内置的「条件判断」。 */
  const run = (params, upstream, judge) => {
    const cmd = { node: 'flow.if', params }
    if (judge !== undefined) cmd.__judge = judge
    return branchFn(cmd, { nodeId: 'IF', upstream, workdir: '.' })
  }
  const upstream = { 商品: '杯子', 价格: 59, 标签: ['家居', '日用'] }

  /* 成立 */
  const yes = run({}, [upstream], {
    mode: 'rules', logic: 'and',
    conds: [{ left: 59, op: 'lt', value: '100', valueType: 'number' }],
  })
  check('成立时 __handle = true', yes.__handle === 'true', JSON.stringify(yes))
  check('★ 成立时下游能拿到上游每一个字段',
    yes.商品 === '杯子' && yes.价格 === 59 && JSON.stringify(yes.标签) === JSON.stringify(['家居', '日用']),
    JSON.stringify(yes))
  check('★ 除了 __handle 之外没有多出别的键',
    Object.keys(yes).filter(k => k !== '__handle').length === Object.keys(upstream).length,
    Object.keys(yes).join(','))

  /* 不成立 */
  const no = run({}, [upstream], {
    mode: 'rules', logic: 'and',
    conds: [{ left: 59, op: 'gt', value: '100', valueType: 'number' }],
  })
  check('不成立时 __handle = false', no.__handle === 'false', JSON.stringify(no))
  check('★ 不成立时上游数据照样完整（判断不改数据）',
    no.商品 === '杯子' && no.价格 === 59, JSON.stringify(no))

  /* ⚠️ 上游不是对象时不能铺平（`{ ...'abc' }` 会变成 `{0:'a',1:'b'}`）。 */
  const str = run({}, ['一段文本'], { mode: 'rules', logic: 'and', conds: [{ left: 'x', op: 'notEmpty' }] })
  check('★ 上游是文本 → 原样放进 value（不铺平）',
    str.value === '一段文本' && str['0'] === undefined, JSON.stringify(str))
  const arr = run({}, [[1, 2, 3]], { mode: 'rules', logic: 'and', conds: [{ left: 'x', op: 'notEmpty' }] })
  check('★ 上游是数组 → 原样放进 value（不铺平）',
    JSON.stringify(arr.value) === JSON.stringify([1, 2, 3]), JSON.stringify(arr))
  const nul = run({}, [null], { mode: 'rules', logic: 'and', conds: [{ left: 'x', op: 'empty' }] })
  check('上游是 null → value 是 null', nul.value === null, JSON.stringify(nul))

  /* 老写法：没有 __judge、只有 expr 参数 → 照旧用表达式。 */
  const old = run({ expr: 'input.价格 > 10' }, [upstream])
  check('★ 老写法（只有 expr）照旧能跑', old.__handle === 'true', JSON.stringify(old))
  check('老写法也带上游数据', old.商品 === '杯子', JSON.stringify(old))

  /* 活出口能被调度器认出来（`liveHandles` 是调度器唯一的判据来源）。 */
  check('调度器能从输出认出走的是哪个出口',
    JSON.stringify(liveHandles(yes, IF_DEF)) === '["true"]'
    && JSON.stringify(liveHandles(no, IF_DEF)) === '["false"]',
    JSON.stringify(liveHandles(yes, IF_DEF)))
}

console.log('')
console.log('⑨ 端到端：调度器解析左边 → 判断 → 日志 → 下游拿到上游数据')
{
  /** 造一个节点规格。 */
  const specOf = (id, opts = {}) => {
    const s = {
      id,
      def: {
        id: opts.defId ?? 'code.js', label: opts.label ?? id, executor: 'builtin',
        inputs: [], outputs: opts.outputs ?? [{ id: 'out', label: '出', type: 'any' }],
      },
      params: opts.params ?? {},
      onError: 'stop',
      skipped: false,
    }
    if (opts.parentId !== undefined) s.parentId = opts.parentId
    return s
  }
  /** IF 节点的规格（两出口）。 */
  const ifSpec = (id, params, parentId) => {
    const s = specOf(id, { defId: 'flow.if', label: '条件判断', params })
    s.def.inputs = [{ id: 'in', label: '入', type: 'any' }]
    s.def.outputs = IF_DEF.outputs
    if (parentId !== undefined) s.parentId = parentId
    return s
  }
  /** 假派发器：记录调用，按脚本给结果。 */
  const fake = (script = {}) => {
    const calls = []
    const fn = async (req) => {
      calls.push({ nodeId: req.nodeId, upstream: req.context.upstream, command: req.command })
      const r = script[req.nodeId]
      if (r !== undefined) return r
      return { ok: true, status: 'success', output: 'out:' + req.nodeId }
    }
    return { fn, calls }
  }

  /* ── 情形 A：按上游字段判，走成立那条，下游拿到上游数据 ── */
  const nodes = [
    specOf('src'),
    ifSpec('IF', {
      conditions: [{ left: { kind: 'field', nodeId: 'src', field: 'count' }, op: 'gt', value: '3', valueType: 'number' }],
      logic: 'and',
    }),
    specOf('yes'),
    specOf('no'),
  ]
  const edges = [
    { id: 'e1', source: 'src', target: 'IF' },
    { id: 'e2', source: 'IF', target: 'yes', sourceHandle: 'true' },
    { id: 'e3', source: 'IF', target: 'no', sourceHandle: 'false' },
  ]
  const d = fake({ src: { ok: true, status: 'success', output: { count: 7, name: '商品A' } } })
  const events = []
  /* 真的用 `branchFn` 当 `flow.if` 的实现（不是编一个输出）——
   * 否则「调度器解析的对不对」与「节点实现比的对不对」两头都可能空转。 */
  const dispatch = async (req, signal) => {
    if (req.nodeId === 'IF') {
      const v = branchFn(req.command, { nodeId: 'IF', workdir: '.', upstream: req.context.upstream })
      d.calls.push({ nodeId: 'IF', upstream: req.context.upstream, command: req.command })
      return { ok: true, status: 'success', output: v }
    }
    return d.fn(req, signal)
  }
  await runGraph({ nodes, edges }, dispatch, { onEvent: e => events.push(e) })

  const ifCall = d.calls.find(c => c.nodeId === 'IF')
  check('★ 调度器把左边解析成了实际值（7）',
    ifCall?.command?.__judge?.conds?.[0]?.left === 7,
    JSON.stringify(ifCall?.command?.__judge))
  check('真值没混进参数表（__judge 与 params 并列）',
    ifCall?.command?.params?.__judge === undefined, JSON.stringify(ifCall?.command))
  const yesCall = d.calls.find(c => c.nodeId === 'yes')
  check('走成立那条', yesCall !== undefined, d.calls.map(c => c.nodeId).join(','))
  check('★ 不成立那条没派发', !d.calls.some(c => c.nodeId === 'no'), d.calls.map(c => c.nodeId).join(','))
  check('★★ 下游拿到的上游数据与原来逐字段相同（判断不改数据）',
    yesCall?.upstream?.[0]?.count === 7 && yesCall?.upstream?.[0]?.name === '商品A',
    JSON.stringify(yesCall?.upstream))

  /* 日志：判了什么、取到什么、结果是什么、走哪个出口。 */
  const lines = events.filter(e => e.kind === 'log' && e.nodeId === 'IF').map(e => e.line)
  check('★ 日志里说了「取到什么值」', lines.some(l => l.includes('当前值')), lines.join(' | '))
  check('★ 日志里说了「共几条条件、怎么合成」', lines.some(l => l.includes('全部满足')), lines.join(' | '))
  check('★★ 日志里说了「走哪个出口」（流程事件完整）',
    lines.some(l => l.includes('判断结果') && l.includes('成立')), lines.join(' | '))
  check('条件判断有 started / success 事件（不是静默的一步）',
    events.some(e => e.kind === 'started' && e.nodeId === 'IF')
    && events.some(e => e.kind === 'success' && e.nodeId === 'IF'))

  /* ── 情形 B：一条条件都没填 → 明确报错，不静默当成立 ── */
  const d2 = fake()
  const ev2 = []
  await runGraph(
    { nodes: [specOf('src'), ifSpec('IF', {}), specOf('yes')], edges: [{ id: 'e1', source: 'src', target: 'IF' }, { id: 'e2', source: 'IF', target: 'yes', sourceHandle: 'true' }] },
    d2.fn,
    { onEvent: e => ev2.push(e) },
  )
  const fail2 = ev2.filter(e => e.kind === 'failed')
  check('★ 没填条件 → 明确报错（不静默当成立）', fail2.length > 0, fail2.map(e => e.error).join(' / '))
  check('报错说清该填什么', fail2.some(e => String(e.error).includes('条件')), fail2.map(e => e.error).join(' / '))
  check('没填条件时不派发它', !d2.calls.some(c => c.nodeId === 'IF'), d2.calls.map(c => c.nodeId).join(','))

  /* ── 情形 C：老存档（只有 expr）经调度器照旧能跑 ── */
  const d3 = fake({ src: { ok: true, status: 'success', output: { 价格: 59 } } })
  const ev3 = []
  const dispatch3 = async (req, signal) => {
    if (req.nodeId === 'IF') {
      const v = branchFn(req.command, { nodeId: 'IF', workdir: '.', upstream: req.context.upstream })
      d3.calls.push({ nodeId: 'IF', upstream: req.context.upstream, command: req.command })
      return { ok: true, status: 'success', output: v }
    }
    return d3.fn(req, signal)
  }
  await runGraph(
    {
      nodes: [specOf('src'), ifSpec('IF', { expr: 'input.价格 < 100' }), specOf('yes'), specOf('no')],
      edges: [
        { id: 'e1', source: 'src', target: 'IF' },
        { id: 'e2', source: 'IF', target: 'yes', sourceHandle: 'true' },
        { id: 'e3', source: 'IF', target: 'no', sourceHandle: 'false' },
      ],
    },
    dispatch3,
    { onEvent: e => ev3.push(e) },
  )
  check('★★ 老存档（只有 expr）照旧走成立那条', d3.calls.some(c => c.nodeId === 'yes'), d3.calls.map(c => c.nodeId).join(','))
  const lines3 = ev3.filter(e => e.kind === 'log' && e.nodeId === 'IF').map(e => e.line)
  check('日志明说用的是老写法', lines3.some(l => l.includes('老写法')), lines3.join(' | '))

  /* 两样都填：按 expr 算，并明说「上面的条件没生效」。 */
  const d4 = fake()
  const ev4 = []
  const dispatch4 = async (req, signal) => {
    if (req.nodeId === 'IF') {
      const v = branchFn(req.command, { nodeId: 'IF', workdir: '.', upstream: req.context.upstream })
      d4.calls.push({ nodeId: 'IF', upstream: req.context.upstream, command: req.command })
      return { ok: true, status: 'success', output: v }
    }
    return d4.fn(req, signal)
  }
  await runGraph(
    {
      nodes: [specOf('src'), ifSpec('IF', { expr: 'true', conditions: [{ left: { kind: 'field', nodeId: 'src', field: 'x' }, op: 'notEmpty' }] }), specOf('yes')],
      edges: [{ id: 'e1', source: 'src', target: 'IF' }, { id: 'e2', source: 'IF', target: 'yes', sourceHandle: 'true' }],
    },
    dispatch4,
    { onEvent: e => ev4.push(e) },
  )
  const lines4 = ev4.filter(e => e.kind === 'log' && e.nodeId === 'IF').map(e => e.line)
  check('★ 两样都填时明说「上面的条件没生效」（不静默二选一）',
    lines4.some(l => l.includes('没生效')), lines4.join(' | '))
}

console.log('')
console.log('⑩ 循环里：条件能读 item / index / outer.item（嵌套）')
{
  /** 造一个循环节点规格。 */
  const loopSpec = (id, params, parentId) => {
    const s = {
      id,
      def: { id: 'flow.loop', label: '循环', executor: 'builtin', inputs: [], outputs: [{ id: 'out', label: '出', type: 'any' }] },
      params,
      onError: 'stop',
      skipped: false,
    }
    if (parentId !== undefined) s.parentId = parentId
    return s
  }
  const specOf = (id, defId, parentId) => {
    const s = {
      id,
      def: { id: defId, label: id, executor: 'builtin', inputs: [], outputs: defId === 'flow.if' ? IF_DEF.outputs : [{ id: 'out', label: '出', type: 'any' }] },
      params: {}, onError: 'stop', skipped: false,
    }
    if (parentId !== undefined) s.parentId = parentId
    return s
  }

  /* 简单情形：源 → 循环 L（体内 head → IF → yes） */
  const nodes = [
    specOf('src', 'code.js'),
    loopSpec('L', { items: { nodeId: 'src', field: '' } }),
    specOf('h', 'code.js', 'L'),
    { ...specOf('IF', 'flow.if', 'L'), params: {
      conditions: [{ left: { kind: 'loop', name: 'item.go' }, op: 'is', value: 'true', valueType: 'boolean' }],
    } },
    specOf('yes', 'code.js', 'L'),
  ]
  const edges = [
    { id: 'e1', source: 'h', target: 'IF' },
    { id: 'e2', source: 'IF', target: 'yes', sourceHandle: 'true' },
  ]
  const seen = []
  let round = 0
  const dispatch = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: [{ go: false, n: 1 }, { go: true, n: 2 }] }
    if (req.nodeId === 'h') { const out = { go: round === 1, n: round }; round += 1; return { ok: true, status: 'success', output: out } }
    if (req.nodeId === 'IF') {
      seen.push(req.command.__judge)
      return { ok: true, status: 'success', output: branchFn(req.command, { nodeId: 'IF', workdir: '.', upstream: req.context.upstream }) }
    }
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  await runGraph({ nodes, edges }, dispatch)

  check('★ 循环里条件能取到 item.go（两轮各一次）', seen.length === 2, String(seen.length))
  check('★★ 第 1 轮 item.go = false → 左侧值是 false',
    seen[0]?.conds?.[0]?.left === false, JSON.stringify(seen[0]))
  check('★★ 第 2 轮 item.go = true → 左侧值是 true',
    seen[1]?.conds?.[0]?.left === true, JSON.stringify(seen[1]))
  check('日志原料里带「循环变量 item.go」', String(seen[0]?.describe?.[0] ?? '').includes('循环变量'), JSON.stringify(seen[0]?.describe))

  /* 嵌套情形：内层条件写 `outer.item.go`。 */
  const nestedNodes = [
    specOf('src', 'code.js'),
    loopSpec('L1', { items: { nodeId: 'src', field: '' } }),
    specOf('h1', 'code.js', 'L1'),
    loopSpec('L2', { mode: 'count', count: 1 }, 'L1'),
    specOf('h2', 'code.js', 'L2'),
    { ...specOf('IF2', 'flow.if', 'L2'), params: {
      conditions: [{ left: { kind: 'loop', name: 'outer.item.go' }, op: 'is', value: 'true', valueType: 'boolean' }],
    } },
  ]
  const nestedSeen = []
  let outerRound = 0
  const dispatch2 = async (req) => {
    if (req.nodeId === 'src') return { ok: true, status: 'success', output: [{ go: true }, { go: false }] }
    if (req.nodeId === 'h1') { const out = { go: outerRound === 0 }; outerRound += 1; return { ok: true, status: 'success', output: out } }
    if (req.nodeId === 'h2') return { ok: true, status: 'success', output: { inner: true } }
    if (req.nodeId === 'IF2') {
      nestedSeen.push(req.command.__judge)
      return { ok: true, status: 'success', output: branchFn(req.command, { nodeId: 'IF2', workdir: '.', upstream: req.context.upstream }) }
    }
    return { ok: true, status: 'success', output: 'out:' + req.nodeId }
  }
  await runGraph({ nodes: nestedNodes, edges: [{ id: 'e1', source: 'h1', target: 'L2' }] }, dispatch2)
  check('★★ 嵌套时条件能取到 outer.item.go（第 1 轮 true）',
    nestedSeen[0]?.conds?.[0]?.left === true, JSON.stringify(nestedSeen))
  check('★★ 第 2 轮外层 item.go = false → 内层取到的也是 false',
    nestedSeen[1]?.conds?.[0]?.left === false, JSON.stringify(nestedSeen))
}

console.log('')
console.log(failed === 0 ? '结论：结构化条件全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
