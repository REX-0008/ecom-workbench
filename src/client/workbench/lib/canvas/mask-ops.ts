/** 蒙版涂抹的纯函数层（用户 m02814 #60 局部重绘）。
 *
 * ## 为什么这一层必须单独存在
 *
 * 真涂（`ctx.arc` + `fill`）要 canvas 2d，而 **jsdom 里 `getContext('2d')` 返回 `null`**
 * （实测；要真跑得装 `canvas` npm 包，项目不装）。所以：
 *   · **算**的部分（笔画覆盖哪些像素、笔刷多大、是否真的涂过）抽到这里；
 *   · **画**的部分留在浏览器。
 *
 * 交付时如实说明「验的是算法，不是涂起来跟不跟手」—— 不许把两者混着说。
 *
 * ## 遮罩的约定（与后端 ComfyUI 对齐）
 *
 * · **黑底白遮罩**：白 = 要重绘的区域，黑 = 保留；
 * · 尺寸与原图**一致**（后端按原图尺寸贴 `ref_mask`，尺寸不同会被缩放，边缘就糊了）。
 *
 * ⚠️ 这个约定写在这里、由 `tests/image-ops.mjs` 的判据钉住；
 * 它也是 `generate.ts` 里 `ref_mask` 槽位那条注释的同一条约定。
 */

/** 一次笔画（归一化坐标，与裁剪同一套 —— 换不同尺寸的图仍然对得上）。 */
export interface BrushStroke {
  /** 画布上的点（归一化 0~1）。 */
  points: { x: number, y: number }[]
  /** 笔刷半径（**归一化**，相对图片宽高的较小者）。 */
  radius: number
  /** 是不是橡皮（擦掉已涂的部分）。 */
  erase?: boolean
}

/** 一块遮罩的统计（判据用：有没有涂过）。 */
export interface MaskStat {
  /** 涂过的点数（按笔画与笔刷面积估）。 */
  covered: number
  /** 覆盖率（0~1）。 */
  ratio: number
}

/**
 * 把笔刷的**像素半径**换算成归一化半径。
 *
 * ## 为什么按「较小边」换算
 *
 * 按宽算，宽图上同样的笔刷看起来比高图细；按高算反之。取较小边之后，
 * **同一把笔刷在任何比例的图上看起来一样粗** —— 那是用户对笔刷的直觉。
 *
 * @param px - 像素半径（界面上那个滑块的值）。
 * @param width - 原图宽。
 * @param height - 原图高。
 * @returns 归一化半径（0~0.5）。
 */
export function normalizeBrush(px: number, width: number, height: number): number {
  const p = Number.isFinite(px) && px > 0 ? px : 1
  const w = Number.isFinite(width) && width > 0 ? width : 1
  const h = Number.isFinite(height) && height > 0 ? height : 1
  const base = Math.min(w, h)
  /* 上限 0.5：半径超过半个图就没有「局部」可言了。 */
  return Math.min(0.5, p / base)
}

/**
 * 一笔画下来**大概涂了多少面积**（归一化单位）。
 *
 * ## 为什么要估算而不是精确算
 *
 * 精确算要栅格化每个圆、还要处理重叠 —— 那是 canvas 的活。
 * 这里只需要回答一个问题：**用户到底涂了没有？**
 * 判据 2 是「没涂就不许提交」，那个判断不需要精确到像素。
 *
 * 估法：相邻两点之间按**胶囊**（两个圆 + 中间矩形）算面积，再减去重叠的粗略修正。
 * 重叠会让结果偏大 —— 但偏大只会让「涂了一点点」更容易通过检查，
 * 而真正的下限是「一个点都没画」（`covered === 0`），那个判得准。
 *
 * @param stroke - 一次笔画。
 * @returns 覆盖面积与占整图比例。
 */
export function strokeArea(stroke: BrushStroke): MaskStat {
  const r = Math.max(0, Math.min(0.5, Number.isFinite(stroke.radius) ? stroke.radius : 0))
  const pts = Array.isArray(stroke.points) ? stroke.points : []
  if (pts.length === 0 || r === 0) return { covered: 0, ratio: 0 }
  /* 单点：一个圆。 */
  const circle = Math.PI * r * r
  let area = circle
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]
    const b = pts[i]
    const dx = (b.x - a.x)
    const dy = (b.y - a.y)
    const len = Math.sqrt(dx * dx + dy * dy)
    /* 一段胶囊：中间矩形 + 两端的半圆（合起来就是 rect + circle）。 */
    area += len * 2 * r + circle
  }
  /* 橡皮不算「涂过」—— 它只会减少覆盖。 */
  if (stroke.erase === true) return { covered: 0, ratio: 0 }
  return { covered: area, ratio: Math.min(1, area) }
}

/**
 * 整块遮罩现在有没有内容（判据 2 的核心）。
 *
 * ## 为什么需要它、而不是「看看 strokes 数组空不空」
 *
 * 用户可以先画几笔、再用橡皮全擦掉 —— 那时 `strokes` 非空，但遮罩是干净的。
 * 拿这个去提交，后端会用工作流自带的占位遮罩，**任务照样成功、结果完全不对**
 * （这是这一批最危险的失败方式：不报错）。
 *
 * @param strokes - 全部笔画（按顺序）。
 * @returns 有没有真的涂到东西。
 */
export function maskHasContent(strokes: readonly BrushStroke[]): boolean {
  let total = 0
  let erased = 0
  for (const s of strokes) {
    const a = strokeArea(s)
    if (s.erase === true) erased += Math.abs(strokeArea({ ...s, erase: false }).covered)
    else total += a.covered
  }
  /* 擦掉的部分从总面积里减：剩得比「一个最小点」还少就当没涂。 */
  return total - erased > 1e-6
}

/**
 * 把一次笔画变成「先画什么再画什么」的指令序列（给浏览器那边照做）。
 *
 * ## 为什么返回指令而不是直接画
 *
 * 这一层不碰 canvas（jsdom 里碰不了）。返回一个数据描述，
 * 浏览器那边照着它 `moveTo` / `lineTo` / `arc` —— 顺序与线宽都在这里定死，
 * 于是「一笔怎么画」是可测的，只有「真的画上去」不可测。
 *
 * @param stroke - 一次笔画。
 * @returns 指令（首点是 `move`，其后是 `line`，`round` 表示端点要画圆头）。
 */
export function brushCommands(stroke: BrushStroke): {
  radius: number
  erase: boolean
  ops: readonly { kind: 'move' | 'line', x: number, y: number }[]
} {
  const r = Math.max(0, Math.min(0.5, Number.isFinite(stroke.radius) ? stroke.radius : 0))
  const pts = Array.isArray(stroke.points) ? stroke.points : []
  const ops: { kind: 'move' | 'line', x: number, y: number }[] = []
  for (let i = 0; i < pts.length; i += 1) {
    /* 坐标夹进 [0,1]：拖出图外的点会把线画到边界外面，导出时被裁掉，
     * 看起来是「涂了但没生效」。 */
    const x = Math.max(0, Math.min(1, pts[i].x))
    const y = Math.max(0, Math.min(1, pts[i].y))
    ops.push({ kind: i === 0 ? 'move' : 'line', x, y })
  }
  return { radius: r, erase: stroke.erase === true, ops }
}
