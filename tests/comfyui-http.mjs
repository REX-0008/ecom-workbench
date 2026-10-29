/** ComfyUI 全链路（契约 CA，2026-10-26）。
 *
 * # ⚠️ 这份测试**不连真服务**
 *
 * 本机没有 ComfyUI 在跑（8188 / 8189 都不通）。所有请求都喂假 `fetchImpl`。
 * 所以它验的是「我们发出的请求对不对、拿回的响应解对没有」，
 * **不验**「真连一个 ComfyUI 能出图」。后者等 ComfyUI 起来补。
 *
 * 跑法：node --import <tsx> tests/comfyui-http.mjs
 */
import { readFile } from 'node:fs/promises'

const {
  submitPrompt, uploadImage, downloadView, getHistory, getQueue, deleteQueueItem,
  interrupt, getSystemStats, normalizeBaseUrl, guessMime, ComfyApiError,
} = await import('../src/schedule/comfyui-http.ts')
const {
  parseSize, adaptWorkflowModelPaths, detectHostOs, resetHostOsCacheForTest,
  cancelJob, isInQueue, outputsOfHistory, textsOfHistory, validateComfyWorkflow,
  applyBindings, pruneUnusedRefs, runComfyGeneration, stateFromQueue,
} = await import('../src/schedule/comfyui.ts')
const { defaultWorkflowOf } = await import('../src/schedule/comfyui-workflows/registry.ts')
const { resetChannelQueueForTest, runningOf } = await import('../src/schedule/channel-queue.ts')

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
 * 造一个假 fetch：按「方法 + 路径」查表回响应，并把每次请求记下来。
 *
 * @param {(url: string, init: object) => {status?: number, body?: any, raw?: Buffer, headers?: object} | null} route
 *   返回 `null` 表示这条请求没配（会记成一次 miss，断言能看出来）。
 * @returns {{fetch: Function, calls: object[]}} 假 fetch 与请求记录。
 */
function fakeFetch(route) {
  const calls = []
  const impl = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ url: String(url), method, body: init.body, headers: init.headers ?? {} })
    const hit = route(String(url), { ...init, method })
    if (hit === null || hit === undefined) {
      return new Response('no route', { status: 599 })
    }
    const status = hit.status ?? 200
    const headers = { 'content-type': 'application/json', ...hit.headers ?? {} }
    const body = hit.raw !== undefined ? hit.raw : JSON.stringify(hit.body ?? {})
    return new Response(body, { status, headers })
  }
  return { fetch: impl, calls }
}

/* 1×1 PNG（当素材与产出用）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

/* ── ① 七个 HTTP 调用 ─────────────────────────────────────────────── */
console.log('① 七个 HTTP 调用')
{
  /* ①-1 提交 */
  {
    const f = fakeFetch(() => ({ body: { prompt_id: 'p-123' } }))
    const id = await submitPrompt({ '1': { class_type: 'X', inputs: {} } }, { baseUrl: 'http://127.0.0.1:8189/', fetchImpl: f.fetch })
    check('★★ submitPrompt → POST {base}/prompt 且拿回 prompt_id',
      id === 'p-123' && f.calls[0].url === 'http://127.0.0.1:8189/prompt' && f.calls[0].method === 'POST',
      JSON.stringify({ url: f.calls[0]?.url, id }))
    const body = JSON.parse(String(f.calls[0].body))
    check('★ 请求体里有 prompt 与 client_id',
      typeof body.prompt === 'object' && typeof body.client_id === 'string',
      Object.keys(body).join(','))
  }

  /* ①-2 提交时 node_errors 会以 200 回来 —— 必须当失败 */
  {
    const f = fakeFetch(() => ({ status: 200, body: { node_errors: { '3': { error: 'missing input' } } } }))
    let err = ''
    try { await submitPrompt({ '1': {} }, { baseUrl: 'http://x', fetchImpl: f.fetch }) } catch (e) { err = e.message }
    check('★★ node_errors 以 200 回来时也当失败（不当成提交成功）',
      err.includes('校验报错') && err.includes('missing input'), err)
  }

  /* ①-3 上传 */
  {
    const f = fakeFetch(() => ({ body: { name: 'abc.png', subfolder: '' } }))
    const name = await uploadImage({ baseUrl: 'http://x', fetchImpl: f.fetch }, PNG, 'my cat.png', 'image/png')
    check('★★ uploadImage → POST {base}/upload/image，返回的是**服务端给的**文件名',
      name === 'abc.png' && f.calls[0].url === 'http://x/upload/image',
      JSON.stringify({ url: f.calls[0]?.url, name }))
    /* 本地文件名要清洗（空格变下划线、带随机前缀）：它会被 ComfyUI 落到自己的
     * `input/` 目录，名字里带路径分隔符就能写到别处去。 */
    const sentName = [...f.calls[0].body.getAll('image')].map(x => x.name)[0] ?? ''
    check('★★ 发给 ComfyUI 的文件名被清洗过（空格→下划线、带随机前缀）',
      /^[a-z0-9]+_my_cat\.png$/.test(sentName), sentName)
    check('★★ 上传体是 multipart（FormData，不是 JSON）',
      typeof f.calls[0].body?.append === 'function' && f.calls[0].body instanceof FormData,
      String(f.calls[0].body?.constructor?.name))
  }

  /* ①-4 取消一个排队中的：走 /queue 删除 */
  {
    let deleted = false
    let interrupted = false
    const r = await cancelJob('job-q', {
      fetchQueue: async () => ({ queue_pending: [['1', 'job-q']], queue_running: [] }),
      deleteItem: async () => { deleted = true },
      interrupt: async () => { interrupted = true },
    })
    check('★★ 排队中的任务 → 从队列删（不 interrupt）',
      r === 'dequeued' && deleted && !interrupted, JSON.stringify({ r, deleted, interrupted }))
  }

  /* ①-5 取消一个正在跑的：才 interrupt */
  {
    let deleted = false
    let interrupted = false
    const r = await cancelJob('job-r', {
      fetchQueue: async () => ({ queue_running: [['1', 'job-r']], queue_pending: [] }),
      deleteItem: async () => { deleted = true },
      interrupt: async () => { interrupted = true },
    })
    check('★★ 正在跑的任务 → interrupt（不从队列删）',
      r === 'interrupted' && interrupted && !deleted, JSON.stringify({ r, deleted, interrupted }))
  }

  /* ①-6 不在队列里：什么都不做（绝不全局 interrupt —— 那会打断别人的任务） */
  {
    let touched = ''
    const r = await cancelJob('job-x', {
      fetchQueue: async () => ({ queue_running: [['1', 'someone-else']], queue_pending: [] }),
      deleteItem: async () => { touched = 'delete' },
      interrupt: async () => { touched = 'interrupt' },
    })
    check('★★ 任务不在队列 → 什么都不做（不误伤别人）',
      r === 'not-found' && touched === '', JSON.stringify({ r, touched }))
  }

  /* ①-7 取历史 / 队列 / 系统信息 / 删队列项 / 中断 —— 端点与用法 */
  {
    const f = fakeFetch((url) => {
      if (url.endsWith('/history/j1')) return { body: { j1: { outputs: {} } } }
      if (url.endsWith('/queue')) return { body: { queue_running: [], queue_pending: [] } }
      if (url.endsWith('/system_stats')) return { body: { system: { os: 'nt' } } }
      return { body: {} }
    })
    const hist = await getHistory({ baseUrl: 'http://x', fetchImpl: f.fetch }, 'j1')
    check('★★ getHistory → GET {base}/history/{id}', hist !== null && f.calls.at(-1).url === 'http://x/history/j1', '')
    const q = await getQueue({ baseUrl: 'http://x', fetchImpl: f.fetch })
    check('★★ getQueue → GET {base}/queue', q !== null && f.calls.at(-1).url === 'http://x/queue', '')
    const sys = await getSystemStats({ baseUrl: 'http://x', fetchImpl: f.fetch })
    check('★★ getSystemStats → GET {base}/system_stats',
      sys !== null && f.calls.at(-1).url === 'http://x/system_stats', '')
    await deleteQueueItem({ baseUrl: 'http://x', fetchImpl: f.fetch }, 'j1')
    check('★★ deleteQueueItem → POST {base}/queue 且体里有 delete 数组',
      f.calls.at(-1).url === 'http://x/queue' && f.calls.at(-1).method === 'POST'
      && String(f.calls.at(-1).body).includes('j1'), String(f.calls.at(-1).body))
    await interrupt({ baseUrl: 'http://x', fetchImpl: f.fetch })
    check('★★ interrupt → POST {base}/interrupt', f.calls.at(-1).url === 'http://x/interrupt', '')
  }

  /* ①-8 取文件字节：/view 拿不到会自动试 /api/view */
  {
    const f = fakeFetch((url) => {
      if (url.includes('/api/view?')) return { raw: PNG, headers: { 'content-type': 'image/png' } }
      if (url.includes('/view?')) return { status: 404, body: {} }
      return null
    })
    const got = await downloadView({ baseUrl: 'http://x', fetchImpl: f.fetch }, 'out.png', 'output', '')
    check('★★ downloadView 先试 /view、404 再试 /api/view（两个路径都认）',
      got.bytes.equals(PNG) && got.mime === 'image/png'
      && f.calls.length === 2 && f.calls[1].url.includes('/api/view?'),
      JSON.stringify({ n: f.calls.length, mime: got.mime }))
    check('★ 请求 URL 里带了 filename / type / subfolder 三个参数',
      f.calls[0].url.includes('filename=out.png') && f.calls[0].url.includes('type=output')
      && f.calls[0].url.includes('subfolder='), f.calls[0].url)
  }

  /* ①-9 连不上时错误说清是「连不上」，不是笼统的「失败」 */
  {
    let err = ''
    try {
      await submitPrompt({ '1': {} }, {
        baseUrl: 'http://127.0.0.1:1',
        fetchImpl: async () => { throw new Error('ECONNREFUSED') },
      })
    } catch (e) { err = e.message }
    check('★★ 连不上时错误里写明「连不上 ComfyUI」并带原因',
      err.includes('连不上 ComfyUI') && err.includes('ECONNREFUSED'), err)
  }
}

/* ── ② 尺寸解析 ───────────────────────────────────────────────────── */
console.log('')
console.log('② 尺寸解析（1024x1024 / 16:9 / 2k 都认）')
{
  check('★★ 1024x1024 → 原样', JSON.stringify(parseSize('1024x1024')) === JSON.stringify({ width: 1024, height: 1024 }), '')
  /* 比例 → 短边 1024、长边按比例算。`16:9` → 1820×1024（16/9×1024=1820.4，取偶 1820）。
   * ⚠️ 我第一版断言写成「宽 1024 高 576」，那是我记错了方向：
   * 参考项目的规则是**短边**固定 1024（`SIZE_BASE`），不是「宽固定 1024」。 */
  check('★★ 16:9 → 高（短边）1024、宽 1820', JSON.stringify(parseSize('16:9')) === JSON.stringify({ width: 1820, height: 1024 }),
    JSON.stringify(parseSize('16:9')))
  check('★ 9:16 → 宽 1024、高 1820（竖屏反过来）',
    JSON.stringify(parseSize('9:16')) === JSON.stringify({ width: 1024, height: 1820 }),
    JSON.stringify(parseSize('9:16')))
  check('★★ 9:16-2k → 长边 2048', JSON.stringify(parseSize('9:16-2k')) === JSON.stringify({ width: 1152, height: 2048 }),
    JSON.stringify(parseSize('9:16-2k')))
  check('★ 空串 / auto → 1024×1024', JSON.stringify(parseSize('')) === JSON.stringify({ width: 1024, height: 1024 })
    && JSON.stringify(parseSize('auto')) === JSON.stringify({ width: 1024, height: 1024 }), '')
  check('★ 奇数取偶（1001x1003 → 1002x1004）',
    JSON.stringify(parseSize('1001x1003')) === JSON.stringify({ width: 1002, height: 1004 }),
    JSON.stringify(parseSize('1001x1003')))
  let err = ''
  try { parseSize('随便写') } catch (e) { err = e.message }
  check('★★ 认不出来时抛错（不静默给默认值）', err.includes('尺寸不合法'), err)
}

/* ── ③ 路径适配与系统探测 ─────────────────────────────────────────── */
console.log('')
console.log('③ 模型路径按目标系统转换')
{
  const wf = { '1': { class_type: 'X', inputs: { model: 'segm/model.onnx', note: '这不是路径' } } }
  const win = adaptWorkflowModelPaths(wf, 'windows')
  const lin = adaptWorkflowModelPaths(wf, 'linux')
  check('★★ windows → 反斜杠', win['1'].inputs.model === 'segm\\model.onnx', win['1'].inputs.model)
  check('★★ linux → 正斜杠', lin['1'].inputs.model === 'segm/model.onnx', lin['1'].inputs.model)
  check('★★ 不是 bbox/segm 路径的字符串不动（提示词之类）',
    win['1'].inputs.note === '这不是路径', win['1'].inputs.note)
  check('★★ 原工作流没被改（需要转换时给的是深拷贝）',
    wf['1'].inputs.model === 'segm/model.onnx', wf['1'].inputs.model)

  resetHostOsCacheForTest()
  const os1 = await detectHostOs('http://host-a', async () => ({ system: { os: 'nt' } }))
  check('★★ system_stats 报 os=nt → windows', os1 === 'windows', os1)
  resetHostOsCacheForTest()
  const os2 = await detectHostOs('http://host-b', async () => { throw new Error('连不上') })
  check('★★ 探不到就当 linux（照参考项目）', os2 === 'linux', os2)
  /* 缓存：第二次不再调 probe。 */
  resetHostOsCacheForTest()
  let probes = 0
  await detectHostOs('http://host-c', async () => { probes += 1; return { system: { os: 'nt' } } })
  await detectHostOs('http://host-c', async () => { probes += 1; return { system: { os: 'nt' } } })
  check('★ 同一个地址只探一次（结果缓存）', probes === 1, String(probes))
  resetHostOsCacheForTest()
}

/* ── ④ 取产出：从 /history 的形状里挑文件 ────────────────────────── */
console.log('')
console.log('④ 从 history 里取出产出文件')
{
  const history = {
    'j-1': {
      outputs: {
        '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
        '10': { gifs: [{ filename: 'b.mp4', subfolder: 'sub', type: 'output' }] },
        '11': { audio: [{ filename: 'c.mp3', subfolder: '', type: 'output' }] },
        '12': { text: ['这是文本，不是文件'] },
      },
    },
  }
  const files = outputsOfHistory(history, 'j-1')
  /* ⚠️ 这一段**只验文件**。文本产出由 `textsOfHistory` 单独负责，见本段后面那几条 ——
   * 别把「断言只问前 3 个」读成「文本是被有意丢掉的」：2026-10-26 之前恰恰因为
   * 没人补那几条，反推提示词（text 工作流）跑完被判「没有产出」而失败。 */
  check('★★ 图片、视频、音频都取出来了（3 个文件）', files.length === 3, String(files.length))
  check('★★ mp4 认成 video/mp4（按扩展名判，不按它在哪个键下）',
    files.find(f => f.filename === 'b.mp4')?.mime === 'video/mp4',
    files.map(f => f.filename + ':' + f.mime).join(','))
  check('★ 子目录带出来了', files.find(f => f.filename === 'b.mp4')?.subfolder === 'sub', '')
  check('★ 文本那条没被混进文件清单（`text` 不是文件，没有 filename）',
    !files.some(f => String(f.filename).includes('文本')), '')
  check('★ 没有这个 job 时给空数组', outputsOfHistory({}, 'never').length === 0, '')

  /* ── 文本产出：另一条路（2026-10-26 补）──────────────────────────── */
  const texts = textsOfHistory(history, 'j-1')
  check('★★ 文本产出被单独取出来了（不是混进文件清单）', texts.length === 1,
    JSON.stringify(texts))
  check('★★ 取的就是那段文字原文', texts[0] === '这是文本，不是文件', texts[0])

  /* 对象形状的 `text` 不许混进字符串数组 —— 交 `[object Object]` 比「没有结果」更难查。 */
  const objText = { 'j-2': { outputs: { '20': { text: [{ foo: 1 }] } } } }
  check('★★ 对象形状的 text 不进字符串数组（挡住 [object Object]）',
    textsOfHistory(objText, 'j-2').length === 0, JSON.stringify(textsOfHistory(objText, 'j-2')))

  /* `string` 键也认（有的文本节点用这个名字），直接是字符串时也能取。 */
  const strKey = { 'j-3': { outputs: { '21': { string: '另一段字' } } } }
  check('★ string 键的直接字符串也取得到',
    textsOfHistory(strKey, 'j-3').join(',') === '另一段字',
    JSON.stringify(textsOfHistory(strKey, 'j-3')))

  /* 没有文本时是**空数组**，不是 undefined。 */
  const noText = textsOfHistory({ 'j-4': { outputs: { '9': { images: [{ filename: 'a.png' }] } } } }, 'j-4')
  check('★★ 没有文本时给空数组（不是 undefined）', Array.isArray(noText) && noText.length === 0,
    JSON.stringify(noText))
  check('★★ 整份 history 是垃圾也给空数组',
    Array.isArray(textsOfHistory(null, 'x')) && textsOfHistory(null, 'x').length === 0,
    JSON.stringify(textsOfHistory(null, 'x')))
  check('★ 空字符串与纯空白不算一条文本',
    textsOfHistory({ 'j-5': { outputs: { '22': { text: ['', '   '] } } } }, 'j-5').length === 0, '')
}

/* ── ⑤ 整链路：假 ComfyUI 走一遍 ──────────────────────────────────── */
console.log('')
console.log('⑤ 整链路（假 ComfyUI：上传 → 提交 → 轮询 → 取字节）')
{
  resetChannelQueueForTest()
  const wf = defaultWorkflowOf('t2i').json
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/upload/image')) return { body: { name: 'up.png', subfolder: '' } }
    if (url.endsWith('/system_stats')) return { body: { system: { os: 'nt' } } }
    if (url.endsWith('/prompt')) return { body: { prompt_id: 'job-e2e' } }
    if (url.includes('/history/job-e2e')) {
      return { body: { 'job-e2e': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } } }
    }
    if (url.includes('/view?')) return { raw: PNG, headers: { 'content-type': 'image/png' } }
    if (url.endsWith('/queue')) return { body: { queue_running: [], queue_pending: [] } }
    return null
  })

  /* ⚠️ 整链路那几段必须包 try/catch：`runComfyGeneration` 在源码改坏时会**抛错**，
   * 不包的话整个测试文件崩掉 —— 那看着像「环境问题」，实际是红的
   * （`docs/机制-测试分两路.md` 记着这条：断言要优雅失败，不该抛异常出去）。
   * 第一版就是这么写的，自证时发现「拼错 URL → 进程崩」而不是「一条断言变红」。 */
  let out = null
  let chainErr = ''
  try {
    out = await runComfyGeneration({
      channel: {
        id: 'ch_comfy', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8189',
        models: [], maxConcurrency: 2,
      },
      category: 't2i',
      workflow: wf,
      bindings: { prompt: '一只白猫', width: 1024, height: 1024, seed: 42 },
      /* 给一张参考图：这样「上传」那一步也会真的被走到（不上传的话
       * 顺序断言里那一位就是 -1，等于那一环没验）。 */
      refImages: [{ name: 'ref.png', bytes: PNG, mime: 'image/png' }],
      http: { fetchImpl: f.fetch },
      sleep: async () => { /* 不真睡 */ },
    })
  } catch (e) { chainErr = e instanceof Error ? e.message : String(e) }

  check('★★ 整链路跑通（没抛错）', chainErr === '' && out !== null, chainErr)
  check('★★ 整链路拿到字节（一个 png）',
    out !== null && out.files.length === 1 && out.files[0].bytes.equals(PNG),
    String(out?.files?.length ?? 0))
  check('★★ 任务 id 带出来了', out?.jobId === 'job-e2e', String(out?.jobId))
  const urls = f.calls.map(c => c.url)
  const at = (suffix) => urls.findIndex(u => u.endsWith(suffix) || u.includes(suffix))
  /* ⚠️ 第一版只判「递增」，没判「都在」—— 那样拼错的 URL（`/prompts`）会让
   * `findIndex` 返回 -1，而 -1 比任何下标都小，顺序断言照样绿。
   * 所以必须先断言五个都能找到。 */
  const order = [at('/upload/image'), at('/system_stats'), at('/prompt'), at('/history/'), at('/view?')]
  check('★★ 五个关键请求都发出去了（一个都不能缺）',
    order.every(i => i >= 0), JSON.stringify({ order, urls }))
  check('★★ 请求顺序对：上传 → 系统探测 → 提交 → 查历史 → 取文件',
    order.every((v, i) => i === 0 || (order[i - 1] >= 0 && v >= 0 && order[i - 1] < v)),
    order.map((v, i) => ['upload', 'stats', 'prompt', 'history', 'view'][i] + '@' + String(v)).join(' '))
  check('★★ 跑完并发闸门已归还（runInChannel 真的套上了）',
    runningOf('ch_comfy') === 0, String(runningOf('ch_comfy')))
}

/* ── ⑥ 整链路的失败面 ─────────────────────────────────────────────── */
console.log('')
console.log('⑥ 整链路的三条失败面')
{
  /** 造一个只回「什么都不产出」的假 ComfyUI。 */
  const noOutput = () => fakeFetch((url) => {
    if (url.endsWith('/system_stats')) return { body: { system: { os: 'nt' } } }
    if (url.endsWith('/prompt')) return { body: { prompt_id: 'job-empty' } }
    if (url.includes('/history/')) return { body: { 'job-empty': { outputs: {} } } }
    if (url.endsWith('/queue')) return { body: { queue_running: [], queue_pending: [] } }
    return null
  })
  resetChannelQueueForTest()
  let err1 = ''
  try {
    await runComfyGeneration({
      channel: { id: 'c1', name: 'x', protocol: 'comfyui', baseUrl: 'http://x', models: [], maxConcurrency: 1 },
      category: 't2i', workflow: defaultWorkflowOf('t2i').json, bindings: { prompt: 'p' },
      http: { fetchImpl: noOutput().fetch }, sleep: async () => {},
    })
  } catch (e) { err1 = e.message }
  /* ⚠️ 这条错误的来源是 `pollJob` 的状态判定（`stateFromHistory`：
   * 「跑完了但 outputs 为空」判 failed），所以话术是「outputs 为空」。
   * 我第一版断言写「没有产出文件」，那是**后半段**（`outputsOfHistory`
   * 一个文件都没解析出来）的话术 —— 那条路只有「history 里有产出条目、
   * 但条目里没有可用字段」才走得到。两句话都对，只是这条走到的是前一句。 */
  check('★★ 跑完了但没产出 → 抛错（不当成成功交空结果）',
    err1.includes('没有产出') || err1.includes('outputs 为空'), err1)

  resetChannelQueueForTest()
  let err2 = ''
  try {
    await runComfyGeneration({
      channel: { id: 'c2', name: 'x', protocol: 'comfyui', baseUrl: 'http://x', models: [], maxConcurrency: 1 },
      category: 't2i', workflow: {}, bindings: { prompt: 'p' },
      http: { fetchImpl: async () => new Response('{}') }, sleep: async () => {},
    })
  } catch (e) { err2 = e.message }
  check('★★ 空工作流 → 明确报错（不提交一份空的一直等到超时）',
    err2.includes('工作流是空的'), err2)

  resetChannelQueueForTest()
  let err3 = ''
  try {
    await runComfyGeneration({
      channel: { id: 'c3', name: 'x', protocol: 'comfyui', baseUrl: 'http://x', models: [], maxConcurrency: 1 },
      category: 't2i', workflow: defaultWorkflowOf('t2i').json, bindings: { prompt: 'p' },
      http: {
        fetchImpl: fakeFetch((url) => (url.endsWith('/system_stats') ? { body: { system: { os: 'nt' } } } : null)).fetch,
      },
      sleep: async () => {},
    })
  } catch (e) { err3 = e.message }
  check('★★ 提交被拒（599）时抛错并带上状态码',
    err3.includes('599'), err3)
}

/* ── ⑦ 老行为不变：applyBindings / pruneUnusedRefs 仍由 comfyui.mjs 覆盖 ── */
console.log('')
console.log('⑦ 老的两个纯函数仍可用（详细断言在 comfyui.mjs）')
{
  const wf = { '3': { class_type: 'CLIPTextEncode', inputs: { text: 'old' }, _meta: { title: 'prompt' } } }
  check('★ applyBindings 还能填', applyBindings(wf, { prompt: 'new' })['3'].inputs.text === 'new', '')
  const withRef = {
    '10': { class_type: 'LoadImage', inputs: { image: 'a.png' }, _meta: { title: 'ref_image_01' } },
    '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0] } },
  }
  check('★ pruneUnusedRefs 还能裁', pruneUnusedRefs(withRef, 0)['10'] === undefined, '')
}

/* ── ⑧ 渠道：14 个新字段与老数据兼容（契约 CA 验收 5）─────────────── */
console.log('')
console.log('⑧ Channel 的 14 个新字段：新能存、老能读')
{
  const { normalizeChannel } = await import('../src/schedule/channels.ts')

  /* 老数据：只有这次改动之前的 6 个键，一个工作流字段都没有。 */
  const oldRaw = {
    id: 'ch_old', name: '老渠道', protocol: 'comfyui',
    baseUrl: 'http://127.0.0.1:8189', models: [], maxConcurrency: 5,
  }
  const n1 = normalizeChannel(oldRaw)
  check('★★ 老数据（无工作流字段）能归一，不报错',
    'error' in n1 === false && n1.channel.id === 'ch_old',
    'error' in n1 ? n1.error : String(n1.channel.id))
  const wfKeys = ['comfyuiT2iWorkflow', 'comfyuiI2iWorkflow', 'comfyuiVideoWorkflow',
    'comfyuiFrameVideoWorkflow', 'comfyuiAudioWorkflow', 'comfyuiFaceRefineWorkflow',
    'comfyuiDepthVideoWorkflow', 'comfyuiProxyUrl', 'comfyuiProxyToken']
  check('★★ 老数据归一后**不会凭空多出**那些键（是 undefined 不是 {}）',
    wfKeys.every(k => n1.channel[k] === undefined),
    wfKeys.filter(k => n1.channel[k] !== undefined).join(','))

  /* 新数据：给了工作流字段就保留。 */
  const withWf = normalizeChannel({
    ...oldRaw, id: 'ch_new',
    comfyuiT2iWorkflow: { name: 'Z-Image', json: { '1': {} }, createdAt: 0 },
    comfyuiProxyUrl: 'http://proxy.local',
  })
  check('★★ 给了工作流字段就原样保留',
    'error' in withWf === false
    && withWf.channel.comfyuiT2iWorkflow?.name === 'Z-Image'
    && withWf.channel.comfyuiProxyUrl === 'http://proxy.local',
    JSON.stringify('error' in withWf ? withWf.error : Object.keys(withWf.channel)))

  /* 更新时不带这些键 → 沿用旧值（界面上改个名字不该把工作流配置弄丢）。 */
  const updated = normalizeChannel(
    { id: 'ch_new', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8189', name: '改过名' },
    withWf.channel,
  )
  check('★★ 只改名 → 工作流字段沿用旧值（不被清掉）',
    'error' in updated === false && updated.channel.comfyuiT2iWorkflow?.name === 'Z-Image',
    JSON.stringify('error' in updated ? updated.error : updated.channel.comfyuiT2iWorkflow))

  /* 显式给 null → 清掉（回到内置默认）。 */
  const cleared = normalizeChannel(
    { id: 'ch_new', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8189', comfyuiT2iWorkflow: null },
    withWf.channel,
  )
  check('★★ 显式给 null → 清掉那个字段（回到内置默认）',
    'error' in cleared === false && cleared.channel.comfyuiT2iWorkflow === undefined,
    String(cleared.channel?.comfyuiT2iWorkflow))
}

console.log('')
console.log(bad === 0
  ? '结论：ComfyUI 七个 HTTP 调用 + 整链路（假响应）全部通过 ✓（⚠️ 真连服务仍未验）'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
