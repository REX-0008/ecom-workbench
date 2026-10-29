/** 宿主半端到端测试：路由注册 → 派发 → 内置节点真跑 → 错误路径。
 *
 * 为什么必须有这个测试：
 *   「构建通过」不代表运行时正常。上一轮就是这么漏掉了一个真 bug——
 *   内置节点按**实例编号**查函数（应该按**节点类型**），四个节点全部查不到。
 *   这个测试直接调 lib/index.js 里编译好的 apply()，走完整 HTTP 路径，一跑就抓到。
 *
 * 跑法：node tests/host-dispatch.mjs
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 存档测试的沙箱目录：必须在载入插件之前设好（模块读环境变量定目录）。 */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), "ewb-test-"))
/* 「已安装 skill」的根也要指到沙箱 —— 否则收藏那几条路由会去扫/动**真实的**
 * $DSH_HOME/skills 目录（红线）。 */
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, "skills")
/* 「打开目录」类路由（`/workflow/open`、`/collect/open`）会真的**弹资源管理器窗口**。
 * 测试里设这个闸门 → 只记录请求的目录、不起进程（见 `src/index.ts` 的闸门说明）。
 * ⚠️ 必须与上面两个一样，在 `import("../lib/index.js")` **之前**设好。 */
process.env.EWB_TEST_NO_SPAWN = '1'
const { apply, lastOpenedDirForTest } = await import("../lib/index.js")
/** 读闸门记下的「最近请求打开的目录」。 */
const lastOpenedDir = () => lastOpenedDirForTest()

/** 捕获到的路由处理函数（apply 注册进来的）。 */
let handler = null

/** 假上下文：只提供 apply 需要的那两个方法，把路由抓下来。 */
/** 假的 subprocess 服务：记下收到的规格，返回一个立刻成功的假句柄。
 * 用途：验证 shell 执行方**按 dsh 的真接口**调用（stdio 与 graceMs 必须给全）。 */
let lastSpec = null
const fakeSub = {
  spawn(spec) {
    lastSpec = spec
    return {
      pid: 1234,
      terminate() { /* 假句柄不需要真终止 */ },
      waitForExit: async () => true,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '假的输出', nextOffset: 4, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }
  },
}

const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ webServer: { register(route) { handler = route.handler; return () => { /* 清理 */ } } } })
    }
    if (names.includes('subprocess')) fn({ subprocess: fakeSub })
  },
  effect() { return () => { /* 清理 */ } },
}

apply(fakeCtx)
console.log('① 路由注册:', handler === null ? '失败 ✗' : '成功 ✓')

/**
 * 模拟一次 HTTP 调用（用真的 Readable 当请求体，走真的 JSON 解析）。
 * @param method - 请求方法。
 * @param url - 请求路径。
 * @param body - 请求体（可选）。
 * @returns 解析后的响应 JSON。
 */
async function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let out = ''
  res.writeHead = () => { /* 忽略状态码 */ }
  res.end = (s) => { out = s }
  res.writableEnded = false
  await handler(req, res)
  return JSON.parse(out)
}

/** 造一条派发请求。 */
function req(node, params, upstream, executor = 'builtin') {
  return { runId: 'test', nodeId: 'n-test', executor, command: { node, params }, context: { workflowId: 'w', upstream, workdir: process.cwd() } }
}

/** 累计失败数（最后决定退出码）。 */
let bad = 0

/**
 * 断言一条，打印结果。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 打印的细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

const health = await call('GET', '/api/ecom-workbench/health')
check('健康检查返回 ok', health.ok === true, JSON.stringify(health))
check('健康检查带工作目录', typeof health.workdir === 'string' && health.workdir !== '')

const r1 = await call('POST', '/api/ecom-workbench/run', [req('code.js', { code: 'return input.map(x => x * 3)', timeout: 5000 }, [[1, 2, 3]])])
check('内置节点按类型查到并真跑', r1.results?.[0]?.status === 'success' && JSON.stringify(r1.results[0].output) === '[3,6,9]', JSON.stringify(r1.results?.[0]))
check('返回日志行', Array.isArray(r1.results?.[0]?.logs) && r1.results[0].logs.length > 0)

const r2 = await call('POST', '/api/ecom-workbench/run', [req('sys.fs.write', { path: '' }, [])])
check('写文件缺路径 → 失败且说明原因', r2.results?.[0]?.status === 'failed' && String(r2.results[0].error).includes('路径'), JSON.stringify(r2.results?.[0]))

const r3 = await call('POST', '/api/ecom-workbench/run', [req('no.such.node', {}, [])])
check('不存在的节点类型 → 失败', r3.results?.[0]?.status === 'failed', JSON.stringify(r3.results?.[0]))

const r4 = await call('POST', '/api/ecom-workbench/run', [
  req('flow.delay', { ms: 20 }, ['原样传下去']),
  req('code.js', { code: 'return "第二个"', timeout: 5000 }, [])
])
check('一次请求可派发多个节点', r4.results?.length === 2 && r4.results[0].status === 'success' && r4.results[1].status === 'success', JSON.stringify(r4.results?.map(x => x.status)))
check('延迟节点原样传上游', JSON.stringify(r4.results?.[0]?.output) === '"原样传下去"')

/* shell 执行方：必须按 dsh 的真接口传规格（stdio + graceMs 缺一不可，否则真机会抛错） */
const r5 = await call('POST', '/api/ecom-workbench/run', [{
  runId: 'sh', nodeId: 'n-sh', executor: 'shell',
  command: { argv: ['cmd.exe', '/c', 'echo hello'], cwd: process.cwd() },
  context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
}])
check('shell 执行方跑到成功', r5.results?.[0]?.status === 'success', JSON.stringify(r5.results?.[0]))
check('给了 stdio（三路齐全）', lastSpec !== null && lastSpec.stdio?.stdin === 'ignore' && lastSpec.stdio?.stdout?.maxBytes > 0 && lastSpec.stdio?.stderr?.maxBytes > 0)
check('给了 graceMs（正数）', lastSpec !== null && typeof lastSpec.graceMs === 'number' && lastSpec.graceMs > 0)
check('给了 cwd', lastSpec !== null && typeof lastSpec.cwd === 'string' && lastSpec.cwd !== '')


/* ── 工作流存档（保存 / 打开 / 删除 / 路径安全）──────────────────
 * 指向临时目录，不污染真实数据目录。 */
const SANDBOX = process.env.EWB_TEST_HOME
check('测试用沙箱目录已注入', typeof SANDBOX === 'string' && SANDBOX !== '')

const doc1 = { version: 1, nodes: [{ id: 'n1', defId: 'code.js' }], edges: [] }
const s1 = await call('POST', '/api/ecom-workbench/workflows', { name: '测试工作流', doc: doc1 })
check('保存返回 ok', s1.ok === true, JSON.stringify(s1))
check('保存给出实际路径', typeof s1.path === 'string' && s1.path.endsWith('.json'), s1.path)
const fsMod = await import('node:fs/promises')
check('文件真的写到盘上', await fsMod.readFile(s1.path, 'utf8').then(() => true).catch(() => false))

const l1 = await call('GET', '/api/ecom-workbench/workflows')
check('列表里有刚存的那份', Array.isArray(l1.items) && l1.items.some(x => x.name === '测试工作流'), JSON.stringify(l1.items))

const g1 = await call('GET', '/api/ecom-workbench/workflow?name=' + encodeURIComponent('测试工作流'))
/* ⚠️ **2026-10-19 改判据**：原先是「整份 JSON 逐字相等」。现在保存时宿主半会
 * 补两样东西 —— 稳定编号 `id`（引用认它）与同步成文件名的 `name` ——
 * 所以逐字相等**必然不成立**，而它红得不对（功能是对的）。
 *
 * 现在按「该相同的必须相同、该补上的必须补上」分开查：
 *   · 用户自己写的内容（nodes / edges / version）一个字都不许变；
 *   · `id` 必须有个非空值（这是本次改动的要求）；
 *   · `name` 必须等于文件名（改名不断引用的前提，见 `ids.ts`）。 */
const back = g1.doc ?? {}
check('读回来内容一致（节点与连线一个字都没变）',
  JSON.stringify({ version: back.version, nodes: back.nodes, edges: back.edges })
  === JSON.stringify({ version: doc1.version, nodes: doc1.nodes, edges: doc1.edges }),
  JSON.stringify(back))
check('★ 存档带上了稳定编号 id', typeof back.id === 'string' && back.id !== '', JSON.stringify(back.id))
check('★ 文件里的 name 同步成了文件名', back.name === '测试工作流', JSON.stringify(back.name))

const g2 = await call('GET', '/api/ecom-workbench/workflow?name=' + encodeURIComponent('不存在的名字'))
check('读不存在 → 明确提示', String(g2.error).includes('没有这份工作流'), JSON.stringify(g2))

/* 路径安全：名字里带 ../ 不能写到目录外面去 */
const evil = await call('POST', '/api/ecom-workbench/workflows', { name: '../../逃逸测试', doc: { x: 1 } })
const dir = String(l1.dir).replace(/[\\/]+$/, '')
check('恶意名字被清洗、进不了上级目录', evil.path.startsWith(dir), evil.path)

const d1 = await call('DELETE', '/api/ecom-workbench/workflow?name=' + encodeURIComponent('测试工作流'))
check('删除成功', d1.ok === true, JSON.stringify(d1))
const g3 = await call('GET', '/api/ecom-workbench/workflow?name=' + encodeURIComponent('测试工作流'))
check('删掉后读不到', g3.error !== undefined)

const d2 = await call('DELETE', '/api/ecom-workbench/workflow?name=' + encodeURIComponent('本来就没有'))
check('删不存在 → ok:false（不抛错）', d2.ok === false)


/* ── 运行记录里要能看到「这一步产出了什么」───────────────────── */
const rr = await call('POST', '/api/ecom-workbench/run', [req('code.js', { code: 'return { items: [1,2,3] }', timeout: 5000 }, [])])
check('运行成功后能读到记录', rr.results?.[0]?.status === 'success')
const runs = await call('GET', '/api/ecom-workbench/runs')
const withOut = Array.isArray(runs) ? runs.find(x => x.outputPreview !== undefined) : undefined
check('记录里有输出摘要', withOut !== undefined && String(withOut.outputPreview).includes('items'), JSON.stringify(withOut?.outputPreview))
check('记录里带节点类型 id', withOut !== undefined && withOut.defId === 'code.js', String(withOut?.defId))
check('记录带起止时间（可算耗时）', withOut !== undefined && typeof withOut.endedAt === 'number' && withOut.endedAt >= withOut.startedAt)


/* ── 版本快照（存 / 列 / 读 / 路径安全）──────────────────────── */
const snapDoc = { version: 1, nodes: [{ id: 's1', defId: 'code.js' }], edges: [] }
const ss1 = await call('POST', '/api/ecom-workbench/snapshots', { name: '快照测试流', doc: snapDoc })
check('存快照返回 ok', ss1.ok === true, JSON.stringify(ss1))
check('快照名是时间戳形式', typeof ss1.snap === 'string' && ss1.snap.length >= 19, String(ss1.snap))
check('快照文件真在盘上', await fsMod.readFile(ss1.path, 'utf8').then(() => true).catch(() => false))

const sl1 = await call('GET', '/api/ecom-workbench/snapshots?name=' + encodeURIComponent('快照测试流'))
check('列表里有刚存的快照', Array.isArray(sl1.snaps) && sl1.snaps.length === 1, JSON.stringify(sl1.snaps))

const sg1 = await call('GET', '/api/ecom-workbench/snapshot?name=' + encodeURIComponent('快照测试流') + '&snap=' + encodeURIComponent(ss1.snap))
check('读回内容一致', JSON.stringify(sg1.doc) === JSON.stringify(snapDoc), JSON.stringify(sg1.doc))

const sg2 = await call('GET', '/api/ecom-workbench/snapshot?name=' + encodeURIComponent('快照测试流') + '&snap=不存在')
check('读不存在的快照 → 明确提示', String(sg2.error).includes('没有这份快照'), JSON.stringify(sg2))

const sl2 = await call('GET', '/api/ecom-workbench/snapshots?name=' + encodeURIComponent('从没存过的流'))
check('没存过的工作流 → 空列表（不报错）', Array.isArray(sl2.snaps) && sl2.snaps.length === 0)

/* 路径安全：快照名里带 ../ 不能读到目录外面 */
const evil2 = await call('GET', '/api/ecom-workbench/snapshot?name=' + encodeURIComponent('../../逃逸') + '&snap=' + encodeURIComponent('../../etc/passwd'))
check('恶意快照名读不到东西', evil2.error !== undefined, JSON.stringify(evil2))


/* ── 工作流列表要带「看得出是哪一份」的信息 ────────────────── */
const ld = await call('POST', '/api/ecom-workbench/workflows', { name: '列表字段测试', doc: { version: 1, nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ id: 'e1' }, { id: 'e2' }] } })
check('存一份用于测列表', ld.ok === true)
const lf = await call('GET', '/api/ecom-workbench/workflows')
const one = Array.isArray(lf.items) ? lf.items.find(x => x.name === '列表字段测试') : undefined
check('列表带节点数', one !== undefined && one.nodes === 3, JSON.stringify(one))
check('列表带连线数', one !== undefined && one.edges === 2)
check('列表带修改时间（列表界面要显示「什么时候改的」）', one !== undefined && typeof one.at === 'number' && one.at > 0)
check('列表带存放目录（用户要知道文件存哪了）', typeof lf.dir === 'string' && lf.dir !== '')


/* ── 删除工作流（列表页的「删除」按钮用）────────────────────── */
const da = await call('POST', '/api/ecom-workbench/workflows', { name: '待删除的流', doc: { version: 1, nodes: [], edges: [] } })
check('先存一份用来删', da.ok === true)
const dd = await call('DELETE', '/api/ecom-workbench/workflow?name=' + encodeURIComponent('待删除的流'))
check('删除成功', dd.ok === true, JSON.stringify(dd))
const l3 = await call('GET', '/api/ecom-workbench/workflows')
check('列表里已经没有了', !(l3.items ?? []).some(x => x.name === '待删除的流'))
const dd2 = await call('DELETE', '/api/ecom-workbench/workflow?name=' + encodeURIComponent('根本不存在'))
check('删不存在的 → 明确失败（不装作成功）', dd2.ok === false, JSON.stringify(dd2))

const r6 = await call('GET', '/api/ecom-workbench/nope')
check('未知路径 → 404 提示', String(r6.error).includes('not found'), JSON.stringify(r6))

/* ── 「打开目录」（工作流列表主行上的新按钮，用户 2026-10-14 要求）──────
 *
 * ⚠️ 这条路由会**真的弹资源管理器窗口**，所以文件顶部已设 `EWB_TEST_NO_SPAWN=1`：
 * 闸门开着时只记录目录、不起进程。这样测试仍验到**真正重要的部分** ——
 * 路径算得对不对、名字有没有被清洗、以及「客户端只发名字不发路径」那条安全约定。 */
const wo = await call('POST', '/api/ecom-workbench/workflow/open', { name: '测试工作流' })
check('打开目录返回 ok', wo.ok === true, JSON.stringify(wo))
check('★ 返回的是**工作流存放目录**（不是别处）',
  typeof wo.path === 'string' && /workflows$/.test(String(wo.path).replace(/[\\/]+$/, '')), String(wo.path))
check('★ 真的请求打开那个目录（闸门记录）',
  lastOpenedDir() !== '' && lastOpenedDir() === wo.path, lastOpenedDir())
check('目录在沙箱里（没跑到真实数据目录）',
  String(wo.path).includes(String(process.env.EWB_TEST_HOME)), String(wo.path))

/* 路径安全：名字里带 `../` **不能**改变被打开的目录。 */
const woEvil = await call('POST', '/api/ecom-workbench/workflow/open', { name: '../../逃逸' })
check('★ 恶意名字仍只打开工作流目录（清洗生效）',
  woEvil.path === wo.path && lastOpenedDir() === wo.path, JSON.stringify({ got: woEvil.path, want: wo.path }))

/* 没给名字 → 明确失败（不静默什么都不发生）。 */
const woNoName = await call('POST', '/api/ecom-workbench/workflow/open', {})
check('没给名字 → 明确失败', woNoName.ok !== true && String(woNoName.error).includes('name'), JSON.stringify(woNoName))

/* 不存在的名字：**照样开目录**（用户可能正要去那里找它），但如实回报 exists:false。 */
const woNone = await call('POST', '/api/ecom-workbench/workflow/open', { name: '根本没这份' })
check('打开不存在的名字：仍开目录、但如实说它不在', woNone.ok === true && woNone.exists === false, JSON.stringify(woNone))

/* ── 收藏：skill 扫描 / 备注 / 搬移（走真路由）──────────────────
 * 这几条路由会**真的动文件**，所以全程在沙箱里；下面先在沙箱里造两个 skill。 */
import { mkdir, writeFile, stat } from 'node:fs/promises'
const skillsRoot = process.env.EWB_TEST_SKILLS
async function seed(name, desc) {
  await mkdir(join(skillsRoot, name), { recursive: true })
  await writeFile(join(skillsRoot, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "${desc}"\n---\n\n正文 ${name}\n`, 'utf8')
}
await seed('route-a', '路由测试用的 skill')
await seed('route-b', '第二个')

const cl1 = await call('GET', '/api/ecom-workbench/collect/list')
check('收藏列表能列出已装 skill', Array.isArray(cl1.skills) && cl1.skills.some(s => s.name === 'route-a'), JSON.stringify(cl1.skills?.map(s => s.name)))
check('列表带备注表（界面要拿它渲染备注）', cl1.notes !== undefined && typeof cl1.notes.skills === 'object')
check('列表回两侧的根目录（让用户看到扫的是哪些目录）',
  Array.isArray(cl1.roots?.installed) && Array.isArray(cl1.roots?.collected), JSON.stringify(cl1.roots))

const rb = await call('GET', '/api/ecom-workbench/collect/skill?name=' + encodeURIComponent('route-a'))
check('能读单个 skill 的正文（供预览）', typeof rb.text === 'string' && rb.text.includes('正文 route-a'), JSON.stringify(rb).slice(0, 120))
check('正文里带「在哪一侧」', rb.where === 'installed')

const rbevil = await call('GET', '/api/ecom-workbench/collect/skill?name=' + encodeURIComponent('../secret'))
check('越界的 skill 名读不到（安全边界）', rbevil.error !== undefined, JSON.stringify(rbevil))

const wn = await call('POST', '/api/ecom-workbench/collect/notes', {
  skills: { 'route-a': { note: '以后也许要用', repo: 'https://github.com/a/b' } },
  plugins: [{ name: '某插件', note: '临时看的' }],
  projects: [],
})
check('备注能保存', wn.ok === true, JSON.stringify(wn))
const cl2 = await call('GET', '/api/ecom-workbench/collect/list')
check('备注保存后能读回（刷新不丢）', cl2.notes?.skills?.['route-a']?.note === '以后也许要用', JSON.stringify(cl2.notes?.skills))
check('插件条目存住了', cl2.notes?.plugins?.[0]?.name === '某插件')

const mv = await call('POST', '/api/ecom-workbench/collect/move', { name: 'route-a', to: 'collect' })
check('搬到收藏成功', mv.ok === true, JSON.stringify(mv))
check('源目录真的没了', await stat(join(skillsRoot, 'route-a')).then(() => false).catch(() => true))
check('生成了备份', typeof mv.backup === 'string' && await stat(mv.backup).then(() => true).catch(() => false))
const cl3 = await call('GET', '/api/ecom-workbench/collect/list')
check('列表里它已变成「收藏」侧', cl3.skills?.find(s => s.name === 'route-a')?.where === 'collected', JSON.stringify(cl3.skills?.find(s => s.name === 'route-a')))
check('搬走后备注还在（备注按名字存，不随目录走）', cl3.notes?.skills?.['route-a']?.note === '以后也许要用')

const mv2 = await call('POST', '/api/ecom-workbench/collect/move', { name: 'route-a', to: 'install' })
check('搬回已安装成功', mv2.ok === true, JSON.stringify(mv2))
check('搬回后确实在已安装侧', await stat(join(skillsRoot, 'route-a')).then(() => true).catch(() => false))

const mvbad = await call('POST', '/api/ecom-workbench/collect/move', { name: '../escape', to: 'collect' })
check('越界名字搬移被拒', mvbad.ok === false, JSON.stringify(mvbad))

/* 打开目录（用户 2026-10-11 要求）。
 * ⚠️ 这几条**只验到路由的判定**，不真去弹资源管理器 ——
 * 弹窗会打断用户，测试不该有这种副作用。
 * 关键是**安全边界**：客户端只许给 skill 名，路径必须由宿主半自己解析。 */
const opBad = await call('POST', '/api/ecom-workbench/collect/open', { name: '../../windows' })
check('打开目录：越界名字被拒（不能打开任意位置）', opBad.error !== undefined, JSON.stringify(opBad))
const opNone = await call('POST', '/api/ecom-workbench/collect/open', { name: '根本不存在的skill' })
check('打开目录：不存在的 skill → 明确失败', opNone.error !== undefined, JSON.stringify(opNone))

/* ── 无界面执行：拿整份工作流文件跑完（用户 2026-10-11 要求）──────────
 *
 * 这是本轮的核心能力：**不开画布也能跑工作流**。
 * 之前跑工作流的逻辑住在画布组件里，工作台一关就没了；
 * 现在宿主半用共用的调度器（workflow/run.ts）自己跑。
 *
 * 这里用真实路由 + 真内置节点（code.js）跑一条两节点的链：
 *   节点1 把 [1,2,3] 乘 2  →  节点2 取上游再乘 10
 * 靠这条验证「顺序 + 上游数据传递」在宿主半这一侧真的成立。 */
const wfDoc = {
  version: 1,
  name: '无界面执行测试',
  nodes: [
    { id: 'n1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return input.map(x => x * 2)' }, onError: 'stop' },
    /* ⚠️ `code.js` 的输入约定：**只有一个上游时 `input` 就是那个值本身**，
     * 不是数组（见 src/dispatch/builtins.ts 的 runCodeFn：
     * `input = upstream.length === 1 ? upstream[0] : upstream`）。
     * 第一版我写成 `input[0].map(...)`，于是 n2 拿到的是 `[2,4,6]` 的第一个元素
     * 而不是数组，报「Cannot read properties of undefined」——
     * 那是**测试用例写错**，不是调度器的问题（探针日志里看得很清楚）。 */
    { id: 'n2', defId: 'code.js', position: { x: 300, y: 0 }, params: { code: 'return input.map(x => x * 10)' }, onError: 'stop' },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
}
await call('POST', '/api/ecom-workbench/workflows', { name: '无界面执行测试', doc: wfDoc })
const runRes = await call('POST', '/api/ecom-workbench/workflow/run', { name: '无界面执行测试' })
check('无界面执行：整份跑成功', runRes.ok === true, JSON.stringify(runRes).slice(0, 160))
check('无界面执行：按顺序跑了两个节点', Array.isArray(runRes.ran) && runRes.ran.join(',') === 'n1,n2', JSON.stringify(runRes.ran))
check('无界面执行：没有中断', runRes.aborted === false)
check('无界面执行：有运行日志（用户看得到发生了什么）', Array.isArray(runRes.logs) && runRes.logs.length > 0,
  String(runRes.logs?.length ?? 0) + ' 条')

/* 上游数据真的传下去了吗 —— 看第二个节点有没有跑成。
 * 它的代码是 `input[0].map(...)`：如果上游没传过来，input[0] 会是 undefined → 必然失败。
 * 所以「两个节点都成功」就等于「上游传递成立」。 */
const runRes2 = await call('POST', '/api/ecom-workbench/workflow/run', { name: '无界面执行测试' })
check('无界面执行：上游数据确实传给了下游（否则第二个节点必失败）',
  runRes2.ok === true && runRes2.ran?.includes('n2'), JSON.stringify(runRes2).slice(0, 160))

const missDoc = { version: 1, name: '跑不存在的', nodes: [], edges: [] }
await call('POST', '/api/ecom-workbench/workflows', { name: '跑不存在的', doc: missDoc })
const runEmpty = await call('POST', '/api/ecom-workbench/workflow/run', { name: '跑不存在的' })
check('无界面执行：没有节点的档 → 明确失败（不装作跑成功）', runEmpty.ok === false, JSON.stringify(runEmpty))
const runNone = await call('POST', '/api/ecom-workbench/workflow/run', { name: '根本没这份' })
check('无界面执行：不存在的工作流 → 明确失败', runNone.ok === false, JSON.stringify(runNone))
const runNoName = await call('POST', '/api/ecom-workbench/workflow/run', {})
check('无界面执行：没给名字 → 明确失败', runNoName.error !== undefined, JSON.stringify(runNoName))

/* ── 端到端：含「循环 + 条件分流」的工作流，从存档跑到出结果 ────────────
 *
 * ⚠️ 这一段的价值在于**跨层**：前面的断言各自测一层（循环计划、分支约定、调度执行），
 * 这里走的是「存档 JSON → toRunSpecs 读 parentId → runGraph 解释执行 →
 * 内置函数真跑」的**完整链路**。任何一环漏接（比如 toRunSpecs 没读 parentId）
 * 前几层都测不出来。
 *
 * 形状：
 *   gen(造 3 项数组) → L(循环) → 里: body(累加/记录)
 *   另一个工作流测条件分流：gate → IF ─true─→ yes
 *                                      └false─→ no
 */
{
  /* ① 循环：内置 `code.js` 造数组，循环体也是一个 `code.js`（记录每轮 item）。 */
  const loopDoc = {
    version: 1,
    name: '端到端循环',
    nodes: [
      { id: 'gen', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return [1,2,3]' }, onError: 'stop' },
      /* ⚠️ **2026-10-13 改**：循环的输入不再靠 `gen → L` 那条跨边界连线
       * （循环节点上的端口已删，照 Dify —— 它的迭代节点**零 Handle**）。
       * 改成参数选择器 `items: { nodeId, field }`，这就是 Dify 的 `iterator_selector`。 */
      { id: 'L', defId: 'flow.loop', position: { x: 300, y: 0 }, params: { mode: 'items', items: { nodeId: 'gen', field: '' }, maxIters: 100 }, onError: 'stop' },
      /* ⚠️ `parentId: 'L'` 是这一段的核心 —— 少了它体节点就不在循环里，
       * 会变成「跑一次」而不是「跑 3 次」。 */
      { id: 'body', defId: 'code.js', parentId: 'L', position: { x: 20, y: 20 }, params: { code: 'return { got: input }' }, onError: 'stop' },
    ],
    /* 循环节点没有端口，所以这里**没有** `gen → L` 这条边了。 */
    edges: [],
  }
  await call('POST', '/api/ecom-workbench/workflows', { name: '端到端循环', doc: loopDoc })
  const lr = await call('POST', '/api/ecom-workbench/workflow/run', { name: '端到端循环' })
  check('端到端循环：整份跑成功', lr.ok === true, JSON.stringify(lr).slice(0, 200))
  check('端到端循环：体节点只记一次（ran 去重）',
    Array.isArray(lr.ran) && lr.ran.join(',') === 'gen,L,body', JSON.stringify(lr.ran))
  check('端到端循环：循环节点本身没有报「没有这个内置节点」',
    !JSON.stringify(lr).includes('没有这个内置节点'), JSON.stringify(lr).slice(0, 200))
  /* ⚠️ 日志条目是 `{ nodeId, line }` **对象**，不是字符串 ——
   * `String(l)` 会得到 `[object Object]`，永远不含「轮」（第一版就是这么假红的）。 */
  check('端到端循环：日志里有轮次交代',
    Array.isArray(lr.logs) && lr.logs.some(l => String(l?.line ?? '').includes('轮')),
    JSON.stringify(lr.logs).slice(0, 260))

  /* ② 条件分流：`flow.if` 是**真正的内置函数**（不是调度器特判），要确认它注册上了。 */
  const ifDoc = {
    version: 1,
    name: '端到端分流',
    nodes: [
      { id: 'gen2', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return { n: 5 }' }, onError: 'stop' },
      { id: 'IF', defId: 'flow.if', position: { x: 300, y: 0 }, params: { expr: 'input.n > 3' }, onError: 'stop' },
      { id: 'yes', defId: 'code.js', position: { x: 600, y: -80 }, params: { code: 'return "走了成立分支"' }, onError: 'stop' },
      { id: 'no', defId: 'code.js', position: { x: 600, y: 80 }, params: { code: 'return "走了不成立分支"' }, onError: 'stop' },
    ],
    edges: [
      { id: 'e1', source: 'gen2', target: 'IF' },
      { id: 'e2', source: 'IF', target: 'yes', sourceHandle: 'true' },
      { id: 'e3', source: 'IF', target: 'no', sourceHandle: 'false' },
    ],
  }
  await call('POST', '/api/ecom-workbench/workflows', { name: '端到端分流', doc: ifDoc })
  const ir = await call('POST', '/api/ecom-workbench/workflow/run', { name: '端到端分流' })
  check('端到端分流：整份跑成功', ir.ok === true, JSON.stringify(ir).slice(0, 200))
  check('端到端分流：走了成立分支', Array.isArray(ir.ran) && ir.ran.includes('yes'), JSON.stringify(ir.ran))
  check('端到端分流：未走的分支没跑', Array.isArray(ir.ran) && !ir.ran.includes('no'), JSON.stringify(ir.ran))
  check('端到端分流：flow.if 真的注册成了内置函数',
    !JSON.stringify(ir).includes('没有这个内置节点'), JSON.stringify(ir).slice(0, 200))
}

/* ②b **结构化条件**经真 HTTP 走一遍（2026-10-19，`flow.if` 改成 Dify 那套之后）。
 *
 * ## 为什么要单独跑这条（不能只信 `if-rules.mjs`）
 *
 * 结构化条件的「左边取什么值」是**调度器解析好之后挂在命令体顶层**的
 * （`__judge`，与 `params` 并列）。那条路要穿过：
 *   画布 → `JSON.stringify` → HTTP → 宿主半 → `dispatch` → 内置函数。
 * `if-rules.mjs` 里是**进程内直接调** `runGraph`，根本不经过序列化 ——
 * 所以「`__judge` 没被带过去」这类错它抓不到（表现是条件恒不成立，而界面一切正常）。
 *
 * 判据落三条：走的是「成立」分支 / 未走的不派发 / 输出把上游数据原样带下去了。
 */
{
  const doc = {
    version: 1,
    name: '端到端结构化条件',
    nodes: [
      { id: 'gen3', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return { 数量: 7, 名称: "杯子" }' }, onError: 'stop' },
      {
        id: 'IF2', defId: 'flow.if', position: { x: 300, y: 0 }, onError: 'stop',
        params: {
          conditions: [{ left: { kind: 'field', nodeId: 'gen3', field: '数量' }, op: 'gt', value: '3', valueType: 'number' }],
          logic: 'and',
          expr: '',
        },
      },
      /* 下游把收到的上游数据原样交出，再由**结束节点**声明成产出 ——
       * 这样「输出带不带上游」在 HTTP 那侧可验（运行记录只存状态与日志，不存节点输出）。 */
      { id: 'yes2', defId: 'code.js', position: { x: 600, y: -80 }, params: { code: 'return { 数量: input.数量, 名称: input.名称 }' }, onError: 'stop' },
      { id: 'no2', defId: 'code.js', position: { x: 600, y: 80 }, params: { code: 'return "不该走到这里"' }, onError: 'stop' },
      { id: 'end2', defId: 'flow.end', position: { x: 900, y: -80 }, params: { fields: ['拿到的 = yes2'] }, onError: 'stop' },
    ],
    edges: [
      { id: 'e1', source: 'gen3', target: 'IF2' },
      { id: 'e2', source: 'IF2', target: 'yes2', sourceHandle: 'true' },
      { id: 'e3', source: 'IF2', target: 'no2', sourceHandle: 'false' },
      { id: 'e4', source: 'yes2', target: 'end2' },
    ],
  }
  await call('POST', '/api/ecom-workbench/workflows', { name: '端到端结构化条件', doc })
  const r2 = await call('POST', '/api/ecom-workbench/workflow/run', { name: '端到端结构化条件' })
  check('★ 结构化条件经 HTTP 也能跑通', r2.ok === true, JSON.stringify(r2).slice(0, 240))
  check('★★ 走了「成立」那条（说明 __judge 穿过了序列化）',
    Array.isArray(r2.ran) && r2.ran.includes('yes2'), JSON.stringify(r2.ran))
  check('★★「不成立」那条没派发', Array.isArray(r2.ran) && !r2.ran.includes('no2'), JSON.stringify(r2.ran))

  /* ⚠️ 这条是**用户明确要求**的那一条：「这个节点做的不只是判断，判断完了
   * 后面的节点还得知道干嘛」—— 所以下游必须拿得到上游的数据。
   * 判据落在**结束节点声明的产出**上（运行记录只存状态与日志，不存每个节点的输出）。
   * 链路是 `gen3 → IF2(条件) → yes2(照抄上游字段) → end2(声明成产出)`，
   * 任何一环把上游弄丢，`拿到的` 就会是 undefined。 */
  const got = r2.declaredOutputs?.拿到的
  check('★★ 下游原样拿到上游数据（判断不改数据）',
    got !== null && typeof got === 'object' && got.数量 === 7 && got.名称 === '杯子',
    JSON.stringify(got ?? null).slice(0, 200))
}

/* ── SSE 运行流（`GET /workflow/run-stream`）──────────────────────────
 *
 * ## 为什么这条必须在这里验（不能只在 dom-render 里验）
 *
 * 它是**宿主半的真 HTTP 口**：拼 SSE 帧的格式（`event:` + `data:` + 空行）
 * 错一个字，浏览器就整条流都不认 —— 而那种错**构建通过、类型检查通过**，
 * 只有真发一次请求才看得见。`dom-render` 那侧 jsdom 没有 `EventSource`，
 * 根本到不了这里。
 *
 * ## 这里要断的三件事
 *
 *   ① 响应头是 `text/event-stream`（不是 JSON）；
 *   ② 有 `step` 帧（逐条过程）**和** `done` 帧（收尾），顺序是后者在前；
 *   ③ `done` 的那一帧里带着 `ran` —— 前端据此说「跑了 N 个节点」。 */
{
  /* 先写一份最小工作流存档到沙箱里（跑得要有一份档）。 */
  const doc = {
    version: 1,
    name: 'sse 用的',
    nodes: [
      { id: 'n1', type: 'v1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return { ok: 1 }', timeout: 5000 }, onError: 'stop', skipped: false },
    ],
    edges: [],
  }
  await call('POST', '/api/ecom-workbench/workflows', { name: 'sse 用的', doc })

  /* 手搓一次请求，因为 `call()` 只等着最后 `end(s)` 的那一坨 JSON。 */
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/api/ecom-workbench/workflow/run-stream?name=' + encodeURIComponent('sse 用的')
  const res = new EventEmitter()
  let head = null
  let text = ''
  res.writeHead = (code, h) => { head = { code, h } }
  res.write = (chunk) => { text += String(chunk) }
  res.end = () => { /* 收尾 */ }
  res.writableEnded = false
  await handler(req, res)

  check('① 响应头是 text/event-stream',
    String(head?.h?.['content-type'] ?? '').includes('text/event-stream'),
    JSON.stringify(head?.h?.['content-type']))
  const hasStep = text.includes('event: step')
  const hasDone = text.includes('event: done')
  check('② 有 step 帧（逐条过程）', hasStep, text.slice(0, 120))
  check('② 有 done 帧（收尾）', hasDone, text.slice(-160))
  check('② done 在最后（不是夹在中间）',
    hasDone && text.lastIndexOf('event: done') > text.lastIndexOf('event: step'),
    String(text.lastIndexOf('event: done')) + ' > ' + String(text.lastIndexOf('event: step')))
  /* 帧格式：每个 `event:` 后面紧跟一行 `data:`，然后一个空行。 */
  check('③ 帧格式正确（event 行紧跟 data 行 + 空行）',
    /event: done\ndata: \{[^\n]*\}\n\n$/.test(text.replace(/\r/g, '')),
    JSON.stringify(text.slice(-80)))
  const doneData = (() => {
    const m = /event: done\ndata: ([^\n]*)/.exec(text)
    if (m === null) return null
    try { return JSON.parse(m[1]) } catch { return null }
  })()
  check('③ done 帧带上了 ran（前端据此说「跑了 N 个节点」）',
    Array.isArray(doneData?.ran), JSON.stringify(doneData))
}

console.log('')
console.log('【P0 回归】正常 POST 打 /run 不许被判成「已取消」（2026-10-23）')
{
  /* ## 这条断言守的是什么（它只能在 S1 之后才有意义）
   *
   * `/run` 用「客户端断开 = 用户点停止」把取消信号传下去。原来判据是
   * `r.on('close', () => { if (!w.writableEnded) ac.abort() })`，
   * 但 Node 真 HTTP 下 **`req` 的 close 在请求体读完那一瞬间就触发** ——
   * 于是每次正常请求都会 abort，派发器把信号接进执行方之后（契约 S1），
   * 每次 `/run` 都返回 `cancelled`、模型/进程一次都没真跑。
   *
   * ⚠️ **为什么必须用真 HTTP 服务**：上面那些 `call()` 用的是假 `Readable`，
   * 它被 `for await` 读完后会自己 destroy、也会发 `close` —— 但发得太"晚"、
   * 且同批测试里没有真派发在等信号，所以老写法能蒙混过关。
   * 只有真 socket 才能复现「1 毫秒就 close」的时序。
   *
   * ⚠️ 这条断言**在 S1 之前是绿的**（信号被派发器丢掉，误判传不下去）——
   * 所以它的价值正是「信号接通之后才会红」。别因为「以前也绿」而觉得它没用。 */
  const { createServer } = await import('node:http')
  const { request: httpRequest } = await import('node:http')

  /**
   * 向本机这个临时服务发一个真 POST，拿回 JSON。
   *
   * ⚠️ 用 `node:http` 的 `request` 而**不是** `fetch`（2026-10-23 踩过）：
   * `fetch` 走 undici 的全局连接池，测试末尾 `process.exit()` 时那个池还在收尾，
   * Node 会在退出那一刻报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
   * —— 断言全绿但退出码 1，接线的人会以为测试坏了。
   * 显式 `agent: false` + `connection: close` 就不留任何连接。
   *
   * @param port - 端口。
   * @param body - 请求体（对象，自动串化）。
   * @returns 解析后的 JSON。
   */
  function postJson(port, body) {
    const text = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const rq = httpRequest({
        port, method: 'POST', path: '/api/ecom-workbench/run', agent: false,
        headers: { 'content-type': 'application/json', connection: 'close', 'content-length': Buffer.byteLength(text) },
      }, (resp) => {
        let out = ''
        resp.setEncoding('utf8')
        resp.on('data', (c) => { out += c })
        resp.on('end', () => {
          try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
        })
        resp.on('error', reject)
      })
      rq.on('error', reject)
      rq.end(text)
    })
  }

  /** 这一轮真正跑到的执行次数（判「执行方有没有真的被调用」）。 */
  let reallyRan = 0

  const srv = createServer((req, res) => {
    /* 直接交给插件注册的那个 handler —— 与真部署时 dsh 的 webServer 做的事一样。 */
    void handler(req, res)
  })
  await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve) })
  const port = srv.address().port
  try {
    /* 打一个真会跑的内置节点（`flow.delay` 5 毫秒，够快但确实占用派发）。 */
    const body = [{
      runId: 'p0-regress', nodeId: 'n-p0', executor: 'builtin',
      command: { node: 'flow.delay', params: { ms: 5 } },
      context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    }]
    const json = await postJson(port, body)
    const first = json.results?.[0]
    check('★★ 正常 POST /run → 结局不是 cancelled', first?.status !== 'cancelled', JSON.stringify(first))
    check('★★ 正常 POST /run → 真的跑成功了', first?.status === 'success', JSON.stringify(first))
    check('★★ 正常 POST /run → 有输出（执行方真被调用过）',
      first?.output !== undefined, JSON.stringify(first?.output))

    /* 再来一条：真的要等一会儿的节点，确认「等」这件事没被误中断。 */
    const body2 = [{
      runId: 'p0-regress2', nodeId: 'n-p0b', executor: 'builtin',
      command: { node: 'flow.delay', params: { ms: 80 } },
      context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    }]
    const t0 = Date.now()
    const json2 = await postJson(port, body2)
    const spent = Date.now() - t0
    check('★★ 需要等的节点也没被误中断（80 毫秒那个跑完了）',
      json2.results?.[0]?.status === 'success', JSON.stringify(json2.results?.[0]))
    check('★ 它确实等了（不是提前收口）', spent >= 60, String(spent) + ' 毫秒')
    reallyRan += 1
  } finally {
    await new Promise((resolve) => { srv.close(resolve) })
  }
  check('★ 用例本身执行到了（不是被异常跳过）', reallyRan === 1, String(reallyRan))
}

console.log(bad === 0 ? '结论：全部通过 ✓' : '结论：' + String(bad) + ' 条失败 ✗')
process.exit(bad === 0 ? 0 : 1)
