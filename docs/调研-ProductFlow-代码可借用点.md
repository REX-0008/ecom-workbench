# 调研 · ProductFlow 的可借用点（2026-10-08）

> 状态：已完成 · 日期：2026-10-08 · 类型：单项调研（工作流画布）
> 对象：`refs-projects/ProductFlow/`（React **19.2.5** + Vite + TS + Tailwind **v4** + `@xyflow/react` 12.10.2）
> 方法：逐文件实读源码，行号为本机实测。**已验证**＝读过该行源码；**推断**＝由代码逻辑推出、未运行验证。

## 一、一句话结论

**最有用**：`reactFlowAdapters.ts`（149 行纯函数，业务模型 ⇄ React Flow 双向转换）+ `WorkflowCanvas.tsx` 的**乐观位置 + 版本号确认**机制 + `WorkflowNodeCard.tsx` 的**状态胶囊/选中环/运行光效**。前两者零依赖、可直接搬；第三者抄 class 与动画即可。

**最没用**：它的业务语义。节点类型只有 4 种且写死（`lib/types.ts:7-11`），节点卡片内容、`nodeDisplay.ts`、i18n 文案全是「商品文案/海报生成」专用，我们的派发器/适配器模型对不上。

**最关键的三个回答**：
1. **适配层能脱离后端独立用吗？——能，完全能。** 它只 `import type` 了 xyflow 的类型（`reactFlowAdapters.ts:1`），**运行时零依赖** React 与 xyflow；测试也只依赖 vitest + 类型（`reactFlowAdapters.test.ts:1-3`）。已验证。
2. **改成我们的模型要动多少？——约 5 个函数、半天。** 只有字段名映射（`position_x/position_y`、`source_node_id/target_node_id`、`node_type`）需要改。
3. **哪些代码用了 React 19 特性？——画布这一栈，一行都没有。** 全库 grep：`useActionState`/`useOptimistic`/`useFormStatus`/ref-as-prop 清理函数/新 `use()`/propTypes 全部 **0 命中**。唯一锁定 React 19 的只是 `package.json` 的版本号本身。详见第三节 3。

---

## 二、可借用清单（核心产出）

| 我们要做什么 | 看它的哪个文件（相对 `refs-projects/ProductFlow/`，带行号） | 借什么 | 工作量估计 |
|---|---|---|---|
| 业务模型 ⇄ 画布模型互转 | `web/src/pages/product-detail/reactFlowAdapters.ts:1-149` | **抄逻辑**（整文件，改字段名） | 0.5 天 |
| 拖拽后写回后端的时机控制 | `reactFlowAdapters.ts:98-120` + `WorkflowCanvas.tsx:1106-1186` | **抄逻辑**（按屏幕距离判是否提交，防误触） | 0.5 天 |
| 乐观位置 + 防止旧响应覆盖新位置 | `WorkflowCanvas.tsx:69-85, 747-754, 1083-1104` | **抄逻辑**（`mutationVersion` 版本号握手） | 0.5 天 |
| 画布总装配（缩放/平移/多选/框选/触摸） | `WorkflowCanvas.tsx:1249-1310`（ReactFlow props）+ `932-940`（触摸分支） | **抄结构**（配置项逐条对照，见第三节 2） | 1 天 |
| 边的自定义渲染 + hover 才出现的删除按钮 | `WorkflowCanvas.tsx:364-436` | **抄逻辑** | 2 小时 |
| 连线合法性校验 + 端点高亮（合法/非法/起点） | `WorkflowCanvas.tsx:162-170, 185-221, 307-319, 1211-1222` | **抄逻辑** | 3 小时 |
| 节点卡片视觉（毛玻璃/状态胶囊/选中环/缩略图位） | `WorkflowNodeCard.tsx:62-114` | **抄结构 + 抄数值** | 0.5 天 |
| 运行/排队光效与粒子动画 | `WorkflowNodeCard.tsx:74-80, 132-149` + `web/src/index.css:335-363, 365-407, 461-472` | **抄数值**（keyframes 可整段搬） | 2 小时 |
| 状态 → 颜色/文案的映射表 | `utils.ts:88-97` + `WorkflowCanvas.tsx:457-470`（MiniMap 配色） | **抄结构** | 1 小时 |
| 节点运行态展示（能否运行/排队中/不可重试） | `utils.ts:143-193` | **抄逻辑** | 2 小时 |
| 取消 / 重试入口 | `utils.ts:195-213`（找可取消的 run）+ `RunsPanel.tsx:112-169` | **抄结构** | 3 小时 |
| 队列位置 / 排队文案 | `utils.ts:235-256` | **抄逻辑** | 1 小时 |
| 失败原因 / 重试提示在卡片上的呈现 | `WorkflowNodeCard.tsx:164-195` + `utils.ts:258-291` | **抄结构** | 2 小时 |
| 撤销/重做栈 | `workflowHistory.ts:46-54`（步骤联合类型）+ `ProductDetailPage.tsx:575-587, 742-777` | **抄结构** | 0.5 天 |
| 删除类操作的二次确认 | `workflowHistory.ts:81-83` + `ProductDetailPage.tsx:766-777` | **抄逻辑** | 1 小时 |
| 撤销时不要把产物 id 一起还原 | `workflowHistory.ts:25-79` | **抄逻辑**（思路值得学） | 1 小时 |
| 选择模型（主选 + 次选 + 框选后归一） | `selection.ts:1-82` | **抄逻辑**（整文件） | 2 小时 |
| 快捷键（复制/粘贴/删除/撤销/输入框避让） | `shortcuts.ts:1-90` | **抄逻辑**（整文件） | 2 小时 |
| 快捷键接线（弹窗打开时禁用等） | `ProductDetailPage.tsx:1619-1710` | **抄结构** | 2 小时 |
| 小地图 / 控制条 / 网格背景 | `WorkflowCanvas.tsx:547-635, 1312-1327, 1347-1358` | **抄结构** | 3 小时 |
| 缩放持久化与钳制 | `reactFlowAdapters.ts:33-35` + `WorkflowCanvas.tsx:707-723` | **抄逻辑** | 1 小时 |
| 自动布局 | `WorkflowCanvas.tsx:774-927` | **仅参考，别抄**（有死循环缺陷，见第三节 4） | — |
| 它的节点文案 / i18n / 业务字段 | `nodeDisplay.ts`、`lib/types.ts:193-309` | **不借** | — |

---

## 三、关键实现解读

### 1. 适配层：为什么它能脱离后端独立用（已验证）

**怎么实现的**：`reactFlowAdapters.ts` 只有 6 行 import——4 个是 `import type`（xyflow 的 `Connection/Edge/Node/XYPosition`，编译后消失），另 2 个是自己目录下的 `constants.ts` 与 `utils.ts`，而这两个又只用到 `clamp` 与三个数字常量。**它没有 import 任何 React**。业务模型通过泛型/结构类型注入（如 `:89-96` 只要求对象有 `workflowNode.position_x` 与 `position`），不绑定具体类型。

**能不能用**：能，整文件搬。把 `WorkflowNode`/`WorkflowEdge` 换成我们的模型类型，把 `position_x/position_y` 换成我们的字段即可；`PRODUCTFLOW_NODE_TYPE` 等常量改名即可。它自带的 `reactFlowAdapters.test.ts`（149 行）也可以一起搬，改一下 fixture 工厂函数（`:24-57`）就行。

**要注意**：① `getChangedWorkflowNodePositionCandidates`（`:89-96`）做的是**整数四舍五入后再比较**，所以「亚像素抖动」不会触发后端写请求——这个细节别丢；② `workflowToReactFlowNodes` 里的 `preservePreviousPositionsForNodeIds`（`:48`）是给「拖拽中不要被后端回包覆盖」用的，要配合 `WorkflowCanvas.tsx:953` 一起理解，单抄一半会失效。

### 2. 画布交互：哪些是 React Flow 配置，哪些是自己的活（已验证）

**怎么实现的**：`WorkflowCanvas.tsx:1249-1310` 把交互全部交给 `<ReactFlow>` 的 props：`panOnDrag={[0]}`（左键拖拽平移）、`selectionKeyCode="Shift"` + `multiSelectionKeyCode=["Control","Meta"]`、`selectionMode={SelectionMode.Partial}`、`panActivationKeyCode="Space"`、`nodeDragThreshold/nodeClickDistance` 按是否触摸屏切换（`:935-940`，触摸 6px / 鼠标 0 与 3px）、`deleteKeyCode={null}` 并把 `onBeforeDelete` 固定返回 `false`（`:1278, 1302`）。**删除一律不走 React Flow**，而是自绘按钮 → 回调 → 后端 API（适配层里 `deletable:false`、`:58,74`）。

**我们能不能用**：能，这一段的配置项可以逐条对照抄。我们 React 18 + `@xyflow/react` 12 是兼容的（见下条）。

**要注意**：① 它把「拖拽提交」和「点击选中」用同一个距离阈值区分（`:938-940`），这是触摸屏上「手指微动不该算拖拽」的解法，值得照做；② 它用 `forwardRef + useImperativeHandle`（`:651, 747-928`）把「居中节点/适配选中/自动布局」暴露给父组件——React 19 允许 ref 直接当 prop，我们 React 18 **必须保留 `forwardRef`**，好在它本来就是这么写的，不用改。

### 3. React 19 特性：实测结论是「没有」（已验证）

**怎么查的**：对 `web/src` 全目录 grep 了 `useActionState`、`useOptimistic`、`useFormStatus`、新 `use()`、`propTypes`、`defaultProps`、字符串 ref、`useSyncExternalStore`、`useTransition`、`useDeferredValue`、`startTransition` —— **全部 0 命中**。用到的 React API 只有 `forwardRef / memo / useCallback / useEffect / useImperativeHandle / useMemo / useRef / useState / createContext / useContext / lazy / Suspense`，这些在 React 18 全都在。

**真正的锁点只有一个**：`web/package.json:18-19` 写死 `react ^19.1.1`，lockfile 解析到 `react@19.2.5`（`web/pnpm-lock.yaml:11-21, 1439, 1495`）。

**要注意**：① `@xyflow/react` 的 peer 声明是 `react: ">=17"`（`web/pnpm-lock.yaml:956-961`，已验证），所以 React 18 **声明上兼容**；但该项目实际只在 React 19 上跑过，**在 React 18 上的真实表现我无法核实**（本机没有 `node_modules`，跑不起来）——**推断**风险低，但建议先做一次最小验证。② 抄代码时把 `@types/react` 一并降到 18，否则类型层会打架。③ 它用 Tailwind **v4**（`web/package.json:25,33`，CSS-first 配置），class 写法与 v3 有差异，若我们还在 v3 需逐条转换。

### 4. 自动布局：这是**反面教材**（已验证，别抄）

`WorkflowCanvas.tsx:774-927` 是一段约 150 行的「分层自动布局」，但算法本身有问题：它用 BFS 队列（`:806-813`）却**从不递减入度、也没有 visited 集合**，节点会被反复入队。对 DAG 是重复计算，**对有环的图会永远循环下去**（按代码逻辑推断：`queue.push(v)` 无条件执行，环上节点永远回到队尾）。此外它还靠 `document.querySelector` 量 DOM 真实高度（`:828-850`）、把固定值 `centerY=216` 当垂直中心（`:853`）。**我们若要做自动布局，用现成库或自己写带 visited 的拓扑分层，不要搬这段。**

---

## 四、不借的部分

- **`nodeDisplay.ts`（143 行）**：整篇是「商品文案节点/图片节点」的中英文旧标题清洗，与我们的派发器模型无关。
- **`lib/types.ts:1-192, 323-739`**：商品、文案、海报、图库、供应商配置等业务类型，全不看。我们只关心 `193-309` 那段画布结构。
- **`nodeDisplay.test.ts` / `workflowConfig.ts` / `InspectorPanel.tsx` / `TemplateGroupsPanel.tsx` / `ImagesPanel.tsx`**：节点配置表单与模板库，绑定它的业务字段。
- **`ProductDetailPage.tsx` 其余 2300 行**：它把「画布 + 侧栏 + 表单 + 产物刷新」揉在一个 2450 行的组件里，是反面结构；只挑上表列出的片段看，别整篇读。
- **`backend/`（Python/FastAPI）**：本次任务范围外，未读。它的队列/重试语义只通过前端类型间接看到。

## 五、未获取 / 未验证

- **未运行验证**：`web/node_modules` 不存在，未安装依赖、未跑测试、未起服务。所有「能不能跑」的判断均为**读代码推断**。
- **未核实**：`@xyflow/react` 12.10.2 在 React **18** 上的实际表现（声明兼容，实测缺）。
- **未核实**：Tailwind v4 → v3 的 class 迁移成本，未逐条比对。
- **未读**：`backend/`、`docs/`、`.trellis/`。
- **只看了关键文件**：`WorkflowCanvas.tsx` 全文、`WorkflowNodeCard.tsx` 全文、`reactFlowAdapters.ts` 全文、`workflowHistory.ts`/`selection.ts`/`shortcuts.ts`/`utils.ts`/`types.ts` 全文、`ProductDetailPage.tsx` 的 6 段（115-215/570-620/735-800/900-1000/1619-1710/2070-2120）、`index.css` 仅 grep 定位。
