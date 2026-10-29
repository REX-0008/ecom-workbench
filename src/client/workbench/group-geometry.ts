/** 编组的几何运算（契约 CE，用户 m01076）。
 *
 * ## 这个文件从哪来
 *
 * 照参考项目 `refs-projects/infinite-canvas/web/src/lib/canvas/canvas-node-geometry.ts`
 * （231 行）搬的。用户 m01076 原话：「按照参考的编组模式和功能改我们的，我觉得用他们的好点」。
 *
 * **保留它原来的注释**，只在「我们这边不同」的地方加说明。
 *
 * ## 两种模型的根本差别（改之前先看这一张表）
 *
 * | 行为 | 参考项目（现在照抄） | 我们原来 |
 * |---|---|---|
 * | 组是什么 | **真节点**（`type: 'group'`，有位置宽高，能选中/拖动/缩放） | 不是节点，是一份名单，框每次渲染算出来 |
 * | 成员怎么认 | 成员的 `data.groupId` 指向组 | 组的 `nodeIds` 里列着 |
 * | 拖节点进组 | 拖停时中心落在框内 → 自动归入 + 吸附 | 无 |
 * | 拖节点出组 | 拖出框 → 自动脱离 | 无 |
 * | 框可改大小 | 能（四角拖动，改完同步成员归属） | 不能，自动贴合成员 |
 * | 一键收纳框内节点 | 有 | 无 |
 * | 框适应成员 | 手动点 | 自动 |
 *
 * ## ⚠️ 成员的坐标仍是**绝对坐标**
 *
 * 参考项目的成员坐标也是绝对的，`groupId` 只是归属标记（不是 React Flow 的
 * `parentId` 父子容器）。这条必须守住：
 *
 *   · 循环框用的是 `parentId`（调度器按它认循环体）—— **那是另一套，不许混**；
 *   · 组用 `groupId`，坐标绝对。两者同时出现在一个画布上互不干扰。
 *
 * ## 这个文件一行 React 都不 import
 *
 * 全是纯函数，测试可以直接喂数据断言（验收 8）。界面只做「把 state 传进来、把
 * 结果 set 回去」。
 */

/** 组节点的类型名（React Flow 的 `nodeTypes` 键）。 */
export const GROUP_NODE_TYPE = 'group'

/** 一个节点的几何 + 归属（这个文件只认这几个字段，不认 V1Node / ContentNode）。 */
export interface GeoNode {
  /** id。 */
  id: string
  /** 类型（`group` 是组）。 */
  type?: string
  /** 左上角坐标（**绝对坐标**）。 */
  position: { x: number, y: number }
  /** 宽。 */
  width: number
  /** 高。 */
  height: number
  /** 归属信息（成员指向组）。 */
  data?: { groupId?: string, [k: string]: unknown }
}

/** 包围盒。 */
export interface NodeBounds {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 一组节点的包围盒。
 *
 * ⚠️ 空数组时返回**反向无限值**（`Infinity / -Infinity`）—— 这是参考项目的原写法，
 * 为的是让 `reduce` 第一次就能被覆盖掉。调用方必须先判空，否则算出来的是一个
 * 「什么都在里面」的框（`NaN` 级别的错，很难查）。
 *
 * @param nodes - 节点。
 * @returns 包围盒。
 */
export function nodeBounds(nodes: readonly GeoNode[]): NodeBounds {
  return nodes.reduce(
    (acc, node) => ({
      left: Math.min(acc.left, node.position.x),
      top: Math.min(acc.top, node.position.y),
      right: Math.max(acc.right, node.position.x + node.width),
      bottom: Math.max(acc.bottom, node.position.y + node.height),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  )
}

/**
 * 节点中心是否落在某个矩形里。
 * @param n - 节点。
 * @param box - 矩形（组的框）。
 * @returns 在里面为 true。
 */
function centerInside(n: GeoNode, box: GeoNode): boolean {
  const cx = n.position.x + n.width / 2
  const cy = n.position.y + n.height / 2
  return cx >= box.position.x && cx <= box.position.x + box.width
    && cy >= box.position.y && cy <= box.position.y + box.height
}

/**
 * 一个节点是否被某个组包住。
 *
 * 判定标准：**节点中心落在组内**（照参考项目的注释原文）。
 * 为什么不用「完全包含」：大节点拖到框上沿时完全包含判据永远不成立，
 * 用户会觉得「怎么拖都进不去」。
 *
 * @param node - 节点。
 * @param group - 组。
 * @returns 被包住为 true。
 */
export function isNodeEnclosedInGroup(node: GeoNode, group: GeoNode): boolean {
  /* 组不能包自己，也不能包别的组（组不嵌套 —— 参考项目同样不支持）。 */
  if (node.id === group.id || node.type === GROUP_NODE_TYPE) return false
  return centerInside(node, group)
}

/**
 * 点是否在某个组内（给单个节点找归属用）。
 *
 * 从后往前找：后加入的组在上面（`reverse` 照参考项目）。
 *
 * @param node - 节点。
 * @param nodes - 全部节点。
 * @returns 组 id；不在任何组里给 `undefined`。
 */
export function findContainingGroupId(node: GeoNode, nodes: readonly GeoNode[]): string | undefined {
  return [...nodes]
    .reverse()
    .find(g => g.type === GROUP_NODE_TYPE && g.id !== node.id && centerInside(node, g))
    ?.id
}

/**
 * 拖动结束时算出「该落进哪个组」。
 *
 * 规则（照参考项目）：被拖的节点里**任何一个**的中心落在某个组内 → 落进那个组。
 * 从后往前取第一个命中的（后画的组在上面）。
 *
 * @param movedIds - 这次被拖的节点 id。
 * @param nodes - 全部节点。
 * @returns 目标组；不该落进任何组给 `null`。
 */
export function findGroupDropTarget(movedIds: ReadonlySet<string>, nodes: readonly GeoNode[]): GeoNode | null {
  /* 拖的是组本身 → 不落进别的组（组不嵌套）。 */
  if (nodes.some(n => movedIds.has(n.id) && n.type === GROUP_NODE_TYPE)) return null
  const moving = nodes.filter(n => movedIds.has(n.id) && n.type !== GROUP_NODE_TYPE)
  if (moving.length === 0) return null
  return [...nodes].reverse().find(g => {
    if (g.type !== GROUP_NODE_TYPE || movedIds.has(g.id)) return false
    return moving.some(n => centerInside(n, g))
  }) ?? null
}

/**
 * 把拖进框的节点**吸附**进去（位置挪进内边距以内）+ 打上 `groupId`。
 *
 * 吸附的意义：不吸附的话，节点看起来「一半在框外」，而它其实已经属于这组了 ——
 * 用户没法从画面上判断归属。
 *
 * @param movedIds - 被拖的节点。
 * @param nodes - 全部节点。
 * @param group - 目标组。
 * @returns 新节点数组。
 */
export function snapNodesIntoGroup(
  movedIds: ReadonlySet<string>,
  nodes: readonly GeoNode[],
  group: GeoNode,
): GeoNode[] {
  const moving = nodes.filter(n => movedIds.has(n.id) && n.type !== GROUP_NODE_TYPE)
  if (moving.length === 0) return [...nodes]
  const pad = 24
  const bounds = nodeBounds(moving)
  const left = group.position.x + pad
  const top = group.position.y + pad
  const right = group.position.x + group.width - pad
  const bottom = group.position.y + group.height - pad
  const dx = bounds.right - bounds.left > right - left
    ? left - bounds.left
    : bounds.left < left ? left - bounds.left
      : bounds.right > right ? right - bounds.right : 0
  const dy = bounds.bottom - bounds.top > bottom - top
    ? top - bounds.top
    : bounds.top < top ? top - bounds.top
      : bounds.bottom > bottom ? bottom - bounds.bottom : 0
  return nodes.map(n => {
    if (!movedIds.has(n.id) || n.type === GROUP_NODE_TYPE) return n
    return {
      ...n,
      position: { x: n.position.x + dx, y: n.position.y + dy },
      data: { ...n.data, groupId: group.id },
    }
  })
}

/**
 * 算一组节点的包围框（带内边距）。
 *
 * 内边距照参考项目：左右 36、顶 44、底 36。
 * 顶部多 8px 是因为框的标题行要占位置 —— 不然标题会压在成员节点上。
 *
 * 另外有**最小尺寸**（280×200，照参考项目）：一个单独的节点周围留 36 太窄，
 * 框会变成一条挤在节点上的细边，看起来像画错了。
 *
 * @param nodes - 成员节点。
 * @param padX - 左右内边距。
 * @param padTop - 顶部内边距。
 * @param padBottom - 底部内边距。
 * @returns 框的位置与尺寸。
 */
export function calculateGroupBoundsForNodes(
  nodes: readonly GeoNode[],
  padX = 36,
  padTop = 44,
  padBottom = 36,
): { x: number, y: number, width: number, height: number } {
  if (nodes.length === 0) return { x: 0, y: 0, width: 760, height: 480 }
  const bounds = nodeBounds(nodes)
  const contentW = bounds.right - bounds.left + padX * 2
  const contentH = bounds.bottom - bounds.top + padTop + padBottom
  const extraW = Math.max(0, 280 - contentW)
  const extraH = Math.max(0, 200 - contentH)
  return {
    x: bounds.left - padX - extraW / 2,
    y: bounds.top - padTop - extraH / 2,
    width: contentW + extraW,
    height: contentH + extraH,
  }
}

/**
 * 把框缩到刚好包住成员（「适应成员」）。
 *
 * @param groupId - 组 id。
 * @param nodes - 全部节点。
 * @param padX - 左右内边距。
 * @param padTop - 顶部内边距。
 * @param padBottom - 底部内边距。
 * @returns 新节点数组；找不到组或组里没成员时原样返回。
 */
export function fitGroupToEnclosedChildren(
  groupId: string,
  nodes: readonly GeoNode[],
  padX = 36,
  padTop = 44,
  padBottom = 36,
): GeoNode[] {
  const group = nodes.find(n => n.id === groupId && n.type === GROUP_NODE_TYPE)
  if (group === undefined) return [...nodes]
  const children = nodes.filter(n => n.data?.groupId === groupId)
  if (children.length === 0) return [...nodes]
  const b = calculateGroupBoundsForNodes(children, padX, padTop, padBottom)
  return nodes.map(n => (n.id !== groupId ? n
    : { ...n, position: { x: b.x, y: b.y }, width: b.width, height: b.height }))
}

/**
 * 一键收纳：把几何上落在框内的节点都归进这一组。
 *
 * @param groupId - 组 id。
 * @param nodes - 全部节点。
 * @returns 新节点数组 + 这次收进去几个。
 */
export function captureEnclosedNodesIntoGroup(
  groupId: string,
  nodes: readonly GeoNode[],
): { nextNodes: GeoNode[], capturedCount: number } {
  const group = nodes.find(n => n.id === groupId && n.type === GROUP_NODE_TYPE)
  if (group === undefined) return { nextNodes: [...nodes], capturedCount: 0 }
  let capturedCount = 0
  const nextNodes = nodes.map(n => {
    if (n.type === GROUP_NODE_TYPE || n.id === groupId) return n
    if (isNodeEnclosedInGroup(n, group) && n.data?.groupId !== groupId) {
      capturedCount += 1
      return { ...n, data: { ...n.data, groupId } }
    }
    return n
  })
  return { nextNodes, capturedCount }
}

/**
 * 解散：删掉组节点 + 清成员的 `groupId`。
 *
 * @param groupId - 组 id。
 * @param nodes - 全部节点。
 * @returns 新节点数组。
 */
export function ungroupCanvasGroup(groupId: string, nodes: readonly GeoNode[]): GeoNode[] {
  return nodes
    .filter(n => n.id !== groupId)
    .map(n => (n.data?.groupId === groupId ? { ...n, data: { ...n.data, groupId: undefined } } : n))
}

/**
 * 组移动 / 缩放之后同步成员归属。
 *
 * 三件事：
 *   ① 几何上在框内的 → 归入（原来不在这一组的）；
 *   ② 原来在这一组、现在不在框内的 → **脱离**（改成它现在落在的那个组，没有就清空）；
 *   ③ 其余不动。
 *
 * ⚠️ 这是「拖框」那条路的唯一入口 —— 框不是父容器，拖它不会带成员走，
 * 所以「谁还在框里」必须在拖完之后重算一次。删掉这个函数，框就会变成
 * 「只是画了条线」：拖完框，成员归属全错。
 *
 * @param groupNodeId - 组 id。
 * @param nodes - 全部节点。
 * @returns 新节点数组。
 */
export function syncGroupMembershipAfterTransform(
  groupNodeId: string,
  nodes: readonly GeoNode[],
): GeoNode[] {
  const group = nodes.find(n => n.id === groupNodeId && n.type === GROUP_NODE_TYPE)
  if (group === undefined) return [...nodes]
  return nodes.map(n => {
    if (n.type === GROUP_NODE_TYPE) return n
    const inside = isNodeEnclosedInGroup(n, group)
    if (inside) {
      if (n.data?.groupId !== group.id) return { ...n, data: { ...n.data, groupId: group.id } }
      return n
    }
    if (n.data?.groupId === group.id) {
      /* 原先属于该组但移动/缩放后脱离了 —— 看看它落进了哪个别的组。 */
      const other = findContainingGroupId(n, nodes)
      return { ...n, data: { ...n.data, groupId: other } }
    }
    return n
  })
}

/**
 * 用一组节点建一个组节点。
 *
 * @param id - 新组的 id。
 * @param members - 成员节点（用它们的包围盒定框）。
 * @param name - 组名（可空，界面会显示「分组」）。
 * @param memberIds - 这次要归进去的节点 id（默认 = `members` 的 id）。
 * @returns 组节点 + 打过 `groupId` 的成员数组。
 */
export function createGroupFromNodes(
  id: string,
  members: readonly GeoNode[],
  name = '',
  memberIds?: readonly string[],
): { group: GeoNode, nodes: GeoNode[] } {
  const bounds = calculateGroupBoundsForNodes(members)
  const ids = new Set(memberIds ?? members.map(m => m.id))
  const group: GeoNode = {
    id,
    type: GROUP_NODE_TYPE,
    position: { x: bounds.x, y: bounds.y },
    width: bounds.width,
    height: bounds.height,
    data: { groupLabel: name },
  }
  return { group, nodes: members.map(m => (ids.has(m.id) ? { ...m, data: { ...m.data, groupId: id } } : m)) }
}

/**
 * 某个组收起了没有（收起时成员从画布上藏掉，但**仍然存在**）。
 * @param nodes - 全部节点。
 * @returns 收起的组 id 集合。
 */
export function collapsedGroupIds(nodes: readonly GeoNode[]): Set<string> {
  const out = new Set<string>()
  for (const n of nodes) {
    if (n.type === GROUP_NODE_TYPE && n.data?.collapsed === true) out.add(n.id)
  }
  return out
}

/* ── 画布节点 ⇄ 几何节点（2026-10-26 契约 CE 追加）────────────────────
 *
 * ## 为什么要有这两个换算
 *
 * 几何层（本文件上半部分）只认 `id / type / position / width / height / data.groupId` ——
 * 这是刻意的：执行画布的节点（`V1Node`，带 `def` / `params` / 运行态）与
 * 内容画布的节点（`ContentNode`，带 `text` / `prompt` / 产物 id）形状完全不同，
 * 让几何层认识两种节点，它就得跟着两边的字段改动一起改。
 *
 * 所以两边各自把节点「拍扁」成 `GeoNode` 再交给几何函数，算完再拿回来
 * **只写回几何字段**（位置、宽高、`groupId`）—— 别的字段一个都不许碰，
 * 碰了就会把用户的内容抹掉（内容画布那边有同样的注释，见 `content-canvas-store.ts:1240`）。
 *
 * ## 宽高从哪来
 *
 * 节点自己的 `width` / `height`（分组框有，普通节点通常没有）→ 没有就用量出来的
 * 实际尺寸（`measureNodes`）→ 再没有就用画布给的兜底尺寸。
 */
export interface GeoFlowNode {
  /** id。 */
  id: string
  /** React Flow 的节点类型（`group` 是组）。 */
  type?: string
  /** 左上角坐标。 */
  position: { x: number, y: number }
  /** 显式宽（分组框有）。 */
  width?: number
  /** 显式高（分组框有）。 */
  height?: number
  /** 节点载荷（这里只读 / 只写 `groupId`）。 */
  data: Record<string, unknown>
}

/**
 * 把一批画布节点拍成几何节点。
 *
 * @param nodes - 画布节点。
 * @param sizes - 实测尺寸表（`measureNodes` 的产出；没有就传空表）。
 * @param fallback - 都量不到时的兜底尺寸（`canvas-layout.ts` 的 `NODE_W` / `NODE_H`）。
 * @returns 几何节点（顺序与入参一致）。
 */
export function toGeoNodes(
  nodes: readonly GeoFlowNode[],
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): GeoNode[] {
  return nodes.map(n => {
    const measured = sizes.get(n.id)
    const w = typeof n.width === 'number' && n.width > 0 ? n.width : (measured?.w ?? fallback.w)
    const h = typeof n.height === 'number' && n.height > 0 ? n.height : (measured?.h ?? fallback.h)
    const gid = n.data.groupId
    return {
      id: n.id,
      type: n.type,
      position: { x: n.position.x, y: n.position.y },
      width: w,
      height: h,
      data: { groupId: typeof gid === 'string' && gid !== '' ? gid : undefined },
    }
  })
}

/**
 * 把几何节点的结果**只回写几何字段**到原节点上。
 *
 * ⚠️ 只写四样：`position` / `width` / `height` / `data.groupId`。
 * 其它字段（`data.def`、`data.params`、运行状态…）一个都不动 ——
 * 几何层手里那份没有它们，重建会把它们抹掉。
 *
 * ⚠️ `data.groupId` 变空时要**delete 那个键**，不能写 `undefined`：
 * 存档会把它序列化成 `"groupId": null`，读回来又是个脏值。
 *
 * ## ⚠️ 这个函数**不增不删**（只说清，别指望它删节点）
 *
 * 它按**原数组**遍历：几何结果里没有的 id 就原样留着；几何结果里有、
 * 原数组没有的 id 也不会被造出来。
 *
 * 为什么这么定：调用方传进来的 `geo` 未必是「全部节点」。`groupSelected`
 * 那条路只把**新选的成员**交给 `createGroupFromNodes`，再把结果拼进来 ——
 * 若这里按 `geo` 的 id 集删，它会把画布上**别的节点全删掉**。
 *
 * 所以「删节点」这件事由**调用方显式做**（解散那两处：先 filter 掉框，再回写）。
 * 想让这个函数代为删除，就得先能把「全部节点」与「一部分节点」区分开，
 * 那是另一个签名，不是加个开关能糊过去的。
 *
 * @param nodes - 原节点。
 * @param geo - 几何层算出来的节点（数量与顺序任意；缺 id 的保留原样）。
 * @returns 新节点数组（长度与 `nodes` 相同）。
 */
export function applyGeoNodes<T extends {
  id: string
  position: { x: number, y: number }
  data: Record<string, unknown>
  width?: number
  height?: number
}>(nodes: readonly T[], geo: readonly GeoNode[]): T[] {
  const byId = new Map(geo.map(g => [g.id, g]))
  return nodes.map(n => {
    const g = byId.get(n.id)
    if (g === undefined) return n
    const data: Record<string, unknown> = { ...n.data }
    const gid = g.data?.groupId
    if (typeof gid === 'string' && gid !== '') data.groupId = gid
    else delete data.groupId
    const next: T = {
      ...n,
      position: { x: g.position.x, y: g.position.y },
      /* `data` 的类型仍是 `T['data']`（V1NodeData / ContentNodeData 各自那一份）——
       * 这里只改了它的两个键，形状没变，所以这个断言是忠实的，不是在骗类型。 */
      data: data as T['data'],
    }
    if (g.width > 0) next.width = g.width
    if (g.height > 0) next.height = g.height
    return next
  })
}


/**
 * 旧存档迁移：`groups: NodeGroup[]`（名单模型）→ 组节点 + 成员的 `groupId`。
 *
 * ## 为什么必须迁移
 *
 * 组从「名单」变成「节点」之后，存档形状变了。不迁移的话，用户打开一份旧画布
 * 看到的是「分组全没了」—— 而它的数据其实还在，只是没人读。
 *
 * ## 迁移规则
 *
 *   · 名单里每个组 → 一个组节点，id 沿用（这样别的引用不会断）；
 *   · 框的位置尺寸照**当前成员的包围盒**算（旧存档里没有存框的尺寸）；
 *   · 成员的 `groupId` 按名单设上；
 *   · 名单里有、但画布上已经找不到的节点 id → 跳过（旧存档可能本来就脏）。
 *
 * @param nodes - 画布节点（不含组节点）。
 * @param groups - 旧名单。
 * @returns 新节点数组（成员 + 组节点），以及迁移了几个组。
 */
export function migrateRosterGroups(
  nodes: readonly GeoNode[],
  groups: readonly { id: string, name: string, nodeIds: readonly string[], description?: string }[],
): { nodes: GeoNode[], migrated: number } {
  if (groups.length === 0) return { nodes: [...nodes], migrated: 0 }
  const owner = new Map<string, string>()
  for (const g of groups) {
    for (const nid of g.nodeIds) {
      /* 一个节点只归一个组（嵌套不支持）。后出现的组覆盖前面的 —— 与
       * `findContainingGroupId` 的「后画的在上面」一致。 */
      if (nodes.some(n => n.id === nid)) owner.set(nid, g.id)
    }
  }
  const withOwner = nodes.map(n => (owner.has(n.id)
    ? { ...n, data: { ...n.data, groupId: owner.get(n.id) } }
    : n))
  const groupNodes: GeoNode[] = []
  for (const g of groups) {
    const members = withOwner.filter(n => n.data?.groupId === g.id)
    if (members.length === 0) continue
    const b = calculateGroupBoundsForNodes(members)
    groupNodes.push({
      id: g.id,
      type: GROUP_NODE_TYPE,
      position: { x: b.x, y: b.y },
      width: b.width,
      height: b.height,
      data: {
        groupLabel: g.name,
        ...g.description === undefined ? {} : { note: g.description },
      },
    })
  }
  /* 组节点排在最前（渲染时在底下，与 `zIndex` 一起保证框不盖住成员）。 */
  return { nodes: [...groupNodes, ...withOwner], migrated: groupNodes.length }
}
