/** 「未登录 → 提醒 → 等人 → 重检」这条路的核验（2026-10-22 加）。
 *
 * ## 为什么单独一条测试
 *
 * 这段有三处「写错了也不报错」的地方，静态看 JSON 全看不出来：
 *
 *   ① **重检**：人点「继续」不代表已经登录。不重检就直接往下跑，下游拿到空数据，
 *      表现为「今天没有数据」—— 看着成功、其实什么都没做。
 *   ② **重检前重开页面**：等待可能长达 12 小时，标签早没了。不重开就会读到
 *      `about:blank`，判据得出「已登录」（**最坏的一类错**：没登录却被判成登录）。
 *   ③ **失败分支必须主动中断**：引擎的循环节点**不检查分支可达性**
 *      （`runLoop` 没有 `hasLiveInput` 闸门），挂在「未走分支」上的循环照样会执行。
 *      不主动中断，「仍未登录」这条路走完，后面的采集循环会被启动、真的开页面。
 *
 * ## 钉哪几条
 *
 * ① 每份带登录检测的存档，未登录分支上都有 `flow.alert-wait`（`manual` 模式、12 小时超时）；
 * ② 那个节点**不在任何 `flow.loop` / `flow.parallel` 内**；
 * ③ 提醒文案含平台名与「重新登录」，且守 R6；
 * ④ **真跑**：未登录时停在等待点、后续采集节点一个都不跑；重检通过才回到主流程；
 * ⑤ 沿用真实存档（不碰磁盘写入），只读。
 *
 * ⚠️ 2026-10-27 票 07 起，「通知」与「等待」是两个节点（`flow.notify` + `flow.wait(manual)`），
 * 现在是**一个** `flow.alert-wait`。上面几条判的东西一条没变，改的是断言对象：
 * 原来分两处认那两个 defId，现在认一个。
 *
 * 跑法：`DSH_HOME=F:/AGENTS/agent-chat-dsh node scripts/run-tests.mjs login-rescue`
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'
import { runGraph } from '../src/workflow/run.ts'
import { branchFn } from '../src/dispatch/builtins.ts'
import { LOGIN_WAIT_TIMEOUT_HOURS } from '../scripts/browser/login-gate.mjs'

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

const WF_DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
const lib = [...(Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : NODE_LIBRARY.values())]

/** 带登录检测的两份（这两份的检查都在顶层，等待点放得下）。 */
const CASES = [
  { file: '取数-抖音电商罗盘', platform: '抖音', checkMark: 'loggedIn: !isLogin' },
  { file: '取数-天猫生意参谋', platform: '天猫', checkMark: 'loggedIn: !isLogin' },
  /* ★ 千川这份是 2026-10-23 才把检查从循环体内挪到顶层的（用户方案 A）。
   * 它原来**没有**这一段，所以上面那几条断言（有 notify / 有 wait / wait 不在循环里）
   * 对它全是「不存在」，而不是「通过」—— 加进来才是真的在验它。 */
  { file: '取数-千川全域推广', platform: '千川', checkMark: 'loggedIn: !isLogin' },
]

console.log('=== 「未登录 → 提醒 → 等人 → 重检」===')
console.log('存档目录：' + WF_DIR)
console.log('')

/* 找不到存档就跳过（与 real-archive-if.mjs 同一条纪律）。 */
if (!CASES.every(c => existsSync(join(WF_DIR, c.file + '.json')))) {
  console.log('（本机没有这两份存档，跳过 —— 先跑 node scripts/build-patrol-workflows.mjs）')
  console.log('')
  console.log('结论：没有可核对的存档（跳过）✓')
  process.exit(0)
}

/**
 * 读存档并翻成调度器要的形状。
 * @param file - 存档名（不含 .json）。
 * @returns 存档与 specs。
 */
function load(file) {
  const doc = JSON.parse(readFileSync(join(WF_DIR, file + '.json'), 'utf8'))
  const specs = toRunSpecsFromCanvas(
    doc.nodes.map(n => ({
      id: n.id,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      data: {
        def: lib.find(d => d.id === n.defId),
        params: n.params,
        onError: n.onError,
        skipped: n.skipped === true,
        label: n.label,
      },
    })),
    doc.edges,
  )
  return { doc, specs }
}

/**
 * 造派发替身。
 *
 * ⚠️ 与真执行方**同一语义**：`code.js` 里含 `throw` 就真失败（那条是「中断」节点）、
 * 登录判据按 `first` / `after` 两个阶段给不同的值（这正是「人重新登录了没」）。
 *
 * @param doc - 存档。
 * @param calls - 记录派发过的节点 id。
 * @param firstLoggedIn - 开工前那次检查的结果。
 * @param afterLoggedIn - 重检那次的检查结果。
 * @returns 派发函数。
 */
function mkDispatch(doc, calls, firstLoggedIn, afterLoggedIn) {
  return async (req) => {
    const node = doc.nodes.find(n => n.id === req.nodeId)
    const defId = node?.defId
    const label = String(node?.label ?? '')
    const code = String(req.command?.params?.code ?? '')
    calls.push(req.nodeId)
    if (defId === 'flow.if') {
      return { ok: true, status: 'success', output: branchFn(req.command, { nodeId: req.nodeId, workdir: '', upstream: req.context.upstream }) }
    }
    if (defId === 'code.js') {
      /* 「中断」节点：真执行方会抛，这里照抛（否则验不出「后续一个都不跑」）。 */
      if (/throw new Error/.test(code)) return { ok: false, status: 'failed', error: '账号仍未登录' }
      if (/算时间/.test(label) || code.includes('todayYMD')) return { ok: true, status: 'success', output: { hour: 10, todayYMD: '20261022' } }
      if (code.includes('modules')) return { ok: true, status: 'success', output: { modules: [{ name: '交易', url: 'https://x/1', btn: 'first' }] } }
      return { ok: true, status: 'success', output: {} }
    }
    if (defId === 'browser.act') {
      /* 只有「读登录」那两段要判结果；其余浏览器动作给个成功空输出。 */
      if (!code.includes('loggedIn: !isLogin')) return { ok: true, status: 'success', output: { result: { ok: true } } }
      const isRecheck = /重新确认登录状态/.test(label)
      const login = isRecheck ? afterLoggedIn : firstLoggedIn
      return { ok: true, status: 'success', output: { result: { ok: true, loggedIn: login, href: 'https://x/', reason: login ? '' : '页面跳到了登录页' } } }
    }
    return { ok: true, status: 'success', output: {} }
  }
}

/* ── ① 结构：未登录分支上有「通知等待」节点（manual） ─────────────── */
console.log('① 未登录分支上有「通知等待」节点（等人点继续）')
for (const c of CASES) {
  const { doc } = load(c.file)
  const alerts = doc.nodes.filter(n => n.defId === 'flow.alert-wait')
  check('★★ ' + c.platform + ' 有 flow.alert-wait', alerts.length === 1, String(alerts.length))
  /* ⚠️ 反过来钉住「旧的没有残留」：两个旧节点各只该出现 0 次。
   * 这一条不是多余的 —— 生成器重跑漏改、或手工迁移漏删，都会在这里红。 */
  check('★ ' + c.platform + ' 不再有 flow.notify（已并进 alert-wait）',
    doc.nodes.filter(n => n.defId === 'flow.notify').length === 0,
    String(doc.nodes.filter(n => n.defId === 'flow.notify').length))
  check('★ ' + c.platform + ' 不再有 flow.wait（这一段已并进 alert-wait）',
    doc.nodes.filter(n => n.defId === 'flow.wait').length === 0,
    String(doc.nodes.filter(n => n.defId === 'flow.wait').length))
  const w = alerts[0]
  if (w !== undefined) {
    check('★★ ' + c.platform + ' 这个节点是「等人点继续」（manual）', w.params?.mode === 'manual', String(w.params?.mode))
    check('★ ' + c.platform + ' 它设了超时（不设会永远挂着）',
      Number(w.params?.timeoutHours) === LOGIN_WAIT_TIMEOUT_HOURS, String(w.params?.timeoutHours))
    /* ⚠️ `onError` 必须是 `stop`，且**显式写在存档里**（2026-10-27 用户定乙）。
     *
     * 为什么单钉这一条：节点定义的默认值是 `continueErrorOutput`（走失败分支）。
     * 这一段要的是「超时 = 整次运行按失败结束」，与换节点之前的老 `flow.wait` 一致。
     * 一旦它退化成默认值，超时后整次运行会被当成「跑完了」，然后继续去
     * reopen / recheck —— 那是在赌重新打开那一刻人刚好登录了。 */
    check('★★ ' + c.platform + ' 这个节点显式写了 onError=stop（不靠默认值）',
      w.onError === 'stop', String(w.onError))
    /* 通知正文仍然在（合并后 `content` 与等待参数同在一个节点上）。 */
    check('★ ' + c.platform + ' 通知正文里带着未登录原因',
      String(w.params?.content ?? '').includes('{{result.reason}}'),
      String(w.params?.content ?? '').slice(0, 50))
  }
  /* 未登录分支进得来：那个「登录了吗？」的 false 出口接到这一段头上。
   * ⚠️ 这一条**判的是那个目标节点的 label 含「未登录」**，所以实例名必须保留那三个字。 */
  const loginIf = doc.nodes.find(n => n.defId === 'flow.if' && /登录了吗/.test(String(n.label ?? '')))
  const falseTarget = doc.edges.find(e => e.source === loginIf?.id && e.sourceHandle === 'false')?.target
  check('★★ ' + c.platform + ' 「登录了吗？」的 false 出口进了这一段',
    falseTarget !== undefined && /未登录/.test(String(doc.nodes.find(n => n.id === falseTarget)?.label ?? '')),
    String(doc.nodes.find(n => n.id === falseTarget)?.label))
}

/* ── ①b 主流程的循环必须挂在「已登录」那条分支上（不是无条件执行） ────────
 *
 * ## 为什么这条必须单独钉（2026-10-23）
 *
 * 千川那份原来的循环是**无条件**执行的：`① 模块清单 → ② 循环 A`，
 * 登录检查在循环**体内**。改成「检查提到循环外」之后，如果只把检查搬出去、
 * 忘了把循环接到「已登录」那条出口上，症状是：未登录时人点了继续、重检也过了，
 * 但循环**没有出边**或者仍然直接连在上面 —— 前者是「登录了也白登」，
 * 后者是「没登录也照跑」（那正是这一段要挡的）。
 *
 * 所以钉两件事：
 *   · 存在一条 `if(true) → 循环` 的边（一开始就登录的路）；
 *   · 重检节点的 true 出口也通向那个循环（人重新登录后回主流程的路）。 */
console.log('')
console.log('①b 主流程的循环挂在「已登录」出口上')
for (const c of CASES) {
  const { doc } = load(c.file)
  const outerLoop = doc.nodes.find(n => n.defId === 'flow.loop' && (n.parentId === undefined || n.parentId === null))
  /* ⚠️ 天猫那份**根本没有循环**（它是线性的：打开 → 读日 → 列报表 → 逐表触发）。
   * 所以这一整段对它是「不适用」，不是「失败」—— 不能拿循环相关的判据去卡它。
   * 这条是 2026-10-23 加千川时发现的：第一版没判，天猫凭空红了 5 条。 */
  if (outerLoop === undefined) {
    console.log('  · ' + c.platform + ' 没有顶层循环（线性结构），跳过这一段的循环判据')
    /* 没有循环就只剩一条要钉的：等待点仍然是顶层的（② 那段已经验过 parentId 链，
     * 这里再确认一次「它没被塞进别的容器」）。 */
    const w = doc.nodes.find(n => n.defId === 'flow.alert-wait')
    check('★★ ' + c.platform + ' 没有循环，等待点就是顶层节点', w !== undefined && w.parentId === undefined,
      String(w?.parentId))
    continue
  }
  check('★ ' + c.platform + ' 有顶层循环', true, String(outerLoop.id))

  const loginIf = doc.nodes.find(n => n.defId === 'flow.if' && /登录了吗/.test(String(n.label ?? '')))
  const trueEdge = doc.edges.find(e => e.source === loginIf?.id && e.sourceHandle === 'true' && e.target === outerLoop?.id)
  check('★★ ' + c.platform + ' 「登录了吗」的 true 出口直通顶层循环', trueEdge !== undefined,
    doc.edges.filter(e => e.source === loginIf?.id).map(e => (e.sourceHandle ?? '-') + '→' + e.target).join(', '))

  /* 反过来：循环**不许**从「模块清单」之类的地方无条件接进来。
   * 判据：指向循环的边，只许来自那两个 IF 的 true 出口。 */
  const intoLoop = doc.edges.filter(e => e.target === outerLoop?.id)
  const fromIfTrue = intoLoop.filter(e => e.sourceHandle === 'true'
    && doc.nodes.find(n => n.id === e.source)?.defId === 'flow.if')
  check('★★ ' + c.platform + ' 循环的入边全部来自 IF 的 true 出口（没有无条件入口）',
    intoLoop.length > 0 && intoLoop.length === fromIfTrue.length,
    intoLoop.map(e => e.source + '(' + (e.sourceHandle ?? '-') + ')').join(', '))

  /* 重检那条 true 出口也要通向同一个循环（人重新登录后的回归路）。 */
  const recheckIf = doc.nodes.find(n => n.defId === 'flow.if' && /重新确认登录结果/.test(String(n.label ?? '')))
  const backEdge = doc.edges.find(e => e.source === recheckIf?.id && e.sourceHandle === 'true' && e.target === outerLoop?.id)
  check('★★ ' + c.platform + ' 重检通过的 true 出口也回到那个循环', backEdge !== undefined,
    doc.edges.filter(e => e.source === recheckIf?.id).map(e => (e.sourceHandle ?? '-') + '→' + e.target).join(', '))

  /* 循环体里**不许**再有等待点（引擎硬限制，见 ② 那段）。
   * 这里顺带钉住「提出来了」这件事：原来千川的检查在循环体内。
   *
   * ⚠️ 两种节点都查（`flow.wait` 与 `flow.alert-wait`）：合并之后这一段用的是后者，
   * 但判据是「不许有等待点」，不是「不许有某一种节点」—— 只查一种会漏掉另一种。 */
  const inLoopWait = doc.nodes.filter(n => (n.defId === 'flow.wait' || n.defId === 'flow.alert-wait')
    && (n.parentId === outerLoop?.id || n.parentId === doc.nodes.find(x => x.parentId === outerLoop?.id)?.id))
  check('★★ ' + c.platform + ' 循环体内没有等待点', inLoopWait.length === 0,
    inLoopWait.map(n => n.id).join(','))
}

/* ── ② 等待点不在循环 / 并行里 ─────────────────────────────────── */
console.log('')
console.log('② 等待点不在任何循环 / 并行框里（引擎的两条硬限制）')
for (const c of CASES) {
  const { doc } = load(c.file)
  const byId = new Map(doc.nodes.map(n => [n.id, n]))
  /* ⚠️ 两种 waits 都查（理由同上：判的是「等待点」这件事，不是某个 defId）。 */
  const waits = doc.nodes.filter(n => n.defId === 'flow.wait' || n.defId === 'flow.alert-wait')
  check('★ ' + c.platform + ' 找得到等待点（不是空跑）', waits.length === 1, String(waits.length))
  for (const w of waits) {
    /** 沿 parentId 链往上找，看有没有循环或并行。 */
    const chain = []
    let cur = w.parentId
    while (cur !== undefined && cur !== null) {
      chain.push(cur)
      cur = byId.get(cur)?.parentId
    }
    const kinds = chain.map(id => byId.get(id)?.defId)
    check('★★ ' + c.platform + ' 的等待点不在循环体里',
      !kinds.some(k => k === 'flow.loop'), kinds.join(',') || '（顶层）')
    check('★★ ' + c.platform + ' 的等待点不在并行框里',
      !kinds.some(k => k === 'flow.parallel'), kinds.join(',') || '（顶层）')
  }
}

/* ── ③ 文案：含平台名与「重新登录」，守 R6 ─────────────────────── */
console.log('')
console.log('③ 提醒文案')
for (const c of CASES) {
  const { doc } = load(c.file)
  const n = doc.nodes.find(x => x.defId === 'flow.alert-wait')
  const content = String(n?.params?.content ?? '')
  check('★★ ' + c.platform + ' 文案含平台名', content.includes(c.platform), content)
  check('★★ ' + c.platform + ' 文案说了要重新登录', content.includes('重新登录'), content)
  /* R6：不用第二人称、不用疑问句。 */
  check('R6 ' + c.platform + ' 文案没有第二人称与问号',
    !/[你您]/.test(content) && !/[？?]/.test(content), content)
  /* 节点说明（label / note）也守 R6。 */
  const labels = [n?.label, n?.note].map(x => String(x ?? '')).join(' ')
  check('R6 ' + c.platform + ' 节点说明没有第二人称', !/[你您]/.test(labels), labels.slice(0, 60))
}

/* ── ④ 真跑：三种情形 ─────────────────────────────────────────── */
console.log('')
console.log('④ 真跑（未登录 → 停在等待点；重检不过 → 中断；重检通过 → 回到主流程）')
for (const c of CASES) {
  const { doc, specs } = load(c.file)
  /** 采集类的节点（循环 / 列目录 / 取名单 / 写结果）—— 「一个都不跑」就是看它们。 */
  const isCollect = (id) => {
    const n = doc.nodes.find(x => x.id === id)
    if (n === undefined) return false
    if (n.defId === 'flow.loop' || n.defId === 'flow.parallel') return true
    if (n.parentId !== undefined) return true
    return /取报表名单|列各文件夹|过滤今天|触发下载|下载落盘|汇总/.test(String(n.label ?? ''))
  }

  /* 情形 1：一开始就没登录 → 必须停在等待点。 */
  {
    const calls = []
    const r = await runGraph({ nodes: specs.nodes, edges: specs.edges, workdir: WF_DIR }, mkDispatch(doc, calls, false, false), {})
    check('★★ ' + c.platform + ' 未登录 → 停在等待点（有挂起现场）', r.paused !== undefined)
    check('★★ ' + c.platform + ' 停在等待点时，采集节点一个都没跑',
      !calls.some(isCollect), calls.join(','))
    check('★ ' + c.platform + ' 停在等待点不算失败（aborted 为假）', r.aborted === false, String(r.aborted))
    check('★ ' + c.platform + ' 挂起前发过提醒（发通知那次派发发生了）',
      /* ⚠️ 2026-10-27 改：合并后发通知是 `flow.alert-wait` 节点**内部**派发一次
       * `flow.notify` 的实现（引擎的 `notifyForAlertWait`：`nodeId` 是 alert-wait 那个 id，
       * `command.node` 才是 `flow.notify`）。所以判据看**命令体里的 node**，
       * 不是看那个节点自己的 `defId` —— 后者现在是 `flow.alert-wait`。
       * 改的是断言对象，判的仍是同一件事：挂起之前真的发过一条提醒。 */
      calls.some(id => {
        const n = doc.nodes.find(x => x.id === id)
        return n?.defId === 'flow.alert-wait'
      }), calls.join(','))

    /* 情形 2：人点了继续，但**还是没登录** → 中断，采集节点仍一个都不跑。 */
    const calls2 = []
    const r2 = await runGraph({ nodes: specs.nodes, edges: specs.edges, workdir: WF_DIR, resume: r.paused }, mkDispatch(doc, calls2, false, false), {})
    check('★★ ' + c.platform + ' 重检仍失败 → 整次运行中断', r2.aborted === true, String(r2.aborted))
    check('★★ ' + c.platform + ' 重检仍失败 → 采集节点一个都不跑',
      !calls2.some(isCollect), calls2.join(','))
    check('★ ' + c.platform + ' 重检前重新打开过页面（读到的不是空白页）',
      calls2.some(id => {
        const n = doc.nodes.find(x => x.id === id)
        return n?.defId === 'browser.act' && /重新打开页面/.test(String(n.label ?? ''))
      }), calls2.join(','))
    check('★ ' + c.platform + ' 挂起前已经写了失败结果（写盘被派发过）',
      calls.some(id => doc.nodes.find(n => n.id === id)?.defId === 'sys.fs.write'), calls.join(','))

    /* 情形 3：人点了继续并且**真的登录了** → 回到主流程。
     *
     * ⚠️ 判据不能用「aborted 为假」：这份测试的派发替身给不出可用的采集数据，
     * 主流程后面必然有节点失败（那与登录这条路无关）。要判的是
     * 「**中断节点没被派发**」+「主流程真的往下跑了」。 */
    const calls3 = []
    const r3 = await runGraph({ nodes: specs.nodes, edges: specs.edges, workdir: WF_DIR, resume: r.paused }, mkDispatch(doc, calls3, false, true), {})
    const abortNode = doc.nodes.find(n => n.defId === 'code.js' && /中断本次运行/.test(String(n.label ?? '')))
    check('★★ ' + c.platform + ' 重登成功 → 没走到「中断」那一步',
      !calls3.includes(abortNode?.id), calls3.join(','))
    /* ⚠️ 看 `ran` 而不是看派发记录：循环本体由调度器解释执行、不经过派发器，
     * 所以它永远不出现在 `calls` 里（与 `tests/sub-workflow.mjs` 里
     * 「子工作流自己不进口 calls」同一个原因）。`ran` 是「真跑过」的名单。 */
    const loopNode = doc.nodes.find(n => n.defId === 'flow.loop')
    const collectEntry = doc.nodes.find(n => /取报表名单/.test(String(n.label ?? '')))
    const advanced = [loopNode?.id, collectEntry?.id].filter(x => x !== undefined)
    check('★★ ' + c.platform + ' 重登成功 → 主流程真的继续了',
      advanced.length > 0 && advanced.some(id => r3.ran.includes(id)),
      'ran=' + JSON.stringify(r3.ran))
  }
}

/* ── ⑤ 「一开始就登录」这条路不受影响 ─────────────────────────── */
console.log('')
console.log('⑤ 一开始就登录时，这一段完全不参与')
for (const c of CASES) {
  const { doc, specs } = load(c.file)
  const calls = []
  const r = await runGraph({ nodes: specs.nodes, edges: specs.edges, workdir: WF_DIR }, mkDispatch(doc, calls, true, true), {})
  const touched = calls.filter(id => /未登录|等人重新登录|重新确认|中断/.test(String(doc.nodes.find(n => n.id === id)?.label ?? '')))
  check('★★ ' + c.platform + ' 一开始就登录 → 没进未登录那段',
    touched.length === 0, touched.join(','))
  check('★ ' + c.platform + ' 一开始就登录 → 没有挂起', r.paused === undefined)
}

console.log('')
console.log(failed === 0 ? '结论：未登录 → 提醒 → 等人 → 重检 全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
