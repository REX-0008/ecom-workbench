/** 三个巡查 job 的 `code.js` 代码段（**单一来源**）。
 *
 * ## 为什么代码放在这里而不是直接写进生成器
 *
 * ① 这些 `code` 要**同时**给两个地方用：
 *    - 生成器（写进工作流存档）
 *    - 测试（`new Function` 跑起来，用真实样本验）
 *    放一处才不会两边分叉。
 * ② 它们很长（几百行），塞进生成器的模板字符串里没法读、没法 diff。
 *
 * ## 纪律（写这些代码时必须守）
 *
 * - **只做纯数据变换**：只吃 `input`、只吐返回值，**不碰文件/网络/命令**
 *   （见 `docs/机制-什么做成节点、什么写代码、什么做成工作流.md`）。
 *   碰外部世界的事由节点做（`browser.act` / `sys.fs.read` / `sys.fs.write`）。
 * - **从真实页面文本反推**：所有解析规则都是 `out/debug-*.txt` 实测出来的，
 *   改规则前先看那份样本。
 * - **不做静默兜底**：拿不到必要输入时**明确抛错**（比算出错档位好）。
 */

/**
 * 共用段：解析上游（可能是数组）+ 剥壳 + 按形状认。
 *
 * ⚠️ 为什么要「按形状认」而不是按下标：
 * 一个节点有两条入边时 `input` 是**数组**，而**顺序会随画布上连线的先后变**
 * （用户拖一下就可能变）。按形状认才稳。
 */
export const CODE_UNWRAP = `
/* 上游可能是数组（多入边）或单值。往里剥一层壳（flow.if / driver 会包 value / result）。 */
const __arr = Array.isArray(input) ? input : [input]
const __flat = []
const __push = (v) => {
  if (v === null || v === undefined) return
  if (Array.isArray(v)) { for (const x of v) __push(x); return }
  __flat.push(v)
}
for (const __item of __arr) __push(__item)
const pickUpstream = (pred) => {
  for (const v of __flat) {
    if (typeof v !== 'object' || v === null) continue
    if (pred(v)) return v
    if (v.value !== undefined && pred(v.value)) return v.value
    if (v.result !== undefined && pred(v.result)) return v.result
  }
  return null
}
`

/**
 * 共用段：机械文本分析（照 `自动巡查/src/text.ts`，逐条搬过来）。
 *
 * 这些都是纯函数，改一行都要先看 `text.ts` 的注释 ——
 * 那里面有实测教训（如「宽松邻近会错抓 50元投放补贴」）。
 */
export const CODE_TEXT_UTILS = `
/** 按行拆分并去空行。 */
const toLines = (text) => String(text ?? '').split(/\\r?\\n/).map((l) => l.trim()).filter((l) => l !== '')

/**
 * 在行流里找含 labelPat 的行，然后在 [该行自身, 之后 lookAhead 行] 里找第一个
 * 匹配 valuePat 的值；再向前面 lookBack 行找（有的卡片值在标签上方）。
 */
const findValueNear = (ls, labelPat, valuePat, opts) => {
  const lookAhead = (opts && opts.lookAhead) ?? 3
  const lookBack = (opts && opts.lookBack) ?? 3
  for (let i = 0; i < ls.length; i++) {
    if (!labelPat.test(ls[i])) continue
    const inline = ls[i].match(valuePat)
    if (inline) return { value: inline[0], at: i }
    for (let j = i + 1; j <= Math.min(ls.length - 1, i + lookAhead); j++) {
      const m = ls[j].match(valuePat)
      if (m) return { value: m[0], at: j }
    }
    for (let j = i - 1; j >= Math.max(0, i - lookBack); j--) {
      const m = ls[j].match(valuePat)
      if (m) return { value: m[0], at: j }
    }
  }
  return null
}

/**
 * 严格版：label 行后 1~3 行内第一个纯数值行命中（中间行必须非数值且非同类 label）。
 * 用途：同名关键词在导航/任务卡里也会出现（「商家体验分」既是菜单项又是评分卡标题），
 * 宽松邻近会错抓（「50元投放补贴」教训）。
 */
const findStrictValue = (ls, labelPat, valuePat) => {
  const vp = valuePat ?? /^\\d+(?:\\.\\d+)?\\s*(?:分)?%?$/
  for (let i = 0; i < ls.length; i++) {
    if (!labelPat.test(ls[i])) continue
    let hit = null
    for (let j = i + 1; j <= Math.min(ls.length - 1, i + 3); j++) {
      if (j !== i + 1 && labelPat.test(ls[j])) break
      if (vp.test(ls[j])) { hit = { value: ls[j], at: j }; break }
    }
    if (hit === null && i > 0 && vp.test(ls[i - 1])) hit = { value: ls[i - 1], at: i - 1 }
    if (hit !== null) return hit
  }
  return null
}

/** 从文本提取数字（去逗号/空格），失败 null。 */
const num = (text) => {
  if (text === null || text === undefined) return null
  const m = String(text).replace(/[,，\\s]/g, '').match(/-?\\d+(?:\\.\\d+)?/)
  return m === null ? null : Number(m[0])
}

/** 档位判定：>= good 档 ok；>= warn 档 warn；否则 crit（分数越高越好型）。 */
const grade = (value, thresholds, lowerIsBetter) => {
  if (value === null) return 'unknown'
  if (lowerIsBetter === true) {
    if (value <= thresholds.good) return 'ok'
    if (value <= thresholds.warn) return 'warn'
    return 'crit'
  }
  if (value >= thresholds.good) return 'ok'
  if (value >= thresholds.warn) return 'warn'
  return 'crit'
}

/** 组一个监控 item。 */
const item = (label, value, state, note, collapseShow) => ({
  label, value, state, note: note ?? '',
  ...(collapseShow === true ? { collapseShow: true } : {}),
})

/** 日期 YYYY-MM-DD（本地时区）。 */
const today = () => new Date().toLocaleDateString('sv')

/** 日期 YYYY-MM-DD（本地时区）from Date。 */
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

/** 时间文本省略年份（2026.09.16 20:00 → 09.16 20:00）。 */
const timeNoYear = (t) => String(t ?? '').replace(/\\b20\\d{2}[.\\-年]\\s*/g, '').replace(/年/g, '').trim()

/** 解析文本里的日期（2026-09-12 / 2026/9/12 / 09-12），返回 YYYY-MM-DD 或 null。 */
const parseDate = (text) => {
  const s = String(text ?? '')
  const full = s.match(/(20\\d{2})[-/.](\\d{1,2})[-/.](\\d{1,2})/)
  if (full) return full[1] + '-' + full[2].padStart(2, '0') + '-' + full[3].padStart(2, '0')
  const md = s.match(/(\\d{1,2})[-/.](\\d{1,2})/)
  if (md) {
    const y = new Date().getFullYear()
    return y + '-' + md[1].padStart(2, '0') + '-' + md[2].padStart(2, '0')
  }
  return null
}

/**
 * 活动名清洗（2026-09-12 用户定稿）：去平台/年份/月份与重复文本。
 * 例：「2026年天猫9月中秋团圆季-2026年9月中秋团圆季现货」→「中秋团圆季」。
 */
const cleanActivityName = (raw) => {
  const rawTrim = String(raw ?? '').trim()
  if (rawTrim === '') return ''
  const parts = rawTrim.split(/[-–—]/).map((s) => s.trim()).filter((s) => s !== '')
  if (parts.length === 0) return rawTrim
  const PREFIX = /^(?:20\\d{2}|\\d{2})年?(?:天猫|抖音|淘宝|京东|小红书|商城|官方)*(?:\\d{1,2}月)?/
  const SUFFIX = /(?:现货|预售|专场|活动|期间)+\\s*$/
  const PLATFORM_WORDS = /(天猫|抖音|淘宝|京东|小红书|商城)+/g
  const strip = (p) => {
    let s = p
    for (let i = 0; i < 3; i++) s = s.replace(PREFIX, '').trim()
    s = s.replace(SUFFIX, '').trim()
    return s
  }
  const stripped = parts.map(strip)
  let best = ''
  if (stripped.length >= 2) {
    const a = stripped[0]
    const shortest = stripped.reduce((m, s) => (s !== '' && s.length < m.length ? s : m), stripped[0])
    for (let i = 0; i < a.length; i++) {
      for (let len = a.length - i; len > best.length; len--) {
        if (len < 2) break
        const sub = a.slice(i, i + len)
        let all = true
        for (let j = 1; j < stripped.length; j++) {
          if (!stripped[j].includes(sub)) { all = false; break }
        }
        if (all && (shortest === '' || sub.length >= shortest.length * 0.5)) best = sub
      }
    }
  }
  let out = best !== '' ? best : (stripped.find((s) => s !== '') ?? rawTrim)
  out = out.replace(PLATFORM_WORDS, '').trim()
  return out === '' ? rawTrim : out
}

/** 状态取最差档（crit > warn > unknown > ok）。 */
const worst = (items) => {
  if (items.some((i) => i.state === 'crit')) return 'crit'
  if (items.some((i) => i.state === 'warn')) return 'warn'
  if (items.every((i) => i.state === 'ok')) return 'ok'
  return 'unknown'
}

/** 一句话摘要：有异常列异常，否则说正常/未采到。 */
const summarize = (items) => {
  const bad = items.filter((i) => i.state === 'warn' || i.state === 'crit')
  if (bad.length === 0) return items.every((i) => i.state === 'ok') ? '全部正常' : '部分指标未采集到'
  return bad.map((i) => i.label + ' ' + i.value).join(' · ')
}
`

/**
 * 共用段：从上游数组里取「配置」与「文本」。
 *
 * ⚠️ 这条链的形状（每一步只把上一步的输出给下一步）：
 *
 * ```
 * ① 读配置 ──→ ② 算时间 ──→ ③ 条件 ──→ ④ 打开 ──→ ⑤ 取文本 ──┐
 *                 └──────────────────────────────────────────→ ⑥ 解析
 * ```
 *
 * 所以 ⑥ 有**两条入边**、`input` 是数组：一条带 `text`（⑤ 给的），
 * 一条带 `cfg`（② 带上来的）。用 `pickUpstream` **按形状认**。
 */
export const CODE_PICK_CFG_TEXT = `
const textOf = pickUpstream((v) => typeof v.text === 'string')
const cfgOf = pickUpstream((v) => v.cfg !== undefined && v.cfg !== null)
/* ⚠️ 名字不能叫 pageText —— 那会与下面的「③ 打开页面」那段里的东西混。
 * 这里叫 pageBodyText，语义就是「页面 innerText」。 */
const pageBodyText = textOf === null ? '' : textOf.text
const cfg = cfgOf === null ? {} : cfgOf.cfg

if (cfg.thresholds === undefined) {
  throw new Error('没拿到配置（cfg.thresholds 为空）。'
    + '这条链上配置来自「① 读配置」，靠「② 算时间 → ⑥ 解析」那条边带过来 —— '
    + '若你改过工作流，请确认 ⑥ 有两条入边（⑤ 取文本 与 ③ 条件的成立出口）。')
}
`

/**
 * 共用段：解析配置 JSON + 兜默认值（**纯数据变换**）。
 *
 * ⚠️ 上游是 `sys.fs.read` 的输出（**文件文本**）或 `undefined`（文件不存在、
 * 那个节点按「失败处理：继续」跳过）—— 两种都要能处理。
 *
 * 为什么不把读文件写在这里：读文件**碰外部世界** → 归 `sys.fs.read` 节点；
 * 这里只负责「把文本变成配置对象」这个纯变换
 * （见 `docs/机制-什么做成节点、什么写代码、什么做成工作流.md`）。
 */
export const CODE_PARSE_CFG = `
/* 上游是 sys.fs.read 的返回值（文件文本字符串），或 undefined（没读到）。 */
const fileText = typeof input === 'string' ? input : ''
const DEFAULT = {
  cdp: { taobao: [9222], douyin: [9222, 9223], qianchuan: [9222, 9223] },
  thresholds: {
    score: { tm: { good: 4.8, warn: 4.6 }, dy: { good: 95, warn: 90 } },
    alert: { warn: 1, crit: 5 },
    qianchuan: { dailyBudget: 20000, budgetWarnPct: 0.8, balanceWarn: 3000, balanceCrit: 1000 },
  },
  activity: { longTermDays: 90 },
}
/* 深合并（对象层合并、数组整体替换）—— 与源码 config.ts 的 merge 同语义。 */
const mergeCfg = (base, patch) => {
  if (patch === null || patch === undefined) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const b = base[k]
    out[k] = (v !== null && typeof v === 'object' && !Array.isArray(v) && b !== null && typeof b === 'object' && !Array.isArray(b))
      ? mergeCfg(b, v) : v
  }
  return out
}
const raw = fileText.trim()
let cfg = DEFAULT
let configSource = '内置默认（配置文件没读到）'
if (raw !== '' && raw.startsWith('{')) {
  try { cfg = mergeCfg(DEFAULT, JSON.parse(raw)); configSource = 'monitor.json' }
  catch { configSource = '内置默认（配置文件不是合法 JSON）' }
} else if (raw !== '') {
  configSource = '内置默认（配置内容不是 JSON）'
}
return { cfg, configSource }
`

/**
 * 共用段：算当前小时 + 夜禁标记（纯数据变换）。
 *
 * @param bypass - 是否绕过夜禁（`true` = 手动跑，照 `巡查.bat` 的行为）。
 * @returns 该步的 code。
 */
export function codeCurfew(bypass) {
  return `
/* 上游 = 「② 解析配置」的输出 { cfg, configSource }，原样带下去给下游。 */
const up = input && typeof input === 'object' ? input : {}
return {
  ...up,
  hour: new Date().getHours(),
  bypassCurfew: ${bypass ? 'true' : 'false'},
  curfewTop: !${bypass ? 'true' : 'false'} && new Date().getHours() < 9,
}
`
}

/** 夜禁 `flow.if` 的条件表达式：没踩夜禁就能跑。 */
export const CURFEW_EXPR = 'input.curfewTop !== true'
