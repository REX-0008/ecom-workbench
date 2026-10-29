/** Gemini 协议（`generateContent`，契约 CB，2026-10-26）。
 *
 * 照参考项目的请求模板搬（`model-plugin.ts:229-246`）：
 *
 * ```
 * POST {base}/v1beta/models/{model}:generateContent
 * header: x-goog-api-key: <key>
 * body: { contents: [{ role: 'user', parts: [{text}, {inline_data:{mime_type,data}}...] }],
 *         generationConfig: { responseModalities: ['IMAGE'] } }
 * ```
 *
 * ## 三个与 OpenAI 不同的地方
 *
 * 1. **鉴权走 header 而不是 Bearer**：`x-goog-api-key`。用错的话上游回 401，
 *    而 401 的话术里不会提示「你 header 名写错了」—— 所以这条要按它的规矩来。
 * 2. **URL 里带模型名**：`/v1beta/models/<model>:generateContent`（注意那个冒号）。
 * 3. **图与文字同一个端点**：靠 `responseModalities` 区分（要图就填 `['IMAGE']`）。
 *
 * ⚠️ `v1beta` 不是 `v1` —— Gemini 的 `generateContent` 只在 `v1beta` 上开放
 * （这也是参考项目写死的）。
 *
 * ## ⚠️ 端到端**未验**
 *
 * 这一版没有任何真 key。请求形状被假 `fetchImpl` 验过，真打一次要等用户配渠道。
 */
import type { Channel } from './channels.ts'
import {
  GenError, readUpstreamError,
  type GenRequest, type GenResult, type GenItem,
} from './net-gen.ts'

/**
 * 组装 `generateContent` 的请求体（**纯函数**，所以能单测形状）。
 *
 * @param req - 请求。
 * @param wantImage - 要不要图（`true` 时加 `responseModalities: ['IMAGE']`）。
 * @returns 请求体。
 */
export function geminiBody(req: GenRequest, wantImage: boolean): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [{ text: req.prompt }]
  for (const ref of req.refs ?? []) {
    /* Gemini 的字段是 `inline_data`（蛇形）。它文档里也认 `inlineData`（驼峰），
     * 但参考项目用的是蛇形、且两家都能收 —— 跟参考保持一致。 */
    parts.push({
      inline_data: { mime_type: ref.mime, data: ref.bytes.toString('base64') },
    })
  }
  const body: Record<string, unknown> = { contents: [{ role: 'user', parts }] }
  if (wantImage) body.generationConfig = { responseModalities: ['IMAGE'] }
  return body
}

/**
 * Gemini 生成。
 *
 * @param ch - 渠道。
 * @param key - 密钥。
 * @param req - 请求（`image` 或 `text`）。
 * @param fetchImpl - 注入的 fetch。
 * @returns 结果。
 */
export async function generateGemini(
  ch: Channel, key: string, req: GenRequest, fetchImpl?: typeof fetch,
): Promise<GenResult> {
  const doFetch = fetchImpl ?? fetch
  const base = String(ch.baseUrl ?? '').replace(/\/+$/, '')
  const wantImage = req.kind === 'image'
  /* 冒号后面是动作，不 encode —— 它是 URL 的一部分而不是参数值。 */
  const url = base + '/v1beta/models/' + encodeURIComponent(req.model) + ':generateContent'

  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify(geminiBody(req, wantImage)),
    ...req.signal === undefined ? {} : { signal: req.signal },
  })
  if (!res.ok) {
    throw new GenError('Gemini 生成失败（' + String(res.status) + '）：' + await readUpstreamError(res), 'upstream')
  }

  const data = await res.json() as {
    candidates?: { content?: { parts?: Record<string, unknown>[] } }[]
  }
  const parts = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? [])
  if (parts.length === 0) throw new GenError('Gemini 返回了空的 candidates（上游没给任何内容）', 'upstream')

  /* 图片在 `inlineData` / `inline_data` 里（两个拼法都要认 ——
   * 不同版本的 API 回的键名不一样，只认一个就有一天突然拿不到图）。 */
  const items: GenItem[] = []
  for (const part of parts) {
    const inline = (part.inlineData ?? part.inline_data) as { mimeType?: string, mime_type?: string, data?: string } | undefined
    if (inline === undefined || typeof inline.data !== 'string' || inline.data === '') continue
    items.push({
      mime: typeof inline.mimeType === 'string' ? inline.mimeType
        : typeof inline.mime_type === 'string' ? inline.mime_type : 'image/png',
      bytes: Buffer.from(inline.data, 'base64'),
    })
  }

  /* 文字在 `text` 里。要文字时把它也当成一份产出（mime `text/plain`），
   * 这样调用方不用为「要文字」写第二条分支。 */
  if (!wantImage) {
    const text = parts
      .map(p => typeof p.text === 'string' ? p.text : '')
      .filter(s => s !== '')
      .join('\n')
    if (text !== '') items.push({ mime: 'text/plain; charset=utf-8', bytes: Buffer.from(text, 'utf8') })
  }

  if (items.length === 0) {
    throw new GenError(
      wantImage
        ? 'Gemini 这次没给图（它可能只回了文字 —— 检查这个模型支不支持出图）'
        : 'Gemini 这次没给任何内容',
      'upstream',
    )
  }
  return {
    items,
    ...wantImage ? { usage: { images: items.length } } : {},
  }
}
