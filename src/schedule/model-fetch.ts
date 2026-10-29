/** 从渠道真拉一次模型清单（2026-10-26，T-B-后端）。
 *
 * ## 它补的是哪个缺口
 *
 * 渠道里的模型一直是**手打文本**（`"gpt-image-1|GPT Image|image,video"`）。
 * 手打必然打错，打错了要到**生成那一刻**才报「这个渠道没有模型 xxx」——
 * 而那时用户已经写完提示词、等了几十秒。
 *
 * 参考项目有 `model-select-modal.tsx`：拉取 → 列表 → 勾选。我们一个都没有。
 *
 * ## 三种协议，三条真路径
 *
 * | 协议 | 端点 | 参考出处 |
 * |---|---|---|
 * | `comfyui` | `GET {base}/api/experiment/models/<类别>` | 参考项目 `comfyui.ts:3446-3470` |
 * | `openai` | `GET {base}/v1/models` | OpenAI 规范 |
 * | `gemini` | `GET {base}/v1beta/models` | Gemini 规范 |
 *
 * ComfyUI 那条要**按类别**拉（它一个接口只给一类）：我们照参考项目的叫法，
 * 但对外只说四种（`diffusion` / `text_encoder` / `checkpoint` / `vae`）——
 * 因为界面那一侧只关心「这一类的模型能拿来干什么」。
 *
 * ## ⚠️ 失败必须说清是哪一种，不许静默空列表
 *
 * 这是本文件最要紧的一条。空列表的意思是「这个渠道一个模型都没有」，
 * 而失败的意思是「我没问到」—— **两者混起来，用户会以为渠道配好了**。
 * 所以下面把失败分成四类，各有各的话：
 *
 * | 类 | 判据 | 用户该改什么 |
 * |---|---|---|
 * | `unreachable` | fetch 抛错（连不上 / DNS / 拒绝连接） | 地址写错了，或服务没起 |
 * | `auth` | 401 / 403 | 密钥不对、没过期、没权限 |
 * | `no-endpoint` | 具体路径 404 / 405 | 这个地址没有这个接口（不是 OpenAI 兼容的、或 ComfyUI 版本不对） |
 * | `upstream` | 其它非 2xx | 上游自己报错，把它的原文带回去 |
 *
 * 「地址不对」与「没这个接口」的区分靠**能不能连上**：
 * 连不上是地址问题；连上了但那条路径 404，是接口问题。
 *
 * ## 关于 `export`（写给下一个看这个文件的人）
 *
 * `comfyModelsUrl` / `openAiModelsUrl` / `geminiModelsUrl` / `parseModelsResponse`
 * 这四个生产代码不直接调（只在本文件内部被 `fetchChannelModels` 用），
 * `export` 只为单测形状与边界：地址拼装（尾部有没有斜杠、ComfyUI 那条要不要带类别）、
 * 三种协议各自的上游包体、缺字段的条目怎么丢。
 * 那是有意的，不是漏接线 —— 别因为「grep 不到跨文件调用方」就把它们收回去，
 * 删了会让这些断言只能靠端到端跑。
 */
import type { Channel } from './channels.ts'

/** 拉取的四种失败原因。 */
export type FetchFailKind = 'unreachable' | 'auth' | 'no-endpoint' | 'upstream'

/** ComfyUI 那侧要拉的四类（对外名字）。 */
export const COMFY_FETCH_KINDS = ['diffusion', 'text_encoder', 'checkpoint', 'vae'] as const

/** ComfyUI 的类别名。 */
export type ComfyFetchKind = typeof COMFY_FETCH_KINDS[number]

/**
 * 对外类别 → ComfyUI 的接口路径段。
 *
 * ⚠️ `text_encoder` 在参考项目里叫 `clip`（它的界面叫 clip），而接口给的是
 * `text_encoders`。两头名字都不一样，所以这里单独一张表 —— **不靠拼接猜**。
 * 出处：参考项目 `web/src/services/api/comfyui.ts:3446-3470`。
 */
const COMFY_SEGMENT: Record<ComfyFetchKind, string> = {
  diffusion: 'diffusion_models',
  text_encoder: 'text_encoders',
  checkpoint: 'checkpoints',
  vae: 'vae',
}

/** 拉回来的一个模型（**只描述「上游有什么」，还没有能力标记**）。 */
export interface FetchedModel {
  /** 上游的模型 id（发给它的那个名字）。 */
  id: string
  /** 显示名（上游给了就用，没给就用 id）。 */
  label: string
}

/** 拉取结论。 */
export interface FetchModelsResult {
  /** 成功了没有。 */
  ok: boolean
  /** 拉到了哪些（成功时；可能是空数组 —— 那表示「这个渠道确实一个都没有」）。 */
  models: FetchedModel[]
  /** 失败原因（失败时）。 */
  kind?: FetchFailKind
  /** 给人看的一句话（失败时必给；成功时也可能给，比如「要选类别」）。 */
  error?: string
  /** 上游的 HTTP 状态码（拿得到就给，用来排查）。 */
  status?: number
  /** 这次问的完整地址（**排查必看**：地址写错是最高频的原因）。 */
  url?: string
}

/** 拉取的注入点（测试塞假响应）。 */
export interface FetchDeps {
  /** 注入的 fetch。 */
  fetchImpl?: typeof fetch
  /** 注入的密钥（不给就从渠道密钥表读）。 */
  key?: string
}

/**
 * 拼 ComfyUI 的模型清单地址。
 *
 * @param baseUrl - 渠道地址（可能带尾斜杠）。
 * @param kind - 要哪一类。
 * @returns 完整地址。
 */
export function comfyModelsUrl(baseUrl: string, kind: ComfyFetchKind): string {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  return base + '/api/experiment/models/' + COMFY_SEGMENT[kind]
}

/**
 * 拼 OpenAI 兼容的模型清单地址。
 *
 * `baseUrl` 可能是 `https://api.openai.com` 也可能是 `https://x.com/v1`
 * （用户填法不统一），两种都要能成：
 * - 已经以 `/v1` 结尾 → 直接接 `/models`
 * - 否则 → 接 `/v1/models`
 *
 * @param baseUrl - 渠道地址。
 * @returns 完整地址。
 */
export function openAiModelsUrl(baseUrl: string): string {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (/\/v1\d*$/i.test(base)) return base + '/models'
  return base + '/v1/models'
}

/**
 * 拼 Gemini 的模型清单地址。
 *
 * @param baseUrl - 渠道地址。
 * @returns 完整地址。
 */
export function geminiModelsUrl(baseUrl: string): string {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (/\/v1beta\d*$/i.test(base)) return base + '/models'
  return base + '/v1beta/models'
}

/**
 * 把一份上游响应解析成模型清单（**纯函数**，三种协议各一个分支）。
 *
 * 只挑「能用」的字段，其余原样忽略 —— 上游的响应里多的是我们不关心的东西
 * （`object` / `owned_by` / `permission` / `topLevel`…），把它们搬进来只会在
 * 界面上多出一堆没用的行。
 *
 * @param protocol - 协议。
 * @param body - 解析好的 JSON。
 * @returns 模型清单（顺序照上游）。
 */
export function parseModelsResponse(protocol: string, body: unknown): FetchedModel[] {
  if (typeof body !== 'object' || body === null) return []
  const root = body as Record<string, unknown>
  const out: FetchedModel[] = []
  /** 收一条：id 非空才算。 */
  const push = (id: unknown, label: unknown): void => {
    const mid = typeof id === 'string' ? id.trim() : ''
    if (mid === '') return
    const name = typeof label === 'string' && label.trim() !== '' ? label.trim() : mid
    out.push({ id: mid, label: name })
  }

  if (protocol === 'openai') {
    /* `{ object: 'list', data: [{ id, object, created, owned_by }] }` */
    const data = root.data
    if (!Array.isArray(data)) return []
    for (const one of data) {
      if (typeof one !== 'object' || one === null) continue
      const rec = one as Record<string, unknown>
      push(rec.id, rec.id)
    }
    return out
  }

  if (protocol === 'gemini') {
    /* `{ models: [{ name: 'models/gemini-2.5-flash', displayName, ... }] }`
     *
     * ⚠️ `name` 带 `models/` 前缀，而真正发给上游的是**去掉前缀的那段**。
     * 不去的话生成请求会变成 `models/models/xxx:generateContent` —— 必然 404。 */
    const list = root.models
    if (!Array.isArray(list)) return []
    for (const one of list) {
      if (typeof one !== 'object' || one === null) continue
      const rec = one as Record<string, unknown>
      const raw = typeof rec.name === 'string' ? rec.name.trim() : ''
      if (raw === '') continue
      const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw
      push(id, rec.displayName)
    }
    return out
  }

  if (protocol === 'comfyui') {
    /* 参考项目那个接口回的是一串对象：`[{ name, path, ... }]`
     * （有的版本是 `[{ filename }]`），两种键名都认。 */
    const list = Array.isArray(root) ? root : (Array.isArray(root.models) ? root.models : [])
    for (const one of list) {
      if (typeof one === 'string') { push(one, one); continue }
      if (typeof one !== 'object' || one === null) continue
      const rec = one as Record<string, unknown>
      const id = rec.name ?? rec.filename ?? rec.model ?? rec.id
      push(id, rec.name ?? rec.filename ?? id)
    }
    return out
  }

  return out
}

/**
 * 发一次请求并做失败分类（**三种原因分开**的核心）。
 *
 * @param url - 完整地址。
 * @param headers - 额外请求头。
 * @param deps - 注入点。
 * @returns 成功给 `{ok:true, body}`；失败给带 `kind` 与一句话的结果。
 */
async function requestOnce(
  url: string, headers: Record<string, string>, deps: FetchDeps,
): Promise<{ ok: true, body: unknown } | { ok: false, result: FetchModelsResult }> {
  const impl = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await impl(url, { method: 'GET', headers })
  } catch (e) {
    /* ① 连不上：地址写错、协议写成 http、服务没起、DNS 不通 —— 都落这里。
     * 原文带回去，因为它常常直接说明原因（`ECONNREFUSED` / `getaddrinfo`）。 */
    const raw = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      result: {
        ok: false, models: [], kind: 'unreachable', url,
        error: '连不上这个地址（' + url + '）：' + raw
          + '。多半是地址写错、端口没开，或者服务没起。',
      },
    }
  }

  /* ② 密钥不对：上游明确拒绝。 */
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      result: {
        ok: false, models: [], kind: 'auth', status: res.status, url,
        error: '密钥不对或没权限（HTTP ' + String(res.status) + '）：'
          + '检查这个渠道的密钥填了没有、有没有过期、这个账号能不能列模型。',
      },
    }
  }

  /* ③ 地址通了但没有这个接口。**这一条与「连不上」必须分开** ——
   * 用户看到「连不上」会去查网络，而实际上是「这个地址不是 OpenAI 兼容的」。 */
  if (res.status === 404 || res.status === 405) {
    return {
      ok: false,
      result: {
        ok: false, models: [], kind: 'no-endpoint', status: res.status, url,
        error: '这个地址没有列模型的接口（HTTP ' + String(res.status) + '）：'
          + '问的是 ' + url + '。地址本身能连上，但它不是这个协议的接口 —— '
          + '检查渠道协议选对没有（OpenAI 兼容 / ComfyUI / Gemini 是三条不同的路）。',
      },
    }
  }

  if (!res.ok) {
    /* ④ 上游自己报错：把它的话带回去（比我们编一句准）。 */
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch { /* 读不到就算了 */ }
    return {
      ok: false,
      result: {
        ok: false, models: [], kind: 'upstream', status: res.status, url,
        error: '上游返回 HTTP ' + String(res.status) + '：' + (detail === '' ? '（没有说明）' : detail),
      },
    }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    return {
      ok: false,
      result: {
        ok: false, models: [], kind: 'upstream', status: res.status, url,
        error: '上游回的不是 JSON（' + (e instanceof Error ? e.message : String(e)) + '）：'
          + '多半是地址指到了一个网页而不是 API。',
      },
    }
  }
  return { ok: true, body }
}

/**
 * 按协议拉一次模型清单。
 *
 * @param channel - 渠道（要它的 `id` / `protocol` / `baseUrl`）。
 * @param key - 这个渠道的密钥（ComfyUI 一般空）。
 * @param kind - ComfyUI 要哪一类（其余协议忽略）。
 * @param deps - 注入点（测试塞假 fetch）。
 * @returns 拉取结论。
 */
export async function fetchChannelModels(
  channel: Pick<Channel, 'protocol' | 'baseUrl'>,
  key: string,
  kind?: ComfyFetchKind,
  deps: FetchDeps = {},
): Promise<FetchModelsResult> {
  const base = String(channel.baseUrl ?? '').trim()
  if (base === '') {
    return {
      ok: false, models: [], kind: 'unreachable',
      error: '这个渠道还没有接口地址：先去渠道设置里把地址填上，再来拉模型。',
    }
  }

  if (channel.protocol === 'comfyui') {
    if (kind === undefined) {
      return {
        ok: false, models: [], kind: 'no-endpoint',
        error: 'ComfyUI 是按类别列模型的（' + COMFY_FETCH_KINDS.join(' / ') + '）：先说要哪一类。',
      }
    }
    const url = comfyModelsUrl(base, kind)
    /* ComfyUI 一般不要密钥。给了就带 —— 走代理时可能用得着。 */
    const headers: Record<string, string> = key === '' ? {} : { authorization: 'Bearer ' + key }
    const got = await requestOnce(url, headers, deps)
    if ('result' in got) return got.result
    const models = parseModelsResponse('comfyui', got.body)
    if (models.length === 0) {
      /* 空不是失败，但要说明**这是真的空**，不是我们没问到。 */
      return {
        ok: true, models: [], url,
        error: '这个地址的「' + kind + '」这一类一个模型都没有。'
          + 'ComfyUI 里没装这一类模型时会这样。',
      }
    }
    return { ok: true, models, url }
  }

  if (channel.protocol === 'openai') {
    const url = openAiModelsUrl(base)
    const headers: Record<string, string> = key === '' ? {} : { authorization: 'Bearer ' + key }
    const got = await requestOnce(url, headers, deps)
    if ('result' in got) return got.result
    return { ok: true, models: parseModelsResponse('openai', got.body), url }
  }

  if (channel.protocol === 'gemini') {
    const url = geminiModelsUrl(base)
    /* Gemini 的密钥走 header（`?key=` 也可以，但 header 不会进日志）。 */
    const headers: Record<string, string> = key === '' ? {} : { 'x-goog-api-key': key }
    const got = await requestOnce(url, headers, deps)
    if ('result' in got) return got.result
    return { ok: true, models: parseModelsResponse('gemini', got.body), url }
  }

  return {
    ok: false, models: [], kind: 'no-endpoint',
    error: '不认识的协议：' + String(channel.protocol) + '（只能是 openai / comfyui / gemini）',
  }
}
