/** 备忘里那几条「代码事实」必须与文档对得上。
 *
 * ## 这份测试原来是干什么的（2026-10-27 写）
 *
 * 当时 `docs/备忘-延后开发功能.md` 有 12 条延后项，其中 8 条后来做完了。
 * 原测试守的是「文档说的 8 做完 / 3 在等 / 1 消失」与代码事实一致，
 * 怕的是**文档不更新，下一个人把已完成的当成未做的重做一遍**。
 *
 * ## 为什么重写（2026-10-29）
 *
 * 用户定：「只保留确定延后且没做的，过时的不需要说明，太累赘了。」
 * 于是文档瘦身成只剩**没做**的条目 —— 「哪条做完了」这个问题整份文档不再回答，
 * 那句「8 / 3 / 1」也一起删了。原来的断言全部失去对象（不是失效，是对象没了）。
 *
 * **没有把旧断言放宽，也没有留一个空壳**：换成守新文档里唯一一条能被代码推翻的话，
 * 并加一条守「文档只留没做的」这个新规矩（旧测试管不到它）。
 *
 * ## 现在守什么
 *
 * 1. **左侧栏那行仍然是写死的**。备忘「引擎与依赖的健康检测」那条写着：
 *    `EcomWorkbench.tsx:790` 的「引擎就绪」**不读任何状态**，并提醒下一个人
 *    「别当成 bug 去接真状态」。那句话是**可被代码推翻的** —— 哪天有人真接上了状态，
 *    这句提醒就变成错的，读的人会拿它当依据跳过检查。
 * 2. **那句提醒还在文档里**。代码还在写死、提醒被删 → 下一个人会去「修」它。
 * 3. **文档只留没做的**。用户 2026-10-29 定：做掉的直接删，不留「已做完」的说明。
 *
 * 其余内容（为什么延后、何时回头看）是判断记录，机器判不了，留给读的人。
 *
 * 跑法：`node tests/memo-status.mjs`（纯读文件，不需要 tsx）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MEMO = join(ROOT, 'docs', '备忘-延后开发功能.md')
const SHELL = join(ROOT, 'src', 'client', 'workbench', 'EcomWorkbench.tsx')

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

/** 读一份文件（读不到给空串，让断言自己报红而不是整份崩掉）。 */
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

console.log('=== 备忘里的代码事实与代码对得上 ===')
console.log('')

const memo = read(MEMO)
const shell = read(SHELL)

check('（前置）备忘文件读得到', memo !== '', MEMO)
check('（前置）左侧栏文件读得到', shell !== '', SHELL)

/* ── ① 左侧栏那行仍然是写死的 ─────────────────────────────────── */
console.log('① 左侧栏底部「引擎就绪」仍是写死的（备忘那条的前提）')
{
  check('★★ 左侧栏里仍有那句「引擎就绪」', shell.includes("'引擎就绪'"), '')

  /* 它不许读真状态：`engineOk` 这个变量名只有执行画布有。
   * 哪天有人把它接进来，这条会红 —— 那时该做的是**去改备忘那条**，
   * 写明「已经接上了」，而不是把断言删掉。 */
  check('★★ 左侧栏没有接引擎真状态（没有 engineOk）', shell.includes('engineOk') === false, '')

  /* 状态点仍然是恒亮那一档（`dot ok pulse`），不是按状态切的三档。 */
  check('★★ 状态点仍是恒亮的 `dot ok pulse`', shell.includes("'dot ok pulse'"), '')
}

/* ── ② 备忘里那句提醒还在 ─────────────────────────────────────── */
console.log('')
console.log('② 备忘里「这不是漏改」那句提醒还在')
{
  /* 提醒和代码是一对：代码还在写死、提醒被删 → 下一个人会去「修」它。
   * 两件缺一件，这条都要红。 */
  check('★★ 备忘里写明「这是知情的决定，不是漏改」', memo.includes('不是漏改'), '')
  check('★★ 备忘里点到了那个行号', memo.includes('EcomWorkbench.tsx:790'), '')
}

/* ── ③ 备忘只留没做的 ────────────────────────────────────────── */
console.log('')
console.log('③ 备忘只留没做的条目（不再有「已做完」的回顾）')
{
  /* 用户 2026-10-29 定：「只保留确定延后且没做的」。
   * 判据取「每条的状态取值都是『延后…』」—— 一旦有人又把完成的写回来，这条红。
   * 注意只查 `**状态**：` 那一行的取值，正文里叙述「已做完的删掉」这类话不算。 */
  const statusLines = [...memo.matchAll(/^\*\*状态\*\*：(.+)$/gm)].map(m => m[1].trim())
  console.log('   各条状态:', JSON.stringify(statusLines))
  check('★★ 每一条的状态都是「延后…」', statusLines.length > 0 && statusLines.every(s => s.startsWith('延后')),
    String(statusLines.length))
  check('★★ 没有「已做完 / 已完成」这种条目', /^\*\*状态\*\*：\s*已/m.test(memo) === false, '')
}

console.log('')
console.log(failed === 0
  ? '结论：备忘里的代码事实与代码一致 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
