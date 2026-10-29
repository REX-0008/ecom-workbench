/** 「条件判断」左边能选什么 —— `if-sources.ts` 的三条规则。
 *
 * ## 为什么单独测这个
 *
 * 这三组候选决定了用户在界面上**点得到什么**，而它们一旦算错，症状是
 * 「界面上能选、跑起来取不到」（最难受的那种错：不报错、不发红、只是值为空）。
 *
 * 三条规则：
 *   ① **只给上游**（不含自己 / 下游 / 同容器兄弟）—— 用户原话
 *      「IF 前面的节点就是传入信息的，要不要点两步这个判断应该交给 IF 这个节点」；
 *   ② **循环变量按层给**（`item` / `index` / `outer.item` / `outer.outer.item`）；
 *   ③ **开始节点的输入项**用与调度器**同一个**解析器（`parseInputFields`）。
 *
 * ⚠️ 这些规则原来写在 `WorkflowCanvas.tsx` 的 `useMemo` 里，而那个文件 import 了
 * `.module.css` —— Node 直接跑不起来（`ERR_UNKNOWN_FILE_EXTENSION`），
 * 于是**测不到**。搬进 `if-sources.ts` 就是为了这一条。
 *
 * 跑法：node --import <tsx> tests/if-sources.mjs
 */
import {
  loopVarsOf, startInputNames, upstreamOf, ifSourcesFor, breakSourcesFor, START_DEF_ID,
} from '../src/client/workbench/if-sources.ts'

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

/** 造一个节点（只要能算候选的那几个字段）。 */
function n(id, opts = {}) {
  const node = {
    id,
    label: opts.label ?? '',
    defId: opts.defId ?? 'code.js',
    defLabel: opts.defLabel ?? '代码',
    fields: opts.fields ?? [{ id: 'out', label: '结果' }],
  }
  if (opts.parentId !== undefined) node.parentId = opts.parentId
  return node
}

/** 造一条边。 */
function e(source, target) {
  return { source, target }
}

console.log('=== 条件左边能选什么（if-sources.ts）===')

console.log('')
console.log('① 上游：只有真的走得到的那几个')
{
  /* 形状：  a → b → IF → d
   *          c（孤立）
   *          IF 自己、d（下游）、c（孤立）都不该出现 */
  const nodes = [n('a'), n('b'), n('IF'), n('d'), n('c')]
  const edges = [e('a', 'b'), e('b', 'IF'), e('IF', 'd')]
  const ups = upstreamOf(nodes, edges, 'IF')
  check('上游含直接上游 b', ups.has('b'), [...ups].join(','))
  check('上游含间接上游 a（走两步也认）', ups.has('a'), [...ups].join(','))
  check('★ 不含自己', !ups.has('IF'), [...ups].join(','))
  check('★ 不含下游 d', !ups.has('d'), [...ups].join(','))
  check('★ 不含无关节点 c', !ups.has('c'), [...ups].join(','))
  check('上游恰好两个', ups.size === 2, [...ups].join(','))

  /* 环（存档被手改坏）：不能死循环，也不能把自己算成上游。 */
  const cyc = upstreamOf([n('x'), n('y'), n('IF')], [e('x', 'y'), e('y', 'x'), e('y', 'IF')], 'IF')
  check('★ 有环时不死循环，且自己不算上游', cyc.size === 2 && !cyc.has('IF'), [...cyc].join(','))

  /* 没有入边 → 空（它是起点）。 */
  check('没有上游时是空', upstreamOf([n('IF')], [], 'IF').size === 0)
}

console.log('')
console.log('② 循环变量：按层给名字（与执行期同一套）')
{
  /* 不在循环里：一个都不给。 */
  check('不在循环里 → 空数组', loopVarsOf([n('x')], n('x')).length === 0,
    JSON.stringify(loopVarsOf([n('x')], n('x'))))

  /* 第 1 层循环。 */
  const L1 = n('L1', { defId: 'flow.loop' })
  const inL1 = n('x', { parentId: 'L1' })
  check('第 1 层给 item / index',
    JSON.stringify(loopVarsOf([L1, inL1], inL1)) === JSON.stringify(['item', 'index']),
    JSON.stringify(loopVarsOf([L1, inL1], inL1)))

  /* 第 2 层：外层是 L1，内层是 L2（L2 自己在 L1 里）。 */
  const L2 = n('L2', { defId: 'flow.loop', parentId: 'L1' })
  const inL2 = n('y', { parentId: 'L2' })
  const two = loopVarsOf([L1, L2, inL2], inL2)
  check('★★ 第 2 层多给一组 outer.item / outer.index',
    JSON.stringify(two) === JSON.stringify(['item', 'index', 'outer.item', 'outer.index']),
    JSON.stringify(two))

  /* 第 3 层：`outer.outer.`。 */
  const L3 = n('L3', { defId: 'flow.loop', parentId: 'L2' })
  const inL3 = n('z', { parentId: 'L3' })
  const three = loopVarsOf([L1, L2, L3, inL3], inL3)
  check('★★★ 第 3 层多给 outer.outer.item',
    three.includes('outer.outer.item') && three.includes('outer.outer.index'),
    JSON.stringify(three))
  check('三层共 6 个名字', three.length === 6, JSON.stringify(three))

  /* ⚠️ 父不是循环（分组框）→ 不给（分组框不执行，也就没有迭代变量）。 */
  const G = n('G', { defId: '__group', defLabel: '分组' })
  const inG = n('w', { parentId: 'G' })
  check('★ 父是分组框时不给循环变量', loopVarsOf([G, inG], inG).length === 0,
    JSON.stringify(loopVarsOf([G, inG], inG)))
}

console.log('')
console.log('③ 开始节点的输入项：与调度器同一个解析器')
{
  const START = n('s', { defId: START_DEF_ID, defLabel: '开始' })
  const params = { s: { fields: ['日期 | 要采集哪一天 | 必填 | 2026-10-17', '店铺'] } }
  const names = startInputNames([START, n('x')], id => params[id] ?? {})
  check('★★ 解析出两个输入项名', JSON.stringify(names) === JSON.stringify(['日期', '店铺']), JSON.stringify(names))

  /* 与 `parseInputFields` 的结果必须**逐字一致** —— 这是「界面能选、跑起来取得到」的保证。 */
  const { parseInputFields } = await import('../src/workflow/io-fields.ts')
  const direct = parseInputFields(params.s.fields).map(f => f.name)
  check('★★ 与调度器那份解析结果逐字相同',
    JSON.stringify(names) === JSON.stringify(direct), JSON.stringify(direct))

  check('没有开始节点 → 空数组', startInputNames([n('x')], () => ({})).length === 0)
  check('开始节点没声明输入 → 空数组',
    startInputNames([START], () => ({ s: { fields: [] } })).length === 0)
  check('声明是字符串也认（存档被手改过）',
    JSON.stringify(startInputNames([START], () => ({ fields: '日期\n店铺' }))) === JSON.stringify(['日期', '店铺']),
    JSON.stringify(startInputNames([START], () => ({ fields: '日期\n店铺' }))))
}

console.log('')
console.log('④ ifSourcesFor：三组一起给，且与节点 id 对得上')
{
  /* 形状：  src → IF（在循环 L 里）
   *          L 是循环，IF 的 parentId = L
   *          s 是开始节点，声明了「日期」 */
  const nodes = [
    n('s', { defId: START_DEF_ID, defLabel: '开始' }),
    n('src', { label: '取数', fields: [{ id: 'out', label: '结果' }, { id: 'list', label: '列表' }] }),
    n('L', { defId: 'flow.loop', defLabel: '循环' }),
    n('IF', { defId: 'flow.if', defLabel: '条件判断', parentId: 'L' }),
    n('after', { label: '下游' }),
  ]
  const edges = [e('s', 'src'), e('src', 'IF'), e('IF', 'after')]
  const params = { s: { fields: ['日期 | 说明 | 必填'] } }
  const src = ifSourcesFor(nodes, edges, 'IF', id => params[id] ?? {})

  /** 按 id 找候选（顺序由节点在数组里的次序决定，断言不锚顺序）。 */
  const pick = (id) => src.fields.find(f => f.id === id)
  check('上游节点给到了（src）', pick('src') !== undefined, JSON.stringify(src.fields.map(f => f.id)))
  check('★ 上游节点的字段清单也在（两个输出）',
    (pick('src')?.fields ?? []).length === 2, JSON.stringify(pick('src')?.fields))
  check('★ 显示名用实例名（「取数」不是「代码」）', pick('src')?.name === '取数', pick('src')?.name)
  check('★ 开始节点自己也在上游里（它确实在上游）', src.fields.some(f => f.id === 's'),
    JSON.stringify(src.fields.map(f => f.id)))
  check('★ 下游不在里面', !src.fields.some(f => f.id === 'after'), JSON.stringify(src.fields.map(f => f.id)))
  check('循环变量给到了（在 L 里）', JSON.stringify(src.loopVars) === JSON.stringify(['item', 'index']),
    JSON.stringify(src.loopVars))
  check('开始节点的输入项给到了', JSON.stringify(src.inputs) === JSON.stringify(['日期']),
    JSON.stringify(src.inputs))

  /* 没改名的节点用类型名（用户认得出是什么节点）。 */
  const noName = ifSourcesFor([n('a'), n('IF')], [e('a', 'IF')], 'IF', () => ({}))
  check('没改名时用类型名', noName.fields[0].name === '代码', noName.fields[0].name)

  /* 自己不在候选里（否则「拿自己的输出判断自己」永远取不到）。 */
  check('★ 自己不在候选里', !src.fields.some(f => f.id === 'IF'), JSON.stringify(src.fields.map(f => f.id)))
}

console.log('')
console.log('④ 循环的「跳出条件」能选什么（breakSourcesFor，2026-10-19）')
{
  /* 形状：
   *   s(开始，声明 日期) → L1(循环) ⊃ [ a(体内) → b(体内) ];  L1 ⊃ L2(内层循环) ⊃ [ c(内层体内) ]
   *   outside（循环外，不该出现）
   *
   * ★ 与条件判断节点的**两处关键不同**（正是这一段要钉的）：
   *   ① `fields` 是**循环体内**的节点，不是「上游节点」——
   *      跳出条件判的是「这一轮跑得怎么样」；
   *   ② `loopVars` 取**这个循环自己**那层的变量，不是「调用者所在层」。 */
  const nodes = [
    n('s', { defId: START_DEF_ID, defLabel: '开始' }),
    n('L1', { defId: 'flow.loop', defLabel: '循环' }),
    n('a', { label: '下载', parentId: 'L1' }),
    n('b', { label: '核对', parentId: 'L1' }),
    n('L2', { defId: 'flow.loop', defLabel: '循环', parentId: 'L1' }),
    n('c', { label: '内层步骤', parentId: 'L2' }),
    n('outside', { label: '循环外' }),
  ]
  const params = { s: { fields: ['日期 | 说明 | 必填'] } }
  const src = breakSourcesFor(nodes, 'L1', id => params[id] ?? {})

  /** 按 id 找候选。 */
  const pick = (id) => src.fields.find(f => f.id === id)
  check('★★ 只给**体内**节点，且**排除体内嵌套的子循环**（只有 a、b）',
    JSON.stringify(src.fields.map(f => f.id).sort()) === JSON.stringify(['a', 'b']),
    JSON.stringify(src.fields.map(f => f.id)))
  check('★★ 循环外的节点不在里面（不是「上游」那套）', pick('outside') === undefined,
    JSON.stringify(src.fields.map(f => f.id)))
  check('★ 开始节点也不在（它是上游，不在体内）', pick('s') === undefined,
    JSON.stringify(src.fields.map(f => f.id)))
  check('★ 内层的成员也不在（只给直接子节点）', pick('c') === undefined,
    JSON.stringify(src.fields.map(f => f.id)))
  /* ★ 子循环被排除：它的输出是聚合对象 `{count, results}`，
   * 而且端口只有一个 `done`，选它够不着里面子项，是个死胡同。 */
  check('★★ 体内嵌套的**子循环**不在候选里（拿聚合对象判跳出没意义）',
    pick('L2') === undefined, JSON.stringify(src.fields.map(f => f.id)))

  /* 显示名用实例名（用户认得出「下载」「核对」）。 */
  check('★ 显示名用实例名', pick('a')?.name === '下载', pick('a')?.name)

  /* loopVars：这个循环自己那层 = 第 1 层 → item / index。
   * ⚠️ **不**因为它是「外层」就多给 outer.*（那是内层才有的）。 */
  check('★ loopVars 是这个循环自己那层（item / index）',
    JSON.stringify(src.loopVars) === JSON.stringify(['item', 'index']), JSON.stringify(src.loopVars))

  /* 内层循环自己的跳出条件 → 有 outer.*（它在第 2 层）。 */
  const inner = breakSourcesFor(nodes, 'L2', id => params[id] ?? {})
  check('★★ 内层循环的 loopVars 带 outer.*',
    JSON.stringify(inner.loopVars) === JSON.stringify(['item', 'index', 'outer.item', 'outer.index']),
    JSON.stringify(inner.loopVars))
  check('★ 内层的 fields 是它自己的成员（c）',
    JSON.stringify(inner.fields.map(f => f.id)) === JSON.stringify(['c']),
    JSON.stringify(inner.fields.map(f => f.id)))

  /* 开始节点的输入项照给（跳出条件也能按「日期」判）。 */
  check('开始节点的输入项给到了', JSON.stringify(src.inputs) === JSON.stringify(['日期']),
    JSON.stringify(src.inputs))

  /* 空循环（没有体内节点）→ fields 为空，不是崩。 */
  const noKids = breakSourcesFor([n('L3', { defId: 'flow.loop', defLabel: '循环' })], 'L3', () => ({}))
  check('空循环体 → fields 是空数组（不崩）', noKids.fields.length === 0, JSON.stringify(noKids.fields))
  check('空循环也给出自己的 loopVars', JSON.stringify(noKids.loopVars) === JSON.stringify(['item', 'index']),
    JSON.stringify(noKids.loopVars))

  /* 循环 id 不存在 → 不崩，loopVars 空。 */
  const ghost = breakSourcesFor(nodes, 'nope', () => ({}))
  check('循环 id 不存在 → 不崩、loopVars 空', ghost.loopVars.length === 0, JSON.stringify(ghost.loopVars))
}

console.log('')
console.log(failed === 0 ? '结论：条件左边候选全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
