/** 把纯文本里的 `**粗体**` 渲染成真正的粗体 —— **全仓唯一一份实现**。
 *
 * ## 为什么单拎一个文件（2026-10-25 契约 BJ）
 *
 * 这份规则原来住在 `PromptBoard.tsx` 里（那个板块的模板正文要用）。
 * 后来内容板块的**提示词库**也要用：`prompt-sources/*.json` 里有 8 条正文
 * 带 Markdown 粗体标记（合计 140 处 `**`），不渲染就是原样露两颗星。
 *
 * 两处各写一份的后果很清楚：改一处忘一处，用户会在其中一个板块里看到星号。
 * 与 `placeDemo` 改调 `placeResult` 是同一个判断 —— **规则只留一份**。
 *
 * ## 为什么不引 Markdown 库
 *
 * 真正用到的只有粗体（其它都是纯文本、缩进、短横线）。
 * 引一个库要处理标题 / 列表 / 代码块 / 链接 / HTML 转义，全是这里用不到的东西，
 * 而且它会把 `#`、`|` 之类吃成结构 —— 用户的提示词原文里有这些字符时反而会变形。
 *
 * ## ⚠️ 只作用于**只读展示**，绝不作用于复制
 *
 * 复制到剪贴板的、编辑态 textarea 里的，**必须保持带 `**`** ——
 * 复制出去的是喂给模型的提示词，Markdown 粗体在那里是正常写法。
 *
 * 所以：`Copy`（`PromptBoard.tsx`）与提示词库的「复制」按钮**都不许过这个函数**。
 * 一旦有人图省事把 `renderEmphasis(...)` 的输出拿去复制，模型收到的是
 * 「粗体的显示结果」而不是原文 —— 而 Markdown 记号已经没了。
 *
 * ## ⚠️ 与 `templates/emphasis.ts` 的 `BOLD` 是两个东西
 *
 * · `templates/emphasis.ts` 的 `BOLD` 是**数据侧**的常量：模板正文用 `${BOLD}` 拼出
 *   `**`，好让源码里没有字面量（`tests/copy-no-markdown.mjs` 的 ① 段盯着这一点）；
 * · 本文件是**显示侧**：把已经带 `**` 的字符串渲染成 `<strong>`。
 *
 * 两者别名相近，改的时候别弄混。这个文件**不 import** 那个常量。
 */
import type { ReactNode } from 'react'

/**
 * 把一段纯文本里的 `**粗体**` 渲染成真正的粗体，其余原样。
 *
 * ## 匹配规则（别放宽）
 *
 * 正则：两对星号夹住要加粗的那一段。标记段**不许跨行、不许再含星号**（正则原文在函数体里）。
 *
 * 为什么：提示词里的粗体都是短语级别。允许跨行会把两个不相关的星号配成一对，
 * 吃掉中间一大段（那一段原本是正文，会整块变成粗体甚至消失）。
 * 实测那 8 条带标记的正文里，140 处全部是短语级、没有一处跨行 —— 这个限制是安全的。
 *
 * ## 一个都没匹配到就原样返回字符串
 *
 * 不是为了省事，而是为了让 React 拿到**稳定的字符串**（而不是长度 1 的数组）：
 * 数组每次渲染都是新引用，会让下游 `useMemo` 一类的判断失效。
 *
 * @param text - 原文（可能带 `**`）。
 * @returns 可以放进 JSX 的节点（字符串与 `<strong>` 混合）。
 */
export function renderEmphasis(text: string): ReactNode {
  /* 一行里可能有多个粗体，所以全扫，不当成「只有一个匹配」。 */
  const out: ReactNode[] = []
  let last = 0
  const re = /\*\*([^*\n]+)\*\*/g
  let m = re.exec(text)
  while (m !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <strong key={'b' + String(m.index)} className="font-semibold text-[var(--dsw-alias-label-primary)]">{m[1]}</strong>,
    )
    last = m.index + m[0].length
    m = re.exec(text)
  }
  if (last === 0) return text
  if (last < text.length) out.push(text.slice(last))
  return out
}
