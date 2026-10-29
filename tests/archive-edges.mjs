/** 存档里的连线**不许有重复**（同一对端点、同一组 handle 只该出现一次）。
 *
 * ## 为什么这条要单独钉住
 *
 * 2026-10-27 实测：13 份真实存档里有 6 组重复边
 * （`取数-抖音电商罗盘` 5 组、`取数-天猫生意参谋` 1 组）。
 * 来源是**生成器**：`build-douyin.mjs` 在 `addLoginRescue` 之外又重连了五行，
 * `build-tmall.mjs` 多连了一条 `ask → abort`。
 *
 * ## 重复边到底坏在哪（实测，不是推断）
 *
 * 之前（2026-10-23）判过「无害」，依据是 `src/workflow/topo.ts` 的 `topoSort`
 * 按 `source\u0000target` 去重（`seen` 集合）。**那只覆盖拓扑排序**，
 * 管不到 `src/workflow/run.ts:957` 的 `upstreamOf`：
 *
 *   const upstreamOf = (id, ctx) => edges.filter(e => e.target === id && edgeAlive(e, ctx))
 *     .map(e => outOf(e.source, ctx))
 *
 * 它是按**原始边表**过滤的。实测两条边 `n2 → n3`：
 *
 *   单条边：n3 收到的上游数组 `[{"v":1}]`        派发 1 次
 *   重复边：n3 收到的上游数组 `[{"v":1},{"v":1}]` 派发 1 次
 *
 * 所以「节点跑两遍」是**不成立的**，但「下游拿到两份重复的上游」是真的。
 * 现在没有哪条工作流因此出错（读 `input.v` 那种拿第一个，结果一样），
 * 但那是运气：任何一处写 `input.length`、按上游个数拼串、或按上游顺序取值的
 * 节点都会静默拿到坏值。**清掉它比赌着安全。**
 *
 * ## 判据
 *
 * 四元组 `source|sourceHandle|target|targetHandle` 完全相同即算重复
 * （`sourceHandle` / `targetHandle` 缺省按空串算 —— `flow.if` 的两个出口靠它区分，
 * `n12|false|n13` 与 `n12||n13` 是两条不同的边，不算重复）。
 *
 * ⚠️ **只读**：找不到存档目录就**跳过**（不算失败）—— 换机器 / 换 profile 时
 * 不该因为「没有那份存档」而红。但**找到了、却查出重复**要红。
 *
 * 跑法：node tests/archive-edges.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 累计失败数。 */
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
 * 一条边的判重键。
 * @param e - 存档里的边。
 * @returns 四元组拼成的字符串。
 */
function edgeKey(e) {
  return [
    String(e.source ?? ''),
    String(e.sourceHandle ?? ''),
    String(e.target ?? ''),
    String(e.targetHandle ?? ''),
  ].join('|')
}

const DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')

console.log('=== 存档连线无重复 ===')

/* 找不到就跳过（与 `tests/real-archive-if.mjs` / `download-merge.mjs` 同一条纪律）。 */
if (!existsSync(DIR)) {
  console.log('（本机没有存档目录：' + DIR + '，跳过）')
  console.log('')
  console.log('结论：没有可核对的存档（跳过）✓')
  process.exit(0)
}
console.log('存档目录：' + DIR)

let scanned = 0
let totalEdges = 0
/** 有重复的存档：[存档名, [重复键…]]。 */
const offenders = []

for (const f of readdirSync(DIR).filter(x => x.endsWith('.json')).sort()) {
  let doc
  try { doc = JSON.parse(readFileSync(join(DIR, f), 'utf8')) } catch { continue }
  if (!Array.isArray(doc.edges)) continue
  scanned += 1
  totalEdges += doc.edges.length
  const seen = new Map()
  for (const e of doc.edges) {
    const k = edgeKey(e)
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const dups = [...seen].filter(([, n]) => n > 1)
  if (dups.length > 0) {
    offenders.push([f.replace(/\.json$/, ''), dups])
    for (const [k, n] of dups) console.log('  ✗ ' + f.replace(/\.json$/, '') + ' / ' + k + '  ×' + String(n))
  }
}

console.log('')
/* ⚠️ 先钉「扫到了东西」—— 目录读空时下面的「无重复」会永远绿，
 * 那就是「通过」把「没验到」包进去了（与 run-tests.mjs 的 [SKIP] 同一件事）。 */
check('★ 扫到了存档（不是空跑）', scanned > 0, String(scanned) + ' 份')
check('★ 扫到了连线（不是全空存档）', totalEdges > 0, String(totalEdges) + ' 条')

const dupCount = offenders.reduce((sum, [, d]) => sum + d.length, 0)
check('★★ 每份存档的连线四元组都不重复', dupCount === 0,
  dupCount === 0
    ? String(scanned) + ' 份 / ' + String(totalEdges) + ' 条连线'
    : String(offenders.length) + ' 份存档、共 ' + String(dupCount) + ' 组重复（生成器里多连了？见文件头）')

console.log('')
console.log(failed === 0 ? '结论：存档连线没有重复 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
