/** 配置板块（票 66，用户 2026-10-29）—— 原来那个从右侧滑出的「工作台设置」抽屉。
 *
 * ## 用户原话
 *
 * > 把左侧栏底部齿轮「工作台设置」改成一个板块，板块名「配置」，排序在最后一个，
 * > 内容不变、只按内容分 tab。
 *
 * ## 这一票只做**骨架与搬家**
 *
 * 每一块设置内部长什么样**一个字没改**（票 68 / 69 才动）：
 * 模型那一格仍是「模型 → 渠道 → 四类默认」三段竖排，其它那一格仍是
 * 「提醒 → 浏览器」两段竖排 —— 与抽屉里原来的顺序**逐字一致**。
 * 变的只有「它们现在住在一个板块的两格 tab 里，而不是一个抽屉的一列里」。
 *
 * ## ⚠️ 一条硬规矩：**不渲染的 tab 不挂组件**
 *
 * 每块都有自己的 `useEffect` 去拉数据（`active` 为真时发请求）。
 * 两格一起渲染 = 一进配置页就发两路请求，其中一路用户根本没打开。
 *
 * 做法：**内容自己按当前 tab 条件渲染**，不用 antd `Tabs` 的 `children`，
 * 也不靠 `destroyOnHidden` —— 那要看 rc-tabs 的内部行为，
 * 而「没渲染就是没渲染」这件事我们自己能保证、也能被断言钉住
 * （判据 6：切走那一格在 DOM 里**不存在**，不是被隐藏）。
 *
 * 同一条规矩在 `ConfigTabs.tsx` 的文件头也写着 —— 那是同一个坑的另一次踩点。
 *
 * ## 为什么不给 `keepMounted`
 *
 * 设置里没有任何「卸载即丢」的状态（不像画布有视口位置）。
 * 常驻只是白占内存，还会让两格的 `useEffect` 在没打开时就跑。
 */
import { useCallback } from 'react'
import { BrowserSettings } from './BrowserSettings.tsx'
import { ChannelSettings } from './ChannelSettings.tsx'
import { DefaultsSettings } from './DefaultsSettings.tsx'
import { ModelListSection } from './ModelListSection.tsx'
import { type BrowserPrefs } from './browser-settings.ts'
import {
  LayoutSettings, ModelSettings, NotifySettings, updateBrowserPrefs, useBrowserPrefs,
} from './WorkspaceSettings.tsx'
import css from './WorkbenchSettings.module.css'

/** 三格的键。顺序照用户 2026-10-29 的原话：模型 → ComfyUI → 其它。 */
export const CONFIG_BOARD_TABS = ['model', 'comfyui', 'other'] as const

/** 一格。
 *
 * `model` —— 四类默认模型 + 模型清单（**只列 OpenAI / Gemini 那类渠道**）；
 * `comfyui` —— ComfyUI 渠道那套（地址 / 密钥 / 并发 / 12 类工作流绑定 / 代理）；
 * `other` —— 浏览器、提醒、布局。
 *
 * ## 为什么 ComfyUI 单独一格（票 75，2026-10-29）
 *
 * 用户原话：「comfyui 给他单独做个设置来兼容他吧。不要把他放在模型里面，
 * 独立一个 tab 吧。他是通过工作流来确定类型，所以不需要设置类型。」
 *
 * 两条路本质不同：模型类渠道靠**模型自带的类型**决定这次能干什么，
 * ComfyUI 靠**绑哪份工作流**决定。给 ComfyUI 的每条模型配四个类型勾选框
 * 本来就不对题（真实数据里它的 `models` 是空数组）。
 */
export type ConfigBoardTab = typeof CONFIG_BOARD_TABS[number]

/**
 * 容错读一格（坏值回 `model`）。
 *
 * ⚠️ 三格都要认：只认 `other` 的话，骨架把 `comfyui` 传进来会被打回 `model`，
 * 用户点 ComfyUI 格看到的却是模型格 —— 那是静默错位，比白屏更难发现。
 *
 * @param raw - 原始值（来自骨架的 `tab`）。
 * @returns 合法的一格。
 */
export function normalizeConfigTab(raw: string): ConfigBoardTab {
  return raw === 'comfyui' || raw === 'other' ? raw : 'model'
}

/** 入参（骨架给的）。 */
export interface ConfigBoardProps {
  /** 这一块是不是正显示着。 */
  active: boolean
  /** 当前是哪一格（空串 = 还没选过）。 */
  tab: string
}

/**
 * 配置板块。
 *
 * @param props - 见 `ConfigBoardProps`。
 * @returns 界面。
 */
export function ConfigBoard({ active, tab }: ConfigBoardProps): React.JSX.Element {
  const which = normalizeConfigTab(tab)
  /* ⚠️ **只渲染当前那一格**（见文件头那条硬规矩）。
   * 下面两个分支互斥，同一时刻只有一个在 DOM 里。 */
  const prefsNow = useBrowserPrefs()
  const onPrefs = useCallback((p: BrowserPrefs): void => { updateBrowserPrefs(p) }, [])

  return (
    <div data-ewb-config-board="" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {which === 'comfyui'
        ? (
          /* ── ComfyUI 格（票 75，2026-10-29）──────────────────────────
           *
           * 用户原话：「comfyui 给他单独做个设置来兼容他吧。不要把他放在模型里面，
           * 独立一个 tab 吧。他是通过工作流来确定类型，所以不需要设置类型，
           * 能兼容的地方直接可以调取就行了。」
           *
           * ## 复用的是 `ChannelSettings`，加了 `onlyProtocol` 入参
           *
           * 那三样（12 类 ComfyUI 工作流绑定、多行文本批量写模型、拉取模型弹窗）
           * **只有这个组件有** —— 票 68 之后它客户端零引用，但一直没删，就是为了
           * 「将来必有一处要用它」。现在这一格就是那一处。
           *
           * ⚠️ **不传 `onlyProtocol` 的调用方行为一个字没变**：
           * `tests/workbenches.mjs` 与 `tests/channels-workflow.mjs` 直接挂它，
           * 它们不传这个入参，所以零影响。
           *
           * ## 这一格里**没有**四个类型勾选框
           *
           * 那不是遗漏 —— ComfyUI 的类型由 12 份工作流绑定决定
           * （`comfyuiT2iWorkflow` 这类字段），给模型配 `text/image/video/audio`
           * 对它没有意义。判据 12 专门钉这一条。 */
          <ChannelSettings active={active} onlyProtocol="comfyui" />
        )
        : which === 'model'
        ? (
          <>
            {/* ── 模型格：一份清单（票 68，2026-10-29）──────────────────
             *
             * ## 改前的形态（票 66 那版，用户否掉了）
             *
             * 竖排三块：`ModelSettings`（dsh 模型目录）/ `ChannelSettings`
             * （标题「内容渠道与并发」）/ `DefaultsSettings`（「内容默认模型 · 四类」）。
             * 用户看到那个标题就问「怎么还有内容渠道，应该不分内容渠道了」——
             * 问题不在功能，在**分法**：他把这三块当成一件事（模型），我们摆成三件。
             *
             * ## 现在的形态（票面「版面」那一节，从上到下）
             *
             * ① **默认模型**五类（`DefaultsSettings`，顺序固定：文本 / 文生图 /
             *    图生图 / 文生视频 / 音频，判定顺序是契约）；
             * ② **模型清单**（`ModelListSection`）：一条模型一行，右侧类型小签；
             * ③ **新建模型**（在清单那一块的头部，点开是表单）；
             * ④ **dsh 模型目录**（`ModelSettings`，`<details>` 默认收起）。
             *
             * ## ⚠️ 「渠道」这个词在界面上取消了，但数据结构没动
             *
             * `channels.json` 仍是「渠道 → 多个模型」—— 密钥、并发、ComfyUI 工作流
             * 三样都是**渠道级**的（`channels.ts:139` 的 `CHANNEL_WORKFLOW_KEYS`）。
             * 界面上只有两处允许出现「渠道」二字：行展开区的「所属渠道」、
             * 新建表单的「建在哪条渠道下」。别的地方不许写。
             *
             * ## 为什么不再挂 `ChannelSettings`
             *
             * 它的渠道列表被模型清单取代了（一块渠道 = 它的模型摊平成了多行）。
             * 但**文件本身保留**：`tests/workbenches.mjs` / `tests/channels-workflow.mjs`
             * 直接挂它按 `data-ewb-channel-row` 找，那些不在本票可改路径里。
             * 新建表单也没有直接复用它 —— 它的形态是「编辑某条渠道」，
             * 而这里要的是「往某条渠道里加一条模型」，两者字段集不同。 */}
            {/* ⚠️ `DefaultsSettings` 外面这层壳**保留**（票 68）。
             *
             * 它自己只渲染一个 `data-ewb-defaults` 的根，没有「节」钩子；
             * 而 `tests/config-defaults.mjs:422` 与 `tests/dom-render.mjs` 都是按
             * `data-ewb-content-defaults-section` 找这一节的。钩子留着、判据就不用改，
             * 而且它说的仍然是实话：「五类默认模型这一节」在这里。
             *
             * 与它相反的是 `data-ewb-channels-section` —— 那一节**真没了**
             * （渠道列表被模型清单取代），所以那个钩子删掉是**事实变了**，
             * 相关断言要换成 `data-ewb-model-list`，不是「判据放宽」。 */}
            <div className={css.section} data-ewb-content-defaults-section="">
              <DefaultsSettings active={active} />
            </div>
            <ModelListSection active={active} />
            <ModelSettings />
          </>
        )
        : (
          <>
            {/* ── 其它格三块：浏览器 → 提醒 → 布局（票 69 改成这个顺序）──
             *
             * ## 顺序按用户原话，不按代码里原来那个
             *
             * 用户 2026-10-29：「内容区限宽，这个做到设置里面去吧，
             * **浏览器、提醒、内容区限宽**都做为一个 tab 的内容先。」
             *
             * 票 66 搬抽屉时是「提醒 → 浏览器」（与抽屉里原来的先后一致）。
             * 票面验收第 1 条要的是用户这次点名的那个顺序，所以**调换**了 ——
             * 这不是判据放宽，是产品顺序按用户最新一句话改了。
             *
             * ⚠️ `NotifySettings` / `LayoutSettings` **自带节钩子**，不包外壳
             * （它们自己渲染 `<div className={ws.section} data-ewb-*-section>`）；
             * `BrowserSettings` 没有，所以它那个外壳由这里补。 */}
            <div className={css.section} data-ewb-browser-section="">
              {/* ⚠️ `titleClassName` **必须传**（票 66 搬家时差点丢）。
               *
               * 2026-10-23 那次用户原话：「把设置内容的板式统一，每一个内容板块的标题字打一点」。
               * `BrowserSettings` 自己的标题只有 `scGroupTitle` 那一档（小一号），
               * 靠外层传 `sectionTitle` 才与「提醒」「布局」两节对齐。
               *
               * 搬进 `ConfigBoard` 时如果照抄成 `<BrowserSettings prefs onPrefs />`，
               * 标题会静默小一号 —— 而 `dom-render` 原来那条判据查的正是
               * 「`WorkspaceSettings` 有没有把 `sectionTitle` 传进去」，
               * 它会变成红。**红了是对的**：那是真的丢了，不是判据过时。 */}
              <BrowserSettings prefs={prefsNow} onPrefs={onPrefs} titleClassName={css.sectionTitle} />
            </div>
            <NotifySettings />
            <LayoutSettings />
          </>
        )}
      {/* 这句话原来是抽屉顶上那句，随内容一起搬过来（它说的仍然是这一层的范围）。
       *
       * 「跨全部工作流共用」是用户 2026-10-23 明确要看到的信息 ——
       * 不然他会以为这里改了只影响当前那一份工作流。 */}
      <div className={css.note}>
        这里的设置跨全部工作流共用。单个节点用哪个浏览器标签，在节点设置里改。
      </div>
    </div>
  )
}
