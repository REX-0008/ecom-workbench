# 电商 AI 工作台 · 开源方案调研（第二次，重做方向）（2026-10-05）

> 状态：已完成
> 检索日期：2026-10-05 ｜ 通道：GitHub Search API + `raw.githubusercontent.com` 抓 README。
> 本机 web_search / DDG / Bing 不可用；360 搜索只返回 CSDN 博客与电商 SaaS 官网，无可用开源项目。
> **star 数与模块清单均来自实际抓取**，未抓到的写「未获取」。

---

## 一、一句话结论

**有对得上的，但不是 100% 覆盖。** 最推荐 **IvyeaOps**（Hector-xue/IvyeaOps，185★）——它是本次唯一一个「跨境电商运营 + 多板块侧边栏聚合 + 自带服务器监控 + 自带数据采集 + 自带 AI 出图」的自托管 web 工作台，且 README 明确说前后端按模块拆分、新增板块成本低，正好对上「结构简单易改」。

次选 **OverSeek**（多模块电商运营后台，MIT，模块划分最像「工作台」），但它绑定 WooCommerce，且内容生产模块缺失。

**没有任何一个开源项目同时覆盖你的「BI + 监控 + 取数 + 图片 + 视频」全部五块**，但 IvyeaOps 覆盖 4 块（缺 BI 的深度）。

---

## 二、候选清单（8 个）

### 1. IvyeaOps ★ 最推荐
- **是什么**：面向亚马逊卖家的自托管运营工作台，侧边栏把十几个功能板块聚合在一起。
- **地址**：https://github.com/Hector-xue/IvyeaOps ｜ **185★** ｜ AGPL-3.0 ｜ Python(FastAPI) + React/Vite
- **模块**：市场调研 · 打法推荐 · Listing 工作台（采集→文案→套图分镜）· 一键图片翻译 · 分析工具（竞品/关键词/评论聚类/流量诊断）· 领星 ERP（大盘/广告优化/受控写操作/审计）· 能力市场·技能 · 知识库工作台 · 外部智能体 · **服务器终端** · **服务器监控（CPU/进程/日志/告警）** · 头程比价 · 用户管理 · 系统配置 · 资讯（24 路信源抓取+AI 汇总）
- **多模块聚合**：✅ 强。侧边栏按「工具 / AI&系统 / 小工具 / 管理」四组组织，单点登录直达所有板块，10 套配色。
- **改造难度**：低。`server/app/routers/` 每个功能一个路由，`client/src/pages/workbench/` 每个板块一个目录，路由与服务一一对应。**最适合 AI 辅助改**。
- **明显缺点**：185★、社区小；AGPL-3.0（商用需注意）；偏亚马逊/领星 ERP，天猫京东要自己接。

### 2. OverSeek
- **是什么**：开源自托管电商运营后台，把 WooCommerce 的数据、分析、履约、营销、客服收进一个私域工作区。
- **地址**：https://github.com/MerlinStacks/overseek ｜ **29★** ｜ MIT ｜ TypeScript(Fastify+React) + PostgreSQL/Elasticsearch/Redis
- **模块**：**可拖拽自定义仪表盘** · 订单与弃单 · 库存与供应链(BOM/预测/采购单) · 发货中心 · 收件箱(含 AI 起草回复) · 邮件营销 · 分析(营收/归因/cohort/CLV) · 增长(广告/评论/SEO/商品 feed) · 批发目录 · 客户与团队/RBAC · 移动 PWA · MCP server + CLI
- **多模块聚合**：✅ 强，模块切分最接近「工作台」定义，且有 drag-and-drop widget 仪表盘（外壳机制）。
- **改造难度**：中。模块多、依赖重（pgvector + Elasticsearch 9 + Redis），改之前要先跑通整套 docker compose。
- **明显缺点**：29★，社区极小；**强绑 WooCommerce**，天猫/京东无接入；无图片/视频生成。

### 3. TradeMind AI
- **是什么**：面向跨境卖家的开源 AI 运营平台，把商品采集→草稿→AI 内容→刊登→订单库存串成一条可观测工作流。
- **地址**：https://github.com/lien0219/trademind-ai ｜ **29★** ｜ Apache-2.0 ｜ Go(Gin) + React/AntD + PostgreSQL/Redis
- **模块**：采集中心（1688/拼多多/淘宝天猫/自定义规则）· 采集任务与**采集监控**（Worker/批次状态）· 商品草稿与 SKU · AI 标题描述 · AI 图片（remove.bg / OpenAI Image / ComfyUI）· 店铺授权 · 订单协同 · 库存协同 · ERP 采购与退货 · 履约分仓与拣货波次 · 销售售后 · 平台结算与订单预估利润
- **多模块聚合**：✅ 强，业务模块最多最细。
- **改造难度**：**高**。业务模型重（审批、幂等、版本冲突、职责分离），对读不懂代码的人是负担。
- **明显缺点**：29★；无视频；BI 弱；改动面大。

### 4. Beav（原 RedBox）
- **是什么**：小红书 AI 自媒体运营工作台，从资讯选题到图文创作、口播剪辑的一站式空间。
- **地址**：https://github.com/Jamailar/Beav ｜ **1807★** ｜ MIT-NC ｜ TypeScript(Electron)
- **模块**：采集与调研（浏览器插件）· 关注与选题 · 运营日报 · 热点聚合（小红书/知乎/V2EX）· 稿件与口播稿 · **媒体工坊（图片模板/参考图生成）** · **视频编辑器（多轨时间线/字幕/画中画/特效）** · 运营日历 · 账号运营规划 · 知识库
- **多模块聚合**：✅ 强，且是本次「内容生产」模块最完整的一个。
- **改造难度**：中高。**是桌面应用（Electron），不是 web 应用**——与你要的「容器型 web 应用」形态不符；体量大（仓库 161MB）。
- **明显缺点**：面向小红书，非电商；**MIT-NC 非商用限制**；无 BI、无监控、无取数后台。

### 5. BrightBean Studio
- **是什么**：可自托管的社媒内容管理平台，多账号排期发布 + 统一收件箱 + 数据分析。
- **地址**：https://github.com/brightbeanxyz/brightbean-studio ｜ **2409★** ｜ AGPL-3.0 ｜ Python(Django) + HTMX
- **模块**：多工作区与 RBAC · 内容编辑器 · 日历排期与队列 · 发布引擎 · 审批流 · 统一社交收件箱 · **分析（KPI 卡/趋势图/全帖表）** · 媒体库 · 客户门户 · 通知 · 白标
- **多模块聚合**：✅ 中上，但全部围绕「社媒内容」这一个域。
- **改造难度**：中。Django + HTMX 结构传统好懂，但插件化低，加板块要动核心。**缺点**：无图/视频生成、无 BI/监控、非电商。

### 6. FounderOS（DEMO）
- **是什么**：单人公司业务指挥中心（开源 demo），一个 Next.js 应用里塞了十几个功能路由。
- **地址**：https://github.com/Bennettxai/FounderOS-DEMO ｜ **973★** ｜ MIT ｜ TypeScript(Next.js) + SQLite
- **模块**：`/` 控制台 · `/comms` 统一收件箱 · `/funnel` 漏斗 · `/social` 增长 · `/content` 内容管线 · `/finances` 财务 · `/agents` 智能体名册 · `/tasks` · `/skills` · `/org` · `/brain` 知识图谱 · `/workflows` · `/integrations` · `/analytics` · `/roadmap`
- **多模块聚合**：✅ 强，**是本次最接近「工作台外壳」形态的现成代码**：每个路由就是一个板块，加板块 = 加一个路由目录。
- **改造难度**：**低**（结构最干净、MIT、Next.js 单应用无重依赖）。
- **明显缺点**：**是 demo**，多数连接器是假数据/占位；不是电商；无采集、无图/视频生成、无真实监控。

### 7. fitMirror
- **是什么**：电商场景 AI 全链路演示项目——顾客侧虚拟试穿客服 + 运营侧视觉生成工作台。
- **地址**：https://github.com/yuyu66688/fit-mirror ｜ **53★** ｜ MIT ｜ Python(FastAPI/LangGraph) + Vue 3 + MySQL
- **模块**：AI 客服（多轮/意图路由/试穿）· 发图找相似款 · 虚拟试穿 · **运营工作台（SKU CRUD + 三级分析→策略→提示词→出图）** · 知识库（向量检索）· 商品目录
- **多模块聚合**：✅ 中，电商 + AI 结合度高，客服与运营两侧都真做。
- **改造难度**：低-中，前后端分离、模块清晰。**缺点**：53★，定位是演示项目；无 BI/监控/采集/视频。

### 8. ProductFlow
- **是什么**：面向单人或小团队商家的开源自托管**商品素材**工作台。
- **地址**：https://github.com/yuqie6/ProductFlow ｜ **305★** ｜ MIT ｜ Python(FastAPI+Dramatiq) + React + PostgreSQL/Redis
- **模块**：商品管理 · 节点画布工作台 · AI 文案 · AI/模板海报 · 连续生图会话 · 生成图画廊 · 运行时配置中心 · 帮助文档
- **多模块聚合**：⚠️ 弱。**本质是「商品图片生产」单域工具**，不是多板块聚合容器。
- **改造难度**：中（要跑 PostgreSQL + Redis + worker + 前端）。**缺点**：模块面窄，不含 BI/监控/取数。

---

## 三、工作台外壳框架（次重点）

这类只提供「外壳 + 挂载面板」的容器，业务模块要自己写。都**不含**电商业务逻辑。

| 项目 | star | 技术栈 | 它提供什么 / 是否合适 |
|---|---|---|---|
| [gethomepage/homepage](https://github.com/gethomepage/homepage) | 32985 | JS | 静态应用仪表盘，100+ 集成、YAML 配置｜只做入口聚合 |
| [glanceapp/glance](https://github.com/glanceapp/glance) | 37343 | Go | 信息聚合仪表盘（RSS/监控/书签 widget）｜展示层 |
| [lissy93/dashy](https://github.com/lissy93/dashy) | 26633 | Vue | 个人仪表盘，状态检查/widget/主题｜展示层 |
| [homarr-labs/homarr](https://github.com/homarr-labs/homarr) | 5001 | TS | 80+ 集成、拖拽配置、内置鉴权｜拖拽机制可参考 |
| [grafana/grafana](https://github.com/grafana/grafana) | 77091 | TS | **插件式面板** + 数据源抽象｜标杆但过重 |
| [cockpit-project/cockpit](https://github.com/cockpit-project/cockpit) | 15181 | Python | 服务器 Web 界面，模块化页面｜监控板块可参考 |

> 判断：**不建议拿这些当基座**——它们是「入口/展示层」，不是「业务工作台容器」；不如从 FounderOS 或 IvyeaOps 的骨架起。

---

## 四、模块对照表

✅ = 原生具备 ｜ 🔶 = 部分/需改造 ｜ ❌ = 没有

| 项目 | BI/看板 | 监控 | 数据采集 | 内容生产（图/视频） | AI 客服 | 电商业务 |
|---|---|---|---|---|---|---|
| **IvyeaOps** | 🔶 首页+ERP 大盘 | ✅ 服务器监控 | ✅ 调研采集+资讯 | ✅ 出图/套图分镜（无视频） | ❌ | ✅ 领星 ERP |
| **OverSeek** | ✅ 分析/归因/CLV | 🔶 运营告警 | 🔶 仅 WooCommerce 同步 | ❌ | ✅ 收件箱 AI 起草 | ✅ 订单/库存/履约 |
| **TradeMind** | 🔶 采集监控为主 | ✅ 采集任务监控 | ✅ 1688/拼多多/淘系 | 🔶 AI 图片（无视频） | ❌ | ✅ 商品/订单/ERP |
| **Beav** | ❌ | ❌ | ✅ 网页/社媒插件采集 | ✅✅ 图片+视频剪辑 | ❌ | ❌ 自媒体 |
| **BrightBean** | 🔶 社媒分析 | ❌ | 🔶 收件箱回填 | 🔶 图文（无生成/视频） | 🔶 统一收件箱 | ❌ |
| **FounderOS** | 🔶 analytics/finances | 🔶 连接状态 | ❌ | 🔶 内容管线（无生成） | 🔶 comms | ❌ 通用 |
| **fitMirror** | ❌ | ❌ | ❌ | ✅ 试穿/出图 | ✅✅ | ✅ SKU/商品 |
| **ProductFlow** | ❌ | ❌ | ❌ | ✅ 生图/海报 | ❌ | 🔶 商品素材 |

**结论**：**IvyeaOps 是唯一在「监控 + 采集 + 内容生产」三块都原生具备的**，BI 与视频是缺口。

---

## 五、确实没有完全对得上的 —— 从零搭时的参考分工

没有找到「BI + 监控 + 取数 + 图片 + 视频」五块齐备、且结构简单的开源工作台。若要自己搭外壳，建议**按板块分别抄不同项目**：

| 你要的板块 | 抄谁的哪一部分 |
|---|---|
| **工作台外壳 / 侧边栏 / 板块路由** | **FounderOS**（973★，MIT，Next.js 单应用，一个路由 = 一个板块，最容易 AI 改）；次级参考 IvyeaOps 的 `client/src/layouts/` 侧边栏 |
| **BI / 看板** | OverSeek 的 drag-and-drop widget 仪表盘机制（MIT）；图表层可看 Grafana 的 panel 插件契约 |
| **监控** | **Cockpit**（模块化服务器页面）或直接抄 IvyeaOps 的「服务器监控」板块实现 |
| **数据采集** | **TradeMind 的采集中心**（采集器 Provider 架构 + 任务/批次状态页）；中文平台规则参考它支持的 1688/拼多多/淘系 |
| **图片生产** | **ProductFlow**（商品→文案→生图→图库的节点画布）或 **Beav 的媒体工坊 + 图片模板机制** |
| **视频生产** | **Beav 的视频编辑器**（多轨时间线/字幕/画中画，功能最全）；轻量替代看 ArcReel（5308★，AGPL-3.0） |
| **AI 客服** | **fitMirror**（LangGraph 意图路由 + 知识库 RAG）或 DeskcommCRM（4417★，MIT，含 WhatsApp/WAHA） |
| **电商业务底座** | **IvyeaOps**（亚马逊/领星 ERP 的板块切分）或 **TradeMind**（淘系采集与商品资产模型） |

**推荐落地路径**：以 **IvyeaOps 的整体骨架**为主干（它已经把「多板块聚合 + 电商 + AI + 监控」做成了可运行形态，且模块化程度高），缺的 BI 与视频两块，分别移植 **OverSeek 的 widget 仪表盘**和 **Beav 的视频编辑器**。

---

## 六、未获取清单

1. **IvyeaOps 的 BI 深度**：README 只展示「首页概览 + 领星 ERP 大盘」，未获取其图表能力/自定义报表范围。
2. **OverSeek 的功能门控细节**：README 说 email/shipping/wholesale/feeds/AI manager/bot shield 等模块「account-feature gated」，未获取免费自托管下哪些真正可用。
3. **TradeMind 前端技术栈与部署复杂度**：只从 topics 得到 antd/react/typescript，未获取实际启动步骤与资源占用。
4. **Beav 的 web 化可行性**：仓库含 `desktop` 与 `plugins` 目录，但未获取是否可在浏览器直接运行（未验证其是否有 web 入口）。
5. **各项目的实际可运行性**：本次只抓 README 与仓库元数据，**均未实际部署验证**；「改造难度」是基于目录结构与技术栈的**推断**，非实测。
6. **GitHub Issue/PR 活跃度**：未获取，无法判断各项目维护响应速度。
7. **中文非 GitHub 项目**：360 搜索只返回 CSDN 博客与商业 SaaS 官网（如 shopex.cn），未发现可用的国产开源工作台；Gitee 未检索（无可用通道）。
8. **被排除项**：通用工作流引擎（n8n/Dify/Node-RED）、纯 BI（Metabase/DataEase）、低代码平台、纯前端图形库——按要求未纳入候选。
