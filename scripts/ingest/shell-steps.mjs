/** 「清洗入库」工作流的三个 shell 步骤（单一来源：生成器与测试都用）。
 *
 * ## ⚠️ 交接方式（我踩过两次才定下来，别改）
 *
 * ### 第一次踩：想把 JSON 塞进命令行
 * 写成 `code.shell` 的 `command: 'node -e "..." "<上游JSON>"'` —— **不行**：
 *   - 上游输出是对象，变量替换会把整个 JSON 塞进命令行；
 *   - `code.shell` 经 **`cmd /c`** 跑（真 shell），引号与双反斜杠会被再吃一层；
 *   - 命令行有长度上限（17 张表的清单可能很长）。
 *
 * ### 第二次踩：想用「上游输出」在步骤间传数据
 * 引擎给每个节点的只有**直接上游**的输出，而这条链是
 * `读 manifest → 列文件 → 读Excel清洗 → 写库`：
 * 第 3 步需要**第 1 步**的 manifest 与**第 2 步**的清单 —— 两者它都拿不到。
 * 硬要用「上游」串，就得每一步都把前面所有东西**累加着往下传**，
 * 中间的数据（几千行 Excel）会在引擎里来回搬好几遍。
 *
 * ### 现在的做法：**一个固定工作目录，数据全落盘**
 *
 * ```
 * <workDir>/config.json      ← 由 code.js 那步写（路径等短配置）
 * <workDir>/files.json       ← 步骤① 写（扫到的文件清单）
 * <workDir>/cleaned.json     ← 步骤② 写（清洗后要入库的行）
 * <workDir>/summary.json     ← 步骤③ 写（写库结果，给面板看）
 * ```
 *
 * 命令行**只带一个 workDir 路径**（没有引号、没有反斜杠、没有长内容）。
 * 这与 `.bat` 里「几个 node 脚本靠文件交接」是同一个形状 ——
 * 本来就是「一串固定步骤」，没必要为了走在引擎里而把数据搬来搬去。
 */

/** 三个脚本共用的读写工具。 */
const IO = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 工作目录（argv[2]）。命令行只有一个路径 —— 这是刻意的（见文件头说明）。 */
const workDir = process.argv[2] ?? ''
if (workDir === '') {
  process.stdout.write(JSON.stringify({ ok: false, error: '没给工作目录' }) + '\\n')
  process.exit(1)
}
/** 读工作目录里的一个 JSON 文件；不在就返回 null。 */
const readJson = (name) => {
  const p = join(workDir, name)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
/** 写工作目录里的一个 JSON 文件（另起一行时也写个 last-error）。 */
const writeJson = (name, obj) => {
  writeFileSync(join(workDir, name), JSON.stringify(obj), 'utf8')
}
/**
 * 收口：把结果以**一行 JSON** 打到 stdout（宿主半只认最后一行），
 * 并写一份同名文件（方便人去看）。
 *
 * @param name - 落盘的文件名。
 * @param obj - 结果。
 * @param fail - 是否算失败（失败时非零退出，让节点标红）。
 */
const emit = (name, obj, fail) => {
  writeJson(name, obj)
  process.stdout.write(JSON.stringify(obj) + '\\n')
  process.exit(fail === true ? 1 : 0)
}
`

/**
 * 步骤①：按 config 里的表清单逐文件夹列 xlsx。
 *
 * 读：`config.json`
 * 写：`files.json` — `{ ok, folders: [{ specId, folder, files }] }`
 */
export const STEP_LIST = IO + `
const cfg = readJson('config.json')
if (cfg === null) emit('files.json', { ok: false, error: '读不到 config.json' }, true)

const path = await import('node:path')
const fs = await import('node:fs')
const dataRoot = String(cfg.dataRoot ?? '')
if (dataRoot === '') emit('files.json', { ok: false, error: 'config 里没有 dataRoot' }, true)

const folders = []
for (const t of cfg.tables ?? []) {
  const dir = path.join(dataRoot, t.folder)
  let files = []
  try {
    /* ⚠️ 排除 ~$ 开头的 **Office 锁文件**（照原脚本），并按文件名排序
     *（升序 = 旧到新，后者覆盖前者 —— 「同主键后者覆盖」那条规则靠它）。 */
    files = fs.readdirSync(dir).filter((f) => /\\.(xlsx|xls)$/i.test(f) && !f.startsWith('~$')).sort()
  } catch {
    /* 文件夹不存在**不是错**（可能今天这个平台没数据）—— 记一条，继续。 */
    folders.push({ specId: t.id, folder: t.folder, files: [], note: '文件夹读不到' })
    continue
  }
  folders.push({ specId: t.id, folder: t.folder, files })
}
emit('files.json', { ok: true, folders, scannedAt: new Date().toISOString() })
`

/**
 * 步骤②：读 Excel → 清洗（照 `ingest.ts` 的主循环）。
 *
 * 读：`config.json`、`files.json`
 * 写：`cleaned.json` — `{ ok, result: {runTime, tables}, errors }`
 *
 * ⚠️ **读 Excel 与清洗放在同一个脚本**（不像我第一版分成两步）：
 * 这样中间数据（几千行）**不用落盘再读回来**，只落「要入库的行」。
 * 与原脚本 `ingest.ts` 的形状也一致（它也是一个进程里读完就洗）。
 */
export const STEP_READ_CLEAN = IO + `
const cfg = readJson('config.json')
const files = readJson('files.json')
if (cfg === null) emit('cleaned.json', { ok: false, error: '读不到 config.json' }, true)
if (files === null) emit('cleaned.json', { ok: false, error: '读不到 files.json（步骤① 没跑？）' }, true)

const path = await import('node:path')
const { pathToFileURL } = await import('node:url')

/* ⚠️ **exceljs 要从它自己的目录 import**（那个项目的 node_modules 里有）。
 * 用绝对路径 + pathToFileURL —— 普通 import 会从**本脚本位置**往上找，
 * 而本脚本在 $DSH_HOME/tmp/ 下，那里没有 exceljs。 */
let ExcelJS = null
try {
  const entry = path.join(String(cfg.projectDir ?? ''), 'node_modules', 'exceljs', 'lib', 'exceljs.nodejs.js')
  const mod = await import(pathToFileURL(entry).href)
  ExcelJS = mod.default ?? mod
} catch (e) {
  emit('cleaned.json', { ok: false, error: '读 Excel 依赖失败（' + String(cfg.projectDir ?? '') + ' 下没有 exceljs？）：' + String(e && e.message ? e.message : e) }, true)
}

/* 清洗库的路径由 config 给（不假设它在用户的项目目录里 —— 那样部署要往人家目录塞文件）。 */
let cleanLib = null
try {
  cleanLib = await import(pathToFileURL(String(cfg.cleanLibPath ?? '')).href)
} catch (e) {
  emit('cleaned.json', { ok: false, error: '读不到清洗库：' + String(e && e.message ? e.message : e) }, true)
}

/**
 * 单元格归一 —— ⚠️ **日期当场转成本地日期串**，不让 Date 过 JSON。
 *
 * 实测教训（2026-10-14 抓到）：本地 6/30 的 Date 过 JSON 会变成
 * UTC 的 2026-06-29T16:00:00.000Z，下游取日期前缀得 **6/29** ——
 * **整整差一天**。这类错**不报错**，只是数据悄悄错一天。
 */
const norm = (v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0')
  }
  if (typeof v === 'object') {
    if (typeof v.result !== 'undefined') return norm(v.result)
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text ?? '').join('')
    if (typeof v.text !== 'undefined') return v.text
    if (typeof v.hyperlink !== 'undefined') return v.hyperlink
  }
  return v
}

const dataRoot = String(cfg.dataRoot ?? '')
const manifest = cfg.manifest
if (!manifest || !Array.isArray(manifest.tables)) emit('cleaned.json', { ok: false, error: 'config 里没有 manifest' }, true)

const errors = []
const sheets = []
for (const f of files.folders ?? []) {
  const spec = manifest.tables.find((t) => t.id === f.specId)
  if (!spec) { errors.push('manifest 里没有表 ' + f.specId); continue }
  for (const file of f.files ?? []) {
    const full = path.join(dataRoot, f.folder, file)
    try {
      const wb = new ExcelJS.Workbook()
      /* ⚠️ **普通加载，不用 read_only** —— read_only 对罗盘导出会**漏数**
       *（原脚本注释：「实测 25 行报成 1 行」）。 */
      await wb.xlsx.readFile(full)
      const ws = spec.sheet === 'first' ? wb.worksheets[0] : wb.getWorksheet(spec.sheet)
      if (!ws) { errors.push(file + ': sheet 不存在 ' + spec.sheet); continue }
      const colCount = ws.columnCount
      const header = []
      for (let c = 1; c <= colCount; c++) {
        const v = ws.getCell(1, c).value
        header.push(v === null || v === undefined ? '' : String(norm(v)).trim())
      }
      const rows = []
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = []
        let has = false
        for (let c = 1; c <= colCount; c++) {
          const n = norm(ws.getCell(r, c).value)
          row.push(n)
          if (n !== null && String(n).trim() !== '') has = true
        }
        if (has) rows.push(row)
      }
      sheets.push({ specId: f.specId, file, sheetName: ws.name, header, rows })
    } catch (e) {
      /* 单个文件读失败**不中断整批**（照原脚本：记 warning 继续）。 */
      errors.push(file + ': 读取失败 ' + String(e && e.message ? e.message : e))
    }
  }
}

let result = null
try {
  result = cleanLib.cleanAll(manifest, sheets)
} catch (e) {
  emit('cleaned.json', { ok: false, error: '清洗失败：' + String(e && e.message ? e.message : e), errors }, true)
}

/* ⚠️ **数据落盘、stdout 只报摘要**（2026-10-14 实测踩到，是个真问题）。
 *
 * 第一版把**整个 result**（含全部清洗后的行）JSON.stringify 打到 stdout ——
 * 真实数据是 416 行 × 125 列，**好几兆**。后果：
 *   · 宿主半收集子进程 stdout 时会**撑爆缓冲**（实测 spawnSync 退出码 null、什么都不知道）
 *   · 那几兆还要在引擎里传一遍、再被丢掉（根本没人读它 —— 步骤③ 要的是**文件**）
 *
 * 所以约定：**数据走 cleaned.json，stdout 只给摘要**。
 * 步骤③ 读 cleaned.json（它本来就这么设计的），人看日志看 stdout 的摘要。
 *
 * 用 writeJson 而不是 emit —— emit 会把同一个对象打到 stdout。 */
writeJson('cleaned.json', { ok: true, result, errors, filesRead: sheets.length })
const summary = (result && Array.isArray(result.summary)) ? result.summary : []
process.stdout.write(JSON.stringify({
  ok: true,
  errors,
  filesRead: sheets.length,
  /* 摘要：每张表写了几行、有没有告警 —— 够人看，也没有体积问题。 */
  tables: summary,
  totalRows: summary.reduce((n, t) => n + (t.rows ?? 0), 0),
}) + String.fromCharCode(10))
process.exit(0)
`

/**
 * 步骤③：写 SQLite（照 `db.ts` + `ingest.ts` 的写库部分）。
 *
 * 读：`config.json`、`cleaned.json`
 * 写：`summary.json` — `{ ok, written, views, materialized }`
 *
 * ⚠️ 四条要点（都是原脚本换来的）：
 *   ① `PRAGMA journal_mode = WAL`
 *   ② 建表：已存在则**补缺失列**（`ALTER TABLE ADD COLUMN`）—— **不重建**（重建会丢历史）
 *   ③ UPSERT：`ON CONFLICT DO UPDATE`（后者覆盖前者）+ 事务包起来
 *   ④ 视图/实体表：`DROP` + `CREATE`（保证定义随 manifest 更新）
 */
export const STEP_WRITE_DB = IO + `
const cfg = readJson('config.json')
const cleaned = readJson('cleaned.json')
if (cfg === null) emit('summary.json', { ok: false, error: '读不到 config.json' }, true)
if (cleaned === null) emit('summary.json', { ok: false, error: '读不到 cleaned.json（步骤② 没跑？）' }, true)
if (cleaned.ok !== true) emit('summary.json', { ok: false, error: '步骤② 失败了：' + String(cleaned.error) }, true)

const dbPath = String(cfg.dbPath ?? '')
if (dbPath === '') emit('summary.json', { ok: false, error: 'config 里没有 dbPath' }, true)

const manifest = cfg.manifest
const tables = (cleaned.result && Array.isArray(cleaned.result.tables)) ? cleaned.result.tables : []
const views = (manifest && manifest.meta && Array.isArray(manifest.meta.derived_views)) ? manifest.meta.derived_views : []
const materialized = (manifest && manifest.meta && Array.isArray(manifest.meta.materialized_tables)) ? manifest.meta.materialized_tables : []

const { DatabaseSync } = await import('node:sqlite')
const fs = await import('node:fs')
const path = await import('node:path')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })
const db = new DatabaseSync(dbPath)
/* ① WAL（照原脚本）。 */
db.exec('PRAGMA journal_mode = WAL;')

/** 类型推断（照 db.ts 的 inferTypes）。 */
const TEXT_BY_NAME = new Set(['抖音号', '主播抖音号', '达人抖音号', '关键词', '搜索词',
  '商品链接', '播放链接', '是否投放', '账号类型', '来源文件'])
const inferTypes = (rows, columns) => {
  const types = {}
  for (const c of columns) {
    if (/ID$/i.test(c) || TEXT_BY_NAME.has(c) || c === '平台' || c === '店铺'
        || c === '日期' || c === '入库时间') { types[c] = 'TEXT'; continue }
    let numeric = true
    for (const r of rows) {
      const v = r[c]
      if (v === null || v === undefined || v === '') continue
      if (typeof v !== 'number') { numeric = false; break }
    }
    types[c] = numeric ? 'REAL' : 'TEXT'
  }
  return types
}

/** ② 建表（含主键）；已存在则**补缺失列**。 */
const ensureTable = (table, columns, pk, types) => {
  const info = db.prepare('PRAGMA table_info("' + table + '")').all()
  if (info.length === 0) {
    const defs = columns.map((c) => '"' + c + '" ' + (types[c] ?? 'TEXT')).join(', ')
    const pkDef = pk.map((c) => '"' + c + '"').join(', ')
    db.exec('CREATE TABLE "' + table + '" (' + defs + ', PRIMARY KEY (' + pkDef + '))')
  } else {
    const existing = new Set(info.map((r) => r.name))
    for (const c of columns) {
      if (!existing.has(c)) db.exec('ALTER TABLE "' + table + '" ADD COLUMN "' + c + '" ' + (types[c] ?? 'TEXT'))
    }
  }
}

/** ③ UPSERT：同主键**后者覆盖前者**（用户确认：报告即可，不告警不报错）+ 事务。 */
const upsertRows = (table, rows, columns, pk) => {
  if (rows.length === 0) return
  const nonPk = columns.filter((c) => !pk.includes(c))
  const colList = columns.map((c) => '"' + c + '"').join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  const setClause = nonPk.map((c) => '"' + c + '"=excluded."' + c + '"').join(', ')
  const pkList = pk.map((c) => '"' + c + '"').join(', ')
  const sql = 'INSERT INTO "' + table + '" (' + colList + ') VALUES (' + placeholders
    + ') ON CONFLICT(' + pkList + ') DO UPDATE SET ' + setClause
  const stmt = db.prepare(sql)
  db.exec('BEGIN')
  try {
    for (const r of rows) stmt.run(...columns.map((c) => (r[c] === undefined ? null : r[c])))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

db.exec('CREATE TABLE IF NOT EXISTS _etl_log (run_time TEXT, table_name TEXT, files INTEGER, rows INTEGER, conflicts INTEGER, note TEXT)')
const written = []
try {
  for (const t of tables) {
    if (!Array.isArray(t.rows) || t.rows.length === 0) {
      written.push({ table: t.table, rows: 0, skipped: t.skipped ?? '没有行' })
      continue
    }
    const types = inferTypes(t.rows, t.columns)
    ensureTable(t.table, t.columns, t.primaryKey, types)
    upsertRows(t.table, t.rows, t.columns, t.primaryKey)
    written.push({ table: t.table, rows: t.rows.length })
    db.prepare('INSERT INTO _etl_log (run_time, table_name, files, rows, conflicts, note) VALUES (?,?,?,?,?,?)')
      .run(new Date().toISOString(), t.table, t.files ?? 0, t.rows.length, t.conflicts ?? 0,
        (t.warnings ?? []).length > 0 ? 'warnings=' + String((t.warnings ?? []).length) : '')
  }
  /* ④ 派生视图：DROP + CREATE。 */
  const builtViews = []
  for (const v of views) {
    db.exec('DROP VIEW IF EXISTS "' + v.view + '"')
    db.exec('CREATE VIEW "' + v.view + '" AS ' + v.sql)
    builtViews.push(v.view)
  }
  /* ⑤ 实体表（看板直读用）：DROP + CTAS + 索引。 */
  const builtTables = []
  for (const m of materialized) {
    db.exec('DROP TABLE IF EXISTS "' + m.table + '"')
    db.exec('CREATE TABLE "' + m.table + '" AS ' + m.sql)
    for (const idx of m.indexes || []) {
      db.exec('CREATE INDEX IF NOT EXISTS "idx_' + m.table + '_' + idx.join('_') + '" ON "'
        + m.table + '" (' + idx.map((c) => '"' + c + '"').join(', ') + ')')
    }
    builtTables.push(m.table)
  }
  db.close()
  emit('summary.json', { ok: true, written, views: builtViews, materialized: builtTables })
} catch (e) {
  try { db.close() } catch { /* 已关 */ }
  emit('summary.json', { ok: false, error: '写库失败：' + String(e && e.message ? e.message : e) }, true)
}
`
