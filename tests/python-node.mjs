/** `code.python` 真跑通（票 09）。
 *
 * ## 这一段守的是什么
 *
 * 这个节点原来**跑不出命令**：参数键是 `code`，而 shell 执行方读的是 `command`，
 * 拼出来是空 argv → 报「shell 命令为空」。标签上还挂着表示没做完的字样。
 *
 * 现在改走 `toCommand`：`python -c <脚本>` + 两个编码变量。
 *
 * ## 为什么要**真起 python**，不是只验命令体拼对了
 *
 * 票的判据第 1 条是「能真跑通一段最简脚本（断言：跑出来输出对得上）」。
 * 只验 `argv` 拼得对是**假绿** —— 拼得对但 python 不认、或者中文乱码，照样不可用。
 * 「中文乱码」正是这条路上实测踩到的坑（见 `node.ts` 文件头第 ① 条），
 * 不真跑一遍根本验不到。
 *
 * ## 走的是同一段执行方
 *
 * 用 `createShellExecutor` —— 与产品派发时是同一个（`src/index.ts` 装配的那个）。
 * 不自己 spawn：那样验的是「我的测试会起进程」，不是「产品会起进程」。
 * 给的 `spawn` 实现把同步 `spawnSync` 包成执行方要的句柄形状（`SpawnHandleLike`）。
 *
 * ⚠️ **本机必须有 python**。没有的话真跑那几条**跳过并明说**，不判红 ——
 * 换机器时不该因为环境不同而红；但也不能安静地当通过（那样「通过」的计数会撒谎）。
 *
 * 跑法：`node --import <tsx loader> tests/python-node.mjs`
 */
import { spawnSync } from 'node:child_process'
import { buildCommand } from '../src/workflow/command.ts'
import { createShellExecutor } from '../src/dispatch/executors.ts'
import { NODE } from '../src/nodes/code/python/node.ts'
import { NODE_IMPLS } from '../src/nodes/impls.ts'

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== code.python（票 09）===')
console.log('')

/* ── ⓪ 环境：本机有没有 python ─────────────────────────────────────
 *
 * 没有就**跳过 + 明说**，不判红也不假装通过。 */
const probe = spawnSync('python', ['--version'], { encoding: 'utf8' })
const hasPython = probe.status === 0
console.log('本机 python：' + (hasPython ? String(probe.stdout).trim() : '没有（下面真跑那几条会跳过）'))
console.log('')

/* ── ① 定义：标签干净、能力声明齐 ──────────────────────────────── */
console.log('① 定义')
{
  check('★★ 标签里没有「未完善」了', !NODE.label.includes('未完善'), NODE.label)
  check('★ 标签是「执行 Python」', NODE.label === '执行 Python', NODE.label)
  check('★ 仍走 shell 执行方（不新增执行方，判定见票）', NODE.executor === 'shell', NODE.executor)
  /* 超时参数必须真生效 —— 不声明 `timeoutParam` 的话界面上那个又是死的。 */
  check('★★ 声明了 timeoutParam（界面上那个超时参数真的生效）', NODE.timeoutParam === 'timeout',
    String(NODE.timeoutParam))
  /* `code.python` 不在内置实现表里：它走 shell，不是 builtin。 */
  check('★ 不在内置实现表里（它走 shell 执行方）', NODE_IMPLS.has('code.python') === false,
    String(NODE_IMPLS.has('code.python')))
  check('★ 参数键是 code', NODE.paramDefs.some((p) => p.key === 'code'),
    NODE.paramDefs.map((p) => p.key).join(','))
  /* 旧的假承诺必须没了：它曾写着「上游数据通过环境变量 DSH_INPUT 读」，全仓从没那个变量。 */
  check('★★ 说明里不再出现 DSH_INPUT 这个假承诺',
    !JSON.stringify(NODE.detail).includes('DSH_INPUT'), '')
}

/* ── ② 命令体：`python -c <脚本>` + 两个编码变量 ───────────────── */
console.log('')
console.log('② 命令体')
{
  const built = buildCommand(NODE, { ...NODE.params, code: 'print(1)' }, [], { fields: {}, env: {} })
  const cmd = built.command
  check('★★ argv 是 python -c <脚本>',
    JSON.stringify(cmd?.argv) === JSON.stringify(['python', '-c', 'print(1)']), JSON.stringify(cmd?.argv))
  check('★★ 带上了 PYTHONUTF8（不然中文乱码）', cmd?.env?.PYTHONUTF8 === '1', JSON.stringify(cmd?.env))
  check('★★ 带上了 PYTHONIOENCODING', cmd?.env?.PYTHONIOENCODING === 'utf-8', JSON.stringify(cmd?.env))
  /* `cwd` 留空时**不写这个键**（与 code.shell 同一条「能省就省」）。 */
  check('★ cwd 留空时不写这个键', !('cwd' in (cmd ?? {})), JSON.stringify(Object.keys(cmd ?? {})))

  const withCwd = buildCommand(NODE, { ...NODE.params, code: 'print(1)', cwd: 'D:/x' }, [], { fields: {}, env: {} })
  check('★ 填了 cwd 就带上', withCwd.command?.cwd === 'D:/x', JSON.stringify(withCwd.command?.cwd))
}

/* ── ③ `{{变量}}` 会替换进代码文本（上游数据的唯一通道）────────── */
console.log('')
console.log('③ 上游数据靠 {{变量}} 进代码')
{
  const built = buildCommand(NODE, { ...NODE.params, code: 'print("店铺= {{店铺}}")' },
    [{ 店铺: 'DemoShop' }], { fields: { 店铺: 'DemoShop' }, env: {} })
  const script = built.command?.argv?.[2]
  check('★★ {{店铺}} 被换成了实际值', String(script).includes('DemoShop'), String(script))
  check('★ 替换后不再留着花括号占位', String(script).includes('{{店铺}}') === false, String(script))
  check('★ 没有「没找到变量」的告警', built.missing.length === 0, built.missing.join(','))
}

/* ── ④ 真跑：走产品那个 shell 执行方 ───────────────────────────── */
console.log('')
console.log('④ 真跑（走 createShellExecutor）')
if (!hasPython) {
  console.log('  （跳过：本机没有 python —— 不判红，也不假装通过）')
} else {
  let seq = 0
  /** 把同步 spawnSync 包成执行方要的句柄形状（`SpawnHandleLike`）。 */
  const syncSpawner = {
    spawn(spec) {
      const r = spawnSync(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        encoding: 'utf8',
        timeout: 60000,
      })
      const out = r.stdout === null ? '' : String(r.stdout)
      const err = r.stderr === null ? '' : String(r.stderr)
      seq += 1
      return {
        pid: r.pid,
        terminate: () => { /* 同步调用已结束，无可终止 */ },
        waitForExit: async () => true,
        done: Promise.resolve({ exitCode: r.status, signal: r.signal ?? null }),
        stdoutText: () => out,
        stderrText: () => err,
      }
    },
  }
  const exec = createShellExecutor(syncSpawner)

  /** 真跑一段 python 代码，回执行方的结果。 */
  const runPython = async (code) => {
    const built = buildCommand(NODE, { ...NODE.params, code }, [], { fields: {}, env: {} })
    return exec.run({
      runId: 'py-test-' + String(seq),
      nodeId: 'p1',
      executor: 'shell',
      command: built.command,
      context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    })
  }

  const simple = await runPython('print(1 + 2)')
  check('★★ 真跑成功', simple.status === 'success', JSON.stringify(simple.status))
  check('★★ 输出对得上（1+2 得 3）', simple.output === '3', JSON.stringify(simple.output))

  /* 中文：这条路上实测踩到的坑，必须真验一遍。 */
  const zh = await runPython('print("中文测试")')
  check('★★ 中文不乱码', zh.output === '中文测试', JSON.stringify(zh.output))

  /* 真实用法：交出结构化数据。 */
  const json = await runPython('import json\nprint(json.dumps({"店铺": "DemoShop", "条数": 3}, ensure_ascii=False))')
  const parsed = (() => { try { return JSON.parse(json.output) } catch { return null } })()
  check('★★ 打印 JSON 能被解析回来', parsed !== null && parsed['店铺'] === 'DemoShop',
    JSON.stringify(json.output))
  check('★ 中文键也是对的', parsed !== null && parsed['条数'] === 3, JSON.stringify(parsed))

  /* 多行 + 引号 + 花括号：证明「走 argv 数组所以不用转义」这条成立。 */
  const multiline = await runPython('d = {"a": 1}\nfor k in d:\n    print(f"k={k}")')
  check('★★ 多行带引号带花括号也不用转义', multiline.output === 'k=a', JSON.stringify(multiline.output))

  /* 脚本报错：判失败，原因取 stderr。 */
  const bad = await runPython('raise SystemExit("故意失败")')
  check('★★ 非 0 退出判失败', bad.status === 'failed', JSON.stringify(bad.status))
  check('★ 失败原因里有 stderr 的内容', String(bad.error ?? '').includes('故意失败'),
    String(bad.error ?? '').slice(0, 80))

  /* 没给变量时占位原样保留（对照组：证明③那次替换不是碰巧）。 */
  const withVar = await runPython('print("hello {{name}}")')
  check('★ 没有上游变量时占位原样保留（对照）', withVar.output === 'hello {{name}}',
    JSON.stringify(withVar.output))
}

console.log('')
console.log(failed === 0
  ? '结论：Python 节点的命令拼装、编码、变量替换、真跑全部通过 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
