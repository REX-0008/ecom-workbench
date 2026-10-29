/** 网络模型两种协议（契约 CB，2026-10-26）。
 *
 * # ⚠️ 这份测试**不连外网**
 *
 * 全走注入的假 `fetchImpl`。所以它验的是「我们发出的请求对不对、拿回的响应解对没有」，
 * **不验**「真打一次 OpenAI / Gemini 能出图」—— 那要等用户配了真 key。
 *
 * 跑法：node --import <tsx> tests/net-gen.mjs
 */
const { generateOnChannel, assertCapability, GenError, itemFromB64OrUrl, readUpstreamError } =
  await import('../src/schedule/net-gen.ts')
const { geminiBody } = await import('../src/schedule/gemini-gen.ts')
const { VIDEO_POLL_MS, VIDEO_POLL_TIMEOUT_MS } = await import('../src/schedule/openai-gen.ts')

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
 * 造一个假 fetch：按调用顺序回响应，并记下每次请求。
 * @param {Array} script - 每次调用的返回：`{status?, body?, raw?, headers?}`
 * @returns {{fetch: Function, calls: object[]}} 假 fetch 与记录。
 */
function fakeFetch(script) {
  const calls = []
  let i = 0
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method ?? 'GET').toUpperCase(), body: init.body, headers: init.headers ?? {} })
    const one = script[Math.min(i, script.length - 1)]
    i += 1
    const status = one?.status ?? 200
    const headers = { 'content-type': 'application/json', ...one?.headers ?? {} }
    return new Response(one?.raw !== undefined ? one.raw : JSON.stringify(one?.body ?? {}), { status, headers })
  }
  return { fetch: impl, calls }
}

/** 1×1 PNG。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG_B64 = PNG.toString('base64')

/** 一个 OpenAI 渠道（带三个模型：能出图的、能出视频的、只能出文字的）。 */
function openAiChannel() {
  return {
    id: 'ch_oa', name: 'OpenAI 兼容', protocol: 'openai', baseUrl: 'https://api.example.com/',
    maxConcurrency: 5,
    models: [
      { id: 'gpt-image-1', label: '出图', caps: ['image'] },
      { id: 'sora-1', label: '出视频', caps: ['video'] },
      { id: 'gpt-4o', label: '文字', caps: ['text'] },
    ],
  }
}

/* ── ① OpenAI 图像生成 ────────────────────────────────────────────── */
console.log('① OpenAI 图像生成：b64_json 解对')
{
  const f = fakeFetch([{ body: { data: [{ b64_json: PNG_B64 }] } }])
  const r = await generateOnChannel(openAiChannel(), 'sk-x', {
    kind: 'image', prompt: '一只白猫', model: 'gpt-image-1', size: '1024x1024', count: 1,
  }, f.fetch)
  check('★★ 请求 URL 是 {base}/v1/images/generations（base 尾斜杠已去掉）',
    f.calls[0].url === 'https://api.example.com/v1/images/generations', f.calls[0].url)
  check('★★ 请求体是 JSON 且带 model / prompt / response_format=b64_json',
    String(f.calls[0].headers['Content-Type']).includes('application/json')
    && (() => { const b = JSON.parse(String(f.calls[0].body)); return b.model === 'gpt-image-1' && b.prompt === '一只白猫' && b.response_format === 'b64_json' })(),
    String(f.calls[0].body).slice(0, 120))
  check('★★ 鉴权走 Bearer', String(f.calls[0].headers.Authorization) === 'Bearer sk-x',
    String(f.calls[0].headers.Authorization))
  check('★★ 返回的字节解对了（与原 PNG 逐字节相同）',
    r.items.length === 1 && r.items[0].bytes.equals(PNG), String(r.items[0]?.bytes?.length))
  check('★★ mime 是 image/png', r.items[0]?.mime === 'image/png', String(r.items[0]?.mime))
  check('★ 用量记了张数（只记张数，不记钱）', r.usage?.images === 1, JSON.stringify(r.usage))
}

/* ── ② OpenAI 图像编辑：必须是 multipart ────────────────────────── */
console.log('')
console.log('② OpenAI 图像编辑：multipart + 参考图进 body')
{
  const f = fakeFetch([{ body: { data: [{ b64_json: PNG_B64 }] } }])
  const r = await generateOnChannel(openAiChannel(), 'sk-x', {
    kind: 'image', prompt: '改成油画', model: 'gpt-image-1', count: 1,
    refs: [{ mime: 'image/png', bytes: PNG }],
  }, f.fetch)
  check('★★ 请求 URL 是 {base}/v1/images/edits', f.calls[0].url === 'https://api.example.com/v1/images/edits', f.calls[0].url)
  check('★★ 请求体是 FormData（multipart），不是 JSON',
    f.calls[0].body instanceof FormData, String(f.calls[0].body?.constructor?.name))
  /* ⚠️ 关键：`content-type` 不许自己设。设了就会缺 boundary，上游解析不了。
   * 这一条是最容易写错的地方（参考项目的模板里专门写了一句注释提醒）。 */
  check('★★ 没有自己设 content-type（设了就没 boundary，上游会解析失败）',
    f.calls[0].headers['Content-Type'] === undefined && f.calls[0].headers['content-type'] === undefined,
    JSON.stringify(Object.keys(f.calls[0].headers)))
  const form = f.calls[0].body
  check('★★ 参考图进了 body（同名 image 字段）',
    form.getAll('image').length === 1, String(form.getAll('image').length))
  check('★★ 模型与提示词也在 body 里',
    form.get('model') === 'gpt-image-1' && form.get('prompt') === '改成油画',
    JSON.stringify({ m: form.get('model'), p: form.get('prompt') }))
  check('★ 结果解对了', r.items[0]?.bytes.equals(PNG), String(r.items[0]?.bytes?.length))
}

/* ── ③ OpenAI 视频：三态 ────────────────────────────────────────── */
console.log('')
console.log('③ OpenAI 视频：pending 继续等、completed 拿字节、failed 报错')
{
  /* 提交 → pending → pending → 有网址（完成）。 */
  const f = fakeFetch([
    { body: { id: 'task-1' } },
    { body: { status: 'pending' } },
    { body: { status: 'processing' } },
    { body: { status: 'completed', video_url: 'https://cdn.example.com/v.mp4' } },
    { raw: Buffer.from([0, 0, 0, 1]), headers: { 'content-type': 'video/mp4' } },
  ])
  const waited = []
  const r = await generateOnChannel(openAiChannel(), 'sk-x', {
    kind: 'video', prompt: '一只猫在跑', model: 'sora-1', seconds: 5,
    sleep: async (ms) => { waited.push(ms) },
  }, f.fetch)
  check('★★ 提交 URL 是 {base}/videos', f.calls[0].url === 'https://api.example.com/videos', f.calls[0].url)
  check('★★ 提交体是 multipart（含 model / prompt / seconds）',
    f.calls[0].body instanceof FormData
    && f.calls[0].body.get('model') === 'sora-1'
    && f.calls[0].body.get('seconds') === '5',
    String(f.calls[0].body?.constructor?.name))
  check('★★ pending 时会继续轮询（问了 4 次状态，不是问一次就放弃）',
    f.calls.filter(c => c.url.includes('/videos/task-1') && c.method === 'GET').length === 3,
    String(f.calls.filter(c => c.url.includes('/videos/task-1')).length))
  check('★★ 轮询间隔是 2.5 秒（照参考项目）',
    waited.length > 0 && waited.every(ms => ms === VIDEO_POLL_MS), waited.join(','))
  check('★★ 有 video_url 时去取字节并拿到 video/mp4',
    r.items[0]?.bytes.length === 4 && r.items[0]?.mime === 'video/mp4',
    JSON.stringify({ n: r.items[0]?.bytes?.length, m: r.items[0]?.mime }))
  check('★ 用量记秒数', r.usage?.seconds === 5, JSON.stringify(r.usage))

  /* 完成但没有网址 → 走 /content。 */
  const f2 = fakeFetch([
    { body: { id: 'task-2' } },
    { body: { status: 'completed' } },
    { raw: Buffer.from([0, 0, 0, 2]), headers: { 'content-type': 'video/mp4' } },
  ])
  const r2 = await generateOnChannel(openAiChannel(), 'sk-x', {
    kind: 'video', prompt: 'p', model: 'sora-1', sleep: async () => {},
  }, f2.fetch)
  check('★★ completed 但没给网址 → 走 /videos/{id}/content 取字节',
    f2.calls.some(c => c.url.endsWith('/content')) && r2.items[0]?.bytes.length === 4,
    f2.calls.map(c => c.url.replace('https://api.example.com', '')).join(' → '))

  /* 失败：必须带上游 error 原文。 */
  const f3 = fakeFetch([
    { body: { id: 'task-3' } },
    { body: { status: 'failed', error: { message: '内容审核未通过' } } },
  ])
  let err = ''
  try {
    await generateOnChannel(openAiChannel(), 'sk-x', {
      kind: 'video', prompt: 'p', model: 'sora-1', sleep: async () => {},
    }, f3.fetch)
  } catch (e) { err = e.message }
  check('★★ failed → 抛错且带出上游 error 原文（不是「生成失败」四个字）',
    err.includes('内容审核未通过'), err)

  /* 超时：一直 pending → 到点停下。 */
  const f4 = fakeFetch([{ body: { id: 'task-4' } }, { body: { status: 'pending' } }])
  let err2 = ''
  const t0 = Date.now()
  try {
    await generateOnChannel(openAiChannel(), 'sk-x', {
      kind: 'video', prompt: 'p', model: 'sora-1',
      /* 不真睡，但每次醒来都往后推一下时钟做不到 —— 所以这里靠「注入的 sleep
       * 里改全局时钟」不现实。改用真实等待：超时是 5 分钟，跑不动。
       * 所以这条改用「轮询里 signal 取消」来验「会停」这条路。 */
      signal: (() => { const ac = new AbortController(); setTimeout(() => ac.abort(), 20); return ac.signal })(),
      sleep: async (ms) => { await new Promise(r => setTimeout(r, ms)) },
    }, f4.fetch)
  } catch (e) { err2 = e.message }
  check('★★ 取消时立刻停（不会一直转）', err2.includes('取消'), err2 + ' / ' + String(Date.now() - t0) + 'ms')
  check('★ 视频轮询超时上限是 5 分钟量级', VIDEO_POLL_TIMEOUT_MS === 300_000, String(VIDEO_POLL_TIMEOUT_MS))
}

/* ── ④ Gemini ─────────────────────────────────────────────────────── */
console.log('')
console.log('④ Gemini：URL / header / parts 都对')
{
  const ch = {
    id: 'ch_gm', name: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.example.com',
    maxConcurrency: 5,
    models: [{ id: 'gemini-2.5-flash-image', label: '出图', caps: ['image', 'text'] }],
  }
  const f = fakeFetch([{
    body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }] },
  }])
  const r = await generateOnChannel(ch, 'goog-key', {
    kind: 'image', prompt: '一只白猫', model: 'gemini-2.5-flash-image',
    refs: [{ mime: 'image/jpeg', bytes: PNG }],
  }, f.fetch)

  check('★★ URL 是 {base}/v1beta/models/{model}:generateContent',
    f.calls[0].url === 'https://generativelanguage.example.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    f.calls[0].url)
  check('★★ 鉴权走 x-goog-api-key（不是 Bearer）',
    f.calls[0].headers['x-goog-api-key'] === 'goog-key'
    && f.calls[0].headers.Authorization === undefined,
    JSON.stringify({ g: f.calls[0].headers['x-goog-api-key'], a: f.calls[0].headers.Authorization }))
  const body = JSON.parse(String(f.calls[0].body))
  check('★★ body 的 parts 里文本与 inline_data 都在',
    body.contents?.[0]?.parts?.[0]?.text === '一只白猫'
    && body.contents[0].parts[1]?.inline_data?.mime_type === 'image/jpeg'
    && body.contents[0].parts[1]?.inline_data?.data === PNG_B64,
    JSON.stringify(body.contents?.[0]?.parts?.map(p => Object.keys(p))))
  check('★★ 要图时带 responseModalities: ["IMAGE"]',
    JSON.stringify(body.generationConfig) === JSON.stringify({ responseModalities: ['IMAGE'] }),
    JSON.stringify(body.generationConfig))
  check('★★ 返回的图解对了', r.items[0]?.bytes.equals(PNG) && r.items[0]?.mime === 'image/png',
    String(r.items[0]?.bytes?.length))

  /* 纯文字：不给 responseModalities，把 text 当一份产出。 */
  const f2 = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: '这是回答' }] } }] } }])
  const r2 = await generateOnChannel(ch, 'k', { kind: 'text', prompt: '问一句', model: 'gemini-2.5-flash-image' }, f2.fetch)
  const body2 = JSON.parse(String(f2.calls[0].body))
  check('★★ 要文字时不带 responseModalities', body2.generationConfig === undefined,
    JSON.stringify(body2.generationConfig))
  check('★★ 文字当成一份产出（mime text/plain）',
    r2.items.length === 1 && r2.items[0].mime.startsWith('text/plain')
    && r2.items[0].bytes.toString('utf8') === '这是回答',
    r2.items[0]?.bytes?.toString('utf8'))

  /* inline_data 的蛇形拼法也要认。 */
  const f3 = fakeFetch([{ body: { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/webp', data: PNG_B64 } }] } }] } }])
  const r3 = await generateOnChannel(ch, 'k', { kind: 'image', prompt: 'p', model: 'gemini-2.5-flash-image' }, f3.fetch)
  check('★★ inline_data（蛇形）也认（不同版本回的键名不同）',
    r3.items[0]?.mime === 'image/webp', String(r3.items[0]?.mime))

  /* 要图却只回了文字 → 明确报错，不给一张空图。 */
  const f4 = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: '抱歉我做不到' }] } }] } }])
  let err = ''
  try { await generateOnChannel(ch, 'k', { kind: 'image', prompt: 'p', model: 'gemini-2.5-flash-image' }, f4.fetch) } catch (e) { err = e.message }
  check('★★ 要图却只回文字 → 明确报错（不交一张空图）',
    err.includes('没给图'), err)

  /* geminiBody 纯函数：没有参考图时 parts 只有一条。 */
  check('★ geminiBody 无参考图时 parts 只有文本一条',
    geminiBody({ kind: 'image', prompt: 'p', model: 'm' }, true).contents[0].parts.length === 1, '')
}

/**
 * 跑一次调用，把抛出来的错误接住（**必须 async**）。
 *
 * ⚠️ 这里踩过一次：第一版写成同步的 `try { generateOnChannel(...) } catch` ——
 * `generateOnChannel` 是 async、返回 Promise，同步 try/catch **抓不到** rejection，
 * 于是 `e.kind` 永远是 undefined，那两条断言假红。
 *
 * @param {Function} fn - 返回 Promise 的调用。
 * @returns {Promise<Error|null>} 抛出来的错误，没抛给 null。
 */
async function caught(fn) {
  try { await fn(); return null } catch (e) { return e }
}

/* ── ⑤ 能力不匹配：说清哪个模型缺什么 ─────────────────────────── */
console.log('')
console.log('⑤ 能力不匹配')
{
  let err = ''
  try {
    await generateOnChannel(openAiChannel(), 'k', { kind: 'image', prompt: 'p', model: 'gpt-4o' }, fakeFetch([{}]).fetch)
  } catch (e) { err = e.message }
  check('★★ 模型没有 image 能力 → 报错里指出**是哪个模型**', err.includes('gpt-4o'), err)
  check('★★ 也指出**缺什么能力**', err.includes('没有「image」能力'), err)
  check('★★ 还列出这个渠道里谁能做（用户看一眼就能换模型）',
    err.includes('gpt-image-1'), err)
  check('★ 这是 capability 类错误（上层能据此判断该换模型）',
    (await caught(() => generateOnChannel(openAiChannel(), 'k', { kind: 'image', prompt: 'p', model: 'gpt-4o' }, fakeFetch([{}]).fetch)))?.kind === 'capability',
    '')

  let err2 = ''
  try {
    await generateOnChannel(openAiChannel(), 'k', { kind: 'image', prompt: 'p', model: '不存在的模型' }, fakeFetch([{}]).fetch)
  } catch (e) { err2 = e.message }
  check('★★ 渠道里没登记的模型 → 报错且列出已登记的模型',
    err2.includes('不存在的模型') && err2.includes('gpt-image-1'), err2)
}

/* ── ⑥ comfyui 协议要明确拒绝 ─────────────────────────────────────── */
console.log('')
console.log('⑥ comfyui 协议不走这条路')
{
  const ch = {
    id: 'ch_c', name: '本地 ComfyUI', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8189',
    maxConcurrency: 2, models: [{ id: 'x', label: 'x', caps: ['image'] }],
  }
  let err = ''
  try {
    await generateOnChannel(ch, '', { kind: 'image', prompt: 'p', model: 'x' }, fakeFetch([{}]).fetch)
  } catch (e) { err = e.message }
  check('★★ 抛错', err !== '', '')
  check('★★ 错误里写明「应由 ComfyUI 那条路处理」', err.includes('应由 ComfyUI 那条路处理'), err)
  check('★ 还指出那条路在哪（runComfyGeneration）', err.includes('runComfyGeneration'), err)
  check('★ 是 protocol 类错误',
    (await caught(() => generateOnChannel(ch, '', { kind: 'image', prompt: 'p', model: 'x' }, fakeFetch([{}]).fetch)))?.kind === 'protocol',
    '')
}

/* ── ⑦ 不支持的能力组合 ───────────────────────────────────────────── */
console.log('')
console.log('⑦ 不支持的能力组合明确说清')
{
  let err = ''
  const ch = { ...openAiChannel(), models: [{ id: 'a', label: 'a', caps: ['audio'] }] }
  try {
    await generateOnChannel(ch, 'k', { kind: 'audio', prompt: 'p', model: 'a' }, fakeFetch([{}]).fetch)
  } catch (e) { err = e.message }
  check('★★ OpenAI 协议下 audio → 明确说「这一版只做了三件」且说清是哪三件',
    err.includes('图像生成') && err.includes('视频'), err)
  check('★ 是 unsupported 类错误',
    (await caught(() => generateOnChannel(ch, 'k', { kind: 'audio', prompt: 'p', model: 'a' }, fakeFetch([{}]).fetch)))?.kind === 'unsupported',
    '')

  const gm = { id: 'g', name: 'g', protocol: 'gemini', baseUrl: 'https://g', maxConcurrency: 1, models: [{ id: 'gm', label: 'gm', caps: ['video'] }] }
  let err2 = ''
  try {
    await generateOnChannel(gm, 'k', { kind: 'video', prompt: 'p', model: 'gm' }, fakeFetch([{}]).fetch)
  } catch (e) { err2 = e.message }
  check('★★ Gemini 下 video → 明确说它不支持视频', err2.includes('不支持'), err2)
}

/* ── ⑧ 上游错误原文要带出来 ─────────────────────────────────────── */
console.log('')
console.log('⑧ 上游错误原文')
{
  const f = fakeFetch([{ status: 400, body: { error: { message: 'model does not support image input' } } }])
  let err = ''
  try { await generateOnChannel(openAiChannel(), 'k', { kind: 'image', prompt: 'p', model: 'gpt-image-1' }, f.fetch) } catch (e) { err = e.message }
  check('★★ 上游 400 的原文带出来了（不是只有状态码）',
    err.includes('400') && err.includes('model does not support image input'), err)

  /* 三种错误体形状都认。 */
  const shapes = [
    [{ error: '纯字符串' }, '纯字符串'],
    [{ error: { message: '对象里的 message' } }, '对象里的 message'],
    [{ message: '顶层 message' }, '顶层 message'],
  ]
  let allOk = true
  const got = []
  for (const [body, want] of shapes) {
    const res = new Response(JSON.stringify(body), { status: 400 })
    const text = await readUpstreamError(res)
    got.push(text)
    if (!text.includes(want)) allOk = false
  }
  check('★★ 三种上游错误体形状都读得出来', allOk, got.join(' | '))

  /* base64 与网址两条路都能拿字节。 */
  const direct = await itemFromB64OrUrl(PNG_B64, undefined)
  check('★ b64_json 直接解码', direct.bytes.equals(PNG), '')
  const withPrefix = await itemFromB64OrUrl('data:image/webp;base64,' + PNG_B64, undefined)
  check('★ 带 data: 前缀也能解（且 mime 从前缀取）',
    withPrefix.mime === 'image/webp' && withPrefix.bytes.equals(PNG), withPrefix.mime)
  const viaUrl = await itemFromB64OrUrl(undefined, 'https://cdn/x.png', async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }))
  check('★ 只有网址时去取回来', viaUrl.bytes.equals(PNG) && viaUrl.mime === 'image/png', '')
  let err3 = ''
  try { await itemFromB64OrUrl(undefined, undefined) } catch (e) { err3 = e.message }
  check('★ 两者都没给 → 明确报错', err3.includes('拿不到产出'), err3)
}

console.log('')
console.log(bad === 0
  ? '结论：OpenAI（图/编辑/视频三态）与 Gemini 全部通过 ✓（⚠️ 真打上游仍未验，无 key）'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
