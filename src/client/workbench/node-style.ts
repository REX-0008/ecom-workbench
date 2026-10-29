/** 版本 1 · 状态 → 色调名映射。
 *
 * 六态在视觉上要分成五档（STATE_META 的 tone 只有四档，queued 与 idle 共用一个），
 * 所以这里按状态名直接给 CSS 局部类名：CSS 里每个类对应一组发光变量。
 */
import type { NodeState } from '../../workflow/model.ts'

/** 状态 → CSS 局部类名后缀（与 v1-canvas.module.css 的类名一一对应）。 */
const TONE: Record<NodeState, string> = {
  idle: 'idle',
  queued: 'queued',
  running: 'running',
  success: 'success',
  failed: 'failed',
  missing: 'missing',
  cancelled: 'cancelled',
}

/**
 * 取某状态对应的色调类名后缀。
 * @param state - 六态之一。
 * @returns CSS Modules 里存在的类名键。
 */
export function toneClass(state: NodeState): string { return TONE[state] }
