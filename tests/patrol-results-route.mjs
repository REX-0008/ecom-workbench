/** 巡查结果的只读读路（票 11，2026-10-30）。
 *
 * # 它守的是什么
 *
 * 总览要「显示数据本身」，而巡查结果的指标明细此前**没有任何接口能拿到**：
 * `collect/records` 读的是归档格式（`outputs` / `reports`），不读 `blocks`；
 * `/workflow/runs` 是运行历史，只有「成没成、跑多久」，没有数字。
 *
 * # 最要紧的一条判据是「哪些文件不该被当成巡查结果」
 *
 * `patrol/` 里住着三种完全不同的东西（`tm-sycm.json` / `douyin-ui.json` 是另一条取数路，
 * `巡查-<名字>-<时间戳>.json` 是归档的运行记录）。按文件名前缀扫就会把它们报成「坏了」——
 * 那是假警报，比没有这条路由更糟：用户会去修一份根本没坏的东西。
 *
 * 所以判据 4（那三类一栏都不进）是本票的核心，它的自证是把「按名单认」改成「按前缀扫」，
 * 那一步必须立刻变红。
 *
 * # 数据是造的，不是读真存档
 *
 * 五份名单文件在沙箱里按真实形状造一遍（含那份形状错的）。
 * 为什么：真存档会随时间变（每天巡查都会覆盖），断言写死了就会隔天红。
 * 形状照 `F:/AGENTS/agent-chat-dsh/profiles/desktop/data/ecom-workbench/patrol/`
 * 的实测内容抄，文件头注明。
 *
 * 跑法：`DSH_HOME=F:/AGENTS/agent-chat-dsh node scripts/run-tests.mjs patrol-results-route`
 */
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

const sandbox = await mkdtemp(join(tmpdir(), 'ewb-patrolres-'))
process.env.EWB_TEST_HOME = join(sandbox, 'data')
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { patrolDir } = await import('../src/schedule/records.ts')
const { PATROL_RESULT_FILES, patrolCacheFile } = await import('../src/schedule/patrol-results.ts')
const { PATROL_JOBS } = await import('../scripts/patrol/jobs.mjs')

let handler = null
apply({
  inject(names, fn) {
    if (names.includes('webServer')) fn({ webServer: { register(route) { handler = route.handler } } })
    if (names.includes('subprocess')) fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
  },
  effect() { return () => { /* 清理 */ } },
})

let bad = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} detail - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/**
 * 模拟一次 HTTP 调用。
 * @param {string} method - 方法。
 * @param {string} url - 路径。
 * @returns {Promise<{code:number, json:any}>} 响应。
 */
async function call(method, url) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let code = 0
  let text = ''
  res.writeHead = (c) => { code = c }
  res.end = (s) => { text = String(s ?? '') }
  res.writableEnded = false
  await handler(req, res)
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { code, json }
}

/**
 * 一份形状正确的巡查结果（照 `patrol-tm-shop.json` 的真实字段抄）。
 * @param {string} job - 任务短名。
 * @param {string} platform - 平台。
 * @returns {object} 结果。
 */
function goodResult(job, platform) {
  return {
    job,
    platform,
    runAt: '2026-10-19T22:54:00.205Z',
    dataDate: '2026-10-20',
    ok: true,
    error: null,
    blocks: [
      {
        id: 'tm-score',
        title: '天猫店铺评分',
        state: 'warn',
        summary: '物流 4.68',
        url: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/',
        urlLabel: '打开天猫后台',
        items: [
          { label: '体验', value: '5.00', state: 'ok', note: '' },
          { label: '商品', value: '5.00', state: 'ok', note: '' },
          /* 这一条是 `state: warn` —— 判据 1 与自证 3 都盯着它：
           * 按 `state` 过滤一次，它就会消失。 */
          { label: '物流', value: '4.68', state: 'warn', note: '' },
          { label: '服务', value: '5.00', state: 'ok', note: '' },
        ],
      },
    ],
  }
}

/**
 * 造沙箱里那批文件（照真存档的实测形状）。
 * @returns {Promise<void>}
 */
async function seed() {
  const dir = patrolDir()
  await mkdir(dir, { recursive: true })
  const put = async (name, obj) => {
    await writeFile(join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8')
  }
  await put('patrol-tm-shop.json', goodResult('patrol-tm-shop', 'tm'))
  await put('patrol-dy-shop.json', goodResult('patrol-dy-shop', 'dy'))
  /* 千川那份真实文件是 `ok: false` 但形状合格 —— 专门留着验「失败不算坏文件」。 */
  const qc = goodResult('patrol-dy-qianchuan', 'dy')
  qc.ok = false
  qc.error = '千川余额不足'
  qc.blocks[0].state = 'bad'
  await put('patrol-dy-qianchuan.json', qc)
  /* 形状错的那份：结果装在单数 `block` 里、没有 runAt / dataDate。 */
  await put('patrol-tm-activity.json', {
    platform: 'tm',
    ok: false,
    error: '天猫活动卡片未匹配到（页面结构待适配）',
    block: {
      id: 'tm-activity', title: '天猫活动报名', state: 'unknown',
      summary: '卡片未匹配到，需人工查看', items: [{ label: '表格提取', value: '未匹配到', state: 'unknown', note: '' }],
    },
  })
  /* 名单里有、盘上没有：patrol-dy-activity.json 故意不写（判据 3 用它）。
   * 注意：不能既「不写」又拿它测「不是合法 JSON」—— 那是两件事，
   * 后者在下面 ⑦ 段单独写一次、断言它是 broken 而不是 missing。 */
  /* 以下三类**不是巡查结果**，判据 4 盯着它们。 */
  await put('tm-sycm.json', {
    job: 'tm-sycm', runAt: '2026-10-22T20:24:32.689Z', ok: false,
    error: '夜禁时段（01:00-06:00）未跑', downloaded: [], skipped: [],
  })
  await put('douyin-ui.json', { ok: true, total: 30, okCount: 30, failCount: 0, stoppedModules: [], note: '' })
  await put('巡查-抖音-店铺数据-20261023-041729-zg6o.json', {
    startedAt: 1761173849000, outputs: { a: 1 }, runId: '20261023-041729-zg6o', via: '定时',
  })
}

await seed()

/* ── ① 名单与生成器一侧对得上 ──────────────────────────────────── */

console.log('① 名单（宿主半的镜像）与 `scripts/patrol/jobs.mjs` 逐条对上')
{
  const theirs = PATROL_JOBS.map(j => ({ file: j.outFile, name: j.name, platform: j.platform }))
  check('★★ 五个文件、五条名字、五个平台逐条相同',
    JSON.stringify(PATROL_RESULT_FILES) === JSON.stringify(theirs),
    JSON.stringify(PATROL_RESULT_FILES.map(f => f.file)))
  check('★★ 一条不多一条不少（5 = 5）', PATROL_RESULT_FILES.length === 5 && theirs.length === 5,
    String(PATROL_RESULT_FILES.length) + ' / ' + String(theirs.length))
}

/* ── ② 三栏分得开 ─────────────────────────────────────────────── */

console.log('')
console.log('② 三栏：正常 / 读不出 / 不在')
const r = await call('GET', '/api/ecom-workbench/patrol/results')
const data = r.json
{
  check('★★ 路由 200 且 ok', r.code === 200 && data?.ok === true, String(r.code))
  check('★★ 正常那栏三份（tm-shop / dy-shop / dy-qianchuan）',
    (data?.items ?? []).length === 3, (data?.items ?? []).map(i => i.file).join(','))
  check('★★★ 形状错的那份进 broken（不是 items，也不是 missing）',
    (data?.broken ?? []).some(b => b.file === 'patrol-tm-activity.json'),
    (data?.broken ?? []).map(b => b.file).join(','))
  check('★★★ `why` 点名缺哪个字段（说人话，不是一句「形状不对」）',
    (() => {
      const b = (data?.broken ?? []).find(x => x.file === 'patrol-tm-activity.json')
      const w = String(b?.why ?? '')
      return w.includes('runAt') && w.includes('dataDate') && w.includes('block')
    })(),
    String((data?.broken ?? []).find(x => x.file === 'patrol-tm-activity.json')?.why))
  check('★★★ 名单里有盘上不在的那份进 missing',
    (data?.missing ?? []).length === 1 && data.missing[0].file === 'patrol-dy-activity.json',
    JSON.stringify(data?.missing ?? null))
  check('★★ missing 里带名字（界面画占位卡要它）',
    data?.missing?.[0]?.name === '巡查-抖音-活动报名', String(data?.missing?.[0]?.name))
  check('★★★ broken 与 missing 是两个字段、互不包含（不是合成一栏）',
    Array.isArray(data?.broken) && Array.isArray(data?.missing)
    && !(data.broken ?? []).some(b => b.file === 'patrol-dy-activity.json')
    && !(data.missing ?? []).some(m => m.file === 'patrol-tm-activity.json'),
    'broken=' + String((data?.broken ?? []).length) + ' missing=' + String((data?.missing ?? []).length))
}

/* ── ③ 那三类一栏都不进（本票核心判据）────────────────────────── */

console.log('')
console.log('③ tm-sycm / douyin-ui / 巡查-* 一栏都不进（不是巡查结果）')
{
  const all = [
    ...(data?.items ?? []).map(x => x.file),
    ...(data?.broken ?? []).map(x => x.file),
    ...(data?.missing ?? []).map(x => x.file),
  ]
  const intruders = all.filter(f => f === 'tm-sycm.json' || f === 'douyin-ui.json' || f.startsWith('巡查-'))
  check('★★★ tm-sycm / douyin-ui / 巡查-* 在三栏里出现 0 次', intruders.length === 0, intruders.join(','))
  check('★★ 三栏加起来正好 5 条（名单就 5 份，不多不少）', all.length === 5, String(all.length) + '：' + all.join(','))
}

/* ── ④ 字段原样透传，不归并、不过滤 ────────────────────────────── */

console.log('')
console.log('④ blocks 与 items 的字段逐字保留')
{
  const tm = (data?.items ?? []).find(i => i.file === 'patrol-tm-shop.json')
  check('★★ 文件里 `ok` / `error` / `dataDate` 原样带出',
    tm?.ok === true && tm?.error === null && tm?.dataDate === '2026-10-20'
    && tm?.runAt === '2026-10-19T22:54:00.205Z',
    JSON.stringify({ ok: tm?.ok, error: tm?.error, d: tm?.dataDate, r: tm?.runAt }))
  const block = tm?.blocks?.[0]
  check('★★★ 块的六个字段全在（id / title / state / summary / url / urlLabel）',
    block?.id === 'tm-score' && block?.title === '天猫店铺评分' && block?.state === 'warn'
    && block?.summary === '物流 4.68'
    && block?.url === 'https://myseller.taobao.com/home.htm/QnworkbenchHome/'
    && block?.urlLabel === '打开天猫后台',
    JSON.stringify({ id: block?.id, s: block?.state, u: block?.urlLabel }))
  check('★★★ 块里四条指标全在，`state: warn` 那条没被过滤掉',
    (block?.items ?? []).length === 4,
    (block?.items ?? []).map(i => i.label + '=' + i.state).join(','))
  check('★★★ 那一条的字段逐字相等（label / value / state / note）',
    JSON.stringify(block?.items?.[2]) === JSON.stringify({ label: '物流', value: '4.68', state: 'warn', note: '' }),
    JSON.stringify(block?.items?.[2]))

  /* 失败但形状合格的那份：它必须在 items 里，块里那个 `state: bad` 也要在。 */
  const qc = (data?.items ?? []).find(i => i.file === 'patrol-dy-qianchuan.json')
  check('★★★ 巡查自己失败（ok: false）的文件仍算「正常形状」，进 items',
    qc !== undefined, String(qc?.file))
  check('★★ 它的 `ok: false` 与错误原因原样带出（不吞）',
    qc?.ok === false && qc?.error === '千川余额不足', JSON.stringify({ ok: qc?.ok, e: qc?.error }))
  check('★★ 它的块 `state: bad` 原样带出（没被当坏文件丢掉）',
    qc?.blocks?.[0]?.state === 'bad', String(qc?.blocks?.[0]?.state))
}

/* ── ⑤ 列表类接口的键名约定 ────────────────────────────────────── */

console.log('')
console.log('⑤ 具名键与 items 的约定')
{
  check('★★ `results` 与 `items` 指向同一个数组',
    Array.isArray(data?.results) && Array.isArray(data?.items)
    && JSON.stringify(data.results) === JSON.stringify(data.items),
    String(data?.results?.length) + ' / ' + String(data?.items?.length))
  check('★ 具名键不是把三栏包起来（它就是正常那一栏）',
    (data?.results ?? []).every(x => typeof x.file === 'string' && Array.isArray(x.blocks)),
    '')
}

/* ── ⑥ 只读：不写盘 ────────────────────────────────────────────── */

console.log('')
console.log('⑥ 这条路由不写盘')
{
  const dir = patrolDir()
  const before = new Map()
  for (const f of await readdir(dir)) before.set(f, (await stat(join(dir, f))).mtimeMs)
  const again = await call('GET', '/api/ecom-workbench/patrol/results')
  const after = new Map()
  for (const f of await readdir(dir)) after.set(f, (await stat(join(dir, f))).mtimeMs)
  const changed = [...before.keys()].filter(f => before.get(f) !== after.get(f))
  check('★★★ 读两次之后每个文件的修改时间一个都不变',
    changed.length === 0, changed.join(','))
  check('★★ 文件名集合也不变（没有新文件被写出来）',
    before.size === after.size, String(before.size) + ' → ' + String(after.size))
  check('★ 第二次读回的内容与第一次相同（没有「读一次改一次」）',
    JSON.stringify(again.json?.items) === JSON.stringify(data?.items), '')
}

/* ── ⑦ 「文件在但读不出」与「文件不在」的分界线 ─────────────────── */

console.log('')
console.log('⑦ 同一份文件：读不出归 broken，不在归 missing')
{
  const dir = patrolDir()
  /* 把「不在」那份换成「在但不是合法 JSON」—— 同一份文件、只改存在性，
   * 它必须从 missing 挪到 broken。这一条是判据 2/3 的分界线，同一条路由两次读 */
  await writeFile(join(dir, 'patrol-dy-activity.json'), '{ 这不是 JSON', 'utf8')
  const r2 = await call('GET', '/api/ecom-workbench/patrol/results')
  check('★★★ 文件在、内容不是合法 JSON → broken（不是 missing）',
    (r2.json?.missing ?? []).length === 0
    && (r2.json?.broken ?? []).some(b => b.file === 'patrol-dy-activity.json'),
    'missing=' + JSON.stringify((r2.json?.missing ?? []).map(m => m.file))
    + ' broken=' + JSON.stringify((r2.json?.broken ?? []).map(b => b.file)))
  check('★★ 它那条 `why` 说清是读不出（不是缺字段）',
    /JSON/.test(String((r2.json?.broken ?? []).find(b => b.file === 'patrol-dy-activity.json')?.why ?? '')),
    String((r2.json?.broken ?? []).find(b => b.file === 'patrol-dy-activity.json')?.why))
  /* 还原成「不在」，免得后面的段读到的状态与前面不一致。 */
  const { rm } = await import('node:fs/promises')
  await rm(join(dir, 'patrol-dy-activity.json'), { force: true })
}

/* ── ⑧ 目录整个不存在 ───────────────────────────────────────────── */
console.log('')
console.log('⑧ patrol/ 目录不存在（一次都没跑过）')
{
  const { rm } = await import('node:fs/promises')
  const dir = patrolDir()
  const keep = await readdir(dir)
  for (const f of keep) await rm(join(dir, f), { force: true })
  /* ⚠️ 缓存也要清（票 14 之后）。不清的话，前面段落读到的有效块会被补偿补回 `items`，
   * 「目录空 → 0 / 0 / 5」就变成「1 / 0 / 5」—— 而那是票 14 的**正确行为**，
   * 这一条要验的却是「一次都没跑过」的干净状态。 */
  await rm(patrolCacheFile(), { force: true })
  const r3 = await call('GET', '/api/ecom-workbench/patrol/results')
  check('★★ 目录空 → 三栏是 0 / 0 / 5（不是报错、不是 404）',
    r3.code === 200 && (r3.json?.items ?? []).length === 0
    && (r3.json?.broken ?? []).length === 0 && (r3.json?.missing ?? []).length === 5,
    String(r3.code) + ' / ' + String((r3.json?.items ?? []).length)
    + ' / ' + String((r3.json?.broken ?? []).length) + ' / ' + String((r3.json?.missing ?? []).length))
  check('★★ 五份的名字都在 missing 里（界面能画满五张占位卡）',
    (r3.json?.missing ?? []).map(m => m.name).join(',') === PATROL_RESULT_FILES.map(f => f.name).join(','),
    (r3.json?.missing ?? []).map(m => m.name).join(','))
}

/* ── ⑨ 默认巡查任务从这份清单派生（票 12）──────────────────────── */

console.log('')
console.log('⑨ defaultPatrolTasks 从 PATROL_RESULT_FILES 派生（票 12）')
{
  const { defaultPatrolTasks } = await import('../src/schedule/store.ts')

  /* `newTaskId()` 里有一截 `Math.random()`（`s-<日期>-<时分秒>-<4位随机>`）。
   * 不固定它，「id 与今天完全相同」这条断言就会每次红 —— 而且红的不是逻辑，
   * 是那个随机尾巴。固定成常数之后，**日期时分秒那一段**才是被验的东西。 */
  const realRandom = Math.random
  Math.random = () => 0.123456789
  const NOW = new Date(2026, 9, 30, 9, 30, 0, 0).getTime()
  let made
  try {
    made = defaultPatrolTasks(NOW)
  } finally {
    Math.random = realRandom
  }

  check('★★ 五条', made.length === 5, String(made.length))
  check('★★★ 五条的名字与顺序逐条相同（派生顺序变了这条就红）',
    made.map(t => t.workflowName).join(',')
    === '巡查-天猫-店铺数据,巡查-天猫-活动报名,巡查-抖音-店铺数据,巡查-抖音-活动报名,巡查-抖音-千川余额',
    made.map(t => t.workflowName).join(','))
  check('★★ `[自动生成] ` 前缀还在', made.every(t => t.name.startsWith('[自动生成] ')),
    JSON.stringify(made.map(t => t.name)))
  /* 这一条是本票的分量所在：id 按 index 编号（`now + i * 1000`），而用户已有的
   * 定时任务按 id 对 —— 所以真正要钉的是「**哪个 id 对应哪份工作流**」，
   * 不是「id 序列长什么样」。
   *
   * ⚠️ 第一版只断言 `id` 序列（`s-…-093000, s-…-093001, …`），自证时调换顺序
   * 它**照样绿** —— 因为 id 只依赖序号，名字换到第几条都不影响那个序列。
   * 那种写法验的是「序号算得对不对」，不是「id 与任务的配对有没有变」。
   * 改成 id 与名字配对之后才抓得到。 */
  check('★★★ 五条「id → 工作流名」的配对与今天逐条相同（配对变了这条就红）',
    made.map(t => t.id + '=' + t.workflowName).join(',')
    === 's-20261030-093000-4fzz=巡查-天猫-店铺数据,'
    + 's-20261030-093001-4fzz=巡查-天猫-活动报名,'
    + 's-20261030-093002-4fzz=巡查-抖音-店铺数据,'
    + 's-20261030-093003-4fzz=巡查-抖音-活动报名,'
    + 's-20261030-093004-4fzz=巡查-抖音-千川余额',
    made.map(t => t.id + '=' + t.workflowName).join(','))
  check('★★ 其余字段与合并前一致（时间 09:30、启用、notes）',
    made.every(t => t.time === '09:30' && t.enabled === true
      && t.note === '首次启动自动生成：每天 09:30 跑一份巡查'),
    JSON.stringify(made[0]))
  check('★★★ 派生源就是那份清单（名字逐条等于 PATROL_RESULT_FILES 的 name）',
    made.map(t => t.workflowName).join(',') === PATROL_RESULT_FILES.map(f => f.name).join(','),
    '')
}

console.log(bad === 0 ? '\n全部通过 ✓' : '\n' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
