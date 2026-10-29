/** 跑全部测试（自动区分「直接 node」与「需要 tsx loader」）。
 *
 * ## 为什么要有这个脚本
 *
 * 本项目 41 个测试分两类，**跑法不一样**：
 *   · 纯 node：只 import 自己的东西（或只读源码文本做断言）
 *   · 需要 tsx loader：`import` 了 `src/**` 或 `scripts/**` 的 `.ts` / `.mjs`
 *
 * 分不清就会**假红**（用 node 直接跑带 `.ts` import 的测试 → 报语法错），
 * 而这个错与代码无关，最后只会被忽略（`AGENTS.md` 里记着这个教训）。
 *
 * 所以判据**自动推断**：读测试文件里有没有
 * `from '../src/` / `from '../scripts/` 这类 import ——
 * 有就加 tsx loader，没有就直接 node。
 * ⚠️ 不维护一份手写清单（那必然过期，`AGENTS.md` 已声明不再维护清单）。
 *
 * ## 用法
 *
 * ```
 * node scripts/run-tests.mjs              # 跑全部，只报结果
 * node scripts/run-tests.mjs -v           # 跑全部，逐个报
 * node scripts/run-tests.mjs dom-render … # 只跑点名的那几个
 * ```
 *
 * 退出码：全绿 0；有红的 1（并列出红的名单 + 它的输出尾部）。
 *
 * ## 耗时（2026-10-26 加）
 *
 * 跑完会多报一段：
 *   · 只跑了 1 个 → 紧跟「通过」那行报「耗时：2.3s」（不空行，读着是一件事）；
 *   · 跑了 2 ~ 5 个 → 「各测试耗时」全列（不叫「最慢的」，因为全都在表里）；
 *   · 跑了 5 个以上 → 「最慢的 5 个」按耗时降序截断，附合计；
 *   · 单个超过 20 秒的行尾标 `⚠️ 慢`（`-v` 时每个测试那一行也跟着标）。
 *
 * 那段**只报不改**：不参与「通过 / 红的 / 跳过」三行计数，也不影响退出码。
 * 目的只有一个：让「刚改的这处会不会让测试变慢」这个问题**有地方可查**。
 *
 * ## 约定：`tests/` 下以 `_` 开头的文件是**共享工具**，不是测试
 *
 * 例如 `tests/_wait.mjs`（界面那几个测试共用的等待替身）—— 它导出函数，
 * **一条断言都没有**。
 *
 * ⚠️ 必须排除掉，理由是这份脚本自己的职责：**「通过」不许把「没验到」包进去**。
 * 不排除的话，它会作为一个「通过」混进计数里 —— `全部 119 个通过 ✓` 里
 * 有 1 个是空文件，别人看总数以为覆盖面变大了，其实什么都没多验。
 * 这与本文件下面 `[SKIP]` 那段要防的是同一件事：**别让计数说谎**。
 *
 * 反过来说：往 `tests/` 放共享工具时**必须**用 `_` 前缀，
 * 否则它会被当成一个测试跑、并混进「通过」里。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TESTS = join(ROOT, 'tests')

/** tsx loader 的路径（与 AGENTS.md 里写的一致）。 */
const TSX_LOADER = 'file:///F:/AGENTS/agent-chat-dsh/refs/deepseek-harness@62962ee4/node_modules/tsx/dist/loader.mjs'

/**
 * 这个测试要不要 tsx loader？
 *
 * 判据：它有没有 import 我们的源码（`src/` 或 `scripts/`）。
 * ⚠️ 只认**真的 import 语句**（行首是 `import` / `from`），
 * 不认注释里提到的路径 —— 否则注释会把判据救活。
 *
 * @param {string} file - 测试文件名（如 `dom-render.mjs`）。
 * @returns {boolean} 需要 loader 就 true。
 */
function needsTsx(file) {
  const src = readFileSync(join(TESTS, file), 'utf8')
  for (const line of src.split('\n')) {
    const t = line.trim()
    /* 跳过注释行（含 JSDoc 的 `*` 行）。 */
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue
    /* ⚠️ **动态 `import()` 也算**（2026-10-21 加，起因是 `error-boundary` 假红）：
     * 它要先 `register()` 装一个「.css 当空对象」的加载钩子，再
     * `await import('../src/.../ErrorBoundary.tsx')` —— 静态 import 会被提升到
     * 钩子**之前**求值，所以只能动态引。
     * 只认静态 import 的话这个测试被判「纯 node」→ 用 node 直接跑 →
     * 报 `Unknown file extension ".tsx"`（看着像代码错，其实是判据漏了）。 */
    const isDynamicSrcImport = /import\s*\(\s*['"]\.\.\/(src|scripts)\//.test(t)
    if (!/^(import|export)\b/.test(t) && !isDynamicSrcImport) continue
    if (isDynamicSrcImport) return true
    if (/from\s+'\.\.\/(src|scripts)\//.test(t)) return true
  }
  return false
}

const args = process.argv.slice(2)
const verbose = args.includes('-v') || args.includes('--verbose')
const named = args.filter(a => !a.startsWith('-'))

/* ── 耗时报告的三个常量（2026-10-26 加）────────────────────────────
 *
 * ⚠️ 必须定义在下面的循环**之前**：`const` 有暂时性死区（TDZ），
 * 在循环里第一次调 `slow()` 时如果还没执行到这三行，会直接抛
 * `Cannot access 'SLOW_MS' before initialization`。
 * 项目里 `check:tdz` 那个脚本专门抓这类错（`tests/tdz-check.mjs`）。 */

/** 单个测试超过这个毫秒数就算「慢」。20 秒是经验阈值：全量两百秒左右，
 * 一个人吃掉 20 秒就是一成，那种多半是「在真等」而不是在验。 */
const SLOW_MS = 20000
/** 标记文本（行尾用）。 */
const SLOW_MARK = '⚠️ 慢'
/** 汇总里列几个最慢的。 */
const SLOW_TOP = 5

/* ⚠️ 排除以 `_` 开头的文件：那是**共享工具**（如 `_wait.mjs`），不是测试。
 * 它没有断言，混进来会让「全部 N 个通过」这个计数说谎 —— 见文件头那条约定。 */
const all = readdirSync(TESTS).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()
const picked = named.length > 0
  ? all.filter(f => named.some(n => f === n || f === n + '.mjs' || f.includes(n)))
  : all

if (picked.length === 0) {
  console.log('没有匹配的测试。可用：' + all.map(f => f.replace('.mjs', '')).join(' '))
  process.exit(1)
}

/* ⚠️ 沙箱环境变量：`collect` 那个测试**不设 `EWB_TEST_SKILLS` 就会去动真实的
 * `$DSH_HOME/skills`**（那是红线，`AGENTS.md` 里写明了）。所以这里统一设上。 */
const env = { ...process.env }
if (env.EWB_TEST_HOME === undefined || env.EWB_TEST_HOME === '') {
  env.EWB_TEST_HOME = join(process.env.TEMP ?? '/tmp', 'ewb-run-tests')
}
if (env.EWB_TEST_SKILLS === undefined || env.EWB_TEST_SKILLS === '') {
  env.EWB_TEST_SKILLS = join(env.EWB_TEST_HOME, 'skills')
}

console.log('跑 ' + String(picked.length) + ' 个测试'
  + (picked.length === all.length ? '' : '（共 ' + String(all.length) + ' 个）') + '…')
console.log('')

/**
 * 从测试输出里捞 `[SKIP]` 行。
 *
 * ## 为什么需要它（2026-10-23 加）
 *
 * 有些测试在**环境不满足**时会主动跳过（端口被占、找不到 chromium、没有真实存档…），
 * 它们 `exit 0`。而这份运行器原来**只看退出码**：绿的时候连 stdout 都不读。
 * 于是「跳过了、一个断言都没验」与「全验了、全过」在输出上**完全一样** ——
 * 那是假绿，等于把「没验到」报成「验过了」。
 *
 * 约定：跳过的测试在自己的 stdout 里打一行以 `[SKIP]` 开头的话。
 * 这份运行器把它们捞出来，单独汇总一句，让「通过」这两个字不再把「跳过」包进去。
 *
 * ⚠️ 约定只管**前缀**，不管内容 —— 各测试自己说清跳过的原因，运行器只负责别把它吞掉。
 * @param {string} out - 该测试的 stdout + stderr。
 * @returns {string[]} 以 `[SKIP]` 开头的行（已去掉前缀与首尾空白）。
 */
function skipLines(out) {
  const found = []
  for (const raw of String(out).split('\n')) {
    const t = raw.trim()
    if (!t.startsWith('[SKIP]')) continue
    const why = t.slice('[SKIP]'.length).trim()
    if (why !== '') found.push(why)
  }
  return found
}

const failed = []
/** 绿的但主动跳过的：`{ file, why[] }`。与 `failed` 分开记，它们不是失败。 */
const skipped = []
/** 每个测试的耗时：`{ file, ms, ok }`（按跑的顺序）。 */
const timings = []
for (const f of picked) {
  const withTsx = needsTsx(f)
  const argv = withTsx
    ? ['--import', TSX_LOADER, join(TESTS, f)]
    : [join(TESTS, f)]
  /* 计时包住**整个子进程**（含它自己的 import 与收尾），不是只算派发那一下。 */
  const t0 = Date.now()
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', env, cwd: ROOT, windowsHide: true })
  const ms = Date.now() - t0
  const out = String(r.stdout ?? '') + String(r.stderr ?? '')
  const ok = r.status === 0
  timings.push({ file: f, ms, ok })
  if (!ok) failed.push({ file: f, out, withTsx })
  /* 绿的时候也要看一眼有没有跳过 —— 这正是这次改动的全部意义。 */
  if (ok) {
    const why = skipLines(out)
    if (why.length > 0) skipped.push({ file: f, why })
  }
  if (verbose || !ok) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + f + (withTsx ? '  [tsx]' : '')
      + '  ' + secs(ms) + (slow(ms) ? '  ' + SLOW_MARK : ''))
  }
}

/**
 * 秒数文本（一位小数）。
 * @param {number} ms - 毫秒。
 * @returns {string} 如 `2.3s`。
 */
function secs(ms) {
  return (ms / 1000).toFixed(1) + 's'
}

/**
 * 这一格算不算「慢」。
 *
 * ⚠️ 20 秒是**经验阈值**，不是硬标准：全量一百多个测试合计两百秒左右，
 * 单个吃掉 20 秒就意味着它一个人占了一成 —— 那种多半是「在真等」而不是在验。
 * @param {number} ms - 毫秒。
 * @returns {boolean} 超过阈值就 true。
 */
function slow(ms) {
  return ms > SLOW_MS
}

/**
 * 报耗时。
 *
 * ## 为什么要有它
 *
 * 全量从 575 秒压到 200 秒之后，**没人知道哪一个慢、哪一个变慢了** ——
 * 超时输出里只有总数，看不到分布。下一个人改完一处想知道「会不会拖慢测试」，
 * 原来无从得知；现在跑一次就能看见最慢的那几个。
 *
 * ## 判据
 *
 *   · 只跑了 1 个 → 紧跟着「通过」那行报这一个的耗时（不加空行：
 *     空一行会让它看着像另一段，而它本来就是在说同一个测试）；
 *   · 跑了 2 ~ `SLOW_TOP` 个 → 标题写「各测试耗时」并**全列**。
 *     ⚠️ 这里刻意不写「最慢的 N 个」：全部都在表里时，那个说法是**错的**
 *     —— 它不是「最慢的几个」，是「只有这几个」；
 *   · 跑了 `SLOW_TOP` 个以上 → 标题写「最慢的 5 个」，按耗时降序截断；
 *   · 超过 `SLOW_MS` 的行尾标 `⚠️ 慢`。
 *
 * ⚠️ 这一段**只报不改**：不参与「通过 / 红的 / 跳过」那三行的计数，
 * 也不改退出码。那三行是所有人对账用的，措辞与数字都不许动。
 */
function reportTimings() {
  if (timings.length === 0) return
  const total = timings.reduce((sum, t) => sum + t.ms, 0)
  if (timings.length === 1) {
    /* 不空行：紧跟在「全部 1 个通过 ✓」下面，读起来是同一件事的补充。 */
    const t = timings[0]
    console.log('耗时：' + secs(t.ms) + (slow(t.ms) ? '  ' + SLOW_MARK : ''))
    return
  }
  const sorted = [...timings].sort((a, b) => b.ms - a.ms)
  /* 全部都在表里时说「各测试耗时」；只有截断了才是「最慢的」。 */
  const shown = sorted.length > SLOW_TOP ? sorted.slice(0, SLOW_TOP) : sorted
  console.log('')
  console.log((shown.length === sorted.length ? '各测试耗时' : '最慢的 ' + String(shown.length) + ' 个')
    + '（合计 ' + secs(total) + '）：')
  for (const t of shown) {
    console.log('   ' + t.file.replace(/\.mjs$/, '').padEnd(22) + secs(t.ms).padStart(7)
      + (slow(t.ms) ? '  ' + SLOW_MARK : ''))
  }
  const over = timings.filter(t => slow(t.ms)).length
  console.log(over === 0
    ? '   （没有超过 ' + String(SLOW_MS / 1000) + ' 秒的测试）'
    : '   （其中 ' + String(over) + ' 个超过 ' + String(SLOW_MS / 1000) + ' 秒）')
}

console.log('')
if (failed.length === 0) {
  console.log('全部 ' + String(picked.length) + ' 个通过 ✓')
  /* ⚠️ 有跳过时必须紧跟着说出来：否则「全部通过」会被读成「全部验过了」。 */
  if (skipped.length > 0) {
    console.log('⚠️ 其中 ' + String(skipped.length) + ' 个是「跳过」（不算失败，但也没验到断言）：')
    for (const s of skipped) console.log('   · ' + s.file + ' —— ' + s.why.join(' / '))
    console.log('   （原因多半是环境：端口被占、缺浏览器、缺真实存档。修好环境后重跑才算验过。）')
  }
  reportTimings()
  process.exit(0)
}

console.log('有 ' + String(failed.length) + ' 个红的：' + failed.map(x => x.file).join(', '))
console.log('')
for (const x of failed) {
  console.log('══ ' + x.file + (x.withTsx ? '  [tsx]' : '') + ' ══')
  /* 只打尾部（前面往往是无关的噪声）。 */
  const lines = x.out.trim().split('\n')
  for (const l of lines.slice(-25)) console.log('  ' + l)
  console.log('')
}
/* 红了也报耗时：排查「是不是某个测试在超时」时，这份分布比错误摘要更有用。 */
reportTimings()
process.exit(1)
