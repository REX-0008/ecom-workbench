/** `flow.if` 的**结构化条件**：读取、解析左边、拼成可比的东西。
 *
 * ## 为什么单独一个文件
 *
 * 条件里「左边取哪个值」有三种来源（图里某节点的字段 / 循环变量 / 开始节点的输入），
 * 三者都要在同一处解析 —— 而这三者的表（节点输出、循环变量、输入）**只有调度器手上有**。
 *
 * 但解析规则本身是纯逻辑：给一张「节点 id → 输出」的表就能算。
 * 所以把**规则**放这里（可单测、不碰磁盘、不碰 React），
 * 调度器（`run.ts`）只负责把表递进来。
 *
 * ## 为什么不在 `branch.ts`
 *
 * `branch.ts` 是「分支的通用约定」，它对**任何**多出口节点都成立（不认 `flow.if` 这个 id）；
 * 而这个文件专属于 `flow.if` 的参数形状。混在一起会让「约定」那一层背上节点参数的知识。
 *
 * 参照物见 `branch.ts` 顶部那段（Dify 的 if-else 节点）。
 */
import {
  type IfCondition, type IfOperand, type IfValueType, type ResolvedCondition,
  isEmptyValue, operatorLabel,
} from './branch.ts'

/** 「条件判断」节点的定义 id（照 `LOOP_DEF_ID` 的写法，只在这一个文件里认它）。 */
export const IF_DEF_ID = 'flow.if'

/** 解析左边时要用到的现场（由调度器组装）。 */
export interface IfResolveContext {
  /** 取某个节点的输出（循环体内优先本轮，回落外层）。 */
  outOf: (nodeId: string) => unknown
  /** 取某个节点的显示名（日志里用，认不出时退回 id）。 */
  labelOf: (nodeId: string) => string
  /** 「开始」节点声明并解析好的输入。 */
  inputs?: Record<string, unknown>
  /** 循环注入的迭代变量（`item` / `index`）。 */
  loopVars?: Record<string, unknown>
}

/**
 * 按点号路径取值（`item.url` → `obj.item.url`）。
 *
 * 与 `variables.ts` 的 `readPath` 同一套规则（数组用数字下标），
 * 但**不导出复用**：那个函数的注释属于「变量替换」的语义，
 * 而这里只需要「取一层」，将来要加特性时两者不该被一起拖住。
 *
 * @param source - 取值来源。
 * @param path - 点号路径。
 * @returns 取到的值，或 `undefined`。
 */
function readPath(source: unknown, path: string): unknown {
  let cur: unknown = source
  for (const seg of path.split('.')) {
    if (seg === '') return undefined
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const i = Number(seg)
      if (!Number.isInteger(i)) return undefined
      cur = cur[i]
      continue
    }
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * 把参数里的 `conditions` 读成一个数组（形状不对的项**丢掉**，不整份报错）。
 *
 * 为什么容错：存档可能被手改、也可能是界面写过一半的中间态。
 * 一条坏条件不该让整份工作流跑不起来 —— 但**也不静默**：
 * 调用方拿 `dropped` 的条数发一条日志。
 *
 * @param raw - `params.conditions` 原值。
 * @returns 合法条件，以及被丢掉的条数。
 */
export function readIfConditions(raw: unknown): { conds: IfCondition[], dropped: number } {
  if (!Array.isArray(raw)) return { conds: [], dropped: 0 }
  const conds: IfCondition[] = []
  let dropped = 0
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) { dropped += 1; continue }
    const o = item as Record<string, unknown>
    const left = o.left
    if (left === null || typeof left !== 'object' || Array.isArray(left)) { dropped += 1; continue }
    const lo = left as Record<string, unknown>
    const kind = lo.kind
    let operand: IfOperand | null = null
    if (kind === 'field') {
      const nodeId = typeof lo.nodeId === 'string' ? lo.nodeId.trim() : ''
      if (nodeId === '') { dropped += 1; continue }
      operand = { kind: 'field', nodeId, field: typeof lo.field === 'string' ? lo.field : '' }
    } else if (kind === 'loop') {
      const name = typeof lo.name === 'string' ? lo.name.trim() : ''
      if (name === '') { dropped += 1; continue }
      operand = { kind: 'loop', name }
    } else if (kind === 'input') {
      const name = typeof lo.name === 'string' ? lo.name.trim() : ''
      if (name === '') { dropped += 1; continue }
      operand = { kind: 'input', name }
    } else { dropped += 1; continue }
    const op = typeof o.op === 'string' && o.op !== '' ? o.op : 'notEmpty'
    const c: IfCondition = { left: operand, op }
    if (typeof o.value === 'string') c.value = o.value
    const vt = o.valueType
    if (vt === 'text' || vt === 'number' || vt === 'boolean') c.valueType = vt as IfValueType
    conds.push(c)
  }
  return { conds, dropped }
}

/**
 * 解析一个条件的左边 → 实际值 + 一句给人看的名字。
 *
 * @param op - 左边定义。
 * @param ctx - 解析现场。
 * @returns 值与显示名（取不到时值可能是 `undefined` —— 那是**合法结果**，
 *   「没这个字段」和「字段是空」是两件事，交给比较符去区分）。
 */
export function resolveOperand(op: IfOperand, ctx: IfResolveContext): { value: unknown, label: string } {
  if (op.kind === 'field') {
    const out = ctx.outOf(op.nodeId)
    const who = ctx.labelOf(op.nodeId)
    if (op.field === '') return { value: out, label: who + ' › 整个输出' }
    if (out === null || typeof out !== 'object') return { value: undefined, label: who + ' › ' + op.field }
    const v = readPath(out, op.field)
    return { value: v, label: who + ' › ' + op.field }
  }
  if (op.kind === 'loop') {
    const v = readPath(ctx.loopVars, op.name)
    return { value: v, label: '循环变量 ' + op.name }
  }
  /* input：只认「开始」节点声明过的字段 —— 与 `resolveInputs` 同一套语义，
   * 所以这里直接读已经解析好的表，不再自己判声明。 */
  const v = ctx.inputs?.[op.name]
  return { value: v, label: '输入 ' + op.name }
}

/**
 * 把参数里的结构化条件解析成「可以直接比」的形状。
 *
 * @param params - 节点参数（已合并默认值）。
 * @param ctx - 解析现场。
 * @returns 解析好的条件、逻辑连接词、被丢掉的条数、以及逐条的一句话（日志用）。
 *   **一条合法条件都没有时返回 `null`** —— 那是「没填结构化条件」，
 *   调用方据此回退到旧写法 `expr`（老存档就是这么跑的），
 *   而不是「0 条条件 = 永远成立」（那会让 IF 静默变成一条直通线）。
 */
export function resolveIfConditions(
  params: Record<string, unknown>,
  ctx: IfResolveContext,
): { conds: ResolvedCondition[], logic: 'and' | 'or', dropped: number, describe: string[] } | null {
  const { conds, dropped } = readIfConditions(params.conditions)
  if (conds.length === 0) return null
  const logic: 'and' | 'or' = params.logic === 'or' ? 'or' : 'and'
  const out: ResolvedCondition[] = []
  const describe: string[] = []
  for (const c of conds) {
    const operand = c.left as IfOperand
    const { value, label } = resolveOperand(operand, ctx)
    const r: ResolvedCondition = { left: value, op: c.op ?? 'notEmpty', label }
    if (c.value !== undefined) r.value = c.value
    if (c.valueType !== undefined) r.valueType = c.valueType
    out.push(r)
    /* 日志里说清「取到了什么」—— 空值时要能一眼看出是「没这个字段」还是「字段是空」，
     * 否则用户只能盯着「条件是 false」猜。 */
    const shown = value === undefined ? '（没取到）' : isEmptyValue(value) ? '（空）' : JSON.stringify(value)
    describe.push(label + ' 当前值 ' + shown + ' ｜ ' + operatorLabel(r.op))
  }
  return { conds: out, logic, dropped, describe }
}

/** 一次判断实际走了哪条路（给调度器用）。 */
export type IfPlan =
  /** 按结构化条件判（新写法）。 */
  | { mode: 'rules', conds: ResolvedCondition[], logic: 'and' | 'or', dropped: number, describe: string[] }
  /** 按旧的 JS 表达式判（老存档）。 */
  | { mode: 'expr', expr: string }
  /** 两条路都没内容 —— 什么都没填。 */
  | { mode: 'none' }

/**
 * 决定这次判断走哪条路。
 *
 * ## 判据（用户 2026-10-19 复核过真实存档，兼容面很小）
 *
 *   ① **`expr` 是非空字符串 → 走旧路**。真实存档里 5 份巡查工作流全是这一种
 *      （`input.curfewTop !== true`），另有 1 份天猫取数（`input.hour < 1 || input.hour >= 6`）。
 *      这一条**优先于**新条件：老存档本来就只可能填了 expr，新存档如果两样都填了，
 *      按 expr 算并**在日志里明说**「上面的条件没生效」—— 静默二选一才是灾难。
 *   ② 没有可用的 expr → 看有没有合法的结构化条件。
 *   ③ 两条都没有 → `none`，由节点实现给一句「什么都没填」的可读错误。
 *      **不能**当成「永远成立」：那会让 IF 静默退化成一条直通线，用户以为判断过了。
 *
 * @param params - 节点参数（已合并默认值）。
 * @param ctx - 解析现场（只在走结构化条件时才需要）。
 * @returns 走哪条路。
 */
export function planIf(params: Record<string, unknown>, ctx: IfResolveContext): IfPlan {
  const expr = typeof params.expr === 'string' ? params.expr : ''
  if (expr.trim() !== '') return { mode: 'expr', expr }
  const rules = resolveIfConditions(params, ctx)
  if (rules === null) return { mode: 'none' }
  return { mode: 'rules', ...rules }
}
