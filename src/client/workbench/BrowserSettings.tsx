/** 全局设置里的**浏览器**一段（只剩机器级的三样：默认 + 检测 + 重新检测）。
 *
 * ## 用户 2026-10-13 定的分工（原话）
 *
 * > 「标签→浏览器应该是在**节点设置**而不是设置中设置。」
 *
 * 于是两处各管一段：
 *
 * | 在哪 | 管什么 | 为什么 |
 * | --- | --- | --- |
 * | **全局设置**（本文件） | 默认用哪个浏览器、默认端口、检测列表、重新检测 | 这些是**机器级**的，与具体流程无关 |
 * | **节点设置**（`NodeBrowserSection`） | 这个标签用哪个、怎么连 | 这是**流程级**的，跟着节点走 |
 *
 * ⚠️ 「标签 → 浏览器」那张表格**从全局搬走了** —— 用户点名要求的。
 * 留在这儿会变成「同一件事两个地方能改」，比没有更糟。
 *
 * ## ★ 2026-10-14 改造（用户 #7）
 *
 * 用户：「**9222 这个不是默认而是前端可见的手填项目**，**不能是硬编码的**」。
 * 所以这里：
 *   · 「默认来源」+「默认端口」都成了**可见的手填项**（端口初始为空，不是 9222）；
 *   · 检测结果里**列出扫到的 CDP 端点及其浏览器版本**（原来是「端口 :9222 在不在听」）。
 */
import css from './workflow-canvas.module.css'
/* ★ 票 57：分组与行的**整体样式**换成两边画布共用的 `canvasFloat*`
 * （住在 `EcomWorkbench.module.css`）。
 *
 * ## 为什么这一格也要换
 *
 * 票 57 要把 `workflow-canvas.module.css` 里那批抽屉类删掉，而本文件
 * 正在用 `.scGroup` / `.scGroupTitle` / `.setRow` / `.setLabel`
 * （15 处）。不换的话删完这一格当场塌 —— 而它是配置板块「其它」格里
 * 活的界面（`ConfigBoard.tsx:202` 挂的）。
 *
 * ## 换的只是 className，行为一个字没动
 *
 * `titleClassName` 那个入参**原样保留**：`ConfigBoard` 把 `WorkbenchSettings.module.css`
 * 的 `sectionTitle` 传进来，
 * 删了标题会掉一档字号（票 66 那次差点丢过）。
 *
 * ## 为什么控件样式（`.setSelect` / `.setValue` / `.setReset`）不换
 *
 * 用户明确说「整体样式不是控件样式」。下拉框与复位按钮各自的长相留在
 * `workflow-canvas.module.css` —— 那些类本票一个都没删。 */
import float from './EcomWorkbench.module.css'
import { SOURCE_LABEL, OPEN_MODE_LABEL, type BrowserSource, type OpenMode } from './browser-detect.ts'
import { EMPTY_PREFS, launcherOf, type BrowserPrefs } from './browser-settings.ts'
import { refreshBrowsers, useDetectedBrowsers } from './browser-detect-store.ts'

/** 来源的中文名（界面上标一下，让用户知道它从哪来的）。 */
const SOURCE_NAME: Record<string, string> = {
  system: '系统装的',
  playwright: 'Playwright 自带',
  cdp: 'CDP',
}

/**
 * 「浏览器」设置一段。
 *
 * @param props.prefs - 当前偏好。
 * @param props.onPrefs - 改偏好。
 * @param props.titleClassName - **可选**：标题那个 div 额外的类名。
 *   ⚠️ 默认不传时行为与改前完全一致（用 `workflow-canvas.module.css` 的 `scGroupTitle`）。
 *   工作台设置传 `ws.sectionTitle`，是为了让「浏览器」这一节的标题与
 *   「模型」「提醒」同一档字号 —— 见 `WorkbenchSettings.module.css` 里那段说明。
 * @returns 设置段元素。
 */
export function BrowserSettings(props: {
  prefs: BrowserPrefs
  onPrefs: (p: BrowserPrefs) => void
  /**
   * 标题的额外类名（可选）。
   *
   * 为什么做成 props 而不是在外层用 CSS 选择器硬套：
   * 外层写 `.browserSection > div > div:first-child` 是**拿 DOM 结构当契约** ——
   * 这里只要多包一层，那条规则就静默失效（界面上标题小一号，而测试若只比
   * 「有没有标题」仍然绿）。做成 props 后，结构怎么变都由这里说了算。
   */
  titleClassName?: string
}) {
  const { prefs, onPrefs, titleClassName } = props
  /* 检测结果走共享缓存 —— 节点设置那边也读同一份，两处不会不一致。 */
  const detect = useDetectedBrowsers()
  const browsers = detect?.browsers ?? []
  /* ⚠️ **CDP 端点不能混进「本机浏览器」那张表**（2026-10-18 用户 m03635 报的）：
   *
   * 宿主半把两类东西**放在同一个 `browsers` 数组**里返回：`source: 'app'` 是
   * 「本机装着的浏览器」（有 `path`），`source: 'cdp'` 是「正在听的调试端口」（`path` 为 null）。
   * 而 `path === null` 在界面上的含义是「**找过但没找到**」—— 于是 CDP 那几条
   * 被渲染成「CDP 端口 9222 —— Chrome/138.0.7204.0 · 没找到」，一行里同时说「检测到」和「没找到」。
   *
   * 上面那一段已经把端点逐个列过了（带端口与版本），所以这里**只要 `app` 那类**。 */
  const apps = browsers.filter(b => b.source !== 'cdp')
  const busy = detect?.loading === true
  const usable = apps.filter(b => b.path !== null)
  const endpoints = detect?.cdp?.endpoints ?? []

  /* 端口下拉的候选值（2026-10-15，用户 m03425 第 5 条「只能选择」）：
   * 本次检测扫到的端点 + 当前已存的值（老配置兜底，理由见下面那段注释）。 */
  const portOptions: string[] = []
  for (const p of [...endpoints.map(e => String(e.port)), prefs.defaultPort]) {
    if (p !== '' && !portOptions.includes(p)) portOptions.push(p)
  }

  return (
    <div className={float.canvasFloatGroup}>
      {/* 标题：默认只挂 `scGroupTitle`（与改前一致）；传了 `titleClassName` 就**两者都挂** ——
       * 不能只挂新的那份，因为 `scGroupTitle` 里还有 `margin-bottom` / 字重那些基础值。 */}
      <div className={titleClassName === undefined ? float.canvasFloatTitle : float.canvasFloatTitle + ' ' + titleClassName} data-ewb-browser-title="">浏览器</div>

      {/* ── 默认（用户：「设置里面选一个作为默认」）──────────────────
       *
       * ★ 2026-10-14：这里现在是「默认**来源**」而不是「默认启动方式」——
       * 因为 CDP 不再是一个「打开方式」，它是「另一个来源」。 */}
      <div className={float.canvasFloatRow}>
        <span className={css.setLabel}>默认来源</span>
        <select
          className={css.setSelect}
          value={prefs.defaultSource}
          aria-label="默认来源"
          onChange={e => {
            const source: BrowserSource = e.target.value === 'app' ? 'app' : 'cdp'
            onPrefs({
              ...prefs,
              defaultSource: source,
              defaultLauncher: launcherOf(source, prefs.defaultOpenMode),
            })
          }}
        >
          {(Object.keys(SOURCE_LABEL) as BrowserSource[]).map(k => (
            <option key={k} value={k}>{SOURCE_LABEL[k].name}</option>
          ))}
        </select>
      </div>

      {prefs.defaultSource === 'cdp'
        ? (
          /* ★ 2026-10-15（用户 m03425 第 5 条：「CDP 模式下的端口不应该可以手填，
           * **应该只能选择**」）。
           *
           * 可选值 = 本次检测扫到的 CDP 端点 + 当前已存的值。**不给你手打** ——
           * 手打一个不存在的端口，跑起来才发现，那正是这条要求要消掉的情况。
           *
           * ⚠️ 保留「不设」这一项：留空时各标签自己选（`checkRunnable` 会明确拦住
           * 没配的标签，不会静默连错端口）。
           * ⚠️ 也把 `prefs.defaultPort` 本身列进候选 —— 老配置里手填过的端口
           * 若不列出来，下拉会显示成别的值，看起来像「设置被改了」。 */
          <div className={float.canvasFloatRow}>
            <span className={css.setLabel}>默认端口</span>
            <select
              className={css.setSelect}
              value={prefs.defaultPort}
              aria-label="默认调试端口"
              onChange={e => { onPrefs({ ...prefs, defaultPort: e.target.value }) }}
            >
              <option value=''>（不设 —— 每个标签自己选）</option>
              {portOptions.map(p => {
                const hit = endpoints.find(e => String(e.port) === p)
                return (
                  <option key={p} value={p}>
                    {p}{hit === undefined || hit.browser === null ? '' : '（' + hit.browser + '）'}
                  </option>
                )
              })}
            </select>
          </div>
        )
        : (
          <>
            <div className={float.canvasFloatRow}>
              <span className={css.setLabel}>默认浏览器</span>
              <select
                className={css.setSelect}
                value={prefs.defaultBrowserId}
                aria-label="默认浏览器"
                onChange={e => { onPrefs({ ...prefs, defaultBrowserId: e.target.value }) }}
              >
                <option value=''>（未设置 —— 用检测到的第一个）</option>
                {/* 只列**本机装着的**浏览器（CDP 端点在上一段单独列，见 `apps` 的说明）。 */}
                {apps.map(b => (
                  <option key={b.id} value={b.id} disabled={b.path === null}>
                    {b.name}{b.path === null ? '（没找到）' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className={float.canvasFloatRow}>
              <span className={css.setLabel}>默认打开方式</span>
              <select
                className={css.setSelect}
                value={prefs.defaultOpenMode}
                aria-label="默认打开方式"
                onChange={e => {
                  const openMode: OpenMode = e.target.value === 'headless' ? 'headless' : 'headed'
                  onPrefs({ ...prefs, defaultOpenMode: openMode, defaultLauncher: launcherOf('app', openMode) })
                }}
              >
                {(Object.keys(OPEN_MODE_LABEL) as OpenMode[]).map(k => (
                  <option key={k} value={k}>{OPEN_MODE_LABEL[k].name}</option>
                ))}
              </select>
            </div>
          </>
        )}
      <div className={css.setNote}>
        没在节点上单独指定的标签，都用这一份。{SOURCE_LABEL[prefs.defaultSource].hint}
      </div>

      {/* ── 检测结果（全列，包括没找到的）────────────────────────────── */}
      <div className={float.canvasFloatTitle} style={{ marginTop: '8px' }}>
        检测到的浏览器
        <button
          type='button'
          className={css.setReset}
          style={{ marginLeft: '8px' }}
          disabled={busy}
          title='重新扫描本机的浏览器与调试端口（只读，不改任何东西）'
          onClick={() => { void refreshBrowsers() }}
        >{busy ? '检测中…' : '重新检测'}</button>
      </div>
      {detect === null
        ? <div className={css.setNote}>正在检测…</div>
        : detect.error !== undefined
          ? <div className={css.setNote}>检测失败：{detect.error}</div>
          : (
            <>
              {/* ★ 扫到的 CDP 端点**逐个列出端口与浏览器版本**（用户 #7 要的）。
               * 原来这里只说「:9222 在不在听」—— 那个写法本身就假设了只有一个端口。 */}
              {endpoints.length > 0
                ? (
                  <div className={css.setNote} data-ewb-cdp-list=''>
                    扫到的调试端口（这些能直接连，<b>保留登录态</b>）：
                    {endpoints.map(e => (
                      <div key={e.port} className={css.setDep}>
                        <span className={css.setDepKind}>CDP</span>
                        <span className={css.setValue}>
                          端口 {String(e.port)}{e.browser === null ? '' : ' —— ' + e.browser}
                        </span>
                      </div>
                    ))}
                  </div>
                )
                : (
                  <div className={css.setNote} data-ewb-cdp-list=''>
                    没扫到调试端口。要用「已开的调试端口（CDP）」这种来源，
                    先把浏览器带 `--remote-debugging-port=&lt;端口&gt;` 启动，再回来点「重新检测」。
                  </div>
                )}
              {apps.map(b => (
                <div key={b.id} className={css.setDep} title={b.path ?? '没找到'}>
                  <span className={css.setDepKind}>{SOURCE_NAME[b.source] ?? b.source}</span>
                  <span className={b.path === null ? css.setDepWarn : css.setValue}>
                    {b.name}{b.path === null ? ' · 没找到' : ''}
                  </span>
                </div>
              ))}
              {apps.length === 0 && <div className={css.setNote}>一个本机浏览器都没检测到。</div>}
            </>
          )}

      {/* 说清「标签那部分去哪儿了」—— 否则用户在这里找不到会以为是坏了。 */}
      <div className={css.setNote} style={{ marginTop: '6px' }}>
        「哪个标签用哪个浏览器」在每个浏览器节点的设置里改
        （打开节点 → 浏览器一节）。改一个标签，用它的节点会一起生效。
      </div>
      {detect !== null && detect.error === undefined
        && prefs.defaultSource === 'app' && apps.length > 0 && usable.length === 0 && (
        <div className={css.setNote}>
          一个可用的浏览器都没有 —— 先装一个，或按「重新检测」。
          {prefs.defaultPort === '' && `（也可以改用「${SOURCE_LABEL.cdp.name}」，它不挑本机的浏览器。）`}
        </div>
      )}
    </div>
  )
}
