/** 真实存档兼容性核对：老存档里的 `expr` 条件在新代码下**真的还能跑**。
 *
 * ## 为什么单独一条（而不并进 `if-rules.mjs`）
 *
 * `if-rules.mjs` 用的是**手写**的 exprs（`input.价格 < 100`）。
 * 但真正的风险不是「随便一个 expr 能跑」，而是**躺在真实数据目录里那 6 份存档**
 * 能不能跑 —— 5 份巡查工作流一旦坏掉，整个巡查板块停摆。
 *
 * 所以这条测试直接**读真实存档**（只读，不写），把每个 `flow.if` 节点的 `expr`
 * 用 `branchFn` 真跑一遍。它盯三件事：
 *   ① 存档里确实有 `expr`（否则这条测试会「永远是绿的」—— 见下面那条警告）；
 *   ② 每个 expr 用**两组合乎实际的上游数据**各跑一次，不抛错、给出真值；
 *   ③ 判断结果经过 `liveHandles` 能被调度器认出来（分支才不会静默全死）。
 *
 * ⚠️ **只读**：路径取 `$DSH_HOME` 下的真实数据目录，找不到就**跳过**（不算失败）——
 * 换一台机器 / 换成测试 profile 时不该因为「没有那份存档」而红。
 * 但「找到了、却读不出 expr」要红。
 *
 * 跑法：node --import <tsx> tests/real-archive-if.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { branchFn } from '../src/dispatch/builtins.ts'
import { liveHandles } from '../src/workflow/branch.ts'

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

/** 可能放着真实存档的目录（按优先级）。 */
const CANDIDATES = [
  join(homedir(), 'AppData', 'Roaming', 'dsh', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows'),
  join('F:/AGENTS/agent-chat-dsh', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows'),
  join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows'),
].filter(p => p !== '' && existsSync(p))

console.log('=== 真实存档里的老 expr 条件（兼容性）===')

/* ⚠️ 找不到就**跳过**（不算失败）：这条依赖本机真实数据，别的机器上不该红。 */
const dir = CANDIDATES[0]
if (dir === undefined) {
  console.log('（本机没有真实存档目录，跳过这一条）')
  console.log('')
  console.log('结论：没有可核对的真实存档（跳过）✓')
  process.exit(0)
}
console.log('存档目录：' + dir)

/** IF 节点定义（两出口）。 */
const IF_DEF = {
  id: 'flow.if', label: '条件判断', executor: 'builtin',
  inputs: [{ id: 'in', label: '入', type: 'any' }],
  outputs: [{ id: 'true', label: '成立', type: 'any' }, { id: 'false', label: '不成立', type: 'any' }],
}

/* 收集所有 IF 节点的 expr。 */
const found = []
for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
  let doc
  try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
  for (const n of doc.nodes ?? []) {
    if (n.defId !== 'flow.if') continue
    const expr = n.params?.expr
    if (typeof expr === 'string' && expr.trim() !== '') {
      found.push({ file: f, nodeId: n.id, expr, label: n.label })
    }
  }
}

console.log('')
console.log('① 存档里确实有老写法（没有的话这条测试等于没验）')
check('★ 找到至少一份用 expr 的存档', found.length > 0,
  '找到 ' + String(found.length) + ' 个 IF 节点')
if (found.length === 0) {
  console.log('')
  console.log('结论：有 ' + String(failed) + ' 条不通过 ✗')
  process.exit(1)
}

/* 每条 expr 用两组数据跑：一组明显成立、一组明显不成立。
 * ⚠️ 具体哪组成立**不写死**（写死等于把某份存档的业务含义钉进测试），
 * 只要求「两组给出的结果不一样」—— 那说明这个 expr 真的在判断、
 * 而不是被静默当成恒真或恒假。 */
console.log('')
console.log('② 每条 expr 都还能求值，而且真的在判断（两组数据结果不同）')
const INPUTS = [
  { hour: 3, curfewTop: true, count: 0 },
  { hour: 12, curfewTop: false, count: 5 },
]
for (const item of found) {
  const results = []
  let err = ''
  for (const up of INPUTS) {
    try {
      const out = branchFn({ node: 'flow.if', params: { expr: item.expr } }, { nodeId: item.nodeId, upstream: [up], workdir: '.' })
      const h = liveHandles(out, IF_DEF)
      results.push(h === null ? '?' : h[0])
    } catch (e) {
      err = String(e?.message ?? e)
      results.push('ERR')
    }
  }
  const where = item.file + ':' + item.nodeId
  check('★ ' + where + ' 的 expr 能跑（不抛错）', err === '', err || item.expr)
  check('★★ ' + where + ' 真的在判断（两组数据结果不同）',
    results[0] !== results[1] && results[0] !== 'ERR' && results[1] !== 'ERR',
    item.expr + ' → ' + results.join(' / '))
}

/* 结构性：每个判断都报了一个**真实存在的出口**（报不存在的话
 * `liveHandles` 会当「没有分支信息」→ 两条分支全活 → 该停的没停）。 */
console.log('')
console.log('③ 判断结论能被调度器认（出口名在定义里）')
{
  const out = branchFn({ node: 'flow.if', params: { expr: 'true' } }, { nodeId: 'x', upstream: [{}], workdir: '.' })
  check('出口名是 true / false，且都在定义里',
    (out.__handle === 'true' || out.__handle === 'false')
    && IF_DEF.outputs.some(o => o.id === out.__handle), JSON.stringify(out))
  check('★ 分支信息被调度器认出来（不是「全活」）', liveHandles(out, IF_DEF) !== null, JSON.stringify(liveHandles(out, IF_DEF)))
}

console.log('')
console.log(failed === 0 ? '结论：真实存档的老 expr 条件全部还能跑 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
