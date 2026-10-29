/** 钉住「浏览器驱动脚本能被找到」——**从产物里验**。
 *
 * ## 为什么必须有这个文件（它是被一个真 bug 换来的）
 *
 * 2026-10-13 用户报：在工作流里点运行，第一个节点就报
 * 「找不到浏览器驱动脚本：`...\lib\driver.mjs`」。
 *
 * 根因：`driverPath()` 原来只找 `join(HERE, 'driver.mjs')`，
 * 假设「实现模块与 driver 同目录」——**那只在源码目录成立**。
 * 产物里 `impl.ts` 被内联进 `lib/index.js`，于是 `HERE` = `lib/`，
 * 它去找 `lib/driver.mjs`，而真文件在 `lib/nodes/browser/driver.mjs`。
 *
 * ## 为什么以前的测试没抓到
 *
 * `browser-driver.mjs` 读的是**源码** `src/nodes/browser/driver.mjs`
 * —— 而**源码路径下那个假设是成立的**，所以一直是绿的。
 * 我自己的真机验证也走的源码路径。
 *
 * **所以这个文件只做一件事：从产物出发，走用户实际走的那条路。**
 * 判据不查字符串（那样会被注释救活），而是**把产物里那段解析逻辑真跑一遍**。
 *
 * 跑法：node tests/browser-driver-path.mjs（需先 `npm run bundle`）
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const LIB = new URL('../lib/', import.meta.url).pathname.replace(/^\//, '')

console.log('=== 浏览器驱动脚本的产物路径（走用户实际走的那条路）===')

/* ① 产物必须先存在（不存在就是没构建，那这条测试等于没跑）。 */
const INDEX = join(LIB, 'index.js')
check('产物 lib/index.js 存在（先 npm run bundle）', existsSync(INDEX), INDEX)
if (!existsSync(INDEX)) {
  console.log('')
  console.log('结论：没有产物，无法验证 ✗')
  process.exit(1)
}

/* ② driver.mjs 必须在产物里、且位置与 copy-runtime 的约定一致。 */
const DRIVER = join(LIB, 'nodes', 'browser', 'driver.mjs')
check('产物里有 lib/nodes/browser/driver.mjs（copy-runtime 复制到了）',
  existsSync(DRIVER), DRIVER)

/* ③ **关键**：把产物里那段 driverPath 逻辑**真跑一遍** ——
 * 不是查它写了什么，而是按它的候选列表逐个试，看能不能命中真文件。
 *
 * 做法：从产物源码里**抽出候选路径的构造方式**（它用了 `join(HERE, X)`），
 * 直接照 `HERE = lib/` 重新算候选；这等价于运行期会发生的事。 */
{
  const src = readFileSync(INDEX, 'utf8')
  /* 抽出所有 `join(HERE, "..."  )` 里的相对片段（产物是双引号、压缩过）。 */
  const rels = [...src.matchAll(/join\(HERE,\s*("(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*)\)/g)]
    .map(m => m[1])
    .map(part => [...part.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]))
  /* HERE 在产物里 = lib/（index.js 所在目录），这就是运行期的真实情况。 */
  const here = LIB
  const tried = []
  let hit = null
  for (const segs of rels) {
    const p = join(here, ...segs)
    tried.push(p)
    if (existsSync(p)) { hit = p; break }
  }
  console.log('    产物里构造了 ' + String(rels.length) + ' 个候选路径')
  for (const t of tried) console.log('      ' + (existsSync(t) ? '✓' : '·') + ' ' + t.replace(LIB, 'lib/'))
  check('★ 产物里的候选路径**至少有一个命中真文件**', hit !== null,
    hit === null ? '全都找不到 —— 这就是用户报的「找不到驱动脚本」' : hit.replace(LIB, 'lib/'))

  /* ④ 反向自证：旧的写法（只找 HERE/driver.mjs）**必须**不命中 ——
   * 否则说明产物结构变了、bug 不复现，那这条测试该重新审。 */
  const oldStyle = join(here, 'driver.mjs')
  check('（对照）旧写法的 lib/driver.mjs 确实不存在（说明 bug 是真的）',
    !existsSync(oldStyle), oldStyle.replace(LIB, 'lib/'))
}

/* ⑤ 候选里必须包含「产物真实布局」那个 —— 这是本次修复的核心。 */
{
  const src = readFileSync(INDEX, 'utf8')
  const i = src.indexOf('function driverPath')
  const body = i < 0 ? '' : src.slice(i, i + 1200)
  check('修好的产物里 driverPath 有多候选（不是只找自己旁边）',
    /nodes["'],\s*["']browser/.test(body), i < 0 ? '找不到 driverPath' : '')
  if (i < 0) failed += 1
}

console.log('')
console.log(failed === 0
  ? '结论：浏览器驱动脚本在产物里能找到 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
