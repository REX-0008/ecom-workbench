/** 展开节点时的**下游让位**（纯运算，不碰 React/DOM）。
 *
 * ## 要解决什么
 *
 * 我们的节点是「**节点内展开**」（2026-10-08 用户定：弹框不要了）。
 * 展开时节点自己会长高（参数区，上限 220px，见 node-form.module.css 的 inlineEditor），
 * 于是会**压住正下方的节点** —— 用户 2026-10-16 报的正是这个。
 *
 * ## 为什么不用现成的自动排版（ELK）
 *
 * 用户问过「能不能借自动排版那个库做」。**实测（2026-10-16）它做不到**，
 * 用的是项目里那份 elkjs 0.12.0（图：a→b→c→d，b→e；a 由 168px 撑到 500px）：
 *
 *   普通模式   a dy=-28，b/c/d/e 全 +138  ← 连 a 自己都动，整张图往下漂
 *   交互模式   一个坐标都不动，但 a 与同层的 a2 重叠 392px（它有意放任重叠）
 *   给每个节点塞 org.eclipse.elk.position  排出来**完全一样**（layered 根本不看输入坐标）
 *
 * 也就是说它**没有**「保留现有布局、只挪该挪的」这一档。所以这里手写。
 *
 * ## 规则（用户 2026-10-16 拍板）
 *
 *   用户原话：「循环的框单独算吧，如果是循环外的节点，循环框作为整理，
 *   如果是循环内的节点，循环内外节点都挪，且循环框也跟着变大。」
 *
 * 落到算法上是四条：
 *
 * 1 **被压住的第一批**：水平方向与展开节点相交、且顶边落在长高的那条带子
 *   `[底边, 底边+extra)` 里的节点。
 * 2 **整列一起让**：把这批人下面同一列的所有节点（＋各自的下游）**平移同一个量**。
 *   为什么不只挪被压住的那几个 —— 只挪它们，它们立刻压到下面还没动的邻居，
 *   又得再挪一轮。整列平移**间距不变**，所以不可能连锁制造新的重叠。
 * 3 **循环框两种情况都对**（不需要特判）：
 *   - 展开的是框**外面**的节点 → 框整体下移，框里的成员**跟着走**（相对坐标不动）；
 *   - 展开的是框**里面**的节点 → 框不动，框里被压住的成员**相对坐标变大**，
 *     由 `refitLoopBox` 把框长高；框外面下方的节点同时下移。
 * 4 **父已在移动名单里 → 子不动**。循环框是 parentId 容器，框整体下移时成员的
 *   相对坐标**不该再改一遍**（改两遍 = 绝对坐标走了 2×dy，成员会飞出框外）。
 *   这一条同时把第 3 条的两种情况表达出来了。
 *
 * ## 一条我第一版写错的
 *
 * 节点展开**永远是往下长**（高度增长方向固定），与流水方向无关 ——
 * 所以带子判据只看 Y，**没有「横排竖排两套算法」**。
 * 第一版按流水方向分了两套，左→右时把同一层并排的邻居也判成「被压住」，
 * 展开一次整张图跟着跑，是错的（`tests/expand-shift.mjs` 第 ② 组盯着它）。
 */
import { BOX_MIN_W, BOX_MIN_H, BOX_PAD_SIDE, BOX_PAD_TOP, BOX_PAD_BOTTOM } from './container-ops.ts'

/** 让位运算需要的**最小节点形状**（测试不必伪造整个节点）。 */
export interface ShiftNodeLike {
  /** 节点 id。 */
  id: string
  /** 画布坐标（循环子节点这里是**相对容器**的坐标）。 */
  position: { x: number, y: number }
  /** 父容器 id（只有循环还有这个；分组框是名单模型、不在这个字段上）。 */
  parentId?: string
  /** 尺寸（循环框写在 style 上；普通节点不写，靠实测表）。
   *
   * 宽高可以是字符串（`300px`）。若这里声明成 number，
   * `V1Node[]` 就**传不进来了**（会报类型错），而画布侧传的就是 V1Node。
   * 读的时候统一用 `Number()` + `isFinite` 兜。 */
  style?: { width?: unknown, height?: unknown }
}

/**
 * 让位之后要**多留出来的那条缝**（像素）。
 *
 * 为什么要有它（用户 2026-10-16 原话）：
 * 「偏移的位置稍微加大一点，**现在偏移过后贴在一起了**，加一点间隔。」
 *
 * 算式算出来的是「刚好让开」—— 被推的节点顶边正好落在展开节点的底边上，
 * 像素级相接。看着像两块粘在一起，读者会怀疑「这是不是重叠了」。
 *
 * 取 40 的理由：与循环框里成员之间的间隔（`container-ops.ts` 的 `BOX_GAP_Y`）
 * 是同一档。两个地方都在表达「这是两块分开的东西」，间隔一致才读得出来。
 */
export const SHIFT_GAP = 40

/** 一次让位要移动谁、移多少。 */
export interface ShiftPlan {
  /** 要移动的节点 id。 */
  ids: Set<string>
  /** 一律下移这么多像素（画布坐标下的固定值）。 */
  dy: number
}

/**
 * 算一个节点的**绝对坐标**（沿 parentId 链把父的原点都加回去）。
 *
 * 为什么不直接用 container-ops 的 absolutePosition：它要完整的 V1Node，
 * 而这一层只要四个字段、好让测试不用伪造整个节点。算式与它逐行一致
 * （沿父链累加 + 防环），改这里时两边要一起改。
 *
 * ⚠️ **导出是有原因的**：画布侧要拿它把「展开前的位置」换算成绝对值。
 * 循环里的节点存的是**相对坐标**，直接用会让整个让位算错
 * （用户 2026-10-16 报的「循环框里面的节点展开不会回避」就是这个）——
 * 而那种错**不报错、界面看着就是「没反应」**，所以算式必须能被单测直接钉住。
 *
 * @param byId - id → 节点。
 * @param n - 目标节点。
 * @param guard - 防环步数上限。
 * @returns 画布绝对坐标。
 */
export function absoluteOf(
  byId: ReadonlyMap<string, ShiftNodeLike>,
  n: ShiftNodeLike,
  guard: number,
): { x: number, y: number } {
  let x = n.position.x
  let y = n.position.y
  let cur = n
  let left = guard
  while (cur.parentId !== undefined && left > 0) {
    const p = byId.get(cur.parentId)
    if (p === undefined) break
    x += p.position.x
    y += p.position.y
    cur = p
    left -= 1
  }
  return { x, y }
}

/** 单个节点的尺寸兜底（循环框写在自己的 style 上，普通节点量不到就用它）。 */
export interface FallbackSize { w: number, h: number }

/**
 * 取某个节点在**画布绝对坐标**下的左上角。
 *
 * 存在的理由：循环里的节点（`parentId` 指向循环框）坐标是**相对框**的。
 * 直接把它当绝对坐标用，会得到一个「比实际小一个框高」的数 ——
 * 于是「谁被压住」的判据全部错位、看起来就像功能没做。
 *
 * @param nodes - 全部节点。
 * @param id - 目标节点 id。
 * @returns 绝对坐标；节点不存在时返回 null。
 */
export function absolutePosOf(
  nodes: readonly ShiftNodeLike[],
  id: string,
): { x: number, y: number } | null {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const n = byId.get(id)
  if (n === undefined) return null
  return absoluteOf(byId, n, nodes.length + 1)
}
/**
 * 从实测尺寸表里取节点的**标称高度**（高度方向的众数）。
 *
 * 它回答的是「**一个节点没长出任何东西时有多高**」—— 让位算式里那条
 * 「被压住的带子」从哪开始，就靠它。
 *
 * 为什么取众数：画布上**大多数节点是收起的、也没在跑的**，它们高度相同
 * （判据不需要精确到个位 —— 误差由 1px 容差吸收）；循环框、展开态、挂着输出
 * 面板的都是少数派。取平均会被那少数派带偏，取众数不会。
 *
 * ⚠️ **必须先把「输出面板」减掉**（2026-10-16 加）：跑起来之后一堆节点同时挂着
 * 输出面板，不减的话众数会跟着变成「卡片 + 面板」—— 那样每个挂着面板的节点算出来
 * 的「长高了多少」都是 0，让位**整个失效**，而且**不报错、看着就是「没反应」**。
 *
 * @param sizes - 实测尺寸表（量不到就是空表）。
 * @param panels - 各节点的输出面板高度（没挂面板的节点不在表里）。
 * @returns 标称高；表空时退回 NODE_H。
 */
export function nominalHeight(
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  panels?: ReadonlyMap<string, number>,
): number {
  const counts = new Map<number, number>()
  for (const [id, s] of sizes) {
    const k = Math.round((s.h - (panels?.get(id) ?? 0)) * 2) / 2
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  let best = 0
  let bestN = 0
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n }
  return best > 0 ? best : 168
}

/**
 * 算出「展开某个节点时，谁要下移」。
 *
 * ## ⚠️ 它是**一道几何题**，不是全部机制
 *
 * 2026-10-16 把输出面板也接上让位之后，画布不再「谁展开就让谁算一次」，
 * 而是**每次重算整张图**（见 {@link settleShift}）：因为一堆节点可能同时长高，
 * 而且长高的原因不止一个（参数区展开 + 输出面板）。
 * 这个函数仍是那道题本身：**给定一个矩形变高了，正下方谁要让**。
 *
 * ## 参数语义（这一层错过两次，都在界面上表现为「功能没反应」）
 *
 * 报到发生在**节点已经长高之后**，所以量到的当前高度是**撑开后**的：
 *   - `rect.h` = **没长东西时**的高度（标称高，见 {@link nominalHeight}）；
 *   - `extra`  = **长出来多少** = 当前实测高 − 标称高。
 * 于是那条带子 = `[标称底边, 当前底边)`，正好是这次**新盖住**的那截空间。
 *
 * @param nodes - 全部节点（循环子节点用**相对坐标**，函数内部自己换算绝对）。
 * @param edges - 全部连线（只要 source / target）。
 * @param opts - 长高的节点 id、它**长高前**的绝对矩形、会多长多少、实测尺寸表。
 * @returns 要移谁、移多少；没人被压住时 ids 为空、dy 为 0。
 */
export function planExpandShift(
  nodes: readonly ShiftNodeLike[],
  edges: readonly { source: string, target: string }[],
  opts: {
    /** 正在长高（或正在缩回）的那个节点。 */
    id: string
    /** 它**长高前**的矩形（坐标＋尺寸，宽高都是画布坐标）。 */
    rect: { x: number, y: number, w: number, h: number }
    /** 会往下多出多少像素（画布坐标下的固定值）。 */
    extra: number
    /** 实测尺寸表（循环框也在里面 —— 它的 style 尺寸就是它的实测尺寸）。 */
    sizes?: ReadonlyMap<string, { w: number, h: number }>
  },
): ShiftPlan {
  const { id, rect, extra, sizes } = opts
  const empty: ShiftPlan = { ids: new Set<string>(), dy: 0 }
  if (extra <= 0) return empty

  const byId = new Map(nodes.map(n => [n.id, n]))
  const guard = nodes.length + 1

  /** 某个节点的绝对矩形。 */
  const boxOf = (n: ShiftNodeLike): { x: number, y: number, w: number, h: number } => {
    const p = absoluteOf(byId, n, guard)
    const m = sizes?.get(n.id)
    const nw = Number(n.style?.width)
    const nh = Number(n.style?.height)
    return {
      x: p.x,
      y: p.y,
      w: m?.w ?? (Number.isFinite(nw) ? nw : rect.w),
      h: m?.h ?? (Number.isFinite(nh) ? nh : rect.h),
    }
  }

  const bottom = rect.y + rect.h
  /** 水平方向与展开节点相交吗（宽高的估算误差用 1px 容差吸收）。 */
  const hHit = (b: { x: number, w: number }): boolean =>
    b.x < rect.x + rect.w - 1 && b.x + b.w > rect.x + 1

  /* ① 被压住的第一批：顶边落在长高的那条带子里。
   * 一个都没有（正下方空着）就什么都不用做。 */
  let minTop = Number.POSITIVE_INFINITY
  for (const n of nodes) {
    if (n.id === id) continue
    const b = boxOf(n)
    if (!hHit(b)) continue
    if (b.y < bottom - 1) continue
    if (b.y >= bottom + extra - 1) continue
    if (b.y < minTop) minTop = b.y
  }
  if (!Number.isFinite(minTop)) return empty
  /* 让开量：把**最靠上**那个被压住的节点推到带子下沿之外，再往后多留一条缝。
   * 「刚好推到下沿」= 两块像素级相接 —— 那就是用户说的「偏移过后贴在一起了」。 */
  const dy = bottom + extra - minTop + SHIFT_GAP
  if (dy <= 0) return empty

  /* ② 整列平移：这批人下面**同一列**的全部节点。 */
  const ids = new Set<string>()
  for (const n of nodes) {
    if (n.id === id) continue
    const b = boxOf(n)
    if (!hHit(b)) continue
    if (b.y < bottom - 1) continue
    ids.add(n.id)
  }

  /* ③ 连带各自的下游（用户 2026-10-16 选的「整条下游一起让」）。
   * 下游多半在右边、本来不重叠；带上它们是为了被推的列与它后面接的东西相对关系不乱。
   * 带环保护：循环图里的回边会让朴素的遍历转不停。 */
  const downs = new Map<string, string[]>()
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    const list = downs.get(e.source)
    if (list === undefined) downs.set(e.source, [e.target])
    else list.push(e.target)
  }
  const queue = [...ids]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const nxt of downs.get(cur) ?? []) {
      if (ids.has(nxt)) continue
      ids.add(nxt)
      queue.push(nxt)
    }
  }

  /* ④ 父已在下移名单里 → 子不动（见文件头第 4 条）。 */
  for (const nid of [...ids]) {
    const n = byId.get(nid)
    if (n === undefined || n.parentId === undefined) continue
    let cur = byId.get(n.parentId)
    let left = guard
    while (cur !== undefined && left > 0) {
      if (ids.has(cur.id)) { ids.delete(nid); break }
      cur = cur.parentId === undefined ? undefined : byId.get(cur.parentId)
      left -= 1
    }
  }

  return { ids, dy }
}
/**
 * 把让位计划落到节点数组上（**只改 position**，不动任何别的字段）。
 *
 * 两条必须保住的性质：
 *   1 **相对坐标的差是平移不变量** —— 循环子节点记的是相对坐标，
 *     平移父框与子节点同一个 dy，差值不变（不必额外修坐标）。
 *   2 **无变化时返回原数组引用** —— 调用方据此跳过 setState；
 *     不返回原引用会无限重渲染（本项目踩过）。
 *
 * @param nodes - 全部节点。
 * @param plan - 让位计划。
 * @param dyOverride - 覆盖平移量（收起时传**负数**，即按原量回移）。
 * @returns 新数组；没人要动时返回**原数组引用**。
 */
export function applyShift<T extends { id: string, position: { x: number, y: number } }>(
  nodes: readonly T[],
  plan: ShiftPlan,
  dyOverride?: number,
): T[] {
  const dy = dyOverride ?? plan.dy
  if (dy === 0 || plan.ids.size === 0) return nodes as T[]
  let changed = false
  const next = nodes.map(n => {
    if (!plan.ids.has(n.id)) return n
    changed = true
    return { ...n, position: { x: n.position.x, y: n.position.y + dy } }
  })
  return changed ? next : (nodes as T[])
}

/**
 * 重新适配循环框：按内容包围盒重算**位置与尺寸**。
 *
 * ## 为什么不直接用 fitLoopBox
 *
 * 它多一条规则「**位置尽量不动**」—— 只要内容还装得下当前框就保持原位置
 * （那是为了「移出一个节点后框不跳走」，很对）。
 * 但让位这一场景要的是相反的行为：内容变高了，框得**跟着长**，
 * 而「装不下才平移」在「内容只变高」时不一定触发，长出来的那截会露在框外。
 *
 * 所以这里就是最直白的一条：**内容包围盒 + 内边距**，左上角对齐内容，
 * 且不小于最小尺寸（BOX_MIN_*，与 fitLoopBox 共用常量，两处不会漂）。
 * 空框不处理（让位场景不涉及空框，不自造规则）。
 *
 * ⚠️ 框的原点一旦改变，子节点的**相对坐标必须跟着改**（它们记的是相对坐标），
 * 不然后续所有几何都会偏 —— 这是 parentId 模型的硬要求。
 *
 * @param nodes - 全部节点（含循环框与它的子节点）。
 * @param loopId - 循环框 id。
 * @param sizes - 实测尺寸表（量不到用兜底）。
 * @param fallback - 兜底节点尺寸。
 * @returns 新数组；无变化时返回**原数组引用**。
 */
export function refitLoopBox<T extends ShiftNodeLike>(
  nodes: readonly T[],
  loopId: string,
  sizes: ReadonlyMap<string, { w: number, h: number }>,
  fallback: { w: number, h: number },
): T[] {
  /* 只认 id —— 调用方保证传进来的是循环框（它按 `def.id === LOOP_DEF_ID` 挑）。
   * 这里不重复判 defId：V1Node 的定义挂在 `data.def.id` 上，判它就得耦合节点结构，
   * 而这一层的输入只有 id / 坐标 / 尺寸。 */
  const loop = nodes.find(n => n.id === loopId)
  if (loop === undefined) return nodes as unknown as T[]
  const kids = nodes.filter(n => n.parentId === loopId)
  if (kids.length === 0) return nodes as unknown as T[]

  const abs = kids.map(k => ({
    id: k.id,
    x: loop.position.x + k.position.x,
    y: loop.position.y + k.position.y,
    w: sizes.get(k.id)?.w ?? fallback.w,
    h: sizes.get(k.id)?.h ?? fallback.h,
  }))
  const minX = Math.min(...abs.map(o => o.x))
  const minY = Math.min(...abs.map(o => o.y))
  const maxX = Math.max(...abs.map(o => o.x + o.w))
  const maxY = Math.max(...abs.map(o => o.y + o.h))
  const x = minX - BOX_PAD_SIDE
  const y = minY - BOX_PAD_TOP
  const width = Math.max(maxX - minX + BOX_PAD_SIDE * 2, BOX_MIN_W)
  const height = Math.max(maxY - minY + BOX_PAD_TOP + BOX_PAD_BOTTOM, BOX_MIN_H)

  const cur = loop.style
  if (loop.position.x === x && loop.position.y === y
    && cur?.width === width && cur?.height === height) {
    return nodes as unknown as T[]
  }

  const byId = new Map(abs.map(o => [o.id, o]))
  return nodes.map(n => {
    if (n.id === loopId) {
      return { ...n, position: { x, y }, style: { ...n.style, width, height } } as unknown as T
    }
    if (n.parentId !== loopId) return n
    const o = byId.get(n.id)
    if (o === undefined) return n
    return { ...n, position: { x: o.x - x, y: o.y - y } }
  })
}
/** 一件「让位请求」：哪个节点长高了多少。 */
export interface ShiftTask {
  /** 长高的那个节点。 */
  id: string
  /** 它**没长东西时**的高度（画布坐标）。 */
  h: number
  /** 长出来多少（画布坐标）。 */
  extra: number
}

/**
 * 一次让位的**整图重算**（本功能的最终形态，2026-10-16）。
 *
 * ## 为什么从「记账本」改成「基线 + 全图重算」
 *
 * 原来是谁展开就让谁算一次、把「推了谁、推了多少」记在本子上，收起时按本子退回。
 * 那套只够对付**一件事**。用户接着要求「输出面板弹出时也让位」，于是同一时刻
 * 会有**一堆节点**各自长高（参数区 + 输出面板，面板还会随悬停长、随终态缩）——
 * 一件事的账本管不了这么多互相叠在一起的涨落。
 *
 * 现在只有一个不变量：
 *
 *   `当前位置 = 基线位置 + 让位量（shift）`
 *
 * 基线 = 「什么都没长高时这张图该是什么样」。每次要重算时：
 *
 *   ① `基线 = 当前位置 − 上次的让位量`（`shift` 由调用方记着）；
 *   ② 在基线上按每个长高请求把正下方推开，反复算到不动；
 *   ③ 新让位量 = 算出来的位置 − 基线位置；把**差值**加到真实节点上。
 *
 * 好处：
 *   - 收起 / 悬停结束 / 面板消失 —— 都只是少了一个请求，算出来自然回到基线；
 *   - **用户自己拖过的节点不会被打回原处**：拖动只改了位置、没改让位量，
 *     于是它自动被算进基线（见下面「为什么要用差值」）；
 *   - 幂等：同样的输入算两遍结果一样，随时重跑都安全。
 *
 * ## 为什么要用「差值」而不是直接写新坐标
 *
 * 真实节点 = 基线 + 让位量。用户可以随时拖节点、容器会自己贴边，
 * 这些都只改「位置」。用 `新让位量 − 旧让位量` 去加，等于把
 * 「位置里那些不是让位引起的部分」原样留在基线上 —— 不会被打回。
 *
 * @param nodes - 当前节点（循环子节点是**相对坐标**）。
 * @param edges - 全部连线。
 * @param tasks - 所有长高请求（extra≤0 的会被忽略）。
 * @param shift - 上次算出来的让位量（节点 id → 加在**自己 y** 上的量）。
 * @param sizes - 实测尺寸表。
 * @returns 新节点数组（无变化时是**原数组引用**）与新的让位量。
 */
export function settleShift<T extends ShiftNodeLike>(
  nodes: readonly T[],
  edges: readonly { source: string, target: string }[],
  tasks: readonly ShiftTask[],
  shift: ReadonlyMap<string, number>,
  sizes?: ReadonlyMap<string, { w: number, h: number }>,
): { nodes: T[], shift: Map<string, number> } {
  const old = (id: string): number => shift.get(id) ?? 0
  const live = tasks.filter(t => t.extra > 1 && t.h > 0)
  if (live.length === 0 && shift.size === 0) {
    return { nodes: nodes as T[], shift: new Map<string, number>() }
  }

  /* ① 基线：把上次施加的让位量从「自己的 y」里减掉（父的位移不必管 —— 见文件头）。 */
  const baseById = new Map<string, number>()
  let working: T[] = nodes.map(n => {
    baseById.set(n.id, n.position.y - old(n.id))
    const s = old(n.id)
    return s === 0 ? n : { ...n, position: { ...n.position, y: n.position.y - s } } as T
  })

  /* ② 逐请求推开，反复算到不动（上限 8 轮兜底）。 */
  const guard = nodes.length + 1
  const baseAbsY = (id: string): number => {
    const n = working.find(x => x.id === id)
    if (n === undefined) return 0
    return absoluteOf(new Map(working.map(x => [x.id, x])), n, guard).y
  }
  const ordered = [...live].sort((a, b) => baseAbsY(a.id) - baseAbsY(b.id))
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (const t of ordered) {
      const at = absolutePosOf(working, t.id)
      if (at === null) continue
      const w = sizes?.get(t.id)?.w ?? 300
      const plan = planExpandShift(working, edges, {
        id: t.id,
        rect: { x: at.x, y: at.y, w, h: t.h },
        extra: t.extra,
        sizes,
      })
      if (plan.dy <= 0 || plan.ids.size === 0) continue
      const next = applyShift(working, plan)
      if (next !== working) { working = next as T[]; moved = true }
    }
    if (!moved) break
  }

  /* ③ 新让位量（相对基线），并按**差值**落到真实节点上。 */
  const next = new Map<string, number>()
  for (const n of working) {
    const b = baseById.get(n.id)
    if (b === undefined) continue
    const d = n.position.y - b
    if (d !== 0) next.set(n.id, d)
  }
  let changed = false
  const out = nodes.map(n => {
    const d = (next.get(n.id) ?? 0) - old(n.id)
    if (d === 0) return n
    changed = true
    return { ...n, position: { ...n.position, y: n.position.y + d } } as T
  })
  return { nodes: changed ? out : (nodes as T[]), shift: next }
}