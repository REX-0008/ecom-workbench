/** 编组**连贯规则**的测试（2026-10-13 瘦身）。
 *
 * ## 为什么只剩这一段
 *
 * 编组改成**名单模型**（照 n8n 的 Canvas Groups）之后，原来那批**坐标换算**
 * 函数全部作废了：建框时算包围盒、把成员坐标改成相对框、解散时再换成绝对坐标、
 * 让框贴紧成员、数框里几个成员 —— 新模型里**成员坐标永不改写**
 * （框是渲染时按包围盒算出来的），这些都不需要。
 *
 * 那一族「框跳走 / 贴边覆盖 / 相对绝对互转错」的 bug 也随之**从根上消失**
 * ——我们曾为此踩过三次。
 *
 * 名单模型自己的测试在 `tests/group-roster.mjs`
 * （框包围盒 / 成员归属唯一性 / 整体拖动 / 描述截断）。
 * 这里只留**与坐标无关**的连贯规则。
 *
 * 跑法：node --import <tsx> tests/group-ops.mjs
 */
import { closeUnderTransit } from '../src/client/workbench/group-ops.ts'

/** 累计失败数。 */
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

console.log('=== 编组连贯规则 ===')
console.log('')
console.log('⑧ 编组必须连贯：夹在中间的节点自动纳入（用户 2026-10-11 要求）')
{
  /* 用户原话：「当一个节点的前后都在一个编组里面，那么他自动进入编组——
   * 编组的意思类似于一个小工作流，他应该是一个连续的动作而不是几个独立的节点。」 */
  const chain = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
    { source: 'C', target: 'D' },
  ]
  const sorted = (s) => [...s].sort().join(',')

  /* ① 链 A→B→C→D，只选了 A 和 C：中间的 B 前后都在框里 → 必须进来。 */
  check('A→B→C→D 选 A、C → B 被纳入', sorted(closeUnderTransit(new Set(['A', 'C']), chain)) === 'A,B,C',
    sorted(closeUnderTransit(new Set(['A', 'C']), chain)))

  /* ② 只选相邻两个（A、B）：B 没有下游在框里、A 没有上游在框里 → **不扩散**。
   * 这条最关键：没有它，算法会顺着链把整张图吞进来。 */
  check('选相邻的 A、B → 不扩散到 C', sorted(closeUnderTransit(new Set(['A', 'B']), chain)) === 'A,B',
    sorted(closeUnderTransit(new Set(['A', 'B']), chain)))

  /* ③ 选了 A 和 D：中间 B、C 都被夹住 → 全进来（整条链）。 */
  check('选 A、D → B、C 都被纳入', sorted(closeUnderTransit(new Set(['A', 'D']), chain)) === 'A,B,C,D',
    sorted(closeUnderTransit(new Set(['A', 'D']), chain)))

  /* ④ 链头：选 B、C → A 的上游没有在框里 → A 不进；D 的下游没有 → D 不进。 */
  check('选 B、C → 不外扩到 A / D', sorted(closeUnderTransit(new Set(['B', 'C']), chain)) === 'B,C',
    sorted(closeUnderTransit(new Set(['B', 'C']), chain)))

  /* ⑤ 多轮传播：A→B→C→D→E，选 A、E。
   * 第一轮 B 与 D 被夹住；第二轮 C 才被夹住（它的前后 B、D 是上一轮才进来的）。
   * 所以「一轮扫描」不够，必须反复到不动。 */
  const long = [
    { source: 'A', target: 'B' }, { source: 'B', target: 'C' },
    { source: 'C', target: 'D' }, { source: 'D', target: 'E' },
  ]
  check('长链选两端 → 多轮传播补齐中间三个',
    sorted(closeUnderTransit(new Set(['A', 'E']), long)) === 'A,B,C,D,E',
    sorted(closeUnderTransit(new Set(['A', 'E']), long)))

  /* ⑥ 分叉汇合：A→B、A→C、B→D、C→D。选 B、D：C 的上游 A 不在、下游 D 在 →
   * 只有一个邻居在框里，**不应该**被拉进来（否则会把无关分支也吞掉）。 */
  const fork = [
    { source: 'A', target: 'B' }, { source: 'A', target: 'C' },
    { source: 'B', target: 'D' }, { source: 'C', target: 'D' },
  ]
  check('分叉图选 B、D → 不把旁支 C 拉进来',
    sorted(closeUnderTransit(new Set(['B', 'D']), fork)) === 'B,D',
    sorted(closeUnderTransit(new Set(['B', 'D']), fork)))
  /* 但选 A、D 时，B 与 C 各自「上游 A 在、下游 D 在」→ 两个都进来。 */
  check('分叉图选 A、D → B、C 都进来（两路都连贯）',
    sorted(closeUnderTransit(new Set(['A', 'D']), fork)) === 'A,B,C,D',
    sorted(closeUnderTransit(new Set(['A', 'D']), fork)))

  /* ⑦ 没有连线的孤点：原样返回，不崩。 */
  check('无连线时原样返回', sorted(closeUnderTransit(new Set(['X', 'Y']), [])) === 'X,Y')
  /* ⑧ 自环（循环节点的回边）不能让它自己把自己算进去。 */
  check('自环不导致异常', sorted(closeUnderTransit(new Set(['A']), [{ source: 'A', target: 'A' }])) === 'A')

  /* ⑨ ⚠️ **上游门槛**：只有「有一个上游在集合里」的节点才允许被沿链拉进来。
   *
   * 为什么单独设这条：光靠 ② 那类测试（选相邻两个）**抓不住**这个门槛被去掉。
   * 真正的反例是**在链头前面还有一个节点**的情形：
   *   图 Z→A→B→C→D，用户选 A、B。
   *   去掉门槛后，Z「能走到 B」于是被拉进来（A 的上游，本不该进）；
   *   有门槛时 Z 没有上游在集合里 → 不进。
   * 实测过：两者结果分别是 `A,B,Z` 与 `A,B`，所以这条能抓住。 */
  const withHead = [{ source: 'Z', target: 'A' }, ...chain]
  check('链头之前的节点不该被拉进来（上游门槛生效）',
    sorted(closeUnderTransit(new Set(['A', 'B']), withHead)) === 'A,B',
    sorted(closeUnderTransit(new Set(['A', 'B']), withHead)))
  /* 同一张图选 A、C 时，B 仍应被纳入（门槛不该把正常情形也拦掉）。 */
  check('同一张图选 A、C → B 仍被纳入',
    sorted(closeUnderTransit(new Set(['A', 'C']), withHead)) === 'A,B,C',
    sorted(closeUnderTransit(new Set(['A', 'C']), withHead)))
}

console.log('')
console.log(failed === 0 ? '结论：连贯规则全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
