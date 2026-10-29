/** OpenAI 兼容协议的三个能力（契约 CB，2026-10-26）。
 *
 * 三条路照参考项目的请求模板搬（`model-plugin.ts:203` / `:221` / `:254`）：
 *
 * | 能力 | 端点 | 体 |
 * |---|---|---|
 * | 图像生成 | `POST {base}/v1/images/generations` | JSON：`{model, prompt, n, size, response_format:'b64_json'}` |
 * | 图像编辑 | `POST {base}/v1/images/edits` | **multipart**：参考图作为 `image` 字段 |
 * | 视频 | `POST {base}/videos` 提交 → 轮询 → 取字节 | multipart |
 *
 * ## 视频为什么是三步而不是一步
 *
 * 视频一条几十秒到十几分钟，任何上游都不会让一个 HTTP 请求挂那么久。
 * 所以是「提交拿 id → 轮询状态 → 完成后取字节」，与参考项目
 * （`video.ts:152` 提交 / `:171` 轮询）一致。
 *
 * 状态只有三态：`pending` / `completed` / `failed`（参考项目也是这三态，
 * 计划 §5.2 已核实它没有百分比）。
 *
 * ## ⚠️ 端到端**未验**
 *
 * 这一版**没有任何真 key**，三条路都只被假 `fetchImpl` 验过。
 * 真打一次上游要等用户配了渠道之后。代码注释与测试里都写明了，
 * 不许因为「代码看起来对」就当成验过。
 */
import type { Channel } from './channels.ts'
import {
  GenError, assertCapability, itemFromB64OrUrl, readUpstreamError,
  type GenRequest, type GenResult, type GenItem,
} from './net-gen.ts'

/** 视频轮询的间隔（2.5 秒，照参考项目 `model-plugin.ts:263`）。 */
export const VIDEO_POLL_MS = 2_500
/** 视频轮询的总超时（5 分钟，照参考项目同处）。 */
export const VIDEO_POLL_TIMEOUT_MS = 300_000

/**
 * 去掉 `baseUrl` 尾部的斜杠。
 * @param baseUrl - 原值。
 * @returns 归一后的值。
 */
function trimBase(baseUrl: string): string {
  return String(baseUrl ?? '').replace(/\/+$/, '')
}

/**
 * 请求头（带鉴权）。
 *
 * @param key - 密钥。
 * @param json - 要不要 `content-type: application/json`
 *   （multipart 时**必须不要** —— 自己设了就会缺 boundary，上游解析不了）。
 * @returns 头。
 */
function headersOf(key: string, json: boolean): Record<string, string> {
  const h: Record<string, string> = {}
  if (key !== '') h.Authorization = 'Bearer ' + key
  if (json) h['Content-Type'] = 'application/json'
  return h
}

/**
 * 图像生成（文生图）。
 *
 * @param ch - 渠道。
 * @param key - 密钥。
 * @param req - 请求。
 * @param fetchImpl - 注入的 fetch。
 * @returns 结果（至少一张）。
 */
export async function generateOpenAiImage(
  ch: Channel, key: string, req: GenRequest, fetchImpl?: typeof fetch,
): Promise<GenResult> {
  const doFetch = fetchImpl ?? fetch
  const base = trimBase(ch.baseUrl)
  const count = Math.max(1, Math.min(15, Math.floor(Math.abs(req.count ?? 1)) || 1))
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    n: count,
    /* 要 base64 而不是网址：网址会过期，我们要立刻存成产物文件。 */
    response_format: 'b64_json',
  }
  if (typeof req.size === 'string' && req.size !== '' && req.size !== 'auto') body.size = req.size

  const res = await doFetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: headersOf(key, true),
    body: JSON.stringify(body),
    ...requestSignal(req),
  })
  if (!res.ok) {
    throw new GenError('图像生成失败（' + String(res.status) + '）：' + await readUpstreamError(res), 'upstream')
  }
  const data = await res.json() as { data?: { b64_json?: string, url?: string }[] }
  const list = Array.isArray(data?.data) ? data.data : []
  if (list.length === 0) throw new GenError('图像生成返回了空列表（上游没给任何图）', 'upstream')

  const items: GenItem[] = []
  for (const one of list) {
    items.push(await itemFromB64OrUrl(one.b64_json, one.url, doFetch, req.signal))
  }
  return { items, usage: { images: items.length } }
}

/**
 * 图像编辑（图生图 / 带参考图的生成）。
 *
 * ## 为什么必须是 multipart
 *
 * OpenAI 的 `images/edits` 收的是文件上传，不是 JSON 里的 base64 字符串。
 * 参考项目同样用 `FormData`（`model-plugin.ts:211-224`），且那一行注释专门写了
 * 「formDataHeader」—— 提醒别自己设 `content-type`。
 *
 * @param ch - 渠道。
 * @param key - 密钥。
 * @param req - 请求（`refs` 必须有）。
 * @param fetchImpl - 注入的 fetch。
 * @returns 结果。
 */
export async function editOpenAiImage(
  ch: Channel, key: string, req: GenRequest, fetchImpl?: typeof fetch,
): Promise<GenResult> {
  const doFetch = fetchImpl ?? fetch
  const base = trimBase(ch.baseUrl)
  const refs = req.refs ?? []
  if (refs.length === 0) throw new GenError('图像编辑至少要一张参考图', 'capability')

  const count = Math.max(1, Math.min(15, Math.floor(Math.abs(req.count ?? 1)) || 1))
  const form = new FormData()
  form.append('model', req.model)
  form.append('prompt', req.prompt)
  form.append('n', String(count))
  form.append('response_format', 'b64_json')
  if (typeof req.size === 'string' && req.size !== '' && req.size !== 'auto') form.append('size', req.size)
  if (typeof req.negativePrompt === 'string' && req.negativePrompt !== '') {
    form.append('negative_prompt', req.negativePrompt)
  }
  /* 多张参考图都塞进同名 `image` 字段 —— OpenAI 侧就是这么收的（数组语义靠重复键）。 */
  refs.forEach((ref, i) => {
    form.append('image', new Blob([new Uint8Array(ref.bytes)], { type: ref.mime }), 'ref-' + String(i) + extOf(ref.mime))
  })

  const res = await doFetch(base + '/v1/images/edits', {
    method: 'POST',
    headers: headersOf(key, false),
    body: form,
    ...requestSignal(req),
  })
  if (!res.ok) {
    throw new GenError('图像编辑失败（' + String(res.status) + '）：' + await readUpstreamError(res), 'upstream')
  }
  const data = await res.json() as { data?: { b64_json?: string, url?: string }[] }
  const list = Array.isArray(data?.data) ? data.data : []
  if (list.length === 0) throw new GenError('图像编辑返回了空列表（上游没给任何图）', 'upstream')
  const items: GenItem[] = []
  for (const one of list) items.push(await itemFromB64OrUrl(one.b64_json, one.url, doFetch, req.signal))
  return { items, usage: { images: items.length } }
}

/** mime → 扩展名（给 multipart 的文件名用）。 */
function extOf(mime: string): string {
  const m = mime.split(';')[0].trim().toLowerCase()
  const table: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  }
  return table[m] ?? '.png'
}

/**
 * 把 `signal` 收成「有就写、没有就不写」的形状。
 *
 * 为什么要绕一下：`{ signal: undefined }` 与「没有这个键」在 `fetch` 眼里一样，
 * 但在 TypeScript 的严格模式下不一样，而且读代码的人会以为「这里故意传了 undefined」。
 * @param req - 请求。
 * @returns 要么 `{}` 要么 `{signal}`。
 */
function requestSignal(req: GenRequest): { signal?: AbortSignal } {
  return req.signal === undefined ? {} : { signal: req.signal }
}

/**
 * 视频生成：提交 → 轮询 → 取字节。
 *
 * @param ch - 渠道。
 * @param key - 密钥。
 * @param req - 请求。
 * @param fetchImpl - 注入的 fetch。
 * @param sleep - 注入的等待（测试不真睡）。
 * @returns 结果（一条视频本体）。
 */
export async function generateOpenAiVideo(
  ch: Channel, key: string, req: GenRequest, fetchImpl?: typeof fetch,
  sleep?: (ms: number) => Promise<void>,
): Promise<GenResult> {
  const doFetch = fetchImpl ?? fetch
  const base = trimBase(ch.baseUrl)
  const seconds = Math.max(1, Math.min(20, Math.floor(Number(req.seconds ?? 5)) || 5))

  /* ① 提交（multipart：参考图要作为 input_reference[] 一起上传）。 */
  const form = new FormData()
  form.append('model', req.model)
  form.append('prompt', req.prompt)
  form.append('seconds', String(seconds))
  if (typeof req.size === 'string' && req.size !== '' && req.size !== 'auto') form.append('size', req.size)
  ;(req.refs ?? []).slice(0, 7).forEach((ref, i) => {
    form.append('input_reference[]', new Blob([new Uint8Array(ref.bytes)], { type: ref.mime }), 'ref-' + String(i) + extOf(ref.mime))
  })

  const created = await doFetch(base + '/videos', {
    method: 'POST', headers: headersOf(key, false), body: form, ...requestSignal(req),
  })
  if (!created.ok) {
    throw new GenError('视频任务提交失败（' + String(created.status) + '）：' + await readUpstreamError(created), 'upstream')
  }
  const task = await created.json() as { id?: string }
  if (typeof task?.id !== 'string' || task.id === '') {
    throw new GenError('视频任务提交后没有返回任务 id', 'upstream')
  }
  const id = task.id

  /* ② 轮询。三态语义照参考项目 `video.ts:171-186`：
   *   · 有 `video_url` / `url` → 完成（先拿网址）
   *   · `status === 'completed'` 但没有网址 → 走 `/content` 取字节
   *   · `failed` / `cancelled` → 失败，**带出上游 error 原文**
   *   · 其余（`pending` / `processing`…）→ 继续等 */
  const wait = sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
  for (;;) {
    if (req.signal?.aborted === true) throw new GenError('已取消', 'upstream')
    const got = await doFetch(base + '/videos/' + encodeURIComponent(id), {
      method: 'GET', headers: headersOf(key, true), ...requestSignal(req),
    })
    if (!got.ok) {
      throw new GenError('查视频任务失败（' + String(got.status) + '）：' + await readUpstreamError(got), 'upstream')
    }
    const state = await got.json() as {
      status?: string, video_url?: string, url?: string
      error?: { message?: string }
    }
    const url = typeof state.video_url === 'string' && state.video_url !== ''
      ? state.video_url
      : typeof state.url === 'string' && state.url !== '' ? state.url : ''
    if (url !== '') {
      const item = await itemFromB64OrUrl(undefined, url, doFetch, req.signal)
      return { items: [item], usage: { seconds } }
    }
    if (state.status === 'completed') {
      /* 完成了但没给网址：走 `/content`。 */
      const content = await doFetch(base + '/videos/' + encodeURIComponent(id) + '/content', {
        method: 'GET', headers: headersOf(key, false), ...requestSignal(req),
      })
      if (!content.ok) {
        throw new GenError('取视频本体失败（' + String(content.status) + '）：' + await readUpstreamError(content), 'upstream')
      }
      const bytes = Buffer.from(await content.arrayBuffer())
      if (bytes.length === 0) throw new GenError('取回来的视频是空的', 'upstream')
      const ct = content.headers.get('content-type') ?? ''
      return { items: [{ mime: ct !== '' ? ct.split(';')[0].trim() : 'video/mp4', bytes }], usage: { seconds } }
    }
    if (state.status === 'failed' || state.status === 'cancelled') {
      const why = state.error?.message
      throw new GenError(
        '视频生成失败' + (typeof why === 'string' && why !== '' ? '：' + why : '（上游没给原因）'),
        'upstream',
      )
    }
    req.onProgress?.('pending', { jobId: id, waitedMs: VIDEO_POLL_TIMEOUT_MS - (deadline - Date.now()) })
    if (Date.now() >= deadline) {
      throw new GenError('等视频出结果超时（' + String(Math.round(VIDEO_POLL_TIMEOUT_MS / 1000)) + ' 秒）', 'upstream')
    }
    await wait(VIDEO_POLL_MS)
  }
}

export { assertCapability }
