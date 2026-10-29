/** 巡查块级补偿：这次没采到就保留上次有效数据（票 14，2026-10-30）。
 *
 * # 它守的是什么
 *
 * 用户第 9 条：「更新没有成功不要更新数据，不是跑了就更新数据，而是**成功拿到数据才更新数据**。」
 *
 * 不做这一层的话，抖音店铺那 11 项一次没采到（`state: 'unknown'`）就真的全变成 `—`，
 * 而上一趟明明采到了。用户看到的是「数据突然没了」，不是「这一趟没采到」。
 *
 * # 判据与段的对应（票面九条）
 *
 * | 段 | 验什么 |
 * |---|---|
 * | ① | 第一次读到有效块 → 写进缓存，`compensated` 空（判据 1） |
 * | ② | 同 id 变 `unknown` → 返回旧块、进 `compensated`（判据 2） |
 * | ③ | 又变回有效 → 覆盖缓存、`compensated` 空（判据 3） |
 * | ④ | 整份 broken → 旧块补回 `items`（判据 4） |
 * | ⑤ | 整份 missing → 同上（判据 5） |
 * | ⑥ | 缓存空 + `unknown` → 原样返回（判据 6） |
 * | ⑦ | `blockAt` 是最后一次真正采到的时间，不是这次跑的（判据 7） |
 * | ⑧ | 缓存坏档 / 写失败 → 路由照常返回（判据 8 / 9） |
 *
 * 跑法：`DSH_HOME=F:/AGENTS/agent-chat-dsh node scripts/run-tests.mjs patrol-compensate`
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

const sandbox = await mkdtemp(join(tmpdir(), 'ewb-patrolcomp-'))
process.env.EWB_TEST_HOME = join(sandbox, 'data')
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { patrolDir } = await import('../src/schedule/records.ts')
const { patrolCacheFile } = await import('../src/schedule/patrol-results.ts')

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
 * 调一次路由。
 * @returns {Promise<{code:number, json:any}>} 响应。
 */
async function call() {
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/api/ecom-workbench/patrol/results'
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
 * 造一份巡查结果文件。
 * @param {string} file - 文件名。
 * @param {object[]} blocks - 块。
 * @param {object} [extra] - 额外字段（覆盖默认）。
 * @returns {Promise<void>}
 */
async function put(file, blocks, extra) {
  const dir = patrolDir()
  await mkdir(dir, { recursive: true })
  const body = {
    job: file.replace(/\.json$/, ''),
    platform: 'dy',
    runAt: '2026-10-29T01:00:00.000Z',
    dataDate: '2026-10-30',
    ok: true,
    error: null,
    blocks,
    ...extra,
  }
  await writeFile(join(dir, file), JSON.stringify(body, null, 2), 'utf8')
}

/**
 * 一个块。
 * @param {string} id - 块 id。
 * @param {string} state - 状态。
 * @param {string} value - 指标值。
 * @returns {object} 块。
 */
function blk(id, state, value) {
  return {
    id, title: id, state, summary: value,
    url: 'https://x', urlLabel: '打开',
    items: [{ label: '余额', value, state, note: '' }],
  }
}

/**
 * 清掉缓存与 patrol 目录（每段之间要干净起点）。
 * @returns {Promise<void>}
 */
async function reset() {
  await rm(patrolDir(), { recursive: true, force: true })
  await rm(patrolCacheFile(), { force: true })
  await mkdir(patrolDir(), { recursive: true })
}

/**
 * 从返回里按块 id 找块（跨所有 items）。
 * @param {object} json - 回包。
 * @param {string} id - 块 id。
 * @returns {object|undefined} 块。
 */
function findBlock(json, id) {
  for (const it of json?.items ?? []) {
    for (const b of it.blocks ?? []) {
      if (b?.id === id) return b
    }
  }
  return undefined
}

/* ── ① 第一次读到有效块 → 写进缓存 ─────────────────────────────── */

console.log('① 第一次读到有效块 → 写进缓存，compensated 空')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '4.9'), blk('dy-sales', 'ok', '12000')])
  const r = await call()
  check('★★ 路由 200', r.code === 200, String(r.code))
  check('★★★ 第一次读 compensated 是空的（没有旧数据可补）',
    (r.json?.compensated ?? ['x']).length === 0, JSON.stringify(r.json?.compensated ?? null))

  let cache = null
  try { cache = JSON.parse(await readFile(patrolCacheFile(), 'utf8')) } catch { cache = null }
  check('★★★ 缓存文件真的写出来了', cache !== null, patrolCacheFile())
  check('★★ 缓存里两个块都在，值与原文件相同',
    (cache?.blocks ?? []).length === 2
    && (cache?.blocks ?? []).every(b => b.id === 'dy-score' ? b.block.items[0].value === '4.9' : true),
    JSON.stringify((cache?.blocks ?? []).map(b => b.id)))
  check('★★ 缓存里记了归属文件（一份坏掉时靠它认）',
    (cache?.blocks ?? []).every(b => b.file === 'patrol-dy-shop.json'),
    JSON.stringify((cache?.blocks ?? []).map(b => b.file)))
  check('★★ 缓存里 `at` 记的是这次跑的 runAt',
    cache?.at?.['dy-score'] === '2026-10-29T01:00:00.000Z', String(cache?.at?.['dy-score']))
}

/* ── ② 这次没采到（unknown）→ 用旧块 ──────────────────────────── */

console.log('')
console.log('② 同 id 变 unknown → 返回旧块并进 compensated')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '4.9'), blk('dy-sales', 'ok', '12000')])
  await call()
  /* 第二趟：页面没渲染出来，两项都 unknown；runAt 换成新的。 */
  await put('patrol-dy-shop.json', [blk('dy-score', 'unknown', '—'), blk('dy-sales', 'unknown', '—')],
    { runAt: '2026-10-30T01:00:00.000Z', dataDate: '2026-10-31' })
  const r = await call()
  check('★★★ 返回的是旧块，值是上次那个数字（不是 `—`）',
    findBlock(r.json, 'dy-score')?.items?.[0]?.value === '4.9',
    String(findBlock(r.json, 'dy-score')?.items?.[0]?.value))
  check('★★★ 旧块的状态也回来了（`ok`，不是 `unknown`）',
    findBlock(r.json, 'dy-score')?.state === 'ok', String(findBlock(r.json, 'dy-score')?.state))
  check('★★★ 两个块都进了 compensated',
    JSON.stringify([...(r.json?.compensated ?? [])].sort()) === '["dy-sales","dy-score"]',
    JSON.stringify(r.json?.compensated ?? null))
  check('★★ 文件顶层那个 runAt 仍是这一趟的时间（新旧要能分开看）',
    (r.json?.items ?? [])[0]?.runAt === '2026-10-30T01:00:00.000Z',
    String((r.json?.items ?? [])[0]?.runAt))
}

/* ── ③ 又采到了 → 覆盖 ─────────────────────────────────────────── */

console.log('')
console.log('③ 又读到有效块 → 覆盖缓存，compensated 空')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '4.9')])
  await call()
  await put('patrol-dy-shop.json', [blk('dy-score', 'unknown', '—')],
    { runAt: '2026-10-30T01:00:00.000Z' })
  await call()
  const before = await call()
  check('★★ 前置：第二趟确实是补回来的（值 4.9）',
    findBlock(before.json, 'dy-score')?.items?.[0]?.value === '4.9', '')

  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '5.0')],
    { runAt: '2026-10-31T01:00:00.000Z', dataDate: '2026-11-01' })
  const r = await call()
  check('★★★ 新值覆盖了旧值', findBlock(r.json, 'dy-score')?.items?.[0]?.value === '5.0',
    String(findBlock(r.json, 'dy-score')?.items?.[0]?.value))
  check('★★★ 这次 compensated 空（不再是旧数据）',
    (r.json?.compensated ?? ['x']).length === 0, JSON.stringify(r.json?.compensated ?? null))
  let cache = null
  try { cache = JSON.parse(await readFile(patrolCacheFile(), 'utf8')) } catch { cache = null }
  check('★★ 缓存里也换成了新值',
    cache?.blocks?.[0]?.block?.items?.[0]?.value === '5.0',
    String(cache?.blocks?.[0]?.block?.items?.[0]?.value))
}

/* ── ④ 整份 broken → 旧块补回 items ───────────────────────────── */

console.log('')
console.log('④ 整份进 broken → 那一份的旧块补回来')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '4.9'), blk('dy-sales', 'ok', '12000')])
  await put('patrol-tm-shop.json', [blk('tm-score', 'ok', '5.0')])
  await call()
  /* 把 dy-shop 写成坏档（形状错：结果装在单数 block 里、没 runAt / dataDate）。 */
  await writeFile(join(patrolDir(), 'patrol-dy-shop.json'), JSON.stringify({
    platform: 'dy', ok: false, error: '页面改版', block: blk('dy-score', 'unknown', '—'),
  }), 'utf8')
  const r = await call()
  check('★★ 这一份进了 broken', (r.json?.broken ?? []).some(b => b.file === 'patrol-dy-shop.json'),
    (r.json?.broken ?? []).map(b => b.file).join(','))
  check('★★★ 它的两个旧块补回了 items',
    findBlock(r.json, 'dy-score')?.items?.[0]?.value === '4.9'
    && findBlock(r.json, 'dy-sales')?.items?.[0]?.value === '12000',
    String(findBlock(r.json, 'dy-score')?.items?.[0]?.value) + ' / '
    + String(findBlock(r.json, 'dy-sales')?.items?.[0]?.value))
  check('★★★ 两个都进了 compensated',
    JSON.stringify([...(r.json?.compensated ?? [])].sort()) === '["dy-sales","dy-score"]',
    JSON.stringify(r.json?.compensated ?? null))
  check('★★ 另一份（没坏的）不受影响，也没被标成旧数据',
    findBlock(r.json, 'tm-score')?.items?.[0]?.value === '5.0'
    && !(r.json?.compensated ?? []).includes('tm-score'),
    String(findBlock(r.json, 'tm-score')?.items?.[0]?.value))
  check('★★ 补回来的那条 `ok` 是 null、`error` 写着为什么（不假装这趟成功了）',
    (() => {
      const it = (r.json?.items ?? []).find(i => i.file === 'patrol-dy-shop.json')
      return it?.ok === null && String(it?.error ?? '').includes('block')
    })(),
    JSON.stringify((r.json?.items ?? []).find(i => i.file === 'patrol-dy-shop.json')?.error ?? null))
}

/* ── ⑤ 整份 missing → 同上 ─────────────────────────────────────── */

console.log('')
console.log('⑤ 整份进 missing → 那一份的旧块补回来')
{
  await reset()
  await put('patrol-dy-qianchuan.json', [blk('qc-balance', 'ok', '8888')])
  await call()
  await rm(join(patrolDir(), 'patrol-dy-qianchuan.json'), { force: true })
  const r = await call()
  check('★★ 这一份进了 missing',
    (r.json?.missing ?? []).some(m => m.file === 'patrol-dy-qianchuan.json'),
    (r.json?.missing ?? []).map(m => m.file).join(','))
  check('★★★ 它的旧块补回了 items（不是整块空白）',
    findBlock(r.json, 'qc-balance')?.items?.[0]?.value === '8888',
    String(findBlock(r.json, 'qc-balance')?.items?.[0]?.value))
  check('★★★ 进了 compensated', (r.json?.compensated ?? []).includes('qc-balance'),
    JSON.stringify(r.json?.compensated ?? null))
}

/* ── ⑥ 缓存空 + unknown → 原样返回 ─────────────────────────────── */

console.log('')
console.log('⑥ 缓存里没有这个块 + 读到 unknown → 原样返回（不补个空块）')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-brandnew', 'unknown', '—')])
  const r = await call()
  check('★★★ 原样返回那个 unknown 块（值是 `—`）',
    findBlock(r.json, 'dy-brandnew')?.items?.[0]?.value === '—',
    String(findBlock(r.json, 'dy-brandnew')?.items?.[0]?.value))
  check('★★★ 没进 compensated（没有旧数据可保，不算补偿）',
    !(r.json?.compensated ?? []).includes('dy-brandnew'),
    JSON.stringify(r.json?.compensated ?? null))
  check('★★ 也没有多冒出一块来', findBlock(r.json, 'dy-brandnew') !== undefined, '')
}

/* ── ⑦ blockAt 是「最后一次真正采到」的时间 ────────────────────── */

console.log('')
console.log('⑦ blockAt 记最后一次真正采到的时间，不是这次跑的')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '4.9')], { runAt: '2026-10-20T03:00:00.000Z' })
  await call()
  await put('patrol-dy-shop.json', [blk('dy-score', 'unknown', '—')], { runAt: '2026-10-30T09:00:00.000Z' })
  const r = await call()
  check('★★★ 补偿之后 blockAt 仍是 10-20（采到那次），不是 10-30（跑那次）',
    r.json?.blockAt?.['dy-score'] === '2026-10-20T03:00:00.000Z',
    String(r.json?.blockAt?.['dy-score']))
  check('★★★ 文件的 runAt 是 10-30（这一趟）—— 两者必须分得开',
    (r.json?.items ?? [])[0]?.runAt === '2026-10-30T09:00:00.000Z',
    String((r.json?.items ?? [])[0]?.runAt))
  /* 再采到一次，blockAt 跟着刷新。 */
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '5.1')], { runAt: '2026-11-05T09:00:00.000Z' })
  const r2 = await call()
  check('★★ 真采到时 blockAt 刷新成那一次的时间',
    r2.json?.blockAt?.['dy-score'] === '2026-11-05T09:00:00.000Z',
    String(r2.json?.blockAt?.['dy-score']))
}

/* ── ⑧ 缓存坏档 / 写失败 → 路由照常返回 ────────────────────────── */

console.log('')
console.log('⑧ 缓存坏档、写失败都不许让路由报错')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '4.9')])
  await writeFile(patrolCacheFile(), '{ 这不是 JSON', 'utf8')
  const r = await call()
  check('★★★ 缓存是非法 JSON → 路由照常 200', r.code === 200 && r.json?.ok === true, String(r.code))
  check('★★ 照常返回数据（当空缓存处理）',
    findBlock(r.json, 'dy-score')?.items?.[0]?.value === '4.9',
    String(findBlock(r.json, 'dy-score')?.items?.[0]?.value))
  check('★★ 坏档被重写成合法 JSON（自愈，不用人删）',
    await canParse(patrolCacheFile()), patrolCacheFile())

  /* 写失败：把一个**同名目录**占住缓存路径 → `writeFile` 必失败。 */
  const { rm: rmf } = await import('node:fs/promises')
  await rmf(patrolCacheFile(), { force: true })
  await mkdir(patrolCacheFile(), { recursive: true })
  const r2 = await call()
  check('★★★ 缓存写失败（路径被目录占住）→ 路由照常 200',
    r2.code === 200 && r2.json?.ok === true, String(r2.code))
  check('★★ 数据照常返回（没被缓存的写失败带塌）',
    findBlock(r2.json, 'dy-score')?.items?.[0]?.value === '4.9',
    String(findBlock(r2.json, 'dy-score')?.items?.[0]?.value))
  await rmf(patrolCacheFile(), { recursive: true, force: true })
}

/* ── ⑨ 缓存只在读的时候用，不改 patrol/*.json ──────────────────── */

console.log('')
console.log('⑨ 补偿不碰 patrol/ 里那些文件')
{
  await reset()
  await put('patrol-dy-shop.json', [blk('dy-score', 'ok', '4.9')])
  const before = await readFile(join(patrolDir(), 'patrol-dy-shop.json'), 'utf8')
  await call()
  await put('patrol-dy-shop.json', [blk('dy-score', 'unknown', '—')],
    { runAt: '2026-10-30T09:00:00.000Z' })
  const mid = await readFile(join(patrolDir(), 'patrol-dy-shop.json'), 'utf8')
  await call()
  const after = await readFile(join(patrolDir(), 'patrol-dy-shop.json'), 'utf8')
  check('★★★ 补偿之后文件内容一个字节都没被改回去（`—` 还在里头）',
    after === mid && after.includes('unknown'), after.includes('—') ? '（仍含 —）' : '')
  check('★★ 与补偿前那次读的也不是同一份（确实是两个不同版本的文件）',
    before !== mid, '')
  check('★★ 缓存文件不在 patrol/ 里（与它同级）',
    !patrolCacheFile().includes(sep() + 'patrol' + sep()), patrolCacheFile())
}

/**
 * 现在的目录分隔符。
 * @returns {string} `\\` 或 `/`。
 */
function sep() {
  return patrolCacheFile().includes('\\') ? '\\' : '/'
}

/**
 * 一个文件是不是合法 JSON。
 * @param {string} path - 文件。
 * @returns {Promise<boolean>} 合法为 true。
 */
async function canParse(path) {
  try {
    JSON.parse(await readFile(path, 'utf8'))
    return true
  } catch {
    return false
  }
}

console.log(bad === 0 ? '\n全部通过 ✓' : '\n' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
