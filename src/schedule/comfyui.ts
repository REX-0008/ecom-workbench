/** ComfyUI 直连（宿主半，契约 AX，2026-10-25）。
 *
 * # ⚠️ 端到端未验 —— 只验了纯函数
 *
 * 本机 ComfyUI **没有在跑**（计划 §二写于 2026-10-25 的实测：8188 / 8189 两个端口
 * 都不通）。所以这个文件里：
 *
 * | 部分 | 状态 |
 * |---|---|
 * | 槽位填写 `applyBindings` | **验过**（`tests/comfyui.mjs` 喂假工作流 JSON） |
 * | 参考图裁剪 `pruneUnusedRefs` | **验过**（同上） |
 * | 轮询间隔与状态判定 `pollJob` | **验过**（喂假 HTTP 响应，不连真服务） |
 * | **真提交一份工作流、真出一张图** | **未验** —— 等 ComfyUI 起来后补 |
 *
 * 这句话在注释里必须留着（计划 §三 2.3 的完成标准就是这么定的）。
 * 不许因为「代码看起来对」就把它写成已经验过。
 *
 * ## 协议长什么样（给不熟 ComfyUI 的人）
 *
 * ComfyUI 的工作流 JSON 是一个**以节点编号为键的对象**：
 *
 * ```json
 * {
 *   "3": { "class_type": "KSampler", "inputs": { "seed": 0, "steps": 20 },
 *          "_meta": { "title": "seed" } },
 *   "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512 },
 *          "_meta": { "title": "width" } }
 * }
 * ```
 *
 * 节点之间的连线不是单独的数组，而是**输入里填一个 `[来源节点编号, 输出序号]`**。
 * 「删掉一个参考图节点」因此要连**指着它的那些输入**一起处理，
 * 否则删完之后别的节点引用一个不存在的编号，ComfyUI 直接拒收。
 *
 * 槽位约定照参考项目：靠 `_meta.title` 标记（`prompt` / `width` / `height` /
 * `seed` / `ref_image_NN`）。参考实现：`refs-projects/infinite-canvas/web/src/services/api/comfyui.ts`。
 */
import { channelKey, readChannels, type Channel } from './channels.ts'
/* 渠道并发闸门（契约 CA 要求接上；之前这个文件「造好了没人调」）。 */
import { runInChannel } from './channel-queue.ts'
/* HTTP 那一层单独一个文件（契约 CA）：它是 IO，这个文件是纯逻辑。 */
import {
  guessMime, submitPrompt, uploadImage, getHistory, getQueue,
  deleteQueueItem, interrupt, getSystemStats, downloadView,
  ComfyApiError, normalizeBaseUrl,
  type ComfyHttpOptions, type DownloadedAsset,
} from './comfyui-http.ts'

/* ── 轮询参数（照参考项目，见 `comfyui.ts:838-843`）──────────────────
 *
 * 集中成常量而不是散落在函数里：数值调整时要能一眼改一处。
 * 视频一条可能跑十几分钟，所以超时上限取 18 小时量级（参考项目的量级）。 */

/** 有任务在跑时的轮询间隔（2 秒）。 */
export const POLL_RUNNING_MS = 2_000
/** 全部在排队时的轮询间隔（3.5 秒）。 */
export const POLL_PENDING_MS = 3_500
/** 单次生成的超时上限（18 小时）。 */
export const POLL_TIMEOUT_MS = 18 * 60 * 60 * 1_000

/** ComfyUI 工作流 JSON：节点编号 → 节点。 */
export type ComfyWorkflow = Record<string, ComfyNode>

/** 一个 ComfyUI 节点。 */
export interface ComfyNode {
  /** 节点类型（如 `KSampler`）。 */
  class_type?: string
  /** 输入；值是字面量，或者 `[来源节点编号, 输出序号]` 表示一条连线。 */
  inputs?: Record<string, unknown>
  /** 元信息，`title` 就是我们认槽位的标记。 */
  _meta?: { title?: unknown }
  /** 其余字段（`_meta` 之外的）原样保留，不解释。 */
  [k: string]: unknown
}

/** 要填进槽位的值（全是可选的，没给就不动那个槽位）。 */
export interface ComfyBindings {
  /** 提示词。 */
  prompt?: string
  /** 宽。 */
  width?: number
  /** 高。 */
  height?: number
  /** 随机种子。 */
  seed?: number
  /** 参考图（按顺序对应 `ref_image_01` / `ref_image_02`…；也支持只有 `ref_image` 的写法）。 */
  refImages?: string[]
  /**
   * 遮罩文件名（契约 T1，2026-10-26）。
   *
   * ## 为什么它一直是个空位
   *
   * 这个文件早就认得三个遮罩槽位名（`ref_mask` / `mask` / `ref_mask_01`，
   * 校验里还有「局部编辑工作流缺少 ref_mask 遮罩槽位」那一条），
   * 但**从生成请求到这里的路一直没通** —— 于是「局部重绘」在数据上永远是
   * 「只有提示词、没有遮罩」。
   *
   * 现在通了：`GenRequest.mask` → `runComfyGeneration` 上传 → 这里的文件名。
   * 值是**ComfyUI 那边的文件名**（`uploadImage` 的返回值），不是本地路径。
   */
  refMask?: string
  /**
   * 负面提示词（2026-10-26 补）。
   *
   * ## 为什么原先一直没填
   *
   * 16 份内置工作流里**只有 `inpaint_qwen_image_api.json` 一份**有负向槽位，
   * 它的标题是 `"CLIP Text Encode (Negative Prompt)"` —— **不是** `negative`。
   * 而 `applyBindings` 只认 `prompt` / `width` / `height` / `seed` / `ref_image*` /
   * `ref_mask*` 这几类名字，于是那一个槽位从来没被填过：
   * 用户在界面上填了负面提示词，记录里也写了，**工作流里永远是它自带的那个空格 `" "`**。
   *
   * ## 三种写法都认
   *
   * | 工作流里标的 `_meta.title` | 认不认 |
   * |---|---|
   * | `"CLIP Text Encode (Negative Prompt)"` | 认（内置那一份的实际写法） |
   * | `negative` / `negative_prompt` | 认（用户自己导入的工作流常见） |
   * | `负面提示词` / `负向提示词` | 认（中文界面的习惯） |
   *
   * 不认的话表现是「填了没生效」—— 那是本项目反复踩的同一类病。
   */
  negativePrompt?: string
  /**
   * 一次出几张（2026-10-26 补）。
   *
   * 填进**建 Latent 那个节点的 `batch_size`**（按结构找，不按标题 ——
   * 理由见 `applyBindings` 末尾那段）。`1` 或没给时**不动工作流**：
   * 那 4 份内置工作流本来就是 `batch_size: 1`，改它等于无意义地改文件。
   *
   * ⚠️ 只有带 `batch_size` 的工作流才吃这个值。视频 / 音频那几类往往没有
   * （它们走 `EmptyMiniMaxMusic3LatentAudio` 这类专用空 Latent），那时 `count` 不生效。
   */
  count?: number
  /**
   * 时长（秒，2026-10-27 补，票 29）。
   *
   * ## 为什么这个字段在 bindings 里叫 `duration`、请求里叫 `seconds`
   *
   * 两处名字不一样是历史原因，不统一：
   *   · 工作流 JSON 那一侧：槽位是 `_meta.title = "duration"`，
   *     `RESERVED_SINGLE_SLOTS` 认的也是这个字（它已经写对了，别动）；
   *   · 请求体那一侧：`GenRequest.seconds` 早就在用了，改它要牵动所有调用方。
   *
   * ## 这个槽位长什么样
   *
   * 内置那份音频工作流（`audio_minimax_music_3_api.json`）里，节点 `47` 是
   * `class_type: "Float"`、`inputs: { "Number": "" }`、`_meta.title: "duration"`，
   * 它的输出被节点 `49`（`MiniMaxMusic3TextEncode`）的 `max_duration` 引用。
   *
   * 也就是说：字段名是 `Number`，不是 `duration` —— 与正向提示词那件事一样，
   * 只按标题认、不按字段名兜底，就会「填了时长但音乐还是那个固定长度」。
   *
   * `undefined` 时一个字节都不动工作流（见 `applyBindings` 里那条分支的说明）。
   */
  duration?: number
}

/**
 * 槽位名 → 节点类型 → 真实输入字段名。
 *
 * 为什么要这张表：同一个 `_meta.title: "prompt"`，在 `CLIPTextEncode` 上字段叫
 * `text`，在 `PrimitiveString` 上叫 `value`。表里查不到时按下面的兜底顺序猜
 * （参考项目也是这么做的，见 `comfyui.ts:318-328`）。
 */
const SLOT_BY_CLASS: Record<string, Record<string, string>> = {
  prompt: {
    CLIPTextEncode: 'text', PrimitiveStringMultiline: 'value', PrimitiveString: 'value',
    TextEncodeBooguEdit: 'prompt', TextEncodeQwenImageEditPlus: 'prompt',
  },
  width: { PrimitiveInt: 'value', PrimitiveFloat: 'value' },
  height: { PrimitiveInt: 'value', PrimitiveFloat: 'value' },
  seed: {
    KSampler: 'seed', KSamplerAdvanced: 'noise_seed',
    PrimitiveInt: 'value', PrimitiveFloat: 'value',
  },
  ref_image: { LoadImage: 'image', LoadImageMask: 'image' },
}

/**
 * 槽位读法：先查表，查不到按候选字段名找第一个存在的。
 *
 * @param inputs - 节点的输入表。
 * @param slot - 槽位名（`prompt` / `width` / …）。
 * @param classType - 节点类型。
 * @param fallbacks - 表里没有时依次试的字段名。
 * @returns 字段名；一个都没有给 `undefined`（表示**这个节点填不了，跳过**）。
 */
function slotName(
  inputs: Record<string, unknown>, slot: string, classType: string, fallbacks: string[],
): string | undefined {
  const known = SLOT_BY_CLASS[slot]?.[classType]
  if (known !== undefined) return known
  for (const f of fallbacks) if (f in inputs) return f
  return undefined
}

/** 从 `_meta.title` 取小写的槽位名（取不到给空串）。 */
function titleOf(node: ComfyNode): string {
  const t = node._meta?.title
  return typeof t === 'string' ? t.trim().toLowerCase() : ''
}

/**
 * 填槽位：把生成参数写进工作流里**标记过**的节点。
 *
 * ## 两条判据，不是一条（这是踩了三次数错同一个东西换来的）
 *
 * | 判据 | 认什么 | 典型 |
 * |---|---|---|
 * | **按标题**（`_meta.title`） | 节点上那句给人看的标记 | `title = "prompt"` / `"CLIP Text Encode (Negative Prompt)"` |
 * | **按结构**（字段名 + 类型） | `inputs` 里的键名与其当前值 | `batch_size: 1` / `negative_prompt: ""` |
 *
 * ⚠️ **同一批工作流里两种形态并存，不是「这批用标题、那批用字段名」。**
 * `inpaint_qwen_image_api.json` 的负向槽位靠**标题**（整句
 * `CLIP Text Encode (Negative Prompt)`，字段名其实是 `text`）；
 * `qwen_image_21_api.json` 的负向槽位靠**字段名**（`negative_prompt: ""`，
 * 标题是「文本编码 Qwen Image 2.1」，一个 negative 都没有）。
 * 两份都在内置清单里、都是 `isDefault: true`。
 * **所以判据必须两条都上**，不能「看多数情况像哪种就选哪种」。
 *
 * ## 四条规则
 *
 * 1. **不改入参**：返回一份深拷贝（原工作流要能反复用，16 份内置的与上游逐字节相同，动不得）。
 * 2. **找不到槽位就跳过，不报错** —— 一份工作流可能压根没有 `seed` 槽位，
 *    那不是错误，只是这个参数用不上。
 * 3. **三处结构兜底**（下面各有一段）：`seed`、`negativePrompt`、`count`。
 *    它们共用一个理由：**槽位标记没写全时，功能不能因此静默失效**。
 *    `seed` 的兜底是「填了种子但结果每次都一样」；`negativePrompt` 是「填了但没生效」；
 *    `count` 是「要三张只给一张」。
 * 4. **正向提示词只有标题一条腿，这是查过的结论，不是漏了**：
 *    16 份工作流里**键名恰好是 `prompt` / `positive_prompt` / `positive` 且值是字符串的节点
 *    是 0 个**（逐份 JSON 解析过）。正向全走 `_meta.title = "prompt"`。
 *    补「按字段名认正向」也没有对象可填 —— 下一个人不必再查一遍。
 *
 * @param workflow - 原工作流。
 * @param bindings - 要填的值。
 * @returns 填好的新工作流。
 */
export function applyBindings(workflow: ComfyWorkflow, bindings: ComfyBindings): ComfyWorkflow {
  const cloned = structuredClone(workflow)
  let seedBound = false
  /** 负面提示词**按标题**填到过没有（下面还有一遍按字段名的兜底）。 */
  let negativeBound = false

  for (const node of Object.values(cloned)) {
    if (typeof node !== 'object' || node === null) continue
    const inputs = node.inputs
    const classType = typeof node.class_type === 'string' ? node.class_type : ''
    if (inputs === undefined) continue
    const title = titleOf(node)
    if (title === '') continue

    if (title === 'prompt' && bindings.prompt !== undefined) {
      const slot = slotName(inputs, 'prompt', classType, ['value', 'text', 'prompt'])
      if (slot !== undefined) inputs[slot] = bindings.prompt
    } else if (title === 'width' && bindings.width !== undefined) {
      const slot = slotName(inputs, 'width', classType, ['value', 'width'])
      if (slot !== undefined) inputs[slot] = bindings.width
    } else if (title === 'height' && bindings.height !== undefined) {
      const slot = slotName(inputs, 'height', classType, ['value', 'height'])
      if (slot !== undefined) inputs[slot] = bindings.height
    } else if (title === 'seed' && bindings.seed !== undefined) {
      const slot = slotName(inputs, 'seed', classType, ['seed', 'noise_seed', 'value'])
      if (slot !== undefined) inputs[slot] = bindings.seed
      seedBound = true
    } else if (
      /* 时长（2026-10-27 补，票 29）。
       *
       * ## 判据必须是 `!== undefined`，不能是 `!== 0` 或「真值判断」
       *
       * 这一条是本票最容易做错的地方：写成 `bindings.duration !== undefined ? … : 0`
       * 或者 `bindings.duration || 5`，都会在不喂时长时改动工作流 ——
       * 内置那份音频的 `Number` 原本是空串 `""`（「用模型自己的默认」），
       * 被写成 `0` 之后那条音乐要么报错、要么变成 0 秒。
       *
       * 所以：`undefined` → 这一支整个不进，工作流一个字节不动。
       *
       * ## 字段名是 `Number`（不是 `duration`）
       *
       * 节点 `47` 是 `class_type: "Float"`、`inputs: { "Number": "" }`。
       * 与正向提示词那件事同一条理由：只按标题认、不按字段名兜底，
       * 换个用户导入的工作流就「填了没生效」。
       *
       * 非有限数（NaN / Infinity）也跳过：写进去 ComfyUI 会拒收整份工作流，
       * 而那种报错读起来跟「时长」毫无关系。 */
      title === 'duration'
      && bindings.duration !== undefined && Number.isFinite(bindings.duration)
    ) {
      const slot = slotName(inputs, 'duration', classType, ['Number', 'value', 'duration', 'seconds'])
      if (slot !== undefined) inputs[slot] = bindings.duration
    } else if (title.startsWith('ref_image') && (bindings.refImages?.length ?? 0) > 0) {
      const m = /^ref_image_(\d{2})$/.exec(title)
      const index = m !== null ? Number(m[1]) - 1 : 0
      const img = bindings.refImages?.[index]
      if (img !== undefined) {
        const slot = slotName(inputs, 'ref_image', classType, ['image'])
        if (slot !== undefined) inputs[slot] = img
      }
    } else if (
      /* 遮罩（契约 T1）：三个槽位名都认 —— 这跟校验里那条判据是同一批名字
       * （`ref_mask` / `mask` / `ref_mask_01`）。只认一个的话，
       * 用户那份工作流标的是别的写法，就会「填了遮罩但没生效」。 */
      (title === 'ref_mask' || title === 'mask' || title === 'ref_mask_01')
      && bindings.refMask !== undefined && bindings.refMask !== ''
    ) {
      const slot = slotName(inputs, 'ref_image', classType, ['image'])
      if (slot !== undefined) inputs[slot] = bindings.refMask
    } else if (
      /* 负面提示词（2026-10-26）。
       *
       * 四个写法都认，理由见 `ComfyBindings.negativePrompt` 的注释：
       * 内置那一份标的是 `"CLIP Text Encode (Negative Prompt)"`（整句，含空格），
       * 而用户自己导入的工作流常见 `negative` / `negative_prompt` / 中文两种。
       * 只认一个的话就是「填了没生效」。
       *
       * ⚠️ 必须放在 `prompt` 分支**之后**：`titleOf` 把标题转小写，
       * 但那时已不影响匹配（这里是整句比对，不是 `startsWith`）。 */
      (title === 'clip text encode (negative prompt)'
        || title === 'negative' || title === 'negative_prompt'
        || title === '负面提示词' || title === '负向提示词')
      && bindings.negativePrompt !== undefined && bindings.negativePrompt !== ''
    ) {
      /* 字段名与正向提示词同一套：`CLIPTextEncode` 上是 `text`、`PrimitiveString` 上是 `value`。 */
      const slot = slotName(inputs, 'prompt', classType, ['value', 'text', 'prompt'])
      if (slot !== undefined) {
        inputs[slot] = bindings.negativePrompt
        negativeBound = true
      }
    }
  }

  /* 负面提示词的**第二条腿：按字段名认**（2026-10-26 补，这是同一件事的第二次修）。
   *
   * ## 为什么光按标题认不够
   *
   * `qwen_image_21_api.json` 的 **`node 512`**（`TextEncodeQwenImage21`）里，
   * 负向文本是**字段名** `negative_prompt: ""`，而它的标题是
   * 「文本编码 Qwen Image 2.1」—— **标题里一个 negative 都没有**。
   *
   * 所以只按 `_meta.title` 认的话，那份工作流**一个字都填不进去**，
   * 而按标题写的那些断言全绿（它们验的都是标题）。两次数错、两次断言没覆盖，
   * 都是同一个毛病：**判据盯着形状（标题长什么样），不盯性质（这个字段能不能填）**。
   *
   * ## 判据
   *
   * `inputs` 里键名是 `negative_prompt`（也认 `negative`），且**当前值是字符串**
   * （不是连线 `["52", 0]`）—— 连线的目标是一个 `ConditioningZeroOut` 之类的节点，
   * 往那里写文本会把工作流写坏。
   *
   * 只填**第一个**匹配的节点：一份工作流里通常只有一个在生效链路上。
   * 按标题已经填过（`negativeBound`）就不再做，避免两份逻辑互相覆盖。 */
  if (!negativeBound && bindings.negativePrompt !== undefined && bindings.negativePrompt !== '') {
    for (const node of Object.values(cloned)) {
      if (typeof node !== 'object' || node === null || node.inputs === undefined) continue
      for (const key of ['negative_prompt', 'negative']) {
        if (typeof node.inputs[key] === 'string') {
          node.inputs[key] = bindings.negativePrompt
          negativeBound = true
          break
        }
      }
      if (negativeBound) break
    }
  }

  if (!seedBound && bindings.seed !== undefined) {
    for (const node of Object.values(cloned)) {
      if (typeof node !== 'object' || node === null || node.inputs === undefined) continue
      if (typeof node.inputs.seed === 'number') { node.inputs.seed = bindings.seed; break }
      if (typeof node.inputs.noise_seed === 'number') { node.inputs.noise_seed = bindings.seed; break }
    }
  }

  /* 一次出几张（`count`，2026-10-26 补）。
   *
   * ## 为什么这里也是「结构兜底」而不是只认标题
   *
   * ComfyUI 的批量由**建 Latent 的那个节点的 `batch_size`** 决定。16 份内置工作流里
   * 有 4 份带这个字段，但那 4 个节点的标题是「空Latent图像」「空Latent图像（SD3）」
   * 这类**描述性**文字，不是槽位标记 —— 按 `_meta.title` 一条也匹配不上。
   *
   * 三条路可走：
   * 1. 给那 4 份 JSON 补 `_meta.title` —— **不行**：那 16 份与上游逐字节相同（SHA256 16/16），
   *    改了就再也 diff 不出来，将来上游更新无法合并；
   * 2. 只认标题，让 `count` 对内置工作流永远无效 —— 等于没做；
   * 3. **按结构找**：谁有 `batch_size` 就填谁（与 `seed` 上面那段同一个套路）。
   *
   * 选 3。理由：`batch_size` 这个名字在 ComfyUI 里**只有一个含义**（一次出几张），
   * 不像 `value` 那样到处都有，按结构找不会误伤。
   *
   * ⚠️ 只填**第一个**带 `batch_size` 的节点 —— 一份工作流里如果有多处（比如两个 Latent），
   * 只可能有一个在生效链路上；全填会让不参与计算的那个也变，白白改动工作流。 */
  if (bindings.count !== undefined && bindings.count > 1) {
    for (const node of Object.values(cloned)) {
      if (typeof node !== 'object' || node === null || node.inputs === undefined) continue
      if (typeof node.inputs.batch_size === 'number') {
        node.inputs.batch_size = bindings.count
        break
      }
    }
  }
  return cloned
}

/**
 * 裁掉没用上的参考图节点，以及指着它们的连线。
 *
 * ## 为什么必须裁，而不是「留个空节点」
 *
 * ComfyUI 里的 `LoadImage` 节点**必须有一个真实文件名**才能跑。
 * 留一个空节点等于提交一份必定失败的工作流 —— 而且报错发生在 ComfyUI 那边，
 * 用户在自己的界面里看不到原因。
 *
 * ## 两步
 *
 * 1. 找出该删的节点：`ref_image_NN` 的下标 ≥ 给了几张图；或者只有 `ref_image`
 *    而一张图都没给。
 * 2. 级联：任何节点的输入指着被删节点 → **那条连线一起删**（输入本身拿掉），
 *    若因此变成「没有输入来源的必需节点」就再删这个节点（循环直到稳定）。
 *
 * 第二步的循环是必要的：`LoadImage → VAEEncode → KSampler` 是一条链，
 * 只删 LoadImage 会让 VAEEncode 指着空气。
 *
 * ⚠️ 有一类节点是「可选输入」——它少一个输入还能跑（参考项目里叫
 * `TextEncodeQwenImage21` / `ComfySwitchNode` 那种多图插槽）。对它们只删连线、
 * 不删节点本身。这份名单照参考项目 `comfyui.ts:455-462`。
 *
 * @param workflow - 工作流。
 * @param assignedImages - 本次真正给了几张参考图。
 * @returns 裁好的新工作流（不改入参）。
 */
export function pruneUnusedRefs(workflow: ComfyWorkflow, assignedImages: number): ComfyWorkflow {
  const cloned = structuredClone(workflow)
  const removed = new Set<string>()

  for (const [id, node] of Object.entries(cloned)) {
    if (typeof node !== 'object' || node === null) continue
    const title = titleOf(node)
    const m = /^ref_image_(\d{2})$/.exec(title)
    if (m !== null) {
      if (Number(m[1]) - 1 >= assignedImages) removed.add(id)
    } else if (title === 'ref_image' && assignedImages === 0) {
      removed.add(id)
    }
  }
  if (removed.size === 0) return cloned

  /** 这些节点少一个输入还能跑 → 只删连线。 */
  const OPTIONAL_INPUT_CLASSES = new Set(['TextEncodeQwenImage21', 'ComfySwitchNode'])

  let changed = true
  while (changed) {
    changed = false
    for (const [id, node] of Object.entries(cloned)) {
      if (removed.has(id)) continue
      const inputs = node?.inputs
      if (inputs === undefined) continue
      const classType = typeof node.class_type === 'string' ? node.class_type : ''
      const optional = OPTIONAL_INPUT_CLASSES.has(classType)

      let broken = false
      for (const [key, val] of Object.entries(inputs)) {
        /* 连线一定是 `[来源节点编号, 输出序号]` 这个形状。 */
        if (!Array.isArray(val) || val.length < 2) continue
        if (!removed.has(String(val[0]))) continue
        delete inputs[key]
        if (!optional) broken = true
      }
      if (broken) { removed.add(id); changed = true }
    }
  }

  for (const id of removed) delete cloned[id]
  return cloned
}

/** 轮询看到的任务状态（ComfyUI `/queue` + `/history` 推出的四态）。 */
export type ComfyState = 'pending' | 'running' | 'done' | 'failed'

/** 一次轮询的结论。 */
export interface PollResult {
  /** 结局。 */
  state: ComfyState
  /** 失败原因（`failed` 时给）。 */
  error?: string
  /** 产出（`done` 时给，原样带出，本函数不解释字段）。 */
  outputs?: unknown
}

/**
 * 按当前状态取下一次该等多久。
 *
 * 这是「轮询间隔两档」的唯一出口 —— 修数值只改常量，不必翻函数。
 * @param state - 当前状态。
 * @returns 毫秒。
 */
export function pollIntervalOf(state: ComfyState): number {
  return state === 'running' ? POLL_RUNNING_MS : POLL_PENDING_MS
}

/**
 * 从 ComfyUI 的 `/history/<id>` 响应推状态（**纯函数**，所以能喂假响应）。
 *
 * ComfyUI 的约定：`history` 里有这个 id 了，就说明它跑完了；
 * 有没有出图看 `outputs` 是否非空，失败看 `status.status_str === "error"`。
 * 不在 history 里 → 还在跑或还在排队，由调用方用 `/queue` 区分。
 *
 * @param history - `/history/<id>` 的 JSON。
 * @param jobId - 任务 id。
 * @returns 结论。
 */
export function stateFromHistory(history: unknown, jobId: string): PollResult {
  if (typeof history !== 'object' || history === null) return { state: 'pending' }
  const entry = (history as Record<string, unknown>)[jobId]
  if (typeof entry !== 'object' || entry === null) return { state: 'pending' }
  const rec = entry as Record<string, unknown>
  const status = rec.status
  const statusStr = typeof status === 'object' && status !== null
    ? String((status as Record<string, unknown>).status_str ?? '')
    : ''
  if (statusStr === 'error') {
    return { state: 'failed', error: 'ComfyUI 执行出错（status_str=error）', outputs: rec.outputs }
  }
  const outputs = rec.outputs
  if (typeof outputs === 'object' && outputs !== null && Object.keys(outputs as object).length > 0) {
    return { state: 'done', outputs }
  }
  /* 有记录但没产出：也算失败 —— 否则会一直等到 18 小时超时，
   * 而真实原因是「它跑完了但什么都没出」。 */
  return { state: 'failed', error: 'ComfyUI 跑完了但没有产出（outputs 为空）' }
}

/**
 * 从 `/queue` 响应推「在跑还是在排队」（**纯函数**）。
 *
 * @param queue - `/queue` 的 JSON（`{ queue_running: [...], queue_pending: [...] }`）。
 * @param jobId - 任务 id。
 * @returns `running` / `pending` / `running`（默认按在跑算，宁可多问一次）。
 */
export function stateFromQueue(queue: unknown, jobId: string): ComfyState {
  if (typeof queue !== 'object' || queue === null) return 'running'
  const rec = queue as Record<string, unknown>
  const listOf = (k: string): unknown[] => Array.isArray(rec[k]) ? rec[k] as unknown[] : []
  /* ComfyUI 的队列项是数组，jobId 一般在下标 1。做一次「整项 JSON 里包含 id」的
   * 宽松判断：它的形状在不同版本里变过，绑死下标会在升级后失效。 */
  const inList = (list: unknown[]): boolean =>
    list.some(item => JSON.stringify(item).includes(jobId))
  if (inList(listOf('queue_running'))) return 'running'
  if (inList(listOf('queue_pending'))) return 'pending'
  return 'running'
}

/**
 * 轮询一个任务直到出结果。
 *
 * ## 这一段「验过」的边界（别读错）
 *
 * 验的是**状态机**：喂假的 `fetchJob`，看它在 running / pending / done / failed
 * 四种输入下是否按对的间隔问、是否在超时后停。**没有验**的是「真连上一个
 * ComfyUI 拿回真图」—— 本机 8189 不通（见文件头）。
 *
 * @param jobId - 任务 id。
 * @param fetchJob - 问一次状态的函数（测试里注假实现）。返回 `{history, queue}`。
 * @param opts - 超时、取消信号、进度回调。
 * @returns 结论（`done` 带 `outputs`）。
 */
export async function pollJob(
  jobId: string,
  fetchJob: (id: string) => Promise<{ history?: unknown, queue?: unknown }>,
  opts: {
    /** 超时上限（毫秒，默认 18 小时）。 */
    timeoutMs?: number
    /** 取消信号。 */
    signal?: AbortSignal
    /** 每次轮询回调一次（界面显示「已等 N 秒」用）。 */
    onTick?: (state: ComfyState, waitedMs: number) => void
    /** 等待实现（测试里可以注入一个不真睡的）。 */
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<PollResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? POLL_TIMEOUT_MS)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  for (;;) {
    if (opts.signal?.aborted === true) return { state: 'failed', error: '已取消' }
    let got: { history?: unknown, queue?: unknown }
    try {
      got = await fetchJob(jobId)
    } catch (e) {
      return { state: 'failed', error: '问 ComfyUI 状态失败：' + (e instanceof Error ? e.message : String(e)) }
    }
    const fromHistory = stateFromHistory(got.history, jobId)
    if (fromHistory.state === 'done' || fromHistory.state === 'failed') return fromHistory
    const state = stateFromQueue(got.queue, jobId)
    opts.onTick?.(state, Date.now() - (deadline - (opts.timeoutMs ?? POLL_TIMEOUT_MS)))
    if (Date.now() >= deadline) {
      return { state: 'failed', error: '等 ComfyUI 出结果超时（' + String(Math.round((opts.timeoutMs ?? POLL_TIMEOUT_MS) / 1000)) + ' 秒）' }
    }
    await sleep(pollIntervalOf(state))
  }
}

/**
 * 取一条 `comfyui` 渠道（含地址与密钥）。
 *
 * @param id - 渠道 id。
 * @returns 渠道；不存在或协议不对给 `null`。
 */
export async function comfyChannel(id: string): Promise<(Channel & { key: string }) | null> {
  const all = await readChannels()
  const c = all.find(x => x.id === id)
  if (c === undefined || c.protocol !== 'comfyui') return null
  return { ...c, key: await channelKey(id) }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 契约 CA（2026-10-26）新增：尺寸解析、工作流校验、路径适配、取消、整链路。
 * 参考出处逐条标在各自注释里（都来自
 * `refs-projects/infinite-canvas/web/src/services/api/comfyui.ts`）。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── 尺寸解析（照参考 `comfyui.ts:17-76`）────────────────────────────
 *
 * 为什么要搬：设置面板给的是 `1024x1024` / `16:9` / `9:16-2k` 这几种人写的写法，
 * 而 ComfyUI 的节点只吃两个数字。中间必须有一步翻译，且**两种写法都得认** ——
 * 只认像素的话，用户选「16:9」就直接报错。 */

/** 什么都不填时的尺寸。 */
export const DEFAULT_SIZE = { width: 1024, height: 1024 }
/** 只给比例时短边的像素基数（参考项目定的 1024）。 */
const SIZE_BASE = 1024
/** `2k` / `4k` 档位的长边（参考项目定的 2048 / 3840）。 */
const SIZE_TIER_BASE: Record<string, number> = { '2k': 2048, '4k': 3840 }
/** 单边硬上限：超过就判非法（防止手滑填个 100000 把显存打爆）。 */
const MAX_PIXEL = 8192

/** `1024x1024`（x 或 × 都认）。 */
const PIXEL_SIZE_PATTERN = /^(\d+)\s*[x×]\s*(\d+)$/
/** `16:9` / `9:16-2k`。 */
const RATIO_PATTERN = /^(\d+)\s*:\s*(\d+)(?:\s*[-_]\s*(2k|4k))?$/i

/**
 * 取偶数（ComfyUI 的 VAE 要求宽高是 2 的倍数，奇数会出黑边或直接报错）。
 * @param value - 原值。
 * @returns 取偶后的值（最小 2）。
 */
function roundToEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * 把设置面板里的尺寸写法翻成像素。
 *
 * 认三种：空 / `auto`（→ 1024×1024）、`1024x1024`（取偶、单边 ≤ 8192）、
 * `16:9` 或 `9:16-2k`（短边 1024，`2k`/`4k` 档位变长边）。
 *
 * @param size - 用户填的写法。
 * @returns 宽高。
 * @throws 认不出来时抛错（**不静默给个默认值** —— 那样用户填错也看不出来）。
 */
export function parseSize(size?: string): { width: number, height: number } {
  const value = (size ?? '').trim()
  if (value === '' || value.toLowerCase() === 'auto') return { ...DEFAULT_SIZE }

  const pixel = PIXEL_SIZE_PATTERN.exec(value)
  if (pixel !== null) {
    const w = Number(pixel[1])
    const h = Number(pixel[2])
    if (w <= 0 || h <= 0) throw new Error('尺寸不合法：' + value)
    const width = roundToEven(w)
    const height = roundToEven(h)
    if (width > MAX_PIXEL || height > MAX_PIXEL) throw new Error('尺寸不合法：' + value)
    return { width, height }
  }

  const ratio = RATIO_PATTERN.exec(value)
  if (ratio !== null) {
    const a = Number(ratio[1])
    const b = Number(ratio[2])
    if (a <= 0 || b <= 0) throw new Error('尺寸不合法：' + value)
    const tier = ratio[3]?.toLowerCase()
    if (tier !== undefined) {
      const base = SIZE_TIER_BASE[tier]
      return a >= b
        ? { width: base, height: roundToEven((base * b) / a) }
        : { width: roundToEven((base * a) / b), height: base }
    }
    return a >= b
      ? { width: roundToEven((SIZE_BASE * a) / b), height: SIZE_BASE }
      : { width: SIZE_BASE, height: roundToEven((SIZE_BASE * b) / a) }
  }

  throw new Error('尺寸不合法：' + value)
}

/* ── 工作流校验（照参考 `comfyui.ts:101-308`）────────────────────────
 *
 * 为什么提交前要校验：一份工作流里少个 `output_image` 标记，提交到 ComfyUI
 * 之后的表现是「跑完了但什么都没出」，而错误信息在 ComfyUI 的日志里、
 * 我们的界面看不到。在这里拦住能给出「缺哪个标记」这种能照着改的话。 */

/** 只许出现一次的槽位（重复标记必然是复制粘贴错了）。 */
const RESERVED_SINGLE_SLOTS = [
  'prompt', 'seed', 'width', 'height', 'duration',
  'first_frame', 'last_frame', 'ref_mask', 'mask', 'ref_mask_01',
  'output_image', 'output_video', 'output_text', 'output_audio',
  'caption', 'lyrics',
]

/** 校验结论。 */
export interface ValidateResult {
  /** 通过没有。 */
  ok: boolean
  /** 不通过的原因（人话，指到具体槽位）。 */
  error?: string
  /** 这份工作流里出现了哪些槽位（界面可以据此显示「支持哪些参数」）。 */
  slots?: string[]
}

/**
 * 按类别校验一份工作流。
 *
 * 校验分三段（与参考项目一样）：
 * ① 保留槽位不许重复标记；② 输出标记必须与类别对得上；
 * ③ 各类别特有的输入槽位（文生图要 prompt、首尾帧要 first_frame + last_frame…）。
 *
 * @param workflow - 工作流（ComfyUI API 格式）。
 * @param category - 哪一类。
 * @returns 结论。
 */
export function validateComfyWorkflow(workflow: unknown, category: string): ValidateResult {
  if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) {
    return { ok: false, error: '工作流 JSON 必须是一个对象（ComfyUI API 格式）' }
  }
  const entries = Object.entries(workflow as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: '工作流内容是空的' }

  const titleToIds: Record<string, string[]> = {}
  for (const [nodeId, node] of entries) {
    if (typeof node !== 'object' || node === null) continue
    const title = titleOf(node as ComfyNode)
    if (title === '') continue
    ;(titleToIds[title] ??= []).push(nodeId)
  }
  const titles = new Set(Object.keys(titleToIds))

  /* ① 唯一性 */
  for (const slot of RESERVED_SINGLE_SLOTS) {
    const ids = titleToIds[slot]
    if (ids !== undefined && ids.length > 1) {
      return { ok: false, error: '保留槽位「' + slot + '」标记了多个节点（' + ids.join(', ') + '），必须唯一' }
    }
  }
  for (const [title, ids] of Object.entries(titleToIds)) {
    if (/^(ref_image_\d+|ref_video_\d+|ref_audio_\d+)$/.test(title) && ids.length > 1) {
      return { ok: false, error: '参考槽位「' + title + '」标记了多个节点（' + ids.join(', ') + '），必须唯一' }
    }
  }

  /* ② 输出标记与类别对不对得上 */
  const hasOutImage = (titleToIds.output_image?.length ?? 0) > 0 || (titleToIds.out_image?.length ?? 0) > 0
  const hasOutVideo = (titleToIds.output_video?.length ?? 0) > 0
  const hasOutText = (titleToIds.output_text?.length ?? 0) > 0
  const hasOutAudio = (titleToIds.output_audio?.length ?? 0) > 0

  const imageLike = ['t2i', 'i2i', 'inpaint', 'superResolve', 'angle', 'upscale']
  const videoLike = ['omniVideo', 'frameVideo', 'faceRefine', 'depthVideo']
  if (imageLike.includes(category)) {
    if (!hasOutImage) return { ok: false, error: '生图工作流缺少 output_image 标记（请在 SaveImage 这类保存节点上标 _meta.title）' }
    if (hasOutVideo || hasOutText || hasOutAudio) return { ok: false, error: '生图工作流不该有 output_video / output_text / output_audio 标记' }
  } else if (videoLike.includes(category)) {
    if (!hasOutVideo) return { ok: false, error: '视频工作流缺少 output_video 标记（请在 SaveVideo 或 VHS_VideoCombine 上标 _meta.title）' }
    if (hasOutImage || hasOutText || hasOutAudio) return { ok: false, error: '视频工作流不该有 output_image / output_text / output_audio 标记' }
  } else if (category === 'text') {
    if (!hasOutText) return { ok: false, error: '文本工作流缺少 output_text 标记' }
    if (hasOutImage || hasOutVideo || hasOutAudio) return { ok: false, error: '文本工作流不该有 output_image / output_video / output_audio 标记' }
  } else if (category === 'audio') {
    if (!hasOutAudio) return { ok: false, error: '音频工作流缺少 output_audio 标记' }
    if (hasOutImage || hasOutVideo || hasOutText) return { ok: false, error: '音频工作流不该有 output_image / output_video / output_text 标记' }
  }

  /* ③ 各类别的输入槽位 */
  const hasPrompt = (titleToIds.prompt?.length ?? 0) > 0
  const hasRefMask = (titleToIds.ref_mask?.length ?? 0) + (titleToIds.mask?.length ?? 0) + (titleToIds.ref_mask_01?.length ?? 0) > 0
  const hasFirst = (titleToIds.first_frame?.length ?? 0) > 0
  const hasLast = (titleToIds.last_frame?.length ?? 0) > 0
  const hasRefImage = [...titles].some(t => /^ref_image(_\d+)?$/.test(t))
  const hasRefVideo = [...titles].some(t => /^ref_video(_\d+)?$/.test(t))
  const hasRefAudio = [...titles].some(t => /^ref_audio(_\d+)?$/.test(t))
  const hasCaption = (titleToIds.caption?.length ?? 0) > 0
  const hasLyrics = (titleToIds.lyrics?.length ?? 0) > 0

  switch (category) {
    case 't2i':
      if (!hasPrompt) return { ok: false, error: '文生图工作流缺少 prompt 槽位' }
      if (hasRefMask) return { ok: false, error: '文生图工作流不该有 ref_mask 槽位' }
      if (hasFirst || hasLast) return { ok: false, error: '文生图工作流不该有 first_frame / last_frame 槽位' }
      break
    case 'i2i':
      if (!hasPrompt) return { ok: false, error: '图生图工作流缺少 prompt 槽位' }
      if (!hasRefImage) return { ok: false, error: '图生图工作流缺少参考图槽位（至少标一个 ref_image_01）' }
      if (hasRefMask) return { ok: false, error: '图生图工作流不该有 ref_mask 槽位' }
      break
    case 'inpaint':
      if (!hasRefMask) return { ok: false, error: '局部编辑工作流缺少 ref_mask 遮罩槽位' }
      if (!hasRefImage) return { ok: false, error: '局部编辑工作流缺少 ref_image_01 底图槽位' }
      break
    case 'superResolve':
      if (!hasRefImage) return { ok: false, error: '超分工作流缺少原图槽位（至少标一个 ref_image_01）' }
      if (hasRefMask) return { ok: false, error: '超分工作流不该有 ref_mask 槽位' }
      break
    case 'angle':
      if (!hasRefImage) return { ok: false, error: '多角度工作流缺少基准原图槽位' }
      if (!hasPrompt) return { ok: false, error: '多角度工作流缺少 prompt 槽位' }
      if (hasRefMask) return { ok: false, error: '多角度工作流不该有 ref_mask 槽位' }
      break
    case 'upscale':
      if (!hasRefImage) return { ok: false, error: '放大工作流缺少原图槽位' }
      if (hasRefMask) return { ok: false, error: '放大工作流不该有 ref_mask 槽位' }
      break
    case 'text':
      if (!hasPrompt) return { ok: false, error: '文本工作流缺少 prompt 槽位' }
      break
    case 'omniVideo':
      if (!hasPrompt) return { ok: false, error: '全能参考视频工作流缺少 prompt 槽位' }
      if (hasFirst || hasLast) return { ok: false, error: '全能参考视频工作流不该有 first_frame / last_frame 槽位' }
      break
    case 'frameVideo':
      if (!hasFirst || !hasLast) return { ok: false, error: '首尾帧视频工作流必须同时有 first_frame 与 last_frame 槽位' }
      if (hasRefVideo || hasRefAudio) return { ok: false, error: '首尾帧视频工作流不支持参考视频或参考音频槽位' }
      break
    case 'audio':
      if (!hasPrompt && !hasCaption && !hasLyrics) return { ok: false, error: '音频工作流缺少提示词槽位（prompt / caption / lyrics 三者之一）' }
      break
    case 'faceRefine':
      if (!hasRefVideo) return { ok: false, error: '人脸修复工作流缺少待修复视频槽位（必须标 ref_video_01）' }
      if (!hasPrompt) return { ok: false, error: '人脸修复工作流缺少 prompt 槽位' }
      break
    case 'depthVideo':
      if (!hasRefVideo) return { ok: false, error: '深度视频工作流缺少待提取视频槽位（必须标 ref_video_01）' }
      break
  }
  return { ok: true, slots: [...titles] }
}

/* ── 模型路径适配（照参考 `comfyui.ts:734-763`）────────────────────── */

/**
 * 按目标主机的系统转换模型路径里的斜杠。
 *
 * 为什么需要：这 16 份工作流里有几个带检测器模型（`segm/xxx.onnx` / `bbox/xxx.onnx`），
 * 那份 JSON 是在 Windows 上导出的、写的是反斜杠。Linux 上的 ComfyUI 收到
 * 反斜杠会报 `Value not in list`（文件找不到）。所以提交前按目标主机改一次。
 *
 * @param workflow - 工作流。
 * @param targetOs - 目标主机是 `windows` 还是 `linux`。
 * @returns 改好的工作流（**没有任何路径需要改时原样返回**，省一次深拷贝）。
 */
export function adaptWorkflowModelPaths(workflow: ComfyWorkflow, targetOs: 'windows' | 'linux'): ComfyWorkflow {
  if (typeof workflow !== 'object' || workflow === null) return workflow
  let modified = false
  const cloned = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow
  for (const node of Object.values(cloned)) {
    if (typeof node !== 'object' || node === null || typeof node.inputs !== 'object' || node.inputs === null) continue
    for (const [key, val] of Object.entries(node.inputs)) {
      if (typeof val !== 'string') continue
      /* 只动带 bbox / segm 段的路径 —— 别的字符串（提示词、文件名）碰不得。 */
      if (!/(?:^|[\\/])(bbox|segm)[\\/]/i.test(val)) continue
      const next = targetOs === 'windows' ? val.replace(/\//g, '\\') : val.replace(/\\/g, '/')
      if (next !== val) { node.inputs[key] = next; modified = true }
    }
  }
  return modified ? cloned : workflow
}

/* ── 主机系统探测（照参考 `comfyui.ts:702-729`）──────────────────────── */

/** 探测结果缓存（同一个地址只问一次 —— 它不会中途换系统）。 */
const HOST_OS_CACHE = new Map<string, 'windows' | 'linux'>()

/**
 * 探测目标 ComfyUI 主机跑的是 Windows 还是 Linux。
 *
 * 探不到就当 `linux`（照参考项目）：这两个系统的路径差别只影响那几个检测器模型，
 * 猜错时的表现是「提交被拒一次」，而走反向重试能自动纠正（见 `submitJob`）。
 *
 * @param baseUrl - 地址。
 * @param probe - 查 `system_stats` 的函数（测试注入）。
 * @returns 系统。
 */
export async function detectHostOs(
  baseUrl: string,
  probe: () => Promise<unknown>,
): Promise<'windows' | 'linux'> {
  const key = normalizeHostKey(baseUrl)
  const cached = HOST_OS_CACHE.get(key)
  if (cached !== undefined) return cached
  try {
    const stats = await probe() as { system?: { os?: unknown } } | null
    const osName = String(stats?.system?.os ?? '').toLowerCase()
    const os = osName === 'nt' ? 'windows' : 'linux'
    HOST_OS_CACHE.set(key, os)
    return os
  } catch {
    return 'linux'
  }
}

/**
 * 地址归一成缓存键（去尾斜杠、小写）。
 * @param baseUrl - 地址。
 * @returns 键。
 */
function normalizeHostKey(baseUrl: string): string {
  return String(baseUrl ?? '').replace(/\/+$/, '').toLowerCase()
}

/**
 * 清掉系统探测缓存（**只给测试用**）。
 *
 * 为什么需要：缓存是模块级的、长寿命；一份测试里前一段探出来的结果会让后一段
 * 拿到不该有的值。这不是给生产开后门，它只是把状态重置回进程刚起来的样子。
 */
export function resetHostOsCacheForTest(): void {
  HOST_OS_CACHE.clear()
}

/* ── 取产出（照参考 `comfyui.ts:962-1090` 的 extractOutputs）────────── */

/** 一份产出文件。 */
export interface ComfyOutputFile {
  /** 文件名（交给 `/view` 用）。 */
  filename: string
  /** 子目录。 */
  subfolder: string
  /** `output` / `input` / `temp`。 */
  type: string
  /** mime（按文件名判；`.mp4` 是视频、`.gif` 是动图）。 */
  mime: string
}

/**
 * 从 `/history/{id}` 的响应里把产出文件列出来。
 *
 * ComfyUI 的产出分在 `outputs[节点id]` 下面，各节点给的字段时间不同：
 * 图片/视频在 `images` / `videos` / `gifs` 里，音频在 `audio`，文本在 `text` / `string`。
 * 这里只挑**能取回字节**的那几种。
 *
 * ⚠️ **文本产出由 `textsOfHistory` 单独取**（2026-10-26 补）。原先注释写着「文本产出走另一条路」，
 * 但那条路当时**根本不存在** —— 结果 text 工作流（反推提示词）跑完被判「没有产出」而失败。
 * 现在两条路都在，别再写成「另一条路」而不给名字。
 *
 * @param history - `/history/{id}` 的原始响应。
 * @param jobId - 任务 id。
 * @returns 文件清单（可能空 —— 那就是「跑完了但没产出文件」，由调用方按类别判）。
 */
export function outputsOfHistory(history: unknown, jobId: string): ComfyOutputFile[] {
  if (typeof history !== 'object' || history === null) return []
  const entry = (history as Record<string, unknown>)[jobId]
  if (typeof entry !== 'object' || entry === null) return []
  const raw = (entry as Record<string, unknown>).outputs
  if (typeof raw !== 'object' || raw === null) return []

  const out: ComfyOutputFile[] = []
  const push = (file: { filename?: unknown, subfolder?: unknown, type?: unknown }, mime: string): void => {
    const filename = typeof file.filename === 'string' ? file.filename : ''
    if (filename === '') return
    out.push({
      filename,
      subfolder: typeof file.subfolder === 'string' ? file.subfolder : '',
      type: typeof file.type === 'string' ? file.type : 'output',
      mime,
    })
  }
  for (const nodeOut of Object.values(raw)) {
    if (typeof nodeOut !== 'object' || nodeOut === null) continue
    const rec = nodeOut as Record<string, unknown>
    /* 图片、视频、动图都在 `images` 里 —— 按扩展名判它到底是什么。
     * （ComfyUI 的 VHS_VideoCombine 也把 mp4 放进 `gifs`，所以三个键都要看。） */
    for (const key of ['images', 'gifs', 'videos']) {
      const list = rec[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue
        const file = item as { filename?: unknown, subfolder?: unknown, type?: unknown }
        const name = typeof file.filename === 'string' ? file.filename : ''
        push(file, guessMime(name) === 'application/octet-stream' ? 'image/png' : guessMime(name))
      }
    }
    const audio = rec.audio
    if (Array.isArray(audio)) {
      for (const item of audio) {
        if (typeof item !== 'object' || item === null) continue
        const file = item as { filename?: unknown, subfolder?: unknown, type?: unknown }
        const name = typeof file.filename === 'string' ? file.filename : ''
        push(file, guessMime(name))
      }
    }
  }
  return out
}

/**
 * 从 `/history/{id}` 的响应里把**文本产出**取出来（2026-10-26 补，反推提示词要用）。
 *
 * ## 为什么要单开一个函数，不塞进 `outputsOfHistory`
 *
 * `ComfyOutputFile` 的语义是「**能用 `/view` 取回字节的文件**」（有 filename / subfolder / type）。
 * 文本产出没有文件名，硬塞进去会让每个消费方都要先判一次「这条到底有没有文件名」——
 * 那是把一个类型里混两种东西，下一个人一定踩。
 *
 * ## 认哪些键
 *
 * ComfyUI 的文本节点（`Show Any` / `PreviewAny`）把结果放在 `text` 或 `string` 下：
 *
 * ```
 * { "12": { "text": ["一段文字"] } }      ← 数组，正常形状
 * { "12": { "string": "一段文字" } }      ← 直接给字符串，也见过
 * { "12": { "text": [ {…} ] } }          ← ⚠️ 对象形状：**不许**当成文字
 * ```
 *
 * 最后一种必须挡掉：把 `[object Object]` 当成反推结果交给用户，比「没有结果」更难查。
 *
 * @param history - `/history/{id}` 的原始响应。
 * @param jobId - 任务 id。
 * @returns 文本清单（按节点顺序；**没有就给空数组，不是 `undefined`**）。
 */
export function textsOfHistory(history: unknown, jobId: string): string[] {
  if (typeof history !== 'object' || history === null) return []
  const entry = (history as Record<string, unknown>)[jobId]
  if (typeof entry !== 'object' || entry === null) return []
  const raw = (entry as Record<string, unknown>).outputs
  if (typeof raw !== 'object' || raw === null) return []

  const out: string[] = []
  /** 收一条：只收真正非空的字符串，别的形状一律跳过。 */
  const pushText = (v: unknown): void => {
    if (typeof v !== 'string') return
    if (v.trim() === '') return
    out.push(v)
  }
  for (const nodeOut of Object.values(raw)) {
    if (typeof nodeOut !== 'object' || nodeOut === null) continue
    const rec = nodeOut as Record<string, unknown>
    for (const key of ['text', 'string']) {
      const v = rec[key]
      if (Array.isArray(v)) {
        for (const one of v) pushText(one)
      } else {
        pushText(v)
      }
    }
  }
  return out
}

/* ── 取消（照参考 `comfyui.ts:1662-1683`）──────────────────────────── */
/**
 * 取消一个任务：**先看它在队列的哪个位置**，再决定怎么取消。
 *
 * ## 为什么不能一律 `/interrupt`
 *
 * `/interrupt` 是**全局**的：它打断当前正在跑的那一个，不认 id。
 * 目标任务还在排队时调它，打断的是**别人的**任务。
 * 所以：排队中 → 从队列里删它；正在跑 → 才 interrupt。
 *
 * 参考项目也是这么分的（它的注释写着「绝不全局 interrupt」）。
 *
 * @param jobId - 任务 id。
 * @param opts - 三个函数（查队列 / 删队列项 / 中断），测试注入。
 * @returns 结果说明（`dequeued` / `interrupted` / `not-found`）。
 */
export async function cancelJob(
  jobId: string,
  opts: {
    /** 查队列（返回 `{queue_running, queue_pending}`）。 */
    fetchQueue: () => Promise<unknown>
    /** 从队列里删一条。 */
    deleteItem: (id: string) => Promise<void>
    /** 中断当前正在跑的那个。 */
    interrupt: () => Promise<void>
  },
): Promise<'dequeued' | 'interrupted' | 'not-found'> {
  if (jobId === '') return 'not-found'
  /* ⚠️ 只查**一次**队列：查两次的话两次之间任务可能刚好从排队变成在跑，
   * 于是「按排队删」这个决定落在了「它已经在跑」的事实之后，删不掉还报成功。 */
  const queue = await opts.fetchQueue().catch(() => null)
  if (!isInQueue(queue, jobId)) return 'not-found'
  if (stateFromQueue(queue, jobId) === 'pending') {
    await opts.deleteItem(jobId)
    return 'dequeued'
  }
  await opts.interrupt()
  return 'interrupted'
}

/**
 * 这个 id 在不在队列里（在跑或在排都算）。
 *
 * @param queue - `/queue` 的响应。
 * @param jobId - 任务 id。
 * @returns 在就 true。
 */
export function isInQueue(queue: unknown, jobId: string): boolean {
  if (typeof queue !== 'object' || queue === null) return false
  const rec = queue as Record<string, unknown>
  for (const key of ['queue_running', 'queue_pending']) {
    const list = rec[key]
    if (!Array.isArray(list)) continue
    if (list.some(item => JSON.stringify(item).includes(jobId))) return true
  }
  return false
}

/* ── 整链路：填槽位 → 上传参考图 → 提交 → 轮询 → 取字节 ──────────────── */

/** 一次生成的结果。 */
export interface ComfyGenResult {
  /** 任务 id（出错时也能拿到，便于用户去 ComfyUI 那边查）。 */
  jobId: string
  /** 取回来的文件（成功时至少一个，除非这次是「只要文字」那一类）。 */
  files: DownloadedAsset[]
  /**
   * 文本产出（2026-10-26 补，反推提示词用）。
   *
   * **没有文本时是空数组，不是 `undefined`** —— 调用方不该为了拿它写 `?? []`。
   * 与 `files` 并列而不是塞进 `files`：两者形态不同（一个有文件名、一个没有），
   * 见 `textsOfHistory` 文件头。
   */
  texts: string[]
  /** 用了哪份工作流（反查用）。 */
  workflowId?: string
}

/**
 * 跑一次完整的 ComfyUI 生成。
 *
 * ## 为什么套一层 `runInChannel`（这一处是契约 CA 的硬要求）
 *
 * 生图 / 生视频是长任务，ComfyUI 本身虽然会排队，但它**不知道我们这条渠道的
 * 并发上限**（那个上限是用户配在渠道上的，为了不打爆显存）。所以提交前先在
 * 我们这一侧排队：`runInChannel(channel.id, channel.maxConcurrency, ...)`。
 *
 * 顺带一个好处：它也让「所有渠道加起来不超过全局上限」那条生效
 * （`channel-queue.ts` 的 `GLOBAL_LIMIT`），否则五个渠道一起开火时本机会同时
 * 开几十个 HTTP + 落几十个文件。
 *
 * ## 五步（照参考项目的 `requestComfyuiGeneration` 语义）
 *
 * 1. 选工作流（渠道配的优先，没有就用内置默认）；
 * 2. 校验（拦截「缺 output_image」这类必然白跑的问题）；
 * 3. 填槽位 + 裁掉没用上的参考图节点；
 * 4. 上传参考图（ComfyUI 只认它自己 `input/` 里的文件名，不认 dataURL）；
 * 5. 提交 → 轮询 → 把产出逐个取回字节。
 *
 * @param opts - 渠道、类别、参数、注入点。
 * @returns 结果。
 * @throws 每一步失败都抛错并带上原因（不返回半成品）。
 */
export async function runComfyGeneration(opts: {
  /** 渠道（`protocol` 必须是 `comfyui`）。 */
  channel: Channel
  /** 渠道的密钥（走代理时用得上，直连一般空）。 */
  key?: string
  /** 工作流类别。 */
  category: string
  /** 要用的工作流（不给就取该类别的内置默认）。 */
  workflow: ComfyWorkflow
  /** 填进槽位的值。 */
  bindings: ComfyBindings
  /** 参考图（按顺序对应 `ref_image_01` / `_02`…）。 */
  refImages?: { name: string, bytes: Buffer, mime: string }[]
  /**
   * 遮罩（局部重绘用，契约 T1）。
   *
   * 它会被上传成 ComfyUI 那边的一个文件名，然后填进 `ref_mask` 槽位
   * （`applyBindings` 认得 `ref_mask` / `mask` / `ref_mask_01` 三个写法）。
   *
   * ⚠️ **必须在填槽位之前上传** —— 填进去的是 ComfyUI 侧的文件名，不是本地路径。
   * 顺序反了的表现是「提交被拒：Value not in list」（那边找不到这个文件）。
   */
  refMask?: { name: string, bytes: Buffer, mime: string }
  /** 轮询参数。 */
  timeoutMs?: number
  /** 取消信号。 */
  signal?: AbortSignal
  /** 进度回调（界面显示「已等 N 秒」）。 */
  onTick?: (state: ComfyState, waitedMs: number) => void
  /** 注入了 fetch 的连接参数（测试塞假响应；也可以只给 `fetchImpl`）。 */
  http?: Partial<ComfyHttpOptions>
  /** 等待实现（测试注入不真睡的）。 */
  sleep?: (ms: number) => Promise<void>
}): Promise<ComfyGenResult> {
  const ch = opts.channel
  const http: ComfyHttpOptions = {
    baseUrl: ch.baseUrl,
    token: opts.key !== undefined && opts.key !== '' ? opts.key : undefined,
    proxyUrl: typeof ch.comfyuiProxyUrl === 'string' ? ch.comfyuiProxyUrl : undefined,
    signal: opts.signal,
    ...opts.http ?? {},
  }

  /* ① **不在这里做全套校验** —— 这是照参考项目的做法，不是说漏了。
   *
   * 参考项目里 `validateComfyuiWorkflow` 只有一个调用方：渠道编辑抽屉
   * （`channel-editor-drawer.tsx:100`），也就是**用户导入工作流**那一刻。
   * 生成链路（`requestComfyuiImage` / `submitJob`）**不调它**。
   *
   * 为什么这一条必须照抄：那 16 份里 `video_h3_face_refine_api.json` 的保存节点
   * （节点 23，`VHS_VideoCombine`）标题是「10. Save (ORIGINAL audio)」、
   * **没有 `output_video` 标记**，按全套校验它是不通过的（上游自己的测试
   * `__tests__/comfyui.test.ts:1149` 断言它通过，那是上游的一处不一致）。
   * 在生成前拦一道，等于让这份内置工作流永远用不了。
   *
   * 所以这里只拦**必然空跑**的那一种：工作流是空的。
   * 真正的结构问题由 ComfyUI 的 `node_errors` 报回来（`submitPrompt` 里已经
   * 把它当失败处理），那份错误比我们的校验更准确。 */
  if (typeof opts.workflow !== 'object' || opts.workflow === null
    || Object.keys(opts.workflow).length === 0) {
    throw new Error('工作流是空的：请先给这个渠道选一份 ComfyUI 工作流')
  }

  /* ② 上传参考图 —— **必须在填槽位之前**：填进去的是 ComfyUI 那边的文件名，
   * 顺序反了就只能填个本地路径，那边找不到文件。 */
  const uploaded: string[] = []
  for (const img of opts.refImages ?? []) {
    uploaded.push(await uploadImage(http, img.bytes, img.name, img.mime))
  }
  /* ②b 遮罩同理（契约 T1）：先上传拿文件名，再填槽位。 */
  const uploadedMask = opts.refMask === undefined
    ? undefined
    : await uploadImage(http, opts.refMask.bytes, opts.refMask.name, opts.refMask.mime)

  /* ③ 填槽位 + 裁剪。顺序固定：先填后裁 —— 先裁的话 `refImages.length`
   * 已经是对的了，但填进去的下标会错位（裁掉 02 之后 03 会顶上来）。 */
  let workflow = applyBindings(opts.workflow, {
    ...opts.bindings,
    refImages: uploaded,
    ...uploadedMask === undefined ? {} : { refMask: uploadedMask },
  })
  workflow = pruneUnusedRefs(workflow, uploaded.length)

  /* ④ 提交（套渠道并发）。**这一段是 `runInChannel` 的真调用点。** */
  const jobId = await runInChannel(ch.id, ch.maxConcurrency, async () => {
    /* 路径适配放在闸门**里面**：探测 OS 也要发一次 HTTP，算在并发里更实在。 */
    const os = await detectHostOs(ch.baseUrl, () => getSystemStats(http))
    return submitPrompt(adaptWorkflowModelPaths(workflow, os), http)
  })

  /* ⑤ 轮询。`pollJob` 的 `fetchJob` 就是两个 HTTP 查询的组合 —— 这正是它当初
   * 设计成「接受注入」的原因，这里不用改它一行。 */
  const polled = await pollJob(
    jobId,
    async (id) => ({ history: await getHistory(http, id), queue: await getQueue(http) }),
    {
      ...opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
      ...opts.signal === undefined ? {} : { signal: opts.signal },
      ...opts.sleep === undefined ? {} : { sleep: opts.sleep },
      ...opts.onTick === undefined ? {} : { onTick: opts.onTick },
    },
  )
  if (polled.state !== 'done') {
    throw new Error(polled.error ?? 'ComfyUI 没有出结果（状态：' + polled.state + '）')
  }

  /* ⑥ 取产出：**文件与文本分两条路**（2026-10-26 补）。
   *
   * 原先只取文件，于是 text 工作流（反推提示词）跑完 `list.length === 0` 被判失败 ——
   * 「跑完了但没产出」，而它其实把文字给出来了。现在两条都取。 */
  const histShape = polled.outputs === undefined ? {} : { [jobId]: { outputs: polled.outputs } }
  const list = outputsOfHistory(histShape, jobId)
  const texts = textsOfHistory(histShape, jobId)

  /* 判据按**类别**分，不是一刀切：
   *
   * · `text`（反推提示词 / 文本生成）→ **有文本就算成功**，文件可有可无；
   * · 其余（图片 / 视频 / 音频 / 各种 i2i）→ **必须至少一个文件**，光有文本不算数 ——
   *   它们要的确实是文件，只看文本会让「工作流配错、只回了一段日志」也被当成成功。
   *
   * 两条都没有才判失败，错误文案把「两条路都空」说清，免得人只去查文件那一条。 */
  const wantsText = opts.category === 'text'
  const hasNothing = list.length === 0 && texts.length === 0
  if (hasNothing || (!wantsText && list.length === 0)) {
    throw new Error(
      opts.category === 'text'
        ? 'ComfyUI 跑完了但没有文本产出（检查文本节点的输出是否接在 output_text 标记的节点上）'
        : 'ComfyUI 跑完了但没有产出文件（检查工作流的 output_image / output_video / output_audio 标记是否标在保存节点上）',
    )
  }
  const files: DownloadedAsset[] = []
  for (const item of list) {
    files.push(await downloadView(http, item.filename, item.type, item.subfolder))
  }
  return { jobId, files, texts }
}

