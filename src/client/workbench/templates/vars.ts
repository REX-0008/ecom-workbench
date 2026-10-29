/** 从模板正文里认出「用户要填的变量」。
 *
 * ## 只做简单识别，不做通用模板引擎
 *
 * 任务书明确要求「先做简单识别，不要做通用模板引擎」。所以这里**只认一种写法**：
 *
 *   `{{变量名}}` —— 双花括号，主写法（参考项目也用它）。
 *
 * ## 为什么**不认** `[占位]` 和 `【占位】`
 *
 * 任务书提到「`{{变量}}` 或 `[占位]` 这类」。照做的第一版把半角 `[ ]` 也认成了变量，
 * 结果是：打开「通用优化」看到**二十几个输入框**（`[角色名称]`、`[具体技能]`…）。
 *
 * 那些不是让人填的 —— 它们是**给模型照着写**的结构骨架。
 * 把骨架变成输入框，等于要求用户替模型把活干了，模板也就废了。
 *
 * 所以模板正文里的骨架统一改写成全角【】（见 `optimize.ts` 文件头的约定 ①），
 * 而本文件**两种方括号都不认**：
 *
 *   · `{{原始提示词}}` → 用户填 → 出现输入框；
 *   · `【角色名称】` / `[角色名称]` → 模型填 → 不出输入框，原样留在正文里。
 *
 * ## 边界（这几种故意不认）
 *
 *   · 空的 `{{}}`、`{{ }}` —— 没名字，认不出该叫什么；
 *   · 名字里带 `{` `}` 或换行 —— 多半是把代码 / JSON 误当成了占位符；
 *   · 名字超过 20 个字 —— 那是正文，不是变量名。
 */

/** 一个被识别出来的变量。 */
export interface PromptVar {
  /** 变量名（双花括号里那段文字，已去首尾空格）。 */
  name: string
  /** 这份模板里出现了几次（同名只出一个输入框，但要能告诉用户「填了会替换 3 处」）。 */
  count: number
}

/** 双花括号：`{{名字}}`。名字里不许有大括号、换行。 */
const DOUBLE_BRACE = /\{\{\s*([^{}\n]{1,20}?)\s*\}\}/g

/**
 * 这个名字是不是**模板引擎的控制写法**（而不是给人填的变量）。
 *
 * ## 为什么必须排除（2026-10-23 契约 K 搬 62 个模板时暴露的）
 *
 * 参考项目的模板正文原样搬过来后，里面带着它自己那套 Handlebars 的指令：
 *
 * | 写法 | 是什么 |
 * | --- | --- |
 * | `{{#hasFocus}}` / `{{^hasFocus}}` / `{{/hasFocus}}` | 条件块的开、反、闭 |
 * | `{{=<% %>=}}` | 切换定界符（这一句整句是控制指令） |
 * | `{{!注释}}` | 注释 |
 * | `{{...}}` | 展开语法 |
 *
 * 这些**没有一个是让人填的**：它们由引擎在渲染时处理掉。我们的 `findVars`
 * 不认这一层的话，打开一个模板会冒出十几个空输入框，而且填了也没用
 * （正文里那几段是条件块的语法，替换掉只会把指令写坏）。
 *
 * ⚠️ 判据只认**语法形状**（开头的 `#` `/` `^` `!` `~` `<` 或整段就是 `...`），
 * **不猜名字的含义**。「这个名字是引擎给的还是用户填的」不在这里判 ——
 * 那需要参考项目引擎的上下文，我们手上没有。
 *
 * @param name - `{{}}` 里那段（已 trim）。
 * @returns 是控制写法就 true。
 */
function isEngineSyntax(name: string): boolean {
  if (name === '...' || name === 'else') return true
  /* `{{=<% %>=}}` —— 切换定界符。整句形状是「等号夹着一段」，
   * 正常变量名不会两头都是等号（`{{=某值}}` 这种也不会以 `=` 收尾）。 */
  if (/^=.*=$/.test(name)) return true
  return /^[#\/^!~<]/.test(name)
}

/**
 * **引擎字段名单**：语法合法、但由参考项目的渲染引擎填值，不是给用户填的。
 *
 * ## 为什么单独一张名单（与 `isEngineSyntax` 是两件事）
 *
 * | 判据 | 处理什么 | 例子 |
 * | --- | --- | --- |
 * | `isEngineSyntax` | 参考项目模板引擎的**语法** | `{{#hasFocus}}`、`{{/x}}`、`{{^x}}`、`{{=<% %>=}}` |
 * | `ENGINE_FIELDS`（本表） | 语法合法、但**值是引擎算出来塞进去的**名字 | `{{snapshotLabel}}`、`{{inputContent}}` |
 *
 * 两类都会在界面上变成空输入框，后果一样（用户看到一个不该填的框，填了也不进模板），
 * 但判法完全不同：前者看形状，后者看**这个名字在参考项目里是不是被引擎赋值的**。
 *
 * ## 名单怎么来的（不靠「看起来像英文」猜）
 *
 * 做法是**两向对撞**：
 *   ① 把 62 个模板正文里出现过的全部 `{{名字}}` 抠出来；
 *   ② 到参考项目 `packages/core/src/services/**` 与 `packages/ui/src/**` 里
 *      逐个搜它的**赋值 / 构造点**（`名字:` 或对象简写 `名字,`）。
 *      只有查得到的才进表，出处写成行内注释。
 *
 * 所以下面每一行后面那个路径都是**证据**，不是备注。复核办法：把路径打开，
 * 那一行能看到它被赋了值（多数在 `evaluation/service.ts` 的模板上下文构造处）。
 *
 * ## 为什么有一批**明显**该进表却没进
 *
 * `originalPrompt` / `promptContent` / `workspacePrompt` / `referencePrompt` /
 * `iterateInput` / `lastOptimizedPrompt` / `iterateRequirement` /
 * `promptRequirement` / `focusBrief` 这 9 个也是引擎填的，但它们填的是
 * **用户提交的那段内容本身** —— 也就是 `{{原始提示词}}` 那个位置。
 * 用户在这个板块里真正要做的，就是往这一处填东西，**它就是输入框存在的理由**。
 * 所以它们留在界面上（这是我们比参考项目多给的一层便利：不用去它的表单里填）。
 *
 * ## 将来加模板时，一个新名字该不该进来
 *
 * 只有三种情况**不进**：
 *   1. 它的名字是中文（`{{原始提示词}}` 这类，是我们自己给用户定的）；
 *   2. 它是上面那 9 个「用户提交内容」之一；
 *   3. 在参考项目源码里**搜不到**它的赋值点 —— 搜不到就不猜，宁可多一个框。
 *
 * ⚠️ 反过来：**不许**因为「这个名字是英文」「看起来像内部字段」就加进来。
 * 名单只认证据。改这张表要同时改 `tests/prompt-optimize.mjs` 里的对照表。
 */
const ENGINE_FIELDS: ReadonlySet<string> = new Set([
  'compareJsonContract', /* services/evaluation/structured-compare-prompts.ts:176 */
  'compareSnapshotCount', /* services/evaluation/service.ts:1939 */
  'compareTestCaseCount', /* services/evaluation/service.ts:1931 */
  'content', /* services/evaluation/service.ts:148 */
  'contentPreview', /* services/prompt/service.ts:226 */
  'contextVariableCount', /* services/variable-value-generation/service.ts:155 */
  'contextVariablesText', /* services/variable-value-generation/service.ts:154 */
  'conversationContext', /* services/context/constants.ts:21 */
  'designContextContent', /* services/evaluation/service.ts:1783 */
  'designContextLabel', /* services/evaluation/service.ts:1782 */
  'designContextSummary', /* services/evaluation/service.ts:1784 */
  'executionInputLabel', /* services/evaluation/service.ts:101 */
  'generationGoal', /* packages/ui/src/services/ImageStyleExtractor.ts:365 */
  'id', /* services/evaluation/service.ts:63 */
  'index', /* services/evaluation/service.ts:1302 */
  'inputContent', /* services/evaluation/service.ts:68 */
  'inputImageCount', /* services/prompt/service.ts:931 */
  'inputKind', /* services/evaluation/service.ts:66 */
  'inputLabel', /* services/evaluation/service.ts:67 */
  'inputSummary', /* services/evaluation/service.ts:69 */
  'label', /* services/evaluation/service.ts:64 */
  'modelKey', /* services/evaluation/service.ts:94 */
  'name', /* services/evaluation/service.ts:3153 */
  'output', /* services/evaluation/service.ts:100 */
  'pairGuidance', /* services/evaluation/service.ts:2353 */
  'pairJudgePayloadJson', /* services/evaluation/structured-compare-prompts.ts:154 */
  'prompt', /* services/evaluation/service.ts:1909 */
  'promptRefLabel', /* services/evaluation/service.ts:84 */
  'promptText', /* services/evaluation/service.ts:80 */
  'reasoning', /* services/evaluation/service.ts:98 */
  'resultLabel', /* services/evaluation/service.ts:1912 */
  'rewritePayloadJson', /* services/evaluation/rewrite-from-evaluation.ts:56 */
  'role', /* services/evaluation/service.ts:85 */
  'roleLabel', /* services/evaluation/service.ts:86 */
  'roleName', /* services/evaluation/service.ts:142 */
  'settingsSummary', /* services/evaluation/service.ts:71 */
  'snapshotId', /* services/evaluation/service.ts:114 */
  'snapshotLabel', /* services/evaluation/service.ts:115 */
  'subject', /* services/evaluation/service.ts:2389 */
  'subjectLabel', /* services/evaluation/service.ts:141 */
  'synthesisPayloadJson', /* services/evaluation/structured-compare-prompts.ts:177 */
  'testCaseInputContent', /* services/evaluation/service.ts:1903 */
  'testCaseInputLabel', /* services/evaluation/service.ts:1902 */
  'testCaseInputSummary', /* services/evaluation/service.ts:1904 */
  'testResult', /* services/evaluation/service.ts:1911 */
  'toolsContext', /* services/context/constants.ts:22 */
  'variableCount', /* services/variable-value-generation/service.ts:152 */
  'variablesText', /* services/variable-value-generation/service.ts:151 */
  'versionLabel', /* services/evaluation/service.ts:96 */
])

/**
 * 供测试核对「名单里每个名字都有出处」用的只读视图。
 *
 * ⚠️ 测试**不读参考项目源码**（那是别人的仓库，路径随时会变，读它会让测试
 * 依赖一个不受我们管的东西）。所以出处以对照表的形式写在
 * `tests/prompt-optimize.mjs` 里，这里只导出名字本身。
 *
 * @returns 名单（按字母序）。
 */
export function engineFields(): readonly string[] {
  return [...ENGINE_FIELDS].sort()
}

/**
 * 认出模板正文里的全部变量，按**首次出现顺序**返回。
 *
 * 同名只返回一个（正文里重复出现的靠 `count` 说明），因为界面上给它一个输入框就够了。
 *
 * @param body - 模板正文。
 * @returns 变量清单（没有变量就是空数组）。
 */
export function findVars(body: string): PromptVar[] {
  const into = new Map<string, PromptVar>()
  /* ⚠️ 每次用前把 `lastIndex` 归零：正则是模块级共享的，
   * 上一轮要是没扫到末尾（比如调用方中途抛错），下一轮会从中间接着扫、漏掉前面的变量。 */
  DOUBLE_BRACE.lastIndex = 0
  let m = DOUBLE_BRACE.exec(body)
  while (m !== null) {
    /* ⚠️ **必须 trim**：`{{ }}` 这种「只有空格」的写法，正则里的 `[^{}\n]` 会把空格
     * 当成名字匹配上，于是凭空多出一个叫「 」的变量（探针在这里抓到过）。
     * trim 之后是空串就跳过 —— 名字是纯空白的占位符不是变量，是排版。 */
    const name = (m[1] ?? '').trim()
    if (name !== '' && !isEngineSyntax(name) && !ENGINE_FIELDS.has(name)) {
      const hit = into.get(name)
      if (hit === undefined) {
        /* Map 保持插入顺序 —— 正好就是首次出现的顺序，不用另存一份索引。 */
        into.set(name, { name, count: 1 })
      } else {
        hit.count += 1
      }
    }
    m = DOUBLE_BRACE.exec(body)
  }
  return [...into.values()]
}

/**
 * 把变量填进正文，得到最终文本（「复制到剪贴板」用的就是它）。
 *
 * 没填的变量**原样留着**（不替换成空串）—— 留着一个明显的占位符，
 * 比悄悄删掉更容易让人发现「这里还没填」。
 *
 * @param body - 模板正文。
 * @param values - 变量名 → 用户填的值。
 * @returns 填好之后的文本。
 */
export function fillVars(body: string, values: Readonly<Record<string, string>>): string {
  /* 重新取一份正则（带 g 的有状态，共享的那个被别的调用动过就麻烦）。 */
  return body.replace(new RegExp(DOUBLE_BRACE.source, 'g'), (whole, raw: string) => {
    /* 与 findVars 用同一套名字规范化（trim），否则「填了却没替换」会莫名其妙。 */
    const v = values[raw.trim()]
    return v === undefined || v.trim() === '' ? whole : v
  })
}
