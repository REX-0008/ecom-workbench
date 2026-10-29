/** 工作流的**稳定编号**（纯函数、零 IO，宿主半与客户端半共用）。
 *
 * ## 为什么需要编号（用户 2026-10-19 原话）
 *
 * 「把引用一起改了，同时，引用不要用名称匹配，当前工作流除了名称没有编号之类的吗？
 *   引用用的应该是编号而不是名称。」
 *
 * 起因是一个真 bug：`取数-抖音电商罗盘.json` 在界面上被改过名，
 * 而「一键下载」里引用它的那个节点还写着旧名字 ——
 * 于是跑一键下载会报「没有这份工作流」。
 * 名字既是**给人看的标签**，又被当成**程序里的键**，改名就把引用扯断了。
 *
 * 所以分成两层（与 n8n 同一个做法：它的 Execute Sub-workflow 节点存
 * `workflowId`，名字只用来显示）：
 *
 * | | 是什么 | 会变吗 |
 * |---|---|---|
 * | **文件名 / 显示名** | `<名>.json` | 用户随时可以改 |
 * | **编号 `doc.id`** | 写进存档的一串字符 | **永不变** |
 *
 * 引用只认编号，名字随便改。
 *
 * ## 编号是怎么来的
 *
 * 由工作流名派生：`wf-` + 名字的 FNV-1a 哈希（36 进制）。
 * 这样做的好处是**生成器不必先读别的存档**就能算出一份工作流的编号
 * （`scripts/combine/build.mjs` 就是这么写组合层的），而且任何机器算出来都一样
 * （纯算术，不依赖时间与随机数）。
 *
 * ⚠️ **只在「存档还没有编号」时派生一次**，之后编号就跟着文件走、不再重算 ——
 * 否则改名会换编号，等于把这次要修的问题换个形式又造一遍。
 *
 * ⚠️ **派生时优先用文件里的 `name`，不是文件名**：生成器按它声明的名字算编号，
 * 而一份被界面改过名的老存档，文件名与 `name` 会不一致（就是上面那份抖音档）。
 * 用 `name` 才能和生成器算出来的一致，引用才接得上。
 *
 * 哈希碰撞概率：32 位、几十份工作流，实际不会撞；真撞了表现为
 * 「引用解析到另一份」，`resolveWorkflowRef` 会按目录顺序取第一个并记日志。
 */

/** 编号前缀（与节点 id 的 `n-`、编组的 `g-` 区分开）。 */
export const WORKFLOW_ID_PREFIX = 'wf-'

/**
 * 由工作流名派生一个编号。
 *
 * 算法：FNV-1a（32 位）扫 UTF-16 码元，结果转 36 进制。
 * 选它而不是 `crypto` / `Math.random`：**纯算术**，浏览器与 Node 结果一致，
 * 且不引入任何依赖（客户端半不许 import Node 内置模块）。
 *
 * @param name - 工作流名（存档文件名，或存档里的 `name`）。
 * @returns 形如 `wf-1a2b3c`。
 */
export function deriveWorkflowId(name: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i)
    /* `Math.imul` 保证 32 位乘法在所有引擎上一致（普通 `*` 会掉到浮点、丢精度）。 */
    h = Math.imul(h, 0x01000193)
  }
  return WORKFLOW_ID_PREFIX + (h >>> 0).toString(36)
}

/**
 * 从一份存档里读出编号（读不到给空串）。
 *
 * 存档来源不可信（可能被手改、可能来自别处），所以只认**非空字符串**。
 *
 * @param doc - 存档内容（任意）。
 * @returns 编号；没有/形状不对时给空串。
 */
export function readWorkflowId(doc: unknown): string {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ''
  const raw = (doc as { id?: unknown }).id
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

/** 一份存档里「该用哪个名字算编号」——文件里的 `name` 优先，退回文件名。 */
function idSeededName(doc: unknown, fileName: string): string {
  if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
    const raw = (doc as { name?: unknown }).name
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  }
  return fileName
}

/** 一次「补编号」的结果。 */
export interface IdentifiedDoc {
  /** 处理好之后的存档（**新对象**；原对象不动）。 */
  doc: Record<string, unknown>
  /** 这份存档该用的编号。 */
  id: string
  /** 编号是新派生的（原来没有）。 */
  idAdded: boolean
}

/**
 * 给一份**读出来的老存档**补上编号（不碰文件里的 `name`）。
 *
 * ## 为什么读档时要补（而不是静默跳过）
 *
 * 12 份既有存档全都没有编号。若只在「下次保存」时补，
 * 那它们**永远不会**被补上（用户不改的工作流就不会保存），
 * 引用迁移也就永远没得可用。所以读到就补，并由调用方（`store.ts`）写回磁盘。
 *
 * ## 为什么这里**不改** `name`
 *
 * `name` 是**老节点按名字引用**的最后一个线索：那份被改过名的抖音存档，
 * 文件名是 `取数-抖音电商罗盘`，而 `name` 还是 `抖音表单下载` ——
 * 老引用写的正是后者。把它同步成文件名，老引用就彻底找不到目标了。
 * 所以：**补编号时不动 name，保存时再同步**（`syncDocIdentity`）。
 *
 * @param doc - 存档内容（任意）。
 * @param fileName - 文件名（不含 `.json`），已被 `safeName` 清洗过。
 * @returns 处理结果；`doc` 不是对象时给空文档与空编号。
 */
export function ensureWorkflowId(doc: unknown, fileName: string): IdentifiedDoc {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { doc: {}, id: '', idAdded: false }
  }
  const src = doc as Record<string, unknown>
  const existing = readWorkflowId(src)
  if (existing !== '') return { doc: src, id: existing, idAdded: false }
  const id = deriveWorkflowId(idSeededName(src, fileName))
  return { doc: { ...src, id }, id, idAdded: true }
}

/**
 * 给一份**要写盘的存档**定编号与名字。
 *
 * 两条规矩（各有一个理由）：
 *
 * 1. **名字同步成文件名** —— 列表、打开、再次保存走的全是文件名
 *    （见 `workflow-doc.ts` 的「三个名字」表），文件里的 `name` 只是显示用的冗余副本。
 *    不同步的话，改过名的存档里会永远留着旧名字（那份抖音档就是这样）。
 * 2. **编号沿用**（有就用），没有才派生 —— 「永不变」是引用能跟着走的前提。
 *    改名的实现是「用新名存一份、删旧的」，沿用编号这一条才让它不断引用。
 *
 * @param doc - 要存的存档。
 * @param fileName - 目标文件名（不含 `.json`）。
 * @param id - 要用哪个编号（调用方已查过是否被别人占用）；空串表示自己派生。
 * @returns 处理好的存档与它的编号。
 */
export function syncDocIdentity(
  doc: unknown,
  fileName: string,
  id = '',
): IdentifiedDoc {
  const base: Record<string, unknown> = (doc !== null && typeof doc === 'object' && !Array.isArray(doc))
    ? { ...(doc as Record<string, unknown>) }
    : {}
  const existing = readWorkflowId(base)
  const finalId = id !== '' ? id : existing !== '' ? existing : deriveWorkflowId(fileName)
  const added = readWorkflowId(base) === ''
  base.id = finalId
  base.name = fileName
  return { doc: base, id: finalId, idAdded: added }
}

/** 一个「按编号或名字找一份工作流」的引用（老节点存名字、新节点存编号）。 */
export interface WorkflowRef {
  /** 编号（新写法；优先）。 */
  id?: string
  /** 名字（老写法；编号找不到时才用）。 */
  name?: string
}

/** 档案袋里的一份（给「按编号/名字找」用的最小信息）。 */
export interface RefTarget {
  /** 文件名（= 显示名）。 */
  name: string
  /** 这份存档的编号。 */
  id: string
}

/**
 * 按引用找到一份工作流（**纯函数**，不碰磁盘）。
 *
 * ## 两条判据的顺序（本次改动的核心）
 *
 * 1. **先按编号**找 —— 新写法。编号永不变，改名不影响它。
 * 2. 编号找不到（或压根没填）→ **再按名字**找 —— 老写法。
 *    `legacy: true` 表示这次用的是名字，调用方据此提示用户「下次保存会自动改成编号」。
 *
 * ⚠️ **编号找到了就不再退回名字**：两者都填、而名字指向别的一份时，
 * 以编号为准。这正是「改过名之后引用跟着走」的保证 ——
 * 若名字优先，改完名那一刻引用就跑到新目标去了（或直接断了）。
 *
 * @param ref - 引用（编号 / 名字，至少填一个）。
 * @param targets - 档案袋里的全部工作流。
 * @returns 命中的那一份与命中方式；都没命中给 null。
 */
export function resolveWorkflowRef(
  ref: WorkflowRef,
  targets: readonly RefTarget[],
): { target: RefTarget, matched: 'id' | 'name', legacy: boolean } | null {
  const id = (ref.id ?? '').trim()
  if (id !== '') {
    const hit = targets.find(t => t.id === id)
    if (hit !== undefined) return { target: hit, matched: 'id', legacy: false }
  }
  const name = (ref.name ?? '').trim()
  if (name !== '') {
    /* 名字可能同时命中多份（重名 / 改名留下的副本）→ 取目录顺序第一个，
     * 与「列表里看到的第一份」一致，不静默随机。 */
    const hit = targets.find(t => t.name === name)
    if (hit !== undefined) return { target: hit, matched: 'name', legacy: true }
  }
  return null
}

/**
 * 判定编号唯一性时的输入。
 *
 * 三个字段缺一不可：只比 `id` 分不出「谁该保留」（撞号时要看后两个）。
 */
export interface IdCandidate {
  /** 文件名（不含 `.json`）。 */
  name: string
  /** 存档里的 `name`（没有给空串）。 */
  docName: string
  /** 当前算出来的编号（空串 = 还没算）。 */
  id: string
}

/**
 * 让每一份工作流拿到**互不相同**的编号。
 *
 * ## 为什么必须有这一步（实测撞到过，不是理论问题）
 *
 * 编号是按名字派生的，而「改过名的老存档」里文件名与 `name` 会不一致 ——
 * 于是两份文件可能派生出同一个编号。实测：
 *
 * ```
 * 天猫取数.json          name=天猫取数     → wf-j6dqoj
 * 取数-天猫生意参谋.json   name=天猫取数     → wf-j6dqoj   ← 撞了
 * 抖音表单下载.json        name=抖音表单下载  → wf-x7cfp
 * 取数-抖音电商罗盘.json   name=抖音表单下载  → wf-x7cfp   ← 撞了
 * ```
 *
 * 撞了之后「按编号找 / 跑」都会取到目录里靠前的那一份 ——
 * 用户选的是「取数-天猫生意参谋」，跑起来的可能是「天猫取数」。
 * 那比原来「按名字找」更糟（名字至少还能把重名列出来），所以必须拦住。
 *
 * ## 怎么判（顺序有讲究，别随手改）
 *
 * 编号被多份占用时，**优先保留「文件名 == 存档里的 name」那一份** ——
 * 那正是生成器按声明名字写出来的那份，组合层引用的就是它（用它的编号才对得上）。
 * 被改名的那份改成「按文件名派生」的编号；新编号若也被占了，再加 `-2` / `-3`。
 *
 * ⚠️ **只读不写**：本函数只算「该用哪个编号」，写盘由调用方做。
 *
 * @param items - 全部候选（顺序 = 目录顺序）。
 * @returns 与入参同序的编号数组（互不相同）。
 */
export function dedupeWorkflowIds(items: readonly IdCandidate[]): string[] {
  const ids: string[] = items.map(x => x.id)
  /** 已确定归属的编号（后来的不许再撞）。 */
  const used = new Set<string>()
  /** 编号 → 占着它的下标们。 */
  const byId = new Map<string, number[]>()
  items.forEach((x, i) => {
    if (x.id === '') return
    const list = byId.get(x.id)
    if (list === undefined) byId.set(x.id, [i])
    else list.push(i)
  })

  /* 第一轮：没撞的当场定下；撞了的先挂着，下面挑一份保留原编号。 */
  const pending: { index: number, preferred: string }[] = []
  for (let i = 0; i < items.length; i += 1) {
    const id = items[i].id
    if (id === '') { pending.push({ index: i, preferred: deriveWorkflowId(items[i].name) }); continue }
    const owners = byId.get(id) ?? []
    if (owners.length === 1) { used.add(id); continue }
    const primary = owners.find(k => items[k].docName === items[k].name) ?? owners[0]
    if (primary === i) { used.add(id); continue }
    pending.push({ index: i, preferred: deriveWorkflowId(items[i].name) })
  }

  /* 第二轮：给挂着的分配（避开已用的，必要时加后缀）。 */
  for (const p of pending) {
    const base = p.preferred !== '' ? p.preferred : deriveWorkflowId(items[p.index].name)
    let candidate = base
    let n = 2
    while (used.has(candidate)) {
      candidate = base + '-' + String(n)
      n += 1
    }
    used.add(candidate)
    ids[p.index] = candidate
  }
  return ids
}

/**
 * 把存档里 `flow.workflow` 节点的「按名字引用」批量改成「按编号引用」。
 *
 * ## 为什么放在这里（纯函数）
 *
 * 迁移只在**读存档列表**那一个地方跑（宿主半），但规则要能单测 ——
 * 而「哪个节点的哪个参数是引用」是一条会变的规则，写进 IO 代码里就没法单独验了。
 *
 * ## 只在「该节点还没有编号」时改
 *
 * 有编号的节点一个字节都不动：那是新写法，重写它等于把用户的选择抹掉。
 *
 * @param doc - 存档内容。
 * @param idByName - 名字 → 编号（由调用方用整份档案袋算好）。
 * @returns 迁移后的存档（**新对象**；没有可迁的就原样返回同一个引用）。
 */
export function migrateWorkflowRefs(
  doc: unknown,
  idByName: ReadonlyMap<string, string>,
): { doc: unknown, migrated: number } {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { doc, migrated: 0 }
  const src = doc as Record<string, unknown>
  if (!Array.isArray(src.nodes)) return { doc, migrated: 0 }
  let migrated = 0
  const nodes = (src.nodes as Record<string, unknown>[]).map(raw => {
    if (raw === null || typeof raw !== 'object') return raw
    if (raw.defId !== 'flow.workflow') return raw
    const params = raw.params
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return raw
    const p = params as Record<string, unknown>
    const hasId = typeof p.workflowId === 'string' && p.workflowId.trim() !== ''
    if (hasId) return raw
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (name === '') return raw
    const id = idByName.get(name)
    if (id === undefined) return raw
    migrated += 1
    /* 下一步是**删掉** `name`：它已经是死数据（执行层只认编号），
     * 留着反而会在界面上变成「一个不渲染、却还在存档里的参数」。
     * 显示名由控件按编号从工作流清单里查 —— 不靠存档里这份缓存。 */
    const next: Record<string, unknown> = { ...p, workflowId: id }
    delete next.name
    return { ...raw, params: next }
  })
  if (migrated === 0) return { doc, migrated: 0 }
  return { doc: { ...src, nodes }, migrated }
}
