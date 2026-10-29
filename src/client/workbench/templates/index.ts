/** 模板库的汇总入口：分类表 + 全部模板。
 *
 * ## 为什么在这里汇总
 *
 * 一个分类一个文件（`optimize.ts` / `iterate.ts` / `extract.ts` / `image.ts` /
 * `evaluation.ts`），加模板只动一个文件；界面组件只认这里导出的
 * `PROMPT_TEMPLATES`，不需要知道有几个分类。
 *
 * ## 顺序
 *
 * 分类顺序 = 左栏分组顺序 = 数组顺序（不排序、不靠名字猜）。
 * 模板顺序 = 各文件里的数组顺序。
 *
 * ## 五个分类怎么来的（2026-10-23 契约 K）
 *
 * 原来是三个（优化 / 迭代 / 提取）。参考项目还有两类内容我们一直没有：
 * 面向文生图 / 图生图的**图像**类，以及给提示词打分找问题的**评估**类。
 * 用户拍板「参考项目还有别的就都做过来」，于是扩成五个。
 *
 * 参考项目的 11 个目录**没有照搬**：它的分类是它的界面分组，硬搬会让左栏
 * 长到没法用。每个模板的来源目录写在 `desc` 末尾，将来要拆随时能拆。
 *
 * ## 许可证（重要）
 *
 * 全部模板正文改编自 prompt-optimizer（AGPL-3.0），**只作提示词内容使用，未复制其代码**。
 * 每个数据文件头都有同一条注记；这里再写一次，因为这是别人最先打开的文件。
 */
import type { PromptCategory, PromptTemplate } from './types.ts'
import { OPTIMIZE_TEMPLATES } from './optimize.ts'
import { ITERATE_TEMPLATES } from './iterate.ts'
import { EXTRACT_TEMPLATES } from './extract.ts'
import { IMAGE_TEMPLATES } from './image.ts'
import { EVALUATION_TEMPLATES } from './evaluation.ts'

/** 五个分类（顺序就是界面上的分组顺序）。 */
export const PROMPT_CATEGORIES: readonly PromptCategory[] = [
  { id: 'optimize', label: '优化' },
  { id: 'iterate', label: '迭代' },
  { id: 'extract', label: '提取' },
  { id: 'image', label: '图像' },
  { id: 'evaluation', label: '评估' },
]

/** 全部模板（按分类顺序拼起来）。 */
export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  ...OPTIMIZE_TEMPLATES,
  ...ITERATE_TEMPLATES,
  ...EXTRACT_TEMPLATES,
  ...IMAGE_TEMPLATES,
  ...EVALUATION_TEMPLATES,
]

/**
 * 按分类取模板。
 * @param category - 分类 id。
 * @returns 该分类下的模板（没这个分类就是空数组）。
 */
export function templatesOf(category: string): readonly PromptTemplate[] {
  return PROMPT_TEMPLATES.filter(t => t.category === category)
}

/**
 * 按 id 取模板。
 * @param id - 模板 id。
 * @returns 模板；找不到返回 undefined（**不抛**：存档里的旧 id 失效时不该白屏）。
 */
export function templateById(id: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.find(t => t.id === id)
}

export type { PromptCategory, PromptTemplate } from './types.ts'
export { findVars, fillVars, engineFields } from './vars.ts'
export type { PromptVar } from './vars.ts'
/* 英文变量名的中文说法（2026-10-23 契约 U）。**只管显示**，正文与替换路都不用它。 */
export { VAR_LABELS, varLabel } from './var-labels.ts'
export type { VarLabel } from './var-labels.ts'
