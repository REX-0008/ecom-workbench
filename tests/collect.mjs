/** 收藏（skill 备忘 / 目录配置 / 搬移）的逻辑测试。
 *
 * ⚠️ **全程在沙箱里跑，绝不碰真实 skill 目录**（红线）。
 *   - `EWB_TEST_HOME` → 收藏数据与备注都落在临时目录；
 *   - `EWB_TEST_SKILLS` → 「已安装」的默认根也指向临时目录。
 *
 * 重点覆盖**安全边界**（搬移会真的动文件）：
 *   名字越界、目标同名不覆盖、源不存在、备份先生成。
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sandbox = await mkdtemp(join(tmpdir(), 'ewb-collect-'))
process.env.EWB_TEST_HOME = join(sandbox, 'data')
process.env.EWB_TEST_SKILLS = join(sandbox, 'skills')
delete process.env.DSH_HOME // 确保不会退回真实数据根

const {
  collectRoot, sideRoots, rootInfos,
  isSafeSkillName, parseSkillFrontmatter, scanSkills, readNotes, writeNotes,
  readSkillBody, moveSkill,
} = await import('../src/collect/store.ts')

/** 已安装侧的默认根（沙箱内）。 */
const installedDir = () => sideRoots('installed')[0]
/** 收藏侧的默认根（沙箱内）。 */
const collectedDir = () => sideRoots('collected')[0]

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

/** 造一个 skill 目录（含 SKILL.md）。 */
async function makeSkill(root, name, description = '测试用') {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n---\n\n正文内容 ${name}\n`, 'utf8')
  return dir
}

console.log('=== 收藏（skill / 备注 / 搬移）===')
console.log('沙箱:', sandbox)
console.log('')

console.log('① 路径解析（沙箱必须生效，否则会动真实 skill 目录）')
{
  check('收藏根落在沙箱内', collectRoot().startsWith(sandbox), collectRoot())
  check('已安装根落在沙箱内', installedDir().startsWith(sandbox), installedDir())
  check('收藏 skill 目录在收藏根下', collectedDir().startsWith(collectRoot()))
}

console.log('')
console.log('② 名字安全校验（这是安全边界，搬移会拼路径）')
{
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    check('拒绝 ' + JSON.stringify(bad), isSafeSkillName(bad) === false)
  }
  for (const good of ['code-review', 'my_skill', 'skill.v2', '中文名']) {
    check('接受 ' + JSON.stringify(good), isSafeSkillName(good) === true)
  }
}

console.log('')
console.log('③ frontmatter 解析')
{
  const fm = parseSkillFrontmatter('---\nname: code-review\ndescription: "代码审查。从固定点审查变更"\n---\n\n正文')
  check('取到 name', fm.name === 'code-review', String(fm.name))
  check('取到 description（去掉引号）', fm.description === '代码审查。从固定点审查变更', String(fm.description))
  check('没有 frontmatter 时不报错', Object.keys(parseSkillFrontmatter('直接是正文')).length === 0)
}

console.log('')
console.log('③b 调用策略（agent 可用 / 仅用户）—— 用户要求的绿灯橙灯依据')
{
  /* 依据 dsh 的 parseInvocationPolicy（skill-filesystem/src/index.ts:1000）：
   *   disable-model-invocation: true → 模型看不到（仅用户）
   *   user-invocable: false        → 用户 /名字 触发不了
   * 没写 = 各自允许。 */
  const on = parseSkillFrontmatter('---\nname: x\ndescription: d\ndisable-model-invocation: true\n---\n')
  check('disable-model-invocation: true 读到', on.disableModelInvocation === true)
  const off = parseSkillFrontmatter('---\nname: x\ndescription: d\ndisable-model-invocation: false\n---\n')
  check('false 读到 false', off.disableModelInvocation === false)
  check('没写时为 undefined（= 默认允许）',
    parseSkillFrontmatter('---\nname: x\ndescription: d\n---\n').disableModelInvocation === undefined)
  /* dsh 接受这几种拼法（大小写不敏感）。 */
  for (const v of ['yes', 'on', '1', 'TRUE', 'Yes']) {
    check('接受 ' + v + ' 当作 true',
      parseSkillFrontmatter('---\nname: x\ndescription: d\ndisable-model-invocation: ' + v + '\n---\n').disableModelInvocation === true)
  }
  for (const v of ['no', 'off', '0', 'FALSE']) {
    check('接受 ' + v + ' 当作 false',
      parseSkillFrontmatter('---\nname: x\ndescription: d\ndisable-model-invocation: ' + v + '\n---\n').disableModelInvocation === false)
  }
  check('认不出的写法当没写（不误判成 true）',
    parseSkillFrontmatter('---\nname: x\ndescription: d\ndisable-model-invocation: maybe\n---\n').disableModelInvocation === undefined)
  const u = parseSkillFrontmatter('---\nname: x\ndescription: d\nuser-invocable: false\n---\n')
  check('user-invocable: false 读到', u.userInvocable === false)
}

console.log('')
console.log('④ 扫描两侧')
{
  await makeSkill(installedDir(), 'alpha', '已装的')
  await makeSkill(installedDir(), 'beta')
  await makeSkill(collectedDir(), 'gamma', '收藏的')
  /* 干扰项：没有 SKILL.md 的目录不算 skill；隐藏目录要跳过。 */
  await mkdir(join(installedDir(), 'not-a-skill'), { recursive: true })
  await mkdir(join(installedDir(), '.hidden'), { recursive: true })

  const list = await scanSkills()
  const names = list.map(s => s.name)
  check('扫到 3 个（排除无 SKILL.md 与隐藏目录）', names.length === 3, names.join(','))
  check('alpha 在已安装侧', list.find(s => s.name === 'alpha')?.where === 'installed')
  check('gamma 在收藏侧', list.find(s => s.name === 'gamma')?.where === 'collected')
  check('读到了 description', list.find(s => s.name === 'alpha')?.description === '已装的')
  check('已装段排在收藏段前', names.indexOf('alpha') < names.indexOf('gamma'))
}

console.log('')
console.log('④b 扫描结果要带上「agent 可用 / 仅用户」（界面亮灯的数据来源）')
{
  /* 造一个「仅用户」的和一个「仅 agent」的，验证扫描把策略带出来了。 */
  const userOnly = join(installedDir(), 'user-only')
  await mkdir(userOnly, { recursive: true })
  await writeFile(join(userOnly, 'SKILL.md'), '---\nname: user-only\ndescription: 只能用户触发\ndisable-model-invocation: true\n---\n', 'utf8')
  const agentOnly = join(installedDir(), 'agent-only')
  await mkdir(agentOnly, { recursive: true })
  await writeFile(join(agentOnly, 'SKILL.md'), '---\nname: agent-only\ndescription: 只能 agent 触发\nuser-invocable: false\n---\n', 'utf8')

  const list = await scanSkills()
  const uo = list.find(s => s.name === 'user-only')
  const ao = list.find(s => s.name === 'agent-only')
  const al = list.find(s => s.name === 'alpha')
  check('没写策略的 → agent 可用（默认允许）', al?.agentUsable === true)
  check('没写策略的 → 用户也能用', al?.userUsable === true)
  check('disable-model-invocation: true → agent **用不了**（界面亮橙灯）', uo?.agentUsable === false,
    '实际 agentUsable=' + String(uo?.agentUsable))
  check('它仍然用户可用', uo?.userUsable === true)
  check('user-invocable: false → 用户用不了', ao?.userUsable === false)
  check('它仍然 agent 可用（界面亮绿灯）', ao?.agentUsable === true)
  /* 清掉这两个，别影响后面的搬移测试（它们不是预期存在的条目）。 */
  await rm(userOnly, { recursive: true, force: true })
  await rm(agentOnly, { recursive: true, force: true })
}

console.log('')
console.log('⑤ 备注读写')
{
  const empty = await readNotes()
  check('没文件时给空白表', Object.keys(empty.skills).length === 0 && empty.plugins.length === 0)
  await writeNotes({ skills: { alpha: { note: '记得看', repo: 'https://github.com/x/y' } }, plugins: [{ name: 'p1' }], projects: [] })
  const back = await readNotes()
  check('备注能落盘并读回', back.skills.alpha?.note === '记得看')
  check('地址也存住了', back.skills.alpha?.repo === 'https://github.com/x/y')
  check('插件清单存住了', back.plugins[0]?.name === 'p1')
}

console.log('')
console.log('⑥ 目录配置（两侧都可配多根）')
{
  const extra = join(sandbox, 'extra-collect')
  await makeSkill(extra, 'delta', '额外根里的')
  await writeNotes({ roots: { collected: [extra] }, skills: {}, plugins: [], projects: [] })
  const list = await scanSkills()
  check('额外根被扫到', list.some(s => s.name === 'delta'), list.map(s => s.name).join(','))
  check('配了根就不再并用默认根', !list.some(s => s.name === 'gamma'))
  /* 注意：`sideRoots` 是**纯函数** —— 配置靠参数传入，它不自己读盘。
   * （路由与 scanSkills 都会先把 notes 读好再传进来。）
   * 所以这里要显式把读到的备注传进去，否则它按默认根算。 */
  const roots = sideRoots('collected', { notes: await readNotes() })
  check('sideRoots 返回配的根', roots.length === 1 && roots[0] === extra, roots.join(','))
  /* 清掉配置，恢复默认，后面还要用。 */
  await writeNotes({ skills: {}, plugins: [], projects: [] })
}

console.log('')
console.log('⑦ 读正文（预览用）')
{
  const got = await readSkillBody('alpha')
  check('读到正文', got !== null && got.text.includes('正文内容 alpha'))
  check('标出在哪一侧', got?.where === 'installed')
  check('越界名字读不到', (await readSkillBody('../secret')) === null)
  check('不存在的名字返回 null', (await readSkillBody('nope')) === null)
}

console.log('')
console.log('⑧ 搬移（已安装 → 收藏）')
{
  const res = await moveSkill('alpha', 'collect')
  check('搬移成功', res.ok === true, res.error ?? '')
  check('源已消失', await stat(join(installedDir(), 'alpha')).then(() => false).catch(() => true))
  check('到了收藏侧', await stat(join(collectedDir(), 'alpha')).then(() => true).catch(() => false))
  check('生成了备份（用户要求先备份）', res.backup !== undefined && await stat(res.backup).then(() => true).catch(() => false))
  const list = await scanSkills()
  check('列表里它的位置变了', list.find(s => s.name === 'alpha')?.where === 'collected')
  const body = await readSkillBody('alpha')
  check('搬完还能读正文', body !== null && body.text.includes('正文内容 alpha'))
}

console.log('')
console.log('⑨ 搬移的边界（都是拒绝，不能损坏数据）')
{
  /* 目标同名：先在已装侧造一个与收藏侧同名的。 */
  await writeNotes({ skills: {}, plugins: [], projects: [] })
  await makeSkill(installedDir(), 'dup')
  await makeSkill(collectedDir(), 'dup')
  const r1 = await moveSkill('dup', 'collect')
  check('目标同名时拒绝', r1.ok === false && r1.error.includes('同名'), r1.error ?? '')
  check('拒绝后源还在', await stat(join(installedDir(), 'dup')).then(() => true).catch(() => false))

  const r2 = await moveSkill('不存在的skill', 'collect')
  check('源不存在时拒绝', r2.ok === false, r2.error ?? '')

  const r3 = await moveSkill('../escape', 'collect')
  check('越界名字被拒', r3.ok === false, r3.error ?? '')

  const r4 = await moveSkill('beta', 'install')
  check('从收藏侧搬回也拒绝（它不在收藏侧）', r4.ok === false, r4.error ?? '')
}

console.log('')
console.log('⑩ 搬移回来（收藏 → 已安装）')
{
  const res = await moveSkill('alpha', 'install')
  check('搬回成功', res.ok === true, res.error ?? '')
  check('回到已安装侧', await stat(join(installedDir(), 'alpha')).then(() => true).catch(() => false))
  check('收藏侧已清空', await stat(join(collectedDir(), 'alpha')).then(() => false).catch(() => true))
}

console.log('')
console.log('⑪ 备份数量有上限（防无限增长）')
{
  /* 反复搬同一个 skill，看备份数是否被压在上限内。 */
  for (let i = 0; i < 8; i++) {
    await moveSkill('alpha', i % 2 === 0 ? 'collect' : 'install')
  }
  const backups = await readdir(join(collectRoot(), '.backup')).catch(() => [])
  check('备份被清理到上限内', backups.length <= 20, '实际 ' + backups.length + ' 份')
}

console.log('')
console.log('⑫ 设置界面要用的「根目录明细」')
{
  /* 界面要能分开说「目录不存在」与「目录在但扫到 0 个」—— 两种毛病两种修法。 */
  const missing = join(sandbox, '根本不存在这个目录')
  await writeNotes({ roots: { collected: [missing] }, skills: {}, plugins: [], projects: [] })
  const bad = await rootInfos('collected', { notes: await readNotes() })
  check('不存在的目录被标出 exists=false', bad[0]?.exists === false, JSON.stringify(bad[0]))
  check('不存在的目录 count 为 0', bad[0]?.count === 0)

  /* 正常存在的目录要报出扫到几个。 */
  const okDir = join(sandbox, 'ok-roots')
  await makeSkill(okDir, 'r1')
  await makeSkill(okDir, 'r2')
  await writeNotes({ roots: { collected: [okDir] }, skills: {}, plugins: [], projects: [] })
  const good = await rootInfos('collected', { notes: await readNotes() })
  check('存在的目录标 exists=true', good[0]?.exists === true)
  check('报出扫到几个（应为 2）', good[0]?.count === 2, '实际 ' + String(good[0]?.count))
  check('默认根被标 isDefault（用户要知道哪个不该删）',
    (await rootInfos('installed', { notes: await readNotes() }))[0]?.isDefault === true)
  /* 清掉配置，避免影响收尾。 */
  await writeNotes({ skills: {}, plugins: [], projects: [] })
}

/* ── ⑨ 任务记录要**两个目录**一起读（2026-10-23 加）─────────────────────
 *
 * 用户原话：「所有有产出的都看得到，巡查本质上也是有产出的。」
 *
 * 但产出落在两个地方：采集类进 `collect/<工作流名>/<时间戳>.json`，
 * **巡查类进 `patrol/<工作流名>-<时间戳>.json`**。改前 `readCollectRecords`
 * 只扫 `collect/`，于是「任务记录」漏掉了全部巡查产出。
 *
 * ## 这一段的重点不是「能读到」，是「不会读错」
 *
 * `patrol/` 里住着**两种形状**的文件：
 *
 * | 文件 | 形状 | 谁写的 |
 * | --- | --- | --- |
 * | `patrol-tm-shop.json` | 有 `blocks`、**没有 `outputs`** | 巡查工作流自己的写文件节点，固定名、每次覆盖 |
 * | `巡查-xxx-<时间戳>.json` | 有 `outputs` | `archiveOutputs` 归档的，留历史 |
 *
 * 前一种混进列表会出现一堆重复条目（固定名，每次覆盖同一个文件）。
 * 所以这里**故意造一份旧格式**，断言它**不出现** —— 这是本段最要紧的一条。
 */
{
  const { collectRecordsDir, patrolDir, readCollectRecords } = await import('../src/schedule/records.ts')

  /* 空目录起步（前面的段落可能留下了东西）。 */
  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })

  /* ① 采集侧：一份归档（带 outputs）。 */
  const collectSub = join(collectRecordsDir(), '全部下载')
  await mkdir(collectSub, { recursive: true })
  await writeFile(join(collectSub, '20261023T0930.json'), JSON.stringify({
    workflow: '全部下载', runId: 'r1', ok: true,
    startedAt: 1000, endedAt: 1750000000000,
    outputs: { 天猫数据: 'tang.csv', 入库条数: 1284 },
  }), 'utf8')

  /* ② 巡查侧：一份归档（带 outputs，文件名带时间戳）。 */
  const pdir = patrolDir()
  await mkdir(pdir, { recursive: true })
  await writeFile(join(pdir, '巡查-天猫竞品-20261023T1000.json'), JSON.stringify({
    workflow: '巡查-天猫竞品', runId: 'r2', ok: true,
    startedAt: 2000, endedAt: 1760000000000,
    outputs: { 判档: { blocks: [{ id: 'b1', state: 'warn', title: '库存' }] } },
  }), 'utf8')

  /* ③ 巡查侧：**旧格式**（固定名、有 blocks、没有 outputs）—— 不该进列表。 */
  await writeFile(join(pdir, 'patrol-tm-shop.json'), JSON.stringify({
    shop: '天猫', blocks: [{ id: 'b1', state: 'ok', title: '库存' }],
  }), 'utf8')

  /* ④ 一个坏档（不是 JSON）—— 应当被跳过，不影响其它。 */
  await writeFile(join(pdir, 'broken.json'), '{ 这不是 JSON', 'utf8')

  const all = await readCollectRecords()

  console.log('')
  console.log('=== ⑨ 任务记录同时读 collect/ 与 patrol/ ===')
  check('★ 两个目录的归档都在列表里（共 2 条）', all.length === 2,
    '实际 ' + String(all.length) + ' 条：' + all.map(r => r.workflow + '/' + r.file).join('、'))

  const fromCollect = all.filter(r => r.from === 'collect')
  const fromPatrol = all.filter(r => r.from === 'patrol')
  check('★ 有一条来自 collect/', fromCollect.length === 1, fromCollect.map(r => r.file).join(','))
  check('★ 有一条来自 patrol/', fromPatrol.length === 1, fromPatrol.map(r => r.file).join(','))

  /* ★★ 这一条是本段核心：旧格式（没有 outputs）**不许**出现。 */
  const hasOldFormat = all.some(r => r.file === 'patrol-tm-shop.json')
  check('★★ patrol/ 里没有 outputs 的旧格式文件不出现', !hasOldFormat,
    hasOldFormat ? '混进来了（固定名那份）' : '')
  const hasBroken = all.some(r => r.file === 'broken.json')
  check('坏档被跳过、不让整张列表打不开', !hasBroken, hasBroken ? '坏档混进来了' : '')

  /* 字段齐不齐：两边都要能取到 workflow / at / ok / outputs。 */
  const c1 = fromCollect[0]
  check('collect/ 那侧 workflow 是目录名', c1?.workflow === '全部下载', String(c1?.workflow))
  check('collect/ 那侧 at 取了 endedAt', c1?.at === 1750000000000, String(c1?.at))
  check('collect/ 那侧 ok 取到了', c1?.ok === true)
  check('collect/ 那侧 outputs 取到了', Object.keys(c1?.outputs ?? {}).length === 2,
    Object.keys(c1?.outputs ?? {}).join(','))

  const p1 = fromPatrol[0]
  /* ⚠️ 这一条钉住「不要把时间戳当工作流名切出来」：
   * 名字从**文件内容**的 `workflow` 键取，不是从文件名切。 */
  check('★ patrol/ 那侧 workflow 取自文件内容（不是切时间戳）',
    p1?.workflow === '巡查-天猫竞品', String(p1?.workflow))
  check('patrol/ 那侧 at 取了 endedAt', p1?.at === 1760000000000, String(p1?.at))
  check('patrol/ 那侧 outputs 取到了', p1 !== undefined && Object.keys(p1.outputs).length === 1,
    Object.keys(p1?.outputs ?? {}).join(','))

  /* ★ 跨两个目录**统一按时间倒序**（巡查那条 endedAt 更大，应当排在前面）。 */
  check('★ 跨两个目录按时间倒序（巡查那条在前）',
    all[0]?.from === 'patrol' && all[1]?.from === 'collect',
    all.map(r => r.from + '/' + String(r.at)).join(' > '))

  /* 反面：按名字过滤时，`patrol/` 那侧也要能过滤到（只过滤 collect/ 会漏掉它）。 */
  const onlyPatrol = await readCollectRecords({ workflow: '巡查-天猫竞品' })
  check('★ 按名字只看一份巡查时能取到它的记录',
    onlyPatrol.length === 1 && onlyPatrol[0]?.from === 'patrol',
    String(onlyPatrol.length) + ' 条')
  const onlyCollect = await readCollectRecords({ workflow: '全部下载' })
  check('按名字只看一份采集时不会带上巡查的记录',
    onlyCollect.length === 1 && onlyCollect[0]?.from === 'collect',
    String(onlyCollect.length) + ' 条')

  /* 清场。 */
  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })
}

/* ── ⑩ 失败也要留一份记录，并写明原因（契约 AD，2026-10-23）──────────
 *
 * ## 这一段守的是什么
 *
 * 用户原话：「加：任务记录里也写明失败原因」（选项说明：存档留底，
 * 日后翻记录时不用再回运行历史找）。
 *
 * 两个坑：
 *   ① 失败时 `outputs` 常常是空的（没跑到结束节点）。旧规则「没产出就不写」
 *      会把整条记录挡掉 —— 实测过：某份工作流 7 次运行、5 次失败，
 *      `collect/` 里一条都没有。所以「加字段」之前得先让失败**有记录**。
 *   ② 加字段容易加出一个恒真的断言。这里每一条都对着**真实落盘文件**验。
 *
 * ## 四档判据（与 `archiveOutputs` 的分档表一一对应）
 *
 * | 情况 | 写不写 | 本条断言 |
 * | --- | --- | --- |
 * | 成功 + 有产出 | 写 | ① |
 * | 成功 + 没产出 | 不写 | ② |
 * | 失败 + 有产出 | 写 | ③ |
 * | 失败 + 没产出 | 写 | ④（本次核心） |
 */
{
  const { archiveOutputs, collectRecordsDir, patrolDir, readCollectRecords } =
    await import('../src/schedule/records.ts')
  const { readFile: readF } = await import('node:fs/promises')

  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })

  const base = { workflowName: '失败留底测试', startedAt: 1000, endedAt: 2000, via: 'list' }

  /* ① 成功 + 有产出 → 写。 */
  const r1 = await archiveOutputs({ ...base, ok: true, runId: 'ad-1', declaredOutputs: { a: 1 } })
  check('★ 成功且有产出 → 写记录', r1.path !== null, r1.reason)

  /* ② 成功 + 没产出 → 不写（旧规则，不许被本次改动带坏）。 */
  const r2 = await archiveOutputs({ ...base, ok: true, runId: 'ad-2' })
  check('★★ 成功但没产出 → 仍然不写（旧规则不变）', r2.path === null, r2.reason)

  /* ③ 失败 + 有产出 → 写。 */
  const r3 = await archiveOutputs({
    ...base, ok: false, runId: 'ad-3', declaredOutputs: { a: 2 }, error: '仓库登录失效',
  })
  check('★ 失败且有产出 → 写记录', r3.path !== null, r3.reason)

  /* ④ ★★ 本次核心：失败 + **没产出** → 也要写，并带上真实原因。 */
  const r4 = await archiveOutputs({
    ...base, ok: false, runId: 'ad-4', error: '天猫后台登录已过期，第 3 步中断',
  })
  check('★★ 失败且没产出 → 也写一份（以前整条消失）', r4.path !== null, r4.reason)

  /* 直接读落盘文件，确认 `error` 真的写进去了（不是只在内存里）。
   * ⚠️ `path` 可能是 null（那条规则被改坏时）—— 必须优雅失败，
   * 不能让 readFile(null) 抛出去把整个测试打成崩溃（第一版就是这样，看着像框架错）。 */
  const raw4 = r4.path === null ? null : JSON.parse(await readF(r4.path, 'utf8'))
  check('★★ 落盘文件里有 error 字段', typeof raw4?.error === 'string' && raw4.error !== '',
    JSON.stringify(raw4?.error ?? null))
  check('★★ error 是真实原因（不是自编的「跑失败了」）',
    raw4?.error === '天猫后台登录已过期，第 3 步中断', String(raw4?.error ?? null))
  check('★ 失败那条的 ok 是 false', raw4?.ok === false, String(raw4?.ok ?? null))
  check('★ 失败且没产出时 outputs 是空对象（不编内容）',
    raw4?.outputs !== null && typeof raw4?.outputs === 'object' && Object.keys(raw4.outputs).length === 0,
    JSON.stringify(raw4?.outputs ?? null))

  /* 成功那条**不许**有 error 键（与 llm / depth 同一条纪律：没有的东西不出现）。 */
  const raw1 = r1.path === null ? null : JSON.parse(await readF(r1.path, 'utf8'))
  check('★★ 成功那条记录里没有 error 这个键',
    raw1 !== null && !('error' in raw1), JSON.stringify(Object.keys(raw1 ?? {})))

  /* ⑤ 两种读法都要把 error 带出来。
   *
   * ⚠️ 不能按文件名找（第一版就是这么断的，直接红了）：文件名是 `newRunId(startedAt)`
   * 生成的（`20261023-xxxxxx-<随机后缀>`），不叫 `ad-4.json`。所以按**内容**找。 */
  const all = await readCollectRecords({ workflow: '失败留底测试' })
  const failedOne = all.find(r => r.error === '天猫后台登录已过期，第 3 步中断')
  check('★★ readCollectRecords 把 error 带出来了',
    failedOne !== undefined, all.map(r => r.file + ':' + String(r.error)).join(','))
  check('★★ 失败且没产出的那条在列表里看得到',
    failedOne !== undefined && Object.keys(failedOne.outputs).length === 0,
    '共 ' + String(all.length) + ' 条：' + all.map(r => r.file).join(','))
  check('★ 成功那条读出来也没有 error 键',
    all.filter(r => r.ok === true).every(r => !('error' in r)),
    JSON.stringify(all.map(r => ({ ok: r.ok, hasError: 'error' in r }))))

  /* ⑥ 巡查侧同样：失败归档（outputs 空）也要读得到，且带 error。 */
  await rm(patrolDir(), { recursive: true, force: true })
  const r5 = await archiveOutputs({
    workflowName: '巡查-失败测试', ok: false, via: 'schedule',
    runId: 'ad-5', startedAt: 3000, endedAt: 4000, error: '巡查-抖音：浏览器连不上',
  })
  check('★★ 巡查类失败且没产出 → 也写一份', r5.path !== null, r5.reason)
  const patrolAll = await readCollectRecords({ workflow: '巡查-失败测试' })
  check('★★ 巡查侧的空产出失败记录读得到（不是写下去就消失）',
    patrolAll.length === 1, String(patrolAll.length) + ' 条')
  check('★★ 巡查侧也把 error 带出来了',
    patrolAll[0]?.error === '巡查-抖音：浏览器连不上', JSON.stringify(patrolAll[0]?.error))

  /* ⑦ 反面：巡查里那种固定名、没有 runId/via 的旧格式，仍然不许混进来。
   * （加了「空产出也认」这条腿之后，必须确认没把旧格式一起放进来。） */
  await mkdir(patrolDir(), { recursive: true })
  await writeFile(join(patrolDir(), 'patrol-tm-shop.json'), JSON.stringify({
    job: 'patrol-tm-shop', ok: false, error: '旧格式', outputs: {},
  }), 'utf8')
  const withOld = await readCollectRecords()
  check('★★ 旧格式（空 outputs 且无 runId/via）仍不出现',
    !withOld.some(r => r.file === 'patrol-tm-shop.json'),
    withOld.map(r => r.file).join(','))

  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })
}

/* ── ⑪ 文件名要与运行编号一致 + 记录里存工作流编号（契约 AJ）───────
 *
 * ## 两个真 bug 的现场
 *
 * **文件名对不上**：原来 `targetFile` 用 `newRunId(input.startedAt)` **另造一个编号**
 * 当文件名，正文里写的是调用方传进来的 `runId`。两个值都是「时间戳 + 4 位随机」，
 * 长得像但毫无关系 —— 实测磁盘上 5 条**全部不一致**
 * （文件名 `20261023-212005-peht`，记录里 `runId: 20261023-212005-o5ge`）。
 * 于是「按运行编号去找任务记录」根本做不到。
 *
 * **改名后认不出**：目录按名字分，名字一改老记录的目录名就成了「已经不存在的名字」。
 * 存下工作流编号之后，读的时候能拿编号查当前名字。
 */
{
  const { archiveOutputs, collectRecordsDir, patrolDir, readCollectRecords } =
    await import('../src/schedule/records.ts')
  const { saveWorkflow, listWorkflows } = await import('../src/workflow/store.ts')
  const { readFile: readF } = await import('node:fs/promises')
  const { basename } = await import('node:path')

  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })

  /* 真存一份工作流，拿到它的编号（不自己编一个假编号 —— 要验「等于存档顶层 id」）。 */
  const saved = await saveWorkflow({ version: 1, nodes: [], edges: [] }, '编号测试流')
  check('★ 工作流存下来带编号', typeof saved.id === 'string' && saved.id !== '', String(saved.id))

  const RUN_ID = '20261025-120000-abcd'
  const r = await archiveOutputs({
    workflowName: '编号测试流',
    workflowId: saved.id,
    ok: true,
    runId: RUN_ID,
    startedAt: 1000,
    endedAt: 2000,
    via: 'list',
    declaredOutputs: { a: 1 },
  })
  check('★ 归档写出去了', r.path !== null, r.reason)

  /* ① ★★ 文件名后缀 = runId（逐字，不是「差不多」）。 */
  check('★★ 文件名就是运行编号（不是另造一个）',
    r.path !== null && basename(r.path, '.json') === RUN_ID,
    String(r.path === null ? null : basename(r.path)))
  const raw = r.path === null ? null : JSON.parse(await readF(r.path, 'utf8'))
  check('★★ 记录正文里的 runId 与文件名逐字一致',
    raw?.runId === RUN_ID && basename(String(r.path), '.json') === raw?.runId,
    JSON.stringify({ file: basename(String(r.path)), runId: raw?.runId }))

  /* ② ★★ 记录里有 workflowId，且等于存档顶层的 id。 */
  check('★★ 记录里有 workflowId', typeof raw?.workflowId === 'string' && raw.workflowId !== '',
    String(raw?.workflowId))
  check('★★ workflowId 等于存档顶层的 id', raw?.workflowId === saved.id, String(raw?.workflowId))

  /* ③ 读的时候用编号查**当前**名字（改名后显示新名）。 */
  const refs = await listWorkflows()
  const mine = refs.find(x => x.id === saved.id)
  check('★ 存档清单里按编号查得到名字', mine !== undefined,
    refs.map(x => x.name + ':' + x.id).slice(0, 3).join(','))

  const all = await readCollectRecords({ workflow: '编号测试流' })
  const rec = all.find(x => x.workflowId === saved.id)
  check('★★ 读出来带 workflowId', rec !== undefined,
    all.map(x => x.workflow + ':' + String(x.workflowId)).join(','))

  /* ★★ 真正的改名验证：目录名（= 当时的名字）与**当前**名字**故意不同**。
   * 上面那条比对的两个值都是同一个名字，证明不了「查了编号」——
   * 所以这里造一份「目录名是旧名、编号是这份工作流」的记录：
   * 读出来必须是**当前**名字（`编号测试流`），不是目录名（`改名前的老目录`）。
   * 这正是用户要的效果：名字改了，任务记录里显示新名字。 */
  const oldDir = join(collectRecordsDir(), '改名前的老目录')
  await mkdir(oldDir, { recursive: true })
  await writeFile(join(oldDir, '20261025-140000-oldn.json'), JSON.stringify({
    workflow: '改名前的老目录', workflowId: saved.id, runId: '20261025-140000-oldn',
    ok: true, startedAt: 5, endedAt: 6, outputs: { a: 9 },
  }), 'utf8')
  const renamedRec = (await readCollectRecords({ workflow: '改名前的老目录' }))[0]
  check('★★ 目录名是旧名时，读出来显示的是存档里的当前名字',
    renamedRec?.workflow === '编号测试流', String(renamedRec?.workflow))
  check('★★ 而且不是目录名（证明真的按编号查了）',
    renamedRec?.workflow !== '改名前的老目录', String(renamedRec?.workflow))

  /* ④ 老记录（没有 workflowId）仍能读出，workflow 退回目录名。 */
  const sub = join(collectRecordsDir(), '老记录流')
  await mkdir(sub, { recursive: true })
  await writeFile(join(sub, 'old-1.json'), JSON.stringify({
    workflow: '老记录流', runId: 'old-1', ok: true, startedAt: 1, endedAt: 2, outputs: { a: 1 },
  }), 'utf8')
  const olds = await readCollectRecords({ workflow: '老记录流' })
  check('★★ 老记录（无 workflowId）仍读得出来', olds.length === 1, String(olds.length) + ' 条')
  check('★★ 老记录没有 workflowId 键', olds[0] !== undefined && !('workflowId' in olds[0]),
    JSON.stringify(Object.keys(olds[0] ?? {})))
  check('★★ 老记录的 workflow 退回目录名', olds[0]?.workflow === '老记录流', String(olds[0]?.workflow))

  /* ⑤ 巡查侧文件名同样用运行编号。 */
  const p = await archiveOutputs({
    workflowName: '巡查-编号测试', workflowId: saved.id, ok: true,
    runId: '20261025-130000-wxyz', startedAt: 3000, endedAt: 4000,
    via: 'schedule', declaredOutputs: { b: 2 },
  })
  check('★★ 巡查侧文件名也以运行编号结尾',
    p.path !== null && String(p.path).endsWith('20261025-130000-wxyz.json'),
    String(p.path === null ? null : basename(p.path)))

  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })
}

/* ── ⑫ 节点主动汇报进任务记录（契约 AN，2026-10-25）─────────────
 *
 * ## 这一段守的是什么
 *
 * 用户要的是「事后翻任务记录不用再回运行历史找」。实现路径：
 *
 * ```
 * 节点实现 → ctx.report(entry)
 *   → createBuiltinExecutor 的局部数组（补上 node id）
 *   → DispatchResult.reports
 *   → 宿主半的 sink（`makeDispatchNode` / runner 里的 collect）
 *   → archiveOutputs 的 reports
 *   → 任务记录文件里的 reports
 * ```
 *
 * 这一段从**最上游**（内置执行方）验到**最下游**（落盘文件 + 读回来），
 * 中间每一环单独断言 —— 任何一环断掉，「汇报」就悄悄消失。
 */
{
  const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
  const { archiveOutputs, collectRecordsDir, patrolDir, readCollectRecords } =
    await import('../src/schedule/records.ts')
  const { readFile: readF } = await import('node:fs/promises')
  const { basename } = await import('node:path')

  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })

  /** 派发一次内置节点（走真的执行方）。 */
  const run = async (command, nodeId = 'n23') => createBuiltinExecutor(new Map([
    ['sys.fs.write', async (_cmd, ctx) => {
      /* 模拟节点实现：干完活主动报一件事。 */
      ctx.report?.({
        message: '写到 报表.xlsx，2048000 字节',
        label: '下载报表',
        metrics: { bytes: 2048000 },
        files: ['F:/out/报表.xlsx'],
      })
      return 'ok'
    }],
  ])).run({
    runId: 'an-run', nodeId, executor: 'builtin',
    command: { node: 'sys.fs.write', params: {} },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })

  /* ① `DispatchResult.reports`：有汇报就有这个键，且带着 node id。 */
  const out = await run({})
  check('★★ 执行方把汇报带回来了（DispatchResult.reports）',
    Array.isArray(out.reports) && out.reports.length === 1, JSON.stringify(out.reports))
  check('★★ 汇报里补上了节点 id（哪个节点报的）',
    out.reports?.[0]?.node === 'n23', String(out.reports?.[0]?.node))
  check('★★ 汇报的正文原样保留', out.reports?.[0]?.message === '写到 报表.xlsx，2048000 字节',
    String(out.reports?.[0]?.message))
  check('★ 汇报里的量化数字也在', out.reports?.[0]?.metrics?.bytes === 2048000,
    JSON.stringify(out.reports?.[0]?.metrics))
  check('★ 汇报里的文件路径也在', out.reports?.[0]?.files?.[0] === 'F:/out/报表.xlsx',
    JSON.stringify(out.reports?.[0]?.files))

  /* ② 没有汇报时**不许有**这个键（与 llm / depth 同一条纪律）。 */
  const quiet = await createBuiltinExecutor(new Map([
    ['code.js', async () => '啥也没报'],
  ])).run({
    runId: 'an-run2', nodeId: 'n9', executor: 'builtin',
    command: { node: 'code.js', params: {} },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 没汇报时结果里没有 reports 这个键',
    !('reports' in quiet), JSON.stringify(Object.keys(quiet)))

  /* ③ 推两条就要读到两条（验收第 2 项）。 */
  const two = await createBuiltinExecutor(new Map([
    ['code.js', async (_c, ctx) => {
      ctx.report?.({ message: '第一件' })
      ctx.report?.({ message: '第二件' })
      return 'ok'
    }],
  ])).run({
    runId: 'an-run3', nodeId: 'n2', executor: 'builtin',
    command: { node: 'code.js', params: {} },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 推两条能读到两条', two.reports?.length === 2, JSON.stringify(two.reports))
  check('★ 两条的顺序与推的顺序一致',
    two.reports?.[0]?.message === '第一件' && two.reports?.[1]?.message === '第二件',
    JSON.stringify(two.reports?.map(r => r.message)))

  /* ④ 任务记录里有 reports，每条含节点 id 与 message（验收第 3 项）。 */
  const archived = await archiveOutputs({
    workflowName: '汇报测试流', ok: true, runId: '20261025-150000-rept',
    startedAt: 1000, endedAt: 2000, via: 'list',
    reports: out.reports,
  })
  check('★★ 有汇报时写出了记录', archived.path !== null, archived.reason)
  const raw = archived.path === null ? null : JSON.parse(await readF(archived.path, 'utf8'))
  check('★★ 落盘文件里有 reports', Array.isArray(raw?.reports), JSON.stringify(raw?.reports))
  check('★★ 每条带节点 id 与 message',
    raw?.reports?.[0]?.node === 'n23'
    && raw?.reports?.[0]?.message === '写到 报表.xlsx，2048000 字节',
    JSON.stringify(raw?.reports?.[0]))
  /* ⑤ 有汇报时**不写** outputs（两条路只写一条）。 */
  check('★★ 有汇报时记录里没有 outputs 键（两条路只写一条）',
    raw !== null && !('outputs' in raw), JSON.stringify(Object.keys(raw ?? {})))

  /* ⑥ 退回：没汇报时仍然写 outputs（老行为不变）。 */
  const fallback = await archiveOutputs({
    workflowName: '汇报测试流', ok: true, runId: '20261025-150001-fb',
    startedAt: 3000, endedAt: 4000, via: 'list',
    declaredOutputs: { 条数: 12 },
  })
  const fbRaw = fallback.path === null ? null : JSON.parse(await readF(fallback.path, 'utf8'))
  check('★★ 没汇报时退回写 outputs（老路径不变）',
    fbRaw?.outputs?.条数 === 12, JSON.stringify(fbRaw?.outputs))
  check('★★ 退回那条里没有 reports 键',
    fbRaw !== null && !('reports' in fbRaw), JSON.stringify(Object.keys(fbRaw ?? {})))

  /* ⑦ 失败但有汇报：error 与 reports 并存（验收第 5 项）。 */
  const failedWithReports = await run({})
  const fr = await archiveOutputs({
    workflowName: '汇报测试流', ok: false, runId: '20261025-150002-fr',
    startedAt: 5000, endedAt: 6000, via: 'list', error: '写盘时权限不足',
    reports: failedWithReports.reports,
  })
  const frRaw = fr.path === null ? null : JSON.parse(await readF(fr.path, 'utf8'))
  check('★★ 失败且有汇报：error 与 reports 都在',
    typeof frRaw?.error === 'string' && Array.isArray(frRaw?.reports),
    JSON.stringify({ error: frRaw?.error, n: frRaw?.reports?.length }))

  /* ⑧ 读回来也要能拿到 reports（落盘对、读取也要对）。 */
  const all = await readCollectRecords({ workflow: '汇报测试流' })
  const readBack = all.find(r => r.file === '20261025-150000-rept.json')
  check('★★ readCollectRecords 把 reports 带出来了',
    readBack?.reports?.[0]?.message === '写到 报表.xlsx，2048000 字节',
    JSON.stringify(readBack?.reports?.[0]))
  /* ⑨ 巡查侧同样：只有 reports 的记录也读得到（不会被「没有 outputs」挡掉）。 */
  const p2 = await archiveOutputs({
    workflowName: '巡查-汇报测试', ok: true, runId: '20261025-150003-pt',
    startedAt: 7000, endedAt: 8000, via: 'schedule', reports: out.reports,
  })
  check('★ 巡查侧汇报记录写出去了', p2.path !== null, p2.reason)
  const patrolRead = await readCollectRecords({ workflow: '巡查-汇报测试' })
  check('★★ 只有 reports 的巡查记录也读得到（不因缺 outputs 被丢掉）',
    patrolRead.length === 1 && patrolRead[0]?.reports?.[0]?.node === 'n23',
    '共 ' + String(patrolRead.length) + ' 条')

  await rm(collectRecordsDir(), { recursive: true, force: true })
  await rm(patrolDir(), { recursive: true, force: true })
}

await rm(sandbox, { recursive: true, force: true })

console.log('')
console.log(failed === 0 ? '结论：收藏逻辑全部通过 ✓' : '结论：有 ' + failed + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
