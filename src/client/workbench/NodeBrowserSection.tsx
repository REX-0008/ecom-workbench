/** 节点设置里的**浏览器**一节（第二层：这个标签用哪个浏览器、怎么连）。
 *
 * ## 用户 2026-10-13 的要求（原话）
 *
 * > 「标签→浏览器应该是在**节点设置**而不是设置中设置。」
 *
 * 以及之前定下的两层结构：
 *
 * > 「**第一层**，用来关联多个节点的自定义名称的浏览器设置，
 * > **第二层**，用来决定通过什么方式打开页面用什么浏览器的。
 * > **第一层决定第二层**……其他的节点第二层自动统一。」
 *
 * ## ★ 2026-10-14 改造：第二层从「选打开方式」改成「选浏览器」（用户 #7）
 *
 * 用户原话：
 *
 * > 「我希望 **9222 这个不是默认而是前端可见的手填项目**，**不能是硬编码的**。
 * > 当前检测到的浏览器是**可以打开的浏览器软件**，而 **CDP 是确认有个端口，他是个浏览器可以用**。
 * > **结果其实一样**……所以，我觉得**他们可以列在一起**，
 * > 而不是将 CDP 列到打开方式上面。」
 * > 「最终结果：**选择浏览器既可以选择一个可以被打开的浏览器，也可以使用 CDP
 * > 连接一个已打开的浏览器，他们都是选择浏览器，而不是选择打开方式**
 * > （当前 CDP 被当做打开方式，和有头无头列在了一起）。」
 *
 * 所以这一节现在的结构是：
 *
 * ```
 * 标签       [下拉 + 可自己写]             ← 第一层（关联多个节点）
 * 来源       [已开的调试端口（CDP） | 本机装着的浏览器]   ← 两个来源**并列**
 *   ├ 来源=CDP → 端口 [下拉，只能选] [检测]   ← ★ 2026-10-15 起**不许手填**
 *   └ 来源=本机 → 浏览器 [下拉] + 方式 [有窗口/无窗口]
 * ```
 *
 * ## ★ 2026-10-15 改造（用户 m03425）：端口从「手填」改成「只能选」
 *
 * 用户原话：「CDP 模式下的端口**不应该可以手填，应该只能选择**。检测按钮保留，
 * 但是**只检测选择的端口是否联通**，不做其他更多检测。**不需要检测到几个调试端口
 * 并选择**，因为端口选择就是最上面的端口选择。**是否有端口存在交给设置**不在这里检测。」
 *
 * 于是：
 *   - 端口是 `<select>`，可选值 = **设置里那份检测结果的端点** + **全局默认端口**
 *     （外加当前值本身，否则老存档里手填过的端口会显示不出来）；
 *   - 原来那排「检测到 N 个调试端口，点一下就填上」的按钮**整段删掉**
 *     （端口选择已经由这个下拉承担，再列一遍是同一个决定问两次）；
 *   - 「检测」按钮保留，只做一件事：`checkCdpPort` 查这个端口通不通。
 *
 * ⚠️ 这一节**不再解释 CDP 是什么** —— 那是设置的事（用户：「CDP 的说明也是设置中解决
 * 不要在节点中过多说明」）。这里的提示只留「改了会影响谁」。
 *
 * ⚠️ 这一节改的**是「标签」的设置，不是这个节点自己的** ——
 * 所以改完之后**所有用同名标签的节点一起生效**。
 * 这是用户点名要的「自动统一」，也是「同名标签不可能用不同浏览器」的机制保证
 * （第二层只存在标签上，节点自己存不下第二套值）。
 *
 * ## 全局设置里为什么还留「默认」
 *
 * 「检测到哪些浏览器」「默认用哪个」是**机器级**的（与具体流程无关），
 * 放全局设置；「这个标签用哪个」是**流程级**的，跟着节点走。
 */
import { useState } from 'react'
import css from './node-form.module.css'
import {
  SOURCE_LABEL, OPEN_MODE_LABEL, type BrowserSource, type OpenMode,
} from './browser-detect.ts'
import { launcherOf, checkRunnable, type BrowserPrefs, type TagBrowser } from './browser-settings.ts'
import { checkCdpPort, useDetectedBrowsers, type DetectResult } from './browser-detect-store.ts'

/** 检测到的一个浏览器（与宿主半 `/browser/detect` 的返回一致）。 */
export interface KnownBrowser {
  /** 稳定 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 可执行文件路径；null = 找过但没找到。 */
  path: string | null
}

/**
 * 浏览器一节（节点内）。
 *
 * @param props.tag - 当前标签名（第一层）。
 * @param props.onTag - 改标签名。
 * @param props.prefs - 全局偏好（含各标签的第二层配置）。
 * @param props.onPrefs - 改偏好（**改的是标签的设置**，不是本节点的）。
 * @param props.browsers - 检测到的浏览器清单（可能为空 —— 还没检测过）。
 * @param props.detect - 宿主半的检测结果（`cdp.endpoints` 就是扫到的端口清单）。
 * @param props.otherTags - 画布上其他标签（下拉里给它们，方便复用同一个）。
 * @returns 一节元素。
 */
export function NodeBrowserSection(props: {
  tag: string
  onTag: (t: string) => void
  prefs: BrowserPrefs
  onPrefs: (p: BrowserPrefs) => void
  browsers: readonly KnownBrowser[]
  /**
   * 宿主半的检测结果。
   *
   * ⚠️ 2026-10-15 起它的用途**只剩一个**：`cdp.endpoints` 里那些端口
   * 是端口下拉的候选值（用户：「是否有端口存在**交给设置**」）。
   * 原来那个「列出扫到的端口、点一下填上」的用法已删。
   *
   * ⚠️ **可选**：没传时退回**共享缓存**（`useDetectedBrowsers`）——
   * 那是全局设置那边读的同一份数据，所以「谁忘了传」不会导致这一节空掉。
   */
  detect?: DetectResult | null
  otherTags: readonly string[]
}) {
  const { prefs, tag } = props
  /* 共享缓存里的检测结果 —— 仅当调用方没传时用它兜底（见上面 `detect` 的说明）。 */
  const shared = useDetectedBrowsers()
  /* 该标签自己的配置（没配过就退回全局默认）。
   * ⚠️ 这里**不直接读 `prefs.tags[tag]`** —— 那可能连 `source` 都没有（老存档）。
   * 一律走 `resolveTag`（它做迁移与推导），保证界面与驱动读的是同一份结论。 */
  const own = prefs.tags[tag]
  const cur: TagBrowser = {
    source: own?.source ?? prefs.defaultSource,
    browserId: own?.browserId ?? '',
    port: own?.port ?? '',
    exePath: own?.exePath ?? '',
    openMode: own?.openMode ?? prefs.defaultOpenMode,
    launcher: launcherOf(own?.source ?? prefs.defaultSource, own?.openMode ?? prefs.defaultOpenMode),
  }
  /** 「这个标签实际会用哪个端口」（自己填了用它，否则跟着全局默认）。 */
  const portInUse = cur.port !== '' ? cur.port : prefs.defaultPort
  /** 这一套到底能不能跑（不能跑时给一句能看懂的原因）。 */
  const runnable = checkRunnable({ ...cur, port: portInUse })

  /** 检测按钮的三态结果（本地状态：只针对当前输入的端口）。 */
  const [probe, setProbe] = useState<{ busy: boolean, text: string, good: boolean } | null>(null)

  /** 改这个标签的第二层（写进 prefs.tags —— 所有同名标签一起生效）。 */
  const patch = (p: Partial<TagBrowser>): void => {
    if (tag.trim() === '') return
    const base = own ?? {
      source: prefs.defaultSource, browserId: '', port: '', exePath: '',
      openMode: prefs.defaultOpenMode, launcher: prefs.defaultLauncher,
    }
    props.onPrefs({ ...prefs, tags: { ...prefs.tags, [tag]: { ...base, ...p } } })
  }

  /**
   * 改**来源**（用户要的「选浏览器」那一层）。
   *
   * ⚠️ 换来源时要**顺手把 `launcher` 重新推导** ——
   * 否则会出现「界面显示『已开的调试端口』，驱动却去启动一个浏览器」
   * 这种最难查的错（界面与行为分叉）。`launcherOf` 是唯一的那条推导。
   */
  const patchSource = (source: BrowserSource): void => {
    patch({ source, launcher: launcherOf(source, cur.openMode) })
  }

  /** 改打开方式（有窗口 / 无窗口）—— 同样要重新推导 `launcher`。 */
  const patchOpenMode = (openMode: OpenMode): void => {
    patch({ openMode, launcher: launcherOf('app', openMode) })
  }

  /** 点「检测」：查当前填的这个端口（单端口，1 毫秒级）。 */
  const doCheck = (): void => {
    const p = portInUse
    setProbe({ busy: true, text: '检测中…', good: false })
    void checkCdpPort(p).then(r => {
      if (r.error !== undefined) {
        setProbe({ busy: false, text: '检测失败：' + r.error, good: false })
      } else if (!r.listening) {
        setProbe({
          busy: false, good: false,
          text: ':' + String(r.port) + ' 上没有任何程序在听 —— 那个浏览器没开，或者端口填错了。',
        })
      } else if (r.browser === null) {
        setProbe({
          busy: false, good: false,
          text: ':' + String(r.port) + ' 上有个程序在听，但它不是浏览器的调试端口 —— 换一个端口试试。',
        })
      } else {
        setProbe({ busy: false, good: true, text: ':' + String(r.port) + ' 是浏览器调试端口（' + r.browser + '）✓' })
      }
    })
  }

  const usable = props.browsers.filter(b => b.path !== null)
  const defaultName = props.browsers.find(b => b.id === prefs.defaultBrowserId)?.name
    ?? (prefs.defaultBrowserId === '' ? '（未设置）' : prefs.defaultBrowserId)
  /**
   * 扫到的 CDP 端点（**端口下拉的候选值**）。
   *
   * ⚠️ 2026-10-15：这一段原来是「列出来、点一下填上」的按钮组，现在改成下拉的选项来源
   * （用户：「是否有端口存在交给设置」）。调用方传的优先，没传就用共享缓存。
   */
  const endpoints = (props.detect ?? shared)?.cdp?.endpoints ?? []
  /**
   * 端口下拉的可选值：**设置里检测到的端点** + **全局默认端口** + **这个标签当前的值**。
   *
   * 三条都有理由：
   *   - 检测到的端点 = 用户要求的「只能选」的来源；
   *   - 全局默认端口 = 用户裁定（「设置里那份检测结果里的调试端口 + 全局设置的默认端口」）；
   *   - 当前值 = 兜底。老存档里可能手填过一个当时没扫到的端口，
   *     不放进来的话下拉会「没有这一项」→ 显示成别的端口，看起来像配置被改了。
   */
  const portOptions = (() => {
    const out: string[] = []
    for (const p of [prefs.defaultPort, ...endpoints.map(e => String(e.port)), portInUse]) {
      if (p !== '' && !out.includes(p)) out.push(p)
    }
    return out
  })()

  return (
    <div className={css.param} data-ewb-node-browser=''>
      <div className={css.paramHead}>
        <span className={css.paramLabel}>浏览器</span>
      </div>

      {/* ── 第一层：标签 ─────────────────────────────────────────────
       * 下拉里给出**已经用过的标签**（方便把几个节点绑在一起），
       * 同时允许直接输入新名字（否则新流程没法起头）。
       * 用 `list` + `datalist`：既是下拉、又能自己写。 */}
      <div className={css.ctlRow}>
        <span className={css.unit} style={{ minWidth: '58px' }}>标签</span>
        <input
          className={css.input}
          list='ewb-known-tags'
          value={tag}
          placeholder='如 淘宝 / 抖音（同名 = 同一个浏览器）'
          aria-label='浏览器标签'
          onChange={e => { props.onTag(e.target.value) }}
        />
        <datalist id='ewb-known-tags'>
          {props.otherTags.filter(t => t !== tag).map(t => <option key={t} value={t} />)}
        </datalist>
      </div>

      {/* ── 第二层·第 1 步：**来源**（用户要的「两个来源并列」）──────────
       *
       * ★ 这是本次改造的核心：CDP **不再**与「有头/无头」并列，
       * 而是与「本机装着的浏览器」并列 —— 两者都是「用哪个浏览器」。 */}
      <div className={css.ctlRow}>
        <span className={css.unit} style={{ minWidth: '58px' }}>来源</span>
        <select
          className={css.select}
          value={cur.source}
          aria-label='这个标签用哪种来源的浏览器'
          onChange={e => { patchSource(e.target.value === 'app' ? 'app' : 'cdp') }}
        >
          {(Object.keys(SOURCE_LABEL) as BrowserSource[]).map(k => (
            <option key={k} value={k}>{SOURCE_LABEL[k].name}</option>
          ))}
        </select>
      </div>

      {cur.source === 'cdp'
        ? (
          /* ── 来源 = 已开的调试端口：**端口只能选** + 检测联通 ──────────
           *
           * ★ 2026-10-15（用户 m03425）：原来是手填 `<input>` + 一排
           * 「检测到 N 个端口」的按钮。现在合成一个下拉 —— 手填容易填错，
           * 而可选值本来就该由设置那边检测出来。 */
          <>
            <div className={css.ctlRow}>
              <span className={css.unit} style={{ minWidth: '58px' }}>端口</span>
              <select
                className={css.select}
                value={portInUse}
                aria-label='浏览器调试端口'
                onChange={e => {
                  /* 写的是**这个标签的端口**（不是全局默认）——
                   * 所以选完只影响用这个标签的节点。 */
                  patch({ port: e.target.value })
                  setProbe(null)
                }}
              >
                {/* ⚠️ **必须有这个空选项**（2026-10-16 修的）：
                 * 标签没配过端口、全局默认也是空时 `value` 就是 `''`，
                 * 而下拉里若只有具体端口，浏览器会把**第一个**当成选中的
                 * —— 表现为「我什么都没选，它已经替我选了 9222」，
                 * 正好是用户 m03425 要消掉的那种「悄悄用了个端口」。
                 * （jsdom 里实测就是 `select.value === '9222'`。）
                 *
                 * 留空 = 这个标签不单独指定，按全局默认走 —— 与
                 * `browser-settings.ts` 的 `checkRunnable` 一致（它会明确拦住
                 * 「标签和全局都没给端口」的情况，不静默连一个猜的端口）。 */}
                <option value=''>
                  {portOptions.length === 0 ? '（设置里没检测到端口）' : '（未指定 —— 按全局默认）'}
                </option>
                {portOptions.map(p => {
                  const hit = endpoints.find(e => String(e.port) === p)
                  const label = p === prefs.defaultPort && p !== '' ? p + '（全局默认）' : p
                  return (
                    <option key={p} value={p}>
                      {hit?.browser === null || hit?.browser === undefined ? label : label + '（' + hit.browser + '）'}
                    </option>
                  )
                })}
              </select>
              <button
                type='button'
                className={css.advToggle}
                aria-label='检测这个端口'
                disabled={probe?.busy === true || portInUse.trim() === ''}
                onClick={doCheck}
              >{probe?.busy === true ? '检测中…' : '检测'}</button>
            </div>
            {probe !== null && (
              <div
                className={css.paramHint}
                data-ewb-cdp-probe={probe.good ? 'ok' : 'bad'}
              >{probe.text}</div>
            )}
            {!runnable.ok && <div className={css.paramHint} data-ewb-cdp-missing=''>{runnable.reason}</div>}
          </>
        )
        : (
          /* ── 来源 = 本机装着的浏览器：选哪一个 + **打开方式的属性** ─── */
          <>
            <div className={css.ctlRow}>
              <span className={css.unit} style={{ minWidth: '58px' }}>浏览器</span>
              <select
                className={css.select}
                value={cur.browserId}
                aria-label='这个标签用哪个浏览器'
                onChange={e => { patch({ browserId: e.target.value }) }}
              >
                <option value=''>（跟全局默认：{defaultName}）</option>
                {usable.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className={css.ctlRow}>
              <span className={css.unit} style={{ minWidth: '58px' }}>打开方式</span>
              <select
                className={css.select}
                value={cur.openMode}
                aria-label='打开方式（有窗口/无窗口）'
                onChange={e => { patchOpenMode(e.target.value === 'headless' ? 'headless' : 'headed') }}
              >
                {(Object.keys(OPEN_MODE_LABEL) as OpenMode[]).map(k => (
                  <option key={k} value={k}>{OPEN_MODE_LABEL[k].name}</option>
                ))}
              </select>
            </div>
          </>
        )}

      {/* ⚠️ 必须说清「这改的是标签，不是这一个节点」——
       * 否则用户以为只影响当前节点，回头发现别的节点也跟着变了会莫名其妙。
       *
       * ★ 2026-10-15（用户 m03425）：「浏览器的说明文字**过多**，简短点」，
       * 且「CDP 的说明也是**设置中**解决，不要在节点中过多说明」——
       * 所以 `SOURCE_LABEL` / `OPEN_MODE_LABEL` 那两长串 hint 在本节**不再显示**，
       * 只留下面这一句「改了会影响谁」。来源与打开方式的含义在「工作台设置 → 浏览器」里讲。 */}
      <div className={css.paramHint}>
        {tag.trim() === ''
          ? '先给这个节点起个标签名 —— 同名标签共用同一个浏览器。'
          : '以上改的是标签「' + tag + '」的设置，所有用这个标签的节点会一起生效。'}
      </div>
      {cur.source === 'app' && usable.length === 0 && (
        <div className={css.paramHint}>
          还没检测到可用浏览器 —— 去「工作台设置 → 浏览器」点一下重新检测。
        </div>
      )}
    </div>
  )
}
