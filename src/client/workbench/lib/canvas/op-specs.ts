/** 图像操作（扩图 / 超分 / 反推提示词）的纯函数层（用户 m02814 #61 / #63）。
 *
 * ## 为什么这一层要存在
 *
 * 真跑要靠后端（`POST /generate` 带 `op`）。但有三件事**必须在界面上算清楚**，
 * 而且都能单独测：
 *
 * 1. **这个 op 需要什么**（要不要底图、要不要提示词、要不要遮罩）——
 *    少给一样后端会**静默用占位图**，任务成功、结果全错；
 * 2. **这个 op 在这个模型上做得到吗**（`upscale` / `superResolve` 在内置清单里
 *    没有工作流，渠道没挂就必然失败）；
 * 3. **反推出来的文本该填到哪里**（`data.prompt`，不是 `data.text`）。
 *
 * 这三条全是「算」，不需要 canvas、不需要网络 —— 所以它们能验。
 */

import type { GenOp } from '../../content-canvas-store.ts'

/** 一个 op 的说明书（界面据此显示/禁用、提交前据此校验）。 */
export interface OpSpec {
  /** op 本身。 */
  op: GenOp
  /** 按钮上的名字（文案守 R6：名词短语、不用第二人称、不做疑问句）。 */
  label: string
  /** 一句说明「它对这张图做什么」。 */
  hint: string
  /** 必须给底图（`refs[0]`）。**四个都要求**，见 `REQUIRES_REF`。 */
  needsRef: boolean
  /** 是否要提示词（用户想让它改成什么）。 */
  needsPrompt: boolean
  /** 是否要遮罩（只有局部重绘要）。 */
  needsMask: boolean
  /** 结果落到哪儿。`text` = 填进 `data.prompt`（那是输入），不是 `data.text`（那是产出）。 */
  result: 'artifact' | 'prompt'
  /**
   * 这个操作**停用了**（票 76，2026-10-29）。
   *
   * ## 停用不等于删除
   *
   * 「反推提示词」那条路要的是**文本模型**，而渠道里已经没有「文本」这一类了
   * （用户定：文本统一走 dsh）。用户选的是「先停掉」，不是「删掉」——
   * 以后若接上 dsh 的视觉模型，这条要能回来。
   *
   * 所以规格**留在表里**、带一个 `disabled: true`，界面据此不渲染那颗按钮。
   *
   * ⚠️ **不许把这个字段当成「删除」的替代**：`OP_SPECS` 里那条要一直在，
   * 否则「以后能回来」就等于「以后要重写一遍」，而且 `result: 'prompt'`
   * 那条判据（填进 `data.prompt` 还是 `data.text`）也会跟着丢。
   */
  disabled?: boolean
  /** 停用的原因（一句话，界面可以显示，也写给下一个读代码的人）。 */
  disabledWhy?: string
}

/**
 * 四个 op 的说明书。
 *
 * ⚠️ 加 op 时**必须回来补一条**：`tests/image-ops.mjs` 有一条按
 * `GEN_OPS` 遍历的断言（漏了会红）。
 */
export const OP_SPECS: readonly OpSpec[] = [
  {
    op: 'inpaint',
    label: '局部重绘',
    hint: '涂出要改的区域，只重画那一块',
    needsRef: true,
    needsPrompt: true,
    needsMask: true,
    result: 'artifact',
  },
  {
    op: 'upscale',
    label: '放大',
    hint: '把这张图放大（渠道要挂了放大工作流才做得到）',
    needsRef: true,
    /* 放大不要提示词：它只是把图变大，没有「改成什么」这一说。 */
    needsPrompt: false,
    needsMask: false,
    result: 'artifact',
  },
  {
    op: 'superResolve',
    label: '超分',
    hint: '把这张图补细节（渠道要挂了超分工作流才做得到）',
    needsRef: true,
    needsPrompt: false,
    needsMask: false,
    result: 'artifact',
  },
  {
    op: 'caption',
    label: '反推提示词',
    /* ⚠️ 票 76（2026-10-29）：**停用，不删**。
     *
     * 它要的是文本模型，而渠道里已经去掉「文本」这一类（文本统一走 dsh）。
     * 用户选的是「先停掉」—— 以后接上 dsh 的视觉模型这条路要能回来，
     * 所以规格留在表里、只加一个标记。
     *
     * `hint` 也改掉了：原来写的是「看图写一段提示词，结果填进提示词框」，
     * 那是**可用状态下**的说明；现在这颗按钮根本不显示，谁要是看到这句
     * 说明去看代码，会以为它还能用。 */
    hint: '已停用：文本统一走 dsh，这条入口暂时没有替代做法',
    needsRef: true,
    needsPrompt: false,
    needsMask: false,
    /* ★ 结果进 `data.prompt`（输入），**不是** `data.text`（产出）。 */
    result: 'prompt',
    disabled: true,
    disabledWhy: '文本统一走 dsh，不再由工作台渠道生成',
  },
  {
    op: 'angle',
    label: '换角度',
    hint: '换一个机位看同一件东西',
    needsRef: true,
    needsPrompt: false,
    needsMask: false,
    result: 'artifact',
  },
]

/**
 * 查一个 op 的说明书。
 * @param op - 操作。
 * @returns 说明书；不认识的 op 给 `undefined`（界面据此不显示那个入口）。
 */
export function opSpecOf(op: GenOp): OpSpec | undefined {
  return OP_SPECS.find(s => s.op === op)
}

/**
 * 一次提交缺了什么（**纯函数**，判据 2 / 3 / 4 都落在这里）。
 *
 * ## 为什么要一个函数而不是三处 if
 *
 * 缺哪一样**后果不一样**，所以文案不能混：
 * · 缺底图 → 后端用占位图、任务成功、结果无关的图；
 * · 缺遮罩（局部重绘）→ 后端用工作流自带遮罩、任务成功、整张图被重画；
 * · 缺提示词 → 后端拿到空串，结果靠模型自由发挥。
 *
 * 三种都必须说清是哪一种，所以返回**第一个**缺的（顺序按严重程度）：
 * 底图 → 遮罩 → 提示词。
 *
 * @param spec - 这个 op 的说明书。
 * @param given - 现在有什么。
 * @returns 缺的那一项的说明；都齐了给空串。
 */
export function missingForOp(
  spec: OpSpec,
  given: { ref?: string, prompt?: string, maskBase64?: string },
): string {
  if (spec.needsRef && (given.ref ?? '').trim() === '') {
    return '这个操作要先有底图（当前节点还没有产物）'
  }
  if (spec.needsMask && (given.maskBase64 ?? '').trim() === '') {
    return '还没有涂遮罩 —— 不涂的话后端会用工作流自带的遮罩，整张图会被重画'
  }
  if (spec.needsPrompt && (given.prompt ?? '').trim() === '') {
    return '要写清楚想把这块改成什么'
  }
  return ''
}

/**
 * 反推提示词的结果该填到哪个字段（判据 4）。
 *
 * ## 为什么单独一个函数
 *
 * 「填进 `data.prompt` 还是 `data.text`」是本批最容易写反的一处，
 * 而且**写反了不报错**：提示词框空着、产出区多了一段文字，
 * 用户下次生成还用旧提示词。用一个函数把这件事钉住，判据直接对着它写。
 *
 * @param spec - 这个 op 的说明书。
 * @returns `'prompt'`（填进输入）或 `'text'`（填进产出）。
 */
export function resultFieldOf(spec: OpSpec): 'prompt' | 'text' {
  return spec.result === 'prompt' ? 'prompt' : 'text'
}

/**
 * 这个 op 在当前有没有可用模型（判据 3）。
 *
 * ## 为什么按「模型数量」判而不是「列表里有没有某个 op」
 *
 * `GET /gen-models?op=upscale` 返回的**已经过滤过**（宿主半只列真能给这个 op
 * 提供工作流的渠道的模型）。所以「列表空」就等于「这个 op 现在做不了」。
 *
 * @param models - 按 op 过滤之后的模型清单。
 * @returns 能做给 true。
 */
export function opAvailable(models: readonly unknown[]): boolean {
  return models.length > 0
}

/**
 * 这个 op 做不了时的说明（**不许静默**）。
 *
 * @param spec - 这个 op 的说明书。
 * @returns 一句话讲清「为什么做不了、去哪儿配」。
 */
export function opUnavailableReason(spec: OpSpec): string {
  return '当前没有渠道能做「' + spec.label + '」—— 去渠道设置里给它挂一份对应的工作流'
}
