/** 清洗的**纯函数库**（照 `清洗入库/src/clean.ts` 逐行搬）。
 *
 * ## 为什么单独一个文件
 *
 * 这些函数是**纯数据变换**（不碰文件、不碰库），三方都要用同一份：
 *   - `read.mjs`（读 Excel 那个 shell 脚本，读完就清洗）
 *   - `tests/ingest-clean.mjs`（离线单测，喂构造数据）
 *   - 将来若把清洗提成 `code.js` 节点，也是这份
 *
 * 放一处才不会「读的脚本改了、测试还在验旧的」。
 *
 * ## 每条规则都在注释里带了**实测来历**
 *
 * 那些注释是从原脚本抄来的 —— 它们是真金白银换来的（丢精度、日期被吃、重复入库翻倍），
 * 不要因为「看不懂为什么要这样」就删掉。
 */

/** 8 位数字日期形态（20200101~20351231，如罗盘导出的 20260630.0）→ YYYY-MM-DD；否则 null。 */
export const numToDate = (v) => {
  if (!Number.isInteger(v)) return null
  if (v < 20200101 || v > 20351231) return null
  const y = Math.floor(v / 10000)
  const m = Math.floor((v % 10000) / 100)
  const d = v % 100
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
}

const FMT_RE = {
  '%Y-%m-%d': /^(\d{4})-(\d{1,2})-(\d{1,2})/,
  '%Y%m%d': /^(\d{4})(\d{2})(\d{2})/,
  '%Y/%m/%d %H:%M': /^(\d{4})\/(\d{1,2})\/(\d{1,2})/,
}

/** 单元格值 → YYYY-MM-DD（本地时区）。 */
export const dateFromCell = (v, fmt) => {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0')
  }
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  const re = fmt ? FMT_RE[fmt] : FMT_RE['%Y-%m-%d']
  const m = re && re.exec(s)
  if (m) return m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0')
  return null
}

/** 从文件名取日期（逐日表文件名首段 YYYYMMDD = 数据日）。 */
export const dateFromFilename = (filename, pattern) => {
  const re = new RegExp(pattern || '(20\\d{2})(\\d{2})(\\d{2})')
  const m = re.exec(filename)
  if (!m || !m[1] || !m[2] || !m[3]) return null
  return m[1] + '-' + m[2] + '-' + m[3]
}

/**
 * ID/文本类列名：这些列即使内容是纯数字也**绝不能转 number**
 * （超 2^53 会丢精度），且 ID 不应参与计算。
 */
const KEEP_TEXT_COL = /(ID$)|(抖音号)|(账号)|(链接)|(上架时间)|(发布时间)|(订单号)/

/** 单元格归一（照 clean.ts 的 normCell）。 */
export const normCell = (v, col) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return dateFromCell(v, '%Y-%m-%d')
  if (typeof v === 'number') {
    /* 8 位日期形态数字（罗盘导出 20260630.0）→ ISO 日期；其余数值原样。 */
    return numToDate(v) ?? v
  }
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    /* 缺失值占位符（源表里的字面 NULL/—// 等）→ SQL NULL。 */
    if (/^(null|none|[—–\-/])$/i.test(t)) return null
    /* ID/文本类列 → 原样保留（防 19 位 ID 转浮点丢精度）。 */
    if (col && KEEP_TEXT_COL.test(col)) return v
    if (/^\d{8}$/.test(t)) {
      const d = numToDate(Number(t))
      if (d) return d
    }
    if (/^[+-]?[\d,]+(\.\d+)?$/.test(t)) {
      const digits = t.replace(/,/g, '')
      /* ≥16 位整数（超 Number.MAX_SAFE_INTEGER，如 19 位素材ID/订单号当名称）
       * 保文本防丢精度。2026-09-04 实锤：图片名=素材ID 被转浮点。 */
      if (/^\d{16,}$/.test(digits)) return v
      const n = Number(digits)
      if (!Number.isNaN(n)) return n
    }
    return v
  }
  return v
}

/** 从文件夹名解析平台。 */
export const platformFromFolder = (folder) => {
  if (folder.includes('天猫')) return '天猫'
  if (folder.includes('抖音')) return '抖音'
  throw new Error('无法从文件夹名解析平台: ' + folder)
}

/** 从文件名解析店铺（照 shopFromFilename）。 */
export const shopFromFilename = (filename, regexStr) => {
  try {
    const m = new RegExp(regexStr).exec(filename)
    return m && m.groups && m.groups.shop ? m.groups.shop : null
  } catch {
    return null
  }
}

/**
 * 清洗一行 → 输出对象（补列 平台/店铺/日期 + 来源文件/入库时间）。
 * 聚合行规则命中返回 null；店铺校验告警进 warnings。
 *
 * @param spec - manifest 里那张表的规则。
 * @param header - 表头。
 * @param row - 一行。
 * @param meta - 文件名/平台/店铺/日期/入库时间/派生列。
 * @param warnings - 收集告警（原地 push）。
 * @returns 清洗后的行，或 null（该行被规则剔除）。
 */
export const transformRow = (spec, header, row, meta, warnings) => {
  const map = {}
  for (let i = 0; i < header.length; i++) map[header[i]] = row[i] ?? null

  /* 排除行规则（如 人群构成 载体类型=全部）。 */
  for (const rule of spec.exclude_row_rules || []) {
    const v = map[rule.column]
    if (v !== null && v !== undefined && String(v).trim() !== '' && rule.values.includes(String(v).trim())) return null
  }
  /* 保留行规则（只保留 values 中的值，如 天猫来源层级=2）。 */
  for (const rule of spec.keep_row_rules || []) {
    const v = map[rule.column]
    if (v === null || v === undefined || String(v).trim() === '' || !rule.values.includes(String(v).trim())) return null
  }
  /* 当日行排除（如千川商品：7 天区间文件含当日不完整快照，只收 T-1 及以前）。 */
  if (spec.exclude_today_rows === true && meta.date !== null && meta.date !== undefined
      && meta.date >= new Date().toLocaleDateString('sv')) return null
  /* 店铺校验（天猫 店铺名称 列）—— 不一致只告警、不拦。 */
  if (spec.shop_check_column) {
    const colV = map[spec.shop_check_column]
    if (colV !== null && colV !== undefined && String(colV).trim() !== ''
        && meta.shop && String(colV).trim() !== meta.shop) {
      warnings.push(meta.filename + ': 店铺列=' + String(colV).trim() + ' ≠ 文件名解析' + meta.shop)
    }
  }

  const out = { 平台: meta.platform, 店铺: meta.shop ?? '', 日期: meta.date ?? '' }
  const dateSrcCol = spec.date !== undefined && spec.date.source === 'column' ? spec.date.column : null
  for (const h of header) {
    const src = h.trim()
    if (!src) continue
    if ((spec.exclude_columns || []).includes(src)) continue
    if (spec.shop_check_column && src === spec.shop_check_column) continue
    if (dateSrcCol && src === dateSrcCol && !spec.keep_date_source && src !== '日期') continue
    const name = (spec.column_map && spec.column_map[src]) !== undefined ? spec.column_map[src] : src
    let val = normCell(map[src], name)
    /* 列值映射（如 人群类型 首购→新客）。 */
    const vm = spec.value_map && spec.value_map[name]
    if (vm) {
      const key = String(val ?? '').trim()
      if (key !== '' && vm[key] !== undefined) val = vm[key]
    }
    out[name] = val
  }
  /* ① 日期列统一为 Cube/SQLite 原生时间戳格式 YYYY-MM-DDT00:00:00.000：
   *    · 表头自带「日期」列时其原始值会反向覆盖 meta.date（罗盘数字日期 20260630.0）
   *    · Cube SqliteQuery 的日期边界字面量是 T 分隔 + 毫秒，
   *      空格分隔或裸日期会因 ' ' < 'T' 输掉起始日比较 → dateRange 首日被吃 */
  {
    const dv = out['日期']
    let iso = null
    if (typeof dv === 'number') {
      iso = numToDate(dv)
    } else if (typeof dv === 'string') {
      const t = dv.trim()
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
      if (m) iso = m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0')
      else if (/^\d{8}$/.test(t)) iso = numToDate(Number(t))
    }
    if (!iso && meta.date) iso = meta.date
    out['日期'] = iso ? iso + 'T00:00:00.000' : ''
  }
  /* ② 主键列 NULL 归一成 ''：SQLite 主键含 NULL 时 ON CONFLICT 永不触发
   *    → 同文件重复入库会**翻倍**。 */
  for (const c of spec.primary_key) {
    if (out[c] === undefined || out[c] === null) out[c] = ''
  }
  out['来源文件'] = meta.filename
  out['入库时间'] = meta.ingestTime
  if (meta.derived) {
    for (const [k, v] of Object.entries(meta.derived)) out[k] = v
  }
  return out
}

/**
 * 把「已读出来的表格数据」清洗成「要写入的行」（照 `ingest.ts` 的主循环）。
 *
 * @param manifest - manifest 对象。
 * @param sheets - `[{ specId, file, sheetName, header, rows }]`（read.mjs 产出的）。
 * @returns `{ runTime, tables, summary }`。
 */
export const cleanAll = (manifest, sheets) => {
  if (manifest === null || manifest === undefined) throw new Error('没拿到 manifest')
  if (!Array.isArray(manifest.tables)) throw new Error('manifest 里没有 tables 数组')
  const list = Array.isArray(sheets) ? sheets : []

  const runTime = new Date().toISOString()
  const tables = []

  for (const spec of manifest.tables) {
    const mine = list.filter((s) => s.specId === spec.id)
    if (mine.length === 0) {
      tables.push({
        id: spec.id, table: spec.table, files: 0, rows: [], columns: [],
        primaryKey: spec.primary_key, warnings: [], conflicts: 0,
        skipped: '文件夹为空或没有文件',
      })
      continue
    }
    const platform = spec.platform || platformFromFolder(spec.folder)
    const allRows = []
    const warnings = []
    const colSet = new Set()
    const seenPk = new Set()
    let conflicts = 0
    const dates = []

    for (const s of mine) {
      const shop = shopFromFilename(s.file, spec.shop_regex)
      /* ⚠️ 无店铺时**不 push 告警**（照源码：`if (!shop) warnings.push(...)`）。
       * 但注意源码那条只在 `!shop` 时告警 —— 复刻它。 */
      if (!shop) warnings.push(s.file + ': 无法从文件名解析店铺 (' + spec.shop_regex + ')')
      const fileDate = spec.date && spec.date.source === 'filename'
        ? dateFromFilename(s.file, spec.date.pattern) : null
      /* 派生列（如 视频 账号类型=自营/合作）：from=filename 取文件名，from=sheet 取 sheet 名。 */
      const derived = {}
      for (const dc of spec.derived_columns || []) {
        const srcText = dc.from === 'sheet' ? s.sheetName : s.file
        const m = new RegExp(dc.pattern).exec(srcText)
        const v = m && m.groups && dc.group ? m.groups[dc.group] : (m ? m[1] : null)
        derived[dc.column] = v ?? ''
        if (!v) {
          warnings.push(s.file + ': 无法从' + (dc.from === 'sheet' ? 'sheet名' : '文件名')
            + '解析派生列 ' + dc.column + ' (' + dc.pattern + ')')
        }
      }

      for (const row of s.rows) {
        let date = fileDate
        if (spec.date && spec.date.source === 'column') {
          const ci = s.header.findIndex((h) => h.trim() === spec.date.column)
          date = ci >= 0 ? dateFromCell(row[ci], spec.date.format) : null
        }
        const out = transformRow(spec, s.header, row, {
          filename: s.file, platform, shop, date, ingestTime: runTime, derived,
        }, warnings)
        if (!out) continue
        const pk = spec.primary_key.map((c) => String(out[c] ?? '')).join('|')
        if (seenPk.has(pk)) conflicts++
        seenPk.add(pk)
        if (date) dates.push(date)
        for (const k of Object.keys(out)) colSet.add(k)
        allRows.push(out)
      }
    }

    /* 列顺序照源码：平台/店铺/日期 在头，来源文件/入库时间 在尾，其余夹中间。 */
    const base = ['平台', '店铺', '日期']
    const mid = Array.from(colSet).filter((c) => !base.includes(c) && c !== '来源文件' && c !== '入库时间')
    const columns = [...base, ...mid, '来源文件', '入库时间']
    const dMin = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : '—'
    const dMax = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : '—'
    tables.push({
      id: spec.id, table: spec.table, files: mine.length,
      columns, primaryKey: spec.primary_key, rows: allRows,
      conflicts, warnings, dMin, dMax,
    })
  }

  const summary = tables.map((t) => ({
    table: t.table, files: t.files, rows: t.rows.length,
    conflicts: t.conflicts, cols: t.columns.length, warnings: t.warnings.length,
  }))
  return { runTime, tables, summary }
}
