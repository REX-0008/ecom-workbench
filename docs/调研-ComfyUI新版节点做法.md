# 调研 · ComfyUI 新版（Vue/DOM 版）的节点做法（2026-10-08）

> 起因：用户问「**能不能看看 comfyui 最新版本的做法，他有 git 项目有源码可以参考吗？就算开源协议不让抄，我们借鉴逻辑总没问题吧**」。
> 目标：搞清楚 ComfyUI 新版怎么做「节点参数常显」，以及它**怎么处理我们卡住的那个问题**（节点变高压住下方）。
> 方法：一手源码实读（raw.githubusercontent.com + GitHub API）。**已核实**＝读到源码原文；**推断**＝由源码逻辑推出。

## 零、先纠一个前提（我的错）

我在派调研时说「当前是 2025 年」——**这是错的**。
实测：`ComfyUI_frontend` 最新 release 是 **v1.57.0，发布于 2026-10-05**，仓库最近推送 2026-10-09。
→ 本次读的是**真·最新版**，结论有效。

## 一、源码在哪（可直接看）

| 仓库 | 内容 | 协议 |
| --- | --- | --- |
| `Comfy-Org/ComfyUI_frontend` | **前端（Vue 3 + TS），独立仓库** | **GPL-3.0-only** |
| `comfyanonymous/ComfyUI` | 后端（Python） | GPL-3.0 |
| `Comfy-Org/litegraph.js` | 旧画布底座（GitHub 上已标 ARCHIVED） | **MIT** |

**关键**：新版前端**不是**后端仓库的子目录，是**独立仓库**。

值得看的目录：
- `src/renderer/extensions/vueNodes/` —— DOM 版节点渲染（组件 / widgets / 布局）
- `src/renderer/core/layout/` —— **布局与测量中枢**（我们最该看这里）
- `src/lib/litegraph/` —— **内嵌的旧底座（MIT）**——**我们关心的尺寸/折叠/测量逻辑大量在这里**
- `docs/adr/` —— **75 篇决策记录**，是本次最有价值的一手材料

## 二、许可证：仍是 GPL，但有一条缝

| 部分 | 协议 | 出处 |
| --- | --- | --- |
| 前端整体 | **GPL-3.0-only** | `package.json` 的 license 字段 + `LICENSE` 全文 |
| **内嵌 litegraph 底座** | **MIT**（未变） | `src/lib/litegraph/LICENSE`，Copyright 2013 Javi Agenjo；npm 包 `@comfyorg/litegraph` 同样是 MIT |

**回答用户的问题**：

- 「有没有源码可以参考」→ **有**，而且前端是独立仓库、可直接读。
- 「协议不让抄的话，借鉴逻辑总没问题吧」→ **正是这样**。
  - **Vue 组件层（GPL）**：只借鉴逻辑，**不抄代码**。
  - **litegraph 层（MIT）**：法律上可抄，但建议**仍只搬逻辑**——否则会把我们的代码绑死在上游演进上。
  - 我们本地 `refs-projects/litegraph.js` 就是这个 MIT 血统，已经读过了。

## 三、节点参数怎么显示（已核实）

**常显在节点上**，渲染顺序：`NodeSlots → NodeWidgets → NodeContent（预览）→ NodeBadges → NodeFooter`。

- 每行参数 = 端口圆点 + 标签 + 控件，**三列 CSS grid**：`min-content | minmax(80px,min-content) | minmax(125px,1fr)`。
- **折叠分两个正交的轴**（这是关键认知）：

| 轴 | 怎么做 | 收起后长什么样 |
| --- | --- | --- |
| **整节点折叠** | 标题栏左侧小箭头 → `node.collapse()` | 只剩标题头；**输入输出端口压成左右各一个合并圆点** |
| **高级参数展开** | 参数分 `shown` / `advanced` / `never` 三档 × `canvas` / `vueNode` / `panel` 三个 surface；底部按钮展开 | 展开的行**带高亮环** |

- **参数多了怎么办：不滚动，节点直接长高。** 源码里（`WidgetGrid.vue`）搜不到任何 `scroll` / `overflow` / `max-height` 限制。
  - 文本用截断（truncate）；多行文本**空闲时隐藏溢出、鼠标悬停或聚焦才出现滚动条**。

## 四、★ 节点高度与布局 —— 我们的阻塞点有答案了

### 4.1 它的核心设计：把「尺寸」拆成两层

权威出处：`docs/adr/CRDT-LAYOUT-0003-crdt-layout-intent-and-local-measurement.md` 的 2026-08-04 修正案，
**标题就是**：*the replicated document holds intent, not measurement*（可复制的文档保存「意图」，不保存「测量值」）。

三条原文要点：

1. **`实际高度 = max(请求高度, 内容自然高度)`**——因为容器用 `min-height` 而不是固定高度。
2. **「A measurement is not a command」（测量不是命令）**——测量结果**不进**可复制 / 可撤销的数据。
3. 它**不禁止测量**——widget 加载、媒体载入、徽章、第三方 DOM 都会让内容变高，这是真实的；
   缺陷从来不是「存在测量」，而是「**没名字的写入把视图派生值提升成了实体状态**」。

### 4.2 它怎么量真实高度（做法很讲究）

- **全站共用「一个」`ResizeObserver`**，元素靠 `data-node-id` 认领——**不是每个节点各建一个**。
- 读 `borderBoxSize`，减去标题高度，写进布局 store；**带缓存去重**（尺寸没变就整条跳过）。
- 节点根元素用 `min-height: var(--node-height)`，`--node-height = 尺寸 + 标题高 + 预览预留`。
- **内容变高 → CSS 自己长高 → 观察器把新高度报回 store**（不需要 JS 逐帧改）。
- 连线读的是**渲染后的尺寸**；端口位置也是从 DOM 现量（`getBoundingClientRect`）写回。
  → **所以节点长高时，连线跟着走，节点位置不动。**

### 4.3 ★ 它有没有自动重排：**没有**

这是本次调研**对我们最有价值的一条**：

| 证据 | 内容 |
| --- | --- |
| 布局目录 17 个文件全列过 | **没有任何重排 / 避让逻辑** |
| `package.json` 依赖 | `elk` / `dagre` / `d3` / `graphlib` / `cytoscape` / `yoga` **全部为空** |
| 源码里一条**被显式关掉**的逻辑 | `lib/litegraph/src/LGraphNode.ts:4528-4540` 原本有「内容超出就撑高」，Vue 模式下**关掉了**，注释写明原因：<br>会造成「节点撑高 → CSS 最小高度变大 → 多行文本又变高 → 观察器再报更大」**死循环** |
| 它有的 | **只有手动整理**——选中 ≥2 个节点 → 出按钮 → 选垂直/水平/网格 + 间距滑杆（默认 12）；**只算一次，不监听高度变化** |

### 4.4 由此得出的答案（推断，但证据很强）

> **ComfyUI 新版面对的是和我们一模一样的问题——它的答案是「接受重叠、不自动重排、给一个手动整理按钮」。**

**这一条直接解开了我们的阻塞点**：

- 我们原本担心「节点常显 → 变高 → 压住下方 → 布局不重算」。
- ComfyUI 的做法是：**高度变了就不重算布局**，保留手动「整理」按钮；需要时用户自己点。
- 而且它的注释**明确警告**：试图「内容超出就撑高 + 自动重排」会撞上**反馈死循环**——那正是我们担心的那条路。

→ **结论：不必为「常显参数」发明新的布局机制**。保留现有「自动布局」按钮，改成在高度变化后**提示「布局可能已过期」**即可。

## 五、三种节点形态（可对照设计）

| 形态 | 长什么样 |
| --- | --- |
| **正常运行** | 标题头（箭头 + 可编辑标题 + 徽章）→ 端口区 → **常显参数网格** → 预览/内容 → 底部（子图进入 / 错误 / 高级参数开关）→ 四角缩放柄 |
| **收起** | **只剩标题头**；输入输出端口**压成左右各一个合并圆点**；运行进度条贴标题下沿 |
| **展开高级** | 底部按钮切换，`advanced` 档参数行出现**并带高亮环**；另有全局开关「始终显示高级参数」（默认关） |

## 六、我们能直接学的 5 条（这部分是逻辑，不是代码）

| # | 学什么 | 解决我们什么问题 |
| --- | --- | --- |
| 1 | **尺寸拆成「请求的」与「实际渲染的」两层，只把前者当数据** | 解决：常显导致的高度变化；也解决「本机测出来的高度不该写进工作流文件」（换机器/换字体就不一样） |
| 2 | **全站一个共享观察器 + 元素认领 + 尺寸去重缓存** | 解决：节点多时的观察开销与重复回调造成的抖动 |
| 3 | **测量值只进「本地测量层」，只有有名字的写入才进可复制数据** | 解决：多人/多机打开同一工作流时，节点高度不该收敛成「谁的环境更高」 |
| 4 | **不做自动重排**，把「整理」做成用户显式触发的一次性动作 | 解决我们的阻塞点；避免与内容高度形成反馈死循环 |
| 5 | **参数分档（显示/高级/从不）× 多个展示位置，而不是靠滚动** | 解决参数太多：默认只显关键参数，底部一键展开，高级行加视觉标记 |

## 七、出处清单（可复核）

| 内容 | 路径 / 地址 |
| --- | --- |
| 协议与版本 | `Comfy-Org/ComfyUI_frontend` 的 `package.json`、`LICENSE` |
| litegraph 的 MIT 许可 | `src/lib/litegraph/LICENSE`（README 自述「included as a git subtree」） |
| DOM 节点组件 | `src/renderer/extensions/vueNodes/components/{LGraphNode,NodeHeader,NodeFooter,NodeWidgets,WidgetGrid}.vue` |
| 高度测量 | `src/renderer/extensions/vueNodes/composables/useVueNodeResizeTracking.ts`、`src/renderer/core/layout/store/layoutStore.ts`（`reportContentSize`） |
| 端口位置同步 | `src/renderer/core/layout/slots/syncSlotOffsets.ts` |
| 关键 ADR | `docs/adr/CRDT-LAYOUT-0003-crdt-layout-intent-and-local-measurement.md` |
| **死循环注释** | `src/lib/litegraph/src/LGraphNode.ts:4528-4540` |
| 参数三档定义 | `src/types/widgetVisibility.ts` |
| 手动整理 | `src/composables/graph/{useArrangeNodes,useArrangeSession}.ts` |
| 官方说明（Canvas→Vue 的原因） | https://docs.comfy.org/interface/nodes-2 |

## 八、查不到的（如实标注）

- **ComfyUI 没有公开文档说明「节点变高会不会压住下方」这个产品决策**——第四节的结论是从「源码里确实不存在重排逻辑」**反推**的，不是官方原话。
- 官方 blog 没有「从 Canvas 换 DOM」的独立技术长文，只有文档站的 Nodes 2.0 页。
