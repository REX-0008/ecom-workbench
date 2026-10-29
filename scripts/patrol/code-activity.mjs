/** `activity` 的解析代码（照 `自动巡查/src/jobs/activity.ts`）。
 *
 * 两个平台各一个块：天猫活动报名 / 抖音活动报名。
 * 内容是「已报名商品的价格校验 + 活动聚合」。
 *
 * ⚠️ 这份比另两个 job 复杂，四条要点：
 *   ① 天猫以「商品ID」行**分段**（每商品一段）；抖音以「共报名N个活动」行分段
 *   ② 价格校验有**两重**：平台要求（页面里的券后价 vs 最低要求）
 *      + **自设最低价**（来自一个 xlsx 表 `J-交易-店铺编码ID.xlsx`）
 *   ③ 抖音那一重会**减去 3**（源码里的实际规则，不是笔误）
 *   ④ 抖音「报名异常」归入异常组但**只标 warn 不升块状态为 crit**
 *
 * ⚠️ **关于那个 xlsx**（`J-交易-店铺编码ID.xlsx`）：
 * 它**碰外部世界**（读文件），按判据**不该写在这段代码里**。
 * 所以把「J 表内容」作为**输入**传进来（由工作流里的 `sys.fs.read` 或
 * 另一个解析节点提供），这里只做纯查表。
 * 拿不到 J 表时**跳过第二重校验**并记一条说明 —— 照源码的 fallback 行为。
 */
import { CODE_UNWRAP, CODE_TEXT_UTILS, CODE_PICK_CFG_TEXT } from './code-common.mjs'

/**
 * 天猫活动解析（照 `tmParseCards` + `tmBlock`）。
 *
 * @returns 该段的代码。
 */
const TM_ACTIVITY = `
/* ── 天猫活动卡片解析（照 tmParseCards）── */
const tmUrl = 'https://myseller.taobao.com/home.htm/starb/tmc-next/sale/seller/homepage.htm?tab=item'

/** 券后最低价区间："49.7 ~ 74.55" → {low,high}；单值 → {low:n,high:n}。 */
const parsePriceRange = (s) => {
  if (!s) return null
  const nums = String(s).match(/[\\d,.]+/g)
  if (!nums || nums.length === 0) return null
  const vals = nums.map((n) => parseFloat(n.replace(/,/g, ''))).filter((n) => !isNaN(n))
  if (vals.length === 0) return null
  return { low: Math.min(...vals), high: Math.max(...vals) }
}
/** 从区间字符串提取低值（"100 ~ 200" / "¥100 - ¥200"）。 */
const rangeLow = (s) => {
  if (!s) return null
  const m = String(s).match(/[\\d,.]+/)
  if (!m) return null
  const n = parseFloat(m[0].replace(/,/g, ''))
  return isNaN(n) ? null : n
}

/** 「商品ID」为锚 → 前一行=商品名 → 段内取活动名/时间/状态/价格区间。 */
const tmParseCards = (ls2) => {
  const cards = []
  for (let i = 0; i < ls2.length; i++) {
    if (ls2[i] !== '商品ID') continue
    const name = (ls2[i - 1] ?? '').trim()
    const id = (ls2[i + 1] ?? '').replace(/\\s+/g, '')
    const next = ls2.indexOf('商品ID', i + 1)
    const segEnd = next === -1 ? ls2.length : next
    const seg = ls2.slice(i, segEnd)
    const at = (label) => {
      const j = seg.indexOf(label)
      if (j === -1) return null
      return seg[j + 1] ?? null
    }
    let status = ''
    for (let j = seg.length - 1; j >= Math.max(0, seg.length - 5); j--) {
      const m = /^(已发布设定|活动中|活动结束|已撤销.*)$/.exec(seg[j] ?? '')
      if (m) { status = m[1]; break }
    }
    cards.push({
      id, name,
      activity: at('活动名称') ?? '',
      time: at('活动时间') ?? '',
      status,
      low: rangeLow(at('活动普惠券后价')),
      floorLow: rangeLow(at('最低普惠券后价要求')),
    })
  }
  return cards
}

/** 活动忽略规则（用户 2026-09-12 定稿）：结束日期 >N 天 或 已过当前日期 → 不计入。 */
const activityIgnored = (timeText, now, days) => {
  const seg = timeText.includes('-') ? timeText.split('-').slice(2).join('-') : timeText
  const end = parseDate(seg) ?? parseDate(timeText)
  if (end === null) return null
  const e = new Date(end + 'T23:59:59')
  if (e.getTime() < now.getTime()) return 'ended'
  if (e.getTime() > now.getTime() + days * 24 * 3600 * 1000) return 'long'
  return null
}

/** Date → YYYY.MM.DD HH:mm（显示时再由 timeNoYear 去年份）。 */
const fmtDate = (d) => d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')

/** 活动时间文本 → start/end Date。 */
const parseRange = (timeText) => {
  const segs = String(timeText ?? '').split('-').map((s) => s.trim()).filter((s) => s !== '')
  if (segs.length < 2) {
    const d = parseDate(timeText)
    return { start: d === null ? null : new Date(d + 'T00:00:00'), end: d === null ? null : new Date(d + 'T23:59:59') }
  }
  const start = parseDate(segs[0])
  const end = parseDate(segs[segs.length - 1])
  const st = segs[0].match(/(\\d{1,2}:\\d{2})/)
  const et = segs[segs.length - 1].match(/(\\d{1,2}:\\d{2})/)
  return {
    start: start === null ? null : new Date(start + 'T' + (st !== null ? st[1] : '00:00')),
    end: end === null ? null : new Date(end + 'T' + (et !== null ? et[1] : '23:59')),
  }
}

const cards = tmParseCards(ls)
if (cards.length === 0) {
  /* ⚠️ 走 __pack，不要直接 return 单块半成品（2026-10-30 修：那会绕过收尾，
   * 盘上就缺 job / runAt / dataDate，blocks 也不是数组）。 */
  return __pack({
    platform: 'tm', ok: false, error: '天猫活动卡片未匹配到（页面结构待适配）',
    block: {
      id: 'tm-activity', title: '天猫活动报名', state: 'unknown',
      summary: '卡片未匹配到（页面结构待适配），需人工查看',
      url: tmUrl, urlLabel: '打开天猫后台',
      items: [item('表格提取', '未匹配到', 'unknown', '见 out/debug-activity-tm.txt')],
    },
  })
}

const now = new Date()
const days = typeof cfg.activity.longTermDays === 'number' ? cfg.activity.longTermDays : 90
const abnormal = []
const acts = new Map()
let counted = 0
let ignored = 0
for (const c of cards) {
  const ign = activityIgnored(c.time, now, days)
  if (ign !== null) { ignored++; continue }
  counted++
  const label = c.name || c.id
  const actName = cleanActivityName(c.activity)
  /* 第一重：平台要求（页面里的券后价 vs 平台最低要求） */
  if (c.low !== null && c.floorLow !== null && c.low > c.floorLow) {
    abnormal.push({ label, value: '普惠券后价 ' + c.low + ' > 平台要求 ' + c.floorLow, state: 'crit', note: '天猫 · ' + actName, group: 'abnormal' })
  }
  /* 第二重：自设最低价（来自 J 表；拿不到就跳过并记说明） */
  const jEntry = jmap.get(c.id)
  if (jEntry && jEntry.low !== undefined && jEntry.low !== '') {
    const pr = parsePriceRange(jEntry.low)
    if (pr && c.low !== null) {
      if (c.low < pr.low) abnormal.push({ label, value: '券后价 ' + c.low + ' < 自设最低 ' + pr.low, state: 'crit', note: '天猫 · 券后最低价校验', group: 'abnormal' })
      else if (c.low > pr.high) abnormal.push({ label, value: '券后价 ' + c.low + ' > 自设最高 ' + pr.high, state: 'crit', note: '天猫 · 券后最低价校验', group: 'abnormal' })
    }
  }
  if (actName === '') continue
  const range = parseRange(c.time)
  const a = acts.get(actName) ?? { count: 0, start: range.start, end: range.end, time: c.time }
  a.count++
  acts.set(actName, a)
}
const activeRows = []
const publishedRows = []
for (const [actName, a] of acts) {
  const isNow = a.start !== null && a.end !== null && a.start.getTime() <= now.getTime() && now.getTime() <= a.end.getTime()
  if (isNow) {
    activeRows.push({ label: actName, value: a.count + ' 个单品', state: 'ok', note: '至 ' + (a.end !== null ? timeNoYear(fmtDate(a.end)) : timeNoYear(a.time)), group: 'active' })
  } else {
    const rangeText = a.start !== null && a.end !== null ? timeNoYear(fmtDate(a.start)) + ' 至 ' + timeNoYear(fmtDate(a.end)) : timeNoYear(a.time)
    publishedRows.push({ label: actName, value: a.count + ' 个单品', state: 'ok', note: rangeText, group: 'published' })
  }
}
const state = abnormal.length > 0 ? 'crit' : 'ok'
let collapseLine = null
if (activeRows.length > 0) {
  collapseLine = { label: '活动进行中', value: String(activeRows[0].note).replace(/^至 /, ''), state: 'ok', collapseShow: true }
} else {
  const latest = publishedRows.map((p) => p.note).sort().pop()
  if (latest !== undefined) collapseLine = { label: '最新活动', value: String(latest).split(' 至 ')[0] ?? latest, state: 'ok', collapseShow: true }
}
const shown = [...(collapseLine !== null ? [collapseLine] : []), ...abnormal, ...activeRows, ...publishedRows]
const __r = {
  platform: 'tm', ok: true, error: null,
  block: {
    id: 'tm-activity', title: '天猫活动报名', state,
    summary: abnormal.length > 0
      ? abnormal.map((i) => i.label + ' ' + i.value).join(' · ').slice(0, 80)
      : '计入 ' + counted + ' 个商品 · ' + (acts.size > 0 ? '活动 ' + acts.size + ' 个（活动中 ' + activeRows.length + '）' : '校验正常') + (ignored > 0 ? '（忽略 ' + ignored + '）' : ''),
    url: tmUrl, urlLabel: '打开天猫后台',
    items: shown.length > 0 ? shown : [item('校验结果', '无在期活动', 'ok', '全部被忽略规则剔除')],
  },
}
`

/**
 * 抖音活动解析（照 `dyParseRecords` + `dyBlock`）。
 */
const DY_ACTIVITY = `
const dyUrl = 'https://fxg.jinritemai.com/ffa/merchant/campaign-square?list_tab=access&f_tab=1&apply_tab=good'

const parsePriceRange2 = (s) => {
  if (!s) return null
  const nums = String(s).match(/[\\d,.]+/g)
  if (!nums || nums.length === 0) return null
  const vals = nums.map((n) => parseFloat(n.replace(/,/g, ''))).filter((n) => !isNaN(n))
  if (vals.length === 0) return null
  return { low: Math.min(...vals), high: Math.max(...vals) }
}
const rangeLow2 = (s) => {
  if (!s) return null
  const m = String(s).match(/[\\d,.]+/)
  if (!m) return null
  const n = parseFloat(m[0].replace(/,/g, ''))
  return isNaN(n) ? null : n
}

/** 「共报名N个活动」为锚分段。 */
const dyParseRecords = (ls2) => {
  const recs = []
  for (let i = 0; i < ls2.length; i++) {
    if (!/^共报名\\d+个活动$/.test(ls2[i])) continue
    const next = ls2.findIndex((l, j) => j > i && /^共报名\\d+个活动$/.test(l))
    const end = next === -1 ? ls2.length : next
    const seg = ls2.slice(i, end)
    /* 商品名 = 锚前 3 行内从近到远第一个非结构行（跳过 类目：/ID: /空行）。 */
    let name = ''
    let recId = ''
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const l = ls2[j] ?? ''
      if (recId === '') {
        const idm = l.match(/^ID[:：]\\s*(.+)$/)
        if (idm) { recId = idm[1].trim(); continue }
      }
      if (l === '' || /^类目：/.test(l) || /^ID[:：]/.test(l) || /^共报名/.test(l)) continue
      if (name === '') name = l
    }
    const actState = seg.find((l) => /^(活动中|待生效|已结束)$/.test(l)) ?? ''
    const activity = seg.find((l) => l !== '' && !/^类目：/.test(l) && !/^ID[:：]/.test(l) && !/^共报名/.test(l) && !/^(活动中|已结束|待开始|报名中)$/.test(l) && !/^20\\d{2}\\//.test(l) && !/^报名(成功|失败)?$/.test(l)) ?? ''
    const dateLine = seg.find((l) => /^20\\d{2}\\//.test(l))
    const endTime = dateLine !== undefined ? (dateLine.split('~')[1] ?? '').trim() : ''
    const statusIdx = seg.findIndex((l) => /^(报名成功|待完善|报名异常)/.test(l))
    const status = statusIdx >= 0 ? seg[statusIdx] : ''
    const statusReason = statusIdx >= 0 && status === '报名异常' ? (seg[statusIdx + 1] ?? '') : ''
    const pick = (label) => {
      const j = seg.findIndex((l) => label.test(l))
      if (j === -1) return null
      return seg[j + 1] ?? null
    }
    recs.push({
      id: recId, name, activity, dateRange: dateLine ?? '', end: endTime, actState, status, statusReason,
      low: rangeLow2(pick(/^(?:预估)?普惠到手价$/)),
      floorLow: rangeLow2(pick(/^(?:预估)?最低到手价$/)),
    })
  }
  return recs
}

const recs = dyParseRecords(ls)
if (recs.length === 0) {
  /* 同上：走 __pack，别绕过收尾。 */
  return __pack({
    platform: 'dy', ok: false, error: '抖音活动记录未匹配到（页面结构待适配）',
    block: {
      id: 'dy-activity', title: '抖音活动报名', state: 'unknown',
      summary: '记录未匹配到（页面结构待适配），需人工查看',
      url: dyUrl, urlLabel: '打开抖音后台',
      items: [item('表格提取', '未匹配到', 'unknown', '见 out/debug-activity-dy.txt')],
    },
  })
}

const now2 = new Date()
const days2 = typeof cfg.activity.longTermDays === 'number' ? cfg.activity.longTermDays : 90
const abnormal2 = []
const activeActs = new Map()
const publishedActs = new Map()
let counted2 = 0
let ignored2 = 0
for (const r of recs) {
  const longTerm = r.end !== '' && r.end >= ymd(new Date(now2.getTime() + days2 * 24 * 3600 * 1000))
  const ended = r.end !== '' && r.end < ymd(now2)
  if (longTerm || ended) { ignored2++; continue }
  counted2++
  const label = r.name || r.id
  const actName = cleanActivityName(r.activity) || '—'
  /* 第一重：抖音实际会减 3（源码里的实际规则，不是笔误） */
  if (r.low !== null && r.floorLow !== null && r.low > r.floorLow) {
    abnormal2.push({ label, value: '普惠到手价 ' + r.low + ' > 平台要求 ' + r.floorLow, state: 'crit', note: '抖音 · ' + actName, group: 'abnormal' })
  }
  /* 第二重：自设最低价（J 表），抖音额外 -3 */
  const jEntry = jmap.get(r.id)
  if (jEntry && jEntry.low !== undefined && jEntry.low !== '') {
    const pr = parsePriceRange2(jEntry.low)
    if (pr && r.low !== null) {
      const adjLow = pr.low - 3
      const adjHigh = pr.high - 3
      if (r.low < adjLow) abnormal2.push({ label, value: '到手价 ' + r.low + ' < 自设最低 ' + adjLow + '(-3)', state: 'crit', note: '抖音 · 券后最低价校验', group: 'abnormal' })
      else if (r.low > adjHigh) abnormal2.push({ label, value: '到手价 ' + r.low + ' > 自设最高 ' + adjHigh + '(-3)', state: 'crit', note: '抖音 · 券后最低价校验', group: 'abnormal' })
    }
  }
  /* ⚠️ 报名状态异常**只标 warn，不升块状态为 crit**（源码注释：当前价格调整阶段属正常） */
  if (r.status !== '' && !/报名成功|报名中/.test(r.status)) {
    abnormal2.push({ label, value: r.status + (r.statusReason ? '：' + r.statusReason : ''), state: 'warn', note: '抖音 · ' + actName, group: 'abnormal' })
  }
  if (r.actState === '活动中') {
    const a = activeActs.get(actName) ?? { count: 0, end: '' }
    a.count++
    if (r.end !== '' && r.end > a.end) a.end = r.end
    activeActs.set(actName, a)
  } else if (r.actState !== '已结束') {
    const a = publishedActs.get(actName) ?? { count: 0, date: '' }
    a.count++
    if (r.dateRange !== '' && r.dateRange > a.date) a.date = r.dateRange
    publishedActs.set(actName, a)
  }
}
const hasCrit = abnormal2.some((i) => i.state === 'crit')
const state2 = hasCrit ? 'crit' : abnormal2.length > 0 ? 'warn' : 'ok'
const activeRows2 = [...activeActs].map(([n, a]) => ({ label: n, value: a.count + ' 个单品', state: 'ok', note: a.end !== '' ? '至 ' + timeNoYear(a.end) : '', group: 'active' }))
const publishedRows2 = [...publishedActs].map(([n, a]) => ({ label: n, value: a.count + ' 个单品', state: 'ok', note: a.date !== '' ? timeNoYear(a.date) : '', group: 'published' }))
let collapseLine2
if (activeRows2.length > 0 && activeRows2[0].note !== '') {
  collapseLine2 = { label: '活动进行中', value: String(activeRows2[0].note).replace(/^至 /, ''), state: 'ok', collapseShow: true }
} else if (publishedRows2.length > 0 && publishedRows2[0].note !== '') {
  collapseLine2 = { label: '最新活动', value: String(publishedRows2[0].note).split(' 至 ')[0] ?? publishedRows2[0].note, state: 'ok', collapseShow: true }
} else {
  collapseLine2 = { label: '活动', value: '—', state: 'ok', collapseShow: true }
}
const shown2 = [collapseLine2, ...abnormal2, ...activeRows2, ...publishedRows2]
const __r = {
  platform: 'dy', ok: true, error: null,
  block: {
    id: 'dy-activity', title: '抖音活动报名', state: state2,
    summary: hasCrit
      ? abnormal2.filter((i) => i.state === 'crit').map((i) => i.label + ' ' + i.value).join(' · ').slice(0, 80)
      : '计入 ' + counted2 + ' 条 · ' + (activeRows2.length > 0 ? '活动中 ' + activeRows2.length + ' 个活动' : '无活动中活动') + (publishedRows2.length > 0 ? ' · 已发布 ' + publishedRows2.length + ' 个' : '') + (ignored2 > 0 ? '（忽略 ' + ignored2 + '）' : ''),
    url: dyUrl, urlLabel: '打开抖音后台',
    items: shown2.length > 0 ? shown2 : [item('校验结果', '无在期已报名活动', 'ok', '')],
  },
}
`

/**
 * `activity` 的 `code.js` 全文。
 *
 * @param platform - `'tm'` 天猫、`'dy'` 抖音。
 * @param jobId - 这份工作流的短名（进结果文件的 `job` 字段）。
 * @returns 该步的代码。
 *
 * ⚠️ J 表（`J-交易-店铺编码ID.xlsx`）**不在代码里读** —— 它是外部文件，
 * 由上游传一个 `jmap`（`Map<商品ID, {low}>`）进来。拿不到就跳过第二重校验。
 *
 * ## ⚠️ 2026-10-14：拆开之后这里**多了一段收尾**
 *
 * 原设计里，`codeParseActivity` 只返回 `{platform, ok, error, block}`（单个块），
 * 再由**合并节点**把它包成完整的 `PatrolResult`（`{job, runAt, dataDate, ok, error, blocks}`）。
 *
 * 拆成「一平台一份」之后**没有合并节点了** —— 所以这段收尾必须搬进来，
 * 否则结果文件缺 `job` / `runAt` / `blocks` 这些面板要的字段（实测：`job=undefined`）。
 *
 * @param platform - `'tm'` 天猫、`'dy'` 抖音。
 * @param jobId - 这份工作流的短名。
 * @returns 该步代码（**已含收尾**）。
 */
export function codeParseActivity(platform, jobId = 'activity') {
  return CODE_UNWRAP + CODE_TEXT_UTILS + CODE_PICK_CFG_TEXT + `
/* ## 唯一一处「把单块包成完整结果」的地方（2026-10-30 修）
 *
 * 原来这段收尾只贴在末尾那个 return 上，而平台段里有提前返回
 * （「卡片 / 记录未匹配到」那两处），它们直接 return 了单数 block 的半成品、
 * 绕过了收尾 —— 盘上跑出来就是 {platform, ok, error, block}，
 * 缺 job / runAt / dataDate，blocks 也不是数组。
 *
 * 现在把收尾抽成 __pack，平台段里的每个出口都走它。形状只有这一份。 */
const __pack = (r) => {
  const block = (r && r.block) ? r.block : null
  const blocks = block ? [block] : []
  const err = (r && r.error) ? String(r.error) : null
  /* ⚠️ ok 优先用上游给的那个（2026-10-30 修）：
   * 原来这里一律 blocks.length > 0，于是「卡片没匹配到」那条失败路径
   * 因为也放了 1 块（装着失败原因），ok 被翻成 true ——
   * 盘上会看到 ok: true 配一句「未匹配到」的 error，自相矛盾。
   * 成功路径上 r.ok 本来就是 true，与旧算法等价，所以这条不改变正常行为。 */
  const ok = typeof (r && r.ok) === 'boolean' ? r.ok : blocks.length > 0
  return {
    job: ${JSON.stringify(jobId)},
    platform: ${JSON.stringify(platform)},
    runAt: new Date().toISOString(),
    dataDate: today(),
    ok,
    error: ok ? err : (err || '采集失败'),
    blocks,
  }
}
const ls = toLines(pageBodyText)

/* ⚠️ J 表（自设券后最低价）由**上游**提供（它来自一个 xlsx 文件，碰外部世界）。
 * 形状：Map 或「数组 of {id, low}」——两种都接，拿不到就是空表（跳过第二重校验）。 */
const jRaw = (() => {
  const hit = pickUpstream((v) => v.jmap !== undefined && v.jmap !== null)
  return hit === null ? null : hit.jmap
})()
const jmap = jRaw instanceof Map ? jRaw : new Map((Array.isArray(jRaw) ? jRaw : []).map((e) => [String(e.id ?? ''), { low: String(e.low ?? '') }]))

` + (platform === 'tm' ? TM_ACTIVITY : DY_ACTIVITY) + `
/* 平台段正常收尾：__r 是它算出来的单块，交给 __pack 打包。
 * 「有没有块」与错误文案都在 __pack 里，这里不再重算一遍（一处一套）。 */
return __pack(__r)
`
}

/** `activity` 最后一步：把两个平台的结果合并成一份 `PatrolResult`（照 `runActivity`）。
 *
 * ⚠️ 两个平台的解析各返回 `{platform, ok, error, block}`，这里合并成
 * `{job, runAt, dataDate, ok, error, blocks}` —— 与另外两个 job 输出**同一形状**
 * （面板只认这一种）。
 *
 * 「部分失败仍算 ok」（照源码 `ok = blocks.length > 0`）：
 * 一家挂了另一家成功时整体算成功，但 `error` 里记着原因。
 */
export const CODE_MERGE_ACTIVITY = CODE_UNWRAP + CODE_TEXT_UTILS + `
const results = []
for (const v of __flat) {
  if (v === null || typeof v !== 'object') continue
  if (typeof v.platform === 'string' && v.block !== undefined && v.block !== null) results.push(v)
}
if (results.length === 0) {
  throw new Error('没收到任何平台的解析结果（上游两条链都没跑？）')
}
const blocks = []
const errors = []
for (const r of results) {
  blocks.push(r.block)
  if (r.error) errors.push((r.platform === 'tm' ? '天猫: ' : '抖音: ') + String(r.error).slice(0, 160))
}
const ok = blocks.length > 0
return {
  job: 'activity',
  runAt: new Date().toISOString(),
  dataDate: today(),
  ok,
  error: ok ? (errors.length > 0 ? errors.join('；') : null) : (errors.join('；') || '采集失败'),
  blocks,
}
`
