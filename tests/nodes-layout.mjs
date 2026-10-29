/** 节点目录化的结构与完整性检查。
 *
 * 为什么必须有它：节点是「一切皆工作流」的核心资产，用户 2026-10-12 把它定为
 * **项目基础的文件规划**（一个节点一个目录）。搬错一个、漏掉一个，
 * 在构建、类型检查、界面渲染里**都不报错** —— 只有跑起来点了那个节点才发现。
 *
 * 它盯三件事：
 *   ① 数量与 id 集合（一个都不许少、不许改 id）；
 *   ② 目录结构符合约定（`src/nodes/<分类>/<名>/node.ts`）；
 *   ③ 定义文件**不 import Node 内置模块**（否则客户端打包会带上它们）。
 *
 * 跑法：node --import <tsx> tests/nodes-layout.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { NODE_LIBRARY } from '../src/nodes/index.ts'

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

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\//, '')
const NODES_DIR = join(ROOT, 'src/nodes')

/** 收集所有 node.ts 的路径。 */
function allNodeFiles(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...allNodeFiles(p))
    else if (e === 'node.ts') out.push(p)
  }
  return out
}

console.log('=== 节点目录化（nodes/）===')

console.log('① 数量与 id 集合')
{
  /* 当前应有的 26 个（2026-10-12 删掉了 10 个只有定义、没有实现的节点，
   * 并把 5 个浏览器动作合成一个「浏览器」节点 —— 见 `src/nodes/index.ts` 的说明；
   * 2026-10-15 加了「跑另一份工作流」补上组合层能力；
   * 2026-10-17 加了「开始 / 结束」两个节点（用户 m00901：输入=开始节点、输出=结束节点）；
   * 2026-10-21 加了「并行」与「等待」两个节点（计划 Step 10 / Step 12））；
   * 2026-10-22 加了「通知」节点（用户定：只做一个提醒节点，判断交给条件判断节点）；
   * 2026-10-23 加了「AI 生成」节点（通用 agent 能力，提示词优化板块第二步要用）；
   * 2026-10-27 加了「Windows 通知与等待」（票 07 第一轮：把通知与等待合成一个节点，
   *   `flow.wait` **本轮保留不删** —— 老的挂起现场还要靠它恢复，
   *   第二轮到人工门通过之后才删）。
   * 2026-10-27 又删了六个（票 21）：`ecom.product.get` / `ecom.sku.update` /
   *   `ecom.order.pull` / `ecom.image.gen` / `ecom.copy.gen` / `data.map` ——
   *   都从未实现过（前四个命令体里 url 是空串、copy.gen 只能落到 summary、
   *   后两个派发报「没有这个内置节点」），且通用节点能覆盖
   *   （`sys.http` / `ai.agent` / `code.js`）。判定写在票 21 的评论里。
   *   **`flow.merge` 没删，补了实现** —— 引擎有两处报错文案把它指给用户。 */
  const EXPECTED = [
    'browser.act', 'browser.download',
    'code.js', 'code.python', 'code.shell',
    'sys.fs.read', 'sys.fs.write', 'sys.http',
    'flow.start', 'flow.end', 'flow.if', 'flow.loop', 'flow.merge', 'flow.workflow', 'flow.delay',
    'flow.parallel', 'flow.notify', 'flow.alert-wait', 'flow.wait',
    'ai.agent',
  ]
  const got = NODE_LIBRARY.map(d => d.id)
  check('节点总数是 20', got.length === 20, String(got.length))
  const missing = EXPECTED.filter(id => !got.includes(id))
  const extra = got.filter(id => !EXPECTED.includes(id))
  check('一个都没丢', missing.length === 0, missing.join(', '))
  check('没有多余/改名的', extra.length === 0, extra.join(', '))
  /* 顺序也要保住（它决定节点库里的显示顺序）。 */
  check('顺序与搬迁前一致', got.join(',') === EXPECTED.join(','), got.slice(0, 3).join(',') + '…')
}

console.log('')
console.log('② 目录结构符合约定')
{
  const files = allNodeFiles(NODES_DIR)
  check('node.ts 文件数 = 20', files.length === 20, String(files.length))
  /* 每个文件都应当是 `src/nodes/<分类>/<名>/node.ts`（相对 NODES_DIR 两段目录 + 文件名）。 */
  const badShape = files
    .map(p => relative(NODES_DIR, p).replace(/\\/g, '/'))
    .filter(rel => rel.split('/').length !== 3)
  check('每个都是 <分类>/<名>/node.ts（两级目录）', badShape.length === 0, badShape.join(', '))
  /* 目录名不许有点（点会让人以为是扩展名；id 里的点换成连字符）。 */
  const dotted = files
    .map(p => relative(NODES_DIR, p).replace(/\\/g, '/'))
    .filter(rel => rel.split('/').some(seg => seg.includes('.')))
    .filter(rel => !rel.endsWith('.ts'))
  check('目录名里没有点', dotted.length === 0, dotted.join(', '))
}

console.log('')
console.log('③ 定义文件不 import Node 内置模块（否则会打进客户端）')
{
  const files = allNodeFiles(NODES_DIR)
  const BAD = [/from ['"]node:/, /from ['"]fs['"]/, /from ['"]path['"]/, /require\(/]
  const offenders = []
  for (const p of files) {
    const s = readFileSync(p, 'utf8')
    /* 只查 import 行（正文里出现 `path` 这种词不算）。 */
    const importLines = s.split('\n').filter(l => l.trim().startsWith('import '))
    for (const line of importLines) {
      if (BAD.some(re => re.test(line))) offenders.push(relative(ROOT, p) + ' → ' + line.trim())
    }
  }
  check('没有 Node 内置模块的 import', offenders.length === 0, offenders.slice(0, 3).join(' | '))
  /* 每个文件都应当只 import 类型（`import type`）——定义是纯数据。 */
  const notTypeOnly = []
  for (const p of files) {
    const s = readFileSync(p, 'utf8')
    const importLines = s.split('\n').filter(l => l.trim().startsWith('import '))
    for (const line of importLines) {
      if (!line.includes('import type')) notTypeOnly.push(relative(ROOT, p) + ' → ' + line.trim())
    }
  }
  check('只 import 类型（定义是纯数据）', notTypeOnly.length === 0, notTypeOnly.slice(0, 3).join(' | '))
}

console.log('')
console.log('④ 汇总点只有一处（加节点要补的那一行）')
{
  const idx = readFileSync(join(NODES_DIR, 'index.ts'), 'utf8')
  /* 每个节点都应当在 index.ts 里被 import 一次。 */
  const imported = [...idx.matchAll(/^import \{ NODE as \w+ \} from '\.\/([^']+)\/node\.ts'/gm)].map(m => m[1])
  check('index.ts 里 import 了 20 个节点', imported.length === 20, String(imported.length))
  /* ⚠️ 数组是**一行多个**（`a, b, c,`），所以不能按行数数 ——
   * 第一版用 `/^\s{2}\w+,$/gm` 数行，得到 1（把整行当一项），白红一次。
   * 改成取数组体、按逗号切。 */
  const arrBody = /export const NODE_LIBRARY: readonly NodeDef\[\] = \[([\s\S]*?)\n\]/.exec(idx)?.[1] ?? ''
  const listedItems = arrBody.split(',').map(s => s.trim()).filter(s => s !== '')
  check('NODE_LIBRARY 数组里有 20 项', listedItems.length === 20, String(listedItems.length))
  /* 数组里引用的名字都要真的 import 过（防「改了 import 忘了改数组」）。 */
  const importedNames = new Set([...idx.matchAll(/^import \{ NODE as (\w+) \}/gm)].map(m => m[1]))
  const unknown = listedItems.filter(name => !importedNames.has(name))
  check('数组里没有未 import 的名字', unknown.length === 0, unknown.join(', '))
  /* 同一节点不许 import 两次（复制粘贴时容易发生）。 */
  const dup = imported.filter((x, i) => imported.indexOf(x) !== i)
  check('没有重复 import', dup.length === 0, dup.join(', '))
}

console.log('')
console.log(failed === 0 ? '结论：节点目录化全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
