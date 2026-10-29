/** 「确认账号已登录」这一步的测试（用户 2026-10-20 加）。
 *
 * ## 为什么必须单测
 *
 * 这件事最容易「写了但没生效」，而且是**看着成功、其实什么都没做**那一类：
 *
 *   - 未登录时生意参谋的接口返 401，但**页面不一定跳转** → 下游拿到空名单
 *     → 表现为「今天没有报表要下」，用户根本看不出是登录问题；
 *   - IF 的两个出口如果没显式写 handle，未登录时循环/后续**照跑**
 *     （`edgeIsLive(undefined, ['false'])` 返回 true）→ 检查等于没加。
 *
 * 所以这里盯三件事：
 *   ① 两份工作流都有「读登录」节点，且判据是各平台自己的（抖音 /login、天猫 login.htm）；
 *   ② IF 的**条件读的是那个节点的输出**（不是循环变量 —— 那里根本没有值）；
 *   ③ IF 的两条出口**都接了**，且 true 才进主流程、false 写「未登录」结果。
 *
 * 跑法：node --import <tsx> tests/login-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_CHECK_DY, LOGIN_CHECK_TM, loginFailResult } from '../scripts/browser/login-check.mjs'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
const DY = join(DIR, '取数-抖音电商罗盘.json')
const TM = join(DIR, '取数-天猫生意参谋.json')

console.log('=== ① 两份存档都在 ===')
check('抖音存档存在', existsSync(DY), DY)
check('天猫存档存在', existsSync(TM), TM)
if (!existsSync(DY) || !existsSync(TM)) {
  console.log('（先跑 node scripts/build-patrol-workflows.mjs）')
  process.exit(1)
}

/** 读一份存档。
 * @param p - 路径。
 * @returns 解析后的对象。 */
const load = (p) => JSON.parse(readFileSync(p, 'utf8'))
const dy = load(DY)
const tm = load(TM)

/** 按标签片段找一个节点。
 * @param doc - 存档。
 * @param kw - 标签里含的词。
 * @returns 节点或 undefined。 */
const byLabel = (doc, kw) => doc.nodes.find(n => String(n.label ?? '').includes(kw))

console.log('')
console.log('=== ② 都有「读登录」节点，判据是各平台自己的 ===')
for (const [name, doc, hint] of [['抖音', dy, '读「登录了吗」'], ['天猫', tm, '读「登录了吗」']]) {
  const n = byLabel(doc, hint)
  check(name + ' 有「读登录」节点', n !== undefined, n === undefined ? '没找到' : n.id)
  if (n === undefined) continue
  check(name + ' 那一步是 browser.act 的 eval', n.defId === 'browser.act' && n.params?.action === 'eval',
    String(n.defId) + '/' + String(n.params?.action))
}
{
  const dyNode = byLabel(dy, '读「登录了吗」')
  const tmNode = byLabel(tm, '读「登录了吗」')
  check('★ 抖音判据是 /login（照源码 douyin-ui.ts:524）',
    String(dyNode?.params?.code ?? '').includes("includes('/login')"))
  check('★ 天猫判据是 login.htm（照源码 tb-sycm.ts:67）',
    String(tmNode?.params?.code ?? '').includes('login.htm'))
}

console.log('')
console.log('=== ③ IF 的条件读「那个节点的输出」，不是循环变量 ===')
for (const [name, doc] of [['抖音', dy], ['天猫', tm]]) {
  const ifNode = byLabel(doc, '登录了吗？')
  check(name + ' 有「登录了吗？」判断', ifNode !== undefined, ifNode?.id)
  if (ifNode === undefined) continue
  const cond = ifNode.params?.conditions?.[0]
  check('★★ ' + name + ' 的左边是 field（上游节点字段）', cond?.left?.kind === 'field', String(cond?.left?.kind))
  /* ⚠️ 这条是**踩过的坑**：第一版写成 `kind: 'loop'` + `item.loggedIn`，
   * 而登录检查不在循环里 → 读到 undefined → 永远走「不成立」→ 未登录分支。 */
  check('★★ ' + name + ' 不是循环变量（那个位置根本没有值）', cond?.left?.kind !== 'loop', String(cond?.left?.kind))
  check('★ ' + name + ' 的字段路径带 result. 前缀（驱动包了一层）',
    String(cond?.left?.field ?? '') === 'result.loggedIn', String(cond?.left?.field))
  check('★ ' + name + ' 比的是布尔 true', cond?.op === 'is' && cond?.valueType === 'boolean',
    String(cond?.op) + '/' + String(cond?.valueType))
}

console.log('')
console.log('=== ④ 两条出口都接了，且 true 才进主流程 ===')
{
  const ifNode = byLabel(dy, '登录了吗？')
  const outs = dy.edges.filter(e => e.source === ifNode?.id)
  check('★★ 抖音 IF 有 true 出口', outs.some(e => e.sourceHandle === 'true'),
    outs.map(e => String(e.sourceHandle)).join(','))
  check('★★ 抖音 IF 有 false 出口', outs.some(e => e.sourceHandle === 'false'),
    outs.map(e => String(e.sourceHandle)).join(','))
  /* true 应该接到循环 A（主流程）。 */
  const trueTarget = outs.find(e => e.sourceHandle === 'true')?.target
  const target = dy.nodes.find(n => n.id === trueTarget)
  check('★★ 抖音 true 接的是循环 A（主流程）', target?.defId === 'flow.loop',
    String(target?.id) + '/' + String(target?.defId))
  /* ⚠️ 反向：模块清单**不许**再直连循环 A（否则没登录也照跑）。 */
  const modules = byLabel(dy, '① 模块清单')
  check('★★ 模块清单不再直连循环 A（否则未登录也照跑）',
    !dy.edges.some(e => e.source === modules?.id && e.target === trueTarget))
}
{
  const ifNode = byLabel(tm, '登录了吗？')
  const outs = tm.edges.filter(e => e.source === ifNode?.id)
  check('★★ 天猫 IF 有 true / false 两条出口',
    outs.some(e => e.sourceHandle === 'true') && outs.some(e => e.sourceHandle === 'false'),
    outs.map(e => String(e.sourceHandle)).join(','))
  const trueTarget = outs.find(e => e.sourceHandle === 'true')?.target
  const target = tm.nodes.find(n => n.id === trueTarget)
  check('★★ 天猫 true 接的是「取报表名单」', String(target?.label ?? '').includes('取报表名单'),
    String(target?.label))
}

console.log('')
console.log('=== ⑤ 未登录那条路会写结果（不是静默停下） ===')
for (const [name, doc] of [['抖音', dy], ['天猫', tm]]) {
  const failNode = doc.nodes.find(n => /未登录/.test(String(n.label ?? '')))
  check(name + ' 有「未登录」节点', failNode !== undefined, failNode?.label)
  if (failNode === undefined) continue
  /* 必须有个 sys.fs.write 接在它后面（写结果文件）。 */
  const next = doc.edges.filter(e => e.source === failNode.id).map(e => doc.nodes.find(n => n.id === e.target))
  check('★★ ' + name + ' 未登录后会写结果文件', next.some(n => n?.defId === 'sys.fs.write'),
    next.map(n => String(n?.defId)).join(','))
}

console.log('')
console.log('=== ⑥ 两段判据代码本身（不依赖存档，直接看生成器给的串） ===')
check('抖音判据认得 /login', LOGIN_CHECK_DY.includes("includes('/login')"))
check('抖音判据不会把登录页误判成已登录', LOGIN_CHECK_DY.includes('loggedIn: !isLogin'))
check('天猫判据认得 login.htm', LOGIN_CHECK_TM.includes('login.htm'))
check('天猫判据同样有 loggedIn', LOGIN_CHECK_TM.includes('loggedIn: !isLogin'))
/* 未登录结果：必须带原因（用户要求「当前输出原因即可」）。 */
{
  const s = loginFailResult('douyin')
  check('未登录结果带 reason 与 hint', s.includes('reason') && s.includes('hint'), String(s.length))
  check('未登录结果 ok:false', s.includes('ok: false'))
  check('未登录结果是抖音字样', s.includes('抖音'))
}
{
  const s = loginFailResult('tmall')
  check('天猫未登录结果是天猫字样', s.includes('天猫'))
}

console.log('')
console.log(failed === 0 ? '结论：登录检查接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
