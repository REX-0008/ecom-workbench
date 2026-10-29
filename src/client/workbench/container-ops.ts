/** 容器（循环框 / 分组框）的**归属运算**（纯逻辑，不碰 React、不碰 DOM）。
 *
 * ## 与 `group-ops.ts` 的分工
 *
 * | 文件 | 管什么 |
 * |---|---|
 * | `group-ops.ts` | **分组的存亡**（建框 / 解散 / 贴边 / 连贯补齐） |
 * | 本文件 | **节点的归属变化**（拖进哪个容器、拖出来、落在谁身上） |
 *
 * 两者都动 `parentId` 与相对坐标，所以都放在「纯运算 + 单测」这一层。
 *
 * ## 背景：容器是「算出来的」，不是「摆出来的」
 *
 * 用户 2026-10-11 定过：分组框的**大小与位置跟着子节点走**（见 `fitGroup`）。
 * 循环框沿用同一条：它也是一个 `parentId` 容器，只是多两件事 ——
 *   1. 它是**可运行的节点**（有端口、会执行），分组框不是；
 *   2. 它的子节点在**执行时逐轮跑**（见 `workflow/loop.ts`）。
 *
 * ## 一个必须守住的约定
 *
 * **一个节点只能有一个父**（React Flow 的硬要求）。所以「拖进另一个容器」必须
 * 先把旧的父子关系解掉（坐标绝对化），否则会出现「挂在两个父下面」的坏状态 ——
 * 那种状态下坐标会算错两次，节点飞到别处。
 */
import type { V1Node } from './WorkflowNode.tsx'
import { closeUnderTransit } from './group-ops.ts'
import { topoSort } from '../../workflow/topo.ts'
/* ⚠️ **只引类型**（`import type` 会被编译期擦掉，不会造成运行时循环依赖）：
 * `canvas-layout.ts` 引了 ELK（体积大），容器运算不该为了一个字符串字面量把它拖进来。 */
import type { LayoutDirection } from './canvas-layout.ts'

/** 容器的判定所需的最小信息。 */
export interface ContainerLike {
  /** 节点 id。 */
  id: string
  /** 节点类型（`'group'` = 分组框；`'v1'` 普通节点）。 */
  type?: string
  /** 节点定义 id（`'flow.loop'` = 循环）。 */
  defId: string
  /** 画布坐标（容器自身的左上角）。 */
  position: { x: number, y: number }
  /** 容器尺寸（分组框与循环框都写在 style 上）。 */
  width?: number
  height?: number
}

/** 循环节点的定义 id（与节点库一致）。 */
export const LOOP_DEF_ID = 'flow.loop'

/**
 * 这个节点是不是「容器」（可以装别的节点）。
 *
 * 两类：
 *   - **分组框**（`type === 'group'`）—— 纯外观，不执行；
 *   - **循环**（`defId === 'flow.loop'`）—— 可执行，子节点逐轮跑。
 *
 * @param n - 节点。
 * @returns 是否能作为容器。
 */
export function isContainer(n: { type?: string, defId: string }): boolean {
  return n.type === 'group' || n.defId === LOOP_DEF_ID
}

/**
 * 从节点数组里挑出容器，并带上它们的尺寸。
 *
 * @param nodes - 全部节点。
 * @param sizes - 实测尺寸表（量不到就用 `style` 上写的，再不行用 0）。
 * @returns 容器清单。
 */
export function containersOf(
  nodes: readonly V1Node[],
  sizes: ReadonlyMap<string, { w: number, h: number }>,
): ContainerLike[] {
  const out: ContainerLike[] = []
  for (const n of nodes) {
    const defId = n.data.def.id
    if (!isContainer({ type: n.type, defId })) continue
    const style = n.style as { width?: number, height?: number } | undefined
    const measured = sizes.get(n.id)
    out.push({
      id: n.id,
      type: n.type,
      defId,
      position: n.position,
      width: measured?.w ?? style?.width,
      height: measured?.h ?? style?.height,
    })
  }
  return out
}

/**
 * 一个点落在哪个容器里（**取最小的那个**）。
 *
 * 为什么要取最小：容器可以嵌套（分组框套分组框、循环框套分组框）。
 * 点在两者重叠处时，用户的意图几乎总是**里面那个**——外面的只是恰好范围大。
 *
 * @param containers - 容器清单。
 * @param point - 要判定的点（**画布绝对坐标**）。
 * @returns 命中的容器 id；都没命中返回 null。
 */
export function containerAt(
  containers: readonly ContainerLike[],
  point: { x: number, y: number },
): string | null {
  let best: ContainerLike | null = null
  for (const c of containers) {
    const w = c.width ?? 0
    const h = c.height ?? 0
    if (w <= 0 || h <= 0) continue
    const inside = point.x >= c.position.x && point.x <= c.position.x + w
      && point.y >= c.position.y && point.y <= c.position.y + h
    if (!inside) continue
    /* 面积更小的优先（= 更靠里）。 */
    if (best === null || w * h < (best.width ?? 0) * (best.height ?? 0)) best = c
  }
  return best === null ? null : best.id
}

/**
 * 把一个节点**挂到某个容器下**（坐标绝对 → 相对）。
 *
 * ⚠️ **先摘掉旧父**：一个节点只能有一个父。若它原本挂在别的容器/框下，
 * 必须先按**旧父**的原点把坐标还原成绝对值，再按**新父**的原点转成相对值。
 * 漏掉这一步，坐标会被减两次，节点飞到别处。
 *
 * @param nodes - 当前全部节点。
 * @param nodeId - 要移动的节点。
 * @param targetId - 目标容器 id（`null` = 移出容器，回到顶层）。
 * @returns 新节点数组（顺序已保证「父在子之前」）。
 */
export function assignToContainer(
  nodes: readonly V1Node[],
  nodeId: string,
  targetId: string | null,
): V1Node[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const node = byId.get(nodeId)
  if (node === undefined) return [...nodes]
  /* 容器不能装容器里 —— 那会让「谁先谁后」变成环。 */
  if (targetId === nodeId) return [...nodes]

  const abs = absolutePosition(nodes, node)
  const target = targetId === null ? null : byId.get(targetId)
  const relPos = target === null
    ? abs
    : { x: abs.x - target.position.x, y: abs.y - target.position.y }

  const next = nodes.map(n => {
    if (n.id !== nodeId) return n
    const out: V1Node = { ...n, position: relPos }
    if (targetId === null) delete (out as { parentId?: string }).parentId
    else out.parentId = targetId
    return out
  })
  return orderParentsFirst(next)
}

/**
 * 算一个节点的**绝对坐标**（沿 `parentId` 链把父的原点都加回去）。
 *
 * 为什么要沿链：容器可以嵌套，相对坐标是相对**直接父**的。
 *
 * @param nodes - 当前全部节点。
 * @param node - 目标节点。
 * @returns 画布绝对坐标。
 */
export function absolutePosition(
  nodes: readonly V1Node[],
  node: V1Node,
): { x: number, y: number } {
  const byId = new Map(nodes.map(n => [n.id, n]))
  let x = node.position.x
  let y = node.position.y
  let cur = node
  /* 防环：链最多走节点总数那么多步。 */
  let guard = nodes.length + 1
  while (cur.parentId !== undefined && guard > 0) {
    const parent = byId.get(cur.parentId)
    if (parent === undefined) break
    x += parent.position.x
    y += parent.position.y
    cur = parent
    guard -= 1
  }
  return { x, y }
}

/**
 * 保证**父排在子之前**（React Flow 的硬要求，否则坐标算错）。
 *
 * 排序是**稳定**的：同一层级保持原顺序，避免每次调用都重排（那会让画面抖）。
 *
 * @param nodes - 节点数组。
 * @returns 新数组（父在子之前）。
 */
export function orderParentsFirst(nodes: readonly V1Node[]): V1Node[] {
  const rank = new Map<string, number>()
  const byId = new Map(nodes.map(n => [n.id, n]))
  /** 算层级：顶层 0，父的下一个 1，以此类推（带防环）。 */
  const depthOf = (id: string): number => {
    const cached = rank.get(id)
    if (cached !== undefined) return cached
    const n = byId.get(id)
    if (n === undefined || n.parentId === undefined) { rank.set(id, 0); return 0 }
    if (rank.has(n.parentId)) { rank.set(id, 1); return 1 }
    rank.set(id, 1)
    const d = depthOf(n.parentId) + 1
    rank.set(id, d)
    return d
  }
  for (const n of nodes) depthOf(n.id)
  /* `sort` 是稳定的（ES2019+），所以同深度保持原顺序。 */
  return [...nodes].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
}

/**
 * 这个位置算不算落在某个容器里（归属判定的**判据**）。
 *
 * ## ⚠️ 它不再直接决定归属（2026-10-12 用户改了规则）
 *
 * 用户实测后提出：「拖进去外框会亮，但是**亮不代表加入循环**」——
 * 即「高亮」与「加入」被绑成同一件事，一拖到就亮、一松手就进去，来不及确认。
 * 新规则拆成两个阶段（计时在 `WorkflowCanvas` 里）：
 *   ① 进框 → 只是「候选」；**停够 1 秒**才高亮（此时才真的会加入）；
 *   ② 高亮后松手 → 加入；**没停够就松手 → 不加入**。
 * 所以本函数现在的角色是「**这个位置在不在容器里**」，由调用方配合计时决定动不动手。
 *
 * 判定仍按**中心点**：
 *   1. 中心点落在某个容器里 → 就是它（嵌套时取最小的那个，见 `containerAt`）；
 *   2. 中心点没落在任何容器里、但当前已属于某个容器 → 完全离开时返回 `null`（表示「不在容器里了」）；
 *   3. 半进半出 → `undefined`（保持原样，手抖不该被踢出）。
 *
 * @param nodes - 当前全部节点。
 * @param nodeId - 拖动的节点。
 * @param sizes - 实测尺寸表。
 * @param fallback - 量不到尺寸时的兜底值。
 * @returns 容器 id（落在里面）；`null`（已不在任何容器里）；`undefined`（保持原样/不必处理）。
 */
export function dropTarget(
  nodes: readonly V1Node[],
  nodeId: string,
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): string | null | undefined {
  const node = nodes.find(n => n.id === nodeId)
  if (node === undefined) return undefined

  const abs = absolutePosition(nodes, node)
  const size = sizes.get(nodeId)
  const w = size?.w ?? (node.style as { width?: number } | undefined)?.width ?? fallback.w
  const h = size?.h ?? (node.style as { height?: number } | undefined)?.height ?? fallback.h
  const center = { x: abs.x + w / 2, y: abs.y + h / 2 }

  /* 容器清单里去掉自己（以及自己的子节点 —— 不能把父拖进子）。
   *
   * ⚠️ 这条 `.filter` **就是**「容器自己不被拖进容器」的实现（否则「谁先谁后」成环）。
   * 早先这里还算过一个 `selfIsContainer` 标记，但**从没被读**（用 `void` 扔掉了）——
   * 挂着只会让人以为「成环检查在别处」。真正做事的是下面这行，所以删掉了那个标记。 */
  const descendants = descendantsOf(nodes, nodeId)
  const containers = containersOf(nodes, sizes)
    .filter(c => c.id !== nodeId && !descendants.has(c.id))

  const hit = containerAt(containers, center)
  if (hit !== null) return hit

  /* 中心点没命中任何容器。 */
  const current = node.parentId
  if (current === undefined) return undefined
  /* 已经不在任何容器里 → 移出。 */
  const curContainer = containers.find(c => c.id === current)
  if (curContainer === undefined) return null
  const stillInside = overlapRatio(abs, { w, h }, curContainer) > 0
  if (!stillInside) return null
  /* 半进半出：保持原位（手抖不该被踢出循环）。 */
  return undefined
}

/**
 * 一个节点在容器内的**重叠比例**（0~1）。
 *
 * @param pos - 节点的绝对坐标。
 * @param size - 节点尺寸。
 * @param container - 容器。
 * @returns 重叠面积 / 节点面积。
 */
function overlapRatio(
  pos: { x: number, y: number },
  size: { w: number, h: number },
  container: ContainerLike,
): number {
  const cw = container.width ?? 0
  const ch = container.height ?? 0
  if (cw <= 0 || ch <= 0 || size.w <= 0 || size.h <= 0) return 0
  const left = Math.max(pos.x, container.position.x)
  const top = Math.max(pos.y, container.position.y)
  const right = Math.min(pos.x + size.w, container.position.x + cw)
  const bottom = Math.min(pos.y + size.h, container.position.y + ch)
  const ow = Math.max(0, right - left)
  const oh = Math.max(0, bottom - top)
  return (ow * oh) / (size.w * size.h)
}

/**
 * 取一个节点的**全部后代**（子、孙……）。
 *
 * 用途：拖动父时不能把它拖进自己的子孙里（会成环）。
 *
 * @param nodes - 全部节点。
 * @param rootId - 起点。
 * @returns 后代 id 集合（不含起点）。
 */
export function descendantsOf(nodes: readonly V1Node[], rootId: string): Set<string> {
  const out = new Set<string>()
  const kids = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parentId === undefined) continue
    const arr = kids.get(n.parentId)
    if (arr === undefined) kids.set(n.parentId, [n.id])
    else arr.push(n.id)
  }
  const stack = [...(kids.get(rootId) ?? [])]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    if (out.has(cur)) continue
    out.add(cur)
    for (const k of kids.get(cur) ?? []) stack.push(k)
  }
  return out
}

/**
 * 把**一个节点**挂到某个容器下，并**补齐被夹在中间的节点**。
 *
 * ## 为什么要「补齐」（用户 2026-10-12 明确要求）
 *
 * 原话：「加入后检测两个节点是否有中间节点，如果有一起加入进来」。
 * 这与编组时那条「连贯」纪律是**同一条**（用户 2026-10-11 就说过：
 * 「编组必须满足连贯……编组的意思类似于一个小工作流」）。
 * 场景：A → B → C，容器里已有 A、C，用户把 B 拖进去 —— 但反过来的情况更常见：
 * 用户只拖了 A，而 C 已经被上游 A 与下游串着，C 也该进来。
 *
 * ⚠️ **只在「加入」时补齐，不在「移出」时补齐** ——
 * 移出是用户明确的减法动作，替他多拿东西出来会让人意外
 * （他可能正想把某个节点单独拎出来）。
 *
 * @param nodes - 当前全部节点。
 * @param nodeId - 刚加入的节点。
 * @param targetId - 目标容器 id。
 * @param edges - 全部连线（用来找中间节点）。
 * @returns 新的节点数组；`moved` 是被一并加进来的其它节点 id（用于提示用户）。
 */
export function assignWithClosure(
  nodes: readonly V1Node[],
  nodeId: string,
  targetId: string,
  edges: readonly { source: string, target: string }[],
): { nodes: V1Node[], closed: string[] } {
  const target = nodes.find(n => n.id === targetId)
  if (target === undefined) return { nodes: [...nodes], closed: [] }

  /* 补齐的判定与编组**完全共用** `closeUnderTransit`（别另写一套 ——
   * 那个算法被它自己的测试抓出过两次错，判据是「有上游在集合里」+「能走到集合里的下游」，
   * 两个条件缺一个都会坏）。
   *
   * ⚠️ **「集合」= 刚拖进来的这个 + 容器里已有的那些**（2026-10-12 修）：
   * 用户要的是「加入后检测**两个节点**是否有中间节点，如果有一起加入进来」——
   * 关键在于是**两个**：容器里已有 A、C，用户把 B 拖进来，或容器里已有 A，
   * 用户把 C 拖进来 —— 这时 A（在容器里）与 C（刚进来）之间夹着的 B 该一起进。
   * 第一版只把「刚拖进来的那个」当集合，于是 `{单个}` 永远补不出东西
   * （单节点的集合没有「两点之间」可言），**断言当场就红了**。
   *
   * 注意「已有的」只算**已经在目标容器里**的节点 —— 不能在整张图上扩散。 */
  const alreadyIn = nodes.filter(x => x.parentId === targetId).map(x => x.id)
  const picked = new Set([...alreadyIn, nodeId])
  const full = closeUnderTransit(picked, edges)

  /* 只补**顶层**节点：已经有父的节点不能改归属（一个节点只能有一个父）。 */
  const byId = new Map(nodes.map(n => [n.id, n]))
  const toMove = [...full].filter(id => {
    const n = byId.get(id)
    if (n === undefined) return false
    /* 已经在这个容器里的不用再动。 */
    if (n.parentId === targetId) return false
    /* 属于别的容器的不动（那会让它换父，用户没要求）。 */
    return n.parentId === undefined
  })
  const closed = toMove.filter(id => id !== nodeId)

  let next: V1Node[] = [...nodes]
  for (const id of toMove) next = assignToContainer(next, id, targetId)
  return { nodes: next, closed }
}

/**
 * 拖动中的**归属意图**：这次松手会「进入」还是「移出」哪个容器。
 *
 * ## 为什么要这么一套（用户 2026-10-12 实测后定的规则）
 *
 * 用户原话：
 *   加入：「拖进循环框后框**不亮**，这时松手也不加入，**悬停 1 秒后框亮**，
 *         此刻在框内松手即加入。」
 *   移出：「脱出框后**不是立即变暗**，出框 **1 秒后变暗**……此时移动回框**不会移出**，
 *         但是在框外松开鼠标**会移出**。」
 *
 * 所以「在里面」与「确认了」是**两件事**，中间隔着一段停留时间。
 * 用户这样能得到「进去先看看 → 停住 → 亮了才松手」的节奏，
 * 而不是一碰到就生效（那样没法反悔）。
 *
 * 本函数是**纯逻辑**：给定「现在在哪」「原本属于谁」「上次状态与起始时刻」，
 * 算出新状态。真实计时不在这里（那需要时钟），只比较**停留了多久**。
 */
export interface DragIntent {
  /** 现在判定出的动作。 */
  kind: 'join' | 'leave' | 'none'
  /** 动作涉及的容器：`join` 是目标，`leave` 是原容器。 */
  containerId: string | null
  /** 在容器里/出框了，但**还没停够** —— 界面可据此给「再停一下」的暗示。 */
  pending: boolean
  /** 本状态的**起始时刻**（调用方据此判断「该重置计时了」）。 */
  since: number
}

/**
 * 要停留多久才算「确认」（毫秒）。
 *
 * 用户明确说了 **1 秒**，所以写死常量而不是做成配置：
 * 做成配置的代价是「每个用户都要自己试出一个值」，而这个值没什么可调的余地
 * （太短来不及反悔，太长嫌慢）。
 */
export const CONFIRM_MS = 1000

/**
 * 推进一次拖动意图（纯函数，可单测）。
 *
 * @param prev - 上一次的意图（没有就传 null）。
 * @param insideId - 按中心点判定，现在落在哪个容器里（`null` = 不在任何容器里）。
 * @param ownerId - 被拖的节点**原本**属于哪个容器（`null` = 本来就不属于容器）。
 * @param now - 当前时刻（毫秒）。
 * @returns 新的意图。`kind` 是要执行的动作，但**只有 `pending === false` 时才真的执行**。
 */
export function stepDragIntent(
  prev: DragIntent | null,
  insideId: string | null,
  ownerId: string | null,
  now: number,
): DragIntent {
  let kind: DragIntent['kind'] = 'none'
  let containerId: string | null = null
  if (insideId !== null) {
    /* 在某个容器里；但若那正是它原本待的地方，则**没有动作**（不是加入也不是移出）。 */
    if (insideId !== ownerId) { kind = 'join'; containerId = insideId }
  } else if (ownerId !== null) {
    /* 完全不在任何容器里、而它本来属于某个容器 → 移出。 */
    kind = 'leave'; containerId = ownerId
  }

  /* 目标变了（或第一次）→ 计时重新开始。
   * 这是「移动回框不会移出」的实现：一回到框里，`kind` 变回 none，
   * 计时归零；再出去要重新等 1 秒。 */
  const sameTarget = prev !== null && prev.kind === kind && prev.containerId === containerId
  const since = sameTarget ? prev.since : now
  const elapsed = now - since

  /* 停够时间才算确认；否则只是候选。`none` 永远不是候选。 */
  const confirmed = kind !== 'none' && elapsed >= CONFIRM_MS
  return { kind, containerId, pending: kind !== 'none' && !confirmed, since }
}

/**
 * 容器框的尺寸与内边距常量。
 *
 * ## 为什么有「最小尺寸」（用户 2026-10-13 报的问题 3 的根因之一）
 *
 * 原来框 = **子节点包围盒 + 30px**，于是：
 *   - 框里只剩一个节点时，框只有 360×284 —— **几乎没地方放新节点**，
 *     用户往里拖时中心点稍微偏一点就落在框外，表现为「拖不进去」；
 *   - 移出一个节点后框会**缩到贴着剩下那个节点**，框的左上角跟着**跳到下面去**，
 *     用户按原来的位置把节点拖回来时，那儿**已经在框外了**。
 *
 * 实测：移出 A 后框从 `(0,0) 400×300` 缩成 `(10,126) 360×284`（整体下移 126px）。
 *
 * 所以框有一个**最小尺寸**（放得下 2×2 个节点还有余量），**空框也保持**。
 * 这与 Dify 的做法方向一致 —— 它的容器**只增不减**
 * （`getIterationContainerResize` 只在子节点超出时撑大）。
 */
export const BOX_PAD_SIDE = 40
export const BOX_PAD_TOP = 64
export const BOX_PAD_BOTTOM = 40
/** 框内相邻节点之间的竖向间距（重排用）。 */
export const BOX_GAP_Y = 40
/**
 * 框内相邻节点之间的横向间距（横排重排用）。
 *
 * 与 `BOX_GAP_Y` **取同一个值**（40）：横排与竖排只是轴向不同，
 * 间距没有理由不一样；分开成两个常量是为了让调用点读起来不自相矛盾
 * （横排时写 `BOX_GAP_Y` 会让人以为「是不是写错了」）。
 */
export const BOX_GAP_X = 40
/**
 * 框的最小宽度。
 *
 * ⚠️ **2026-10-16 从 600 改到 380**（用户原话：
 * 「将循环默认的宽度也取消掉，**没有内容的时候宽度只比普通节点大一点**，
 * 有节点有自动重排」）。
 *
 * 旧值 600 是「放得下 2×2 个节点」那个理由留下的 —— 但用户看到的是一个
 * **空框占着两个节点宽**，观感上像是「框本来就有这么大」，而不是「能装东西」。
 * 现在取「普通节点宽 300 + 两侧内边距」，即**只比普通节点大一点**；
 * 一旦装进节点，`needW` 会按内容自己撑开（那条逻辑没变）。
 */
export const BOX_MIN_W = 300 + BOX_PAD_SIDE * 2
/**
 * 框的最小高度。
 *
 * 同理从 400 改小：空框不必占出「两行节点」的高度，够放下标题栏 + 一条提示即可。
 * 有内容时按内容撑开。
 */
export const BOX_MIN_H = 168 + BOX_PAD_TOP + BOX_PAD_BOTTOM
/**
 * **收起态**的框高度（只留标题栏那一条）。
 *
 * 收起是**显示语义**（照 Dify：收起只是不显示内部节点，不影响运行），
 * 所以它必须有**看得见的效果** —— 否则用户点「收起」会以为按钮坏了
 * （用户 2026-10-16 报的正是这条：「循环的收起展开**没有实际作用**」）。
 * 两个效果一起做才算数：① 框缩成一条；② 成员节点不再画在画布上。
 */
export const BOX_COLLAPSED_H = 46
/**
 * 框头那一行的高度（收起态的框就是这一条）。
 *
 * 设置面板是 `top: 100%` 挂在**框头下沿**的，所以「面板底边离框顶多远」
 * = 这个值 + `BOX_SETTINGS_H`。成员节点的最小 y 必须按它算 —— 否则最靠上的
 * 成员仍会被面板压住（用户 2026-10-16 报的正是这个：「设置被里面的节点挡住了」）。
 */
export const BOX_HEAD_H = BOX_COLLAPSED_H
/**
 * 「设置」面板打开时，为它让出多少高度。
 *
 * ⚠️ **2026-10-16 加**（用户报「设置点击没有作用」的第二个原因）。
 * ⚠️ **同日又改了一次语义**：用户接着说「设置被里面的节点挡住了，
 * 这个设置区域**应该将内部节点往外挤压**」。所以这个值现在管两件事：
 *
 *   ① **框长高**：面板是 `position: absolute`（见 CSS 里的长注释：成员节点是
 *      React Flow 平铺画的、与框是兄弟关系，框内部的 `z-index` 盖不过它们），
 *      所以必须真的让出一块**没人占的地方**给它。
 *   ② **成员被推下去**：`fitLoopBox` 拿它抬高成员的最小 y（`settingsPad`），
 *      于是「挤压」真的发生 —— 用户要的就是这个。
 *
 * 取值按实测：面板约「四行字段 + 一行提示」。少一点会截字，多一点只是留白，
 * 所以宁多勿少。
 */
export const BOX_SETTINGS_H = 190

/**
 * 界面侧的层数上限 —— 与执行期 `run.ts` 的 `MAX_LOOP_DEPTH` **必须相同**。
 *
 * 为什么不从 `run.ts` 引：那个文件引了 `loop.ts` / `branch.ts` / 派发相关的一堆，
 * 客户端引它会把宿主半的东西拖进产物。这里是**常量同步**，
 * `tests/loop-nest-ui.mjs` 有一条断言钉住两边相等（改一边不改另一边会红）。
 *
 * ⚠️ **位置在文件靠前处**（2026-10-19 从文件末尾搬上来）：`layoutContainer`
 * 的递归深度判据用的就是它。放在使用处之后虽然运行时没问题（模块初始化完才调用），
 * 但读代码的人会以为「先用了后定义」是笔误。
 */
export const MAX_LOOP_DEPTH_UI = 5

/**
 * 框内排列的**轴向**（不是画布方向 —— 两者正交，见 `innerAxisOf`）。
 *
 *   - `TB`：从上到下（竖排）
 *   - `LR`：从左到右（横排）
 */
export type InnerAxis = 'TB' | 'LR'

/**
 * 画布方向 → **框内**排列轴向（**正交**，不是跟随）。
 *
 * | 画布方向 | 框内 | 为什么 |
 * | --- | --- | --- |
 * | `RIGHT`（从左到右） | **竖排**（TB） | 横排的图**宽而矮**，框内竖排能省宽度 |
 * | `DOWN`（从上到下） | **横排**（LR） | 竖排的图**高而窄**，框内横排能省高度 |
 *
 * ⚠️ **为什么是「正交」而不是「跟随」**：跟随的话，横排的画布会排出一条
 * 又宽又扁的框（宽度再乘成员数），一屏根本放不下；正交才是省地方的那个方向。
 * 这也是 n8n 与 Dify 容器内部的取向（它们的容器是独立子图，内部再跑一次分层算法，
 * 实际效果就是这个正交关系）。
 *
 * @param dir - 画布方向。
 * @returns 框内排列轴向。
 */
export function innerAxisOf(dir: LayoutDirection): InnerAxis {
  return dir === 'DOWN' ? 'LR' : 'TB'
}

/**
 * 翻转轴向（嵌套循环用：每一层相对上一层正交）。
 *
 * @param axis - 当前轴向。
 * @returns 另一个轴向。
 */
function flipAxis(axis: InnerAxis): InnerAxis {
  return axis === 'TB' ? 'LR' : 'TB'
}

/**
 * 第 `depth` 层容器该用哪个轴向（**每一层相对上一层正交**）。
 *
 * ## 为什么要单独一个函数（2026-10-21 修的真 BUG）
 *
 * 这条规则原先只写在 `layoutContainer` 的**递归**里（`flipAxis(axis)`）。
 * 但 `refitNodes` 是**逐个循环**调 `relayoutInside` 的（`orderLoopsInnerFirst`
 * 保证内层先），每一步传的都是同一个 `dir` —— 于是每层都算出
 * `innerAxisOf(dir)` 同一个轴向，**翻转丢了**。
 *
 * 症状（用户原话「涉及到循环的自动排版都有问题」）：内层与外层排法一样，
 * 而外层是按「内层会翻转」预留的空间 → 内层装不下、成员露到框外。
 *
 * 修法：层深由调用方传进来，轴向在这里算 —— 规则只有一份，
 * 递归与非递归两条路都用它。
 *
 * @param dir - 画布方向。
 * @param depth - 层深（0 = 最外那层循环）。
 * @returns 该层的轴向。
 *
 * @deprecated **2026-10-21 起不用了**。用户改了口径（原话）：
 * 「**不应该每次转**，是自动横排的时候循环内竖排，自动竖排的时候循环内横排」
 * —— 所有嵌套层用**同一个**轴向（`innerAxisOf(dir)`），需要不同就由用户在
 * 循环框上手动切（`LoopNodeData.axis`）。留着它是因为 `flipAxis` / 这个换算
 * 关系本身仍是对的，将来若要恢复「逐层正交」可以直接用。
 */
export function axisAt(dir: LayoutDirection, depth: number): InnerAxis {
  let axis = innerAxisOf(dir)
  for (let i = 0; i < depth; i++) axis = flipAxis(axis)
  return axis
}

/**
 * 一个成员在排列时要占多大。
 *
 * ## 为什么循环成员要用**它自己声明的尺寸**
 *
 * 内层循环是个容器，它的 `style.width/height` 是**框自己声明的尺寸**
 * （由 `fitLoopBox` 算出来写进去的），不是成员坐标。而 `sizes` 量的是
 * DOM 上那个框的实际像素 —— 两者通常一致，但**首帧 / 面板还没挂**时
 * `sizes` 里没有它，只能靠声明值。
 *
 * ⚠️ **不能用 `fallback`（普通节点的 300×168）**：一个装了 3 个成员的循环框
 * 可能是 600×400，按 300×168 摆会让它**压住后面的成员**
 * （这正是本函数 2026-10-19 修掉的那个错）。
 *
 * @param n - 成员节点。
 * @param sizes - 实测尺寸表。
 * @param fallback - 兜底尺寸（普通节点）。
 * @returns 尺寸。
 */
function memberSize(
  n: V1Node,
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): { w: number, h: number } {
  /* ★★ **循环框的尺寸以它自己的 `style` 为准，先于实测表**（2026-10-21 修的真 BUG）。
   *
   * ## 症状（用户原话）
   *
   * 「横排竖排，如果循环嵌套比较多，**需要多点几次才能排出来**，
   *  我看的是取数-千川全域推广，需要点 4 下。」
   *
   * ## 根因
   *
   * `sizes` 是 `measureNodes` 量 DOM 得到的 —— 而它是**本轮开始时的快照**。
   * 循环框的尺寸是本函数外面 `fitLoopBox` **刚算出来、写进 `style`** 的，
   * DOM 还没重绘，所以 `sizes` 里是**上一帧的旧值**。
   *
   * 旧顺序是「先查 `sizes`、查到就返回」→ 外层拿到的是内层**上一轮**的尺寸
   * → 按旧尺寸给内层留位 → 内层这一轮长宽了 → 装不下。
   * 一帧只能修正一层，嵌套 N 层就要点 N 次（实测三层要 3～4 次）。
   *
   * ## 为什么「`style` 比 DOM 准」在这里成立
   *
   * `style.width/height` 是**我们自己算的、确定的值**；而 DOM 上的像素
   * 反映的是**上一次渲染**。重排这件事本来就该用「我已经决定它多大」，
   * 而不是「它上次多大」。
   *
   * ## 非循环节点仍走实测表
   *
   * 普通节点的高度是**浏览器排出来的**（文字换行、输出面板），我们无法预知，
   * 只能量 —— 所以它们保持原样。
   *
   * @param n - 成员节点。
   * @param sizes - 实测尺寸表（本轮开始时的快照）。
   * @param fallback - 兜底尺寸（普通节点）。
   * @returns 尺寸。
   */
  if (n.data.def.id === LOOP_DEF_ID) {
    const style = n.style as { width?: number, height?: number } | undefined
    const w = typeof style?.width === 'number' && style.width > 0 ? style.width : undefined
    const h = typeof style?.height === 'number' && style.height > 0 ? style.height : undefined
    /* 只有缺一项时才回落实测表 / 兜底（首帧可能只有一项）。 */
    if (w !== undefined && h !== undefined) return { w, h }
    if (w !== undefined) return { w, h: h ?? sizes.get(n.id)?.h ?? fallback.h }
    if (h !== undefined) return { w: sizes.get(n.id)?.w ?? fallback.w, h }
  }
  const measured = sizes.get(n.id)
  if (measured !== undefined) return measured
  return fallback
}

/**
 * 排**一个**容器内部的成员（递归实现，见 `relayoutInside` 的说明）。
 *
 * @param nodes - 全部节点。
 * @param containerId - 容器 id。
 * @param edges - 全部连线。
 * @param sizes - 实测尺寸表。
 * @param fallback - 兜底节点尺寸。
 * @param axis - 本层排列轴向。
 * @param depth - 已经下探了几层容器（0 = 最外那一层自己）。
 * @param seen - 已处理过的容器 id（防「parentId 成环」时无限递归）。
 * @param recurse - 要不要顺带递归排内层容器。
 *   ⚠️ **`relayoutInside` 传 false**（由 `orderLoopsInnerFirst` 逐个排）——
 *   递归排会用 `flipAxis` 算出一个**与外层正交、但与内层自己那一轮相反**的轴，
 *   把内层刚排好的结果覆盖掉。详见 `relayoutInside` 的说明。
 * @returns 新数组；**无任何变化时返回传进来的那个数组引用**。
 */
function layoutContainer(
  nodes: readonly V1Node[],
  containerId: string,
  edges: readonly { source: string, target: string }[],
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
  axis: InnerAxis,
  depth: number,
  seen: Set<string>,
  recurse: boolean,
): V1Node[] {
  /* 层数上限与执行期一致（`MAX_LOOP_DEPTH_UI` = `run.ts` 的 `MAX_LOOP_DEPTH`）。
   * 超过就**当普通节点摆**，不再往下递归 —— 与执行期的「超限明确报错」配套：
   * 界面不去猜一个跑不起来的图长什么样。 */
  if (depth >= MAX_LOOP_DEPTH_UI) return nodes as V1Node[]
  if (seen.has(containerId)) return nodes as V1Node[]
  seen.add(containerId)

  const kids0 = nodes.filter(n => n.parentId === containerId)

  /* ① **先排内层**，再排外层（仅当 `recurse` 为真时）。
   *
   * ⚠️ `relayoutInside` 传 `recurse = false` —— 它的调用方
   * （`refitNodes` 的 `orderLoopsInnerFirst` 循环）会**逐个**排每个容器，
   * 内层已经在自己那一轮排过了。这里再递归一次会用 `flipAxis` 算出
   * 与内层自己那轮**相反**的轴，把它的结果覆盖掉（2026-10-21 的真 BUG：
   * 嵌套循环的成员被排成横排、露到框外）。
   *
   * 保留递归这条路是给「只想排一棵子树」的调用方用的；当前没有这样的调用方，
   * 但删掉它会让「为什么不递归」变成一处没有代码可对照的传说。 */
  let cur = nodes as V1Node[]
  let changed = false
  if (recurse) {
    for (const k of kids0) {
      if (k.data.def.id !== LOOP_DEF_ID) continue
      const laid = layoutContainer(cur, k.id, edges, sizes, fallback, flipAxis(axis), depth + 1, seen, true)
      if (laid !== cur) {
        cur = laid
        changed = true
      }
    }
  }

  /* ② 成员少于 2 个不排（一个显示不出「不重叠」这件事，排了反而会把它挪走）。
   * ⚠️ 这一步放在递归**之后**：一个只装了一个「内层循环」的外层框，
   * 内层自己那批成员该排还是要排。 */
  if (kids0.length < 2) return changed ? cur : (nodes as V1Node[])

  const kids = cur.filter(n => n.parentId === containerId)

  /* ③ 只取**两端都在框内**的边（跨框的边是循环的进出边，与内部排列无关）。 */
  const kidIds = new Set(kids.map(k => k.id))
  const innerEdges = edges
    .filter(e => kidIds.has(e.source) && kidIds.has(e.target))
    .map(e => ({ source: e.source, target: e.target }))

  /* ④ 拓扑顺序（同层按原顺序，`topoSort` 保证稳定）。 */
  const topo = topoSort(kids.map(k => ({ id: k.id })), innerEdges)
  /* ⑤ 环里的节点排不出来 → 用原顺序补到末尾（保持用户原来的相对次序）。 */
  const ordered: string[] = [...topo.order]
  for (const k of kids) if (!ordered.includes(k.id)) ordered.push(k.id)

  const byId = new Map(kids.map(k => [k.id, k]))
  const pos = new Map<string, { x: number, y: number }>()
  /**
   * 本层实际用哪个轴向。
   *
   * 用户 2026-10-21 定（原话）：「**不应该每次转**，是自动横排的时候循环内竖排，
   * 自动竖排的时候循环内横排。同时给循环加个按钮调整横排和竖排吧」
   *
   * 所以规则变成两层：
   *   ① **默认**：由画布方向推到「正交」那个（`innerAxisOf`）—— 所有嵌套层**都一样**，
   *      **不再逐层翻转**（翻转正是上一版排版错乱的根源）；
   *   ② **手动**：某个循环框自己设了 `data.axis` 就用它，优先级最高。
   *
   * ⚠️ 为什么去掉逐层翻转：`refitNodes` 是**逐个循环**调进来的，每层传同一个
   * `dir`；要让翻转生效就得把「我是第几层」传进来（多一个参数、多一处可算错的地方），
   * 而用户要的是「简单、可预期」—— 所有层同向 + 需要时手动切。
   */
  const own = (nodes.find(n => n.id === containerId)?.data as { axis?: unknown } | undefined)?.axis
  const useAxis: InnerAxis = own === 'TB' || own === 'LR' ? own : axis
  if (useAxis === 'TB') {
    /* 竖排：x 统一取容器内左边距，y 依次累加（行距 = 该成员的高 + `BOX_GAP_Y`）。 */
    let y = BOX_PAD_TOP
    for (const id of ordered) {
      const k = byId.get(id) as V1Node
      const h = memberSize(k, sizes, fallback).h
      pos.set(id, { x: BOX_PAD_SIDE, y })
      y += h + BOX_GAP_Y
    }
  } else {
    /* 横排：y 统一取容器内上边距，x 依次累加（列距 = 该成员的宽 + `BOX_GAP_X`）。 */
    let x = BOX_PAD_SIDE
    for (const id of ordered) {
      const k = byId.get(id) as V1Node
      const w = memberSize(k, sizes, fallback).w
      pos.set(id, { x, y: BOX_PAD_TOP })
      x += w + BOX_GAP_X
    }
  }

  /* ⑥ 只在**真的有变化**时返回新数组（幂等：同输入同输出，不会引起无限渲染）。 */
  const next = cur.map(n => {
    const p = pos.get(n.id)
    if (p === undefined) return n
    if (n.position.x === p.x && n.position.y === p.y) return n
    changed = true
    return { ...n, position: p }
  })
  return changed ? next : (nodes as V1Node[])
}

/**
 * 把**一个容器内部**的节点重排成整齐的一列（或一行）。
 *
 * ## 为什么需要它
 *
 * 用户原话：「加入拖动加入循环后应该立即自动排版，不然一开始加入的时候叠一起了。」
 *
 * 原因：拖进容器时节点保持**你松手时的位置**，而框里原来的节点还在那儿 →
 * 两个节点叠在一起。而框的内边距只有几十像素，**没地方放**。
 *
 * ## 为什么自己排而不用 ELK
 *
 * ELK 是**异步**的，而这里必须在「改归属的同一拍」里同步算出位置 ——
 * 否则会出现「先按旧位置渲染一帧、再跳过去」的闪烁。
 * 而且框内结构简单（以一条链为主），按连线顺序摆一列就够，不需要通用布局算法。
 *
 * ## 排法（五条规则）
 *
 * 1. **轴向由画布方向决定，且是正交的** —— 见 `innerAxisOf`；
 * 2. **顺序按连线**：`topoSort` 得出「谁在谁后面」（同层按原顺序，稳定）；
 * 3. **成员逐个累加**：竖排累加 y（行距 = 该成员高 + `BOX_GAP_Y`），
 *    横排累加 x（列距 = 该成员宽 + `BOX_GAP_X`）；
 * 4. **环里的节点**（回边造成环，拓扑排不出来）→ 按原顺序补到末尾，保持相对次序；
 * 5. **嵌套循环先排内层、再排外层，每层翻转轴向** —— 内层循环按**它自己声明的尺寸**
 *    占位（不是普通节点的兜底尺寸），层数上限与执行期一致（5 层）。
 *
 * ⚠️ 坐标是**相对容器**的（React Flow 的 `parentId` 模型要求）。
 * 节点少于 2 个时不排（一个显示不出「不重叠」这件事，排了反而会把它挪走）。
 *
 * @param nodes - 全部节点。
 * @param containerId - 容器 id。
 * @param edges - 全部连线（**必须显式传** —— 连线不在 `nodes` 里）。
 * @param sizes - 实测尺寸表（量不到用兜底）。
 * @param fallback - 兜底节点尺寸。
 * @param dir - 画布方向（`'RIGHT'` / `'DOWN'`）。**框内按它的正交方向排**，见 `innerAxisOf`。
 *   ⚠️ 由调用方传，**不在这里读 `localStorage`** —— 这是纯函数，测试要能直接给方向。
 * @returns 新数组；无变化时返回**原数组引用**（调用方据此跳过 setState）。
 */
export function relayoutInside(
  nodes: readonly V1Node[],
  containerId: string,
  edges: readonly { source: string, target: string }[],
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
  dir: LayoutDirection,
  depth = 0,
): V1Node[] {
  /* ⚠️⚠️ **不递归**（2026-10-21 修的真 BUG，用户报「循环的自动排版都有问题」）。
   *
   * ## 症状
   *
   * 嵌套循环里，**内层框的成员被排成横排、而且露到框外**。
   * 实测（`取数-千川全域推广` 的 n12 在 n9 里）：n12 的成员
   * 位置是 `x=40 / x=380`、y 相同（横排），而 n12 的框只有 380 宽 → 第二个成员整个在外。
   *
   * ## 根因（两条叠在一起）
   *
   * `refitNodes` 已经按「内层先、外层后」逐个调这个函数：
   *
   * ```
   * for (const loopId of orderLoopsInnerFirst(next)) {
   *   next = relayoutInside(next, loopId, …, dir)   // ← 每一次都排**这一个**容器
   *   next = fitLoopBox(next, loopId, …)
   * }
   * ```
   *
   * 而旧实现在这里**又递归排了一遍内层**，传的是 `flipAxis(axis)`。
   * 于是内层被排了两次、而且两次的轴向**相反**：
   *
   *   · 它自己那一轮：`innerAxisOf('RIGHT')` = **TB**（竖排）；
   *   · 被外层递归那一轮：`flipAxis(TB)` = **LR**（横排）—— 后者覆盖前者。
   *
   * 外层拿到的内层尺寸还是「竖排那轮算的」，内层却被改成了横排 → 装不下。
   *
   * ## 修法
   *
   * 这个函数**只排本层**。内层由 `orderLoopsInnerFirst` 保证在它之前排过，
   * 它自己的轴向也只算一次（`innerAxisOf(dir)`）——「每一层相对上一层正交」
   * 这件事改由**调用方按层传 dir** 表达，不再在递归里翻。
   *
   * 实测确认：改前 n12 的成员横排越界；改后竖排、全部装进框内
   * （`tests/nested-loop-layout.mjs` 钉住）。
   *
   * @param nodes - 全部节点。
   * @param containerId - 要排的那个容器。
   * @param edges - 全部连线。
   * @param sizes - 实测尺寸表。
   * @param fallback - 兜底尺寸。
   * @param dir - 画布方向（本层轴向由它经 `innerAxisOf` 决定）。
   * @param depth - 这个容器在第几层（0 = 最外那层循环）。
   *   ⚠️ **必须传**：轴向是「每一层相对上一层正交」的（`innerAxisOf` + `flipAxis`），
   *   而 `refitNodes` 是**逐个循环**调本函数 —— 不传层深的话每层都按
   *   `innerAxisOf(dir)` 算成同一个轴向、**翻转丢了**：
   *   内层与外层排法一样，而外层按「内层会翻转」预留空间 → 装不下。
   * @returns 新数组；无变化时返回原引用。
   */
  return layoutContainer(nodes, containerId, edges, sizes, fallback, axisAt(dir, depth), 0, new Set(), false)
}

/**
 * 算出「从容器里拖出 X 时，还要连带拖出哪些节点」。
 *
 * ## 规则（用户 2026-10-13 拍板：「就按下游」）
 *
 * **X + 它在同一容器内的全部下游**（沿连线往后走，只走两端都在这个容器里的边）。
 *
 * 为什么是下游而不是「全部」：用户原话是
 * > 「脱出的时候应该类似拖入，脱出的节点后方的节点应该被连带拖出。」
 *
 * 「后方」= 下游。而**上游留在框里**是合法状态 —— 我们的模型是
 * 「逻辑是回边、外观是容器框，不是子图」（用户 2026-10-12 定），
 * 所以框里只剩上游照样能跑（循环只跑框内成员）。
 *
 * 行为表（`A → B → C` 都在框里）：
 *
 * | 拖谁 | 带走 |
 * |---|---|
 * | A（头） | A、B、C |
 * | B（中间） | B、C（**A 留在框里**） |
 * | C（尾） | 只 C |
 *
 * ⚠️ 有分支时（X 后面有两条路）**两条都带走** —— 因为留在框里的话，
 * 它们各自的上游都没了，等于把链从中间剪断，比多带走几个更难理解。
 *
 * @param nodes - 全部节点。
 * @param edges - 全部连线。
 * @param startId - 被拖出的那个节点。
 * @param containerId - 它所属的容器。
 * @returns 要一起移出的节点 id（**含 startId 自己**，按「先自己、再下游」顺序）。
 */
export function leaveClosure(
  nodes: readonly V1Node[],
  edges: readonly { source: string, target: string }[],
  startId: string,
  containerId: string,
): string[] {
  /* 只在这个容器内走 —— 跨框的边是循环的进出边，不该顺着它扩散出去。*/
  const kids = new Set(nodes.filter(n => n.parentId === containerId).map(n => n.id))
  if (!kids.has(startId)) return [startId]

  const downs = new Map<string, string[]>()
  for (const e of edges) {
    if (!kids.has(e.source) || !kids.has(e.target)) continue
    const list = downs.get(e.source)
    if (list === undefined) downs.set(e.source, [e.target])
    else list.push(e.target)
  }

  /* 从 startId 顺着下游走，**带环保护**（回边会造成环，不防就死循环）。 */
  const seen = new Set<string>([startId])
  const queue = [startId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const nxt of downs.get(cur) ?? []) {
      if (seen.has(nxt)) continue
      seen.add(nxt)
      queue.push(nxt)
    }
  }
  /* 顺序：先自己，其余按**拓扑序**（上游在前）—— 这样移出去之后相对次序好看。 */
  const rest = [...seen].filter(id => id !== startId)
  const order = new Map(kids.size === 0 ? [] : [...kids].map((id, i) => [id, i]))
  rest.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return [startId, ...rest]
}

/**
 * 把节点（连带下游）移出一个容器，并给它们安排落点。
 *
 * ## 落点规则
 *
 * 移出来的那几个摆在**原框的右侧**、与框顶对齐，并保持它们的相对竖向顺序 ——
 * 这样「从哪里来」一目了然，也不会压到画布上别的东西（右侧通常是空的）。
 *
 * 为什么不重排整张画布：那会**打乱用户自己摆的布局**。
 * 用户只要求「连带拖出」，没要求把整张图重新排一遍。
 *
 * ⚠️ 坐标：移出的节点要改成**绝对坐标**（`assignToContainer(nodes, id, null)` 内部处理），
 * 然后再平移到落点。
 *
 * @param nodes - 全部节点。
 * @param edges - 全部连线。
 * @param startId - 被拖出的节点。
 * @param containerId - 它所属的容器。
 * @param sizes - 实测尺寸表。
 * @param fallback - 兜底尺寸。
 * @returns `{ nodes, moved }`；`moved` 是跟着一起出来的 id（**不含** startId）。
 */
export function removeWithClosure(
  nodes: readonly V1Node[],
  edges: readonly { source: string, target: string }[],
  startId: string,
  containerId: string,
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): { nodes: V1Node[], moved: string[] } {
  const ids = leaveClosure(nodes, edges, startId, containerId)
  const moved = ids.filter(id => id !== startId)
  /* 先全部解掉父子关系（坐标自动绝对化）。 */
  let next: V1Node[] = [...nodes]
  for (const id of ids) next = assignToContainer(next, id, null)

  /* 落点：原框右侧。框的位置与尺寸从**原始 nodes** 里读（移出后框还会被贴边，
   * 这里只负责别摆在框上面）。 */
  const box = nodes.find(n => n.id === containerId)
  if (box === undefined) return { nodes: next, moved }
  const boxW = (box.style as { width?: number } | undefined)?.width ?? fallback.w
  const startX = box.position.x + boxW + BOX_PAD_SIDE * 2
  /* 竖排：从框顶开始，依次往下，与「框内重排」同一套间距，视觉统一。 */
  const byId = new Map(next.map(n => [n.id, n]))
  let y = box.position.y
  const pos = new Map<string, { x: number, y: number }>()
  for (const id of ids) {
    pos.set(id, { x: startX, y })
    /* 同 `fitLoopBox`：尺寸判据走 `memberSize`（被移出来的也可能是个内层循环框）。 */
    const movedNode = byId.get(id)
    const h = movedNode === undefined ? fallback.h : memberSize(movedNode, sizes, fallback).h
    y += h + BOX_GAP_Y
  }
  next = next.map(n => {
    const p = pos.get(n.id)
    if (p === undefined) return n
    if (byId.get(n.id)?.position.x === p.x && byId.get(n.id)?.position.y === p.y) return n
    return { ...n, position: p }
  })
  return { nodes: next, moved }
}

/**
 * 让一个**循环框**贴紧它的子节点（与 `fitGroup` 同类，但按循环体留边）。
 *
 * ⚠️ 必须**幂等**：返回原数组引用表示无变化，调用方据此跳过 setState ——
 * 否则 setState → 重渲染 → 又贴 → 死循环（`dom-render` 有专门的断言盯着）。
 *
 * ## 尺寸规则（三条，缺一条就会退回「框乱跳」的老毛病）
 *
 * 1. **内容 + 内边距** = 期望尺寸，但不小于 `BOX_MIN_W/H`（空框也用最小尺寸）；
 * 2. **尺寸只增大不缩到最小以下** —— 但内容变小**允许**缩（回到最小尺寸）；
 * 3. **位置尽量不动**：只要内容仍装得下当前框，就**保持框的原位置**，
 *    只在内容溢出时才移动它。这条是「框不跳走」的关键 ——
 *    只做 1、2 的话，移出一个节点后框的左上角仍会跟着剩下的内容跑。
 *
 * @param nodes - 全部节点。
 * @param loopId - 循环节点 id。
 * @param sizes - 实测尺寸表。
 * @param fallback - 兜底尺寸。
 * @returns 新数组或原数组（无变化时）。
 */
export function fitLoopBox(
  nodes: readonly V1Node[],
  loopId: string,
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): V1Node[] {
  const loop = nodes.find(n => n.id === loopId && n.data.def.id === LOOP_DEF_ID)
  if (loop === undefined) return nodes as V1Node[]

  const kids = nodes.filter(n => n.parentId === loopId)
  const cur = loop.style as { width?: number, height?: number } | undefined

  /* ⚠️ **收起态：框缩成一条，位置不动**（2026-10-16 加）。
   *
   * 收起是显示语义 —— 用户点「收起」要**看得出变化**，否则会以为按钮坏了
   * （原话：「循环的收起展开没有实际作用」）。
   * 宽度保留（收起的框仍代表「这一段的范围」），只把高度压到标题栏那条。
   * 成员坐标一个都不动 —— 展开时原样回来，不需要重新排。 */
  if (loop.data.collapsed === true) {
    if (cur?.height === BOX_COLLAPSED_H) return nodes as V1Node[]
    return nodes.map(n => n.id === loopId
      ? { ...n, style: { ...n.style, height: BOX_COLLAPSED_H } }
      : n)
  }

  /* ⚠️ **「设置」面板开着时要为它腾出地方**（2026-10-16，用户原话：
   * 「设置被里面的节点挡住了，这个设置区域**应该将内部节点往外挤压**」）。
   *
   * 两件事一起做：① 框长高（`extraH`）；② **成员整体下移**，让出框头 + 面板
   * 那一段（`topPad` 变高）。
   *
   * ⚠️ 为什么不能只做 ①：面板是 `position: absolute` 挂在框头下沿的
   * （见 CSS 里的长注释 —— 成员是 React Flow 平铺画的、与框是兄弟关系，
   * 框内部的 `z-index` 盖不过它们），所以「框长高」不会自动把成员挪开，
   * 面板照样盖在成员身上。必须真的推它们。
   *
   * ⚠️ 也别想着「把框往上挪」代替「把成员往下推」：那会让框整个跳走
   * （本项目为「框跳走」踩过三次），而用户要的是看得见的「挤压」。 */
  const settingsOpen = loop.data.settingsOpen === true
  /* ★ **让位高度优先用面板实测值**（2026-10-16，用户原话：「这个空间留出，
   *   你是弄的自动的，看设置有多少内容流多少，还是硬编码的」）。
   *
   * 面板自己量 `offsetHeight` 后经 `data.settingsPanelH` 报回来（见
   * `LoopNode.tsx` 的那个 `useEffect`），这里优先用它；量不到时（jsdom 没有布局、
   * 真机首帧、面板还没挂）退回 `BOX_SETTINGS_H` 的估算值。
   *
   * ⚠️ 别去掉那个兜底：`fitLoopBox` 在面板**还没渲染出来**的那一拍就要算尺寸，
   * 而那时没有任何实测值可用。 */
  const measured = typeof loop.data.settingsPanelH === 'number' ? loop.data.settingsPanelH : 0
  const panelH = measured > 0 ? measured : BOX_SETTINGS_H
  const extraH = settingsOpen ? panelH : 0
  /** 成员允许出现的最小 y（相对框顶）：框头 + 面板。收起/未开面板时是普通上边距。 */
  const topPad = settingsOpen ? BOX_HEAD_H + panelH : BOX_PAD_TOP

  /* 空框：**缩到最小尺寸**，位置不动。
   *
   * ⚠️ **2026-10-16 改**（用户原话：「将循环默认的宽度也取消掉，**没有内容的时候
   * 宽度只比普通节点大一点**」）。旧写法是 `Math.max(cur.width, BOX_MIN_W)`
   * ——「只增不减」，于是从旧存档读出来的空框会一直保留它当初的 740px 宽，
   * 用户看到的就是「明明空的却占着两个节点宽」。
   *
   * 现在空框**直接取最小值**（不理会 `cur.width`）。位置仍然不动 ——
   * 那条规矩防的是「移出成员后框跳走导致拖不回去」，而空框没有内容可参照，
   * 动它才是没道理的。 */
  if (kids.length === 0) {
    const mw = BOX_MIN_W
    const mh = BOX_MIN_H + extraH
    if (cur?.width === mw && cur?.height === mh) return nodes as V1Node[]
    return nodes.map(n => n.id === loopId
      ? { ...n, style: { ...n.style, width: mw, height: mh } }
      : n)
  }

  /* ⚠️ 成员尺寸走 `memberSize`，**与框内排列用同一套判据**。
   *
   * 两处用不同判据会怎样（2026-10-19，嵌套循环加进来之后才暴露）：
   * 成员是个**内层循环**、而实测表里没有它（首帧 / 面板还没挂）时，
   * `relayoutInside` 按它自己声明的 600×400 摆位，而这里按兜底 300×168 算框 →
   * **框比内容小一半，内层循环露在框外**。两个函数读同一份尺寸，这条才不会漂。 */
  const abs = kids.map(k => {
    const sz = memberSize(k, sizes, fallback)
    return {
      id: k.id,
      x: loop.position.x + k.position.x,
      y: loop.position.y + k.position.y,
      w: sz.w,
      h: sz.h,
    }
  })
  const cMinX = Math.min(...abs.map(a => a.x))
  const cMinY = Math.min(...abs.map(a => a.y))
  const cMaxX = Math.max(...abs.map(a => a.x + a.w))
  const cMaxY = Math.max(...abs.map(a => a.y + a.h))

  /* 期望宽度：内容 + 内边距，但不小于最小尺寸。 */
  const needW = Math.max(cMaxX - cMinX + BOX_PAD_SIDE * 2, BOX_MIN_W)

  /* 位置：**先试「不动」** —— 只要内容装得下当前框就保持原位置。
   * 装不下才平移到能装下（平移量取最小，避免框突然蹦很远）。
   *
   * ⚠️ **这里量的是「成员被推开之前」的包围盒，判据也仍用 `BOX_PAD_TOP`**
   * （2026-10-16 改）。原因见下面 `pushDown` 的长注释：让框**别动**、
   * 改推成员，才是用户要的「挤压」；用 `topPad` 去判会让框整体上移 172px
   * （实测踩到 —— 框跳到上面去，而成员一动不动）。 */
  const curW = cur?.width ?? 0
  const curH = cur?.height ?? 0
  let x = loop.position.x
  let y = loop.position.y
  const fitsNow = cMinX >= x + BOX_PAD_SIDE && cMinY >= y + BOX_PAD_TOP
    && cMaxX <= x + curW - BOX_PAD_SIDE && cMaxY <= y + curH - BOX_PAD_BOTTOM
  if (!fitsNow) {
    x = cMinX - BOX_PAD_SIDE
    y = cMinY - BOX_PAD_TOP
  }

  /* ★★ **把成员整体推开**，让出框头与设置面板那一段（用户 2026-10-16 原话：
   *   「设置被里面的节点挡住了，这个设置区域应该将内部节点往外挤压」）。
   *
   * 为什么必须推成员、而不能只让框长高：面板是 `position: absolute` 挂在框头
   * 下沿的（见 CSS 里的长注释 —— 成员是 React Flow 平铺画的、与框是兄弟关系，
   * 框内部的 `z-index` 盖不过它们），所以「框长高」不会自动把成员挪开，
   * 面板照样盖在它们身上。
   *
   * 为什么也不能靠「把框往上挪」代替：那正是 `fitsNow` 分支会做的事，实测结果是
   * **框整个上移 172px、成员一个像素没动**（因为成员的绝对坐标由父节点位置 +
   * 自身相对坐标决定，框一动成员跟着动）。那既是「框跳走」这个老毛病复发，
   * 也不是用户要的「挤压」。
   *
   * 算法：算出「最靠上的成员还差多少才到 `topPad`」，把这个差值**加给所有成员**。
   * 同一偏移才不改变它们之间排好的相对次序（`relayoutInside` 排出来的竖列不能乱）。
   *
   * ⚠️ **只推下、绝不拉上**（`Math.max(0, …)`）—— 这条很重要，两个理由：
   *
   * ① 关掉设置时若把差值算成负数，成员会被**拉回** `BOX_PAD_TOP`。
   *    而用户可能**自己把某个成员拖到框里靠下的位置**，下一次 refit 就把它
   *    拽回顶部 —— 那是个更难解释的 bug（「我拖好的位置自己跑了」）。
   * ② 只推不拉**不会累积**：推到位之后差值为 0，再跑一次什么都不动（幂等）。
   *    代价只是「开过一次设置之后，框顶部会留出那一段空白」——
   *    比「位置自己跑掉」好得多。
   *
   * 因此「成员不被设置面板挡住」是一次性的、只增不减的让位。 */
  const pushDown = Math.max(0, topPad - (cMinY - y))

  /* 期望高度：按**推开之后**的包围盒算，否则框不会随面板/收起变化。
   * 上边距是 `topPad`（面板开着时含框头 + 面板那一段）。 */
  const needH = Math.max(cMaxY + pushDown - y + BOX_PAD_BOTTOM, BOX_MIN_H + extraH)

  if (loop.position.x === x && loop.position.y === y
    && curW === needW && curH === needH && pushDown === 0) {
    return nodes as V1Node[]
  }

  const byId = new Map(abs.map(a => [a.id, a]))
  return nodes.map(n => {
    if (n.id === loopId) {
      return { ...n, position: { x, y }, style: { ...n.style, width: needW, height: needH } }
    }
    if (n.parentId !== loopId) return n
    const a = byId.get(n.id)
    if (a === undefined) return n
    return { ...n, position: { x: a.x - x, y: a.y - y + pushDown } }
  })
}

/**
 * 一个循环的「成员允许呆的范围」——上沿要跳过框头（以及开着的设置面板）。
 *
 * 与 `fitLoopBox` 用**同一组常量**：两边各写一套的话，
 * 「成员被钳住的范围」与「框算出来的尺寸」会对不上，表现为「明明还在框里却被弹回来」。
 *
 * @param loop - 循环节点。
 * @returns 上/下/左/右 四边允许的最小/最大值（相对框顶点的坐标）。
 */
export function loopInnerBounds(loop: V1Node): {
  minX: number, minY: number, maxX: number, maxY: number
} {
  const style = loop.style as { width?: number, height?: number } | undefined
  const w = style?.width ?? BOX_MIN_W
  const h = style?.height ?? BOX_MIN_H
  const panelH = typeof loop.data.settingsPanelH === 'number' && loop.data.settingsPanelH > 0
    ? loop.data.settingsPanelH
    : BOX_SETTINGS_H
  /* 上沿：框头；设置面板开着时再加上面板那一段（面板是绝对定位挂在框头下沿的，
   * 成员若钻到它下面就会被盖住 —— 那正是 2026-10-16 修过的那件事）。 */
  const top = loop.data.settingsOpen === true ? BOX_HEAD_H + panelH : BOX_PAD_TOP
  return {
    minX: BOX_PAD_SIDE,
    minY: top,
    maxX: w - BOX_PAD_SIDE,
    maxY: h - BOX_PAD_BOTTOM,
  }
}

/**
 * 把已进容器的节点**钳在框内**（照 Dify 的 `getRestrictedIterationPosition`）。
 *
 * ## 为什么要有这个（用户 2026-10-19 明确要抄）
 *
 * Dify 的做法是：成员一旦进了迭代框，拖动时**被钳住、出不去**
 * （`nodes/iteration/use-interactions.helpers.ts:47-60`）。理由不是防呆，
 * 是**一致性** —— 它没有「拖出即移出」这个动作（我搜过 `isInIteration = false`、
 * `parentId = undefined`、`removeFromIteration`，全仓零命中），
 * 所以成员若能拖到框外，界面会出现「看着在外面、其实还属于它」的矛盾状态。
 *
 * 我们的归属由右键菜单改（`putIntoLoop` / `takeOutOfLoop`），
 * 所以同样需要这条：**位置可以动，归属不能靠拖**。
 *
 * ⚠️ **只钳、不改归属**：这里返回的是新坐标，绝不碰 `parentId`。
 *
 * ⚠️ 框比成员还小的时候（刚建的框、或用户把框拖小了），
 * `maxX - minX < w` → 两个约束打架。此时的取舍是**优先保证左上角可见**
 * （`Math.max(min, Math.min(pos, max))` 先压上限再抬下限的顺序无关，
 * 这里刻意让下限赢）—— 否则成员会跑到框外，看起来像「明明在里面却不见了」。
 *
 * @param nodes - 全部节点。
 * @param nodeId - 被拖的那个。
 * @param sizes - 实测尺寸表。
 * @param fallback - 兜底尺寸。
 * @returns 需要改时返回新坐标（相对父），无需改时返回 `null`。
 */
export function clampIntoLoop(
  nodes: readonly V1Node[],
  nodeId: string,
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): { x: number, y: number } | null {
  const node = nodes.find(n => n.id === nodeId)
  if (node === undefined || node.parentId === undefined) return null
  const loop = nodes.find(n => n.id === node.parentId && n.data.def.id === LOOP_DEF_ID)
  if (loop === undefined) return null
  /* 收起态的框只有标题栏那么高 —— 成员此时被藏起来了（`shownNodes` 打 hidden），
   * 钳它会把它挪到一个莫名其妙的位置，展开后位置就乱了。所以不动。 */
  if (loop.data.collapsed === true) return null

  const b = loopInnerBounds(loop)
  /* 同 `fitLoopBox`：成员尺寸走 `memberSize`（内层循环按自己声明的尺寸算），
   * 否则拖一个内层循环框时会按 300×168 钳它 —— 框比它实际小，它被卡在中间拖不到右边。 */
  const sz = memberSize(node, sizes, fallback)
  const w = sz.w
  const h = sz.h
  const x = Math.max(b.minX, Math.min(node.position.x, b.maxX - w))
  const y = Math.max(b.minY, Math.min(node.position.y, b.maxY - h))
  if (x === node.position.x && y === node.position.y) return null
  return { x, y }
}

/**
 * 一个节点**可以放进**哪些循环（右键菜单的候选）。
 *
 * ## 三条排除（缺一条都会坏）
 *
 * ① **自己** —— 自己塞自己。
 * ② **自己的后代** —— 会成环（A 装 B、B 又装 A），调度器算层数时会绕不出去。
 *    注意：`descendantsOf` 走的是 `parentId` 链，所以「我里面的循环」也在里面。
 * ③ **已经满了 5 层的** —— 执行期 `MAX_LOOP_DEPTH` 会报错，界面不该让人先点进去再失败。
 *    层数按「放进它之后最深的那个节点在第几层」算。
 *
 *    ⚠️ **公式是 `候选层数 + 我的子树深度`，不是 `+ 1 +`**（第一版写错，被
 *    `tests/loop-nest-ui.mjs` 的「4 层的框仍可放进第 5 层」当场抓到）。
 *    道理：`candDepth` 是候选循环自己那层，我放进去就是 `candDepth + 1` 层，
 *    而 `myDepth` 已经把我自己算进去了（我就是循环时算 1）。
 *    所以「我最深那个节点」= `candDepth + myDepth`；再 `+1` 会多算一层，
 *    表现为「明明还能放进去却选不到」（我第一版就漏了 4 → 5 这一个组合）。
 *
 * ⚠️ 这是**菜单候选**，不是权限校验 —— 真正的约束仍由执行期判。
 * 但两边判据要一致，否则会出现「界面上能选、跑起来报错」。
 *
 * @param nodes - 全部节点。
 * @param nodeId - 要移动的节点（可能本身是个循环）。
 * @returns 可选的循环节点 id 列表（空数组 = 没得选）。
 */
export function loopTargetsFor(nodes: readonly V1Node[], nodeId: string): string[] {
  const node = nodes.find(n => n.id === nodeId)
  if (node === undefined) return []
  const banned = descendantsOf(nodes, nodeId)
  banned.add(nodeId)
  /* 我自己这棵子树有几层（我若是普通节点则是 0）。 */
  const myDepth = subtreeLoopDepth(nodes, nodeId)
  const out: string[] = []
  for (const cand of nodes) {
    if (cand.data.def.id !== LOOP_DEF_ID) continue
    if (banned.has(cand.id)) continue
    const candDepth = loopChainDepthOf(nodes, cand.id)
    /* 放进它之后，我这棵子树最深的那个在第 candDepth + myDepth 层。
     * ⚠️ 不是 candDepth + 1 + myDepth（那会多算一层，见函数头那条更正）。 */
    if (candDepth + myDepth > MAX_LOOP_DEPTH_UI) continue
    out.push(cand.id)
  }
  return out
}

/**
 * 一个节点处在第几层循环里（照 `loop.ts` 的 `loopChainDepth`，但只看 `parentId`）。
 *
 * @param nodes - 全部节点。
 * @param id - 要算的节点（普通节点算它所在的层，循环算它自己那层）。
 * @returns 层数（顶层普通节点是 0）。
 */
function loopChainDepthOf(nodes: readonly V1Node[], id: string): number {
  const byId = new Map(nodes.map(n => [n.id, n]))
  let depth = 0
  let cur = byId.get(id)
  let guard = nodes.length + 1
  while (cur !== undefined && guard > 0) {
    if (cur.data.def.id === LOOP_DEF_ID) depth += 1
    cur = cur.parentId === undefined ? undefined : byId.get(cur.parentId)
    guard -= 1
  }
  return depth
}

/**
 * 我这棵子树最深套了几层循环（我就是循环时算 1，普通节点算 0）。
 *
 * 用途：把一个「里面还套着循环」的循环放进外层时，要确认总层数不超上限。
 *
 * @param nodes - 全部节点。
 * @param rootId - 子树根。
 * @returns 最大层数。
 */
function subtreeLoopDepth(nodes: readonly V1Node[], rootId: string): number {
  const kids = new Map<string, V1Node[]>()
  for (const n of nodes) {
    if (n.parentId === undefined) continue
    const list = kids.get(n.parentId)
    if (list === undefined) kids.set(n.parentId, [n])
    else list.push(n)
  }
  const walk = (id: string, depth: number, guard: number): number => {
    if (guard <= 0) return depth
    const self = nodes.find(n => n.id === id)
    const next = self?.data.def.id === LOOP_DEF_ID ? depth + 1 : depth
    let best = next
    for (const k of kids.get(id) ?? []) {
      const d = walk(k.id, next, guard - 1)
      if (d > best) best = d
    }
    return best
  }
  return walk(rootId, 0, nodes.length + 1)
}

/**
 * 把一批循环框排成「**内层在前、外层在后**」。
 *
 * ## 为什么顺序不能反（2026-10-19，加嵌套循环时才暴露）
 *
 * `refitNodes` 对每个循环框做两件事：① `relayoutInside` 摆成员；② `fitLoopBox` 定框尺寸。
 * 若外层先跑，它摆成员时读的是内层循环**上一轮**的 `style.width/height` ——
 * 而内层这一轮的成员刚变过、框还没跟着变 → 外层按旧尺寸留位，
 * 内层框长出来之后**压住外层的下一个成员**。
 *
 * 内层先跑则相反：内层先把成员摆好、框定好尺寸，外层读到的就是本轮的真实尺寸。
 *
 * ⚠️ 与 `relayoutInside` 的递归**不冲突**：递归保证「内层成员被摆过」，
 * 这个顺序保证「内层框的尺寸是本轮的」。两件事缺一不可。
 *
 * 同一层之间保持原顺序（稳定排序），避免每轮来回换位置。
 *
 * @param nodes - 全部节点。
 * @returns 循环框的 id 列表，内层在前。
 */
export function orderLoopsInnerFirst(nodes: readonly V1Node[]): string[] {
  const loops = nodes.filter(n => n.data.def.id === LOOP_DEF_ID)
  /* `loopChainDepthOf` 数的是「自己算一层 + 上面每一层循环」，
   * 所以**层数大的在内层** → 降序排就是内层在前。
   * 排序稳定（ES2019+），同层保持原顺序。 */
  const depth = new Map(loops.map(n => [n.id, loopChainDepthOf(nodes, n.id)]))
  return loops
    .map(n => n.id)
    .sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0))
}
