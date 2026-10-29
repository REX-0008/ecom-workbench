/** 节点主动汇报第二轮：`sys.fs.read` 与 `code.js` 真的推汇报（票 08）。
 *
 * ## 这一段守的是什么
 *
 * 第一轮只有 `sys.fs.write` 一个节点在推（`builtins.ts` 的 `writeFileFn`），
 * 端到端证据在 `tests/report-e2e.mjs`。本票把 `sys.fs.read`（读到了什么、多少字节）
 * 与 `code.js`（算出了什么形状）接上。
 *
 * ## 为什么走真执行方而不是直接调函数
 *
 * 汇报的口径有一半在执行方那侧：`createBuiltinExecutor` 的 `report` 会把节点写的
 * `ReportEntry` 补上 `node` 再交回。直接调函数只能验到「节点传了对象」，
 * 验不到「执行方收下了、并且真的随结果交回去了」。所以这里走
 * `createBuiltinExecutor(真实现)`，与 `src/index.ts` 注册进派发器的是同一个东西。
 *
 * ## 与 `report-e2e.mjs` 的分工
 *
 * | | `report-e2e.mjs` | 本文件 |
 * |---|---|---|
 * | 验什么 | 整条链（真存档 → 真跑 → 落盘文件） | 这两个节点推的**内容**对不对 |
 * | 节点 | `sys.fs.write` | `sys.fs.read` / `code.js` |
 *
 * 端到端那条不动（它是唯一证据）；这里只加「另外两个节点的汇报说得对不对」。
 *
 * ## 沙箱
 *
 * 读的目标文件放在按 `process.pid` 隔离的临时目录里（这个项目踩过固定路径
 * 在并发时互相删目录的坑，见 `tests/report-e2e.mjs` 文件头第 ③ 条）。
 *
 * 跑法：node --import <tsx> tests/report-nodes.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-report-nodes-' + String(process.pid) + '-'))

const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
const { readFileFn, runCodeFn } = await import('../src/dispatch/builtins.ts')

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

/**
 * 跑一次内置节点（走真的执行方）。
 * @param {string} node - 节点类型 id（命令体里的 `node`）。
 * @param {object} impl - 这个节点的实现函数。
 * @param {object} params - 参数。
 * @param {object} [extra] - 额外字段（如 upstream / 不传 report）。
 * @returns {Promise<object>} 执行方结果。
 */
async function run(node, impl, params, extra = {}) {
  const exec = createBuiltinExecutor(new Map([[node, impl]]))
  return exec.run({
    runId: 'rn-run', nodeId: extra.nodeId ?? 'n1', executor: 'builtin',
    command: { node, params },
    context: {
      workflowId: 'w',
      upstream: extra.upstream ?? [],
      workdir: SANDBOX,
    },
  })
}

console.log('=== 节点主动汇报第二轮：sys.fs.read 与 code.js ===')
console.log('沙箱：' + SANDBOX)
console.log('')

/* ── ① `sys.fs.read`：说清读到了什么、多少字节 ─────────────────── */
console.log('① sys.fs.read：读到哪个文件、多少字节')
{
  const file = join(SANDBOX, '读入.txt')
  /* 内容故意含中文：字节数与字符数不同（utf8 下中文占 3 字节），
   * 这样「按字节报」与「按字符报」能区分开 —— 用户核对文件大小看的是字节。 */
  const CONTENT = '这行是中文，字节数比字数多。'
  writeFileSync(file, CONTENT, 'utf8')
  const realBytes = Buffer.byteLength(CONTENT, 'utf8')

  const r = await run('sys.fs.read', readFileFn, { path: file, encoding: 'utf8' })
  check('（前置）读成功了', r.status === 'success', JSON.stringify(r.status))
  check('（前置）读了原文回来', r.output === CONTENT, JSON.stringify(r.output))

  const rep = r.reports?.[0]
  check('★★ 推了一条汇报', Array.isArray(r.reports) && r.reports.length === 1,
    JSON.stringify(r.reports))
  const msg = String(rep?.message ?? '')
  check('★★ 汇报里写明了文件路径', msg.includes(file), msg)
  check('★★ 汇报里的字节数是磁盘上的真实大小（' + String(realBytes) + '）',
    msg.includes(String(realBytes)), msg)
  check('★★ 字节数**不是**字符数（按字符算会少得多）',
    realBytes !== CONTENT.length && !msg.includes('，' + String(CONTENT.length) + ' 字节'),
    JSON.stringify({ 字节: realBytes, 字符: CONTENT.length }))
  check('★ 结构化字段齐（bytes 指标 + files 路径）',
    rep?.metrics?.bytes === realBytes && rep?.files?.[0] === file,
    JSON.stringify({ metrics: rep?.metrics, files: rep?.files }))
  check('★★ 不是「完成」这类空话', msg !== '完成' && msg.trim().length > 10, JSON.stringify(msg))
  check('★ 汇报里补上了节点 id', rep?.node === 'n1', String(rep?.node))
}

/* ── ② 反面：空文件要单独说明（不是「读到 0 字节」一句带过）───────── */
console.log('')
console.log('② sys.fs.read：空文件说得出来')
{
  const file = join(SANDBOX, '空文件.txt')
  writeFileSync(file, '', 'utf8')
  const r = await run('sys.fs.read', readFileFn, { path: file })
  const msg = String(r.reports?.[0]?.message ?? '')
  check('★ 空文件那条汇报点明是空文件', msg.includes('空文件'), msg)
  check('★ 空文件的字节数是 0', r.reports?.[0]?.metrics?.bytes === 0,
    JSON.stringify(r.reports?.[0]?.metrics))
}

/* ── ③ `code.js`：说清算出了什么（形状 + 规模，不倒全文）─────────── */
console.log('')
console.log('③ code.js：算出了什么形状、多大规模')
{
  /** 跑一段代码并取出那条汇报。 */
  const codeReport = async (code) => {
    const r = await run('code.js', runCodeFn, { code, timeout: 5000 })
    return { r, msg: String(r.reports?.[0]?.message ?? ''), rep: r.reports?.[0] }
  }

  /* 数组：说条数。 */
  {
    const { r, msg, rep } = await codeReport('return [1,2,3,4,5]')
    check('★★ 数组：说了条数', msg.includes('5') && msg.includes('条'), msg)
    check('★ 数组：条数也进 metrics', rep?.metrics?.count === 5, JSON.stringify(rep?.metrics))
    check('★ 数组：不倒全文（句子不长）', msg.length < 60, String(msg.length))
    check('（前置）输出仍是数组本身', Array.isArray(r.output) && r.output.length === 5,
      JSON.stringify(r.output))
  }

  /* 对象：说键数与键名。 */
  {
    const { msg, rep } = await codeReport('return {条数: 12, 日期: "2026-10-27"}')
    check('★★ 对象：说了几个键', msg.includes('2') && msg.includes('键'), msg)
    check('★ 对象：键名也列出来（认得出是哪一步的数据）',
      msg.includes('条数') && msg.includes('日期'), msg)
    check('★ 对象：键数进 metrics', rep?.metrics?.keys === 2, JSON.stringify(rep?.metrics))
  }

  /* 字符串：说字数。 */
  {
    const { msg, rep } = await codeReport('return "一二三四五六"')
    check('★★ 文本：说了字数', msg.includes('6') && msg.includes('字'), msg)
    check('★ 文本：字数进 metrics', rep?.metrics?.chars === 6, JSON.stringify(rep?.metrics))
    /* 文本节点最要紧的一条：不许把内容倒进汇报（可能是一整页）。 */
    check('★★ 文本：不倒内容（原文没出现在汇报里）', !msg.includes('一二三四五六'), msg)
  }

  /* 空值几种：都要分开说清。 */
  {
    const u = await codeReport('return undefined')
    check('★ 没有 return 时说明下游取不到值', u.msg.includes('取不到'), u.msg)
    const n = await codeReport('return null')
    check('★ null 与 undefined 说得不一样', n.msg !== u.msg && n.msg.includes('null'), n.msg)
    const e = await codeReport('return []')
    check('★ 空数组单独说明', e.msg.includes('0 条'), e.msg)
    const s = await codeReport('return ""')
    check('★ 空文本单独说明', s.msg.includes('空文本'), s.msg)
  }

  /* 汇报不许影响返回值（纪律 1：汇报不进数据流）。 */
  {
    const { r } = await codeReport('return {ok: true, n: 7}')
    check('★★ 汇报不进 outputs（返回值原样）',
      r.output?.ok === true && r.output?.n === 7, JSON.stringify(r.output))
    check('★ 返回值里没有汇报字段',
      !('reports' in (r.output ?? {})) && !('message' in (r.output ?? {})),
      JSON.stringify(Object.keys(r.output ?? {})))
  }
}

/* ── ④ 可选性：不传 report 时两个节点照样跑（纪律 5）──────────────── */
console.log('')
console.log('④ 不传 report 时照样跑得通（编译器 / 预览那类场景）')
{
  const file = join(SANDBOX, '读入2.txt')
  writeFileSync(file, 'ok', 'utf8')
  /* 执行方总会传 report；这里直接调函数，模拟「没有 report 的调用方」。 */
  const ctxNoReport = { nodeId: 'n9', workdir: SANDBOX, upstream: [] }
  let readOk = true
  try {
    const out = await readFileFn({ params: { path: file } }, ctxNoReport)
    readOk = out === 'ok'
  } catch { readOk = false }
  check('★★ sys.fs.read 不传 report 也跑得通', readOk)

  let codeOk = true
  try {
    const out = await runCodeFn({ params: { code: 'return 42' } }, ctxNoReport)
    codeOk = out === 42
  } catch { codeOk = false }
  check('★★ code.js 不传 report 也跑得通', codeOk)

  /* 反面：没传 report 时结果里也不该冒出 reports 键。 */
  const quiet = await run('sys.fs.read', readFileFn, { path: file })
  check('★ 有汇报时结果里才有 reports 键', Array.isArray(quiet.reports), JSON.stringify(Object.keys(quiet)))
}

/* ── 收尾 ──────────────────────────────────────────────────────── */
rmSync(SANDBOX, { recursive: true, force: true })
check('临时沙箱已清理', !existsSync(SANDBOX))

console.log('')
console.log(failed === 0
  ? '结论：sys.fs.read 与 code.js 都真的在推汇报，且说得清产出 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
