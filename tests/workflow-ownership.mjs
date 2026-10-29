/** 画布的文件归属：**有归属则覆盖、无归属才新建**（用户 2026-10-14 报的 bug）。
 *
 * ## 为什么必须有它（这个 bug 就是这样漏掉的）
 *
 * 用户原话：「我打开的明明是天猫取数，但是我保存的时候成了保存新文件：
 *   工作流-2026-10-14T1224。是不是当前画布根本没有记录当前编辑的是哪个工作流，
 *   每次都是一个没有归属的画布，这个功能要补齐。每次打开的画布都应该是个有文件归属的。」
 *
 * 改动前画布**永远**用时间戳新建，所以「打开 → 保存 → 多出一个文件」是**必然结果**。
 * 这类 bug 的特点是：**构建通过、类型检查通过、界面看起来一切正常** ——
 * 只有用户去数据目录里数文件才看得出来。所以必须有一条自动化断言盯着它，
 * 而且判据要落在**真的写盘、真的数文件**上，不能只看函数返回值。
 *
 * ## 判据分两层
 *
 * ① **纯函数层**（`resolveSaveTarget`）：名字与「这次是不是新建」怎么定的。
 * ② **真盘层**（`src/workflow/store.ts` 的 `saveWorkflow` / `listWorkflows`）：
 *    真写进沙箱目录，然后**数文件个数** —— 这是最能说明问题的判据。
 *
 * ⚠️ 全程在 `EWB_TEST_HOME` 沙箱里（`workflowsDir` 优先读它），**绝不碰真实数据目录**。
 * 这一条是本项目的红线（见 `AGENTS.md`「运行文件」与
 * `pitfalls/测试误写真实数据库.md`）。
 *
 * 跑法：node tests/workflow-ownership.mjs（需要 tsx loader，见 `scripts/run-tests.mjs`）
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/* ⚠️ 沙箱必须在**载入任何 src 模块之前**设好（`workflowsDir()` 读环境变量定目录）。 */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-own-'))

const { saveWorkflow, listWorkflows } = await import('../src/workflow/store.ts')
const {
  resolveSaveTarget, timestampName, docFingerprint, toWorkflowDoc, fromWorkflowDoc,
} = await import('../src/client/workbench/workflow-doc.ts')
const { NODE_LIBRARY } = await import('../src/client/workbench/node-library.ts')

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

/** 目录里现在有几份工作流（直接数盘上的 .json）。 */
async function countFiles() {
  try {
    const files = await readdir(join(process.env.EWB_TEST_HOME, 'workflows'))
    return files.filter(f => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** 读回盘上某一份的内容。 */
async function readBack(name) {
  const text = await readFile(join(process.env.EWB_TEST_HOME, 'workflows', name + '.json'), 'utf8')
  return JSON.parse(text)
}

/* ── 一个最小的画布节点（形状与 `SourceNode` 一致）── */
function node(id, x) {
  return {
    id,
    type: 'v1',
    position: { x, y: 40 },
    data: { def: { id: 'code.js', params: {}, onError: 'stop' }, params: { code: 'return 1' }, onError: 'stop' },
  }
}

/* ══ ① 纯函数层：名字与「新建 or 覆盖」怎么定的 ════════════════════════════ */
console.log('=== ① resolveSaveTarget（照 n8n 的 workflowId 可空 + isNewWorkflow）===')
{
  const stamp = '工作流-2026-10-14T1224'

  const owned = resolveSaveTarget({ name: '天猫取数', isNew: false }, stamp)
  check('有归属 → 写**原来那个名字**', owned.name === '天猫取数', owned.name)
  check('有归属 → 不是新建（走覆盖那一支）', owned.creates === false, String(owned.creates))

  const fresh = resolveSaveTarget({ name: '', isNew: true }, stamp)
  check('没归属 → 用时间戳名字', fresh.name === stamp, fresh.name)
  check('没归属 → 是新建', fresh.creates === true, String(fresh.creates))

  /* ⚠️ 边界：`isNew: false` 但名字是空串（脏状态）→ 必须仍按新建处理。
   * 不这样判的话会去写一个「.json」这样的怪文件。 */
  const dirty = resolveSaveTarget({ name: '', isNew: false }, stamp)
  check('空名字即使 isNew=false 也按新建处理（不写怪文件）', dirty.creates === true && dirty.name === stamp, JSON.stringify(dirty))

  check('时间戳名字形如 工作流-YYYY-MM-DDTHHmm', /^工作流-\d{4}-\d{2}-\d{2}T\d{4}$/.test(timestampName(new Date('2026-10-14T12:24:00Z'))), timestampName(new Date('2026-10-14T12:24:00Z')))
}

/* ══ ② 真盘层：打开 → 保存 → 数文件 ═════════════════════════════════════ */
console.log('')
console.log('=== ② 真写盘：打开一份 → 保存 → 磁盘上不该多出文件 ===')

/* 先造一份「已存在的工作流」（模拟用户以前存过的天猫取数）。 */
const created = await saveWorkflow(toWorkflowDoc([node('n1', 10), node('n2', 300)], [], '天猫取数', []), '天猫取数')
check('先造一份已存的「天猫取数」', created.name === '天猫取数', created.path)
check('盘上有 1 份', await countFiles() === 1, String(await countFiles()))

/* 画布状态机（与 `WorkflowCanvas` 里那两个 state 同一个形状）。 */
let fileRef = { name: '', isNew: true }
let savedFp = ''

/** 模拟「打开一份已存的工作流」（= `applyWorkflow` 设归属那一步）。 */
async function openInto(name, nodes) {
  const doc = toWorkflowDoc(nodes, [], name, [])
  fileRef = { name, isNew: false }
  savedFp = docFingerprint(doc)
  return doc
}

/** 模拟「点一次保存」（= `save` → `writeFile` 那两步）。 */
async function pressSave(nodes, description) {
  const target = resolveSaveTarget(fileRef, timestampName())
  const doc = toWorkflowDoc(nodes, [], target.name, [], description)
  const r = await saveWorkflow(doc, target.name)
  fileRef = { name: r.name, isNew: false }
  savedFp = docFingerprint(doc)
  return { target, r, doc }
}

const opened = await openInto('天猫取数', [node('n1', 10), node('n2', 300)])
check('打开后画布显示「有归属」（不是新建）', fileRef.isNew === false && fileRef.name === '天猫取数', JSON.stringify(fileRef))
check('刚打开时「未保存」标记不该亮（内容与盘上一致）', docFingerprint(opened) === savedFp)

/* ★ 核心断言 1：有归属 → 覆盖，盘上**不新增文件**。 */
const before1 = await countFiles()
const s1 = await pressSave([node('n1', 10), node('n2', 300), node('n3', 600)])
check('★ 有归属时保存：写的是原来那个名字', s1.target.name === '天猫取数' && s1.target.creates === false, JSON.stringify(s1.target))
check('★ 有归属时保存：磁盘上**没有多出文件**（1 → ' + String(before1) + '）', await countFiles() === before1, String(await countFiles()))
const disk1 = await readBack('天猫取数')
check('★ 有归属时保存：原文件内容**被更新了**（多了一个节点）', disk1.nodes.length === 3, String(disk1.nodes.map(n => n.id).join(',')))
check('保存后画布显示「已保存」（指纹跟上）', docFingerprint(s1.doc) === savedFp)
check('保存后归属仍是那一份', fileRef.name === '天猫取数' && fileRef.isNew === false, JSON.stringify(fileRef))

/* 再点一次：仍然覆盖同一份（幂等，不会每次都多一个文件）。 */
const s2 = await pressSave([node('n1', 10), node('n2', 300), node('n3', 600)])
check('再点一次保存：还是同一份（盘上仍是 ' + String(before1) + ' 份）', await countFiles() === before1, String(await countFiles()))
check('再点一次保存：文件名没变', s2.r.name === '天猫取数', s2.r.name)

/* ★ 核心断言 2：空白画布 → 新建一份，且**随后再点不会又生成一个**。 */
console.log('')
console.log('=== ③ 空白画布（无归属）→ 新建；随后再点不再新建 ===')
{
  /* 模拟「+ 新建」：清空并且丢掉归属。 */
  fileRef = { name: '', isNew: true }
  savedFp = ''
  const blank = [node('b1', 20)]
  const before2 = await countFiles()
  const s3 = await pressSave(blank)
  check('★ 没归属时保存：生成一个新名字', s3.target.creates === true && /^工作流-\d{4}-\d{2}-\d{2}T\d{4}$/.test(s3.target.name), s3.target.name)
  check('★ 没归属时保存：磁盘上多出一份（' + String(before2) + ' → ' + String(await countFiles()) + '）', await countFiles() === before2 + 1, String(await countFiles()))
  check('★ 保存后**当场获得归属**（下次就是覆盖了）', fileRef.isNew === false && fileRef.name === s3.target.name, JSON.stringify(fileRef))

  /* ★ 就是用户报的那个症状：以前这里会又生成一个。 */
  const before3 = await countFiles()
  const s4 = await pressSave([node('b1', 20), node('b2', 300)])
  check('★★ 随后再点保存：**不会又生成一个**（仍写第一份）', s4.target.creates === false && s4.r.name === s3.target.name, s4.r.name)
  check('★★ 随后再点保存：磁盘份数不变（' + String(before3) + '）', await countFiles() === before3, String(await countFiles()))
  const disk3 = await readBack(s3.target.name)
  check('★★ 第一份的内容被更新（不是留着一份旧的）', disk3.nodes.length === 2, String(disk3.nodes.map(n => n.id).join(',')))
}

/* ★ 核心断言 3：打开带说明的存档 → 保存 → 说明还在（T9 的 F1）。 */
console.log('')
console.log('=== ④ 说明字段的往返（T9 查出的 F1：一存就丢）===')
{
  const DESC = '从天猫生意参谋逐张报表取数并落盘。'
  /* 造一份带 root 级 `description` 的存档（宿主半的列表路由读的就是它）。 */
  const withDesc = { ...toWorkflowDoc([node('d1', 10)], [], '带说明的流', [], DESC) }
  await saveWorkflow(withDesc, '带说明的流')
  const raw = await readBack('带说明的流')
  check('存档里确实写下了 root 级 description', raw.description === DESC, JSON.stringify(raw.description))
  check('★ 存档的 root keys 里有 description（不是只存在于编组里）', Object.keys(raw).includes('description'), Object.keys(raw).join(','))

  /* 打开它（`fromWorkflowDoc` 要把说明读出来）。 */
  const backed = fromWorkflowDoc(raw, new Map(NODE_LIBRARY.map(d => [d.id, d])), () => ({ id: '__group', label: '分组', executor: 'builtin', inputs: [], outputs: [] }))
  check('★ 打开时读出了说明（画布要拿着它）', backed.description === DESC, JSON.stringify(backed.description))

  /* 保存回去（画布把读到的说明原样交给 `toWorkflowDoc`）。 */
  const nodes = backed.nodes.map(r => ({ id: r.id, type: 'v1', position: r.position, data: { def: r.data.def, params: r.data.params, onError: r.data.onError } }))
  const saved = { ...toWorkflowDoc(nodes, backed.edges, '带说明的流', backed.groups, backed.description) }
  await saveWorkflow(saved, '带说明的流')
  const after = await readBack('带说明的流')
  check('★★ 打开 → 保存 之后，说明**还在**（F1 修好）', after.description === DESC, JSON.stringify(after.description))
  check('★ 而且盘上份数没变（这次走的是覆盖）', await countFiles() === 3, String(await countFiles()))

  /* 反向：老存档没有这个字段 → 读出来是空串，保存时**不写**空键。 */
  const noDesc = { ...toWorkflowDoc([node('e1', 10)], [], '没有说明的流', [], '') }
  check('没有说明时不写空键（存档干净）', !Object.keys(noDesc).includes('description'), Object.keys(noDesc).join(','))
  const back2 = fromWorkflowDoc({ nodes: [], edges: [] }, new Map(), () => ({ id: '__group', label: '分组', executor: 'builtin', inputs: [], outputs: [] }))
  check('老存档（没有 description）读出来是空串，不报错', back2.description === '', JSON.stringify(back2.description))
}

/* ★ 核心断言 4：列表接口要能看见保存后的效果（名字与说明都对得上） */
console.log('')
console.log('=== ⑤ 存完之后列表里的样子 ===')
{
  const items = await listWorkflows()
  const names = items.map(x => x.name).sort()
  console.log('   盘上现在有:', names.join(' / '))
  check('列表里「天猫取数」还在（没被存成新名字）', names.includes('天猫取数'))
  check('★ 列表里没有多出「天猫取数」的副本', names.filter(n => n.startsWith('天猫取数')).length === 1, names.join(','))
  const tmall = items.find(x => x.name === '天猫取数')
  check('列表读得到它的节点数（界面要显示）', tmall !== undefined && tmall.doc.nodes.length === 3, String(tmall?.doc?.nodes?.length))
}

/* ══ ⑥ 装基线指纹：点「新建」/ 打开之后**不该**顶着「未保存」══════════════
 *
 * ## 这个 bug 是怎么来的（是「恒亮的标记」那个反模式的**又一个实例**）
 *
 * 画布有三个地方要装基线指纹：保存后、打开后、新建后。
 * 前两个我处理对了，**新建那条漏了** —— 写的是 `setSavedFp('')`：
 *   · `dirty` = `docFingerprint(...) !== savedFp`，而 `savedFp === ''`
 *     → **恒为真**（指纹永远不等于空串，空画布的指纹也不等于）；
 *   · 而那个「挂载时装一次基线」的 effect 有**只跑一次**的守卫，
 *     挂载时就用掉了那一次机会 → **没人再把 `savedFp` 填回来**。
 * 于是点完「新建」，空画布一直顶着「未保存的新工作流 · 未保存」，永不消失。
 *
 * ⚠️ 这条**必须**有断言：上面 ②③ 段全绿也抓不到它 ——
 * 它们只走「打开 → 保存」那条路，而 bug 在「新建」这条路上。
 * 这正是「三条路径只测了两条」的漏。 */
console.log('')
console.log('=== ⑥ 点「新建」之后的状态（必修 1）===')
{
  /* 与 `WorkflowCanvas.tsx` 的 `newWorkflow` 同一个形状：
   * 清空 → 丢归属 → 装一次**空画布的新基线**。 */
  let f = { name: '天猫取数', isNew: false }
  let fp = docFingerprint(toWorkflowDoc([node('n1', 10)], [], '天猫取数', []))
  const dirtyNow = (nodes, name) => docFingerprint(toWorkflowDoc(nodes, [], name, [])) !== fp

  check('前置：打开着「天猫取数」且没有改动 → 不报未保存', dirtyNow([node('n1', 10)], '天猫取数') === false)
  /* ★ 真正改一下，确认「未保存」这条机制**本身是活的**
   * （否则下面那条「新建后不报未保存」可能因为 dirty 恒假而假绿）。 */
  check('★ 机制是活的：改了内容 → 报未保存', dirtyNow([node('n1', 10), node('n2', 300)], '天猫取数') === true)

  /* ── 点「新建」：照 `newWorkflow` 的三步 ── */
  f = { name: '', isNew: true }
  fp = docFingerprint(toWorkflowDoc([], [], '', [], ''))
  check('★★ 点新建后**不报未保存**（修好的判据：装的是空画布基线）',
    dirtyNow([], '') === false,
    'savedFp=' + JSON.stringify(fp.slice(0, 40)))
  /* 反向：证明这条断言抓得住原来的写法。 */
  const badFp = ''
  check('★ 反向核对：用 `setSavedFp(\'\')` 那种写法会**恒报未保存**（这就是那个 bug）',
    (docFingerprint(toWorkflowDoc([], [], '', [])) !== badFp) === true)
  /* 新建之后再画一个节点 → 应该**报**未保存。 */
  check('★ 新建后加了节点 → 报未保存', dirtyNow([node('x1', 10)], '') === true)
  /* ⚠️ 归属要用**归属名**算指纹（不是空串）：这是「刚打开就报未保存」那个坑的同源问题。 */
  check('★ 新建后指纹里的名字与归属一致（空名字）', f.name === '' && f.isNew === true)

  /* ★★ **源码层**再钉一次：上面那些是「模拟 `newWorkflow` 的三步」，
   * 而真正要防的是**组件里那一行被改回去**。
   *
   * 为什么不能直接 import `WorkflowCanvas.tsx` 来测真的那条路：
   * 它 import 了 `.module.css`，Node 加载不了（`.css` 不是 JS 模块）——
   * 实测报 `ERR_UNKNOWN_FILE_EXTENSION`。所以组件闭包里的逻辑**在 node 里测不到**，
   * 只能查源码。这一条**是突变测试逼出来的**：把那一行改回 `setSavedFp('')` 时，
   * 上面 ⑥ 段的模拟断言**照样全绿**（因为模拟用的是「修好之后」的写法）。
   *
   * 判据是「源码里有那一行」而不是「没有 `setSavedFp('')`」——
   * 后者会因为别处也有 `setSavedFp` 而误判，前者指向明确。 */
  /* ⚠️⚠️ **2026-10-29（票 63 连带）：靶子从「新建」换成「打开」。**
   *
   * ## 为什么换
   *
   * 上面那两条源码层断言找的是 `newWorkflow` 的函数体。票 63 用户定了
   * 「执行画布去掉新建、打开、另存为按钮，新建打开归工作流管理」，
   * 那个函数**连函数一起删了**（它只被那颗按钮调用）——
   * 于是两条断言变成「找不到那一行」，永远红。
   *
   * ## 守的事没变，只是换到**现在仍然活着**的同族路径上
   *
   * 原来守：**清空画布之后**装的必须是算出来的指纹（不是空串），
   * 否则「未保存」恒亮。
   *
   * 现在守：**打开一份之后**装的必须是算出来的指纹，否则同样恒亮。
   *
   * 这不是「换一条更松的」。原来那条守的是「别写成空串」，
   * 现在这条守的是**同一个反模式的另一面**，而且多守了两件原来没验的事：
   *
   * | 这件 | 漏了会怎样 |
   * |---|---|
   * | 用 `syncedNodes` 而不是 `nextNodes` | 同步第二层给浏览器节点补了字段，拿同步前的数组算 → 打开完立刻「未保存」 |
   * | 用 `ownName` 而不是 `file.name` | 加载后 `dirty` 拿现在的名字算，两者不一致 → 一打开就「未保存」 |
   *
   * 后两件正是 `WorkflowCanvas.tsx:4204-4207` 那段注释记的真坑
   * （`bundle-identifiers` 的断言当场抓到过）。 */
  const canvasSrc = await readFile(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')

  /* 找出「打开 / 加载」那条路径里装基线的那一段。 */
  const openBody = /setSavedFp\(docFingerprint\(toWorkflowDocOf\(([\s\S]*?)\)\)\)/.exec(canvasSrc)

  check('★★ 源码层：打开一份之后装的是**算出来的指纹**（不是空串）',
    openBody !== null,
    openBody === null
      ? '找不到「打开后装基线」那一行 → 打开一份后「未保存」会恒亮'
      : openBody[1].replace(/\s+/g, ' ').trim().slice(0, 110))

  /* ★ 名字那半：必须用 `ownName`，不是 `file.name`。 */
  check('★★ 源码层：指纹里的名字用的是 `ownName`（不是 `file.name`）',
    openBody !== null && /\bownName\b/.test(openBody[1]),
    '名字不一致 → 一打开就报未保存')

  /* ★ 节点那半：必须用 `syncedNodes`，不是 `nextNodes`。 */
  check('★★ 源码层：指纹里的节点用的是 `syncedNodes`（不是 `nextNodes`）',
    openBody !== null && /\bsyncedNodes\b/.test(openBody[1]),
    '同步第二层补过字段，拿同步前的数组算 → 打开完立刻「未保存」')

  /* 反向：那一行**不许**写成空串。 */
  check('★★ 源码层：那一行不是 `setSavedFp(\'\')`',
    !/setSavedFp\(''\)/.test(canvasSrc),
    /setSavedFp\(''\)/.test(canvasSrc) ? '出现了 setSavedFp(\'\')' : '')
}

/* ══ ⑦ 「⎌ 恢复」找老快照（T4 审出的必修 2：老快照静默够不着）══════════════
 *
 * 用户 2026-10-14 之前，快照名**恒为「当前工作流」**；之后改成跟着归属走。
 * 盘上老目录于是**没人再看** —— 实测真机数据目录下只有那一个目录、2 个快照，
 * 而工作流列表里一份都不叫这个名字 → 点「恢复」只说「还没有存过快照」。
 *
 * ⚠️ 测的是 `snapshot-lookup.ts` 的**真实现**（不是在这里抄一份规则）——
 * 抄一份就变成假绿：实现改了、测试那份没改照样通过。
 * 这个模块是纯函数、没有 `.module.css` 依赖，所以 node 测试 import 得进来
 * （`WorkflowCanvas.tsx` 不行，它 import 了 `.module.css`，Node 加载不了）。 */
console.log('')
console.log('=== ⑦ 恢复：快照改名之后，老快照仍够得着（必修 2）===')
{
  const { resolveSnapLookup, legacySnapNotice, LEGACY_SNAP_DIR } = await import('../src/client/workbench/snapshot-lookup.ts')

  /** 造一个假的「盘」：目录名 → 快照名数组。 */
  const disk = (map) => async (name) => ({ ok: true, snaps: map[name] ?? [] })

  /* ① 现状：目标名下没有，老目录里有 → 必须兜底到老目录。 */
  const legacyDisk = disk({ [LEGACY_SNAP_DIR]: ['2026-10-12T11-44-48', '2026-10-10T17-46-43'] })
  const fallback = await resolveSnapLookup('天猫取数', legacyDisk)
  check('★★ 目标名下为空时兜底到老目录（快照不再静默够不着）',
    fallback.snaps.length === 2 && fallback.legacy === true, JSON.stringify(fallback))
  check('★★ 而且给出去读的目录是**老目录**（否则读的时候必然找不到）',
    fallback.dir === LEGACY_SNAP_DIR, fallback.dir)
  check('★ 提示里说清了「不一定属于当前这份工作流」',
    /不一定属于当前这份工作流/.test(legacySnapNotice(fallback)), legacySnapNotice(fallback))

  /* ② 目标名下**有**快照 → 用目标目录、**不**混老目录那批
   *（否则每份工作流都会看到同一批老快照，会以为属于自己）。 */
  const bothDisk = disk({
    天猫取数: ['2026-10-14T09-00-00'],
    [LEGACY_SNAP_DIR]: ['2026-10-10T17-46-43'],
  })
  const own = await resolveSnapLookup('天猫取数', bothDisk)
  check('★ 目标名下有时不兜底（不把老快照混进来）',
    own.snaps.length === 1 && own.legacy === false && own.dir === '天猫取数', JSON.stringify(own))
  check('★ 这时没有「改版前」提示', legacySnapNotice(own) === '', JSON.stringify(legacySnapNotice(own)))

  /* ③ **没归属**时目标名就是老目录名 → 不该重复查、也不该标成 legacy
   *（否则会对「本来就是当前目录」的快照说「这些是改版前存的」）。 */
  const newFlow = await resolveSnapLookup(LEGACY_SNAP_DIR, legacyDisk)
  check('★ 没归属时（目标名就是老目录名）不误标 legacy',
    newFlow.snaps.length === 2 && newFlow.legacy === false && newFlow.dir === LEGACY_SNAP_DIR, JSON.stringify(newFlow))

  /* ④ 两边都空 → 空数组，界面照旧说「还没有存过快照」。 */
  const empty = await resolveSnapLookup('天猫取数', disk({}))
  check('★ 两边都没有 → 空（界面说「还没有存过快照」）',
    empty.snaps.length === 0 && empty.legacy === false, JSON.stringify(empty))

  /* ⑤ 目标目录**读失败** → 如实报错，**不兜底**替上。
   * 分不清「没有」与「读不到」时拿老快照顶，会让人以为数据是好的。 */
  const broken = async () => ({ ok: false, snaps: [], error: '宿主半返回 500' })
  const err = await resolveSnapLookup('天猫取数', broken)
  check('★ 目标目录读失败时如实报错、不拿老快照顶替',
    err.snaps.length === 0 && err.error === '宿主半返回 500', JSON.stringify(err))
}

console.log('')
console.log(failed === 0 ? '结论：全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
