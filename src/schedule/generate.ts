/** 一次生成的任务编排（契约 CC，2026-10-26）。
 *
 * ## 它解决什么问题
 *
 * CA（ComfyUI）与 CB（网络模型）两条能力都做完了，但它们都是「一次 await 到结果」。
 * 视频一条十几分钟 —— 界面发一个 HTTP 请求挂在那里等十几分钟是不可接受的。
 *
 * 所以这一层把一次生成**拆成「提交」与「查进度」两半**：
 *
 * ```
 * POST /generate          立刻回一个任务 id（此刻状态 submitted）
 * GET  /generate/:id      轮询：submitted → running → success / failed
 * POST /generate/:id/cancel  取消（真的 abort 掉上游）
 * ```
 *
 * 参考项目不做这件事，因为它在浏览器里、可以直接 await（`requestComfyuiVideo`
 * 就是个长 Promise）。我们是宿主，长任务必须能拆开 —— 这是**唯一一处必须
 * 与参考项目不同**的地方，不是另起一套。
 *
 * ## 一次生成的六步（顺序固定）
 *
 * 1. 选渠道（按 `caps` 找能做的；请求指定了就只用那个）
 * 2. 限流（`runInChannel`）—— **两条协议都受渠道上限约束，但闸门位置不同**：
 *    ComfyUI 那层在 `runComfyGeneration` 内部（`comfyui.ts:952`），
 *    网络模型这一层在这一文件里（`:382`）。为什么不能两边都套，见 `runTask` ③。
 * 3. 调对的那条路（`comfyui` → `runComfyGeneration`；`openai`/`gemini` → `generateOnChannel`）
 * 4. 存产物（每个字节进 `artifacts/`）
 * 5. 写生成记录（`writeGenLog`）
 * 6. 全程回调进度
 *
 * ## 任务只在内存里
 *
 * 重启就清。为什么不做持久化：生成记录（`gen-logs/`）已经把「要了什么、得到了什么」
 * 落盘了，那是历史事实；而「这次跑到哪一步了」是**进程内的瞬时状态**，
 * 重启后本来就不该恢复 —— 恢复一个已经没有进程在跑的「运行中」任务，
 * 只会让界面显示一个永远不动的东西。这与定时任务那次（契约 AD）的判断一致。
 */
import { readChannels, channelKey } from './channels.ts'
import { runInChannel } from './channel-queue.ts'
import {
  runComfyGeneration, parseSize, type ComfyGenResult, type ComfyWorkflow, type ComfyBindings,
  type ComfyState,
} from './comfyui.ts'
/* 连接参数的类型在 HTTP 那个文件里（`comfyui.ts` 只是 re-import 了其中的函数）。 */
import type { ComfyHttpOptions } from './comfyui-http.ts'
import { defaultWorkflowOf, type WorkflowCategory } from './comfyui-workflows/registry.ts'
import { generateOnChannel, GenError, type GenKind, type GenOp, type GenRequest } from './net-gen.ts'
import { storeArtifact } from './artifacts.ts'
import { writeGenLog, type GenLog } from './gen-logs.ts'
import { readModelDefaults, defaultOf } from './model-defaults.ts'
/* 五类的中文名**只在这一处定义**（`model-types.ts`）。
 * 为什么不在这里另抄一份：票 67 之前这里有一份 `KIND_LABEL`，票 67 又在
 * `model-types.ts` 建了一份 `MODEL_TYPE_LABEL` —— 两份一漂，同一件事就有两个名字，
 * 用户对不上报错里那句话（`pitfalls/同一件事写两份迟早漂.md`）。
 * 现在只留后端一份、界面（票 68）自己管显示，报错文案从这一份取。 */
import { MODEL_TYPE_LABEL, typesOfModel } from './model-types.ts'
import { newRunId } from '../workflow/workflow-runs.ts'

/** 任务状态（就是四态：提交了 / 在跑 / 成了 / 没成）。 */
export type TaskStatus = 'submitted' | 'running' | 'success' | 'failed'

/** 一次生成的结果里，一个产物的简化形状（回给界面用）。 */
export interface TaskArtifact {
  /** 产物 id（拼 `url` 用）。 */
  id: string
  /** mime。 */
  mime: string
  /** 字节数。 */
  bytes: number
  /** 直接能塞 `<img src>` 的地址。 */
  url: string
  /** 宽（图片有）。 */
  width?: number
  /** 高。 */
  height?: number
}

/** 进度的一步（**记下来是为了能断言「确实经过了哪几步」** —— 只存最新状态的话，
 * 测试只能看到终态，中间经过什么全靠猜）。 */
export interface TaskStep {
  /** 什么时候。 */
  at: number
  /** 当时的状态。 */
  status: TaskStatus
  /** 当时的阶段名（`submitted` / `queued` / `running` / `storing` / `done`）。 */
  stage: string
  /** 附注（可读的一句）。 */
  note?: string
}

/** 一个生成任务（内存里的一条）。 */
export interface GenerateTask {
  /** 任务 id（同时也是这次生成的记录 id）。 */
  id: string
  /** 要生成什么。 */
  kind: GenKind
  /** 状态。 */
  status: TaskStatus
  /** 现在到了哪一步。 */
  stage: string
  /** 提示词原文。 */
  prompt: string
  /** 模型 id。 */
  model: string
  /** 渠道 id。 */
  channelId: string
  /** 渠道显示名（界面直接显示，不必再查一次渠道表）。 */
  channelName: string
  /** 提交时间。 */
  createdAt: number
  /** 结束时间（没结束就不写这个键）。 */
  endedAt?: number
  /** 已经等了多久（ms，轮询时更新）。 */
  waitedMs: number
  /** 产物。 */
  artifacts: TaskArtifact[]
  /** 失败原因。 */
  error?: string
  /**
   * 这次实际用的随机种子（票 08）。
   *
   * 为什么要在任务上留一份：生成记录（`gen-logs/`）里的 `params.seed` 是它写的，
   * 而「这张图用的哪个种子」是用户想「换个种子再来一张」时的唯一线索。
   * 只有真用上种子的那条路（ComfyUI）才会写这个键 —— 网络模型的接口没有种子参数。
   */
  seed?: number
  /** 走过的每一步（见 `TaskStep` 的说明）。 */
  history: TaskStep[]
}

/** 可注入的依赖（**只给测试用**：塞假 fetch、假等待，不真连服务）。 */
export interface GenerateDeps {
  /** 网络模型那条路用的 fetch。 */
  netFetch?: typeof fetch
  /** ComfyUI 那条路的连接参数（`fetchImpl` 在这里面）。 */
  comfyHttp?: Partial<ComfyHttpOptions>
  /** 等待实现（ComfyUI 轮询用，测试注入不真睡的）。 */
  sleep?: (ms: number) => Promise<void>
}

/** 注入的依赖（模块级；`null` 表示用真实实现）。 */
let deps: GenerateDeps = {}

/**
 * 换掉依赖（**只给测试用**）。
 *
 * @param next - 新依赖；传 `null` 恢复真实实现。
 */
export function setGenerateDeps(next: GenerateDeps | null): void {
  deps = next ?? {}
}

/** 任务表（内存）。 */
const tasks = new Map<string, GenerateTask>()
/** 每个任务的取消器。 */
const cancels = new Map<string, AbortController>()
/** 任务表最多留多少条（界面只看最近的；不设上限会一直涨）。 */
const MAX_TASKS = 200

/**
 * 种子取值上界（票 08）。
 *
 * ComfyUI 的 `seed` 是 uint32，`2**32 - 1` 是它能收的最大值。
 * 写成 `Math.random() * 1e6` 那种也能跑，但那是**另一个取值范围** ——
 * 用户从 ComfyUI 界面上抄来的种子可能超出它，抄回来就不对了。
 */
export const SEED_MAX = 2 ** 32 - 1

/**
 * 取一个随机种子（票 08，2026-10-30）。
 *
 * ## 为什么需要它
 *
 * ComfyUI 那条路上的种子此前从请求到工作流**整段断着**：`GenerateInput` 没有
 * `seed`、`bindings` 不填 `seed`，工作流里那个写死的数永远不变。于是同一句
 * 提示词重跑 → 同一张图，ComfyUI 甚至直接命中缓存（实测第一次 4.06 秒、
 * 第二次 0.02 秒、产物字节完全相同）。用户点「重新生成」以为按钮坏了。
 *
 * ## 只在这一层取一次
 *
 * 随机必须只取一次、取完就写进生成记录（`logOf`）。取两次的地方一旦分开
 * （比如这里取一次、记录里再取一次），记录里那个数就不再是这张图实际用的那个，
 * 「换个种子再来一张」就成了碰运气 —— 那与本票要消灭的病同形。
 *
 * @returns `0 ~ 2**32-1` 之间的整数。
 */
export function pickSeed(): number {
  /* `Math.random()` 取不到 1，所以 `+ 1` 之后 `SEED_MAX` 本身也在范围内。 */
  return Math.floor(Math.random() * (SEED_MAX + 1))
}

/**
 * 清空任务表（**只给测试用**）。
 *
 * 为什么需要：模块级的表是长寿命的，前一段测试留下的任务会让后一段的
 * 「列最近任务」断言数不对。
 */
export function resetGenerateForTest(): void {
  for (const ac of cancels.values()) ac.abort()
  tasks.clear()
  cancels.clear()
}

/**
 * 记一步进度（同时更新状态与阶段）。
 *
 * @param task - 任务。
 * @param status - 状态。
 * @param stage - 阶段名。
 * @param note - 附注。
 */
function step(task: GenerateTask, status: TaskStatus, stage: string, note?: string): void {
  task.status = status
  task.stage = stage
  task.history.push({
    at: Date.now(), status, stage, ...note === undefined ? {} : { note },
  })
}

/**
 * 把一种生成能力对到 ComfyUI 的工作流类别上。
 *
 * 为什么图像要分「有参考图 / 没参考图」：这两件事在 ComfyUI 里是两份工作流
 * （`t2i` 文生图 / `i2i` 图生图），槽位不一样（图生图要 `ref_image_01`）。
 * 分错了的表现是「提交被拒：缺少 ref_image 槽位」。
 *
 * ## `op` 优先（契约 T1，2026-10-26）
 *
 * 给了 `op` 就按操作定类别，**不看 `kind` 与 `hasRefs`**：
 * 「在图上局部重绘」与「文生图 / 图生图」是三种不同的工作流，
 * 靠 `hasRefs` 猜不出来（局部重绘也有参考图）。
 *
 * **不给 `op` 时行为一字不变** —— 这是加这个参数时的硬约束。
 *
 * @param kind - 生成什么。
 * @param hasRefs - 带没带参考图。
 * @param op - 对已有的图做什么操作（可选）。
 * @returns 工作流类别。
 */
export function categoryOf(kind: GenKind, hasRefs: boolean, op?: GenOp): WorkflowCategory {
  /* ① 操作优先。 */
  if (op !== undefined) {
    const byOp: Record<GenOp, WorkflowCategory> = {
      inpaint: 'inpaint',
      upscale: 'upscale',
      superResolve: 'superResolve',
      /* 反推提示词在 ComfyUI 里就是「文本工作流」那一份（图进去、提示词出来）。 */
      caption: 'text',
      angle: 'angle',
    }
    const mapped = byOp[op]
    if (mapped !== undefined) return mapped
  }
  /* ② 没给 op：与加 op 之前逐字一致。 */
  if (kind === 'image') return hasRefs ? 'i2i' : 't2i'
  if (kind === 'video') return 'omniVideo'
  if (kind === 'audio') return 'audio'
  return 'text'
}

/** 类别的中文名（报错文案里用 —— 说「超分」比说 `superResolve` 好懂）。 */
const CATEGORY_LABEL: Record<string, string> = {
  t2i: '文生图',
  i2i: '图生图',
  inpaint: '局部重绘',
  text: '文本',
  omniVideo: '全能参考视频',
  frameVideo: '首尾帧视频',
  audio: '音频',
  faceRefine: '人脸修复',
  depthVideo: '深度视频',
  superResolve: '超分',
  angle: '多角度',
  upscale: '放大',
}

/** 类别 → 渠道上那个字段名（照参考 `use-config-store.ts:41-54` 的映射）。 */
const CATEGORY_FIELD: Record<string, string> = {
  t2i: 'comfyuiT2iWorkflow',
  i2i: 'comfyuiI2iWorkflow',
  inpaint: 'comfyuiInpaintWorkflow',
  text: 'comfyuiTextWorkflow',
  omniVideo: 'comfyuiVideoWorkflow',
  frameVideo: 'comfyuiFrameVideoWorkflow',
  audio: 'comfyuiAudioWorkflow',
  faceRefine: 'comfyuiFaceRefineWorkflow',
  depthVideo: 'comfyuiDepthVideoWorkflow',
  superResolve: 'comfyuiSuperResolveWorkflow',
  angle: 'comfyuiAngleWorkflow',
  upscale: 'comfyuiUpscaleWorkflow',
}

/**
 * 取这次要用的 ComfyUI 工作流：渠道配了就用渠道的，没配就用内置默认。
 *
 * @param channel - 渠道（`comfyui*Workflow` 字段是契约 CA 加的）。
 * @param category - 类别。
 * @returns 工作流；这一类既没配也没有内置 → `null`（调用方要转成一句人话，见 `workflowMissingWhy`）。
 */
export function pickWorkflow(channel: Record<string, unknown>, category: WorkflowCategory): ComfyWorkflow | null {
  const field = CATEGORY_FIELD[category]
  const own = field === undefined ? undefined : channel[field]
  /* 渠道自己配的那份：可能是 `{name, json}` 也可能是裸 JSON（用户导入的形状不统一），
   * 两种都认 —— 只认一种的话，配了工作流却「说没配」。 */
  if (typeof own === 'object' && own !== null) {
    const rec = own as Record<string, unknown>
    if (typeof rec.json === 'object' && rec.json !== null) return rec.json as ComfyWorkflow
    if (Object.keys(rec).length > 0) return rec as ComfyWorkflow
  }
  const builtin = defaultWorkflowOf(category)
  return builtin === undefined ? null : builtin.json
}

/**
 * 「这一类没有工作流」时该怎么说（契约 T1）。
 *
 * ## 为什么单拆一个函数
 *
 * `superResolve` / `angle` / `upscale` 这三类**内置清单里没有 JSON**
 * （`comfyui-workflows/registry.ts` 的文件头写明了：参考项目里它们由用户自己导入）。
 * 所以「渠道没配」是这三类的**正常状态**，不是配置出错 —— 但用户点下去必须看懂
 * 「少了什么、去哪加」。
 *
 * 只说 `null` / 只说 `superResolve` 都不够：前者是一句空话，
 * 后者是给开发者看的。所以这里给出三件事：**哪一类、去哪配、内置有没有**。
 *
 * @param category - 类别。
 * @returns 一句人能读懂的话。
 */
export function workflowMissingWhy(category: WorkflowCategory): string {
  const label = CATEGORY_LABEL[category] ?? category
  const hasBuiltin = defaultWorkflowOf(category) !== undefined
  if (!hasBuiltin) {
    return '这个渠道没挂「' + label + '」工作流，内置清单里也没有这一类（'
      + category + '）：请去渠道设置里给它选一份工作流再试。'
  }
  /* 内置有却走到这里，说明渠道字段里那份是显式清掉的（`null`）——
   * 那种情况下面这句才是真的。 */
  return '这个渠道没挂「' + label + '」工作流（' + category + '）：请去渠道设置里选一份，'
    + '或清掉那个配置让内置的接管。'
}

/**
 * 选渠道：请求指定了就用它，否则找第一个「有模型能做这件事」的渠道。
 *
 * ## 为什么必须是「有能做的模型」而不是「有渠道」
 *
 * 一个渠道里可能有五个模型，只有一个能出图。只看渠道就选，会选到
 * 「能做文字、不能出图」的那个，然后报错 —— 而实际上另一个渠道明明能做。
 *
 * @param kind - 生成什么。
 * @param wanted - 请求指定的渠道 id（可空）。
 * @returns 渠道；找不到给一条人看得懂的错。
 */
export async function pickChannel(
  kind: GenKind, wanted?: string,
): Promise<{ ok: true, channel: Awaited<ReturnType<typeof readChannels>>[number] } | { ok: false, error: string }> {
  const all = await readChannels()
  if (wanted !== undefined && wanted !== '') {
    const one = all.find(c => c.id === wanted)
    if (one === undefined) return { ok: false, error: '没有这个渠道：' + wanted }
    return { ok: true, channel: one }
  }
  /* 头一个「有模型能 c(p)s 这件事」的渠道。 */
  const fit = all.find(c => c.models.some(m => m.caps.includes(kind)))
  if (fit === undefined) {
    return {
      ok: false,
      error: '没有渠道能生成 ' + kind + '（'
        + (all.length === 0 ? '一条渠道都没配' : '已配渠道的模型能力：' + all.map(c => c.name + '(' + c.models.map(m => m.caps.join('/')).join(',') + ')').join('；'))
        + '）',
    }
  }
  return { ok: true, channel: fit }
}

/**
 * 定这次生成「用哪个渠道、哪个模型」（2026-10-26，T-B-后端）。
 *
 * ## 它替换掉的是「撞运气」
 *
 * 原来的做法（界面那一半 `ContentCanvas.tsx:1493` / `:1550`）：
 *
 * ```ts
 * const model = (d.model ?? '').trim() !== '' ? (d.model ?? '').trim() : (ms.data[0]?.modelId ?? '')
 * ```
 *
 * **取清单里的第一个。** 换一个渠道、换一台机器，出的东西就变了，
 * 而用户什么都没改 —— 这不是「设置」，是撞运气。
 *
 * 现在的三层：
 *
 * ```
 * ① 调用方指定了模型        → 用它（渠道也指定了就一起用）
 *   ② 没指定 → 读「默认模型」里这一类的那条 → 用它的渠道 + 模型
 *     ③ 默认也没有 → **报错**：「还没设默认模型，去设置里选一个」
 * ```
 *
 * 第 ③ 层是这一条的关键：**不许静默取第一个**。用户看到的是
 * 「还没设默认模型」，而不是「出来一张不知道用什么模型画的东西」。
 *
 * @param input - 请求（看 `kind` / `model` / `channelId` / `op` / `refs`）。
 * @returns 定好的渠道与模型。
 * @throws 没指定又没设默认时抛一条能读懂的话。
 */
export async function resolveGenerationTarget(
  input: Pick<GenerateInput, 'kind' | 'model' | 'channelId' | 'op' | 'refs'>,
): Promise<{ channelId?: string, model: string, from: 'given' | 'default' }> {
  const given = typeof input.model === 'string' ? input.model.trim() : ''
  if (given !== '') {
    return {
      model: given,
      ...input.channelId === undefined || input.channelId === '' ? {} : { channelId: input.channelId },
      from: 'given',
    }
  }

  const kindForDefault = defaultTypeOf(input)
  /* ★ 票 76（2026-10-29）：文本与反推**没有默认模型可取**（渠道里没有那一类了）。
   *
   * 这两句必须**在取默认之前**就说清，不能落到下面那条「还没设默认模型」——
   * 那句话会让用户跑去设置里找一个根本不存在的「文本」勾选框。 */
  if (kindForDefault === '') {
    throw new Error(
      input.op === 'caption'
        ? '反推提示词已停用：文本统一走 dsh，不再由工作台渠道生成。'
          + '这条入口暂时没有替代做法 —— 到画布上手动填提示词。'
        : '文本生成不在工作台渠道里做了（统一走 dsh）。'
          + '这个操作要走渠道的话，把类型换成图片 / 视频 / 音频之一；'
          + '要写字请用「AI 生成」节点或 dsh 自己的模型。',
    )
  }
  const defaults = await readModelDefaults()
  const hit = defaultOf(defaults, kindForDefault)
  if (hit !== undefined) {
    return { channelId: hit.channelId, model: hit.modelId, from: 'default' }
  }

  const label = KIND_LABEL[kindForDefault] ?? kindForDefault
  throw new Error(
    '这次生成没有指定模型，而「' + label + '」这一类还没有设默认模型。'
    + '去工作台设置的「默认模型」里给「' + label + '」选一个再试；'
    + '或者在这次提交里直接指定模型。'
    + '（以前没指定会静默取模型清单里的第一个 —— 那样出来的是什么全凭渠道顺序，已经改掉了。）',
  )
}

/**
 * 这次生成该按**哪一类**去取默认模型（票 76 之后只有三类）。
 *
 * ## 四类 → 三类
 *
 * 票 76：渠道里去掉「文本」这一类（文本统一走 dsh）。所以 `kind: 'text'`
 * **没有默认模型可取** —— 返回空串，由调用方明确报错，不许静默降级成
 * 别的类（降级会让一次「润色文字」悄悄变成「画一张图」）。
 *
 * ## 唯一的例外仍是反推
 *
 * `op: 'caption'` 也返回空串（票 76 把反推停掉了，见 `op-specs.ts` 的
 * `disabled`）。这一支留着是为了让**老画布上手动发的 caption** 走到
 * 一句说得清的话，而不是走到「没有默认模型」那种含糊报错。
 *
 * ## ⚠️ `categoryOf` 一个字没动
 *
 * 它决定**跑哪一份 ComfyUI 工作流**（caption 仍映射到 `text` 分类）。
 * 那是工作流分类，与本函数「取哪一格默认模型」是两件事。
 * 票 76 是**第三次**改形态，也是第三次没动它 —— `tests/category-lock.mjs`
 * 的 48 格期望表钉着。
 *
 * @param input - 生成请求（只看 `kind` / `op`）。
 * @returns 三类之一；文本与反推给空串（没有默认模型可取）。
 */
export function defaultTypeOf(
  input: Pick<GenerateInput, 'kind' | 'op'>,
): string {
  if (input.op === 'caption') return ''
  if (input.kind === 'text') return ''
  return input.kind
}

/**
 * 报错里的类名（说人话）。**不另定义一份**，直接用四类的中文名表。
 *
 * 票 74 之后 `MODEL_TYPE_LABEL.image` 就是「图片」—— 与 `GenKind` 同名同数，
 * 不再需要 `image: '生图'` 那种兜底覆盖。
 */
const KIND_LABEL: Record<string, string> = { ...MODEL_TYPE_LABEL }

/** 提交一次生成要什么。 */
export interface GenerateInput {
  /** 生成什么。 */
  kind: GenKind
  /**
   * 对已有的图做什么操作（可选，契约 T1）。
   *
   * 给了就决定用哪一类 ComfyUI 工作流（局部重绘 / 超分 / 放大 / 反推 / 多角度）。
   * 不给时行为与加这个字段之前一字不变。
   */
  op?: GenOp
  /** 提示词。 */
  prompt: string
  /**
   * 模型 id（**可以不给** —— 不给就用「默认模型」里这一类的那条）。
   *
   * 2026-10-26 之前这个字段是必填的，而界面在没选时自己填了「清单第一个」。
   * 现在改成：不给就走 `resolveGenerationTarget` 的三层回落，
   * 默认也没设就**明确报错**（见那个函数的说明）。
   */
  model: string
  /** 指定渠道（可选）。 */
  channelId?: string
  /** 尺寸写法（`1024x1024` / `16:9`）。 */
  size?: string
  /** 要几张（图片）。 */
  count?: number
  /** 要几秒（视频）。 */
  seconds?: number
  /**
   * 随机种子（票 08，2026-10-30）。
   *
   * 不给就由后端取一个随机整数（范围与 ComfyUI 一致：`0 ~ 2**32-1`），
   * 给了就用给的。为什么要有它：在此之前 seed 从请求到工作流这一层**断着**，
   * 工作流里那个种子永远不变 → 同一句提示词重跑返回同一张图（ComfyUI 甚至
   * 直接命中缓存，0.02 秒返回），用户点「重新生成」以为按钮坏了。
   *
   * 只有 ComfyUI 那条路认它。网络模型（openai / gemini）的接口没有种子参数，
   * 那边**不会写这个键**，也不假装写了（见 `runTask` 里 `usedSeed` 的说明）。
   */
  seed?: number
  /** 参考图（图生图 / 编辑用）。 */
  refs?: { mime: string, bytes: Buffer }[]
  /**
   * 遮罩（局部重绘用，契约 T1）。
   *
   * 只走 ComfyUI 那条路（上传成 `ref_mask` 槽位）。网络模型会明确报错，
   * 因为那两家的 API 没有「遮罩」这个参数（见 `net-gen.ts` ②b）。
   */
  mask?: { mime: string, bytes: Buffer }
  /** 反查提示词。 */
  negativePrompt?: string
  /** 从哪触发（写进生成记录的 `source`）。 */
  source?: string
  /** 画布来源时是哪一份画布。 */
  canvasId?: string
  /** 画布来源时是哪个节点。 */
  canvasNodeId?: string
}

/**
 * 提交一次生成：**立刻返回任务**，真正的活在后台跑。
 *
 * ## 为什么立刻返回而不是等结果
 *
 * 视频一条十几分钟。界面发一个请求等十几分钟 → 浏览器超时、用户以为卡死。
 * 所以这里只做三件事（都是毫秒级）：造任务、登记、起异步。真正跑在后台。
 *
 * ⚠️ 任务 id **就是**生成记录的 id：一次生成一条记录，两者一一对应，
 * 界面拿任务 id 就能顺着找到记录，不必再维护一份映射。
 *
 * @param input - 见 `GenerateInput`。
 * @returns 任务（此刻 `status: 'submitted'`）。
 */
export function submitGeneration(input: GenerateInput): GenerateTask {
  const id = newRunId()
  /* 任务 id 同时当记录 id —— 它要满足 `isGenLogId`（`[A-Za-z0-9][A-Za-z0-9._-]*`），
   * `newRunId()` 的形状 `20261026-020000-abcd` 正好满足。 */
  const task: GenerateTask = {
    id, kind: input.kind, status: 'submitted', stage: 'submitted',
    prompt: input.prompt, model: input.model,
    channelId: input.channelId ?? '', channelName: '',
    createdAt: Date.now(), waitedMs: 0, artifacts: [], history: [],
  }
  step(task, 'submitted', 'submitted', '已受理')
  tasks.set(id, task)
  const ac = new AbortController()
  cancels.set(id, ac)
  pruneTasks()

  /* 起后台。**不 await** —— 这是「立刻返回」的全部含义。
   * 用 `setTimeout(0)` 而不是直接调：让本次 HTTP 响应先出去，
   * 保证界面第一次查进度时能看到 `submitted`（不是已经 `running`）。 */
  setTimeout(() => { void runTask(task, input, ac.signal) }, 0)
  return task
}

/** 把超出上限的旧任务挤出去（新的先留）。 */
function pruneTasks(): void {
  if (tasks.size <= MAX_TASKS) return
  const sorted = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  for (const old of sorted.slice(0, tasks.size - MAX_TASKS)) {
    tasks.delete(old.id)
    cancels.delete(old.id)
  }
}

/**
 * 真正跑一个任务（内部函数）。
 *
 * @param task - 任务（会被就地更新）。
 * @param input - 请求。
 * @param signal - 取消信号。
 */
async function runTask(task: GenerateTask, input: GenerateInput, signal: AbortSignal): Promise<void> {
  step(task, 'running', 'queued', '等渠道名额')
  try {
    /* ⓪ 定「用哪个渠道、哪个模型」（2026-10-26，T-B-后端）。
     *
     * 这一段以前没有：界面在没选模型时自己填了「清单第一个」，
     * 宿主这边就把那个值当用户选的收下 —— **撞运气的那一步在界面里，后端看不见**。
     * 现在收口到这里：没指定 → 默认模型 → 都没有就报错说去设置里选。
     *
     * 为什么要放进 `runTask` 而不是 `submitGeneration`：它要读磁盘（默认模型文件），
     * 而 `submitGeneration` 是同步的、要**立刻返回**。放进去就等于把磁盘 IO 塞进
     * HTTP 响应路径上 —— 那正是「立刻返回」要避免的东西。 */
    const target = await resolveGenerationTarget(input)
    const wantedModel = target.model
    const wantedChannel = target.channelId
    /* 把定下来的值写回任务（界面据此显示「这次用的是哪个模型」，
     * 否则用户看到的是空白 —— 而空白正是他抱怨的那件事）。 */
    task.model = wantedModel
    if (target.from === 'default') step(task, 'running', 'queued', '用默认模型：' + wantedModel)

    /* ① 选渠道 */
    const picked = await pickChannel(input.kind, wantedChannel)
    if ('error' in picked) throw new Error(picked.error)
    const ch = picked.channel
    task.channelId = ch.id
    task.channelName = ch.name

    /* ② 能力匹配（在真跑之前拦住，省一次白跑的上游请求）。
     *
     * ⚠️ `caption`（反推提示词）走网络模型时要按 **`text`** 判能力，不是按调用方给的 `kind`：
     * 反推的产物是**文字**。调用方通常给 `kind: 'image'`（因为手里是张图），
     * 但「能出图的模型」不等于「能读图答字的模型」—— 按 `image` 判会放行一个
     * 只会画图的模型，然后它真去画图了（实测：回来一张图而不是一段描述）。
     *
     * ComfyUI 那条路不受影响：它按 `category` 选工作流，`caption` 映射到 `text`（`categoryOf`）。 */
    const captionOnNet = input.op === 'caption' && ch.protocol !== 'comfyui'
    const effectiveKind: GenKind = captionOnNet ? 'text' : input.kind
    const model = ch.models.find(m => m.id === wantedModel)
    if (model === undefined) {
      throw new Error('渠道「' + ch.name + '」里没有模型 ' + wantedModel
        + '（这个渠道登记的：' + (ch.models.length === 0 ? '没有' : ch.models.map(m => m.id).join('、')) + '）'
        + (target.from === 'default'
          ? '。这个模型是从「默认模型」里取的 —— 去设置里改成这个渠道有的模型，或者重新拉一次模型清单。'
          : ''))
    }
    if (!model.caps.includes(effectiveKind)) {
      const canDo = ch.models.filter(m => m.caps.includes(effectiveKind)).map(m => m.id)
      throw new Error('模型 ' + wantedModel + ' 没有「' + effectiveKind + '」能力（它有的是：'
        + (model.caps.length === 0 ? '未登记' : model.caps.join('、')) + '）。这个渠道里能做 '
        + effectiveKind + ' 的：' + (canDo.length === 0 ? '没有' : canDo.join('、')))
    }

    const key = await channelKey(ch.id)
    step(task, 'running', 'running', '已开始（' + ch.name + '）')

    /* ③ 调对的那条路。
     *
     * ## ⚠️ 两条路的限流位置**不一样**，这是刻意的
     *
     * · `comfyui` → **不在这里套**。`runComfyGeneration` 内部已经套了一层
     *   （`comfyui.ts:952`，契约 CA 的硬要求）。外层再套一层会**死锁**：
     *   `maxConcurrency === 1` 时外层占了唯一名额，内层永远等不到 —— 任务挂死，
     *   不报错也不超时。第一次实现就写成外层也套，是被这条约束拦住的。
     * · `openai` / `gemini` → **在这里套**。`generateOnChannel` 不自己限流
     *   （它只是拼请求），所以名额必须由调用方拿。
     *
     * 结果：两条路都受渠道上限约束，只是闸门位置不同。 */
    const ran = ch.protocol === 'comfyui'
      ? await runComfyBranch(task, ch, input, key, signal)
      : await runInChannel(ch.id, ch.maxConcurrency, async (): Promise<{ items: { mime: string, bytes: Buffer }[], texts: string[] }> => {
        if (signal.aborted) throw new Error('已取消')

        const req: GenRequest = {
          kind: effectiveKind,
          ...input.op === undefined ? {} : { op: input.op },
          prompt: input.prompt,
          /* ⚠️ 用 `wantedModel`，**不是** `input.model`（2026-10-26 修）。
           * `input.model` 在「没指定、走默认」时是**空串** —— 用它发给上游
           * 会变成 `POST /v1/images/generations` 带一个空 model，上游 400。
           * 这个 bug 是 `tests/gen-model-target.mjs` ④ 段抓出来的。 */
          model: wantedModel,
          ...input.size === undefined ? {} : { size: input.size },
          ...input.count === undefined ? {} : { count: input.count },
          ...input.seconds === undefined ? {} : { seconds: input.seconds },
          ...input.refs === undefined ? {} : { refs: input.refs },
          /* 遮罩也透传：网络模型那边会**明确拒绝**（它的 API 没有这个参数），
           * 而不是静默忽略 —— 静默忽略会让用户以为「我抹了遮罩结果没生效」。 */
          ...input.mask === undefined ? {} : { mask: input.mask },
          ...input.negativePrompt === undefined ? {} : { negativePrompt: input.negativePrompt },
          signal,
          onProgress: (stage, detail) => {
            task.stage = stage
            const waited = detail !== null && typeof detail === 'object'
              ? (detail as { waitedMs?: unknown }).waitedMs : undefined
            if (typeof waited === 'number') task.waitedMs = waited
          },
          ...deps.sleep === undefined ? {} : { sleep: deps.sleep },
        }
        const res = await generateOnChannel(ch, key, req, deps.netFetch)
        /* 网络模型那边把文字当 `text/plain` 的一份产出交回来（`gemini-gen.ts`），
         * 所以这里没有单独的 `texts` —— 它已经在 `items` 里了。 */
        return { items: res.items.map(i => ({ mime: i.mime, bytes: i.bytes })), texts: [] }
      })

    const items = ran.items

    if (signal.aborted) throw new Error('已取消：任务在提交后被停止')

    /* ④ 存产物。
     *
     * 文本产出（`caption` 反推提示词那一类）**也存成产物**，mime 是 `text/plain`。
     * 为什么不单开一个 `task.texts`：界面已经在按 `artifacts` 渲染结果，
     * 加一条并列的字段就要在界面里写第二套展示与读法；而 `POST /artifact`
     * 这条存取的形状本来就与图片一模一样（字节 + mime），文字也是字节。
     * 于是界面的读法不变：拿 `url` 取回来就是那段字。 */
    const allOutputs = [
      ...items,
      ...ran.texts.map(t => ({ mime: 'text/plain; charset=utf-8', bytes: Buffer.from(t, 'utf8') })),
    ]
    step(task, 'running', 'storing', '存 ' + String(allOutputs.length) + ' 个产物')
    for (const item of allOutputs) {
      const meta = await storeArtifact({
        data: item.bytes,
        mime: item.mime,
        source: 'gen-' + effectiveKind,
        params: {
          prompt: input.prompt, model: wantedModel,
          ...input.size === undefined ? {} : { size: input.size },
        },
      })
      task.artifacts.push({
        id: meta.id, mime: meta.mime, bytes: meta.bytes,
        url: '/api/ecom-workbench/artifact/' + meta.id,
      })
    }

    /* ⑤ 写生成记录（成功） */
    await writeGenLog(logOf(task, input, 'success'))
    task.endedAt = Date.now()
    step(task, 'success', 'done', '完成，' + String(task.artifacts.length) + ' 个产物')
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    const cancelled = signal.aborted || raw.includes('取消')
    task.error = cancelled ? (raw.includes('取消') ? raw : '已取消') : raw
    task.endedAt = Date.now()
    /* ⑥ **失败也要写记录**：这是 gen-logs.ts 的三条硬规矩之一（采集那边踩过的坑）。 */
    try {
      await writeGenLog({ ...logOf(task, input, 'failed'), error: task.error })
    } catch { /* 写记录失败不该盖掉真正的失败原因 */ }
    step(task, 'failed', 'failed', task.error)
  } finally {
    cancels.delete(task.id)
  }
}

/**
 * ComfyUI 那条路（内部）。
 *
 * @param task - 任务。
 * @param ch - 渠道。
 * @param input - 请求。
 * @param key - 密钥。
 * @param signal - 取消信号。
 * @returns 产出的字节。
 */
async function runComfyBranch(
  task: GenerateTask,
  ch: Awaited<ReturnType<typeof readChannels>>[number],
  input: GenerateInput,
  key: string,
  signal: AbortSignal,
): Promise<{ items: { mime: string, bytes: Buffer }[], texts: string[] }> {
  const category = categoryOf(input.kind, (input.refs?.length ?? 0) > 0, input.op)
  const workflow = pickWorkflow(ch as unknown as Record<string, unknown>, category)
  if (workflow === null) {
    /* ⚠️ 不许只说一句 `null` 或者只报类别英文名（契约 T1）。
     * `superResolve` / `angle` / `upscale` 这三类**内置清单里就没有**，
     * 所以「没配」是它们的正常状态 —— 用户点下去必须看懂少了什么、去哪加。
     * `workflowMissingWhy` 负责把那句话组织成人能读的。 */
    throw new Error(workflowMissingWhy(category))
  }

  /* 种子只取一次（票 08）：给了用给的，没给随机。
   * 写回 `task.seed` 是给生成记录用的 —— 记录里那个数必须是这张图实际用的那个。 */
  const usedSeed = input.seed !== undefined && Number.isFinite(input.seed)
    ? input.seed
    : pickSeed()
  task.seed = usedSeed

  /* 槽位值：尺寸解析成宽高（`sizeBindings` 里调 `parseSize`），负面提示词也给上。
   *
   * ⚠️ `negativePrompt` 原先**没传**（2026-10-26 修）：请求里收了、生成记录里写了，
   * 就是没进工作流 —— 内置那份工作流的负向槽位永远是它自带的空格。
   * 只传不给槽位名也没用，两处都得改（`applyBindings` 那边加了分支）。 */
  const bindings: ComfyBindings = {
    prompt: input.prompt,
    /* 种子（票 08，2026-10-30）。**没给就随机** —— 这是本票的全部意义：
     * 不给种子时工作流里那个数永远不变，同一句提示词重跑返回同一张图。
     * 给了就用给的（用户想复现某一张图时靠它）。
     *
     * ⚠️ 只在这里取一次，取完立刻写回 `task.seed`（生成记录从这个值写）。
     * 两处各取一次的话，记录里那个数就不是这张图实际用的那个。 */
    seed: usedSeed,
    ...input.size === undefined ? {} : sizeBindings(input.size),
    ...input.negativePrompt === undefined || input.negativePrompt === ''
      ? {} : { negativePrompt: input.negativePrompt },
    /* 一次出几张（2026-10-26 补）。填进建 Latent 节点的 `batch_size`。
     * 只有 `count > 1` 才填 —— 1 是工作流自己的默认值，动它没有意义。 */
    ...input.count === undefined || input.count <= 1 ? {} : { count: input.count },
    /* 时长（2026-10-27 补，票 29）：请求里叫 `seconds`，bindings 里叫 `duration`。
     *
     * ⚠️ 名字不同是历史原因，不统一（理由写在 `ComfyBindings.duration` 上）。
     * ⚠️ 没给就不发这个键 —— 发 `0` 或 `5` 会把内置音频工作流里那个空串
     * （「用模型自己的默认」）改掉，等于替用户做了个他没收到的决定。 */
    ...input.seconds === undefined || !Number.isFinite(input.seconds)
      ? {} : { duration: input.seconds },
  }
  const refImages = (input.refs ?? []).map((r, i) => ({
    name: 'ref-' + String(i) + extOfMime(r.mime), bytes: r.bytes, mime: r.mime,
  }))
  /* 遮罩（契约 T1）：上传成 ComfyUI 的文件名再填 `ref_mask` 槽位。
   * 文件名带随机前缀由 `uploadImage` 自己加，这里只给个可读的底名。 */
  const refMask = input.mask === undefined
    ? undefined
    : { name: 'mask' + extOfMime(input.mask.mime), bytes: input.mask.bytes, mime: input.mask.mime }

  const res: ComfyGenResult = await runComfyGeneration({
    channel: ch as never,
    key,
    category,
    workflow,
    bindings,
    ...refImages.length === 0 ? {} : { refImages },
    ...refMask === undefined ? {} : { refMask },
    signal,
    onTick: (state: ComfyState, waitedMs: number) => {
      task.stage = state === 'pending' ? 'queued' : 'running'
      task.waitedMs = waitedMs
    },
    ...deps.comfyHttp === undefined ? {} : { http: deps.comfyHttp },
    ...deps.sleep === undefined ? {} : { sleep: deps.sleep },
  })
  /* 文件与文本**都交回去**（2026-10-26 补，反推提示词要用）。
   * 文本按 `text/plain` 存成产物，界面拿 `url` 就能读到那段字 ——
   * 不给它单独造一条「文本」字段，界面就要为两种结果写两条展示分支。 */
  return {
    items: res.files.map(f => ({ mime: f.mime, bytes: f.bytes })),
    texts: res.texts,
  }
}

/** mime → 扩展名（参考图的文件名用）。 */
function extOfMime(mime: string): string {
  const m = mime.split(';')[0].trim().toLowerCase()
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' } as Record<string, string>)[m] ?? '.png'
}

/**
 * 尺寸写法 → 槽位值（宽高）。
 *
 * ## 这里**必须调** `parseSize`，不许自己再写一份正则（2026-10-26 修的）
 *
 * 第一版是这样写的：
 *
 * ```
 * const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(size.trim())
 * if (m === null) return {}          // ← 认不出就静默不填
 * ```
 *
 * 而它上面的注释写着「`parseSize` 在 `comfyui.ts` 里…这里只是把解析失败变成不致命」——
 * **注释读起来像「我们考虑过比例」，实际是「考虑过，没接」**：
 * `parseSize`（`comfyui.ts:475`，能算 `16:9` → 1820×1024）在整个生成链路里 **0 处调用**，
 * 而 16 份内置工作流里有 11 份确实带 `width`/`height` 槽位。
 * 于是用户选「16:9」→ 那份工作流用它自己的默认尺寸 → 出图比例不对，而**没有任何提示**。
 *
 * ## 现在的规矩：要么真算出来，要么明确报错
 *
 * `parseSize` 认不出来会 `throw`（它抛的是「尺寸不合法：xxx」）。这里**接住并补一句人话**，
 * 说出「认不出来的写法长什么样」与「该写成什么样」—— 用户填了东西就该生效，
 * 或者明确告诉他为什么没生效。**不许退回 `{}` 静默降级。**
 *
 * @param size - 用户写的尺寸。
 * @returns 要填进槽位的宽高。
 * @throws 写法认不出来时抛一条能读懂的话（由 `runTask` 收成 `task.error`）。
 */
function sizeBindings(size: string): ComfyBindings {
  try {
    const { width, height } = parseSize(size)
    return { width, height }
  } catch (e) {
    /* `parseSize` 的原文是「尺寸不合法：16：9」—— 那句对用户不够，
     * 他不知道该怎么改。所以这里补上能认的三种写法与最常踩的那个坑（中文冒号）。 */
    const raw = e instanceof Error ? e.message : String(e)
    const why = /：/.test(size)
      ? '（写成了中文冒号「：」，要英文冒号「:」）'
      : ''
    throw new Error(
      '尺寸写法认不出来：' + size + why
      + '。能写的是「1024x1024」「16:9」「9:16-2k」这几种；'
      + '原来那句：' + raw,
    )
  }
}

/**
 * 组装生成记录（15 个字段，一个不多）。
 *
 * ⚠️ 形状以 `gen-logs.ts` 的 `GenLog` 为准，`normalizeGenLog` 会把不认识的键丢掉。
 * 这里**只填该填的**：`endedAt` 在成功时由调用方补，`error` 只在失败时给。
 *
 * @param task - 任务。
 * @param input - 请求。
 * @param status - 记录状态。
 * @returns 记录。
 */
function logOf(task: GenerateTask, input: GenerateInput, status: 'success' | 'failed'): GenLog {
  return {
    id: task.id,
    kind: input.kind === 'video' ? 'video' : 'image',
    createdAt: task.createdAt,
    ...task.endedAt === undefined ? {} : { endedAt: task.endedAt },
    status,
    channelId: task.channelId,
    /* 用 `task.model`，**不是** `input.model`（2026-10-26 修）：
     * 走默认模型时 `input.model` 是空串，而记录里该写**实际用的那个**——
     * 否则事后翻记录会看到一条「model 是空」的生成，查不出当时用了什么。 */
    model: task.model,
    prompt: input.prompt,
    ...input.negativePrompt === undefined ? {} : { negativePrompt: input.negativePrompt },
    params: {
      ...input.size === undefined ? {} : { size: input.size },
      ...input.count === undefined ? {} : { count: input.count },
      ...input.seconds === undefined ? {} : { seconds: input.seconds },
      /* 种子（票 08）：用 `task.seed`，**不是** `input.seed`。
       * 没给种子时 `input.seed` 是 undefined，而实际用的那个是随机出来的 ——
       * 记录里写 undefined 等于「这张图的种子查不到」，本票就白做了。
       * 网络模型那条路不写这个键（那边的接口没有种子参数，写了就是假话）。 */
      ...task.seed === undefined ? {} : { seed: task.seed },
    },
    artifacts: task.artifacts.map(a => ({ id: a.id, bytes: a.bytes })),
    usage: {
      ...task.kind === 'image' ? { images: task.artifacts.length } : {},
      ...task.kind === 'video' && input.seconds !== undefined ? { seconds: input.seconds } : {},
    },
    ...input.source === undefined ? {} : { source: input.source },
    ...input.canvasId === undefined ? {} : { canvasId: input.canvasId },
    ...input.canvasNodeId === undefined ? {} : { canvasNodeId: input.canvasNodeId },
  }
}

/**
 * 查一个任务。
 * @param id - 任务 id。
 * @returns 任务；没有给 `null`。
 */
export function getTask(id: string): GenerateTask | null {
  return tasks.get(id) ?? null
}

/**
 * 列最近的任务（新的在前）。
 * @param limit - 最多几条（默认 50）。
 * @returns 任务数组。
 */
export function listTasks(limit = 50): GenerateTask[] {
  return [...tasks.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit > 0 ? limit : 50)
}

/**
 * 取消一个任务。
 *
 * @param id - 任务 id。
 * @returns 取消了就 true（任务不存在 / 已经结束给 false）。
 */
export function cancelTask(id: string): boolean {
  const task = tasks.get(id)
  if (task === undefined) return false
  if (task.status === 'success' || task.status === 'failed') return false
  const ac = cancels.get(id)
  if (ac === undefined) return false
  /* 先记一步「用户要停」，再 abort。顺序反了的话，若 abort 引发的失败先落地，
   * 历史里会看不出「是用户停的」还是「自己失败的」。 */
  step(task, 'running', 'cancelling', '用户点了停止')
  ac.abort()
  return true
}

/* ── 只读查询接口（界面用）─────────────────────────────────────────── */

/** 模型清单里的一条。 */
export interface ModelOption {
  /** 渠道 id。 */
  channelId: string
  /** 渠道名。 */
  channelName: string
  /** 渠道协议（界面可据此显示「本地 / 云端」）。 */
  protocol: string
  /** 模型 id（提交生成时用它）。 */
  modelId: string
  /** 模型显示名。 */
  modelLabel: string
  /** 这个模型的能力。 */
  caps: string[]
  /**
   * 这个模型算哪几类（票 70，2026-10-29）。
   *
   * ## 为什么由后端给，而不是让界面从 `caps` 推
   *
   * `caps` 分不出文生图与图生图（两者都是 `image`）。界面想筛就得自己写一遍
   * 「`caps` → 类型」的推导 —— 那是同一件事第二套判据，票 67 刚把它收进
   * `src/schedule/model-types.ts` 的 `typesOfModel` 一处。
   *
   * 所以判据留在宿主半，**这里直接给答案**。
   *
   * ⚠️ 加这个字段**不影响任何既有调用方**：老字段一个没少、没改名，
   * 多一个键不会让谁读错。
   */
  types: string[]
}

/**
 * 列出「能做某件事」的模型（跨渠道合并）。
 *
 * 为什么要有这条接口：参考项目那个模型下拉是纯前端的（渠道存在 localStorage），
 * 我们的渠道在宿主（`channels.json`），界面读不到，只能问宿主。
 *
 * @param kind - 只要 `caps` 含它的模型；不给就列全部。
 * @returns 模型清单（按渠道顺序、渠道内按登记顺序）。
 */
export async function listModels(kind?: GenKind): Promise<ModelOption[]> {
  const all = await readChannels()
  const out: ModelOption[] = []
  for (const ch of all) {
    for (const m of ch.models) {
      if (kind !== undefined && !m.caps.includes(kind)) continue
      out.push({
        channelId: ch.id, channelName: ch.name, protocol: ch.protocol,
        modelId: m.id, modelLabel: m.label, caps: m.caps,
        /* ⚠️ 必须调 `typesOfModel`，不在这里另写一份推导 —— 那又是两套判据。 */
        types: typesOfModel(m),
      })
    }
  }
  return out
}

/**
 * 按操作过滤模型清单（契约 T1）：只留**真做得了这个操作**的。
 *
 * ## 为什么必须在后端过滤，而不是界面自己筛
 *
 * 「有工作流」这件事界面看不见 —— 工作流挂在渠道上（`channels.json` 的
 * `comfyui*Workflow` 字段），界面拿不到。让界面按 `caps` 筛会筛出一批
 * 「能出图但这一类没挂工作流」的渠道，用户点了才报错。
 *
 * ## 三类判据
 *
 * 1. **网络模型渠道（openai / gemini）**：它们的 API 没有遮罩、没有超分、
 *    没有多角度。除了 `caption`（反推提示词 —— 那是文本活，Gemini 能做），
 *    其余 op 一律不列。列了就是把用户引向一条必然报错的路。
 * 2. **ComfyUI 渠道**：这一类必须**有工作流**（渠道挂的或内置的）。
 *    没有就不列 —— 否则选完会撞上 `workflowMissingWhy` 那句「请去配一份」。
 * 3. 其余模型照旧保留。
 *
 * @param models - `listModels()` 的结果。
 * @param op - 要做的操作。
 * @returns 过滤后的清单（顺序不变）。
 */
export async function filterModelsByOp(models: ModelOption[], op: GenOp): Promise<ModelOption[]> {
  const wantCategory = categoryOf('image', true, op)
  const all = await readChannels()
  const byId = new Map(all.map(c => [c.id, c]))
  return models.filter((m) => {
    const ch = byId.get(m.channelId)
    if (ch === undefined) return false
    if (ch.protocol === 'comfyui') {
      /* 这一类有工作流才列。 */
      return pickWorkflow(ch as unknown as Record<string, unknown>, wantCategory) !== null
    }
    /* 网络模型：只有反推提示词这条路走得通，而且**那个模型得真有 `text` 能力**。
     *
     * ⚠️ 光放行 `caption` 是不够的（第一版就漏了这一层）：请求侧对网络模型的
     * `caption` 会强制按 `kind: 'text'` 发（`runTask` 的 `effectiveKind`），
     * 所以「只会画图」的模型在这一步就会被能力校验拦。
     * 过滤时如果不看 `caps`，界面会列出一个「选了必然报错」的模型 —— 那正是这条函数存在的理由。 */
    return op === 'caption' && m.caps.includes('text')
  })
}

/** 渠道连通性测试的结论。 */
export interface ChannelTestResult {
  /** 通过没有。 */
  ok: boolean
  /** 说明（失败时带上游原文）。 */
  message: string
  /** HTTP 状态码（拿不到给 0）。 */
  status: number
}

/**
 * 测一个渠道通不通。
 *
 * 三种协议各有一个「最便宜的」探测端点：
 * · `comfyui` → `GET /system_stats`（它就是用来报告主机状态的）
 * · `openai`  → `GET /v1/models`（列模型，不产生任何生成）
 * · `gemini`  → `GET /v1beta/models`（同上）
 *
 * ⚠️ 不真发一次生成来测 —— 那要花钱、要等，而且「能生成」不等于「配置对」。
 *
 * @param id - 渠道 id。
 * @returns 结论。
 */
export async function testChannel(id: string): Promise<ChannelTestResult> {
  const all = await readChannels()
  const ch = all.find(c => c.id === id)
  if (ch === undefined) return { ok: false, message: '没有这个渠道：' + id, status: 0 }
  const key = await channelKey(id)
  const doFetch = deps.netFetch ?? fetch
  const base = ch.baseUrl.replace(/\/+$/, '')
  const path = ch.protocol === 'comfyui'
    ? '/system_stats'
    : ch.protocol === 'gemini' ? '/v1beta/models' : '/v1/models'
  const headers: Record<string, string> = {}
  if (key !== '') {
    if (ch.protocol === 'gemini') headers['x-goog-api-key'] = key
    else headers.Authorization = 'Bearer ' + key
  }

  try {
    /* ComfyUI 那条路的连接参数走注入（与生成共用同一份），其余用 netFetch。 */
    const useInjected = ch.protocol === 'comfyui' && deps.comfyHttp?.fetchImpl !== undefined
    const fetchImpl = useInjected ? deps.comfyHttp?.fetchImpl : doFetch
    const res = await (fetchImpl ?? fetch)(base + path, { headers })
    if (res.ok) return { ok: true, message: '连得上（' + String(res.status) + '）', status: res.status }
    let detail = ''
    try { detail = (await res.text()).slice(0, 300) } catch { /* 读不到就算了 */ }
    return {
      ok: false,
      message: '连上了但被拒绝（' + String(res.status) + '）：'
        + (detail === '' ? '没有更多说明' : detail),
      status: res.status,
    }
  } catch (e) {
    return {
      ok: false,
      message: '连不上：' + (e instanceof Error ? e.message : String(e)),
      status: 0,
    }
  }
}

export { GenError }
