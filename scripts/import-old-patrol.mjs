/** 从旧项目导入巡查结果：旧 3 份按块 `id` 切成新 5 份。
 *
 * ## ⚠️ 这是**临时数据**，不是采集出来的
 *
 * 源是旧项目 `D:/ecom-data/自动巡查/out/` 下那三份
 * （`shop.json` 2026-09-16、`activity.json` 2026-09-18、`qianchuan.json` 2026-09-16），
 * 出处 `my-dsh-plugins/workbench/src/workbench-node.ts:37-38` 的 `PATROL_DIR`。
 *
 * 用户 2026-10-30 的原话：「巡查的旧数据去旧项目找，**数据展示先用旧项目的数据暂不采集**」。
 *
 * 所以这份数据的寿命是：**等新的巡查工作流（票 10）修好、真跑过之后，
 * 重跑一次巡查就会把这 5 个文件覆盖掉。** 届时本脚本不要再跑 ——
 * 再跑等于把 9 月的数据盖回盘上，界面会显示「数据更新于 09-16」而实际早跑过新的。
 *
 * ## 为什么是 3 → 5
 *
 * 旧项目一份 `shop.json` 里装 6 个块（天猫 3 + 抖音 3），我们按
 * 「一份 = 一个平台 + 一个任务」拆成 5 份（见 `scripts/patrol/jobs.mjs` 的文件头）。
 * 切分规则按块的 `id`，9 个块一个不多一个不少、每块唯一归属：
 *
 * | 旧块 id | 归到 |
 * | --- | --- |
 * | `tm-score` / `tm-alert` / `tm-sales` | `patrol-tm-shop.json` |
 * | `dy-score` / `dy-alert` / `dy-sales` | `patrol-dy-shop.json` |
 * | `tm-activity` | `patrol-tm-activity.json` |
 * | `dy-activity` | `patrol-dy-activity.json` |
 * | `qianchuan` | `patrol-dy-qianchuan.json` |
 *
 * ## 三条硬约束（票 13）
 *
 * ### ① `runAt` / `dataDate` 用**旧的原值**，不许改成今天
 *
 * 改成今天等于谎报「数据是今天采的」，界面上会显示「更新于 10-30」而内容是 9 月的。
 * 这违反用户第 9 条「成功拿到数据才更新数据」。所以每份新文件的这两个字段
 * 直接抄**来源 job**（`shop` / `activity` / `qianchuan`）的原值。
 *
 * ### ② 那 3 项 `—` / `unknown` 原样保留
 *
 * 千川的「今日成交金额」「ROI」、抖音活动报名的「活动」这三项旧数据里就是没采到的。
 * **不许因为「没采到」就删** —— 删了界面上就看不出「这项本来就没有」。
 *
 * ### ③ 幂等
 *
 * 每次都是「按源文件整份重算 → 整份覆盖」，所以跑两次结果逐字节相同，
 * 块也不会叠成两份（不是 append）。
 *
 * ## 跑法
 *
 * ```
 * node scripts/import-old-patrol.mjs
 * ```
 *
 * 目标目录与其它生成器同源：`$DSH_HOME/profiles/<profile>/data/ecom-workbench/patrol`。
 * 测试靠改 `DSH_HOME` 放进沙箱，不会碰真实数据。
 *
 * ⚠️ **只写这 5 个文件**：`patrol/` 下另外几类（`tm-sycm.json`、`douyin-ui.json`、
 * `巡查-*.json` 归档）一个字节都不动。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATROL_JOBS } from './patrol/jobs.mjs'

/** 旧项目的巡查结果目录（只读来源）。 */
export const OLD_PATROL_OUT = 'D:/ecom-data/自动巡查/out'

/** 旧的三份源文件 → 我们的 `job` 名（`job` 字段不进新文件，只用来说明来源）。 */
export const SOURCE_FILES = {
  shop: 'shop.json',
  activity: 'activity.json',
  qianchuan: 'qianchuan.json',
}

/**
 * 块 `id` → 目标文件名。
 *
 * ⚠️ **必须逐条列出，不能只按 `tm-` / `dy-` 前缀切**：
 * `tm-activity` 与 `tm-score` 前缀一样，但一个归活动报名、一个归店铺数据。
 */
export const BLOCK_HOME = {
  'tm-score': 'patrol-tm-shop.json',
  'tm-alert': 'patrol-tm-shop.json',
  'tm-sales': 'patrol-tm-shop.json',
  'dy-score': 'patrol-dy-shop.json',
  'dy-alert': 'patrol-dy-shop.json',
  'dy-sales': 'patrol-dy-shop.json',
  'tm-activity': 'patrol-tm-activity.json',
  'dy-activity': 'patrol-dy-activity.json',
  qianchuan: 'patrol-dy-qianchuan.json',
}

/**
 * 每份目标文件从**哪一份源**取顶层字段（`runAt` / `dataDate` / `ok` / `error`）。
 *
 * 为什么不按块自己算：那四个字段是**一次运行**的属性，不是块的属性。
 * 旧项目里一次 `shop` 运行同时采了天猫和抖音的块，所以两份新文件的 `runAt`
 * 都该是那一次运行的时刻 —— 现在拆开了，但时刻仍是同一个。
 */
export const TARGET_SOURCE = {
  'patrol-tm-shop.json': 'shop',
  'patrol-dy-shop.json': 'shop',
  'patrol-tm-activity.json': 'activity',
  'patrol-dy-activity.json': 'activity',
  'patrol-dy-qianchuan.json': 'qianchuan',
}

/** `PATROL_JOBS` 里那个 job（按 outFile 找）。 */
function jobOf(outFile) {
  const job = PATROL_JOBS.find(j => j.outFile === outFile)
  if (job === undefined) throw new Error('jobs.mjs 里没有 outFile = ' + outFile + ' 的那一份')
  return job
}

/**
 * 读三份旧文件。缺哪份就明确报错（不静默跳过 —— 少了源就切不全 5 份）。
 *
 * @param srcDir - 旧数据目录。
 * @returns `{ shop, activity, qianchuan }` 的解析结果。
 */
export function readSources(srcDir) {
  const out = {}
  for (const [key, file] of Object.entries(SOURCE_FILES)) {
    const p = join(srcDir, file)
    if (!existsSync(p)) {
      throw new Error('找不到旧项目的数据：' + p
        + '\n  本脚本读的是旧项目 ' + OLD_PATROL_OUT + ' 那三份（只读）。'
        + '没有它就切不出 5 份，不静默跳过。')
    }
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(doc.blocks)) {
      throw new Error(file + ' 里没有 blocks 数组（形状与预期不符，先看文件）')
    }
    out[key] = doc
  }
  return out
}

/**
 * 按块 `id` 把三份源切成五份文档（**纯函数，不落盘**，测试直接调它）。
 *
 * @param sources - `readSources()` 的返回值。
 * @returns `Map<outFile, doc>`，键的顺序与 `PATROL_JOBS` 一致。
 */
export function splitToFive(sources) {
  /** 先把所有块按目标归类，顺便查「有没有块没地方去 / 有没有块重复」。 */
  const buckets = new Map()
  for (const file of Object.keys(TARGET_SOURCE)) buckets.set(file, [])
  const seen = new Set()
  for (const [key, doc] of Object.entries(sources)) {
    for (const block of doc.blocks) {
      const id = String(block?.id ?? '')
      const home = BLOCK_HOME[id]
      if (home === undefined) {
        throw new Error('块 id「' + id + '」不在切分表里（来自 ' + SOURCE_FILES[key]
          + '）。要么是命名变了，要么是旧数据里多了一种块 —— 先更新 BLOCK_HOME 再跑。')
      }
      if (seen.has(id)) throw new Error('块 id「' + id + '」出现了两次（旧数据不该有重名块）')
      seen.add(id)
      buckets.get(home).push(block)
    }
  }

  const out = new Map()
  for (const job of PATROL_JOBS) {
    const file = job.outFile
    const src = sources[TARGET_SOURCE[file]]
    if (src === undefined) throw new Error('TARGET_SOURCE 里没有 ' + file + ' 对应的源')
    /* ⚠️ 顶层四个字段抄**来源那一次运行**的原值，不是 new Date()。
     * 见文件头硬约束 ①。 */
    out.set(file, {
      job: job.id,
      platform: job.platform,
      runAt: src.runAt,
      dataDate: src.dataDate,
      ok: src.ok,
      error: src.error,
      blocks: buckets.get(file),
    })
  }
  return out
}

/**
 * 导入并落盘（整份覆盖，因此幂等）。
 *
 * @param opts - `{ srcDir, outDir, write }`。`write` 可替换（测试用它抓内容不落盘）。
 * @returns `Map<outFile, doc>`（写进去的那五份）。
 */
export function importOldPatrol(opts) {
  const { srcDir = OLD_PATROL_OUT, outDir, write } = opts
  const five = splitToFive(readSources(srcDir))
  const put = write ?? ((p, text) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text, 'utf8')
  })
  for (const [file, doc] of five) put(join(outDir, file), JSON.stringify(doc, null, 2))
  return five
}

/* ── 命令行入口 ──────────────────────────────────────────────────────
 * 被 import 时不跑（测试直接调上面的函数）。 */
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === join(process.argv[1])

if (isMain) {
  const HOME = process.env.DSH_HOME ?? ''
  const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
  if (HOME === '') {
    console.error('要设 DSH_HOME（目标目录在 $DSH_HOME/profiles/<profile>/data/ecom-workbench/patrol 下）')
    process.exit(1)
  }
  const OUT_DIR = join(HOME, 'profiles', PROFILE, 'data', 'ecom-workbench', 'patrol')
  const five = importOldPatrol({ outDir: OUT_DIR })
  console.log('旧项目巡查数据（2026-09-16 / 09-18）已切分写入：' + OUT_DIR)
  for (const [file, doc] of five) {
    const src = TARGET_SOURCE[file]
    console.log('')
    console.log('  ' + file)
    console.log('    ' + String(doc.blocks.length) + ' 块 · ok=' + String(doc.ok)
      + ' · runAt=' + String(doc.runAt) + ' · dataDate=' + String(doc.dataDate)
      + ' （顶层字段抄自 ' + SOURCE_FILES[src] + '）')
    for (const b of doc.blocks) {
      console.log('      · ' + b.id + ' [' + String(b.state) + '] ' + String(b.title ?? '')
        + '  ' + String((b.items ?? []).length) + ' 项')
    }
  }
  console.log('')
  console.log('⚠️ 这是 2026-09 的临时数据。新巡查真跑一次就会覆盖掉；之后不要再跑本脚本。')
}
