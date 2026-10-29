/** 五份巡查结果的形状必须统一，而且**盘上真正跑出来的**也要统一。
 *
 * ## 这条测试为什么存在（2026-10-30，票 10）
 *
 * 用户看到的是 `patrol/` 下那五个结果文件，不是存档、也不是解析代码。
 * 所以「生成器写对了」不等于「盘上对了」—— 实测踩到：
 *
 *   存档里解析节点的末尾 `return` 带 `job / platform / runAt / dataDate / ok / error / blocks`，
 *   但同一段代码**前半部分有提前返回**（「卡片 / 记录未匹配到」那两处），
 *   它们直接 `return` 了单数 `block` 的半成品、绕过了末尾的收尾。
 *   于是盘上跑出来是 `{platform, ok, error, block}` —— 缺三个字段、`blocks` 也不是数组。
 *
 * 那一份是**真的按失败路径跑过**（`patrol-tm-activity.json` 的 error 写着
 * 「天猫活动卡片未匹配到（页面结构待适配）」），所以它不是「没跑到」，是「跑到了错的那条出口」。
 *
 * ## 这条测试盯五件事
 *
 * 1. 五份解析代码里**没有绕过收尾的出口**（每处 `return` 都走 `__pack`）
 * 2. 真跑那几段代码（喂假输入），返回的键都是 `job / platform / runAt / dataDate / ok / error / blocks`
 * 3. 三份非活动类的解析代码同样满足第 2 条
 * 4. **失败路径**（卡片没匹配到）与**成功路径**形状相同
 * 5. `sys.fs.write` 的 path 与 `PATROL_JOBS[].outFile` 一一对上
 *
 * ⚠️ 判据落在「真跑出来的键」上，不是「源码里有 blocks 这个词」——
 * 后者在 bug 存在时**照样是绿的**（末尾那段的 `blocks` 一直都在）。
 *
 * 跑法：`DSH_HOME=F:/AGENTS/agent-chat-dsh node tests/patrol-shape.mjs`
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { codeParseActivity } from '../scripts/patrol/code-activity.mjs'
import { codeParseShop } from '../scripts/patrol/code-shop.mjs'
import { codeParseQianchuan } from '../scripts/patrol/code-qianchuan.mjs'
import { PATROL_JOBS } from '../scripts/patrol/jobs.mjs'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 一份巡查结果必须有的键（顺序也固定）。 */
const SHAPE = ['job', 'platform', 'runAt', 'dataDate', 'ok', 'error', 'blocks']

/**
 * 一份最小可用的上游：配置 + 页面文本。
 *
 * ⚠️ 这几段代码都要求上游带 `cfg.thresholds`（否则明确抛「没拿到配置」）——
 * 那是它们的设计，不是测试要绕的东西。
 *
 * 形状照真实的 `monitor.json`（`profiles/desktop/data/workbench/monitor.json`）：
 * `thresholds.score.tm.good / .warn`、`thresholds.score.dy…`、`thresholds.alert.warn / .crit`、
 * `thresholds.qianchuan.*`。**造错形状会让店铺解析在半路抛 TypeError**
 * （它读 `cfg.thresholds.score.tm`），那是喂错数据，不是代码坏。
 *
 * @param text - 假装取到的整页文本。
 * @returns 上游数组。
 */
function upstream(text) {
  return [
    { text },
    {
      cfg: {
        thresholds: {
          score: { tm: { good: 4.8, warn: 4.6 }, dy: { good: 90, warn: 85 } },
          alert: { warn: 1, crit: 5 },
          qianchuan: { dailyBudget: 500, budgetWarnPct: 0.8, balanceWarn: 3000, balanceCrit: 0 },
        },
        activity: { longTermDays: 90 },
      },
      configSource: 'file',
    },
  ]
}

/**
 * 把一段 `code.js` 正文当函数跑一遍。
 *
 * @param code - 页面/数据变换代码。
 * @param input - 上游。
 * @returns 它 return 的东西。
 */
async function runCode(code, input) {
  const runner = new Function('input', '"use strict";return (async () => {' + code + '})()')
  return await runner(input)
}

/**
 * 生成某一类的解析代码。
 *
 * @param kind - `shop` / `activity` / `qianchuan`。
 * @param platform - `tm` / `dy`。
 * @param id - 这份工作流的短名。
 * @returns 代码正文。
 */
function codeFor(kind, platform, id) {
  if (kind === 'activity') return codeParseActivity(platform, id)
  if (kind === 'qianchuan') return codeParseQianchuan(id, platform)
  return codeParseShop(platform, id)
}

console.log('=== 巡查结果形状统一 ===')
console.log('PATROL_JOBS 份数：' + String(PATROL_JOBS.length))
console.log('')

/* ── ① 源码里没有绕过收尾的出口 ────────────────────────────────
 *
 * 判据很挑剔：**每一处顶层 `return` 后面都必须跟着 `__pack`**（或紧跟那两行注释）。
 * 这个 bug 的形态就是「末尾那处走 __pack、中间那处直接 return 半成品」，
 * 所以只数「有没有 blocks」是抓不到的。
 *
 * ⚠️ 只有活动那两份（`codeParseActivity`）走 `__pack`：店铺与千川是**另一套写法**
 * （自己算好 blocks 再 return），它们从来就没有「提前返回绕过收尾」这个病 ——
 * 实测它们每份都只有 1 处顶层 return，且都写全了 7 个键。
 * 所以 ① 只对活动类适用；店铺 / 千川由 ② 真跑验形状。 */
console.log('① 解析代码里没有绕过收尾的 return（活动类）')
for (const job of PATROL_JOBS) {
  const code = codeFor(job.kind, job.platform, job.id)
  const topReturns = code.split('\n').filter(l => /^return /.test(l))
  if (job.kind === 'activity') {
    const bad = topReturns.filter(l => !/^return __pack\(/.test(l))
    check('★★ ' + job.id + ' 每一处顶层 return 都走 __pack',
      topReturns.length > 0 && bad.length === 0,
      '顶层 return ' + String(topReturns.length) + ' 处' + (bad.length === 0 ? '' : '，其中 ' + String(bad.length) + ' 处绕过：' + bad.join(' | ')))
  } else {
    /* 非活动类：只该有 1 处出口（没有中间分支早退）。多出来就是又埋了一个绕过点。 */
    check('★★ ' + job.id + ' 只有一处顶层 return（没有中途早退）',
      topReturns.length === 1, '顶层 return ' + String(topReturns.length) + ' 处')
  }
  /* 单数 `block:` 只许出现在 `block: {` 这种「传进去的块」位置，
   * 不许出现在「return 的东西」里 —— 后者就是那个 bug。 */
  const badInline = [...code.matchAll(/return \{[^}]*\bblock:\s*\{/g)]
  check('★ ' + job.id + ' 没有直接 return 单数 block',
    badInline.length === 0, String(badInline.length) + ' 处')
}

/* ── ② 三份非活动类真跑：返回形状对 ──────────────────────────── */
console.log('')
console.log('② 真跑：商店 / 千川三份的返回形状')
for (const job of PATROL_JOBS.filter(j => j.kind !== 'activity')) {
  const code = codeFor(job.kind, job.platform, job.id)
  let out
  try {
    out = await runCode(code, upstream('随便一段没有关键数据的页面文本'))
  } catch (e) {
    check('★★ ' + job.id + ' 能跑起来', false, e instanceof Error ? e.message.slice(0, 60) : String(e))
    continue
  }
  const keys = out !== null && typeof out === 'object' ? Object.keys(out) : []
  check('★★ ' + job.id + ' 返回的键与约定一致', JSON.stringify(keys) === JSON.stringify(SHAPE), JSON.stringify(keys))
  check('★ ' + job.id + ' blocks 是数组', Array.isArray(out?.blocks), Object.prototype.toString.call(out?.blocks))
}

/* ── ③ 活动类：失败路径与成功路径形状相同 ───────────────────────
 *
 * ⚠️ **失败路径就是那个 bug 的现场**：卡片没匹配到 → 提前返回 → 形状缺三个字段。
 * 所以这一条必须是「喂一段一定匹配不到的文本」，而不是只验成功路径。 */
console.log('')
console.log('③ 活动类：失败路径与成功路径形状相同')
for (const job of PATROL_JOBS.filter(j => j.kind === 'activity')) {
  const code = codeFor(job.kind, job.platform, job.id)

  let bad
  try {
    /* 「一定匹配不到」的文本：一句废话，不含卡片/记录需要的字段。 */
    bad = await runCode(code, upstream('这是一段不含任何活动卡片的页面文本'))
  } catch (e) {
    check('★★ ' + job.id + ' 失败路径能跑起来', false, e instanceof Error ? e.message.slice(0, 60) : String(e))
    continue
  }
  const badKeys = bad !== null && typeof bad === 'object' ? Object.keys(bad) : []
  check('★★ ' + job.id + ' 失败路径也返回完整形状（这一条就是那个 bug）',
    JSON.stringify(badKeys) === JSON.stringify(SHAPE), JSON.stringify(badKeys))
  check('★★ ' + job.id + ' 失败路径也是 blocks 数组（不是单数 block）',
    Array.isArray(bad?.blocks), Object.prototype.toString.call(bad?.blocks))
  check('★ ' + job.id + ' 失败路径 blocks 有 1 块（失败原因装在里面）',
    Array.isArray(bad?.blocks) && bad.blocks.length === 1, String(bad?.blocks?.length))
  check('★ ' + job.id + ' 失败路径 ok 为假且有 error',
    bad?.ok === false && String(bad?.error ?? '') !== '', String(bad?.error))
  check('★ ' + job.id + ' 失败路径有 job 与 dataDate（原来缺这两个）',
    bad?.job === job.id && /^\d{4}-\d{2}-\d{2}$/.test(String(bad?.dataDate ?? '')),
    String(bad?.job) + ' / ' + String(bad?.dataDate))
}

/* ── ④ 落盘路径与 PATROL_JOBS 一一对上 ─────────────────────────── */
console.log('')
console.log('④ 重建后的存档里 sys.fs.write 的 path 与 outFile 对上')

const DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
if (!existsSync(DIR)) {
  console.log('（本机没有存档目录：' + DIR + '，跳过这一条）')
  check('★ 存档目录存在', false, '先跑 node scripts/build-patrol-workflows.mjs')
} else {
  for (const job of PATROL_JOBS) {
    const file = join(DIR, job.name + '.json')
    if (!existsSync(file)) {
      check('★★ ' + job.id + ' 的存档存在', false, job.name + '.json 不存在')
      continue
    }
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const writes = (doc.nodes ?? []).filter(n => n.defId === 'sys.fs.write')
    /* 每份都有两个写盘点：夜禁跳过那个 + 正常那个 —— 两者路径必须是同一个 outFile。 */
    const paths = [...new Set(writes.map(n => String(n.params?.path ?? '')))]
    const expected = '/' + job.outFile
    check('★★ ' + job.id + ' 写盘路径与 outFile 一致',
      paths.length === 1 && paths[0].endsWith(expected),
      JSON.stringify(paths))
  }
}

/* ── ⑤ 判定逻辑没被顺手改 ─────────────────────────────────────
 *
 * 挑几个「说得出为什么」的阈值与关键词，证明这一轮只动了形状。
 * 这些数来自源码（`自动巡查` 的巡检规则），改它们等于改业务判定。 */
console.log('')
console.log('⑤ 判定逻辑没被顺手改（挑几处阈值 / 关键词）')
{
  const tmAct = codeParseActivity('tm', 'patrol-tm-activity')
  check('★ 天猫活动：长期活动天数默认 90', tmAct.includes('longTermDays') && tmAct.includes('90'), '')
  check('★ 天猫活动：忽略规则函数还在', tmAct.includes('activityIgnored'), '')
  const dyAct = codeParseActivity('dy', 'patrol-dy-activity')
  check('★ 抖音活动：记录解析函数还在', dyAct.includes('dyParseRecords'), '')
  const shopTm = codeParseShop('tm', 'patrol-tm-shop')
  const shopDy = codeParseShop('dy', 'patrol-dy-shop')
  /* 判据落在店铺自己那两个取值窗口上。**两份要分开取**：
   * 'tm' 只产出天猫那一段、'dy' 只产出抖音那一段，
   * 用一份去验另一平台的窗口永远找不到（第一版就这么写错了）。
   *
   * 只比窗口那一段，不把正则拼进去 —— 源码是模板字符串，生成后反斜杠会变一层。
   * 也不写 || 兜底。 */
  const near = (code, label) => {
    const at = code.indexOf(label)
    if (at < 0) return ''
    return code.slice(at, at + 160)
  }
  check('★ 店铺：天猫支付金额的取值窗口是 lookAhead 2 / lookBack 1',
    /\{ lookAhead: 2, lookBack: 1 \}/.test(near(shopTm, '/^支付金额$/')),
    near(shopTm, '/^支付金额$/').slice(0, 120))
  check('★ 店铺：抖音成交金额的取值窗口是 lookAhead 3 / lookBack 2',
    /\{ lookAhead: 3, lookBack: 2 \}/.test(near(shopDy, 'findValueNear(ls, /成交金额/')),
    near(shopDy, 'findValueNear(ls, /成交金额/').slice(0, 130))
  const qc = codeParseQianchuan('patrol-dy-qianchuan', 'dy')
  check('★ 千川：余额解析还在', qc.length > 500, String(qc.length) + ' 字符')
}

console.log('')
console.log(failed === 0 ? '结论：五份巡查结果的形状统一，失败路径与成功路径一致 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
