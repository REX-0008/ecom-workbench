/** 「画布跑完要进运行历史」（用户 m14827）—— 端到端，**真的起宿主半那条路由的替身**。
 *
 * ## 为什么必须端到端
 *
 * 这个 bug 的现象是「画布里点运行，历史里什么都没有」，而**单元层面每块都对**：
 * `runGraph` 跑得很正常、`useRunStore` 收得到日志、`appendRun` 也能写盘 ——
 * 唯独**没人把这两头接起来**。
 *
 * 所以判据必须是「跑一次之后，那份工作流的 run 文件里真的多了一条」，
 * 不是「代码里出现了 `recordCanvasRun` 这个词」（那种断言查 import 就能骗过）。
 *
 * ## 怎么跑
 *
 * 1. 用 `runGraph` 真跑一个小图（一个 `code.js`），拿到真实的 `RunGraphResult`；
 * 2. 按画布那段代码**同样的规则**组一份记录，POST 给宿主半那条路由的处理逻辑；
 * 3. 读盘，断言文件里有那条记录。
 *
 * ⚠️ 第 2 步不直接调 `WorkflowCanvas.tsx`（它引 `.module.css`，Node 跑不了）。
 * 所以这里另外钉一条**源码层**断言：画布那段确实在 `runSeq` 的成功分支里、
 * 且读的是 `fileRef.current.name`。两条合起来才等于「接上了」。
 *
 * 跑法：node --import <tsx> tests/canvas-run-history.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runGraph } from '../src/workflow/run.ts'
import { runCodeFn } from '../src/dispatch/builtins.ts'
import { appendRun, loadRuns, listRunNames, newRunId, runsDir } from '../src/workflow/workflow-runs.ts'
import { workflowsDir } from '../src/workflow/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'ewb-canvas-runs-'))
/* ⚠️ **把沙箱指到本次的临时目录**（2026-10-20）。
 *
 * `workflowsDir` 里 `EWB_TEST_HOME` **优先于传进去的 `dshHome`**，
 * 而 `runsDir` 是从 `workflowsDir` 派生的 —— 所以只传 `{dshHome}` 不管用，
 * 文件会落到 `npm test` 设的那个共享 `EWB_TEST_HOME` 下（本测试清理不到，
 * 而且别的测试也可能撞上）。设成 TMP 之后「隔离」与「自己清理」两件事才对得上。 */
process.env.EWB_TEST_HOME = TMP

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

const NAME = '画布测试工作流'
const OPTS = { dshHome: TMP, profile: 'test' }

console.log('=== 画布跑完要进运行历史 ===')
console.log('')

/* ── ① 真跑一张小图 ─────────────────────────────────────────── */
console.log('① 用 runGraph 真跑（一个 code.js 节点）')
let result
{
  const nodes = [{
    id: 'n1',
    def: { id: 'code.js', label: '代码', paramDefs: [], executor: 'builtin' },
    params: { code: 'return { hello: "world" }' },
    onError: 'stop',
  }]
  /* ⚠️ 派发函数必须返回 `RunOutcome`（`{ ok, status, output }`）。
   *
   * 踩过两次坑，都记在这里：
   *   ① `runCodeFn` 是 **BuiltinFn** —— 它直接返回**裸输出**（`{hello:1}`），
   *      既没有 `ok` 也没有 `status`。直接把它当 `RunOutcome` 用，
   *      `runGraph` 会判 `res.ok` 为 undefined → **整个图被当成失败**
   *      （但 `ran` 里仍有那个节点，因为派发确实发生过）。
   *      症状很迷惑：**看着跑了、其实判失败**。
   *   ② 正确的包法是「执行方做的事」：`createBuiltinExecutor` 里
   *      `return { status: 'success', output: out, logs }` —— 它也不带 `ok`，
   *      那个 `ok` 是**派发器**加的（`dispatcher.ts` 的 `DispatchResult` 也只有 status）。
   *      所以这里要连 `ok` 一起补。
   *
   * 真实画布这条路是 `dispatchNode(...)` → HTTP → 宿主半派发器 → 返回带 `ok` 的形状，
   * 所以线上没问题；只是这个测试的替身要自己补上。 */
  const edges = []
  result = await runGraph(
    { nodes, edges, workdir: TMP },
    async (req) => {
      const out = await runCodeFn(req.command, { nodeId: req.nodeId, workdir: TMP, upstream: [] })
      return { ok: true, status: 'success', output: out, logs: ['调用内置 code.js', '完成'] }
    },
    { workflowId: 'v1-canvas' },
  )
  check('跑通了（不是 aborted）', result.aborted !== true, String(result.aborted))
  check('ran 里有 n1', result.ran.includes('n1'), JSON.stringify(result.ran))
}

/* ── ② 按画布那段代码的规则组一份记录，落盘 ─────────────────── */
console.log('')
console.log('② 按画布的规则组记录并落盘（等价于 POST /workflow/record）')
{
  const startedAt = Date.now() - 5
  const record = {
    id: newRunId(startedAt),
    name: NAME,
    startedAt,
    endedAt: Date.now(),
    /* 与 `runSeq` 里那条判据同源：`runGraph` 没有 ok，看 aborted。 */
    ok: result.aborted !== true,
    ...result.aborted === true ? { aborted: true } : {},
    ran: result.ran,
    nodes: result.ran.map(id => ({
      nodeId: id,
      defId: 'code.js',
      state: 'success',
      logs: ['调用内置 code.js', '完成'],
    })),
    via: 'canvas',
  }
  const saved = await appendRun(record, OPTS)
  check('★ 落盘成功', saved === true, String(saved))

  const runs = await loadRuns(NAME, OPTS)
  check('★★ 历史里真的多了一条', runs.length === 1, String(runs.length))
  check('★★ 那条记的是画布发起的（via=canvas）', runs[0]?.via === 'canvas', String(runs[0]?.via))
  check('★ 节点明细带上了', Array.isArray(runs[0]?.nodes) && runs[0].nodes.length === 1,
    JSON.stringify(runs[0]?.nodes?.length))
  check('★ 节点明细里有日志', (runs[0]?.nodes?.[0]?.logs ?? []).length === 2,
    JSON.stringify(runs[0]?.nodes?.[0]?.logs))
  check('结束状态是 success', runs[0]?.ok === true, String(runs[0]?.ok))
}

/* ── ③ 分组列表里能看到它 ───────────────────────────────────── */
console.log('')
console.log('③ 「运行历史」页面的分组列表里能看到这份工作流')
{
  const names = await listRunNames(OPTS)
  check('★★ 列表里有它（否则页面显示「还没有运行记录」）', names.includes(NAME), JSON.stringify(names))
}

/* ── ④ 没有归属名 → 不落盘（宿主半也会拦，这里验画布侧的判据） ── */
console.log('')
console.log('④ 画布还没保存成文件时，不上报（否则历史里会多一份没名字的）')
{
  const canvasSrc = readFileSync(join(HERE, '..', 'src', 'client', 'workbench', 'WorkflowCanvas.tsx'), 'utf8')
  /* 判据锚在**那段代码本体**上：`const owner = fileRef.current.name` 之后
   * 必须有一个非空判断才调用上报。 */
  const gate = /const owner = fileRef\.current\.name\s*\n\s*if \(owner !== ''\)/.test(canvasSrc)
  check('★★ 画布侧有「没名字就不上报」的判断', gate, gate ? '' : '没找到 if (owner !== \'\')')
}

/* ── ⑤ 源码层：上报真的接在 runSeq 里（不是死代码） ─────────── */
console.log('')
console.log('⑤ 上报接在 runSeq 成功后（不是写了却没人调）')
{
  const canvasSrc = readFileSync(join(HERE, '..', 'src', 'client', 'workbench', 'WorkflowCanvas.tsx'), 'utf8')
  const body = /const runSeq = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/.exec(canvasSrc)?.[0] ?? ''
  check('runSeq 函数体找得到', body !== '', String(body.length) + ' 字符')
  /* 必须在 `await runGraph(` 之后（否则拿不到结果）。 */
  const graphAt = body.indexOf('await runGraph(')
  const recordAt = body.indexOf('recordCanvasRun(')
  check('★★ recordCanvasRun 在 runGraph 之后（拿得到结果）', graphAt >= 0 && recordAt > graphAt,
    'runGraph@' + String(graphAt) + ' record@' + String(recordAt))
  check('★ 上报读的是 fileRef（归属名的稳定引用）', /fileRef\.current\.name/.test(body))
  check('★ 上报带了 ran 与节点明细', /ran:/.test(body) && /nodes: nodeLines/.test(body))

  /* 宿主半那条路由必须存在（否则前端上报会 404）。 */
  const hostSrc = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')
  check('★★ 宿主半有 /workflow/record 路由', /path === '\/api\/ecom-workbench\/workflow\/record'/.test(hostSrc))
  check('★ 那条路由会落盘', /await appendRun\(record\)/.test(
    hostSrc.slice(hostSrc.indexOf('/workflow/record'))))
}

/* ── ⑥ 别把运行历史写进工作流存档目录（那个是 workflows/，这个是 runs/） ── */
console.log('')
console.log('⑥ 历史存在 runs/，不是混在 workflows/ 里')
{
  /* ⚠️ **不能自己拼期望路径**（第一版就是这么错的）：`runsDir` 是
   * `workflowsDir` 的父目录再拼 `runs`，而 `workflowsDir` 里
   * **`EWB_TEST_HOME` 优先于传进去的 `dshHome`** ——
   * `npm test` 会设它，于是实际落点与「按 dshHome 拼」算出来的不一样。
   * 正确的做法是**问那个函数**（唯一真源），对比「它给的目录里有没有文件」。 */
  const dir = runsDir(OPTS.dshHome, OPTS.profile)
  check('runs 目录被建出来了', existsSync(dir), dir)
  const file = join(dir, NAME + '.json')
  check('★ 文件名就是工作流名', existsSync(file), file)
  /* 顺带钉住：它**不是** workflows 目录（两个目录必须不同）。 */
  check('★ 与 workflows 目录不是同一个', dir !== workflowsDir(OPTS.dshHome, OPTS.profile),
    dir + ' vs ' + workflowsDir(OPTS.dshHome, OPTS.profile))
}

/* ── ⑥ 中断后「排队中」必须被撤掉（2026-10-23 契约 AC）────────────────
 *
 * ## 用户看到的那一幕
 *
 * 原话：「报错了，但是后续还在执行。」—— 实际没继续执行。
 * 一开跑就把每个节点标成「排队中」，某个节点失败中断后**没人撤掉那些排队**，
 * 于是画布上看着像后面还在跑。
 *
 * ## 判据
 *
 * 这一段是**源码层**断言（`WorkflowCanvas.tsx` 开 `.module.css`，Node 跑不了）。
 * 源码断言最容易写成「代码里出现某个字符串就过」，所以每条都钉在
 * **具体的结构条件**上，缺一条就会漏掉一种真实错法：
 *
 *   ① 兜底那一步在 `await runGraph(` **之后** —— 否则拿不到 `aborted`；
 *   ② 它被 `r.aborted === true` **包着** —— 否则正常跑完也误标；
 *   ③ 它只挑 `state !== 'queued'` 的**跳过** —— 否则把真失败的节点改成
 *      「未执行」，用户查半天找不到真正的错因；
 *   ④ 写的是 `cancelled` + 「未执行」 —— 不是 `idle` / 「已停止」。
 */
console.log('')
console.log('⑥ 中断后把残留的「排队中」撤掉（不能看着像还在跑）')
{
  const canvasSrc = readFileSync(join(HERE, '..', 'src', 'client', 'workbench', 'WorkflowCanvas.tsx'), 'utf8')
  const body = /const runSeq = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/.exec(canvasSrc)?.[0] ?? ''
  check('runSeq 函数体找得到（这一段的前提）', body !== '', String(body.length) + ' 字符')

  /* ① 位置：在 `await runGraph(` 之后。 */
  const graphAt = body.indexOf('await runGraph(')
  const sweepAt = body.indexOf("n.data.state !== 'queued'")
  check('★★ 兜底扫描在 await runGraph 之后（拿得到 aborted）',
    graphAt >= 0 && sweepAt > graphAt,
    'runGraph@' + String(graphAt) + ' 扫描@' + String(sweepAt))

  /* ② 被 `r.aborted === true` 守着 —— 正常跑完不许扫。
   *
   * ⚠️ 判据不是「文件里出现过 `r.aborted === true`」（上报那一处也有它），
   * 而是**紧挨在扫描之前**那段条件。取扫描点往前 300 字符看。
   *
   * ⚠️ **2026-10-23 补丁改过这里**：兜底从「`setNodes(ns => …)` 回调」改成了
   * 「先算出 `finalNodes` 再 setNodes」（为了让上报读到最终状态）。
   * 于是外层不再是 `if (...) {`，而是三元表达式
   * `const finalNodes: V1Node[] = r.aborted === true`。判据跟着改成
   * 「紧邻扫描的那个条件里必须有 `r.aborted === true`」——
   * **两种写法都算过，但必须真的在守着**：把条件删掉、或改成 `&& false` 都会红
   * （自证②验的就是这个）。 */
  const beforeSweep = sweepAt < 0 ? '' : body.slice(Math.max(0, sweepAt - 300), sweepAt)
  const guardedByAborted = /r\.aborted === true/.test(beforeSweep)
  check('★★ ★ 扫描被 r.aborted === true 守着（正常跑完不做这一步）', guardedByAborted,
    guardedByAborted ? '' : '扫描前面 300 字符里找不到 r.aborted === true')

  /* ③ 只挑 `state !== 'queued'` 的跳过。 */
  const onlyQueued = /if \(n\.data\.state !== 'queued'\) return n/.test(body)
  check('★★ 只处理 queued（failed 的节点不许动）', onlyQueued,
    onlyQueued ? '' : '找不到 if (n.data.state !== \'queued\') return n')

  /* ④ 写成 `cancelled` + 「未执行」。 */
  const markCancelled = /state: 'cancelled' as NodeState, progress: '未执行'/.test(body)
  check('★★ 标成 cancelled + 「未执行」（不是 idle / 已停止）', markCancelled,
    markCancelled ? '' : '找不到 state: \'cancelled\' … progress: \'未执行\'')

  /* ⑤ 运行历史那张表里必须有 `cancelled → 未执行 / idle`（灰）。
   *
   * 没有它 `cancelled` 会落到 `?? { text: n.state }` 兜底，界面上露出英文。 */
  const histSrc = readFileSync(join(HERE, '..', 'src', 'client', 'workbench', 'RunHistoryPanel.tsx'), 'utf8')
  const labelRow = /cancelled:\s*\{\s*text:\s*'未执行',\s*tone:\s*'idle'\s*\}/.test(histSrc)
  check('★★ 运行历史里 cancelled 显示「未执行」、配色 idle（灰，不是红）', labelRow,
    labelRow ? '' : 'STATE_LABEL 里没有 cancelled: { text: \'未执行\', tone: \'idle\' }')

  /* ⑥ 反面：`failed` 那条**不许**被这条兜底改写。
   * 判据：扫描附近不许出现 `state === 'failed'`（它只认 queued）。 */
  const sweepBlock = sweepAt < 0 ? '' : body.slice(Math.max(0, sweepAt - 200), sweepAt + 400)
  const notTouchingFailed = !/state === 'failed'/.test(sweepBlock)
  check('★ 兜底那一段里没有 state === \'failed\'（真失败的不动）', notTouchingFailed,
    notTouchingFailed ? '' : '兜底里出现了 state === \'failed\'')

  /* ⑦ `onEvent` 里有真的 `cancelled` 分支（不是注释、不是空 case）。
   *
   * ## 这条原来是「记录现状」，2026-10-23 晚改成**正面判据**
   *
   * 加这一批时引擎还没发 `cancelled`，那时这条断言写的是「case 还是注释」
   * —— 用来提醒「引擎好了就能放开」。引擎随后把
   * `{ kind: 'cancelled' }` 加进 `RunEvent`（`workflow/run.ts:290`）并在收尾
   * emit（`:2479`），注释放开了，于是这条换成正面判据：
   *
   *   ① 有**真代码**的 `case 'cancelled':`（不是被块注释包着的示例）；
   *   ② 它标的是 `cancelled` + 「未执行」（不是 idle / 已停止）。
   *
   * ⚠️ 只验「文件里出现 case 'cancelled'」不够 —— 注释里那句话也满足它。
   * 所以要连着下一行 `markNode(...)` 一起验。 */
  const hasLiveCase = /case 'cancelled':\s*\n\s*markNode\(e\.nodeId, 'cancelled', '未执行'\)/.test(canvasSrc)
  check('★★ onEvent 里有真的 cancelled 分支，标 cancelled + 「未执行」', hasLiveCase,
    hasLiveCase ? '' : '找不到 case \'cancelled\': 紧跟 markNode(..., \'cancelled\', \'未执行\')')
}

/* ── ⑦ 上报时状态不许被压成「跳过」，也不许读旧值（2026-10-23 契约 AC 补丁）
 *
 * ## 两个独立缺口，各验各的
 *
 * | 缺口 | 症状 | 判据 |
 * | --- | --- | --- |
 * | ① 白名单里没有 `cancelled` | 画布自报的「未执行」在运行历史里显示成「跳过」 | 白名单表达式里必须出现 `'cancelled'` |
 * | ② 上报读的是 `nodesRef.current`（渲染期才同步） | 兜底改的状态在记录里丢失，送出去的是旧的 `queued` | 上报必须用**这一轮算出来的**那份，不许直接读 ref |
 *
 * ⚠️ 缺口 ② 的判据不能是「文件里有没有 `finalNodes` 这个词」——
 * 那也是「出现某个字符串就算过」。下面钉的是**结构**：
 *   · `finalNodes` 必须在扫描那一步被算出来（与 setNodes 同一个输入）；
 *   · 上报那一段里**不许**再出现 `nodesRef.current.find(... data.state)`。
 */
console.log('')
console.log('⑦ 上报状态：不许压成「跳过」，也不许读兜底之前的旧值')
{
  const canvasSrc = readFileSync(join(HERE, '..', 'src', 'client', 'workbench', 'WorkflowCanvas.tsx'), 'utf8')
  const body = /const runSeq = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/.exec(canvasSrc)?.[0] ?? ''

  /* ① 白名单含 `cancelled`。判据落在**那个三元表达式本体**上。 */
  const whitelist = /state:\s*st === 'success'[\s\S]{0,300}?\?\s*st\s*:\s*'skipped'/.exec(body)?.[0] ?? ''
  check('白名单那张三元表达式找得到', whitelist !== '', String(whitelist.length) + ' 字符')
  check('★★ 白名单里有 cancelled（画布自报的「未执行」不会被压成「跳过」）',
    /st === 'cancelled'/.test(whitelist),
    whitelist === '' ? '没找到白名单' : (/st === 'cancelled'/.test(whitelist) ? '' : '白名单里没有 cancelled'))

  /* ② 上报用**这一轮算出来的**那份，不是 ref。
   *
   * 两条一起看：
   *   a) `finalNodes` 确实被算出来（赋值给它）；
   *   b) 上报那一段里用 `byId`（由 finalNodes 建的 Map）取节点，而不是 ref。 */
  const finalNodesDefined = /const finalNodes: V1Node\[\] = r\.aborted === true/.test(body)
  check('★★ 兜底结果被算成 finalNodes（与 setNodes 同一个输入）', finalNodesDefined,
    finalNodesDefined ? '' : '找不到 const finalNodes: V1Node[] = r.aborted === true')

  /* 上报那段：从 `const owner =` 到 `recordCanvasRun(` 之间。 */
  const reportFrom = body.indexOf('const owner = fileRef.current.name')
  const reportTo = body.indexOf('recordCanvasRun(')
  const reportSeg = reportFrom < 0 || reportTo < reportFrom ? '' : body.slice(reportFrom, reportTo)
  check('上报那一段找得到', reportSeg !== '', String(reportSeg.length) + ' 字符')
  const usesFinalNodes = /new Map\(finalNodes\.map\(n => \[n\.id, n\]\)\)/.test(reportSeg)
  check('★★ ★ 上报用的是 finalNodes 建的 Map（读得到兜底之后的最终状态）',
    usesFinalNodes, usesFinalNodes ? '' : '上报里找不到 new Map(finalNodes.map(...))')
  /* ★ 反面铁证：上报里**不许**再直接用 ref 取状态。
   * 没有这一条，两处都写也能过 —— 而那种写法里 ref 那一份就是旧的。 */
  const readsRefForState = /nodesRef\.current\.find\([^)]*\)\s*\n?\s*const st = n\?\.data\.state/.test(reportSeg)
    || /const n = nodesRef\.current\.find/.test(reportSeg)
  check('★★ 上报里不再直接读 nodesRef.current 取状态（否则拿到的是旧版）',
    !readsRefForState, readsRefForState ? '上报里还在用 nodesRef.current.find(...)' : '')

  /* ③ 反面：白名单那一侧，`failed` 仍原样通过。
   * 判据：`st === 'failed'` 必须在同一个三元条件里（不是被漏掉）。 */
  check('★ 反面：failed 仍原样传出（没被兜底或白名单改写）',
    /st === 'failed'/.test(whitelist),
    /st === 'failed'/.test(whitelist) ? '' : '白名单里没有 failed')

  /* ④ 反面：正常跑完（不中断）时 `finalNodes` 就是原样那一份 ——
   * 不许对 `queued` 之类做任何映射。
   * 判据：三元的两支里，`else` 那支必须是**原样** `nodesRef.current`（不加映射）。 */
  const elseBranchRaw = /: nodesRef\.current\s*\n/.test(body)
  check('★ 反面：不中断时直接用原样的节点表（不误标任何状态）', elseBranchRaw,
    elseBranchRaw ? '' : 'finalNodes 的 else 分支不是原样 nodesRef.current')
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 票 28：画布的 onEvent 认得 `stream`（接收端准备好）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么这一段要「真跑一遍」，不能只搜源码
 *
 * 只搜 `case 'stream':` 会踩这一轮已经踩过一次的坑：**搜到注释里的同名字样**。
 * `WorkflowCanvas.tsx` 里解释这件事的那些注释本身就写着 `case 'stream'`。
 *
 * 所以做法是：把 `onEvent` 的**函数体原文**抠出来，去掉注释，
 * 再拼成一个能执行的函数（它的依赖 `markNode` / `rs` 用桩顶上），
 * 然后**真的喂一条 `{kind:'stream'}` 进去**，看 `appendStream` 有没有被调用。
 *
 * ⚠️ 这一段验的是「接收端认这个帧」，**不验传输**：
 * 画布那条路（`POST /run` + `JSON.stringify`）现在根本送不出这个帧，
 * 所以**画布上仍然不会吐字**。传输那头是票 28 的第二步（丙方案），还没做。
 */
console.log('')
console.log('⑧ 票 28：画布 onEvent 认得 stream 帧，并喂进 run-store')
{
  const canvasSrc = readFileSync(join(HERE, '..', 'src', 'client', 'workbench', 'WorkflowCanvas.tsx'), 'utf8')
  const lines = canvasSrc.split('\n')

  /* 定位 `const onEvent = (e: RunEvent): void => {` 那一行，再找出它的配对 `}`。
   * 用括号配对数（不用行号硬写）—— 行号会随任何一次插入漂，
   * 这一轮已经踩过「绝对行号」的坑（`NEVER_RUN_OK` 那张表）。 */
  const startAt = lines.findIndex(l => /const onEvent = \(e: RunEvent\): void => \{/.test(l))
  check('前提：找得到 onEvent 的定义', startAt >= 0, '第 ' + String(startAt + 1) + ' 行')
  let endAt = -1
  if (startAt >= 0) {
    let depth = 0
    for (let i = startAt; i < lines.length; i += 1) {
      for (const ch of lines[i]) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
      if (depth === 0 && i > startAt) { endAt = i; break }
    }
  }
  check('前提：找得到 onEvent 的收尾大括号', endAt > startAt,
    endAt > startAt ? '第 ' + String(endAt + 1) + ' 行' : '括号没配平')

  if (startAt < 0 || endAt <= startAt) {
    check('★★★ onEvent 里有 stream 分支并调 appendStream', false, '前提不成立，跳过')
  } else {
    const rawBody = lines.slice(startAt, endAt + 1).join('\n')
    /* **去掉注释**再跑 —— 这是这一段存在的一半理由（防搜到注释假绿）。 */
    const codeOnly = rawBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    check('★★ 去掉注释后，源码里的 case \'stream\' 仍然在（不是只在注释里）',
      /case 'stream':/.test(codeOnly),
      /case 'stream':/.test(codeOnly) ? '' : '去掉注释就没了 —— 说明只写在注释里')

    /* ── 真跑：把函数体变成可执行函数，喂一条 stream 帧 ──
     *
     * 函数体里用到三样外部东西：`useRunStore`（→ `rs`）、`markNode`、`RunEvent`（类型，运行时不需要）。
     * 前两个用桩顶上：`markNode` 只记调用，`rs` 记 appendStream / pushLine / setProgress。 */
    const calls = { appendStream: [], pushLine: [], setProgress: [], markNode: [] }
    const stubs = {
      useRunStore: { getState: () => ({
        appendStream: (nodeId, chunk) => { calls.appendStream.push([nodeId, chunk]) },
        pushLine: (nodeId, line) => { calls.pushLine.push([nodeId, line]) },
        setProgress: (nodeId, done, total) => { calls.setProgress.push([nodeId, done, total]) },
      }) },
      markNode: (nodeId, state, text) => { calls.markNode.push([nodeId, state, text]) },
    }
    /* `RunEvent` 只是类型标注，`new Function` 里不认 —— 换成 `any`（`:` 后面那个类型）。
     * 只改参数那一处，函数体一个字不动。 */
    const runnable = codeOnly.replace(
      /const onEvent = \(e: RunEvent\): void => \{/,
      'const onEvent = (e) => {',
    )
    const factory = new Function('useRunStore', 'markNode',
      runnable + '\nreturn onEvent')
    const onEvent = factory(stubs.useRunStore, stubs.markNode)

    onEvent({ kind: 'stream', nodeId: 'ag1', text: '甲' })
    check('★★★ 喂一条 stream 帧 → appendStream 真被调用',
      calls.appendStream.length === 1, '调用 ' + String(calls.appendStream.length) + ' 次')
    check('★★★ 喂的 nodeId 与这一片字都对得上',
      calls.appendStream[0]?.[0] === 'ag1' && calls.appendStream[0]?.[1] === '甲',
      JSON.stringify(calls.appendStream[0] ?? null))
    /* ★ 只追加这一片，**不自己拼**（拼是 run-store 的事，重复拼会每个字重复 N 遍）。 */
    onEvent({ kind: 'stream', nodeId: 'ag1', text: '乙丙' })
    check('★★ 第二片原样交出去（不在这里拼接、不改写）',
      calls.appendStream[1]?.[1] === '乙丙',
      JSON.stringify(calls.appendStream[1] ?? null))

    /* ── 别的帧不许误进 stream ── */
    calls.appendStream.length = 0
    onEvent({ kind: 'log', nodeId: 'ag1', line: '一条日志' })
    check('★★ log 帧不进 appendStream（各走各的路）',
      calls.appendStream.length === 0 && calls.pushLine.length === 1,
      'appendStream ' + String(calls.appendStream.length) + ' / pushLine ' + String(calls.pushLine.length))

    /* ── 原来的分支没被弄坏 ── */
    calls.markNode.length = 0
    onEvent({ kind: 'started', nodeId: 'n1' })
    check('★ started 帧照旧标成运行中（加 stream 没把原来那几支弄坏）',
      calls.markNode[0]?.[1] === 'running', JSON.stringify(calls.markNode[0] ?? null))
  }
}

rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('（临时目录已清理）')
console.log(failed === 0 ? '结论：画布跑完会进运行历史 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
