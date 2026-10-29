/** 挂起现场**落盘**（\`data/ecom-workbench/paused/<runId>.json\`）。
 *
 * ## 为什么单独测它
 *
 * 落盘这一层最容易坏在两处，而且**都不报错**：
 *   ① 目录算错 → 现场写到别处，恢复时找不到（看着像「挂起丢了」）；
 *   ② 同一份并发写 → 后写的整条覆盖先写的（运行历史已经因为这件事丢过记录，
 *      见 \`workflow-runs.ts\` 的长注释）。
 *
 * 全程在 \`EWB_TEST_HOME\` 沙箱里 —— **绝不碰真实数据目录**（红线）。
 *
 * 跑法：node --import <tsx> tests/pause-store.mjs
 */
const { mkdtemp, rm, readFile, readdir } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const sandbox = await mkdtemp(join(tmpdir(), 'ewb-paused-'))
process.env.EWB_TEST_HOME = join(sandbox, 'home')

const {
  savePausedRun, loadPausedRun, removePausedRun, listPausedRuns, pausedDir, pausedAtOf,
} = await import('../src/workflow/pause-store.ts')

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

/**
 * 造一份现场。
 * @param runId - 运行 id。
 * @param extra - 要覆盖的字段。
 */
function snap(runId, extra = {}) {
  const pausedAt = Date.now()
  return {
    version: 1,
    runId,
    workflowId: '取数-抖音',
    startedAt: pausedAt - 1000,
    pausedAt,
    resumeAfter: 'n-wait',
    ran: ['n1', 'n-wait'],
    executions: 2,
    outputs: { n1: { ok: true } },
    unreachable: [],
    inputs: { 日期: '2026-10-21' },
    wait: { mode: 'duration', resumeAtMs: pausedAt + 60000, ms: 60000 },
    ...extra,
  }
}

console.log('=== 挂起现场落盘（paused/）===')

console.log('① 目录位置：与 workflows/、runs/ 同级')
{
  const dir = pausedDir()
  check('目录名是 paused', dir.endsWith('paused'), dir)
  const { workflowsDir } = await import('../src/workflow/store.ts')
  const parent = join(workflowsDir(), '..')
  check('★ 与 workflows/ 同级（备份 / 搬迁一次带走）', dir.startsWith(parent), dir)
}

console.log('')
console.log('② 存 → 读回来一模一样')
{
  const ok = await savePausedRun(snap('run-a'))
  check('存成功', ok === true)
  const back = await loadPausedRun('run-a')
  check('读得回来', back !== null)
  check('★ runId 对得上', back.runId === 'run-a', String(back?.runId))
  check('★ 输出没丢（下游恢复要用）', back.outputs.n1.ok === true, JSON.stringify(back?.outputs))
  check('★ 输入没丢', back.inputs['日期'] === '2026-10-21', JSON.stringify(back?.inputs))
  check('★ 要等多久没丢', back.wait.ms === 60000, JSON.stringify(back?.wait))
  check('★ 「跑过哪些」没丢', back.ran.join(',') === 'n1,n-wait', back.ran.join(','))
}

console.log('')
console.log('③ 按运行分文件（同时挂起十份 = 十个文件，天然不冲突）')
{
  await savePausedRun(snap('run-b'))
  await savePausedRun(snap('run-c'))
  const files = await readdir(pausedDir())
  check('★ 三份各一个文件', files.filter(f => f.endsWith('.json')).length === 3, files.join(','))
  const list = await listPausedRuns()
  check('★ 列得出三份', list.length === 3, String(list.length))
  check('新的在前', list[0].pausedAt >= list[list.length - 1].pausedAt)
}

console.log('')
console.log('④ 并发写同一份：**不丢**（走串行队列）')
{
  /* 20 个并发写同一份：最后留在磁盘上的必须是**某一次完整的**，
   * 不能是两份拼起来的半截（那会让 JSON 直接解析失败）。 */
  await Promise.all(Array.from({ length: 20 }, (_, i) => savePausedRun(snap('run-d', {
    executions: i,
    outputs: { n1: { i } },
  }))))
  const back = await loadPausedRun('run-d')
  check('★ 文件仍然解析得开（没被写坏）', back !== null)
  check('★ 内容是**某一次完整的**（i 在 0..19 之间）',
    back !== null && back.outputs.n1.i >= 0 && back.outputs.n1.i <= 19,
    JSON.stringify(back?.outputs))
  check('★ 文件里只有一份 JSON（不是两次拼接）', (await readFile(join(pausedDir(), 'run-d.json'), 'utf8')).trim().endsWith('}'),
    '')
}

console.log('')
console.log('⑤ 坏文件 / 不存在的文件：读回来 null，**不抛**')
{
  check('不存在的给 null', await loadPausedRun('从来没有过') === null)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(pausedDir(), 'run-broken.json'), '{ 这不是 JSON', 'utf8')
  check('★ 内容坏了给 null（不抛）', await loadPausedRun('run-broken') === null)
  const list = await listPausedRuns()
  check('★ 坏文件不影响列出其它的', list.length === 4, String(list.length))
}

console.log('')
console.log('⑥ 删：删掉就真没了；本来没有也算成功')
{
  check('删得掉', await removePausedRun('run-a') === true)
  check('★ 删完之后读不到', await loadPausedRun('run-a') === null)
  check('删不存在的也返回 true（调用方只关心「现在没有它」）',
    await removePausedRun('从来没有过') === true)
  check('mtime 查不到时给 null（不抛）', await pausedAtOf('从来没有过') === null)
}

console.log('')
console.log('⑦ runId 里的路径穿越被清洗（安全边界）')
{
  /* ⚠️ runId 来自界面 / 磁盘，必须走 \`safeName\` —— 否则 \`../\` 能写到目录外。
   *
   * ⚠️ 判据是「**有没有跑到目录外**」，不是「文件名里有没有 \`..\`」：
   * \`safeName\` 只把路径分隔符换掉，剩下孤零零的 \`..\` 在文件名里**无害**
   * （它不构成一个目录段）。第一版按「含 ..」判，白红一次。 */
  const outside = join(sandbox, 'home', '逃出去.json')
  await savePausedRun(snap('../../逃出去'))
  const files = await readdir(pausedDir())
  check('★ 没有写到目录外（目录里还是那几个）', files.length === 5, files.join(','))
  let leaked = true
  try { await readFile(outside, 'utf8') } catch { leaked = false }
  check('★★ 目录外那个位置**没有**被写出文件（穿越被挡住）', leaked === false, outside)
  check('★ 它被清洗成了一个**目录内的**文件名', files.some(f => f.includes('逃出去')), files.join(','))
}

await rm(sandbox, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? '结论：挂起现场落盘全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
