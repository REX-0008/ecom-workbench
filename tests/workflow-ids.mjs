/** 工作流的**稳定编号**与「按编号引用」的规则核验。
 *
 * ## 为什么单测这一层
 *
 * 用户 2026-10-19：「引用不要用名称匹配……引用用的应该是编号而不是名称。」
 *
 * 这条要求落地后，有几件事**错了不会崩、只会静默跑错份**：
 *   ① 编号按名字派生，而「改过名的老存档」文件名与 `name` 不一致 → 可能撞号；
 *   ② 撞号之后「按编号找」会取到目录里靠前的那一份 → 用户选 A、跑的是 B；
 *   ③ 引用迁移时「名字 → 编号」的表若让旧 `name` 抢占文件名 → 迁到副本上；
 *   ④ 编号找到了却又退回按名字找 → 改名那一刻引用就断（回到改之前）。
 *
 * 四件事都在这一个文件里钉住。**改判据前先想清楚它原来抓的是哪一条**。
 *
 * 七段：① 派生规则 ② 补编号 ③ 写盘定编号 ④ 编号唯一 ⑤ 按引用找
 * ⑥ 老引用迁移 ⑦ **磁盘层**（真实文件，沙箱临时目录）。
 *
 * 跑法：node --import <tsx> tests/workflow-ids.mjs
 */
import { deriveWorkflowId, readWorkflowId, ensureWorkflowId, syncDocIdentity, dedupeWorkflowIds, resolveWorkflowRef, migrateWorkflowRefs } from '../src/workflow/ids.ts'

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== 工作流编号（引用认编号，不认名字）===')

/* ── ① 派生规则本身 ─────────────────────────────────────────────── */
console.log('')
console.log('① 派生规则稳定（同一名字任何机器都得同一个编号）')
{
  /* 写死几个期望值：换个平台 / 换个 Node 版本都不该变。
   * 若这条红了，说明派生规则被改了 —— 那会让**所有既有存档的编号**失效，慎改。 */
  check('同一名字两次派生相同', deriveWorkflowId('天猫取数') === deriveWorkflowId('天猫取数'))
  check('不同名字派生不同', deriveWorkflowId('天猫取数') !== deriveWorkflowId('抖音表单下载'))
  check('带前缀（与节点 id / 组 id 区分得开）', deriveWorkflowId('x').startsWith('wf-'), deriveWorkflowId('x'))
  check('中文名不抛错（按码元扫，不按字节）', typeof deriveWorkflowId('巡查-抖音-千川余额') === 'string')
  /* 空名字也要有值（老存档可能连 name 都没有，靠文件名顶）。 */
  check('空名字也能派生（不返回空串）', deriveWorkflowId('') !== '', deriveWorkflowId(''))
}

/* ── ② 读 / 补编号 ─────────────────────────────────────────────── */
console.log('')
console.log('② 老存档补编号（读到就补，不静默跳过）')
{
  check('没有 id 的老存档 → 派生出编号', readWorkflowId(ensureWorkflowId({ name: '天猫取数' }, '天猫取数').doc) !== '')
  check('派生用的是**存档里的 name**（生成器按它算，才对得上）',
    ensureWorkflowId({ name: '天猫取数' }, '取数-天猫生意参谋').id === deriveWorkflowId('天猫取数'))
  check('没有 name 时退回文件名', ensureWorkflowId({}, '某个文件名').id === deriveWorkflowId('某个文件名'))
  /* ★ 已经有编号的**一个字节都不动** —— 「永不变」是引用能跟着走的前提。 */
  const keep = ensureWorkflowId({ id: 'wf-keep', name: '天猫取数' }, '别的名字')
  check('★ 已有编号原样保留（改名不换编号）', keep.id === 'wf-keep' && keep.idAdded === false, JSON.stringify(keep))
  check('存档不是对象时给空编号（存档不可信）', ensureWorkflowId(null, 'x').id === '')
}

/* ── ③ 写盘时定编号与名字 ──────────────────────────────────────── */
console.log('')
console.log('③ 写盘时：沿用编号 + 名字同步成文件名')
{
  const kept = syncDocIdentity({ id: 'wf-keep', name: '旧名' }, '新名')
  check('★ 沿用原编号（改名的实现是「新名存一份、删旧的」）', kept.id === 'wf-keep', kept.id)
  check('文件里的 name 同步成文件名', kept.doc.name === '新名', String(kept.doc.name))
  const fresh = syncDocIdentity({}, '随手一份')
  check('没有编号的按文件名派生一个', fresh.id === deriveWorkflowId('随手一份'), fresh.id)
  check('派生的那个也写进了存档', fresh.doc.id === fresh.id)
}

/* ── ④ 编号必须唯一（实测撞过）─────────────────────────────────── */
console.log('')
console.log('④ 编号唯一：撞号时保留「文件名 == name」那份')
{
  /* 实测的形状：改名副本的 `name` 还是旧名字 → 与正本算出同一个编号。 */
  const dup = dedupeWorkflowIds([
    { name: '取数-天猫生意参谋', docName: '天猫取数', id: deriveWorkflowId('天猫取数') },
    { name: '天猫取数', docName: '天猫取数', id: deriveWorkflowId('天猫取数') },
  ])
  check('★ 两个不再撞号', dup[0] !== dup[1], JSON.stringify(dup))
  check('★ 正本（文件名 == name）保留原编号',
    dup[1] === deriveWorkflowId('天猫取数'), JSON.stringify(dup))
  check('★ 副本改成按**文件名**派生的编号',
    dup[0] === deriveWorkflowId('取数-天猫生意参谋'), JSON.stringify(dup))

  /* 三份撞一起、且新编号也被占 → 加后缀，不能重复。 */
  const three = dedupeWorkflowIds([
    { name: 'a', docName: 'x', id: deriveWorkflowId('x') },
    { name: 'b', docName: 'x', id: deriveWorkflowId('x') },
    { name: 'c', docName: 'x', id: deriveWorkflowId('x') },
  ])
  check('三份撞一起也互不相同', new Set(three).size === 3, JSON.stringify(three))
  /* 没撞的不动（这是「只补该补的」的保证）。 */
  const clean = dedupeWorkflowIds([
    { name: 'a', docName: 'a', id: 'wf-a' },
    { name: 'b', docName: 'b', id: 'wf-b' },
  ])
  check('没撞的一个都不改', clean[0] === 'wf-a' && clean[1] === 'wf-b', JSON.stringify(clean))
}

/* ── ⑤ 按引用找（先编号、后名字）────────────────────────────────── */
console.log('')
console.log('⑤ 找目标：编号优先，名字只做老存档兼容')
{
  const targets = [
    { name: '天猫取数', id: 'wf-real' },
    { name: '别的', id: 'wf-other' },
  ]
  check('按编号找到', resolveWorkflowRef({ id: 'wf-real' }, targets)?.target.name === '天猫取数')
  check('编号找不到时按名字找到（老写法）', resolveWorkflowRef({ name: '别的' }, targets)?.target.id === 'wf-other')
  check('★ 用了名字要标 legacy（调用方据此提示迁移）',
    resolveWorkflowRef({ name: '别的' }, targets)?.legacy === true)
  check('用编号不算 legacy', resolveWorkflowRef({ id: 'wf-real' }, targets)?.legacy === false)
  /* ★ 两者都填、且名字指向别的一份 → **以编号为准**。
   * 若反过来，改名的那个 bug 会以另一种形式回来。 */
  check('★ 编号与名字冲突时以编号为准',
    resolveWorkflowRef({ id: 'wf-real', name: '别的' }, targets)?.target.name === '天猫取数')
  check('都没命中给 null', resolveWorkflowRef({ id: 'wf-nope', name: '也没有' }, targets) === null)
}

/* ── ⑥ 老存档的引用迁移 ────────────────────────────────────────── */
console.log('')
console.log('⑥ 老引用（存名字）迁成编号')
{
  const doc = {
    version: 1,
    nodes: [
      { id: 'n1', defId: 'flow.workflow', params: { name: '天猫取数', inputs: [] } },
      { id: 'n2', defId: 'code.js', params: { code: 'x' } },
    ],
  }
  const idByName = new Map([['天猫取数', 'wf-tm']])
  const r = migrateWorkflowRefs(doc, idByName)
  const n1 = r.doc.nodes[0]
  check('迁了一条', r.migrated === 1, String(r.migrated))
  check('★ 参数里写进了编号', n1.params.workflowId === 'wf-tm', JSON.stringify(n1.params))
  check('★ 旧的 name 被删掉（它已是死数据）', n1.params.name === undefined, JSON.stringify(n1.params))
  check('别的参数原样保留', JSON.stringify(n1.params.inputs) === '[]', JSON.stringify(n1.params))
  check('别的节点一个字节不动', JSON.stringify(r.doc.nodes[1]) === JSON.stringify(doc.nodes[1]))
  /* 原对象不许被改（纯函数的纪律）。 */
  check('原存档没被就地改（返回新对象）', doc.nodes[0].params.workflowId === undefined)

  /* 已经有编号的节点：不动（那是用户的选择，重写它等于抹掉）。
   * ⚠️ **这一条必须让 `name` 也在 idByName 里**（第一版没放，于是它永远绿 ——
   * 突变测试验证过：把「已编号就跳过」那行删掉，它照样通过）。
   * 那种节点是真实存在过的形状：迁移前手改过、或半迁过的存档。 */
  const already = { nodes: [{ id: 'n1', defId: 'flow.workflow', params: { workflowId: 'wf-keep', name: '天猫取数' } }] }
  const r2 = migrateWorkflowRefs(already, idByName)
  check('★ 已编号的节点不重写（哪怕 name 也能查到）',
    r2.migrated === 0 && already.nodes[0].params.workflowId === 'wf-keep', String(r2.migrated))

  /* 名字找不到对应的工作流 → 不动（不清空，让人能看见它指过谁）。 */
  const miss = { nodes: [{ id: 'n1', defId: 'flow.workflow', params: { name: '没有这份' } }] }
  const r3 = migrateWorkflowRefs(miss, idByName)
  check('找不到目标时不糟蹋原值', r3.migrated === 0 && miss.nodes[0].params.name === '没有这份')

  /* 空参数（新加的节点还没选）→ 不动。 */
  const empty = { nodes: [{ id: 'n1', defId: 'flow.workflow', params: { workflowId: '' } }] }
  check('空参数不报错也不迁', migrateWorkflowRefs(empty, idByName).migrated === 0)
}

/* ── ⑦ 磁盘层：撞号的真实形状（沙箱，不碰真实数据）──────────────── */
console.log('')
console.log('⑦ 磁盘层：改过名的副本不能把老引用抢走')
{
  /* 这一段用**真实文件**复现我实测撞到的形状：
   *   · 天猫取数.json        name=天猫取数   （正本）
   *   · 取数-天猫生意参谋.json  name=天猫取数   （改名副本，name 没同步）
   *   · 一键下载.json        节点的 params.name = 天猫取数（老引用）
   *
   * 两个陷阱都在这里：
   *   ① 两份算出同一个编号 → 按编号找会取到靠前那份；
   *   ② 老引用「天猫取数」若被 `name` 先登记，就迁到**副本**上（实测就这么错的）。
   * 正确结果：老引用指向**正本**（文件名与名字逐字相同的那份）。
   */
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const HOME = mkdtempSync(join(tmpdir(), 'ewb-ids-disk-'))
  process.env.EWB_TEST_HOME = HOME
  mkdirSync(join(HOME, 'workflows'), { recursive: true })
  const DIR = join(HOME, 'workflows')
  const put = (file, doc) => writeFileSync(join(DIR, file + '.json'), JSON.stringify(doc), 'utf8')
  const bare = (name, nodes = []) => ({ version: 1, name, nodes, edges: [] })

  put('天猫取数', bare('天猫取数'))
  put('取数-天猫生意参谋', bare('天猫取数'))
  put('一键下载', bare('一键下载', [
    { id: 'n1', defId: 'flow.workflow', params: { name: '天猫取数' } },
  ]))

  const { listWorkflows, loadWorkflowByRef } = await import('../src/workflow/store.ts')
  const items = await listWorkflows()
  const byName = Object.fromEntries(items.map(x => [x.name, x]))

  check('三份都读到了', items.length === 3, String(items.length))
  check('★ 编号互不相同（撞号会跑错份）',
    byName['天猫取数'].id !== byName['取数-天猫生意参谋'].id,
    byName['天猫取数'].id + ' / ' + byName['取数-天猫生意参谋'].id)
  check('★ 正本保留按名字派生的编号',
    byName['天猫取数'].id === deriveWorkflowId('天猫取数'), byName['天猫取数'].id)

  const migrated = byName['一键下载'].doc.nodes[0].params
  check('★ 老引用被迁成了编号', typeof migrated.workflowId === 'string' && migrated.workflowId !== '', JSON.stringify(migrated))
  check('★ 而且指向**正本**（不是改过名的副本）',
    migrated.workflowId === byName['天猫取数'].id,
    JSON.stringify({ ref: migrated.workflowId, 正本: byName['天猫取数'].id, 副本: byName['取数-天猫生意参谋'].id }))
  check('旧的 name 已删掉（不留死数据）', migrated.name === undefined, JSON.stringify(migrated))

  /* 按那个编号真的读得到正本。 */
  const got = await loadWorkflowByRef({ id: migrated.workflowId })
  check('按编号读到的就是「天猫取数」', got?.name === '天猫取数', String(got?.name))

  /* 幂等：再读一次一个字节都不改写（否则列表每刷一次就写盘）。 */
  const { readdirSync, readFileSync } = await import('node:fs')
  const snap = () => readdirSync(DIR).sort().map(f => readFileSync(join(DIR, f), 'utf8')).join('|')
  const before = snap()
  await listWorkflows()
  check('★ 第二次读不再改写任何文件（幂等）', snap() === before)

  rmSync(HOME, { recursive: true, force: true })
}

console.log('')
console.log(failed === 0 ? '结论：编号与引用的规则全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
