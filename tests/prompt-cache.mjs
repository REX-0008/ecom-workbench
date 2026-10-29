/** 提示词源的本地缓存（契约 CG，2026-10-26）。
 *
 * # 这一段守的是什么
 *
 * 三层回落：**缓存 → 内置副本 → 拉取失败仍是内置副本**（用户 m01114 定的）。
 * 最要紧的是第三条：源挂了不能让人打不开提示词库，但**也不能让人以为看到的是最新的**
 * —— 所以每条断言都检查「来源说清了没有」。
 *
 * 跑法：node --import <tsx> tests/prompt-cache.mjs
 */
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-pc-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const {
  listSources, readSource, refreshSource, readCache, clearCache, asCachedSource, isSourceId,
} = await import('../src/schedule/prompt-cache.ts')
const { promptCacheDir } = await import('../src/schedule/artifacts.ts')
const { BUILTIN_PROMPT_SOURCES } = await import('../src/client/workbench/prompt-sources/index.ts')

let handler = null
const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) fn({ webServer: { register(route) { handler = route.handler } } })
    if (names.includes('subprocess')) fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
  },
  effect() { return () => { /* 清理 */ } },
}
apply(fakeCtx)

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

/** 上游形状的一条（照 `PromptEntry` 的必填字段）。 */
function entry(id, prompt) {
  return {
    id, sourceId: 'awesome-gpt-image', title: '标题 ' + id, prompt,
    description: '', coverUrl: '', referenceImageUrls: [], tags: [], author: '',
    sourceUrl: '', createdAt: '', imageMode: '', imageModel: '',
  }
}

/**
 * 造一个假 fetch。
 * @param {object} opts - `{status, body, delayMs}`。
 * @returns {Function} 假 fetch。
 */
function fakeFetch(opts = {}) {
  return async () => {
    if (opts.throwIt) throw new Error('ECONNREFUSED')
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    return new Response(JSON.stringify(opts.body ?? []), {
      status: opts.status ?? 200, headers: { 'content-type': 'application/json' },
    })
  }
}

const SRC = 'awesome-gpt-image'
const BUILTIN = BUILTIN_PROMPT_SOURCES.find(s => s.id === SRC)

/* ── ① 没有缓存时读 → 内置副本 + 说清来源 ─────────────────────────── */
console.log('① 没有缓存：读内置副本，并说明是内置')
{
  const got = await readSource(SRC)
  check('★★ 读到了（内置副本）', got !== null && got.source.id === SRC, String(got?.source?.id))
  check('★★ `from` 是 builtin（不是 cache）', got?.from === 'builtin', String(got?.from))
  check('★★ **说明里写明「用的是内置副本」**（不写会让人以为是最新的）',
    String(got?.note).includes('内置副本'), String(got?.note))
  check('★ 内置副本的条目数与源定义一致', got?.source.count === BUILTIN.count,
    String(got?.source.count) + ' / ' + String(BUILTIN.count))
  check('★ 不存在的源 → null（不抛错）', (await readSource('no-such-source')) === null, '')
  check('★ 非法 id → null（不读目录外的东西）', (await readSource('../x')) === null, '')
}

/* ── ② 三个路由都在 ─────────────────────────────────────────────── */
console.log('')
console.log('② 三条路由')
{
  const list = await call('GET', '/api/ecom-workbench/prompt-sources')
  const items = list.json?.sources ?? []
  check('★★ 列表路由回 5 个源', list.code === 200 && items.length === 5, String(items.length))
  check('★★ 列表遵守 BC 约定（sources + items 内容一致）',
    JSON.stringify(list.json?.sources) === JSON.stringify(list.json?.items), '')
  check('★★ 列表**不带 entries**（五个源共 800KB，清单页不该搬）',
    items.every(s => s.entries === undefined), JSON.stringify(Object.keys(items[0] ?? {})))
  check('★ 每条带 from（cache / builtin）', items.every(s => s.from === 'builtin' || s.from === 'cache'),
    items.map(s => s.from).join(','))

  const one = await call('GET', '/api/ecom-workbench/prompt-sources/' + SRC)
  check('★★ 单条路由回完整源（含 entries）',
    one.code === 200 && Array.isArray(one.json?.source?.entries) && one.json.source.entries.length > 0,
    String(one.json?.source?.entries?.length))
  check('★★ 单条路由也回 from 与 note',
    one.json?.from === 'builtin' && String(one.json?.note).includes('内置副本'),
    JSON.stringify({ from: one.json?.from, note: one.json?.note }))

  const miss = await call('GET', '/api/ecom-workbench/prompt-sources/nope')
  check('★★ 不存在的源 → 404 + 说明', miss.code === 404 && String(miss.json?.error).includes('没有这个提示词源'),
    String(miss.json?.error))
}

/* ── ③ refresh 真拉上游并写缓存 ─────────────────────────────────── */
console.log('')
console.log('③ refresh 拉上游、写缓存')
{
  const upstream = [entry('a1', '提示词一'), entry('a2', '提示词二'), entry('a3', '提示词三')]
  const r = await refreshSource(SRC, fakeFetch({ body: upstream }))
  check('★★ 拉取成功', r.ok === true, JSON.stringify({ ok: r.ok, e: r.error }))
  check('★★ 拉到 3 条', r.count === 3, String(r.count))
  check('★ 给了拉取时间', typeof r.fetchedAt === 'number' && r.fetchedAt > 0, String(r.fetchedAt))

  const file = join(promptCacheDir(), SRC + '.json')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  check('★★ 缓存写进 prompt-cache/<源id>.json', onDisk.id === SRC, file)
  check('★★ 缓存里是上游那 3 条（不是内置的副本）',
    onDisk.entries.length === 3 && onDisk.entries[0].id === 'a1', String(onDisk.entries.length))
  check('★ 缓存里带 fetchedAt', typeof onDisk.fetchedAt === 'number' && onDisk.fetchedAt > 0, '')

  /* 形状能被 BuiltinPromptSource 读回（验收 3）。 */
  const back = asCachedSource(onDisk)
  check('★★ 缓存的形状能被读回（id/name/url/license/count/upstreamCount/entries 都在）',
    back !== null && back.id === SRC && back.name !== '' && back.url !== ''
    && back.license !== '' && back.count === 3 && Array.isArray(back.entries),
    JSON.stringify({ id: back?.id, count: back?.count }))
}

/* ── ④ 缓存优先于内置（验收 4）──────────────────────────────────── */
console.log('')
console.log('④ 缓存优先于内置')
{
  const got = await readSource(SRC)
  check('★★ `from` 变成 cache', got?.from === 'cache', String(got?.from))
  check('★★ 读到的是缓存那 3 条（不是内置的 53 条）',
    got?.source.entries.length === 3 && got?.source.entries[0].id === 'a1',
    String(got?.source.entries.length))
  check('★★ 说明里写的是缓存时间（不是「内置副本」）',
    String(got?.note).includes('缓存') && !String(got?.note).includes('内置'), String(got?.note))

  const list = await listSources()
  const mine = list.find(s => s.id === SRC)
  check('★★ 列表里这一条的 from 也变成 cache', mine?.from === 'cache', String(mine?.from))
  check('★★ 列表里的 count 是缓存的 3 条', mine?.count === 3, String(mine?.count))
  check('★ 列表里带 fetchedAt（只有 cache 才有）', typeof mine?.fetchedAt === 'number', String(mine?.fetchedAt))
  /* 别的源没拉过，仍是内置。 */
  const other = list.find(s => s.id !== SRC)
  check('★★ 别的源没拉过 → 仍是 builtin（互不影响）', other?.from === 'builtin', String(other?.from))
}

/* ── ⑤ 拉取失败：不覆盖缓存、说清回落（验收 2）────────────────── */
console.log('')
console.log('⑤ 拉取失败：回内置那份 + 说清')
{
  /* 先把缓存清掉，从「没有缓存」的干净状态验失败回落。 */
  await clearCache(SRC)
  check('★ 缓存清掉了', (await readCache(SRC)) === null, '')

  const r500 = await refreshSource(SRC, fakeFetch({ status: 500, body: { error: 'boom' } }))
  check('★★ 上游 500 → ok:false', r500.ok === false, String(r500.ok))
  check('★★ 原因里带上游状态码', String(r500.error).includes('500'), String(r500.error))
  check('★★ fallback 标成 builtin', r500.fallback === 'builtin', String(r500.fallback))
  check('★★ 说明写明「用的是内置副本」', String(r500.note).includes('内置副本'), String(r500.note))

  /* 读的时候确实回落到了内置（而不是报错）。 */
  const got = await readSource(SRC)
  check('★★ 拉取失败之后照样读得到（回内置那份，不是报错）',
    got !== null && got.from === 'builtin', String(got?.from))
  check('★ 而且读到的条数是内置的条数', got?.source.count === BUILTIN.count,
    String(got?.source.count) + ' / ' + String(BUILTIN.count))

  /* 连不上也一路话。 */
  const rnet = await refreshSource(SRC, fakeFetch({ throwIt: true }))
  check('★★ 连不上 → ok:false 且说「连不上」', rnet.ok === false && String(rnet.error).includes('连不上'),
    String(rnet.error))

  /* 上游给的不是 JSON 数组。 */
  const rbad = await refreshSource(SRC, async () => new Response('不是 JSON', { status: 200 }))
  check('★★ 上游回的不是 JSON → ok:false 且说清', rbad.ok === false && String(rbad.error).includes('JSON'),
    String(rbad.error))
  const rempty = await refreshSource(SRC, fakeFetch({ body: [] }))
  check('★★ 上游回空数组 → ok:false（不写一份空缓存把好好的内置副本盖掉）',
    rempty.ok === false && String(rempty.error).includes('一个条目都没给'), String(rempty.error))
  const rwrong = await refreshSource(SRC, fakeFetch({ body: [{ nope: 1 }, { also: 2 }] }))
  check('★★ 上游回的条目形状不对 → ok:false 且说清「没有一条符合形状」',
    rwrong.ok === false && String(rwrong.error).includes('符合形状'), String(rwrong.error))

  /* 不存在的源 / 非法 id。
   * ⚠️ 判据在 2026-10-26 改过一次：旧断言要求错误里含「没有这个内置源 … 只支持内置的五份」，
   * 那是当时的事实（拉取只认内置常量）。现在地址以**配置**为准，用户自己加的源也能拉，
   * 「只支持内置五份」这句已经不成立 —— 所以断言的是「说清是哪个源不存在」这件事本身。 */
  const rmiss = await refreshSource('no-such-source', fakeFetch({ body: [] }))
  check('★ 不存在的源 → ok:false 且说出是哪个源', rmiss.ok === false
    && String(rmiss.error).includes('没有这个源') && String(rmiss.error).includes('no-such-source'),
  String(rmiss.error))
  const rbad2 = await refreshSource('../x', fakeFetch({ body: [] }))
  check('★ 非法 id → ok:false（不写目录外）', rbad2.ok === false, String(rbad2.error))
}

/* ── ⑥ 失败不覆盖已有缓存 ───────────────────────────────────────── */
console.log('')
console.log('⑥ 拉取失败**不覆盖**已有缓存')
{
  /* 先成功拉一次（3 条），再让上游挂掉。 */
  await refreshSource(SRC, fakeFetch({ body: [entry('b1', 'p1'), entry('b2', 'p2')] }))
  const before = await readSource(SRC)
  check('★ 先有一份 2 条的缓存', before?.source.count === 2, String(before?.source.count))

  const r = await refreshSource(SRC, fakeFetch({ status: 500 }))
  check('★★ 这次拉取失败', r.ok === false, String(r.ok))
  const after = await readSource(SRC)
  check('★★ **缓存还在、还是那 2 条**（失败不该把好数据降级成内置副本）',
    after?.from === 'cache' && after?.source.count === 2, String(after?.source.count))

  /* 上游形状变了（少一批条目）也算一次正常刷新 —— 那是真实变化，该覆盖。 */
  await refreshSource(SRC, fakeFetch({ body: [entry('c1', 'p')] }))
  const shrunk = await readSource(SRC)
  check('★ 上游真的变少时照样覆盖（那是真实变化，不是失败）',
    shrunk?.source.count === 1, String(shrunk?.source.count))

  await clearCache(SRC)
}

/* ── ⑦ 从缓存读回来的字节稳定（能被界面直接吃）──────────────────── */
console.log('')
console.log('⑦ 缓存写盘 / 读回的往返')
{
  const upstream = Array.from({ length: 120 }, (_, i) => entry('e' + String(i), '提示词 ' + String(i)))
  const r = await refreshSource(SRC, fakeFetch({ body: upstream }))
  check('★★ 120 条全部写下来', r.ok === true && r.count === 120, String(r.count))
  const got = await readSource(SRC)
  check('★★ 读回也是 120 条', got?.source.entries.length === 120, String(got?.source.entries.length))
  check('★★ 条目内容原样（prompt 与 id 都对）',
    got?.source.entries[0].id === 'e0' && got?.source.entries[0].prompt === '提示词 0',
    JSON.stringify(got?.source.entries[0]))

  const wrapped = await refreshSource('awesome-gpt4o-image-prompts', fakeFetch({ body: { entries: [entry('z1', 'p')] } }))
  check('★★ 上游形状 `{entries:[...]}` 也认（不只认裸数组）',
    wrapped.ok === true && wrapped.count === 1, JSON.stringify({ ok: wrapped.ok, n: wrapped.count }))
  const prompts = await refreshSource('youmind-gpt-image-2', fakeFetch({ body: { prompts: [entry('y1', 'p')] } }))
  check('★★ 上游形状 `{prompts:[...]}` 也认',
    prompts.ok === true && prompts.count === 1, JSON.stringify({ ok: prompts.ok, n: prompts.count }))
}

/* ── ⑧ 沙箱：缓存写在沙箱里 ─────────────────────────────────────── */
console.log('')
console.log('⑧ 目录')
{
  const dir = promptCacheDir()
  check('★★ 缓存目录在沙箱里', dir.startsWith(process.env.EWB_TEST_HOME), dir)
  const names = await readdir(dir)
  check('★ 目录里真有缓存文件', names.some(n => n.endsWith('.json')), names.join(','))
  check('★ isSourceId 挡住路径穿越', !isSourceId('../x') && isSourceId(SRC), '')
  const s = await stat(dir)
  check('★ 目录确实建出来了', s.isDirectory(), '')
}

console.log('')
console.log(bad === 0
  ? '结论：提示词缓存（三层回落 / 三条路由 / 失败不降级）全部通过 ✓'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
