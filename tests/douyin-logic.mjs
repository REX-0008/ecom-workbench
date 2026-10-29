/** 离线验「抖音表单下载」的纯逻辑（不开任何页面）。
 *
 * 用户红线：不开抖音页面。所以只跑纯函数：
 *   · `DY_STEP_MODULES`（模块配置）
 *   · `DY_MODULE_DATES`（算 L，并算出**这个模块**要补哪些日期）
 *   · `DY_SET_DATE` / `DY_FILENAME`（循环体内的两段 —— **要模拟变量替换**）
 *   · `DY_SUMMARY`（连续失败护栏 + 总账）
 *
 * ## ⚠️ 2026-10-19 结构改动后，这里少了一段
 *
 * 原来还有 `DY_BUILD_PAIRS`（把 7 个模块的日期**全算完展平**成一张列表）。
 * 用户指出那样「先全部排查、再统一下载」前后脱节，改成**两层嵌套**：
 * 每个模块在自己那一轮里算自己的日期、紧接着逐日下载。
 * 于是展平那一步**不需要存在**，「每个模块补哪几天」这个判断并进了
 * `DY_MODULE_DATES`（见 ② 的 `dates` 断言）。
 *
 * ## ⚠️ 本测试的一个关键手法：**模拟 `{{item}}` 替换**
 *
 * 循环变量在真机上经**变量替换**注入（`const item = {{item}}` → `const item = {...}`）。
 * 测试里没有引擎，所以我把 `{{item}}` **自己换成 JSON** —— 这恰好也是
 * 变量替换真实做的事（`toText` 对对象 `JSON.stringify`）。
 * 于是这些循环体代码**能被离线验**（不必起引擎、不必开页面）。
 *
 * 跑完即删（验过后收成常驻测试）。
 */
import {
  DY_STEP_MODULES, DY_READ_R, DY_SHOP_TAB, DY_MODULE_DATES, DY_SET_DATE, DY_FILENAME, DY_SUMMARY, DY_ROUND_GUARD, DY_SHOP,
} from '../scripts/browser/douyin-code.mjs'

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}
/**
 * 跑一段代码，**并模拟变量替换**（把 `{{item}}` / `{{item.xxx}}` / 开始节点的输入换成值）。
 *
 * @param code - 代码段。
 * @param input - 上游数据。
 * @param item - 循环项（不给就说明这段不在循环里）。
 * @param win - `window` 桩（**页面内脚本要用**，见下）。
 * @param vars - 开始节点声明的输入（`{modules, from, to}`）。
 *   ⚠️ **不给就模拟「这份工作流没有开始节点」** —— 那时引擎把 `{{名字}}` 原样留着，
 *   脚本必须自己扛住（见 `DY_STEP_MODULES` 里那段「变量要写在引号里」的说明）。
 * @returns 返回值。
 */
async function run(code, input, item, win, vars) {
  let src = code
  if (item !== undefined) {
    /* 与引擎的 toText 同语义：对象 → JSON（那是合法 JS 字面量）。 */
    const asText = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))
    src = src.split('{{item}}').join(asText(item))
    /* 点号路径也支持（{{item.url}} 之类）。 */
    for (const m of [...src.matchAll(/\{\{item\.([\w.]+)\}\}/g)]) {
      const path = m[1].split('.')
      let cur = item
      for (const seg of path) cur = cur === undefined || cur === null ? undefined : cur[seg]
      src = src.split(m[0]).join(asText(cur))
    }
  }
  /* 开始节点的输入：与引擎同一套（`substituteText` → `toText`，对象转 JSON）。 */
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      src = src.split('{{' + k + '}}').join(typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''))
    }
  }
  if (/\{\{item/.test(src)) {
    throw new Error('测试里没替换干净的循环变量：' + String(src.match(/\{\{item[^}]*\}\}/)?.[0]))
  }
  /* ⚠️ 只认**像占位符的**（`{{名字}}`，里面是字母或点），
   * 不能见到 `{{` 就报 —— 脚本里有 `raw.split('{{')` 这种**字面量**，
   * 那不是占位符（第一版这么写，好好的代码被误判成没替换干净）。 */
  if (vars !== undefined) {
    const left = src.match(/\{\{[A-Za-z_][\w.]*\}\}/)
    if (left !== null) throw new Error('测试里没替换干净的占位符：' + left[0])
  }
  /* ⚠️ 有的段是**页面内脚本**（要 `window` / `location` / `document`）——
   * 真机上它们跑在浏览器里，而这里在 Node 跑。所以给一个**桩**。
   * 桩只提供「有没有」与最少方法；**不给**的东西正好用来验「明确报错」。 */
  const args = win === undefined ? ['input'] : ['input', 'window', 'document', 'location']
  const fn = new Function(...args, '"use strict";return (async () => {' + src + '})()')
  if (win === undefined) return await fn(input)
  return await fn(input, win, win.document, win.location)
}

/* ── ① 模块配置 ── */
console.log('=== ① 模块配置（照源码 MODULES）===')
{
  const r = await run(DY_STEP_MODULES, undefined)
  console.log('  模块: ' + r.modules.map(m => m.name).join(' / '))
  check('★ 7 个罗盘模块（源码 9 个减去 2 个千川）', r.count === 7, String(r.count))
  check('★ 商品卡**不在**（源码：2026-09-12 已停用）', !r.modules.some(m => m.name === '商品卡'))
  check('★ 千川那 2 个不在（它们走另一套流程）',
    !r.modules.some(m => m.name === '推广' || m.name === '推广商品'))
  check('短视频拆成自营/合作两条', r.modules.filter(m => m.name.startsWith('短视频')).length === 2)
  check('每条都有 url / picker / folder / btn',
    r.modules.every(m => m.url && m.picker && m.folder && m.btn))
  check('店铺名对', r.shop === DY_SHOP, r.shop)
  /* ★ URL / picker / folder **逐条对源码** `douyin-ui.ts:37-52`（2026-10-16 加）。
   *
   * 为什么值得单列一条：真机上踩过一次「配置里一个字段写错」——
   * 搜索那条 URL 少了 `/search` 一段，于是打开的是别的页面，
   * 循环 A 跑到第 6 个模块报「找不到日期控件」中断。前 5 个全绿，
   * 靠肉眼看配置是发现不了的（`shop/drainage-terms` 看着完全合理）。
   *
   * ⚠️ 下面这 7 条是**从源码抄下来的**（不是从我们的配置抄的）——
   * 这才叫「对规格」；从自己的配置抄一遍等于什么也没验。 */
  const SRC = {
    '交易': ['https://compass.jinritemai.com/shop/business-part', '.aurora-dorami-date-picker-wrapper', 'D-店铺-整体-抖音'],
    '直播': ['https://compass.jinritemai.com/shop/live-overview', '.aurora-dorami-date-picker-wrapper', 'D-店铺-直播-抖音'],
    '短视频-自营': ['https://compass.jinritemai.com/shop/video/overview', '.aurora-dorami-date-picker-wrapper', 'D-店铺-视频-抖音'],
    '短视频-合作': ['https://compass.jinritemai.com/shop/video/overview', '.aurora-dorami-date-picker-wrapper', 'D-店铺-视频-抖音'],
    '图文': ['https://compass.jinritemai.com/shop/graphic/graphic-analysis', '.aurora-dorami-date-picker-wrapper', 'D-店铺-图文-抖音'],
    '搜索': ['https://compass.jinritemai.com/shop/search/drainage-terms', '.ecom-dorami-date-picker-wrapper', 'D-店铺-搜索-抖音'],
    '商品列表': ['https://compass.jinritemai.com/shop/commodity/product-list', '.aurora-dorami-date-picker-wrapper', 'S-商品-整体-抖音'],
  }
  const wrong = r.modules.filter((m) => {
    const s = SRC[m.name]
    return s === undefined || s[0] !== m.url || s[1] !== m.picker || s[2] !== m.folder
  })
  check('★ 7 个模块的 url / picker / folder 逐条等于源码（douyin-ui.ts:37-52）',
    wrong.length === 0 && Object.keys(SRC).length === r.modules.length,
    wrong.length === 0 ? '' : wrong.map((m) => m.name + '=' + m.url).join(' / '))

  /* ⚠️ 短视频那两条要有 nameFilter 与 fileSuffix（源码有）。 */
  const vs = r.modules.find(m => m.name === '短视频-自营')
  check('短视频-自营 有 nameFilter/fileSuffix/videoTag',
    vs.nameFilter === '自营' && vs.fileSuffix === '-自营' && vs.videoTag === '自营', JSON.stringify(vs))

  /* ★★ 开始节点的 modules 参数（2026-10-19 加）。
   *
   * 这里钉的核心是用户那条原则：
   * > 「删模块这种事情，不应该，工作流做好了就应该兼容而不是为了部分去删基础结构。」
   *
   * 所以「留空 = 全部」是硬判据，写反成「留空 = 空数组」会让整份工作流
   * **一个模块都不跑、也不报错**，结果文件里 total=0 —— 看起来像「今天不用补数」。 */
  console.log('  ── modules 参数（开始节点）──')
  const withVars = async (mods) => await run(DY_STEP_MODULES, undefined, undefined, undefined,
    { modules: mods, from: '', to: '' })

  const all7 = await withVars('')
  check('★★ modules 留空 → 跑**全部** 7 个（不是空数组）',
    all7.modules.length === 7 && all7.count === 7, String(all7.modules.length))

  const blank = await withVars('   ')
  check('★★ modules 只填空格 → 也算留空，跑全部',
    blank.modules.length === 7, String(blank.modules.length))

  /* 没给 vars（= 这份工作流没有开始节点）→ 也要跑全部，与改造前一致。 */
  const noStart = await run(DY_STEP_MODULES, undefined)
  check('★★ 没有开始节点（变量没被替换）→ 也跑全部（向后兼容）',
    noStart.modules.length === 7, String(noStart.modules.length))

  const one = await withVars('交易')
  check('★ modules 指定中文名 → 只跑那一个',
    one.modules.length === 1 && one.modules[0].name === '交易', JSON.stringify(one.modules.map(m => m.name)))

  const byAlias = await withVars('trade')
  check('★ 也认英文别名（源码支持 name 或 alias）',
    byAlias.modules.length === 1 && byAlias.modules[0].name === '交易', JSON.stringify(byAlias.modules.map(m => m.name)))

  const two = await withVars('交易,直播')
  check('★ 逗号分隔多个',
    two.modules.length === 2 && JSON.stringify(two.modules.map(m => m.name)) === '["交易","直播"]',
    JSON.stringify(two.modules.map(m => m.name)))

  const video = await withVars('短视频')
  check('★ 写「短视频」→ 自营 + 合作两条都跑（照源码那条特例）',
    video.modules.length === 2 && video.modules.every(m => m.name.startsWith('短视频-')),
    JSON.stringify(video.modules.map(m => m.name)))

  const typo = await withVars('交易,交易xx')
  check('★ 拼错的模块名要说出来（unknown），不能静默当没写',
    typo.modules.length === 1 && JSON.stringify(typo.unknown) === '["交易xx"]',
    JSON.stringify({ got: typo.modules.map(m => m.name), unknown: typo.unknown }))

  const noneMatch = await withVars('不存在的模块')
  check('★ 一个都不匹配 → 0 个（这时确实该空，与「留空」是两件事）',
    noneMatch.modules.length === 0 && noneMatch.count === 0, String(noneMatch.modules.length))
}

/* ── ② 算 L + 本模块要补哪些日期（循环A 的第⑤步）── */
console.log('')
console.log('=== ② 算 L 与「本模块补哪几天」（循环 A 的最后一步）===')
{
  const item = { name: '交易', folder: 'D-店铺-整体-抖音', picker: '.p' }
  const filesOut = { folder: 'D-店铺-整体-抖音', files: ['DemoShop-20260928-a.xlsx', 'DemoShop-20260930-b.xlsx', 'DemoShop-20260929-c.xlsx', '~$临时.xlsx'] }
  const rOut = { result: { ok: true, R: '2026-10-02' } }
  const r = await run(DY_MODULE_DATES, [filesOut, rOut], item)
  console.log('  ' + JSON.stringify({ lastDate: r.lastDate, R: r.R, fileCount: r.fileCount, days: r.days }))
  check('★ L 取最大（2026-09-30）', r.lastDate === '2026-09-30', r.lastDate)
  check('★ R 从 browser.act 那层（包壳）里剥出来了', r.R === '2026-10-02', r.R)
  check('模块配置带下去了（下一步要用）', r.module?.name === '交易', JSON.stringify(r.module?.name))

  /* ★ 这一段是本次结构改动的核心：日期**按模块自己算**，不再展平。
   * 交易 L=09-30、R=10-02 → 补 10-01 / 10-02（升序，照源码 dateRange）。 */
  check('★ 算出这个模块要补的日期（L+1 ~ R，升序）',
    JSON.stringify(r.dates.map(d => d.date)) === JSON.stringify(['2026-10-01', '2026-10-02']),
    JSON.stringify(r.dates.map(d => d.date)))
  check('★ 每项都自带模块（内层循环靠它判 dropdown / 找目录）',
    r.dates.every(d => d.module?.name === '交易'), JSON.stringify(r.dates[0]?.module?.name))
  check('days 与 dates 条数一致', r.days === 2, String(r.days))
  check('L == R 之外的正常补齐不会被记成 skipWhy', r.skipWhy === '', JSON.stringify(r.skipWhy))

  /* L == R（今天已经下过了）→ 0 条，内层循环跑 0 轮。**不是错误**。 */
  {
    const same = await run(DY_MODULE_DATES, [filesOut, { result: { ok: true, R: '2026-09-30' } }], item)
    check('★ L == R → 0 条（内层跑 0 轮，不是报错）',
      Array.isArray(same.dates) && same.dates.length === 0, String(same.dates.length))
    check('  且不记成跳过', same.skipWhy === '', JSON.stringify(same.skipWhy))
  }

  /* ⚠️ 掉登录 → 明确报错（不猜日期）。 */
  let loginThrew = false
  let loginMsg = ''
  try { await run(DY_MODULE_DATES, [filesOut, { result: { ok: false, err: 'LOGIN_REQUIRED' } }], item) } catch (e) { loginThrew = true; loginMsg = String(e.message) }
  check('★ 掉登录 → 明确抛错', loginThrew, loginMsg.slice(0, 80))
  check('  报错里让人去登录', loginMsg.includes('登录'), loginMsg.slice(0, 100))

  /* ⚠️ 读不到 R → 也抛错（不猜）。 */
  let noRThrew = false
  try { await run(DY_MODULE_DATES, [filesOut, { result: { ok: false, err: '读不到 R' } }], item) } catch { noRThrew = true }
  check('★ 读不到 R → 抛错（不猜日期）', noRThrew)

  /* ⚠️ nameFilter（短视频自营/合作共用一个文件夹）。 */
  const vsItem = { name: '短视频-自营', folder: 'D-店铺-视频-抖音', nameFilter: '自营' }
  const shared = { folder: 'D-店铺-视频-抖音', files: ['DemoShop-20260901-自营.xlsx', 'DemoShop-20260928-合作.xlsx'] }
  const r2 = await run(DY_MODULE_DATES, [shared, { result: { ok: true, R: '2026-10-02' } }], vsItem)
  check('★ nameFilter 生效（只算自营那份的日期）', r2.lastDate === '2026-09-01', r2.lastDate)
  check('  于是要补的日期从自营那份的 L 起算',
    JSON.stringify(r2.dates[0]?.date) === JSON.stringify('2026-09-02'), JSON.stringify(r2.dates[0]?.date))

  /* ⚠️ 缺 L（第一次跑、目录空）→ 记 skipWhy、0 条（照源码：无法确定开始日期）。 */
  {
    const empty = await run(DY_MODULE_DATES, [{ folder: 'F', files: [] }, { result: { ok: true, R: '2026-10-02' } }], item)
    check('★ 没有 L → skipWhy 说清原因', String(empty.skipWhy).includes('现有数据'), JSON.stringify(empty.skipWhy))
    check('  且 0 条（内层跑 0 轮，不报错）', empty.dates.length === 0, String(empty.dates.length))
  }
  /* ⚠️ 读不到 R（返回了但 R 是空串）→ 记 skipWhy。 */
  {
    const noR = await run(DY_MODULE_DATES, [filesOut, { result: { ok: true, R: '' } }], item)
    check('★ R 是空串 → skipWhy 说清原因', String(noR.skipWhy).includes('已结算日'), JSON.stringify(noR.skipWhy))
    check('  且 0 条', noR.dates.length === 0, String(noR.dates.length))
  }

  /* 拿不到目录清单 / 拿不到 R 这两种「上游没给」→ 明确抛错（不静默）。 */
  let noFilesThrew = false
  try { await run(DY_MODULE_DATES, [{ result: { ok: true, R: '2026-10-02' } }], item) } catch { noFilesThrew = true }
  check('★ 拿不到目录清单 → 明确抛错', noFilesThrew)

  /* ★★ 开始节点的 from / to 覆盖（2026-10-19 加，照源码 douyin-ui.ts:552-557）
   *
   * 源码原句：`const to = toArg || R; const from = fromArg || (L ? nextDay(L) : '')`
   * 也就是「**填了就用填的，没填才自动推算**」。
   * 这条是向后兼容的另一半：三个输入全留空必须与改造前逐字一致。 */
  console.log('  ── from / to 参数（开始节点）──')
  const withRange = async (from, to) => await run(DY_MODULE_DATES, [filesOut, rOut], item, undefined,
    { modules: '', from, to })

  /* ① 都留空 → 与改造前完全一致（L+1 ~ R = 10-01 ~ 10-02）。 */
  const auto = await withRange('', '')
  check('★★ from / to 都留空 → 与改造前逐字一致（L+1 ~ R）',
    JSON.stringify(auto.dates.map(d => d.date)) === JSON.stringify(['2026-10-01', '2026-10-02']),
    JSON.stringify(auto.dates.map(d => d.date)))
  check('  且不记成跳过', auto.skipWhy === '', JSON.stringify(auto.skipWhy))

  /* ② 只给 from（回填起点）→ 起点用它，终点仍按 R。 */
  const onlyFrom = await withRange('2026-09-29', '')
  check('★ 只给 from → 起点用它、终点仍按 R',
    JSON.stringify(onlyFrom.dates.map(d => d.date)) === JSON.stringify(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']),
    JSON.stringify(onlyFrom.dates.map(d => d.date)))

  /* ③ 只给 to → 起点仍按 L+1，终点用它。 */
  const onlyTo = await withRange('', '2026-10-01')
  check('★ 只给 to → 起点仍按 L+1、终点用它',
    JSON.stringify(onlyTo.dates.map(d => d.date)) === JSON.stringify(['2026-10-01']),
    JSON.stringify(onlyTo.dates.map(d => d.date)))

  /* ④ 两个都给 → 完全按给的区间（与 L / R 无关）。 */
  const both = await withRange('2026-09-01', '2026-09-03')
  check('★★ from / to 都给 → 完全按给的区间（不再看 L / R）',
    JSON.stringify(both.dates.map(d => d.date)) === JSON.stringify(['2026-09-01', '2026-09-02', '2026-09-03']),
    JSON.stringify(both.dates.map(d => d.date)))

  /* ⑤ 区间倒过来（from > to）→ 0 条，不报错（照源码：无需补数）。 */
  const inverted = await withRange('2026-10-05', '2026-10-01')
  check('★ from > to → 0 条（照源码「无需补数」，不是报错）',
    inverted.dates.length === 0 && inverted.skipWhy === '',
    JSON.stringify({ n: inverted.dates.length, skipWhy: inverted.skipWhy }))

  /* ⑥ 目录是空的（没有 L），但**给了 from** → 照样能跑（源码的 --from 就是干这个的）。 */
  {
    const emptyDir = { folder: 'F', files: [] }
    const withFrom = await run(DY_MODULE_DATES, [emptyDir, rOut], item, undefined,
      { modules: '', from: '2026-10-01', to: '' })
    check('★★ 没有 L 但给了 from → 照样算得出日期（回填场景）',
      JSON.stringify(withFrom.dates.map(d => d.date)) === JSON.stringify(['2026-10-01', '2026-10-02']),
      JSON.stringify(withFrom.dates.map(d => d.date)))
    /* 而没给 from 时仍是「跳过」（与改造前一致）。 */
    const noFrom = await run(DY_MODULE_DATES, [emptyDir, rOut], item, undefined, { modules: '', from: '', to: '' })
    check('  没给 from 时仍按老规矩跳过', noFrom.dates.length === 0 && String(noFrom.skipWhy).includes('现有数据'),
      JSON.stringify({ n: noFrom.dates.length, why: noFrom.skipWhy }))
  }

  /* ⑦ 日期写错形状 → 明确报错（不静默算出 0 天）。 */
  {
    let threw = false
    let msg = ''
    try { await run(DY_MODULE_DATES, [filesOut, rOut], item, undefined, { modules: '', from: '2026/10/01', to: '' }) } catch (e) { threw = true; msg = String(e.message) }
    check('★ from 写成 2026/10/01 → 明确报错（说清要什么格式）',
      threw && msg.includes('2026-10-01'), msg.slice(0, 100))
  }

  /* ⑧ 填了 to 但没有 R → 仍然跳过（照源码：`if (!R)` 在算 to 之后仍然拦）。 */
  {
    const noR2 = await run(DY_MODULE_DATES, [filesOut, { result: { ok: true, R: '' } }], item, undefined,
      { modules: '', from: '2026-09-01', to: '2026-09-05' })
    check('★ 填了 to 但读不到 R → 仍跳过（照源码：R 是必读的）',
      noR2.dates.length === 0 && String(noR2.skipWhy).includes('已结算日'),
      JSON.stringify({ n: noR2.dates.length, why: noR2.skipWhy }))
  }
}

/* ── ④ 循环B 的两段（★ 验 `{{item}}` 那个写法真的能跑）── */
console.log('')
console.log('=== ④ 循环 B（含 `const item = {{item}}` 那个写法）===')
{
  const pair = { module: { name: '交易', folder: 'D-店铺-整体-抖音' }, date: '2026-09-29', firstOfModule: true }
  /* ⚠️ 给一个**极简 window 桩**（只有 location 与空 document）——
   * 于是 `window.__picker` 是 undefined，正好验「没有 picker 时明确报错」。 */
  const bareWin = {
    location: { href: 'https://compass.jinritemai.com/shop/business-part' },
    document: { title: '测试页', querySelector: () => null, body: { innerText: '' } },
  }
  const r = await run(DY_SET_DATE, {}, pair, bareWin)
  console.log('  设日期（桩 window，没有 __picker）: ' + JSON.stringify(r))
  check('★ `const item = {{item}}` 能跑（没语法错）', typeof r === 'object' && r !== null)
  check('★ 没有 __picker 时**明确报错**（不静默）', r.ok === false && String(r.err).includes('__picker'), String(r.err))

  /* ★ 再给一个「__picker 齐全」的桩，验设日期真的被调用了。 */
  {
    const calls = []
    const dayjsLike = () => {
      const o = {}
      for (const fn of ['year', 'month', 'date', 'hour', 'minute', 'second', 'millisecond']) o[fn] = () => dayjsLike()
      return o
    }
    const fullWin = {
      location: { href: 'https://x/' },
      document: { title: '正常页', querySelector: () => null, body: { innerText: '' } },
      __picker: {
        m0: dayjsLike(),
        onChangeFiber: { memoizedProps: { onChange: (v, o) => { calls.push({ v, o }) } } },
      },
    }
    const r2 = await run(DY_SET_DATE, {}, pair, fullWin)
    console.log('  设日期（桩 window 齐全）: ' + JSON.stringify(r2))
    check('★ picker 齐全时 → ok=true', r2.ok === true, JSON.stringify(r2))
    check('★ 真的调了 onChange（1 次）', calls.length === 1, String(calls.length))
    check('★ 传的是 { type: "day" }（照源码）', calls[0]?.v?.type === 'day', JSON.stringify(calls[0]?.v?.type))
    check('★ 日期区间是 [当天0点, 当天23:59:59.999]（照源码）',
      Array.isArray(calls[0]?.v?.date) && calls[0].v.date.length === 2, JSON.stringify(calls[0]?.v?.date))
    check('★ triggerType 是 quick（照源码）', calls[0]?.o?.triggerType === 'quick', JSON.stringify(calls[0]?.o))
  }

  /* 文件名（纯逻辑，能完整验）。 */
  const f = await run(DY_FILENAME, { suggestedFilename: '自营短视频.xlsx' },
    { module: { name: '短视频-自营', folder: 'D-店铺-视频-抖音', fileSuffix: '-自营' }, date: '2026-09-29' })
  console.log('  fileName: ' + f.fileName)
  check('★ 前缀「店铺-YYYYMMDD-」', f.fileName.startsWith(DY_SHOP + '-20260929-'), f.fileName)
  check('★ 后缀加上（-自营）', f.fileName.includes('-自营'), f.fileName)
  check('folder 带下来', f.folder === 'D-店铺-视频-抖音', f.folder)
  check('用了建议名', f.usedSuggested === true)

  /* 建议名缺失 → 用模块名兜底（**不静默出空名**）。 */
  const f2 = await run(DY_FILENAME, {}, { module: { name: '图文', folder: 'F' }, date: '2026-01-01' })
  check('★ 没建议名时用模块名兜底（不出空名）', f2.fileName.includes('图文'), f2.fileName)
  check('  并标了没用建议名', f2.usedSuggested === false)

  /* 非法字符。 */
  const f3 = await run(DY_FILENAME, { suggestedFilename: 'a/b:c*d.xlsx' }, { module: { name: 'A', folder: 'F' }, date: '2026-01-01' })
  const tail = f3.fileName.slice(f3.fileName.indexOf('20260101') + 9)
  check('★ 非法字符换成 _（照源码）', !/[\\/:*?"<>|]/.test(tail), tail)

  /* ★★ 夹在「下载」与「本轮结果」之间，必须把成败原样带下去。
   *
   * 不加这一段的话链条是这样坏的：拼名那步只返回 fileName / folder / date，
   * 下一段 `DY_ROUND_GUARD` 去读 ok 读到 undefined → `inner.ok === true` 恒假
   * → **每一轮都记成失败**，而汇总照报（total 对、okCount 恒 0、误报连续失败）。
   * 这个 bug 以前被汇总那个「只认 value/result」的坏递归掩盖着，看不出来。 */
  const fb = await run(DY_FILENAME, { result: { ok: true, suggestedFilename: 'x.xlsx', pageTitle: '正常页' } },
    { module: { name: '交易', folder: 'F' }, date: '2026-10-01' })
  check('★★ 下载成功 → 拼名这步把 ok=true 带下去', fb.ok === true, JSON.stringify({ ok: fb.ok, pageTitle: fb.pageTitle }))
  check('★★ 页面标题也带下去（本轮结果的风控判据要用）', fb.pageTitle === '正常页', String(fb.pageTitle))
  const fbad = await run(DY_FILENAME, { result: { ok: false, err: '按钮没点到', pageTitle: '验证页' } },
    { module: { name: '交易', folder: 'F' }, date: '2026-10-01' })
  check('★★ 下载失败 → ok=false 且原样带下 err', fbad.ok === false && String(fbad.err).includes('按钮没点到'),
    JSON.stringify({ ok: fbad.ok, err: fbad.err }))

  /* ★★ 端到端串一遍：拼名 → 本轮结果，ok 必须活到最后一环。 */
  const guard = await run(DY_ROUND_GUARD, fb,
    { module: { name: '交易', folder: 'F' }, date: '2026-10-01' })
  check('★★ 拼名 → 本轮结果 串起来，成功那轮记成 ok=true（不是全记失败）',
    guard.ok === true && guard.failed === false, JSON.stringify(guard))
}

/* ── ⑤ 汇总 + 连续失败护栏 ── */
console.log('')
console.log('=== ⑤ 汇总与连续失败护栏 ===')
{
  /* 交易：成功、失败、失败 → 该模块有「连续 2 次」。 */
  const r = await run(DY_SUMMARY, [
    { date: '2026-09-01', ok: true, failed: false, moduleName: '交易' },
    { date: '2026-09-02', ok: false, failed: true, moduleName: '交易' },
    { date: '2026-09-03', ok: false, failed: true, moduleName: '交易' },
    { date: '2026-09-01', ok: true, failed: false, moduleName: '直播' },
  ])
  console.log('  ' + JSON.stringify(r))
  check('★ 认出「交易」有连续 2 次失败', r.stoppedModules.includes('交易'), JSON.stringify(r.stoppedModules))
  check('★ 直播没被误判', !r.stoppedModules.includes('直播'), JSON.stringify(r.stoppedModules))
  check('总账对（2 成功 2 失败）', r.okCount === 2 && r.failCount === 2, JSON.stringify({ ok: r.okCount, fail: r.failCount }))
  check('有失败 → ok=false', r.ok === false)
  check('说明里点了模块名', String(r.note).includes('交易'), String(r.note))

  /* 失败**不连续**（失败-成功-失败）→ 不该停。 */
  const r2 = await run(DY_SUMMARY, [
    { date: '2026-09-01', ok: false, failed: true, moduleName: '交易' },
    { date: '2026-09-02', ok: true, failed: false, moduleName: '交易' },
    { date: '2026-09-03', ok: false, failed: true, moduleName: '交易' },
  ])
  check('★ 不连续的失败不停模块', r2.stoppedModules.length === 0, JSON.stringify(r2.stoppedModules))

  /* 全成功。 */
  const r3 = await run(DY_SUMMARY, [{ date: 'd', ok: true, failed: false, moduleName: 'A' }])
  check('全成功 → ok=true 且无停模块', r3.ok === true && r3.stoppedModules.length === 0)
}

/* ── ⑥ 读「已结算日 R」那段的规格（★ 锚到源码 douyin-ui.ts:81-92）──
 *
 * ## 为什么这条断言必须是「查字符串存在」（本项目一般不许这么写）
 *
 * ## ★ 它的力气有多大（实测，别以为它只是「查了有这个词」）
 *
 * 只查「文本里有没有 walkFiber」是不够的 —— 我实测过两种改坏法：
 *   · 把 `fib.child` 改成 `fib.zzchild`（深挖真的废了）→ **当场红** ✓
 *   · 把 `walkFiber` 整个改名成 `walkFiberZZZ` → **仍然是绿的** ✗
 *     原因不是注释（注释已摘），而是 **`includes` 是子串匹配**：
 *     `'const walkFiberZZZ'` 里**确实含** `'const walkFiber'` 这个前缀。
 * ⇒ **它拦得住「删掉那几行 / 改判据」，拦不住「在名字后面接东西」这类改法。**
 * 这一段的规格是页面内代码，**真正的验证只有用户手动跑一次**。
 *
 * 这一段是**页面内脚本**：它探进抖音自己的 React 组件树里翻一个 dayjs 实例。
 * 那个树我们控制不了，所以**能跑通的那版源码就是唯一靠得准的规格**
 * （`D:\ecom-data\自动下载\src\douyin-ui.ts` 的 `setupPicker`，L81-92）。
 *
 * ## 它为什么必须存在（否则这个 bug 会再回来）
 *
 * 2026-10-16 真机上必报「找不到 dayjs 模板（页面改版？）」：那段代码被
 * **按自己的理解简化过** —— 只沿父链看一层 props、判据用 `year`/`month`，
 * 而 dayjs 就藏在 `ocf.memoizedProps.value.date[0]` 里，那一层根本没碰。
 * 当时 `douyin-workflow`（端到端）与 `douyin-logic`（纯逻辑）**全是绿的**
 * —— 端到端那段把 `browser.act` 换成了返回构造数据的桩，
 * 页面里的代码**一个字都没被执行**。所以这条只能钉「规格在不在」。
 *
 * ## 判据锚在哪（关键：**先摘掉注释**）
 *
 * 只查源码文本会被**我们自己的注释**骗过去 —— 上面那段说明里
 * 恰好写着 `ocf.memoizedProps.value` 这些词（这正是「用 includes 查某串
 * 结果被注释里的同一串救活」那个假绿，见 AGENTS.md 里 browser-driver 那条）。
 * 所以断言前先把 `/* … *\/` 与整行 `//` 注释**摘掉**，
 * 再在**只剩代码**的文本上查。`照自己的理解简化` 那句是**反向对照**：
 * 它只出现在注释里，必须**查不到** —— 证明摘注释这一步真的生效。 */
console.log('')
console.log('=== ⑥ 读 R 那段照源码的规格（页面内脚本，只能钉规格）===')
{
  /* ⚠️ 直接查**导入的那段代码本体**（不读文件）—— 它就是要钉的那个规格。 */
  const raw = DY_READ_R
  /* ⚠️ 摘注释：块注释 + 整行行注释。摘完再查。 */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  check('摘注释这一步有效（只写在注释里的那句话查不到）',
    !code.includes('照自己的理解简化'))
  /* ① 源码第一句：控件自己的 value 里就带着 dayjs。 */
  check('★ 先看 ocf.memoizedProps.value（源码第一句）',
    code.includes('ocf.memoizedProps.value'), '')
  check('★ 用它取 value.date[0] 当 dayjs（源码判据）',
    code.includes('v.date[0]') && code.includes("typeof v.date[0].format === 'function'"), '')
  /* ② 深挖：对象深 20 层带 seen 防环、fiber 树 child/sibling 深 8 层。 */
  check('★ 深挖对象 walkObj（源码同法，fiber 里有环不设防会爆栈）',
    code.includes('const walkObj') && code.includes('seen.has(x)') && code.includes('dep > 20'), '')
  check('★ 深挖 fiber walkFiber（child/sibling）',
    code.includes('const walkFiber') && code.includes('fib.child') && code.includes('fib.sibling'), '')
  /* ③ 判定 dayjs 的特征是 format + toISOString（不是 year/month）。 */
  check('★ 判定用 format + toISOString（dayjs 的特征）',
    code.includes("typeof x.format === 'function' && typeof x.toISOString === 'function'"), '')
  check('★ 旧那版的错判据（year/month）已不在',
    !code.includes("typeof val.year === 'function'"), '')
  /* ④ 读 R：先 value.date[1].format，再退页面元素，最后才扫正文。 */
  check('★ 读 R 第一条来源 = v.date[1].format(YYYY-MM-DD)（源码）',
    code.includes("v.date[1].format('YYYY-MM-DD')"), '')
  check('★ 第二条来源 = [class*=date-picker-default-display]（源码）',
    code.includes('date-picker-default-display'), '')
  const i1 = code.indexOf("v.date[1].format('YYYY-MM-DD')")
  const i2 = code.indexOf('date-picker-default-display')
  check('★ 三条来源按源码顺序（date[1] → 页面元素 → 扫正文）',
    i1 >= 0 && i2 > i1, 'date[1]@' + String(i1) + ' 元素@' + String(i2))
}

/* ── ⑦ 「找不到日期控件」会就地等一会儿再查一次（★ 2026-10-16 真机踩到）──
 *
 * 真机：**搜索页**的日期控件出现得比别的模块慢，上游只等了固定 4 秒就进来了，
 * `②c` 查一次没找到 → 报「找不到日期控件」→ 循环 A 中断（前 5 个模块都过得去）。
 *
 * 源码那一步是 `page.waitForSelector(picker, 20000)`（在 playwright 层）；
 * 我们这段是**页面内脚本**，拿不到 page，所以改成「轮询重查」。
 *
 * 这条断言是**行为**断言（不是查字符串）：让 `document.querySelector`
 * **第一次返回 null、之后才返回元素**，看它会不会再查一次 ——
 * 查了，就会走到后面那句「控件上找不到 onChange」；
 * 没查（还是老代码），拿到的是「等了 12 秒…」那句。 */
console.log('')
console.log('=== ⑦ 日期控件晚出现时会重查（搜索页那次）===')
{
  let calls = 0
  const fakeWin = {
    location: { href: 'https://compass.jinritemai.com/shop/search/drainage-terms' },
    document: {
      title: '抖音电商罗盘',
      body: { innerText: '' },
      querySelector: () => { calls++; return calls === 1 ? null : {} },
    },
  }
  const r = await run(DY_READ_R, undefined, { name: '搜索', picker: '.ecom-dorami-date-picker-wrapper' }, fakeWin)
  console.log('  ' + JSON.stringify({ calls, err: r.err, ok: r.ok }))
  check('★ 第一次没找到 → 会再查（calls ≥ 2）', calls >= 2, String(calls))
  check('★ 再查到了就继续往下走（报的是找不到 onChange，不是「等了 12 秒」）',
    r.ok === false && String(r.err).includes('onChange') && !String(r.err).includes('12 秒'), String(r.err))
}

/* ── ⑧ 点「本店搜索词」tab（★ 用户 2026-10-17 提醒：搜索页要多点一下）──
 *
 * 源码 `douyin-ui.ts:538-545`：`if (mod.shopTab) { …点「本店搜索词」… }`，
 * 位置在「等控件」之后、`setupPicker` **之前**（日期控件是点了 tab 才出来的）。
 * 我们拆工作流时漏了这一下 —— 用户凭记忆发现，比日志更快。
 *
 * 判据照源码：**只点可见的**（`offsetParent !== null`）。
 * 别的模块没有这个 tab → 返回 `clicked:false`，**不是失败**（循环体共用一张图）。 */
console.log('')
console.log('=== ⑧ 点「本店搜索词」tab 那一步 ===')
{
  const item = { name: '搜索', shopTab: true }

  /* ① 页面上有那个 tab → 真的点它。 */
  let clicked = 0
  const withTab = {
    location: { href: 'https://compass.jinritemai.com/shop/search/drainage-terms' },
    document: {
      title: '抖音电商罗盘',
      querySelectorAll: () => [{ offsetParent: {}, textContent: '本店搜索词', click: () => { clicked++ } }],
      body: { innerText: '' },
    },
  }
  const r1 = await run(DY_SHOP_TAB, undefined, item, withTab)
  check('★ 有 tab → 点了一下', r1.ok === true && r1.clicked === true && clicked === 1, JSON.stringify({ ...r1, clicked }))

  /* ② 别的模块页面上没有这个 tab → 跳过，**不算失败**。 */
  const noTab = {
    location: { href: 'https://compass.jinritemai.com/shop/business-part' },
    document: {
      title: '抖音电商罗盘',
      querySelectorAll: () => [{ offsetParent: {}, textContent: '交易概览', click: () => { throw new Error('不该点这个') } }],
      body: { innerText: '' },
    },
  }
  const r2 = await run(DY_SHOP_TAB, undefined, { name: '交易' }, noTab)
  check('★ 没有 tab → 跳过（ok:true / clicked:false，不是失败）',
    r2.ok === true && r2.clicked === false, JSON.stringify(r2))

  /* ③ 隐藏的同名元素**不算**（照源码 offsetParent === null 要滤掉）。 */
  let hiddenClicked = 0
  const hiddenOnly = {
    location: { href: 'https://compass.jinritemai.com/shop/search/drainage-terms' },
    document: {
      title: '抖音电商罗盘',
      querySelectorAll: () => [{ offsetParent: null, textContent: '本店搜索词', click: () => { hiddenClicked++ } }],
      body: { innerText: '' },
    },
  }
  const r3 = await run(DY_SHOP_TAB, undefined, item, hiddenOnly)
  check('★ 隐藏的同名元素不点（照源码只认可见的）',
    r3.clicked === false && hiddenClicked === 0, JSON.stringify({ ...r3, hiddenClicked }))

  /* ④ 掉登录 → 明确报错。 */
  const loginPage = {
    location: { href: 'https://compass.jinritemai.com/login' },
    document: { title: '登录', querySelectorAll: () => [], body: { innerText: '' } },
  }
  const r4 = await run(DY_SHOP_TAB, undefined, item, loginPage)
  check('★ 登录页 → 明确报 LOGIN_REQUIRED', r4.ok === false && r4.err === 'LOGIN_REQUIRED', JSON.stringify(r4))
}

console.log('')
console.log(failed === 0 ? '结论：抖音的纯逻辑、读 R 的规格、点 tab 都验过 ✓（页面内真正执行仍留给用户手动测）'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
