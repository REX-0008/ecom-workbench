/** 编组的**名单模型**（照 n8n 的 Canvas Groups，2026-10-13 新增）。
 *
 * ## 为什么换成这个模型
 *
 * 用户 2026-10-13 定规矩：「改一下 agents.md，将之前的参考 N8N 改为参考 N8N 和 dify，
 * **他们都没有的就不做**」，并选择「编组照 n8n 改内部」。
 *
 * n8n 的做法（`refs` 里没有它，已联网读源码）：
 * ```ts
 * interface IWorkflowGroup { id: string; name: string; nodeIds: string[]; description?: string }
 * ```
 * 组就是**一串节点 id**，挂在 `workflow.nodeGroups[]` 上。
 *
 * ## 与旧模型（`parentId` 父容器）的根本差别
 *
 * | | 旧：`parentId` 父容器 | 新：名单（本文件） |
 * |---|---|---|
 * | 成员怎么记 | 子节点的 `parentId` 指向框 | 组的 `nodeIds` 里列着 |
 * | 成员坐标 | **相对框**（要换算） | **绝对**（永不改动） |
 * | 框的位置尺寸 | 存在框节点上（会跳、要贴边） | **每次渲染算**出来（不可能跳） |
 * | 整体拖动 | React Flow 自动（父动子动） | 自己写：给成员加同一偏移 |
 *
 * 新模型的**收益**：坐标永不被改写 ⇒ 「框跳走 / 贴边覆盖 / 相对绝对互转错」
 * 那一族 bug **从根上不存在**（我们为此踩过三次）。
 *
 * 新模型的**代价**：整体拖动要自己写（见 `moveGroupBy`），而且框不是父、
 * 不能被 React Flow 当容器用 —— 但它本来也不需要（框只是显示）。
 *
 * ## ⚠️ 循环**不用**这个模型
 *
 * 循环框仍是 `parentId` 容器，因为它**要执行**（调度器按 `parentId` 认循环体）。
 * 两组容器用两套机制是**有意的**：n8n 的组是纯视觉、Dify 的迭代是执行容器，
 * 而我们两样都有 —— 各自照各自最像的那家抄。
 */

/** 一个组（照 n8n 的 `IWorkflowGroup`）。 */
export interface NodeGroup {
  /** 组 id（与画布上的框节点 id 不同 —— 框是渲染出来的，不是存档节点）。 */
  id: string
  /** 组名（不能为空，n8n 也这么要求）。 */
  name: string
  /** 成员节点 id。 */
  nodeIds: string[]
  /** 可选描述（n8n 上限 145 字，见 `GROUP_DESC_MAX`）。 */
  description?: string
}

/**
 * 描述字数上限。
 *
 * 照 n8n 的 `GROUP_DESCRIPTION_MAX_LENGTH = 145`（它源码里的注释说这个数是为了
 * 「收起时保持在 3 行以内」）。同一个理由适用我们。
 */
export const GROUP_DESC_MAX = 145

/** 框的内边距（渲染时框要比成员大一圈）。 */
export const ROSTER_PAD = 26
/** 顶部多留一点给标题栏（可编辑的名字输入框在那里）。 */
export const ROSTER_PAD_TOP = 40

/** 成员的包围盒（画布绝对坐标）。 */
export interface Box { x: number, y: number, width: number, height: number }

/**
 * 算一组成员的包围盒（供渲染框用）。
 *
 * ⚠️ **纯函数、不改任何数据** —— 这是新模型的关键：框的位置尺寸是**算出来的**，
 * 不写回节点。所以它永远不会「跳」，也不需要贴边函数。
 *
 * @param group - 组。
 * @param positions - 节点 id → 绝对坐标。
 * @param sizes - 节点 id → 尺寸（量不到用兜底）。
 * @param fallback - 兜底尺寸。
 * @returns 包围盒（已含内边距）；没有成员时返回 `null`（空组不该画框）。
 */
export function groupBox(
  group: NodeGroup,
  positions: ReadonlyMap<string, { x: number, y: number }>,
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): Box | null {
  /* 只算**真的还在画布上**的成员（名单里可能残留已删除的 id —— 存档被手改过、
   * 或删节点时漏了清理；这里容错，不让一个坏 id 把整个框算没）。 */
  const live = group.nodeIds.filter(id => positions.has(id))
  if (live.length === 0) return null
  const xs = live.map(id => positions.get(id) as { x: number, y: number })
  const minX = Math.min(...xs.map(p => p.x)) - ROSTER_PAD
  const minY = Math.min(...xs.map(p => p.y)) - ROSTER_PAD_TOP
  const maxX = Math.max(...live.map(id => (positions.get(id) as { x: number }).x + (sizes.get(id)?.w ?? fallback.w)))
  const maxY = Math.max(...live.map(id => (positions.get(id) as { y: number }).y + (sizes.get(id)?.h ?? fallback.h)))
  return { x: minX, y: minY, width: maxX - minX + ROSTER_PAD, height: maxY - minY + ROSTER_PAD }
}

/**
 * 造一个新组（建组时用）。
 *
 * 名字照 n8n 给默认值「分组 N」（它的默认是「Group 1」）——
 * 用户建完可以立刻改名，但**不能为空**（n8n 也这么要求）。
 *
 * @param groups - 现有组（用来算默认名与保证 id 唯一）。
 * @param nodeIds - 成员。
 * @returns 新组。
 */
export function makeGroup(groups: readonly NodeGroup[], nodeIds: readonly string[]): NodeGroup {
  /* id 用 `g-序号`（与节点 id 的 `n-` 前缀区分开，看存档一眼能认出）。 */
  let n = groups.length + 1
  while (groups.some(g => g.id === 'g-' + String(n))) n += 1
  /* 默认名同样避重（n8n：重名会自动改名）。 */
  let m = groups.length + 1
  while (groups.some(g => g.name === '分组 ' + String(m))) m += 1
  return { id: 'g-' + String(n), name: '分组 ' + String(m), nodeIds: [...nodeIds] }
}

/**
 * 把节点加进组（若它已在别的组里，先摘出来）。
 *
 * ⚠️ n8n 的硬规则：**一个节点最多属一个组**
 * （它源码 `NODE_GROUPING_RULES.nodeAlreadyGrouped`：
 * 「A node can belong to at most one group at a time.」）。
 * 所以这里先摘。
 *
 * @param groups - 现有组。
 * @param groupId - 目标组。
 * @param ids - 要加入的节点。
 * @returns 新组数组（无变化时返回**原数组引用**）。
 */
export function addToGroup(
  groups: readonly NodeGroup[],
  groupId: string,
  ids: readonly string[],
): NodeGroup[] {
  const target = groups.find(g => g.id === groupId)
  if (target === undefined) return groups as NodeGroup[]
  const add = ids.filter(id => !target.nodeIds.includes(id))
  if (add.length === 0 && !groups.some(g => g.id !== groupId && g.nodeIds.some(id => ids.includes(id)))) {
    return groups as NodeGroup[]
  }
  const next = groups.map(g => {
    /* 先从别的组里摘掉（一个节点只能属一个组）。 */
    const cleaned = g.nodeIds.filter(id => !ids.includes(id))
    if (g.id !== groupId) return cleaned.length === g.nodeIds.length ? g : { ...g, nodeIds: cleaned }
    /* 目标组：摘掉重复的再加入。 */
    return { ...g, nodeIds: [...cleaned, ...ids.filter(id => !cleaned.includes(id))] }
  })
  return next
}

/**
 * 把节点从组里摘掉（解散单个成员）。
 *
 * @param groups - 现有组。
 * @param ids - 要摘的节点。
 * @returns 新组数组；组因此变空时**保留空组**（由调用方决定删不删 ——
 *   n8n 的规则是「组至少一个成员」，但空组是合法的**过渡状态**，见那里的说明）。
 */
export function removeFromGroups(groups: readonly NodeGroup[], ids: readonly string[]): NodeGroup[] {
  let changed = false
  const next = groups.map(g => {
    const kept = g.nodeIds.filter(id => !ids.includes(id))
    if (kept.length === g.nodeIds.length) return g
    changed = true
    return { ...g, nodeIds: kept }
  })
  return changed ? next : (groups as NodeGroup[])
}

/**
 * 整组按偏移移动（拖动框时用）。
 *
 * ## 为什么要自己写（这是新模型唯一的代价）
 *
 * 旧模型里框是**父节点**，React Flow 让「框动子动」自动成立。
 * 新模型里框只是个渲染出来的矩形，所以拖动它必须**把每个成员加同样的偏移**。
 * 好在这是十几行、且**不涉及坐标换算**（成员坐标是绝对的），比旧模型那套
 * 相对/绝对互转简单得多。
 *
 * @param nodes - 全部节点。
 * @param group - 要移动的组。
 * @param dx - x 偏移。
 * @param dy - y 偏移。
 * @returns 新节点数组（无成员时返回原数组引用）。
 */
export function moveGroupBy<T extends { id: string, position: { x: number, y: number } }>(
  nodes: readonly T[],
  group: NodeGroup,
  dx: number,
  dy: number,
): T[] {
  const members = new Set(group.nodeIds)
  if (!nodes.some(n => members.has(n.id))) return nodes as T[]
  return nodes.map(n => members.has(n.id)
    ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
    : n)
}

/**
 * 把描述裁到上限内（存档写入前用）。
 *
 * 照 n8n 的做法：**超长截断而不是拒绝**（它的注释说导入一个超长描述的存档时
 * 「n8n shortens them and shows a warning」）。截断比让用户丢一整个存档好。
 *
 * @param text - 原描述。
 * @returns 截断后的描述（空串表示没有描述）。
 */
export function clampDesc(text: string): string {
  const t = text.trim()
  return t.length <= GROUP_DESC_MAX ? t : t.slice(0, GROUP_DESC_MAX)
}
