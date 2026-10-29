/** 「天猫取数」工作流的页面内代码（照 `自动下载/src/tb-sycm.ts`）。
 *
 * ## 对应原脚本
 *
 * `下载天猫.bat` → `node src/tb-sycm.ts`。
 *
 * ## ⚠️ 这份脚本有**四条护栏**，都必须搬进工作流（源码原话）
 *
 * | 护栏 | 源码写法 | 搬法 |
 * | --- | --- | --- |
 * | **夜禁 01:00–06:00** | `h>=1 && h<6` → `exit 2` | `flow.if` 分支（与巡查一致） |
 * | **风控信号** | 响应含「滑块/验证码/操作过于频繁/请重新登录」→ **立即终止，退出码 2，绝不重试** | 页面内抛 `RISK:` → 让节点失败 |
 * | **连续 2 张报表未拿到地址** | 立即停止 | 解析那步的护栏（见下） |
 * | **请求间隔随机 8–15 秒** | `GAP_MIN_MS` / `GAP_MAX_MS` | **在页面内 sleep**（页面里发请求，节奏也在页面里控） |
 *
 * ⚠️ **为什么节奏控制放在页面内的 eval 里**：请求是页面内 `fetch` 发的
 * （要带页面 cookie / UA / Referer 才不被反爬），所以间隔也该在同一个循环里控。
 * 若搬到工作流层用 `flow.delay`，那段代码就得拆成「一张报表一个节点」——
 * 而报表张数是**运行时才知道**的（要先 fetch 名单），表达不了。
 *
 * ## ⚠️ 日期口径与抖音**不同**（源码专门写了注释警告）
 *
 * - **抖音**：文件名日期 = **数据日期**（脚本手动拼的）
 * - **天猫**：文件名日期 = **系统下载日期**（淘宝自动命名），数据日期在表格内部
 * → 所以「今天是否已跑过」用**文件名含今天**判断，不能用数据日期。
 *   源码还警告：**要用本地日期**（`toISOString` 在 UTC+8 早上 8 点前会取到昨天 → 误判已下载跳过）。
 */

/** 取报表名单（页面内 fetch）。 */
export const TM_FETCH_REPORTS = `
/* 页面内：取报表名单 + 风控检测。
 * ⚠️ 用页面内 fetch（**不是**宿主半的 HTTP）—— 要带页面的 cookie/UA/Referer 才过反爬。
 * 源码原话：「天猫的反爬特别严格……能直接用 API 是因为 API 和点击的页面效果反馈是一样的，
 * 而不是他可以不通过浏览器」。 */
const r = await fetch('https://sycm.taobao.com/lyone/fetchData/getReportList.json?pageSize=50&currentPage=1&keyword=&space=personal', { credentials: 'include' })
const t = await r.text()
/* ⚠️ **风控信号 → 立即终止**（源码：退出码 2，**绝不重试**，等 24 小时）。 */
if (/滑块|验证码|操作过于频繁|请重新登录/.test(t)) {
  throw new Error('RISK: ' + t.slice(0, 150))
}
const j = JSON.parse(t)
const reports = ((j && j.data && j.data.reportList) || []).map((x) => ({ id: x.id, name: x.reportName }))

/** 报表名 → 文件夹（照源码 folderFor：关键词→搜索，去掉最后一段）。 */
const folderFor = (reportName) => {
  const key = String(reportName).includes('关键词') ? String(reportName).replace('关键词', '搜索') : String(reportName)
  const parts = key.split('-')
  parts.pop()
  return parts.join('-')
}
return { reports: reports.map((x) => ({ ...x, folder: folderFor(x.name) })) }
`

/**
 * 「过滤今天已下载的」那步的**纯逻辑**部分（把「列目录」的结果喂进来）。
 *
 * ⚠️ 列目录是碰外部世界 → 由 `code.shell` 做；这里只做判断（纯变换）。
 */
export const TM_FILTER_TODAY = `
/* 上游有**两条边**：① 报表名单（直接来自「取报表名单」那步）+ ② 列目录结果。
 *
 * ⚠️ 而「取报表名单」是 browser.act —— 它的输出是驱动包的一层
 * （\`{ result: <页面脚本的返回值> }\`，见 driver.mjs 的 actEval），
 * 所以要**往里剥一层**才能拿到 reports。
 * 实测踩到：不剥就报「没拿到报表名单」。
 *
 * ⚠️ 另外「列目录」那步是 code.shell —— 它交给下游的是纯文本
 * （src/dispatch/executors.ts 里 return { status:'success', output: out.trim() }），
 * 所以字符串要先解析成对象。⚠️ 2026-10-16 修的线上 BUG：原先只写了
 * 「已经是对象」那条路（typeof v !== 'object' 就直接返回 null），
 * 于是真机上列目录那步明明成功、却报「没拿到报表名单」。
 * 与抖音那份是同一个病根（那边报了「拿不到目录清单」），
 * 见 pitfalls/同一件事写两份迟早漂.md。 */
const arr = Array.isArray(input) ? input : [input]
/** 把一条上游值归一成对象；认不出来返回 null。 */
const un = (v) => {
  if (v === null || v === undefined) return null
  /* ① 字符串：shell 的 stdout。取最后一行能解析成 JSON 的。 */
  if (typeof v === 'string') {
    const lines = v.trim().split(/\\r?\\n/).filter((l) => l.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i])
        if (o !== null && typeof o === 'object') return un(o)
      } catch { /* 往前找 */ }
    }
    return null
  }
  if (typeof v !== 'object') return null
  if (Array.isArray(v.reports) || Array.isArray(v.dirs)) return v
  /* ② 剥驱动外壳（browser.act → { result: ... }）。 */
  if (v.result !== null && typeof v.result === 'object') return un(v.result)
  return v
}
const reports = []
const dirs = {}
for (const raw of arr) {
  const v = un(raw)
  if (v === null) continue
  if (Array.isArray(v.reports)) for (const r of v.reports) reports.push(r)
  if (Array.isArray(v.dirs)) for (const d of v.dirs) dirs[d.folder] = d.files || []
}
if (reports.length === 0) throw new Error('没拿到报表名单（上游「取报表名单」那步失败？）')

/* ⚠️ **必须用本地日期**（源码注释：toISOString 在 UTC+8 早上 8 点前会取到昨天
 * → 误判「已下载」→ 当天数据永远下不下来）。 */
const now = new Date()
const todayYMD = String(now.getFullYear())
  + String(now.getMonth() + 1).padStart(2, '0')
  + String(now.getDate()).padStart(2, '0')

const need = []
const skipped = []
for (const r of reports) {
  const files = dirs[r.folder] || []
  /* 判据照源码：文件名含**今天** → 今天是下过的。 */
  if (files.some((f) => String(f).includes(todayYMD))) skipped.push(r.folder)
  else need.push(r)
}
return { todayYMD, reports: need, skipped, allReports: reports }
`

/**
 * 触发下载 + 轮询拿 OSS 直链（页面内，含**随机间隔**与风控检测）。
 *
 * 对照源码那段 `page.evaluate`：一字一句照搬，包括
 * `POLL_TIMES=10` / `POLL_INTERVAL_MS=1200` / 间隔 `8000~15000ms` / `REPORT_AFTER_MS=3000`。
 */
export const TM_TRIGGER_AND_POLL = `
/* 上游：要下载的报表名单（含 id / name / folder）。
 *
 * ## 警告：这里是页面内代码，读不到 input
 *
 * 这一段由 browser.act 的 eval 动作在页面里跑 —— 那是被原样送进页面执行的字符串，
 * 页面里没有 input 这个变量（input 只在 code.js 那种 Node 侧节点里存在）。
 * 第一版照抄了 code.js 的写法，真机上直接报
 * ReferenceError: input is not defined（用户 2026-10-20 报的就是这个）。
 *
 * 正确做法：用变量替换把上游数据写进代码文本。
 * 上游那个节点输出的字段叫 reports，所以写占位符 reports 即可 ——
 * 对象会被 JSON.stringify 成合法 JS 字面量（见 workflow/variables.ts 的 toText）。
 *
 * 源码 tb-sycm.ts:152-184 是 page.evaluate(fn, { reports, ... }) ——
 * 数据走第二个参数；我们这条通道只有「代码字符串」，所以走变量替换。
 * 效果等价（同一份数据、同一段逻辑），只是注入方式不同。 */
const reports = Array.isArray({{reports}}) ? {{reports}} : []
if (reports.length === 0) return { results: [], note: '没有需要下载的报表' }

/* 节奏常量（照源码）。 */
const GAP_MIN_MS = 8000
const GAP_MAX_MS = 15000
const REPORT_AFTER_MS = 3000
const POLL_TIMES = 10
const POLL_INTERVAL_MS = 1200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 带风控检测的 GET（照源码 get()）。 */
const get = async (path) => {
  const r = await fetch('https://sycm.taobao.com' + path, { credentials: 'include' })
  const t = await r.text()
  if (/滑块|验证码|操作过于频繁|请重新登录/.test(t)) throw new Error('RISK: ' + t.slice(0, 150))
  return JSON.parse(t)
}

const out = []
for (let i = 0; i < reports.length; i++) {
  const rep = reports[i]
  /* ⚠️ 随机拟人间隔（源码注释：「请求间隔随机 8–15s，拟人化」）。 */
  if (i > 0) await sleep(GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS)))
  try {
    await get('/lyone/fetchData/download.json?reportId=' + rep.id)
    let url = null
    for (let k = 0; k < POLL_TIMES; k++) {
      await sleep(POLL_INTERVAL_MS)
      const q = await get('/lyone/fetchData/queryDownloadUrl.json?reportId=' + rep.id)
      if (q && q.data && q.data.status === '1' && q.data.url) { url = q.data.url; break }
    }
    out.push({ id: rep.id, name: rep.name, folder: rep.folder, url })
  } catch (e) {
    const m = String((e && e.message) || e)
    /* ⚠️ 风控**不在这里吞掉** —— 上抛，让整条链立刻停（源码：RISK 上抛终止全部）。 */
    if (m.startsWith('RISK:')) throw e
    out.push({ id: rep.id, name: rep.name, folder: rep.folder, url: null })
  }
  await sleep(REPORT_AFTER_MS)
}
return { results: out }
`

/* ⚠️ **`TM_GUARD_AND_PICK`（连续失败护栏）已于 2026-10-15 删除**（用户定）。
 *
 * 删的依据（两条独立发现一致 —— T8 的评估 §〇·甲 + T9 的 E7）：
 *   ① **它并不中断流程** —— 只产出 `downloadable` / `stopped` 两个字段，
 *      **没有 `throw`**；而它的 `onError` 是 `stop`，不抛错就触发不了失败分支
 *      → 那个节点每次都「成功」，界面上看不出它做没做事。
 *   ② **它的位置与源码不一致** —— 源码两个阶段里，**阶段一（触发+轮询）没有这道护栏**
 *      （只有风控立即终止）；护栏在**阶段二（下载）**里。
 *   ③ **真正的那道护栏已经在 ⑩ 下载那步的脚本里**（`tmall-shell.mjs` 的
 *      `CONSECUTIVE_LIMIT = 2` + `break`，而且它**两种失败都管**：拿不到地址、下载失败）。
 *   → 冗余且错位，留着只会让人以为这里有一道真正的护栏 ——
 *     「看着有防线」比「没有防线」更危险（见 `pitfalls/假防线-看着写了其实不生效.md`）。
 *
 * ⚠️ 它夹带的**纯数据**职责没有丢，并进了 `TM_PICK_FILENAME`：
 *   剥驱动外壳（`{result: …}`）+ 剔除 url 为空的项。
 *
 * ⚠️ 顺带说明「为什么没把它改成真会中断的」：要「中途停」现在就能做到
 * （循环体内 `throw` + `onError:'stop'` → 整条中断），但代价是**整条停**
 * （连写结果文件都不做）。而源码的护栏是「停该阶段、后面继续」——
 * 那种语义**引擎给不了**（循环没有 `break`，n8n / Dify 的迭代也都没有）。
 * 所以正确做法是「删掉这个假护栏，把真护栏留在 ⑩ 的脚本里」。
 */

/**

 *
 * ⚠️ 校验的必要性（照源码）：OSS 出错时会返回一段 HTML/文本（不是 xlsx），
 * 直接落盘就得到一个坏文件，而日志还说「成功」。源码的判据是 **PK 头**（zip 的前两字节），
 * 但那要在**拿到文件之后**才看得到，所以 PK 校验在 ⑩ 下载那步做，这里只取名字。
 *
 * ⚠️ **2026-10-15 合并**：原先这两件事在「连续失败护栏」那个节点里
 * （`TM_GUARD_AND_PICK`），护栏被删后并到这里。合并的只有**纯数据**那部分：
 *   ① **剥驱动外壳** —— ⑧ 是 `browser.act`，输出是驱动包的一层
 *      （`{ result: <页面脚本的返回值> }`）。不剥看不见 results，
 *      于是计划恒为空 —— **而且不报错**（看着像「今天没有要下的」）。
 *   ② **剔掉没拿到地址的项** —— url 为空的直接不进计划，
 *      否则 ⑩ 会拿着 null 去下载。
 * ⚠️ **没有并过来的**：护栏那段「连续 2 张失败就停」。它**本来就不生效**
 * （只产出 `stopped` 字段、不 `throw`，触发不了 `onError:'stop'`），
 * 而且**位置与源码不符**（源码阶段一没有这道护栏，它在阶段二下载里，
 * 真的那道在 ⑩ 的脚本中，`CONSECUTIVE_LIMIT = 2`）。
 * 见 `pitfalls/假防线-看着写了其实不生效.md`。
 */
export const TM_PICK_FILENAME = `
const up = input && typeof input === 'object' ? input : {}
/* 剥驱动外壳：两种形状都认（万一上游换成别的节点，直接给 results 也要能用）。 */
const payload = up.result !== undefined && up.result !== null ? up.result : up
const results = Array.isArray(payload.results) ? payload.results : []
/* 只留拿到地址的。 */
const downloadable = results.filter((r) => r && r.url !== null && r.url !== undefined)
/* 只算出「每个下载任务该落到哪」—— 真正的下载与校验由下一个节点（碰外部世界）做。 */
const plan = downloadable.map((r) => {
  const tail = String(r.url).split('/').pop() || ''
  const fn = decodeURIComponent(tail.split('?')[0])
  return { id: r.id, name: r.name, folder: r.folder, url: r.url, file: fn }
})
return {
  plan, count: plan.length,
  missing: results.length - downloadable.length,
  total: results.length,
}
`
