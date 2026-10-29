/** 节点运行时数据 store（zustand）。
 *
 * 为什么不塞进 React Flow 的 node.data：
 *   流式输出每秒几十次更新，data 换引用会穿透 memo 导致**整个节点重渲染**。
 *   走 store 后只有订阅它的那个小面板组件重渲染，节点其余部分不动。
 *
 * 数据只留最近 MAX_LINES 行（调研建议 ~50），防止节点无限长高、elkjs 布局崩。
 */
import { create } from 'zustand'

/** 每个节点最多保留的日志行数。 */
const MAX_LINES = 50

/** 一个节点的运行时数据。 */
export interface NodeRunData {
  /** 日志行（流式追加，只留最近 MAX_LINES 行）。 */
  lines: string[]
  /** 进度：已完成 / 总数（可选）。 */
  done?: number
  /** 进度：总数（可选）。 */
  total?: number
  /** 权限/流式文本累积（用于打字机效果，可选）。 */
  stream?: string
}

interface RunStore {
  /** 节点实例 id → 运行时数据。 */
  byNode: Record<string, NodeRunData>
  /** 追加一行日志。 */
  pushLine: (nodeId: string, line: string) => void
  /** 设置进度。 */
  setProgress: (nodeId: string, done: number, total: number) => void
  /** 追加流式文本。 */
  appendStream: (nodeId: string, chunk: string) => void
  /** 清空某节点的运行时数据。 */
  clear: (nodeId: string) => void
  /** 清空全部。 */
  clearAll: () => void
}

/** 空的运行时数据。 */
const EMPTY: NodeRunData = { lines: [] }

/** 运行时数据 store。 */
export const useRunStore = create<RunStore>((set) => ({
  byNode: {},

  pushLine: (nodeId, line) => set(s => {
    const cur = s.byNode[nodeId] ?? EMPTY
    const next = cur.lines.concat(line).slice(-MAX_LINES)
    return { byNode: { ...s.byNode, [nodeId]: { ...cur, lines: next } } }
  }),

  setProgress: (nodeId, done, total) => set(s => {
    const cur = s.byNode[nodeId] ?? EMPTY
    return { byNode: { ...s.byNode, [nodeId]: { ...cur, done, total } } }
  }),

  appendStream: (nodeId, chunk) => set(s => {
    const cur = s.byNode[nodeId] ?? EMPTY
    return { byNode: { ...s.byNode, [nodeId]: { ...cur, stream: (cur.stream ?? '') + chunk } } }
  }),

  clear: (nodeId) => set(s => {
    const next = { ...s.byNode }
    delete next[nodeId]
    return { byNode: next }
  }),

  clearAll: () => set({ byNode: {} }),
}))

/**
 * 读一个节点的运行时数据（无数据时返回空对象，引用稳定）。
 * @param nodeId - 节点实例 id。
 * @returns 运行时数据。
 */
export function useNodeRun(nodeId: string): NodeRunData {
  return useRunStore(s => s.byNode[nodeId] ?? EMPTY)
}
