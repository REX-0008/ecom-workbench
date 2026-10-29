/** 循环体的**计划**（哪些节点属于循环、按什么顺序、从哪进从哪出）。
 *
 * ## 为什么单独一个文件
 *
 * 循环的**执行**在 `run.ts`（它要拿派发器、要发事件），但「**怎么算出循环体**」
 * 是纯粹的图运算 —— 可以脱离派发器、脱离浏览器直接单测。
 * 分开之后，最容易错的那部分（拓扑、首尾识别、容器内外分流）有了独立护栏。
 *
 * ## 用户定的形态（2026-10-12）
 *
 * > 「进去只是外观，本质上还是 N8N 的那套逻辑，也就是说，循环这个框内的最后一个输出
 * >   其实就默认链接到循环的那个回边的意思，**并不是一个相对独立的子图**。」
 *
 * 所以：
 *   - 循环体是**容器**（节点 `parentId` 指向循环节点），不是子图；
 *   - `循环 → 头`、`尾 → 循环` 这两条边**隐式自动补**，画布上不画；
 *   - **内部节点之间仍要连线**（数据流保持显式、可调试）。
 */
import { topoSort, type TopoEdge } from './topo.ts'
/* 条件跳出的条件形状与求值**直接复用** if-else 那一套（照 Dify：两处同一个 Condition 类型）。
 * 不在这里另造一套的理由：比较符 18 个、左边三种来源、界面控件 —— 全是现成的，
 * 抄一份等于埋一颗「两边慢慢漂」的雷（见 `pitfalls/同一件事写两份迟早漂.md`）。 */
import {
  evaluateConditions, type IfCondition, type IfOperand, type IfValueType, type ResolvedCondition,
} from './branch.ts'

/** 循环节点类型 id（与节点库里的定义一致）。 */
export const LOOP_DEF_ID = 'flow.loop'

/** 参与计划的最小节点形状。 */
export interface LoopNodeShape {
  id: string
  /** 节点类型 id（用来认「谁是循环节点」）。 */
  defId: string
  /** 容器归属。 */
  parentId?: string
}

/**
 * 算出「哪些节点属于哪个循环」。
 *
 * 判定不用节点类型字样，而用**边关系**：某节点 `parentId` 指向的那个节点，
 * 如果**本身是循环节点**，那么它就是这个循环的体。
 * 指向分组框的 `parentId` 不算（分组框纯背景，不参与执行）。
 *
 * @param nodes - 全部节点。
 * @returns 子节点 id → 循环节点 id。
 */
export function containerMap(nodes: readonly LoopNodeShape[]): Map<string, string> {
  const loopIds = new Set(nodes.filter(n => n.defId === LOOP_DEF_ID).map(n => n.id))
  const out = new Map<string, string>()
  for (const n of nodes) {
    const p = n.parentId
    if (p !== undefined && loopIds.has(p)) out.set(n.id, p)
  }
  return out
}

/** 一个循环的执行计划。 */
export interface LoopPlan {
  /** 循环体节点 id（只含本循环的直系子节点）。 */
  bodyIds: string[]
  /** 体内的拓扑序（父先于子？这里是上游先于下游）。 */
  order: string[]
  /**
   * 入口节点（体内没有「体内上游」的那些）。
   *
   * 它们**接收循环注入的迭代变量**（`item` / `index`）—— 用户不需要为此连线。
   * 多个入口都允许（循环体可以是「一进多出」的分叉形状）。
   */
  heads: string[]
  /**
   * 出口节点（体内没有「体内下游」的那些）。
   *
   * 每轮结束后取它们的输出汇集成本轮结果。
   */
  tails: string[]
  /** 体内的连线（只保留两端都在体内的）。 */
  innerEdges: TopoEdge[]
  /** 从体外指向体内的真实入边（**保留**：那是显式输入，不清除）。 */
  outerIn: TopoEdge[]
  /** 从体内指向体外的真实出边（**保留**）。 */
  outerOut: TopoEdge[]
  /** 体内排在环里的节点（正常循环体为空；回边才会造成环）。 */
  cycles: string[]
}

/**
 * 算出一个循环的执行计划。
 *
 * @param nodes - 全部节点。
 * @param edges - 全部连线。
 * @param loopId - 循环节点 id。
 * @returns 计划；该循环不存在或没有体时返回 null（由调用方决定怎么报错）。
 */
export function loopPlan(
  nodes: readonly LoopNodeShape[],
  edges: readonly TopoEdge[],
  loopId: string,
): LoopPlan | null {
  if (!nodes.some(n => n.id === loopId && n.defId === LOOP_DEF_ID)) return null
  const bodyIds = nodes.filter(n => n.parentId === loopId).map(n => n.id)
  if (bodyIds.length === 0) return null
  const inBody = new Set(bodyIds)

  const innerEdges: TopoEdge[] = []
  const outerIn: TopoEdge[] = []
  const outerOut: TopoEdge[] = []
  for (const e of edges) {
    const s = inBody.has(e.source)
    const t = inBody.has(e.target)
    if (s && t) innerEdges.push(e)
    else if (!s && t) outerIn.push(e)
    else if (s && !t) outerOut.push(e)
  }

  /* 体内拓扑序：**只喂体内的节点与体内的边** —— 这样体外的东西不会干扰排序。 */
  const graph = topoSort(bodyIds.map(id => ({ id })), innerEdges)

  /* 入口 / 出口按**边关系**算，不按坐标、也不按节点类型。 */
  const hasInnerUp = new Set<string>()
  const hasInnerDown = new Set<string>()
  for (const e of innerEdges) {
    hasInnerDown.add(e.source)
    hasInnerUp.add(e.target)
  }
  const heads = bodyIds.filter(id => !hasInnerUp.has(id))
  const tails = bodyIds.filter(id => !hasInnerDown.has(id))

  return {
    bodyIds,
    order: graph.order.concat(graph.cycles),
    heads,
    tails,
    innerEdges,
    outerIn,
    outerOut,
    cycles: graph.cycles,
  }
}

/**
 * 挑出某个循环**体内直接嵌着**的循环节点。
 *
 * ## ⚠️ 2026-10-19 起它**不再**用来拦截执行
 *
 * 原注释写的是「嵌套循环需要每层各一份迭代变量 + 结果嵌套，本计划的执行模型
 * 只注入一层迭代变量」，于是 `run.ts` 在跑任何循环前先查它、有内层就抛错。
 *
 * 那条模型限制**已经解除**（见 `plans/2026-10-19-嵌套循环-最终方案.md`）：
 *   - 每层各一份迭代变量 → `RunScope.parent` 链 + `loopVarFields`；
 *   - 变量取值 → `{{item}}` 取最内层、`{{outer.item}}` 往外一层；
 *   - 结果 → 只「交上一层」（不做自动嵌套数组）。
 *
 * 现在它只剩**结构查询**这一个用途（想知道「这个循环里有没有套着循环」时用），
 * 执行期改为按 `loopChainDepth` 卡**层数上限**（防呆，不是技术限制）。
 * 保留它是因为它有一条独立单测（`tests/loop-plan.mjs` ⑦）。
 *
 * @param nodes - 全部节点。
 * @param loopId - 外层循环 id。
 * @returns 直接嵌在它体内的循环节点 id 列表（空 = 体内没有循环）。
 */
export function nestedLoops(nodes: readonly LoopNodeShape[], loopId: string): string[] {
  return nodes
    .filter(n => n.parentId === loopId && n.defId === LOOP_DEF_ID)
    .map(n => n.id)
}

/**
 * 一个循环**自己算第几层**（沿 `parentId` 链往上，数沿途有几个循环节点）。
 *
 * 为什么要它：嵌套放开之后，执行期只剩一条限制 —— **层数上限**（防呆）。
 * 判据必须按「这个循环嵌在几层循环里」算，而不是按「它体内还有没有循环」
 * （后者只看得到一层：`L1 ⊃ L2 ⊃ L3` 时，对 L1 只看得到 L2）。
 *
 * 顶层循环返回 1；`L1 ⊃ L2` 时 L2 返回 2。
 *
 * @param nodes - 全部节点。
 * @param loopId - 要算的循环 id。
 * @returns 层数（从 1 起）；该 id 不存在时返回 0。
 */
export function loopChainDepth(nodes: readonly LoopNodeShape[], loopId: string): number {
  const byId = new Map(nodes.map(n => [n.id, n]))
  let depth = 0
  let cur = byId.get(loopId)
  /* 防环：链最多走节点总数那么多步（存档被手改成环时不能死循环）。 */
  let guard = nodes.length + 1
  while (cur !== undefined && guard > 0) {
    if (cur.defId === LOOP_DEF_ID) depth += 1
    cur = cur.parentId === undefined ? undefined : byId.get(cur.parentId)
    guard -= 1
  }
  return depth
}

/**
 * 「哪一层」的链式现场（只要这两个字段，`RunScope` 结构上就满足）。
 *
 * 为什么单独声明：`loopVarFields` 是**纯函数、可单测**的（`tests/loop-plan.mjs`），
 * 不该为了它把 `run.ts` 里的 `RunScope` 搬出来 —— 那个接口带着一堆执行期才有的
 * 东西（`unreachable` / `heads` …），搬出来会让纯逻辑与执行现场耦合。
 */
export interface LoopVarScope {
  /** 这一层的迭代变量（`{ item, index }`）。 */
  loopVars?: Record<string, unknown>
  /** 外面那一层（顶层没有）。 */
  parent?: LoopVarScope
}

/**
 * 把一个作用域的迭代变量展开成**变量表**（`{{item}}` / `{{outer.item}}` 靠它）。
 *
 * ## 取值规则（用户批准的那套）
 *
 * | 写法 | 取哪层 |
 * |---|---|
 * | `{{item}}` / `{{index}}` | **最内层**那份（与嵌套之前完全一致） |
 * | `{{outer.item}}` / `{{outer.index}}` | **往外一层**那份 |
 * | `{{outer.outer.item}}` | 再往外一层（任意深度都成立） |
 *
 * ## 为什么是「逐层拼 outer」而不是「把 loopVars 换成数组」
 *
 * 数组版本会让内层的 `{{item}}` 不知道该取哪层；而 `outer.` 前缀有两个好处：
 *   ① 老存档里所有 `{{item}}` / `{{index}}` 一字不改就是原来的意思（硬判据）；
 *   ② 逐层拼自然得到 `outer.outer`，不必为「第 3 层」再发明写法。
 *
 * ⚠️ **没有外层时不留 `outer` 这个键**：留着它会把 `{{outer}}` 从
 * 「未找到（原样保留 + 一条警告）」变成「替换成空串」——
 * 前者用户查得到，后者是静默的坏值。
 *
 * @param ctx - 当前层的现场（`run.ts` 的 `RunScope` 结构上就满足）。
 * @returns 变量表；顶层返回 `{}`。
 */
export function loopVarFields(ctx: LoopVarScope | undefined): Record<string, unknown> {
  if (ctx === undefined || ctx.loopVars === undefined) return {}
  const out: Record<string, unknown> = { ...ctx.loopVars }
  const outer = loopVarFields(ctx.parent)
  if (Object.keys(outer).length > 0) out.outer = outer
  return out
}

/**
 * 取值时「一层一层往外」的输出表链（`RunScope` 结构上就满足）。
 *
 * 与 `LoopVarScope` 分开声明，是因为「迭代变量」与「节点输出」是两件事：
 * 一个只要 `loopVars`，另一个只要 `local` / `bodyIds`。
 */
export interface ScopedOutputs {
  /** 这一层（本轮）内各节点的输出。 */
  local?: ReadonlyMap<string, unknown>
  /** 这一层包含哪些节点（用来判断「这个输出算哪一层的」）。 */
  bodyIds?: ReadonlySet<string>
  /** 外面那一层（顶层没有）。 */
  parent?: ScopedOutputs
}

/**
 * 取一个节点的输出，**按它所属的最近那一层**取。
 *
 * ## 这条规则就是「不读上一轮」的实现（别改成「本地没有就往外回落」）
 *
 * `run.ts` 里记载过一个真 BUG：写成「本地没有这个键就回落读外层」时，
 * 「本层起点、但本轮还没跑」会读到**上一轮的残留**，症状是「循环数据莫名串味」。
 * 所以判据必须是**归属**（这个节点属于哪一层），而不是**本地表里有没有这个键**：
 *
 * ```
 * 走在内层 → 起点在内层体里 → 只读内层本轮 local（没有就是没有，绝不回落）
 *          → 起点在外层体里   → 只读外层本轮 local（同样不回落）
 *          → 起点在顶层       → 读全局 outputs
 * ```
 *
 * 嵌套之后这是同一类问题**深一层**：内层若把「外层体里的起点」当成「全局」，
 * 就会读到外层**上一轮**写进全局表的残留。
 *
 * @param nodeId - 起点节点 id。
 * @param scope - 当前层现场（`undefined` = 顶层）。
 * @param fallback - 全局输出表（顶层那份）。
 * @returns `found` = 归属层确实产出过它；`value` 是产出值。
 */
export function scopedOutputOf(
  nodeId: string,
  scope: ScopedOutputs | undefined,
  fallback: ReadonlyMap<string, unknown>,
): { found: boolean, value: unknown } {
  let cur: ScopedOutputs | undefined = scope
  while (cur !== undefined) {
    if (cur.bodyIds?.has(nodeId) === true) {
      /* 找到了归属层 —— **只认这一层本轮**，绝不往外回落。 */
      return { found: cur.local?.has(nodeId) === true, value: cur.local?.get(nodeId) }
    }
    cur = cur.parent
  }
  return { found: fallback.has(nodeId), value: fallback.get(nodeId) }
}

/* ══ 条件跳出（`breakConditions`，照 Dify 的 `break_conditions`）═══════════════

参照物：`refs-projects/dify/web/app/components/workflow/nodes/loop/types.ts`

```ts
export type LoopNodeType = CommonNodeType & {
  break_conditions?: Condition[]   // 与 if-else 同一个 Condition 类型
  loop_count: number
  logical_operator?: LogicalOperator
}
```

⚠️ **Dify 的后端执行器没有 checkout**，所以「运行时怎么判 break」没读到源码，
语义只从类型推：**一组条件，按 `logical_operator` 合成一个结果，成立就结束这个循环**
（结束的是**这个循环**，不是整个工作流）。

⚠️ **n8n 那半没有对应能力**：`SplitInBatches` 的 `noItemsLeft` 出口是「没有剩余项了」，
不是「按条件跳出」。所以这一条**只有 Dify 一个参照**，不是「两家取一半」。

## 我们的三条取舍（都有理由，别当成没抄全）

1. **条件形状直接复用 `IfCondition`**（`workflow/branch.ts`），不新造一套。
   Dify 也是「与 if-else 同一个 Condition 类型」——界面控件、比较符、左边三种来源
   全部现成，用户学一次就够。
2. **多一条 `breakLogic`（and / or）**，照 Dify 的 `logical_operator`。
   默认 `and`（与 `flow.if` 的 `logic` 同一个默认值）。
3. **每层各判各的**：判据取的是**本层本轮**的现场（`ctx`），不是共享的一张表。
   所以内层跳出不会停外层；外层跳出后内层也就不再开新一轮（它根本没被叫起来）。

## 「跳出」与「失败」是两件事（硬要求）

跳出**不是失败**：不发 `failed`、不置 `aborted`、循环节点照常报 `success`，
并且**已经收集到的轮次结果照常给出**。理由：用户要的是「跑够了我自己停」，
把它做成失败会让下游的失败策略（`stop` / `continue`）误判，
也会在运行记录里显示成「红叉」——那是假报错。
*/

/**
 * 读一个循环的跳出配置。
 *
 * ## 容错（与 `readIfConditions` 同一条纪律）
 *
 * 存档可能被手改、也可能是界面写过一半的中间态。所以：
 *   - 不是数组 → 当作「没配」（不跳）；
 *   - 数组里形状不对的项 → **丢掉**，由调用方拿 `dropped` 报一句（不静默）；
 *   - **一条合法条件都没有 → 当作「没配」**，绝不当作「永远成立」。
 *     后者会让循环静默只跑一轮 —— 与 `flow.if` 那边「0 条条件不等于成立」同源。
 *
 * @param raw - `params.breakConditions` 原值。
 * @returns 合法的条件，以及被丢掉的条数。
 */
export function readBreakConditions(raw: unknown): {
  conds: IfCondition[]
  dropped: number
} {
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
 * 一个循环这**一层**的跳出配置（已经解析成「可以直接比」的形状）。
 *
 * `null` 表示「没配」—— 调用方据此**完全跳过**判定（老存档走的就是这条路，
 * 一行都不多跑）。这与「配了但条件不成立」是两件事。
 */
export interface BreakRule {
  /** 已解析出左边值的条件。 */
  conds: ResolvedCondition[]
  /** 多条条件怎么合成一个结果。 */
  logic: 'and' | 'or'
}

/**
 * 判定「这一轮跑完之后该不该跳出」。
 *
 * @param rule - 本层的跳出配置（`null` = 没配 → 永远不跳）。
 * @returns 是否跳出，以及逐条的一句话说明（日志用；没配时是空数组）。
 * @throws 比较符不认识时（由调用方的失败策略处理，不静默当「不跳」）。
 */
export function shouldBreakLoop(rule: BreakRule | null): { break: boolean, detail: string[] } {
  if (rule === null || rule.conds.length === 0) return { break: false, detail: [] }
  const r = evaluateConditions(rule.conds, rule.logic)
  return { break: r.pass, detail: r.detail }
}

/**
 * 一个「选节点 + 选字段」参数的值（照 Dify 的 `ValueSelector`）。
 *
 * 形状：`{ nodeId, field }`。`field` 为 `''` 表示「取那个节点的**整体输出**」
 * （节点只有一个输出字段时用户不必再选一次）。
 */
export interface NodeFieldRef {
  /** 源节点 id（画布上的实例 id）。 */
  nodeId: string
  /** 该节点的输出字段名；空串 = 取整体输出。 */
  field: string
}

/**
 * 从参数里读出一个「选节点 + 选字段」的值。
 *
 * ⚠️ **必须容错**：存档可能被手改、也可能是旧版本写的，所以形状不对时返回 `null`
 * 而不是抛错 —— 让调用方给一句可读的提示（「请选一个数据来源」），
 * 比在深层抛 TypeError 好查得多。
 *
 * @param raw - 参数原值。
 * @returns 解析结果；形状不对返回 `null`。
 */
export function readNodeField(raw: unknown): NodeFieldRef | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as { nodeId?: unknown, field?: unknown }
  if (typeof o.nodeId !== 'string' || o.nodeId === '') return null
  const field = typeof o.field === 'string' ? o.field : ''
  return { nodeId: o.nodeId, field }
}

/**
 * 按 `NodeFieldRef` 从一个「节点 id → 输出」表里取值，并（可选）钻进字段。
 *
 * ## `scope` 是 2026-10-19 加的可选参数（嵌套循环用）
 *
 * 不传时行为与以前**逐字一致**（只查 `outputs` 那一张表）—— 老调用、老存档不受影响。
 * 传了之后按**归属层**找：选的节点若属于内层体，就读内层本轮的 `local`；
 * 属于外层体就读外层本轮的；都不属于才落回 `outputs`。
 *
 * 为什么必须有它：内层循环的「遍历哪个数据」要能选**外层体里**某个节点的输出，
 * 而那张表在全局 `outputs` 里只留着**最后一轮**的残留（见 `scopedOutputOf`）。
 *
 * @param ref - 选中的节点与字段。
 * @param outputs - 兜底的节点输出表（顶层是全局 `outputs`；循环内是每轮的 `local`）。
 * @param scope - 可选的「一层一层往外」现场；不传 = 只看 `outputs`。
 * @returns 取到的值；节点还没跑过、或字段不存在时返回 `undefined`。
 */
export function resolveNodeField(
  ref: NodeFieldRef,
  outputs: ReadonlyMap<string, unknown>,
  scope?: ScopedOutputs,
): unknown {
  let out: unknown
  if (scope !== undefined) {
    /* 按归属层找。**归属层里没有 = 就是没有**（不往外回落 —— 那是串味 bug 的写法）。 */
    const got = scopedOutputOf(ref.nodeId, scope, outputs)
    if (!got.found) return undefined
    out = got.value
  } else {
    if (!outputs.has(ref.nodeId)) return undefined
    out = outputs.get(ref.nodeId)
  }
  if (ref.field === '') return out
  if (out === null || typeof out !== 'object') return undefined
  return (out as Record<string, unknown>)[ref.field]
}

/**
 * 把循环的输入展开成「要迭代的项」。
 *
 * 两种模式：
 *   - `mode='count'`：固定次数，每项是 `{ index }`。
 *   - `mode='items'`：用 `value`（由调用方按 `items` 选择器解析出来的值）逐项。
 *     是数组 → 逐项；不是数组 → **明确报错**（见下）。
 *
 * ⚠️ **2026-10-13 改**：原来从「上游输出数组」里**猜**一个数组出来
 * （`upstream.find(u => Array.isArray(u))`），拆掉端口之后这个来源没有了，
 * 改由参数选择器**明确指定**。
 * 「取到的不是数组」也从「包成一项继续跑」改成**明确报错** ——
 * 因为选择器是用户明确选的，选错了就该说清，而不是静默按一条跑
 * （静默的话用户会以为「循环跑了但只处理了一条」，比报错难查得多）。
 *
 * @param params - 循环节点的参数。
 * @param value - 按 `items` 选择器解析出来的值。
 * @returns 要迭代的项，以及一条警告（没有为空串）。
 * @throws 逐条遍历模式下取到的值不是数组时。
 */
export function iterationItems(
  params: Record<string, unknown>,
  value: unknown,
): { items: unknown[], warning: string } {
  const mode = typeof params.mode === 'string' ? params.mode : 'items'
  const maxItersRaw = typeof params.maxIters === 'number' && Number.isFinite(params.maxIters)
    ? Math.floor(params.maxIters)
    : 100
  const maxIters = Math.max(1, maxItersRaw)

  let items: unknown[]
  if (mode === 'count') {
    const countRaw = typeof params.count === 'number' && Number.isFinite(params.count) ? Math.floor(params.count) : 5
    const count = Math.max(0, countRaw)
    items = Array.from({ length: count }, (_v, i) => ({ index: i }))
  } else if (Array.isArray(value)) {
    items = value
  } else if (value === undefined) {
    throw new Error('循环没有拿到数据：请在「遍历哪个数据」里选一个上游节点的输出字段。')
  } else {
    throw new Error('「遍历哪个数据」选到的不是一个列表（' + typeof value + '）：'
      + '逐条遍历要选数组/列表类型的输出。若要重复固定次数，把「循环方式」改成「固定重复几次」。')
  }

  let warning = ''
  if (items.length > maxIters) {
    warning = '要迭代 ' + String(items.length) + ' 项，超过上限 ' + String(maxIters)
      + ' 项，只跑前 ' + String(maxIters) + ' 项（上限可在节点设置里调大）'
    items = items.slice(0, maxIters)
  }
  return { items, warning }
}

/**
 * 汇总一轮的出口输出。
 *
 * 单个出口 → 直接是它的输出（最常见，结果数组就是「每轮的输出」）。
 * 多个出口 → 组成 `{ 出口节点id: 输出 }`，不丢信息。
 *
 * @param tails - 出口节点 id。
 * @param local - 本轮的输出表。
 * @returns 本轮结果。
 */
export function collectRound(tails: readonly string[], local: ReadonlyMap<string, unknown>): unknown {
  if (tails.length === 1) return local.get(tails[0] as string)
  const out: Record<string, unknown> = {}
  for (const t of tails) out[t] = local.get(t)
  return out
}

/**
 * 按「结果取哪个」参数，把每轮的完整结果**收窄**成用户要的那一项。
 *
 * ## 参照物（用户 2026-10-13 指定「参考那两个工作流参考」）
 *
 * **n8n**（官方 `Loop Over Items` 文档原文）：
 * > 「The node saves the original incoming data, and with each iteration, returns a
 * > predefined amount of data through the **loop** output. When the node execution
 * > completes, it **combines all of the processed data** and returns it through the
 * > **done** output.」
 * → 它把**所有轮**的结果合并成一份从 `done` 出去，**没有「取体内哪个变量」这个选项**。
 *
 * **Dify**（`nodes/iteration/types.ts`）：
 * ```ts
 * output_selector: ValueSelector   // 取体内哪个变量作为整体输出
 * flatten_output: boolean          // 全是列表时是否摊平
 * ```
 * → 它是**用户指定**「从体内哪个节点取」。
 *
 * ## 我们的做法（两家各取一半）
 *
 * - **默认（不选）**：照 **n8n** —— 给每轮结果组成的数组 + 轮数。
 * - **选了 `result`**：照 **Dify** —— 只取那个节点/字段在每轮的值组成数组。
 *   这正是「循环里跑一个下载节点、只想要它的输出」这类常见用法。
 *
 * ⚠️ **默认必须是「全给」而不是「猜一个」**：旧行为就是全给，
 * 改成「必须选」会让已有工作流的结果形状变化（下游读 `results` 的会读不到）。
 * **选了才收窄** —— 向后兼容。
 *
 * ⚠️ **不做 `flatten_output`**（Dify 有，n8n 没有）：那是用户没提出的额外能力。
 * 要摊平，在循环后面接一个现有节点即可（「一切皆工作流」的用法）。
 *
 * @param results - 每轮的完整结果（`collectRound` 的产出）。
 * @param ref - 「结果取哪个」的选择器；`null` = 没选（全给）。
 * @param locals - 每轮的输出表（按轮序），用来按 `ref` 取值。
 * @returns 循环的输出对象。
 */
export function buildLoopOutput(
  results: readonly unknown[],
  ref: NodeFieldRef | null,
  locals: readonly ReadonlyMap<string, unknown>[],
): { count: number, results: unknown[], picked?: unknown[] } {
  const base = { count: results.length, results: [...results] }
  /* 没选 → 照 n8n：每轮结果全给出（旧行为，向后兼容）。 */
  if (ref === null) return base
  /* 选了 → 照 Dify：逐轮取那个节点的那个字段。 */
  return { ...base, picked: locals.map(l => resolveNodeField(ref, l)) }
}
