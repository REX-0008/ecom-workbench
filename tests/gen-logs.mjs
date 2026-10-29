/** 生成记录（契约 BA，2026-10-25）。
 *
 * ## 这一段守的是什么
 *
 * 记录形状与执行文档 §2.2 逐字段一致、失败也留记录、图片与视频两目录互不串。
 *
 * ## ⚠️ 这里**没有生成链路**
 *
 * 记录全是手工造的（照文档 §五「本期替代判据」）。这份测试造出来的记录躺在
 * 沙箱里，跑完就删。**不许把它读成「生成跑通了」**。
 *
 * 跑法：node --import <tsx> tests/gen-logs.mjs
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/* 票 44：判据 2 要造真文件、还要写一个「路径穿越的靶子」哨兵。
 * `readFile` / `readdir` 上面那行已经导过了，这里只补另外两个 ——
 * 重复导入同一个名字是 `SyntaxError`（第一版就这么挂的）。 */
import { writeFile, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-gl-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { writeGenLog, readGenLog, listGenLogs, normalizeGenLog, deleteGenLog, isGenLogId } = await import('../src/schedule/gen-logs.ts')
const { genLogsDir } = await import('../src/schedule/artifacts.ts')

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

/** 造一条成功记录（文档 §2.2 的完整形状）。 */
function okLog(id, createdAt, extra = {}) {
  return {
    id, kind: 'image', createdAt, endedAt: createdAt + 4200, status: 'success',
    channelId: 'ch_a', model: 'gpt-image-1', prompt: '一只白猫',
    negativePrompt: '模糊', params: { size: '1024x1024', count: 2, seed: 42 },
    artifacts: [{ id: 'a-1', width: 1024, height: 1024, bytes: 204800 }],
    usage: { images: 2 }, source: 'workbench', ...extra,
  }
}

/* ── ① 字段与文档逐字段一致 ────────────────────────────────────────── */
console.log('① 字段形状（照执行文档 §2.2）')
{
  await writeGenLog(okLog('gl_ok', 1000))
  const got = await readGenLog('gl_ok')
  /* 必填键一个不少。 */
  const must = ['id', 'kind', 'createdAt', 'status', 'channelId', 'model', 'prompt', 'params', 'artifacts', 'usage']
  const missing = must.filter(k => got?.[k] === undefined)
  check('★★ 必填十个键都在', missing.length === 0, '缺：' + missing.join(','))
  /* 可选键给了就在。（`okLog` 里 `endedAt = createdAt + 4200`，所以是 5200。） */
  check('★★ 可选键给了就在（endedAt / negativePrompt / source）',
    got?.endedAt === 5200 && got?.negativePrompt === '模糊' && got?.source === 'workbench',
    JSON.stringify({ e: got?.endedAt, n: got?.negativePrompt, s: got?.source }))
  /* 没有多余键：把整份键名列出来断言（这是「多一个少一个都不行」的判据）。 */
  const keys = Object.keys(got ?? {}).sort()
  const allowed = ['artifacts', 'channelId', 'createdAt', 'endedAt', 'id', 'kind', 'model',
    'negativePrompt', 'params', 'prompt', 'source', 'status', 'usage',
    'canvasId', 'canvasNodeId', 'error'].sort()
  check('★★ 没有多余的键（一个都不许有）',
    keys.every(k => allowed.includes(k)), keys.filter(k => !allowed.includes(k)).join(','))
  check('★ artifacts 里那条带 id 与尺寸',
    got?.artifacts?.[0]?.id === 'a-1' && got?.artifacts?.[0]?.bytes === 204800,
    JSON.stringify(got?.artifacts?.[0]))
  check('★ usage 只记张数（images=2）', got?.usage?.images === 2, JSON.stringify(got?.usage))
}

/* ── ② 可选键「没有就不写」────────────────────────────────────────── */
console.log('')
console.log('② 可选键没给就不出现（不是 undefined、不是空串）')
{
  const minimal = {
    id: 'gl_min', kind: 'image', createdAt: 2000, status: 'pending',
    channelId: 'ch_a', model: 'm', prompt: 'p', params: {}, artifacts: [], usage: {},
  }
  await writeGenLog(minimal)
  const got = await readGenLog('gl_min')
  check('★★ 没给 endedAt → 那个键不在', !('endedAt' in (got ?? {})), JSON.stringify(Object.keys(got ?? {})))
  check('★★ 没给 error → 那个键不在', !('error' in (got ?? {})), '')
  check('★★ 没给 canvasId → 那个键不在', !('canvasId' in (got ?? {})), '')
  const raw = await readFile(join(genLogsDir(), 'image', 'gl_min.json'), 'utf8')
  check('★★ 磁盘上的 JSON 里也没有那些键（不是只在内存里去掉）',
    !raw.includes('"endedAt"') && !raw.includes('"error"') && !raw.includes('"canvasId"'),
    raw.replace(/\s+/g, ' ').slice(0, 100))
}

/* ── ③ 失败也留记录 ───────────────────────────────────────────────── */
console.log('')
console.log('③ 失败也留记录（采集那边踩过的坑，不重犯）')
{
  await writeGenLog({
    id: 'gl_fail', kind: 'image', createdAt: 3000, endedAt: 3300, status: 'failed',
    channelId: 'ch_a', model: 'gpt-image-1', prompt: '一只黑猫',
    params: { size: '512x512' }, artifacts: [], usage: {},
    error: '上游返回 429：限流', source: 'workbench',
  })
  const got = await readGenLog('gl_fail')
  check('★★ 失败记录能落盘并读回', got !== null && got.status === 'failed', String(got?.status))
  check('★★ 失败原因原文带出来了', got?.error === '上游返回 429：限流', String(got?.error))
  check('★★ 失败记录也进了列表', (await listGenLogs('image')).some(l => l.id === 'gl_fail'), '')
  const files = await readdir(join(genLogsDir(), 'image'))
  check('★★ 磁盘上真有一个文件（不是只返回成功）', files.includes('gl_fail.json'), files.join(','))
}

/* ── ④ 倒序 + 两目录互不串 ────────────────────────────────────────── */
console.log('')
console.log('④ 按 createdAt 倒序，image / video 互不串')
{
  await writeGenLog(okLog('gl_old', 500))
  await writeGenLog(okLog('gl_new', 9000))
  const list = await listGenLogs('image')
  const order = list.map(l => l.createdAt)
  check('★★ 按 createdAt 倒序（新的在前）',
    order.every((v, i) => i === 0 || order[i - 1] >= v), order.join(','))
  check('★★ 最新那条在最前', list[0]?.id === 'gl_new', String(list[0]?.id))

  await writeGenLog({
    id: 'gl_vid', kind: 'video', createdAt: 8000, status: 'pending',
    channelId: 'ch_v', model: 'v-model', prompt: '一只猫在跑',
    params: { seconds: 5 }, artifacts: [], usage: { seconds: 5 },
  })
  const imgs = await listGenLogs('image')
  const vids = await listGenLogs('video')
  check('★★ video 目录里只有那条视频', vids.length === 1 && vids[0].id === 'gl_vid',
    vids.map(l => l.id).join(','))
  check('★★ image 列表里没有视频那条', !imgs.some(l => l.id === 'gl_vid'), imgs.map(l => l.id).join(','))
  check('★★ 视频那条在 video/ 目录下（不是 image/）',
    (await readdir(join(genLogsDir(), 'video'))).includes('gl_vid.json'), '')

  const limited = await listGenLogs('image', 2)
  check('★ limit 生效', limited.length === 2, String(limited.length))
}

/* ── ⑤ 全文搜：不许有结算类字段（连注释都不许）────────────────────── */
console.log('')
console.log('⑤ 源码全文搜结算类关键词 → 0 命中')
{
  const src = await readFile(new URL('../src/schedule/gen-logs.ts', import.meta.url), 'utf8')
  /* ⚠️ 判据是中英文都搜。「成本」也算 —— 它是最容易被写进注释的同一个意思。 */
  const banned = ['价格', '单价', '费用', '成本', 'cost', 'price', 'Price', 'Cost', '¥', '￥']
  const hits = banned.filter(w => src.includes(w))
  check('★★ 全文 0 命中', hits.length === 0, hits.join(',') + '（命中 ' + String(hits.length) + ' 个）')
}

/* ── ⑥ 路由 ───────────────────────────────────────────────────────── */
console.log('')
console.log('⑥ 两条路由')
{
  const list = await call('GET', '/api/ecom-workbench/gen-logs?kind=image&limit=100')
  check('★★ 列表路由回记录（kind=image）',
    list.code === 200 && list.json?.ok === true && Array.isArray(list.json?.logs),
    String(list.json?.logs?.length))
  /* 契约 BC 的约定：具名键与 `items` 同时给、内容一致。 */
  check('★★ 具名键与 items 两个键内容一致（列表类接口的约定）',
    JSON.stringify(list.json?.logs) === JSON.stringify(list.json?.items)
    && Array.isArray(list.json?.items),
    JSON.stringify({ named: (list.json?.logs ?? []).length, items: (list.json?.items ?? []).length }))
  const v = await call('GET', '/api/ecom-workbench/gen-logs?kind=video')
  check('★ kind=video 只回视频那条', (v.json?.logs ?? []).every(l => l.kind === 'video'),
    (v.json?.logs ?? []).map(l => l.kind).join(','))

  const one = await call('GET', '/api/ecom-workbench/gen-log/gl_ok')
  check('★★ 单条路由回完整记录', one.code === 200 && one.json?.log?.id === 'gl_ok',
    String(one.json?.log?.prompt))
  const miss = await call('GET', '/api/ecom-workbench/gen-log/never')
  check('★★ 找不到 → 404 + 说明',
    miss.code === 404 && String(miss.json?.error).includes('没有这条生成记录'),
    String(miss.json?.error))

  /* 非法 id 不该让它读到目录外去。 */
  const evil = await call('GET', '/api/ecom-workbench/gen-log/..%2F..%2Fbrowser-prefs')
  check('★★ 非法 id → 404（不读目录外的文件）', evil.code === 404, String(evil.code))
}

/* ── ⑦ 归一：不认识的键丢掉 ───────────────────────────────────────── */
console.log('')
console.log('⑦ 归一器丢掉不认识的键（防止有人塞进不该有的字段）')
{
  const dirty = normalizeGenLog({
    id: 'gl_dirty', kind: 'image', createdAt: 1, status: 'success',
    channelId: 'c', model: 'm', prompt: 'p', params: {}, artifacts: [], usage: {},
    somehowMoney: 12, extraThing: 'x',
  })
  check('★★ 不认识的键被丢掉',
    dirty !== null && !('somehowMoney' in dirty) && !('extraThing' in dirty),
    JSON.stringify(Object.keys(dirty ?? {})))
  check('★ 合法记录照常归一', dirty?.id === 'gl_dirty', String(dirty?.id))
  check('★ id 非法 → 归一返回 null', normalizeGenLog({ id: '../x', kind: 'image' }) === null, '')
  check('★ kind 不合法 → 归一返回 null', normalizeGenLog({ id: 'x', kind: 'audio' }) === null, '')
}

/* ── ⑥ 删一条记录（票 44，判据 2）────────────────────────────────────
 *
 * ## 为什么这一段是**真文件**
 *
 * 这一段跑在 `EWB_TEST_HOME` 的临时目录里（`:20` 那句 `mkdtemp`），
 * `writeGenLog` 写的是真文件、`deleteGenLog` 删的也是真文件。
 * 所以「删前几个、删后几个」是 `readdir` **数出来的**，不是桩回来的。
 *
 * 这比「贴两条 DELETE 请求」强得多：请求发出去不等于文件真删了
 * —— 路由写错、路径拼错、权限不足，请求照样是 200 的样子。
 */
console.log('')
console.log('⑥ 删一条记录（真文件、两次 readdir）')
{
  const dir = genLogsDir()
  const imgDir = join(dir, 'image')
  /** 数一个目录里有几个 `.json`（目录不存在给 0）。 */
  const countJson = async (d) => {
    try {
      return (await readdir(d)).filter(n => n.endsWith('.json')).length
    } catch {
      return 0
    }
  }

  /* 造三条记录（id 带前缀，免得与上面几段用过的撞）。 */
  await writeGenLog(okLog('gl_del_a', 3000))
  await writeGenLog(okLog('gl_del_b', 3100))
  await writeGenLog(okLog('gl_del_c', 3200))

  const before = await countJson(imgDir)
  console.log('   删前 image/ 下的 .json 个数:', before)
  check('★★★ 判据 2：造完三条之后，image/ 下至少有 3 条',
    before >= 3, '实际 ' + String(before))

  /* 真删一条。 */
  const okDel = await deleteGenLog('gl_del_b')
  const after = await countJson(imgDir)
  console.log('   删后 image/ 下的 .json 个数:', after)
  check('★★★ 判据 2：deleteGenLog 返回 true（真删掉了）', okDel === true, String(okDel))
  check('★★★ 判据 2：文件数**正好少 1**', after === before - 1,
    String(before) + ' → ' + String(after))
  check('★★ 判据 2：删掉的那条真读不出来了（不是只少了个计数）',
    (await readGenLog('gl_del_b')) === null)
  check('★★ 判据 2：**别的记录没被连累**（a 与 c 都还在）',
    (await readGenLog('gl_del_a')) !== null && (await readGenLog('gl_del_c')) !== null)

  /* ── 安全边界：id 不合法时必须**一个文件都不碰** ──
   *
   * ## 这条第一版是假绿，必须这么写才有效
   *
   * 第一版只传了 `'../evil'`、然后数 `image/` 下的文件有没有少 —— 那是**假绿**：
   * `../evil.json` 指向的是一个**本来就不存在**的文件，删不掉当然「个数没变」。
   * 去掉 `isGenLogId` 校验它照样变绿（自证时当场发现的）。
   *
   * 有效的写法：**先造一个「路径穿越之后真会被删到」的文件**。
   * `kindDir('image')` 是 `genLogsDir()/image`，而 `join(它, '../evil.json')`
   * 正好是 `genLogsDir()/evil.json` —— 所以就在那儿放一个哨兵文件。
   * 校验若缺失，这个哨兵会被删掉；校验在，它必须原地不动。
   *
   * 这条断言验的是「**安全边界真的挡住了**」，不是「碰巧没撞上」。 */
  const sentinel = join(dir, 'evil.json')
  await writeFile(sentinel, '{"id":"evil"}', 'utf8')
  const badDel = await deleteGenLog('../evil')
  let sentinelAlive = true
  try { await readFile(sentinel, 'utf8') } catch { sentinelAlive = false }
  console.log('   哨兵文件（路径穿越的靶子）还在:', sentinelAlive ? '在 ✓' : '被删掉了 ✗')
  check('★★★ 安全：deleteGenLog 对非法 id 返回 false', badDel === false, String(badDel))
  check('★★★ 安全：`../evil` **删不掉那个哨兵文件**（校验真的挡住了路径穿越）',
    sentinelAlive, sentinelAlive ? '' : '哨兵被删了 —— 说明校验没拦住')
  /* 收尾：把哨兵清掉，别留给后面的段落。 */
  try { await unlink(sentinel) } catch { /* 已经不在 */ }
  check('★★ 安全：`isGenLogId` 对 `../evil` 说不行', isGenLogId('../evil') === false)
  check('★★ 安全：`isGenLogId` 对正常 id 说行', isGenLogId('gl_del_a') === true)

  /* 删一条不存在的：给 false，不炸。 */
  check('★ 删一条不存在的记录 → false（不抛错）',
    (await deleteGenLog('gl_not_there')) === false)
}

console.log('')
console.log(bad === 0
  ? '结论：生成记录形状、失败留档、两目录分离、无结算字段全部通过 ✓（⚠️ 记录由手工造，无生成链路）'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
