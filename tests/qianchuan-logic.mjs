/** 千川全域推广的**纯逻辑**（不开任何页面）。
 *
 * ## 用户红线
 *
 * 「不许开真实千川页面」（反爬）。所以这里只跑纯函数，一行浏览器代码都不碰。
 *
 * ## 盯的是哪几件事
 *
 * · `qcSegRange` 分段（照源码 L256-262）—— 分段错就下错区间；
 * · **幂等按「类型 + 区间结束日」**（源码 L230-231 专门注释过）——
 *   文件名尾部 id 每次都变，按完整文件名判重会**每天重下一遍**；
 * · 「≤7 天走快捷 / >7 天走日历」的选择判据（源码 L418）；
 * · R 的取法：素材维度按昨天、商品维度含今天（源码 L402）。
 *
 * ## ⚠️ 本测试的关键手法：模拟 `{{item}}` 与开始节点的变量替换
 *
 * 真机上循环变量与开始节点输入经**变量替换**注入（`const item = {{item}}`）。
 * 这里我把它们换成 JSON / 文本再跑 —— 那正是变量替换真实做的事
 * （`toText` 对对象会 `JSON.stringify`，而 JSON 是合法 JS 字面量）。
 *
 * 跑法：node tests/qianchuan-logic.mjs
 */
import {
  QC_MODULES, QC_TYPES, QC_PRODUCT_TYPE, QC_MAX_SEG, QC_SHOP,
  QC_STEP_MODULES, QC_PLAN_TYPES, QC_TYPE_PLAN, QC_SUMMARY,
} from '../scripts/browser/qianchuan-code.mjs'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 跑一段代码，**并模拟变量替换**。
 *
 * @param code - 代码段。
 * @param input - 上游数据。
 * @param item - 循环项（不给就说明这段不在循环里）。
 * @param vars - 开始节点声明的输入（`{from, to}`）。
 * @returns 返回值。
 */
async function run(code, input, item, vars) {
  let src = code
  const asText = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))
  if (item !== undefined) {
    src = src.split('{{item}}').join(asText(item))
    for (const m of [...src.matchAll(/\{\{item\.([\w.]+)\}\}/g)]) {
      let cur = item
      for (const seg of m[1].split('.')) cur = cur === undefined || cur === null ? undefined : cur[seg]
      src = src.split(m[0]).join(asText(cur))
    }
  }
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) src = src.split('{{' + k + '}}').join(String(v ?? ''))
  }
  if (/\{\{item/.test(src)) {
    throw new Error('测试里没替换干净的循环变量：' + String(src.match(/\{\{item[^}]*\}\}/)?.[0]))
  }
  /* 只认「像占位符的」（`{{名字}}`），不能见到 `{{` 就报 ——
   * 脚本里有 `s.split('{{')` 这种字面量（那不是占位符）。 */
  if (vars !== undefined) {
    const left = src.match(/\{\{[A-Za-z_][\w.]*\}\}/)
    if (left !== null) throw new Error('测试里没替换干净的占位符：' + left[0])
  }
  const fn = new Function('input', '"use strict";return (async () => {' + src + '})()')
  return await fn(input)
}

/** 日期串 + n 天（测试里自己算，用来断言）。 */
const addDays = (s, n) => {
  const d = new Date(s + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
/** 本地今天 / 昨天（与脚本同一套：本地时区，不是 UTC）。 */
const ymdLocal = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

console.log('=== 千川全域推广：纯逻辑（不开页面）===')

/* ── ① 模块配置 ───────────────────────────────────────────────────── */
console.log('')
console.log('① 模块配置（照源码 MODULES 里 qianchuan 那两条）')
{
  const r = await run(QC_STEP_MODULES, undefined)
  console.log('  模块: ' + r.modules.map(m => m.name + (m.product ? '(商品维度)' : '(素材维度)')).join(' / '))
  check('★ 两个模块', r.count === 2, String(r.count))
  check('★ 是「推广」与「推广商品」',
    JSON.stringify(r.modules.map(m => m.name)) === '["推广","推广商品"]',
    JSON.stringify(r.modules.map(m => m.name)))
  check('★ 推广是素材维度、推广商品是商品维度',
    r.modules[0].product === false && r.modules[1].product === true,
    JSON.stringify(r.modules.map(m => m.product)))
  check('★ 目录照源码（T-推广-素材-抖音 / T-推广-商品-抖音）',
    r.modules[0].folder === 'T-推广-素材-抖音' && r.modules[1].folder === 'T-推广-商品-抖音',
    r.modules.map(m => m.folder).join(' / '))
  check('★ picker 照源码（.ovui-range-picker）',
    r.modules.every(m => m.picker === '.ovui-range-picker'))
  check('★ 两个 URL 都指向 site-promotion',
    r.modules.every(m => m.url.includes('qianchuan.jinritemai.com') && m.url.includes('/site-promotion')))
  check('★ 推广商品那条 URL 短一些（照源码只带 tabs=product&mar-goal=2）',
    r.modules[1].url.length < r.modules[0].url.length,
    String(r.modules[0].url.length) + ' vs ' + String(r.modules[1].url.length))
  check('店铺名与罗盘那份一致', r.shop === QC_SHOP, r.shop)
  /* 常量本身也对一遍（它们各自被下游用到，错一个就全线错）。 */
  check('QC_TYPES 是视频/图片', JSON.stringify(QC_TYPES) === '["视频","图片"]', JSON.stringify(QC_TYPES))
  check('QC_PRODUCT_TYPE 是商品', QC_PRODUCT_TYPE === '商品', QC_PRODUCT_TYPE)
  check('QC_MAX_SEG 是 7（用户 2026-09-04 定案）', QC_MAX_SEG === 7, String(QC_MAX_SEG))
  check('模块表里的 product 只有推广商品是 true',
    QC_MODULES.filter(m => m.product === true).length === 1)
}

/* ── ② R 的取法（素材=昨天 / 商品=今天）──────────────────────────── */
console.log('')
console.log('② R：素材维度按昨天、商品维度含今天（照源码 L402 那行三元）')
{
  const now = new Date()
  const today = ymdLocal(now)
  const yesterday = ymdLocal(new Date(Date.now() - 86400000))

  const mat = await run(QC_PLAN_TYPES, undefined, { name: '推广', product: false, folder: 'F' })
  console.log('  素材维度: R=' + mat.R + ' 类型=' + mat.types.join('/'))
  check('★ 素材维度 R = 昨天', mat.R === yesterday, mat.R + '（今天 ' + today + '）')
  check('★ 素材维度两个类型：视频 / 图片',
    JSON.stringify(mat.types) === '["视频","图片"]', JSON.stringify(mat.types))
  check('★ rows 每项都自带 module（内层靠它找目录）',
    mat.rows.every(r2 => r2.module?.name === '推广'), JSON.stringify(mat.rows[0]?.module?.name))

  const prod = await run(QC_PLAN_TYPES, undefined, { name: '推广商品', product: true, folder: 'G' })
  console.log('  商品维度: R=' + prod.R + ' 类型=' + prod.types.join('/'))
  check('★ 商品维度 R = 今天（含今日）', prod.R === today, prod.R)
  check('★ 商品维度只有一个类型「商品」',
    JSON.stringify(prod.types) === '["商品"]', JSON.stringify(prod.types))
  check('★ rows 里带 product:true（内层判要不要点素材 radio）',
    prod.rows.every(r2 => r2.product === true), JSON.stringify(prod.rows[0]?.product))
  check('rows 条数 = types 条数', mat.rows.length === 2 && prod.rows.length === 1,
    String(mat.rows.length) + ' / ' + String(prod.rows.length))
}

/* ── ③ 分段（照源码 qcSegRange）──────────────────────────────────── */
console.log('')
console.log('③ 按 7 天分段（照源码 qcSegRange：闭区间、升序）')
{
  /* 直接用 typePlan 来验分段（它是唯一入口，不该在测试里另写一份）。 */
  const plan = (files, item, vars) => run(QC_TYPE_PLAN,
    [{ ok: true, folder: item.module.folder, files, count: files.length }], item, vars)

  const mat = { module: { name: '推广', folder: 'T-推广-素材-抖音', product: false }, type: '视频', R: '2026-10-10', product: false }

  /* ① 缺口正好 7 天 → 1 段，且走快捷。 */
  const p1 = await plan([], mat, { from: '2026-10-04', to: '2026-10-10' })
  console.log('  7 天: ' + JSON.stringify(p1.segs.map(s => s.from + '~' + s.to)) + ' mode=' + p1.mode)
  check('★ 7 天 → 1 段', p1.segCount === 1, String(p1.segCount))
  check('★ 7 天 → 区间就是 from~to',
    p1.segs[0].from === '2026-10-04' && p1.segs[0].to === '2026-10-10', JSON.stringify(p1.segs[0]))
  check('★ 7 天且贴着 R → 走快捷「最近7天」', p1.segs[0].quick === true && p1.mode === '快捷最近7天', p1.mode)

  /* ② 15 天 → 3 段（7 + 7 + 1）。 */
  const p2 = await plan([], mat, { from: '2026-09-26', to: '2026-10-10' })
  console.log('  15 天: ' + JSON.stringify(p2.segs.map(s => s.from + '~' + s.to)))
  check('★ 15 天 → 3 段', p2.segCount === 3, String(p2.segCount))
  check('★ 每段最多 7 天', p2.segs.every(s => {
    const days = Math.round((new Date(s.to + 'T00:00:00') - new Date(s.from + 'T00:00:00')) / 86400000) + 1
    return days <= 7
  }), p2.segs.map(s => s.from + '~' + s.to).join(' / '))
  check('★ 段首尾相接、覆盖整个区间',
    p2.segs[0].from === '2026-09-26' && p2.segs[2].to === '2026-10-10', JSON.stringify(p2.segs))
  /* ★★ 多段时**一段都不许走快捷** —— 快捷是「最近7天」= R-6~R，
   * 与中间那些段不是一回事。只判「贴着 R」会让最后那段误走快捷。 */
  check('★★ 多段时不用快捷（快捷只对「整批就一段」成立）',
    p2.segs.every(s => s.quick === false) && p2.mode === '日历点击',
    JSON.stringify({ quick: p2.segs.map(s => s.quick), mode: p2.mode }))

  /* ③ 8 天 → 2 段（7 + 1）。边界值：再多一天就多一段。 */
  const p3 = await plan([], mat, { from: '2026-10-03', to: '2026-10-10' })
  check('★ 8 天 → 2 段（7+1）', p3.segCount === 2, JSON.stringify(p3.segs.map(s => s.from + '~' + s.to)))

  /* ④ from > to → 0 段（照源码 `if (from > to) return []`）。 */
  const p4 = await plan([], mat, { from: '2026-10-10', to: '2026-10-01' })
  check('★ from > to → 0 段（不是报错）', p4.segCount === 0, String(p4.segCount))
}

/* ── ④ ★★ 幂等按「类型 + 区间结束日」，不看文件名里的 id ──────────── */
console.log('')
console.log('④ ★★ 幂等按「类型 + 区间结束日」判（源码 L230-231 专门注释过）')
{
  const plan = (files, item, vars) => run(QC_TYPE_PLAN,
    [{ ok: true, folder: item.module.folder, files, count: files.length }], item, vars)
  const mat = { module: { name: '推广', folder: 'T-推广-素材-抖音', product: false }, type: '视频', R: '2026-10-10', product: false }

  /* 素材维度（横线分隔）：导出名 + 我们加的店铺前缀与区间结束日（源码 qcDownload 的落盘名）。 */
  const matFile = (endDate, id) =>
    'DemoShop-' + endDate.replace(/-/g, '') + '-全域推广数据-视频-2026-09-01 10_30_00-' + endDate + '-' + id + '.xlsx'

  /* ① 没有任何文件 → L 是空 → 只靠 from 参数决定起点。 */
  const p0 = await plan([], mat, { from: '2026-10-01', to: '2026-10-10' })
  check('★ 没有现有数据 → L 为空、按 from 起算',
    p0.L === '' && p0.from === '2026-10-01', JSON.stringify({ L: p0.L, from: p0.from }))

  /* ② 有文件 → L 取最大的**区间结束日**。 */
  const p1 = await plan([matFile('2026-10-05', 'aaa'), matFile('2026-10-08', 'bbb')], mat, { from: '', to: '2026-10-10' })
  check('★ L 取最大的区间结束日（2026-10-08）', p1.L === '2026-10-08', p1.L)
  check('★ 没给 from → 起点 = L+1（2026-10-09）', p1.from === '2026-10-09', p1.from)

  /* ★★ 核心：**同一区间、不同随机 id** → 判据必须一样。
   *
   * 这就是源码那句「文件名尾部 id 每次都变」的意思。
   * 若判据写成「完整文件名比一场」，下面这条会红 —— 因为名字确实不一样。 */
  const A = matFile('2026-10-08', 'ID-aaaaaa')
  const B = matFile('2026-10-08', 'ID-bbbbbb')
  check('★★ 两个文件只有尾部 id 不同', A !== B, A.slice(-30) + ' ≠ ' + B.slice(-30))
  const pa = await plan([A], mat, { from: '', to: '2026-10-10' })
  const pb = await plan([B], mat, { from: '', to: '2026-10-10' })
  check('★★ 尾部 id 不同 → L 完全相同（按「类型+结束日」抠，不看整名）',
    pa.L === pb.L && pa.L === '2026-10-08',
    JSON.stringify({ A: pa.L, B: pb.L }))

  /* ③ 已有数据覆盖到目标日 → 本类型跳过（**不是报错**）。 */
  const p2 = await plan([matFile('2026-10-10', 'x')], mat, { from: '', to: '2026-10-10' })
  check('★ 已有数据到目标日 → 0 段 + skipWhy（不是报错）',
    p2.segCount === 0 && p2.skipWhy !== '', JSON.stringify({ seg: p2.segCount, why: p2.skipWhy }))
  check('  跳过原因说清了「已覆盖」', String(p2.skipWhy).includes('覆盖'), p2.skipWhy)

  /* ④ 已有数据**超过**目标日（例如上次跑到了今天、这次 --to 是昨天）→ 也跳过。 */
  const p3 = await plan([matFile('2026-10-12', 'y')], mat, { from: '', to: '2026-10-10' })
  check('★ 已有数据超过目标日 → 也跳过', p3.segCount === 0, String(p3.segCount))

  /* ⑤ ★ 类型必须分开算：图片的文件不能抬高视频的 L。
   * 千川两张表在**同一个文件夹**里，只靠文件名里的类型词区分。 */
  const imgFile = (endDate, id) =>
    'DemoShop-' + endDate.replace(/-/g, '') + '-全域推广数据-图片-2026-09-01 10_30_00-' + endDate + '-' + id + '.xlsx'
  const p4 = await plan([imgFile('2026-10-09', 'z')], mat, { from: '', to: '2026-10-10' })
  check('★★ 图片的文件不算成视频的 L（同一文件夹按类型词分开）',
    p4.L === '', 'L=' + JSON.stringify(p4.L))
  /* 反过来：视频的文件不能算成图片的。 */
  const imgItem = { module: mat.module, type: '图片', R: '2026-10-10', product: false }
  const p5 = await plan([matFile('2026-10-09', 'q')], imgItem, { from: '', to: '2026-10-10' })
  check('★★ 视频的文件也不算成图片的 L', p5.L === '', 'L=' + JSON.stringify(p5.L))

  /* ⑥ ★★ 商品维度用**下划线**分隔（源码 sep 变量）：`全域推广数据_商品_...`。
   * 用横线的正则去匹配它必然落空 —— 这条钉住两种分隔符都认对了。 */
  const prodItem = { module: { name: '推广商品', folder: 'T-推广-商品-抖音', product: true }, type: '商品', R: '2026-10-10', product: true }
  const prodFile = (endDate, id) =>
    'DemoShop-' + endDate.replace(/-/g, '') + '-全域推广数据_商品_' + '2026-09-01 10_30_00-' + endDate + '-' + id + '.xlsx'
  const pp = await plan([prodFile('2026-10-07', 'p')], prodItem, { from: '', to: '2026-10-10' })
  check('★★ 商品维度（下划线分隔）也认得出 → L=2026-10-07', pp.L === '2026-10-07', pp.L)
  /* 反证：拿素材维度的横线名喂给商品维度 → 不该认。 */
  const pWrong = await plan([matFile('2026-10-07', 'r')], prodItem, { from: '', to: '2026-10-10' })
  check('★ 素材维度的文件名不会被算成商品的 L', pWrong.L === '', 'L=' + JSON.stringify(pWrong.L))

  /* ⑦ 非 xlsx 不算（正则只认导出名形状，但目录清单里可能有别的）。 */
  const p6 = await plan(['说明.txt', '~$临时.xlsx'], mat, { from: '2026-10-01', to: '2026-10-02' })
  check('★ 不像导出名的文件不算进 L', p6.L === '', 'L=' + JSON.stringify(p6.L))
}

/* ── ⑤ ≤7天走快捷 / >7天走日历 ──────────────────────────────────── */
console.log('')
console.log('⑤ 「走快捷」还是「点日历」的判据（照源码 L418）')
{
  const plan = (item, vars) => run(QC_TYPE_PLAN, [{ ok: true, folder: 'F', files: [], count: 0 }], item, vars)
  const mat = { module: { name: '推广', folder: 'F', product: false }, type: '视频', R: '2026-10-10', product: false }

  const cases = [
    ['2026-10-04', '2026-10-10', true, '正好 7 天且贴着 R'],
    ['2026-10-05', '2026-10-10', true, '6 天且贴着 R'],
    ['2026-10-10', '2026-10-10', true, '1 天且贴着 R'],
    ['2026-10-03', '2026-10-10', false, '8 天（超过 7）'],
    ['2026-09-20', '2026-10-10', false, '21 天'],
    ['2026-09-01', '2026-09-07', false, '7 天但**不贴 R**（回填老区间）'],
  ]
  for (const [from, to, expectQuick, why] of cases) {
    const p = await plan(mat, { from, to })
    const isQuick = p.segCount === 1 && p.segs[0].quick === true
    check('★ ' + from + '~' + to + ' → ' + (expectQuick ? '快捷' : '日历') + '（' + why + '）',
      isQuick === expectQuick, 'mode=' + p.mode + ' segs=' + String(p.segCount))
  }
}

/* ── ⑥ 汇总（总账 + 按类型分账）────────────────────────────────── */
console.log('')
console.log('⑥ 汇总')
{
  const round = (type, endDate, ok, skipped) => ({
    ok, skipped, type, moduleName: '推广', endDate, from: endDate, path: 'x', fileName: 'f', size: 1,
    failed: !ok, err: null,
  })

  /* 引擎给循环下游的形状是 `{ count, results: [...] }` —— 键名是 results。 */
  const shaped = {
    count: 2,
    results: [
      { count: 3, results: [round('视频', '2026-10-04', true, false), round('视频', '2026-10-10', true, false), round('图片', '2026-10-10', true, true)] },
      { count: 1, results: [round('商品', '2026-10-10', true, false)] },
    ],
  }
  const r = await run(QC_SUMMARY, shaped)
  console.log('  ' + JSON.stringify(r))
  check('★★ 汇总数到了轮次（不是恒报 0）', r.total === 4, 'total=' + String(r.total))
  check('★ 成功 3、跳过 1、失败 0',
    r.okCount === 3 && r.skipCount === 1 && r.failCount === 0,
    JSON.stringify({ ok: r.okCount, skip: r.skipCount, fail: r.failCount }))
  check('★ 没失败 → ok=true', r.ok === true)
  check('★ 按类型分账（视频 2 / 图片 1 / 商品 1）',
    r.byType['视频']?.ok === 2 && r.byType['图片']?.skipped === 1 && r.byType['商品']?.ok === 1,
    JSON.stringify(r.byType))

  /* 跳过**不该**算进失败数（它是幂等命中，正常情况）。 */
  check('★★ 「已存在跳过」不算失败', r.failCount === 0, JSON.stringify(r.byType))

  /* 有失败 → ok=false 且 note 说清。 */
  const bad = { count: 1, results: [{ count: 2, results: [round('视频', '2026-10-04', false, false), round('视频', '2026-10-10', true, false)] }] }
  const r2 = await run(QC_SUMMARY, bad)
  check('★ 一段失败 → ok=false、failCount=1', r2.ok === false && r2.failCount === 1, JSON.stringify({ ok: r2.ok, fail: r2.failCount }))
  check('★ note 说清有几段失败', String(r2.note).includes('1'), r2.note)

  /* 空输入也要能跑（循环 0 轮时）。 */
  const r3 = await run(QC_SUMMARY, { count: 0, results: [] })
  check('★ 0 轮也能汇总（不报错）', r3.total === 0 && r3.ok === true, JSON.stringify(r3))
}

console.log('')
console.log(failed === 0
  ? '结论：千川的分段、幂等判据、快捷选择、汇总都验过 ✓（页面内执行仍留给真机）'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
