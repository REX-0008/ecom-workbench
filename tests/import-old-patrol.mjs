/** 旧项目巡查数据导入（票 13）：3 份切 5 份、保留旧日期、原样留 `—`/`unknown`、幂等。
 *
 * ## 这条测试盯什么
 *
 * `scripts/import-old-patrol.mjs` 是**一次性**脚本，跑一次就结束了 ——
 * 正因为如此，它里面的三条硬约束（旧日期、原样保留未采到的项、幂等）
 * 一旦被谁顺手改坏，**没有第二次运行会替你发现问题**。
 * 所以判据钉在**它产出的五份文件**上，而不是「脚本跑完退出码 0」。
 *
 * ## 判据（对应票 13 的六条验收）
 *
 * 1. 9 个块按 `id` 切分，5 份文件各自的块数与切分表一致
 * 2. `patrol-tm-shop.json` 里块的 `id` 只有 `tm-score` / `tm-alert` / `tm-sales`（不混 `dy-*`）
 * 3. `runAt` / `dataDate` 是旧原值（2026-09-16 / 2026-09-18），**不是今天**
 * 4. 27 项一项不少，含 3 项 `—` / `unknown` 的**原样保留**
 * 5. 幂等：跑两次，5 份文件内容逐字相同
 * 6. 不在名单里的三类文件（`tm-sycm` / `douyin-ui` / `巡查-*`）还在、内容不变
 *
 * ## 为什么不去碰真实盘上的文件
 *
 * 判据 5、6 会**写盘**，而真实 `patrol/` 是用户数据。所以整条测试在
 * `$DSH_HOME` 下的一个临时目录里跑：源用**真**的旧项目文件（只读、路径写死），
 * 目标用临时目录。真实 `patrol/` 一个字节不碰。
 *
 * ⚠️ 旧项目那三份文件**不在本仓库**（`D:/ecom-data/...`）。
 * 换机器就没有 → 那一段**跳过**（不算失败），与 `tests/real-archive-if.mjs` 同一条纪律。
 *
 * 跑法：node tests/import-old-patrol.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  splitToFive, readSources, importOldPatrol,
  OLD_PATROL_OUT, BLOCK_HOME, TARGET_SOURCE,
} from '../scripts/import-old-patrol.mjs'
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

console.log('=== 旧项目巡查数据导入（3 份切 5 份）===')
console.log('旧数据目录：' + OLD_PATROL_OUT)
console.log('')

/* ⚠️ 找不到旧数据就跳过（不算失败）：那三份在项目侧的数据根里，不在本仓库。 */
const hasSource = ['shop.json', 'activity.json', 'qianchuan.json']
  .every(f => existsSync(join(OLD_PATROL_OUT, f)))
if (!hasSource) {
  console.log('（本机没有旧项目巡查数据，跳过 —— 它在 ' + OLD_PATROL_OUT + '，不在本仓库）')
  console.log('')
  console.log('结论：没有可核对的旧数据（跳过）✓')
  process.exit(0)
}

const sources = readSources(OLD_PATROL_OUT)
const five = splitToFive(sources)

/* ── 判据 1：9 个块按 id 切分，5 份的块数与切分表一致 ─────────────── */
console.log('① 按块 id 切分')
{
  /** 切分表里每个目标文件该有几块（由 BLOCK_HOME 反算，不另抄一遍数字）。 */
  const expect = new Map()
  for (const home of Object.values(BLOCK_HOME)) expect.set(home, (expect.get(home) ?? 0) + 1)
  let allOk = true
  for (const job of PATROL_JOBS) {
    const doc = five.get(job.outFile)
    const want = expect.get(job.outFile) ?? 0
    const got = Array.isArray(doc?.blocks) ? doc.blocks.length : -1
    if (got !== want) allOk = false
    check('★ ' + job.outFile + ' 块数 = ' + String(want), got === want, String(got) + ' 块')
  }
  check('★★ 五份加起来正好 9 块（一块不多一块不少）', allOk
    && [...five.values()].reduce((s, d) => s + d.blocks.length, 0) === 9,
  String([...five.values()].reduce((s, d) => s + d.blocks.length, 0)) + ' 块')
}

/* ── 判据 2：天猫店铺那份不许混进 dy-* 的块 ───────────────────────── */
console.log('')
console.log('② 平台不串味')
{
  const tmShopIds = five.get('patrol-tm-shop.json').blocks.map(b => String(b.id))
  check('★★ patrol-tm-shop.json 只有 tm-score / tm-alert / tm-sales',
    JSON.stringify(tmShopIds) === JSON.stringify(['tm-score', 'tm-alert', 'tm-sales']),
    tmShopIds.join(', '))
  const dyShopIds = five.get('patrol-dy-shop.json').blocks.map(b => String(b.id))
  check('★★ patrol-dy-shop.json 只有 dy-score / dy-alert / dy-sales',
    JSON.stringify(dyShopIds) === JSON.stringify(['dy-score', 'dy-alert', 'dy-sales']),
    dyShopIds.join(', '))
  let noCross = true
  for (const job of PATROL_JOBS) {
    for (const b of five.get(job.outFile).blocks) {
      const id = String(b.id)
      if (job.platform === 'tm' && id.startsWith('dy-')) noCross = false
      if (job.platform === 'dy' && id.startsWith('tm-')) noCross = false
    }
  }
  check('★★ 没有一份里混进另一平台的块', noCross)
}

/* ── 判据 3：runAt / dataDate 是旧原值，不是今天 ──────────────────── */
console.log('')
console.log('③ 日期用旧原值（不谎报）')
{
  const today = new Date().toLocaleDateString('sv')
  /** 旧数据里那两个日期（票 13 明写）。 */
  const OLD_DATES = { shop: '2026-09-16', activity: '2026-09-18' }
  for (const job of PATROL_JOBS) {
    const doc = five.get(job.outFile)
    const srcKey = TARGET_SOURCE[job.outFile]
    const wantDate = OLD_DATES[srcKey] ?? '2026-09-16'
    check('★★ ' + job.outFile + ' 的 dataDate 是旧值 ' + wantDate,
      doc.dataDate === wantDate, String(doc.dataDate))
  }
  let anyToday = false
  for (const doc of five.values()) {
    if (doc.dataDate === today) anyToday = true
    if (String(doc.runAt ?? '').startsWith(today)) anyToday = true
  }
  check('★★ 五份里没有任何一份的日期是今天（' + today + '）', !anyToday)
  /* `runAt` 必须是 ISO 时间戳，且年份与 dataDate 同一年（不是被 new Date() 刷成今天）。 */
  const tmShop = five.get('patrol-tm-shop.json')
  check('★ patrol-tm-shop.json 的 runAt 与来源 shop.json 逐字相同',
    tmShop.runAt === sources.shop.runAt, String(tmShop.runAt))
}

/* ── 判据 4：27 项一项不少，含 3 项 — / unknown ────────────────────── */
console.log('')
console.log('④ 27 项一项不少，未采到的原样保留')
{
  let items = 0
  for (const doc of five.values()) for (const b of doc.blocks) items += (b.items ?? []).length
  check('★★ 五份加起来正好 27 项', items === 27, String(items) + ' 项')

  /** 旧数据里那 3 项「本来就没采到」的（票 13 点名要求原样保留）。
   *
   * ⚠️ 判据按**值**是不是 `—` 算，**不能按 `state === 'unknown'` 算** ——
   * 实测这三项里状态并不统一：
   *   · 千川「今日成交金额」「ROI」 → value `—`、state `unknown`
   *   · 抖音活动报名「活动」       → value `—`、state **`ok`**（旧项目就是这么写的）
   * 票面把它们合称「`—` / `unknown`」，指的是同一批「没采到」的项，不是同一个状态值。
   * 第一版按 state 判只数出 2 项，就是这个原因。 */
  const dashes = []
  for (const doc of five.values()) {
    for (const b of doc.blocks) {
      for (const it of (b.items ?? [])) {
        if (String(it.value) === '—') dashes.push(b.id + '/' + String(it.label) + '(' + String(it.state) + ')')
      }
    }
  }
  check('★★ 3 项「—」原样留着（千川成交金额、千川 ROI、抖音活动）',
    dashes.length === 3, dashes.join('、'))
  check('★ 千川的今日成交金额与 ROI 两项都在',
    dashes.some(d => d.startsWith('qianchuan/今日成交金额'))
    && dashes.some(d => d.startsWith('qianchuan/ROI')), dashes.join('、'))
  check('★ 抖音活动报名的「活动」那一项还在',
    dashes.some(d => d.startsWith('dy-activity/活动')), dashes.join('、'))
}

/* ── 判据 5 + 6：幂等与「不动别人」，在临时目录里真写盘 ────────────── */
console.log('')
console.log('⑤⑥ 幂等 + 不碰不在名单里的文件（在临时目录里真写盘，真实 patrol/ 不碰）')
{
  const sandbox = mkdtempSync(join(tmpdir(), 'ewb-import-patrol-'))
  try {
    /* 先放三个「不该被动的」文件进去，模拟真实目录里的那三类。 */
    const bystanders = {
      'tm-sycm.json': '{"runAt":"2026-10-23T04:24:00.000Z"}',
      'douyin-ui.json': '{"ok":true,"total":32,"okCount":30,"failCount":2,"stoppedModules":[],"note":""}',
      '巡查-天猫-活动报名-20261030-013816-t6mm.json': '{"startedAt":"2026-10-30T01:38:16.000Z","outputs":[]}',
    }
    mkdirSync(sandbox, { recursive: true })
    for (const [f, text] of Object.entries(bystanders)) writeFileSync(join(sandbox, f), text, 'utf8')

    const run1 = importOldPatrol({ srcDir: OLD_PATROL_OUT, outDir: sandbox })
    const snapshot1 = new Map()
    for (const file of run1.keys()) snapshot1.set(file, readFileSync(join(sandbox, file), 'utf8'))

    const run2 = importOldPatrol({ srcDir: OLD_PATROL_OUT, outDir: sandbox })
    let identical = true
    for (const file of run2.keys()) {
      if (readFileSync(join(sandbox, file), 'utf8') !== snapshot1.get(file)) identical = false
    }
    check('★★ 跑两次，5 份文件逐字相同（幂等，不是追加）', identical)
    check('★ 两次都只产出 5 份（没有生出第 6 份）', run1.size === 5 && run2.size === 5,
      String(run1.size) + ' / ' + String(run2.size))

    /* 三个「不该被动的」还在、内容一个字节没变。 */
    let bystandersOk = true
    for (const [f, text] of Object.entries(bystanders)) {
      const p = join(sandbox, f)
      if (!existsSync(p) || readFileSync(p, 'utf8') !== text) bystandersOk = false
    }
    check('★★ tm-sycm / douyin-ui / 巡查-* 三类文件都还在且内容没变', bystandersOk)

    /* 临时目录里只有 5 + 3 个 json（没有别的东西被写出来）。 */
    const jsons = readdirSync(sandbox).filter(x => x.endsWith('.json')).sort()
    check('★ 目录里正好 8 个 json（5 份结果 + 3 个旁观者）', jsons.length === 8, jsons.length + ' 个')
  } finally {
    /* 清掉沙箱（`$DSH_HOME/tmp/` 的临时产物跑完即删）。 */
    rmSync(sandbox, { recursive: true, force: true })
  }
}

console.log('')
console.log(failed === 0
  ? '结论：旧数据切成 5 份、日期是旧值、27 项齐全、幂等、不碰旁文件 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
