/** 浏览器偏好「落盘 + 补进节点规格」的测试（用户 2026-10-20）。
 *
 * ## 为什么必须单测
 *
 * 这个 bug 的形态是「从画布跑得了、从列表启动报找不到浏览器」。两边的分叉点是：
 *
 *   - 画布：`syncBrowserLayer` 把偏好写进节点参数 → 存档/内存里就有 port；
 *   - 列表 / 定时：宿主半直接读存档 → **存档里从来没有 port**。
 *
 * 所以判据必须盯**宿主半那条路补上了没**，而不是「有没有写文件」。
 *
 * 三件事：
 *   ① `normalizePrefs` 容错（缺字段 / 手改坏 / 老形状都能用）；
 *   ② `applyPrefsToSpecs` 把偏好补进节点（缺才补、不覆盖用户填的）；
 *   ③ 真实存档跑 `toRunSpecs` + `applyPrefsToSpecs` 之后，浏览器节点**有 port**。
 *
 * 跑法：node --import <tsx> tests/browser-prefs.mjs
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizePrefs, applyPrefsToSpecs, PREFS_FILE } from '../src/workflow/browser-prefs.ts'
import { toRunSpecs } from '../src/workflow/specs.ts'
import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { saveWorkflow } from '../src/workflow/store.ts'
import { runWorkflowFile } from '../src/workflow/run-file.ts'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== ① normalizePrefs 容错 ===')
{
  const empty = normalizePrefs(null)
  check('null → 一份可用的空偏好', empty.defaultSource === 'cdp' && empty.defaultPort === '')
  /* ⚠️ 必须**不**补默认端口 —— 用户 2026-10-14 明确定过「端口不能硬编码」。 */
  check('★★ 空偏好里没有默认端口（不能硬编码）', empty.defaultPort === '', JSON.stringify(empty.defaultPort))

  const weird = normalizePrefs({ defaultPort: 9222, tags: { 天猫: { port: 9223, source: 'cdp' }, '': { port: '1' } } })
  check('★ 数字端口被转成可用的形状', String(weird.defaultPort) === '9222', JSON.stringify(weird.defaultPort))
  check('★ 空标签名被丢掉', Object.keys(weird.tags).length === 1, Object.keys(weird.tags).join(','))
  check('★ 标签的 launcher 由 source 推导', weird.tags['天猫']?.launcher === 'cdp', String(weird.tags['天猫']?.launcher))

  const bad = normalizePrefs('不是对象')
  check('★ 字符串输入不炸、退回空偏好', bad.defaultSource === 'cdp')
}

console.log('')
console.log('=== ② applyPrefsToSpecs：缺才补、不覆盖 ===')
{
  const prefs = normalizePrefs({
    defaultSource: 'cdp', defaultPort: '9222',
    tags: { 天猫: { source: 'cdp', port: '9333', exePath: '', openMode: 'headed', launcher: 'cdp' } },
  })
  /** 造一个最小规格。
   * @param id - 节点类型 id。
   * @param params - 参数。
   * @returns 规格。 */
  const spec = (id, params) => ({ id: 'n1', def: { id, params: {} }, params })

  const a = spec('browser.act', { session: '天猫' })
  const n1 = applyPrefsToSpecs([a], prefs)
  check('★ 补了 1 个节点', n1 === 1, String(n1))
  check('★★ 标签自己配的端口被补上（9333，不是全局 9222）', a.params.port === '9333', JSON.stringify(a.params.port))
  check('★ launcher 也补上了', a.params.launcher === 'cdp', String(a.params.launcher))

  /* 用户显式填过 → 不动。 */
  const b = spec('browser.act', { session: '天猫', port: '9999' })
  applyPrefsToSpecs([b], prefs)
  check('★★ 用户显式填的端口不被覆盖', b.params.port === '9999', JSON.stringify(b.params.port))

  /* 标签没配过 → 跟全局默认。 */
  const c = spec('browser.act', { session: '别的标签' })
  applyPrefsToSpecs([c], prefs)
  check('★ 没配过的标签跟全局默认端口', c.params.port === '9222', JSON.stringify(c.params.port))

  /* 非浏览器节点不动。 */
  const d = spec('code.js', { code: 'x' })
  const n2 = applyPrefsToSpecs([d], prefs)
  check('★ code.js 不被碰', n2 === 0 && d.params.port === undefined)

  /* 全局也没端口 → 不补（让驱动明确报「没填端口」，比瞎猜好）。 */
  const none = normalizePrefs({ defaultSource: 'cdp', defaultPort: '' })
  const e = spec('browser.act', { session: '天猫' })
  applyPrefsToSpecs([e], none)
  check('★ 全局没端口时不瞎补', e.params.port === undefined, JSON.stringify(e.params.port))
}

console.log('')
console.log('=== ③ 真实存档：跑之前补上 port ===')
{
  const DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
  const F = join(DIR, '取数-天猫生意参谋.json')
  check('天猫存档存在', existsSync(F), F)
  if (existsSync(F)) {
    const doc = JSON.parse(readFileSync(F, 'utf8'))
    const { nodes } = toRunSpecs(doc, NODE_LIBRARY)
    const browsers = nodes.filter(n => n.def.id === 'browser.act' || n.def.id === 'browser.download')
    check('存档里有浏览器节点', browsers.length > 0, String(browsers.length))
    /* ⚠️ 这份存档里**本来没有可用的 port** —— 那正是 bug 的成因，先钉住这个事实。
     *
     * 判据是「空」而不是「undefined」：画布写回存档时把没配的值写成**空串**
     * （`syncBrowserLayer` 一律写三个字段）。两种形态对驱动是同一件事 ——
     * 都等于「没填端口」。 */
    check('★★ 存档里本来没有端口（所以从列表启动失败）',
      browsers.every(n => n.params.port === undefined || n.params.port === ''),
      browsers.map(n => JSON.stringify(n.params.port)).join(','))

    const prefs = normalizePrefs({ defaultSource: 'cdp', defaultPort: '9222', tags: {} })
    applyPrefsToSpecs(nodes, prefs)
    check('★★ 补完之后每个浏览器节点都有 port',
      browsers.every(n => typeof n.params.port === 'string' && n.params.port !== ''),
      browsers.map(n => JSON.stringify(n.params.port)).join(','))
  }
}

console.log('')
console.log('=== ④ 偏好文件名对得上（宿主半与画布都认它）===')
{
  check('PREFS_FILE 是 browser-prefs.json', PREFS_FILE === 'browser-prefs.json', PREFS_FILE)
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  check('★ 宿主半路由用的是同一个常量', host.includes('PREFS_FILE'))
  check('★★ 宿主半有 /browser/prefs 的 GET 与 POST',
    host.includes("'/api/ecom-workbench/browser/prefs' && r.method === 'GET'")
    && host.includes("'/api/ecom-workbench/browser/prefs' && r.method === 'POST'"))
  /* ⚠️ **三条**跑路都要传 prefs：`/workflow/run-stream`（流式）、`/workflow/run`（列表）、
   * 以及 **2026-10-21 新增的「恢复挂起的运行」**（`resumePausedRun`）——
   * 恢复同样不经过画布，不补端口的话「挂起后继续」会在浏览器节点上失败。
   *
   * 判据用「至少 3 处」而不是精确等于：将来再加一条跑路（比如「批量执行」）
   * 不该让这条测试假红；而**少一处**是真问题，必须红。 */
  const count = (host.match(/prefs: await readBrowserPrefs\(\)/g) ?? []).length
  check('★★ 三条跑路都传了 prefs（流式 + 列表 + 恢复）', count >= 3, String(count))
}

console.log('')
console.log('=== ⑤ 真的跑一次：派发出去的浏览器节点带上了 port ===')
{
  /* ## 为什么必须有这一段
   *
   * 上面 ③ 只证明了「纯函数能补」—— 而 bug 可能出在**没人调用它**
   * （`run-file.ts` 里漏了那一行）。自证时把调用改成 `void 0`，
   * ③ 照样全绿 → **假绿**。
   *
   * 所以这里真的跑一次 `runWorkflowFile`，把派发出去的命令抓下来看。
   * 这条一旦断，就是用户报的那个「从列表启动找不到浏览器」。 */
  const TMP = mkdtempSync(join(tmpdir(), 'ewb-prefs-'))
  process.env.EWB_TEST_HOME = TMP
  /* 先存一份最小工作流：一个浏览器节点（只有 session，没有 port）。 */
  await saveWorkflow({
    version: 1,
    id: 'wf-test-prefs',
    name: '偏好测试',
    nodes: [{
      id: 'n1', type: 'v1', defId: 'browser.act', position: { x: 0, y: 0 },
      params: { action: 'goto', session: '天猫', url: 'https://example.com/' },
      onError: 'stop', skipped: false, label: '打开页面',
    }],
    edges: [],
  }, '偏好测试')

  /** 抓到的派发命令。 */
  const seen = []
  const res = await runWorkflowFile('偏好测试', NODE_LIBRARY, async (req) => {
    seen.push(req)
    return { ok: true, status: 'success', output: { url: 'https://example.com/' }, logs: [] }
  }, {
    workdir: TMP,
    prefs: { defaultSource: 'cdp', defaultPort: '9222', tags: {} },
  })
  check('跑起来了', res.ok === true, JSON.stringify(res.error ?? ''))
  check('派发了 1 个节点', seen.length === 1, String(seen.length))
  const p = seen[0]?.command?.params ?? {}
  check('★★ 派发出去的命令里带上了 port（这就是从列表启动能用的关键）',
    String(p.port ?? '') === '9222', JSON.stringify(p.port))
  check('★ launcher 也带上了', String(p.launcher ?? '') === 'cdp', JSON.stringify(p.launcher))
  rmSync(TMP, { recursive: true, force: true })
}

console.log('')
console.log(failed === 0 ? '结论：浏览器偏好接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
