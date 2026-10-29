/** `categoryOf` 的常驻锁（票 74，2026-10-29）。
 *
 * ## 为什么这个要单独一个文件
 *
 * `categoryOf` 决定**跑哪一份 ComfyUI 工作流**。它与「这个模型是哪一类」
 * （`MODEL_TYPES`）是**两件事**，而这两天已经有人两次想把它们合并：
 *
 * · 票 67 把类型拆成五类时，差点顺手把 `categoryOf` 也按五类简化；
 * · 票 74 把类型退回四类时，又差点顺手把它一起退成四类。
 *
 * 两次的后果一样：**图生图会跑文生图那份工作流**（没有参考图槽位），
 * 出来一张跟参考图无关的图，而且不报错。
 *
 * ## 为什么是「写死的期望表」而不是「跑一遍看输出」
 *
 * 跑一遍看输出只能证明「现在是这样」，改坏了照样是「现在是这样」。
 * 期望表是**从改之前那天实际跑出来的值抄下来的**（2026-10-29 16:30 抄的，
 * 抄完才动代码），所以它锁住的是「那天的事实」，不是「今天的实现」。
 *
 * 表覆盖 `kind` × 有没有参考图 × `op` 的全部组合 —— 漏一组就等于给
 * 那一组开了口子。
 *
 * 跑法：node --import <tsx> tests/category-lock.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-cat-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')

const { categoryOf } = await import('../src/schedule/generate.ts')

let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 期望表。**从 2026-10-29 改动之前的实际返回值抄下来**，不是照票面猜的。
 *
 * 键是 `kind|有参考图|op`，值是当时的 `categoryOf` 返回。
 * `-` 表示不给 `op`。
 */
const EXPECTED = {
  /* ── image ── */
  'image|0|-': 't2i',
  'image|0|inpaint': 'inpaint',
  'image|0|upscale': 'upscale',
  'image|0|superResolve': 'superResolve',
  'image|0|caption': 'text',
  'image|0|angle': 'angle',
  'image|1|-': 'i2i',
  'image|1|inpaint': 'inpaint',
  'image|1|upscale': 'upscale',
  'image|1|superResolve': 'superResolve',
  'image|1|caption': 'text',
  'image|1|angle': 'angle',
  /* ── video ── */
  'video|0|-': 'omniVideo',
  'video|0|inpaint': 'inpaint',
  'video|0|upscale': 'upscale',
  'video|0|superResolve': 'superResolve',
  'video|0|caption': 'text',
  'video|0|angle': 'angle',
  'video|1|-': 'omniVideo',
  'video|1|inpaint': 'inpaint',
  'video|1|upscale': 'upscale',
  'video|1|superResolve': 'superResolve',
  'video|1|caption': 'text',
  'video|1|angle': 'angle',
  /* ── audio ── */
  'audio|0|-': 'audio',
  'audio|0|inpaint': 'inpaint',
  'audio|0|upscale': 'upscale',
  'audio|0|superResolve': 'superResolve',
  'audio|0|caption': 'text',
  'audio|0|angle': 'angle',
  'audio|1|-': 'audio',
  'audio|1|inpaint': 'inpaint',
  'audio|1|upscale': 'upscale',
  'audio|1|superResolve': 'superResolve',
  'audio|1|caption': 'text',
  'audio|1|angle': 'angle',
  /* ── text ── */
  'text|0|-': 'text',
  'text|0|inpaint': 'inpaint',
  'text|0|upscale': 'upscale',
  'text|0|superResolve': 'superResolve',
  'text|0|caption': 'text',
  'text|0|angle': 'angle',
  'text|1|-': 'text',
  'text|1|inpaint': 'inpaint',
  'text|1|upscale': 'upscale',
  'text|1|superResolve': 'superResolve',
  'text|1|caption': 'text',
  'text|1|angle': 'angle',
}

/* ══════════════════════════════════════════════════════════════════════
 * 一、逐格比对（48 格）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== 一、categoryOf 逐格比对（48 格，写死的期望表）===')
{
  const actual = {}
  for (const kind of ['image', 'video', 'audio', 'text']) {
    for (const hasRefs of [false, true]) {
      for (const op of [undefined, 'inpaint', 'upscale', 'superResolve', 'caption', 'angle']) {
        actual[kind + '|' + (hasRefs ? 1 : 0) + '|' + (op ?? '-')] =
          categoryOf(kind, hasRefs, op)
      }
    }
  }

  const keys = Object.keys(EXPECTED)
  check('★★ 格子数对（4 kind × 2 参考图 × 6 op = 48）', keys.length === 48 && Object.keys(actual).length === 48,
    String(Object.keys(actual).length) + ' 格')

  const wrong = keys.filter(k => actual[k] !== EXPECTED[k])
  check('★★★ 48 格逐格等于改之前的实际值（这是「工作流分类没被顺手简化」的唯一证据）',
    wrong.length === 0,
    wrong.length === 0 ? '' : wrong.map(k => k + '：期望 ' + EXPECTED[k] + '，实际 ' + actual[k]).join('； '))

  /* 逐格打印一次，交付时要贴。 */
  console.log('    实测：')
  for (const k of keys) console.log('      ' + k + ' → ' + actual[k])
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、三条与「类型四类」直接对撞的性质（分开的证据）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 二、它与四类类型标签是两件事 ===')
{
  /* ① 同一个 kind='image'，带不带参考图给两套不同答案 —— 四类标签做不到这件事。 */
  check('★★★ 同是 kind=image：不带参考图是 t2i、带参考图是 i2i（类型标签只有一个 image）',
    categoryOf('image', false) === 't2i' && categoryOf('image', true) === 'i2i',
    categoryOf('image', false) + ' / ' + categoryOf('image', true))

  /* ② 它比类型标签**多**：op 分出五种工作流，而类型只有四类。 */
  const opCats = new Set(['inpaint', 'upscale', 'superResolve', 'caption', 'angle']
    .map(op => categoryOf('image', false, op)))
  check('★★★ 五种 op 给出五种不同类别（类型标签只有四类，装不下）',
    opCats.size === 5, [...opCats].join('、'))

  check('★★★ op 优先于 kind 与参考图（局部重绘带参考图仍是 inpaint，不是 i2i）',
    categoryOf('image', true, 'inpaint') === 'inpaint'
    && categoryOf('video', true, 'inpaint') === 'inpaint',
    categoryOf('image', true, 'inpaint') + ' / ' + categoryOf('video', true, 'inpaint'))

  check('★★ 反推提示词恒走 text（与 kind 无关）',
    ['image', 'video', 'audio', 'text'].every(k => categoryOf(k, true, 'caption') === 'text'),
    '')

  /* ③ 它给出的类别里有一部分**根本不是类型名**（`omniVideo` / `inpaint` / `angle`）——
   *    拿它当「类型」用会造出 `MODEL_TYPES` 里没有的值。 */
  const cats = new Set(Object.values(EXPECTED))
  check('★★★ 它给出的类别里有四个不是类型名（omniVideo / inpaint / upscale / superResolve / angle）',
    ['omniVideo', 'inpaint', 'upscale', 'superResolve', 'angle'].every(c => cats.has(c)),
    [...cats].join('、'))
}

console.log('')
console.log(failed === 0
  ? '结论：categoryOf 48 格逐格未变，且与四类类型标签确实是两件事 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
