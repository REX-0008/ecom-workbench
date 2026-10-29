/** 复制工作流（票 46，2026-10-28）。
 *
 * # 用户原话
 *
 * 「执行和内容的工作流管理与画布库都增加复制功能。」
 *
 * # 这一份盯什么
 *
 * 复制这件事**最坏的结果不是「没复制成」，是「复制把原来的那份盖掉了」**。
 * `saveWorkflow`（`src/workflow/store.ts:88-100`）是直接 `writeFile`，
 * **没有同名拒绝** —— 所以「读出来 + 换个名字保存」这个最直觉的做法，
 * 名字撞了会直接毁掉一份存档，还不报错。
 *
 * 因此这里的断言分三层，每层要抓的是不同的坏法：
 *
 * | 层 | 抓什么坏法 |
 * |---|---|
 * | 名字 | 副本名撞上已有名字 → **原件被覆盖** |
 * | 编号 | 副本沿用原件 id → `flow.workflow` 引用指错份 |
 * | 内容 | 副本是空壳 / 丢了节点 / 连复制三次后名字不再往后数 |
 *
 * # 为什么用真实的 store 与真实磁盘（沙箱目录）
 *
 * 用桩 fetch 只能验「发了什么请求」，验不到「磁盘上那份文件有没有被改」——
 * 而「撞名不覆盖」这件事**只有看磁盘才算数**。所以这里把 `EWB_TEST_HOME`
 * 指到临时目录，走真的 `saveWorkflow` / `listWorkflows`。
 *
 * 跑法：node --import <tsx> tests/workflow-duplicate.mjs
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-wfdup-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { saveWorkflow, listWorkflows, loadWorkflow, workflowsDir } = await import('../src/workflow/store.ts')
const { deriveWorkflowId } = await import('../src/workflow/ids.ts')

/* ── 把 fetch 接到真实 store 上 ─────────────────────────────────────
 *
 * `duplicateWorkflow` 走的是三条 HTTP 路由（`/workflow`、`/workflows`）。
 * 在 node 里没有浏览器 env，`fetch('/api/...')` 会直接报「Failed to parse URL」。
 *
 * **这里不换掉被验的代码，只换掉它脚下的传输层** —— 请求照发、路由照认，
 * 落到的却是**真的 `saveWorkflow` / `listWorkflows` 与真的磁盘文件**。
 * 这样「撞名有没有覆盖原件」才验得到（用桩数据只能验「发了什么」，验不到文件变没变）。
 *
 * 认的四条路由与 `src/index.ts` 里那几条一一对应：
 *
 * | 方法与路径 | 真实位置 |
 * |---|---|
 * | `GET /api/ecom-workbench/workflow?name=X` | `src/index.ts` 读一份 |
 * | `GET /api/ecom-workbench/workflows` | `src/index.ts:2989` 列清单 |
 * | `POST /api/ecom-workbench/workflows` | `src/index.ts:3023` 保存 |
 */
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url), 'http://test.local')
  const p = u.pathname
  const method = (init?.method ?? 'GET').toUpperCase()
  /**
   * 造一个假的 Response（只要 `ok` / `status` / `json()` 三样，被验的代码只用这三样）。
   * @param {number} status - HTTP 状态。
   * @param {unknown} body - 回包。
   */
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

  if (p === '/api/ecom-workbench/workflow' && method === 'GET') {
    const doc = await loadWorkflow(u.searchParams.get('name') ?? '')
    return doc === null ? reply(404, {}) : reply(200, { doc })
  }
  if (p === '/api/ecom-workbench/workflows' && method === 'GET') {
    const items = await listWorkflows()
    return reply(200, { dir: workflowsDir(), items: items.map(x => ({ name: x.name, id: x.id })) })
  }
  if (p === '/api/ecom-workbench/workflows' && method === 'POST') {
    const body = JSON.parse(String(init.body))
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : '未命名工作流'
    const saved = await saveWorkflow(body.doc ?? {}, name)
    return reply(200, { ok: true, path: saved.path, name: saved.name, id: saved.id })
  }
  return reply(404, { error: '没有这条路由：' + method + ' ' + p })
}

const { workflowCopyName, duplicateWorkflow } = await import('../src/client/workbench/dispatch-client.ts')

let bad = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} ok - 过没过。
 * @param {string} [detail] - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : '  → ' + detail))
}

/** 一份像样的工作流（有节点、有连线、有编号）。 */
function doc(name, extra = {}) {
  return {
    id: deriveWorkflowId(name),
    name,
    nodes: [
      { id: 'n1', defId: 'flow.start', params: { type: 'manual' } },
      { id: 'n2', defId: 'flow.end', params: {} },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    ...extra,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：副本名的规则
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 副本名：原名 + 副本 / 副本 2 / 副本 3 ===')
{
  const none = new Set([])
  check('★★ 没有占用时 → 「X 副本」', workflowCopyName('天猫取数', none) === '天猫取数 副本',
    workflowCopyName('天猫取数', none))
  check('★ 已有「X 副本」→ 「X 副本 2」',
    workflowCopyName('天猫取数', new Set(['天猫取数 副本'])) === '天猫取数 副本 2')
  check('★ 已有 2 → 「X 副本 3」',
    workflowCopyName('天猫取数', new Set(['天猫取数 副本', '天猫取数 副本 2'])) === '天猫取数 副本 3')
  /* ★ 中间空位要能用（用户删过一份副本后再复制）。 */
  check('★★ 中间有空位 → 用空位（不复用到 4）',
    workflowCopyName('天猫取数', new Set(['天猫取数 副本', '天猫取数 副本 3'])) === '天猫取数 副本 2',
    workflowCopyName('天猫取数', new Set(['天猫取数 副本', '天猫取数 副本 3'])))
  /* ★ 从副本再复制：不许出现「X 副本 副本」。 */
  check('★★ 从「X 副本」再复制 → 往后数，不是叠后缀',
    workflowCopyName('天猫取数 副本', new Set(['天猫取数 副本'])) === '天猫取数 副本 2',
    workflowCopyName('天猫取数 副本', new Set(['天猫取数 副本'])))
  check('★ 从「X 副本 2」再复制 → 同上',
    workflowCopyName('天猫取数 副本 2', new Set(['天猫取数 副本', '天猫取数 副本 2'])) === '天猫取数 副本 3',
    workflowCopyName('天猫取数 副本 2', new Set(['天猫取数 副本', '天猫取数 副本 2'])))
  check('★ 原件本身叫「X 副本」的也不会撞（那是原件，已占）',
    workflowCopyName('X 副本', new Set(['X 副本'])) === 'X 副本 2')
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 真磁盘：复制出一份，原件不变
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 复制出一份：多了一份、原件一个字节没变 ===')
{
  await saveWorkflow(doc('示例流程'), '示例流程')
  const before = await readFile(join(workflowsDir(), '示例流程.json'), 'utf8')

  const got = await duplicateWorkflow('示例流程')
  check('★★ 复制成功', got.ok === true, got.ok ? '' : String(got.error))
  check('★★ 副本名是「示例流程 副本」', got.name === '示例流程 副本', String(got.name))

  const after = await readFile(join(workflowsDir(), '示例流程.json'), 'utf8')
  check('★★★ 原件内容**逐字未变**（撞名/覆盖的第一道防线）', before === after,
    before === after ? '（逐字相同）' : '变了：' + after.slice(0, 100))

  const list = await listWorkflows()
  check('★★ 列表里多了一份（从 1 变 2）', list.length === 2, list.map(x => x.name).join(','))

  const copy = JSON.parse(await readFile(join(workflowsDir(), '示例流程 副本.json'), 'utf8'))
  check('★★ 副本里有原件全部节点', Array.isArray(copy.nodes) && copy.nodes.length === 2,
    String(copy.nodes?.length))
  check('★★ 副本里有原件全部连线', Array.isArray(copy.edges) && copy.edges.length === 1,
    String(copy.edges?.length))
  check('★★ 副本里的 name 跟着文件名（不是原件的名字）', copy.name === '示例流程 副本', String(copy.name))

  /* ★★ 这一条是票 46 的核心：编号不能与原件同。 */
  check('★★★ 副本编号**不等于**原件编号（引用不会串）',
    copy.id !== deriveWorkflowId('示例流程') && copy.id === deriveWorkflowId('示例流程 副本'),
    '原件 ' + deriveWorkflowId('示例流程') + ' / 副本 ' + String(copy.id))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 连复制三次：名字往后数，且每次编号都唯一
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 连着复制三次 → 副本 / 副本 2 / 副本 3，编号互不相同 ===')
{
  const names = []
  for (let i = 0; i < 3; i += 1) {
    const got = await duplicateWorkflow('示例流程')
    if (!got.ok) { check('第 ' + String(i + 1) + ' 次复制成功', false, String(got.error)); break }
    names.push(got.name)
  }
  check('★★★ 三次得到的名字依次是 副本 2 / 副本 3 / 副本 4（② 段已占了「副本」）',
    names.join(',') === '示例流程 副本 2,示例流程 副本 3,示例流程 副本 4',
    names.join(','))
  check('★ 第三次之后名字没有再撞（每次都是新的）', new Set(names).size === names.length, names.join(','))

  const list = await listWorkflows()
  const ids = list.map(x => x.id).filter(id => id !== '')
  check('★★★ 所有存档的编号**互不相同**（没有一个重复）',
    new Set(ids).size === ids.length,
    ids.length + ' 份，去重后 ' + String(new Set(ids).size))
  check('★ 一共 5 份（原件 + 4 份副本）', list.length === 5, String(list.length))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 撞名不覆盖（票面要求「额外必贴撞名那次的实际过程」）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 撞名：把副本名改成已存在的名字，原件必须原样 ===')
{
  /* 造一份「重要流程」，记下它此刻的内容。 */
  await saveWorkflow(doc('重要流程', { nodes: [{ id: 'keep', defId: 'flow.start', params: {} }] }), '重要流程')
  const keyBefore = await readFile(join(workflowsDir(), '重要流程.json'), 'utf8')

  /* 关键动作：**不经过 duplicateWorkflow**，直接模拟「用户自己决定名字」那条路 ——
   * 也就是票面警告的那个最直觉的写法：读出来、换个名字、保存。
   * 若 `duplicateWorkflow` 的名字查重失效，它就会走成这个样子。 */
  const naive = doc('重要流程')
  await saveWorkflow(naive, '重要流程')
  const keyAfterNaive = await readFile(join(workflowsDir(), '重要流程.json'), 'utf8')
  check('★ 前提：直接覆盖写**确实会改掉原件**（这条证明「不查重就会毁」是真的，不是吓人）',
    keyBefore !== keyAfterNaive,
    keyBefore === keyAfterNaive ? '（没变 —— 那这一段的靶子不成立）' : '（变了，正如警告）')

  /* 还原原件，然后用**正确的方法**再试一次。 */
  await saveWorkflow(JSON.parse(keyBefore), '重要流程')
  const keyReset = await readFile(join(workflowsDir(), '重要流程.json'), 'utf8')
  check('★ 还原成功（原件回到初始内容）', keyReset === keyBefore)

  /* 正确方法：把名字占满，逼它往后数。 */
  await saveWorkflow(doc('重要流程 副本'), '重要流程 副本')
  const occupied = await readFile(join(workflowsDir(), '重要流程 副本.json'), 'utf8')

  const got = await duplicateWorkflow('重要流程')
  check('★★★ 名字撞了 → 自动往后数，没覆盖「重要流程 副本」',
    got.ok === true && got.name === '重要流程 副本 2', String(got.name))
  const occupiedAfter = await readFile(join(workflowsDir(), '重要流程 副本.json'), 'utf8')
  check('★★★ 被撞的那份**逐字未变**（这就是「撞名不覆盖」）', occupied === occupiedAfter,
    occupied === occupiedAfter ? '（逐字相同）' : '变了：' + occupiedAfter.slice(0, 100))
  const keyStill = await readFile(join(workflowsDir(), '重要流程.json'), 'utf8')
  check('★★★ 原件也**逐字未变**', keyStill === keyBefore,
    keyStill === keyBefore ? '（逐字相同）' : '变了：' + keyStill.slice(0, 100))

  /* 文件数对得上（没有凭空多出来的旧名字）。 */
  const files = (await readdir(workflowsDir())).filter(f => f.endsWith('.json'))
  check('★ 目录里的文件数与列表条数一致', files.length === (await listWorkflows()).length,
    files.length + ' 个文件')
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 原件不存在 / 原件不是工作流
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 边界：不存在 / 不是工作流 / 什么都不留下 ===')
{
  const before = (await listWorkflows()).length
  const miss = await duplicateWorkflow('根本没有这份')
  check('★★ 原件不存在 → 失败，且**不留下空文件**',
    miss.ok === false && String(miss.error).includes('读原件失败'), String(miss.error))
  check('★★ 失败之后存量没变（没凭空多一份）', (await listWorkflows()).length === before,
    String(before) + ' → ' + String((await listWorkflows()).length))
}

console.log('')
if (bad === 0) console.log('全部通过 ✓')
else { console.log('有 ' + String(bad) + ' 条不通过 ✗'); process.exitCode = 1 }
