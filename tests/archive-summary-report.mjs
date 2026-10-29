/** 采集存档里那句「整平台汇总」必须**说自己算出来的数**，不是引擎猜的形状。
 *
 * ## 为什么要有这一条（2026-10-27，票 20 第三件）
 *
 * 引擎对 `code.js` 的汇报原本只能报**形状**（「算出了对象，6 个键」）——
 * 它不知道那段代码在算什么。用户点开任务记录看到的是「一个 6 个键的对象」，
 * 而不是「采到 32 条，成功 30，失败 2」。
 *
 * 引擎后来开了个口子（`src/dispatch/builtins.ts` 的 `ownReportOf`）：
 * 输出里带 `__report`（**非空字符串**）就用它当汇报，**并从输出里摘掉**再交给下游。
 *
 * ## 这条测试盯四件事
 *
 * ① **两份存档的汇总节点都带 `__report`** —— 少一份就是漏改（当年派活写「三份」，
 *    实际只有两份有汇总节点：天猫是线性批量下载，没有汇总这一步）；
 * ② **那句汇报真的带业务量** —— 条数 / 成功 / 失败里至少两样，不许「汇总完成」；
 * ③ **`__report` 不落进输出** —— 走的是**真的 `runCodeFn`**，不是自己模拟摘除。
 *    引擎那一步一旦退化成「不摘」或「浅拷贝漏键」，这里会红；
 * ④ **业务键一个不少** —— 与改动前的基线逐键比对（两份清单不同，各比各的）。
 *
 * ⚠️ 判据不能只看「有汇报」：`__report` 写成空串时引擎会退回形状描述，
 * 那也算「有汇报」。所以要断言句子里**含量词**。
 *
 * 跑法：`DSH_HOME=F:/AGENTS/agent-chat-dsh node tests/archive-summary-report.mjs`
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { runCodeFn } from '../src/dispatch/builtins.ts'

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

const DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')

console.log('=== 采集存档的「整平台汇总」自己说那句话 ===')

/* 找不到存档就跳过（与 `real-archive-if` / `archive-edges` 同一条纪律）。 */
if (!existsSync(DIR)) {
  console.log('（本机没有存档目录：' + DIR + '，跳过）')
  console.log('')
  console.log('结论：没有可核对的存档（跳过）✓')
  process.exit(0)
}
console.log('存档目录：' + DIR)

/** 业务量判据：句子里至少要有两个数（条数 / 成功 / 失败 / 跳过）。 */
const QUANTITY = /\d+\s*(条|段)/

/**
 * 去掉 JS 注释，只留代码。
 *
 * ⚠️ 必须先去掉再判「有没有写 `__report`」—— 那段代码的注释里反复提到这个词，
 * 不去注释就会把说明当代码（第一版就是这么假绿的）。
 *
 * @param code - 源码。
 * @returns 去掉注释的代码。
 */
function stripComments(code) {
  let out = ''
  let i = 0
  while (i < code.length) {
    const two = code.slice(i, i + 2)
    if (two === '//') {
      const nl = code.indexOf('\n', i)
      if (nl < 0) break
      i = nl
      continue
    }
    if (two === '/*') {
      const end = code.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 2
      continue
    }
    out += code[i]
    i += 1
  }
  return out
}

/**
 * 每一份的配置。
 *
 * - `keys` 是**改动前**记录的键名清单（抖音来自磁盘上真跑过的 `patrol/douyin-ui.json`，
 *   千川来自抠脚本本体跑出来的），改完必须逐键相同。
 * - `input` 是喂给汇总代码的假输入。**必须按那段代码自己认的形状造**：
 *   抖音认 `r.failed === true` 才算连续失败；千川认「有 `endDate` 且 `ok` 是布尔」才算轮次，
 *   且 `skipped` 与 `ok: false` 互斥（见 `qianchuan-code.mjs` 组装那一轮的地方）。
 *   ⚠️ 造错的话 `rounds` 会是空数组、输出全是 0 —— 那是**假基线**，不是没数据。
 */
const CASES = [
  {
    label: '抖音',
    file: '取数-抖音电商罗盘',
    keys: ['ok', 'total', 'okCount', 'failCount', 'stoppedModules', 'note'],
    input: {
      rounds: Array.from({ length: 32 }, (_, i) => ({
        moduleName: 'm' + String(i % 7), date: '2026-10-2' + String(i % 9),
        ok: i < 30, failed: i >= 30, file: 'f' + String(i) + '.xlsx',
      })),
    },
  },
  {
    label: '千川',
    file: '取数-千川全域推广',
    keys: ['ok', 'total', 'okCount', 'skipCount', 'failCount', 'byType', 'note'],
    input: {
      rounds: Array.from({ length: 32 }, (_, i) => ({
        moduleName: 'm' + String(i % 2), type: 't' + String(i % 3),
        endDate: '2026-10-2' + String(i % 9),
        /* 第 31 条是「跳过」（`ok` 仍为真），最后一条才是失败。 */
        ok: i < 31, skipped: i === 30, file: 'q' + String(i) + '.xlsx',
      })),
    },
  },
]

for (const c of CASES) {
  const file = join(DIR, c.file + '.json')
  if (!existsSync(file)) {
    console.log('  · ' + c.label + '：本机没有 ' + c.file + '.json，跳过')
    continue
  }
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const sums = (doc.nodes ?? []).filter(n => n.defId === 'code.js' && /汇总/.test(String(n.label ?? '')))
  check('★ ' + c.label + ' 找得到汇总节点（不是空跑）', sums.length === 1, String(sums.length))
  const sum = sums[0]
  if (sum === undefined) continue

  /* ① 源码里带 `__report`，且是**字符串**（对象形式引擎不认，还会原样留在输出里）。
   *
   * ⚠️ **必须先去注释再判**（第一版没去，判到的是注释里那句说明，
   * 于是这条断言永远是绿的 —— 正是「通过把没验到包进去」那种病）。
   * 判据落在**真的赋值**上：`const __report = '…'`，且 return 的对象里有这个键。 */
  const src = String(sum.params?.code ?? '')
  const body = stripComments(src)
  check('★★ ' + c.label + ' 汇总代码里写了 __report', body.includes('__report'))
  check('★ ' + c.label + ' __report 是字符串（不是对象，对象引擎不认）',
    /__report\s*=\s*'/.test(body) || /__report\s*=\s*"/.test(body),
    (body.match(/__report\s*=\s*['"][^'"]{0,30}/) ?? ['（没找到赋值）'])[0])
  check('★ ' + c.label + ' __report 进了 return 的对象（不是只算不用）',
    /return\s*\{[\s\S]*__report/.test(body))

  /* ③ 走**真** `runCodeFn`：这样验的既是「句子对不对」，也是「引擎摘没摘」。 */
  const reports = []
  const out = await runCodeFn(
    { params: { code: src, timeout: 10000 } },
    { upstream: [c.input], workdir: DIR, report: (e) => reports.push(e.message) },
  )

  const msg = String(reports[0] ?? '')
  check('★★ ' + c.label + ' 推了一条汇报', reports.length === 1, JSON.stringify(reports))
  /* ② 业务量：句子里至少要有两个数（条数 + 成功/失败之一）。 */
  const nums = msg.match(/\d+/g) ?? []
  check('★★ ' + c.label + ' 那句汇报里有业务量（至少两个数）', nums.length >= 2, msg)
  check('★★ ' + c.label + ' 那句汇报带量词（条 / 段）', QUANTITY.test(msg), msg)
  check('★ ' + c.label + ' 不是形状描述（不许出现「个键」）', !/个键/.test(msg), msg)

  /* ③ 摘除：走真引擎，输出里不许有 `__report`。 */
  const outKeys = out !== null && typeof out === 'object' && !Array.isArray(out) ? Object.keys(out) : []
  check('★★ ' + c.label + ' __report 没落进输出（引擎摘掉了）',
    !outKeys.includes('__report'), JSON.stringify(outKeys))

  /* ④ 业务键一个不少：与改动前的基线逐键比。 */
  check('★★ ' + c.label + ' 业务键与改前基线逐键一致',
    JSON.stringify(outKeys) === JSON.stringify(c.keys),
    JSON.stringify(outKeys) + ' vs ' + JSON.stringify(c.keys))
}

console.log('')
console.log(failed === 0 ? '结论：两份存档的整平台汇总都说出了业务量 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
