/** 并行体的**计划**（框内怎么切成几路、每路按什么顺序、结果按什么次序摆）。
 *
 * ## 为什么单独一个文件
 *
 * 与 `loop.ts` 同一个理由：**执行**在 `run.ts`（要拿派发器、要发事件），
 * 而「**怎么算出并行体、怎么切路**」是纯粹的图运算 —— 可以脱离派发器单测。
 * 最容易错的那部分（切路、顺序、端点）因此有了独立护栏。
 *
 * ## 用户定的形态（2026-10-21 / 22）
 *
 * 一个节点里并行跑多件事（如两个平台同时取数）：
 *   - 归属与循环**同一套** `parentId`（不另造归属机制 —— 见 AGENTS.md「容器现状」）；
 *   - 一路 = 框内一个「没有来自框内的入边」的成员，加上它在框内的全部下游；
 *   - 路与路并发，每路内部保持顺序，全部有结果才往下走；
 *   - 输出 = 按「每路起点在拓扑序里的位置」排好序的数组。
 *
 * ## 框内多路汇到同一个节点 —— **明确拒绝**，不静默给结果
 *
 * 形状：甲→丙、乙→丙（甲、乙 都是框内起点）。让丙「等两边都到」等于在并行内部
 * 再造一套依赖调度，复杂度陡增；n8n 与 Dify 也都不隐式支持跨分支汇合，
 * 而是靠**显式合并节点**做 —— 我们有 `flow.merge`。
 *
 * 所以这种形状由 `parallelPlan` 返回 `kind: 'cross-lane-merge'` 并指出
 * 「哪几路汇到了哪个节点」，由调度器当场报错（先合并、或改成串联）。
 *
 * ## 曾经的做法与它错在哪（2026-10-22 校核抓出来的）
 *
 * 第一版是「静默归属」：从每个起点往下走，走到的都归这一路，后一路盖掉前一路。
 * 后果是三重的：
 *   ① 汇合点被**最后**一路抢走（不是文件头当年写的「最早一路」），文档与实现不一致；
 *   ② 被抢的那一路丢了末端，**它的结果整个从输出里消失**；
 *   ③ 汇合点读到的是「对面那一路当时有没有跑完」—— 于是同一个图，只改并发上限，
 *      结果就不同（串行时可能从全局读到，并发时读不到）。
 * 不报错、不丢数据的模样、但结果不对，且依赖并发上限 —— 这是最坏的一类，
 * 所以改成**当场拒绝**。
 *
 * ⚠️ 画布当前**不能**把节点放进并行框（`container-ops.ts` 的 `isContainer`
 * 只认分组框与循环）。所以并行体现在只能通过改存档里成员的 `parentId` 建立 ——
 * 这一条写在节点说明里，不许写成「拖进去即可」。
 */
import { topoSort, type TopoEdge } from './topo.ts'

/** 并行节点类型 id（与节点库里的定义一致）。 */
export const PARALLEL_DEF_ID = 'flow.parallel'

/** 参与计划的最小节点形状。 */
export interface ParallelNodeShape {
  id: string
  /** 节点类型 id（用来认「谁是并行节点」）。 */
  defId: string
  /** 容器归属。 */
  parentId?: string
}

/** 一路（框内一条独立的分支）。 */
export interface ParallelLane {
  /** 这一路的起点（框内没有来自框内的入边的那个成员）。 */
  head: string
  /** 这一路的全部节点 id（按框内拓扑序，起点在最前）。 */
  ids: string[]
  /** 这一路的末端（路内没有下游的那些），结果从它们的输出取。 */
  tails: string[]
}

/** 一个并行节点的执行计划。 */
export interface ParallelPlan {
  /**
   * 结论。
   *
   * `ok` = 能跑；`cross-lane-merge` = 框内有多路汇到同一个节点（**明确拒绝**）；
   * `empty` = 框里没有成员（与「汇合」是两回事，所以不合成同一个值）。
   */
  kind: 'ok' | 'cross-lane-merge' | 'empty'
  /** 并行体节点 id（只含本并行节点的直系子节点）。 */
  bodyIds: string[]
  /** 体内的拓扑序（上游先于下游；环里的排在最后）。 */
  order: string[]
  /** 切出来的几路（按起点在拓扑序里的位置排；`kind !== 'ok'` 时为空）。 */
  lanes: ParallelLane[]
  /** 体内的连线（只保留两端都在体内的）。 */
  innerEdges: TopoEdge[]
  /** 从体外指向体内的入边（保留：那是显式输入）。 */
  outerIn: TopoEdge[]
  /** 从体内指向体外的出边（保留）。 */
  outerOut: TopoEdge[]
  /**
   * 跨路汇合的位置（`kind === 'cross-lane-merge'` 时才有）。
   *
   * 一条 = 一个被两条以上支路指向的体内节点。`nodes` 是它的体内上游节点，
   * 调度器据此说清「哪几个汇到了哪」。
   */
  merges: { target: string, sources: string[] }[]
}

/**
 * 算出一个并行节点的执行计划。
 *
 * @param nodes - 全部节点。
 * @param edges - 全部连线。
 * @param parallelId - 并行节点 id。
 * @returns 计划；该并行节点不存在时返回 null（调用方据此报错）。
 */
export function parallelPlan(
  nodes: readonly ParallelNodeShape[],
  edges: readonly TopoEdge[],
  parallelId: string,
): ParallelPlan | null {
  if (!nodes.some(n => n.id === parallelId && n.defId === PARALLEL_DEF_ID)) return null
  const bodyIds = nodes.filter(n => n.parentId === parallelId).map(n => n.id)
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

  const base: Omit<ParallelPlan, 'kind'> = {
    bodyIds, order: [], lanes: [], innerEdges, outerIn, outerOut, merges: [],
  }
  if (bodyIds.length === 0) return { ...base, kind: 'empty' }

  /* 体内拓扑序：**只喂体内的节点与体内的边** —— 体外的东西不干扰排序。 */
  const graph = topoSort(bodyIds.map(id => ({ id })), innerEdges)
  const order = graph.order.concat(graph.cycles)
  const pos = new Map(order.map((id, i) => [id, i]))

  /* 邻接表（去重，方向：上游 → 下游）与反向表（下游 ← 上游）。 */
  const next = new Map<string, string[]>()
  const prev = new Map<string, string[]>()
  for (const id of bodyIds) { next.set(id, []); prev.set(id, []) }
  const seen = new Set<string>()
  for (const e of innerEdges) {
    const key = e.source + '\u0000' + e.target
    if (seen.has(key)) continue
    seen.add(key)
    next.get(e.source)?.push(e.target)
    prev.get(e.target)?.push(e.source)
  }

  /* 起点 = 体内没有「来自体内的入边」的那些（按拓扑序）。 */
  const heads = order.filter(id => (prev.get(id) ?? []).length === 0)

  /* ── ① 先判「跨路汇合」──────────────────────────────────────────
   *
   * 判据不是「有几个体内上游」，而是「这些上游是不是分属不同的支路」。
   * 一个成员分叉到两个下游、再合回来（甲→乙、甲→丙、乙→丁、丙→丁）**不是**跨路汇合 ——
   * 丁的两个上游都从甲出发，仍属同一路。
   *
   * 做法：从每个起点做一次可达集，然后看每个节点的体内上游分别来自哪几个起点。
   * 汇合点的上游来自两个以上不同起点 = 跨路汇合（**明确拒绝**）。
   * 环里的节点（没有任何起点能到）自然只有同一个来源，不误报。 */
  const reachOf = new Map<string, Set<string>>()
  for (const head of heads) {
    const got = new Set<string>()
    const stack = [head]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (got.has(cur)) continue
      got.add(cur)
      for (const nxt of next.get(cur) ?? []) stack.push(nxt)
    }
    reachOf.set(head, got)
  }
  const merges: { target: string, sources: string[] }[] = []
  for (const id of order) {
    const ups = prev.get(id) ?? []
    if (ups.length < 2) continue
    /* 这个节点的每个体内上游分别属于哪几个起点。 */
    const origins = new Set<string>()
    for (const up of ups) {
      for (const [head, reach] of reachOf) if (reach.has(up)) origins.add(head)
    }
    if (origins.size > 1) merges.push({ target: id, sources: ups })
  }
  if (merges.length > 0) return { ...base, order, merges, kind: 'cross-lane-merge' }

  /* ── ② 切路（没有跨路汇合时，每个节点只可能属于一路）────────────── */
  const owner = new Map<string, number>()
  const lanes: ParallelLane[] = []
  for (const head of heads) {
    if (owner.has(head)) continue
    const idx = lanes.length
    const seenInLane = new Set<string>([head])
    const stack = [head]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      /* ⚠️ **已被前面某一路收走的不再抢**（2026-10-22 修）。
       * 上面那道跨路汇合检测已经拒掉了真会撞车的形状；这里再守一道，
       * 防的是「将来有人放宽检测」时又退化成静默抢节点（那正是这次的 bug）。 */
      if (owner.has(cur)) continue
      owner.set(cur, idx)
      for (const nxt of next.get(cur) ?? []) {
        if (seenInLane.has(nxt)) continue
        seenInLane.add(nxt)
        stack.push(nxt)
      }
    }
    lanes.push({ head, ids: [], tails: [] })
  }

  /* 环里的节点（有体内入边、却没有起点能走到它）各起一路 —— 不让它们静默消失。 */
  for (const id of order) {
    if (owner.has(id)) continue
    owner.set(id, lanes.length)
    lanes.push({ head: id, ids: [], tails: [] })
  }

  for (const lane of lanes) {
    const idx = lanes.indexOf(lane)
    lane.ids = order.filter(id => owner.get(id) === idx)
    const inLane = new Set(lane.ids)
    lane.tails = lane.ids.filter(id => !(next.get(id) ?? []).some(n => inLane.has(n)))
  }

  /* 按「起点在拓扑序里的位置」排 —— 结果数组的顺序据此确定（并发不影响顺序）。 */
  lanes.sort((a, b) => (pos.get(a.head) ?? 0) - (pos.get(b.head) ?? 0))

  return { ...base, order, lanes, kind: 'ok' }
}
