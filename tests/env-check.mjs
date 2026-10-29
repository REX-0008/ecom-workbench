/** 钉住「环境检测」（用户 m03425 第 6 条）。
 *
 * ## 用户原话
 *
 * > 「在工作流管理 tab 中增加一个**环境检测按钮**，你思考一下应该检测些什么，
 * > 节点依赖，浏览器准备（特别是默认浏览器是否可用，比如默认浏览器如果是 cdp，
 * > 那么这个 cdp 接口是否可用需要验证）。现在不必求全，因为依赖声明这个部分还没做，
 * > 将部分没实现后期准备完善的部分写入总纲即可。」
 *
 * ## 这个测试盯什么（以及为什么不查「按钮在不在」）
 *
 * 「按钮在不在」是最没价值的一类断言 —— 它绿着，功能照样可以是假的。
 * 所以判定逻辑抽成了**纯函数**（`src/workflow/env-check.ts`），
 * 这里直接喂构造好的事实，验**判定本身**对不对：
 *
 *   · `buildEnvReport` —— 什么情况算「跑不了」；
 *   · `scanNodeGaps` —— 哪些存档引用了消失的节点类型。
 *
 * ⚠️ 为什么判定在客户端而机器事实在宿主半：**宿主半读不到 localStorage**
 * （偏好存在浏览器里），**客户端连不了 socket** —— 所以「默认是 CDP、
 * 但那个端口没在听」这件事只能两侧各出一半、在客户端合起来判。
 * 这条分工本身也在这里钉住（查宿主半只给事实、不给结论）。
 *
 * 这份测试**不需要 tsx loader**，但 `env-check.ts` 是 TS、被 src 引用 ——
 * 用纯 node 跑时靠 `scripts/run-tests.mjs` 按 import 自动加 loader。
 */
import { readFileSync } from 'node:fs'
import { buildEnvReport, scanNodeGaps } from '../src/workflow/env-check.ts'

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 一份「一切正常」的机器事实（各用例只改它要验的那一项）。 */
const GOOD_FACTS = {
  library: 19,
  workflows: 3,
  gaps: [],
  depsImplemented: false,
  browsersUsable: 2,
  browserNames: ['QQ 浏览器', 'Google Chrome'],
  cdpPorts: [9222],
}
/** 默认偏好：CDP + 正确的端口（也就是「能跑」那一组）。 */
const GOOD_PREFS = { defaultSource: 'cdp', defaultPort: '9222' }

/* ── ① 判定的四类阻塞 ──────────────────────────────────────────────── */
console.log('')
console.log('=== ① 什么算「跑不了」 ===')
{
  const ok = buildEnvReport(GOOD_FACTS, GOOD_PREFS)
  check('★ 一切正常 → 没有阻塞', ok.blockers.length === 0, ok.blockers.join(' / '))
  check('  报告里带着机器事实（library / workflows / cdpPorts）',
    ok.library === 19 && ok.workflows === 3 && ok.cdpPorts.includes(9222))
}
{
  /* ① 存档里有消失的节点类型。 */
  const r = buildEnvReport({ ...GOOD_FACTS, gaps: [{ workflow: '天猫取数', defId: 'browser.act' }] }, GOOD_PREFS)
  check('★ 存档引用了消失的节点类型 → 阻塞', r.blockers.length === 1 && r.blockers[0].includes('1 处'))
}
{
  /* ② 默认来源是 CDP、机器上一个端口都没在听。 */
  const r = buildEnvReport({ ...GOOD_FACTS, cdpPorts: [] }, GOOD_PREFS)
  check('★ 默认是 CDP 但没有任何调试端口在听 → 阻塞',
    r.blockers.some(b => b.includes('没有任何调试端口在听')), r.blockers.join(' / '))
}
{
  /* ③ 用户点名的那条：默认端口不在在听列表里。 */
  const r = buildEnvReport({ ...GOOD_FACTS, cdpPorts: [9333] }, GOOD_PREFS)
  check('★ 默认端口 9222 没在听（在听的是 9333）→ 阻塞',
    r.blockers.some(b => b.includes('9222') && b.includes('9333')), r.blockers.join(' / '))
}
{
  /* ④ 默认来源是本机、却一个能用的都没有。 */
  const r = buildEnvReport({ ...GOOD_FACTS, browsersUsable: 0, browserNames: [] },
    { defaultSource: 'app', defaultPort: '' })
  check('★ 默认是本机浏览器但一个能用的都没有 → 阻塞',
    r.blockers.some(b => b.includes('没找到能用的')), r.blockers.join(' / '))
}
{
  /* ⚠️ 反向：本机来源**不**该因为「CDP 端口没在听」而报错（那是另一条来源的事）。 */
  const r = buildEnvReport({ ...GOOD_FACTS, cdpPorts: [] },
    { defaultSource: 'app', defaultPort: '' })
  check('★ 默认是本机时，CDP 端口一个都没有**不算**阻塞（两条来源互不干涉）',
    r.blockers.length === 0, r.blockers.join(' / '))
}

/* ── ② 不该被当成错的那些（判据要稳，不能一开就红）───────────────────── */
console.log('')
console.log('=== ② 「没设」不等于「错」 ===')
{
  /* ⚠️ 留空是合法的「各标签自己选」。算成错的话，每个新用户一打开
   * 就看见一片红，这条功能就失去意义了（`checkRunnable` 才管真跑时的拦截）。 */
  const r = buildEnvReport({ ...GOOD_FACTS, cdpPorts: [9222] },
    { defaultSource: 'cdp', defaultPort: '' })
  check('★ 「没设默认端口」不算阻塞（合法的「各标签自己选」）',
    r.blockers.length === 0, r.blockers.join(' / '))
}
{
  /* 有端口在听、默认端口也留空 → 仍然不报。 */
  const r = buildEnvReport(GOOD_FACTS, { defaultSource: 'cdp', defaultPort: '  ' })
  check('★ 只有空格也算「没设」（trim 过）', r.blockers.length === 0, r.blockers.join(' / '))
  check('  报告里的 defaultPort 是 trim 后的值', r.defaultPort === '', JSON.stringify(r.defaultPort))
}
{
  /* gaps 多于一条时数量要对（文案里的 N 就是它）。 */
  const r = buildEnvReport({
    ...GOOD_FACTS,
    gaps: [
      { workflow: 'a', defId: 'x.y' },
      { workflow: 'b', defId: 'x.y' },
      { workflow: 'b', defId: 'z.w' },
    ],
  }, GOOD_PREFS)
  check('★ 缺的处数报的是总数（3 处，不是 2 种）',
    r.blockers.some(b => b.includes('3 处')), r.blockers.join(' / '))
}

/* ── ③ 扫「消失的节点类型」 ────────────────────────────────────────── */
console.log('')
console.log('=== ③ 哪些存档引用了消失的类型 ===')
const KNOWN = new Set(['browser.act', 'code.js', 'flow.if', 'flow.loop'])
{
  const items = [
    { name: '好的', doc: { nodes: [{ defId: 'browser.act' }, { defId: 'code.js' }] } },
    { name: '坏的', doc: { nodes: [{ defId: 'browser.act' }, { defId: 'ecom.gone' }] } },
  ]
  const gaps = scanNodeGaps(items, KNOWN)
  check('★ 揪出引用了消失类型的存档', gaps.length === 1 && gaps[0].workflow === '坏的'
    && gaps[0].defId === 'ecom.gone', JSON.stringify(gaps))
}
{
  /* ★ 分组框**不是**缺类型。它有**两种**存档形态，两种都要排掉：
   *   ① 新档：`type: 'group'`；
   *   ② 旧档：**没有 `type`**，但 `defId` 是 `'__group'`
   *      （`workflow-doc.ts` 的注释写明「旧档没写 type，但 defId 恰好是 `__group`」）。
   *
   * ⚠️ 这两条要**分开断言**：第一版只造了 ①，于是「只排 ①」的实现照样绿 ——
   * 而真机上旧编组会被误报成一串「`__group` 已经不在节点库里了」。
   * 漏的那条是后来补进测试的（补完立刻确认：去掉 `defId === '__group'` 这半会红）。 */
  const items = [{ name: '有编组的', doc: { nodes: [{ type: 'group', label: '一组' }, { defId: 'code.js' }] } }]
  const gaps = scanNodeGaps(items, KNOWN)
  check('★ 分组框·新档（type: "group"）**不**被误报', gaps.length === 0, JSON.stringify(gaps))

  const old = [{ name: '旧档的', doc: { nodes: [{ defId: '__group', label: '一组' }, { defId: 'code.js' }] } }]
  const oldGaps = scanNodeGaps(old, KNOWN)
  check('★ 分组框·**旧档**（只有 defId: "__group"、没有 type）**不**被误报',
    oldGaps.length === 0, JSON.stringify(oldGaps))
}
{
  /* 循环体成员带 parentId、有正常 defId —— 该查的照查。 */
  const items = [{ name: '有循环的', doc: { nodes: [{ defId: 'flow.loop' }, { defId: 'gone.too', parentId: 'n1' }] } }]
  const gaps = scanNodeGaps(items, KNOWN)
  check('★ 循环体成员里的消失类型也要揪出来',
    gaps.length === 1 && gaps[0].defId === 'gone.too', JSON.stringify(gaps))
}
{
  /* 脏档不能炸：doc 为 null / nodes 不是数组 / 节点不是对象。 */
  const items = [
    { name: '空档', doc: null },
    { name: '坏档', doc: { nodes: 'not-an-array' } },
    { name: '怪节点', doc: { nodes: [null, 42, { defId: 123 }, {}] } },
  ]
  let threw = null
  let gaps = null
  try { gaps = scanNodeGaps(items, KNOWN) } catch (e) { threw = e }
  check('★ 脏档不抛错（老档 / 手改坏的档）', threw === null, threw === null ? '' : String(threw))
  check('  脏档也不产生假缺口（defId 不是字符串就跳过）', gaps !== null && gaps.length === 0,
    JSON.stringify(gaps))
}

/* ── ④ 两侧分工（宿主半只给事实，不给结论）────────────────────────── */
console.log('')
console.log('=== ④ 宿主半 / 客户端的边界 ===')
{
  const hostSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const listSrc = readFileSync(new URL('../src/client/workbench/WorkflowList.tsx', import.meta.url), 'utf8')
  check('★ 宿主半有 /env-check 路由', hostSrc.includes('/api/ecom-workbench/env-check'))
  check('★ 它只接受 GET（只读）', /env-check'\s*&&\s*r\.method\s*===\s*'GET'/.test(hostSrc))
  check('★ 宿主半**不**判断「默认端口通不通」（它读不到 localStorage）',
    !hostSrc.includes('没在听'), '结论只该出现在客户端')
  check('★ 判定逻辑在客户端调用（buildEnvReport）', listSrc.includes('buildEnvReport'))
  /* 2026-10-27 改（票 22）：这一条原来判「声明式依赖未实现这件事被显式报出」
   * （`depsImplemented: false` + 界面那句「声明式依赖」）。
   *
   * ⚠️ **判据的前提变了，不是为了让测试变绿而放宽**：依赖判定实现了，
   * `depsImplemented` 现在是 `true`，界面上也不再是「还没做」而是「缺哪些、怎么装」。
   * 所以这里改成判**新的事实**，而且判得更紧：它不只要求「有话说」，
   * 还要求「说得出缺哪个节点、缺什么」。真正的详细断言在 `tests/node-deps.mjs`。
   *
   * 原来那条防的是「假装查过了」；现在换成：不许把「没查」说成「没缺」
   * （老宿主半那一条分支必须留着）。 */
  check('★ 依赖判定已实现（不再是「未实现」那句）',
    hostSrc.includes('depsImplemented: true') && !hostSrc.includes('depsImplemented: false'),
    hostSrc.includes('depsImplemented: true') ? 'depsImplemented: true' : '没找到')
  check('★★ 界面把缺件的节点逐条说出来（含怎么装）',
    listSrc.includes('depsMissing') && listSrc.includes('data-ewb-env-dep-reason'))
  check('★★ 但「没查到」那条分支还在（老宿主半时不许说成「没缺」）',
    listSrc.includes('!env.depsImplemented'))
  /* ⚠️ 这个按钮要探端口（约 2 秒），**不能在挂载时自动跑** ——
   * 用户只是来看列表时不该付这个等待。 */
  const effects = [...listSrc.matchAll(/useEffect\(\(\)\s*=>\s*\{([^}]*)\}/g)].map(m => m[1])
  check('★ 不在挂载时自动跑（只在点按钮时跑）',
    listSrc.includes('onClick={checkEnv}') && !effects.some(b => b.includes('checkEnv')))
  check('★ 先给结论（环境就绪 / 有 N 件事要先解决）',
    listSrc.includes('环境就绪') && listSrc.includes('件事要先解决'))
}

console.log('')
console.log(failed === 0 ? '结论：环境检测的判定与两侧分工都对 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
