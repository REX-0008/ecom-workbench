/** ComfyUI 最小通路：渠道绑了工作流、默认模型指过去、走 /generate 真能出图（票 03，2026-10-30）。
 *
 * # 为什么单开一份
 *
 * `comfyui.mjs` 验的是 `applyBindings` 这类纯函数，`comfyui-http.mjs` 验的是
 * 那一层 HTTP 客户端，`channels-workflow.mjs` 验的是「渠道上那 14 个字段存得进去」。
 * 没有任何一条把这三段串起来验：渠道里挂了工作流 → 取默认模型 → 走 `/generate`
 * → 出图。中间任何一段断了，上面三份测试全是绿的。
 *
 * 这正是本项目反复出现的病（`AGENTS.md` 里记着「测试绿了 ≠ 生产走了那条路」）：
 * 每一段各自绿，串起来不通。所以这一份只验串起来。
 *
 * # 两段，判据不同
 *
 * | 段 | 依赖 | 验什么 |
 * |---|---|---|
 * | ① 用替身 ComfyUI | 无（假 fetch） | 渠道配好之后 `/generate` 这条路结构上通 |
 * | ② 用真 ComfyUI | 本机 8188 在跑 | 真出图；不在跑就 `[SKIP]`，不算通过 |
 *
 * ⚠️ ② 段不给「通过」记账：ComfyUI 没开时它打一行 `[SKIP]`，
 * `scripts/run-tests.mjs` 会把 `[SKIP]` 单独列出来，不混进通过数。
 * 不这么做的话，「ComfyUI 没开」会被读成「通路验过了」。
 *
 * # 跑法
 *
 * ```
 * DSH_HOME=F:/AGENTS/agent-chat-dsh node scripts/run-tests.mjs comfyui-live
 * ```
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-comfylive-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { saveChannel, readChannels } = await import('../src/schedule/channels.ts')
const { saveModelDefaults, readModelDefaults, defaultOf, defaultStatus } = await import('../src/schedule/model-defaults.ts')
const { resetGenerateForTest, setGenerateDeps, getTask } = await import('../src/schedule/generate.ts')
const { resetChannelQueueForTest } = await import('../src/schedule/channel-queue.ts')
const { validateComfyWorkflow, applyBindings } = await import('../src/schedule/comfyui.ts')
const { pickWorkflow } = await import('../src/schedule/generate.ts')

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
 * 模拟一次 HTTP 调用（照 `tests/gen-op-route.mjs` 的写法）。
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

/* 本机 ComfyUI 的地址（与交付里配进渠道的那个一致）。 */
const COMFY_URL = 'http://127.0.0.1:8188'

/**
 * 一份 SD1.5 文生图工作流（与 `scripts/comfyui/sd15-t2i.workflow.json` 同形）。
 *
 * 为什么不在这里 `readFile` 那个文件：这一段验的是「渠道里挂的 JSON 能不能
 * 一路走到提交」，从文件读进来会多一个「文件在不在」的失败面，
 * 与要验的事无关。② 段才去读真文件。
 * @returns {object} 工作流。
 */
function sd15Workflow() {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anything-v5-PrtRE.safetensors' }, _meta: { title: '加载模型' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece', clip: ['4', 1] }, _meta: { title: 'prompt' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['4', 1] }, _meta: { title: 'negative' } },
    '8': { class_type: 'PrimitiveInt', inputs: { value: 512 }, _meta: { title: 'width' } },
    '9': { class_type: 'PrimitiveInt', inputs: { value: 512 }, _meta: { title: 'height' } },
    '10': { class_type: 'PrimitiveInt', inputs: { value: 12345 }, _meta: { title: 'seed' } },
    '11': { class_type: 'EmptyLatentImage', inputs: { width: ['8', 0], height: ['9', 0], batch_size: 1 }, _meta: { title: '空 Latent' } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: ['10', 0], steps: 20, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras',
        denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0],
      },
      _meta: { title: 'K 采样器' },
    },
    '5': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] }, _meta: { title: 'VAE 解码' } },
    '1': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'ewb' }, _meta: { title: 'output_image' } },
  }
}

/**
 * 替身 ComfyUI：记下提交上去的那份工作流，回一份像样的历史。
 *
 * ## 为什么不「什么都收」（第一版就是什么都收，被自证抓出来的）
 *
 * 第一版的替身对 `/prompt` 一律回 `prompt_id`。于是「把渠道里那份工作流清掉」
 * 这条自证里，「走 /generate 能出图」仍然绿 —— 因为 `pickWorkflow` 会回落到
 * 内置的 t2i 那份（要 `z_image_turbo_bf16.safetensors`），而替身不认模型、
 * 照收不误。真机不会这样：ComfyUI 对找不到的模型回 200 + `node_errors`，
 * `submitPrompt` 把它当失败（`comfyui-http.ts:189`）。
 *
 * 所以替身必须照真机那条判据：模型文件不在本机清单里就拒收。
 * 这样「工作流是不是这一份」才是出图成功的必要条件，而不是碰巧。
 *
 * @returns {{fetchImpl: Function, submitted: object[]}} 替身与它记下的提交。
 */
function fakeComfy() {
  const submitted = []
  /* 本机真有的 checkpoint（照 `GET /object_info/CheckpointLoaderSimple` 的实测清单）。
   * 内置那 16 份要的 `qwen_image_2.1_bf16` / `z_image_turbo_bf16` / `ae.safetensors`
   * 一个都不在里面 —— 所以清掉渠道工作流之后必然跑不了。 */
  const HAS_CKPT = 'anything-v5-PrtRE.safetensors'
  const fetchImpl = async (url, init) => {
    const u = String(url)
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.includes('/prompt')) {
      let body = null
      try { body = JSON.parse(String(init?.body ?? '{}')) } catch { body = null }
      submitted.push(body)
      /* 照真机的形状：模型不在清单里就 200 + node_errors（不是 4xx）。 */
      const bad = []
      for (const [id, node] of Object.entries(body?.prompt ?? {})) {
        if (typeof node !== 'object' || node === null) continue
        const inp = node.inputs ?? {}
        for (const key of ['ckpt_name', 'unet_name', 'vae_name', 'clip_name', 'lora_name']) {
          const v = inp[key]
          if (typeof v !== 'string' || v === '') continue
          if (v !== HAS_CKPT) bad.push({ id, key, v })
        }
      }
      if (bad.length > 0) {
        const first = bad[0]
        return json({
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
          node_errors: {
            [String(first.id)]: {
              errors: [{ message: 'Value not in list: ' + first.key + ': ' + first.v }],
            },
          },
        })
      }
      return json({ prompt_id: 'job-1' })
    }
    if (u.includes('/system_stats')) return json({ system: { os: 'nt' } })
    if (u.includes('/history/')) {
      return json({
        'job-1': {
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

/* ── ① 结构：渠道挂了工作流，一路走到提交 ─────────────────────────────── */

console.log('① 渠道挂了 t2i 工作流 → 取默认模型 → 走 /generate 能出图（替身 ComfyUI）')
{
  const wf = sd15Workflow()
  await saveChannel({
    id: 'ch-live', name: '本地 comfyui', protocol: 'comfyui', baseUrl: COMFY_URL,
    models: [{ id: 'sd15', label: 'SD1.5', caps: ['image'] }],
    comfyuiT2iWorkflow: { name: 'SD1.5 文生图（本机）', json: wf },
  })
  await saveModelDefaults({ defaultImageModel: { channelId: 'ch-live', modelId: 'sd15' } })

  /* 读回来：存进去的东西真的落盘了。 */
  const chs = await readChannels()
  const ch = chs.find(c => c.id === 'ch-live')
  check('★★ 渠道里那份 t2i 工作流读得回来',
    ch?.comfyuiT2iWorkflow !== null && typeof ch?.comfyuiT2iWorkflow === 'object',
    JSON.stringify(ch === undefined ? '' : Object.keys(ch.comfyuiT2iWorkflow ?? {})))
  check('★★ baseUrl 是 ComfyUI 的地址', ch?.baseUrl === COMFY_URL, String(ch?.baseUrl))
  check('★★ 模型带 image 能力（pickChannel 靠它找渠道）',
    (ch?.models ?? []).some(m => (m.caps ?? []).includes('image')),
    JSON.stringify((ch?.models ?? []).map(m => m.caps)))

  /* 默认模型：`resolveGenerationTarget` 没指定模型时靠它。 */
  const dflt = await readModelDefaults()
  const ref = defaultOf(dflt, 'image')
  check('★★ 图片类默认模型指向这条渠道',
    ref?.channelId === 'ch-live' && ref?.modelId === 'sd15',
    JSON.stringify(ref ?? null))
  check('★ 状态里图片是「已设」', defaultStatus(dflt).image === true, JSON.stringify(defaultStatus(dflt)))

  /* 工作流本身在 t2i 这一类是合法的：槽位与输出标记都齐。 */
  check('★★ 这份工作流过得了 t2i 的结构校验', validateComfyWorkflow(wf, 't2i').ok === true,
    JSON.stringify(validateComfyWorkflow(wf, 't2i')))
  /* 槽位真的填得进去：不是只有标记、填的时候落空。 */
  const bound = applyBindings(wf, { prompt: '一只猫', negativePrompt: '低清', width: 640, height: 384, seed: 99 })
  check('★★ prompt 填进去了', bound['6'].inputs.text === '一只猫', String(bound['6'].inputs.text))
  check('★★ negative 填进去了', bound['7'].inputs.text === '低清', String(bound['7'].inputs.text))
  check('★★ width / height 填进去了',
    bound['8'].inputs.value === 640 && bound['9'].inputs.value === 384,
    bound['8'].inputs.value + 'x' + bound['9'].inputs.value)
  check('★★ seed 填进去了', bound['10'].inputs.value === 99, String(bound['10'].inputs.value))

  /* 走 /generate 这条路。 */
  const fake = fakeComfy()
  resetGenerateForTest()
  resetChannelQueueForTest()
  setGenerateDeps({ comfyHttp: { fetchImpl: fake.fetchImpl }, sleep: async () => { /* 不真睡 */ } })

  const r = await call('POST', '/api/ecom-workbench/generate', {
    kind: 'image', prompt: 'a quiet street at dusk', size: '512x512',
  })
  check('★★ POST /generate 回了任务 id（没指定模型、走默认）',
    r.code === 200 && typeof r.json?.id === 'string', String(r.code) + ' / ' + String(r.json?.id))

  const t = await waitTask(r.json?.id ?? '', 5000)
  check('★★ 走 /generate 能出图（任务成功）', t?.status === 'success',
    String(t?.status) + ' / ' + String(t?.error ?? ''))
  check('★★ 用的是默认模型', t?.model === 'sd15' && t?.channelId === 'ch-live',
    String(t?.channelId) + ' / ' + String(t?.model))
  check('★★ 有产物落进产物库', (t?.artifacts?.length ?? 0) === 1,
    JSON.stringify((t?.artifacts ?? []).map(a => a.bytes)))

  /* 提交给 ComfyUI 的那份工作流里，槽位是填好的，不是原样照发。 */
  const sent = fake.submitted[0]?.prompt ?? {}
  check('★★ 提交给 ComfyUI 的 prompt 是请求里那句',
    sent['6']?.inputs?.text === 'a quiet street at dusk', String(sent['6']?.inputs?.text))
  check('★★ 提交给 ComfyUI 的尺寸是请求里的 512x512',
    sent['8']?.inputs?.value === 512 && sent['9']?.inputs?.value === 512,
    sent['8']?.inputs?.value + 'x' + sent['9']?.inputs?.value)

  /* 自证要盯的这一件：渠道没挂工作流时会怎样。 */
  const bare = { id: 'ch-bare', name: '裸渠道', protocol: 'comfyui', baseUrl: COMFY_URL, models: [] }
  check('★★ 裸渠道上 pickWorkflow(t2i) 拿到的是内置那份，不是 null',
    pickWorkflow(bare, 't2i') !== null, String(pickWorkflow(bare, 't2i') === null))
}

/* ── ② 真 ComfyUI（没开就跳过，不算通过） ──────────────────────────── */

console.log('② 真 ComfyUI：能用现有 SD1.5 checkpoint 出图')
{
  let alive = false
  let stats = null
  try {
    const res = await fetch(COMFY_URL + '/system_stats', { signal: AbortSignal.timeout(2000) })
    if (res.ok) { alive = true; stats = await res.json() }
  } catch { alive = false }

  if (!alive) {
    console.log('[SKIP] 本机 ' + COMFY_URL + ' 上没有 ComfyUI 在跑 —— 这一段没验')
  } else {
    check('★ 本机 ComfyUI 在线', alive === true,
      String(stats?.system?.comfyui_version) + ' / ' + String(stats?.devices?.[0]?.name))

    /* 工作流里那个 checkpoint 真的在这台机器上 —— 不在就是「配了但跑不了」。 */
    let ckpts = []
    try {
      const r2 = await fetch(COMFY_URL + '/object_info/CheckpointLoaderSimple', { signal: AbortSignal.timeout(5000) })
      const j2 = await r2.json()
      ckpts = j2?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
    } catch { ckpts = [] }
    const need = 'anything-v5-PrtRE.safetensors'
    check('★★ 工作流要的 checkpoint 在本机清单里', ckpts.includes(need),
      ckpts.includes(need) ? need : ('清单里没有 ' + need))

    /* 真跑一次：走的是本机 ComfyUI，不用替身。
     *
     * ⚠️ `setGenerateDeps(null)` 这一句是第一版漏掉、被自证抓出来的。
     * 第一版只调了 `resetGenerateForTest()` —— 那个只清任务表，不清 deps，
     * 于是 ① 段注入的替身在这一段还在生效：真 ComfyUI 那一整段打的是假 fetch，
     * 0.03 秒「出图」、产物 70 字节（那个 1×1 PNG）。
     * 一条本该验「真机能跑」的断言，验的是替身 —— 比没有这条更糟。 */
    setGenerateDeps(null)
    resetGenerateForTest()
    resetChannelQueueForTest()
    const wf = JSON.parse(await readFile(
      new URL('../scripts/comfyui/sd15-t2i.workflow.json', import.meta.url), 'utf8'))
    await saveChannel({
      id: 'ch-real', name: '本地 comfyui（真）', protocol: 'comfyui', baseUrl: COMFY_URL,
      models: [{ id: 'sd15-real', label: 'SD1.5', caps: ['image'] }],
      comfyuiT2iWorkflow: { name: 'SD1.5 文生图（本机）', json: wf },
    })
    await saveModelDefaults({ defaultImageModel: { channelId: 'ch-real', modelId: 'sd15-real' } })

    const startedAt = Date.now()
    const r = await call('POST', '/api/ecom-workbench/generate', {
      kind: 'image', prompt: 'a quiet street at dusk, soft light', size: '512x512', channelId: 'ch-real',
    })
    const t = await waitTask(r.json?.id ?? '', 180000)
    const usedMs = Date.now() - startedAt
    check('★★ 真 ComfyUI 出图成功', t?.status === 'success',
      String(t?.status) + ' / ' + String(t?.error ?? '') + ' / ' + (usedMs / 1000).toFixed(2) + 's')
    check('★★ 真出图有产物', (t?.artifacts?.length ?? 0) > 0,
      JSON.stringify((t?.artifacts ?? []).map(a => a.bytes + ' bytes')))
    check('★ 单次出图在 60 秒内（4060 上 20 步 512 方图）', usedMs < 60000, String(usedMs) + ' ms')
  }
}

console.log(bad === 0 ? '\n全部通过 ✓' : '\n' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
