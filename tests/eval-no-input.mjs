/** 页面内 eval 的代码**不许读 input**（用户 2026-10-20 报的真 BUG）。
 *
 * ## 症状
 *
 * 天猫工作流跑到「⑧ 触发下载 + 轮询拿直链」就断：
 *
 *   page.evaluate: ReferenceError: input is not defined
 *
 * ## 根因
 *
 * `browser.act` 的 eval 动作把代码**原样送进页面**执行
 * （`driver.mjs`：`page.evaluate(async (src) => eval(...), code)`）。
 * 页面里**没有** `input` 这个变量 —— 它只在 `code.js`（Node 侧）里存在，
 * 由调度器注入（`run.ts` 的 `emit` 那条链）。
 *
 * 第一版照抄了 `code.js` 的写法（`const up = input && ...`），所以真机上必炸。
 * 而离线测试**抓不到**：那个测试的桩不认识这段代码，直接返回构造数据，
 * 根本没执行它。**这就是「测试全绿、真机报错」的又一次。**
 *
 * ## 正确写法（照抖音那几段的先例）
 *
 * 用变量替换把上游数据**写进代码文本**：
 *
 *   const reports = Array.isArray({{reports}}) ? {{reports}} : []
 *
 * 对象会被 `JSON.stringify` 成合法 JS 字面量（`variables.ts` 的 `toText`）。
 * 抖音的 `DY_READ_R` 写 `const item = {{item}}` 就是这个路子。
 *
 * ## 这条测试盯什么
 *
 * 拿**生成的存档**里每个 `browser.act` 的 eval 代码，去掉注释后看有没有
 * 裸 `input`。有就红 —— 那种代码到了真机上一定 ReferenceError。
 *
 * 跑法：node tests/eval-no-input.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 去掉 JS 注释，只留代码。
 *
 * ⚠️ 必须先去注释再判 —— 我们**故意**在注释里写「页面里没有 input」这类说明，
 * 不去注释会把说明当代码误报（第一版没有这一步，结果自己写的注释把测试搞红）。
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

const DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
console.log('=== 扫所有存档里 browser.act 的 eval 代码 ===')
if (!existsSync(DIR)) {
  console.log('  （存档目录不存在：先跑 node scripts/build-patrol-workflows.mjs）')
  process.exit(1)
}

let scanned = 0
let bad = 0
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue
  let doc
  try { doc = JSON.parse(readFileSync(join(DIR, f), 'utf8')) } catch { continue }
  if (!Array.isArray(doc.nodes)) continue
  for (const n of doc.nodes) {
    if (n.defId !== 'browser.act') continue
    if (n.params?.action !== 'eval') continue
    const code = String(n.params.code ?? '')
    if (code === '') continue
    scanned += 1
    const body = stripComments(code)
    /* 只认「当变量用」的 input。
     *
     * ⚠️ 第一版判据太宽，把 `document.querySelectorAll(root + ' input')` 也算进来了
     * —— 那里面 input 是**选择器字符串的一部分**。所以要先去掉所有字符串字面量，
     * 再在剩下的代码里找裸 input。
     *
     * 这样做还有个好处：不会因为我们自己在文案里写「页面里没有 input」而误报
     * （那种在字符串里，去掉之后就不见了）。 */
    const noStr = body
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
    const hit = /(^|[^.\w$])input\b/m.exec(noStr)
    if (hit === null) continue
    const at = noStr.indexOf(hit[0]) + hit[0].indexOf('input')
    const line = noStr.slice(Math.max(0, at - 50), at + 60).replace(/\n/g, ' ')
    console.log('  ✗ ' + f.replace('.json', '') + ' / ' + n.id + ' (' + String(n.label ?? '') + ')')
    console.log('      …' + line.trim() + '…')
    bad += 1
  }
}

console.log('')
check('扫到了 eval 节点（不是空跑）', scanned > 0, String(scanned) + ' 个')
check('★★ 没有任何 eval 代码读 input', bad === 0, bad === 0 ? '' : String(bad) + ' 处（真机上会 ReferenceError）')

console.log('')
console.log('=== 天猫「触发下载」那段必须走变量替换 ===')
{
  const TM = join(DIR, '取数-天猫生意参谋.json')
  if (existsSync(TM)) {
    const doc = JSON.parse(readFileSync(TM, 'utf8'))
    const n = doc.nodes.find(x => /触发下载/.test(String(x.label ?? '')))
    check('找得到「触发下载」节点', n !== undefined, n?.id)
    if (n !== undefined) {
      const code = String(n.params.code ?? '')
      check('★★ 它用 {{reports}} 变量替换', code.includes('{{reports}}'))
      check('★ 它不再读 input', !/\binput\b/.test(stripComments(code)))
    }
  }
}

console.log('')
console.log(failed === 0 ? '结论：页面内代码都没读 input ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
