/** 模型类型标签（票 67 建、票 74 收成四类，2026-10-29）。
 *
 * # 四类：文本 / 图片 / 视频 / 音频
 *
 * 用户 2026-10-29 原话：「模型清单就是先渠道，然后每个渠道几个模型，
 * 每个模型下面4个选项，文本，图片，视频，音频。手动勾选就行了。」
 *
 * 票 67 当时做成了五类（把「图片」拆成文生图与图生图），用户这次把它推翻一半。
 * 所以本文件回到四类，**与 `caps` 的四个值一一对应**。
 *
 * # ⚠️ 为什么不与 `categoryOf` 合并（这一条最要紧）
 *
 * 项目里现在有两套「分类」，**必须分开**：
 *
 * | 名字 | 值 | 谁在用 | 回答的问题 |
 * |---|---|---|---|
 * | `MODEL_TYPES`（本文件） | `text` / `image` / `video` / `audio` | 界面分组、默认模型、节点找模型 | 这条模型在界面上**算哪一类** |
 * | `categoryOf`（`generate.ts:194`） | `t2i` / `i2i` / `inpaint` / `upscale` / `superResolve` / `caption` / `angle` / `omniVideo` / `frameVideo` / `audio` / `text` | 选哪份 ComfyUI 工作流 | 这一次**跑哪一份工作流** |
 *
 * **`categoryOf` 分不出「这个模型是哪一类」，`MODEL_TYPES` 也分不出「这次该跑哪份工作流」。**
 * 把它们合并的后果很具体：图生图与文生图会走同一份工作流 ——
 * 图生图那次会拿着一份没有参考图槽位的 ComfyUI 图去跑，出来一张跟参考图无关的图。
 *
 * ## 这条教训发生过两次（写在这是为了不再有第三次）
 *
 * · 票 67 把类型拆成五类时，差点顺手把 `categoryOf` 也按五类简化；
 * · 票 74 把类型退回四类时，又差点顺手把 `categoryOf` 一起退成四类。
 *
 * 两次都是同一个念头：「既然分类变了，那个分类也一起改吧」。
 * 两次都会让图生图跑错工作流。**改这里的时候不要动 `categoryOf`。**
 *
 * `tests/category-lock.mjs` 用一张逐字写死的期望表钉住 `categoryOf`，
 * 谁动它谁红 —— 不靠人看输出。
 *
 * # 为什么「推导」而不是「另存一份标签」
 *
 * 老渠道（票 67 之前存进 `channels.json` 的）里没有 `types` 这个键。
 * 要是规定「必须手工打标签」，用户升级完看到的是一片「无类型」。
 *
 * 所以缺省时**从 `caps` 推导**（`typesOfModel`）：老数据不用动就能用。
 *
 * ⚠️ **推导只在读的时候做，不写回磁盘**。写回就是静默改用户数据 ——
 * 用户打开一个文件发现多了一堆自己没写过的键，那是最难信任的一种行为。
 */

import type { ChannelModel } from './channels.ts'

/** 三类（**顺序是契约**：界面按它排列，票面第 1 条验收钉着这个顺序）。
 *
 * ## 票 76（2026-10-29）：渠道里去掉「文本」这一类
 *
 * 用户定：文本统一走 dsh，哪怕是在工作台加的渠道。所以界面上不再有「文本」这个勾选框。
 *
 * ⚠️ **`CAPS` 仍是四值**（`image/video/text/audio`）。`caps` 是「这个模型物理上
 * 能不能做这件事」，`MODEL_TYPES` 是「界面上分几类」。ComfyUI 那份本地文本工作流
 * 还挂在渠道上（`text-qwen3-5`），所以 `caps` 里的 `text` 一个字节都不许删 ——
 * 删了既有渠道数据全错（`generate.ts:545` 的能力校验就靠它）。
 *
 * 只有文本能力的模型现在推导出**空数组**（清单里显示「无类型」），那是对的：
 * 它在界面上不属于任何一格。 */
export const MODEL_TYPES = ['image', 'video', 'audio'] as const

/** 一类。 */
export type ModelType = typeof MODEL_TYPES[number]

/**
 * 中文名（R6：不用第二人称、不用口语词、不用疑问句）。
 *
 * ⚠️ 界面侧（票 68）必须用同一份措辞，否则同一件事在两处叫两个名字。
 */
export const MODEL_TYPE_LABEL: Record<ModelType, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
}

/**
 * 票 67 用过两天的旧取值 → 现在归到哪一类（票 74）。
 *
 * `t2i`（文生图）与 `i2i`（图生图）现在都算 `image` 一类。
 *
 * ## ⚠️ 它们**不进 `MODEL_TYPES`**
 *
 * 进了的话界面那个「四个勾选框」会冒出两个不该有的选项。
 * 这张表只用来**认旧值**（`/gen-models?type=t2i` 那种），不是可选项清单。
 *
 * ## 为什么旧取值「当 image」而不是「拒掉」
 *
 * 界面（票 68 那一版）可能还在发 `?type=t2i`。拒掉等于模型下拉突然空了，
 * 而且要一直空到界面重做完。当 `image` 处理是**语义安全**的：
 * `t2i` / `i2i` 本来就都是 `image` 的子集，放宽范围不会选到做不了这件事的模型 ——
 * 真做不了的那条由 `generate.ts` 的 `caps` 校验拦住。
 *
 * 一句话：**筛窄了会误伤既有调用方，筛宽了最坏只是多列几个模型。**
 */
export const LEGACY_TYPE_ALIAS: Record<string, ModelType> = {
  t2i: 'image',
  i2i: 'image',
}

/**
 * 这个字符串是不是四类之一（票 74 之前是五类）。
 * @param raw - 待查值。
 * @returns 是就 true（顺带收窄类型）。
 */
export function isModelType(raw: unknown): raw is ModelType {
  return typeof raw === 'string' && (MODEL_TYPES as readonly string[]).includes(raw)
}

/**
 * `caps` 里的一个值 → 它能推导出哪些类型。
 *
 * ## 四类与四个 `caps` 一一对应
 *
 * 票 74 之后这里**没有一处多给**：`image` 只给 `image`，不再拆成
 * 文生图与图生图。上一版在这里拆成两格，是为了让界面分两栏列默认模型 ——
 * 用户现在的答复是「四个选项，手动勾选就行」，那两格不要了。
 *
 * @param cap - `caps` 里的一个值。
 * @returns 它能推导出的类型（可能为空）。
 */
export function typesOfCap(cap: string): ModelType[] {
  switch (cap) {
    /* ⚠️ 票 76：`text` 不再推导出任何类型。
     *
     * 为什么不是把它从 `switch` 里删掉走 `default: return []`：那样将来谁加一条
     * 「不认识的 cap 就当 text」的兜底，这条会**静默复活**。显式写一行
     * 空数组，读代码的人一眼看到「文本这一类是被**有意**去掉的」。 */
    case 'text': return []
    /* 票 74：不再拆成文生图与图生图 —— 用户要的是「图片」一格。
     * 拆开之后那两格在界面上各要一个默认模型，而用户明确说「四个选项」。 */
    case 'image': return ['image']
    case 'video': return ['video']
    case 'audio': return ['audio']
    /* 不认识的能力值（上游给的新词）：不推导。
     * 静默当成某一类会让界面把它列到错的那一栏里去。 */
    default: return []
  }
}

/**
 * 一条模型算哪几类（**纯函数**）。
 *
 * 有 `types` 就照它（用户手工标过的为准，会先按闭集过滤掉不认识的）；
 * 没有就按 `caps` 推导。
 *
 * ## 为什么手工标了就不再推导
 *
 * 「标过」的意思是用户明确说了这条模型在界面上算哪类。而 `caps` 是
 * 「上游能做哪些活」，两者可以不一样（Gemini 能做图生图那种情况，
 * 用户可能就是要手动排除掉）。推导只在**没人告诉我**的时候用。
 *
 * @param m - 模型（`types` 可选）。
 * @returns 类型数组（顺序按 `MODEL_TYPES`，去重）。
 */
export function typesOfModel(m: Pick<ChannelModel, 'caps'> & { types?: string[] }): ModelType[] {
  const hand = Array.isArray(m.types) ? m.types : []
  if (hand.length > 0) {
    /* 按闭集顺序输出、顺带去重：手标顺序不该影响界面上的排列。 */
    return MODEL_TYPES.filter(t => hand.includes(t))
  }
  const out = new Set<ModelType>()
  for (const cap of m.caps) for (const t of typesOfCap(cap)) out.add(t)
  return MODEL_TYPES.filter(t => out.has(t))
}
