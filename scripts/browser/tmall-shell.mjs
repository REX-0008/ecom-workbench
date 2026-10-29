/** 「天猫取数」工作流的两个 shell 步骤（单一来源：生成器与测试都用）。
 *
 * ## 交接方式与「清洗入库」同一条约定
 *
 * **数据走文件，命令行只带一个路径**（`cmd /c` 会剥掉开头的引号、还有长度上限
 * —— 这两条都是实测踩出来的，见 `scripts/ingest/shell-steps.mjs` 的文件头）。
 *
 * ## ⚠️ 下载那步为什么必须走 shell（不能是 `browser.download` 节点）
 *
 * 天猫**不走浏览器的 download 事件**。它是：
 *   ① 页面内 `fetch` 触发下载 → 轮询拿到一个 **OSS 直链**
 *   ② 用 **Node 直接 GET 那个直链**（带 `User-Agent` + `Referer`，否则被 OSS 拒）
 *   ③ 落盘前**校验 PK 头**（zip 魔数 `0x50 0x4B`）—— OSS 出错时会返回一段 HTML/文本，
 *      不校验就会把坏文件当成功落盘，而日志还写「✅」（源码专门做了这个校验）
 *
 * 这三件事里 ① 是页面内（`browser.act/eval`），②③ 是 Node 的活 → 本文件。
 */

/** 两个脚本共用的读写工具（与 ingest 那边同一形状）。 */
const IO = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/* ⚠️ 入参是**一个工作目录**（不是一个 JSON 串）—— 命令行里不能有引号，见文件头。 */
const workDir = process.argv[2] ?? ''
if (workDir === '') {
  process.stdout.write(JSON.stringify({ ok: false, error: '没给工作目录' }) + '\\n')
  process.exit(1)
}
/** 读工作目录里的 JSON。 */
const readJson = (name) => {
  const p = join(workDir, name)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
/** 写工作目录里的 JSON（**只落盘，不打 stdout** —— 大内容会撑爆子进程缓冲）。 */
const writeJson = (name, obj) => { writeFileSync(join(workDir, name), JSON.stringify(obj), 'utf8') }
/** 收口：写文件 + 一行摘要 JSON 到 stdout。 */
const emit = (name, obj, fail) => {
  writeJson(name, obj)
  process.stdout.write(JSON.stringify(obj) + '\\n')
  process.exit(fail === true ? 1 : 0)
}
`

/**
 * ① 列各报表文件夹里已有的文件名（为「今天是否已下载」判断）。
 *
 * 入参：`workDir/reports.json` = `{ dataRoot, reports: [{folder}] }`
 * 出参：`workDir/dirs.json`    = `{ ok, dirs: [{folder, files}] }`
 *
 * ⚠️ 与源码一致：只看**文件名**（含 `~$` 锁文件要排除），不解析文件内容。
 */
export const TM_LIST_DIRS = IO + `
const a = readJson('reports.json')
if (a === null) { emit('dirs.json', { ok: false, error: '读不到 reports.json（上游那步没跑？）' }, true) }
const path = await import('node:path')
const fs = await import('node:fs')
const dataRoot = String(a.dataRoot ?? '')
if (dataRoot === '') emit('dirs.json', { ok: false, error: 'reports.json 里没有 dataRoot' }, true)

/** 去重：同一文件夹可能被多张报表共用（如「短视频-自营/合作」都在 D-店铺-视频-抖音）。 */
const seen = new Set()
const dirs = []
for (const r of a.reports ?? []) {
  const folder = String(r.folder ?? '')
  if (folder === '' || seen.has(folder)) continue
  seen.add(folder)
  let files = []
  try {
    /* ⚠️ 排除 ~$ 开头的 **Office 锁文件**（照原脚本）。 */
    files = fs.readdirSync(path.join(dataRoot, folder))
      .filter((f) => /\\.(xlsx|xls)$/i.test(f) && !f.startsWith('~$'))
  } catch { /* 文件夹不存在 = 今天没下过，正常 */ }
  dirs.push({ folder, files })
}
emit('dirs.json', { ok: true, dirs, scannedAt: new Date().toISOString() })
`

/**
 * ② 下载 OSS 直链并落盘（带 UA/Referer + PK 校验 + 连续失败护栏）。
 *
 * 入参：`workDir/plan.json` = `{ dataRoot, plan: [{folder, file, url, name}], missing, total }`
 * 出参：`workDir/summary.json` = `{ ok, downloaded, failed, skipped, results }`
 *
 * ⚠️ 四处照源码：
 *   ① `User-Agent` + `Referer` 两个常量（不带会被 OSS 拒）
 *   ② **PK 头校验**（`0x50 0x4B`）—— 假 xlsx 不许落盘
 *   ③ 已存在则**跳过**（幂等，重跑不重复下）
 *   ④ **连续 2 次失败立即停止**（源码的连续失败护栏）
 */
export const TM_DOWNLOAD = IO + `
const a = readJson('plan.json')
if (a === null) { emit('summary.json', { ok: false, error: '读不到 plan.json（上游那步没跑？）' }, true) }
const dataRoot = String(a.dataRoot ?? '')
if (dataRoot === '') emit('summary.json', { ok: false, error: 'plan.json 里没有 dataRoot' }, true)
const plan = Array.isArray(a.plan) ? a.plan : []

const path = await import('node:path')
const fs = await import('node:fs')

/* ⚠️ 两个常量照源码：不带 UA/Referer 会被 OSS 拒（403 或连到别的东西）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://sycm.taobao.com/'
/** 连续失败护栏（照源码：连续 2 次失败立即停止）。 */
const CONSECUTIVE_LIMIT = 2

const downloaded = []
const failed = []
const skipped = []
let consecutive = 0
let stopped = null

for (const item of plan) {
  const folder = String(item.folder ?? '')
  const file = String(item.file ?? '')
  const url = String(item.url ?? '')
  if (folder === '' || file === '' || url === '') {
    failed.push({ folder, file, error: '缺 folder/file/url' })
    consecutive++
    if (consecutive >= CONSECUTIVE_LIMIT) { stopped = '连续 ' + CONSECUTIVE_LIMIT + ' 次失败，立即停止'; break }
    continue
  }
  const dir = path.join(dataRoot, folder)
  const savePath = path.join(dir, file)
  /* ③ 已存在则跳过（幂等）。 */
  if (fs.existsSync(savePath)) { skipped.push({ folder, file }); consecutive = 0; continue }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: REFERER } })
    if (!res.ok) throw new Error('OSS 下载 HTTP ' + String(res.status))
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) throw new Error('OSS 下载内容为空')
    /* ② **PK 头校验**：zip/xlsx 的头两字节是 0x50 0x4B。
     * 不校验的话，OSS 出错返回一段 HTML 也会被当成功落盘。 */
    const isXlsx = buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b
    if (!isXlsx) throw new Error('非有效 xlsx（前两字节不是 PK）：' + buf.slice(0, 120).toString('utf8').slice(0, 100))
    /* 先写临时文件再改名 —— 中途失败不会留半个坏文件。 */
    const tmp = savePath + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, savePath)
    downloaded.push({ folder, file, bytes: buf.length })
    consecutive = 0
  } catch (e) {
    failed.push({ folder, file, error: String(e && e.message ? e.message : e) })
    consecutive++
    if (consecutive >= CONSECUTIVE_LIMIT) { stopped = '连续 ' + CONSECUTIVE_LIMIT + ' 次下载失败，立即停止（连续失败护栏）'; break }
  }
}

/* ⚠️ 结果可能很长（每张报表一条），但**本步的条数是人可读的量级**（几十条），
 * 所以直接落盘 + stdout 摘要。若将来报表数暴涨，改成只落盘。 */
emit('summary.json', {
  ok: failed.length === 0 && stopped === null,
  downloaded, failed, skipped, stopped,
  total: plan.length, missing: a.missing ?? 0, reportsTotal: a.total ?? 0,
  finishedAt: new Date().toISOString(),
}, false)
`
