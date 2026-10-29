/** 英文变量名的**中文说法**（2026-10-23 契约 U）。
 *
 * ## 为什么需要这份表
 *
 * 用户 m02240 第 2 条原话：「那些变量都是写的变量名称是英文，没有说明吗？」
 *
 * 搬完 62 个模板后，界面上会出现 `originalPrompt`、`workspacePrompt`、
 * `lastOptimizedPrompt` 这种名字。它们对我们（写代码时按参考项目的字段名抄的）
 * 是清楚的，对用户不是 —— 一个中文界面里冒出一串英文键名，等于没写说明。
 *
 * ## 这里**只管显示**，不动正文
 *
 * 正文里的 `{{originalPrompt}}` **原样保留**：那是与参考项目对账的唯一凭据，
 * 改了正文就再也对不上（`templates/*.ts` 的文件头都写着这条纪律）。
 * 本表只给界面提供「这个名字中文怎么说」。
 *
 * ⚠️ **复制到剪贴板、喂给模型的内容也不受影响**：`fillVars` 按 `{{原名}}`
 * 替换，本表根本不参与那条路。所以「显示中文」与「内容原样」两件事不冲突。
 *
 * ## 每条怎么写
 *
 * - `label` —— **名词短语**，不是句子。它是输入框上方那行字。
 * - `hint` —— 一句话说清「填什么」+「从哪来」。**不许同义反复**
 *   （`originalPrompt` 写「输入原始提示词」等于没说；要写「要拿去优化的那段原文，
 *   从现有提示词里整段粘过来」）。
 *
 * 守 R6（`AGENTS.md`）：不用第二人称、不用口语词、不用疑问句做标签。
 *
 * ## 名字与语义的出处（每个都查过参考项目，不是猜的）
 *
 * | 名字 | 语义依据 |
 * | --- | --- |
 * | `originalPrompt` | `packages/core/src/services/context/constants.ts:16`（`PREDEFINED_VARIABLES` 第一项） |
 * | `lastOptimizedPrompt` | 同上 `:17` |
 * | `iterateInput` | 同上 `:18`（`iteratePrompt(originalPrompt, lastOptimizedPrompt, iterateInput, …)`，`services/prompt/electron-proxy.ts:58`） |
 * | `workspacePrompt` | `services/evaluation/service.ts:469`（`request.target.workspacePrompt` —— **工作区里那份当前提示词**，与「用户手里那份原文」是两个东西） |
 * | `referencePrompt` | `services/evaluation/service.ts:1778`（`originalPrompt: referencePrompt` 与 `referencePrompt` 并列出现，指的是**参考图/参照物那一份**） |
 * | `iterateRequirement` | `services/evaluation/types.ts:421`（注释原文「迭代需求（来自 iterationNote）」） |
 * | `promptRequirement` | `packages/ui/src/services/ImageStyleExtractor.ts:373`（值是 `trimmedOriginalPrompt`，为空时给一句默认说明 —— 即**这次生图的具体要求**） |
 * | `promptContent` | `services/variable-extraction/types.ts:14`（被提取变量的那段提示词正文） |
 * | `focusBrief` | `services/evaluation/service.ts:602-604`（`request.focus.content` —— **这次评分的关注点**） |
 * | `analysisStage` | `services/template/default-templates/evaluation/image/content.ts:168-169`（取值 `original-input` / `workspace`，说明**这次评估看的是原始输入还是工作区里那份**） |
 *
 * ## ⚠️ 五个名字**故意没配**：它们不是用户要填的变量
 *
 * `placeholder`、`location_theme`、`headline_text`、`title_text`、`reference_style`
 * 在 62 个模板正文里**只出现在转义示例区**
 * （`{{=<% %>=}}{{名字}}<%={{ }}=%>` 这种写法里），意思是「正文里**可能**出现的
 * 占位符长这样」，是**给模型看的举例**，不是让用户填的位置。
 *
 * 实测（2026-10-23 扫全库）：这 5 个名字在转义区里出现 32 次，**区外 0 次**。
 *
 * 但 `findVars` **目前不认转义区**（它只跳过语法与引擎字段名，见 `vars.ts` 的说明），
 * 所以它们仍会在界面上冒出输入框。给它们配中文标签会**掩盖**这个结构问题：
 * 用户看到一个体面的中文标签，更不会怀疑这个框本来就不该存在。
 *
 * 所以本表**不给它们编说明**，界面按「没配标签」处理 —— 显示原名。
 * 真正的修法在 `vars.ts`（跳过转义区），那是另一件事，等定。
 */

/** 一个变量的中文说法。 */
export interface VarLabel {
  /** 名词短语（输入框上方那行字）。 */
  label: string
  /** 一句话说明「填什么」+「从哪来」（悬停显示）。 */
  hint: string
}

/**
 * 英文变量名 → 中文说法。
 *
 * ⚠️ **键必须是正文里的原名**（区分大小写，含下划线）。本表不参与替换，
 * 只参与显示；键写错了不会报错，只会「界面上还是英文」——
 * `tests/prompt-optimize.mjs` 有一条断言逐个核对「键能在某个模板正文里找到」。
 */
export const VAR_LABELS: Readonly<Record<string, VarLabel>> = {
  originalPrompt: {
    label: '原始提示词',
    hint: '要拿去优化的那段原文，从现有提示词里整段粘过来。优化结果会替换它。',
  },
  lastOptimizedPrompt: {
    label: '上次优化的结果',
    hint: '上一轮优化后的版本。迭代类模板要在它的基础上继续改，所以要连它一起给。',
  },
  iterateInput: {
    label: '这次的修改要求',
    hint: '这一轮希望怎么改（加什么、删什么、语气往哪偏）。只写这一轮的变化，不重写整段。',
  },
  iterateRequirement: {
    label: '迭代需求说明',
    hint: '评估类模板要据此判断「按这个要求改过之后有没有变好」。写清这次改动的目标。',
  },
  workspacePrompt: {
    label: '工作区当前提示词',
    hint: '工作区里正在用的那一份（可能是上一轮改过的）。与「原始提示词」不是同一份，别混。',
  },
  referencePrompt: {
    label: '参考提示词',
    hint: '作为对照标准的那一份（别人写好的、或上一版）。评估拿它来比。',
  },
  promptContent: {
    label: '待分析的提示词',
    hint: '要从里面挑出变量位置的那段正文，通常是刚写完、还没参数化的提示词。',
  },
  promptRequirement: {
    label: '这次的出图要求',
    hint: '对这次生成结果的具体要求（题材、用途、要保留什么）。留空时模板会按「只凭参考图反推」处理。',
  },
  focusBrief: {
    label: '这次的关注点',
    hint: '评估时只盯这一件事（如「输出格式稳不稳定」）。留空则做一次完整评估。',
  },
  analysisStage: {
    label: '评估对象',
    hint: '这一轮评的是「刚输进来的原始内容」还是「工作区里那份」——两种口径的评分标准不同。',
  },
}

/**
 * 取一个变量的中文说法。
 *
 * @param name - 正文里的原名。
 * @returns 有配就返回；**没配返回 undefined**（调用方显示原名，不要显示成空白）。
 */
export function varLabel(name: string): VarLabel | undefined {
  return Object.prototype.hasOwnProperty.call(VAR_LABELS, name) ? VAR_LABELS[name] : undefined
}
