/** `qianchuan` 的解析代码（照 `自动巡查/src/jobs/qianchuan.ts`）。
 *
 * 页面：千川首页 —— 账户整体消耗 / 账户余额 / 净成交金额 / 净成交ROI。
 *
 * ⚠️ 两条实测出来的解析规则（`out/debug-qianchuan.txt` 真样本）：
 *   ① 数字卡是**拆行**的：标签行后是 `0` 与 `.00` **两行**，必须**拼接**
 *      —— 不拼就只拿到 `0`
 *   ② 「今日消耗」只能用 `账户整体消耗` 卡（fallback `整体消耗(元)`）——
 *      **不能用宽松的「消耗」匹配**：页面顶部「近7日…已消耗 893.57元」会被误取
 *      （源码里 2026-09-12 用户实测暴露的教训）
 */
import { CODE_UNWRAP, CODE_TEXT_UTILS, CODE_PICK_CFG_TEXT } from './code-common.mjs'

/** `qianchuan` 的 `code.js` 全文。
 *
 * @param jobId - 这份工作流的短名（进结果文件的 `job` 字段）。
 *   ⚠️ **2026-10-14 加的**：拆成「一平台一份」之后，`job` 不该再写死 ——
 *   否则面板分不清哪份结果是谁的。默认回退到旧值，单独调它（如测试）不传也能用。
 * @param platform - 平台代号（进结果文件的 `platform` 字段）。
 *   ⚠️ **2026-10-30 补**：五份巡查结果要形状统一，而这一份原来**根本没有这个键**
 *   （其余四份都有）。缺它的时候面板只能靠 `job` 猜平台，猜法一旦不一致就分错。
 *   默认 `'dy'` —— 千川本来就属抖音那条线（`PATROL_JOBS` 里 `platform: 'dy'`）。
 */
export function codeParseQianchuan(jobId = 'qianchuan', platform = 'dy') {
  return CODE_UNWRAP + CODE_TEXT_UTILS + CODE_PICK_CFG_TEXT + `
/* ── 以下逐行照 自动巡查/src/jobs/qianchuan.ts ── */
const t = cfg.thresholds.qianchuan
const ls = toLines(pageBodyText)

/* 拆分数字卡提取：标签行后最多 3 行内的数字片段**拼接**（页面实锤结构）。 */
const splitMetric = (label) => {
  for (let i = 0; i < ls.length; i++) {
    if (!label.test(ls[i])) continue
    let digits = ''
    for (let j = i + 1; j <= Math.min(ls.length - 1, i + 3); j++) {
      if (/^[\\d.]+$/.test(ls[j])) digits += ls[j]
      else if (digits !== '') break
    }
    return digits === '' ? null : digits
  }
  return null
}

const balanceText = splitMetric(/^账户余额/)
const balance = num(balanceText)
const spendText = splitMetric(/^账户整体消耗/) ?? splitMetric(/^整体消耗\\(元\\)/)
const spend = num(spendText)
const gmv = splitMetric(/^净成交金额/)
const roi = splitMetric(/^净成交ROI/)

const items = []
let spendState = 'unknown'
if (spend !== null) {
  if (spend >= t.dailyBudget) spendState = 'crit'
  else if (spend >= t.dailyBudget * t.budgetWarnPct) spendState = 'warn'
  else spendState = 'ok'
  items.push(item('今日消耗', spendText ?? String(spend), spendState,
    spendState === 'ok' ? '账户整体消耗' : '账户整体消耗 · 预算 ' + t.dailyBudget + ' · 达 ' + Math.round((spend / t.dailyBudget) * 100) + '%', true))
} else {
  items.push(item('今日消耗', '—', 'unknown', '未匹配到，需人工查看', true))
}
let balanceState = 'unknown'
if (balance !== null) {
  if (balance <= t.balanceCrit) balanceState = 'crit'
  else if (balance <= t.balanceWarn) balanceState = 'warn'
  else balanceState = 'ok'
  items.push(item('账户余额', String(balance), balanceState,
    balanceState !== 'ok' ? '余额不足预警' : '', balanceState === 'warn' || balanceState === 'crit'))
} else {
  items.push(item('账户余额', '—', 'unknown', '未匹配到，需人工查看'))
}
if (gmv !== null) items.push(item('今日成交金额', gmv + ' 元', 'ok', '', true))
else items.push(item('今日成交金额', '—', 'unknown', '未匹配到', true))
if (roi !== null) items.push(item('ROI', roi, 'ok', ''))
else items.push(item('ROI', '—', 'unknown', '未匹配到'))

const state = worst(items)
const block = {
  id: 'qianchuan',
  title: '推广消耗（千川）',
  state,
  summary: state === 'ok'
    ? '消耗 ' + (spend ?? '—') + ' / 预算 ' + t.dailyBudget + ' · 余额 ' + (balance ?? '—')
    : items.filter((i) => i.state === 'warn' || i.state === 'crit').map((i) => i.label + ' ' + i.value).join(' · ') || '数据未采集到',
  url: 'https://qianchuan.jinritemai.com/home',
  urlLabel: '打开千川后台',
  items,
}

return {
  job: ${JSON.stringify(jobId)},
  platform: ${JSON.stringify(platform)},
  runAt: new Date().toISOString(),
  dataDate: today(),
  ok: spend !== null || balance !== null,
  error: (spend === null && balance === null) ? '消耗/余额均未匹配到（页面结构待适配）' : null,
  blocks: [block],
}
`
}
