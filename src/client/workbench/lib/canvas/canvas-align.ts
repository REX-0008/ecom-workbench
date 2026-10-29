/**
 * 内容画布的对齐参考线与吸附（票 01，用户 C2）。
 *
 * ## 为什么要做（用户原话的意思）
 *
 * 建多个节点时全靠眼估 —— 两个节点「看起来齐了」，实际上差 4 像素，
 * 导出或截图之后一眼就看得出来歪。
 *
 * ## 两家参考项目怎么做的（先查清再动手，项目 AGENTS.md 的「参照」节要求）
 *
 * | | Dify | n8n |
 * |---|---|---|
 * | 对齐参考线 | 有 | **没有** |
 * | 吸附到别的节点 | 有 | **没有** |
 * | 网格吸附 | 无 | 有（且只用于布局计算，不在拖动路径） |
 * | 阈值 | 5 画布像素 | — |
 *
 * 所以这一条**不是「两家都有」**，也就不是「两家都没有的不做」拦得住的那类。
 *
 * ### Dify 的具体做法
 *
 * `web/app/components/workflow/hooks/use-helpline.ts`、`help-line/index.tsx`、
 * `hooks/use-nodes-interactions.ts:250-325`：
 *
 * - `const ALIGN_THRESHOLD = 5`（`use-helpline.ts:25`）
 * - **只比左上角**（`node.position.x` / `.y`），不比三条竖向锚点、三条横向锚点
 * - 在 `handleNodeDrag` 里每帧算，命中就把 `currentNode.position` 改成目标节点坐标
 * - 两条线：`HelpLineHorizontal`（`h-px`）/ `HelpLineVertical`（`w-px`），
 *   位置 `top * zoom + y`（视口变换之后按屏幕坐标画）
 * - 线的长度从最靠边的那个对齐节点拉到当前节点，不是整屏一条
 *
 * ### n8n 的具体做法
 *
 * 没有对齐线。`grep -rniE "align(ment)?(line|guide|helper)|helperLine|guideline"
 * packages/frontend/editor-ui/src` 零命中。只有网格吸附
 * （`app/utils/nodeViewUtils.ts:36` 的 `GRID_SIZE = 16` 与 `snapToGrid`），
 * 而那个函数只被 `useCanvasLayout.ts:1195-1206` 与 `agentNode.ts:28` 调，
 * **不在拖动路径上**。所以 n8n 的拖动是「随便放」。
 *
 * ## 我们与 Dify 的三处差异（及理由）
 *
 * ### ① 比六条边（左中右 / 上中下），不只比左上角
 *
 * Dify 的节点是**固定尺寸卡片**，只比左上角不会出错。我们的节点尺寸按类型差很多
 * （文本 260×120、图片 320×320、组 760×480），只比左上角会出现
 * 「两个节点看着居中对齐了，判定却说不齐」。尺寸不一时六条边是必需的。
 *
 * ### ② 拖动中只画线，松手才吸
 *
 * Dify 是拖动中直接改坐标（吸住）。副作用是**拖不过去** ——
 * 阈值内被粘在那条线上，想微调 3px 挪不动，要先把鼠标拉远再回来。
 * 我们改成「拖动中看得见线、松手才落定」，微调不被挡。
 *
 * ### ③ 不做 Dify 那两个例外
 *
 * - `isInIteration` / `isInLoop` 不参与对齐 —— 我们没有「循环容器里的节点不许对齐」这回事
 *   （编组是纯视觉、循环靠 `parentId`）。
 * - `ENTRY_NODE_WRAPPER_OFFSET = { x: 0, y: 21 }` —— 我们没有「入口节点外面多包一层」。
 *
 * 照抄这两个例外只会往我们这里塞不存在的规则。
 *
 * ## 这个文件是纯函数
 *
 * 不碰 React、不碰 DOM、不碰 React Flow。组件只负责把坐标喂进来、把结果画出去。
 * 这样阈值、六条边、参考线长度全部能在没有浏览器的环境里钉住。
 */

/**
 * 吸附阈值（画布像素）。
 *
 * Dify 是 5。取 6 的理由：我们六条边一起比，命中率天然比只比左上角高，
 * 阈值再放大容易「乱吸」（稍微歪一点就被拽走）。6 是 5 上浮一档，仍属紧的那一档。
 *
 * ⚠️ 判据 4 的自证就是把这一条改成 0 —— 见 `computeAlign` 里那个 `<= 0` 的短路，
 * 那一条短路保证「0 = 关掉」而不是「0 = 只有像素级完全相等才算」。
 */
export const ALIGN_THRESHOLD = 6

/** 一个节点在画布坐标里的方框（这个文件只认这四个数）。 */
export interface AlignBox {
  /** 节点 id（判断「是不是它自己」用）。 */
  id: string
  /** 左上角横坐标。 */
  x: number
  /** 左上角纵坐标。 */
  y: number
  /** 宽。 */
  width: number
  /** 高。 */
  height: number
}

/**
 * 一条参考线。
 *
 * 坐标全是**画布坐标**，不是屏幕坐标 —— 屏幕坐标要乘缩放再加平移，
 * 那是渲染层的事（Dify 在 `help-line/index.tsx` 里做 `top * zoom + y`）。
 * 放在这里会让这个文件必须知道视口，就没法纯函数单测了。
 */
export interface AlignGuide {
  /** `'x'` = 一条**竖线**（把横坐标对齐）；`'y'` = 一条**横线**。 */
  axis: 'x' | 'y'
  /** 线的位置：`axis === 'x'` 时是横坐标，`'y'` 时是纵坐标。 */
  at: number
  /** 线的起点（另一轴）。 */
  from: number
  /** 线的终点（另一轴）。 */
  to: number
}

/** 对齐结果。 */
export interface AlignResult {
  /** 要移动多少才能吸上（画布像素，没命中就是 0）。 */
  dx: number
  /** 同上，纵向。 */
  dy: number
  /** 竖线（横坐标对齐）。 */
  vertical: AlignGuide[]
  /** 横线（纵坐标对齐）。 */
  horizontal: AlignGuide[]
}

/** 没有对齐时的结果（也用它当初始值）。 */
export const NO_ALIGN: AlignResult = { dx: 0, dy: 0, vertical: [], horizontal: [] }

/** 一组方框在某个轴上的三个锚点（左/中/右 或 上/中/下）。 */
function anchorsOn(box: AlignBox, axis: 'x' | 'y'): [number, number, number] {
  if (axis === 'x') {
    const a = box.x
    return [a, a + box.width / 2, a + box.width]
  }
  const a = box.y
  return [a, a + box.height / 2, a + box.height]
}

/** 一组方框在某个轴上的范围（参考线要画到这儿）。 */
function spanOn(box: AlignBox, axis: 'x' | 'y'): { from: number, to: number } {
  return axis === 'x'
    ? { from: box.y, to: box.y + box.height }
    : { from: box.x, to: box.x + box.width }
}

/**
 * 在一条轴上找**最近的一条**可对齐线。
 *
 * 为什么只取最近的一条：命中两条时（比如左边与某节点左边齐、右边与另一节点右边齐），
 * 取错的代价是「吸到更远的那条」—— 用户看到的线离鼠标更远，会以为程序乱吸。
 * 取 diff 绝对值最小的那条，且在绝对值相同时取**先遍历到的**（顺序稳定、可复现）。
 *
 * @param moving - 正在拖的那个方框。
 * @param others - 可以对齐到的那批方框。
 * @param axis - 哪条轴。
 * @param threshold - 阈值；`<= 0` 表示关掉（返回 `null`）。
 * @returns 命中信息，或 `null`。
 */
function nearestOn(
  moving: AlignBox,
  others: readonly AlignBox[],
  axis: 'x' | 'y',
  threshold: number,
): { delta: number, at: number, guide: AlignGuide } | null {
  /* ⚠️ `<= 0` 短路必须留：阈值为 0 时不该「只有像素级完全相等才对齐」，
   * 那等于功能还在、只是几乎不触发 —— 自证时把它改 0，判据必须红，
   * 而不是变成「0 像素差仍能吸上」这种仍然活着的状态。 */
  if (!(threshold > 0)) return null
  const mine = anchorsOn(moving, axis)
  let best: { delta: number, at: number, guide: AlignGuide } | null = null
  for (const other of others) {
    if (other.id === moving.id) continue
    const theirs = anchorsOn(other, axis)
    for (const t of theirs) {
      for (const m of mine) {
        const delta = t - m
        if (Math.abs(delta) > threshold) continue
        if (best !== null && Math.abs(delta) >= Math.abs(best.delta)) continue
        /* 参考线要么横、要么竖，另一轴画多长由**两个方框的边缘**决定（照 Dify：
         * 从最靠边的对齐节点拉到我这个节点，不是整屏一条）。 */
        const a = spanOn(moving, axis)
        const b = spanOn(other, axis)
        best = {
          delta,
          at: t,
          guide: {
            axis,
            at: t,
            from: Math.min(a.from, b.from),
            to: Math.max(a.to, b.to),
          },
        }
      }
    }
  }
  return best
}

/**
 * 算对齐：拖动中的方框该不该吸、吸到哪、参考线画在哪。
 *
 * ## 谁该被排除
 *
 * `others` 里**不许包含移动中的那些节点**（多选拖动时会有好几个一起动）。
 * 这个函数不去猜哪些在动 —— 由调用方把它们剔掉，因为「哪些在动」只有拖动回调知道。
 * 函数里只额外跳过 `id` 与 `moving.id` 相同的那一个（防御性的一行）。
 *
 * ## 两个轴的吸附互相独立
 *
 * 横向命中不该影响纵向。Dify 也是分开算的（`showVerticalHelpLineNodes` /
 * `showHorizontalHelpLineNodes` 各一套）。
 *
 * @param moving - 正在拖的那个方框。
 * @param others - 其它所有节点的方框（不含移动中的那些）。
 * @param threshold - 阈值（默认 `ALIGN_THRESHOLD`）。
 * @returns 位移量与参考线；没命中时 `dx` / `dy` 为 0、数组为空。
 */
export function computeAlign(
  moving: AlignBox,
  others: readonly AlignBox[],
  threshold: number = ALIGN_THRESHOLD,
): AlignResult {
  if (!(threshold > 0)) return { ...NO_ALIGN }
  const x = nearestOn(moving, others, 'x', threshold)
  const y = nearestOn(moving, others, 'y', threshold)
  return {
    dx: x === null ? 0 : x.delta,
    dy: y === null ? 0 : y.delta,
    vertical: x === null ? [] : [x.guide],
    horizontal: y === null ? [] : [y.guide],
  }
}

/**
 * 松手时该落在哪。
 *
 * 只是 `position + dx/dy` 的一个包装 —— 单独一个函数是为了让「松手吸附」
 * 那条路有名字、能被直接钉住，而不是散在组件里写 `x + r.dx`。
 *
 * @param at - 松手时的位置。
 * @param result - `computeAlign` 的结果。
 * @returns 吸附后的位置。
 */
export function snappedPosition(at: { x: number, y: number }, result: AlignResult): { x: number, y: number } {
  return { x: at.x + result.dx, y: at.y + result.dy }
}
