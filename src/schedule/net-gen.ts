/** 网络模型的统一生成入口（契约 CB，2026-10-26）。
 *
 * ## 它是什么
 *
 * 内容板块要「用外部的模型生成图 / 视频 / 文字」。外部模型有两种协议：
 * `openai`（OpenAI 兼容）与 `gemini`（Google 的 `generateContent`）。
 * 这个文件是**唯一入口**：调用方只说「我要一张图、提示词是什么」，
 * 它按渠道的 `protocol` 分派到 `openai-gen.ts` 或 `gemini-gen.ts`。
 *
 * 第三个协议 `comfyui` **不走这里** —— 它是本地直连、走槽位工作流那套，
 * 实现完全在 `comfyui.ts`（契约 CA）。这里遇到它要**明确报错**，
 * 不许「顺便也实现一遍」：同一件事写两份必然漂，那是本项目反复踩的坑。
 *
 * ## 为什么宿主来做（而不是前端）
 *
 * 密钥在宿主（`channels.secret.json`，前端读不到），而且 Node 没有浏览器那层
 * CORS / 混合内容限制 —— 参考项目为此写了一个 `comfyuiFetch` 代理层，
 * 我们直接 `fetch` 就行。
 *
 * ## ⚠️ 与参考项目的一处刻意差异
 *
 * 参考项目有一层「用户可编辑的请求脚本」（`model-plugin.ts`，383 行，把模板脚本
 * 交给沙箱执行）。用户 m01076 选的是 **B：先做固定两种协议**，
 * 所以这一层不做 —— 没有沙箱执行器，也就没有「脚本能干什么」这一整类安全问题。
 */
import type { Channel, ChannelModel } from './channels.ts'
import { generateOpenAiImage, editOpenAiImage, generateOpenAiVideo } from './openai-gen.ts'
import { generateGemini } from './gemini-gen.ts'

/** 生成什么。 */
export type GenKind = 'image' | 'video' | 'text' | 'audio'

/**
 * **图像操作**（契约 T1，2026-10-26）。
 *
 * ## 为什么不并进 `GenKind`
 *
 * `GenKind` 是「产出是什么」（图 / 视频 / 文字 / 音频），
 * `GenOp` 是「对**已有的图**做什么」（局部重绘 / 放大 / 超分 / 反推 / 多角度）。
 * 两件事维度不同：`kind: 'image' + op: 'inpaint'` 才是「在图上局部重绘」。
 *
 * 硬把 op 塞进 `GenKind` 会让所有 `categoryOf(kind, hasRefs)` 的调用点都要改，
 * 而且会让「图生图」与「局部重绘」这两个本来平行的东西变成兄弟枚举值 ——
 * 以后再想加操作就得再动一次枚举。所以**平行加一个**，`kind` 一字不动。
 */
export type GenOp = 'inpaint' | 'upscale' | 'superResolve' | 'caption' | 'angle'

/** 全部操作（界面做下拉、测试遍历用）。 */
export const GEN_OPS: readonly GenOp[] = ['inpaint', 'upscale', 'superResolve', 'caption', 'angle']

/**
 * 判断一个字符串是不是 `GenOp`。
 * @param v - 待查值。
 * @returns 是就 true。
 */
export function isGenOp(v: unknown): v is GenOp {
  return typeof v === 'string' && (GEN_OPS as readonly string[]).includes(v)
}

/** 一次生成的请求（四个能力共用这一份）。 */
export interface GenRequest {
  /** 要生成什么。 */
  kind: GenKind
  /**
   * 对已有的图做什么操作（可选，契约 T1）。
   *
   * 不给 → 行为与加这个字段之前**一字不变**（`categoryOf` 只看 `kind` 与 `hasRefs`）。
   */
  op?: GenOp
  /** 提示词。 */
  prompt: string
  /** 模型 id（渠道 `models[].id` 里的那个）。 */
  model: string
  /** 尺寸写法（`1024x1024` / `16:9`；不给就用模型默认）。 */
  size?: string
  /** 要几张（只对图片有意义，默认 1）。 */
  count?: number
  /** 要几秒（只对视频有意义，默认 5）。 */
  seconds?: number
  /**
   * 参考图（图生图 / 图像编辑 / 带图问答用）。
   *
   * ⚠️ 给 `bytes` 而不是 `dataUrl`：前端的 dataUrl 要在宿主这里拆成字节再
   * 重新编码进请求，多一道 base64 往返纯属浪费。上游要 base64 时这里现编。
   */
  refs?: { mime: string, bytes: Buffer }[]
  /**
   * 遮罩（局部重绘用，契约 T1）。
   *
   * ## 它之前一直是「后端认得、但没人传」
   *
   * `comfyui.ts` 早就认 `ref_mask` / `mask` / `ref_mask_01` 三个槽位名，
   * 校验里还专门有「局部编辑工作流缺少 ref_mask 遮罩槽位」这一条 ——
   * 但从生成请求到工作流槽位之间**没有这条路**。所以「局部重绘」在数据上
   * 一直是「只有提示词、没有遮罩」，ComfyUI 那边只能拿空遮罩跑。
   *
   * 现在接上：给了就在 ComfyUI 那条路上传成 `ref_mask`（见 `comfyui.ts` 的
   * `applyBindings` 与 `runComfyGeneration` 的 mask 上传）。
   *
   * 网络模型（openai / gemini）那边**不认**这个字段 —— 那两家的 API 没有
   * 「遮罩」这个参数。给了 mask 却走网络模型时会明确报错，不静默忽略。
   */
  mask?: { mime: string, bytes: Buffer }
  /** 反查提示词（部分模型认）。 */
  negativePrompt?: string
  /** 取消信号。 */
  signal?: AbortSignal
  /** 进度回调（视频轮询时用来显示「已等 N 秒」）。 */
  onProgress?: (stage: string, detail?: unknown) => void
  /**
   * 等待实现（**测试用**：注入一个不真睡的，让轮询测试跑得飞快）。
   *
   * 为什么放在请求上而不是函数参数：`generateOnChannel` 是唯一入口，
   * 加参数会让每个调用点都要透传一次；放在请求里跟着请求走。
   */
  sleep?: (ms: number) => Promise<void>
}

/** 一份产出的字节。 */
export interface GenItem {
  /** mime（`image/png` / `video/mp4` …）。 */
  mime: string
  /** 字节。 */
  bytes: Buffer
}

/** 一次生成的结果。 */
export interface GenResult {
  /** 产出（至少一个）。 */
  items: GenItem[]
  /**
   * 用量。**只记张数与秒数，不记任何与结算有关的量**（计划 §三 5.3，用户 m01114 定）。
   * 留单价字段就会有人填，填了就会有人拿它当真相。
   */
  usage?: { images?: number, seconds?: number }
}

/**
 * 生成失败（带「是谁的问题」）。
 *
 * 为什么要单独一个类型：上层要区分「这个模型不支持这个能力」（用户该换模型）
 * 与「上游挂了」（该重试），两者的处理完全不同。
 */
export class GenError extends Error {
  /** 错误类别。 */
  readonly kind: 'capability' | 'protocol' | 'upstream' | 'unsupported'

  /**
   * @param message - 人看得懂的说明。
   * @param kind - 类别。
   */
  constructor(message: string, kind: GenError['kind'] = 'upstream') {
    super(message)
    this.name = 'GenError'
    this.kind = kind
  }
}

/**
 * 找一个模型在渠道里登记的能力。
 *
 * @param ch - 渠道。
 * @param modelId - 模型 id。
 * @returns 那条模型；渠道里没登记这个模型给 `undefined`。
 */
export function findModel(ch: Channel, modelId: string): ChannelModel | undefined {
  return ch.models.find(m => m.id === modelId)
}

/**
 * 检查「这个模型能不能做这件事」，不能就说清是谁缺什么。
 *
 * ## 为什么要单独一步、并且说得这么啰嗦
 *
 * 「静默失败」是这一层最坏的失败方式：用户点生成、等半天、什么都没发生，
 * 或者拿回一张图但模型根本不支持图像。所以这里报错必须带三件事：
 * **哪个模型、缺什么能力、这个渠道里哪些模型有**。
 * 用户看一眼就能换模型，不用去猜。
 *
 * @param ch - 渠道。
 * @param modelId - 模型 id。
 * @param kind - 要做的能力。
 * @throws `GenError`（`kind: 'capability'`）。
 */
export function assertCapability(ch: Channel, modelId: string, kind: GenKind): void {
  const m = findModel(ch, modelId)
  if (m === undefined) {
    throw new GenError(
      '渠道「' + ch.name + '」里没有模型 ' + modelId
      + '（这个渠道登记的模型：'
      + (ch.models.length === 0 ? '一个都没有' : ch.models.map(x => x.id).join('、'))
      + '）',
      'capability',
    )
  }
  if (!m.caps.includes(kind)) {
    const canDo = ch.models.filter(x => x.caps.includes(kind)).map(x => x.id)
    throw new GenError(
      '模型 ' + modelId + ' 没有「' + kind + '」能力（它有的是：'
      + (m.caps.length === 0 ? '未登记任何能力' : m.caps.join('、'))
      + '）。这个渠道里能做 ' + kind + ' 的模型：'
      + (canDo.length === 0 ? '没有' : canDo.join('、')),
      'capability',
    )
  }
}

/**
 * 在一次生成上跑一遍：校验 → 分派 → 归一结果。
 *
 * @param ch - 渠道（`protocol` 决定走哪条路）。
 * @param key - 渠道密钥（宿主从 `channels.secret.json` 读出来传进来）。
 * @param req - 请求。
 * @param fetchImpl - 注入的 fetch（测试塞假响应；不给用全局）。
 * @returns 结果。
 * @throws `GenError`。
 */
export async function generateOnChannel(
  ch: Channel, key: string, req: GenRequest, fetchImpl?: typeof fetch,
): Promise<GenResult> {
  /* ① 协议分派。`comfyui` 明确拒绝 —— 见文件头。 */
  if (ch.protocol === 'comfyui') {
    throw new GenError(
      '渠道「' + ch.name + '」是 ComfyUI 协议，不走网络模型这条路：'
      + '应由 ComfyUI 那条路处理（`src/schedule/comfyui.ts` 的 runComfyGeneration）',
      'protocol',
    )
  }

  /* ② 能力匹配（在最前面：省掉一次白跑的上游请求）。 */
  assertCapability(ch, req.model, req.kind)

  /* ②b `op` 与 `mask` 只有 ComfyUI 那条路认（契约 T1）。
   *
   * 网络模型的 API 里没有「遮罩」这个参数、也没有「超分 / 多角度」这种操作 ——
   * 它们就是「给提示词、给参考图、拿回图」。静默忽略会让用户以为「我抹了遮罩
   * 结果没生效」，所以这里明确拒绝。
   *
   * ⚠️ `caption`（反推提示词）不一样：它 kind 是 `text`、不需要遮罩，
   * Gemini 那条路能做（带图问答），所以不在这里拦。 */
  if (req.op !== undefined && req.op !== 'caption' && req.kind !== 'text') {
    throw new GenError(
      '渠道「' + ch.name + '」是网络模型（' + ch.protocol + '），做不了「' + req.op + '」这类图像操作：'
      + '它的 API 只有「生成 / 编辑」，没有超分、多角度、局部重绘。'
      + '这类操作用 ComfyUI 渠道（它走的是槽位工作流，能挂对应的工作流）。',
      'unsupported',
    )
  }
  if (req.mask !== undefined) {
    throw new GenError(
      '渠道「' + ch.name + '」是网络模型（' + ch.protocol + '），它的 API 没有「遮罩」这个参数：'
      + '局部重绘要用 ComfyUI 渠道（那份工作流里有 ref_mask 槽位）。',
      'unsupported',
    )
  }

  /* ③ 按协议 + 能力分派。 */
  if (ch.protocol === 'openai') {
    if (req.kind === 'image') {
      const refs = req.refs ?? []
      /* 有参考图 → 走 edits（multipart）；没有 → 走 generations（JSON）。
       * 这与参考项目 `image.ts:59` 的 `requestEdit` 是同一条判据。 */
      return refs.length > 0
        ? editOpenAiImage(ch, key, req, fetchImpl)
        : generateOpenAiImage(ch, key, req, fetchImpl)
    }
    if (req.kind === 'video') return generateOpenAiVideo(ch, key, req, fetchImpl, req.sleep)
    throw new GenError(
      'OpenAI 协议这一版只做了「图像生成 / 图像编辑 / 视频」三件，'
      + '文字请用 dsh 自己的模型（`ai.agent` 节点）。收到：' + req.kind,
      'unsupported',
    )
  }

  if (ch.protocol === 'gemini') {
    /* Gemini 的 generateContent 一件事同时能做文字与图（靠 responseModalities 区分），
     * 所以图像与文字合在一条路上。视频不走它（参考项目也是明确不支持）。 */
    if (req.kind === 'image' || req.kind === 'text') return generateGemini(ch, key, req, fetchImpl)
    throw new GenError(
      'Gemini 协议这一版只做了「图像生成 / 文字」，视频它不支持（参考项目同样不支持）。收到：' + req.kind,
      'unsupported',
    )
  }

  throw new GenError('不认识的协议：' + String(ch.protocol), 'protocol')
}

/**
 * 把一份上游给的 base64 或网址变成字节。
 *
 * 为什么要它：OpenAI 的 `images/generations` 可能回 `b64_json`（内容是 base64）
 * 也可能回 `url`（要再取一次）。两条都要支持 —— 只支持一条的话，
 * 换一个上游就「生成了但拿不到图」。
 *
 * @param b64 - base64 文本（可带 `data:` 前缀）。
 * @param url - 网址（`b64` 没给时才用）。
 * @param fetchImpl - 注入的 fetch。
 * @param signal - 取消信号。
 * @returns mime 与字节。
 * @throws 两个都没给、或网址取回来是空的。
 */
export async function itemFromB64OrUrl(
  b64: string | undefined, url: string | undefined, fetchImpl?: typeof fetch, signal?: AbortSignal,
): Promise<GenItem> {
  if (typeof b64 === 'string' && b64 !== '') {
    /* 有的上游把前缀也塞进来（`data:image/png;base64,xxx`），拆掉再解码。 */
    const m = /^data:([^;]+);base64,(.*)$/.exec(b64)
    if (m !== null) return { mime: m[1], bytes: Buffer.from(m[2], 'base64') }
    return { mime: 'image/png', bytes: Buffer.from(b64, 'base64') }
  }
  if (typeof url === 'string' && url !== '') {
    const doFetch = fetchImpl ?? fetch
    const res = await doFetch(url, signal === undefined ? {} : { signal })
    if (!res.ok) throw new GenError('取产出网址失败：' + String(res.status) + ' ' + url, 'upstream')
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) throw new GenError('取回来的产出是空的：' + url, 'upstream')
    const ct = res.headers.get('content-type') ?? ''
    return { mime: ct !== '' ? ct.split(';')[0].trim() : guessFromUrl(url), bytes }
  }
  throw new GenError('上游既没给 base64 也没给网址，拿不到产出', 'upstream')
}

/**
 * 按网址猜 mime（拿不到 `content-type` 时的兜底）。
 * @param url - 网址。
 * @returns mime；猜不到给 `application/octet-stream`。
 */
export function guessFromUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0]
  const ext = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : ''
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  }
  return table[ext] ?? 'application/octet-stream'
}

/**
 * 把上游的错误响应读成一句人话。
 *
 * 上游的错误体形状各家不同（`{error:{message}}` / `{error:"..."}` / `{message}` / 纯文本），
 * 但**原文必须带出来** —— 用户拿着「400」没法查，拿着
 * 「400：model does not support image input」能查。
 *
 * @param res - 响应。
 * @returns 说明。
 */
export async function readUpstreamError(res: Response): Promise<string> {
  let text = ''
  try { text = await res.text() } catch { return String(res.status) }
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const err = body.error
    if (typeof err === 'string' && err !== '') return err
    if (typeof err === 'object' && err !== null) {
      const msg = (err as Record<string, unknown>).message
      if (typeof msg === 'string' && msg !== '') return msg
    }
    if (typeof body.message === 'string' && body.message !== '') return body.message
  } catch { /* 不是 JSON，用原文 */ }
  /* 纯文本错误体：截一段就够（有的上游会回一整页 HTML）。 */
  return text.slice(0, 300)
}
