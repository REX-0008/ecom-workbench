/** 画布编辑历史（撤销 / 重做）。
 *
 * 依据：docs/机制-设计依据.md §4.3；原始调研 docs/调研-三个工作流项目工程化.md。
 * 抄的是 Langflow 的 `stores/flowsManagerStore.ts:12-18 / 92-157`（**MIT，可抄码**）的思路：
 *   - 两个栈：past（可撤销的过去）与 future（可重做的未来）
 *   - **上限 100 条**，超出丢最旧的（防止长时间编辑吃爆内存）
 *   - 快照做**深拷贝**（否则撤销时拿到的是被改过的同一个对象）
 *   - **新操作会清空 future**（标准的撤销语义：撤销后做新动作，就不能再重做了）
 *
 * ⚠️ 调研更正：**Activepieces 没有撤销/重做**（它的 web 全库 grep undo|redo 零命中，
 * 靠「草稿 + 服务端版本」替代）。所以这块只能照 Langflow 抄。
 */
import { create } from 'zustand'
import type { Edge } from '@xyflow/react'
import type { V1Node } from './WorkflowNode.tsx'


/** 一次快照（节点 + 连线）。 */
export interface Snapshot {
  /** 节点（深拷贝）。 */
  nodes: V1Node[]
  /** 连线（深拷贝）。 */
  edges: Edge[]
}

/** 历史栈的最大长度（超出丢最旧的）。 */
const MAX_HISTORY = 100

/**
 * 深拷贝一份快照。
 * 只拷会变的部分（data 里的回调函数不能拷，拷贝时会丢，所以在恢复时重新挂）。
 * @param nodes - 当前节点。
 * @param edges - 当前连线。
 * @returns 快照。
 */
function cloneSnapshot(nodes: V1Node[], edges: Edge[]): Snapshot {
  return {
    nodes: nodes.map(n => ({
      ...n,
      position: { ...n.position },
      /* data 里既有数据（def/params）也有回调函数（onRunOne 等）；
       * 快照只保留数据侧，回调在恢复时由画布重新挂（见画布里的同步 effect）。 */
      data: {
        ...n.data,
        params: { ...(n.data.params ?? {}) },
        onRunOne: undefined,
        onRunFrom: undefined,
        onParam: undefined,
        onOnError: undefined,
      },
    })) as V1Node[],
    edges: edges.map(e => ({ ...e })),
  }
}

/**
 * 两份快照是不是「同一件事」。
 *
 * 只比数据侧（位置 + 参数 + 失败策略 + 状态 + 连线），**不比回调函数**——
 * 那些每次渲染都是新引用，比了会永远判为「不同」，去重就失效了。
 *
 * @param a - 一份快照（可能没有）。
 * @param b - 另一份快照。
 * @returns 是否等价。
 */
function sameSnapshot(a: Snapshot | undefined, b: Snapshot): boolean {
  if (a === undefined) return false
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false
  /** 取节点里「会变的那几项」做指纹。 */
  const nodeKey = (n: V1Node): string => JSON.stringify([
    n.id, n.data.def.id, n.position.x, n.position.y,
    n.data.params ?? {}, n.data.onError ?? '', n.data.state ?? '',
  ])
  /** 取连线做指纹。 */
  const edgeKey = (e: Edge): string => JSON.stringify([e.source, e.target, e.sourceHandle ?? '', e.targetHandle ?? ''])
  const na = a.nodes.map(nodeKey).sort().join('|')
  const nb = b.nodes.map(nodeKey).sort().join('|')
  if (na !== nb) return false
  const ea = a.edges.map(edgeKey).sort().join('|')
  const eb = b.edges.map(edgeKey).sort().join('|')
  return ea === eb
}

interface HistoryStore {
  /** 可撤销的过去（栈顶是最近一次）。 */
  past: Snapshot[]
  /** 可重做的未来。 */
  future: Snapshot[]
  /**
   * 记录一次「操作前」的状态（在任何会改动画布的 action 之前调）。
   * @param nodes - 改动前的节点。
   * @param edges - 改动前的连线。
   */
  push: (nodes: V1Node[], edges: Edge[]) => void
  /**
   * 撤销一步。
   * @param current - 当前状态（会被推进 future）。
   * @returns 要恢复到的快照；没得撤销返回 null。
   */
  undo: (current: Snapshot) => Snapshot | null
  /**
   * 重做一步。
   * @param current - 当前状态（会被推回 past）。
   * @returns 要恢复到的快照；没得重做返回 null。
   */
  redo: (current: Snapshot) => Snapshot | null
  /** 清空历史（切换工作流时用）。 */
  clear: () => void
  /** 历史深度（供按可用性禁用按钮）。 */
  depth: () => { past: number, future: number }
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  past: [],
  future: [],

  push: (nodes, edges) => set(s => {
    const snap = cloneSnapshot(nodes, edges)
    /* 去重：与栈顶完全相同就不入栈（Langflow 的做法）。
     * 否则「连续两次一样的操作」会白占两格撤销——用户按两次 Ctrl+Z 却什么都没变。 */
    if (sameSnapshot(s.past[s.past.length - 1], snap)) return { past: s.past, future: [] }
    const next = s.past.concat([snap])
    /* 超上限丢最旧的 */
    const trimmed = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    /* 新操作清空 future（标准撤销语义） */
    return { past: trimmed, future: [] }
  }),

  undo: (current) => {
    const s = get()
    if (s.past.length === 0) return null
    const prev = s.past[s.past.length - 1]
    set({
      past: s.past.slice(0, -1),
      future: s.future.concat([cloneSnapshot(current.nodes, current.edges)]),
    })
    return prev
  },

  redo: (current) => {
    const s = get()
    if (s.future.length === 0) return null
    const next = s.future[s.future.length - 1]
    set({
      future: s.future.slice(0, -1),
      past: s.past.concat([cloneSnapshot(current.nodes, current.edges)]),
    })
    return next
  },

  clear: () => set({ past: [], future: [] }),

  depth: () => { const s = get(); return { past: s.past.length, future: s.future.length } },
}))

/**
 * 把一份快照恢复到画布（重新挂上回调）。
 * @param snap - 快照。
 * @param nodes - 当前节点（用来复用回调）。
 * @returns 可直接 setNodes 的节点数组。
 */
export function restoreSnapshot(snap: Snapshot, nodes: V1Node[]): V1Node[] {
  /** 旧节点的回调（按 id 找回来挂上）。 */
  const byId = new Map(nodes.map(n => [n.id, n.data]))
  return snap.nodes.map(n => {
    const prev = byId.get(n.id)
    return {
      ...n,
      data: {
        ...n.data,
        onRunOne: prev?.onRunOne,
        onRunFrom: prev?.onRunFrom,
        onParam: prev?.onParam,
        onOnError: prev?.onOnError,
      },
    } as V1Node
  })
}
