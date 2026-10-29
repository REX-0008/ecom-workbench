/** 对齐辅助线（拖动节点时，与其它节点对齐就画一条线）。
 *
 * 依据：Langflow 有一份约 100 行的实现（MIT 可抄），本文件按同样思路重写。
 *
 * 解决什么：手拖节点时很难对齐，一排节点看着歪歪扭扭。
 * 做法：拖动时算出与其它节点的**纵向中心线 / 横向中心线**的距离，
 * 只要在阈值内就画一条虚线，并把节点吸附过去。
 *
 * 阈值定 6px：太小了看不出来（等于没有），太大了会「抢」用户的手（拖不到想要的位置）。
 */

/** 一条辅助线。 */
export interface HelperLine {
  /** 线的方向：竖线（对齐 x）或横线（对齐 y）。 */
  type: 'vertical' | 'horizontal'
  /** 线在画布坐标系里的位置（竖线给 x，横线给 y）。 */
  position: number
}

/** 吸附阈值（像素）。 */
const SNAP = 6

/**
 * 算出一个被拖动的节点与其它节点的对齐线，以及吸附后的坐标。
 *
 * @param dragged - 正在拖的节点（id + 中心坐标）。
 * @param others - 其它节点的中心坐标（id + 中心）。
 * @param pos - 被拖节点的当前位置（左上角坐标）。
 * @returns 辅助线清单、吸附后的位置、是否发生了吸附。
 */
export function computeHelperLines(
  dragged: { id: string, centerX: number, centerY: number },
  others: readonly { id: string, centerX: number, centerY: number }[],
  pos: { x: number, y: number },
): { lines: HelperLine[], snapped: { x: number, y: number }, didSnap: boolean } {
  const lines: HelperLine[] = []
  let bestX: number | undefined
  let bestY: number | undefined
  let gapX = SNAP + 1
  let gapY = SNAP + 1
  for (const o of others) {
    if (o.id === dragged.id) continue
    const dx = Math.abs(o.centerX - dragged.centerX)
    if (dx <= SNAP && dx < gapX) { gapX = dx; bestX = o.centerX }
    const dy = Math.abs(o.centerY - dragged.centerY)
    if (dy <= SNAP && dy < gapY) { gapY = dy; bestY = o.centerY }
  }
  let x = pos.x
  let y = pos.y
  if (bestX !== undefined) {
    lines.push({ type: 'vertical', position: bestX })
    /* 中心对齐 → 反推左上角坐标 */
    x = pos.x + (bestX - dragged.centerX)
  }
  if (bestY !== undefined) {
    lines.push({ type: 'horizontal', position: bestY })
    y = pos.y + (bestY - dragged.centerY)
  }
  return { lines, snapped: { x, y }, didSnap: lines.length > 0 }
}
