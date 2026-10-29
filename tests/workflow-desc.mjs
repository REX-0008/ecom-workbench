/** 工作流列表的**说明字段**这条链（用户 2026-10-14 要求）。
 *
 * ## 为什么单独一个测试
 *
 * 「说明」要经过四处才到用户眼前：
 *   ① 存档文件里的 `description` 字段
 *   ② 宿主半列表路由把它读出来（`/api/ecom-workbench/workflows`）
 *   ③ 客户端列表组件把它显示出来
 *   ④ 生成器给每份工作流写上它
 *
 * 任何一处断了，用户看到的就是「没有说明」—— **而且不报错**。
 * 所以这里逐处验（前三处读源码/真跑路由，第四处读真存档）。
 *
 * ⚠️ 写成「查源码里有没有某串」是**假断言**（注释里也可能有那串）——
 * 所以本测试的判据尽量是**真跑一次路由**或**读真存档**。
 */
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PATROL_JOBS } from '../scripts/patrol/jobs.mjs'

const HOME = process.env.DSH_HOME ?? ''
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const WF_DIR = join(HOME, 'profiles', PROFILE, 'data', 'ecom-workbench', 'workflows')
/* ⚠️ **每次一个唯一目录**（`mkdtempSync`）。理由见 `tests/ingest-steps.mjs` 那段注释：
 * 写死的目录名会让「两个进程同时跑」与「上次残留」都变成假红（2026-10-20 修）。 */
const TMP = mkdtempSync(join(tmpdir(), 'ewb-desc-test-'))

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/* 目录已经由 `mkdtempSync` 建好了 —— 不要再删它。 */

/* ── ① 存档层：真存档里有说明，且 API 会把它读出来 ── */
console.log('=== ① 真存档里的说明（八份生成器产出的工作流）===')
{
  /* 八份 = 5 份巡查 + 清洗入库 + 两获取数工作流。
   *
   * ⚠️ **名字由生成器决定，别在这里写死**（2026-10-19 踩过）：
   * 这两份取数工作流被用户改过名（「抖音表单下载」→「取数-抖音电商罗盘」），
   * 这里写死旧名就红，而代码完全正常 —— 断言测的是「名字」不是「有没有说明」。
   * 现在从生成器里那两个 `new Builder('…', '')` 读出来，改名字不必改测试。 */
  const generatorNames = (file) => {
    const src = readFileSync(new URL('../scripts/browser/' + file, import.meta.url), 'utf8')
    const m = /new Builder\('([^']+)'/.exec(src)
    return m === null ? '' : m[1]
  }
  const generated = [
    ...PATROL_JOBS.map(j => j.name),
    '清洗入库',
    generatorNames('build-tmall.mjs'),
    generatorNames('build-douyin.mjs'),
  ].filter(n => n !== '')
  const missingFile = generated.filter(n => !existsSync(join(WF_DIR, n + '.json')))
  check('★ 八份生成的工作流都在（缺了就先去跑生成器）', missingFile.length === 0, missingFile.join(', '))

  let withDesc = 0
  for (const n of generated) {
    const p = join(WF_DIR, n + '.json')
    if (!existsSync(p)) continue
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    const d = doc.description
    const okDesc = typeof d === 'string' && d.trim() !== ''
    check('  ' + n + ' 有说明', okDesc, okDesc ? String(d).slice(0, 46) + '…' : '（无）')
    if (okDesc) withDesc += 1
  }
  check('★ 八份**全部**有说明（不是「大部分有」）', withDesc === generated.length, String(withDesc) + '/' + String(generated.length))

  /* ⚠️ 说明要**说人话**：不能只是把名字重复一遍。 */
  for (const n of generated) {
    const p = join(WF_DIR, n + '.json')
    if (!existsSync(p)) continue
    const d = String(JSON.parse(readFileSync(p, 'utf8')).description ?? '')
    check('  ' + n + ' 的说明比名字长（不是复述名字）', d.length > n.length, String(d.length) + ' vs ' + String(n.length))
  }
}

/* ── ② 宿主半路由：真读一遍，看它有没有把说明带出来 ── */
console.log('')
console.log('=== ② 宿主半的列表路由（读源码，找那两行真代码）===')
{
  const src = readFileSync('src/index.ts', 'utf8')
  /* ⚠️ 判据锚到**真代码**（`doc?.description`），不是「文件里有没有 description 这个词」
   * —— 我加注释时也写了这个词，宽松判据会被自己的注释救活。 */
  check('★ 路由里从存档取 description', src.includes('doc?.description'), '')
  check('★ 取不到时给空串（老存档不报错）',
    /description:\s*typeof doc\?\.description === 'string' \? doc\.description : ''/.test(src), '')
  /* 它要在 map 出来的对象里（也就是真的会进 JSON 响应）。 */
  const inRich = /description:\s*typeof doc\?\.description/.test(src)
  check('★ 那一行在 map 的返回对象里（真会进响应）', inRich, '')
}

/* ── ③ 类型层：WorkflowDoc 认这个字段 ── */
console.log('')
console.log('=== ③ 存档类型（WorkflowDoc）===')
{
  /* ⚠️ 2026-10-15：声明搬到了 `specs.ts`（画布也要用同一份翻译，
   * 而 `run-file.ts` 引 `store.ts` 用 `node:fs`，浏览器里引不了）。
   * `run-file.ts` 保留重导出，所以既有 import 点没变。 */
  const src = readFileSync('src/workflow/specs.ts', 'utf8')
  check('★ WorkflowDoc 声明了 description（可选）', /description\?\s*:\s*unknown/.test(src), '')
  check('★ 是**可选**的（老存档没有它也能读）', /description\?\s*:/.test(src), '')
  /* 重导出必须还在 —— 否则所有 `from './run-file.ts'` 的旧 import 点会一起断。 */
  const rf = readFileSync('src/workflow/run-file.ts', 'utf8')
  check('★ run-file.ts 仍重导出 WorkflowDoc（既有 import 点不断）',
    /export\s*\{[^}]*WorkflowDoc[^}]*\}\s*from\s*'\.\/specs\.ts'/.test(rf), '')
}

/* ── ④ 客户端：列表组件真的把它渲染出来 ── */
console.log('')
console.log('=== ④ 客户端列表组件 ===')
{
  const src = readFileSync('src/client/workbench/WorkflowList.tsx', 'utf8')
  check('★ Row 类型里有 description', /description\?\s*:\s*string/.test(src), '')
  /* ⚠️ 判据锚到 JSX 里引用 `r.description`（真渲染），不是「文件里有没有这个词」。 */
  check('★ JSX 里真的渲染了 r.description', src.includes('{r.description}'), '')
  /* 老存档（空串）**不该**留一行空白。 */
  check('★ 空说明时不渲染那一行（老存档不留白）',
    /r\.description !== ''/.test(src), '')
}

/* ── ⑤ 生成器：每份都写了说明（读源码找真的赋值）── */
console.log('')
console.log('=== ⑤ 生成器给每份写说明 ===')
{
  const files = [
    'scripts/build-patrol-workflows.mjs',
    'scripts/ingest/build.mjs',
    'scripts/browser/build-tmall.mjs',
    'scripts/browser/build-douyin.mjs',
    'scripts/combine/build.mjs',
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    /* ⚠️ 锚到 `doc.description =`（真赋值），不是「注释里提过」。 */
    check('  ' + f.split('/').pop() + ' 里有 doc.description 赋值',
      /doc\.description\s*=/.test(src), '')
  }
  /* 巡查那五个的说明由配置表驱动。 */
  const jm = readFileSync('scripts/patrol/jobs.mjs', 'utf8')
  check('★ 每份巡查的配置里都有 task（说明的素材）',
    PATROL_JOBS.every(j => typeof j.task === 'string' && j.task !== ''), '')
  check('  配置表里真写了 task 字段', jm.includes('task:'), '')
}

rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log(failed === 0 ? '结论：工作流「说明」这条链四层都通 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
