/** ComfyUI 的 HTTP 调用层（契约 CA，2026-10-26）。
 *
 * ## 为什么与 `comfyui.ts` 分成两个文件
 *
 * 参考项目把它写在一个 3469 行的 `services/api/comfyui.ts` 里 —— 那是因为它是浏览器，
 * 所有请求都得经过一个 `comfyuiFetch`（要处理 CORS 代理、混合内容、相对路径）。
 * 我们是宿主（Node），**没有 CORS 问题、不需要代理**，于是那一层薄到只剩
 * 「拼 URL + 带上 token + 判 ok」。
 *
 * 分开的好处是**纯函数与 IO 不搅在一起**：槽位填写、参考图裁剪、状态判定
 * 全是纯函数（在 `comfyui.ts`），好单测；这里只有「真的发请求」。
 *
 * ## 为什么每个函数都接受 `fetchImpl`
 *
 * 测试要喂假响应。用「注入一个 fetch」而不是「拦截全局 fetch」：
 * 后者会让所有测试互相干扰（全局状态），而且拦不干净时测试会**真连出去**。
 * 这与 `pollJob` 接受 `fetchJob` 是同一个做法。
 *
 * ## ⚠️ 端到端仍未验
 *
 * 本机没有 ComfyUI 在跑（8188 / 8189 都不通）。这里每一行代码都只被
 * **假 fetch** 验过，没有被真服务验过。等 ComfyUI 起来要补一次真连。
 */
import type { ComfyWorkflow } from './comfyui.ts'

/**
 * 一次请求要带的东西。
 *
 * `fetchImpl` 不给就用全局 `fetch`（Node 18+ 自带；本机是 v24）。
 */
export interface ComfyHttpOptions {
  /** 往哪里发（渠道的 `baseUrl`，如 `http://127.0.0.1:8189`）。 */
  baseUrl: string
  /** 鉴权 token（可选；ComfyUI 默认不鉴权，走代理时一般要）。 */
  token?: string
  /**
   * 代理地址（可选）。参考项目用它绕 CORS。
   *
   * **我们是宿主，一般不需要**；字段留着是因为渠道配置里有它
   * （`channels.ts` 的 `comfyuiProxyUrl`），有值就照它的规则拼。
   * 空值 = 直连。
   */
  proxyUrl?: string
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 取消信号。 */
  signal?: AbortSignal
}

/**
 * 归一地址：去掉尾部的斜杠，避免拼出 `//prompt` 这种。
 *
 * @param baseUrl - 原始地址。
 * @returns 归一后的地址。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl ?? '').replace(/\/+$/, '')
}

/**
 * 一次请求的错误（带 HTTP 状态码，便于调用方区分 4xx / 5xx）。
 */
export class ComfyApiError extends Error {
  /** HTTP 状态码（网络层失败时是 0）。 */
  readonly status: number

  /**
   * @param message - 人看得懂的说明。
   * @param status - HTTP 状态码。
   */
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ComfyApiError'
    this.status = status
  }
}

/**
 * 发一次请求并把响应读成 JSON。
 *
 * ## 为什么要单拆出来
 *
 * 每个端点都要做四件一样的事：拼 URL、加 headers、判 `ok`、把错误体里的话带出来。
 * 参考项目也是这么收的（它的 `comfyuiFetch`）。写五遍必然有一遍漏掉错误处理，
 * 而「漏掉的那一遍」在出问题时表现就是一句没头没尾的 500。
 *
 * @param opts - 连接参数。
 * @param pathAndQuery - 相对路径（如 `/prompt`）。
 * @param init - `fetch` 的其余参数。
 * @returns 解析好的 JSON（HTTP 非 2xx 时抛 `ComfyApiError`）。
 */
async function requestJson(
  opts: ComfyHttpOptions, pathAndQuery: string, init: RequestInit = {},
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch
  const base = normalizeBaseUrl(opts.baseUrl)
  /* 有代理就按参考项目的规则拼：`{proxy}{base}{path}`。
   * 没有就直接 `{base}{path}`。 */
  const proxy = normalizeBaseUrl(opts.proxyUrl ?? '')
  const url = proxy === '' ? base + pathAndQuery : proxy + base + pathAndQuery
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (opts.token !== undefined && opts.token !== '') headers.Authorization = 'Bearer ' + opts.token

  let res: Response
  try {
    res = await doFetch(url, { ...init, headers, ...opts.signal === undefined ? {} : { signal: opts.signal } })
  } catch (e) {
    /* 连接层失败（服务没起来、地址错）—— 这条最常发生，
     * 必须说清是「连不上」而不是笼统的「请求失败」。 */
    throw new ComfyApiError(
      '连不上 ComfyUI（' + base + '）：' + (e instanceof Error ? e.message : String(e)),
      0,
    )
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw new ComfyApiError('ComfyUI 返回 ' + String(res.status) + (detail === '' ? '' : '：' + detail), res.status)
  }
  try {
    return await res.json()
  } catch {
    /* 2xx 但体不是 JSON：ComfyUI 的某些端点会回空体。给 null 比抛错好 ——
     * 调用方只关心「成没成」，体是次要的。 */
    return null
  }
}

/**
 * 从错误响应里捞出最有用的那句话。
 *
 * ComfyUI 的错误体有两种形状：`{error:{message,details}}` 与 `{node_errors:{...}}`。
 * 后者更重要 —— 它说的是「哪个节点缺什么输入」，那是用户唯一能照着改的信息。
 *
 * @param res - 响应。
 * @returns 说明（捞不到给空串）。
 */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json() as {
      error?: { message?: string, details?: string }
      node_errors?: Record<string, unknown>
    }
    if (body?.node_errors !== undefined && Object.keys(body.node_errors).length > 0) {
      return JSON.stringify(body.node_errors)
    }
    if (typeof body?.error?.message === 'string') {
      return body.error.details !== undefined
        ? body.error.message + '：' + body.error.details
        : body.error.message
    }
  } catch { /* 体不是 JSON，没什么可捞的 */ }
  return ''
}

/** ComfyUI `/prompt` 的响应原始形状（它是蛇形键，我们内部用驼峰）。 */
interface PromptRawResponse {
  prompt_id?: unknown
  node_errors?: Record<string, unknown>
}

/**
 * 提交一份工作流到 `/prompt`。
 *
 * ## 一个容易踩的地方：`node_errors` 会以 **200** 回来
 *
 * ComfyUI 对「工作流结构有问题」不回 4xx，而是 200 + `node_errors`。
 * 只看 `res.ok` 的话，这种失败会被当成提交成功，然后轮询等到超时 ——
 * 用户看到的是「等了 18 小时什么也没有」，真实原因是第 3 行少了个参数。
 * 所以这里**必须**把 `node_errors` 当失败。
 *
 * @param workflow - 已经填好槽位的工作流。
 * @param opts - 连接参数。
 * @returns 任务 id。
 * @throws `ComfyApiError`（提交失败 / 校验报错 / 没有 prompt_id）。
 */
export async function submitPrompt(workflow: ComfyWorkflow, opts: ComfyHttpOptions): Promise<string> {
  const body = JSON.stringify({
    prompt: workflow,
    /* `client_id` 是 ComfyUI 用来认「这个任务是谁提交的」，我们不需要回连，
     * 但字段得给（某些版本缺它会有怪行为）。给个固定前缀 + 随机串。 */
    client_id: 'ewb-' + Math.random().toString(36).slice(2, 10),
  })
  const data = await requestJson(opts, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }) as PromptRawResponse | null

  if (data?.node_errors !== undefined && Object.keys(data.node_errors).length > 0) {
    throw new ComfyApiError('ComfyUI 工作流校验报错：' + JSON.stringify(data.node_errors), 200)
  }
  if (typeof data?.prompt_id !== 'string' || data.prompt_id === '') {
    throw new ComfyApiError('ComfyUI /prompt 响应里没有 prompt_id', 200)
  }
  return data.prompt_id
}

/**
 * 上传一个素材到 `/upload/image`，返回 ComfyUI 那边的文件名。
 *
 * ## 为什么用 `FormData` 而不是自己拼 multipart
 *
 * Node 18+ 的 `FormData` + `fetch` 会自己算 `boundary`、自己设 header。
 * 手拼边界是最容易出错的一段（少一个 `\r\n` 服务端就解析不了），
 * 有标准实现就用它。
 *
 * ## 名字要清洗
 *
 * ComfyUI 会把文件落到它自己的 `input/` 目录。名字里带路径分隔符就能写到别处去，
 * 所以只留字母数字与 `. _ -`，并加一个随机前缀避免覆盖别人的同名文件。
 *
 * @param opts - 连接参数。
 * @param bytes - 文件字节。
 * @param filename - 想要的名字（会被清洗）。
 * @param mime - 类型（默认按扩展名猜）。
 * @returns ComfyUI 里的引用名（有子目录时形如 `sub/name`）。
 */
export async function uploadImage(
  opts: ComfyHttpOptions, bytes: Buffer, filename = 'image.png', mime = '',
): Promise<string> {
  const safe = String(Math.random().toString(36).slice(2, 10)) + '_'
    + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: mime === '' ? guessMime(filename) : mime }), safe)
  form.append('overwrite', 'true')
  form.append('type', 'input')

  const data = await requestJson(opts, '/upload/image', { method: 'POST', body: form }) as
    { name?: string, subfolder?: string } | null
  if (typeof data?.name !== 'string' || data.name === '') {
    throw new ComfyApiError('ComfyUI /upload/image 响应里没有文件名', 200)
  }
  return data.subfolder !== undefined && data.subfolder !== '' ? data.subfolder + '/' + data.name : data.name
}

/**
 * 按扩展名猜 mime（上传与下载两边共用）。
 * @param name - 文件名。
 * @returns mime；不认识给 `application/octet-stream`。
 */
export function guessMime(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
    txt: 'text/plain; charset=utf-8',
  }
  return table[ext] ?? 'application/octet-stream'
}

/**
 * 查一个任务的执行记录（`/history/{id}`）。
 *
 * @param opts - 连接参数。
 * @param jobId - 任务 id。
 * @returns 原始响应（本函数不解释它 —— 判状态是 `comfyui.ts` 里纯函数的事）。
 */
export async function getHistory(opts: ComfyHttpOptions, jobId: string): Promise<unknown> {
  return requestJson(opts, '/history/' + encodeURIComponent(jobId), { method: 'GET' })
}

/**
 * 查队列（`/queue`）。
 *
 * @param opts - 连接参数。
 * @returns 原始响应（`{queue_running:[], queue_pending:[]}`）。
 */
export async function getQueue(opts: ComfyHttpOptions): Promise<unknown> {
  return requestJson(opts, '/queue', { method: 'GET' })
}

/**
 * 从队列里删掉一条**还在排队**的任务（`POST /queue {delete:[id]}`）。
 *
 * @param opts - 连接参数。
 * @param jobId - 任务 id。
 */
export async function deleteQueueItem(opts: ComfyHttpOptions, jobId: string): Promise<void> {
  await requestJson(opts, '/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [jobId] }),
  })
}

/**
 * 中断**正在运行**的任务（`POST /interrupt`）。
 *
 * ⚠️ 这个端点是**全局**的：它中断当前正在跑的那一个，不认 id。
 * 所以调用前必须先确认目标任务真的在跑（否则会打断别人的任务）。
 * 那个判断在 `comfyui.ts` 的 `cancelJob` 里。
 *
 * @param opts - 连接参数。
 */
export async function interrupt(opts: ComfyHttpOptions): Promise<void> {
  await requestJson(opts, '/interrupt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
}

/**
 * 查主机信息（`/system_stats`）。用来判主机是 Windows 还是 Linux。
 *
 * @param opts - 连接参数。
 * @returns 原始响应。
 */
export async function getSystemStats(opts: ComfyHttpOptions): Promise<unknown> {
  return requestJson(opts, '/system_stats', { method: 'GET' })
}

/** 下载回来的一份字节。 */
export interface DownloadedAsset {
  /** 字节。 */
  bytes: Buffer
  /** mime（按文件名猜；服务端给了 `content-type` 就用它的）。 */
  mime: string
}

/**
 * 按文件名取回产物字节（`/view`）。
 *
 * ## 为什么 `/api/view` 与 `/view` 两个路径都要试
 *
 * ComfyUI 前端走 `/view`，有些部署（走反向代理的）用 `/api/view`。
 * 参考项目就是「一个失败就试另一个」（它的 `downloadAsset`）。
 * 我们照抄：先 `/view`，404 再试 `/api/view`。
 *
 * @param opts - 连接参数。
 * @param filename - 服务端给的文件名。
 * @param type - `output` / `input` / `temp`（默认 `output`）。
 * @param subfolder - 子目录（默认空）。
 * @returns 字节与 mime。
 * @throws 两个路径都拿不到时抛错。
 */
export async function downloadView(
  opts: ComfyHttpOptions, filename: string, type = 'output', subfolder = '',
): Promise<DownloadedAsset> {
  const query = '?filename=' + encodeURIComponent(filename)
    + '&type=' + encodeURIComponent(type)
    + '&subfolder=' + encodeURIComponent(subfolder)
  const doFetch = opts.fetchImpl ?? fetch
  const base = normalizeBaseUrl(opts.baseUrl)
  const proxy = normalizeBaseUrl(opts.proxyUrl ?? '')
  const prefix = proxy === '' ? base : proxy + base
  const headers: Record<string, string> = {}
  if (opts.token !== undefined && opts.token !== '') headers.Authorization = 'Bearer ' + opts.token

  let lastErr = ''
  for (const path of ['/view', '/api/view']) {
    try {
      const res = await doFetch(prefix + path + query, { headers, ...opts.signal === undefined ? {} : { signal: opts.signal } })
      if (!res.ok) { lastErr = String(res.status); continue }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) { lastErr = '响应体是空的'; continue }
      const ct = res.headers.get('content-type') ?? ''
      return { bytes: buf, mime: ct !== '' ? ct : guessMime(filename) }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new ComfyApiError('从 ComfyUI 取文件失败（' + filename + '）：' + lastErr, 0)
}
