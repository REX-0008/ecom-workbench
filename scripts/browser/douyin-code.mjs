/** 「取数-抖音电商罗盘」工作流的各段代码（**单一来源**：生成器与测试都用）。
 *
 * ## 对应原脚本
 *
 * `下载抖音.bat` → `node src/douyin-ui.ts`（612 行，最大的一份）。
 *
 * ## ★ 结构（2026-10-19 改：**两层嵌套循环**，用户定的「严格内连」）
 *
 * ```
 * ① 模块清单
 * ② 循环 A：逐模块
 *      ②a 打开该模块页 → ②b 等页面渲染 → ②b2 点「本店搜索词」tab（仅搜索模块）
 *      ②c 读已结算日 R → ②d 列该模块目录得 L → ②e 算「这个模块要补哪些日期」
 *      ③ 循环 B：逐日期（**嵌在 ② 里**）
 *           ④a 设日期 → ④b 这个模块要两步点击吗？
 *                 ├ 是 → ④b1 两下点击 + 落盘
 *                 └ 否 → ④b2 一次点击 + 落盘
 *              → ④c 拼文件名 → ④d 本轮结果
 * ⑤ 汇总（连续失败护栏）→ 写结果文件
 * ```
 *
 * ### 为什么要嵌进去（用户 2026-10-19 原话）
 *
 * > 「按照原本 TS 的逻辑，打开网页，排查日期，查到日期后下载。然后继续下一个表格，
 * >   而不是当前的先全部排查，然后下载（前后脱节，不太合理）。」
 *
 * 改之前是「两个并列的循环」：循环 A 把 7 个模块的日期**全查完**，
 * 再交给循环 B 逐日下载 —— 而循环 B 里**没有「打开页面」这一步**，
 * 它靠循环 A 跑完后页面上残留的那一个页面。
 * 于是「哪个模块在哪个页面上」全靠**顺序巧合**：任何一个模块失败、或页面被导航走，
 * 后面就会在**上一个模块的页面**上下载（这就是「前后脱节」的技术根因）。
 *
 * 嵌进去之后，内层循环一定在外层那一轮**之内**跑：页面是外层这一步刚打开的，
 * 日期是这个模块自己算的，下完才轮到下一个模块。隐患从结构上消失，
 * 不需要再加任何「记住上一个模块是谁」的状态。
 *
 * ⚠️ 嵌套循环的能力 2026-10-19 才有（见 `plans/2026-10-19-嵌套循环-最终方案.md`）：
 *   - 内层写 `{{item}}` / `{{index}}` 取**内层**本轮的值，`{{outer.item}}` 取外层那份；
 *   - 内层循环的输出交到**外层那一轮**的结果里（外层用它自己的「结果取哪个」去收）。
 *
 * ## ★★ 循环变量怎么进节点（我第一版**写错了两次**，都记下来）
 *
 * ### 错法一：以为循环变量塞在上游数据里
 * 我写「从 `input` 里剥出 `item`」—— **永远拿不到**。
 * 事实（`run.ts`）：循环变量经**变量替换**注入
 * （`loopVars: { item: items[i], index: i }` 走 `scope.fields`）。
 *
 * ### 错法二：写 `{{item.nameFilter ? A : B}}`
 * **变量替换是纯文本替换，不是 JS 表达式** —— 里面写三目运算符不会求值，
 * 那个占位符会原样留着（或替换成空）→ 静默出错。
 *
 * ### ✅ 正确写法：`const item = {{item}}`
 * `toText()` 对**对象**会 `JSON.stringify` —— 而 JSON 恰好是合法 JS 字面量。
 * 所以 `const item = {{item}}` 会变成 `const item = {"name":"交易",...}`，**能跑**。
 *
 * 这个写法还有个好处：**测试里我能自己把 `{{item}}` 换成 JSON 再跑**
 * （不必真的起引擎），所以这些 `code.js` 段是**可离线单测的**。
 *
 * ## ⚠️ 四条护栏（源码原话）
 *
 * | 护栏 | 源码 |
 * | --- | --- |
 * | 夜禁 **01:00–06:00** | `h>=1 && h<6` → `exit 2` |
 * | 掉登录**等人登录**（5 分钟） | `page.url().includes('/login')` → 轮询 300 秒 |
 * | **连续 2 个日期失败** → 停该模块 | `consecutiveFails >= 2` |
 * | 疑似验证页 → **立即终止** | `/验证|安全|滑块/.test(title)` → `exit 2` |
 *
 * ## ⚠️ 节奏控制（反爬，源码值）——**有一处如实记为没搬进来**
 *
 * 源码：日期间随机 8–15 秒、失败后退避到 30–60 秒、每 5 天加 20–40 秒、
 * 模块间 20–40 秒。
 *
 * 我们用 `flow.delay`（固定值）表达**大致节奏**，
 * 但「按第几天 / 有没有失败」变化的**随机退避**在画布上表达不了
 * （那需要循环体内的状态与分支）。**这是取舍，不是遗漏** ——
 * 记在此处，免得以后有人以为「已经完整搬过来了」。
 */

/**
 * 7 个罗盘模块的配置（照源码 `MODULES`，逐条搬）。
 *
 * ⚠️ **`商品卡` 已停用**（源码注释：2026-09-12 被商品列表页替代）→ 9 条减 1 条。
 * ⚠️ 两个千川模块（`promo` / `promoprod`）走**另一套流程**（区间滚动 7 天，不是逐日），
 * 源码用 `qianchuanFlow` 单独实现 —— **本工作流只做罗盘这 7 个**。
 */
export const DY_MODULES = [
  /* ⚠️ URL / picker / folder 一律照源码 `douyin-ui.ts:37-52` 抄，**别凭记忆写**。
   *
   * 2026-10-16 真机踩到：搜索那条的 URL 少了 `/search` 一段
   * （写成 `shop/drainage-terms`，源码是 `shop/search/drainage-terms`），
   * 于是打开的是别的页面 → `②c 读已结算日 R` 报「找不到日期控件」→ 循环 A 中断。
   * 前 5 个模块全绿、只在第 6 个断，正是「配置里的一个字段写错」的形状。 */

  { name: '交易', alias: 'trade', url: 'https://compass.jinritemai.com/shop/business-part', picker: '.aurora-dorami-date-picker-wrapper', folder: 'D-店铺-整体-抖音', btn: 'dropdown' },
  { name: '直播', alias: 'live', url: 'https://compass.jinritemai.com/shop/live-overview', picker: '.aurora-dorami-date-picker-wrapper', folder: 'D-店铺-直播-抖音', btn: 'first' },
  { name: '短视频-自营', alias: 'video-self', url: 'https://compass.jinritemai.com/shop/video/overview', picker: '.aurora-dorami-date-picker-wrapper', folder: 'D-店铺-视频-抖音', btn: 'last', videoTag: '自营', nameFilter: '自营', fileSuffix: '-自营' },
  { name: '短视频-合作', alias: 'video-partner', url: 'https://compass.jinritemai.com/shop/video/overview', picker: '.aurora-dorami-date-picker-wrapper', folder: 'D-店铺-视频-抖音', btn: 'last', videoTag: '合作', nameFilter: '合作', fileSuffix: '-合作' },
  { name: '图文', alias: 'article', url: 'https://compass.jinritemai.com/shop/graphic/graphic-analysis', picker: '.aurora-dorami-date-picker-wrapper', folder: 'D-店铺-图文-抖音', btn: 'last' },
  { name: '搜索', alias: 'search', url: 'https://compass.jinritemai.com/shop/search/drainage-terms', picker: '.ecom-dorami-date-picker-wrapper', folder: 'D-店铺-搜索-抖音', btn: 'first', shopTab: true },
  { name: '商品列表', alias: 'commodity', url: 'https://compass.jinritemai.com/shop/commodity/product-list', picker: '.aurora-dorami-date-picker-wrapper', folder: 'S-商品-整体-抖音', btn: 'dropdown' },
]

/**
 * 循环A 的循环体节点「打开该模块页」之后、读 R 之前要走的那一下（**页面内 eval**）。
 *
 * ## 它为什么必须单独存在（2026-10-17 用户提醒）
 *
 * 搜索模块的页面**默认不是「本店搜索词」那一栏**，得先点一下那个 tab，
 * 日期控件才出来。源码 `douyin-ui.ts:538-545` 里是 `if (mod.shopTab) { …点「本店搜索词」… }`，
 * 位置在「等控件」之后、`setupPicker` 之前。
 *
 * 我们拆工作流时**漏了这一下**（记在 E3）—— 但当时的症状被别的错盖住了
 * （先是 dayjs、后是 URL、再是等控件），一直没轮到它。
 *
 * ## 为什么做成「一直存在、自己判断要不要点」而不是按模块二选一
 *
 * 用 `flow.if` 按 `{{item.shopTab}}` 分岔要多两个节点，且**两个模块共用同一张循环体图**；
 * 更省事的是：这一下**先看有没有那个 tab**，没有就立刻返回（等于没做）。
 * 别的模块上「找不到那个 tab」是正常的，不是错误。
 *
 * ⚠️ 判据照源码：**只点可见的**（`offsetParent !== null`）那个「本店搜索词」。
 * 隐藏的同名元素点了也没用（而且会点错目标）。
 *
 * 输出 `{ ok: true, clicked: 真假 }` —— `clicked=false` 表示「这个页面没有那个 tab」
 * （别的模块就是这种），**不是失败**。
 */
export const DY_SHOP_TAB = `
/* ⚠️ 循环变量经变量替换注入。 */
const item = {{item}}

/* ⚠️ 掉登录 → 明确报错（别在登录页上找 tab）。 */
if (location.href.includes('/login')) return { ok: false, err: 'LOGIN_REQUIRED' }

/* 照源码：只认**可见**的那个「本店搜索词」。找不到 = 这个模块没有这个 tab（正常）。 */
const els = Array.from(document.querySelectorAll('div,span,li,button')).filter((e) => {
  const el = e
  return el.offsetParent !== null && (el.textContent || '').trim() === '本店搜索词'
})
if (!els.length) return { ok: true, clicked: false, moduleName: item.name }
els[0].click()
return { ok: true, clicked: true, moduleName: item.name }
`

/** 店铺名（源码 `SHOP`）。 */
export const DY_SHOP = 'DemoShop'

/** 「拿循环项」的**统一写法**（每段循环体内的代码都以它开头）。 */
const ITEM_HEAD = `
/* ⚠️ 循环变量经**变量替换**注入（引擎的 loopVars → scope.fields）。
 * 写法说明见本文件头部：用 \`const item = {{item}}\`
 * —— 对象会被 JSON.stringify，而 JSON 是合法 JS 字面量，所以能跑。 */
const item = {{item}}
`

/**
 * 步骤①：模块清单（`code.js`）—— 并**按开始节点的 `modules` 参数过滤**。
 *
 * 模块配置**写进工作流**（不是每次去读源码）—— 它就是「配置不是流程」里的那份配置
 * （用户 2026-10-12 原话：「8 个模块是**配置**不是流程」）。
 *
 * ## ⚠️⚠️ 「留空 = 跑全部」，不是「留空 = 什么都不跑」
 *
 * 用户 2026-10-19 的原则（原话）：
 * > 「删模块这种事情，不应该，工作流做好了就应该兼容而不是为了部分去删基础结构。」
 *
 * 所以 `modules` 留空（没填、空串、或全是空白）时，**必须原样返回全部 7 个模块**。
 * 这是向后兼容的硬判据：三个输入全留空时，行为与「没有开始节点」时逐字一致。
 *
 * 反过来写成「留空 → 过滤成空列表」，症状是**一个模块都不跑、也不报错**，
 * 结果文件里 total=0 —— 看起来像「今天不用补数」。这是本段最危险的错法，
 * `tests/douyin-logic.mjs` 与 `tests/douyin-workflow.mjs` 各有一条断言钉着它。
 *
 * ## 过滤规则（照源码 `douyin-ui.ts:517-518`）
 *
 * 按**中文名**或**英文别名**匹配，逗号分隔；另外 `短视频` 这一个词算中所有
 * `短视频-*`（源码那句 `x === '短视频' && mod.name.startsWith('短视频-')`）。
 * 不认识的词**不静默忽略** —— 记一条警告，否则用户拼错一个模块名会以为跑过了。
 */
export const DY_STEP_MODULES = `
/* 罗盘那 7 个模块（**逐日**）。两个千川模块走另一套流程，不在本工作流里。
 * ⚠️ 商品卡已停用（源码 2026-09-12 注释：被商品列表页替代）。 */
const all = ${JSON.stringify(DY_MODULES, null, 2)}

/* ⚠️⚠️ 变量替换是**纯文本替换**，所以它必须写在**引号里面**。
 *
 * 写成 \`String({{modules}}).trim()\` 是不行的：留空时替换结果是空文本，
 * 拼出来是 \`String().trim()\` —— 恰好能跑，但**没有开始节点时** \`{{modules}}\`
 * 会原样保留，拼出来是 \`String({{modules}})\` → **语法错误、整步失败**。
 * 写成带引号的 \`String("{{modules}}")\` 两种情况都合法。 */
const raw = String("{{modules}}").trim()
/* 没有开始节点（变量没被替换）时留空 → 按「全部」处理，与改造前一致。 */
const wantRaw = raw.split('{{').length > 1 ? '' : raw
const want = wantRaw === '' ? [] : wantRaw.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== '')

/* ★ 留空 → 全部（用户原则：兼容，不是删掉基础结构）。 */
const matched = want.length === 0
  ? all
  : all.filter((m) => want.some((x) => x === m.name || x === m.alias || (x === '短视频' && m.name.startsWith('短视频-'))))

/* 不认识的名字要说出来，不能静默当没写。 */
const known = new Set()
for (const m of all) { known.add(m.name); known.add(m.alias) }
known.add('短视频')
const unknown = want.filter((x) => !known.has(x))

return {
  modules: matched,
  count: matched.length,
  shop: ${JSON.stringify(DY_SHOP)},
  /* 这两个字段是给用户看的（日志/结果文件），下游不依赖。 */
  requested: want,
  unknown,
}
`

/**
 * 循环A 的循环体①：算「该模块要下哪些日期」——**页面内 eval**（要读 R）。
 *
 * ⚠️ 这一步同时做两件事（照源码 `setupPicker` + 主循环的日期计算）：
 *   ① 找 picker 的 fiber、存 dayjs 到 `window.__picker`（**循环B 设日期要用**）
 *   ② 读「最近已结算日 R」
 *
 * 输出 `{ ok, R, err }`。
 *
 * ⚠️ **不猜日期**：读不到 R 就 `ok:false`（猜错会把不该下的日期下下来）。
 * ⚠️ 掉登录要**明确报错**（`LOGIN_REQUIRED`），不要当成「页面没加载完」。
 */
export const DY_READ_R = `
/* ⚠️ 循环变量经变量替换注入。 */
const item = {{item}}
const sel = item.picker

/* ⚠️ 掉登录 → 明确报错（让人去登录），不当作「页面没加载完」。 */
if (location.href.includes('/login')) return { ok: false, err: 'LOGIN_REQUIRED' }

/* ⚠️ 找到控件前**就地等一会儿**（最多 12 秒）—— 照源码的意思（它那儿是
 * page.waitForSelector(picker, 20000)，但**换了个做法**：源码那一步在
 * playwright 层、拿得到 page；我们这里是**页面内脚本**，没有 page 对象，
 * 所以改成「轮询重查」。等价，且不跨层。
 *
 * 2026-10-16 真机踩到：**搜索页**的日期控件比别的模块出现得慢，上游只等了
 * 固定 4 秒就进来了，查一次没找到 → 报「找不到日期控件」→ 循环 A 中断。
 * 前 5 个模块都过得去，就它不行。（那次的 URL 还少了 /search 一段，
 * 见 DY_MODULES 的备注 —— 两件事叠在一起，URL 那件已先修。） */
const waitFor = (fn, ms) => new Promise((resolve) => {
  const t0 = Date.now()
  const tick = () => { if (fn() || Date.now() - t0 >= ms) resolve(null); else setTimeout(tick, 300) }
  tick()
})
let root = document.querySelector(sel)
if (!root) { await waitFor(() => document.querySelector(sel), 12000); root = document.querySelector(sel) }
if (!root) return { ok: false, err: '找不到日期控件（' + sel + '）—— 等了 12 秒页面还没加载完，或改版了' }

/** 找 React fiber（源码同法）。 */
const findFiber = (el) => {
  const k = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  return k ? el[k] : null
}
let f = findFiber(root)
let ocf = null
let depth = 0
while (f && depth < 60) {
  const p = f.memoizedProps
  if (p && typeof p.onChange === 'function') { ocf = f; break }
  f = f.return
  depth++
}
if (!ocf) return { ok: false, err: '控件上找不到 onChange（页面改版？）' }

/* ══════════════════════════════════════════════════════════════════════════
 * dayjs 模板：**照源码 douyin-ui.ts 的 setupPicker 逐句搬**（2026-10-16 重写）。
 *
 * ⚠️⚠️ 我第一版是「照自己的理解简化」的，结果真机上必报
 *      「找不到 dayjs 模板（页面改版？）」—— 用户 2026-10-16 报的就是这个。
 *      两处都简化错了：
 *
 *        我写的                             源码的
 *        ─────────────────────────────────  ────────────────────────────────
 *        只往「父链」上走，每层只看一层      先看控件自己的 value.date[0]，
 *        props（Object.values 一层）        不行再**深层遍历**：
 *                                           对象深 20 层、fiber 树 child/sibling
 *                                           深 8 层，还带 seen 防环
 *        判据 = 有 year / month 方法        判据 = 有 format + toISOString
 *                                           （dayjs 的特征）
 *
 *      ⇒ **别自己重写这种「探进别人页面内部结构」的代码**：它是在跟一个
 *      我们控制不了的实现搏斗，能跑通的那个版本就是唯一靠谱的规格。
 *      （与 pitfalls/同一件事写两份迟早漂.md 同源：重写 = 悄悄换了规格。）
 * ══════════════════════════════════════════════════════════════════════════ */
const v = ocf.memoizedProps.value
let m0 = null
/* ① 最可靠：控件自己的值里就带着 dayjs。
 * 源码第一句：if (v && v.date && v.date[0] && typeof v.date[0].format === 'function') m0 = v.date[0] */
if (v && v.date && v.date[0] && typeof v.date[0].format === 'function') m0 = v.date[0]
/* ② 找不到才深挖（源码同法）。 */
if (!m0) {
  const seen = new Set()
  const found = []
  const walkObj = (x, dep) => {
    if (!x || typeof x !== 'object' || seen.has(x) || dep > 20 || found.length) return
    seen.add(x)
    if (typeof x.format === 'function' && typeof x.toISOString === 'function') { found.push(x); return }
    if (Array.isArray(x)) { x.slice(0, 20).forEach((i) => { walkObj(i, dep + 1) }); return }
    for (const k of Object.keys(x).slice(0, 30)) walkObj(x[k], dep + 1)
  }
  const walkFiber = (fib, dep) => {
    if (!fib || dep > 8 || found.length) return
    if (fib.memoizedProps) walkObj(fib.memoizedProps, 0)
    if (!found.length && fib.child) walkFiber(fib.child, dep + 1)
    if (!found.length && fib.sibling) walkFiber(fib.sibling, dep + 1)
  }
  walkFiber(ocf, 0)
  if (found.length) m0 = found[0]
}
if (!m0) return { ok: false, err: '找不到 dayjs 模板（页面改版？）' }
/* ⚠️ 存下来给循环B 用（同一个页面、同一份 window）。 */
window.__picker = { onChangeFiber: ocf, m0 }

/* ── 读「已结算日 R」：**照源码的三条来源**（顺序也照它） ──────────────────
 * ① 控件自己的值里 date[1] 就是当前范围结束日 = 最近已结算日（最可靠）
 * ② 退回页面上的日期显示元素（源码选择器 date-picker-default-display）
 * ③ 我们额外加的一条：扫正文里「结算 / 更新至 / 数据至」上下文的日子
 *    （⚠️ 这条**不在源码里**，是 2026-10-16 保留的兜底 —— 源码那两条都是
 *     抓具体 DOM，页面一改就全断；这条抓的是文案语义，坏得慢一些） */
let R = ''
if (v && v.date && v.date[1] && typeof v.date[1].format === 'function') R = v.date[1].format('YYYY-MM-DD')
if (R === '') {
  const disp = document.querySelector('[class*="date-picker-default-display"]')
  const t = disp ? (disp.textContent || '') : ''
  const ms = t.match(/(\\d{4})\\/(\\d{2})\\/(\\d{2})/g)
  if (ms && ms.length) {
    const p2 = ms[ms.length - 1].split('/')
    R = p2[0] + '-' + p2[1] + '-' + p2[2]
  }
}
if (R === '') {
  const text = document.body ? document.body.innerText : ''
  const lines = text.split(/\\r?\\n/).map((l) => l.trim()).filter((l) => l !== '')
  for (let i = 0; i < lines.length; i++) {
    if (!/结算|更新至|数据至/.test(lines[i])) continue
    const win = lines.slice(i, i + 3).join(' ')
    const m = win.match(/(20\\d{2})[-/.](\\d{1,2})[-/.](\\d{1,2})/)
    if (m) { R = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'); break }
  }
}
if (R === '') return { ok: false, err: '读不到「已结算日 R」（页面结构待适配）' }
return { ok: true, R, moduleName: item.name }
`

/**
 * 循环A 的循环体最后一个：算「**这一个模块**要补哪些日期」（纯逻辑）。
 *
 * ## 2026-10-19 改：从「算 L，等最后统一展平」变成「本模块自己算完就交给内层」
 *
 * 改之前是两个节点：
 *   ②e 算 L → （循环 A 结束）→ ③ 把 7 个模块的日期**展平成一个长列表**
 * 那份展平列表带 `firstOfModule`（「某模块第一天」），用来让循环 B 知道
 * 「这一项换了模块，要重新打开页面」。而循环 B 里**没有打开页面这一步** ——
 * 它靠循环 A 跑完后页面上残留的那一个页面。这就是「前后脱节」的技术根因。
 *
 * 现在日期在**本模块这一轮之内**算完，直接交给嵌在里面的循环 B：
 * 不需要 `firstOfModule`、不需要「记住上一个模块是谁」，页面也一定是刚打开的那个。
 *
 * 入参：① 列目录那步的输出（`code.shell`，裸 JSON）+ ② 读 R 那步的输出（`browser.act`，包了壳）。
 * 出参：`{ module, folder, fileCount, lastDate, R, dates, days, skipWhy }`
 *   - `dates` 是**内层循环要遍历的列表**，每项 `{ module, date }`
 *     （内层写 `{{item.date}}` 取日期、`{{item.module.btn}}` 判要不要两步点击）；
 *   - `skipWhy` 非空表示这个模块整个跳过（照源码：读不到 R / 没有 L 就跳过，不猜日期）。
 *
 * ⚠️ 照源码 `findLastDate`：扫文件名里的 `(20\d{2})(\d{2})(\d{2})` 取最大。
 * ⚠️ `nameFilter`（短视频自营/合作落在同一文件夹）照源码按名字过滤。
 * ⚠️ 日期区间照源码 `dateRange`：`L+1 ~ R`，含两端，**升序**。
 */
export const DY_MODULE_DATES = `
const item = {{item}}

/* 上游两条边：① 列目录（code.shell）② 读 R（browser.act，包了壳）。
 *
 * ⚠️⚠️ **两条路的形状完全不同，必须都认**（2026-10-16 修的线上 BUG）：
 *
 *   · code.shell 交给下游的是纯文本（src/dispatch/executors.ts 里
 *     return { status: 'success', output: out.trim() }）—— 脚本往 stdout 打的
 *     那行 JSON 在这里还是字符串。
 *   · browser.act（eval 动作）交给下游的是对象，而且是包了一层的
 *     （{ result: {...} }）。
 *
 * 我第一版只写了对象那条路，于是真机上 n6 明明成功（日志里 32 个文件都在）
 * 却报「拿不到目录清单」。
 *
 * ⚠️ 为什么测试没抓到：tests/douyin-workflow.mjs 的壳桩自己把最后一行
 * JSON 解析成了对象 —— 那是 shell 执行方的第二份实现，与真的那份不一致。
 * 这正是 pitfalls/同一件事写两份迟早漂.md 记的那类坑。
 * 现在那个壳桩已改成返回真文本，与执行方一致。 */
const arr = Array.isArray(input) ? input : [input]
/** 把一条上游值归一成对象；认不出来返回 null。 */
const un = (v) => {
  if (v === null || v === undefined) return null
  /* ① 字符串：shell 的 stdout。取**最后一行能解析成 JSON 的**（脚本可能还打了别的）。 */
  if (typeof v === 'string') {
    const lines = v.trim().split(/\\r?\\n/).filter((l) => l.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i])
        if (o !== null && typeof o === 'object') return o
      } catch { /* 往前找 */ }
    }
    return null
  }
  if (typeof v !== 'object') return null
  /* ② 已经是我们要的形状。 */
  if (Array.isArray(v.files) || typeof v.R === 'string' || v.err !== undefined) return v
  /* ③ 包了壳的（browser.act → { result: {...} }）。 */
  if (v.result !== null && typeof v.result === 'object') return un(v.result)
  return v
}
let files = null
let rRes = null
for (const raw of arr) {
  const v = un(raw)
  if (v === null) continue
  if (Array.isArray(v.files)) files = v
  if (typeof v.R === 'string' || v.err !== undefined) rRes = v
}
if (files === null) throw new Error('拿不到目录清单（列目录那步失败？）')
if (rRes === null) throw new Error('拿不到已结算日（读 R 那步失败？）')

/* ⚠️ 掉登录 / 读不到 R：**明确停下**，不猜日期。 */
if (rRes.ok !== true) {
  const why = String(rRes.err ?? '未知原因')
  throw new Error('读已结算日失败：' + why
    + (why === 'LOGIN_REQUIRED' ? ' —— 请在那个浏览器窗口里登录抖音，然后重跑' : ''))
}

/* 现有最大日期（照源码 findLastDate）。 */
const scan = (list) => {
  let max = ''
  for (const f of list) {
    const m = String(f).match(/(20\\d{2})(\\d{2})(\\d{2})/)
    if (!m) continue
    const d = m[1] + '-' + m[2] + '-' + m[3]
    if (d > max) max = d
  }
  return max
}
/* ⚠️ 短视频那两条共用一个文件夹，按 nameFilter 分（照源码的 nameFilter 思路）。 */
const nameFilter = item.nameFilter
const lastDate = nameFilter
  ? scan(files.files.filter((f) => String(f).includes(nameFilter)))
  : scan(files.files)

/** 日期串 + n 天。 */
const addDays = (s, n) => {
  const d = new Date(s + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
/** 日期区间（含两端，**升序** —— 照源码 dateRange）。 */
const range = (from, to) => {
  const out = []
  const d = new Date(from + 'T00:00:00')
  const e = new Date(to + 'T00:00:00')
  while (d <= e) {
    out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'))
    d.setDate(d.getDate() + 1)
  }
  return out
}

/* ── 开始节点的 from / to 覆盖（照源码 douyin-ui.ts:552-557）────────────────
 *
 * 源码原句：
 *   const to   = toArg || R;
 *   const from = fromArg || (L ? nextDay(L) : '');
 *
 * 也就是：**填了就用填的，没填才走自动推算**。留空时与改造前逐字一致
 * （from = L+1、to = R），这是向后兼容的硬判据。
 *
 * ## ⚠️ R 仍然必须读得到
 *
 * 源码在算 to 之后仍然 if (!R) { 跳过 } —— 也就是**填了 --to 也不能不要 R**。
 * 为什么：R 是「这批数据结算到哪天」，用来判断「有没有超出可下范围」，
 * 也是日志里给人看的对照值。这里照抄，不改它的语义。
 *
 * ## ⚠️ 变量替换要写在引号里（同 DY_STEP_MODULES 那段）
 *
 * 没有开始节点时 {{from}} 会原样保留成那 8 个字符，写在引号里就只是
 * 一段怪字符串（下面按「没填」处理）；不写引号则拼出非法 JS、整步失败。 */
const pickArg = (raw) => {
  const s = String(raw ?? '').trim()
  /* 没被替换（含 \`{{\`）或空串 → 当作「没填」。 */
  if (s === '' || s.split('{{').length > 1) return ''
  return s
}
const fromArg = pickArg("{{from}}")
const toArg = pickArg("{{to}}")

/* 校验用户填的日期形状（写错时说清，而不是静默算出 0 天）。 */
const badDate = []
for (const [who, v] of [['from', fromArg], ['to', toArg]]) {
  if (v !== '' && !/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) badDate.push(who + '=' + v)
}
if (badDate.length > 0) {
  throw new Error('日期要写成 2026-10-01 这种样子（年-月-日，带前导零）。这几项不对：' + badDate.join('、'))
}

/* 本模块的日期区间：**from ~ to**（含两端、升序，照源码 dateRange）。
 *
 * ⚠️ 照源码：读不到 R → **该模块跳过**（记原因，不猜日期）；
 * 「没有 L 且没填 from」→ 也跳过（源码：无法确定开始日期）。
 * 跳过时 dates 是空数组 —— 内层循环跑 0 轮（不是报错）。 */
const R = String(rRes.R ?? '')
let skipWhy = ''
let dates = []
if (R === '') {
  skipWhy = '读不到最近已结算日 R'
} else {
  /* ★ 填了就用填的，没填才自动推算（与改造前逐字一致）。 */
  const to = toArg !== '' ? toArg : R
  const from = fromArg !== '' ? fromArg : (lastDate === '' ? '' : addDays(lastDate, 1))
  if (from === '') {
    skipWhy = '没有现有数据且未指定起点（源码：无法确定开始日期）'
  } else if (from > to) {
    /* from > to 说明没有要补的日期 —— 正常情况，不是跳过也不是错误。 */
    dates = []
  } else {
    dates = range(from, to).map((date) => ({ module: item, date }))
  }
}

return {
  module: item,
  folder: files.folder,
  fileCount: files.files.length,
  lastDate, R,
  dates,
  days: dates.length,
  skipWhy,
  /* 给用户看的：这次区间到底是自动推算还是参数指定的（排查「为什么跑了这些天」）。 */
  rangeFrom: fromArg,
  rangeTo: toArg,
}
`

/**
 * 循环B 的循环体：设日期 —— **页面内 eval**。
 *
 * ⚠️ 日期来自 `{{item.date}}`（变量替换）。
 * 输出 `{ ok, date }`；`ok=false` 时下游按失败处理。
 */
export const DY_SET_DATE = `
const item = {{item}}
const ds = String(item.date)
const p = window.__picker
if (!p) {
  /* ⚠️ 到这儿说明：这个模块的**首日**那一步没把页面打开/没读 R。
   * 明确报错，不要静默（否则后面全在错误的页面上操作）。 */
  return { ok: false, err: '页面还没准备好（__picker 不存在）—— 该模块的首日没先打开页面？', pageTitle: document.title }
}

const parts = ds.split('-').map(Number)
const y = parts[0]
const m = parts[1]
const dd = parts[2]
/* 照源码 setDate：用 dayjs 链构造当天 0:00 与 23:59:59.999，再调 onChange。 */
const mk = (hr, mi, sec, ms) => {
  let x = p.m0
  const steps = [['year', y], ['month', m - 1], ['date', dd], ['hour', hr], ['minute', mi], ['second', sec], ['millisecond', ms]]
  for (const [fn, arg] of steps) {
    if (typeof x[fn] === 'function') { x = x[fn](arg) } else { return null }
  }
  return x
}
const b = mk(0, 0, 0, 0)
const e2 = mk(23, 59, 59, 999)
if (!b || !e2) return { ok: false, err: '构造日期失败（dayjs 链断了）', pageTitle: document.title }
p.onChangeFiber.memoizedProps.onChange({ type: 'day', date: [b, e2] }, { triggerType: 'quick' })
return { ok: true, date: ds, pageTitle: document.title, moduleName: item.module.name }
`

/**
 * 循环B 的循环体（第二步）：文件名（纯逻辑）。
 *
 * ⚠️ 照源码 `downloadOne`：`{店铺}-{YYYYMMDD}-{建议名}{后缀}`，
 * 建议名非法字符替成 `_`（源码 `replace(/[\\/:*?"<>|]/g, '_')`）。
 *
 * ⚠️ `suggestedFilename` 由**下载那步**给。拿不到就用模块名兜底
 * （**不静默出空名** —— 那会落成一个怪文件）。
 */
export const DY_FILENAME = `
const item = {{item}}
const up = input && typeof input === 'object' ? input : {}
const inner = up.result !== undefined && up.result !== null && typeof up.result === 'object' ? up.result : up
/* 建议名可能从两个地方来（上游，或包在 result 里）。 */
const suggested = String(inner.suggestedFilename ?? up.suggestedFilename ?? '')
const date = String(item.date)
const mod = item.module
if (date === '') throw new Error('拿不到当前日期（循环变量？）')

/* 兜底：建议名没有就用模块名（**不静默出空名**）。 */
const base = suggested !== '' ? suggested : (String(mod.name) + '.xlsx')
const safe = (s) => String(s).replace(/[\\\\/:*?"<>|]/g, '_')
const suffix = mod.fileSuffix || ''
const extIdx = base.lastIndexOf('.')
const fnBase = extIdx > 0 ? base.slice(0, extIdx) + suffix + base.slice(extIdx) : base + suffix
return {
  fileName: safe(${JSON.stringify(DY_SHOP)} + '-' + date.replace(/-/g, '') + '-' + fnBase),
  folder: mod.folder,
  date, moduleName: mod.name,
  usedSuggested: suggested !== '',
  ok: inner.ok === true,
  pageTitle: inner.pageTitle ?? '',
  err: inner.err ?? null,
  /* ⚠️⚠️ 把下载那步的成败与页面标题原样带下去（2026-10-19 修的真 BUG）。
   *
   * 这一步夹在「下载」与「本轮结果」之间。它原来只返回拼好的名字，
   * 于是下游 DY_ROUND_GUARD 去读 ok 时读的是**这一步自己的输出** ——
   * 那里没有 ok，所以 inner.ok === true 恒假 → **每一轮都被记成失败**，
   * 汇总里 total 对、但 okCount 恒为 0，还会误报「连续 2 日失败」。
   *
   * 这个坑以前**看不出来**：汇总那段的递归只认 value / result 键，
   * 一条轮次都收不到，于是恒报 total=0。两个 bug 互相掩盖。
   * 今天把汇总修对了，它才露出来 —— 所以必须一起修，否则等于把
   * 「全都失败了」当成正常结果报给用户。
   *
   * 带的是**上游自己给的**，不是重新推断：这跟 flow.if 的
   * 「上游原样 + 一个标记」是同一个纪律。
   *
   * ⚠️ 这段注释住在**模板字符串内部** —— 这里一个反引号都不能写，
   * 写了就会提前闭合模板串、整份文件语法错误（本轮已经踩过一次）。 */
}
`

/**
 * 下载脚本的**公共前半段**（两个分支共用，别各写一份 —— 那必然漂）。
 *
 * 这一段做的事：取循环项 → 备好目录（不存在的建出来）→ **先挂下载监听**。
 *
 * ⚠️ 先挂监听是 Playwright 官方要求的顺序（原文：*Start waiting for download
 * before clicking. **Note no await***）。反过来会**静默丢事件**：
 * 点下去到挂监听之间文件已经开始下了，事件早派发完 —— 表现为「永远等不到下载」。
 *
 * ⚠️ `waiter.catch(() => {})` 也必须有：点击那步先抛错时没人再 await 它，
 * 它会变成**未处理的 rejection**，Node 直接崩进程（用户看到崩溃而不是「按钮没找到」）。
 */
const DY_DL_PRE = `
const item = {{item}}
const mod = item.module
const btn = String(mod.btn ?? '')
const date = String(item.date ?? '')
if (date === '') throw new Error('拿不到当前日期（循环变量没注入？）')

/* 驱动层才拿得到 node 的 fs / path（页面层做不到）。 */
const fs = await import('node:fs')
const ps = await import('node:path')
const root = __DATA_ROOT__
const dir = ps.join(root, String(mod.folder ?? ''))
/* 目录不存在就建（照 browser.download 的老行为，不让落盘因为缺目录而失败）。 */
fs.mkdirSync(dir, { recursive: true })

/* ① 先挂监听（官方要求的顺序：先挂、后点；中间不 await）。 */
const WAIT_MS = 120000
const waiter = page.waitForEvent('download', { timeout: WAIT_MS })
waiter.catch(() => {})
`

/**
 * 下载脚本的**公共后半段**：等下载 → 定名 → 同名不覆盖 → 落盘 → 校验 → 返回。
 *
 * ⚠️ **定名规则与 2026-10-19 之前逐字一致**（这次重构不许动它）：
 * `{店铺}-{YYYYMMDD}-{建议名}{后缀}`，非法字符替 `_`，同名加时间戳。
 * 下游「清洗入库」靠文件名里的 8 位日期取数据日（`dateFromFilename`），
 * 名字一变就会静默取不到日期 —— 这是「不许顺手改」的硬理由。
 */
const DY_DL_POST = `
/* ③ 等下载开始（这里才 await）。 */
let dl
try {
  dl = await waiter
} catch (e) {
  /* ⚠️ **失败时也要把页面标题带出去**（2026-10-20 修）。
   *
   * 为什么：下游 ④d（DY_ROUND_GUARD）靠 pageTitle 判「疑似风控页 → 立即终止，
   * 绝不重试」。而这条 throw 出去之后，browser.act 的失败**不带任何输出**，
   * 于是 pageTitle 变成空串 → **风控护栏在「下载失败」这种最该触发的时刻失效**。
   *
   * 这正是用户 2026-10-20 报「下到一半失败」时的一个隐患：
   * 如果是被风控拦了，原来的代码只会报「没开始下载」，不会说「这是风控页」。
   *
   * 现在读一次标题再抛，把标题**嵌进错误信息**（抛错没法带结构化输出，
   * 所以只能放进文字里；下游 DY_ROUND_GUARD 也能从那句里认出「验证/安全/滑块」）。 */
  let title = ''
  try { title = await page.title() } catch { /* 页面可能已经关了，保持空 */ }
  throw new Error('点了之后 ' + String(WAIT_MS) + ' 毫秒内没有开始下载。'
    + '模块=' + String(mod.name ?? '?') + '，日期=' + date + '。'
    + '页面标题=' + (title === '' ? '(读不到)' : title) + '。'
    + '检查三件事：① 按钮选择器对不对；② 这个按钮是不是真的触发下载'
    + '（有些按钮只是弹个窗、或者要等几十秒才生成文件）；'
    + '③ 标题里若有「验证 / 安全 / 滑块」，说明是被风控了，等一段时间再跑。'
    + '原始信息：' + String(e?.message ?? e).slice(0, 120))
}

/* ④ 定名：照源码 {店铺}-{YYYYMMDD}-{建议名}{后缀}，非法字符替成 _。
 * 后缀按模块（短视频那两条共用文件夹，靠 -自营 / -合作 区分）。 */
const SHOP = __SHOP__
const safe = (s) => String(s).replace(/[\\\\/:*?"<>|]/g, '_')
const suggested = String(dl.suggestedFilename() ?? '').trim()
/* 拿不到建议名就用模块名兜底（不静默出空名 —— 那会落成一个怪文件）。 */
const base = suggested !== '' ? suggested : (String(mod.name ?? 'download') + '.xlsx')
const suffix = String(mod.fileSuffix ?? '')
const extIdx = base.lastIndexOf('.')
const fnBase = extIdx > 0 ? base.slice(0, extIdx) + suffix + base.slice(extIdx) : base + suffix
const finalName = safe(SHOP + '-' + date.replace(/-/g, '') + '-' + fnBase)

let file = ps.join(dir, finalName)
/* 同名不覆盖（照 browser.download 的老行为：加时间戳）。
 * 用 existsSync 判 —— 这是驱动层才做得到的事，也是这段脚本存在的理由之一。 */
if (fs.existsSync(file)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dot = finalName.lastIndexOf('.')
  file = ps.join(dir, dot > 0
    ? finalName.slice(0, dot) + '-' + stamp + finalName.slice(dot)
    : finalName + '-' + stamp)
}

/* ⑤ 落盘：必须在同一进程里立刻做（CDP 远程连接下临时文件随上下文消失）。 */
try {
  await dl.saveAs(file)
} catch (e) {
  throw new Error('文件没能存到 ' + file + '。'
    + '常见原因：那个目录不允许写、或同名文件正被别的程序打开。'
    + '原始信息：' + String(e?.message ?? e).slice(0, 120))
}

/* ⑥ 落盘校验：下载中途被拦会留下残缺文件，当成功会污染下游。 */
const failure = await dl.failure()
if (failure !== null && failure !== undefined) {
  throw new Error('下载失败：' + String(failure) + '，文件可能不完整：' + file)
}

return {
  ok: true,
  path: file,
  fileName: ps.basename(file),
  suggestedFilename: suggested,
  dir, date, moduleName: String(mod.name ?? ''), btn,
  /* 页面标题给下游「风控立即终止」那道护栏用。
   * ⚠️ 原来那步（browser.download 节点）不返回它，于是 DY_ROUND_GUARD 里那条
   * 「疑似验证页立即终止」实际永远拿不到标题、等于没生效。顺手补上。 */
  pageTitle: await page.title(),
}
`

/**
 * 把公共两段与一个「点击那几行」拼成完整脚本。
 *
 * @param {string} clickPart - 点击步骤（页面层代码正文）。
 * @param {string} dataRoot - 数据根目录（生成时写死进脚本）。
 * @returns {string} 节点代码正文。
 */
function composeDownload(clickPart, dataRoot) {
  return DY_DL_PRE.split('__DATA_ROOT__').join(JSON.stringify(String(dataRoot)))
    + clickPart
    + DY_DL_POST.split('__SHOP__').join(JSON.stringify(DY_SHOP))
}

/**
 * ④b1 的**点击那几行**：下拉菜单 —— 两下。
 *
 * 交易 / 商品列表（`btn === 'dropdown'`）的下载按钮是**下拉菜单**：
 * 先点「下载」出菜单，再点「下载当前明细」才真的下。
 * 源码 `douyin-ui.ts:193-195` 就是这么写的，且两下之间**只有一次
 * `waitForTimeout(1500)`、没有任何重连** —— 「同一页面会话内不间断」是它的隐含前提。
 *
 * ⚠️ 所以这两下**必须在同一个节点、同一个进程里**。我们「一个节点 = 一个子进程」，
 * 拆成两个节点实测必失败（2026-10-19，本地假页面 + 真驱动：第二个节点点的时候
 * 下拉已经收起，报 `page.click: Timeout 30000ms exceeded`）。
 *
 * ⚠️ 选择器串照抄源码，别凭记忆改；`evaluate` 合成点击在这个页面**不触发下拉**
 * （源码注释明写），所以两处都用 `page.locator(...).click()` 真实鼠标。
 */
const CLICK_DROPDOWN = `
/* ② 触发：两下，中间等 1.5 秒让菜单渲染（照源码 waitForTimeout(1500)）。 */
const triggerSel = '.aurora-dropdown-trigger:has-text("下载")'
const menuSel = '.aurora-dropdown-menu-title-content:has-text("下载当前明细")'

try {
  await page.locator(triggerSel).first().click({ timeout: 30000 })
} catch (e) {
  throw new Error('第 1 下「点开下载菜单」没点到（' + triggerSel + '）。'
    + '这个模块（' + String(mod.name ?? '?') + '）的下载是下拉菜单，第一步要先把菜单点开。'
    + '检查页面上还有没有那个「下载」按钮（页面改版常失效）。原始信息：'
    + String(e?.message ?? e).split('\\n')[0].slice(0, 100))
}
await page.waitForTimeout(1500)
try {
  await page.locator(menuSel).first().click({ timeout: 30000 })
} catch (e) {
  /* ⚠️ **失败时把菜单里实际有什么记下来**（2026-10-20 加）。
   *
   * 为什么：真机上这次报「菜单已经点开了，但里面没有那一项」，而
   * **代码与源码 douyin-ui.ts:193-195 逐字一致**（同一个选择器、同样等 1500ms）——
   * 那就是页面上的文案变了。但没有菜单的实际内容，只能猜。
   *
   * 这一段不改行为（只在**失败之后**多读一次页面），代价是一次 evaluate；
   * 换来的是下次报错直接写明「菜单里有：A、B、C」，不用再让用户手工去页面里找。 */
  let menuItems = '(读不到)'
  try {
    menuItems = await page.evaluate(() => {
      /* 下拉菜单容器有好几种可能（不同版本用不同类名），三种都试。 */
      const sels = [
        '.aurora-dropdown-menu-title-content',
        '[class*="dropdown-menu"] [class*="title-content"]',
        '[class*="dropdown-menu"] li',
      ]
      for (const s of sels) {
        const els = Array.from(document.querySelectorAll(s))
        const texts = els.map(x => (x.textContent || '').trim()).filter(t => t !== '')
        if (texts.length > 0) return texts.slice(0, 8).join('、')
      }
      /* 一个都找不到：把「跟下载有关的可见文字」捞出来，仍比空手强。 */
      const all = Array.from(document.querySelectorAll('body *'))
        .filter(x => x.offsetParent !== null)
        .map(x => (x.textContent || '').trim())
        .filter(t => t !== '' && t.length <= 12 && /下载|明细|导出/.test(t))
      return all.length === 0 ? '(菜单里没找到任何下载相关文字)' : all.slice(0, 8).join('、')
    })
  } catch { /* 读页面本身失败就保持「读不到」，不掩盖原错误 */ }
  throw new Error('第 2 下「下载当前明细」没点到（' + menuSel + '）。'
    + '菜单已经点开了，但里面没有那一项。'
    + '★ 菜单里实际有：' + String(menuItems)
    + ' ｜ 如果名字对不上，改 douyin-code.mjs 的 CLICK_DROPDOWN 里那个串。'
    + '原始信息：' + String(e?.message ?? e).split('\\n')[0].slice(0, 100))
}
`

/**
 * ④b2 的**点击那几行**：单按钮 —— 一下。
 *
 * ## ⚠️ 这 5 个模块的行为**一字不变**（用户明确要求）
 *
 * 选择器仍是 `text=下载明细`，取第一个 / 最后一个仍按 `btn` 决定 ——
 * 与改造前那一段逐字一致（原来它写在同一个脚本的 else 分支里，
 * 现在只是搬到另一个函数，点击与落盘的文字**一个字符都没动**）。
 *
 * ## 为什么按 `btn` 决定取第几个
 *
 * 照源码 `douyin-ui.ts:163` 的那行三元：`(b === 'last' ? all[all.length - 1] : all[0]).click()`。
 * 我们有 3 个模块是 `last`（短视频-自营 / 短视频-合作 / 图文）。
 * 页面上「下载明细」可能不止一个（筛选区与表头各一个）——
 * 取错那个就是点了个不下数据的按钮，然后卡满超时。
 * 这里用 Playwright 的 `.last()` / `.first()` 表达同一语义。
 *
 * ⚠️ 点击方式仍是 Playwright 真实鼠标，不改走页面内合成点击 ——
 * 这 5 个模块现在是能跑的，改成 evaluate 等于重写一个没坏的东西。
 *
 * ⚠️⚠️ 这段是**模板字符串内部**（外层是反引号）—— 这里一个反引号都不能写，
 * 写了就会提前结束模板串、整份文件语法错误。所以注释里提到代码时只用撇号描述。
 */
const CLICK_SINGLE = `
/* ② 触发：一下。 */
const oneSel = 'text=下载明细'
const pickLast = btn === 'last'
try {
  const target = pickLast ? page.locator(oneSel).last() : page.locator(oneSel).first()
  await target.click({ timeout: 30000 })
} catch (e) {
  throw new Error('没点到「下载明细」（' + oneSel + '，取'
    /* ⚠️ 写成「最后」+「个」会拼出「最后个」——读着不通（「第一个」「最后一个」）。
     * 所以两种说法各写全，不做尾部拼接。 */
    + (pickLast ? '最后一个' : '第一个') + '）。'
    + '检查选择器是否还对得上那个按钮（页面改版常失效）。原始信息：'
    + String(e?.message ?? e).split('\\n')[0].slice(0, 100))
}
`

/**
 * ④b1：**两步点击**（交易 / 商品列表）→ 等下载 → 定名 → 落盘。
 *
 * 由 `composeDownload` 把「公共前半段 + 这两下 + 公共后半段」拼起来。
 * 所以它与 ④b2 **共用同一份落盘逻辑** —— 文件名规则只有一处，
 * 不会出现「两个分支落盘不一样」那种漂移。
 *
 * @param {string} dataRoot - 数据根目录（生成时写进脚本，测试会换成沙箱路径）。
 * @returns {string} 节点代码正文。
 */
export function downloadDropdown(dataRoot) {
  return composeDownload(CLICK_DROPDOWN, dataRoot)
}

/**
 * ④b2：**一次点击**（其余 5 个模块）→ 等下载 → 定名 → 落盘。
 *
 * 与 ④b1 只差点击那几行，其余逐字相同。
 *
 * @param {string} dataRoot - 数据根目录（生成时写进脚本，测试会换成沙箱路径）。
 * @returns {string} 节点代码正文。
 */
export function downloadSingle(dataRoot) {
  return composeDownload(CLICK_SINGLE, dataRoot)
}

/**
 * 循环B 的每轮末尾：本轮结果（含风控立即终止）——纯逻辑。
 *
 * ⚠️ **「连续失败」不在这里判**（循环体看不到历史，见下）。
 * 这里只做两件事：① 记本轮成败 ② **疑似验证页立即抛错**（照源码 `exit 2`）。
 *
 * ⚠️ **为什么「连续失败护栏」不在循环体里**（如实记）：
 * 循环体只看得到当前项，而「连续 2 次」需要知道前一轮。
 * 硬凑的话得让循环把上轮输出传给下轮 —— 那需要循环体之间有额外状态通道，
 * 我们没有（Dify 的 Iteration 也没有）。
 * 所以**真正的连续判断放在循环之后的汇总步骤**（`DY_SUMMARY`）——
 * 那里能拿到**全部轮次**，按顺序扫一遍就能数连续。
 */
export const DY_ROUND_GUARD = `
const item = {{item}}
const up = input && typeof input === 'object' ? input : {}
const inner = up.result !== undefined && up.result !== null && typeof up.result === 'object' ? up.result : up
const ok = inner.ok === true
/* ⚠️ 疑似验证页 → **立即终止**（照源码：绝不重试，等 24 小时）。 */
const title = String(inner.pageTitle ?? '')
if (/验证|安全|滑块/.test(title)) {
  throw new Error('页面疑似验证/风控页，立即终止（源码：退出码 2，绝不重试，等 24 小时）。标题=' + title)
}
return { ok, date: String(item.date), moduleName: item.module.name, failed: !ok, err: inner.err ?? null }
`

/**
 * 循环B 之后：汇总 + **连续失败护栏**（纯逻辑）。
 *
 * ⚠️ 这里才是「连续失败」的正确位置：循环的 `result` 给出**全部轮次**，
 * 按模块分组扫一遍即可。
 * ⚠️ 照源码：连续 2 次失败 → **停该模块**（不是终止整个流程）；
 * 而风控页那条在循环体里已经抛错了（终止整个流程）。
 */
export const DY_SUMMARY = `
/* 上游 = 外层循环的全部轮次（每轮里又含着内层那些日期轮次），递归找。
 *
 * ⚠️⚠️ **必须遍历所有键，不许只认 value / result**（2026-10-19 修的真 BUG）。
 *
 * 循环交给下游的形状是 \`{ count, results: [...] }\` —— 键名是 \`results\`。
 * 原先这里只递归 \`v.value\` 与 \`v.result\`，于是**一条都找不到**，
 * 总账永远报 total=0、连续失败护栏永远不触发（而且**不报错**，
 * 看起来像「这次全都成功了」）。
 *
 * 同一个坑在「模块清单」那段已经踩过一次（那里留下了「不挑键名」的注释），
 * 这里又踩了一次 —— 所以这条纪律写死在代码里：**按形状认，不按键名认**。 */
const rounds = []
const seen = new Set()
const walk = (v) => {
  if (v === null || v === undefined) return
  if (typeof v !== 'object') return
  /* 防环（正常 JSON 不会有，但上游是人拼的，保险）。 */
  if (seen.has(v)) return
  seen.add(v)
  if (Array.isArray(v)) { for (const x of v) walk(x); return }
  /* 认「轮次」：有 date 与 ok（这是 ④d 产出的形状）。 */
  if (v.date !== undefined && typeof v.ok === 'boolean') { rounds.push(v); return }
  /* ⚠️ 不挑键名 —— 所有值都往下走。 */
  for (const val of Object.values(v)) walk(val)
}
walk(input)

/* ⚠️ 连续失败护栏（照源码：连续 2 个日期失败 → 停该模块）。
 * 按模块分组扫 —— 同一模块连续才算连续。 */
const byModule = {}
for (const r of rounds) {
  const k = String(r.moduleName ?? '?')
  if (byModule[k] === undefined) byModule[k] = []
  byModule[k].push(r)
}
const stoppedModules = []
for (const [name, list] of Object.entries(byModule)) {
  let consecutive = 0
  for (const r of list) {
    if (r.failed === true) {
      consecutive++
      if (consecutive >= 2) { stoppedModules.push(name); break }
    } else {
      consecutive = 0
    }
  }
}
const okCount = rounds.filter((r) => r.ok === true).length
const failCount = rounds.filter((r) => r.ok !== true).length
/* 这一步自己说那句话（票 20 第三件，2026-10-27）。
 *
 * ## 为什么需要它
 *
 * 引擎对 code.js 的汇报原本只能报**形状**（「算出了对象，5 个键」），因为
 * 它不知道这段代码在算什么。用户点开任务记录要看到的是
 * 「采到 32 条，成功 30，失败 2」，不是「一个 5 个键的对象」。
 *
 * ## 约定（引擎 builtins.ts 的 ownReportOf）
 *
 * 输出里带 __report（非空字符串）就把它当汇报，并且从输出里摘掉
 * 再交给下游 —— 所以结果文件里不会多这个键。
 * ⚠️ 三条硬约束：
 *   ① 必须是字符串。对象形式的 __report 引擎不认，而且会原样留在输出里；
 *   ② 空串等于没写（退回形状描述）；
 *   ③ 只在最外层认，嵌在里层没人读。
 *
 * 句子里必须带业务量（条数 / 成功 / 失败），不许写成「汇总完成」那种空话。 */
const __report = '整平台：采到 ' + String(rounds.length) + ' 条，成功 ' + String(okCount)
  + ' 条，失败 ' + String(failCount) + ' 条'
  + (stoppedModules.length > 0
    ? '，' + String(stoppedModules.length) + ' 个模块被连续失败护栏停下'
    : '')
return {
  ok: failCount === 0,
  total: rounds.length, okCount, failCount,
  stoppedModules,
  note: stoppedModules.length > 0
    ? '这些模块出现「连续 2 日失败」，按源码护栏应提前停止：' + stoppedModules.join('、')
    : '',
  __report,
}
`
