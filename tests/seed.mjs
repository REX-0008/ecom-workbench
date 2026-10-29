/** 生成链路把种子传进 ComfyUI 工作流，并写进生成记录（票 08，2026-10-30）。
 *
 * # 它守的是什么
 *
 * 在此之前：`ComfyBindings.seed` 字段在、`applyBindings` 的 `title === 'seed'`
 * 分支在、`KSampler: 'seed'` 槽位映射也在 —— **三层能力都在，只有最上面那层
 * （`GenerateInput` → `bindings`）没接上**。于是工作流里那个写死的种子永远不变，
 * 同一句提示词重跑返回同一张图（ComfyUI 还会直接命中缓存，0.02 秒返回）。
 * 用户点「重新生成」以为按钮坏了。
 *
 * 所以这一份验的不是 `applyBindings`（`comfyui.mjs` 已经验过它认得 seed），
 * 而是「请求里的种子真的从最上面一层走到工作流里、并且被记下来」。
 *
 * # 判据（票面五条）
 *
 * 1. 不给 seed → 用的是随机整数，落在 `[0, 2**32-1]`
 * 2. 连发两次同样的请求 → 两次的种子不同（本票存在的理由）
 * 3. 给了 seed → 用它，不被随机覆盖
 * 4. 那个种子出现在生成记录里（`gen-logs/image/<id>.json` 的 `params.seed`）
 * 5. `applyBindings` 真把种子填进了标题为 `seed` 的节点
 *
 * # 跑法
 *
 * ```
 * DSH_HOME=F:/AGENTS/agent-chat-dsh node scripts/run-tests.mjs seed
 * ```
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-seed-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { saveChannel } = await import('../src/schedule/channels.ts')
const { resetGenerateForTest, setGenerateDeps, getTask, pickSeed, SEED_MAX } = await import('../src/schedule/generate.ts')
const { resetChannelQueueForTest } = await import('../src/schedule/channel-queue.ts')
const { applyBindings } = await import('../src/schedule/comfyui.ts')
const { genLogsDir } = await import('../src/schedule/artifacts.ts')

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
 * @param {object} [body] - 请求体。
 * @returns {Promise<{code:number, json:any}>} 响应。
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
  await handler(req, res)
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { code, json }
}

/** 1×1 PNG。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 一份最小的文生图工作流：只留 seed 那个槽位与输出标记。
 *
 * 为什么不用真的 SD1.5 那份：这一段验的是「种子有没有从请求走到工作流」，
 * 与 checkpoint 名字、步数、采样器毫无关系。工作流越小，「填进去了」这件事
 * 越难被别的分支碰巧满足。
 * @returns {object} 工作流。
 */
function tinyWorkflow() {
  return {
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' }, _meta: { title: 'prompt' } },
    '10': { class_type: 'PrimitiveInt', inputs: { value: 12345 }, _meta: { title: 'seed' } },
    '3': { class_type: 'KSampler', inputs: { seed: ['10', 0], steps: 20 }, _meta: { title: 'K 采样器' } },
    '1': { class_type: 'SaveImage', inputs: {}, _meta: { title: 'output_image' } },
  }
}

/**
 * 替身 ComfyUI：记下提交上去的每一份工作流。
 *
 * ⚠️ 这里能「什么都收」是因为本票不验工作流合法性（`comfyui-live.mjs` 才验）。
 * 但它必须**如实记下**收到的那份 —— 本票所有断言都从这份记录里读，
 * 记错了就等于没验。
 * @returns {{fetchImpl: Function, submitted: object[]}} 替身与记录。
 */
function fakeComfy() {
  const submitted = []
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.includes('/prompt')) {
      let body = null
      try { body = JSON.parse(String(init?.body ?? '{}')) } catch { body = null }
      submitted.push(body)
      /* prompt_id 带上序号：同一份 history 形状被两次请求共用的话，
       * 「第二次出的图是不是新的」这类断言会互相干扰。 */
      return json({ prompt_id: 'job-' + String(submitted.length) })
    }
    if (u.includes('/system_stats')) return json({ system: { os: 'nt' } })
    if (u.includes('/history/')) {
      /* 按请求里那个 id 回（不是写死 `job-1`）。
       * 第一版写死了 `job-1`，于是第二、三次请求拿到的 prompt_id 是 `job-2` / `job-3`，
       * history 里永远查不到 → 任务一直是 pending → 测试挂到超时。
       * 替身要照真机的形状：给哪个 id 就回哪个 id 的历史。 */
      const id = decodeURIComponent(u.slice(u.indexOf('/history/') + '/history/'.length).split('?')[0])
      return json({
        [id]: {
          status: { status_str: 'success', completed: true },
          outputs: { 1: { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } },
        },
      })
    }
    if (u.includes('/queue')) return json({ queue_running: [], queue_pending: [] })
    if (u.includes('/view')) {
      return new Response(Buffer.from(PNG_B64, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } })
    }
    return json({})
  }
  return { fetchImpl, submitted }
}

/**
 * 等一个任务跑到终态。
 * @param {string} id - 任务 id。
 * @param {number} ms - 最多等多久。
 * @returns {Promise<object|null>} 任务。
 */
async function waitTask(id, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const t = getTask(id)
    if (t !== null && (t.status === 'success' || t.status === 'failed' || t.status === 'cancelled')) return t
    if (Date.now() > deadline) return t
    await new Promise(done => setTimeout(done, 20))
  }
}

/**
 * 读一条生成记录。
 * @param {string} id - 任务 id（同时是记录 id）。
 * @returns {Promise<object|null>} 记录。
 */
async function readLog(id) {
  for (let i = 0; i < 50; i += 1) {
    try { return JSON.parse(await readFile(join(genLogsDir(), 'image', id + '.json'), 'utf8')) } catch {
      await new Promise(r => setTimeout(r, 10))
    }
  }
  return null
}

/**
 * 走一次 `/generate`，返回任务与提交给 ComfyUI 的那份工作流。
 * @param {object} body - 请求体。
 * @param {object} fake - 替身。
 * @returns {Promise<{task: object|null, sent: object}>} 任务与提交内容。
 */
async function generateOnce(body, fake) {
  const before = fake.submitted.length
  const r = await call('POST', '/api/ecom-workbench/generate', body)
  const task = await waitTask(r.json?.id ?? '', 5000)
  const sent = fake.submitted[before]?.prompt ?? {}
  return { task, sent, code: r.code, id: r.json?.id }
}

/* ── ① 随机种子的取值范围 ─────────────────────────────────────────── */

console.log('① 不给 seed → 随机整数，落在 [0, 2**32-1]')
{
  check('★★ 上界就是 ComfyUI 那种子的最大值', SEED_MAX === 4294967295, String(SEED_MAX))

  const draws = Array.from({ length: 1000 }, () => pickSeed())
  check('★★ 1000 次取出来全是整数（没有小数）', draws.every(n => Number.isInteger(n)),
    String(draws.filter(n => !Number.isInteger(n)).length) + ' 个不是整数')
  check('★★ 全部落在 [0, 2**32-1]', draws.every(n => n >= 0 && n <= SEED_MAX),
    '最小 ' + String(Math.min(...draws)) + ' / 最大 ' + String(Math.max(...draws)))
  check('★★ 1000 次不是同一个数（随机真的在动）', new Set(draws).size > 900,
    String(new Set(draws).size) + ' 个不同的值')
}

/* ── ② 请求里的种子走到工作流里 ──────────────────────────────────── */

console.log('')
console.log('② 走 /generate：不给就随机、给了就用给的')
{
  await saveChannel({
    id: 'ch-seed', name: '本地 comfyui', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'sd15', label: 'SD1.5', caps: ['image'] }],
    comfyuiT2iWorkflow: { name: '种子测试', json: tinyWorkflow() },
  })
  const fake = fakeComfy()
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ comfyHttp: { fetchImpl: fake.fetchImpl }, sleep: async () => { /* 不真睡 */ } })

  const base = {
    kind: 'image', prompt: 'a quiet street at dusk',
    model: 'sd15', channelId: 'ch-seed',
  }

  /* 第一次：不给 seed。 */
  const a = await generateOnce(base, fake)
  check('★★ 第一次成功', a.task?.status === 'success', String(a.task?.status) + ' / ' + String(a.task?.error ?? ''))
  const seedA = a.sent['10']?.inputs?.value
  check('★★ 不给 seed 时工作流里那个槽位是整数（不是原来的 12345 也照样是整数）',
    Number.isInteger(seedA), String(seedA))
  check('★★ 那个整数落在 [0, 2**32-1]', Number.isInteger(seedA) && seedA >= 0 && seedA <= SEED_MAX, String(seedA))
  check('★★ 任务上带着这次用的种子（界面与记录都读它）',
    a.task?.seed === seedA, String(a.task?.seed) + ' / ' + String(seedA))

  /* 第二次：同一句提示词，也不给 seed —— 本票存在的全部理由。 */
  const b = await generateOnce(base, fake)
  const seedB = b.sent['10']?.inputs?.value
  check('★★ 第二次也成功', b.task?.status === 'success', String(b.task?.status))
  check('★★★ 连发两次同样的请求 → 两次的种子不同',
    Number.isInteger(seedA) && Number.isInteger(seedB) && seedA !== seedB,
    String(seedA) + ' / ' + String(seedB))

  /* 第三次：明确给一个种子。 */
  const c = await generateOnce({ ...base, seed: 424242 }, fake)
  check('★★★ 给了 seed → 工作流里就是那个数（不被随机覆盖）',
    c.sent['10']?.inputs?.value === 424242, String(c.sent['10']?.inputs?.value))
  check('★★ 给了 seed 时任务上也记那个数', c.task?.seed === 424242, String(c.task?.seed))
}

/* ── ③ 种子写进生成记录 ─────────────────────────────────────────── */

console.log('')
console.log('③ 生成记录里查得到种子')
{
  const fake = fakeComfy()
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ comfyHttp: { fetchImpl: fake.fetchImpl }, sleep: async () => { /* 不真睡 */ } })

  const r = await generateOnce({
    kind: 'image', prompt: '记录里的种子', model: 'sd15', channelId: 'ch-seed',
  }, fake)
  const log = await readLog(r.id ?? '')
  check('★★ 记录落盘了', log !== null && log.id === r.id, String(log?.id))
  check('★★★ 记录里带着种子（`params.seed`）',
    Number.isInteger(log?.params?.seed), JSON.stringify(log?.params ?? null))
  check('★★★ 记录里那个种子就是工作流里用的那个',
    log?.params?.seed === r.sent['10']?.inputs?.value,
    String(log?.params?.seed) + ' / ' + String(r.sent['10']?.inputs?.value))

  /* 明确给的种子也要进记录 —— 「这张图用了哪个种子」在两条路上都得查得到。 */
  const r2 = await generateOnce({
    kind: 'image', prompt: '给定了种子', model: 'sd15', channelId: 'ch-seed', seed: 777,
  }, fake)
  const log2 = await readLog(r2.id ?? '')
  check('★★ 给了 seed 时记录里也是它', log2?.params?.seed === 777, String(log2?.params?.seed))
}

/* ── ④ 网络模型那条路不假装有种子 ───────────────────────────────── */

console.log('')
console.log('④ 网络模型那条路不写种子（它的接口没有这个参数）')
{
  /* 网络模型的接口（`/v1/images/generations`）没有种子参数。
   * 如果这一层也生成一个随机数写进记录，记录里那个数就是假的 ——
   * 用户照着它去「换个种子再来一张」会发现根本对不上。 */
  const netFetch = async () => new Response(JSON.stringify({
    created: 1, data: [{ b64_json: PNG_B64 }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  await saveChannel({
    id: 'ch-net', name: '网络渠道', protocol: 'openai', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'img-1', label: '图片模型', caps: ['image'] }],
  })
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ netFetch })

  const r = await generateOnce({
    kind: 'image', prompt: '网络模型', model: 'img-1', channelId: 'ch-net', seed: 888,
  }, { submitted: [] })
  check('★★ 网络模型那条路成功', r.task?.status === 'success',
    String(r.task?.status) + ' / ' + String(r.task?.error ?? ''))
  check('★★ 任务上没有种子（网络上没有这个概念）', r.task?.seed === undefined, String(r.task?.seed))
  const log = await readLog(r.id ?? '')
  check('★★ 记录里也没有 params.seed',
    log !== null && !('seed' in (log?.params ?? {})), JSON.stringify(log?.params ?? null))
}

/* ── ⑤ applyBindings 真把种子填进槽位 ───────────────────────────── */

console.log('')
console.log('⑤ applyBindings：种子真填进标题为 seed 的节点')
{
  const wf = tinyWorkflow()
  const bound = applyBindings(wf, { seed: 20261030 })
  check('★★★ 标题为 seed 的节点拿到了种子',
    bound['10']?.inputs?.value === 20261030, String(bound['10']?.inputs?.value))
  check('★ 原工作流没被改（返回的是拷贝）', wf['10']?.inputs?.value === 12345, String(wf['10']?.inputs?.value))

  /* 槽位名兜底：标 seed 的节点字段不叫 value 时也该填上。 */
  const other = {
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' }, _meta: { title: 'prompt' } },
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 }, _meta: { title: 'seed' } },
    '1': { class_type: 'SaveImage', inputs: {}, _meta: { title: 'output_image' } },
  }
  const b2 = applyBindings(other, { seed: 5 })
  check('★★ 字段名是 seed 时也填（KSampler 那种）', b2['3']?.inputs?.seed === 5, String(b2['3']?.inputs?.seed))

  /* 上面两条验的是 `applyBindings` 自己。**这一条验的是它真的被接上了** ——
   * 把 seed 从 `bindings` 里拿掉（恢复票 08 之前的现状）时，只有这一条会红：
   * 工作流里那个节点仍是它自己写死的 12345，而不是这次用的种子。 */
  const fake = fakeComfy()
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ comfyHttp: { fetchImpl: fake.fetchImpl }, sleep: async () => { /* 不真睡 */ } })
  const r = await generateOnce({
    kind: 'image', prompt: '种子真进了工作流', model: 'sd15', channelId: 'ch-seed', seed: 13579,
  }, fake)
  check('★★★ 提交出去的那份工作流里，seed 节点是这次的种子（不是它自己写死的 12345）',
    r.sent['10']?.inputs?.value === 13579, String(r.sent['10']?.inputs?.value))
}

console.log(bad === 0 ? '\n全部通过 ✓' : '\n' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
