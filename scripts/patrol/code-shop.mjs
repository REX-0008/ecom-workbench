/** `shop` 的解析代码（照 `自动巡查/src/jobs/shop.ts`）。
 *
 * 两个平台各 **3 个块**：
 *   天猫：店铺评分（5 分制）/ 预警 / 当日销售额
 *   抖音：店铺评分（100 分制）/ 预警 / 当日销售额
 *
 * ⚠️ 三条容易漏的实测规则：
 *   ① **抖音评分必须用「严格版」取值**（`findStrictValue`）——
 *      同名关键词在左侧导航/新手任务卡里也出现，宽松版会**错抓**
 *      （源码注释：「实测『50元投放补贴』被当成商家体验分」）
 *   ② **抖音「待发货」不预警**（用户 2026-09-12 定稿）：显示数值但恒为 ok
 *   ③ 抖音评分若「较昨日 下降」，即使分档是 ok 也**降成 warn**
 */
import { CODE_UNWRAP, CODE_TEXT_UTILS, CODE_PICK_CFG_TEXT } from './code-common.mjs'

/** ⚠️ `alertGrade` 必须放在**两个平台之外**（天猫段与抖音段都要用它）。
 * 我第一版把它写在天猫段里，抖音段调用时 `ReferenceError: alertGrade is not defined`
 * —— 这是按平台拆分时最容易漏的一处（共用函数跟着一侧走了）。 */
const ALERT_GRADE = `
/** 预警数字档：0=ok；<=warn → warn；>warn → crit（照源码 alertGrade）。 */
const alertGrade = (n) => {
  if (n === null) return 'unknown'
  const w = cfg.thresholds.alert.warn
  if (n === 0) return 'ok'
  if (n <= w) return 'warn'
  return 'crit'
}
`

/** 天猫那一段（评分 / 预警 / 销售额三个块）。 */
const TM_PART = `
/* ── 天猫 ── */
const tmUrl = 'https://myseller.taobao.com/home.htm/QnworkbenchHome/'
const tmItems = []

/* ① 店铺评分（5 分制，分数越高越好） */
const tmScoreDefs = [
  { label: '体验', re: /真实体验分/ },
  { label: '商品', re: /宝贝质量/ },
  { label: '物流', re: /物流速度/ },
  { label: '服务', re: /服务保障/ },
]
const tmScoreItems = tmScoreDefs.map(({ label, re }) => {
  const hit = findValueNear(ls, re, /\\d(?:\\.\\d+)?\\s*(?:分)?/)
  const v = num(hit === null ? null : hit.value)
  return item(label, hit === null ? '—' : hit.value.replace(/\\s+/g, ''), grade(v, cfg.thresholds.score.tm), hit === null ? '未匹配到，需人工查看' : '')
})
const tmScoreBlock = {
  id: 'tm-score', title: '天猫店铺评分', state: worst(tmScoreItems), summary: summarize(tmScoreItems),
  url: tmUrl, urlLabel: '打开天猫后台', items: tmScoreItems,
}

/* ② 预警（0=ok；1..warn 档 warn；>warn 档 crit） */
const tmAlertDefs = [
  { label: '包裹异常', re: /包裹异常|异常包裹/ },
  { label: '待处理违规', re: /待处理违规|违规预警/ },
  { label: '待处理投诉', re: /待处理投诉/ },
  { label: '待处理售后', re: /待处理售后/ },
]
const tmAlertItems = tmAlertDefs.map(({ label, re }) => {
  const hit = findValueNear(ls, re, /\\d+/)
  const n = num(hit === null ? null : hit.value)
  return item(label, hit === null ? '—' : String(n), alertGrade(n), hit === null ? '未匹配到，需人工查看' : (n === 0 ? '无待办' : ''))
})
const tmAlertBlock = {
  id: 'tm-alert', title: '天猫预警', state: worst(tmAlertItems), summary: summarize(tmAlertItems),
  url: tmUrl, urlLabel: '打开天猫后台', items: tmAlertItems,
}

/* ③ 当日销售额（今日实时 + 昨日 T+1 双口径） */
const tmTodayHit = findValueNear(ls, /^支付金额$/, /\\d+(?:\\.\\d+)?/, { lookAhead: 2, lookBack: 1 })
const tmYestHit = findValueNear(ls, /^昨日/, /\\d+(?:\\.\\d+)?/)
const tmToday = num(tmTodayHit === null ? null : tmTodayHit.value)
const tmYest = num(tmYestHit === null ? null : tmYestHit.value)
const tmSalesBlock = {
  id: 'tm-sales', title: '天猫', state: tmToday === null ? 'unknown' : 'ok',
  summary: '今日 ¥' + (tmToday ?? '—') + ' · 昨日 ¥' + (tmYest ?? '—'),
  url: tmUrl, urlLabel: '打开天猫后台',
  items: [item('今日成交金额', tmToday === null ? '—' : '¥' + tmToday, tmToday === null ? 'unknown' : 'ok', '昨日 ¥' + (tmYest ?? '—'), true)],
}
`

/** 抖音那一段。 */
const DY_PART = `
/* ── 抖音 ── */
const dyUrl = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index'

/* ① 店铺评分（100 分制）—— ⚠️ 必须用 findStrictValue（宽松版会错抓导航里的同名文字） */
const dyScoreDefs = [
  { label: '体验', re: /商家体验分/ },
  { label: '商品', re: /^(?:商品体验分|商品)$/ },
  { label: '物流', re: /^(?:物流体验分|物流)$/ },
  { label: '服务', re: /^(?:服务体验分|服务)$/ },
]
const dyScoreItems = dyScoreDefs.map(({ label, re }) => {
  const hit = findStrictValue(ls, re)
  const v = num(hit === null ? null : hit.value)
  let note = ''
  if (hit !== null) {
    const win = ls.slice(hit.at, Math.min(ls.length, hit.at + 5)).join(' ')
    const dm = win.match(/较昨日\\s*(持平|上升|下降)/)
    if (dm) {
      note = '较昨日 ' + dm[1]
      if (dm[1] === '下降') note += '，需关注'
    }
  }
  let st = grade(v, cfg.thresholds.score.dy)
  if (st === 'ok' && note.includes('下降')) st = 'warn'  /* 持平/上升不动；下降降到 warn */
  return item(label, hit === null ? '—' : hit.value.replace(/\\s+/g, ''), st, note || (hit === null ? '未匹配到，需人工查看' : ''))
})
const dyScoreBlock = {
  id: 'dy-score', title: '抖音店铺评分', state: worst(dyScoreItems), summary: summarize(dyScoreItems),
  url: dyUrl, urlLabel: '打开抖音后台', items: dyScoreItems,
}

/* ② 预警 —— ⚠️「待发货」不参与预警（用户 2026-09-12 定稿） */
const dyAlertDefs = [
  { label: '待发货', re: /待发货/, noAlert: true },
  { label: '异常包裹', re: /异常包裹/ },
  { label: '待处理售后', re: /待处理售后/ },
  { label: '服务工单', re: /服务工单/ },
  { label: '待整改风险点', re: /待整改风险点|风险点/ },
  { label: '待处理违规', re: /待处理违规|违规/ },
]
const dyAlertItems = dyAlertDefs.map(({ label, re, noAlert }) => {
  const hit = findValueNear(ls, re, /\\d+/)
  const n = num(hit === null ? null : hit.value)
  if (noAlert === true) return item(label, hit === null ? '—' : String(n), 'ok', hit === null ? '未匹配到' : '不计预警')
  return item(label, hit === null ? '—' : String(n), alertGrade(n), hit === null ? '未匹配到，需人工查看' : (n === 0 ? '无待办' : ''))
})
const dyAlertBlock = {
  id: 'dy-alert', title: '抖音预警', state: worst(dyAlertItems), summary: summarize(dyAlertItems),
  url: dyUrl, urlLabel: '打开抖音后台', items: dyAlertItems,
}

/* ③ 当日销售额（抖音页面不暴露昨日，只取当日实时） */
const dySalesHit = findValueNear(ls, /成交金额/, /[\\d,，.]+/, { lookAhead: 3, lookBack: 2 })
const dySalesVal = num(dySalesHit === null ? null : dySalesHit.value)
let dySalesNote = ''
if (dySalesHit !== null) {
  const win = ls.slice(dySalesHit.at, Math.min(ls.length, dySalesHit.at + 4)).join(' ')
  const dm = win.match(/较昨日\\s*(持平|上升|下降)/)
  if (dm) dySalesNote = '较昨日 ' + dm[1]
}
const dySalesBlock = {
  id: 'dy-sales', title: '抖音', state: dySalesVal === null ? 'unknown' : 'ok',
  summary: '今日成交 ¥' + (dySalesVal ?? '—'),
  url: dyUrl, urlLabel: '打开抖音后台',
  items: [item('今日成交金额', dySalesVal === null ? '—' : '¥' + dySalesVal, dySalesVal === null ? 'unknown' : 'ok', dySalesNote, true)],
}
`

/**
 * `shop` 的 `code.js` 全文。
 *
 * @param platform - `'tm'` 只解析天猫、`'dy'` 只解析抖音。
 *   ⚠️ 按平台分成两个解析节点，是因为**两个页面是分别打开的** ——
 *   一次只拿得到一个页面的文本。合并成一个节点的话，
 *   要么去读文件（碰外部世界，不合判据），要么把两条链搅在一起。
 * @param jobId - 这份工作流的短名（进结果文件的 `job` 字段）。
 *   ⚠️ **2026-10-14 加的**：拆成「一平台一份」之后，`job` 不能再写死 `'shop'`
 *   （那会让五份工作流的结果文件都自称 `shop`，面板分不清）。默认回退到旧值，
 *   这样单独调它（如测试）不传也能用。
 */
export function codeParseShop(platform, jobId = 'shop') {
  const tmOnly = platform === 'tm'
  const head = CODE_UNWRAP + CODE_TEXT_UTILS + CODE_PICK_CFG_TEXT + ALERT_GRADE + `
const ls = toLines(pageBodyText)
`
  const part = tmOnly ? TM_PART : DY_PART
  const blocks = tmOnly
    ? '[tmScoreBlock, tmAlertBlock, tmSalesBlock]'
    : '[dyScoreBlock, dyAlertBlock, dySalesBlock]'
  const label = tmOnly ? '天猫' : '抖音'
  return head + part + `
/* ⚠️ **本节点只解析一个平台**（另一个平台是另一次「打开页面」拿到的文本）。
 * 空文本时明确记下来 —— 不要静默返回空块（那看起来像「页面正常但什么都没采到」）。 */
const blocks = ${blocks}
if (ls.length === 0) {
  return {
    job: ${JSON.stringify(jobId)},
    platform: '${platform}',
    runAt: new Date().toISOString(),
    dataDate: today(),
    ok: false,
    error: '${label}页面文本为空（页面没打开 / 没取到 innerText）',
    blocks: [{
      id: '${platform}-empty', title: '${label}', state: 'unknown',
      summary: '页面文本为空，未采集到',
      url: '${tmOnly ? 'https://myseller.taobao.com/home.htm/QnworkbenchHome/' : 'https://fxg.jinritemai.com/ffa/mshop/homepage/index'}',
      items: [{ label: '页面文本', value: '空', state: 'unknown', note: '检查上一步「取整页文本」' }],
    }],
  }
}
return {
  job: ${JSON.stringify(jobId)},
  platform: '${platform}',
  runAt: new Date().toISOString(),
  dataDate: today(),
  ok: true,
  error: null,
  blocks,
}
`
}

/**
 * `shop` 最后一步：把两个平台的结果**合并**成一份 `PatrolResult`
 * （照源码 `runShop`：两家各 3 块 → 6 块；**部分失败仍算 ok**）。
 *
 * ⚠️ 「部分失败仍算 ok」是源码的语义（`ok = blocks.length > 0`）——
 * 一家挂了另一家成功，整体算成功但 `error` 里记着原因。这条容易漏。
 */
export const CODE_MERGE_SHOP = CODE_UNWRAP + CODE_TEXT_UTILS + `
/* 上游是两条链的两个结果（天猫一段、抖音一段），所以 input 是数组。 */
const results = []
for (const v of __flat) {
  if (v === null || typeof v !== 'object') continue
  if (Array.isArray(v.blocks)) results.push(v)
}
if (results.length === 0) {
  throw new Error('没收到任何平台的解析结果（上游两条链都没跑？）')
}
const blocks = []
const errors = []
for (const r of results) {
  for (const b of r.blocks) blocks.push(b)
  if (r.error) errors.push((r.platform === 'tm' ? '天猫: ' : '抖音: ') + String(r.error).slice(0, 160))
}
/* ⚠️ ok 的语义（照源码 runShop 的 ok = blocks.length > 0）**再加上一条**：
 * **全部块都是「未采集到」的占位块时，不算成功**。
 *
 * 为什么不能只照源码：源码那边「块」只可能由真实页面文本产生（拿不到文本就抛错、
 * 记进 error 而不是产生块）。而我们为了让面板「看得见失败」，给空文本也**生成了占位块**
 * （id 以 -empty 结尾）—— 于是「有块」不再等价于「采到了」。
 * 实测症状：页面完全没打开时输出 ok: true（2026-10-14 抓到）。
 *
 * 判据：**只要有一个块不是在「文本为空」那条路上生成的**，就算采到了。 */
const isPlaceholder = (b) => typeof b.id === 'string' && b.id.endsWith('-empty')
const gotAny = blocks.some((b) => !isPlaceholder(b))
const ok = gotAny
return {
  job: 'shop',
  runAt: new Date().toISOString(),
  dataDate: today(),
  ok,
  error: ok ? (errors.length > 0 ? errors.join('；') : null) : (errors.join('；') || '采集失败'),
  blocks,
}
`
