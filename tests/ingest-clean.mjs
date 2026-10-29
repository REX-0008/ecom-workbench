/** 离线验「清洗」纯逻辑（用真实 manifest + 构造的行数据）。
 *
 * ⚠️ 用户红线：不改真实文件。所以**不碰** `ecom.db`、也不读真实 Excel ——
 * 只用 manifest（**只读**）与**构造**的表格数据。
 *
 * ⚠️ 清洗逻辑的来源是 `scripts/ingest/clean-lib.mjs`（**单一来源**：
 * 生成器、shell 步骤、本测试三方共用）。早先有过一份内嵌在生成器里的副本，
 * 已删 —— 两份必然分叉。
 */
import { readFileSync, existsSync } from 'node:fs'
import { cleanAll } from '../scripts/ingest/clean-lib.mjs'

const MANIFEST = 'D:/ecom-data/清洗入库/manifest.json'
let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}
/**
 * 跑一次清洗（直接调库，不再 eval 一段代码 —— 逻辑已经是模块）。
 * @param input - `{ manifest, sheets }`。
 * @returns 清洗结果。
 */
async function run(input) {
  return cleanAll(input.manifest, input.sheets)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
console.log('=== 真 manifest ===')
console.log('  tables: ' + String(manifest.tables.length))
console.log('  data_root: ' + String(manifest.meta.data_root))
console.log('  db_path: ' + String(manifest.meta.db_path))

/* ── ① 端到端跑一遍（构造一张表的两个文件）── */
console.log('')
console.log('=== ① 用真 manifest 跑清洗（构造行数据）===')
{
  /* 挑一张**规则简单**的表（product_map：只有排除列、无排除行规则）。 */
  const spec = manifest.tables.find(t => t.id === 'product_map')
  check('找到 product_map 表', spec !== undefined)
  if (spec) {
    console.log('  表: ' + spec.table + '  文件夹: ' + spec.folder)
    console.log('  主键: ' + JSON.stringify(spec.primary_key))
    console.log('  排列: ' + JSON.stringify(spec.exclude_columns))

    const header = ['商品ID', '链接名', '券后最低价', '店铺名称']
    const input = {
      manifest,
      sheets: [{
        specId: 'product_map', file: 'test-商品表.xlsx', sheetName: 'Sheet1',
        header,
        rows: [
          ['1234567890123456789', '某链接', '49.7 ~ 74.55', 'DemoShop旗舰店'],
          [null, '空ID行', '10', 'DemoShop旗舰店'],
        ],
      }],
    }
    const r = await run(input)
    const t = r.tables.find(x => x.id === 'product_map')
    console.log('  行数: ' + String(t.rows.length))
    console.log('  列: ' + JSON.stringify(t.columns))
    console.log('  第一行: ' + JSON.stringify(t.rows[0]))
    check('★ 19 位商品 ID **保文本**（没被转成浮点丢精度）',
      t.rows[0]['商品ID'] === '1234567890123456789', String(t.rows[0]['商品ID']))
    check('★ 日期列被转成 T00:00:00.000 格式（Cube 边界字面量要求）',
      typeof t.rows[0]['日期'] === 'string' && (t.rows[0]['日期'] === '' || t.rows[0]['日期'].includes('T00:00:00.000')),
      String(t.rows[0]['日期']))
    check('主键缺失时归一成空串（防 ON CONFLICT 失效）',
      t.rows[1]['商品ID'] === '', JSON.stringify(t.rows[1]['商品ID']))
    check('来源文件 / 入库时间都补上了',
      t.rows[0]['来源文件'] === 'test-商品表.xlsx' && typeof t.rows[0]['入库时间'] === 'string')
    check('summary 有这张表', r.summary.some(s => s.table === spec.table))
  }
}

/* ── ② 排除行规则（挑一张有排除行的表）── */
console.log('')
console.log('=== ② 排除行规则 ===')
{
  const spec = manifest.tables.find(t => t.exclude_row_rules && t.exclude_row_rules.length > 0)
  check('找到有排除行规则的表', spec !== undefined, spec?.id)
  if (spec) {
    const rule = spec.exclude_row_rules[0]
    console.log('  表: ' + spec.id + '  规则: ' + JSON.stringify(rule))
    const header = [rule.column, '其他列']
    const input = {
      manifest,
      sheets: [{
        specId: spec.id, file: 'x.xlsx', sheetName: 'S',
        header,
        rows: [
          [rule.values[0], '该被排除'],
          ['不匹配的值', '该留下'],
        ],
      }],
    }
    const r = await run(input)
    const t = r.tables.find(x => x.id === spec.id)
    console.log('  留下 ' + String(t.rows.length) + ' 行')
    check('★ 命中排除值的行被丢掉', t.rows.length === 1, String(t.rows.length))
    check('★ 留下的是那一行', t.rows[0]?.['其他列'] === '该留下', JSON.stringify(t.rows[0]?.['其他列']))
  }
}

/* ── ③ 保留行规则（只留指定值）── */
console.log('')
console.log('=== ③ 保留行规则（只留指定值）===')
{
  const spec = manifest.tables.find(t => t.keep_row_rules && t.keep_row_rules.length > 0)
  check('找到有保留行规则的表', spec !== undefined, spec?.id)
  if (spec) {
    const rule = spec.keep_row_rules[0]
    console.log('  表: ' + spec.id + '  规则: ' + JSON.stringify(rule))
    const input = {
      manifest,
      sheets: [{
        specId: spec.id, file: 'x.xlsx', sheetName: 'S',
        header: [rule.column, '其他列'],
        rows: [[rule.values[0], '留下'], ['不在列表里', '丢掉']],
      }],
    }
    const r = await run(input)
    const t = r.tables.find(x => x.id === spec.id)
    check('★ 只留 values 里的行', t.rows.length === 1, String(t.rows.length))
    check('留对了', t.rows[0]?.['其他列'] === '留下', JSON.stringify(t.rows[0]?.['其他列']))
  }
}

/* ── ④ 空文件夹的表 → 不算错，标 skipped ── */
console.log('')
console.log('=== ④ 没有文件的表 ===')
{
  const r = await run({ manifest, sheets: [] })
  check('17 张表都在结果里（没有文件也占位）', r.tables.length === manifest.tables.length, String(r.tables.length))
  check('每张表都标了 skipped 原因', r.tables.every(t => typeof t.skipped === 'string' && t.skipped !== ''),
    JSON.stringify(r.tables[0]?.skipped))
  check('没有行', r.tables.every(t => t.rows.length === 0))
}

/* ── ⑤ 数值/日期归一（照 clean.ts 的实锤规则）── */
console.log('')
console.log('=== ⑤ 数值与日期归一（这几条都是实锤换来的）===')
{
  const spec = manifest.tables.find(t => t.id === 'product_map')
  const header = ['商品ID', '数值列', '日期列', '缺失列']
  const input = {
    manifest,
    sheets: [{
      specId: 'product_map', file: 'x.xlsx', sheetName: 'S', header,
      rows: [
        ['9999999999999999', '1,234.5', '20260630', 'NULL'],
        ['1', '49.7', '2026-06-30', '—'],
        ['2', 'abc', 20260630, '/'],
      ],
    }],
  }
  const r = await run(input)
  const t = r.tables.find(x => x.id === 'product_map')
  const row0 = t.rows[0]
  const row1 = t.rows[1]
  const row2 = t.rows[2]
  console.log('  行0: ' + JSON.stringify(row0))
  console.log('  行2: ' + JSON.stringify(row2))
  check('★ 16 位以上数字保文本', row0['商品ID'] === '9999999999999999', String(row0['商品ID']))
  check('★ 千分位数字转 number', row0['数值列'] === 1234.5, JSON.stringify(row0['数值列']))
  check('★ 8 位数字日期串 → ISO', String(row0['日期列']).startsWith('2026-06-30'), String(row0['日期列']))
  check('★ 缺失占位符 NULL → SQL NULL', row0['缺失列'] === null, JSON.stringify(row0['缺失列']))
  check('★ 缺失占位符 — → SQL NULL', row1['缺失列'] === null, JSON.stringify(row1['缺失列']))
  check('★ 缺失占位符 / → SQL NULL', row2['缺失列'] === null, JSON.stringify(row2['缺失列']))
  check('★ 数字型 8 位日期 → ISO', String(row2['日期列']).includes('2026-06-30'), String(row2['日期列']))
  check('非数字文本原样保留', row2['数值列'] === 'abc', JSON.stringify(row2['数值列']))
}

/* ── ⑥ 坏输入必须明确报错 ── */
console.log('')
console.log('=== ⑥ 坏输入 ===')
{
  let e1 = false
  try { await run({ sheets: [] }) } catch { e1 = true }
  check('没有 manifest → 明确抛错', e1)
  let e2 = false
  try { await run({ manifest: { tables: 'x' }, sheets: [] }) } catch { e2 = true }
  check('manifest.tables 不是数组 → 明确抛错', e2)
}

console.log('')
console.log(failed === 0 ? '结论：清洗逻辑用真 manifest 离线验过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
