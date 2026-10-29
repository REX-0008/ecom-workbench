/** 画布入口（保留这个文件是为了不动 EcomWorkbench 的引用）。
 *
 * 历史：它原本是「两个画布版本（v1/v2）的切换器」，会包一层 `wrap + stage`。
 * 现在只有一版画布，而 `WorkflowCanvas` **自己就渲染完整外壳**
 * （`.wrap` → 工具条 + `.bodyRow` → 节点库 + `.canvas`），
 * 再包一层会造成：
 *   - 三层 `flex: 1 1 auto` 嵌套，中间那层的 `overflow: hidden` 可能把高度吃掉
 *   - `canvas-switch.module.css` 里的 `.wrap` / `.stage` 与画布自己的 `.wrap` 职责重叠
 *
 * 所以改为**直接转发**：不包任何容器。
 */
import { createElement as h } from 'react'
import { WorkflowCanvas } from './WorkflowCanvas.tsx'

/**
 * 画布入口。
 * @param props.active - 画布是不是**当前可见**的那一屏。
 *   常驻挂载后画布切走不卸载，它的全局键盘监听必须跟着停 —— 见 `WorkflowCanvas` 的说明。
 * @param props.topHidden - 顶部标题是否已收起（透传给画布，只影响那个按钮的显示）。
 * @param props.onToggleTop - 点「收起顶部」时回调。
 * @returns 画布元素（外壳由 WorkflowCanvas 自己渲染）。
 */
export function WorkflowCanvasSwitch({ active = true, topHidden = false, onToggleTop }: {
  active?: boolean
  topHidden?: boolean
  onToggleTop?: () => void
} = {}) {
  return h(WorkflowCanvas, { active, topHidden, onToggleTop })
}
