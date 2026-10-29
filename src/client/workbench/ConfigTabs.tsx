/** 配置页的三个 tab（票 10 建五 tab，票 38 收到三 tab，2026-10-28）。
 *
 * ## 它解决什么
 *
 * 配置页原来是把四块**竖着排成一页**：渠道列表 + 渠道表单 + 存储目录 + 默认模型 +
 * 提示词源，全挤在同一列里。内容越加越多，一页排下去要滚很久，而且
 * 「改默认模型」和「改渠道」在视觉上是同一层级的事，实际不是。
 *
 * ## ★ 票 38：从五个 tab 收到三个（2026-10-28）
 *
 * 用户原话（票 37 条目一）：「模型方面的配置，工作台级设置其实有这个内容了，
 * 是不是这里的渠道、默认模型应该放到工作台设置中。……其他三项提示词源、存储、
 * 偏好保留在内容板块，这个是板块设置。」
 *
 * | 原 tab | 现在去哪 | 判据 |
 * |---|---|---|
 * | `channels`（渠道） | **配置板块 · 模型格**（`ModelListSection.tsx` 的 `data-ewb-model-list`；票 68 起渠道列表被模型清单取代） | 渠道是跨板块共用的资源，作用范围与工作台级一致 |
 * | `defaults`（默认模型） | **配置板块 · 模型格**（同上，`data-ewb-content-defaults-section`） | 同上；且它读的是渠道里的模型，跟着渠道走才不会两处不一致 |
 * | `prompt-sources`（提示词源） | **留在本页** | 只影响内容板块的提示词库，是板块自己的事 |
 * | `storage`（存储） | **留在本页** | 产物落哪个目录，板块自己的事 |
 * | `preferences`（偏好） | **留在本页** | 板块自己的观感偏好 |
 *
 * 判据一句话：**它影响别的板块吗？** 影响（渠道 / 模型）→ 工作台级；只影响自己 → 板块级。
 *
 * ⚠️ 票 66（2026-10-29）：那两块原来住在「工作台设置**抽屉**」里，
 * 现在抽屉已删、升级成侧栏最后的「配置」**板块**（`boards.ts` 的 `id: 'settings'`），
 * 内容搬进它的「模型」那一格 —— 位置换了，**归属层级没变**（仍是工作台级），
 * 所以上表那两行只是把落点写成新地方。
 *
 * ## `localStorage` 里可能还存着两个已搬走的键
 *
 * `readConfigTab` 对坏值一律回默认（`prompt-sources`），所以老会话里存着
 * `channels` / `defaults` 的人进来会落到第一个 tab，**不抛错、不白屏**。
 * 这一条是有意保留的容错，别改成「迁移到某个 tab」—— 搬走的那两块在这里已经没有内容了。
 *
 * ## 一条硬规矩：**不渲染的 tab 不挂组件**
 *
 * 每块都有自己的 `useEffect` 去拉数据（`active` 为真时发请求）。三个 tab 一起渲染
 * 等于一进配置页就发三路请求，其中两路用户根本没打开。
 *
 * 做法：`Tabs` 只负责导航条，**内容自己按当前 tab 条件渲染**（`items` 不给 children）。
 * 不靠 antd 的 `destroyOnHidden` —— 那要看 rc-tabs 内部行为，而「没渲染就是没渲染」
 * 这件事我们自己能保证，也能被断言钉住。
 *
 * ## tab 状态要跨刷新活下来
 *
 * 存浏览器本地（`localStorage`，键 `ewb.configTab`），与画布偏好同一套做法
 * （`lib/canvas/canvas-prefs.ts`）。理由也一样：这是「这个人习惯从哪个 tab 进」，
 * 不是配置内容本身。
 *
 * ⚠️ 读的时候**必须容错**：`localStorage` 可能被手改、也可能是更早版本存的键。
 * 抛错会让整个配置页打不开 —— 那比「回到默认 tab」严重得多。
 */
import { useCallback, useState } from 'react'
import { Tabs } from 'antd'
import { PromptSourcesSettings } from './PromptSourcesSettings.tsx'
import { StorageSettings } from './StorageSettings.tsx'
import { PreferencesSettings } from './PreferencesSettings.tsx'

/**
 * 三个 tab 的键。
 *
 * 顺序照「先配什么」排：提示词源是内容板块最常用的那一项，排第一；
 * 存储是环境类设置；偏好最后。
 *
 * ⚠️ 顺序变了（原来是渠道打头）—— 渠道搬走之后提示词源就是这里最常来的。
 */
export const CONFIG_TABS = ['prompt-sources', 'storage', 'preferences'] as const

/** 一个 tab 的键。 */
export type ConfigTabKey = typeof CONFIG_TABS[number]

/** tab 的中文名（R6：不用疑问句、不用第二人称）。 */
export const CONFIG_TAB_LABEL: Record<ConfigTabKey, string> = {
  'prompt-sources': '提示词源',
  storage: '存储',
  preferences: '偏好',
}

/** localStorage 的键。 */
export const CONFIG_TAB_KEY = 'ewb.configTab'

/** 默认落在哪个 tab。 */
export const DEFAULT_CONFIG_TAB: ConfigTabKey = 'prompt-sources'

/**
 * 这个键是不是三个之一。
 *
 * @param v - 待查值。
 * @returns 是就 true（窄化成 `ConfigTabKey`）。
 */
export function isConfigTab(v: unknown): v is ConfigTabKey {
  return typeof v === 'string' && (CONFIG_TABS as readonly string[]).includes(v)
}

/**
 * 读上次停在哪个 tab。
 *
 * 读不到、存的是坏值、`localStorage` 本身不可用 —— 三种都回默认，不抛错。
 * ★ 存着**已搬走的键**（`channels` / `defaults`）也回默认，理由见文件头。
 *
 * @param raw - 原始字符串（不传则从 localStorage 读；测试用）。
 * @returns 三个键之一。
 */
export function readConfigTab(raw?: string | null): ConfigTabKey {
  let text = raw
  if (text === undefined) {
    try { text = localStorage.getItem(CONFIG_TAB_KEY) } catch { text = null }
  }
  return isConfigTab(text) ? text : DEFAULT_CONFIG_TAB
}

/**
 * 记住当前 tab。
 *
 * 存不进去就跳过（隐私模式、配额满）—— 那只是「下次回来要重新点一下」，
 * 不该让切 tab 这个动作失败。
 *
 * @param tab - 要记的 tab。
 */
export function saveConfigTab(tab: ConfigTabKey): void {
  try { localStorage.setItem(CONFIG_TAB_KEY, tab) } catch { /* 存不了就算了 */ }
}

/** 配置面板的入参。 */
export interface ConfigTabsProps {
  /** 这一格是不是正显示着（不显示就不发请求）。 */
  active: boolean
  /**
   * 进来时停在哪个 tab。
   *
   * 不给就按上次存的那个（正常使用就是这条路）。
   * 给了就**以它为准**，不写回 —— 测试用它直接落到某一块，
   * 不用为了「进到存储 tab」去模拟点击。
   */
  initialTab?: ConfigTabKey
}

/**
 * 配置面板：三个 tab + 各自的内容。
 * @param props - 见入参。
 * @returns 界面。
 */
export function ConfigTabs({ active, initialTab }: ConfigTabsProps): React.JSX.Element {
  const [tab, setTab] = useState<ConfigTabKey>(() => initialTab ?? readConfigTab())

  const change = useCallback((key: string): void => {
    if (!isConfigTab(key)) return
    setTab(key)
    /* 传了 `initialTab` 的场合不写回：那种调用方要的是一个确定的起点，
     * 让它污染用户的「上次在哪」不合适。 */
    if (initialTab === undefined) saveConfigTab(key)
  }, [initialTab])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-ewb-config-tabs={tab}>
      <Tabs
        activeKey={tab}
        onChange={change}
        /* 只给导航条，不给 children —— 内容在下面按 tab 条件渲染（理由见文件头）。 */
        items={CONFIG_TABS.map(k => ({
          key: k,
          label: <span data-ewb-config-tab={k}>{CONFIG_TAB_LABEL[k]}</span>,
        }))}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-ewb-config-pane={tab}>
        {/* ⚠️ 渠道与四类默认模型**不在这里** —— 它们已上收到工作台级的配置板块
         * （`WorkspaceSettings.tsx`）。把 `<ChannelSettings />` 挂回来等于两处入口。 */}
        {tab === 'prompt-sources' ? <PromptSourcesSettings active={active} /> : null}
        {tab === 'storage' ? <StorageSettings active={active} /> : null}
        {tab === 'preferences' ? <PreferencesSettings active={active} /> : null}
      </div>
    </div>
  )
}
