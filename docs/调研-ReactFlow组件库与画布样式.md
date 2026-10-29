# 调研 · React Flow（@xyflow/react）可直接用的组件库与画布样式（2026-10-07）

> 状态：已完稿 · 2026-10-07 · 数据来源均为当日实测（GitHub API / npm registry / 官网抓取）

## 1. 一句话结论

**官方那套 React Flow UI（shadcn 注册表，MIT，含 17 个组件 + 2 个完整模板）就是最优解**——它不走 npm，而是用 `shadcn` 命令把源码拷进我们项目，可任意改样式；配合 `colorMode` 和 CSS 变量，**同一份节点代码能换出多套完全不同的外观**，正好满足「一次做多个画布样式给用户挑」。社区里没有比它更成熟、许可更干净的替代品。

---

## 2. 可直接用的库清单

| 名称 | 地址 | ★ | 许可 | 风格 | 怎么用 | demo |
|---|---|---|---|---|---|---|
| **React Flow UI（官方）** | [reactflow.dev/ui](https://reactflow.dev/ui) · [xyflow/xyflow](https://github.com/xyflow/xyflow) | 38598 | **MIT** | shadcn 风、中性、圆角卡片 | `npx shadcn@latest add https://ui.reactflow.dev/base-node`（拷源码，非 npm 包） | [ui.reactflow.dev/base-node](https://ui.reactflow.dev/base-node) |
| **AI Workflow Editor 模板（官方）** | [ui/templates/ai-workflow-editor](https://reactflow.dev/ui/templates/ai-workflow-editor) | — | MIT | AI 工作流、侧栏 + 画布 | 官网 Download ZIP，Next.js + AI SDK + Zustand | 同上页可下载 |
| **Workflow Editor 模板（官方）** | [ui/templates/workflow-editor](https://reactflow.dev/ui/templates/workflow-editor) | — | MIT | 通用工作流、ELK 自动布局 | 同上 | 同上页可下载 |
| **VisualFlow 模板集** | [visualflow.dev](https://www.visualflow.dev) · [Azim-Ahmed/Automation-workflow](https://github.com/Azim-Ahmed/Automation-workflow) | 325 | **无 LICENSE 文件**（默认版权保留） | 多风格模板（企业级/流程图/Langflow 风） | 付费 $49/mo 或 $199 买断；仓库为示例代码 | [visualflow.dev](https://www.visualflow.dev) |
| **Workflow Builder SDK** | [workflowbuilder.io](https://www.workflowbuilder.io/) · [synergycodes/workflowbuilder](https://github.com/synergycodes/workflowbuilder) | 391 | **Apache-2.0** | 专业编辑器、节点面板 + 属性栏 | npm 包 + SDK 内嵌 | [workflowbuilder.io](https://www.workflowbuilder.io/) |
| **shadcn-next-workflows** | [nobruf/shadcn-next-workflows](https://github.com/nobruf/shadcn-next-workflows) | 308 | **MIT** | shadcn + Tailwind，深色、紧凑 | 抄源码（Next.js 项目） | 原 Vercel 链接**超时未验证** |
| **Dify 画布** | [langgenius/dify](https://github.com/langgenius/dify) | 158034 | **改版 Apache-2.0**（多租户/对外商业需授权） | 现代 SaaS、圆角、浅色为主 | 可抄前端代码（须守附加条款） | dify.ai 在线试用 |
| **Langflow** | [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | 155567 | **MIT** | 深色、发光边框、科技感 | 可抄源码 | langflow.org |
| **Flowise** | [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) | 55491 | 部分 Apache-2.0 + `src/enterprise` 商用许可 | 深色侧栏、卡片节点 | 抄非 enterprise 部分 | flowiseai.com |
| **Activepieces** | [activepieces/activepieces](https://github.com/activepieces/activepieces) | 24933 | **MIT Expat**（`packages/ee/` 除外） | 明快、彩色图标、宽松 | 可抄源码 | activepieces.com |
| **n8n（编辑器前端）** | [n8n-io/n8n](https://github.com/n8n-io/n8n) | 206822 | **Sustainable Use License**（非开源） | 深色画布、节点卡片精致 | ⚠️ **前端是自研 Vue 组件 + 自己的 canvas，不是 React Flow**；禁商用转售 | n8n.io |
| **Windmill** | [windmill-labs/windmill](https://github.com/windmill-labs/windmill) | 18126 | **AGPLv3**（`backend/`）+ Apache 混合 | 暗色、紧凑、等宽感 | ⚠️ **AGPL 不能抄** | windmill.dev |
| **React Flow 本体** | [@xyflow/react](https://www.npmjs.com/package/@xyflow/react) | — | **MIT** | — | `npm i @xyflow/react` v12.12.0，peer `react >=17` ✅ React 18 兼容 | reactflow.dev |
| **Rete.js**（非 React Flow，备选） | [retejs/rete](https://github.com/retejs/rete) | 12290 | MIT | 可插拔渲染器 | npm | retejs.org |

---

## 3. 风格方向归纳（6 个差异明显的方向）

| # | 方向 | 特征 | 现成参考 |
|---|---|---|---|
| 1 | **极简线框风** | 无填充/浅填充、细边框、1px 描边、弱阴影、留白大 | React Flow UI 默认组件；官方 Base Style 示例 |
| 2 | **卡片式（信息密集）** | 白底圆角卡片 + 柔和阴影、标题栏/内容区/底栏三段式 | 官方 `BaseNode`（Header/Content/Footer）；Dify |
| 3 | **终端/控制台风** | 等宽字体、近黑底 + 单色强调（青/绿）、方角、紧凑、无阴影 | Windmill（AGPL，**只看不抄**）；官方 Turbo Flow 示例（[链接](https://reactflow.dev/examples/styling/turbo-flow)，源自 turbo.build） |
| 4 | **深色科技/发光风** | 深灰底、节点带彩色描边或外发光、连线有色彩、有渐变 | Langflow；官方 Dark Mode 示例 `colorMode="dark"` |
| 5 | **流程图风** | 大节点、粗连线带箭头、正交折线（step/smoothstep）、强调走向 | 官方 Workflow Editor 模板；VisualFlow 目录 |
| 6 | **SaaS 明快风** | 高饱和分类色图标、圆润、深浅双模式、宽松间距 | Activepieces；shadcn-next-workflows |

> 补充第 7 类：**AI 工作流风**——侧栏节点库 + 中央画布 + 右侧属性面板的三栏布局，节点带运行状态徽标（官方 `NodeStatusIndicator`）。这正是 AI Workflow Editor 模板。

---

## 4. 推荐给用户看的 4–6 个具体方案

### 方案 A：官方 React Flow UI 默认（极简线框 + 卡片式）
- **风格**：中性灰白、圆角卡片、轻阴影、干净克制的 shadcn 视觉；深浅色一键切换（`colorMode`）。
- **看实物**：<https://reactflow.dev/ui> （页面上每个组件都有真实渲染预览，可点击交互）
- **怎么落地**：`npx shadcn@latest add https://ui.reactflow.dev/base-node` 逐组件拷入。
- **价值**：MIT，改起来无限制——**这是后面所有方案的共同底座**。

### 方案 B：官方 Workflow Editor 模板（流程图风 + 自动布局）
- **风格**：左拖拽节点栏 + 中画布 + 自动布局（ELKjs），节点偏大、连线清晰，整体是「专业编辑器」感。
- **看实物**：<https://reactflow.dev/ui/templates/workflow-editor> （官网 Download ZIP 拿完整可跑工程）
- **注意**：Next.js 技术栈，我们是 React 18 + dsh 插件，需**移植而非直接跑**。

### 方案 C：官方 AI Workflow Editor 模板（AI 工作流风）
- **风格**：三栏布局、节点带运行状态指示、AI SDK 集成；与本项目「电商 AI 工作台」定位最贴合。
- **看实物**：<https://reactflow.dev/ui/templates/ai-workflow-editor>
- **注意**：同样 Next.js + Zustand，需移植。

### 方案 D：Terminal / Turbo Flow 深色紧凑风（对应委托人 FounderOS 偏好）
- **风格**：近黑背景、单色强调、方角紧凑、无多余装饰，源自 turbo.build 的观感。
- **看实物**：<https://reactflow.dev/examples/styling/turbo-flow> （官方可交互示例）
- **落地**：官方示例直接给代码，套在方案 A 的组件上改 CSS 变量与字体即可。

### 方案 E：Langflow 深色发光风
- **风格**：深色画布、节点带彩色描边与微光、连线有色彩，科技感强，视觉最"贵"。
- **看实物**：<https://www.langflow.org>（在线试用）/ 源码 <https://github.com/langflow-ai/langflow>
- **许可**：**MIT ✅ 可抄**。

### 方案 F：Activepieces / Dify 明快 SaaS 风
- **风格**：高饱和分类色图标、圆润宽松、明暗双模，最"产品化"、最讨非技术用户喜欢。
- **看实物**：<https://www.activepieces.com>（MIT Expat，可抄）/ <https://dify.ai>
- **注意**：Dify 是改版 Apache-2.0，**多租户或对外商业需授权**；我们内部用没问题。

> **另有付费快速路**：VisualFlow $199 买断含多套模板（<https://www.visualflow.dev>），Workflow Builder Apache-2.0 SDK（<https://www.workflowbuilder.io/>）。若想要"买来即用"可考虑，但样式自由度不如官方 UI。

---

## 5. 未获取 / 未核实

1. **n8n 编辑器前端确认**：n8n 前端是 Vue（非 React Flow），故**不能直接复用**；其许可证为 Sustainable Use License（非开源，禁止转售）。**未逐行核实**其画布渲染实现，推断依据为仓库语言构成与官方定位。
2. **shadcn-next-workflows 在线 demo**：原 homepage `shadcn-next-workflows.vercel.app` 抓取**超时 20s 未成功**，无法确认是否仍在线；仅确认仓库 ★308 / MIT / 最后 push 2025-01-16（**已近两年未更新**）。
3. **React Flow UI 组件的完整源码**：仅确认了 `base-node` 的 shadcn 安装路径可用、组件清单（Base Node / NodeStatusIndicator / LabeledHandle / ButtonHandle / DatabaseSchemaNode / PlaceholderNode / LabeledGroupNode / NodeTooltip / NodeAppendix / NodeSearch / ZoomSlider / ZoomSelect / DevTools / ButtonEdge / AnnotatedSVGEdge / DataEdge），**未逐个拷贝源码审阅**。
4. **各项目的实际截图文件**：本次以**可交互在线 demo 链接**代替静态截图（对用户更有价值），**未下载图片文件**。
5. **Flowise / Activepieces / n8n 的 star 与许可为 API 实测值**，但其「界面好不好看」属主观判断，**由委托人自行看 demo 决定**。
6. React Flow UI 是否为独立 npm 包：**确认不是**——它是 shadcn registry（拷源码）。npm 上 `@xyflow/react-ui` **不存在**。
