# 调研：工作流节点的说明文字怎么写 & 节点编辑的 UX 规范（2026-10-10）

> 状态：初稿完成
> 委托人诉求：「每一个节点应该有更细的说明，设置展开后也不应该只是列几个参数，而是参数的意义是什么得说明」
> 「我希望每个节点设置打开后，至少知道这个节点在做什么能做什么」
> 所有结论均标注来源；标「推断」的为我基于来源的归纳，非原文。

## 1. 一句话结论

**业界没有统一的「节点说明书」写作标准，但 n8n 给出了可直接照抄、且已被自动化 lint 强制执行的规范**：节点级描述一句话说清「做什么」，参数级描述一句话说清「影响什么」（sentence case）；boolean 一律以 `Whether to…` 开头；默认值必须写进描述（如 `Defaults to false`）；必填项打开即见、可选项收进折叠区。Node-RED 提供了最完整的**节点帮助页结构模板**（Overview 2–3 行 / Inputs / Outputs / Details / References）。Dify / Langflow / ComfyUI 只有字段级约定，没有写作规范。

## 2. 找到的规范文档清单

| 文档 | 链接 | 许可 | 关键要点 |
|---|---|---|---|
| **n8n UX guidelines**（主收获，已读完） | https://raw.githubusercontent.com/n8n-io/n8n-docs/main/docs/connect/create-nodes/build-your-node/reference/ux-guidelines.md | n8n-docs 仓库：Sustainable Use License + Commons Clause（源码可见，非 OSI；引用/参考可用，不可售卖） | 大小写规范、术语规范、占位符示例清单、operation 命名三件套（name/action/description）、boolean 描述规范 |
| **n8n Node UI design**（已读完） | .../plan-your-node/node-ui-design.md | 同上 | 5 种帮助载体、必填/可选排序规则、渐进披露、默认值写法、tooltip 不许抄 API 文档 |
| **n8n Node UI elements**（已读完） | .../reference/node-ui-elements.md | 同上 | `hint` vs `description` 区别、node hints 的 location/whenToDisplay、notice、collection |
| **n8n 节点描述相关 lint 规则**（已读） | https://github.com/n8n-io/n8n/tree/master/packages/@n8n/eslint-plugin-community-nodes/docs/rules | n8n：Sustainable Use License | `require-node-description-fields`（必须 subtitle）、`resource-operation-pattern`（>5 operation 必须分 resource） |
| **n8n 字段定义源码**（已读） | https://raw.githubusercontent.com/n8n-io/n8n/master/packages/workflow/src/interfaces.ts | 同上 | 证实 `description?` 与 `hint?` 是两个独立字段 |
| **Node-RED Node help style guide**（已读完，结构模板最佳） | https://raw.githubusercontent.com/node-red/node-red.github.io/main/docs/creating-nodes/help-style-guide.md | Apache-2.0 | Overview 2–3 行 / Inputs / Outputs / Details / References 五段结构 |
| **Node-RED edit dialog + properties**（已读） | .../docs/creating-nodes/edit-dialog.md、properties.md | Apache-2.0 | label 写法、select 使用、required/validate、渐进披露的 oneditprepare |
| **GOV.UK Design System**（已读 select / text-input / question-pages） | https://github.com/alphagov/govuk-design-system/tree/main/src | MIT | 提示文案写法、禁用占位符、**禁用星号标必填**、select 反方证据 |
| **Shopify Polaris text field**（已读） | https://github.com/Shopify/polaris/blob/main/polaris.shopify.com/content/components/selection-and-input/text-field.mdx | MIT | help text 定位与用途、"Optional" 标注、占位符低对比度警告 |
| **Dify 插件开发规范**（已读 general-specifications / tool） | https://github.com/langgenius/dify-docs/blob/main/en/develop-plugin/features-and-specs/plugin-types/general-specifications.mdx | CC-BY-4.0 | 表单项有 `helper`（多语言标签）+ `url`（文档链接）两个独立字段 |
| **Langflow 组件开发指南**（已读） | https://github.com/langflow-ai/langflow/blob/main/docs/docs/_partial-basic-component-structure.mdx | MIT | 组件级 `description` + `documentation`（URL）两个属性 |
| **ComfyUI 节点帮助机制**（已读完） | https://github.com/Comfy-Org/docs/blob/main/custom-nodes/help_page.mdx | GPL-3.0 | 无节点级描述字段；只有每个输入的 `tooltip`，可另挂 Markdown 帮助页 |
| **ComfyUI 输入选项类型**（已读） | https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy/comfy_types/node_typing.py | GPL-3.0 | `tooltip`、`placeholder`、`RemoteInputOptions`（动态选项全套字段） |
| **Material Design 文字字段指引** | https://m3.material.io/components/text-fields/guidelines | Google 站点条款 | **未获取**：页面为 JS 渲染，抓到的正文仅 67 字符，无有效内容 |

## 3. Q1–Q5 逐条回答

### Q1 参数说明该写什么、写多长

- **一句话，sentence case（句首大写、其余小写），不加句号**（单句）。来源：n8n node-ui-design.md「UI text style」表：Tooltip = sentence case，"Don't use a period for one-sentence tooltips. Always use a period if there's more than one sentence."
- **要写"影响什么"而非"这是什么"**。n8n 明确禁止照抄接口文档：「Don't just copy-paste API parameter descriptions. If the description doesn't make sense, or has errors, improve it.」（node-ui-design.md）
- **boolean 一律以 `Whether to…` 开头**。来源：n8n ux-guidelines.md「Boolean description」；node-ui-design.md「Toggles」：Tooltips for binary states should start with something like **Whether to . . .**
- **必填 / 可选 / 默认值怎么展示**（三家的做法，已验证）：
  - n8n：**必填**放节点打开就可见；**可选**收进折叠区（Original 叫 **Optional fields**，现称 Additional Fields / collection）；默认值**直接预填进字段**，并在描述里点明——原文 "load the field with that value. Explain this in the field description. For example, **Defaults to false**."
  - GOV.UK：**绝不用星号标必填**（"Never mark mandatory fields with asterisks"），反过来给可选项标 "(optional)"。来源：question-pages/index.md
  - Polaris：同样要求「Be labeled as "Optional" when you need to request input that's not required」
- **反面例子（同义反复）**：`超时时间` → 说明写「请输入超时时间」；`选择器` → 「请输入选择器」。这类说明只是把参数名重复一遍。**判据（来自 Dify 写作指南，已读）**：ask of each sentence what the reader would do differently for having read it, and cut the ones with no answer —— 读者读完不会换个做法，就删掉。

### Q2 节点级说明该包含什么

- **Node-RED 的五段结构是现成答案**（help-style-guide.md 原文，已验证）：
  1. **Overview** —— 高层介绍，**不超过 2–3 行**；**第一段会被直接当作节点面板悬停提示**。
  2. **Inputs** —— 描述节点会用到消息的哪些属性、各是什么类型；简介即可，细节放 Details。
  3. **Outputs** —— 节点会发出什么；多输出时每个输出单独一份属性清单。
  4. **Details** —— 「explain how it should be used」，讲用法、讲输入输出的更多信息。
  5. **References** —— 外链：追加文档、节点的 git 仓库 / npm 页。
- **好的节点说明让用户能回答 5 个问题**（推断，依据上述结构与 n8n 的 5 种帮助载体归纳）：① 这节点干什么 ② 我要喂它什么数据 ③ 它会吐出什么数据 ④ 每个参数怎么填 ⑤ 哪里能查到更多。
- **n8n 对节点级描述本身的字数要求**：`description` = "A short description of the node. n8n uses this in the GUI."（standard-parameters.md）；lint 规则 `require-node-description-fields` 强制节点必须同时提供 `icon` 与 `subtitle`（subtitle 随参数动态变化，如 `={{$parameter["operation"]}}`）。
- **放在哪（五家对比，已验证）**：
  - n8n：**5 种载体**——① Info box（黄框，夹在字段之间，慎用）② Parameter hint（输入框下方一行）③ **Node hint**（可指定显示在 inputPane / outputPane / ndv，且可选 always / beforeExecution / afterExecution，支持 `displayCondition` 表达式）④ Tooltip（问号图标悬浮）⑤ Placeholder。
  - Node-RED：节点被选中后，帮助文本显示在**右侧 info 标签页**。
  - ComfyUI：**没有节点级描述字段**；每个输入的 `tooltip` 在悬浮时显示，另可在 `WEB_DIRECTORY/docs/<NodeName>.md` 挂 Markdown 帮助页，且支持按语言分文件（`en.md` / `zh.md`）。
  - Dify：表单项级 `helper`（帮助文档链接的**文案标签**）+ `url`（链接地址），两个字段分开。
  - Langflow：组件级一个 `documentation` URL 字段。

### Q3 分组与层级

- **参数多了怎么办**（n8n 的完整答案，已验证）：
  - 必填项排序：**重要度从高到低**，且**范围由大到小**（原文例：Document → Page → Text to insert）。
  - 可选项排序：**按字母序**；为把同类聚一起可以改名（Email / Secondary Email → **Email (primary)** / **Email (secondary)**）。
  - **依赖型可选项捆在一起**：一个开关管一组字段（"bundle them together. They should both be under a single option that shows both fields when selected"）。
  - 可选项多时**按主题分组**。
  - **渐进披露**：`displayOptions.show` 让字段在前置字段有值之前不出现。
- **Resource / Operation 两级是不是成熟做法**：是，且已变成**可执行规则**。n8n 的 lint 规则 `resource-operation-pattern`：**operation 超过 5 个还没分 resource 就告警**，理由是「users benefit from having them organized into logical resource groups rather than seeing a long flat list」。另外 operation 命名有三件套规范：`name`（面板内下拉，Title Case，不重复 resource）、`action`（选节点面板，sentence case，**要重复 resource**，且省冠词——correct: `Update row in sheet` / incorrect: `Update a row in a sheet`）、`description`（副标题，**要提供比 name 更多的信息**）。
- **「常用 + 高级」之外的第三种分层**（已验证的 4 种）：
  1. **业务对象分层**：Resource / Operation（按业务概念）。
  2. **用户自选清单**：n8n `collection` 类型——用户自己点 "Add Field" 决定要填哪几个，不填的不占地方。
  3. **语义分组容器**：n8n `fixedCollection`——"Use to group fields that are semantically related"。
  4. **依赖渐进披露**：字段随前置条件出现/消失。
  - 另有 **节点级**分层：n8n `group` 属性 + codex 文件的 `categories`（固定 10 类，如 `Data & Storage`），决定节点在面板里的归类。

### Q4 帮助与文档的挂接

- **要不要放「查看文档」链接**：要。n8n：Info box / hint / tooltip **都可以带链接**，且要求**新标签页打开**（"This field can include links, which should open in a new tab"）。节点与凭据的文档链接由 codex 文件的 `resources` 对象提供，「n8n automatically adds help links to credentials and nodes in the GUI」。
- **表单项级别最好也挂**：Dify 的 `helper`（文案）+ `url`（地址）双字段是值得照抄的设计——比把链接塞进说明正文更干净。
- **有没有内联示例**：有，n8n 给了**可直接抄的占位符示例表**（ux-guidelines.md）：占位符以 "e.g." 开头、示例内容用 camelCase。模板：图片 `e.g. https://example.com/image.png`、搜索词 `e.g. automation`、邮箱 `e.g. nathan@example.com`、姓名 `e.g. Nathan Smith`。
- **反面**：GOV.UK **反对用占位符**（"Avoid placeholder text"），理由三条：① 用户一输入就消失，对记忆障碍用户或回看答案的人不友好 ② 屏幕阅读器不一定读 ③ 浏览器默认样式常不满足对比度要求。→ **结论（推断）**：占位符只放"不影响理解的示例"，**不能承载必知信息**；Polaris 也说占位符低对比度（"don't rely on it for important information"）。

### Q5 「能是选项就用选项」的 UX 依据

- **支持下拉的证据（n8n，已验证）**：node-ui-design.md 的 Toggles 段给了**判断标准**——「Use toggles when it's clear what happens in a false state」；当"不成立时会发生什么"不清楚，就必须改用**有具名选项的下拉**。原文例：`Simplify Output?` 适合开关；`Append?` 必须用下拉，因为不 append 时到底是"什么都不做"还是"覆盖"还是"丢弃"说不清。→ 依据是**语义清晰度**，不是笼统的"选项更好"。
- **反对无条件下拉的证据（GOV.UK，已验证）**：select「should only be used as a last resort」，因为 research shows that some users find selects very difficult to use；并列出 5 类具体困难（关不掉、往里面打字、把聚焦项当成已选项、小屏上想缩放选项、不知道能往下滚）。`<select multiple>` 更被明确否定（多选请用复选框）。
- **什么时候反而该用自由文本**（已验证的两条 + 一条推断）：
  1. 值域开放、无法穷举。
  2. 用户要粘贴现成的 URL / ID —— 且**必须容错**：n8n 要求同一记录提供"从列表选"和"填 ID"**两种方式**，并把字段命名为 `<Record name> name or ID`；tooltip 写 "Choose a name from the list, or specify an ID using an expression."，同时「handle the user pasting in the absolute path」/「handle the user pasting in the entire URL」。
  3. （推断）需要写表达式 / 动态取值时。n8n 用 `noDataExpression: true` 显式禁止对 resource、operation 这类字段用表达式——即**结构化的字段才锁死为下拉**。
- **动态选项的 UX 注意点**（n8n + ComfyUI，已验证）：
  - n8n：优先用 **Resource Locator** 组件，默认模式取 `From list`；列表可 `searchable`、可 `searchFilterRequired: true` 强制先搜索（选项太多时不让人硬翻）；**加载慢必须有提示**——`slowLoadNotice` 可配 `{message, timeout}`，官方示例文案："If loading takes longer than expected, try selecting a resource using 'By ID'"。
  - ComfyUI `RemoteInputOptions` 是一份现成的动态选项 UX 字段清单：`refresh_button`（是否给刷新按钮）、`control_after_refresh`（刷新后选第一项还是最后一项）、`timeout`、`max_retries`、`refresh`（缓存 TTL，多久自动刷新）。

## 4. 可直接执行的写作规则

### 4.1 节点级（每个节点都写）

参照 Node-RED 五段结构，落到我们画布上就是「节点设置面板顶部 + 可选展开的详情区」：

```text
<一句话：这个节点做什么、对什么数据做什么。≤2 行，sentence case，无句号。>
        ↑ 这一句同时用作画布上节点悬停提示

输入：<需要上游给什么数据；没有则写"无需输入">
输出：<产出什么数据，下游能拿它做什么>

详情（折叠，默认收起）：
  何时用     <1–2 句典型场景>
  注意       <会失败 / 会改数据的点；没有则省略>
  示例       <一段可直接抄的配置>
  相关文档   <external link，新标签页打开>
```

写节点说明的自检（来自 Dify 写作指南）：**每句话都问"读者读完会不会换个做法"，不会就删。**

### 4.2 参数级（89 个参数逐个补）

按 n8n 规则写成一句话，**说影响什么，不说它是什么**：

| 参数类型 | 模板 | 照抄示例 |
|---|---|---|
| 开关 | `Whether to <做/不做的事>` | `Whether to return a simplified version of the response instead of the raw data` |
| 有默认值的项 | `<说明>。Defaults to <值>` | 默认 `false` → 「…。Defaults to false」 |
| 下拉 | 说明**选不同值会有什么不同**，不是复述选项名 | 见下方正反例 |
| 文本/数字 | 说明**格式、单位、边界**；举例用 `e.g.` | `e.g. https://example.com/image.png` |
| 时长/超时 | 写明**单位**与**到点后的行为** | 「等待元素出现的最长时间，超时后节点判失败（默认 30 秒）」 |

强制项（都有 n8n 来源）：
1. 单句不加句号；多句则每句加句号。
2. boolean 一律 `Whether to…` 开头。
3. 标签用 Title Case（如 `Timeout`），说明用 sentence case。
4. 不抄接口文档原文；看不懂就改写。
5. 同一概念只用一个词（选定「目录」就不再用「文件夹」）。
6. 不用技术黑话，能用「字段」就别用「key」。
7. 占位符只放 `e.g.` 示例，不放必知信息。
8. 必填项打开即见，可选项收进折叠区；**不标星号**。

## 5. 正反例对照

以委托人的三个典型节点为例：

| 场景 | ❌ 差说明 | ✅ 好说明 | 依据 |
|---|---|---|---|
| 抓列表 / 选择器 | 「请输入选择器」 | 「列表项的 CSS 选择器。每匹配到一个元素算一条记录；写 `li.product` 这种，不要写整段 HTML」 | 同义反复 vs 讲影响 + `e.g.` 示例（n8n） |
| 等待 / 超时 | 「请输入超时时间」 | 「等待的最长秒数。超时后节点判失败、不继续往下走。Defaults to 30」 | 默认值必须写进描述（n8n）；单位必须写明（推断） |
| 生成主图 / 模式开关 | 「是否简化」 | 「Whether to return only the image URL instead of the full generation metadata」 | boolean 必须 `Whether to…`（n8n） |
| 等待 / 模式选择 | 「等待模式」（下拉，无说明） | 「按元素出现等 / 按固定时长等。选固定时长时，'元素选择器'不生效」 | 「不成立时会发生什么」说不清就必须用下拉并解释（n8n Append? 例） |
| 节点级 | 「抓列表节点」 | 「从当前页面按选择器抓取列表项，每条输出一个对象（标题、链接、价格）。」 | Node-RED Overview ≤2–3 行；n8n 节点 description 要 short（推断其长度上限） |

## 6. 未获取 / 未核实

- **Material Design 对 helper text 的建议**：**未获取**。`m3.material.io/components/text-fields/guidelines` 抓到的是 JS 空壳（正文仅 67 字符），`m2.material.io` 同页亦然。**我没有读到**这两个页面的实际指引内容，上文未引用它们。
- **n8n 官方文档站的线上版本**未单独核对，读的是仓库 raw 文件（与线上同源，但线上可能已改版）。
- 未找到 n8n 社区论坛关于 node UX 的帖子——**未获取**（检索通道受限，未能检索论坛）。
- **NN/g 等研究机构关于下拉 vs 文本的原始研究**：**未获取**。web_search 在本机返回的是无关的娱乐/词典结果（引擎不可用），没有拿到可用的一手研究。Q5 的正面依据只来自 n8n 的设计判断，反面依据来自 GOV.UK 的用户研究转述，**二者都不是对照实验**。
- `resource-operation-pattern` 的阈值「5 个 operation」是 lint 规则里的具体数值，**已核实**；但该规则的状态是 **warn 而非 error**，即不强制。
- 「好处方只放内联示例、不放必知信息」这个结论是**推断**（由 GOV.UK 与 Polaris 的占位符警告归纳），未找到直接这样表述的规范原文。
- 各文档的**许可**已逐仓核实（列在第 2 节）；但「参考其规则用于内部产品规范」是否构成衍生作品，**未做法律判断**。
