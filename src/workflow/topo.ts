/** 图形拓扑排序（派发器「先跑上游」的依据）。
 *
 * 依据：docs/机制-设计依据.md §4.2；原始调研 docs/调研-三个工作流项目工程化.md。
 * 算法照 litegraph.js 的 `computeExecutionOrder`（**MIT，可抄码**，src/litegraph.js:1161-1300）——
 * 它就是 Kahn 算法：
 *   1 把所有「没有上游」的节点入队
 *   2 出队一个，写进结果，把它每个下游的欠账减一
 *   3 某个下游欠账减到 0 就入队
 *   4 队列空了还有节点没写进结果 —— 那些就在环里
 *
 * 两个产出：
 *   - order —— 一个可行的执行顺序
 *   - level —— 每个节点在第几层（同层互不依赖，**可以同时跑**）
 * 派发器按层推进：同层并发、跨层必须等上游。
 *
 * 环（循环节点故意造的回边）不会被当成错误：环里的节点拿不到 level，
 * 派发器把它们当成「上游是循环体」单独处理，不参与分层。
 */

/** 参与排序的最小节点形状。 */
export interface TopoNode {
  /** 节点实例 id。 */
  id: string
}

/** 参与排序的最小连线形状。 */
export interface TopoEdge {
  /** 起点节点实例 id。 */
  source: string
  /** 终点节点实例 id。 */
  target: string
  /**
   * 起点接在哪个出口上（多出口节点才有）。
   *
   * 分支可达性要用它：节点报「只走某个出口」时，接在**别的出口**上的边不算上游。
   * 排序本身不看这个字段（依赖关系与接哪个出口无关）。
   */
  sourceHandle?: string
}

/** 排序结果。 */
export interface TopoResult {
  /** 可行的执行顺序（先上游后下游）。 */
  order: string[]
  /** 节点 id → 层级（0 是最上游）。环里的节点不在表里。 */
  level: Record<string, number>
  /** 排不进去的节点（处在环里）。正常工作流为空。 */
  cycles: string[]
}

/**
 * 对一张图做拓扑排序并分层。
 *
 * 重复边（同一对节点连了多条）只算一次依赖，否则欠账永远减不到 0。
 * 指向不存在节点的边直接忽略（画布上删节点时可能残留）。
 *
 * @param nodes - 节点清单。
 * @param edges - 连线清单。
 * @returns 执行顺序、层级、环内节点。
 */
export function topoSort(nodes: readonly TopoNode[], edges: readonly TopoEdge[]): TopoResult {
  const ids = new Set(nodes.map(n => n.id))
  /** 节点 → 它的下游（去重）。 */
  const next = new Map<string, string[]>()
  /** 节点 → 还没结算的上游个数。 */
  const debt = new Map<string, number>()
  for (const n of nodes) {
    next.set(n.id, [])
    debt.set(n.id, 0)
  }
  const seen = new Set<string>()
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue
    const key = e.source + "\u0000" + e.target
    if (seen.has(key)) continue
    seen.add(key)
    next.get(e.source)?.push(e.target)
    debt.set(e.target, (debt.get(e.target) ?? 0) + 1)
  }

  const level: Record<string, number> = {}
  const queue: string[] = []
  for (const n of nodes) {
    if ((debt.get(n.id) ?? 0) === 0) {
      queue.push(n.id)
      level[n.id] = 0
    }
  }

  const order: string[] = []
  while (queue.length > 0) {
    const cur = queue.shift() as string
    order.push(cur)
    const here = level[cur] ?? 0
    for (const nxt of next.get(cur) ?? []) {
      // 下游的层级 = 它所有上游里最深的那层 + 1
      level[nxt] = Math.max(level[nxt] ?? 0, here + 1)
      const left = (debt.get(nxt) ?? 0) - 1
      debt.set(nxt, left)
      if (left === 0) queue.push(nxt)
    }
  }

  const cycles = nodes.filter(n => !(n.id in level)).map(n => n.id)
  return { order, level, cycles }
}

/**
 * 取某个节点的全部上游（含间接上游），用于「只跑这一段」。
 *
 * @param id - 起始节点 id。
 * @param edges - 连线清单。
 * @returns 起始节点 + 它所有上游的 id 集合。
 */
export function withUpstream(id: string, edges: readonly TopoEdge[]): Set<string> {
  const got = new Set<string>([id])
  const stack: string[] = [id]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    for (const e of edges) {
      if (e.target !== cur || got.has(e.source)) continue
      got.add(e.source)
      stack.push(e.source)
    }
  }
  return got
}
