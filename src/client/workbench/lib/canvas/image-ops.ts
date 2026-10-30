/** 图像操作的纯函数层：裁剪 / 拆图 / 抓帧的时间点（用户 m02814）。
 *
 * ## 为什么这一层必须存在、而且必须能单独跑
 *
 * 这三件事真正的「干活」部分都要 canvas：
 * 裁剪要 `drawImage`、拆图要切像素、抓帧要从 `<video>` 画到 `<canvas>`。
 * 而 **jsdom 里 `canvas.getContext('2d')` 返回 `null`**（实测；
 * 要真跑得装 canvas npm 包，项目不装）。
 *
 * 所以：**几何 / 时间这类算得出来的部分全部抽到这里**，
 * 像素那一步留在浏览器里由组件做。判据落在这一层，
 * 交付时如实说明「验的是算法，不是像素效果」—— 不许把两者混着说。
 *
 * ## 归一化坐标（0~1）而不是像素
 *
 * 裁剪矩形用 `{ x, y, width, height }` 且都是 **0~1 的比例**。
 * 理由（照参考项目 `canvas-node-crop-dialog.tsx`）：存进存档之后，
 * 用户换一张不同尺寸的图做同一套裁剪，比例仍然对；像素值一换图就全错。
 * 只有在真要动像素那一刻才乘原图宽高（`cropPixelRect`）。
 */

/** 归一化裁剪矩形（每个值都在 0~1，且 x+width ≤ 1）。 */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/** 整张图（不裁）。 */
export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 }

/** 把任意数值夹进 [lo, hi]。 */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 把用户拖出来的框归一化成一个**合法**的裁剪矩形。
 *
 * ## 它要挡住的四件事（每一条都真会把人卡住）
 *
 * 1. **拖反了**：从右下往左上拖，`width` / `height` 是负的 —— 负宽高会让
 *    `drawImage` 画出空图，而且不报错（最坑的一种）。
 * 2. **拖出画布边界**：拖到图外面，`x + width > 1`。取回来的像素会带透明边。
 * 3. **拖成一条线**：`width` 是 0（手一抖就点了一下）。0 宽高同样是空图。
 * 4. **NaN / Infinity**：输入框里敲了怪值，或者除零算出来的。
 *
 * 第 3 条给了**最小尺寸**而不是「直接丢掉」：用户拖了一点点就想裁一条细缝，
 * 丢掉的话没有任何反馈；夹到最小尺寸至少看得见结果，还能继续调。
 *
 * @param r - 用户拖出来的（可能非法）矩形。
 * @param min - 最小宽高（占整图的比例）。默认 0.01（1%）。
 * @returns 合法矩形，保证 `x,width,y,height ≥ 0`、`x+width ≤ 1`、`y+height ≤ 1`。
 */
export function normalizeCrop(r: CropRect, min: number = 0.01): CropRect {
  const m = clamp(min, 0, 0.5)
  /* 第 1 条：负宽高 → 先翻转成正常方向（拖反了不代表用户想裁 0 像素）。 */
  let x0 = r.width >= 0 ? r.x : r.x + r.width
  let x1 = r.width >= 0 ? r.x + r.width : r.x
  let y0 = r.height >= 0 ? r.y : r.y + r.height
  let y1 = r.height >= 0 ? r.y + r.height : r.y
  /* 第 4 条：NaN 会一路传下去，最后在 drawImage 那里静默画出空白。 */
  x0 = clamp(x0, 0, 1)
  y0 = clamp(y0, 0, 1)
  x1 = clamp(x1, 0, 1)
  y1 = clamp(y1, 0, 1)
  let width = x1 - x0
  let height = y1 - y0
  /* 第 3 条：太薄 → 补到最小值（补的方向是**往里长**，不越界）。 */
  if (width < m) {
    width = m
    if (x0 + width > 1) x0 = 1 - width
  }
  if (height < m) {
    height = m
    if (y0 + height > 1) y0 = 1 - height
  }
  return { x: Number(x0.toFixed(6)), y: Number(y0.toFixed(6)), width: Number(width.toFixed(6)), height: Number(height.toFixed(6)) }
}

/**
 * 归一化矩形 → 原图上的像素矩形（取整）。
 *
 * ⚠️ `width` / `height` **至少 1 像素**：比例很小时 `Math.round` 会算出 0，
 * 而 0 宽高的 `drawImage` 什么都不画、也不报错。
 *
 * @param r - 归一化矩形（先过 `normalizeCrop`）。
 * @param w - 原图宽（像素）。
 * @param h - 原图高（像素）。
 * @returns 像素矩形（可直接喂 `drawImage`）。
 */
export function cropPixelRect(r: CropRect, w: number, h: number): { x: number, y: number, width: number, height: number } {
  const iw = Math.max(1, Math.round(Number.isFinite(w) ? w : 1))
  const ih = Math.max(1, Math.round(Number.isFinite(h) ? h : 1))
  const px = Math.round(r.x * iw)
  const py = Math.round(r.y * ih)
  const pw = Math.max(1, Math.round(r.width * iw))
  const ph = Math.max(1, Math.round(r.height * ih))
  /* 再夹一次：四舍五入之后有可能超出原图 1 像素。 */
  return {
    x: clamp(px, 0, iw - 1),
    y: clamp(py, 0, ih - 1),
    width: clamp(pw, 1, iw - clamp(px, 0, iw - 1)),
    height: clamp(ph, 1, ih - clamp(py, 0, ih - 1)),
  }
}

/** 比例预设：`free` 表示不锁。 */
export type RatioPreset = 'free' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16'

/** 预设 → 数值比例（`free` 给 `null`）。 */
export function ratioValue(p: RatioPreset): number | null {
  if (p === '1:1') return 1
  if (p === '4:3') return 4 / 3
  if (p === '3:4') return 3 / 4
  if (p === '16:9') return 16 / 9
  if (p === '9:16') return 9 / 16
  return null
}

/**
 * Fit a crop to an aspect ratio, then normalize it to the image bounds.
 * The crop may shift at the bounds, and minimum-size normalization can alter
 * the requested ratio.
 *
 * @param r - Current normalized crop.
 * @param p - Aspect ratio preset; `free` only normalizes the crop.
 * @param image - Image dimensions in pixels; each omitted or nonpositive dimension defaults to 1.
 * @returns The normalized crop.
 */
export function applyRatioPreset(
  r: CropRect,
  p: RatioPreset,
  image?: { width: number, height: number },
): CropRect {
  const ratio = ratioValue(p)
  if (ratio === null) return normalizeCrop(r)
  /* 归一化坐标系里「宽度 1 对应 image.width 像素」，所以比例要换算：
   * 想让像素上左右 = ratio，则归一化宽高比应为 ratio * (h/w)（照参考 `:227`）。 */
  const iw = image !== undefined && image.width > 0 ? image.width : 1
  const ih = image !== undefined && image.height > 0 ? image.height : 1
  const norm = ratio * (ih / iw)
  const cx = r.x + r.width / 2
  const cy = r.y + r.height / 2
  let width = r.width
  let height = width / norm
  if (height > r.height) { height = r.height; width = height * norm }
  /* 再夹进 [0,1]（中心不变时可能顶出边界）。 */
  width = Math.min(width, 1)
  height = Math.min(height, 1)
  let x = cx - width / 2
  let y = cy - height / 2
  if (x < 0) x = 0
  if (y < 0) y = 0
  if (x + width > 1) x = 1 - width
  if (y + height > 1) y = 1 - height
  return normalizeCrop({ x, y, width, height })
}

/** 拆图切出来的一块（归一化坐标）。 */
export interface SplitPiece extends CropRect {
  /** 第几行（0 起）。 */
  row: number
  /** 第几列（0 起）。 */
  col: number
}

/**
 * 把一张图按「行 × 列」平均切成若干块。
 *
 * ## 为什么用「边界取整」而不是「每块宽高取整」
 *
 * 若每块宽 `Math.floor(w / cols)`，最后会剩下 1~2 像素没分到任何一块
 * （`w=100, cols=3` → 每块 33，最后丢 1 像素）。逐块丢一点，在 4×4 上就是明显的一圈黑边。
 * 这里改成**算出每块的左/右边界再取整**：`round(i*w/cols)` 到 `round((i+1)*w/cols)`，
 * 相邻块边界重合、像素一块不丢。
 *
 * @param width - Image width in pixels, rounded and clamped to at least 1; non-finite values use 1.
 * @param height - Image height in pixels, rounded and clamped to at least 1; non-finite values use 1.
 * @param rows - Row count, rounded and clamped to 1–16; non-finite values use 1.
 * @param cols - Column count, rounded and clamped to 1–16; non-finite values use 1.
 * @returns Pieces in row-major order with normalized coordinates. Pieces can
 *   have zero width or height when there are more columns or rows than pixels.
 */
export function splitRects(width: number, height: number, rows: number, cols: number): SplitPiece[] {
  const w = Math.max(1, Math.round(Number.isFinite(width) ? width : 1))
  const h = Math.max(1, Math.round(Number.isFinite(height) ? height : 1))
  /* 上限 16：再多的话一张图会变成几十个节点，画布会卡死（那也不是用户的意图）。 */
  const rs = clamp(Math.round(Number.isFinite(rows) ? rows : 1), 1, 16)
  const cs = clamp(Math.round(Number.isFinite(cols) ? cols : 1), 1, 16)
  const out: SplitPiece[] = []
  for (let r = 0; r < rs; r += 1) {
    const top = Math.round((r * h) / rs)
    const bottom = Math.round(((r + 1) * h) / rs)
    for (let c = 0; c < cs; c += 1) {
      const left = Math.round((c * w) / cs)
      const right = Math.round(((c + 1) * w) / cs)
      out.push({
        row: r,
        col: c,
        x: left / w,
        y: top / h,
        width: (right - left) / w,
        height: (bottom - top) / h,
      })
    }
  }
  return out
}

/** 抓哪一帧。 */
export type FrameWhich = 'first' | 'last' | 'current'

/**
 * 算出该把 `<video>.currentTime` 设到哪个秒。
 *
 * ## 三条边界（每一条都真会让抓帧失败）
 *
 * 1. **`duration` 是 `NaN`**：视频还没解析出元数据时读到的就是 `NaN`
 *    （`readyState < 1`）。把它当 0 处理，而不是原样传下去 ——
 *    `currentTime = NaN` 会让浏览器抛 `InvalidStateError`。
 * 2. **尾帧不能等于 `duration`**：设成正好 `duration` 时有些浏览器
 *    会认为「到头了」而不触发 `seeked`，抓出来的永远是黑帧。
 *    所以取 `duration - 一帧`。帧长按 30fps 估（`1/30`）；要求 ≥ 24fps 的视频
 *    都够用，而 30fps 是最常见的。
 * 3. **结果不许小于 0**：`duration` 极小时 `duration - 1/30` 会变负。
 *    负的 `currentTime` 会被浏览器夹到 0，但**夹之前**的中间值会让人算错。
 *
 * @param duration - 视频时长（秒）。
 * @param which - 抓哪一帧。
 * @param current - 「当前帧」用的秒数（`which` 不是 `current` 时忽略）。
 * @returns 秒数，保证 `0 ≤ t < duration`（`duration` 非法时给 0）。
 */
export function frameTimeOf(duration: number, which: FrameWhich, current: number = 0): number {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0
  if (d === 0) return 0
  if (which === 'first') return 0
  if (which === 'last') {
    const t = d - 1 / 30
    return t > 0 ? Number(t.toFixed(3)) : 0
  }
  /* current：夹进 [0, d - 一帧]，理由同第 2 条。 */
  const c = Number.isFinite(current) ? current : 0
  const hi = d - 1 / 30
  return Number(clamp(c, 0, hi > 0 ? hi : 0).toFixed(3))
}
