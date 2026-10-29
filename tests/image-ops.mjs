/** `lib/canvas/image-ops.ts` 的判据（用户 m02814）。
 *
 * ## 这个文件验什么、不验什么（先说清，免得误读）
 *
 * **验的**：几何与时间的算法 —— 裁剪矩形归一化、像素换算、比例预设、
 * 拆图的边界分配、抓帧的秒数。
 *
 * **不验的**：真像素。`drawImage` / `getImageData` 这些要 canvas 2d 上下文，
 * 而 jsdom 里 `getContext('2d')` 返回 `null`（实测）。所以「裁出来的图对不对」
 * 「拆出来的每块长得对不对」「抓的那一帧画面对不对」**只能人眼看**，
 * 交付时单独列出，不假装验了。
 *
 * 跑法：node --import <tsx> tests/image-ops.mjs
 */
import {
  FULL_CROP, normalizeCrop, cropPixelRect, ratioValue, applyRatioPreset,
  splitRects, frameTimeOf,
} from '../src/client/workbench/lib/canvas/image-ops.ts'

let failed = 0
let total = 0

/**
 * 一条断言。
 * @param {string} name 判据说明。
 * @param {boolean} ok 通过与否。
 * @param {string} [detail] 失败时要看的值。
 */
function check(name, ok, detail = '') {
  total += 1
  if (!ok) failed += 1
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail === '' ? '' : '  —— ' + detail))
}

console.log('=== ① 裁剪：归一化要挡住四种坏输入 ===')
{
  const ok = normalizeCrop({ x: 0.2, y: 0.3, width: 0.4, height: 0.3 })
  check('★★ 正常框原样通过',
    ok.x === 0.2 && ok.y === 0.3 && ok.width === 0.4 && ok.height === 0.3, JSON.stringify(ok))

  /* 拖反了：从右下往左上拖 → 宽高为负 */
  const rev = normalizeCrop({ x: 0.6, y: 0.6, width: -0.3, height: -0.2 })
  check('★★ 拖反了（负宽高）→ 翻正成正常矩形（否则 drawImage 画空白）',
    rev.width > 0 && rev.height > 0 && Math.abs(rev.x - 0.3) < 1e-6 && Math.abs(rev.y - 0.4) < 1e-6,
    JSON.stringify(rev))

  /* 拖出边界 */
  const out = normalizeCrop({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 })
  check('★★ 拖出边界 → 夹进 [0,1]（否则取回的像素带透明边）',
    out.x + out.width <= 1.000001 && out.y + out.height <= 1.000001,
    JSON.stringify(out))

  /* 拖成一条线 */
  const flat = normalizeCrop({ x: 0.5, y: 0.5, width: 0, height: 0 })
  check('★★ 拖成 0 宽高 → 补到最小尺寸（0 宽高同样是空图）',
    flat.width >= 0.01 && flat.height >= 0.01, JSON.stringify(flat))

  /* NaN */
  const nan = normalizeCrop({ x: Number.NaN, y: 0.2, width: Number.POSITIVE_INFINITY, height: 0.1 })
  check('★★ NaN / Infinity → 不原样传下去（否则 drawImage 静默画空白）',
    Number.isFinite(nan.x) && Number.isFinite(nan.width) && nan.x >= 0 && nan.x + nan.width <= 1.000001,
    JSON.stringify(nan))

  check('★ 整图常量就是 0,0,1,1',
    FULL_CROP.x === 0 && FULL_CROP.y === 0 && FULL_CROP.width === 1 && FULL_CROP.height === 1)
}

console.log('')
console.log('=== ② 裁剪：归一化 → 像素 ===')
{
  const r = cropPixelRect({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, 800, 400)
  check('★★ 0.25/0.5/0.5/0.25 在 800×400 上是 200,200,400,100',
    r.x === 200 && r.y === 200 && r.width === 400 && r.height === 100, JSON.stringify(r))

  /* 比例极小时四舍五入会得到 0 —— 而 0 宽高的 drawImage 什么都不画、也不报错 */
  const tiny = cropPixelRect({ x: 0.999, y: 0.999, width: 0.001, height: 0.001 }, 100, 100)
  check('★★ 极小的框 → 宽高至少 1 像素（0 像素不画也不报错）',
    tiny.width >= 1 && tiny.height >= 1, JSON.stringify(tiny))

  const over = cropPixelRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 100, 100)
  check('★★ 四舍五入之后也不许越界（x+width ≤ 原图宽）',
    over.x + over.width <= 100 && over.y + over.height <= 100, JSON.stringify(over))

  const zero = cropPixelRect({ x: 0, y: 0, width: 1, height: 1 }, 0, 0)
  check('★ 图片尺寸给 0（还没加载完）→ 不崩，按 1×1 算',
    zero.width >= 1 && zero.height >= 1, JSON.stringify(zero))
}

console.log('')
console.log('=== ③ 比例预设 ===')
{
  check('★ 1:1 / 16:9 / 9:16 的数值对',
    ratioValue('1:1') === 1 && Math.abs((ratioValue('16:9') ?? 0) - 16 / 9) < 1e-9
    && Math.abs((ratioValue('9:16') ?? 0) - 9 / 16) < 1e-9)
  check('★ free 不锁比例（给 null）', ratioValue('free') === null)

  /* 1:1 的框在 800×400 的图上，像素上应该是正方形 */
  const sq = applyRatioPreset({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, '1:1', { width: 800, height: 400 })
  const sqPx = cropPixelRect(sq, 800, 400)
  check('★★ 1:1 预设 → 像素上是正方形（宽高差 ≤ 1 像素）',
    Math.abs(sqPx.width - sqPx.height) <= 1, sqPx.width + '×' + sqPx.height)

  const wide = applyRatioPreset({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, '16:9', { width: 800, height: 400 })
  const widePx = cropPixelRect(wide, 800, 400)
  check('★★ 16:9 预设 → 像素比例接近 16/9',
    Math.abs(widePx.width / widePx.height - 16 / 9) < 0.06,
    String((widePx.width / widePx.height).toFixed(3)))

  check('★★ 等比框不许越界（撑满会超出原图，超出部分没有像素）',
    sq.x >= -1e-9 && sq.y >= -1e-9 && sq.x + sq.width <= 1.000001 && sq.y + sq.height <= 1.000001,
    JSON.stringify(sq))

  const kept = applyRatioPreset({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, 'free', { width: 100, height: 100 })
  check('★ free 时原样返回（用户没要求锁比例）',
    kept.x === 0.2 && kept.width === 0.3, JSON.stringify(kept))
}

console.log('')
console.log('=== ④ 拆图：边界分配（一块像素都不许丢） ===')
{
  const p4 = splitRects(100, 80, 2, 2)
  check('★★ 2×2 → 4 块', p4.length === 4, String(p4.length))
  check('★ 顺序是从左到右、从上到下',
    p4[0].row === 0 && p4[0].col === 0 && p4[1].col === 1 && p4[2].row === 1, JSON.stringify(p4.map(p => [p.row, p.col])))
  check('★★ 相邻块边界严丝合缝（左块的右边 = 右块的左边）',
    Math.abs((p4[0].x + p4[0].width) - p4[1].x) < 1e-9
    && Math.abs((p4[0].y + p4[0].height) - p4[2].y) < 1e-9,
    JSON.stringify(p4.slice(0, 3).map(p => [p.x, p.width])))

  /* 100 像素切 3 列：每块 33 会丢 1 像素，边界取整则不丢 */
  const p3 = splitRects(100, 100, 1, 3)
  const widths = p3.map(p => Math.round(p.width * 100))
  check('★★ 100 像素切 3 列 → 像素一块都不丢（合计正好 100）',
    widths.reduce((a, b) => a + b, 0) === 100, widths.join(' + '))
  check('★ 最后一块的右边贴住 1.0',
    Math.abs(p3[2].x + p3[2].width - 1) < 1e-9, String(p3[2].x + p3[2].width))

  const p16 = splitRects(160, 160, 4, 4)
  check('★★ 4×4 → 16 块', p16.length === 16)
  check('★ 4×4 每块比例都是 0.25',
    p16.every(p => Math.abs(p.width - 0.25) < 1e-9 && Math.abs(p.height - 0.25) < 1e-9))

  check('★ 行列为 0 / 负数 / NaN → 按 1 处理（不崩、不给空数组）',
    splitRects(10, 10, 0, 0).length === 1
    && splitRects(10, 10, Number.NaN, Number.NaN).length === 1)
  check('★ 行列超过 16 → 夹到 16（再多会变成几十个节点，画布卡死）',
    splitRects(1000, 1000, 99, 99).length === 16 * 16)
}

console.log('')
console.log('=== ⑤ 抓帧：秒数（三条边界） ===')
{
  check('★★ 首帧 → 0', frameTimeOf(10, 'first') === 0)
  check('★★ 尾帧 → duration 减一帧（不能正好等于 duration，会抓出黑帧）',
    frameTimeOf(10, 'last') < 10 && frameTimeOf(10, 'last') > 9.9,
    String(frameTimeOf(10, 'last')))
  check('★★ 尾帧不许小于 0（时长极小时 duration-1/30 会变负）',
    frameTimeOf(0.01, 'last') >= 0, String(frameTimeOf(0.01, 'last')))
  check('★★ duration 是 NaN（视频还没加载出元数据）→ 给 0，不传下去（会抛 InvalidStateError）',
    frameTimeOf(Number.NaN, 'last') === 0 && frameTimeOf(Number.NaN, 'current', 5) === 0)
  check('★ duration 是 0 / 负数 → 给 0',
    frameTimeOf(0, 'first') === 0 && frameTimeOf(-3, 'last') === 0)

  check('★★ 当前帧原样用（在范围内）',
    frameTimeOf(10, 'current', 3.5) === 3.5, String(frameTimeOf(10, 'current', 3.5)))
  check('★★ 当前帧超出末尾 → 夹到「末尾减一帧」（不然同样抓黑帧）',
    frameTimeOf(10, 'current', 10) < 10 && frameTimeOf(10, 'current', 10) > 9.9,
    String(frameTimeOf(10, 'current', 10)))
  check('★ 当前帧是负数 / NaN → 给 0',
    frameTimeOf(10, 'current', -5) === 0 && frameTimeOf(10, 'current', Number.NaN) === 0)
}

console.log('')
console.log(failed === 0 ? '结论：图像操作的纯函数都对 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
console.log('（共 ' + String(total) + ' 条判据）')
process.exit(failed === 0 ? 0 : 1)
