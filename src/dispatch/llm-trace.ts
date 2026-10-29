/** 一次模型调用留下的**痕迹**（2026-10-23，计划 `plans/电商AI工作台-2026-10-23-06-执行-模型调用留痕.md`）。
 *
 * ## 为什么单开一个文件
 *
 * 这份形状**三方都要用**：执行方（`src/dispatch/`）产出它、工作流引擎（`src/workflow/`）
 * 把它写进运行记录、界面（`src/client/`）读出来显示。
 * 三处各写一遍必然漂（见 `pitfalls/同一件事写两份迟早漂.md`），所以只定义一次。
 *
 * ⚠️ 本文件**不 import 任何东西**（连 `node:` 都不引）—— 界面也要引它，
 * 带了 Node 内置模块就打不进客户端产物。这与 `browser-prefs.ts` 的分法同一条纪律。
 *
 * ## 字段从哪来（照 Dify 的字段集、照 n8n 的克制）
 *
 * | 字段 | 参照 |
 * | --- | --- |
 * | `provider` / `model` | Dify 的 `model_provider` / `model_name` |
 * | 三个 token 数 | Dify 的 `usage`、n8n 的 `tokenUsage` |
 * | `finish` | Dify 的 `finish_reason` |
 * | `promptPreview` / `outputPreview` | Dify 存全量 prompts/outputs，**我们只存摘要** |
 *
 * 为什么不存全文：运行记录每份工作流留 60 次、每节点最多 400 条明细，
 * 按每条两份 500 字算最坏约 400KB（见 `TRACE_TEXT_PREVIEW` 的注释）。
 * 再大就会让记录文件变成没人敢打开的东西，而本项目还没有任何清理机制。
 */

/**
 * 摘要（提示词 / 回答）各留多少字。
 *
 * 定 500：运行记录的上限是「每份工作流 60 次 × 每节点 400 条明细」，
 * 最坏情况 `400 × 2 × 500 ≈ 400KB`，比已有的日志上限还小。
 */
export const TRACE_TEXT_PREVIEW = 500

/** 一次模型调用留下的痕迹。 */
export interface LlmTrace {
  /** 提供方（dsh 的 provider id，如 `deepseek-official`）。 */
  provider: string
  /** 模型 id。 */
  model: string
  /**
   * 输入 token 数。
   *
   * ⚠️ 官方 `TokenUsage` 的计数是**互斥**的：这里是**未命中缓存的那部分**输入，
   * 命中缓存另计（`cacheReadTokens`）。不要把两者相加当成「输入 token」。
   */
  inputTokens?: number
  /** 输出 token 数。 */
  outputTokens?: number
  /** 合计。**上游没给就不写这个键** —— 不许用前面两个自己算一个冒充。 */
  totalTokens?: number
  /** 结束原因：`stop` / `max-tokens` / `error` / `aborted`（或 adapter 报的其它值）。 */
  finish: string
  /** 提示词前若干字（上限见 `TRACE_TEXT_PREVIEW`）。 */
  promptPreview?: string
  /** 回答前若干字。 */
  outputPreview?: string
  /**
   * 上面两个摘要是否被截断过。
   *
   * ⚠️ **只在真截了时才是 `true`**；没截时**不写这个键**（不写 `false`）——
   * 少一个键就少一份要靠读代码才知道含义的状态。
   */
  truncated?: boolean
}

/**
 * 把一段文本截到 {@link TRACE_TEXT_PREVIEW} 字。
 *
 * 纯函数（不碰磁盘、不看环境），所以两侧都能直接调、也能单测。
 *
 * @param text - 原始文本。
 * @returns `text` 是（可能被截短的）文本，`truncated` 表示截过没有。
 */
export function truncateTraceText(text: string): { text: string, truncated: boolean } {
  if (text.length <= TRACE_TEXT_PREVIEW) return { text, truncated: false }
  return { text: text.slice(0, TRACE_TEXT_PREVIEW), truncated: true }
}

/** `finish` 给用户看的说法（键是 `reason.kind`）。 */
const FINISH_LABEL: Record<string, string> = {
  stop: '结束 stop',
  'max-tokens': '结束 达到 token 上限',
  error: '结束 出错',
  aborted: '结束 中断',
  /* 流没走到 `finish` 就断了 —— 如实说「不知道」，不编一个 `stop`。
   * ⚠️ 这一条自带「结束」两个字：拼的时候别再前缀一次，否则会成「结束 结束原因未知」。 */
  unknown: '结束原因未知',
}

/**
 * 把一份痕迹变成**一行给人看的文字**。
 *
 * ## 界面直接调它，别在界面里重新拼字符串
 *
 * 这一行的拼法（哪几段留、用什么分隔、什么词）是**规则**，规则只该有一份。
 * 界面各处自己拼，改一次文案就要翻好几处，而且必然有人漏 ——
 * 那就成了「历史面板写着『出错』、画布写着『失败』」这种没人认得出是同一件事的状态。
 *
 * ## 拿不到的字段整段省略
 *
 * 没 token 就**不出现** `输入 / 输出` 那一段，绝不写「输入 0 / 输出 0」
 * （0 是实测值，缺失是没测到 —— 两件事，见 `LlmTrace.inputTokens` 的注释）。
 * `finish` 为 `unknown` 时显示「结束原因未知」，不露英文 `unknown` 给用户看。
 *
 * @param trace - 一份模型痕迹。
 * @returns 一行文字，形如
 *   `模型 deepseek-official/deepseek-v4-flash · 输入 120 / 输出 45 token · 结束 stop`；
 *   带截断时末尾再加 `（摘要已截断）`。
 */
export function formatTraceLine(trace: LlmTrace): string {
  const parts: string[] = ['模型 ' + trace.provider + '/' + trace.model]
  /* token 段：输入输出**都**没有时整段不写。只有一个时也只写那一个
   * （「输入 120 token」是有意义的，不该因为缺输出就把输入也藏起来）。 */
  const tokens: string[] = []
  if (trace.inputTokens !== undefined) tokens.push('输入 ' + String(trace.inputTokens))
  if (trace.outputTokens !== undefined) tokens.push('输出 ' + String(trace.outputTokens))
  if (tokens.length > 0) parts.push(tokens.join(' / ') + ' token')
  else if (trace.totalTokens !== undefined) parts.push('合计 ' + String(trace.totalTokens) + ' token')
  /* 结束原因：认得的用上表（已经带好「结束」二字），不认得的原样给
   * （adapter 可能报我们没见过的值，丢掉它比露一个陌生词更糟 —— 那正是诊断线索）。 */
  parts.push(FINISH_LABEL[trace.finish] ?? ('结束 ' + trace.finish))
  const line = parts.join(' · ')
  return trace.truncated === true ? line + '（摘要已截断）' : line
}
