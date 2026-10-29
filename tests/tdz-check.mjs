/** 「用在定义之前」（暂时性死区）检查 —— 用 TypeScript 编译器查，不自己写。
 *
 * 为什么需要：这个坑**踩了四次**（copySelected / recordHistory / skipped …），
 * 每次表现都是「构建通过、单测通过，打开画布整个白屏」。
 *
 * 为什么用 tsc 而不是自己写扫描：
 *   我先写了一版手写的行号扫描，因「同名变量在不同函数里各自独立」而**误报 38–66 处**；
 *   按函数边界重写后又误报 38 处。
 *   而 TypeScript 自带这个诊断（**TS2448 / TS2454**），一次就准。→ 用现成的。
 *
 * 做法：对本机没有 @types/react 的现实，用最小声明让 tsc 能解析 JSX，
 * 然后**只挑出 TS2448 / TS2454** 这两类；其余类型噪音忽略。
 *
 * 跑法：node tests/tdz-check.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TSC = '../../refs/deepseek-harness@62962ee4/node_modules/typescript/bin/tsc'

/** 要跑的两份配置：客户端与引擎侧。 */
const CONFIGS = [
  { name: '客户端（组件与画布）', cfg: 'tsconfig.client.json' },
  { name: '引擎侧（工作流与派发）', cfg: 'tsconfig.check.json' },
]

/** 总共发现的问题数。 */
let bad = 0

for (const c of CONFIGS) {
  let out = ''
  try {
    const r = await run(process.execPath, [TSC, '-p', c.cfg], { cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 })
    out = String(r.stdout ?? '')
  } catch (e) {
    out = String(e.stdout ?? '')
  }
  /* 只挑「用在定义之前」这两类（TS2448 / TS2454）。 */
  const hits = out.split('\n').filter(l => /TS2448|TS2454/.test(l))
  const unique = [...new Set(hits.map(h => h.split('(')[0] + ' | ' + (h.match(/(TS\d+)/)?.[1] ?? '')))]
  if (unique.length === 0) {
    console.log('  ✓ ' + c.name + '：没有「用在定义之前」')
  } else {
    bad += unique.length
    console.log('  ✗ ' + c.name + '：发现 ' + String(unique.length) + ' 处')
    for (const u of unique) console.log('      ' + u)
  }
}

console.log(bad === 0 ? '结论：没有「用在定义之前」✓' : '结论：有 ' + String(bad) + ' 处，必须修 ✗')
process.exit(bad === 0 ? 0 : 1)
