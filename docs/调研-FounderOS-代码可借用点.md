# 调研 · FounderOS 的可借用点（2026-10-08）

> 状态：已完成 · 日期：2026-10-08 · 类型：单项调研（界面与外壳）
> 对象：`refs-projects/FounderOS-DEMO/`（Next.js 14 App Router + React 18.3 + TS + Tailwind 3.4，见 `package.json:19-49`）
> 方法：逐文件实读源码，所有行号为本机实测。标注「已验证」＝读过源码；「推断」＝未读到直接证据。

## 一、一句话结论

**最有用**：它的**外壳三件套**——「面板宽度写进 CSS 变量 → 内容列用 margin 让位」（`Sidebar.tsx:99-104` + `app/layout.tsx:49`）、**固定宽度滑动指示器 tab**（`SlidingTabs.tsx:18-32`）、**一套 token 化的主题切换**（`globals.css` 主题块 + `tailwind.config.ts` 的 `os.*`）。这三样是纯 CSS + 几十行 React，与 Next.js 零耦合，可整体照搬。

**最没用**：它的业务层。`lib/`（222 个文件）、`app/api/**/route.ts`（95 条路由）、`lib/connectors/*`（39 个外部集成）全部是「一人公司」业务，与电商工作台无关；且服务端组件 + SQLite 的架构我们不用。

**一句话**：**只抄 `components/` 里的外壳组件与 `globals.css` 的 token 层，`lib/` 与 `app/api/` 一律不看。**

---

## 二、可借用清单（核心产出）

| 我们要做什么 | 看它的哪个文件（相对 `refs-projects/FounderOS-DEMO/`，带行号） | 借什么 | 工作量估计 |
|---|---|---|---|
| 左侧面板骨架（分组导航 + 折叠 + 拖宽 + hover 提示） | `components/Sidebar.tsx:64-246`（常量 64-67，拖拽 110-139，发布宽度 99-104） | **抄逻辑** | 0.5 天（去掉 Next 依赖） |
| 导航项怎么组织 | `lib/nav.ts:33-89`（分组数组 + `NAV_ORDER` + 数字快捷键） | **抄结构**（数据与渲染分离，值得学） | 0.5 小时 |
| 面板展开时内容列滑走 | `app/layout.tsx:47-49` + `components/Sidebar.tsx:99-104` + `app/globals.css:1171-1178` | **抄逻辑** | 0.5 小时 |
| 顶部 tab 滑动指示器 | `components/SlidingTabs.tsx:1-61`（核心 18-32） | **抄逻辑**（整文件可移植） | 1 小时 |
| 主题 token 体系（配色/圆角/动效曲线） | `tailwind.config.ts:14-63` + `app/globals.css:11-49, 241-285` | **抄结构 + 抄数值** | 0.5 天 |
| 主题切换（无闪白） | `lib/theme.ts:9-47` + `components/ThemeToggle.tsx:14-98` | **抄逻辑** | 2 小时 |
| hover/active 统一交互层 | `app/globals.css:412-483`（`.pressable` 一族） | **抄逻辑**（改掉磁吸，见第三节） | 2 小时 |
| 状态点 / 徽章 / 分区标题 / Kbd | `components/terminal.tsx:29-120` + `app/globals.css:757-791, 793-814` | **抄结构 + 抄数值** | 2 小时 |
| 命令面板（⌘K） | `components/CommandPalette.tsx:25-239` + `lib/palette.ts`（131 行） | **抄结构**（键盘逻辑可抄） | 0.5 天 |
| 顶栏（面包屑 + 右侧按钮组） | `components/Topbar.tsx:26-63` | **抄结构** | 1 小时 |
| 卡片入场动效（错峰上浮/画线/填充） | `components/motion.tsx:13-34` + `app/globals.css:584-644` | **抄逻辑** | 1 小时 |
| 图标方案 | `package.json:27`（`lucide-react ^0.441`），用法见 `Sidebar.tsx:55` | **直接用**（我们已可同款） | 0 |
| 业务层（工作流/CRM/财务/集成） | `lib/*`、`app/api/*`、`lib/connectors/*` | **不借，别看** | — |

---

## 三、关键实现解读

### 1. 布局让位机制：宽度只存一份，内容列靠 margin 跟（已验证）

**它怎么做的**：`Sidebar` 自己算宽度，用 `document.documentElement.style.setProperty('--sidebar-w', w)` 把值写到根元素（`Sidebar.tsx:99-104`）；`layout.tsx:49` 的内容列**只读这个变量**：`style={{ marginLeft: 'var(--sidebar-w, 232px)' }}`。右侧的「指挥台」面板同理发布 `--conductor-w`（`ConductorPanel.tsx:112-117`），内容列同时读两个变量。`os-shell` 类负责 420ms 的缓动过渡，拖拽中加 `conductor-dragging` 类把过渡关掉，避免手柄滞后（`globals.css:1171-1178`）。

**我们能不能用**：**能，几乎原样。** 我们也是客户端 React，`document.documentElement` 写法完全成立。这条是本次最值得直接拿的东西。

**要注意**：① 默认值必须在 `var(--sidebar-w, 232px)` 里给一份，否则首帧塌陷；② 折叠/拖宽必须**同时**更新变量，别在组件里另存一份宽度（它的测试 `tests/sidebar-collapse.test.ts:16-21` 专门钉死「不许硬编码 ml-[232px]」）；③ 它只在 `useEffect` 里写变量，首帧会闪一下——我们若在意，可以在 `<html>` 上先塞一个初始值。

### 2. SlidingTabs：固定宽度 + 一个平移的指示条（已验证）

**它怎么做的**：不用测量 DOM，而是**约定每个 tab 等宽**（`tabWidth`，默认 120px），容器用 `grid-template-columns: repeat(n, 120px)`；指示器是一个绝对定位的 `<span>`，宽度=tabWidth，位置=`transform: translateX(i * tabWidth)`（`SlidingTabs.tsx:21-32`）。切换时只改 `i`，靠 CSS transition 滑过去。同一组件支持两种外观：`underline`（页签下划线）与 `pill`（分段控件）。

**我们能不能用**：**能，整文件可移植。** 61 行、零依赖（只用到 `React.ReactNode`），改成我们的 token 名即可。

**要注意**：**代价是标签必须等宽**——中文标签长短不一，会出现长标签被挤或短标签留白。要么给足 tabWidth，要么改成「测量每个按钮实际位置再平移」（那时就不叫固定宽度方案了）。它自己在 `SlidingTabs.tsx:3-4` 的注释里写明这是刻意的取舍。

### 3. 主题 token：Tailwind 只做「转发」，真值放 CSS 变量（已验证）

**它怎么做的**：三层——① `globals.css` 里每个主题一个 `:root[data-theme='x']` 块，只定义 `--bg`、`--surface`、`--text-2`、`--accent` 这类**语义变量**（`globals.css:241-285` 是默认的 mono 主题）；② `tailwind.config.ts:17-40` 把 `os.bg / os.text / os.muted` 等类名**映射到那些变量**，本身不含颜色值；③ 切换时只改 `<html data-theme>`，全站重着色，**零组件改动**。另外用一个内联脚本在首帧前应用（`lib/theme.ts:42-47`），避免闪白。

**我们能不能用**：**能，这是我最推荐整体照搬的一层。** 它的 `--accent-soft / --accent-line`（accent 的半透明变体）和 `--ok/--warn/--err` 三态色是很实用的最小集。

**要注意**：① 它维护了 **6 套主题**，我们只要 1 套（深色）即可，别照抄全部；② 它把同一份值在 `tailwind.config.ts` 与 `globals.css` 里**写了两遍**（因为 SVG 的 `fill` 和 `color-mix` 要读原始 `var()`），这是个真实的维护负担——我们只留 CSS 变量那一份就够。

### 4. 统一 hover/active 交互层（已验证，但建议**简化后**再抄）

**它怎么做的**：`.pressable` 一个类管住六条属性的过渡（`globals.css:413-423`），配 `data-lens="c|r"` 区分「控件 4px 磁吸」与「行/卡片 2px」（`lib/hooks/useLens.ts:44-50`），`:active` 做下沉（`globals.css:465-470`），再加 `.lens-child / .linky / .state-fade` 三个兄弟类覆盖非按钮场景。

**我们能不能用**：**逻辑能抄，磁吸建议砍掉。** 一个 `.pressable` + `:active` 下沉 + `focus-visible` 环，我们 20 行就能拿到 80% 的效果。

**要注意**：它为此挂了一个**全局 `pointermove` 监听**，每次移动都算 `getBoundingClientRect` 并写 4 个 CSS 变量（`useLens.ts:31-62`），还把 spotlight 一起算了。对一个「个人/小团队内部用」的工具，这是过度设计；且它自己在注释里说 spotlight 在公开演示里是**关掉的**。

---

## 四、不借的部分（明确别看，省时间）

| 不看什么 | 为什么 |
|---|---|
| `lib/`（222 文件：`brain-*`、`comms-*`、`funnel-*`、`crypto-*`、`trading-*`…） | 全是「一人公司」业务域，与电商无关 |
| `app/api/**/route.ts`（95 条路由） | Next.js Route Handler，我们是 dsh 插件，不跑 HTTP 服务端 |
| `lib/connectors/**`（39 个） | 外部 SaaS 适配器（Stripe/Slack/IMAP…），我们的「执行方适配器」是 `shell/agent/http/builtin`，抽象层次不同 |
| `app/*/page.tsx`、`app/*/loading.tsx` | 服务端组件 + 路由约定，不可移植 |
| `components/` 下 126 个 .tsx 里约 120 个业务组件（`BrainViz`、`FunnelSpace`、`TradingBoard`…） | 强绑定它自己的数据模型；视觉可当参考，代码不可用 |
| `tests/**`（313 个 .test.ts） | 断言的是它的实现细节（如 `sidebar-collapse.test.ts` 直接读源码字符串），对我们的代码无意义 |
| `middleware.ts`、`instrumentation.ts`、`lib/db.ts`、`scripts/seed.ts` | 服务端/SQLite 设施 |

**Next.js 特有、**不能抄**的写法**（结构思路可参考，代码必须重写）：
- `import Link from 'next/link'`（`Sidebar.tsx:4`）、`usePathname` / `useRouter`（`Sidebar.tsx:7`、`CommandPalette.tsx:4`）→ 换成我们自己的路由状态；
- `next/font/google` 的字体加载（`app/layout.tsx:16-20`）→ 换成 CSS `@font-face` 或系统字体栈；
- **服务端组件直读数据库**（`app/layout.tsx:30-34` 的 `paletteAgents()` 直接调 `getDb()`）→ 我们必须改成前端 fetch 或 props；
- `next/dynamic` 懒加载、`<head>` 内联脚本的 `dangerouslySetInnerHTML`（`app/layout.tsx:39-42`）→ 客户端 React 里改成 `useEffect` 或独立入口脚本。

**通用、**能抄**的**：`SlidingTabs.tsx` 全篇、`terminal.tsx` 全篇（注释明写「无状态无 handler」）、`motion.tsx` 全篇、`globals.css` 的 token 块与 `.pressable`/`.dot`/`.rise` 工具类、`nav.ts` 的分组数据结构、`Sidebar.tsx` 的拖拽与折叠逻辑。

---

## 五、未获取 / 未验证

1. **没跑起来看**——本文全部结论来自源码阅读，未启动它的 dev server（README 说跑在 4100 端口）。**视觉效果是推断**，未做浏览器实测。
2. **未验证**：`Sidebar` 折叠时 hover 提示的定位在滚动容器内是否真的准确——它注释说用 `fixed` 是为了绕开裁剪（`Sidebar.tsx:74-76`），但我没实测边界情况。
3. **未验证**：`SlidingTabs` 在标签数量多、超出容器宽度时是否溢出——源码里没有 `overflow` 处理。
4. **未读**：`components/slab.tsx`（213 行，图表组件）、`lib/palette.ts` 全文（只看了被调用的函数签名）、`CommandPalette` 的完整键盘可达性细节。
5. **许可（已验证）**：根 `LICENSE` 为 **MIT License, Copyright (c) 2026 FounderOS**——可自由复制修改，保留版权声明即可。
6. **未验证**：它的 Tailwind 主题块与 `tailwind.config.ts` 是手工同步的（CLAUDE.md 明说要「keep the two in sync」），我没有逐值比对，**推断**存在少量漂移。
