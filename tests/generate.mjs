/** 生成任务的编排层（契约 CC，2026-10-26）。
 *
 * # ⚠️ 不连真服务
 *
 * 全部走注入的假 `fetchImpl`。验的是「拆成提交 + 轮询之后，六步顺序对不对、
 * 限流真不真、失败留不留档」，**不验**真打一次上游能出图。
 *
 * 跑法：node --import <tsx> tests/generate.mjs
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-gen-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const {
  submitGeneration, getTask, listTasks, cancelTask, resetGenerateForTest,
  setGenerateDeps, listModels, testChannel, pickChannel, categoryOf, pickWorkflow,
} = await import('../src/schedule/generate.ts')
const { saveChannel } = await import('../src/schedule/channels.ts')
const { artifactsDir, canvasesDir } = await import('../src/schedule/artifacts.ts')
const { genLogsDir } = await import('../src/schedule/artifacts.ts')
const { loadArtifact } = await import('../src/schedule/artifacts.ts')
const { resetChannelQueueForTest, runningTotal } = await import('../src/schedule/channel-queue.ts')

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
 * 造一个假 fetch：回固定 JSON，可选延迟，并记录同时进行中的请求数峰值。
 * @param {object} opts - `{body, status, delayMs, counter}`。
 * @returns {Function} 假 fetch。
 */
function jsonFetch(opts = {}) {
  for (const k of Object.keys(opts ?? {})) void k
  const counter = { now: 0, peak: 0 }
  const impl = async () => {
    counter.now += 1
    counter.peak = Math.max(counter.peak, counter.now)
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    counter.now -= 1
    return new Response(JSON.stringify(opts.body ?? { data: [{ b64_json: PNG_B64 }] }), {
      status: opts.status ?? 200, headers: { 'content-type': 'application/json' },
    })
  }
  impl.counter = counter
  return impl
}

/**
 * 等一个任务到终态（或超时）。
 * @param {string} id - 任务 id。
 * @param {number} [timeoutMs] - 最多等多久。
 * @returns {Promise<object|null>} 任务。
 */
async function settle(id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const t = getTask(id)
    if (t !== null && (t.status === 'success' || t.status === 'failed')) return t
    if (Date.now() >= deadline) return getTask(id)
    await new Promise(r => setTimeout(r, 10))
  }
}

/**
 * 建一个能出图的 OpenAI 渠道。
 * @param {string} id - 渠道 id。
 * @param {number} [max] - 并发上限。
 * @returns {Promise<object>} 存好的渠道。
 */
async function mkChannel(id, max = 5) {
  const r = await saveChannel({
    id, name: '渠道 ' + id, protocol: 'openai', baseUrl: 'https://api.example.com',
    models: [{ id: 'img-1', label: '出图', caps: ['image'] }],
    maxConcurrency: max,
  })
  if ('error' in r) throw new Error('建渠道失败：' + r.error)
  return r.channel
}

/* ── ① 提交立刻返回，任务能查到 ───────────────────────────────────── */
console.log('① 提交立刻返回（不等生成）')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await mkChannel('ch_fast')
  /* 假 fetch 延迟 300ms —— 如果 `submitGeneration` 是同步等结果，这里会花 300ms。 */
  setGenerateDeps({ netFetch: jsonFetch({ delayMs: 300 }) })

  const t0 = Date.now()
  const task = submitGeneration({ kind: 'image', prompt: '一只白猫', model: 'img-1', channelId: 'ch_fast' })
  const spent = Date.now() - t0
  check('★★ 提交在 50ms 内返回（不挂住等生成）', spent < 50, String(spent) + 'ms')
  check('★★ 返回里有任务 id', typeof task.id === 'string' && task.id !== '', task.id)
  check('★★ 提交时状态是 submitted（还没开跑）', task.status === 'submitted', task.status)
  check('★ 用任务 id 立刻查得到', getTask(task.id)?.id === task.id, '')

  const done = await settle(task.id)
  check('★★ 最终成功', done?.status === 'success', String(done?.status))
  /* 三态都走过了（这就是验收 2 要的 submitted → running → success）。 */
  const seen = done.history.map(h => h.status)
  check('★★ 进度里能看到 submitted → running → success 三态',
    seen.includes('submitted') && seen.includes('running') && seen.includes('success'),
    seen.join(' → '))
}

/* ── ② 产物真落盘 ────────────────────────────────────────────────── */
console.log('')
console.log('② 产物真落盘')
{
  resetGenerateForTest()
  setGenerateDeps({ netFetch: jsonFetch() })
  const task = submitGeneration({ kind: 'image', prompt: '猫', model: 'img-1', channelId: 'ch_fast', source: 'workbench' })
  const done = await settle(task.id)
  check('★★ 任务里带回一个产物', done.artifacts.length === 1, String(done.artifacts.length))
  const a = done.artifacts[0]
  check('★★ 产物 id 与 url 都在（界面直接塞 img src）',
    typeof a?.id === 'string' && a.url === '/api/ecom-workbench/artifact/' + a.id, String(a?.url))
  /* 真的从磁盘取回来对字节 —— 只看任务里那个数字不算「落盘」。 */
  const loaded = await loadArtifact(a.id)
  check('★★ 从磁盘取回来字节与原图逐字节相同',
    loaded !== null && loaded.data.equals(PNG), String(loaded?.data?.length))
  check('★★ content-type 是 image/png', loaded?.meta.mime === 'image/png', String(loaded?.meta.mime))
  const files = await readdir(artifactsDir())
  check('★ artifacts/ 下真有这个文件',
    files.some(f => f === a.id + '.png') && files.some(f => f === a.id + '.json'),
    files.filter(f => f.startsWith(a.id)).join(','))
}

/* ── ③ 生成记录真写（15 个字段一个不多一个不少）────────────────── */
console.log('')
console.log('③ 生成记录')
{
  resetGenerateForTest()
  setGenerateDeps({ netFetch: jsonFetch() })
  const task = submitGeneration({
    kind: 'image', prompt: '猫', model: 'img-1', channelId: 'ch_fast',
    size: '1024x1024', count: 2, source: 'canvas', canvasId: 'cv_1', canvasNodeId: 'n3',
  })
  const done = await settle(task.id)
  const raw = await readFile(join(genLogsDir(), 'image', task.id + '.json'), 'utf8')
  const log = JSON.parse(raw)
  check('★★ 记录落在 gen-logs/image/<任务id>.json', log.id === task.id, log.id)

  /* 15 个字段的闭集（照 `gen-logs.ts` 的 `GenLog`）。多一个少一个都不行。 */
  const allowed = ['id', 'kind', 'createdAt', 'endedAt', 'status', 'channelId', 'model', 'prompt',
    'negativePrompt', 'params', 'artifacts', 'usage', 'error', 'source', 'canvasId', 'canvasNodeId']
  const extra = Object.keys(log).filter(k => !allowed.includes(k))
  check('★★ 没有多余的字段', extra.length === 0, extra.join(','))
  const must = ['id', 'kind', 'createdAt', 'status', 'channelId', 'model', 'prompt', 'params', 'artifacts', 'usage']
  check('★★ 必填十个都在', must.every(k => log[k] !== undefined), must.filter(k => log[k] === undefined).join(','))
  check('★★ 状态是 success', log.status === 'success', log.status)
  check('★★ 来源与画布反查字段也带上了',
    log.source === 'canvas' && log.canvasId === 'cv_1' && log.canvasNodeId === 'n3',
    JSON.stringify({ s: log.source, c: log.canvasId, n: log.canvasNodeId }))
  check('★★ 参数原样留着（尺寸、张数）',
    log.params?.size === '1024x1024' && log.params?.count === 2, JSON.stringify(log.params))
  check('★★ 用量只记张数（不记任何结算量）',
    log.usage?.images === 1 && log.usage?.seconds === undefined, JSON.stringify(log.usage))
  check('★ 没给 negativePrompt 时那个键不在', !('negativePrompt' in log), JSON.stringify(Object.keys(log)))
  check('★★ 成功记录里没有 error 键', !('error' in log), '')

  const vids = await readdir(join(genLogsDir(), 'image'))
  check('★ 目录里真有这一份', vids.includes(task.id + '.json'), '')
}

/* ── ④ 失败也留档，带上游原文 ────────────────────────────────────── */
console.log('')
console.log('④ 失败也留档')
{
  resetGenerateForTest()
  setGenerateDeps({
    netFetch: jsonFetch({ status: 500, body: { error: { message: '上游模型暂时不可用' } } }),
  })
  const task = submitGeneration({ kind: 'image', prompt: '猫', model: 'img-1', channelId: 'ch_fast' })
  const done = await settle(task.id)
  check('★★ 任务状态是 failed', done.status === 'failed', done.status)
  check('★★ 错误里带出上游原文', String(done.error).includes('上游模型暂时不可用'), String(done.error))
  /* 先等落盘（写记录在 catch 里、任务状态更新之前 —— 但保险起见轮询一下）。 */
  let log = null
  for (let i = 0; i < 50 && log === null; i += 1) {
    try { log = JSON.parse(await readFile(join(genLogsDir(), 'image', task.id + '.json'), 'utf8')) } catch {
      await new Promise(r => setTimeout(r, 10))
    }
  }
  check('★★ 失败也写了一份记录', log !== null && log.id === task.id, String(log?.id))
  check('★★ 记录里 status=failed 且 error 是上游原文',
    log?.status === 'failed' && String(log?.error).includes('上游模型暂时不可用'), String(log?.error))
  check('★ 失败记录里没有产物', Array.isArray(log?.artifacts) && log.artifacts.length === 0,
    JSON.stringify(log?.artifacts))
}

/* ── ⑤ 取消真生效 ────────────────────────────────────────────────── */
console.log('')
console.log('⑤ 取消')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  /* 慢响应：给取消留出时间窗。 */
  setGenerateDeps({ netFetch: jsonFetch({ delayMs: 400 }) })
  const task = submitGeneration({ kind: 'image', prompt: '猫', model: 'img-1', channelId: 'ch_fast' })
  /* 等它真的开始跑，再取消（立刻取消会落在 submitted 阶段，验不到「跑中取消」）。 */
  for (let i = 0; i < 100 && getTask(task.id)?.status === 'submitted'; i += 1) {
    await new Promise(r => setTimeout(r, 5))
  }
  const cancelled = cancelTask(task.id)
  check('★★ 取消返回 true', cancelled === true, String(cancelled))
  const done = await settle(task.id)
  check('★★ 任务变成 failed', done.status === 'failed', done.status)
  check('★★ 错误里说明是取消', String(done.error).includes('取消'), String(done.error))
  check('★ 进度里记了「用户点了停止」这一步',
    done.history.some(h => h.stage === 'cancelling'), done.history.map(h => h.stage).join(','))

  /* 已经结束的任务再取消 → false（不假装成功）。 */
  check('★ 已结束的任务取消 → false', cancelTask(task.id) === false, '')
  check('★ 不存在的任务取消 → false', cancelTask('never-exist') === false, '')
}

/* ── ⑥ 限流真生效（验收 7 + 8）───────────────────────────────────── */
console.log('')
console.log('⑥ 限流：同一渠道连提 8 个，同时最多 maxConcurrency 个')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await mkChannel('ch_limit', 2)
  const f = jsonFetch({ delayMs: 60 })
  setGenerateDeps({ netFetch: f })

  const ids = []
  for (let i = 0; i < 8; i += 1) {
    ids.push(submitGeneration({ kind: 'image', prompt: '第 ' + String(i), model: 'img-1', channelId: 'ch_limit' }).id)
  }
  const done = await Promise.all(ids.map(id => settle(id, 8000)))
  check('★★ 8 个全部成功（排队不拒绝）', done.every(t => t.status === 'success'),
    done.map(t => t.status).join(','))
  check('★★ **同时在跑**的峰值 ≤ maxConcurrency(2) —— 限流真的生效',
    f.counter.peak <= 2, String(f.counter.peak))
  check('★ 而且真的并发到了 2（没退化成串行）', f.counter.peak === 2, String(f.counter.peak))
  check('★ 跑完之后队列计数归零', runningTotal() === 0, String(runningTotal()))

  /* 反向证明这条断言咬得住：把上限调成 5 再跑，峰值应该跟着变大。
   * 如果断言写错了（比如没数到），这里会看到峰值还是 2。 */
  resetGenerateForTest()
  resetChannelQueueForTest()
  await mkChannel('ch_limit5', 5)
  const f2 = jsonFetch({ delayMs: 60 })
  setGenerateDeps({ netFetch: f2 })
  const ids2 = []
  for (let i = 0; i < 8; i += 1) {
    ids2.push(submitGeneration({ kind: 'image', prompt: 'p', model: 'img-1', channelId: 'ch_limit5' }).id)
  }
  await Promise.all(ids2.map(id => settle(id, 8000)))
  check('★★ 上限调成 5 时峰值跟着变大（证明第 2 条数的是真并发）',
    f2.counter.peak === 5, String(f2.counter.peak))
  resetChannelQueueForTest()
}

/* ── ⑦ 模型清单接口（跨渠道、按能力筛）────────────────────────────── */
console.log('')
console.log('⑦ 模型清单')
{
  await saveChannel({
    id: 'ch_vid', name: '视频渠道', protocol: 'openai', baseUrl: 'https://v.example.com',
    models: [
      { id: 'vid-1', label: '出视频', caps: ['video'] },
      { id: 'both-1', label: '图与视频', caps: ['image', 'video'] },
    ],
    maxConcurrency: 3,
  })
  const imgs = await listModels('image')
  const ids = imgs.map(m => m.modelId)
  check('★★ kind=image 只返回 caps 含 image 的模型',
    ids.includes('img-1') && ids.includes('both-1') && !ids.includes('vid-1'), ids.join(','))
  check('★★ 跨渠道合并（两个渠道的模型都在）',
    imgs.some(m => m.channelId === 'ch_fast') && imgs.some(m => m.channelId === 'ch_vid'),
    imgs.map(m => m.channelId).join(','))
  check('★ 每条带渠道名、模型名、能力',
    imgs.every(m => m.channelName !== '' && m.modelLabel !== '' && Array.isArray(m.caps)), '')
  const all = await listModels()
  check('★ 不传 kind 就列全部', all.length >= 3, String(all.length))
}

/* ── ⑧ 渠道连通测试 ──────────────────────────────────────────────── */
console.log('')
console.log('⑧ 渠道连通测试')
{
  setGenerateDeps({ netFetch: jsonFetch({ body: { data: [] } }) })
  const ok = await testChannel('ch_fast')
  check('★★ 200 → ok', ok.ok === true && ok.status === 200, JSON.stringify(ok))

  setGenerateDeps({ netFetch: jsonFetch({ status: 401, body: { error: { message: 'Invalid API key' } } }) })
  const bad1 = await testChannel('ch_fast')
  check('★★ 401 → 失败且带上游原因',
    bad1.ok === false && bad1.status === 401 && bad1.message.includes('Invalid API key'), bad1.message)

  setGenerateDeps({ netFetch: async () => { throw new Error('ECONNREFUSED') } })
  const down = await testChannel('ch_fast')
  check('★★ 连不上 → 失败且说明「连不上」',
    down.ok === false && down.message.includes('连不上') && down.message.includes('ECONNREFUSED'), down.message)

  const none = await testChannel('never-exist')
  check('★ 不存在的渠道 → 失败并说清', none.ok === false && none.message.includes('没有这个渠道'), none.message)

  /* 三种协议各打对的探测端点。 */
  const seen = []
  setGenerateDeps({ netFetch: async (url) => { seen.push(String(url)); return new Response('{}', { status: 200 }) } })
  await testChannel('ch_fast')
  await saveChannel({ id: 'ch_cf', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8189', models: [] })
  await testChannel('ch_cf')
  await saveChannel({ id: 'ch_gm', name: 'G', protocol: 'gemini', baseUrl: 'https://g.example.com', models: [] })
  await testChannel('ch_gm')
  check('★★ 三种协议各打自己的探测端点（openai /v1/models、comfyui /system_stats、gemini /v1beta/models）',
    seen.some(u => u.endsWith('/v1/models')) && seen.some(u => u.endsWith('/system_stats')) && seen.some(u => u.endsWith('/v1beta/models')),
    seen.join(' | '))
}

/* ── ⑨ 选渠道与类别映射 ──────────────────────────────────────────── */
console.log('')
console.log('⑨ 选渠道与工作流类别')
{
  const picked = await pickChannel('image')
  check('★★ 按能力自动选渠道（挑到能出图的）', 'channel' in picked && picked.channel.models.some(m => m.caps.includes('image')),
    'error' in picked ? picked.error : String(picked.channel.id))

  const none = await pickChannel('audio')
  check('★★ 没有渠道能做 audio → 清楚报错并列出各渠道能力',
    'error' in none && none.error.includes('没有渠道能生成 audio'), 'error' in none ? none.error : '意外选中')

  const one = await pickChannel('image', 'ch_vid')
  check('★ 指定 channelId 时就用它', 'channel' in one && one.channel.id === 'ch_vid', '')

  check('★★ 类目映射：无参考图的图 → t2i，有参考图 → i2i',
    categoryOf('image', false) === 't2i' && categoryOf('image', true) === 'i2i', '')
  check('★ 视频 → omniVideo、音频 → audio、文字 → text',
    categoryOf('video', false) === 'omniVideo' && categoryOf('audio', false) === 'audio'
    && categoryOf('text', false) === 'text', '')

  /* 渠道没配工作流时，回落到内置默认（那 16 份）。 */
  const wf = pickWorkflow({}, 't2i')
  check('★★ 渠道没配工作流时回落到内置默认（那 16 份）',
    wf !== null && Object.keys(wf).length > 0, String(wf === null ? 'null' : Object.keys(wf).length))
  const noneWf = pickWorkflow({}, 'superResolve')
  check('★★ 内置也没有的类别 → null（不抛错）', noneWf === null, String(noneWf))
}

/* ── ⑩ 任务表上限 ────────────────────────────────────────────────── */
console.log('')
console.log('⑩ 任务表不会无限涨')
{
  resetGenerateForTest()
  setGenerateDeps({ netFetch: jsonFetch() })
  for (let i = 0; i < 210; i += 1) submitGeneration({ kind: 'image', prompt: 'p', model: 'img-1', channelId: 'ch_fast' })
  const list = listTasks(1000)
  check('★★ 上限 200 条（超出的旧任务被挤掉）', list.length <= 200, String(list.length))
  check('★ 列表按时间倒序（新的在前）',
    list.every((t, i) => i === 0 || list[i - 1].createdAt >= t.createdAt), '')
  await new Promise(r => setTimeout(r, 200))
}

console.log('')
console.log(bad === 0
  ? '结论：生成编排（提交/轮询/产物/记录/失败/取消/限流/清单/连通）全部通过 ✓（⚠️ 真打上游未验）'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
