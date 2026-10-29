/** 连线合法性校验。
 *
 * 依据：docs/机制-设计依据.md §4.4；原始调研 docs/调研-三个工作流项目工程化.md。
 * 抄的是 Langflow 的 `utils/reactflowUtils.ts:414-540`（**MIT，可抄码**）的三个要点，按我们的模型简化：
 *
 *   1 **不能自己连自己**（source === target）
 *   2 **同类型才让连**（端口颜色编码 = 数据类型；不同类型不允许混连）
 *   3 **不许连成环**（除回路节点外）—— 原实现完全没有环检测，连成环后 ELK 布局与执行都会出问题
 *
 * 另外补一条 Langflow 没有的：**一个入口端口只能接一条线**（多入边会让数据来源不明确）。
 */
import type { Connection, Edge } from '@xyflow/react'
import { PORT_COLORS, type NodeDef, type PortType } from '../../workflow/model.ts'

/** 校验所需的最小上下文。 */
export interface ValidateContext {
  /** 节点 id → 节点定义（用于查端口类型）。 */
  defs: Map<string, NodeDef>
  /** 节点实例 id → 它的类型定义 id。 */
  nodeDefId: Map<string, string>
  /** 当前所有连线。 */
  edges: Edge[]
}

/**
 * 查某个端口的数据类型。
 * @param ctx - 校验上下文。
 * @param nodeId - 节点实例 id。
 * @param handle - 端口 id。
 * @param dir - 入口还是出口。
 * @returns 端口类型；查不到返回 null。
 */
function portType(ctx: ValidateContext, nodeId: string, handle: string | null | undefined, dir: 'in' | 'out'): PortType | null {
  if (handle === null || handle === undefined) return null
  const defId = ctx.nodeDefId.get(nodeId)
  if (defId === undefined) return null
  const def = ctx.defs.get(defId)
  if (def === undefined) return null
  const list = dir === 'in' ? def.inputs : def.outputs
  const p = list.find(x => x.id === handle)
  return p === undefined ? null : p.type
}

/**
 * 查某个入口端口是否允许接多条线。
 *
 * 默认 **false**（一条）——安全默认值；只有端口显式声明 `multi: true` 才放行。
 * 查不到端口定义时也返回 false（保守：宁可多问一次，也不静默接受可疑的多入）。
 *
 * @param ctx - 校验上下文。
 * @param nodeId - 节点实例 id。
 * @param handle - 入口端口 id。
 * @returns 是否允许多入。
 */
function portAllowsMulti(ctx: ValidateContext, nodeId: string, handle: string | null | undefined): boolean {
  if (handle === null || handle === undefined) return false
  const defId = ctx.nodeDefId.get(nodeId)
  if (defId === undefined) return false
  const def = ctx.defs.get(defId)
  if (def === undefined) return false
  return def.inputs.find(x => x.id === handle)?.multi === true
}

/**
 * 沿出边做深度优先，判断「连上这条会不会成环」。
 * @param ctx - 校验上下文。
 * @param from - 起点（新边的 target）。
 * @param to - 要找的目标（新边的 source）。
 * @returns true 表示会成环。
 */
function wouldCycle(ctx: ValidateContext, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack: string[] = [from]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    if (cur === to) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const e of ctx.edges) {
      if (e.source === cur) stack.push(e.target)
    }
  }
  return false
}

/**
 * 判断一条连线是否合法（React Flow 的 `isValidConnection` 用）。
 * @param conn - 待校验的连接。
 * @param ctx - 校验上下文。
 * @returns 是否允许连。
 */
export function isValidConnection(conn: Connection | Edge, ctx: ValidateContext): boolean {
  const source = conn.source
  const target = conn.target
  if (source === null || target === null || source === '' || target === '') return false
  // 规则 1：不能自己连自己
  if (source === target) return false
  // 规则 3：不能连成环
  if (wouldCycle(ctx, target, source)) return false
  // 规则 4：入口默认只接一条线；**声明了 multi 的端口可接多条**
  //        （2026-10-08 改为按需放行：此前一刀切禁止，属过度限制）
  if (!portAllowsMulti(ctx, target, conn.targetHandle)) {
    const dup = ctx.edges.find(e => e.target === target && e.targetHandle === conn.targetHandle && e.source !== source)
    if (dup !== undefined) return false
  }
  // 规则 2：端口类型要兼容（any 与谁都兼容）
  const outType = portType(ctx, source, conn.sourceHandle, 'out')
  const inType = portType(ctx, target, conn.targetHandle, 'in')
  if (outType !== null && inType !== null && outType !== inType && outType !== 'any' && inType !== 'any') return false
  return true
}

/**
 * 给用户解释「为什么这条线连不上」（悬停/拖动时提示用）。
 * @param conn - 待校验的连接。
 * @param ctx - 校验上下文。
 * @returns 原因文字；合法则返回空串。
 */
export function whyInvalid(conn: Connection | Edge, ctx: ValidateContext): string {
  const source = conn.source
  const target = conn.target
  if (source === target) return '不能连到自己'
  if (wouldCycle(ctx, target, source)) return '不能连成环（会把流程绕回去）'
  if (!portAllowsMulti(ctx, target, conn.targetHandle)) {
    const dup = ctx.edges.find(e => e.target === target && e.targetHandle === conn.targetHandle && e.source !== source)
    if (dup !== undefined) return '这个入口已经有线了（若确实要接多条，需在节点定义里把它标为可多入）'
  }
  const outType = portType(ctx, source, conn.sourceHandle, 'out')
  const inType = portType(ctx, target, conn.targetHandle, 'in')
  if (outType !== null && inType !== null && outType !== inType && outType !== 'any' && inType !== 'any') {
    return '类型不匹配：' + outType + '（' + PORT_COLORS[outType] + '） ≠ ' + inType
  }
  return ''
}
