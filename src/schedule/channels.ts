/** 模型渠道表与密钥（宿主半，契约 AX，2026-10-25）。
 *
 * ## 为什么要「两张表」
 *
 * 计划 §三 2.1 的硬要求：**密钥不进前端**。前端要读渠道（显示名字、协议、模型），
 * 但绝不能读到 `sk-...`。所以分成两个文件：
 *
 * ```
 * channels.json         渠道定义（可回给前端，绝不含密钥）
 * channels.secret.json  只有宿主读：{ "<渠道 id>": "sk-..." }
 * ```
 *
 * 为什么不塞进一个文件、读的时候挑字段：**一个字段忘了删就泄一次**。
 * 分成两个文件之后，「回给前端的那份」在磁盘上就不含密钥，漏删也无从泄起。
 *
 * ## 读回来的 `hasKey`
 *
 * 前端需要知道「这条渠道配过密钥没有」（界面上显示「已配置 / 未配置」），
 * 但只能知道**有没有**，不能知道是什么。所以 `readChannelsWithKey()` 返回的每条
 * 带一个布尔值，密钥本体留在 `readChannelSecrets()` 里、只有宿主自己用。
 *
 * ## 目录
 *
 * 与 `workflows/` 同级（`dataRoot()`），沙箱判断在 `artifacts.ts` 那一层做过了。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from './artifacts.ts'
import { MODEL_TYPES } from './model-types.ts'

/** 允许的协议三种。`gemini` 本期只存不调用（计划 §三 2.1）。 */
export const PROTOCOLS = ['openai', 'comfyui', 'gemini'] as const

/** 协议。 */
export type ChannelProtocol = typeof PROTOCOLS[number]

/** 模型能力的闭集（计划里只有这四类；界面按它过滤可选项）。 */
export const CAPS = ['image', 'video', 'text', 'audio'] as const

/** 一个模型。 */
export interface ChannelModel {
  /** 模型 id（发给上游的那个名字）。 */
  id: string
  /** 显示名。 */
  label: string
  /** 能力标记（可多选）。 */
  caps: string[]
  /**
   * 这条模型在界面上算哪几类（票 67，2026-10-29）。
   *
   * ## ⚠️ 必须可选
   *
   * 这次改动之前存下的渠道没有这个键，而 `caps` 那一套已经够用
   * （五类里四类能推出来）。改成必填，老渠道读出来就缺键报错 ——
   * 那是静默的数据迁移，本项目踩过（契约 AD）。
   *
   * 缺省时由 `model-types.ts` 的 `typesOfModel()` 从 `caps` 推导，
   * **推导不写回磁盘**。取值见 `MODEL_TYPES`。
   */
  types?: string[]
}

/** 一条渠道（**不含密钥**）。 */
export interface Channel {
  /** 渠道 id（`[A-Za-z0-9_-]`）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 协议。 */
  protocol: ChannelProtocol
  /** 接口地址（`comfyui` 是本地地址，其余是 API 根）。 */
  baseUrl: string
  /** 模型列表。 */
  models: ChannelModel[]
  /** 这个渠道最多同时跑几个（默认 5，计划 §三 2.2）。 */
  maxConcurrency: number
  /* ── 以下 14 个是契约 CA（2026-10-26）加的，**全部可选** ──────────────
   *
   * 形状照参考项目 `stores/use-config-store.ts:86-108` 的 `ModelChannel`。
   * 为什么挂在渠道上而不是模型上：同一台 ComfyUI 上那 16 份工作流由**渠道**决定用哪份，
   * 模型只是「这一类的名字」（参考项目也是这么分的）。
   *
   * ⚠️ **必须全部可选**：这次改动之前存下的渠道没有这些键。
   * 读的时候照旧能读，缺的键交给上层回落内置默认
   * （见 `comfyui-workflows/registry.ts` 的 `defaultWorkflowOf`）。
   * 把其中任何一个改成必填，老渠道读出来就会缺键报错 —— 那是静默的数据迁移，
   * 本项目踩过（契约 AD 那次）。 */

  /**
   * ComfyUI 走代理时的地址（可选）。
   *
   * 参考项目是浏览器，要绕 CORS 才需要它。我们是宿主，**空着就直连**；
   * 字段留着是因为上游配置面有它，以后接远端 ComfyUI 时用得上。
   */
  comfyuiProxyUrl?: string
  /** 走代理时的 token（可选，与上面的地址配套）。 */
  comfyuiProxyToken?: string
  /** 用户自定义的工作流清单（可选；内置的那些在 `comfyui-workflows/`）。 */
  workflows?: unknown[]
  /** 文生图用哪份工作流。 */
  comfyuiT2iWorkflow?: unknown
  /** 图生图。 */
  comfyuiI2iWorkflow?: unknown
  /** 局部编辑。 */
  comfyuiInpaintWorkflow?: unknown
  /** 文生文本。 */
  comfyuiTextWorkflow?: unknown
  /** 全能参考视频。 */
  comfyuiVideoWorkflow?: unknown
  /** 首尾帧视频。 */
  comfyuiFrameVideoWorkflow?: unknown
  /** 超分。 */
  comfyuiSuperResolveWorkflow?: unknown
  /** 多角度。 */
  comfyuiAngleWorkflow?: unknown
  /** 放大。 */
  comfyuiUpscaleWorkflow?: unknown
  /** 音频。 */
  comfyuiAudioWorkflow?: unknown
  /** 人脸修复。 */
  comfyuiFaceRefineWorkflow?: unknown
  /** 深度视频。 */
  comfyuiDepthVideoWorkflow?: unknown
}

/** 回给前端的渠道（多一个「配没配密钥」）。 */
export interface ChannelWithKey extends Channel {
  /** 配过密钥就 true。**只有这个布尔值，没有任何密钥信息**。 */
  hasKey: boolean
}

/**
 * 14 个 ComfyUI 工作流字段的键名（契约 CA）。
 *
 * 为什么列成常量：`normalizeChannel` 要按同一份清单「读请求 / 沿用旧值」，
 * 手写 14 遍必然漏一个 —— 而漏掉的那个字段的表现是「保存完就没了」，
 * 用户会以为程序不记配置。
 */
const CHANNEL_WORKFLOW_KEYS: (keyof Channel)[] = [
  'comfyuiProxyUrl', 'comfyuiProxyToken', 'workflows',
  'comfyuiT2iWorkflow', 'comfyuiI2iWorkflow', 'comfyuiInpaintWorkflow', 'comfyuiTextWorkflow',
  'comfyuiVideoWorkflow', 'comfyuiFrameVideoWorkflow', 'comfyuiSuperResolveWorkflow',
  'comfyuiAngleWorkflow', 'comfyuiUpscaleWorkflow', 'comfyuiAudioWorkflow',
  'comfyuiFaceRefineWorkflow', 'comfyuiDepthVideoWorkflow',
]

/** 数据文件里的非法记录：读的时候跳过，不整份失败。 */
function channelsFile(): string {
  return join(dataRoot(), 'channels.json')
}

/** 密钥文件路径（只有宿主读）。 */
export function channelSecretFile(): string {
  return join(dataRoot(), 'channels.secret.json')
}

/** id 的合法形状。**这是安全边界**：id 会进 URL，也会进密钥表的键。 */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/

/**
 * id 合不合法。
 * @param id - 待查 id。
 * @returns 合法为 true。
 */
export function isChannelId(id: string): boolean {
  return ID_OK.test(id)
}

/** 校验结论。 */
export type NormalizeResult =
  | { ok: true, channel: Channel }
  | { ok: false, error: string }

/**
 * 把请求体归一成一条渠道（**纯函数**，不碰磁盘 —— 所以好单测）。
 *
 * ## 校验（缺一条就 400，不静默兜底）
 *
 * - `id`：只许 `[A-Za-z0-9_-]`；不给就现造一个 `ch_` 开头的。
 * - `protocol`：必须在三种里。**不认识就报错**，不猜一个默认协议 ——
 *   猜错会让一条本该直连 ComfyUI 的渠道去说 OpenAI 的话。
 * - `baseUrl`：空串报错（没有地址这条渠道根本用不了，存下来只是让人以后踩）。
 * - `maxConcurrency`：正整数，缺省 5，上限 50（防手滑填成 5000）。
 *
 * @param raw - 请求体。
 * @param prior - 更新时传旧记录（没给的字段沿用旧值）。
 * @returns 归一后的渠道，或一条人看得懂的错误。
 */
export function normalizeChannel(raw: Record<string, unknown>, prior?: Channel): NormalizeResult {
  const str = (k: string): string => typeof raw[k] === 'string' ? (raw[k] as string).trim() : ''

  const rawId = str('id') !== '' ? str('id') : prior?.id ?? ''
  const id = rawId !== '' ? rawId : 'ch_' + Math.random().toString(36).slice(2, 10)
  if (!isChannelId(id)) return { ok: false, error: '渠道 id 只能用字母、数字、下划线、短横线：' + id }

  const protocol = str('protocol') !== '' ? str('protocol') : prior?.protocol ?? ''
  if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
    return { ok: false, error: '协议只能是 openai / comfyui / gemini，收到：' + (protocol === '' ? '（空）' : protocol) }
  }

  const baseUrl = str('baseUrl') !== '' ? str('baseUrl') : prior?.baseUrl ?? ''
  if (baseUrl === '') return { ok: false, error: '接口地址不能为空' }

  const name = str('name') !== '' ? str('name') : prior?.name ?? id

  /* 模型列表：给了就按形状收，坏条目**跳过**而不是整条渠道报错
   * （一个模型 id 写错不该让整条渠道存不进去）。没给就沿用旧值。
   *
   * ## 两种形状都收（2026-10-26，T-B-后端）
   *
   * 界面上一直是「一行一个模型」的**文本**（`ChannelSettings.tsx` 的 `parseModels`
   * 拆 `"gpt-image-1|GPT Image|image,video"`）。现在拉了模型之后要能**勾选**，
   * 勾出来的是结构化形状 `{ id, label, caps }`。
   *
   * 所以：
   * - 字符串项 `"gpt-image-1|GPS Image|image"` → 按那个格式拆开收进来；
   * - 对象项 `{ id, label, caps }` → 原样收。
   *
   * **老渠道（全是对象）照旧**，一个字段都不变；新界面可以只发字符串，也可以只发对象。
   * 为什么不强制统一成一种：老渠道存在磁盘上了，强制某种形状就等于要写一次迁移 ——
   * 而这次改动不该让任何已存的渠道读不出来。 */
  const models: ChannelModel[] = []
  /** 拆一条字符串写法 `id|显示名|能力,能力`（界面一直在用这个格式）。 */
  const pushText = (line: string): void => {
    const raw = line.trim()
    if (raw === '') return
    const [idPart, labelPart, capsPart] = raw.split('|')
    const mid = (idPart ?? '').trim()
    if (mid === '') return
    models.push({
      id: mid,
      label: (labelPart ?? '').trim() === '' ? mid : (labelPart ?? '').trim(),
      caps: (capsPart ?? '').split(',')
        .map(s => s.trim())
        .filter((c): c is string => c !== '' && (CAPS as readonly string[]).includes(c)),
    })
  }
  if (Array.isArray(raw.models)) {
    for (const m of raw.models) {
      /* 字符串项：界面那条文本格式。 */
      if (typeof m === 'string') { pushText(m); continue }
      if (typeof m !== 'object' || m === null) continue
      const rec = m as Record<string, unknown>
      const mid = typeof rec.id === 'string' ? rec.id.trim() : ''
      if (mid === '') continue
      const one: ChannelModel = {
        id: mid,
        label: typeof rec.label === 'string' && rec.label.trim() !== '' ? rec.label.trim() : mid,
        caps: Array.isArray(rec.caps)
          ? rec.caps.filter((c): c is string => typeof c === 'string' && (CAPS as readonly string[]).includes(c))
          : [],
      }
      /* `types`（票 67）：**给了才写这个键**。
       *
       * 为什么不给就写一份推导结果：写回就是静默改用户数据。
       * 「没给」的语义是「按 caps 推导」，这件事在读的时候做（`typesOfModel`），
       * 不是在这里落盘。老渠道读出来再存回去，也不会凭空多出这个键。
       *
       * 过滤用 `MODEL_TYPES`（五值），与 `caps` 那条用 `CAPS`（四值）各管各的。 */
      if (Array.isArray(rec.types)) {
        one.types = MODEL_TYPES.filter(t => (rec.types as unknown[]).includes(t))
      }
      models.push(one)
    }
  } else if (typeof raw.models === 'string') {
    /* 整段文本（多行）也给：有些调用方直接发草稿里的那段字。 */
    for (const line of raw.models.split('\n')) pushText(line)
  } else if (prior !== undefined) {
    models.push(...prior.models)
  }

  const rawMax = raw.maxConcurrency
  const maxConcurrency = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
    ? Math.min(50, Math.floor(rawMax))
    : prior?.maxConcurrency ?? 5

  /* ## 14 个工作流字段的读法（契约 CA）：有就保留原样，没有就不写这个键
   *
   * 为什么原样保留而不是做形状校验：这些字段存的是整份 ComfyUI 工作流 JSON，
   * 形状由 ComfyUI 决定、不由我们决定。在这里校验等于多一道会漂的判据 ——
   * 真正的校验在提交前那一步（`validateComfyWorkflow`），那里才知道类别。
   *
   * ⚠️ 只在**两种来源都有值**时沿用旧值：请求里给了就用请求的
   * （包括给 `null` 表示「清掉这份、回到内置默认」）。 */
  const optional: Partial<Channel> = {}
  const carry = (k: keyof Channel): void => {
    const fromReq = raw[k as string]
    if (fromReq !== undefined) {
      /* `null` 是明确的「清掉」→ 不写这个键（= 回落到内置默认）。 */
      if (fromReq !== null) (optional as Record<string, unknown>)[k as string] = fromReq
      return
    }
    const fromPrior = prior === undefined ? undefined : (prior as unknown as Record<string, unknown>)[k as string]
    if (fromPrior !== undefined) (optional as Record<string, unknown>)[k as string] = fromPrior
  }
  for (const k of CHANNEL_WORKFLOW_KEYS) carry(k)

  return {
    ok: true,
    channel: {
      id, name, protocol: protocol as ChannelProtocol, baseUrl, models, maxConcurrency,
      ...optional,
    },
  }
}

/**
 * 读渠道表（不含密钥）。
 *
 * 文件不存在给空数组；坏 JSON 也给空数组 —— 但**不覆盖**那个坏文件
 * （下一步保存时才会重写，这样坏内容还留着能人工看一眼）。
 *
 * @returns 渠道数组。
 */
export async function readChannels(): Promise<Channel[]> {
  let text: string
  try {
    text = await readFile(channelsFile(), 'utf8')
  } catch { return [] }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: Channel[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    /* 单条坏记录跳过：一条写坏的渠道不该让整张表读不出来。 */
    const n = normalizeChannel(item as Record<string, unknown>)
    if (n.ok) out.push(n.channel)
  }
  return out
}

/**
 * 读密钥表（**只有宿主用**）。
 * @returns `{ 渠道 id: 密钥 }`；文件不存在给空对象。
 */
export async function readChannelSecrets(): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(channelSecretFile(), 'utf8')
  } catch { return {} }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return {} }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

/**
 * 取一条渠道的密钥（宿主调上游时用）。
 * @param id - 渠道 id。
 * @returns 密钥；没配给空串。
 */
export async function channelKey(id: string): Promise<string> {
  return (await readChannelSecrets())[id] ?? ''
}

/**
 * 读渠道表并附上 `hasKey`（**回给前端的那一份**）。
 *
 * ⚠️ 这里只读密钥表的**键**，从来不改写、也不把值放进返回值。
 * @returns 渠道数组。
 */
export async function readChannelsWithKey(): Promise<ChannelWithKey[]> {
  const [channels, secrets] = await Promise.all([readChannels(), readChannelSecrets()])
  return channels.map(c => ({ ...c, hasKey: (secrets[c.id] ?? '') !== '' }))
}

/**
 * 写密钥表（内部用）。
 * @param secrets - 整份密钥表。
 */
async function writeSecrets(secrets: Record<string, string>): Promise<void> {
  await mkdir(dataRoot(), { recursive: true })
  await writeFile(channelSecretFile(), JSON.stringify(secrets, null, 2), 'utf8')
}

/**
 * 新建或更新一条渠道。
 *
 * ## 密钥的三个语义（这是最容易做歪的一处）
 *
 * | 请求里 | 结果 |
 * |---|---|
 * | 带 `apiKey: "sk-..."` | 写进密钥表（**不进 channels.json**） |
 * | 带 `apiKey: ""`（空串） | 只清掉旧密钥？**不** —— 见下 |
 * | 不带 `apiKey` 键 | 旧密钥原样保留（改名字不该把密钥弄丢） |
 *
 * 空串按「没带」处理：界面上「名字留给空」这类误操作不该把已经配好的密钥删掉。
 * 要真的删密钥，走 `DELETE /channels/<id>`（整条渠道一起删）。
 *
 * @param raw - 请求体。
 * @returns 存好的渠道（含 `hasKey`），或错误。
 */
export async function saveChannel(
  raw: Record<string, unknown>,
): Promise<{ ok: true, channel: ChannelWithKey } | { ok: false, error: string }> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '请求体要是一个对象' }
  const all = await readChannels()
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''
  const prior = rawId === '' ? undefined : all.find(c => c.id === rawId)
  const n = normalizeChannel(raw, prior)
  /* ⚠️ 用 `in` 判而不是 `n.ok` 判别式：本项目 `tsconfig` 是 `strict: false`，
   * 关掉 `strictNullChecks` 之后可判别联合**不会收窄** —— `n.error` 会报
   * 「Property 'error' does not exist」。`in` 在这个配置下正常。 */
  if ('error' in n) return { ok: false, error: n.error }

  /* 同 id 覆盖，新 id 追加（顺序即界面上的顺序）。 */
  const next = all.some(c => c.id === n.channel.id)
    ? all.map(c => c.id === n.channel.id ? n.channel : c)
    : [...all, n.channel]
  await mkdir(dataRoot(), { recursive: true })
  await writeFile(channelsFile(), JSON.stringify(next, null, 2), 'utf8')

  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  if (apiKey !== '') {
    const secrets = await readChannelSecrets()
    secrets[n.channel.id] = apiKey
    await writeSecrets(secrets)
  }
  const secrets = await readChannelSecrets()
  return { ok: true, channel: { ...n.channel, hasKey: (secrets[n.channel.id] ?? '') !== '' } }
}

/**
 * 删一条渠道，**同时删它的密钥**。
 *
 * 为什么密钥一定要跟着删：不删的话，下次新建一条同名 id 的渠道会**凭空带上旧密钥**
 * ——用户看到「没配密钥」却能用，排查时完全想不到原因。
 *
 * @param id - 渠道 id。
 * @returns 删掉了就 true（本来就没有给 false，调用方据此回 404）。
 */
export async function deleteChannel(id: string): Promise<boolean> {
  const all = await readChannels()
  const next = all.filter(c => c.id !== id)
  const removed = next.length !== all.length
  if (removed) {
    await mkdir(dataRoot(), { recursive: true })
    await writeFile(channelsFile(), JSON.stringify(next, null, 2), 'utf8')
  }
  const secrets = await readChannelSecrets()
  if (secrets[id] !== undefined) {
    delete secrets[id]
    await writeSecrets(secrets)
  }
  return removed
}
