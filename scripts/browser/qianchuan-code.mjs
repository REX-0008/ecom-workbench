/** 「取数-千川全域推广」工作流的各段代码（**单一来源**：生成器与测试都用）。
 *
 * ## 对应原脚本
 *
 * `D:\ecom-data\自动下载\src\douyin-ui.ts` 的千川那一段
 * （L224–473，`// ============ 千川全域推广` 到 `// ============ 主流程` 之前）。
 *
 * ## ★ 结构（三层嵌套循环）
 *
 * 源码是**三层**：主流程逐模块 → `qianchuanFlow` 里逐类型 → 逐 7 天分段。
 *
 * ```
 * ① 模块清单（2 个：推广 / 推广商品）
 * ② 循环 A：逐模块
 *      ②a 打开该模块页（goto）
 *      ②b 等页面渲染
 *      ②c 检查登录（千川未登录会跳登录域）
 *      ②d 点「素材」维度 radio（商品维度跳过）
 *      ②e 算 R 与本模块有哪几个类型
 *      ③ 循环 B：逐类型（嵌在 A 里）
 *           ③a 列该模块目录
 *           ③b 算 L / from / to / 分段
 *           ④ 循环 C：逐分段（嵌在 B 里）
 *                ④a 设区间（≤7天走快捷，>7天走日历点击）
 *                ④b 点类型 radio + 等表头切过去
 *                ④c 点下载并落盘
 *                ④d 本轮结果（含风控立即终止）
 *           ③c 类型间停顿（反爬）
 *      ②f 模块间停顿（反爬）
 * ⑤ 汇总（连续失败护栏）
 * ⑥ 写结果文件
 * ⑦ 结束
 * ```
 *
 * ⚠️ **为什么不把「模块 × 类型」压成一层**：源码的 `goto` 与「点素材 radio」
 * 在**类型循环之外**（一个模块只进一次页面）。压成一层就得每个类型重新打开页面，
 * 那是**改变行为**而不是简化结构。
 *
 * ## ⚠️ 循环变量怎么写（三层嵌套，`item` 只指最内层）
 *
 * | 写在哪一层 | 取本层用 | 往外一层 | 再往外 |
 * |---|---|---|---|
 * | 分段（最内） | `{{item.date}}` | `{{outer.item.type}}` | `{{outer.outer.item.name}}` |
 *
 * 本文件里我在**内层的每一层 item 上都塞了完整信息**（见 `QC_PLAN_TYPES` /
 * `QC_TYPE_PLAN`），所以绝大多数地方只用 `{{item.xxx}}` 就够 ——
 * 能用内层就别写 `outer.`：`outer.` 少一层能取、多一层报错，是纯负担。
 */

/** 千川全域推广的两个模块（照源码 `MODULES` 里 `qianchuan: true` 那两条，逐字搬）。 */
export const QC_MODULES = [
  {
    name: '推广',
    alias: 'promo',
    /* 素材维度：视频 / 图片两张表。 */
    product: false,
    folder: 'T-推广-素材-抖音',
    url: 'https://qianchuan.jinritemai.com/dataV2/bidding/site-promotion?aavid=0000000000000000&tabs=product&product-assist-task-type=1&product-material-type=video&product-material-search=&product-plan-aggregate-smart-bid-type=&product-task-search=&product-invest-order-platform=0&product-material-order-platform=0&mar-goal=2',
    picker: '.ovui-range-picker',
  },
  {
    name: '推广商品',
    alias: 'promoprod',
    /* 商品维度：默认 tab=product，**不需要点素材 radio**；只有「商品」一张表。 */
    product: true,
    folder: 'T-推广-商品-抖音',
    url: 'https://qianchuan.jinritemai.com/dataV2/bidding/site-promotion?aavid=0000000000000000&tabs=product&mar-goal=2',
    picker: '.ovui-range-picker',
  },
]

/** 素材维度的两个类型（照源码 `QC_TYPES`）。 */
export const QC_TYPES = ['视频', '图片']

/** 商品维度的类型（照源码 `QC_PRODUCT_TYPE`）。 */
export const QC_PRODUCT_TYPE = '商品'

/** 单段最大天数（照源码 `QC_MAX_SEG`，用户 2026-09-04 定案）。 */
export const QC_MAX_SEG = 7

/** 店铺名（照源码 `SHOP`，与罗盘那份同一个）。 */
export const QC_SHOP = 'DemoShop'

/**
 * ① 模块清单（`code.js`）。
 *
 * 两个千川模块**都在这份工作流里**（源码主流程按 `mod.qianchuan` 分给
 * `qianchuanFlow`）。它们与罗盘那 7 个模块走**完全不同的流程**
 * （区间滚动 vs 逐日），所以是两份工作流，不是一份里的分支。
 */
export const QC_STEP_MODULES = `
/* 两个千川模块：推广（素材维度：视频/图片）、推广商品（商品维度）。 */
const modules = ${JSON.stringify(QC_MODULES, null, 2)}
return { modules, count: modules.length, shop: ${JSON.stringify(QC_SHOP)} }
`

/**
 * ②c 检查登录（**页面内** eval）。
 *
 * 照源码 L383-393：千川未登录会跳登录域，URL 不再是 `site-promotion`。
 *
 * ## ⚠️ 与源码的一处不同（如实记）
 *
 * 源码是**等 5 分钟**（每 5 秒重新 goto 一次，登录了就继续）。
 * 我们这里**直接报错并告诉人去登录**，原因是：
 *   · 重新 goto 是「打开页面」那个节点的职责，这段 eval 没有 page 对象；
 *   · 我们的「重试」是**节点级**的（重跑同一个节点），重跑一段只读的 eval
 *     不会让页面变成已登录 —— 那会白等。
 *
 * 所以取的是「说清楚 + 立刻停」，而不是「静默等 5 分钟然后报一句超时」。
 * 用户重新跑一次即可（登录态是常驻的，刷新一次页面就好了）。
 */
export const QC_CHECK_LOGIN = `
/* 千川未登录 → 跳登录域，URL 里不再有 site-promotion。 */
const url = String(location.href)
if (!url.includes('site-promotion')) {
  return {
    ok: false,
    needLogin: true,
    url,
    err: '千川没登录（当前页面不是 site-promotion，而是 ' + url.slice(0, 80) + '）',
  }
}
return { ok: true, needLogin: false, url, title: document.title }
`

/**
 * ②d 点「素材」维度 radio（**页面内** eval）。
 *
 * 照源码 L397-401 + `qcClickRadio`（L265-273）逐句搬：
 * 找 `.ovui-radio-item` 里文本完全等于「素材」的那个；
 * 已激活（class 含 `--checked`）返回 `already`，找到就点、返回 `clicked`；
 * 找不到返回 `no 素材` —— 源码把它当**致命错**（页面改版）。
 *
 * ## ⚠️ 为什么每次导航后都要点
 *
 * 源码 L226 的实测结论：`goto` / 新窗口打开时页面状态回默认「商品」维度
 * 而 **URL query 不被读取恢复**。所以「URL 里写了 tabs=product」不代表
 * 页面就是那个维度 —— 必须点。
 *
 * 商品维度（`product: true`）**默认就是 tab=product**，不需要点，
 * 所以生成器把它略过（源码也是 `if (!mod.product)`）。
 */
export const QC_CLICK_DIM = `
/* 循环 A 的 item **就是模块对象**（items 指向 ① 的 modules 字段）。 */
const mod = {{item}}

/* ★ 商品维度**默认就是 tab=product**，不需要点（照源码 L397 的 if (!mod.product)）。
 *
 * ⚠️ 这里必须「脚本自己判」而不是「两个节点按分支走」：
 * 循环体是**一张图**，两个模块轮流跑同一串节点，而我们没有「按项跳过节点」的能力。
 * 这与罗盘那份的 shopTab 是同一个设计（数据层区分，图只有一张）。 */
if (mod.product === true) {
  return { ok: true, clicked: false, skipped: true, reason: '商品维度默认就是 tab=product，不用点', url: location.href, title: document.title }
}

/** 点 ovui-radio-item（照源码 qcClickRadio，逐句搬）。 */
const clickRadio = (t) => {
  const el = Array.from(document.querySelectorAll('.ovui-radio-item')).find((e) => (e.textContent || '').trim() === t)
  if (!el) return 'no ' + t
  if (String(el.className).includes('--checked')) return 'already'
  el.click()
  return 'clicked'
}
const r = clickRadio('素材')
/* 找不到「素材」= 页面改版，源码当致命错（不静默往下走）。 */
if (r.startsWith('no ')) {
  throw new Error('找不到「素材」维度按钮（页面可能改版）—— 千川的维度 radio 文案或结构变了')
}
return { ok: true, clicked: r === 'clicked', skipped: false, state: r, url: location.href, title: document.title }
`

/**
 * ②e 算 R 与本模块有哪几个类型（纯逻辑）。
 *
 * 照源码 L402-403：
 * ```
 * const R = mod.product ? ymd(new Date()) : ymd(new Date(Date.now() - 86400_000));
 * const types = mod.product ? [QC_PRODUCT_TYPE] : QC_TYPES;
 * ```
 * 也就是：**商品维度含今日**（今天的数据也算），**素材维度只到昨天**。
 *
 * 输出一个列表，每项自带模块信息 —— 这样内层只需要 `{{item.xxx}}`。
 */
export const QC_PLAN_TYPES = `
const item = {{item}}
const mod = item

/** 本地日期串 YYYY-MM-DD（与源码 ymd 同一套：本地时区，不用 UTC）。 */
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

/* ★ 商品维度**含今日**；素材维度**只到昨天**（照源码那行三元）。 */
const R = mod.product === true ? ymd(new Date()) : ymd(new Date(Date.now() - 86400000))
const types = mod.product === true ? ['商品'] : ['视频', '图片']

/* 每项都带上模块的全部信息（name/folder/url/product）——
 * 内层靠 {{item.module.folder}} 找目录、靠 {{item.module.name}} 记结果。 */
const rows = types.map((t) => ({
  module: mod,
  type: t,
  R,
  /* 「是否商品维度」直接摊成布尔，内层判起来不用点两下。 */
  product: mod.product === true,
}))

return { R, types, rows, count: rows.length, moduleName: mod.name }
`

/**
 * ③b 算 L / from / to / 分段（纯逻辑）。
 *
 * ## 照搬源码的三段
 *
 * ① `qcLastEndDate`（L241-252）：扫文件名里「类型 + 区间结束日」，取最大。
 * ② `qcSegRange`（L256-262）：`[from,to]` 按 7 天切段（闭区间、升序）。
 * ③ 起点终点（L405-410）：`from = --from || nextDay(L)`、`to = --to || R`。
 *
 * ## ⚠️⚠️ 幂等按「**类型 + 区间结束日**」，**不按完整文件名**
 *
 * 源码 L230-231 专门为这条写了注释：
 * > 下载 = 直接 download 事件（非异步任务），**文件名尾部 id 每次都变** →
 * > 幂等按「类型+区间结束日」判断，不按完整文件名
 *
 * 所以判据是 `正则抠出区间结束日`，而不是「这个名字有没有存在过」。
 * 改成按完整文件名比，症状是**每天重下一遍**（名字每次都不样，永远判「没有」），
 * `tests/qianchuan-logic.mjs` 有一条断言钉着它。
 *
 * ## 文件名长什么样（从源码正则反推，别凭记忆）
 *
 *   素材维度：`全域推广数据-视频-2026-10-01 10_30_00-2026-10-07.xlsx`
 *   商品维度：`全域推广数据_商品_2026-10-01 10_30_00-2026-10-07.xlsx`
 *
 * 分隔符**不一样**（`-` vs `_`），源码用 `sep` 变量处理。落盘时前缀是
 * `DemoShop-20261007-`，所以完整名里既有 `-` 也有 `_` —— 正则只锚
 * `全域推广数据` 后面那一段，不管前面的店铺前缀。
 *
 * ## 入参
 *
 * ① ③a 列目录的输出（`code.shell`，裸 JSON 文本）
 * ② 本层的循环项 `{{item}}`（含 `module` / `type` / `R` / `product`）
 *
 * ## 出参
 *
 * `{ module, type, L, from, to, segs, segCount, skipWhy }`
 *   · `segs` 每项 `{ from, to, quick }` —— 内层循环遍历它；
 *   · `quick: true` 表示这一段可以用面板快捷「最近7天」（≤7 天且贴着 R）。
 */
export const QC_TYPE_PLAN = `
const item = {{item}}
const mod = item.module
const type = String(item.type)
const R = String(item.R)

/* ── 上游：code.shell 给的是一行 JSON 文本（与真执行方一致：纯文本，不解析）── */
const arr = Array.isArray(input) ? input : [input]
/** 把一条上游值归一成 { files } 形状；认不出来返回 null。 */
const un = (v) => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const lines = v.trim().split(/\\r?\\n/).filter((l) => l.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i])
        if (o !== null && typeof o === 'object') return Array.isArray(o.files) ? o : null
      } catch { /* 往前找 */ }
    }
    return null
  }
  if (typeof v !== 'object') return null
  if (Array.isArray(v.files)) return v
  if (v.result !== null && typeof v.result === 'object') return un(v.result)
  return null
}
let listed = null
for (const raw of arr) {
  const v = un(raw)
  if (v !== null) listed = v
}
if (listed === null) throw new Error('拿不到目录清单（列目录那步失败？）')

/* ── ① 现有数据到哪天（照源码 qcLastEndDate，逐句搬） ──
 *
 * ⚠️ 分组 2 才是「区间结束日」；分组 1 是导出时刻的日期（没用）。
 *
 * ⚠️⚠️ 分隔符那三个位置**照源码逐字排**，不是「sep 重复三遍」：
 *     「全域推广数据」 + sep + 类型 + (sep 是下划线就下划线、否则横线) + 日期
 *   即素材维度是「全域推广数据-视频-2026-…」（两个横线），
 *   商品维度是「全域推广数据_商品_2026-…」（两个下划线）。
 *   我第一版多写了一个 sep，拼出「全域推广数据-视频--」，于是**永远匹配不上** ——
 *   症状是 L 恒为空、每天都在「没有现有数据」的状态下重下。 */
const sep = type === '商品' ? '_' : '-'
const re = new RegExp(
  '全域推广数据' + sep + type + (sep === '_' ? '_' : '-')
  + '(\\\\d{4}-\\\\d{2}-\\\\d{2}) \\\\d{2}_\\\\d{2}_\\\\d{2}-(\\\\d{4}-\\\\d{2}-\\\\d{2})',
)
const ends = []
for (const f of listed.files) {
  const m = String(f).match(re)
  if (m) ends.push(m[2])
}
ends.sort()
const L = ends.length === 0 ? '' : ends[ends.length - 1]

/* ── ② 起点终点（照源码 L405-410：填了用填的，没填才自动推算） ── */
/** 日期串 + n 天。 */
const addDays = (s, n) => {
  const d = new Date(s + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
/** 开始节点的可选参数（写在引号里 —— 没有开始节点时它们是原样保留的占位符）。 */
const pickArg = (raw) => {
  const s = String(raw ?? '').trim()
  if (s === '' || s.split('{{').length > 1) return ''
  return s
}
const fromArg = pickArg("{{from}}")
const toArg = pickArg("{{to}}")

let skipWhy = ''
let from = fromArg !== '' ? fromArg : (L === '' ? '' : addDays(L, 1))
const to = toArg !== '' ? toArg : R
if (L !== '' && L >= to) {
  /* 已有数据已经覆盖到目标截止日 → 无需补（正常情况，不是错误）。 */
  skipWhy = '已有数据到 ' + L + '，已覆盖到 ' + to
  from = ''
}
if (from === '' && skipWhy === '') skipWhy = '没有现有数据且没指定 from（无法确定起点）'

/* ── ③ 按 7 天切段（照源码 qcSegRange，逐句搬：闭区间、升序） ──
 *
 * ★ **每一段都自带 module / type**（不只是 from/to/quick）。
 *
 * 为什么：最内层循环的 item 只指那一段。若段里只有 from/to/quick，
 * 那么「拼落盘目录」「记结果里的类型名」就得写 outer.item.type、
 * outer.outer.item.name —— 层数一多，写错就**静默取到 undefined**。
 * 把完整信息塞进最内层，内层一律只写 item.xxx，没有层数可数错。 */
const segs = []
if (skipWhy === '') {
  if (from > to) {
    /* from > to 也是「无需补」。 */
  } else {
    let s = from
    while (s <= to) {
      const e0 = addDays(s, 6)
      const e = e0 > to ? to : e0
      segs.push({ module: mod, type, R, from: s, to: e, quick: false })
      s = addDays(e, 1)
    }
  }
}

/* ★ 快捷判据**照源码 L418 那一整个条件**，逐字对：
 *
 *     segs.length === 1 && s >= qcAddDays(R, -6) && e === R
 *
 * ⚠️⚠️ 注意比的是 **R（最近已结算日）**，不是 to。
 * 我第一版写成 e === to，两者在「没填 --to」时相等（所以测试前半段全绿），
 * 但**一旦填了回填区间**（to 早于 R）就分叉了：那时 e === to 仍成立 →
 * 一小段老区间被误判成「就是最近7天」→ 走快捷 = 下的是 R-6~R，
 * **完全不是用户要的那个区间**，而且不报错。
 *
 * 「是不是最近 7 天」这件事与「这次补到哪天」无关 —— 它只取决于 R。
 *
 * 三个条件缺一不可：分段的最后一段天然贴着 to，若只看后两个、或只看 to，
 * 多段时最后那段也会走快捷。 */
if (segs.length === 1) {
  const only = segs[0]
  only.quick = (only.from >= addDays(R, -6) && only.to === R)
}

return {
  module: mod,
  type, L,
  from: from === '' ? '' : from,
  to,
  segs,
  segCount: segs.length,
  /* 给用户看的：这一批走的是快捷还是日历（源码 dry-run 时也打印这个）。 */
  mode: segs.length === 1 && segs[0].quick === true ? '快捷最近7天' : '日历点击',
  skipWhy,
  folder: mod.folder,
}
`

/**
 * ④a 设区间（**页面内** eval）。
 *
 * ## ⚠️ 这一段是**逐句照搬** `qcSetRange`（源码 L314-337）与 `qcClickShortcut`（L276-289）
 *
 * 任务书硬要求：「这是唯一验证过能设日期的版本，别自己重写」。
 * 所以下面的点格子、翻月、校验 input 值，全部照抄，包括：
 *   · 翻月最多 30 次（`i < 30`），翻不动就 `month unreachable`；
 *   · 点完格子等 500ms、点完终点等 2500ms；
 *   · **设完要校验输入框的值**（`vals[1] === from && vals[2] === to`）——
 *     不校验就会出现「以为设了、其实没设」的静默错，然后下错区间。
 *
 * ## 两条路（源码 L418-424）
 *
 * · `item.quick === true` → 点面板快捷「最近7天」（= R-6~R），**不点格子**；
 * · 否则 → 日历格子点击设任意区间。
 *
 * 为什么要有快捷这条：源码 L229 记着「时间设置 = 面板快捷「最近7天」或日历格子点击」，
 * 快捷是**正常日常增量**那条路（缺口 ≤7 天），格子是**断档补**那条路。
 */
export const QC_SET_RANGE = `
const item = {{item}}
const from = String(item.from)
const to = String(item.to)
const quick = item.quick === true
const root = '.ovui-range-picker'

/* ── 打开日期面板（两条路都要） ── */
const inputs = document.querySelectorAll(root + ' input')
if (inputs.length < 2) {
  throw new Error('找不到日期范围输入框（' + root + ' input）—— 页面可能没加载完或改版了')
}
inputs[1].click()
await new Promise((r) => setTimeout(r, 1000))

/** 面板是否已弹出。 */
const popper = () => document.querySelector(root + '__popper--show')

/* ══ 路一：快捷「最近7天」 ══ */
if (quick) {
  const p = popper()
  if (!p) throw new Error('日期面板没弹出（点开输入框后看不到 popper）')
  const el = Array.from(p.querySelectorAll('*')).find((e) => (e.textContent || '').trim() === '最近7天' && e.children.length === 0)
  if (!el) throw new Error('面板上找不到「最近7天」这个快捷项（文案变了？）')
  el.click()
  await new Promise((r) => setTimeout(r, 3000))
  return { ok: true, mode: 'shortcut', from, to, title: document.title }
}

/* ══ 路二：日历格子点击（照源码 qcSetRange 逐句搬） ══ */
const labelOf = (d) => { const p2 = d.split('-'); return p2[0] + '年' + Number(p2[1]) + '月' }

/** 点面板里某年月某日的格子（照源码 qcClickCell）。 */
const clickCell = (ds) => {
  const p = popper()
  if (!p) return 'no popper'
  const parts = ds.split('-')
  const label = parts[0] + '年' + Number(parts[1]) + '月'
  const panels = Array.from(p.querySelectorAll('.ovui-panel-date'))
  for (const panel of panels) {
    const head = panel.querySelector('.ovui-date__header-label')
    const shown = head ? (head.textContent || '').trim() : ''
    if (shown !== label) continue
    const cells = Array.from(panel.querySelectorAll('td.ovui-date__cell'))
    const td = cells.find((t) => {
      if (/disabled|prev|next/i.test(String(t.className))) return false
      const span = t.querySelector('.ovui-date__cell-inner')
      return span && (span.textContent || '').trim() === String(Number(parts[2]))
    })
    if (!td) return 'no cell ' + ds
    const inner = td.querySelector('.ovui-date__cell-inner')
    ;(inner || td).click()
    return 'clicked'
  }
  return 'no panel ' + label
}

/** 年月标签 → YYYY-MM（照源码那个内联 ym）。 */
const ymOf = (label) => {
  const m = String(label).match(/(\\d{4})年(\\d{1,2})月/)
  return m ? m[1] + '-' + String(Number(m[2])).padStart(2, '0') : ''
}

for (let i = 0; i < 30; i++) {
  const p = popper()
  if (!p) throw new Error('日期面板没弹出（翻月过程中消失）')
  const shown = Array.from(document.querySelectorAll(root + '__popper--show .ovui-date__header-label')).map((e) => (e.textContent || '').trim())
  if (shown.length === 0) throw new Error('面板里没有年月标题（结构变了？）')
  /* 两个月的标题都在了 → 起止都在可视范围里，可以点格子。 */
  if (shown.includes(labelOf(from)) && shown.includes(labelOf(to))) break
  const left = ymOf(shown[0])
  const right = ymOf(shown[shown.length - 1])
  if (from.slice(0, 7) < left) {
    const btn = document.querySelector(root + '__popper--show .ovui-date__header-prev-month')
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  } else if (to.slice(0, 7) > right) {
    const btn = document.querySelector(root + '__popper--show .ovui-date__header-next-month')
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  } else {
    /* 翻不动（区间跨度超过面板能显示的范围）—— 源码返回 month unreachable。 */
    throw new Error('翻不到要的月份（面板显示 ' + shown.join('/') + '，要 ' + labelOf(from) + '~' + labelOf(to) + '）')
  }
  await new Promise((r) => setTimeout(r, 400))
}

const c1 = clickCell(from)
if (c1 !== 'clicked') throw new Error('起点格子点不到（' + from + '）：' + c1)
await new Promise((r) => setTimeout(r, 500))
const c2 = clickCell(to)
if (c2 !== 'clicked') throw new Error('终点格子点不到（' + to + '）：' + c2)
await new Promise((r) => setTimeout(r, 2500))

/* ★ 校验：设完必须回读输入框的值（源码同款）。不校验 = 静默下错区间。 */
const vals = Array.from(document.querySelectorAll(root + ' input')).map((el) => el.value)
if (!(vals[1] === from && vals[2] === to)) {
  throw new Error('区间没设上：输入框回读是 ' + vals[1] + '~' + vals[2] + '，目标是 ' + from + '~' + to)
}
return { ok: true, mode: 'calendar', from, to, title: document.title }
`

/**
 * ④b 点类型 radio + 等表头切过去（**页面内** eval）。
 *
 * 照源码 L426-440：点「视频 / 图片 / 商品」radio；点了之后**等表头出现那个词**
 * （最多 15 秒），因为切换是异步的，不等就会拿到**上一类型**的表。
 *
 * ## ⚠️ 为什么「已激活」也要往下走
 *
 * `qcClickRadio` 可能返回 `already`（这一类型本来就是选中的）。源码此时
 * **不检查表头**（`if (tr === 'clicked')` 才等）—— 因为没切换就没有竞态。
 * 这里照抄这个条件，别「顺手都等」：多等 15 秒是白等。
 *
 * ⚠️ 但**点不到**（`no <类型>`）是致命错（页面改版），不静默。
 */
export const QC_PICK_TYPE = `
const item = {{item}}
const type = String(item.type)

/** 点 ovui-radio-item（照源码 qcClickRadio，逐句搬）。 */
const clickRadio = (t) => {
  const el = Array.from(document.querySelectorAll('.ovui-radio-item')).find((e) => (e.textContent || '').trim() === t)
  if (!el) return 'no ' + t
  if (String(el.className).includes('--checked')) return 'already'
  el.click()
  return 'clicked'
}

const r = clickRadio(type)
if (r.startsWith('no ')) {
  throw new Error('找不到类型按钮「' + type + '」（页面可能改版）')
}
if (r === 'already') {
  /* 本来就是选中的 → 没有切换竞态，不用等表头（照源码只对 clicked 才等）。 */
  return { ok: true, state: r, waited: false, type, title: document.title }
}

/* 点了 → 等表头切到目标类型（最多 15 秒）。不等就会拿到上一类型的表。 */
const deadline = Date.now() + 15000
let header = ''
for (;;) {
  const th = document.querySelector('th')
  header = th ? (th.textContent || '').trim() : ''
  if (header.includes(type)) return { ok: true, state: r, waited: true, header, type, title: document.title }
  if (Date.now() >= deadline) break
  await new Promise((res) => setTimeout(res, 1000))
}
throw new Error('表头没切到「' + type + '」（等了 15 秒，当前表头是「' + header + '」）—— 页面切换超时')
`

/**
 * ④c 点下载并落盘（**驱动层** eval）—— 一个节点做完。
 *
 * ## 为什么是驱动层
 *
 * 要 `page.waitForEvent('download')`、要 `saveAs`、要查文件存不存在 ——
 * 这三件事页面内脚本都做不到（页面里没有临时文件）。
 * 判据同抖音那份：脚本里出现 `page.` 就判成驱动层（`driver.mjs` 的
 * `looksLikeDriverScript`）。
 *
 * ## 照搬源码 `qcDownload`（L340-375）的四处
 *
 * ① **先挂监听再点**（`waitForEvent` 先拿到 Promise，不 await）；
 * ② **自适应回退**：主类名 `.qc-report-download-btn` 没了就用 `[class*="report-download"]`；
 * ③ **文件名类型校验**：导出名必须含 `全域推广数据` 且含类型词，否则**不落盘**直接报错；
 *    落盘名 = `DemoShop-{YYYYMMDD}-{导出原名}`；
 * ④ **同名不覆盖**：`existsSync` 就先 `cancel()` 再返回「已存在跳过」。
 *
 * ## ⚠️ 一处与源码不同（如实记）
 *
 * 源码在 `saveAs` 被取消（`canceled|ENOENT`）时判「效果未知」，
 * 隔 5 秒**整段重跑一次**（限 1 次）。这里不做：那个重跑要重新点下载按钮、
 * 重新等事件，而我们现在有**节点级重试**（`retry` 参数，见 t19）——
 * 重跑整个节点等价且更简单。所以这里只把「未知」如实报成失败原因，
 * 让节点的失败策略去决定重不重试。
 *
 * @param {string} dataRoot - 数据根目录（生成时写死进脚本，测试会换成沙箱路径）。
 * @returns {string} 节点代码正文。
 */
export function qcDownload(dataRoot) {
  return `
const item = {{item}}
const mod = item.module
const type = String(item.type)
const endYmd = String(item.to)
if (endYmd === '') throw new Error('拿不到本段结束日（循环变量没注入？）')

/* 驱动层才拿得到 node 的 fs / path（页面层做不到）。 */
const fs = await import('node:fs')
const ps = await import('node:path')
const root = ${JSON.stringify(String(dataRoot))}
const dir = ps.join(root, String(mod.folder ?? ''))
fs.mkdirSync(dir, { recursive: true })

/* ① 先挂监听（官方要求的顺序：先挂、后点；中间不 await）。
 * 必须先接住失败 —— 否则点击那步先抛错时它会变成未处理的 rejection，进程直接崩。 */
const WAIT_MS = 60000
const waiter = page.waitForEvent('download', { timeout: WAIT_MS })
waiter.catch(() => {})

/* ② 点下载按钮（照源码：主类名没了就子串兜底；降级要记一笔，那是改版信号）。 */
const btnState = await page.evaluate(() => {
  const primaryAlive = document.querySelector('.qc-report-download-btn') !== null
  const b = document.querySelector('.qc-report-download-btn button') || document.querySelector('[class*="report-download"] button')
  if (!b) return 'no button'
  b.click()
  return primaryAlive ? 'clicked' : 'clicked:fallback'
})
if (btnState === 'no button') {
  throw new Error('找不到下载按钮（\.qc-report-download-btn button 与子串兜底都没命中）—— 页面可能改版了')
}

/* ③ 等下载事件。 */
let dl
try {
  dl = await waiter
} catch (e) {
  throw new Error('点了下载后 ' + String(WAIT_MS) + ' 毫秒内没有开始下载（可能弹了验证 / 改版）。'
    + '类型=' + type + '，区间到=' + endYmd + '。原始信息：' + String(e?.message ?? e).slice(0, 120))
}

/* ④ 导出名要含「全域推广数据」且含类型词 —— 不含就说明下错表了，不许落盘。 */
const suggested = String(dl.suggestedFilename() ?? '').replace(/[\\\\/:*?"<>|]/g, '_')
if (!/全域推广数据[-_]/.test(suggested) || !suggested.includes(type)) {
  try { await dl.cancel() } catch { /* ignore */ }
  throw new Error('导出文件名类型不符（期望含「全域推广数据」与「' + type + '」）：' + suggested.slice(0, 60))
}

/* ⑤ 落盘名照源码：{店铺}-{区间结束日}-{导出原名}。 */
const fn = ${JSON.stringify(QC_SHOP)} + '-' + endYmd.replace(/-/g, '') + '-' + suggested
const file = ps.join(dir, fn)

/* ★ 同名不覆盖：已经有了就取消这次下载（源码同款「已存在跳过」）。 */
if (fs.existsSync(file)) {
  try { await dl.cancel() } catch { /* ignore */ }
  return {
    ok: true, skipped: true,
    path: file, fileName: fn, dir, type, endYmd,
    moduleName: String(mod.name ?? ''), endDate: endYmd,
    btnState,
    pageTitle: await page.title(),
    msg: '已存在跳过',
  }
}

/* ⑥ 落盘：必须在同一进程里立刻做（CDP 远程连接下临时文件随上下文消失）。 */
try {
  await dl.saveAs(file)
} catch (e) {
  throw new Error('文件没能存到 ' + file + '。那个目录不允许写？原始信息：' + String(e?.message ?? e).slice(0, 120))
}

/* ⑦ 落盘校验：下载中途被拦会留下残缺文件，当成功会污染下游。 */
const failure = await dl.failure()
if (failure !== null && failure !== undefined) {
  throw new Error('下载失败：' + String(failure) + '，文件可能不完整：' + file)
}

let size = 0
try { size = fs.statSync(file).size } catch { /* ignore */ }

return {
  ok: true, skipped: false,
  path: file, fileName: fn, dir, size,
  type, endYmd,
  moduleName: String(mod.name ?? ''),
  /* 冗余两个名字，让下游与本段的意图在日志里都看得见（幂等按 endDate 判）。 */
  endDate: endYmd,
  btnState,
  pageTitle: await page.title(),
}
`
}

/**
 * ④d 本轮结果（纯逻辑，含**风控立即终止**）。
 *
 * 照源码 L445-450：
 * ```
 * if (consecutiveFails >= 2) {
 *   const title = await page.title()
 *   if (/验证|安全|滑块/.test(title)) { 立即终止（退出码 2，绝不重试，等 24 小时） }
 *   logErr(`${type}: 连续 2 段失败，停止该类型`); break
 * }
 * ```
 *
 * 两件事分开：**连续次数**归循环（`maxConsecutiveFailures=2`），
 * **验证页立即终止**归这里（它是一次性判据，不需要历史）。
 *
 * ⚠️ 「跳过（已存在）」必须算**成功**：源码 `qcDownload` 里它返回
 * `{ ok: true, msg: '已存在跳过' }`，`consecutiveFails` 会清零。
 */
export const QC_ROUND_GUARD = `
const item = {{item}}
const up = input && typeof input === 'object' ? input : {}
const inner = up.result !== undefined && up.result !== null && typeof up.result === 'object' ? up.result : up
const ok = inner.ok === true

/* ⚠️ 疑似验证页 → **立即终止**（照源码：绝不重试，等 24 小时）。 */
const title = String(inner.pageTitle ?? '')
if (/验证|安全|滑块/.test(title)) {
  throw new Error('页面疑似验证/风控页，立即终止（源码：退出码 2，绝不重试，等 24 小时）。标题=' + title)
}

return {
  ok,
  /* 把成败与「跳过」都带下去（下游汇总靠这两个数）。 */
  skipped: inner.skipped === true,
  type: String(item.type),
  moduleName: String(item.module && item.module.name ? item.module.name : ''),
  /* ★ 幂等判据用的就是它（类型 + 区间结束日），结果里也留着，事后好对账。 */
  endDate: String(item.to),
  from: String(item.from),
  path: inner.path ?? null,
  fileName: inner.fileName ?? null,
  size: inner.size ?? 0,
  failed: !ok,
  err: inner.err ?? null,
}
`

/**
 * ⑤ 汇总（纯逻辑）：总账 + 按类型分组。
 *
 * ## ⚠️ 与抖音那份的两条区别
 *
 * 1. **不按模块判「连续失败」** —— 源码千川的连续判据是「连续 2 **段**」，
 *    而这个循环已经用 `maxConsecutiveFailures=2` 在**分段那一层**做掉了。
 *    这一层再判一遍会重复（而且会误杀：两个不同的段本来就不该算「连续」）。
 * 2. 额外报出「跳过的段数」—— 幂等命中是**正常情况**，不该混进失败数里。
 *
 * ⚠️ 递归必须**遍历所有键**，不能只认 `value` / `result`：
 * 引擎给循环下游的形状是 `{ count, results: [...] }`，键名是 `results`。
 * （这个坑在抖音那份踩过两次，见 `douyin-code.mjs` 的 `DY_SUMMARY`。）
 */
export const QC_SUMMARY = `
/* 上游 = 最外层循环的全部轮次（每轮里还嵌着两层循环），递归找。 */
const rounds = []
const seen = new Set()
const walk = (v) => {
  if (v === null || v === undefined) return
  if (typeof v !== 'object') return
  if (seen.has(v)) return
  seen.add(v)
  if (Array.isArray(v)) { for (const x of v) walk(x); return }
  /* 认「轮次」：有 endDate 与 ok（这是 ④d 产出的形状）。 */
  if (v.endDate !== undefined && typeof v.ok === 'boolean') { rounds.push(v); return }
  /* ⚠️ 不挑键名 —— 所有值都往下走。 */
  for (const val of Object.values(v)) walk(val)
}
walk(input)

const okCount = rounds.filter((r) => r.ok === true && r.skipped !== true).length
const skipCount = rounds.filter((r) => r.skipped === true).length
const failCount = rounds.filter((r) => r.ok !== true).length

/* 按类型分账（给用户看「哪张表补了几段、失败几段」）。 */
const byType = {}
for (const r of rounds) {
  const k = String(r.type ?? '?')
  if (byType[k] === undefined) byType[k] = { ok: 0, skipped: 0, failed: 0 }
  if (r.ok !== true) byType[k].failed++
  else if (r.skipped === true) byType[k].skipped++
  else byType[k].ok++
}

/* 这一步自己说那句话（票 20 第三件，2026-10-27）。
 *
 * ## 为什么需要它
 *
 * 引擎对 code.js 的汇报原本只能报**形状**（「算出了对象，7 个键」），因为它
 * 不知道这段代码在算什么。用户点开任务记录要看到的是
 * 「采到 32 段，成功 30，跳过 1，失败 1」，不是「一个 7 个键的对象」。
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
 * 句子里必须带业务量（段数 / 成功 / 跳过 / 失败），不许写成「汇总完成」那种空话。
 * 千川的量词用「段」不用「条」：它的单位是「一段日期区间」，与抖音的「一天」不是一回事。 */
const __report = '整平台：采到 ' + String(rounds.length) + ' 段，成功 ' + String(okCount)
  + ' 段，跳过 ' + String(skipCount) + ' 段，失败 ' + String(failCount) + ' 段'
return {
  ok: failCount === 0,
  total: rounds.length,
  okCount,
  skipCount,
  failCount,
  byType,
  note: failCount > 0
    ? '有 ' + String(failCount) + ' 段失败（详见日志）'
    : '',
  __report,
}
`
