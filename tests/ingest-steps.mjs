/** 验「清洗入库」三个 shell 步骤，用**固定工作目录**交接（新设计）。
 *
 * ⚠️ 只用临时文件：临时 xlsx、临时 db、临时工作目录。
 * 真实 `ecom.db` **一个字节都不许动**（跑完比对指纹）。
 *
 * 跑完即删（验过后收成常驻测试）。
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { STEP_LIST, STEP_READ_CLEAN, STEP_WRITE_DB } from '../scripts/ingest/shell-steps.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = 'D:/ecom-data/清洗入库'
const REAL_DB = join(PROJECT, 'ecom.db')
/* ⚠️ **每次一个唯一目录**（`mkdtempSync`），不是写死的目录名。
 *
 * 2026-10-20 修的假红（`tests/代码审查-2026-10-20.md` I2）：
 * 原来写死 `ewb-ingest-steps`，于是
 *   ① 两个进程同时跑会互相删对方的工作目录 →
 *      报 `ENOENT ...\work\cleaned.json`（稳定复现）；
 *   ② **即使单跑也会偶发红** —— 上次被杀掉时留下的残留目录会参与本轮。
 * 用 `mkdtempSync` 之后两个假红面一起消失（`collect.mjs` 早就是这么写的）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ewb-ingest-steps-'))
const WORK = join(TMP, 'work')

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 跑一个步骤（命令行**只有一个路径** —— 这是刻意的，见模块头说明）。 */
function runStep(code, tag) {
  const f = join(TMP, 'step-' + tag + '.mjs')
  writeFileSync(f, code, 'utf8')
  const r = spawnSync(process.execPath, [f, WORK], { encoding: 'utf8', windowsHide: true })
  const lines = String(r.stdout ?? '').trim().split('\n').filter(l => l.trim() !== '')
  let parsed = null
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); break } catch { /* 往前找 */ }
  }
  return { code: r.status, parsed, err: String(r.stderr ?? '') }
}

/* 目录已经由 `mkdtempSync` 建好了 —— 不要再删它（那是本次唯一的那份）。 */
mkdirSync(WORK, { recursive: true })

const { statSync } = await import('node:fs')
const dbBefore = existsSync(REAL_DB) ? { size: statSync(REAL_DB).size, mtime: statSync(REAL_DB).mtimeMs } : null

/* 造临时数据（天猫 + 抖音 + 一个 ~$ 锁文件）。 */
const dataRoot = join(TMP, '原始数据')
mkdirSync(join(dataRoot, 'D-店铺-整体-天猫'), { recursive: true })
mkdirSync(join(dataRoot, 'D-店铺-整体-抖音'), { recursive: true })
{
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(join(PROJECT, 'node_modules/exceljs/lib/exceljs.nodejs.js')).href)
  const ExcelJS = mod.default ?? mod
  const mk = async (folder, file, rows) => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('主数据')
    for (const r of rows) ws.addRow(r)
    await wb.xlsx.writeFile(join(dataRoot, folder, file))
  }
  /* ⚠️ 本地日期（若读 Excel 时让 Date 过 JSON，会错成前一天）。 */
  await mk('D-店铺-整体-天猫', 'DemoShop-20260630.xlsx', [
    ['商品ID', '商品名称', '支付金额', '日期'],
    ['1234567890123456789', '长ID商品', 100, new Date(2026, 5, 30)],
  ])
  await mk('D-店铺-整体-抖音', 'DemoShop-20260701.xlsx', [
    ['商品ID', '商品名称', '支付金额'],
    ['2', '普通商品', '1,234.5'],
  ])
  writeFileSync(join(dataRoot, 'D-店铺-整体-天猫', '~$DemoShop-20260630.xlsx'), 'lock')
}

const manifest = {
  meta: { db_path: join(TMP, 'out.db'), derived_views: [], materialized_tables: [] },
  tables: [
    { id: 'tm_overview', table: 'tm_overview_demo', folder: 'D-店铺-整体-天猫', sheet: 'first',
      platform: '天猫', shop_regex: '(?<shop>[^-]+)-',
      /* ⚠️ 日期来源用**列**（那个列的值是读 Excel 那步传下来的）—— 这条正好验时区坑。 */
      date: { source: 'column', column: '日期', format: '%Y-%m-%d' },
      primary_key: ['商品ID', '日期'], exclude_columns: [] },
    { id: 'dy_overview', table: 'dy_overview_demo', folder: 'D-店铺-整体-抖音', sheet: 'first',
      platform: '抖音', shop_regex: '(?<shop>[^-]+)-',
      date: { source: 'filename', pattern: '(20\\d{2})(\\d{2})(\\d{2})' },
      primary_key: ['商品ID', '日期'], exclude_columns: [] },
  ],
}

/* 写 config.json（这一步在工作流里是 code.js 干的）。 */
writeFileSync(join(WORK, 'config.json'), JSON.stringify({
  dataRoot, dbPath: join(TMP, 'out.db'), projectDir: PROJECT, manifest,
  cleanLibPath: join(HERE, '..', 'scripts', 'ingest', 'clean-lib.mjs'),
  tables: manifest.tables.map(t => ({ id: t.id, folder: t.folder })),
}), 'utf8')

/* ── ① 列文件 ── */
console.log('=== ① 列文件 ===')
const r1 = runStep(STEP_LIST, 'list')
check('跑通', r1.parsed?.ok === true, String(r1.parsed?.error ?? r1.err).slice(0, 150))
const folders = r1.parsed?.folders ?? []
console.log('  扫到: ' + JSON.stringify(folders.map(f => f.folder + ' → ' + (f.files ?? []).join(','))))
check('两表都扫了', folders.length === 2, String(folders.length))
check('★ 排除了 ~$ 锁文件', folders[0]?.files?.length === 1, JSON.stringify(folders[0]?.files))
check('★ 写出了 files.json（交接靠它）', existsSync(join(WORK, 'files.json')))

/* ── ② 读 Excel + 清洗 ── */
console.log('')
console.log('=== ② 读 Excel + 清洗 ===')
const r2 = runStep(STEP_READ_CLEAN, 'read')
check('跑通', r2.parsed?.ok === true, String(r2.parsed?.error ?? r2.err).slice(0, 200))
/* ⚠️ **行数据不在 stdout 里，在 cleaned.json 里**（2026-10-14 改的）。
 *
 * 为什么：真实数据是 416 行 × 125 列，`JSON.stringify` 打到 stdout 有**好几兆** ——
 * 子进程 stdout 缓冲会被撑爆（实测 spawnSync 退出码 null）。
 * 所以约定：**数据走文件，stdout 只给摘要**。这条断言要跟着改（我第一版没改，测试红了）。 */
const cleanedFile = JSON.parse(readFileSync(join(WORK, 'cleaned.json'), 'utf8'))
check('★ 行数据落在 cleaned.json（不是 stdout）', Array.isArray(cleanedFile.result?.tables), JSON.stringify(Object.keys(cleanedFile)))
check('★ stdout 只给摘要（有 totalRows，没有整份行）', typeof r2.parsed?.totalRows === 'number',
  JSON.stringify(r2.parsed).slice(0, 120))
const tabs = cleanedFile.result?.tables ?? []
const tm = tabs.find(t => t.id === 'tm_overview')
const dy = tabs.find(t => t.id === 'dy_overview')
console.log('  天猫行: ' + JSON.stringify(tm?.rows))
console.log('  抖音行: ' + JSON.stringify(dy?.rows))
check('天猫 1 行', tm?.rows?.length === 1, String(tm?.rows?.length))
check('抖音 1 行', dy?.rows?.length === 1, String(dy?.rows?.length))
check('★ 19 位 ID 保文本', tm?.rows?.[0]?.['商品ID'] === '1234567890123456789', String(tm?.rows?.[0]?.['商品ID']))
check('★ 日期来自**列**（2026-06-30，不是 6-29 —— 时区坑不许回来）',
  String(tm?.rows?.[0]?.['日期']).startsWith('2026-06-30T00:00:00.000'), String(tm?.rows?.[0]?.['日期']))
check('★ 日期来自**文件名**（抖音 2026-07-01）',
  String(dy?.rows?.[0]?.['日期']).startsWith('2026-07-01T00:00:00.000'), String(dy?.rows?.[0]?.['日期']))
check('★ 千分位数字转 number', dy?.rows?.[0]?.['支付金额'] === 1234.5, JSON.stringify(dy?.rows?.[0]?.['支付金额']))
check('★ 写出了 cleaned.json（这一步的产出）', existsSync(join(WORK, 'cleaned.json')))

/* ── ③ 写库 ── */
console.log('')
console.log('=== ③ 写库（临时库）===')
const r3 = runStep(STEP_WRITE_DB, 'write')
check('跑通', r3.parsed?.ok === true, String(r3.parsed?.error ?? r3.err).slice(0, 200))
console.log('  written: ' + JSON.stringify(r3.parsed?.written))
check('两张表都写了', (r3.parsed?.written ?? []).filter(w => w.rows > 0).length === 2, JSON.stringify(r3.parsed?.written))
check('★ 写出了 summary.json', existsSync(join(WORK, 'summary.json')))

{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(TMP, 'out.db'))
  const t = db.prepare('SELECT * FROM tm_overview_demo').all()
  const d = db.prepare('SELECT * FROM dy_overview_demo').all()
  const log = db.prepare('SELECT COUNT(*) AS n FROM _etl_log').all()
  console.log('  库里天猫: ' + JSON.stringify(t))
  console.log('  库里抖音: ' + JSON.stringify(d))
  check('★ 库里日期 2026-06-30（列来源，没差一天）', String(t[0]?.日期).startsWith('2026-06-30'), String(t[0]?.日期))
  check('★ 库里 19 位 ID 仍是文本', t[0]?.商品ID === '1234567890123456789', String(t[0]?.商品ID))
  check('ETL 日志记了 2 张表', Number(log[0]?.n) === 2, JSON.stringify(log))
  db.close()
}

/* ── ④ 幂等：再跑一次，行数不涨（UPSERT 生效）── */
console.log('')
console.log('=== ④ 再跑一次（UPSERT 应覆盖不新增）===')
{
  const r3b = runStep(STEP_WRITE_DB, 'write2')
  check('第二次也跑通', r3b.parsed?.ok === true, String(r3b.parsed?.error ?? ''))
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(TMP, 'out.db'))
  const t = db.prepare('SELECT COUNT(*) AS n FROM tm_overview_demo').all()
  console.log('  天猫表行数: ' + JSON.stringify(t))
  check('★ UPSERT：行数没涨（还是 1）', Number(t[0]?.n) === 1, JSON.stringify(t))
  db.close()
}

/* ── ⑤ 坏输入：缺 config / 上一步没跑 ── */
console.log('')
console.log('=== ⑤ 坏输入 ===')
{
  const WORK2 = join(TMP, 'work-empty')
  mkdirSync(WORK2, { recursive: true })
  const f = join(TMP, 'step-bad.mjs')
  writeFileSync(f, STEP_WRITE_DB, 'utf8')
  const r = spawnSync(process.execPath, [f, WORK2], { encoding: 'utf8', windowsHide: true })
  check('★ 缺 config.json → 非零退出', r.status !== 0, String(r.status))
  const out = String(r.stdout ?? '')
  check('★ 说明缺什么（不是静默失败）', out.includes('config.json'), out.trim().slice(0, 90))

  const f2 = join(TMP, 'step-bad2.mjs')
  writeFileSync(f2, STEP_LIST, 'utf8')
  const r2 = spawnSync(process.execPath, [f2, WORK2], { encoding: 'utf8', windowsHide: true })
  check('★ 缺 config → 也说明原因', r2.status !== 0 && String(r2.stdout).includes('config.json'), String(r2.stdout).trim().slice(0, 90))
}

/* ── ⑥ 真实库没被动过 ── */
console.log('')
console.log('=== ⑥ 真实库没被动过 ===')
if (dbBefore === null) {
  console.log('  （真实 ecom.db 原本不在，跳过）')
} else {
  const now = statSync(REAL_DB)
  check('★ 真实 ecom.db 大小不变', now.size === dbBefore.size, String(dbBefore.size) + ' → ' + String(now.size))
  check('★ 真实 ecom.db 修改时间不变', now.mtimeMs === dbBefore.mtime, new Date(dbBefore.mtime).toISOString())
}

rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('  （临时目录已清理）')
console.log(failed === 0 ? '结论：三个 shell 步骤用工作目录交接跑通了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
