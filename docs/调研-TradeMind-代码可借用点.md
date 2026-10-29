# 调研 · TradeMind 的可借用点（2026-10-10）

> 调研对象：`refs-projects/trademind-ai/`（Go + React18/TS + Node 采集服务）
> 路径一律相对 TradeMind 项目根。所有行号来自本次实际读取的 checkout。
> 状态：**只读**，未修改被调研项目任何文件；未运行其代码（未执行构建/测试）。

## 1. 一句话结论

**最有用**：它的「**采集器 = 声明式规则 JSON + 页面摘要喂 AI 生成规则 + 质量分闸门**」整条链路（`backend/internal/modules/collectruleai/` + `collector/src/providers/sourceCustom/`）——正是委托人「采集器＝一套关键词 + 交给 agent 生成采集流程」的成熟参照；以及「**任务表 + Redis 可靠队列 + 租约 + 追加式事件时间线**」的调度骨架。
**最没用**：它的 ERP 深水区（库存/订单/采购/结算/利润/费用）与抖店真实写入链——业务逻辑极重、与「一切执行皆工作流」的设计不同源，读了只有干扰。
**它没有**：**没有任何工作流/DAG 引擎**（全仓 grep `workflow|编排|节点` 只命中注释与 landing 文案）。委托人的「节点 + 派发器」在它这里**无先例可抄**，只能抄它的任务/模块范式。

## 2. 可借用清单（核心产出）

| 我们要做什么 | 看它的哪个文件（相对路径+行数） | 借什么 | 工作量估计 |
|---|---|---|---|
| 采集器契约（可内化/可外挂的适配器） | `collector/src/providers/collector-provider.ts:15-27`；`collector/src/types/provider-meta.ts:8-21` | **抄结构**：4 个方法（sourceId/meta/canHandle/collect）+ 能力标签 `features`、状态 `available\|beta\|planned\|disabled`。正好映射我们的执行方适配器 | 0.5 天（照抄成 TS 接口） |
| 采集器注册表（不把平台逻辑写进框架） | `collector/src/providers/registry.ts:10-41` | **抄逻辑**：数组 + 大小写不敏感 Map + 历史别名 + 对外元信息列表 | 0.5 天 |
| 声明式采集规则的数据形状 | `collector/src/providers/sourceCustom/types.ts:50-79` | **抄结构**：`title/price/currency/mainImages/descriptionImages/attributes/skus/fallbacks` + `CustomCollectOptions` | 1 天 |
| 规则安全校验（AI 产物不可信） | `backend/internal/modules/collectrule/schema.go:11-64` | **抄逻辑**：64KB 上限、selector 长度/条数上限、禁用 `script/eval(/function(/javascript:` | 0.5 天 |
| **AI 生成采集流程（关键词→规则）** | `backend/internal/modules/collectruleai/service.go:295-463` | **抄流程**：分析页→取提示词模板→JSON 模式调用→解析→校验→**摘要补全**→**真跑一次试采集**→质量分 | 2-3 天 |
| AI 输出不全时的兜底补全 | `backend/internal/modules/collectruleai/augment.go:93-193` | **抄逻辑**：按候选 selector 置信度排序补 title/price/图片，并回写「已从页面摘要补全」告警 | 1 天 |
| 生成结果的质量闸门（不给用户烂规则） | `backend/internal/modules/collectruleai/quality.go:10-41` | **抄逻辑**：字段命中计分 + 60 分阈值 + 宽泛 selector 扣分 + allowSave/blockReasons | 1 天 |
| 页面摘要采集（喂 AI 的输入） | `collector/src/providers/sourceCustom/analyze-page.ts:38-90` | **仅参考**：在页内构造 `{selector,sample,count,confidence}` 候选，**只回摘要不回整页 HTML** | 1.5 天 |
| 平台冲突拦截（有专用采集器就别用自定义） | `backend/internal/modules/collectruleai/platform.go:36-63` | **抄逻辑**：URL→平台→已有 available/beta 采集器则拒绝并给推荐文案 | 0.5 天 |
| 任务状态模型（含租约字段） | `backend/internal/modules/collect/model.go:12-93` | **抄结构**：状态机 7 态 + Batch 聚合 + 事件表；`lockedBy/lockedUntil/lockVersion/executionId/heartbeatAt` | 0.5 天 |
| 可靠队列（不丢任务） | `backend/internal/modules/collect/queue.go:35-101` | **抄逻辑**：LPUSH → **BRPOPLPUSH 到 processing** → ack 删除 / requeue 回主队列 | 1 天（Redis 或等价实现） |
| Worker 消费 + 幂等守卫 | `backend/internal/modules/collect/worker.go:89-193` | **抄逻辑**：多槽并发、状态不匹配直接 ack 丢弃、租户校验、panic 兜底 | 1 天 |
| 原子认领 + 租约续期（防重复执行） | `backend/internal/modules/collect/lease.go:29-78` | **抄逻辑**：claim 时校验 `locked_by+execution_id+lock_version`；续期；过期由 reaper 回收 | 1.5 天 |
| 重试与退避（区分可重试/不可重试） | `backend/internal/modules/collect/retry.go:17-90` | **抄逻辑**：指数退避封顶、错误码白名单决定是否重试 | 1 天 |
| 按来源限速（批量采集防封） | `backend/internal/modules/collect/batch_policy.go:9-64`；`batch_throttle.go:27-114` | **抄逻辑**：每源并发数 + 随机延迟 + Redis SetNX 闸门（Lua 安全释放） | 1 天 |
| 进度上报 / 时间线 | `backend/internal/modules/collect/events.go:18-33,65-103,230-283` | **抄结构**：追加式事件表 + 状态迁移记录 + **敏感 key 黑名单过滤** + 分页接口 | 1 天 |
| 商品资产模型（含平台映射） | `backend/internal/modules/product/model.go:41-131` | **抄结构**：Product 同时存原值与 AI 值；Image 带类型/来源/评分；SKU 带成本/划线价/预警库存；**平台映射独立表**（不污染原始数据） | 1 天 |
| 采集结果→商品的归一化 | `collector/src/types/product.ts:1-29`；`backend/internal/modules/collect/custom_import_normalize.go:36-81` | **抄逻辑**：任何来源先归一成统一结构；`raw` 必留；无 SKU 时合成默认规格；币种推断 | 1 天 |
| 模块划分（对节点设计的参考） | `backend/internal/modules/`（63 个模块，每个模块内 handler/service/model/dto/router 同包）；`docs/architecture/module-boundaries.md:15-24,48-62` | **仅参考**：一模块=一业务域、依赖单向、provider 隔离外部能力 | 0（当目录规范读） |
| 多板块后台导航与路由 | `admin/config/routes.ts:54-315`；`admin/src/layouts/*GroupLayout.tsx`（各 4-15 行） | **抄结构**：单文件声明式路由 = 菜单；分组用极薄 layout 壳（只做默认子页跳转） | 0.5 天 |
| 菜单权限过滤 | `admin/src/app.tsx:323-330`；`admin/src/utils/menuAccess.ts` | **抄逻辑**：`menuDataRender` + `filterMenuByPermission`，不在路由里写 access | 0.5 天 |
| 前端 API 传输边界 | `admin/src/services/*.ts`（60 个，按业务域一文件） | **抄结构**：页面不直接拼请求，service 不 import 页面 | 0.5 天 |
| AI 能力封装（唯一入口） | `backend/internal/providers/ai/gateway.go:16-109`；`provider.go:5-9`；`factory.go:14-42` | **抄结构**：业务只调 Gateway；Provider 接口只有 `Chat`；按 settings 分派 + 统一超时 + 连通性自测 | 1 天 |
| 图像能力封装 | `backend/internal/providers/image/provider.go:5-15`；`types.go:9-60` | **抄结构**：7 个能力方法 + 请求/结果类型；结果只回 URL 或原始字节 | 1 天 |
| 提示词模板化（不硬编码 prompt） | `backend/internal/modules/aiprompt/model.go:8-22`；`seed.go:12-41` | **抄结构**：code 唯一 + 场景 + 变量占位 + **输出 JSON Schema** + 温度/上限；启动时 seed 默认模板 | 0.5 天 |
| 任务中心统一视图（多来源合并） | `backend/internal/modules/taskcenter/source_priority.go:5-41`；`merge.go` | **仅参考**：9 类任务按固定优先级合并成一张列表 + 失败标记不改源表 | 1.5 天 |

## 3. 关键实现解读

### 3.1 AI 生成采集规则（最值得抄）
**怎么做的**（`collectruleai/service.go:295-463`，已验证）：① 校验 URL + 读 settings 开关；② 检查该平台是否已有专用采集器，有就直接拒绝并给推荐（`platform.go:36-63`）；③ 让采集服务**在页面内**抽一份摘要（候选 selector + 样本 + 命中数 + 置信度，`analyze-page.ts:38-90`），按上限截断（`service.go:251-280`）；④ 取 `ai_prompts` 里 code=`collect_rule_generate` 的模板，变量替换后以 **JSON 模式**调用；⑤ 解析 + 安全校验；⑥ **用摘要把 AI 漏掉的字段补上**（`augment.go:93-193`）；⑦ **真拿这条规则跑一次采集**（`service.go:465-497`）；⑧ 算质量分，<60 给出「请重新生成」告警。
**我们能不能用**：能，且几乎是逐条对应。委托人的「关键词」可换成「目标字段清单 + 站点样本」；「agent 生成采集流程」= 步骤 ③④⑥⑦。
**要注意**：它把「**先试跑再落库**」当成硬要求——这是规则可用性的唯一保证，别省。AI 产物必须过 schema 校验（`collectrule/schema.go:15-20` 的禁用模式），因为规则最终会被注入页面执行。

### 3.2 任务调度骨架（采集中心可直接复用）
**怎么做的**（已验证）：任务表带租约字段（`collect/model.go:50-73`）；入队 LPUSH，消费用 **BRPOPLPUSH** 挪到 `...:processing`，成功才 LREM，失败 TxPipelined 回主队列（`queue.go:49-100`）——进程崩了也不会丢；认领是带版本号的原子更新，续期协程保活，超时由 reaper 回收（`lease.go:29-114`）；每次状态变化追加一条事件行（`events.go:105-142`），payload 过敏感 key 黑名单。
**我们能不能用**：能。我们的派发器可以直接借这套「**队列 + 租约 + 事件时间线**」三件套；`batch_policy.go` 的「每来源并发闸门」正好对应「每个执行方适配器限流」。
**要注意**：它把「执行中」的中间态也落库（`locked_by/lock_version`），换来的是**可查、可恢复、可重放**。如果只做内存队列，这块收益就没了。

### 3.3 模块划分与 Provider 隔离
**怎么做的**（已验证）：`backend/internal/modules/` 下 63 个平铺模块，每个模块自带 `handler.go/service.go/model.go/dto.go/router.go`（同包，不强制分层目录）；外部能力全部收在 `backend/internal/providers/`（ai/image/ocr/storage/platform/email）。边界规则写在 `docs/architecture/module-boundaries.md:15-24`：worker 不得依赖 handler、repository 不得决定状态机、共享层不得反向依赖业务。
**我们能不能用**：能，但要**改一处**——它是「模块 = 业务域」，委托人是「**节点 = 执行单元**」。建议：模块仍按业务域切（商品/客服/数据/内容/工作流），模块内的每个能力再包成一个节点，由派发器调用。这样节点不会退化成散落的函数。
**要注意**：它的模块内 service 文件经常 500-1300 行（如 `collect/service.go` 933 行、`aiproducttext/service.go` 1355 行）。**别抄这个体量**。

### 3.4 AI / 图像能力封装
**怎么做的**（已验证）：`providers/ai/provider.go:5-9` 接口只有 `Name()` + `Chat()`；业务只调 `Gateway.Chat`（`gateway.go:45-109`），由 Gateway 读 settings、合并默认参数、选模型（有图自动切视觉模型）、加超时、建 client；新增厂商只加一个 `case`（`factory.go:24-41`）。图像侧是 7 个能力方法的大接口（`image/provider.go:5-15`），配套能力表 `image/capabilities.go`。
**我们能不能用**：能。AI 侧照抄；**图像侧建议不要照抄那个 7 方法接口**——它导致 `imagetask/` 膨胀到 77 个文件。改成「一个能力 = 一个节点」，每个节点声明自己需要的能力，适配器按能力注册。
**要注意**：提示词进数据库（`aiprompt/model.go:8-22`）并带 `outputSchema`，这个设计值得保留。

## 4. 不借的部分

- **ERP 深水区**：`inventory/`、`order/`、`procurement/`、`salesreturn/`、`settlement/`、`profitability/`、`warehousefee/`、`freightfee/`、`advertisingfee/`、`warehouse/`、`logistics/` —— 与「工作流派发」不同源，且大量业务语义（最小货币单位、失败关闭、快照 revision）只在它自己的 ERP 语境成立。
- **抖店真实写入链**：`operationtask/`、`productpublish/`、`productioncontrol/`、`douyinruntime/` —— 高度平台专属 + 审批/灰度/kill switch，我们不做真实平台写入。
- **图片文字翻译引擎**：`imagetask/translate_*.go`（30+ 文件，OCR/坐标/重排/渲染/校验）—— 单点能力，不是工作流问题。
- **运维文档海洋**：`docs/runbooks/`（40 篇）、`docs/*_DESIGN.md`（80+ 篇）、`SLO.md`、`DISASTER_RECOVERY_PLAN.md` —— 生产运维产物，我们内部小团队用不上。
- **Go 代码本身**：只取思路，不移植。
- **`collector/src/normalizer/index.ts`**：全文 2 行，是空壳（已验证），别指望。

## 5. 未获取 / 未验证

- 未运行项目任何代码；未执行其构建与测试，**接口行为均为静态阅读所得**。
- 未读：`collector/src/browser/session-manager.ts`（登录态/浏览器 Profile 机制，委托人若要做「agent 驱动浏览器」需补读）、`customerchat/`、`customersync/`、`imagetask/` 主体、`docs/api.md` 全文。
- 「它没有工作流引擎」是**基于全仓关键词 grep 的推断**（命中均为注释/landing 文案），未逐个文件人工确认。
- 表格中的**工作量估计为推断**，未做实测；按单人熟悉 TS/React 的节奏估算。
- 行号基于当前 checkout；若项目更新可能漂移。
