/** 生成路由（契约 CC，2026-10-26）。
 *
 * ## 这一段守的是什么
 *
 * 验收第 1 条是本轮最要紧的一条：**`POST /generate` 必须立刻返回**。
 * 它不能靠「看代码里没 await」来验 —— 那挡不住有人在里面加一个 await。
 * 所以这里给假 ComfyUI 设 3 秒延迟，然后量 HTTP 响应本身的耗时。
 *
 * ## 走哪条路
 *
 * 照 `tests/canvases.mjs` 的模式：`apply(fakeCtx)` 抓住路由处理函数，
 * 用 `Readable` 造请求、`EventEmitter` 当响应。不走真 `http.createServer`
 * 是因为这里要验的是「路由怎么回」，不是「Node 的 HTTP 实现」。
 *
 * 跑法：node --import <tsx> tests/generate-route.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-genr-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { saveChannel } = await import('../src/schedule/channels.ts')
const { resetGenerateForTest, setGenerateDeps, getTask } = await import('../src/schedule/generate.ts')
const { resetChannelQueueForTest } = await import('../src/schedule/channel-queue.ts')

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
 * 模拟一次 HTTP 调用（同时量耗时）。
 * @param {string} method - 方法。
 * @param {string} url - 路径。
 * @param {object} [body] - 请求体。
 * @returns {Promise<{code:number, json:any, ms:number}>} 响应与耗时。
 */
async function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let code = 0
  let text = ''
  res.writeHead = (c) => { code = c }
  res.end = (s) => { text = String(s ?? '') }
  res.writableEnded = false
  const t0 = Date.now()
  await handler(req, res)
  const ms = Date.now() - t0
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { code, json, ms }
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

/** 1×1 PNG。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG_B64 = PNG.toString('base64')

/**
 * 假 fetch：延迟若干毫秒后回一张图。
 * @param {number} delayMs - 延迟。
 * @param {number} [status] - 状态码。
 * @param {object} [body] - 响应体。
 * @returns {Function} 假 fetch。
 */
function slowFetch(delayMs, status = 200, body) {
  return async () => {
    await new Promise(r => setTimeout(r, delayMs))
    return new Response(JSON.stringify(body ?? { data: [{ b64_json: PNG_B64 }] }), {
      status, headers: { 'content-type': 'application/json' },
    })
  }
}

/**
 * 等一个任务到终态。
 * @param {string} id - 任务 id。
 * @param {number} [timeoutMs] - 最多等多久。
 * @returns {Promise<object|null>} 任务。
 */
async function settle(id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const t = getTask(id)
    if (t !== null && (t.status === 'success' || t.status === 'failed')) return t
    if (Date.now() >= deadline) return getTask(id)
    await new Promise(r => setTimeout(r, 15))
  }
}

await saveChannel({
  id: 'ch_r', name: '路由渠道', protocol: 'openai', baseUrl: 'https://api.example.com',
  models: [{ id: 'img-1', label: '出图', caps: ['image'] }], maxConcurrency: 2,
})

/* ── ① POST /generate 立刻返回（验收 1）──────────────────────────── */
console.log('① POST /generate 不挂住（假上游 3 秒延迟）')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ netFetch: slowFetch(3000) })

  const r = await call('POST', '/api/ecom-workbench/generate', {
    kind: 'image', prompt: '一只白猫', model: 'img-1', channelId: 'ch_r',
  })
  check('★★ HTTP 响应在 500ms 内回来（上游要 3 秒，说明没在里面等）', r.ms < 500, String(r.ms) + 'ms')
  check('★★ 返回里有任务 id', r.code === 200 && typeof r.json?.id === 'string' && r.json.id !== '', String(r.json?.id))
  check('★★ 此刻状态是 submitted（不是 success —— 活还没干完）',
    r.json?.task?.status === 'submitted', String(r.json?.task?.status))

  const id = r.json.id
  /* 轮询能看到进度往前走。 */
  const t1 = await call('GET', '/api/ecom-workbench/generate/' + id)
  check('★★ GET /generate/:id 立刻查得到（200 + 带 task）',
    t1.code === 200 && t1.json?.task?.id === id, String(t1.json?.task?.status))
  check('★ 查到的时候还在跑（不是已经结束）',
    t1.json?.task?.status === 'submitted' || t1.json?.task?.status === 'running',
    String(t1.json?.task?.status))

  const done = await settle(id)
  check('★★ 等一会儿之后变 success', done?.status === 'success', String(done?.status))
  const states = done.history.map(h => h.status)
  check('★★ 三态都出现过：submitted → running → success',
    states.includes('submitted') && states.includes('running') && states.includes('success'),
    states.join(' → '))
}

/* ── ② 产物与记录都通过路由可见（验收 3、4）────────────────────── */
console.log('')
console.log('② 路由能取到产物与记录')
{
  resetGenerateForTest()
  setGenerateDeps({ netFetch: slowFetch(0) })
  const created = await call('POST', '/api/ecom-workbench/generate', {
    kind: 'image', prompt: '猫', model: 'img-1', channelId: 'ch_r', source: 'workbench',
  })
  const done = await settle(created.json.id)
  const artId = done?.artifacts?.[0]?.id
  check('★★ 任务里有产物 id', typeof artId === 'string' && artId !== '', String(artId))

  /* 走真的二进制路由取一次（不是直接调 loadArtifact）。
   * 这一条验的是「界面拿 url 能显示图」那条路。 */
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/api/ecom-workbench/artifact/' + artId
  const res = new EventEmitter()
  let code = 0
  let headers = {}
  let raw
  res.writeHead = (c, h) => { code = c; headers = h ?? {} }
  res.end = (s) => { raw = s }
  res.writableEnded = false
  await handler(req, res)
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''))
  check('★★ GET /artifact/<id> 回 200 且字节与原图相同',
    code === 200 && buf.equals(PNG), JSON.stringify({ code, n: buf.length }))
  check('★★ content-type 是 image/png', String(headers['content-type']) === 'image/png',
    String(headers['content-type']))

  /* 生成记录走真路由查一次。 */
  const log = await call('GET', '/api/ecom-workbench/gen-log/' + created.json.id)
  check('★★ 按任务 id 查得到生成记录', log.code === 200 && log.json?.log?.id === created.json.id,
    String(log.json?.log?.status))
}

/* ── ③ 校验与 404（请求形状不对要 400，不是 500）──────────────── */
console.log('')
console.log('③ 入参校验与 404')
{
  const noPrompt = await call('POST', '/api/ecom-workbench/generate', { model: 'img-1', channelId: 'ch_r' })
  check('★★ 没给提示词 → 400 且说明', noPrompt.code === 400 && String(noPrompt.json?.error).includes('提示词'),
    String(noPrompt.json?.error))
  /* ⚠️ 「没给模型」这一条 2026-10-26 变了语义（T-B-后端）：
   *
   * 以前是 400（那时候界面会自己填「清单第一个」）。现在不给模型走三层回落 ——
   * 接口**照样受理**，真正的判断在后端：没设默认模型时任务失败并说「去设置里选」。
   * 所以这里验的是「受理了」，而「没设默认要报错」由 `gen-op.mjs` ⑥h 段验
   * （那里能真等任务跑完看 `task.error`；这里 `call` 只拿到 HTTP 那一层）。
   *
   * 这一改不是放宽校验：模型这个参数从「必填字符串」变成了「可以不给，但不给必须有出处」，
   * 而「出处」在磁盘上（`model-defaults.json`），HTTP 这一层判不了。 */
  const noModel = await call('POST', '/api/ecom-workbench/generate', { prompt: 'p', channelId: 'ch_r' })
  check('★★ 没给模型 → 接口仍受理（是否报错看有没有设默认模型，在后端判）',
    noModel.code === 200 && typeof noModel.json?.id === 'string', String(noModel.code))

  const miss = await call('GET', '/api/ecom-workbench/generate/never-exist')
  check('★★ 查不存在的任务 → 404', miss.code === 404 && String(miss.json?.error).includes('没有这个任务'),
    String(miss.json?.error))
  const cancelMiss = await call('POST', '/api/ecom-workbench/generate/never-exist/cancel')
  check('★★ 取消不存在的任务 → 404（不是假装成功）', cancelMiss.code === 404, String(cancelMiss.code))
}

/* ── ④ 取消（验收 6）──────────────────────────────────────────────── */
console.log('')
console.log('④ 取消路由')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ netFetch: slowFetch(1200) })
  const created = await call('POST', '/api/ecom-workbench/generate', {
    kind: 'image', prompt: 'p', model: 'img-1', channelId: 'ch_r',
  })
  const id = created.json.id
  /* 等它真开始跑再取消。 */
  for (let i = 0; i < 100 && getTask(id)?.status === 'submitted'; i += 1) {
    await new Promise(r => setTimeout(r, 5))
  }
  const c = await call('POST', '/api/ecom-workbench/generate/' + id + '/cancel')
  check('★★ 取消接口回 200 + ok', c.code === 200 && c.json?.ok === true, String(c.code))
  const done = await settle(id)
  check('★★ 任务变 failed 且错误里说明是取消',
    done?.status === 'failed' && String(done?.error).includes('取消'),
    JSON.stringify({ s: done?.status, e: done?.error }))
}

/* ── ⑤ 列表路由：具名键 + items（BC 那轮的约定）────────────────── */
console.log('')
console.log('⑤ 列表路由遵守 BC 的键名约定')
{
  resetGenerateForTest()
  setGenerateDeps({ netFetch: slowFetch(0) })
  for (let i = 0; i < 3; i += 1) {
    await call('POST', '/api/ecom-workbench/generate', {
      kind: 'image', prompt: 'p' + String(i), model: 'img-1', channelId: 'ch_r',
    })
  }
  const list = await call('GET', '/api/ecom-workbench/generate')
  check('★★ 列表回 tasks 与 items 两个键，内容一致',
    JSON.stringify(list.json?.tasks) === JSON.stringify(list.json?.items) && Array.isArray(list.json?.items),
    JSON.stringify({ t: (list.json?.tasks ?? []).length, i: (list.json?.items ?? []).length }))

  /* ⚠️ 路径是 `/gen-models`，不是 `/models`：后者被 dsh 模型目录占了
   * （`src/index.ts` 后面那条），同名判断先到的赢，会把那条吃掉。
   * 这条测试用对路径，既验我们的接口，也提醒「别改回去」。 */
  const models = await call('GET', '/api/ecom-workbench/gen-models?kind=image')
  /* 路由查重（2026-10-26 踩过一次：把 `/models` 占了，把 dsh 模型目录那条吃掉）。
   * 判据是**源码里 `/models` 只有一处**（本来就该只有 dsh 那一条）。 */
  const hostSrc = await (await import('node:fs/promises')).readFile(
    new URL('../src/index.ts', import.meta.url), 'utf8',
  )
  const dupModels = (hostSrc.match(/path === '\/api\/ecom-workbench\/models'/g) ?? []).length
  check('★★ 源码里 /models 只有 1 处（dsh 那条），我们的用 /gen-models',
    dupModels === 1 && hostSrc.includes("path === '/api/ecom-workbench/gen-models'"),
    JSON.stringify({ models: dupModels }))
  check('★★ 模型清单也遵守（models + items）',
    JSON.stringify(models.json?.models) === JSON.stringify(models.json?.items)
    && (models.json?.models ?? []).length > 0,
    String((models.json?.models ?? []).length))
  check('★★ kind=image 时只回能做图的模型',
    (models.json?.models ?? []).every(m => m.caps.includes('image')),
    (models.json?.models ?? []).map(m => m.modelId).join(','))
  await new Promise(r => setTimeout(r, 200))
}

/* ── ⑥ 渠道连通测试路由（验收 10）───────────────────────────────── */
console.log('')
console.log('⑥ 渠道连通测试路由')
{
  setGenerateDeps({ netFetch: slowFetch(0, 200, { data: [] }) })
  const ok = await call('POST', '/api/ecom-workbench/channels/ch_r/test')
  check('★★ 200 → ok:true', ok.code === 200 && ok.json?.ok === true, JSON.stringify(ok.json?.result))

  setGenerateDeps({ netFetch: slowFetch(0, 401, { error: { message: 'Invalid API key' } }) })
  const bad1 = await call('POST', '/api/ecom-workbench/channels/ch_r/test')
  check('★★ 401 → ok:false 且带上游原因（HTTP 仍是 200，因为它是「测试结果」不是「接口失败」）',
    bad1.code === 200 && bad1.json?.ok === false && String(bad1.json?.error).includes('Invalid API key'),
    JSON.stringify({ code: bad1.code, ok: bad1.json?.ok, e: bad1.json?.error }))
}

/* ── ⑦ 既有路由没被碰坏（回归）────────────────────────────────────── */
console.log('')
console.log('⑦ 既有路由回归')
{
  const health = await call('GET', '/api/ecom-workbench/health')
  check('★ /health 还通', health.code === 200 && health.json?.ok === true, String(health.code))
  const chs = await call('GET', '/api/ecom-workbench/channels')
  check('★ /channels 还通且不回密钥', chs.code === 200 && Array.isArray(chs.json?.channels)
    && !JSON.stringify(chs.json).includes('sk-'), String((chs.json?.channels ?? []).length))
  const dirs = await call('GET', '/api/ecom-workbench/content/dirs')
  check('★ /content/dirs 还通', dirs.code === 200 && typeof dirs.json?.artifacts === 'string', '')
}

console.log('')
console.log(bad === 0
  ? '结论：生成路由（立刻返回 / 进度 / 产物 / 记录 / 取消 / 校验 / 清单 / 连通）全部通过 ✓'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
