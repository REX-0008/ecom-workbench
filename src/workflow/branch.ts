/** 分支的**通用约定**（调度器不特判任何节点 id）。
 *
 * ## 约定
 *
 * 节点输出里带 `__handle: '<出口名>'` 时，**只有那个出口是活的**；
 * 没有这个字段时（绝大多数节点）全部出口都活 —— 行为与今天完全一致。
 *
 * 为什么做成「约定」而不是「调度器认 `flow.if` 这个 id」：
 *   - 多出口节点不止条件判断一种（将来可能有三路分流、错误分支……），
 *     按 id 特判等于每加一种就改一次调度器；
 *   - 节点自己的实现（builtin 函数）最清楚走了哪个出口，让它**报出来**最直接。
 *
 * ## 未走的分支怎么被「不执行」
 *
 * 调度器按**可达性**推：一个节点的所有入边都来自「未走的分支」时，
 * 它没有任何活上游 → 判为不可达 → 跳过且**不派发**。
 * 这样分支下游的整条链都自然不跑，不需要调度器去逐个标记。
 *
 * ## 两套条件写法（2026-10-19）
 *
 * | | 参数 | 谁求值 |
 * | --- | --- | --- |
 * | **结构化**（新，默认） | `conditions`：每条 = 左边取哪个值 + 比较符 + 右边填什么 | `evaluateConditions` |
 * | **JS 表达式**（旧，兼容） | `expr`：一段 `input.x > 3` 这样的代码 | `evaluateCondition` |
 *
 * 为什么两套都留：5 份巡查工作流的夜禁判断全是旧写法，存档躺在真实数据目录里
 * —— 删掉旧路等于让整个巡查板块停摆。判据很明确：
 * **`expr` 是非空字符串就按旧路算**（2026-10-19 复核过真实存档，那里只有
 * `input.curfewTop !== true` 这一种写法，兼容面很小）。
 */
import type { NodeDef } from './model.ts'

/** 输出里携带「哪个出口活着」的字段名。 */
export const BRANCH_KEY = '__handle'

/**
 * 「走失败分支」那个出口的 id（`onError: 'continueErrorOutput'`）。
 *
 * ## 与 n8n 的差异：靠**命名**不靠位置（有意为之）
 *
 * n8n 把失败出口**追加**在正常出口之后、靠**位置索引**区分
 * （`nodeSuccessData[mainOutputTypes.length - 1]`，见
 * `refs-projects/n8n/packages/workflow/src/node-helpers.ts:1331-1350`）。
 * 我们这套模型的边用 `sourceHandle` 字符串指出口（`RunSpecEdge.sourceHandle`），
 * 存档里**没有「位置」这个概念** —— 改成位置要动画布与全部存档。
 *
 * 所以照 n8n 的**语义**（追加一个出口、失败时只有它活），标识用**命名**。
 * ⚠️ 两处必须一致，改名要一起改：
 *   · 界面画那个红出口：`src/client/workbench/WorkflowNode.tsx:33` 的 `ERROR_HANDLE`
 *     （客户端不 import 本文件，是另一份常量）；
 *   · 引擎派生那个出口：`src/workflow/specs.ts` 的 `withErrorOutput`。
 */
export const ERROR_HANDLE = '__error'

/**
 * 一个节点这次跑完，哪些出口是活的。
 *
 * @param output - 节点的输出。
 * @param def - 它的定义（用来知道它有几个出口）。
 * @returns 活的出口名；`null` 表示「全部出口都活」（没有分支信息）。
 */
export function liveHandles(output: unknown, def: NodeDef): string[] | null {
  if (output === null || typeof output !== 'object') return null
  const h = (output as Record<string, unknown>)[BRANCH_KEY]
  if (typeof h !== 'string' || h === '') return null
  /* 只认定义里真实存在的出口（防止节点报了一个不存在的名字，
   * 那会让下游永远不可达 —— 静默地什么都不跑比报错更难查）。 */
  return def.outputs.some(o => o.id === h) ? [h] : null
}

/**
 * 一条入边是否「活着」。
 *
 * @param handle - 这条边接在起点的哪个出口上（undefined = 单出口，等同唯一出口）。
 * @param handles - 起点这次活着的出口（`null` = 全活）。
 * @returns 该边是否应当被当作有效上游。
 */
export function edgeIsLive(handle: string | undefined, handles: string[] | null): boolean {
  if (handles === null) return true
  /* 没写 handle 的边：接在单出口节点上时视为那个唯一出口。 */
  if (handle === undefined) return handles.length > 0
  return handles.includes(handle)
}

/* ══ 结构化条件（照 Dify 的 IF/ELSE 节点）═════════════════════════════════

参照物：`refs-projects/dify/web/app/components/workflow/nodes/if-else/`
  · `Condition = { id, varType, variable_selector, comparison_operator, value }`
  · `IfElseNodeType = { logical_operator: 'and'|'or', conditions: Condition[], cases, … }`
  · 比较符全集在它的 `types.ts`（`contains` / `is` / `isNot` / `empty` / `>` / `in` …）

## 三处**有意**与 Dify 不同（别当成没抄全）

1. **右边只能是「填进去的值」，不能选变量**。Dify 的 `Condition.value` 也是
   字面量（`string | string[] | boolean`），不是选择器 —— 这一条**照它**。
   要「两个上游字段互相比较」，用 `code.js` 算一次，别在这里发明变量对变量。
2. **不做多分支 `cases`**。Dify 的 IF/ELSE 能配「否则如果……再否则……」，
   那是把 IF 与 SWITCH 合成一个节点。我们的场景（夜禁、抓到 0 条）只要两路，
   而多分支要改调度器的出边命名与画布的多端口布局 —— 那是独立一件事。
   两路可以用多个 IF 串起来，语义完全等价。
3. **不做 `allOf`**。它只对「数组里每一项都满足」有意义，属类型专用运算符；
   我们这里比标量，需要时在 `code.js` 里判断。

## 三种左边（`IfOperand`）

| kind | 从哪取 | 典型用法 |
| --- | --- | --- |
| `field` | 图里某个节点的输出字段（`nodeId` + `field`） | 「③ 算时间」的 `curfewTop` |
| `loop` | 循环变量（`item` / `index`，可带点号 `item.url`） | 循环里逐条判断 |
| `input` | 「开始」节点声明的输入项 | 「日期 / 是否手动跑」 |

⚠️ **左边取值在派发前由调度器解析**（`run.ts` 的 `resolveIfConditions`），因为：
  · 只有调度器手上有「所有节点的输出」这张表；
  · 命令要能序列化过 HTTP，**带不了闭包**；
  · 循环变量住在 `ctx.loopVars` 里，也只有调度器知道。
所以 `branchFn` 拿到的是**已经解析成具体值**的条件（`ResolvedCondition`），它只管比。
这跟循环的 `items: { nodeId, field }` 由调度器解析是同一个路子。

## 输出必须带上游数据（用户 2026-10-19 明确要求）

「判断完了后面的节点还得知道干嘛」—— 所以 IF 的输出是**上游原样**，只多一个
`__handle` 标记从哪个出口走。不这么做的话，IF 下游的节点就取不到 `{{字段}}`，
用户得给每个 IF 都接一条旁路（正是用户说的「每一个 IF 前面都得有一个
帮他区分的节点」那种别扭）。
*/

/** 一个条件的左边：从哪取值。 */
export type IfOperand =
  /** 图里某个节点的输出字段。`field` 为空串 = 取那个节点的整体输出。 */
  | { kind: 'field', nodeId: string, field: string }
  /** 循环变量。`name` 可带点号路径，如 `item.url`。 */
  | { kind: 'loop', name: string }
  /** 「开始」节点声明的输入项。 */
  | { kind: 'input', name: string }

/**
 * 比较符（照 Dify 的 `ComparisonOperator`，去掉两个不适用的，见上）。
 *
 * 顺序就是界面上下拉的顺序：先是「空 / 有没有」，再是「等于」，最后是大小与包含。
 */
export const IF_OPERATORS = [
  { id: 'empty', label: '为空', unary: true, hint: '没值、空文本、空列表、空对象都算「为空」' },
  { id: 'notEmpty', label: '不为空', unary: true, hint: '与「为空」相反' },
  { id: 'exists', label: '有这个字段', unary: true, hint: '字段存在就算有（值是空也算）' },
  { id: 'notExists', label: '没有这个字段', unary: true, hint: '字段压根不存在（不是「值为空」）' },
  { id: 'isNull', label: '是空值', unary: true, hint: '只有空（没定义 / null）算；0 与空文本不算' },
  { id: 'isNotNull', label: '不是空值', unary: true, hint: '与「是空值」相反' },
  { id: 'is', label: '等于', unary: false, hint: '按右边选的类型比：选「真假」就按真假比，选「数字」就按数字比' },
  { id: 'isNot', label: '不等于', unary: false, hint: '与「等于」相反' },
  { id: 'contains', label: '包含', unary: false, hint: '左边的文本里含右边的字' },
  { id: 'notContains', label: '不包含', unary: false, hint: '与「包含」相反' },
  { id: 'startWith', label: '开头是', unary: false, hint: '左边以右边开头' },
  { id: 'endWith', label: '结尾是', unary: false, hint: '左边以右边结尾' },
  { id: 'gt', label: '大于', unary: false, hint: '两边都是数字时按数字比，否则按文本比' },
  { id: 'gte', label: '大于等于', unary: false, hint: '同上' },
  { id: 'lt', label: '小于', unary: false, hint: '同上；左边没取到值时一律不成立' },
  { id: 'lte', label: '小于等于', unary: false, hint: '同上' },
  { id: 'in', label: '是其中之一', unary: false, hint: '右边填一组（用逗号或换行隔开）' },
  { id: 'notIn', label: '不是其中任何一个', unary: false, hint: '与「是其中之一」相反' },
] as const

/** 比较符的 id。 */
export type IfOperator = typeof IF_OPERATORS[number]['id']

/** 右边那个值的类型（决定怎么比）。 */
export type IfValueType = 'text' | 'number' | 'boolean'

/**
 * 一个比较符是不是单目（不需要右边的值）。
 *
 * @param op - 比较符 id。
 * @returns 单目则 true。
 */
export function operatorIsUnary(op: string): boolean {
  return IF_OPERATORS.find(o => o.id === op)?.unary === true
}

/**
 * 一个比较符的中文名（找不到时原样返回，别让界面出现空白）。
 *
 * @param op - 比较符 id。
 * @returns 中文名。
 */
export function operatorLabel(op: string): string {
  return IF_OPERATORS.find(o => o.id === op)?.label ?? op
}

/** 界面上「一条条件」存成什么样（`params.conditions` 的每一项）。 */
export interface IfCondition {
  /** 左边：从哪取值。 */
  left?: IfOperand
  /** 比较符。 */
  op?: string
  /** 右边：填进去的值（单目运算符不用）。 */
  value?: string
  /** 右边按什么比（默认按文本）。 */
  valueType?: IfValueType
}

/** 已经把左边解析成具体值的一条条件（`branchFn` 实际吃到的东西）。 */
export interface ResolvedCondition {
  /** 左边实际取到的值。 */
  left: unknown
  /** 比较符。 */
  op: string
  /** 右边填的原文。 */
  value?: string
  /** 右边按什么比。 */
  valueType?: IfValueType
  /** 给人看的一句话（如「③ 算时间 › curfewTop」），只用于日志。 */
  label?: string
}

/**
 * 空值判定（`empty` / `notEmpty` 用）。
 *
 * 比 JS 的真值判定更宽：空对象 `{}` 也算空。
 * 理由与 `evaluateCondition` 那条一样 —— 采集里「没拿到东西」的直觉就是「空的」，
 * 而 `{}` 在 JS 里是真值，不特殊处理用户会写反。
 *
 * @param v - 要判断的值。
 * @returns 是否为空。
 */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}

/** 值 → 比较用的文本（`undefined` / `null` 给空串，避免变成 "undefined"）。 */
function toText(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

/** 值 → 数字（不是数字给 `null`）。 */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 值 → 真假（与旧路一致：**空数组判假**）。 */
function toBool(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  return Boolean(v)
}

/**
 * 右边填的原文 → 按声明的类型转成可比的值。
 *
 * @param raw - 用户填的文本。
 * @param type - 声明的类型（默认按文本）。
 * @returns 转好的值。
 */
export function coerceRight(raw: string | undefined, type: IfValueType | undefined): unknown {
  const t = raw ?? ''
  if (type === 'number') {
    const n = toNumber(t)
    /* 填不成数字就**原样当文本**，让「等于 'abc'」这类比较仍能按文本走 ——
     * 转成 NaN 会让所有比较都静默变成 false。 */
    return n === null ? t : n
  }
  if (type === 'boolean') {
    const s = t.trim()
    return s === 'true' || s === '是' || s === '1'
  }
  return t
}

/**
 * 比一条条件。
 *
 * @param c - 已解析出左边值的条件。
 * @returns 是否成立。
 * @throws 比较符不认识时（由节点的失败策略处理，不静默当 false）。
 */
export function compareOne(c: ResolvedCondition): boolean {
  const op = c.op
  const left = c.left
  const right = coerceRight(c.value, c.valueType)

  switch (op) {
    case 'empty': return isEmptyValue(left)
    case 'notEmpty': return !isEmptyValue(left)
    case 'exists': return left !== undefined
    case 'notExists': return left === undefined
    case 'isNull': return left === undefined || left === null
    case 'isNotNull': return !(left === undefined || left === null)
    case 'is':
    case 'isNot': {
      let same: boolean
      if (c.valueType === 'boolean') same = toBool(left) === right
      else if (c.valueType === 'number') {
        const a = toNumber(left)
        const b = toNumber(right)
        same = a !== null && b !== null && a === b
      } else same = toText(left) === toText(right)
      return op === 'is' ? same : !same
    }
    case 'contains': return toText(left).includes(toText(right))
    case 'notContains': return !toText(left).includes(toText(right))
    case 'startWith': return toText(left).startsWith(toText(right))
    case 'endWith': return toText(left).endsWith(toText(right))
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      /* 两边都像数字就按数字比，否则按文本比 —— 这条规则写在界面的 hint 里。
       * 左边没值时一律不成立（「没取到」不该被当成 0，从而误判「小于 5」成立）。 */
      if (left === undefined || left === null) return false
      const a = toNumber(left)
      const b = toNumber(right)
      let cmp: number
      if (a !== null && b !== null) cmp = a - b
      else {
        const x = toText(left)
        const y = toText(right)
        cmp = x < y ? -1 : x > y ? 1 : 0
      }
      if (op === 'gt') return cmp > 0
      if (op === 'gte') return cmp >= 0
      if (op === 'lt') return cmp < 0
      return cmp <= 0
    }
    case 'in':
    case 'notIn': {
      const list = toText(right).split(/[,，、\n\r]/).map(s => s.trim()).filter(s => s !== '')
      const hit = list.includes(toText(left))
      return op === 'in' ? hit : !hit
    }
    default:
      /* 不认识的比较符 → **明确报错**，不静默当 false。
       * 静默的话表现为「条件永远不成立」，而界面上看着一切正常，极难查。 */
      throw new Error('不认识的比较符：' + String(op))
  }
}

/**
 * 比一组条件（`and` 全部成立 / `or` 任一成立）。
 *
 * @param conds - 条件（左边值已解析好）。
 * @param logic - `and` 或 `or`（其余一律按 `and` —— 宁可严，不可松）。
 * @returns 总结果，以及逐条的一句话说明（供日志用）。
 */
export function evaluateConditions(
  conds: readonly ResolvedCondition[],
  logic: string | undefined,
): { pass: boolean, detail: string[] } {
  const detail: string[] = []
  if (conds.length === 0) return { pass: true, detail }
  const results: boolean[] = []
  for (const c of conds) {
    const ok = compareOne(c)
    results.push(ok)
    const who = c.label !== undefined && c.label !== '' ? c.label : '（没选变量）'
    const rhs = operatorIsUnary(c.op) ? '' : ' ' + toText(coerceRight(c.value, c.valueType))
    detail.push(who + ' ' + operatorLabel(c.op) + rhs + ' → ' + (ok ? '成立' : '不成立'))
  }
  const pass = logic === 'or' ? results.some(Boolean) : results.every(Boolean)
  return { pass, detail }
}

/**
 * 求值一个条件表达式（`flow.if` 的**旧写法**用）。
 *
 * 安全边界：用 `new Function` 跑在**本进程**里，只传 `input` 一个名字。
 * 与 `code.js` 节点同样的做法（本项目已有先例，不是新引入的风险面）——
 * 这些工作流本来就是用户自己写的，不是外部输入。
 *
 * 真值判定照 JavaScript 的惯例，但**额外把空数组判为假**：
 * 「抓到 0 条就不继续」是采集里最常见的意图，而 `[]` 在 JS 里是真值，
 * 不特殊处理的话用户写 `input.length` 才对、写 `input` 就悄悄反了。
 *
 * @param expr - 表达式文本（用 `input` 代表上游数据）。
 * @param input - 上游数据。
 * @returns 条件是否成立。
 * @throws 表达式为空或求值抛错时（由调用方按节点失败策略处理）。
 */
export function evaluateCondition(expr: string, input: unknown): boolean {
  if (expr.trim() === '') throw new Error('没填判断条件')
  const fn = new Function('input', '"use strict";return (' + expr + ')') as (i: unknown) => unknown
  const v = fn(input)
  if (Array.isArray(v)) return v.length > 0
  return Boolean(v)
}
