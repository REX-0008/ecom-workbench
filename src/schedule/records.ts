/** 产出归档：把「结束节点声明的产出」落一份到**板块记录**里。
 *
 * ## 为什么要有它（计划 Step 2 第 2 条）
 *
 * 运行历史里**不放**结束节点的产出（用户 m03841 定的，红线）。
 * 但取数板块要「列采集记录」、总览板块要「读巡查结果」—— 它们读的是**板块自己的记录**，
 * 不是运行历史。所以跑完之后要把 `declaredOutputs` **再落一份**到板块目录。
 *
 * | 工作流 | 落到哪 |
 * |---|---|
 * | 采集类（名字不是「巡查-」开头） | `collect/<工作流名>/<时间戳>.json` |
 * | 巡查类（名字以「巡查-」开头） | `patrol/` —— **复用**已有的巡查结果目录 |
 *
 * ## ⚠️ 为什么这个文件住在 `src/schedule/` 里
 *
 * 本轮的边界是「只改 `src/index.ts`、新建 `src/schedule/` 与 `src/notify/`」。
 * 归档有两个写入者：手动跑（`src/index.ts` 的两条跑路）与定时跑（`src/schedule/`）。
 * 两边都要同一份实现（「同一件事写两份迟早漂」，见 `pitfalls/`），
 * 所以它只能落在两处都允许的那一侧。
 *
 * ## ⚠️ `collect/` 这个目录是**共用的**（已知代价，别踩）
 *
 * `collect/` 底下已经住着收藏板块的东西：`skills/`（收藏的 skill 目录）、
 * `notes.json`、`.backup/`。采集记录按 `collect/<工作流名>/` 追加进去，
 * 于是**工作流名不能叫 `skills` 或 `notes`**（会被 `RESERVED` 挡掉并换名）。
 * 计划里给的就是这个路径，前端按它读，所以这里不去另起一个目录名。
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowsDir, safeName, listWorkflowRefs } from '../workflow/store.ts'
import type { NodeReport } from '../dispatch/executors.ts'

/** 插件数据根（`workflows/` 的父目录）。 */
function dataRoot(): string {
  return join(workflowsDir(), '..')
}

/**
 * 采集记录根目录（`collect/`）。
 * @returns 绝对路径。
 */
export function collectRecordsDir(): string {
  return join(dataRoot(), 'collect')
}

/**
 * 巡查结果目录（`patrol/`）—— 与巡查工作流自己写的那份**同一个目录**。
 * @returns 绝对路径。
 */
export function patrolDir(): string {
  return join(dataRoot(), 'patrol')
}

/**
 * `collect/` 底下**不能**当工作流名用的名字（已被收藏板块占着）。
 *
 * 撞上了就加前缀 `wf-` —— 宁可名字丑一点，也不能把 skill 目录写坏。
 */
const RESERVED = new Set(['skills', 'notes', '.backup', 'records'])

/**
 * 一次归档的输入。
 */
export interface ArchiveInput {
  /** 工作流名（作分组键）。 */
  workflowName: string
  /** 结束节点声明的产出；空对象 = 没东西可落。 */
  declaredOutputs?: Record<string, unknown>
  /**
   * 本次运行里各节点**主动报上来的事**（2026-10-25 加，契约 AN）。
   *
   * ## 与 `declaredOutputs` 的关系：两条并存，汇报优先
   *
   * `declaredOutputs` 是**结束节点**声明的那一份（老机制）。汇报是新机制：
   * 每个节点自己报「我做了什么」。两条会并存一段时间 —— 结束节点还在存档里，
   * 按计划等下一轮才删。
   *
   * 并存时的取舍（本条验收第 4 项）：
   *   · 有汇报 → 写 `reports`，**不写** `outputs`；
   *   · 没有汇报 → 退回写 `outputs`（老行为一字不变）。
   * 记录里永远只有其中一个键 —— 两个都写会让读的人不知道该信哪个。
   * 用哪个键本身就是「来源」的标记，不必再加一个 `source` 字段
   * （多一个字段就多一处会写错的地方）。
   */
  reports?: NodeReport[]
  /** 这次成没成（`ok && !aborted`）。 */
  ok: boolean
  /** 谁跑的：`list` / `stream` / `schedule`。 */
  via: string
  /** 运行 id（与运行历史里那条对得上）。 */
  runId: string
  /** 起止时间（毫秒）。 */
  startedAt: number
  endedAt: number
  /**
   * 工作流的固定编号（存档顶层的 `id`，如 `wf-1bzlv0k`）。2026-10-25 加（契约 AJ）。
   *
   * ## 为什么要存编号
   *
   * 目录是按**名字**分的（`collect/<工作流名>/`）。名字一改，老记录的目录名就与新名字
   * 对不上 —— 任务记录里会显示一个「已经不存在」的名字，用户看不出那是同一份。
   * 存下编号之后，读的时候可以拿编号去存档里查**当前**名字，改过名也能显示对的。
   *
   * ⚠️ **目录命名规则不动**（还是按名字）；这个字段只解决「显示哪个名字」。
   * ⚠️ 老记录没有这个字段 —— 读的时候退回目录名，不许因此报错或显示空白。
   */
  workflowId?: string
  /**
   * 失败原因（2026-10-23 加，契约 AD）。
   *
   * ⚠️ **只有 `ok: false` 时给**；成功时**不写这个键**（不写 `undefined`、不写空串）——
   * 与本项目 `llm` / `depth` / `truncated` 同一条纪律：没有的东西不出现，
   * 否则读者还得自己判「有值但看不出来」。
   *
   * 传真实原因，**不要自己拼一句「跑失败了」** —— 用户要的就是「不用回运行历史找」，
   * 自编一句等于什么都没留下。
   */
  error?: string
}

/**
 * 一份工作流算采集类还是巡查类。
 *
 * 判据只有名字前缀一项 —— 理由：`types`（工作流类型标签）是**给人看的**，
 * 计划里明说它「不参与任何执行判断」（见 `src/workflow/workflow-types.ts` 文件头），
 * 拿它决定文件落哪会把「标签改名」变成「记录换目录」。名字前缀是存档的硬事实。
 *
 * @param name - 工作流名。
 * @returns 巡查类给 `patrol`，其余给 `collect`。
 */
export function boardOf(name: string): 'patrol' | 'collect' {
  return name.trim().startsWith('巡查-') ? 'patrol' : 'collect'
}

/**
 * 一次归档里要写的那个文件路径。
 * @param input - 归档输入。
 * @returns 绝对路径（目录已算好，文件还没建）。
 */
/** 采集目录下真正的子目录名（撞上收藏板块的名字时加前缀）。 */
function collectSubDir(workflowName: string): string {
  const safe = safeName(workflowName)
  return RESERVED.has(safe) ? 'wf-' + safe : safe
}

function targetFile(input: ArchiveInput): string {
  /* ## ⚠️ 文件名后缀 = 记录里的 `runId`（2026-10-25 改，契约 AJ）
   *
   * 原来是 `newRunId(input.startedAt)` —— **另造一个编号**当文件名，
   * 而正文里写的是调用方传进来的 `input.runId`。两个值都是
   * 「时间戳 + 4 位随机」，长得像但完全无关 —— 实测磁盘上 5 条**全部对不上**
   * （文件名 `20261023-212005-peht`，记录里 `runId: 20261023-212005-o5ge`）。
   *
   * 于是「按运行编号去找那份任务记录」这件事根本做不到：
   * 从运行历史点进任务记录、或者反过来，只能靠时间戳肉眼比对。
   *
   * 现在直接用 `input.runId` 当文件名。**后缀一定对得上**，因为就是同一个字符串。
   *
   * ⚠️ 老文件不迁移：它们照旧躺在那里（文件名是旧的自造编号），
   * 读的时候按内容读、不依赖文件名，所以照样读得出来。
   * 只是它们无法与运行历史对上号 —— 已经发生的事实，改不了，如实留着。 */
  const stamp = input.runId
  if (boardOf(input.workflowName) === 'patrol') {
    /* 巡查：复用 `patrol/`。文件名 = `<工作流名>-<运行编号>.json`，
     * 与巡查工作流自己写的那份（如 `patrol-tm-shop.json`）**并列不冲突**：
     * 那份是「最近一次的权威结果」（固定名、每次覆盖），
     * 这份是「结束节点声明的产出」（带编号、留历史）。 */
    return join(patrolDir(), safeName(input.workflowName) + '-' + stamp + '.json')
  }
  return join(collectRecordsDir(), collectSubDir(input.workflowName), stamp + '.json')
}

/**
 * 把一次的产出一份落到板块记录。
 *
 * ⚠️ **失败只回报、不抛**：跑都跑完了，记录没落上不该让「执行」报失败
 * （与 `appendRun` 同一条纪律）。
 *
 * ## ⚠️ 为什么这里**没有**串行队列
 *
 * 落盘规则是「读-改-写」才需要排队（`workflow-runs.ts` 那个 `serialize` 是为了
 * 「两份并发各自读到同一份旧数组、后写的盖掉先写的」）。这里每次写的是
 * **一个新文件**（路径里带运行 id），两次运行各写各的、互不覆盖 ——
 * 加一把锁只会让并行的采集互相等待。
 *
 * ## 写不写：分两档看「成没成」与「有没有产出」（2026-10-23 改，契约 AD）
 *
 * | 情况 | 写不写 |
 * | --- | --- |
 * | 成功 + 有产出 | 写 |
 * | 成功 + 没产出 | **不写** |
 * | 失败 + 有产出 | 写 |
 * | 失败 + 没产出 | **写** ← 本次改的核心 |
 *
 * 前三档的理由没变：老存档没有结束节点，`declaredOutputs` 是空对象，
 * 那种情况写一个空 JSON 只会让列表里冒出一堆空条目。
 *
 * **第四档为什么反过来**：失败本身就是一件该留底的事。
 * 实测到的现实 —— `runs\取数-天猫生意参谋.json` 有 7 次运行、5 次失败，
 * 而 `collect\` 里一条记录都没有（失败时 `outputs` 是 0 项，被旧规则整条挡掉）。
 * 用户点开「任务记录」只看到零星几条成功，其余失败**凭空消失**，
 * 只能回运行历史一条条翻。要的正是「事后翻记录时不用再回去找」。
 *
 * ⚠️ 所以：**任务记录会变多**（以前失败的都不见了）。这不是 bug，是这次要的效果。
 * 下一个人看到条目变多、别以为是漏加了判据。
 *
 * @param input - 归档输入。
 * @returns 写成功了没 + 落点（没写时 `path` 为 null）。
 */
export async function archiveOutputs(input: ArchiveInput): Promise<{ path: string | null, reason: string }> {
  const outputs = input.declaredOutputs
  const emptyOutputs = outputs === undefined || outputs === null || Object.keys(outputs).length === 0
  /* 有汇报就走汇报那条路（契约 AN）—— 汇报优先于结束节点声明的产出。 */
  const reports = input.reports !== undefined && input.reports.length > 0 ? input.reports : undefined
  /* 成功且**两条路都没有内容** → 不写（旧规则保持不变，理由见上表）。
   * ⚠️ 判的是「两条都空」：一个节点报了一件事也算有内容，
   * 那种情况绝不能因为没有 `declaredOutputs` 就把记录整条丢掉 ——
   * 那会把「节点主动汇报」这个新功能直接废掉。 */
  if (emptyOutputs && reports === undefined && input.ok) {
    return { path: null, reason: '这次成功但没有结束节点声明的产出（老存档没结束节点），不写空记录' }
  }
  const file = targetFile(input)
  try {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify({
      workflow: input.workflowName,
      runId: input.runId,
      via: input.via,
      ok: input.ok,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      /* 工作流编号（契约 AJ）：有才写，老调用方没传就不写这个键。 */
      ...typeof input.workflowId === 'string' && input.workflowId !== '' ? { workflowId: input.workflowId } : {},
      /* ⚠️ 成功时**不写这个键**；失败但没有原因时也不写（不编一句「跑失败了」）。 */
      ...typeof input.error === 'string' && input.error !== '' ? { error: input.error } : {},
      /* ## 汇报与产出两条路只写一条（契约 AN 验收第 4 项）
       *
       * 有汇报就写 `reports`、**不写** `outputs`；没汇报才退回 `outputs`。
       * 两个都写会让读的人不知道该信哪个 —— 而键名本身就是来源标记。 */
      ...reports === undefined
        ? { outputs: emptyOutputs ? {} : outputs }
        : { reports },
    }, null, 2), 'utf8')
    return { path: file, reason: '已归档到板块记录' }
  } catch (e) {
    return { path: null, reason: '写板块记录失败：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/** 一条采集记录（列表用，读的是归档文件本身）。 */
export interface CollectRecord {
  /**
   * 工作流名（给人看的那一个）。
   *
   * 取值顺序（2026-10-25 改，契约 AJ）：
   *   ① 文件里有 `workflowId` → 拿它去**当前存档**里查名字（改名后显示新名字）；
   *   ② 查不到 / 没有编号 → 退回目录名（`collect/`）或文件内容里的 `workflow`（`patrol/`）。
   * 第 ② 步保证**老记录照旧读得出来**（那些没有 `workflowId`）。
   */
  workflow: string
  /**
   * 这次运行时那份工作流的编号（存档顶层 `id`）。
   *
   * ⚠️ 老记录没有这个键 —— 那时这里是 `undefined`，`workflow` 退回名字。
   */
  workflowId?: string
  /** 文件名 = 运行编号（2026-10-25 起与 `runId` 后缀一致；老文件是旧的自造编号）。 */
  file: string
  /** 绝对路径。 */
  path: string
  /** 落盘时间（文件修改时间，毫秒）。 */
  at: number
  /** 这次成没成。 */
  ok?: boolean
  /**
   * 失败原因（2026-10-23 加，契约 AD）。
   *
   * ⚠️ 落盘文件里**没有这个键**时这里也没有 —— 不补一个空串、不补「未知原因」。
   */
  error?: string
  /**
   * 本次运行各节点主动报上来的事（2026-10-25 加，契约 AN）。
   *
   * ⚠️ 与 `outputs` **互斥**：有 `reports` 的记录里没有 `outputs` 键，反之亦然
   * （由 `archiveOutputs` 保证）。界面据此判「这条记录走的是新机制还是老机制」。
   */
  reports?: NodeReport[]
  /** 结束节点声明的产出（老机制；有 `reports` 时这里没有这个键）。 */
  outputs: Record<string, unknown>
  /**
   * 这份记录落在哪个目录（2026-10-23 加）。
   *
   * 两个目录的产出**形状一样，语义也一样**（都是「结束节点声明的东西」），
   * 所以统一成一种记录返回。留这个字段是给界面用的：
   * 巡查的产出与采集的产出在展示上可能需要区分，而不必再去猜文件名。
   */
  from: 'collect' | 'patrol'
}

/**
 * 编号 → **当前**名字（一次读全、只在本次调用内缓存）。
 *
 * ## 为什么要有这个
 *
 * 目录是按名字分的，名字一改，老记录的目录名就是**已经不存在的旧名字**。
 * 记录里存了 `workflowId` 之后，就能拿编号查出它现在叫什么（契约 AJ 第 3 条）。
 *
 * ## 为什么读失败就当空表
 *
 * 「名字显示得不够新」不该让整张任务记录列表打不开 ——
 * 与这个文件里其它地方「单个坏文件跳过、不让整张列表打不开」同一条纪律。
 *
 * @returns 编号 → 名字；读不出来时是空 Map（调用方据此退回目录名）。
 */
async function currentNameById(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const refs = await listWorkflowRefs()
    for (const r of refs) map.set(r.id, r.name)
  } catch {
    /* 读不到存档清单 → 全部退回名字，不拦列表。 */
  }
  return map
}

/**
 * 一条记录最终显示的名字：有编号且查得到就用**当前**名字，否则退回兜底值。
 *
 * @param byId - 编号 → 当前名字（见 `currentNameById`）。
 * @param id - 记录里的 `workflowId`（可能没有）。
 * @param fallback - 兜底（`collect/` 那侧是目录名、`patrol/` 那侧是文件内容里的名字）。
 * @returns 显示用的名字。
 */
function displayName(byId: Map<string, string>, id: unknown, fallback: string): string {
  if (typeof id !== 'string' || id === '') return fallback
  return byId.get(id) ?? fallback
}

/**
 * `patrol/` 里那些「带 `outputs` 的归档」的文件名后缀（`-<运行编号>`）。
 *
 * 归档文件名是 `safeName(工作流名) + '-' + 运行编号 + '.json'`（见 `targetFile`）。
 * 这里只在**从内容里取不到 `workflow` 键**时才回退到「去掉这个后缀当名字」，
 * 所以正则宽松一点没关系 —— 取不到就是名字带尾巴。
 */
const PATROL_STAMP_SUFFIX = /-\d{8,}.*$/

/**
 * 从落盘 JSON 里取 `reports`，顺便把形状校好。
 *
 * ## 为什么要校验而不是直接 `as`
 *
 * 任务记录是**给用户看的最终产物**，一个坏条目（缺 `message`、`metrics` 里塞了字符串）
 * 会让界面渲染出一片空白或 `NaN`。所以这里按形状过滤：
 * 只留「有非空 `message` 且是对象」的，`metrics` 只留数字，`files` 只留字符串。
 *
 * @param raw - 文件里解析出来的 `reports`（可能是任何东西）。
 * @returns 合格的条目；一条都没有时 `undefined`（不返回空数组）。
 */
function readReports(raw: unknown): NodeReport[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: NodeReport[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    if (typeof r.message !== 'string' || r.message === '') continue
    const metrics: Record<string, number> = {}
    if (r.metrics !== null && typeof r.metrics === 'object' && !Array.isArray(r.metrics)) {
      for (const [k, v] of Object.entries(r.metrics as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = v
      }
    }
    const files = Array.isArray(r.files) ? r.files.filter(x => typeof x === 'string') : []
    out.push({
      message: r.message,
      ...typeof r.label === 'string' && r.label !== '' ? { label: r.label } : {},
      ...Object.keys(metrics).length === 0 ? {} : { metrics },
      ...files.length === 0 ? {} : { files },
      /* `node` 是收集方补的；缺了就写空串，不编一个假编号。 */
      node: typeof r.node === 'string' ? r.node : '',
    })
  }
  return out.length === 0 ? undefined : out
}

/**
 * 读 `patrol/` 里**由 `archiveOutputs` 归档的**那些产出。
 *
 * ## ⚠️ 为什么必须**按内容**判，不能按文件名判
 *
 * `patrol/` 里住着两种形状完全不同的文件：
 *
 * | 文件 | 形状 | 谁写的 |
 * | --- | --- | --- |
 * | `patrol-tm-shop.json` | 有 `blocks` 数组、**没有 `outputs`** | 巡查工作流自己用写文件节点写的，**固定名、每次覆盖** |
 * | `巡查-xxx-<时间戳>.json` | 有 `outputs` | `archiveOutputs` 归档的，**带时间戳、留历史** |
 *
 * 前一种是「最近一次的权威结果」—— 混进历史列表会让同一份巡查出现一堆重复条目，
 * 而且它的 `blocks` 与 `outputs` 语义不同，界面按 `outputs` 排版会对不上。
 *
 * 所以判据是 **`outputs` 是不是一个非空对象**。按文件名判（比如「带不带时间戳」）
 * 会把将来改了命名规则的新文件漏掉，而按内容判不会。
 *
 * ## ⚠️ 失败归档的 `outputs` 可能是空对象（2026-10-23 加，契约 AD）
 *
 * 契约 AD 之后，**失败的运行即使没有产出也落一份记录**，那份记录里 `outputs` 是 `{}`。
 * 只按「非空」判的话，这些失败记录会被**当成固定名那种文件排除掉** ——
 * 也就是「写下去了，但列表里永远看不到」，等于白写。
 *
 * 所以判据补了第二条腿：**空 `outputs` 的记录，看它有没有归档独有的标记**。
 * `archiveOutputs` 写的文件必定带 `runId` 与 `via`（见那个函数），
 * 而巡查工作流自己写的那种固定名文件（`patrol-tm-shop.json` / `tm-sycm.json`）
 * 只有 `job` / `runAt` / `blocks` 之类，**没有这两个键**。实测核对过四份真实文件。
 *
 * 两条腿合起来的效果：
 *
 * | 文件 | `outputs` | 有 `runId`+`via` | 读得到吗 |
 * | --- | --- | --- | --- |
 * | 成功的归档 | 非空 | 有 | 读得到（第一条腿） |
 * | **失败的归档（无产出）** | **空** | **有** | **读得到（第二条腿，本次新增）** |
 * | 固定名结果（`patrol-tm-shop.json`） | 没有这个键 | 无 | 排除（正确） |
 *
 * @param limit - 最多返回几条（调用方已按总量限制，这里只是个上限）。
 * @returns 记录（未排序）。
 */
async function readPatrolRecords(limit: number, byId?: Map<string, string>): Promise<CollectRecord[]> {
  const root = patrolDir()
  let files: string[]
  try {
    files = (await readdir(root)).filter(f => f.endsWith('.json'))
  } catch {
    /* 目录不存在（还没跑过巡查）= 没有记录，不是错误。 */
    return []
  }
  const out: CollectRecord[] = []
  for (const f of files) {
    const path = join(root, f)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as {
        workflow?: unknown, workflowId?: unknown, ok?: unknown, error?: unknown, outputs?: unknown,
        endedAt?: unknown, runId?: unknown, via?: unknown, reports?: unknown,
      }
      /* ★★ 判据（2026-10-25 契约 AN 之后分三种，不再只看 `outputs`）：
       *
       *   ① 老式归档：有 `outputs` 对象 —— 空的话还要求有 `runId`+`via`（契约 AD 那两条腿）；
       *   ② **汇报式归档：没有 `outputs` 键，但有 `reports`** —— 这正是本轮新增的形态，
       *      不认它的话「节点主动汇报」的巡查记录会被**整条丢掉**（写下去了却永远看不到）。
       *   ③ 固定名那份（`patrol-tm-shop.json`）：两者都没有 → 排除。
       *
       * ⚠️ 这一处最容易被漏：`collect/` 那一侧是按目录扫的，不判键；
       * 只有 `patrol/` 这一侧会「因为键的形状不对而跳过」。 */
      const reports = readReports(parsed.reports)
      const hasOutputsKey = parsed.outputs !== null && typeof parsed.outputs === 'object'
        && !Array.isArray(parsed.outputs)
      const outputs = hasOutputsKey ? parsed.outputs as Record<string, unknown> : {}
      const looksArchived = typeof parsed.runId === 'string' && parsed.runId !== ''
        && typeof parsed.via === 'string' && parsed.via !== ''
      if (reports === undefined) {
        if (!hasOutputsKey) continue
        if (Object.keys(outputs).length === 0 && !looksArchived) continue
      }
      const st = await stat(path).catch(() => null)
      /* `workflow` 名：**优先取文件内容里的**（归档时写过，最可靠）。
       * 取不到才退回文件名去掉编号后缀 —— 不从时间戳里切，那样容易切坏。 */
      const named = typeof parsed.workflow === 'string' && parsed.workflow.trim() !== ''
        ? parsed.workflow.trim()
        : f.replace(/\.json$/, '').replace(PATROL_STAMP_SUFFIX, '')
      const workflowId = typeof parsed.workflowId === 'string' && parsed.workflowId !== ''
        ? parsed.workflowId
        : undefined
      out.push({
        /* 有编号就用它查**当前**名字（改名后显示新名）；查不到 / 没编号退回兜底值。 */
        workflow: byId === undefined ? named : displayName(byId, workflowId, named),
        ...workflowId === undefined ? {} : { workflowId },
        file: f,
        path,
        at: typeof parsed.endedAt === 'number' ? parsed.endedAt : (st === null ? 0 : Math.round(st.mtimeMs)),
        ...typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {},
        ...typeof parsed.error === 'string' && parsed.error !== '' ? { error: parsed.error } : {},
        ...reports === undefined ? {} : { reports },
        outputs,
        from: 'patrol',
      })
    } catch {
      /* 坏档跳过（与另一条路同一条纪律：单个坏文件不让整张列表打不开）。 */
    }
    if (out.length >= limit) break
  }
  return out
}

/**
 * 读任务记录（新的在前）。
 *
 * ## 两个目录一起读（2026-10-23 改）
 *
 * 用户原话：「所有有产出的都看得到，巡查本质上也是有产出的。」
 *
 * 但产出落在**两个目录**，而改前这里只扫了 `collect/`：
 *
 * | 谁 | 落在哪 |
 * | --- | --- |
 * | 采集类（名字不是「巡查-」开头） | `collect/<工作流名>/<时间戳>.json` |
 * | **巡查类**（名字以「巡查-」开头） | **`patrol/<工作流名>-<时间戳>.json`** |
 *
 * 于是「任务记录」漏掉了全部巡查产出。现在两边合并、**统一按时间倒序**。
 * `patrol/` 那侧的筛选规则见 `readPatrolRecords`（按内容判，不按文件名判）。
 *
 * ## 两种读法
 *
 *   · 给了 `workflow` → 只读那一份工作流的（`collect/` 侧按目录名、
 *     `patrol/` 侧按内容里的 `workflow` 键或文件名前缀比对）；
 *   · 没给 → 扫 `collect/` 的**每一个子目录**（收藏板块那几样跳过）+ 整个 `patrol/`。
 *
 * ⚠️ 单个文件坏掉就跳过，不让整张列表打不开（与 `loadRuns` 同一条纪律）。
 *
 * @param opts.workflow - 只看哪一份工作流。
 * @param opts.limit - 最多返回几条（默认 200）。
 * @returns 记录（新的在前）。
 */
export async function readCollectRecords(
  opts: { workflow?: string, limit?: number } = {},
): Promise<CollectRecord[]> {
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : 200
  const root = collectRecordsDir()
  const want = (opts.workflow ?? '').trim()
  /* 编号 → 当前名字（只读一次）。改名后靠它把老记录显示成新名字（契约 AJ）。 */
  const byId = await currentNameById()
  let dirs: string[]
  if (want !== '') {
    /* 走同一个派生函数 —— 否则「名字撞上收藏板块」的那几份按名字过滤就查不到。 */
    dirs = [collectSubDir(want)]
  } else {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !RESERVED.has(e.name)).map(e => e.name)
    } catch {
      dirs = []
    }
  }
  const out: CollectRecord[] = []
  for (const dir of dirs) {
    const full = join(root, dir)
    let files: string[]
    try {
      files = (await readdir(full)).filter(f => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const f of files) {
      const path = join(full, f)
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as {
          ok?: unknown, error?: unknown, outputs?: unknown, endedAt?: unknown, workflowId?: unknown,
          reports?: unknown,
        }
        const st = await stat(path).catch(() => null)
        const reports = readReports(parsed.reports)
        const workflowId = typeof parsed.workflowId === 'string' && parsed.workflowId !== ''
          ? parsed.workflowId
          : undefined
        out.push({
          /* 有编号就用它查**当前**名字；没有编号（老记录）退回目录名。 */
          workflow: displayName(byId, workflowId, dir),
          ...workflowId === undefined ? {} : { workflowId },
          file: f,
          path,
          at: typeof parsed.endedAt === 'number' ? parsed.endedAt : (st === null ? 0 : Math.round(st.mtimeMs)),
          ...typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {},
          /* 失败原因：文件里没写就没有这个键（契约 AD）。 */
          ...typeof parsed.error === 'string' && parsed.error !== '' ? { error: parsed.error } : {},
          /* 汇报（契约 AN）：有就带出来，没有这个键。 */
          ...reports === undefined ? {} : { reports },
          outputs: parsed.outputs !== null && typeof parsed.outputs === 'object' && !Array.isArray(parsed.outputs)
            ? parsed.outputs as Record<string, unknown>
            : {},
          from: 'collect',
        })
      } catch {
        /* 坏档跳过 */
      }
    }
  }

  /* ★ 巡查那一侧（`patrol/`）。
   * 给了 `workflow` 时两边都要按名字过滤 —— 只过滤 `collect/` 的话，
   * 「只看这一份巡查」会把它的记录全漏掉。
   *
   * ⚠️ 过滤时要认**两种名字**（契约 AJ）：改过名的工作流，
   * 记录里的 `workflow` 已经被换成**当前**名字，而调用方可能还在用旧名字查
   * （比如目录名 / 文件名前缀）。所以「当前名 == want」与「文件名以 want- 开头」
   * 两条都算命中。 */
  const patrolAll = await readPatrolRecords(limit, byId)
  const patrol = want === ''
    ? patrolAll
    : patrolAll.filter(r => r.workflow === want || r.file.startsWith(safeName(want) + '-'))

  out.push(...patrol)
  out.sort((a, b) => (a.at === b.at ? a.file.localeCompare(b.file) : b.at - a.at))
  return out.slice(0, limit)
}
