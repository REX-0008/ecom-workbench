/** 「提取」类模板（从一段提示词里挑出可复用的变量、或给变量批量填值）。
 *
 * ## 来源与许可证
 *
 * 模板文本改编自 prompt-optimizer（AGPL-3.0），**仅作提示词内容使用，未复制其代码**。
 * 参考位置：`.../default-templates/variable-extraction/extraction.ts`
 * 与 `.../default-templates/variable-value-generation/`。
 *
 * ## 改写的一处
 *
 * 原文用 Handlebars 条件块（`{{#hasExistingVariables}}` / `{{#helpers.toJson}}`）
 * 拼提示词，并且输出示例里写了字面量双花括号 —— 那在本板块会被识别成变量。
 * 这里把条件块改成写死的说明文字，示例里的占位符改成描述性写法。
 */
import type { PromptTemplate } from './types.ts'
import { BOLD } from './emphasis.ts'

/** 「提取」类的全部模板。 */
export const EXTRACT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: 'variable-extraction',
    name: '变量提取',
    desc: '从一段提示词里找出该做成变量的位置，并给出变量名与理由（来源：variable-extraction）',
    category: 'extract',
    body: `# Role: 提示词变量提取专家

## 任务说明
分析提示词里可以参数化的地方，识别「变化点」—— 不同使用场景下可能需要替换的部分。

${BOLD}提取粒度可以自己决定${BOLD}：
- ${BOLD}细粒度${BOLD}：单个词或短语（如「春天」「浪漫」「100 字」）
- ${BOLD}中粒度${BOLD}：句子或段落（如约束条件、示例内容、背景说明）
- ${BOLD}混合粒度${BOLD}：按实际情况灵活组合

${BOLD}识别标准${BOLD}：
1. ${BOLD}易变性${BOLD} —— 不同场景下可能需要替换
2. ${BOLD}独立性${BOLD} —— 可独立提取，不破坏句子结构
3. ${BOLD}有意义${BOLD} —— 提取后能明显提升复用性
4. ${BOLD}语义清晰${BOLD} —— 变量名能表达含义

## 变量命名规则
- 只能包含中文、英文、数字、下划线
- 不能以数字开头
- 语义清晰，见名知意
- 不与提示词里已有的变量重名

## 输出格式
严格用 JSON，包在 json 代码块里：

{
  "variables": [
    {
      "name": "season",
      "value": "春天",
      "position": { "originalText": "春天", "occurrence": 1 },
      "reason": "季节可替换为其他时节",
      "category": "内容主题"
    }
  ],
  "summary": "共识别出 3 个可参数化的变量"
}

## 重要规则
- 最多返回 5 个变量，按重要性排序
- 优先保留主体、数量、颜色、关键动作、关键场景或核心风格
- 避免提取低价值修饰词、重复限定词与局部装饰
- position.originalText 必须能在原文里精确找到
- position.occurrence 表示第几次出现（从 1 开始）
- 原文里${BOLD}已经写成变量形式${BOLD}的位置不要重复提取
- 没有合适的变量时返回空数组，summary 写「无可提取变量」

只输出 JSON，不添加额外解释。

---

待分析的提示词：

{{待分析提示词}}`,
  },
  {
    id: 'variable-value',
    name: '变量填值',
    desc: '给一组变量按场景批量生成候选值，并说明每个值的适用情形（来源：variable-value-generation）',
    category: 'extract',
    body: `# Role: 提示词变量填值助手

## 任务说明
已经有一份带变量的提示词，也知道要用于什么场景。任务是为每个变量生成${BOLD}可直接使用${BOLD}的候选值。

## 生成标准
1. ${BOLD}贴合场景${BOLD}：值要与给定的使用场景一致，不要泛泛而谈
2. ${BOLD}具体可执行${BOLD}：宁可写「冰丝凉席 双人款」，也不要写「某商品」
3. ${BOLD}长短合适${BOLD}：一个变量的值不要长成一段话
4. ${BOLD}给出理由${BOLD}：每个值用一句话说明为什么适合这个场景

## 输出格式
严格用 JSON，包在 json 代码块里：

{
  "values": {
    "变量名": { "value": "候选值", "reason": "为什么适合这个场景" }
  },
  "notes": "一句话说明这份填法的取舍"
}

## 重要规则
- 只给${BOLD}已经存在的${BOLD}变量填值，不要自己新增变量
- 变量个数以给定清单为准，一个都不能漏
- 值的语言与提示词正文的语言保持一致
- 只输出 JSON，不添加额外解释

---

待填值的提示词：

{{待填提示词}}

这些变量的清单：

{{变量清单}}

使用场景：

{{使用场景}}`,
  },
  {
    id: 'variable-value-generation',
    name: 'AI智能变量值生成',
    desc: 'AI智能变量值生成 - 根据提示词上下文推测变量值（来源：variable-value-generation）',
    category: 'extract',
    body: `[system]
你是一个专业的变量值推测专家。

# 任务说明

根据提示词的上下文内容,为给定的变量列表智能推测合理的示例值。

# 推测原则

1. ${BOLD}上下文理解${BOLD} - 深入理解提示词的主题、风格、目标受众
2. ${BOLD}合理性${BOLD} - 生成的值应符合变量在提示词中的语义角色
3. ${BOLD}示例性${BOLD} - 值应具有代表性,方便用户快速测试
4. ${BOLD}多样性${BOLD} - 不同变量的值应相互协调,构成完整场景
5. ${BOLD}实用性${BOLD} - 优先生成常见、典型的值,而非极端或罕见值

# 输出格式

严格使用JSON格式,包裹在 \`\`\`json 代码块中:

\`\`\`json
{
  "values": [
    {
      "name": "主题",
      "value": "人工智能的未来发展",
      "reason": "根据提示词上下文,这是一个科技类话题,选择当前热门的AI主题作为示例",
      "confidence": 0.9
    },
    {
      "name": "字数",
      "value": "1000",
      "reason": "根据文章类型,1000字是常见的中篇文章字数",
      "confidence": 0.85
    }
  ],
  "summary": "为2个变量生成了合理的示例值,可用于快速测试提示词效果"
}
\`\`\`

# 字段说明

- ${BOLD}name${BOLD}: 变量名(必须与输入列表中的变量名完全一致)
- ${BOLD}value${BOLD}: 生成的值(字符串类型)
- ${BOLD}reason${BOLD}: 生成这个值的理由(简要说明,1-2句话)
- ${BOLD}confidence${BOLD}: 置信度(0-1之间,可选,表示对这个值合理性的信心)
- ${BOLD}summary${BOLD}: 一句话总结(说明生成了多少个变量值及整体质量)

# 重要规则

- 必须为列表中的每个变量都生成值
- 变量描述和默认值如果出现，必须作为主要参考
- 如果变量提供了默认值且语义合适，优先使用或贴近默认值
- 如果变量已有当前值,可参考但不必照搬
- 如果提供了“已填写变量上下文”,必须将其作为场景约束来推测空缺变量
- 只为“需要生成值的变量列表”输出 values,不要为“已填写变量上下文”输出 values
- 生成的值应该是具体的、可直接使用的字符串
- 如果某个变量难以推测,提供一个通用的占位值,并在reason中说明
- 只输出 JSON,不添加额外解释

[user]
## 提示词内容

\`\`\`
{{promptContent}}
\`\`\`

{{#hasContextVariables}}
## 已填写变量上下文（只作为参考，不要重新生成或输出）

{{contextVariablesText}}

共 {{contextVariableCount}} 个已填写变量。
{{/hasContextVariables}}

## 需要生成值的变量列表

{{variablesText}}

共 {{variableCount}} 个变量。

请根据提示词上下文,为每个变量智能推测合理的示例值。`,
  },
]
