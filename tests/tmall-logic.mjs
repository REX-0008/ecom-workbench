/** 离线验「天猫取数」的纯逻辑部分（不开任何页面）。
 *
 * 用户红线：不开抖音/天猫页面、不改真实文件。所以这里**只跑纯函数**：
 *   · `TM_FILTER_TODAY`（今天已下载的过滤 —— 含那个 UTC 差一天的坑）
 *   · `TM_PICK_FILENAME`（从直链取文件名 + 剥壳 + 剔除没地址的）
 *
 * ⚠️ **2026-10-15 起「连续失败护栏」不再是画布节点** —— 用户定「删掉」。
 * 它不 `throw`，触发不了 `onError:'stop'`，**本来就不生效**（见
 * `pitfalls/假防线-看着写了其实不生效.md`）；它夹带的纯数据职责（剥壳 + 剔除没地址的）
 * 并进了 `TM_PICK_FILENAME`。**真的护栏在 ⑩ 下载那步的 shell 脚本里**
 * （`tmall-shell.mjs` 的 `CONSECUTIVE_LIMIT = 2`，两种失败都管）。
 *
 * ⚠️ 页面内那两段（`TM_FETCH_REPORTS` / `TM_TRIGGER_AND_POLL`）**没法离线跑**
 * （它们要在真页面上 fetch）—— 那部分由用户手动单步测（他明说了会这么测）。
 * 所以本测试**不假装覆盖它们**，只覆盖纯逻辑（外加「假护栏没回来」的反向断言）。
 */
import { TM_FETCH_REPORTS, TM_FILTER_TODAY, TM_TRIGGER_AND_POLL, TM_PICK_FILENAME } from '../scripts/browser/tmall-code.mjs'

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}
async function run(code, input) {
  const fn = new Function('input', '"use strict";return (async () => {' + code + '})()')
  return await fn(input)
}

/* 今天的 YYYYMMDD（本地）—— 用它造「今天已下载」的场景。 */
const now = new Date()
const todayYMD = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0')

/* ── ① 过滤今天已下载的 ── */
console.log('=== ① 过滤今天已下载的（含 UTC 差一天的坑）===')
{
  const reports = [
    { id: 1, name: '店铺-整体', folder: 'D-店铺-整体-天猫' },
    { id: 2, name: '店铺-搜索-关键词', folder: 'D-店铺-搜索-天猫' },
    { id: 3, name: '商品-整体', folder: 'S-商品-整体-天猫' },
  ]
  const dirs = [
    /* 第一个文件夹里有「今天下载」的文件 → 应被跳过。 */
    { folder: 'D-店铺-整体-天猫', files: ['店铺-整体_' + todayYMD + '.xlsx'] },
    /* 第二个里有**别的日期**的文件 → 仍要下。 */
    { folder: 'D-店铺-搜索-天猫', files: ['店铺-搜索-20250101.xlsx'] },
  ]
  const r = await run(TM_FILTER_TODAY, [{ reports }, { dirs }])
  console.log('  todayYMD = ' + r.todayYMD)
  console.log('  要下: ' + JSON.stringify(r.reports.map(x => x.folder)))
  console.log('  跳过: ' + JSON.stringify(r.skipped))
  check('★ 今天已下载的被跳过', r.skipped.includes('D-店铺-整体-天猫'), JSON.stringify(r.skipped))
  check('★ 别的日期的仍要下', r.reports.some(x => x.folder === 'D-店铺-搜索-天猫'), JSON.stringify(r.reports))
  check('★ 没文件的也要下（第一次跑）', r.reports.some(x => x.folder === 'S-商品-整体-天猫'))
  check('★ 用的是**本地**日期（todayYMD 与本地一致）', r.todayYMD === todayYMD, r.todayYMD + ' vs ' + todayYMD)

  /* ⚠️ 反向自证那个 UTC 坑：UTC 日期在东八区早上 8 点前会**差一天**。 */
  const utcYMD = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  console.log('  UTC 日期: ' + utcYMD + '  本地日期: ' + todayYMD + '  ' + (utcYMD === todayYMD ? '（此刻相同）' : '（此刻不同 —— 正是那个坑）'))
  /* ⚠️ 判据要锚到**实际算 todayYMD 的那几行**，不能查「整段里有没有 toISOString」
   * —— 注释里为了警告这件事**专门写了** toISOString 这个词，
   * 查整段就会被注释救活（我第一版就是，测试无意义地红了）。
   * 而那个赋值**跨三行**，所以要从 `todayYMD =` 那行往后取几行一起看。 */
  const lines = TM_FILTER_TODAY.split('\n')
  const start = lines.findIndex(l => l.includes('todayYMD ='))
  const stmt = lines.slice(start, start + 4).join('\n')
  check('★ 取日期那几行没用 toISOString（它按 UTC 走会差一天）',
    start >= 0 && !stmt.includes('toISOString'), stmt.replace(/\n/g, ' | ').trim())
  check('★ 取日期那几行用的是本地 getFullYear/getMonth/getDate',
    start >= 0 && stmt.includes('getFullYear') && stmt.includes('getMonth') && stmt.includes('getDate'),
    stmt.replace(/\n/g, ' | ').trim())
}

/* ── ② ★ 数据链的「剥壳」+ 剔除没地址的（这块踩过两次，必须钉住）──
 *
 * 事实：`browser.act` 的输出被驱动包了一层 —— 页面脚本 `return X`，
 * 工作流里拿到的（即下游节点的 `input`）是 **`{ result: X }`**（见 driver.mjs 的 actEval）。
 * 而 `code.shell` 的输出**没有**这一层（它就是脚本打在 stdout 的那行 JSON）。
 *
 * 所以凡是要读 `browser.act` 输出的 `code.js`，都得**往里剥一层**。
 *
 * ⚠️ 不剥的后果是**静默的**（很难查）：
 *   · 「⑤b 拼 reports.json」不剥 → 报「报表名单是空的」
 *   · 「⑨ 从直链取文件名」不剥 → 计划恒为空，**而且不报错**
 *     （看着像「今天没有要下的」）
 * 实测数据：直接喂 `{result:{results:[…]}}` 给 ⑨ → count=0；
 *          喂剥过的 `{results:[…]}` → count=2。
 *
 * ⚠️ **2026-10-15 起，剥壳在 ⑨「从直链取文件名」里** —— 原先它在
 * 「连续失败护栏」那个节点（`TM_GUARD_AND_PICK`）里，护栏已删
 * （它不 `throw`，触发不了 `onError:'stop'`，见 `pitfalls/假防线-看着写了其实不生效.md`）。
 * 剥壳与「剔除没地址的」这两件**纯数据**的事并进了 ⑨。
 * **真的护栏在 ⑩ 下载那步的脚本里**（`CONSECUTIVE_LIMIT = 2`），不在画布节点上。
 */
console.log('')
console.log('=== ② 剥壳 + 剔除没地址的（⑨ 从直链取文件名）===')
{
  const withResult = { result: { results: [
    { id: 1, folder: 'F1', name: 'A', url: 'http://x/a.xlsx' },
    { id: 2, folder: 'F2', name: 'B', url: 'http://x/b.xlsx' },
  ] } }
  const g1 = await run(TM_PICK_FILENAME, withResult)
  check('★ 能剥壳（喂 {result:{results}} 也能认出 2 个）', g1.count === 2, String(g1.count))

  const plain = { results: [{ id: 1, folder: 'F1', name: 'A', url: 'http://x/a.xlsx' }] }
  const g2 = await run(TM_PICK_FILENAME, plain)
  check('★ 不包壳的也能认（万一上游换成别的节点）', g2.count === 1, String(g2.count))

  /* 没拿到地址的**不许进计划** —— 否则 ⑩ 会拿着 null 去下载。
   * （这原本是护栏节点干的，护栏删掉后并到 ⑨，所以这条断言跟着搬过来。） */
  const mixed = { result: { results: [
    { id: 1, url: null }, { id: 2, url: 'http://x/ok.xlsx' }, { id: 3, url: undefined },
  ] } }
  const g3 = await run(TM_PICK_FILENAME, mixed)
  check('★ 没地址的**不进**计划', g3.count === 1, String(g3.count))
  check('★ 没地址的被计进 missing（原护栏的统计口径）', g3.missing === 2 && g3.total === 3,
    JSON.stringify({ m: g3.missing, t: g3.total }))
  check('计划里没有 url 为空的项', g3.plan.every(p => p.url), JSON.stringify(g3.plan.map(p => p.url)))

  /* 过滤那步同理（它要同时认 browser.act 与 code.shell 两种形状）。 */
  const f1 = await run(TM_FILTER_TODAY, [
    { result: { reports: [{ id: 1, folder: 'F1' }] } },
    { ok: true, dirs: [] },
  ])
  check('★ 过滤能剥壳（browser.act 那份）', f1.reports.length === 1, String(f1.reports.length))

  /* ⚠️ 反向自证：注释里写了不算 —— 判据看代码里真有剥壳那两行。 */
  check('⑨ 代码里真写了剥壳（看 .result）', TM_PICK_FILENAME.includes('up.result'), '')
  check('过滤代码里真写了剥壳（看 .result）', TM_FILTER_TODAY.includes('v.result'), '')

  /* ⚠️ **删掉的假护栏不许回来**（2026-10-15 用户定）。
   * 判据：那段的特征串（`stopped` + `连续`）不该再出现在任何一段画布代码里。
   * 真的护栏在 ⑩ 的 shell 脚本里（`CONSECUTIVE_LIMIT`），那条由 tm 那侧的
   * `tmall-shell.mjs` 自己验，不在这里。 */
  for (const [name, src] of [
    ['⑨ 取文件名', TM_PICK_FILENAME],
    ['⑦ 过滤今天', TM_FILTER_TODAY],
    ['⑤ 取报表名单', TM_FETCH_REPORTS],
    ['⑧ 触发+轮询', TM_TRIGGER_AND_POLL],
  ]) {
    const fake = src.includes('连续') && src.includes('stopped')
    check('★ 假护栏没回来（' + name + ' 里没有 stopped+连续）', !fake,
      fake ? '★ 又出现了' : '')
  }
}

/* ── ③ 从直链取文件名 ── */
console.log('')
console.log('=== ③ 从 OSS 直链取文件名 ===')
{
  const r = await run(TM_PICK_FILENAME, { result: { results: [
    { id: 1, name: 'A', folder: 'F1', url: 'https://oss.example.com/path/%E5%BA%97%E9%93%BA-20260101.xlsx?sign=abc' },
    { id: 2, name: 'B', folder: 'F2', url: 'https://oss.example.com/plain-20260102.xlsx' },
  ] } })
  console.log('  plan: ' + JSON.stringify(r.plan.map(p => p.file)))
  check('★ 取到文件名（去掉 query）', r.plan[0].file === '店铺-20260101.xlsx', r.plan[0].file)
  check('★ 中文文件名解码了', r.plan[0].file.includes('店铺'), r.plan[0].file)
  check('★ 无编码的也正常', r.plan[1].file === 'plain-20260102.xlsx', r.plan[1].file)
  check('folder 带下来了（落盘要用）', r.plan[0].folder === 'F1', r.plan[0].folder)
  check('统计信息带下来了', r.count === 2 && r.total === 2 && r.missing === 0,
    JSON.stringify({ c: r.count, t: r.total, m: r.missing }))

  const e = await run(TM_PICK_FILENAME, {})
  check('空输入不崩', e.plan.length === 0 && e.count === 0)
}

console.log('')
console.log(failed === 0 ? '结论：天猫取数的纯逻辑离线验过 ✓（页面内那两段留给用户手动测）'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
