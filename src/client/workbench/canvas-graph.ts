/** 画布的「图形派生」：连线的样子 + 每个节点能引用哪些变量。
 *
 * 为什么单独成文件（2026-10-08 拆分）：
 *   这两个都是**纯函数**（输入节点与连线，输出派生数据），不碰 React 状态。
 *   它们原先挤在画布主文件里，而这个文件是「改连线颜色也要读 1400 行」的典型。
 *
 * 两个概念的区别（别看混）：
 *   - `decorateEdge` —— 连线**看起来**什么样（颜色跟随源端口、运行中会流动）
 *   - `computeAvailableVars` —— 这个节点**能写哪些** `{{变量}}`（上游输出端口名）
 */
import type { Edge } from '@xyflow/react'
import { PORT_COLORS, type NodeDef, type PortType } from '../../workflow/model.ts'
import type { V1Node } from './WorkflowNode.tsx'
/**
 * 端口类型 → 连线颜色（源端口没有声明时退回 any 的灰）。
 * @param defs - 节点类型库（按 defId 查）。
 * @param nodes - 画布节点。
 * @param sourceId - 源节点实例 id。
 * @param handle - 源端口 id。
 * @returns 颜色字符串。
 */
export function edgeColor(defs: Map<string, NodeDef>, nodes: V1Node[], sourceId: string, handle?: string | null): string {
  const n = nodes.find(x => x.id === sourceId)
  if (n === undefined) return PORT_COLORS.any
  const def = defs.get(n.data.def.id)
  const port = def?.outputs.find(p => p.id === handle)
  const t: PortType = port?.type ?? 'any'
  return PORT_COLORS[t]
}

/**
 * 给一条连线补齐「颜色 + 发光 + 是否流动」的视觉属性。
 * @param defs - 节点类型库。
 * @param nodes - 画布节点。
 * @param e - 原始连线。
 * @returns 带 style 的连线。
 */
export function decorateEdge(defs: Map<string, NodeDef>, nodes: V1Node[], e: Edge): Edge {
  const color = edgeColor(defs, nodes, e.source, e.sourceHandle)
  const srcState = nodes.find(n => n.id === e.source)?.data.state
  return {
    ...e,
    type: 'default',
    animated: srcState === 'running' || srcState === 'queued',
    style: { stroke: color, filter: 'drop-shadow(0 0 4px ' + color + ')' },
    markerEnd: { type: 'arrowclosed' as never, color, width: 16, height: 16 },
  }
}

/**
 * 按连线算出「每个节点能引用哪些变量」。
 *
 * 依据：一个节点的可用变量＝它所有上游节点的**输出端口名**（那是下游能取到的字段来源）。
 * 再补两个前缀空间：`env.` 与 `vars.`（环境变量与全局变量）。
 *
 * 为什么算这个：光实现 `{{}}` 替换不够——用户还得知道**有哪些名字可写**。
 * 这份清单会显示在节点的设置区里，点一下就能复制。
 *
 * @param nodes - 画布节点。
 * @param edges - 画布连线。
 * @returns 节点实例 id → 可用变量名列表（已排序去重）。
 */
export function computeAvailableVars(nodes: V1Node[], edges: Edge[]): Record<string, string[]> {
  const defOf = new Map(nodes.map(n => [n.id, n.data.def]))
  const out: Record<string, string[]> = {}
  for (const n of nodes) {
    const names = new Set<string>()
    for (const e of edges) {
      if (e.target !== n.id) continue
      const up = defOf.get(e.source)
      for (const p of up?.outputs ?? []) names.add(p.id)
    }
    /* 上游输出端口名之外，给两个前缀空间留个提示位 */
    out[n.id] = [...names].sort()
  }
  return out
}

/** 把示例数据转成画布节点。 */
