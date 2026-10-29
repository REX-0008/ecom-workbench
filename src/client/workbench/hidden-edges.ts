/** 收起循环时「藏成员」要连带藏哪些边（2026-10-21 修的真 BUG）。
 *
 * ## 症状（用户报的）
 *
 * ```
 * Error code 008：Couldn't create edge for target handle id: "in", edge id: e6.
 * ```
 *
 * React Flow 的 008 = 「按这条边去找端点的端口，没找着」。
 *
 * ## 成因
 *
 * 循环收起时，`shownNodes` 把「父循环已收起」的成员打了 `hidden` ——
 * **节点不渲染**，于是它身上那个 `in` 端口也不存在。
 * 而那条边还在 `edges` 里点名要那个端口 → 每次渲染都报一次 008，
 * 画布上还会留一条连到空气的线。
 *
 * ## 为什么必须抽成纯函数
 *
 * 判据只能落在**数据**上（`hidden` 那位有没有被打上），
 * 而 jsdom 里 React Flow 没有布局、**一条边都画不出来** ——
 * 想从 DOM 上数 `.react-flow__edge` 的话，收起前就是 0 条，断言永远绿（假绿）。
 * 把这个规则搬出来，测试就能直接喂数据、看结果。
 *
 * @param nodes - 全部节点（用来查 `parentId` / `collapsed`）。
 * @param edges - 全部边（只要 `source` / `target`）。
 * @returns 里面每条边加上 `hidden: true` 的判定结果（**同一个顺序**）。
 */
export function hiddenEdgesOf(
  nodes: readonly { id: string, parentId?: string, data?: { def?: { id?: string }, collapsed?: boolean } }[],
  edges: readonly { source: string, target: string }[],
): boolean[] {
  /* 收起的循环 id。判据与 `shownNodes` 那条**同源** —— 两处必须一致，
   * 否则会漂成「节点藏了、边还在」（就是 008）或反过来。 */
  const collapsed = new Set(
    nodes.filter(n => n.data?.def?.id === 'flow.loop' && n.data?.collapsed === true).map(n => n.id),
  )
  if (collapsed.size === 0) return edges.map(() => false)

  /** 某个节点是不是「因为父循环收起而不画」。 */
  const isHidden = (id: string): boolean => {
    const n = nodes.find(x => x.id === id)
    if (n === undefined) return false
    const pid = n.parentId
    return pid !== undefined && collapsed.has(pid)
  }

  /* 任一端被藏 → 这条边也不画。
   * ⚠️ **藏起来而不是删掉**：展开时原样回来，且存档 / 执行完全不感知
   * （收起是显示语义，见 `shownNodes` 的长注释）。 */
  return edges.map(e => isHidden(e.source) || isHidden(e.target))
}
