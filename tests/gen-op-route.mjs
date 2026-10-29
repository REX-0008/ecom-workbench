/** 生成路由接受 op / mask，模型清单按 op 过滤（契约 T1，2026-10-26）。
 *
 * ## 为什么要单独一份
 *
 * `gen-op.mjs` 验的是纯函数与 ComfyUI 那条路。**路由层**是另一件事：
 * 请求体里的 `op` / `mask` 有没有真的被接住、`?op=` 有没有真的走过滤。
 * 这一层走的是 `apply(fakeCtx)` 抓住路由处理函数（照 `tests/generate-route.mjs` 的模式）。
 *
 * 跑法：node --import <tsx> tests/gen-op-route.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-genopr-'))
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

/* 假 ComfyUI：上传回文件名、提交回 prompt_id、历史直接 done。 */
function fakeComfyHttp() {
  return async (url) => {
    const u = String(url)
    const json = (body) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    if (u.includes('/upload/image')) return json({ name: 'up_mask.png', subfolder: '', type: 'input' })
    if (u.includes('/prompt')) return json({ prompt_id: 'job-1' })
    if (u.includes('/system_stats')) return json({ system: { os: 'nt' } })
    if (u.includes('/history/')) {
      return json({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs: { 9: { images: [{ filename: 'o.png', subfolder: '', type: 'output' }] } },
        },
      })
    }
    if (u.includes('/queue')) return json({ queue_running: [], queue_pending: [] })
    if (u.includes('/view')) {
      return new Response(Buffer.from(PNG_B64, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } })
    }
    return json({})
  }
}

/* ── ① POST /generate 接受 op 与 mask ───────────────────────────────── */

console.log('① POST /generate 接住 op 与 mask（不是静静丢掉）')
{
  await saveChannel({
    id: 'ch-comfy', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
  })
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ comfyHttp: { fetchImpl: fakeComfyHttp() } })

  const r = await call('POST', '/api/ecom-workbench/generate', {
    kind: 'image', prompt: '把背景换成海', model: 'local', channelId: 'ch-comfy',
    op: 'inpaint',
    mask: { base64: PNG_B64, mime: 'image/png' },
  })
  check('★★ 接口回 200 且给了任务 id', r.code === 200 && typeof r.json?.id === 'string',
    String(r.code) + ' / ' + String(r.json?.id))

  /* 任务能跑完，说明 `op` / `mask` 没有把这条链弄坏。 */
  const deadline = Date.now() + 5000
  let t = null
  for (;;) {
    t = getTask(r.json.id)
    if (t !== null && (t.status === 'success' || t.status === 'failed')) break
    if (Date.now() > deadline) break
    await new Promise(done => setTimeout(done, 20))
  }
  check('★★ 带 op+mask 的任务跑完了（成功）', t?.status === 'success',
    String(t?.status) + ' / ' + String(t?.error ?? ''))
  check('★★ 有产出（遮罩那条链没把产出吞掉）', (t?.artifacts?.length ?? 0) > 0,
    String(t?.artifacts?.length ?? 0))
}

console.log('② 不认识的 op 当没给（不因一个笔误让整次生成失败）')
{
  const r = await call('POST', '/api/ecom-workbench/generate', {
    kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-comfy',
    op: 'blur',      /* 不在 GEN_OPS 里 */
  })
  check('★★ 笔误的 op 不报错（照样接单）', r.code === 200 && typeof r.json?.id === 'string',
    String(r.code))
}

/* ── ③ GET /gen-models?op= 真走过滤 ─────────────────────────────────── */

console.log('③ GET /gen-models 支持按 op 过滤')
{
  await saveChannel({
    id: 'ch-net', name: '云端', protocol: 'openai', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'gpt-image-1', label: '出图', caps: ['image'] }],
  })
  const plain = await call('GET', '/api/ecom-workbench/gen-models')
  check('★★ 不带 op：两个渠道都列', (plain.json?.models?.length ?? 0) === 2,
    String(plain.json?.models?.length ?? 0))
  check('★ 不带 op 时回包里没有 op 字段', plain.json?.op === undefined, JSON.stringify(plain.json?.op))

  const up = await call('GET', '/api/ecom-workbench/gen-models?op=upscale')
  check('★★ ?op=upscale：一个都不列（内置没有这一类，渠道也没挂）',
    (up.json?.models?.length ?? -1) === 0, String(up.json?.models?.length))
  check('★★ 回包里带上是哪个 op（界面能核对自己问的）', up.json?.op === 'upscale',
    String(up.json?.op))

  const cap = await call('GET', '/api/ecom-workbench/gen-models?op=caption')
  /* 上面那两个渠道（`ch-comfy` 只有 image、`ch-net` 只有 image）都不该出现网络模型：
   * 网络模型的 caption 会强制按 `kind:'text'` 发，只会画图的模型到那里就被拦。 */
  check('★★ ?op=caption：网络模型那边只留 ComfyUI（那个模型没有 text 能力）',
    (cap.json?.models?.length ?? 0) === 1 && cap.json?.models?.[0]?.channelId === 'ch-comfy',
    String(cap.json?.models?.length ?? 0) + ' / ' + (cap.json?.models ?? []).map(m => m.channelId).join(','))

  const bogus = await call('GET', '/api/ecom-workbench/gen-models?op=blur')
  check('★★ 不认识的 op 当没给（列全部，不静默回空）',
    (bogus.json?.models?.length ?? 0) === 2, String(bogus.json?.models?.length ?? 0))
}

console.log('')
if (bad === 0) {
  console.log('全部通过 ✓')
} else {
  console.log('有 ' + String(bad) + ' 条不通过 ✗')
  process.exitCode = 1
}
