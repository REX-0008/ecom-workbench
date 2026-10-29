/** 「跳过节点」的语义实现（纯函数，可单独验）。
 *
 * 为什么单独成文件：跳过的语义很容易写错——常见错误是「跳过＝不跑＝下游拿不到数据」，
 * 那样链就断了，跳过也就失去意义。正确语义是「不执行，但把上游输出原样传下去」。
 *
 * 放纯函数里，是为了能脱离画布单测这条语义。
 */

/**
 * 算出被跳过的节点应该往下游传什么。
 *
 * @param upstream - 该节点的各上游输出（按连线顺序，已过滤掉 undefined）。
 * @returns 要传下去的値：没有上游时返回 undefined；一个上游时原样；多个时给数组。
 */
export function passthroughOf(upstream: readonly unknown[]): unknown {
  if (upstream.length === 0) return undefined
  return upstream.length === 1 ? upstream[0] : upstream
}

/**
 * 一组选中节点该被设成什么状态（实现「一键全跳 / 一键全恢复」）。
 *
 * 规则：**只要有一个还是没跳过的，就全部设为跳过**（第一次点＝全跳）；
 * 反之全部恢复（第二次点＝全恢复）。
 *
 * @param current - 选中节点当前的跳过状态列表。
 * @returns 应该设成什么（true＝跳过）。
 */
export function nextSkipValue(current: readonly boolean[]): boolean {
  return current.some(v => v !== true)
}
