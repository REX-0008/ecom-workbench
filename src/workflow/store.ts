/** 工作流文件的存与取（宿主半）。
 *
 * 为什么需要：画布上的「保存」此前**只往控制台打印**（函数注释自己写着「落盘后续接宿主半」），
 * 用户辛苦连好的流程一刷新就没了。这个文件把它落到磁盘上。
 *
 * 存到哪：**数据目录**，不进源码目录。
 * 规则来自工作区约定：插件数据放 `$DSH_HOME/profiles/<profile>/data/<插件名>/`。
 * 拿不到那个环境变量时退回「用户主目录下的 .ecom-workbench」——总能落地，不会静默失败。
 *
 * 文件名安全：工作流名会被清洗成安全文件名（去掉路径分隔符与非法字符），
 * 防止「名字里带 ../」把文件写到目录外面去。
 */
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  ensureWorkflowId, syncDocIdentity, migrateWorkflowRefs, readWorkflowId,
  resolveWorkflowRef, dedupeWorkflowIds, type WorkflowRef,
} from './ids.ts'
/* 读存档时顺手纠正老存档里对不上的接入端口名（票 04，画布错误 008）。 */
import { repairEdgeTargets, type EdgeTargetFix } from './edge-targets.ts'
import { NODE_LIBRARY } from '../nodes/index.ts'

/** 存放工作流的子目录名（数据目录之下）。 */
const SUB_DIR = 'workflows'

/** 版本快照的子目录名（在同一个工作流目录下）。
 *
 * 为什么放一起而不是另开目录：快照是「某个工作流的历次版本」，
 * 跟着工作流走最直观；分开存反而要多一层「哪个快照属于哪份工作流」的映射。
 */
const SNAP_DIR = '_snapshots'

/**
 * 解析工作流存放目录。
 *
 * 优先用 dsh 的数据目录（$DSH_HOME/profiles/<profile>/data/<插件>/），
 * 拿不到就退回用户主目录（保证一定能写，而不是报错让用户没法用）。
 *
 * @param dshHome - 数据根目录（可选，测试可注入）。
 * @param profile - 当前 profile 名（可选）。
 * @returns 绝对路径。
 */
export function workflowsDir(dshHome?: string, profile?: string): string {
  /* 测试用沙箱：EWB_TEST_HOME 优先于一切——测试绝不碰真实数据目录。 */
  const sandbox = process.env.EWB_TEST_HOME
  if (sandbox !== undefined && sandbox !== "") return join(sandbox, SUB_DIR)
  const home = dshHome ?? process.env.DSH_HOME
  if (home !== undefined && home !== "") {
    const prof = profile ?? process.env.DSH_PROFILE ?? "desktop"
    return join(home, "profiles", prof, "data", "ecom-workbench", SUB_DIR)
  }
  return join(homedir(), ".ecom-workbench", SUB_DIR)
}

/**
 * 把工作流名清洗成安全文件名。
 *
 * 规则：去掉路径分隔符与 Windows 非法字符，去掉首尾点与空格，空名给兜底名。
 * **这一步是安全边界**——不清洗的话名字里的 `../` 能写到目录外面。
 *
 * @param name - 用户给的工作流名。
 * @returns 安全文件名（不含扩展名）。
 */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .trim()
  return cleaned === "" ? "未命名工作流" : cleaned.slice(0, 80)
}

/**
 * 存一份工作流。
 *
 * ## ⚠️ 写盘时**定编号**（2026-10-19）
 *
 * 存档要带稳定编号 `id`（引用认它，不认名字）。这里做三件事：
 *   1. 有编号就**沿用**（改名的实现是「新名存一份、删旧的」，沿用才不断引用）；
 *   2. 没有就按文件名派生一个（12 份老存档第一次保存时补齐）；
 *   3. 把文件里的 `name` **同步成文件名**（显示名以文件名为准）。
 * 规则本身在 `ids.ts` 的 `syncDocIdentity`（纯函数、可单测），这里只负责写。
 *
 * @param doc - 工作流内容（任意 JSON）。
 * @param name - 工作流名（会清洗）。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 实际写入的路径、清洗后的名字、以及这份存档的编号。
 */
export async function saveWorkflow(
  doc: unknown,
  name: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<{ path: string, name: string, id: string }> {
  const dir = workflowsDir(opts.dshHome, opts.profile)
  const file = safeName(name)
  const path = join(dir, file + ".json")
  const fixed = syncDocIdentity(doc, file)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(fixed.doc, null, 2), "utf8")
  return { path, name: file, id: fixed.id }
}

/**
 * 列已存的工作流（按名字排序）。
 *
 * 目录不存在时返回空数组（不是错误——用户还没存过任何东西）。
 * 单个文件读坏不影响其它文件（跳过坏的，不整批失败）。
 *
 * ## ⚠️ 读的时候**顺手补齐编号与引用**（2026-10-19）
 *
 * 12 份既有存档全都没有编号、`flow.workflow` 节点也全按名字引用。
 * 只在「下次保存」时补的话，用户不改的工作流就永远补不上 ——
 * 于是「按编号引用」这件事等于没做。所以读到就补，**并写回磁盘**：
 *
 *   ① 缺 `id` → 按文件里的 `name`（没有则文件名）派生并写回；
 *   ② 引用还是名字（`params.name`）→ 换成编号（`params.workflowId`）并写回。
 *
 * ⚠️ **两件事都只做一次**：补过之后 `idAdded` / `migrated` 都是 0，不再写盘。
 * 所以列表刷十次也只写第一次（`dom-render` 之外没人会察觉，但别让它变成写放大）。
 *
 * ⚠️ 写回失败**不影响返回**：读得出就照常给界面，
 * 下次再读时还会重试补（补不上不该让列表打不开）。
 *
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 条目数组：名字 + 编号 + 内容。
 */
export async function listWorkflows(
  opts: { dshHome?: string, profile?: string, /**
   * 不在读列表时补写（只读场景用 —— 比如宿主半的「环境检测」）。
   * 默认 `true`：列表页读到就该补齐，否则那件事永远没人做。
   */ noBackfill?: boolean } = {},
): Promise<{ name: string, id: string, doc: unknown, at?: number }[]> {
  const dir = workflowsDir(opts.dshHome, opts.profile)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  /* ── 第一趟：读盘 + 补编号 ─────────────────────────────────────── */
  const out: { name: string, id: string, doc: unknown, at?: number, dirty: boolean }[] = []
  for (const f of files.sort()) {
    if (!f.endsWith(".json")) continue
    const file = f.slice(0, -5)
    try {
      const full = join(dir, f)
      const text = await readFile(full, 'utf8')
      /* 取文件的修改时间给列表用（stat 失败就留空，不影响读取）。 */
      const st = await stat(full).catch(() => null)
      const settled = ensureWorkflowId(JSON.parse(text), safeName(file))
      /* ★ 顺手纠正接入端口名（票 04，2026-10-30）。
       *
       * 为什么列表也要做、而不是只靠 `loadWorkflow`：这两条是**各自读盘**的
       * （这里 `readFile`，那边也是），列表根本不走 `loadWorkflow`。
       * 只在其中一处修，就会出现「列表里看是对的、点开画布还是 008」——
       * 那种「换个入口就不对」最难查。
       *
       * 改过就置 `dirty`，下面第三趟统一写回（这一段本来就有那个写回循环，
       * 不用另起一条写盘路径）。 */
      const repaired = repairEdgeTargets(settled.doc, NODE_LIBRARY)
      out.push({
        name: file,
        id: settled.id,
        doc: repaired.doc,
        at: st === null || st === undefined ? undefined : Math.round(st.mtimeMs),
        /* 补了编号 / 修了端口 → 这份要写回（下面统一写）。 */
        dirty: settled.idAdded || repaired.changed.length > 0,
        /* ⚠️ 注意 `name` 用的是**文件名**，与 `doc.name` 可能是两个值
         * （老存档被改过名时它们不一致，这正是引用断掉的那份）。 */
      })
    } catch {
      /* 单个文件坏了就跳过，不让整批读失败 */
    }
  }

  /* ── 第一趟半：编号必须唯一（2026-10-19 实测撞过，见 `dedupeWorkflowIds`）──
   *
   * 编号按名字派生，而「改过名的老存档」文件名与 `name` 不一致 ——
   * 于是两份文件可能算出同一个编号，按编号找就会跑错份。
   * 这里统一去重并把结果写回存档（改过的那几份 dirty 置真）。 */
  const fixedIds = dedupeWorkflowIds(out.map(x => ({
    name: x.name,
    docName: (x.doc !== null && typeof x.doc === 'object' && !Array.isArray(x.doc))
      ? String((x.doc as { name?: unknown }).name ?? '')
      : '',
    id: x.id,
  })))
  out.forEach((item, i) => {
    if (fixedIds[i] === item.id) return
    item.id = fixedIds[i]
    if (item.doc !== null && typeof item.doc === 'object' && !Array.isArray(item.doc)) {
      item.doc = { ...(item.doc as Record<string, unknown>), id: fixedIds[i] }
    }
    item.dirty = true
  })

  /* ── 第二趟：把「按名字引用」迁成「按编号引用」────────────────────
   *
   * 名字 → 编号的表要用**整份档案袋**算：老引用写的是「当时那个名字」，
   * 而那份工作流现在的文件名可能已经换了。所以**两个名字都收**：
   *   · 文件名（现在的显示名）
   *   · 存档里的 `name`（改名前的老名字，老引用写的就是它）
   *
   * ⚠️ **必须分两轮，且文件名先登记**（这里踩过一次）：
   * 第一版按目录顺序一趟登记两者，结果「天猫取数」这个名字先被
   * `取数-天猫生意参谋.json`（它的 `name` 还叫天猫取数）抢走了 ——
   * 于是「一键下载」里引用「天猫取数」被迁到了**那份改过名的副本**上。
   * 判据应当是：**名字与某份文件名逐字相同时，就指向那份文件** ——
   * 文件名是权威（见 `workflow-doc.ts` 的「三个名字」表），
   * 存档里的 `name` 只是旧副本。
   */
  const idByName = new Map<string, string>()
  for (const item of out) {
    if (item.id === '') continue
    if (!idByName.has(item.name)) idByName.set(item.name, item.id)
  }
  for (const item of out) {
    if (item.id === '') continue
    const docName = (item.doc !== null && typeof item.doc === 'object' && !Array.isArray(item.doc))
      ? (item.doc as { name?: unknown }).name
      : undefined
    if (typeof docName === 'string' && docName.trim() !== '' && !idByName.has(docName.trim())) {
      idByName.set(docName.trim(), item.id)
    }
  }
  for (const item of out) {
    const m = migrateWorkflowRefs(item.doc, idByName)
    if (m.migrated > 0) {
      item.doc = m.doc
      item.dirty = true
    }
  }

  /* ── 第三趟：写回（只写动过的）─────────────────────────────────── */
  if (opts.noBackfill !== true) {
    for (const item of out) {
      if (!item.dirty) continue
      try {
        await writeFile(join(dir, item.name + '.json'), JSON.stringify(item.doc, null, 2), 'utf8')
        item.dirty = false
      } catch {
        /* 写不进去不影响这次返回 —— 下次读还会重试。 */
      }
    }
  }

  return out.map(({ name, id, doc, at }) => ({ name, id, doc, at }))
}

/**
 * 读一份工作流。
 *
 * ## ⚠️ 读的时候**顺手纠正接入端口名**（2026-10-30，票 04）
 *
 * 老存档里的连线还指着改名前那个口（`in`），而现在的节点叫 `path` / `content`。
 * 画布打开就报 `Couldn't create edge for target handle id: "in"`（用户报的 008）。
 *
 * 与上面 `ensureWorkflowId` 那条规矩**有一处刻意不同**，写清楚免得下一个人以为漏了：
 *
 * | | `ensureWorkflowId` | 本次的端口纠正 |
 * |---|---|---|
 * | 读的时候补 | 补 | 补 |
 * | 读的时候写盘 | **不写**，交给 `listWorkflows` 统一写 | **这里就写** |
 *
 * 为什么这次读的时候就写：调用它的不止列表页。`loadWorkflowByRef`（画布打开、
 * 列表页执行、定时跑都走它）也会直接落到这里，而那些路径**不会**经过
 * `listWorkflows` 的写回。若也交给列表页统一写，那么「只打开不看列表」
 * 那条路上修好的东西永远留在内存里 —— 下次打开又得再修一遍，违反幂等。
 *
 * 三条纪律（票面点名）：
 *   ① 只在 `changed` 非空时写 —— 否则每次打开都把修改时间刷成现在，
 *      用户看不出这份工作流到底什么时候改过；
 *   ② 写回失败**不许让打开失败** —— 读到的内容照常返回，只留一句日志。
 *      打不开的代价远大于「这次没存回去」（下次打开还会重试）；
 *   ③ 没改动时返回的仍是原来那一份内容，不重建对象。
 *
 * @param name - 工作流名（会清洗，所以名字里带路径也读不到别处）。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 内容；不存在返回 null。
 */
export async function loadWorkflow(
  name: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<unknown | null> {
  const path = join(workflowsDir(opts.dshHome, opts.profile), safeName(name) + ".json")
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(path, "utf8")) as unknown
  } catch {
    return null
  }
  /* 补编号（读一次补一次，不写盘 —— 写盘由 `listWorkflows` 统一做）。
   * 少了这一步，「只打开不看列表」那条路上拿到的存档仍然没有编号。 */
  const settled = ensureWorkflowId(doc, safeName(name)).doc
  /* 端口纠正：与补编号同一趟，但**写回由这里自己做**（理由见上面的对照表）。 */
  return repairOnRead(settled, path)
}

/**
 * 把「纠正端口名 + 写回」这一段收在一处（`loadWorkflow` 与 `listWorkflows` 共用）。
 *
 * ## 写回失败怎么处理
 *
 * **吞掉，只留一句日志。** 打开这件事不能因为「存不回去」而失败 ——
 * 读得到就是读得到，这次没写回去，下次打开还会再修一遍（纯函数是幂等的）。
 *
 * 日志走 `console.warn`：与画布那边（`canvas-layout.ts:285`）同一个做法。
 * 不往运行记录里塞 —— 这不是「这次运行发生了什么」，是宿主半的一次自修。
 *
 * @param doc - 已经补过编号的存档内容。
 * @param path - 它所在的绝对路径（写回用）。
 * @returns 修好的内容（没改动时是原对象）。
 */
async function repairOnRead(doc: unknown, path: string): Promise<unknown> {
  let rep: { doc: unknown, changed: EdgeTargetFix[] }
  try {
    rep = repairEdgeTargets(doc, NODE_LIBRARY)
  } catch (e) {
    /* 纯函数抛错说明存档形状怪得超出预期。**不影响打开**：原样返回。 */
    console.warn('[ecom-workbench] 接入端口纠正失败（这份存档照常打开）：'
      + (e instanceof Error ? e.message : String(e)))
    return doc
  }
  if (rep.changed.length === 0) return doc
  try {
    await writeFile(path, JSON.stringify(rep.doc, null, 2), 'utf8')
    console.warn('[ecom-workbench] 已纠正 ' + String(rep.changed.length) + ' 条连线的接入端口（老存档里的端口名对不上）：'
      + rep.changed.map(c => c.edgeId + ' ' + c.defId + ' ' + c.from + '→' + c.to).join('；'))
  } catch (e) {
    /* 写不进去不影响这次打开。下一趟读还会重试（纯函数幂等，不会越修越乱）。 */
    console.warn('[ecom-workbench] 接入端口已纠正但没能写回存档（下次打开会再试）：'
      + (e instanceof Error ? e.message : String(e)))
  }
  return rep.doc
}

/**
 * 全部工作流的「名字 + 编号」（给「按编号找一份」用）。
 *
 * ⚠️ 必须走 `listWorkflows`（不是自己 `readdir`）：补编号与引用迁移都在那里，
 * 自己读一遍会拿到没编号的老存档，按编号就找不到。
 *
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 清单（名字 = 文件名）。
 */
export async function listWorkflowRefs(
  opts: { dshHome?: string, profile?: string } = {},
): Promise<{ name: string, id: string }[]> {
  const items = await listWorkflows(opts)
  return items.map(x => ({ name: x.name, id: x.id }))
}

/**
 * 按**编号**读一份工作流；编号找不到时**退回按名字**（老存档 / 老引用）。
 *
 * ## 这条回退是本次改动的兼容层（用户要求的第 4 条）
 *
 * 老存档里 `flow.workflow` 节点存的是名字。`listWorkflows` 会把它们迁成编号，
 * 但两种情况下仍可能只有名字：
 *   ① 那份存档在另一台机器上、还没被读过（没机会迁移）；
 *   ② 用户手改存档、直接写了个名字。
 * 所以这里两条都认 —— **先编号、后名字**，与 `resolveWorkflowRef` 同一个顺序。
 *
 * @param ref - 引用（编号 / 名字）。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 命中信息（含实际用哪个名字读到的）与内容；都没命中给 null。
 */
export async function loadWorkflowByRef(
  ref: WorkflowRef,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<{ name: string, id: string, doc: unknown, legacy: boolean } | null> {
  const refs = await listWorkflowRefs(opts)
  const hit = resolveWorkflowRef(ref, refs)
  /* 编号与名字都没命中 → 再给名字一次机会（可能是一份名字里有非法字符的老档，
   * `safeName` 之后与文件名对不上）。这一条只对名字生效，不影响编号的优先级。 */
  const name = hit === null ? (ref.name ?? '').trim() : hit.target.name
  if (name === '') return null
  const doc = await loadWorkflow(name, opts)
  if (doc === null) return null
  return {
    name,
    id: hit?.target.id ?? readWorkflowId(doc),
    doc,
    legacy: hit === null ? true : hit.legacy,
  }
}

/**
 * 删一份工作流。
 *
 * @param name - 工作流名（会清洗）。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 是否删掉了（本来不存在算 false）。
 */
export async function deleteWorkflow(
  name: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<boolean> {
  const path = join(workflowsDir(opts.dshHome, opts.profile), safeName(name) + ".json")
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/**
 * 存一份版本快照（用户点名的 P3 项）。
 *
 * 快照是**某份工作流在某时刻的样子**，供「改坏了想退回去」用。
 * 文件名带时间戳（精确到秒），所以同一份工作流可以有多个版本的快照。
 *
 * @param name - 工作流名（会清洗）。
 * @param doc - 当时的内容。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 写入的路径与快照名。
 */
export async function saveSnapshot(
  name: string,
  doc: unknown,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<{ path: string, snap: string }> {
  const dir = join(workflowsDir(opts.dshHome, opts.profile), SNAP_DIR, safeName(name))
  /* 时间戳精确到秒：同一秒内连点两次会覆盖，这可以接受（本来就是一秒内的同一个状态）。 */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = join(dir, stamp + '.json')
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(doc, null, 2), 'utf8')
  return { path, snap: stamp }
}

/**
 * 列某份工作流的全部快照（新的在前）。
 *
 * @param name - 工作流名。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 快照名数组（新的在前）。
 */
export async function listSnapshots(
  name: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<string[]> {
  const dir = join(workflowsDir(opts.dshHome, opts.profile), SNAP_DIR, safeName(name))
  try {
    const files = await readdir(dir)
    return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort().reverse()
  } catch {
    return []
  }
}

/**
 * 读一份快照。
 *
 * @param name - 工作流名。
 * @param snap - 快照名。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 内容；不存在返回 null。
 * @throws 快照名非法时抛错（防路径穿越——它是从界面传来的）。
 */
export async function loadSnapshot(
  name: string,
  snap: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<unknown | null> {
  /* 快照名来自界面，必须清洗——否则 ../ 能读到目录外面。 */
  const safe = safeName(snap)
  const path = join(workflowsDir(opts.dshHome, opts.profile), SNAP_DIR, safeName(name), safe + '.json')
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}
