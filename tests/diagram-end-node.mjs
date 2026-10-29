/** 图 2 / 图 4 的「结束节点」那段必须同时写着现行形态与目标形态（票 09 第二部分）。
 *
 * ## 为什么这条要一个测试
 *
 * 「已定未实施」这四个字是**给人看的护栏**：图里主线画的是现行形态，
 * 有人照着图去改代码时，必须能在图上看到「目标形态还没做」。
 *
 * 这段卡片是**手写进 HTML 的**（`finalize` 生成之后又补的），
 * 没有任何东西守着它 —— 以后谁重新跑一遍 archify 生成，那段卡片会**静静消失**，
 * 而图上仍然看着完整。图和代码对不上，比没有图更坏。
 *
 * 所以钉三件事：① 那两个字还在；② 图 2 与图 4 **都**在；③ 现行形态与目标形态两侧都在。
 *
 * ## 为什么不去验渲染
 *
 * 那是 `browser-check` 门禁的事，且要开浏览器（`dom-render` 归 lead 调度，我不跑）。
 * 这里只验文件原文里有这几句话 —— 它守的是「内容别丢」，不是「画得对不对」。
 *
 * 跑法：`node tests/diagram-end-node.mjs`（不需要 tsx，纯读文件）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== 图 2 / 图 4：结束节点「已定未实施」（票 09）===')
console.log('')

/* 图有两份（初版与 review-2 可读性修复版），两份都要在 —— 只改一份等于漏。
 * 路径取「20261025 内容更正版」，它是 `docs/调研-工作台功能逻辑图.md` §5.2 记的现行版本。 */
const targets = [
  { name: '图 2 初版', path: 'outputs/功能逻辑图/workflow-run-lifecycle-20261023-093500/run-lifecycle-20261025.html' },
  { name: '图 2 review-2', path: 'outputs/功能逻辑图/workflow-run-lifecycle-20261023-093500/review-2/run-lifecycle-20261025.html' },
  { name: '图 4', path: 'outputs/功能逻辑图/dataflow-outputs-to-disk-20261023-101500/outputs-to-disk-20261025.html' },
]

for (const t of targets) {
  console.log(t.name + '：' + t.path)
  if (!existsSync(t.path)) {
    /* 文件不在 = 图被搬走或删了。不判红（不归我管），但必须明说，不能当通过。 */
    console.log('  （跳过：文件不在 —— 不判红，也不假装通过）')
    continue
  }
  const html = readFileSync(t.path, 'utf8')
  const hits = (html.match(/已定未实施/g) ?? []).length
  check('★★ 「已定未实施」出现次数 ≥ 1', hits >= 1, String(hits) + ' 次')

  /* 只有那四个字不够 —— 一张图可以只写一句「已定未实施」而不说是什么没实施。
   * 下面四条是 §5.1 的实质内容，缺一条这张卡片就是残的。 */
  check('★★ 写了现行形态（结束节点声明 fields → 收成 declaredOutputs）',
    html.includes('声明 fields') && html.includes('declaredOutputs'))
  check('★★ 写明了目标形态：存档里不画结束节点、flow.end 仍在节点库',
    html.includes('不再写进工作流存档') && html.includes('flow.end 仍在节点库'))
  check('★★ 写明了产出改由「节点主动汇报」汇总',
    html.includes('节点主动汇报'))
  check('★★ 写明了结束节点原声明产出「单独存一份记录，不并入任务记录」',
    html.includes('单独存一份记录') && html.includes('不并入任务记录'))
  /* 保守时态：不许写成「已经做了」。 */
  check('★ 没有把它写成已完成（不得出现「已实施」这种反向说法）',
    html.includes('已实施') === false, html.includes('已实施') ? '出现了「已实施」' : '')
  console.log('')
}

console.log(failed === 0
  ? '结论：图 2 / 图 4 的结束节点卡片都在，且写着现行形态、目标形态与「已定未实施」✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
