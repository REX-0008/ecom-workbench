/** 工作台默认板块 —— **全部走 registerBoard 注册，没有特权通道**。
 *
 * ## 这里现在是什么
 *
 * 它不再是「骨架读的清单」，而是**一份注册文件**：本文件在模块初始化时把默认板块
 * 交给 `board-registry.ts` 的注册表。骨架（`EcomWorkbench.tsx`）只读注册表，
 * **一个字都不认得这些板块 id** —— 所以以后增减板块、改顺序、第三方插件插界面，
 * 动的都是注册项，不动骨架。
 *
 * ## 顺序 = 导航顺序（用户 2026-10-21 定，2026-10-22 加第九块，2026-10-23 减两块）
 *
 * **总览 / 自动化 / BI / 内容 / 工作流 / 收藏 / 提示词**（现共 7 块）。
 * 靠每个板块的 `order` 排出来（10 / 20 / … / 90），不靠数组位置 ——
 * 第三方插块时只要给个 order 就能插到想要的位置。
 *
 * ⚠️ `order` 只增不改：删板块时**留空号**（30 之后直接 60），
 * 不把后面的往前挪 —— 第三方插件的 order 是按现有号段挑的，重排会撞车。
 *
 * ## 两种板块，同一个接口
 *
 * · **画布类**（工作流板块）：它在骨架里有一个**常驻挂载**的格子，靠 tab 上的
 *   `keepMounted` **声明**出来（不是骨架里判断某个 id）。原因见
 *   `EcomWorkbench.module.css` 的 `.pane` 注释（四条坑，缺一条就露馅）。
 * · **普通类**：内容放进滚动容器，切走就卸载。
 *
 * ## 图标存组件引用（不存字符串）
 *
 * 调用方直接当组件渲染，主题色靠 `currentColor` 跟随。
 */
import {
  AutomationIcon, ChartColumnIcon, ImageIcon,
  LayoutDashboardIcon, MessageSquareIcon, StarIcon, WorkflowIcon,
  /* 票 66：「配置」板块的图标。票面写的是 `GearIcon`，但那个名字是
   * `EcomWorkbench.tsx:46` 里**私有的**齿轮函数，`icons.tsx` 里没有；
   * 这里对应的是 `SettingsIcon`（lucide settings，同样是齿轮形状）。
   * 用图标集里现成的那个，不新造一个 —— 也省得改 `icons.tsx`（它不在本票可改路径）。 */
  SettingsIcon,
} from './icons.tsx'
import { registerBoard } from './board-registry.ts'
import type { BoardTab } from './board-registry.ts'
import { WorkflowBoard } from './WorkflowBoard.tsx'
import { CollectPanel } from './CollectPanel.tsx'
import { ConfigBoard } from './ConfigBoard.tsx'
/* 六个板块的真实内容（2026-10-21 接入）。**在那之前**它们都指向一个占位组件，
 * 那句「待接入」就是它渲染的。
 *
 * ⚠️ **那个占位组件已经删了**（票 47，2026-10-28，用户「7.删」）：
 * 它叫 `PendingBoard.tsx`，六个板块接入真实内容后**全仓零引用**，
 * 只在本文件这一行注释里还被提到。想找那份最小样例的话**已经没有这个文件了**，
 * 要照抄「一个板块长什么样」，直接看下面任何一个真实板块组件。 */
import { OverviewBoard } from './OverviewBoard.tsx'
/* ⚠️ 别名：本文件底部那个 `CollectBoard` 是**收藏**板块的薄壳（老名字，先到先用）。
 * 这里引进来的是**取数**板块，所以按它的注册 id 叫 `CollectDataBoard`。 */
import { CollectBoard as CollectDataBoard } from './CollectBoard.tsx'
import { BiBoard } from './BiBoard.tsx'
/* ⚠️ `ScheduleBoard` 的 import 已从这里删掉（2026-10-23）：
 * 它不再注册成独立板块，改由 `CollectBoard.tsx` 自己引用并放进「定时任务」那一格。
 * 组件文件本身没动。 */
/* ⚠️ `NotifyBoard` 的 import 已从这里删掉（2026-10-23）：
 * 提醒不再注册成独立板块 —— 它的**两项设置**搬进了工作台设置
 * （`WorkspaceSettings.tsx` 的「提醒」一节）。
 * 文件已改名为 `NotifyDiagnostics.tsx`（只剩「通知通道自检」与「什么情况会提醒」
 * 两块运行时诊断），由 `WorkspaceSettings.tsx` 在「提醒」一节底部折叠挂载 ——
 * **不是死代码**，`tests/dom-render.mjs` 的 ⓘ 段有断言盯着它。 */
import { ContentBoard } from './ContentBoard.tsx'
/* 第九个板块（2026-10-22 加）：「提示词」—— 模板库。
 * 图标用现成的那套里的 `PackageIcon`（模板也是「一堆可取的件」），不新画图标。 */
import { PromptBoard } from './PromptBoard.tsx'

/**
 * 工作流板块的三格。
 *
 * ⚠️ **顺序 2026-10-13 调过**（用户要求：「将工作流放第一个」）。
 * 为什么顺序重要：默认打开的是 `tabs[0]` —— 所以「谁排第一」= 「进这个板块先看到什么」。
 * 用户的选择是**先看清单**：进来先挑一份（或新建），再进画布。
 *
 * ⚠️ **改过名**（原来叫「工作流」）。左侧栏那个**板块入口**就叫「工作流」，
 * 同一格再叫「工作流」—— 同一个词指两个不同的东西，用户分不清「点哪个」。
 * 现在叫「工作流管理」：与板块入口区分开，且说清它是**管理面**。
 *
 * ⚠️ `keepMounted: true` 只标在画布那一格上：那是「切走不卸载、只藏起来」的声明。
 * 列表页与运行历史没有这个需要，卸了再挂反而是干净的。
 */
const WORKFLOW_TABS: readonly BoardTab[] = [
  /* ★ 票 01（2026-10-30）：**画布那格挪到第一位，并声明成 `dynamic`**。
   *
   * 用户原话：「工作流中的画布应该按照内容板块进行同样操作，默认隐藏画布，
   * 在工作流管理中新建或者打开画布才在第一个 TAB 出现画布。」
   *
   * ## 两个标记管两件不同的事（别混）
   *
   * · `dynamic: true` —— 这一格**在不在 tab 条上**由板块上报决定。
   *   板块默认只报 `['files', 'history']`（画布不出现），
   *   新建或打开一份之后才报上 `['canvas', 'files', 'history']`。
   * · `keepMounted: true` —— 切走**不卸载**，只藏起来。
   *   画布必须常驻（节点与连线是组件内 `useState`，卸载即丢，
   *   而撤销栈是模块级 store 不跟着销毁 —— 切回来「屏幕」与「历史」对不上）。
   *
   * ⚠️ 两者独立：动态格可以「不在 tab 条上但仍然常驻」。画布就是这样 ——
   * 用户关掉画布那一格之后，它仍挂着（下次打开才不用重挂）。
   *
   * ## 为什么画布排第一位
   *
   * 用户要求「才在第一个 TAB 出现画布」。而骨架的「当前格」默认取 `tabs[0]`，
   * 所以画布必须写在第一位 —— 同时板块那一侧要兜一层（`tab === 'canvas'`
   * 但一份都没开时显示「工作流管理」），否则第一次进板块会先看到空白。
   * 那个兜底照 `ContentBoard.tsx` 的做法。 */
  { id: 'canvas', label: '画布', dynamic: true, keepMounted: true },
  { id: 'files', label: '工作流管理' },
  { id: 'history', label: '运行历史' },
]

/**
 * 收藏板块的三格（用户 2026-10-11：**不要再分一层**）。
 * 「设置」用来配两侧的 skill 目录（两侧都可配多个）。
 */
const COLLECT_TABS: readonly BoardTab[] = [
  { id: 'skill', label: 'Skill' },
  { id: 'github', label: 'Github项目' },
  { id: 'settings', label: '设置' },
]

/* ── 六个板块的内容组件 ──────────────────────────────────────────────────
 *
 * 2026-10-21 接入真实内容（原来是同一句「待接入」的空壳）。六个组件各自住在
 * 同名的文件里：OverviewBoard / CollectBoard / BiBoard / ScheduleBoard /
 * ContentBoard（`NotifyBoard` 已改成 `NotifyDiagnostics`，不再是板块）。
 *
 * ⚠️ **它们没有在这里声明 tabs**，而是各自在板块内部画 tab 条
 * （`SlidingTabs`，与工作流板块同一个组件）。理由：这两处 tab
 * （取数的「采集中心 / 采集任务」、内容的「图片 / 视频」）是**板块内部的视图切换**，
 * 不是骨架级的导航；放在板块里，第三方插件照抄一个板块时不会被骨架的 tab 契约绊住。
 *
 * ⚠️ **组件引用必须稳定**：这里全是 `import` 进来的模块级函数，
 * 不是每次渲染现造的箭头函数 —— 否则骨架里那个 ErrorBoundary 会跟着换身份、
 * 每次渲染把那块重新挂一遍。 */

/**
 * 注册默认板块。
 *
 * @returns 一次性摘掉它们的函数（插件重载/停用时用）。
 */
export function registerDefaultBoards(): () => void {
  const disposers = [
    registerBoard({
      id: 'overview',
      title: '总览',
      group: '运营',
      icon: LayoutDashboardIcon,
      order: 10,
      component: OverviewBoard,
    }),
    registerBoard({
      /* 「取数」→「自动化」（用户 2026-10-23 定）。
       *
       * 改名的理由（用户原话指向的意思）：这块不只是"取数"，它是**跑批**的地方 ——
       * 取数、清洗、定时、看结果都在这里。「取数」这个名字只说出了其中一步。
       *
       * ⚠️ **图标 2026-10-23 换过（契约 Y）**：原来是 `DownloadArrowIcon`（下载箭头），
       * 那是「取数一步」的图标，与改完的名字对不上。现在用 `AutomationIcon`
       * （两条反向弧形箭头 = 周而复始地跑）。用户原话：「左侧栏的 ICON 需要调整一下」。 */
      id: 'collect-data',
      title: '自动化',
      group: '运营',
      icon: AutomationIcon,
      order: 20,
      component: CollectDataBoard,
    }),
    registerBoard({
      id: 'bi',
      /* ★ 常驻挂载（用户 2026-10-23：「BI 的界面要持久化，切走再切回不该重新加载」）。
       *
       * 这一条**只加声明，不改骨架**：`EcomWorkbench.tsx:171` 的 `keepsMounted()`
       * 本来就认注册项上的 `keepMounted`，所以加这一个字段就够了。
       *
       * ⚠️ 它与画布那条是同一个机制（`boards.ts:66`）：打开过一次就一直挂载，
       * 切走只是藏起来。隐藏规则（`.boardPane` / `.pane` 那四条）**一处都不用动**。 */
      title: 'BI',
      group: '运营',
      /* ⚠️ **图标 2026-10-23 换过（契约 Y）**：原来用 `LayoutGridIcon`（四宫格），
       * 与总览的 `LayoutDashboardIcon`（也是四块矩形）缩到 15px 分不出。
       * 用户原话：「BI 的图标与总览太像」。现在用柱状图，轮廓一眼不同。 */
      icon: ChartColumnIcon,
      order: 30,
      keepMounted: true,
      component: BiBoard,
    }),
    /* ⚠️ 独立的「定时」板块已删（用户 2026-10-23：「定时板块挪进自动化的 tab 里」）。
     *
     * 删除前确认过：`ScheduleBoard` 的界面已经嵌进自动化的第二格
     * （`CollectBoard.tsx` 的 `scheduled` 那一格），新增 / 删除 / 立即跑 / 启停
     * 这些能力全部由它自己提供，没有退化。
     * 这里**删的只是导航入口**，`ScheduleBoard` 组件本身照旧存在。
     *
     * ── 独立的「提醒」板块也删了（用户 2026-10-23 m02240）──────────────
     *
     * 用户原话：「提醒板块仅仅是设置问题，将提醒板块内容压缩放到工作台设置中」。
     *
     * 搬走的是**两项设置**（`failNotify` / `alertMinLevel`），现在住在
     * `WorkspaceSettings.tsx` 的「提醒」一节里，与「模型」「浏览器」并列。
     *
     * ⚠️ **没搬**的是那个板块里原先剩下的两块，它们不是设置：
     *   · **通知通道自检**（真起一次 PowerShell 并弹一条）—— 运行时诊断；
     *   · **什么情况会提醒**（读真实定时任务，标出每条现在会不会发）—— 运行态展示。
     * 这两块已移到 `NotifyDiagnostics.tsx`，由 `WorkspaceSettings.tsx` 在
     * 「提醒」一节的底部**折叠挂载**（2026-10-23 定）。不塞进设置的主选项区，
     * 是因为一个「点一下会真的弹通知」的按钮会让人分不清
     * 「我现在选什么」与「它现在怎么样」；折叠起来只在排查时展开。
     */
    registerBoard({
      id: 'content',
      title: '内容',
      group: '创作',
      icon: ImageIcon,
      order: 60,
      /* 内容板块从「两格空壳」变成**画布形态**（2026-10-25 契约 AY，计划 §三 Step 3）。
       *
       * ## 顺序即「进这个板块先看到什么」
       *
       * `canvas` 写在**第一位** —— 验收要求「打开画布后它出现在第一位」。
       * 骨架的 `visibleTabs` **只过滤不重排**，所以顺序只能在这里定。
       *
       * ## `dynamic: true` 只标在画布那格
       *
       * 它的意思不是「这块特殊」，而是「**它出不出现由板块上报决定**」：
       * 没打开任何画布时 tab 条上不该有它。其余六格永远显示，不受上报影响。
       *
       * ## `keepMounted: true` 也只在画布那格
       *
       * 画布的节点与撤销栈在组件内，卸载即丢。这条声明与执行画布用的是**同一个机制**
       * （`keptTabsOf` 现在认多格，2026-10-25 契约 AU 铺好的地基）。
       */
      tabs: [
        { id: 'canvas', label: '画布', dynamic: true, keepMounted: true },
        { id: 'lib', label: '画布库' },
        { id: 'gen', label: '生图工作台' },
        { id: 'video', label: '视频创作台' },
        /* ★ 音频工作台那一格**已删**（票 34，2026-10-28）。
         *
         * 依据：参考项目 `refs-projects/infinite-canvas/web/src/pages/` 下只有
         * `image/` 与 `video/`，**没有 audio 页**。参考里音频是**节点类型**
         * （可以拖进画布），不是独立工作台。用户原话：「音频工作台参考好像没有，可以去掉。」
         *
         * ⚠️ 删的只是**入口**，三样东西都还在：
         *   · 音频节点（`NODE_SIZE.audio` 还在这张表里，能拖进画布）
         *   · 后端生成音频的能力
         *   · `ImageWorkbench.tsx` 的 `kind === 'audio'` 那条实现分支
         *   留着它们是**有意的**：删入口与删能力是两件事，后者没有任何依据。
         *
         * ⚠️ 别只删 `ContentBoard.tsx` 的 `ALWAYS` 数组就以为删干净了 ——
         * tab 条读的是**这一张声明**（`EcomWorkbench.tsx:222` 的 `visibleTabs`
         * 只过滤 `dynamic: true` 的格子，本格不是 dynamic，在 `ALWAYS` 里删它没效果）。
         * 那样会得到「tab 还在、点进去空白」，比不改更糟。 */
        { id: 'library', label: '内容库' },
        { id: 'prompts', label: '提示词库' },
        /* ⚠️ 票 66：label 从「配置」改成「板块设置」。
         *
         * 理由是**重名**：侧栏最下面新加了一个板块叫「配置」（工作台级设置），
         * 而这一格是**内容板块自己的**设置（提示词源 / 存储 / 偏好）。
         * 两个都叫「配置」，用户分不出哪个管什么。
         *
         * ⚠️ **`id` 保持 `config` 不变** —— 改它要动 `localStorage` 里已存的
         * `ewb.configTab` 与 `ContentBoard.tsx` 的 `ALWAYS` 数组，得不偿失。 */
        { id: 'config', label: '板块设置' },
      ],
      component: ContentBoard,
    }),
    /* 工作流与收藏：真实实现，且各自声明自己的 tab。 */
    registerBoard({
      id: 'workflow',
      title: '工作流',
      group: '编排',
      icon: WorkflowIcon,
      order: 70,
      tabs: WORKFLOW_TABS,
      component: WorkflowBoard,
    }),
    registerBoard({
      /* 收藏（用户 2026-10-11 要求）：**记录、备忘**暂时用不上的好东西，不是管理它们。
       * 分组与「工作流」同组（用户定）—— 收藏的东西最终是要拿去编排的。 */
      id: 'collect',
      title: '收藏',
      group: '编排',
      icon: StarIcon,
      order: 80,
      tabs: COLLECT_TABS,
      component: CollectBoard,
    }),
    registerBoard({
      /* 提示词（用户 2026-10-22 要求）：**第九个板块**，排在「收藏」之后。
       *
       * 为什么放在「编排」组：模板库与工作流是一件事的两半 —— 模板给的是
       * 「一段写好的要求」，工作流给的是「谁来执行它」。优化动作（调模型）
       * 将来也是走工作流，所以它们该在同一组里挨着。
       *
       * 为什么 order 是 90 而不是插在中间：数字只增不改，插在中间要给后面
       * 全部板块重排号，会让第三方插件的 order 撞车（它们习惯给 100 前后）。
       * 90 留出了「以后想往编排组里再塞一块」的空位。 */
      id: 'prompt',
      title: '提示词',
      group: '编排',
      icon: MessageSquareIcon,
      order: 90,
      component: PromptBoard,
    }),
    /* ── 配置（票 66，用户 2026-10-29）────────────────────────────────
     *
     * 用户原话：「把左侧栏底部齿轮『工作台设置』改成一个板块，板块名『配置』，
     * 排序在最后一个，内容不变、只按内容分 tab。」
     *
     * ## 为什么 id 是 `settings` 而不是 `config`
     *
     * 内容板块里已经有一格叫 `config`（内容是内容板块自己的设置）。
     * 板块 id 与那一格撞名不报错，但读代码的人会以为它们是一回事。
     *
     * ## 为什么 `group: '系统'` 是新分组
     *
     * 它是**工作台级**的设置（模型 / 渠道 / 提醒 / 浏览器，跨所有工作流共用），
     * 与「编排」那三块（工作流 / 收藏 / 提示词，都是干活的地方）不是一类。
     * 单独一组让侧栏上有一个可见的分隔。
     *
     * ## 为什么 `order: 100`
     *
     * 用户要「排序在最后一个」。原来最大是 90（提示词），100 在它之后、
     * 又给第三方插件常见的 `100 前后` 留了余地（与 `:259` 那段「数字只增不改」
     * 的说明同一条理由）。
     *
     * ## ⚠️ 不加 `keepMounted`
     *
     * 设置里没有任何「卸载即丢」的状态（不像画布有视口位置）。
     * 常驻只是白占内存，而且会让两格的 `useEffect` 在没打开时就跑。 */
    registerBoard({
      id: 'settings',
      title: '配置',
      group: '系统',
      icon: SettingsIcon,
      order: 100,
      tabs: [
        /* ★ 票 75（2026-10-29）：两格 → **三格** `模型 / ComfyUI / 其它`。
         *
         * 用户原话：「comfyui 给他单独做个设置来兼容他吧。不要把他放在模型里面，
         * 独立一个 tab 吧。他是通过工作流来确定类型，所以不需要设置类型，
         * 能兼容的地方直接可以调取就行了。」
         *
         * ## 为什么 ComfyUI 要独立出去（不是排版偏好）
         *
         * | | OpenAI / Gemini | ComfyUI |
         * |---|---|---|
         * | 怎么知道这次要干什么 | **模型自带类型**（`caps`） | **按工作流决定**（12 类） |
         * | 靠什么选 | 模型 id | `comfyuiT2iWorkflow` 等 12 个工作流字段 |
         * | 要不要给每个模型配四个勾选框 | 要 | **不要** |
         *
         * 真实数据里 ComfyUI 那条渠道的 `models` 就是空数组 ——
         * 给它配类型勾选框本来没有意义。
         *
         * ## 顺序按用户原话
         *
         * 「模型」→「ComfyUI」→「其它」：ComfyUI 紧挨着模型，因为它是
         * 「另一种配模型的路」；其它是设置类，最后。
         *
         * ⚠️ **只渲染当前那一格**（`ConfigBoard.tsx` 里条件渲染）——
         * 每块都有自己的 `useEffect` 去拉数据，几格一起渲染就是进一次发多路请求。
         * 这条规矩在 `ConfigTabs.tsx` 的文件头也写着，是同一件事。 */
        { id: 'model', label: '模型' },
        { id: 'comfyui', label: 'ComfyUI' },
        { id: 'other', label: '其它' },
      ],
      component: ConfigBoard,
    }),
  ]
  return () => { for (const d of disposers) d() }
}

/**
 * 收藏板块的内容组件：把 `CollectPanel` 的 `tab` 参数接到注册项的当前 tab 上。
 *
 * 为什么需要这层薄壳：`CollectPanel` 是**按 tab 取数据**的老组件
 * （它自己的 `tab` 入参是 `'skill' | 'github' | 'settings'`），
 * 而注册项的 tab 是「当前板块选了哪一格」—— 由骨架传下来。
 *
 * @param props - 注册项给的内容入参。
 * @returns 收藏面板。
 */
function CollectBoard({ tab }: { tab: string }): React.JSX.Element {
  const which = tab === 'github' || tab === 'settings' ? tab : 'skill'
  return CollectPanel({ tab: which })
}


/* ── 加载即注册 ─────────────────────────────────────────────────────────
 *
 * 骨架（EcomWorkbench.tsx）只 `import './boards.ts'` 拿副作用，不读这里的导出 ——
 * 那正是「骨架不知道有哪些板块」的意思。
 *
 * 为什么不用 `ctx.effect`：注册表是**模块级的**，与 React 树的挂载/卸载无关；
 * 骨架这一层也拿不到 cordis 上下文（它只经 slots 注册，数据只从 props 走）。
 * 热更新时模块会重新求值，同一 id 重复注册 = 替换（注册表里就是这么定的），
 * 所以不会叠出两块。真要摘掉时用下面导出的 disposer。 */

/** 默认板块的反注册函数（插件卸载/重置时调用；热更新时不必，重复注册即替换）。 */
export const disposeDefaultBoards = registerDefaultBoards()
