/** 电商工作台 · 宿主半（派发器运行处）。
 *
 * 关键设计（理由见 docs/机制-设计依据.md §1；原始调研 docs/调研-派发器现成实现.md）：
 *   - **进程管理走 dsh 自带的 ctx.subprocess**（MIT，base bundle 已注册，第三方插件可 inject）
 *     ——「起子进程 / AbortSignal 取消 / 杀进程树 / 优雅终止 / 超时分类」不用手搓
 *   - **排队走 p-queue**（MIT）——因为 dsh-jobs-local 的并发上限是「拒绝」不是「排队」，
 *     与我们需要的 queued 状态不符，必须在它前面排队
 *   - HTTP 路由走 ctx.inject(['webServer'])，注册 /api/ecom-workbench 前缀（照原 workbench 的做法）
 *
 * 注意（调研钉住的实现点）：terminate() 之后**必须 await waitForExit()**，
 * 只 terminate 会漏掉孙进程（这正是手写 taskkill /T /F 无法保证的）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ExecutorKind } from './dispatch/dispatcher.ts'
import { WorkflowDispatcher } from './dispatch/dispatcher.ts'
import {
  createShellExecutor, createHttpExecutor, createBuiltinExecutor, createAgentExecutor,
  type SpawnLike, type BuiltinFn, type SpawnHandleLike, type AgentDelegate, type AgentDelegateResult,
  type NodeReport,
} from './dispatch/executors.ts'
/* 模型调用留痕（2026-10-23）：形状三方共用一份，这里只产不存。 */
import { truncateTraceText, type LlmTrace } from './dispatch/llm-trace.ts'
import {
  readFileFn, writeFileFn, delayFn, runCodeFn, branchFn,
} from './dispatch/builtins.ts'
/* 节点**实现**表（节点 id → 函数）。随节点目录化挪到了 `src/nodes/impls.ts` ——
 * 那边维护「哪个节点由哪个函数实现」，这里只引它。 */
import { NODE_IMPLS } from './nodes/impls.ts'
import {
  saveWorkflow, listWorkflows, loadWorkflow, loadWorkflowByRef, deleteWorkflow, workflowsDir, safeName,
  saveSnapshot, listSnapshots, loadSnapshot,
} from './workflow/store.ts'
/* 无界面执行：共用的调度器 + 「按工作流文件跑」的接线。
 * 节点定义表也从这里拿（它本来是客户端文件，但**纯数据、零界面依赖**，
 * 宿主半可以直接用 —— 已验证宿主半产物能把它打进去）。 */
import { runWorkflowFile, type RunFileResult } from './workflow/run-file.ts'
/* ── 2026-10-21 新增（计划 Step 11 / Step 12）──────────────────
 * 工作流级并发（排队而不是拒绝）+ 暂停恢复（现场落盘 / 读回继续）。
 * 两件事都只住在宿主半：并发上限管的是整个进程的负载（浏览器、子进程），
 * 现场落盘要碰磁盘 —— 画布那一侧都不该做。 */
import { sharedRunQueue } from './workflow/run-queue.ts'
import { savePausedRun, loadPausedRun, removePausedRun, listPausedRuns } from './workflow/pause-store.ts'
import type { RunSnapshot } from './workflow/snapshot.ts'
/* 工作流执行指纹（票 17）：恢复前核一次「这份档后来改过没有」。 */
import { checkResumeFingerprint } from './workflow/fingerprint.ts'
import { parseInputFields, parseOutputFields } from './workflow/io-fields.ts'
import { readTypes } from './workflow/workflow-types.ts'
import {
  appendRun, loadRuns, clearRuns, listRunNames, newRunId,
  type RunNodeLine, type WorkflowRun,
} from './workflow/workflow-runs.ts'
/* 节点明细的归并键（2026-10-23，「父子同名节点在运行记录里撞车」）。
 * ⚠️ 直接用调度器导出的那一份，不在这里自己拼 `depth + ':' + nodeId` ——
 * 拼法写两遍必然漂（见 `run.ts` 该函数自己的注释）。 */
import { nodeKeyOf } from './workflow/run.ts'

/* 节点事件的归并规则挪到了独立文件（2026-10-25，契约 AR）。
 *
 * 为什么挪：runner.ts 也要用同一份规则，而 index.ts 引用 runner.ts ——
 * 反向 import 会成环。独立文件让两边都依赖它、它不依赖任何一边。
 * 逻辑一个字没改。
 *
 * ⚠️ 用 `import` + `export` 两行，不用 `export ... from`：
 * 后者只把它**转发出去**，不在本模块作用域里引入 —— 本文件自己还要调它
 * （`resumePausedRun` 与 `runCollector` 两处）。 */
import { mergeNodeEvent, type NodeEventLike } from './workflow/node-events.ts'
export { mergeNodeEvent, type NodeEventLike } from './workflow/node-events.ts'

/* ── 模型路由：存储 + 五级回落（2026-10-23，契约 H）──────────────
 *
 * 用户原话：「不是所有的 dsh 模型都读入工作台」。
 * 所以这里有两件事要分清：
 *   - **dsh 的模型目录**（`llm.listProviders` / `listModels`）是**全集**，只读、只用于列表；
 *   - **工作台自己的偏好**（`model-prefs.json`）是**子集**：一个默认 + 一份备选名单，
 *     只有用户挑过的才进名单。
 *
 * 形状与回落顺序定死在计划 `plans/电商AI工作台-2026-10-23-08-计划-模型链路与模板补全.md` §2.2 / §2.4。
 */

/** 一条模型路由（provider + model，两段式，**不用字符串拼 `provider/model`**）。 */
export interface ModelRef {
  /** provider 路由 id（如 `deepseek-official`）。 */
  provider: string
  /** 模型 id（如 `deepseek-v4-flash`）。 */
  model: string
}

/** 工作台的模型偏好（`model-prefs.json` 的形状）。 */
export interface ModelPrefs {
  /** 工作台里设的默认模型（缺省 = 不是没设，见 §2.2 的②③顺序）。 */
  default?: ModelRef
  /** 备选名单：下拉里只出现这份（`picks` 为空 = 只能留空走默认）。 */
  picks: ModelRef[]
}

/** 偏好文件名（插件数据目录下，与 `browser-prefs.json` 同级）。 */
export const MODEL_PREFS_FILE = 'model-prefs.json'

/** 备选名单条数上限（计划 §2.4 定死）。 */
const MAX_PICKS = 20

/**
 * 偏好文件的绝对路径。
 *
 * ⚠️ 用 `workflowsDir` 的父目录 —— 与 `browser-prefs.json` / `notify-prefs.json` /
 * `ui-prefs.json` 同一个写法（`EWB_TEST_HOME` 沙箱与降级路径自动一致），
 * 不在这里另发明一套目录解析。
 *
 * @returns 绝对路径。
 */
export function modelPrefsFile(): string {
  return join(workflowsDir(), '..', MODEL_PREFS_FILE)
}

/**
 * 把任意输入洗成一条可用路由。
 *
 * @param raw - 任意输入（`{ provider, model }` 或 `{ provider, id }`）。
 * @returns 可用路由；字段不合格时 `undefined`（调用方据此**丢掉这一条**，不是整单失败）。
 */
export function asModelRef(raw: unknown): ModelRef | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const provider = typeof o.provider === 'string' ? o.provider.trim() : ''
  /* `model` 是契约名；`id` 是 `LlmModelInfo` 的字段名，顺手也认（界面可能直接转手给过来）。 */
  const modelRaw = typeof o.model === 'string' ? o.model : (typeof o.id === 'string' ? o.id : '')
  const model = modelRaw.trim()
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * 一条路由的稳定键（去重、比较用）。
 *
 * @param r - 路由。
 * @returns `provider` + 分隔符 + `model`。
 */
export function modelRefKey(r: ModelRef): string {
  return r.provider + '\u0000' + r.model
}

/**
 * 把任意输入洗成一份偏好。
 *
 * 坏字段一律**丢掉那一条**并回落到空 —— 与 `ui-prefs` / `notify-prefs` 同一条纪律：
 * 读配置失败不该让任何调用方崩，也不该静默把一个坏值当成好值用。
 *
 * @param raw - 读到的 JSON（可能是 null / 字符串 / 残缺对象）。
 * @returns 偏好（`picks` 一定存在、已去重、已截到上限）。
 */
export function normalizeModelPrefs(raw: unknown): ModelPrefs {
  const empty: ModelPrefs = { picks: [] }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const o = raw as Record<string, unknown>
  const def = asModelRef(o.default)
  /** 名单：逐条洗、去重、截上限（坏条丢掉，不整份作废）。 */
  const picks: ModelRef[] = []
  const seen = new Set<string>()
  if (Array.isArray(o.picks)) {
    for (const item of o.picks) {
      const r = asModelRef(item)
      if (r === undefined) continue
      const k = modelRefKey(r)
      if (seen.has(k)) continue
      seen.add(k)
      picks.push(r)
      if (picks.length >= MAX_PICKS) break
    }
  }
  return def === undefined ? { picks } : { default: def, picks }
}

/**
 * 读工作台的模型偏好。
 *
 * 文件不存在 / JSON 坏 / 字段坏 → 回落到空偏好，**不抛错、不建文件**。
 *
 * @returns 偏好（一定可用）。
 */
export async function readModelPrefs(): Promise<ModelPrefs> {
  try {
    const text = await readFile(modelPrefsFile(), 'utf8')
    return normalizeModelPrefs(JSON.parse(text))
  } catch {
    return { picks: [] }
  }
}

/**
 * 写工作台的模型偏好（**部分更新**）。
 *
 * 只改传进来的字段（`default` / `picks`），其余保持盘上原值。
 * `picks` 会去重、截到上限；坏条丢掉。`default` 传 `null` = **清掉**默认模型。
 *
 * @param patch - 要改的字段（任意输入）。
 * @returns 合并后的完整偏好。
 */
export async function writeModelPrefs(patch: unknown): Promise<ModelPrefs> {
  const base = await readModelPrefs()
  const o = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
    ? patch as Record<string, unknown>
    : {}
  /** 下一份（就字段论字段，没传的保持不变）。 */
  const next: ModelPrefs = { picks: base.picks }
  if (base.default !== undefined) next.default = base.default
  /* `default`：显式传 null = 清掉；传对象 = 覆盖；没传 = 不动。 */
  if ('default' in o) {
    if (o.default === null) delete next.default
    else {
      const d = asModelRef(o.default)
      if (d === undefined) delete next.default
      else next.default = d
    }
  }
  if ('picks' in o) {
    /* 整份替换名单（增删由界面自己算好整份传过来 —— 比逐条增删少一个「找不到那一条」的错误面）。 */
    const normalized = normalizeModelPrefs({ picks: o.picks })
    next.picks = normalized.picks
  }
  const file = modelPrefsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 五级回落里「这一级从哪来」的标记（要写进日志给用户看）。 */
export type RouteSource = 'node' | 'workspace-default' | 'dsh-default' | 'pick' | 'first-available'

/** 「这一级从哪来」的中文说法（写日志用，守 R6：不用第二人称、不用疑问句）。 */
const ROUTE_SOURCE_LABEL: Record<RouteSource, string> = {
  node: '节点选的模型',
  'workspace-default': '工作台设置里的默认模型',
  'dsh-default': 'dsh 的默认模型',
  pick: '备选名单里的第一个',
  'first-available': '自动挑的第一个可用模型',
}

/**
 * 给日志用的一句「路由来源」。
 *
 * @param source - 来源标记。
 * @returns 中文说法。
 */
export function routeSourceLabel(source: RouteSource): string {
  return ROUTE_SOURCE_LABEL[source]
}

/** 五级回落要用的四份输入（都是「查得到就有、查不到就没有」）。 */
export interface RouteSources {
  /** ① 节点上选的（命令体里的 `model`）。 */
  node?: ModelRef
  /** ② `model-prefs.json` 的 default。 */
  workspaceDefault?: ModelRef
  /** ③ dsh 的 `agentDefaultModel.currentSelection()`。 */
  dshDefault?: ModelRef
  /** ④ `model-prefs.json` 的 `picks[0]`。 */
  firstPick?: ModelRef
  /** ⑤ 第一个 provider 的第一个模型。 */
  firstAvailable?: ModelRef
}

/**
 * 按五级回落挑一条路由（**纯函数**，不碰磁盘、不看环境）。
 *
 * 顺序定死在计划 §2.2：
 *
 * ```
 * ① 节点上选的模型
 * ② 工作台设置里的默认模型（model-prefs.json 的 default）
 * ③ dsh 的 agentDefaultModel.currentSelection()
 * ④ 备选名单里第一个（model-prefs.json 的 picks[0]）
 * ⑤ 第一个 provider 的第一个模型
 * ```
 *
 * ⚠️ **② 在 ③ 之前**（计划 §2.2 明写的决定）：工作台设的默认是这个工作台的事，
 * 比 dsh 的全局选择更贴近意图；② 没设过才问 dsh。
 *
 * @param sources - 五级各自的候选（缺哪级就传 `undefined`）。
 * @returns 命中的路由与来源；一级都没命中时 `{ route: null }`。
 */
export function pickRouteFrom(sources: RouteSources): { route: ModelRef, source: RouteSource } | null {
  const order: { source: RouteSource, ref: ModelRef | undefined }[] = [
    { source: 'node', ref: sources.node },
    { source: 'workspace-default', ref: sources.workspaceDefault },
    { source: 'dsh-default', ref: sources.dshDefault },
    { source: 'pick', ref: sources.firstPick },
    { source: 'first-available', ref: sources.firstAvailable },
  ]
  for (const step of order) {
    /* 每一级都按 `asModelRef` 洗一遍 —— 上游给的东西可能是半截的
     * （空串、缺字段），那种**算这一级没有**，往下走，不在这里抛错。 */
    const r = asModelRef(step.ref)
    if (r !== undefined) return { route: r, source: step.source }
  }
  return null
}

/**
 * 把命令体里的 `model` 解析成一条路由。
 *
 * ## 为什么坚持两段式（`{ provider, model }`）而不是 `"provider/model"`
 *
 * 我查了 `LlmModelInfo`（`refs/deepseek-harness@62962ee4/packages/llm/llm/src/types.ts:330-341`）：
 * `id` 的类型是**宽松的 `string`**，协议层**没有禁止**斜杠；而 pi-ai 那条多 provider 通道的
 * provider 名与 model id 都由用户配置（一份 settings 就能写出带斜杠的值）。
 * 用 `/` 拼接时，`"a/b/c"` 到底切成 `a` + `b/c` 还是 `a/b` + `c` 无法判断 ——
 * 那种歧义在真机上表现为「明明选了模型却说找不到」，是最难查的一类。
 *
 * 所以：**存档里存字符串（计划 §2.5 定的，与老存档兼容），运行时按两段式传**。
 * 这里也接受 `"provider/model"` 字符串（**只在恰好一个斜杠时**才切），
 * 多于一个斜杠一律判定格式不合法 → **静默往下跌落**（不是报错）。
 *
 * @param raw - 命令体里的 `model`（字符串 / 对象 / 别的什么）。
 * @returns 路由；格式不合法时 `undefined`（调用方据此往第②级走）。
 */
export function parseCommandModel(raw: unknown): ModelRef | undefined {
  /* ① 首选：两段式对象。 */
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return asModelRef(raw)
  /* ② 兼容：`"provider/model"` 字符串，**只在恰好一个斜杠时**才切。 */
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined
  const parts = text.split('/')
  if (parts.length !== 2) return undefined
  const [provider, model] = parts
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/* ── 模型目录（`GET /models` 的数据来源）────────────────────────────
 *
 * ⚠️ 路由闭包与 `apply` 的 `llm` 注入**不在同一个作用域**（路由在 `ctx.inject(['webServer'])`
 * 里、`llm` 在另一个 `inject` 里），所以这里留一个模块级引用：
 * `apply` 拿到 `llm` 时登记，路由读它。没登记（服务不在）= 目录读不出来，如实返回空。
 */

/** 当前的 `llm` 服务（`apply` 登记；没登记说明服务不在）。 */
let llmService: LlmLike | null = null

/** 当前的默认模型服务（同上）。 */
let defaultModelService: DefaultModelLike | null = null

/** 一条 provider 的目录（`GET /models` 的形状，见计划 §2.4）。 */
export interface ProviderCatalog {
  /** provider 路由 id。 */
  id: string
  /** 给人看的名字（拿不到就用 id）。 */
  name: string
  /** 这个 provider 下的模型（读不出来时是空数组）。 */
  models: { id: string, name: string, description?: string }[]
}

/**
 * 读 dsh 的模型目录 + 工作台的偏好 + dsh 当前选择。
 *
 * ## 为什么一个 provider 失败不影响别的
 *
 * `listModels` 会真的去问 adapter（有的实现要读凭据、有的要联网）。
 * 一个 provider 没配凭据就整份列表失败的话，用户会以为「工作台一个模型都没有」——
 * 而实际上别的 provider 是好的。所以逐 provider `try/catch`，坏的那个给空数组。
 *
 * @returns `{ providers, prefs, current }`（形状见计划 §2.4）。
 */
export async function readModelsCatalog(): Promise<{
  providers: ProviderCatalog[]
  prefs: ModelPrefs
  current: ModelRef | null
}> {
  const prefs = await readModelPrefs()
  const llm = llmService
  const providers: ProviderCatalog[] = []
  if (llm !== null) {
    let list: { id: string, displayName?: string }[] = []
    try {
      list = llm.listProviders()
    } catch { list = [] }
    for (const p of list) {
      if (p === null || typeof p !== 'object' || typeof p.id !== 'string' || p.id === '') continue
      const entry: ProviderCatalog = {
        id: p.id,
        name: typeof p.displayName === 'string' && p.displayName !== '' ? p.displayName : p.id,
        models: [],
      }
      try {
        const models = await llm.listModels(p.id)
        for (const m of models) {
          if (m === null || typeof m !== 'object' || typeof m.id !== 'string' || m.id === '') continue
          entry.models.push({
            id: m.id,
            name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
            ...typeof m.description === 'string' && m.description !== '' ? { description: m.description } : {},
          })
        }
      } catch { /* 这个 provider 读不出来 → 空数组，不影响其他 provider。 */ }
      providers.push(entry)
    }
  }
  /* dsh 当前选中的那个（界面上标「dsh 默认」用）。拿不到给 null。 */
  let current: ModelRef | null = null
  try {
    const pick = defaultModelService?.currentSelection()
    if (pick !== undefined && pick.provider !== '' && pick.model !== '') {
      current = { provider: pick.provider, model: pick.model }
    }
  } catch { current = null }
  return { providers, prefs, current }
}
/* 环境检测的**判定逻辑**（纯函数、可单测）—— 宿主半只提供机器事实。 */
import { scanNodeGaps } from './workflow/env-check.ts'
/* 依赖判定（票 22，2026-10-27）：`NodeDef.deps` 一直是死字段 —— 声明了但没人读。
 * 规则在 `judgeLibrary`（纯函数，可单测），这里只负责「真去探一次」并把它报进 `/env-check`。 */
import { judgeLibrary } from './workflow/deps-check.ts'
/* 浏览器偏好（2026-10-20）：从列表 / 定时启动不经过画布，而存档里没有 port。
 * 那份偏好存在插件数据目录的一个 JSON 里（画布也读写它），宿主半在跑之前读一次补进去。 */
import { PREFS_FILE, normalizePrefs, applyPrefsToSpecs } from './workflow/browser-prefs.ts'

import { NODE_LIBRARY } from './client/workbench/node-library.ts'
/* ⚠️ 「怎么解析 netstat」「怎么并发探端口」是**纯逻辑**，住在客户端的
 * `browser-detect.ts`（那边有单测、也能被浏览器那侧复用）。
 * 宿主半只提供「怎么发那个 HTTP 请求」—— 这正是 `AGENTS.md` 的分层：
 * 能碰网络/磁盘的一侧才做 IO，规则放纯函数里。
 * 与 `NODE_LIBRARY` 同一条路子（那个也是客户端文件、纯数据、宿主半直接用）。 */
/* 浏览器检测（读磁盘 / 探端口 / 问 CDP）**整个搬出去**了（2026-10-17，Step 5 的拆分）——
 * 它与 HTTP 路由、采集面板挤在同一个文件里，改任一件都要翻七百行。
 * ⚠️ 它读 `process.platform`，属于**宿主半的机器事实**，别挪回客户端。 */
import { detectBrowsers, probePort, probeCdp } from './workflow/browser-detect-host.ts'

/* ⚠️ `normalizePort` 仍是**纯规则**（客户端那份），这里只借来归一化手填的端口串。 */
import { normalizePort } from './client/workbench/browser-detect.ts'
import {
  scanSkills, readNotes, writeNotes, readSkillBody, moveSkill, rootInfos, resolveSkillDir,
  type Notes, type MoveDirection,
} from './collect/store.ts'
/* ── 2026-10-21 新增的两块（计划 Step 2 第 2/3 条 + Step 5/6/7）──────
 * 产出归档、采集记录读取、BI 启动、定时执行器、系统通知。
 * 都落在 `src/schedule/` 与 `src/notify/`，本文件只负责「接线」。
 * ⚠️ 归档之所以住在 `src/schedule/` 里，是因为它有两个写入者
 * （这里的跑路 + 定时器），见 `src/schedule/records.ts` 的文件头。 */
import { archiveOutputs, readCollectRecords } from './schedule/records.ts'
/* 巡查结果的只读读路（票 11，2026-10-30）。
 * 为什么单开一个文件：它做的是「按名单认哪几份是巡查结果、按形状分成三栏」，
 * 与采集归档（读 `outputs` / `reports`）是两套判据。混在一起会让 `records.ts`
 * 同时操心两种文件形状 —— 而 `patrol/` 里正好住着三种互不相干的东西。 */
import { readPatrolResults } from './schedule/patrol-results.ts'
/* 产物（图片 / 视频）的存与取（2026-10-25，契约 AV）。
 * 为什么单开一个文件：它管的是「二进制怎么落到磁盘、怎么原样吐回去」，
 * 与采集归档（JSON）是两件事，混在一起会让那个文件同时操心两种介质。 */
import {
  storeArtifact, loadArtifact, listArtifacts, countArtifacts, artifactsDir,
  canvasesDir, materialsDir, genLogsDir, promptCacheDir,
} from './schedule/artifacts.ts'
/* 删产物（契约 BA 才加的那个函数）。**单独一行 import** 而不是并进上面那条：
 * 契约要求这个文件「只许新增、删除列为 0」，改上面那条 import 会算一处修改。 */
import { deleteArtifact } from './schedule/artifacts.ts'
/* 内容板块 Step 4/5 的宿主半（契约 BA，2026-10-25）：生成记录、引用计数、素材库。 */
import { writeGenLog, readGenLog, listGenLogs, deleteGenLog, isGenLogId } from './schedule/gen-logs.ts'
import { artifactUsage } from './schedule/artifact-usage.ts'
/* 提示词源的本地缓存（契约 CG，2026-10-26）。补的是「promptCacheDir 造好了没人用」。 */
import {
  listSources as listPromptSources, readSource as readPromptSource, refreshSource as refreshPromptSource,
} from './schedule/prompt-cache.ts'
/* 生成任务的编排与路由（契约 CC，2026-10-26）。 */
import {
  submitGeneration, getTask, listTasks, cancelTask, listModels, testChannel,
  filterModelsByOp,
  type GenerateInput,
} from './schedule/generate.ts'
import { isGenOp } from './schedule/net-gen.ts'
/* 提及解析是**纯函数**（`src/schedule/mentions.ts`）：界面直接 import 它就行，
 * 不需要宿主提供一条路由 —— 它没有 I/O，也没有要读的存档。
 * 这里不 import，避免「宿主引了却没人用」的空引用。 */
import { listMaterials, saveMaterial, saveTextMaterial, loadMaterial, deleteMaterial } from './schedule/materials.ts'
/* 拉模型清单（2026-10-26，T-B-后端）：三种协议三条真路径。 */
import { fetchChannelModels, COMFY_FETCH_KINDS } from './schedule/model-fetch.ts'
/* 五类默认模型（文本 / 文生图 / 图生图 / 文生视频 / 音频，票 67）。
 * ⚠️ 2026-10-29 之前是四类（`image` 一格管文生图与图生图）。 */
import { readModelDefaults, saveModelDefaults, defaultOf, defaultStatus } from './schedule/model-defaults.ts'
/* 本地存储目录可改。
 * `applyStorageConfig` 是「重启后把盘上的目录配置套回来」的唯一入口 ——
 * 一度没有调用方：用户改了目录、热生效，一重启全回默认，而 `storage.json` 还在。 */
import {
  readStorageConfig, saveStorageConfig, dirsSummary, applyStorageConfig,
} from './schedule/storage-config.ts'
/* 提示词源可配（内置五个删不掉，只能停用）。 */
import {
  listConfiguredSources, addSource, updateSource, deleteSource, probeSource,
} from './schedule/prompt-source-config.ts'
import { PROTOCOLS } from './schedule/channels.ts'
/* 模型类型四类（票 67 建、票 74 退回四类）：`MODEL_TYPES` / `MODEL_TYPE_LABEL` /
 * `typesOfModel` / `isModelType` / `LEGACY_TYPE_ALIAS`（认票 67 的旧取值）。
 * ⚠️ 与上面那个 `CAPS`（四值）**两套并存**，不是替换 —— 理由见 `model-types.ts` 文件头。 */
import { MODEL_TYPES, MODEL_TYPE_LABEL, typesOfModel, isModelType, LEGACY_TYPE_ALIAS } from './schedule/model-types.ts'
/* 内容板块 Step 2/3 的宿主半（契约 AX，2026-10-25）：渠道表、画布项目。
 * 渠道的密钥那条纪律在 `channels.ts` 的文件头写清了 —— 一句话：
 * 密钥存在另一个文件里，任何 GET 的响应都读不到它。 */
import { readChannelsWithKey, saveChannel, deleteChannel, readChannels, channelKey } from './schedule/channels.ts'
import { listCanvases, loadCanvas, saveCanvas, createCanvas, deleteCanvas, isCanvasId } from './schedule/canvases.ts'
import { biStatus, startBi } from './schedule/bi.ts'
import {
  loadTasks, normalizeTask, normalizeTime, newTaskId, seedDefaultTasks, updateTasks,
  type ScheduleTask,
} from './schedule/store.ts'
import { runTaskById, startScheduler } from './schedule/runner.ts'
import { notify, killAll as notifyKillAll, selfcheck as notifySelfcheck } from './notify/index.ts'
/* 提醒档位（2026-10-22）：失败提醒 / 预警节点提醒 / 不提醒三档。
 * 落盘与容错都在那边，这里只用它的读与写。 */
import { readNotifyPrefs, writeNotifyPrefs } from './notify/prefs.ts'
/* 界面偏好（2026-10-22）：「重启桌面端就丢」的那五个开关落到文件。
 * 规则与逐字段容错在那边，这里只用它的读与写。 */
import { readUiPrefs, writeUiPrefs } from './prefs/ui-prefs.ts'

/**
 * 读浏览器偏好文件（插件数据目录下的 browser-prefs.json）。
 *
 * ## 为什么要有这个文件（用户 2026-10-20：「从列表启动找不到浏览器」）
 *
 * 偏好原来只存在**浏览器的 localStorage** 里，宿主半读不到。画布在打开时会把
 * 它写进节点参数，所以从画布跑没问题；而从列表 / 定时任务启动不经过画布，
 * 存档里的 port 是空的 → 驱动报「连不上浏览器的调试端口」。
 *
 * 现在两份都写：localStorage（画布快速缓存）+ 这个文件（宿主半的权威来源）。
 *
 * ⚠️ **读不到不报错**，返回 `null`：偏好缺失不该让整个运行失败 ——
 * 那时驱动会给出「没填端口」的明确提示（比在这里拦更好查）。
 *
 * @returns 偏好（已归一）；文件不存在或坏了返回 null。
 */
async function readBrowserPrefs(): Promise<ReturnType<typeof normalizePrefs> | null> {
  try {
    /* 与工作流存档同级（同一个插件数据目录）。 */
    const dir = join(workflowsDir(), "..")
    const text = await readFile(join(dir, PREFS_FILE), "utf8")
    return normalizePrefs(JSON.parse(text))
  } catch {
    return null
  }
}

export const name = 'ecom-workbench'

/** 内置节点函数表（节点 id → 函数；在 dsh 进程内跑，不另起进程）。
 *
 * ⚠️ **2026-10-12 起挪到了 `src/nodes/impls.ts`** ——
 * 用户把「一个节点一个目录」定为项目基础的文件规划，实现表跟着节点走。
 * 那条「节点 id → 实现」的映射在那边维护，这里只做转发。
 *
 * ⚠️ **不在这里的节点**：
 *   - 循环（`flow.loop`）—— 它由调度器解释执行，不是「派发一个节点」；
 *   - 要起子进程的（code.shell / code.python 等）—— 走 shell 执行方，
 *     它们的「实现」是拼一条命令，不属于内置函数表。 */

/** 派发请求的最小形状（来自客户端 buildCommand）。 */
interface DispatchBody {
  /** 本次运行 id。 */
  runId?: string
  /** 节点实例 id。 */
  nodeId?: string
  /** 派发给谁。 */
  executor?: string
  /** 命令体。 */
  command?: unknown
  /** 上下文。 */
  context?: { workflowId?: string, upstream?: unknown[], workdir?: string, env?: Record<string, string> }
}

/** 派发器单例（宿主半内一个）。 */
let dispatcher: WorkflowDispatcher | null = null

/* ── 节点流订阅表（票 28 第二步，2026-10-27）─────────────────────────
 *
 * ## 它解决什么
 *
 * 票 14 让 agent 节点在宿主半逐片吐字，但那个回调挂在命令体的 `__onStream` 上，
 * 而命令体要过 `JSON.stringify` —— **函数被静静丢掉**。所以画布按 ▶ 那条路
 * （`POST /run`）一个分片都收不到，只能等整段。
 *
 * ## 为什么这里存的不是引擎的回调
 *
 * 过 HTTP 的是**函数**，存一个函数照样传不过去。这里存的是「往某条响应流写」
 * 这个闭包 —— 闭包留在宿主半进程里，根本没有序列化这回事。
 *
 * ## 谁写、谁读
 *
 * - **登记**只发生在 SSE 路由里（用户开订阅时，路由把「往这条响应写」塞进表）；
 * - **读取**只在转发那一处（`createLlmDelegate` 拿到 `__runId` 后按它查表）。
 *
 * ⚠️ **建表只发生在 SSE 路由**：`__runId` 从 HTTP 请求体来、谁都能塞，
 * 所以它**只用来查表，永远不用来建表**。这条分工破了的话，
 * 一个野 runId 就能在表里留一条没人清理的条目（内存泄漏），
 * 而它推的时候也没有任何人在听。 */
type NodeStreamSink = (frame: { kind: 'stream', nodeId: string, text: string }) => void
/** 一条订阅：往哪推、怎么收尾、什么时候建的（TTL 判活用）。 */
interface NodeStreamEntry {
  /** 往那条响应流写。 */
  sink: NodeStreamSink
  /**
   * 结束这条流（发 `done` 帧并关连接）。
   *
   * ## 为什么它必须和 `sink` 一起存在
   *
   * 第一版只有 `sink`，收尾交给「客户端断开」那条回调。那是个**真缺陷**：
   * 节点正常跑完之后宿主半只是把表里的条目删了，那条 SSE **一直不结束** ——
   * 浏览器那边 `EventSource` 等不到终止帧会**自动重连**，于是同一条流被重订一次
   * （`FlowRunPanel.tsx:224` 记着这个坑）。
   *
   * 所以：删条目这件事本身要通知到流上，不能只删不改流的状态。
   */
  finish: () => void
  /** 登记时刻（毫秒）。兜底 TTL 靠它判「多久没动」。 */
  at: number
}
/** `runId` → 订阅。 */
const nodeStreams = new Map<string, NodeStreamEntry>()

/** 兜底 TTL：10 分钟（节点默认超时 300 秒，取两倍足够宽）。 */
export const NODE_STREAM_TTL_MS = 10 * 60 * 1000

/**
 * `runId` 合不合法（`__runId` 是**不可信输入**，它从 HTTP 请求体来）。
 *
 * 三条：非空、长度 ≤ 128、不含换行。
 *
 * ⚠️ 校验的目的不是「防注入」（它只用来查 Map，不拼 SQL 也不拼路径），
 * 而是**别让一个野值有任何机会在表里留下东西**：不合法就当没有，
 * 转发那一处直接跳过，等于这条通道不存在。
 *
 * @param raw - 待查值。
 * @returns 合法就 true。
 */
export function isRunIdShape(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  if (raw === '' || raw.length > 128) return false
  return !/[\r\n]/.test(raw)
}

/**
 * 清掉一条订阅（**幂等**），并**把那条流收尾**。
 *
 * 四条清场路径都会调它，其中「派发抛错」与「客户端断开」可能同时触发。
 *
 * ⚠️ **不许抛错** —— 在 `close` 回调里抛会把那条连接的错误日志弄脏，
 * 而它本来只是「没人听了」这件正常事。
 *
 * ⚠️ 收尾（发 `done` + `end`）**必须在这里做**，不能只 `delete`：
 * 只删条目的话那条 SSE 永远不结束，浏览器 `EventSource` 会**自动重连**
 * （`FlowRunPanel.tsx:224` 记着这个坑），于是同一条流被重订一次。
 *
 * @param runId - 运行 id。
 */
export function dropNodeStream(runId: string): void {
  const entry = nodeStreams.get(runId)
  /* 先删再收尾：`finish` 里若同步触发别的东西，也不该看到一个还在表里的条目。 */
  try { nodeStreams.delete(runId) } catch { /* 不该发生；真发生了也不许冒出去 */ }
  if (entry === undefined) return
  try { entry.finish() } catch { /* 流已经没了 */ }
}

/**
 * 扫一遍，清掉超过 TTL 没动的条目。
 *
 * 前三条清场路径都要求「有地方会执行到」：节点跑完、派发抛错、客户端断开。
 * 进程在节点中途卡死时**一条都不触发**，表里的条目就永远留着。
 *
 * @param now - 当前时刻（测试注入用）。
 * @returns 清掉几条。
 */
export function sweepNodeStreams(now: number = Date.now()): number {
  let n = 0
  for (const [runId, entry] of [...nodeStreams.entries()]) {
    if (now - entry.at < NODE_STREAM_TTL_MS) continue
    dropNodeStream(runId)
    n += 1
  }
  return n
}

/**
 * 取（必要时建）派发器。
 * @returns 派发器实例。
 */
function getDispatcher(): WorkflowDispatcher {
  if (dispatcher === null) {
    dispatcher = new WorkflowDispatcher({ concurrency: 2, timeoutMs: 300000 })
    dispatcher.register(createHttpExecutor())
    dispatcher.register(createBuiltinExecutor(NODE_IMPLS))
  }
  return dispatcher
}

/**
 * 把一次节点派发交给本地派发器（`runWorkflowFile` 要的那个形状）。
 *
 * ## 为什么要单独一个函数
 *
 * 同一段适配现在有**三处**调用者（SSE 那条跑路、列表那条跑路、定时执行器），
 * 原先前两处各写了一遍一模一样的对象字面量。第三处（定时）如果照抄，
 * 就是三份 —— 改一处漏两处，症状是「某个入口跑出来跟别处不一样」，极难查
 * （见 `pitfalls/同一件事写两份迟早漂.md`）。
 *
 * @param req - `runWorkflowFile` 递过来的派发请求。
 * @param signal - 取消信号。
 * @returns 派发结果（形状见 `RunOutcome`）。
 */
async function dispatchNode(req: {
  runId: string
  nodeId: string
  executor: string
  command: unknown
  context: { workflowId: string, upstream: unknown[], workdir: string, env?: Record<string, string> }
  /* 本节点的超时（契约 AV Step 0.3）。调度层将来给得出就透传，给不出就不写 —— 
   * 派发器那边不填时走全局兜底，与改动前一致。 */
  timeoutMs?: number
}, signal?: AbortSignal) {
  const out = await getDispatcher().dispatch({
    runId: req.runId,
    nodeId: req.nodeId,
    executor: req.executor as ExecutorKind,
    command: req.command,
    context: req.context,
    ...req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs },
    signal,
  })
  return {
    ok: out.status === 'success',
    status: out.status,
    output: out.output,
    logs: out.logs,
    error: out.error,
    /* ## 汇报必须**原样交回给调度器**（2026-10-25，契约 AN）
     *
     * 引擎在 `run.ts:1320` 做的是 `for (const entry of outcome.reports ?? []) emit({kind:'report', ...})`。
     * 这里不漏出去的话，那一步永远拿到空数组 —— 汇报在**派发层与调度层之间**就断了，
     * 而「内置执行方确实收到了 report」之类的断言照样是绿的。
     *
     * ⚠️ 没有汇报时**不写这个键**（与 `llm` 同一条纪律），所以用条件展开而不是 `reports: out.reports`。 */
    ...out.reports === undefined ? {} : { reports: out.reports },
  }
}

/**
 * 从已收集的节点明细里汇总汇报（契约 AN）。
 *
 * ## 为什么从明细里取，而不是在执行方那一侧另攒一份
 *
 * 明细里的 `reports` 是引擎那条事件流（`run.ts:1320` → `mergeNodeEvent`）攒出来的，
 * 运行历史界面显示的就是它。任务记录若另攒一份，同一个事实就有两个来源 ——
 * 迟早出现「历史里有三条、任务记录里两条」这种没人解释得清的分歧。
 *
 * 取明细还白得两个好处：
 *   · `node` 是画布编号（明细的键），与运行历史对得上；
 *   · 子工作流里报的会挂在**子流程那个节点**名下（明细的 `depth` 已经把它分开）。
 *
 * ⚠️ 一条都没有时返回空数组，调用方据此**不写这个键**
 * （与 `llm` / `depth` 同一条纪律）。
 *
 * @param nodes - 已收集的节点明细。
 * @returns 汇总后的汇报（按明细顺序、节点内按到达顺序）。
 */
function collectReports(nodes: readonly RunNodeLine[]): NodeReport[] {
  const out: NodeReport[] = []
  for (const line of nodes) {
    for (const entry of line.reports ?? []) out.push({ ...entry, node: line.nodeId })
  }
  return out
}

/**
 * 把 dsh 的 ctx.subprocess 适配成我们的 SpawnLike（只做形状转换，不加逻辑）。
 *
 * dsh 的规格**不给默认值**（源码原话：this seam applies no defaults），所以这里必须把
 * stdio 与 graceMs 补全，否则 spawn 会直接抛错：
 *   - stdout/stderr 用 collect 模式（带内存上限），这样读输出不是消费式的，settle 后还能读
 *   - stdin 归零（'ignore'），我们不喂输入
 *   - graceMs 是「终止时留给进程的清理时间」，取 3 秒
 *
 * @param sub - dsh 的 subprocess 服务。
 * @param workdir - 没给 cwd 时的兜底目录（dsh 要求 cwd 必填）。
 * @returns SpawnLike 实现。
 */
function adaptSubprocess(sub: SubprocessLike, workdir: string): SpawnLike {
  return {
    spawn(spec): SpawnHandleLike {
      const h = sub.spawn({
        argv: spec.argv,
        cwd: spec.cwd !== undefined && spec.cwd !== '' ? spec.cwd : workdir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: COLLECT_BYTES },
          stderr: { maxBytes: COLLECT_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        env: spec.env,
        signal: spec.signal,
      })
      /* 直接用 dsh 句柄上的 collect 读取器（偏移式、非消费式，settle 后照样能读），
       * 转成执行方要的「取一段文本」形状。 */
      const read = (name: 'stdout' | 'stderr'): string => {
        try { return h.collected[name]?.readFrom(0).text ?? '' } catch { return '' }
      }
      const handle: SpawnHandleLike = {
        pid: h.pid,
        terminate: () => { try { h.terminate() } catch { /* 已退出 */ } },
        waitForExit: () => h.waitForExit(),
        done: h.done,
        stdoutText: () => read('stdout'),
        stderrText: () => read('stderr'),
      }
      return handle
    },
  }
}

/** subprocess 服务的形状（dsh 的 ctx.subprocess；已核实源码）。 */
interface SubprocessLike {
  /**
   * 启动一个受管进程。
   * @param spec - 完整规格（argv / cwd / stdio / graceMs / env / signal，**不给默认值**）。
   * @returns 进程句柄。
   */
  spawn: (spec: unknown) => DshHandleLike
}

/** dsh 进程句柄的形状（只写我们用到的那几项；已核实 dsh 源码）。 */
interface DshHandleLike {
  /** 进程 id（可能没有）。 */
  pid?: number
  /** 请求终止（幂等）。 */
  terminate: () => void
  /** 等整棵进程树清空。 */
  waitForExit: (signal?: AbortSignal) => Promise<boolean>
  /** 进程退出事实。 */
  done: Promise<{ exitCode: number | null, signal: string | null }>
  /** 采集模式下的输出读取器（偏移式、非消费式）。 */
  collected: {
    /** 标准输出读取器（采集模式才有）。 */
    stdout?: { readFrom: (fromByte: number) => { text: string } }
    /** 标准错误读取器（采集模式才有）。 */
    stderr?: { readFrom: (fromByte: number) => { text: string } }
  }
}

/** 每次采集输出的内存上限（32 KB 够看诊断；超出保留尾部）。 */
const COLLECT_BYTES = 32 * 1024

/** 终止时留给子进程的清理时间（毫秒）。 */
const TERMINATE_GRACE_MS = 3000

/** llm 服务里我们用到的形状（dsh 的 ctx.llm；已核实 asar 里 `LlmRuntime` 的方法表）。 */
interface LlmLike {
  /** 流式一次模型调用（`waterfall` 包装过，插件按普通异步迭代器用即可）。 */
  stream: (options: unknown) => AsyncIterable<LlmChunk>
  /** 已注册的 provider 路由（`{ id, displayName, … }`）。 */
  listProviders: () => { id: string, displayName?: string }[]
  /** 某个 provider 下的模型目录（`LlmModelInfo`：`provider` / `id` / `name` / `description?`）。 */
  listModels: (provider: string) => Promise<{ id: string, name?: string, description?: string }[]>
}

/** 模型流里的一个分片（只写我们读的那几种）。 */
type LlmChunk =
  | { type: 'text-delta', index: number, text: string }
  | { type: 'block-end', index: number, block: { type: string, text?: string } }
  /* usage 按契约在 `finish` **之前**到达（官方 `types.ts:458`「usage precedes finish」）。
   * 三个字段的语义见 `writeUsage` 的注释：计数**互斥**，且可能整块不给。 */
  | {
    type: 'usage'
    usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number }
  }
  | { type: 'finish', reason: { kind: string, failure?: { message?: string, code?: string } } }

/** 默认模型选择服务（dsh 的 ctx.agentDefaultModel）。 */
interface DefaultModelLike {
  /** 当前选中的 provider / model（用户在界面上选的那一份）。 */
  currentSelection: () => { provider: string, model: string }
}

/** webServer 服务的形状。 */
interface WebServerLike {
  /** 主机。 */
  host: string
  /** 端口。 */
  port: number
  /** 注册一条路由（返回清理函数）。 */
  register: (o: { kind: string, path: string, handler: (req: unknown, res: unknown) => Promise<void> }) => () => void
}

/**
 * 在系统的文件管理器里打开一个目录（用户 2026-10-11 要求）。
 *
 * 为什么用 `node:child_process` 而**不用 `ctx.subprocess`**：
 * ctx.subprocess 是给「受管任务」用的（要给全 stdio/graceMs、要能取消、会被记账），
 * 而这里只是**放一个 GUI 窗口**、进程立刻退出、我们不等也不看它 —— 借用那套反而
 * 要多写规格、还会在任务列表里留下一条无意义的记录。用子进程直接起更贴合。
 *
 * 三平台各自的标准做法（不是只在 Windows 能用）：
 *   Windows `explorer <dir>` ｜ macOS `open <dir>` ｜ Linux `xdg-open <dir>`
 *
 * **失败不抛**：打不开文件管理器不该让「打开目录」这个操作报错到界面上——
 * 调用方拿到的 `ok:true` 表示「已经请求打开了」，而路径本身已经回给界面。
 *
 * ## 测试闸门（`EWB_TEST_NO_SPAWN`）
 *
 * `tests/host-dispatch.mjs` 会**走真路由**验「打开目录」/「打开 skill 目录」。
 * 没有闸门的话，每跑一次测试就会**真的弹出资源管理器窗口** —— 那是很讨厌的副作用
 * （跑一次测试开好几个窗口），但直接把这条路由从测试里跳过又等于没验。
 *
 * 所以加一个**只认环境变量**的闸门：设了 `EWB_TEST_NO_SPAWN=1` 就只记录、不真起进程。
 * 这与 `EWB_TEST_HOME` / `EWB_TEST_SKILLS` 是同一类做法（测试沙箱）。
 * ⚠️ 它**只影响「起进程」这一下**；路径解析、安全清洗、路由装配全部照跑，
 * 所以测试仍能验到真正重要的部分（路径算得对不对、只不收路径）。
 */
function openInFileManager(dir: string): void {
  /* 测试闸门：只记录不弹窗（见上面的说明）。 */
  if (process.env.EWB_TEST_NO_SPAWN === '1') {
    lastOpenedDir = dir
    return
  }
  try {
    /* 用 spawn 且 detached + 忽略 stdio：父进程不等它、也不占管道。 */
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => { /* 起不来就算了，界面已拿到路径 */ })
    child.unref()
  } catch {
    /* 同上：静默 —— 调用方仍然拿到路径，可以自己复制 */
  }
}

/**
 * 最近一次「请求打开」的目录（**只在测试闸门开着时**被赋值）。
 *
 * 用途：测试要确认「算出来的路径对不对」，而在闸门模式下没有进程可观察。
 * 导出一个只读的取值函数（见文件末尾），避免测试去读模块私有变量。
 */
let lastOpenedDir = ''

/**
 * 取最近一次「请求打开」的目录（测试用）。
 * @returns 目录路径；没开闸门或还没调用过时是空串。
 */
export function lastOpenedDirForTest(): string {
  return lastOpenedDir
}

/**
 * 读一个请求的 JSON 体（上限 8 MB，够传一批节点参数）。
 *
 * @param req - 请求。
 * @returns 解析好的 JSON（空体给空对象）。
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 8 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * 恢复之前先看一眼前提（票 17）：工作流存档还是不是挂起时那一份。
 *
 * ## 为什么单独一个函数，而不是直接塞进 `resumePausedRun`
 *
 * 它要在**删现场之前**跑完。`resumePausedRun` 的第一步是删现场（那条纪律没错），
 * 而拒绝必须发生在删之前 —— 否则用户按拒绝理由去「改回挂起时的样子再点继续」时，
 * 现场已经没了。把这段抽出来，调用点的顺序就一目了然，不必在长函数里找。
 *
 * ## 判据只有一处实现
 *
 * 真正的比对在 `run-file.ts`（`checkResumeFingerprint`）—— 那里同时拿得到
 * 存档原文与现场，是唯一该放判据的地方。这里做的只是**提前读一次存档**
 * 喂给同一个函数，不复制它的规则。
 *
 * 读存档失败 / 存档已经不在 → **放行**。那种情况下面 `runWorkflowFile`
 * 自己会报「没有这份工作流」，不必在这里再编一个理由
 * （编了就是两份口径，而这一份还更不准）。
 *
 * @param snap - 现场。
 * @returns `ok: true` 放行（`legacy` 表示老现场没法核）；`ok: false` 带原因。
 */
async function previewResumeFingerprint(
  snap: RunSnapshot,
): Promise<{ ok: true, legacy: boolean } | { ok: false, reason: string }> {
  if (snap.fingerprint === undefined || snap.fingerprint === '') return { ok: true, legacy: true }
  let doc: unknown
  try {
    const hit = await loadWorkflowByRef({ name: snap.workflowId })
    if (hit === null) return { ok: true, legacy: false }
    doc = hit.doc
  } catch {
    /* 存档读不出来：交给下面 `runWorkflowFile` 报它自己那句（口径只有一份）。 */
    return { ok: true, legacy: false }
  }
  return checkResumeFingerprint(snap.fingerprint, doc)
}

/**
 * 恢复一份挂起的运行：读回现场，从挂起点继续。
 *
 * ## 为什么是「重新调 `runWorkflowFile`」而不是「把那个 Promise 接着跑」
 *
 * 挂起时**那次运行已经结束了**（函数返回、栈都散了）。跨重启更是连进程都没了。
 * 所以恢复 = 拿现场 + 存档**从头调一次调度器**，由它按 `resume` 跳过前半段
 * （见 `RunGraphInput.resume` 的三条语义）。n8n 的 Wait 也是这个形态
 * ——挂起时把执行数据存库、恢复时**重新载入**。
 *
 * ## 五个必须做对的地方
 *
 * 1. **先删现场再跑**：跑的过程中若又挂一次（第二个等待节点），会写下新的一份。
 *    不删的话两份并存，「哪个是当前的」就说不清了。
 * 2. **运行记录要新建一条**（不是改原来那条）：恢复是一次**新的运行**
 *    ——它有新的开始时间、可能又有新的失败。原来那条留着，让人能看出
 *    「先挂起、后继续」这两段（用户要的「等待中」就是看那条）。
 * 3. **名字用现场里的 `workflowId`**：恢复入口可能只给了 `id`，
 *    而运行历史的分组键是名字 —— 两边不一致会分到两个组里。
 * 4. **失败要报出来**：恢复失败时用户得知道是哪一份、为什么，
 *    不能只在服务端留个静默（他等了几小时的东西）。
 * 5. **不走队列就并发失控**：与「新点一次执行」是同一类负载，共用同一个队列。
 *
 * @param snap - 现场。
 * @param via - 谁触发的（`auto` 定时器 / `manual` 界面点继续），只用于显示。
 * @returns 结果（`ok` + 一句话 + 新的运行 id）。
 */
async function resumePausedRun(
  snap: RunSnapshot,
  via: 'auto' | 'manual',
): Promise<{ ok: boolean, summary: string, runId: string, waiting?: boolean, resumeAt?: number, rejected?: boolean }> {
  const startedAt = Date.now()
  const id = newRunId(startedAt)
  const byNode = new Map<string, RunNodeLine>()
  /* 归并规则只有一份（`mergeNodeEvent`）—— 与 `/workflow/run-stream` 的
   * `runCollector` 调的是**同一个函数**，别再在这里抄一遍那些分支。 */
  const feed = (e: NodeEventLike): void => { mergeNodeEvent(byNode, e) }

  /* ★ 先核工作流指纹，**核过才删现场**（票 17，2026-10-27）。
   *
   * ## 为什么必须先核、后删
   *
   * 下面第一件事就是 `removePausedRun`（那条纪律本身没错：恢复完就不该留旧现场）。
   * 但如果**拒绝**发生在删之后，用户按拒绝理由去「把工作流改回挂起时的样子，
   * 再点一次继续」时会发现现场已经没了 —— 一句让人照做、却做不成的话，
   * 比不给理由更坏。所以核不过就**原样留着现场**，让人有机会改回来。
   *
   * ## 只对 manual 核，auto 走原样
   *
   * 自动恢复（扫盘器到点捡起来）如果也在这里拒，一次「工作流改过」就会让
   * 那份现场**每一轮都被捡起来、每一轮都被拒**，直到有人手动点取消。
   * 所以自动恢复这条路不核 —— 它落在 `runWorkflowFile` 里那道核上
   * （那里对**所有**恢复入口生效，包括 auto），结果一样是拒绝，
   * 但`resumePausedRun` 这一层不额外做第二次判断。
   *
   * ## 判据在哪
   *
   * 真正比对的实现在 `run-file.ts` 的 `checkResumeFingerprint` 调用点 ——
   * 那里是唯一同时拿得到「存档原文」与「现场」的地方。
   * 这里做的只是「别把现场提前删掉」。 */
  const gate = await previewResumeFingerprint(snap)
  if (gate.ok === false) {
    /* ★ 留现场、但**做个记号**（票 17，2026-10-27）。
     *
     * 不记号的话，自动恢复每 30 秒扫一遍盘，会把这份现场**每一轮都捡起来、
     * 每一轮都拒一次** —— 用户每分钟收到一条「恢复失败」通知，
     * 一次改动变成持续噪音，直到他手动点取消。
     *
     * 记号只服务于**自动恢复**这条路（下面 `beat` 里跳过）。
     * 用户手动点「继续」时**照样会重新核一次**：那时如果他已把工作流改回挂起时的样子，
     * 核过就放行（放行会把现场删掉，记号自然跟着消失）—— 这是拒绝理由里
     * 「改回来可以再点继续」那句话能成立的前提。 */
    await savePausedRun({ ...snap, resumeBlocked: gate.reason })
    return { ok: false, summary: gate.reason, runId: '', rejected: true }
  }

  /* ① 删现场（理由见上）。删不掉不拦 —— 下面的「又挂一次」会把它覆盖成新的。 */
  await removePausedRun(snap.runId)

  const res = await sharedRunQueue().run(snap.workflowId, async () => runWorkflowFile(
    { name: snap.workflowId },
    NODE_LIBRARY,
    dispatchNode,
    {
      workdir: process.cwd(),
      /* 偏好读不到不该让恢复失败 —— 那时驱动会给「没填端口」的明确提示。 */
      prefs: await readBrowserPrefs().catch(() => null) ?? undefined,
      resume: snap,
      runId: id,
      startedAt,
      onEvent: (e) => { feed(e as { kind: string, nodeId: string }) },
    },
  )).catch((e: unknown): RunFileResult => ({
    /* 队列拒绝（同一份已在跑/在排）也走这里。返回类型显式标 `RunFileResult`：
     * 不标的话 TS 会把两路合成联合类型，下面取 `res.paused` 报「属性不存在」（已踩）。 */
    ok: false, ran: [], aborted: false, missingTypes: [],
    error: e instanceof Error ? e.message : String(e),
  }))

  const succeeded = res.ok && !res.aborted
  const waiting = res.paused !== undefined
  const summary = waiting
    ? '又挂起了（等下一个条件）'
    : succeeded ? '继续跑完了（' + String(res.ran.length) + ' 个节点）' : '继续时失败：' + (res.error ?? '有节点失败并中断')

  /* ② 运行记录：**新建一条**（理由见上）。名字用现场里的那份。 */
  const name = res.name ?? snap.workflowId
  const record: WorkflowRun = {
    id,
    name,
    startedAt,
    endedAt: Date.now(),
    ok: succeeded,
    ...res.aborted ? { aborted: true } : {},
    ran: res.ran,
    nodes: [...byNode.values()],
    via: 'resume-' + via,
    ...res.error === undefined ? {} : { error: res.error },
    ...res.inputs === undefined ? {} : { inputs: res.inputs },
    ...res.declaredOutputs === undefined ? {} : { outputs: res.declaredOutputs },
    /* 又挂起：把**新的**现场存下来（旧的那份上面已经删了）。 */
    ...res.paused === undefined ? {} : { waiting: true, resumeAt: res.paused.wait.resumeAtMs },
  }
  if (res.paused !== undefined) {
    const savedSnap = await savePausedRun(res.paused)
    if (!savedSnap) {
      /* 存不下就当失败 —— 假装挂起的话用户会等一个永远不来的恢复。 */
      record.ok = false
      record.waiting = false
      delete record.resumeAt
      record.error = '运行现场存不下（磁盘？），这次没法继续恢复 —— 当成失败处理'
    }
  }
  await appendRun(record)

  /* ③ 产出归档：**真跑完就写**（成功要看有没有产出，失败一律写 —— 见 `archiveOutputs` 的分档表）。
   * 挂起时产出是半截的，写进去等于污染板块记录，所以挂起这条路仍然跳过。 */
  if (!waiting) {
    await archiveOutputs({
      workflowName: name,
      ...res.declaredOutputs === undefined ? {} : { declaredOutputs: res.declaredOutputs },
      /* 本次运行的节点汇报（契约 AN）：从**已收集的节点明细**里汇总，
       * 与运行历史里显示的是同一份数据（不另攒一条通道）。 */
      ...collectReports([...byNode.values()]).length === 0
        ? {}
        : { reports: collectReports([...byNode.values()]) },
      ok: succeeded,
      /* 工作流编号（契约 AJ）：改名后靠它对上当前名字。 */
      ...res.id === undefined ? {} : { workflowId: res.id },
      /* 失败原因取**真实那条**（`record.error` 是这段逻辑上面刚写进运行记录的那句：
       * 跑失败时是工作流执行方的报错，现场存不下时是那句磁盘说明）。不许自编。 */
      ...succeeded ? {} : { error: record.error },
      via: 'resume-' + via,
      runId: id,
      startedAt,
      endedAt: Date.now(),
    })
  }

  return {
    ok: succeeded || waiting,
    summary,
    runId: id,
    ...res.paused === undefined ? {} : { waiting: true, resumeAt: res.paused.wait.resumeAtMs },
  }
}

/**
 * 建一个「把提示词交给模型」的委派函数（`agent` 执行方用）。
 *
 * ## 为什么是直接调 `ctx.llm.stream`
 *
 * 见 `apply()` 里那段长注释：`ctx.subagents` 要一个活的 Agent 当 parent，
 * 而我们的三条触发路径都不经过 agent。`ctx.llm` 只要 provider + model + messages，
 * 不碰 Agent、不落会话记录 —— 这正是「生成一段文案」需要的最小能力。
 *
 * ## 路由（provider / model）怎么定
 *
 * **五级回落**，顺序定死在计划 §2.2（见 `pickRouteFrom`）：
 *   ① 节点上选的模型（命令体里的 `model`）
 *   ② 工作台设置里的默认模型（`model-prefs.json` 的 default）
 *   ③ dsh 的 `agentDefaultModel.currentSelection()`
 *   ④ 备选名单里第一个（`model-prefs.json` 的 picks[0]）
 *   ⑤ 第一个 provider 的第一个模型
 *
 * ⚠️ **② 在 ③ 之前**：工作台设的默认是这个工作台的事，比 dsh 的全局选择更贴近意图；
 * ② 没设过才问 dsh。这条是计划里的明确决定，别调换。
 *
 * 五级全空 → 明确报「没有可用的模型」，而不是发一个注定失败的请求。
 * 每一级拿不到（服务不在、抛错、值为空、格式不合法）都**往下走**，不在中途抛。
 *
 * ⚠️ 这里**不校验模型是否在目录里**：dsh 的路由本身接受未列出的模型 id
 * （`listModels` 的注释写明「catalog membership does not constrain core routing」）。
 *
 * ## 结果怎么变成文本
 *
 * 流里 `text-delta` 拼起来就是回答。终态 `finish` 要看一眼：
 *   - `stop` / `tool-calls` → 正常，用拼出来的文本；
 *   - `max-tokens` → 截断了，**当失败**（截一半的文案比报错更糟）；
 *   - `error` / `aborted` → 取失败原因抛出去（`aborted` 里含用户取消与超时）。
 *
 * @param c - 注入上下文（用来拿 `agentDefaultModel`）。
 * @param llm - `llm` 服务。
 * @returns 委派函数 `(prompt, input, signal, command) => Promise<AgentDelegateResult>`。
 */
function createLlmDelegate(c: Context, llm: LlmLike): AgentDelegate {  /* `ctx.get(name)` 是 cordis 运行时的方法，但 `Context` 类型上没有它（官方类型只暴露注入后的属性）。
   * 这里只取我们需要的那一处，不为了它去改 `Context` 的类型。 */
  const getService = (name: string): unknown =>
    (c as unknown as { get?: (n: string) => unknown }).get?.(name)

  /**
   * 收集五级回落要用的候选（每一级各自容错：拿不到就给 `undefined`）。
   *
   * @param commandModel - 命令体里解析出来的模型（第①级）。
   * @returns 五级候选。
   */
  const collectSources = async (commandModel: ModelRef | undefined): Promise<RouteSources> => {
    const sources: RouteSources = {}
    /* ① 节点上选的（调用方已经解析好，格式不合法时本来就是 undefined）。 */
    if (commandModel !== undefined) sources.node = commandModel
    /* ② 工作台设置里的默认模型。读文件失败 → 当作没设，往下走。 */
    try {
      const prefs = await readModelPrefs()
      if (prefs.default !== undefined) sources.workspaceDefault = prefs.default
      const first = prefs.picks[0]
      if (first !== undefined) sources.firstPick = first
    } catch { /* 读偏好失败 → ②④ 都没有，交给 ③⑤ */ }
    /* ③ dsh 的默认选择。服务不在 / 抛错 → 往下走。 */
    try {
      const sel = getService('agentDefaultModel') as DefaultModelLike | undefined
      const pick = sel?.currentSelection()
      if (pick !== undefined && pick.provider !== '' && pick.model !== '') {
        sources.dshDefault = { provider: pick.provider, model: pick.model }
      }
    } catch { /* 服务不在 / 抛错 → 往下走 */ }
    /* ⑤ 第一个 provider 的第一个模型。 */
    try {
      const first = llm.listProviders()[0]
      if (first !== undefined && first.id !== '') {
        const models = await llm.listModels(first.id)
        const m = models[0]
        if (m !== undefined && m.id !== '') sources.firstAvailable = { provider: first.id, model: m.id }
      }
    } catch { /* 一个 provider 都读不出来 → ⑤ 没有 */ }
    return sources
  }

  return async (
    prompt: string,
    input: unknown,
    signal?: AbortSignal,
    command?: { model?: unknown, system?: unknown },
  ): Promise<AgentDelegateResult> => {
    /* 命令体里的 `model` 先解析（格式不合法 → undefined → 第①级不参与，**静默往下跌落**）。 */
    const commandModel = parseCommandModel(command?.model)
    const picked = pickRouteFrom(await collectSources(commandModel))
    if (picked === null) {
      /* 五级全空是**配置没做**，不是模型给了什么结局 —— 抛出去让上层照原样报，
       * 这时候也确实没有痕迹（连 provider 都没选出来，trace 里那三个必填字段填不出真值）。 */
      throw new Error('没有可用的模型：先在工作台设置里选一个默认模型，或在节点上选一个')
    }
    const route = picked.route
    /* ## 系统提示词：用户写在节点上的那条（2026-10-23）
     *
     * ⚠️ 与「干净渠道」不矛盾，先把两件事分开写清楚（`ai.agent` 节点的注释里也有同一段）：
     *   - 「干净」说的是**不被动塞进框架自己的东西**：dsh 那套 agent 系统提示词装配
     *     （工具怎么用、工作区规则、身份设定）与随之而来的整套工具声明。
     *     走 `ctx.llm.stream` + 不传 tools + 不传 sessionId，就是为了一直保持这条。
     *   - 「系统提示词」说的是**用户主动写的、模型按它执行的设定**。
     *     它是用户意图的一部分，和上面那套框子无关。
     * 判据只有一条：这段文字是用户写的，还是框架塞的？用户写的该有，框架塞的不要。
     *
     * ## 为什么用官方 `GenerateOptions.system`，而不是自己拼一条 system 消息
     *
     * 官方的字段（`refs/.../llm/llm/src/types.ts:524-528`）原文就写着
     * 「System prompt text for one-shot callers; adapters map it to the provider's
     * system slot ahead of `messages`」—— 正是我们这个场景（一次性调用、不落会话）。
     * `experimental/auto-review` 也是这么用的（`system: REVIEW_POLICY` + 一条 user）。
     *
     * 两套适配器各自怎么处理，都核过：
     *   - DeepSeek（`llm-deepseek/src/serialize.ts:150`）：和 history 里的 system 并入顶层 `system` 字段；
     *   - pi-ai（`llm-pi-ai/src/context.ts:158-163`）：直接取它当 `systemPrompt`。
     * 而自己拼 `{ role: 'system' }` 消息的话：DeepSeek 那条路在 `systemPromptUpdate !== 'in-history'`
     * 时才认它（`:109-114`），pi-ai 那条路会把它折进 user 消息 —— 同一份命令体，
     * 换个模型路由就换一种投递方式。所以用官方字段，不自己拼。
     *
     * ## 留空时与改动前逐字节一致
     *
     * `system` 为空（或没这个键）时**不传这个字段**，`messages` 仍是那一条 user ——
     * 老行为一个字都不变。写个空串进去，两套适配器都会当成「有系统提示词但内容为空」
     * （pi-ai 那边会拼出一个空 `systemPrompt`），平白多一种边界状态。 */
    const system = typeof command?.system === 'string' ? command.system : ''
    /* 节点上的「参考资料」并入用户消息：分开两段，模型看得清哪段是指令。 */
    const text = input === undefined || input === null || String(input).trim() === ''
      ? prompt
      : prompt + '\n\n参考资料：\n' + (typeof input === 'string' ? input : JSON.stringify(input, null, 2))
    let answer = ''
    /** 这次调用要补进执行方日志的行（目前只有「路由来源」这一条）。 */
    const extraLogs: string[] = []
    /* 痕迹：路由现成就有；token 与结束原因边收边填（见下面 usage / finish 两处）。
     * `finish` 先写 `unknown` 占位 —— 正常情况下客户端一定会收到 `finish` 分片覆盖掉它；
     * 没收到就说明流中途断了，那 `unknown` 本身就是如实的结果（不是编一个 'stop'）。
     *
     * ⚠️ 摘要里放的是「user 正文 + 系统提示词」，拼接顺序与理由见 `agentTracePreview`。 */
    const previewSource = agentTracePreview(text, system)
    const trace: LlmTrace = {
      provider: route.provider,
      model: route.model,
      finish: 'unknown',
      ...previewBlock(previewSource, undefined),
    }
    /* 路由来源写进**日志**（不是 trace）：用户排查「为什么这次用的不是我以为的模型」时，
     * 这一行是唯一线索。`LlmTrace` 的语义不动（契约 A 定的字段一个字不改）。 */
    extraLogs.push('模型路由来源：' + routeSourceLabel(picked.source)
      + '（' + route.provider + '/' + route.model + '）')
    /* 这一节点流订阅的键（票 28 第二步）。
     *
     * ⚠️ 在循环**外面**取一次，而不是每片字各取一次：清场要用同一个值，
     * 循环里每片重取虽然结果一样，但会让「清场用的那个值」与「推送用的那个值」
     * 变成两次读取 —— 将来有人在这里改动（比如加个规范化）就会对不上。
     *
     * 形状不合法时是 undefined：这时推送与清场**都不做**。
     * 不合法说明这个请求不是画布那条路发的，本来也没人订阅。 */
    const rawRunId = (command as { __runId?: unknown } | undefined)?.__runId
    const streamRunId = isRunIdShape(rawRunId) ? rawRunId : undefined
    try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...agentRequestShape(text, system),
      ...signal === undefined ? {} : { signal },
    })) {
      /* 一片字到了（票 14，2026-10-27）。
       *
       * ## 为什么要往外推那一下
       *
       * 这一段是**唯一**能看到「字正在长出来」的地方（模型流只在宿主半）。
       * 原先这里只往 `answer` 里累，一个字都不往外发 —— 于是一个要说 30 秒的节点，
       * 在界面上就是卡住 30 秒，用户不知道它是在跑还是已经死了。
       *
       * ## 回调从哪来
       *
       * `__onStream` 是引擎（`run.ts` 的 `runNode`）塞进命令体的：吐字发生在这一侧，
       * 而 `emit` 在引擎那一侧，中间隔着派发器与执行方，能把东西递过去的只有命令体
       * （`__judge` 走的是同一条路）。取不到就什么都不做 ——
       * 编译器 / 预览这类场景本来就没有 `runGraph` 在听。
       *
       * ## ⚠️ 传的是 `chunk.text`（这一片新增的字），不是 `answer`
       *
       * 界面那边是 `s + chunk` 追加。传累计全文的话每个字都会重复 N 遍
       * （100 片 = 100 倍长度），屏幕上是一遍遍长出来的乱码。
       *
       * 顺带一条纪律：**不 await、不 try** —— 这只是推给界面显示，
       * 界面慢或收不到都不该影响这次模型调用本身。 */
      if (chunk.type === 'text-delta') {
        answer += chunk.text
        const push = (command as { __onStream?: unknown } | undefined)?.__onStream
        if (typeof push === 'function') (push as (t: string) => void)(chunk.text)
        /* ★ 第二条通道：查表往订阅的流里推（票 28 第二步，2026-10-27）。
         *
         * ## 为什么这里要多一条，而不是替换上面那条
         *
         * 上面那条走「引擎塞进来的回调」，只在**进程内**派发时有效
         * （`/workflow/run-stream` 那条列表页的路），画布那条过 HTTP，函数过不去。
         *
         * 这一条走「宿主半自己有一张订阅表」：闭包留在进程里，没有序列化这回事。
         * **两条并存**，因为两个消费方还在（列表页那条不能断）。
         *
         * ## ⚠️ `__runId` 是**不可信输入**，只用来查表
         *
         * 它从 HTTP 请求体来，谁都能塞。所以：
         *   · 形状不合法 → 当没有，什么都不推（`isRunIdShape`）；
         *   · 表里查不到 → 什么都不推（**绝不在这里建条目** ——
         *     建表只发生在 SSE 路由里，那个分工破了就会留没人清理的僵尸条目）。
         *
         * 推的时候也不 await、不 try：这只是给界面看的，
         * 界面慢或收不到都不该影响这次模型调用本身。 */
        const rid = (command as { __runId?: unknown } | undefined)?.__runId
        if (isRunIdShape(rid)) {
          const entry = nodeStreams.get(rid)
          if (entry !== undefined) {
            /* 摸一下 `at`：TTL 判的是「多久没动」，正在推的这条不该被扫掉。 */
            entry.at = Date.now()
            /* `__nodeId` 也是客户端塞进来的（实例 id，界面靠它把字贴到那个节点上）。
             * 与 `__runId` 一样当不可信输入：不是字符串就回落到空串，
             * 界面那边认不出节点只是不显示，不会画错地方。 */
            const nid = (command as { __nodeId?: unknown } | undefined)?.__nodeId
            const nodeId = typeof nid === 'string' ? nid : ''
            try { entry.sink({ kind: 'stream', nodeId, text: chunk.text }) } catch { /* 没人听了 */ }
          }
        }
        continue
      }
      /* usage 分片按契约在 finish **之前**到达（官方 types.ts:458「usage precedes finish」）。
       * ⚠️ 三个字段按官方名字直接搬，**上游没给就不写这个键** —— 见 `writeUsage` 的注释。 */
      if (chunk.type === 'usage') { writeUsage(trace, chunk.usage); continue }
      if (chunk.type === 'finish') {
        const kind = chunk.reason.kind
        /* 结束原因**如实记**（error / aborted / max-tokens 各自不同，诊断价值不同，
         * 不许统统写成 'error'）。之后无论成功失败，这份 trace 都要带出去。 */
        trace.finish = kind
        /* 失败也是**返回**（不是抛）—— 抛了就没有返回值，痕迹跟着丢，
         * 而最需要看痕迹的恰恰是失败这几次。回答的摘要也一并补上（已经收到的部分）。 */
        if (kind === 'error' || kind === 'aborted') {
          const why = chunk.reason.failure?.message ?? kind
          return {
            ok: false,
            error: '模型调用失败：' + why,
            trace: { ...trace, ...previewBlock(undefined, answer) },
            logs: extraLogs,
          }
        }
        if (kind === 'max-tokens') {
          return {
            ok: false,
            error: '模型输出被截断（到达 token 上限）—— 把提示词写短些，或换上限更高的模型',
            trace: { ...trace, ...previewBlock(undefined, answer) },
            logs: extraLogs,
          }
        }
      }
    }
    } finally {
      /* 清场路径 ①②：节点跑完 / 模型调用抛错，都在这里清。
       *
       * ## 为什么是 `finally` 而不是正常收尾那一处
       *
       * 这一段有**五条出口**（成功、空回答、模型报错、被截断，以及上游抛错），
       * 每条各写一遍清理必然漏 —— 而漏掉的那条正是「抛错路径」，也就是最容易漏的那一条。
       *
       * ## ⚠️ 这一处**不是唯一**的清场点，也不是最外层的
       *
       * 「agent 节点缺少 prompt」这类失败发生在**调到本函数之前**（执行方 `executors.ts:367`
       * 直接返回 failed），那时这一段根本没进，`finally` 也就不会执行。
       * 最外层的清场在 `createAgentExecutor` 外面那层包装里（本文件注册执行方那一处）——
       * 那里能包住**所有**结局。
       *
       * 这里保留它是因为：模型这条路的收尾比外层更早，早清一步能让重试马上拿到新订阅。
       * 两处都调同一个幂等函数，先后顺序不影响结果。 */
      if (streamRunId !== undefined) dropNodeStream(streamRunId)
    }
    /* 回答的摘要最后补（只有拿到回答才知道长什么样）。 */
    const withAnswer = { ...trace, ...previewBlock(undefined, answer) }
    if (answer.trim() === '') {
      /* 空回答：模型确实被调了、也确实什么都没产出 —— 痕迹照样交出去。 */
      return { ok: false, error: '模型没有返回任何文字', trace: withAnswer, logs: extraLogs }
    }
    return { ok: true, text: answer, trace: withAnswer, logs: extraLogs }
  }
}

/**
 * 把 usage 分片里的三个 token 数搬进痕迹。
 *
 * ## 为什么是「没给就不写键」而不是「给 0」
 *
 * 官方 `TokenUsage` 的注释写着：`totalTokens` 在某些情况下**省略**（unavailable or inconsistent）。
 * 上游没给就说明它不知道，写个 0 会让界面显示「这次花了 0 token」——
 * 那是**拿假数字冒充实测**（n8n 的 `tokenUsageEstimate` 那条教训）。
 *
 * ## 为什么只搬三个、不搬缓存那两个
 *
 * `inputTokens` 是**未命中缓存的那部分**（计数互斥），`cacheReadTokens` 另计。
 * 本轮只给用户看「输入 / 输出 / 合计」三样，缓存细分等有人要看再加；
 * 加的时候照同样规矩：有就写、没有就不写。
 *
 * @param trace - 要填的痕迹（就地改）。
 * @param usage - 分辨率里的 usage 分片内容（可能是残缺对象）。
 */
function writeUsage(trace: LlmTrace, usage: { inputTokens?: unknown, outputTokens?: unknown, totalTokens?: unknown } | undefined): void {
  if (usage === undefined || usage === null) return
  /** 只收有限的正数（0 是合法值 —— 例如空回答的输出 0，那是实测不是缺失）。 */
  const take = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  const input = take(usage.inputTokens)
  const output = take(usage.outputTokens)
  const total = take(usage.totalTokens)
  if (input !== undefined) trace.inputTokens = input
  if (output !== undefined) trace.outputTokens = output
  if (total !== undefined) trace.totalTokens = total
}

/**
 * 生成「摘要」那一段痕迹（提示词 / 回答，各自截到上限）。
 *
 * @param prompt - 提示词（给了才写 `promptPreview`）。
 * @param answer - 回答（给了才写 `outputPreview`）。
 * @returns 只含实际有的键的对象（可以直接 `Object.assign` 进痕迹）。
 */
function previewBlock(prompt: string | undefined, answer: string | undefined): Partial<LlmTrace> {
  const out: Partial<LlmTrace> = {}
  let cut = false
  if (prompt !== undefined) {
    const p = truncateTraceText(prompt)
    /* ⚠️ 空提示词不写键 —— 与 `truncated` / `totalTokens` 同一条纪律：
     * 写个空串进去，界面还得自己判 `=== ''`，等于多一种「有值但看不出来」的状态。 */
    if (p.text !== '') out.promptPreview = p.text
    cut = cut || p.truncated
  }
  if (answer !== undefined) {
    const a = truncateTraceText(answer)
    /* 空回答同理（模型什么都没产出时不留一个空串）。 */
    if (a.text !== '') out.outputPreview = a.text
    cut = cut || a.truncated
  }
  /* ⚠️ 只在**真截了**时写 `truncated`；没截就不写这个键（不是 `false`）。 */
  if (cut) out.truncated = true
  return out
}

/**
 * 造一份「要发给模型的请求形状」—— 只含 `messages` 与可选的 `system`。
 *
 * ## 为什么单独抽出来（2026-10-23）
 *
 * 这两件事是契约 V 的核心：**没填系统提示词时，发出去的东西必须与改动前逐字节一致**。
 * 埋在一个 `for await` 里没法单测（要起整套 apply + 假 llm 才能看一眼参数），
 * 抽成纯函数就能直接断言「两条 / 一条」「`system` 键在不在」。
 *
 * ## 形状照官方 `GenerateOptions`（不自创）
 *
 * - `messages: RequestMessage[]` —— 一条 `{ role: 'user', content: [{ type: 'text', text }] }`；
 * - `system?: string` —— 官方 `types.ts:524-528` 的注释：「System prompt text for one-shot
 *   callers; adapters map it to the provider's system slot ahead of `messages`」。
 *
 * ⚠️ **不要**改成自己拼一条 `{ role: 'system', content: [...] }` 消息：
 *   - DeepSeek 适配器只在 `systemPromptUpdate === 'in-history'` 时才把 system 消息当更新收
 *     （`llm-deepseek/src/serialize.ts:109-114`），否则是当顶层 `system` 字段；
 *   - pi-ai 适配器会把首条 system 消息**折进 user 消息**（`llm-pi-ai/src/context.ts:158-163`）。
 *   同一份命令体换个模型路由就换一种投递方式 —— 用官方字段，两套都按「系统提示词」对待。
 *
 * ## `system` 为空串时不写这个键
 *
 * 与 `input` / `model` / `truncated` 同一条纪律：没有的东西不出现。
 * 写个空串，pi-ai 那边会得到一个空 `systemPrompt`（`text.length > 0` 才置值，见 `:163`），
 * 徒增一种边界状态；而我们这边也没法再区分「用户没填」与「用户填了个空」。
 *
 * @param text - 用户消息正文（提示词，可能已并入参考资料）。
 * @param system - 系统提示词（空串 = 没填）。
 * @returns 可以直接展开进 `llm.stream(...)` 的对象。
 */
export function agentRequestShape(
  text: string,
  system: string,
): { messages: { role: 'user', content: { type: 'text', text: string }[] }[], system?: string } {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...system === '' ? {} : { system },
  }
}

/**
 * 造痕迹里 `promptPreview` 的来源文本：**user 正文在前，系统提示词在后**。
 *
 * ## 契约 V 第 5 条的判断（2026-10-23）：两条都算，不丢系统提示词
 *
 * 三条理由：
 *   ① 痕迹存在的意义是「事后解释这次模型为什么这么答」。只留 user 那条，
 *      看到一条莫名其妙的回答时，缺的恰恰是「当时设了什么角色与规矩」那一半。
 *   ② 上限 500 字（`TRACE_TEXT_PREVIEW`）是按**整份痕迹**算的，不是每条一份。
 *      拼接后再截，落盘体积与现在完全一样，不多占一个字节。
 *   ③ 截断要说真话。拼接后截，`truncated` 为 true 就是「后面还有」；
 *      而只截 user 那条的话，`truncated` 可能是 false 而系统提示词整个不见了 ——
 *      界面会显示成「提示词就这么长」，那是**不实**。
 *
 * ## 为什么系统提示词放在**后面**
 *
 * 真被截时，被截掉的是排在后面的部分。系统提示词一次写定、很少变；
 * user 正文每条都变 —— 变的那条更该被看见。所以宁可截掉那份不常变的长设定。
 *
 * ## 为什么带「系统提示词：」这个标签
 *
 * 两段接在一起、用户不知道哪段是哪段，等于摘要里多了一坨看不出结构的长文本。
 * 一个标签就够，不引 Markdown（`tests/copy-no-markdown.mjs` 只在节点文案里钉，
 * 但这条纪律是全项目的）。
 *
 * @param text - user 正文（提示词，可能已并入参考资料）。
 * @param system - 系统提示词（空串 = 没填）。
 * @returns 供 `previewBlock` 截断的文本。
 */
export function agentTracePreview(text: string, system: string): string {
  return system === '' ? text : text + '\n\n系统提示词：\n' + system
}

/**
 * 插件激活入口（宿主半）。
 * @param ctx - cordis 上下文。
 */
export function apply(ctx: Context): void {
  const d = getDispatcher()

  /* ── 启动时把磁盘上的**内容目录配置**套进来（2026-10-26，T-B-后端自查补）──
   *
   * ## 为什么这里必须有这一句
   *
   * `saveStorageConfig` 存完立刻 `setDirOverrides` —— 热生效。但那份覆盖表**在内存里**，
   * 重启就空了。于是「用户改了产物目录 → 重启 → 全部回到默认」，
   * 而盘上的 `storage.json` 明明还在。这个函数就是那道桥，
   * 它一度**写好了却没有任何调用方**（只在注释里被提到）——
   * 测试当时是绿的，因为它自己手动调了一次。
   *
   * ## 为什么是 `void` 而不是 `await`
   *
   * `apply` 是同步签名（cordis 的约定），不能等。所以后台跑一次：
   * 目录是每次调用现算的，这一次套用会赶在第一次写盘之前完成
   * （插件加载到第一次真写产物之间至少要一次用户操作）。
   *
   * ## 为什么失败必须说出来
   *
   * 「从没配过」与「配过但文件坏了」在旧写法里都是空对象：
   * 前者该安静用默认，后者说出来否则用户以为配置自己丢了。
   * 所以 `applyStorageConfig` 会把原因带回来，这里报给日志。 */
  void applyStorageConfig().then((r) => {
    if (r.problem === undefined) return
    const log = (ctx as unknown as { logger?: { warn?: (m: string) => void } }).logger
    log?.warn?.('ecom-workbench: ' + r.problem)
  }).catch((e: unknown) => {
    const log = (ctx as unknown as { logger?: { warn?: (m: string) => void } }).logger
    log?.warn?.('ecom-workbench: 存储目录配置套用失败：' + (e instanceof Error ? e.message : String(e)))
  })

  // 进程执行方：接 dsh 的 subprocess（服务存在时才挂）
  ctx.inject(['subprocess'], (sctx) => {
    const sub = (sctx as unknown as { subprocess: SubprocessLike }).subprocess
    d.register(createShellExecutor(adaptSubprocess(sub, process.cwd())))
  })

  /* agent 执行方：直接调 `ctx.llm.stream`（**不用 `ctx.subagents`**）。
   *
   * ## 为什么不用 subagents（2026-10-23 核实过 asar 源码）
   *
   * `ctx.subagents` 看起来最像「委派一个 AI 去干」，但它的两个接口都不适配我们的三条触发路径：
   *
   *   1. 老代码调的 `subs.run(...)` —— `SubagentRuntime` 的方法表里**根本没有 `run`**
   *      （只有 `startActivation` / `prompt` / `interrupt` / `list` / `listChildren` …）。
   *      那段是死代码，任何 agent 节点一跑就抛「subagents 服务未提供 run」。
   *   2. `startActivation` 要一个**活的 Agent 当 parent**，且有一句硬校验：
   *      `this.ctx.get('agents')?.get(spec.request.parent.id) !== spec.request.parent`
   *      就抛 `UNAUTHORIZED`（`dsh-subagent/lib/index.js` 的 `startActivation`）。
   *      而我们三条触发路径（画布 / 列表 / 定时）**都不经过 agent**，
   *      插件里没有天然的 parent；拿 `agents.list()[0]` 顶替等于把子 agent 的
   *      结果与会话记录挂到别人那次对话里（`delivery: 'parent'` 会写 catalog 并投递结算消息）。
   *
   * 所以走**第三条路**：`ctx.llm` 是宿主半本来就注册着的模型服务
   * （`dsh-base` 的 `llm` + `llm-deepseek-api-key` / `llm-deepseek-account`），
   * 它只要 provider + model + messages，**不需要 Agent、不产生会话记录**。
   * 参照 dsh 自己的 `dsh-compaction-basic`：它也是插件直接 `ctx.llm.stream(...)`。
   *
   * ⚠️ 代价（如实交代）：这条路**只调模型、不给工具**。子 agent 那套「能读文件、能跑命令」
   * 在本节点上没有。这是有意的 —— 生成文案不需要动用户磁盘。
   */
  ctx.inject(['llm'], (lctx) => {
    const llm = (lctx as unknown as { llm: LlmLike }).llm
    /* 登记给 `GET /models` 用：路由闭包与这里不在同一个作用域（见 `llmService` 的注释）。
     * 用 `ctx.effect` 收掉 —— 插件卸载后不该留一个指向旧服务的引用。 */
    llmService = llm
    ;(lctx as unknown as { effect?: (fn: () => () => void, label: string) => void })
      .effect?.(() => () => { if (llmService === llm) llmService = null }, 'ecom-workbench: llm service handle')
    /* 注册 agent 执行方 —— 外面包一层**最外层的清场**（票 28 第二步）。
     *
     * ## 为什么不能只在 `createLlmDelegate` 里清
     *
     * 那里只管「模型真被调了」这一条路。而 agent 节点还有**调都没调**的结局：
     * `executors.ts:367` 在 `prompt === ''` 时直接返回 failed，连 delegate 都没进 ——
     * 那时 `createLlmDelegate` 的 `finally` 根本不会执行，表里那条订阅就留着了。
     *
     * 后果不是内存泄漏那么温柔：重试是**新 runId**，但如果引擎复用同一个 runId
     * 再派发（或客户端重开同一条订阅），旧条目会把它推的字送到**已经结束的那条流**上。
     *
     * ## 为什么要包在这一层
     *
     * `run()` 是**所有结局的必经之路**：成功、失败、超时、取消、抛错，一条都绕不过。
     * 包在这里，四种结局共用一处清场。
     *
     * ⚠️ 清场值是**派发请求里的那个 `runId`**，不是命令体里的 `__runId` ——
     * 前者是引擎造的（唯一、可信），后者从 HTTP 来（可能根本没有）。
     * 客户端塞进命令体的 `__runId` 就是它，所以两边对得上；
     * 而「客户端没塞」的那些调用（列表页、定时）这里清的是表里根本没有的键，
     * `dropNodeStream` 幂等，什么都不发生。 */
    const agentExec = createAgentExecutor(createLlmDelegate(lctx, llm))
    d.register({
      kind: 'agent',
      async run(req) {
        try {
          return await agentExec.run(req)
        } finally {
          if (isRunIdShape(req.runId)) dropNodeStream(req.runId)
        }
      },
    })
  })

  /* 默认模型服务（`ctx.agentDefaultModel`）：只给 `GET /models` 的 `current` 用。
   * 它可能不存在（部署里没装 `dsh-agent-default-model`）—— 那时 `current` 给 `null`。 */
  ctx.inject(['agentDefaultModel'], (mctx) => {
    const sel = (mctx as unknown as { agentDefaultModel: DefaultModelLike }).agentDefaultModel
    defaultModelService = sel
    ;(mctx as unknown as { effect?: (fn: () => () => void, label: string) => void })
      .effect?.(() => () => { if (defaultModelService === sel) defaultModelService = null }, 'ecom-workbench: default model handle')
  })

  /* ── 定时执行器（2026-10-21，计划 Step 5/6/7）────────────────────
   *
   * 每分钟扫一次任务表，到点**直接调 `runWorkflowFile`** —— 不经过 agent、
   * 不新开 Session、不投消息（理由见 `src/schedule/runner.ts` 的文件头，
   * 对照的是 @michengai/dsh-automation 与 dsh 自带的 ctx.schedule）。
   *
   * ⚠️ **定时器必须能被 `ctx.effect` 收掉**：插件卸载 / 热重载时留一个走得动的
   * `setInterval`，它会一直跑、还带着旧闭包 —— 那种问题在真机上表现为
   * 「改完代码还是旧的」，查起来极难。
   *
   * ⚠️ **首次启动任务表为空时写入五份巡查默认任务**（每天 09:30，名字前带
   * 「[自动生成]」）。先 seed 再起表 —— 免得第一分钟扫到空表白跑一趟。 */
  ctx.effect(() => {
    let stop: (() => void) | null = null
    let disposed = false
    void seedDefaultTasks()
      .catch(() => 0)
      .then(() => {
        if (disposed) return
        stop = startScheduler(dispatchNode, {
          workdir: process.cwd(),
          prefs: () => readBrowserPrefs(),
        })
      })
    return () => {
      disposed = true
      if (stop !== null) stop()
    }
  }, 'ecom-workbench: schedule')

  /* ── 挂起运行的**自动恢复**（2026-10-21，计划 Step 12）──────────────
   *
   * ## 为什么是「每分钟扫一遍」而不是「挂起时算好 setTimeout」
   *
   * 与定时执行器同一个理由（见 `src/schedule/runner.ts` 文件头）：
   * 每分钟比一次 `resumeAt` 是**幂等**的 —— 插件重启、系统休眠唤醒、时间被改，
   * 下一秒都比得出来；而「算好时间再睡到那时」一旦算错就要等到明天才知道。
   *
   * 更要紧的一条：**挂起的运行本来就跨重启**（用户关掉工作台、第二天再开），
   * 那时根本没有「那个 setTimeout」了 —— 只有磁盘上的现场文件还在。
   * 所以恢复必须由「扫盘」驱动，不能由内存里的定时器驱动。
   *
   * ## 三条纪律
   *
   * 1. **一份失败不影响其它份**（逐份 try/catch）。
   * 2. **同一分钟不重复触发**：正在恢复的记在 `resuming` 里，扫到就跳过。
   * 3. **定时器能被 `ctx.effect` 收掉** —— 与上面那条定时器同一条纪律。 */
  ctx.effect(() => {
    /** 正在恢复的那些 runId（防同一份在同一分钟里被扫两次）。 */
    const resuming = new Set<string>()
    let stopped = false
    let busy = false
    /** 扫一遍：把「到点了」的现场恢复掉。 */
    const beat = (): void => {
      if (stopped || busy) return
      busy = true
      void (async () => {
        const now = Date.now()
        const list = await listPausedRuns()
        for (const snap of list) {
          if (stopped) return
          if (snap.wait.resumeAtMs > now) continue
          /* ★ 已经被拒绝恢复过的跳过（票 17）。
           *
           * 指纹对不上时现场会**留着**（让用户有机会把工作流改回去），
           * 而它到点了仍然「该恢复」。不跳过的话每 30 秒拒一次、弹一次通知 ——
           * 见 `RunSnapshot.resumeBlocked` 的注释。手动点「继续」不受这条限制：
           * 那条路会重新核一次。 */
          if (snap.resumeBlocked !== undefined) continue
          if (resuming.has(snap.runId)) continue
          resuming.add(snap.runId)
          try {
            const r = await resumePausedRun(snap, 'auto')
            /* 失败要**提醒**（用户等了几小时的东西不能静默失败）。
             * 与定时任务同一条取舍：失败才提醒，成功不打扰。
             *
             * ⚠️ 用户 2026-10-22 把提醒拆成两项独立设置（`src/notify/prefs.ts`）：
             * **挂起恢复失败归 `failNotify` 这一项**（用户原话：「挂起恢复失败作为
             * 失败是否提醒的一个级别吧」）。`alertMinLevel` 管预警节点，与这里无关。
             * 读偏好失败由 `readNotifyPrefs()` 自己吞掉并回默认值
             * （宁可多发一条，不能因为读配置把恢复流程搞崩）。
             * ⚠️ 这个 await 在「逐份恢复」的循环里，但它只读一个小 JSON、
             * 而且同一份已经在 `resuming` 里防重入 —— 不会把循环卡住。 */
            if (!r.ok && (await readNotifyPrefs()).failNotify) {
              void notify('挂起的运行恢复失败：' + snap.workflowId, r.summary)
            }
          } catch (e) {
            if ((await readNotifyPrefs()).failNotify) {
              void notify('挂起的运行恢复失败：' + snap.workflowId, e instanceof Error ? e.message : String(e))
            }
          } finally {
            resuming.delete(snap.runId)
          }
        }
      })()
        .catch(() => { /* 单次扫描失败不影响下一分钟 */ })
        .finally(() => { busy = false })
    }
    const timer = setInterval(beat, 30_000)
    if (typeof timer.unref === 'function') timer.unref()
    /* 起来时先扫一次：插件重启后那些「早就该继续」的现场不该再等半分钟。 */
    beat()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'ecom-workbench: paused resume')

  /* 通知子进程也要能收掉：弹一条要 PowerShell 驻留 6 秒（气球显示期间不能退），
   * 卸载 / 热重载时留一个还在睡的进程，它**带着旧闭包**、卸载后还会再弹一次。 */
  ctx.effect(() => () => { notifyKillAll() }, 'ecom-workbench: notify processes')

  // HTTP 路由（照原 workbench 的 prefix 模式）
  ctx.inject(['webServer'], (wctx) => {
    const server = (wctx as unknown as { webServer: WebServerLike }).webServer
    const dispose = server.register({
      kind: 'prefix',
      path: '/api/ecom-workbench',
      handler: async (req: unknown, res: unknown) => {
        const r = req as IncomingMessage
        const w = res as ServerResponse
        const path = new URL(r.url ?? '/', 'http://x').pathname
        const send = (code: number, body: unknown): void => {
          w.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          w.end(JSON.stringify(body))
        }
        try {
          /* ── 产物（图片 / 视频）的取：二进制路由（2026-10-25，契约 AV）──────
           *
           * ## 为什么单开一段、并且**不用 `send()`**
           *
           * `send()` 里写死 `content-type: application/json`，它是给所有普通接口用的。
           * 改它会波及每一条现有路由（前端解析、错误处理全部跟着变）。
           * 而 `w` 就是原生 `ServerResponse` —— 这里自己 `writeHead` + `end(Buffer)`
           * 就能吐二进制，一行都不动 `send()`。
           *
           * ## 缓存头用 `no-cache` 而不是 `max-age`
           *
           * 产物 id 是内容寻址的（同一个 id 的字节不会变），但**本轮的 id 是
           * 生成时刻造的**，删了重建可能复用同一个名字（手工放文件那种场景）。
           * 用 `no-cache`（每次回来问一下、命中就 304）既省流量又不会看到旧图。
           *
           * ⚠️ 放在 `try` 里第一段：`loadArtifact` 会读磁盘，出错要能落进统一 500。
           * ⚠️ **必须在 404 兜底之前** —— 它在最后，这里放前面不用担心顺序，
           * 但千万别放到 `send(404)` 之后（那段之后没有代码会执行到）。 */
          if (path.startsWith('/api/ecom-workbench/artifact/') && r.method === 'GET') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/artifact/'.length))
            const got = await loadArtifact(id)
            if (got === null) {
              /* 找不到也给 JSON —— 界面能显示原因，比空白页好。 */
              w.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
              w.end(JSON.stringify({ error: '没有这个产物：' + id }))
              return
            }
            w.writeHead(200, {
              'content-type': got.meta.mime,
              'content-length': String(got.data.length),
              'cache-control': 'no-cache',
              /* 产物库删了文件就不该再被缓存命中（计划 §4.2 的「删了要有明确提示」）。 */
              'etag': '"' + got.meta.id + '-' + String(got.data.length) + '"',
            })
            w.end(got.data)
            return
          }
          /* ── 产物的存：POST 一个 JSON（字节走 base64）────────────────
           *
           * 为什么走 JSON 而不是 multipart：这一侧的请求体读取只有
           * `readJsonBody` 一条路（上限 8 MB），multipart 要自己解边界，
           * 那是为「用户上传大文件」准备的；生成的图走这条够用。
           * 上传（素材库）要等 Step 4，那时再加二进制上传。
           *
           * ⚠️ 前端**拿不到** base64 之后的图（内存会炸），所以这条路由的
           * 主要调用方是宿主自己的生成链路，前端只是转发一次生成结果。 */
          if (path === '/api/ecom-workbench/artifact' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const pick = (k: string): unknown => body[k]
            try {
              const meta = await storeArtifact({
                base64: typeof pick('base64') === 'string' ? pick('base64') as string : undefined,
                mime: typeof pick('mime') === 'string' ? pick('mime') as string : undefined,
                ext: typeof pick('ext') === 'string' ? pick('ext') as string : undefined,
                id: typeof pick('id') === 'string' ? pick('id') as string : undefined,
                width: typeof pick('width') === 'number' ? pick('width') as number : undefined,
                height: typeof pick('height') === 'number' ? pick('height') as number : undefined,
                source: typeof pick('source') === 'string' ? pick('source') as string : undefined,
                workflowId: typeof pick('workflowId') === 'string' ? pick('workflowId') as string : undefined,
                runId: typeof pick('runId') === 'string' ? pick('runId') as string : undefined,
                params: typeof body.params === 'object' && body.params !== null
                  ? body.params as Record<string, unknown> : undefined,
              })
              /* 回 `url` 而不是只回 id：界面拿它直接塞 `<img src>`，不必自己拼前缀。 */
              send(200, {
                ok: true, ...meta,
                url: '/api/ecom-workbench/artifact/' + meta.id,
              })
            } catch (e) {
              send(400, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          /* 产物清单（产物库下一步用；现在先给一条能查的）。 */
          if (path === '/api/ecom-workbench/artifacts' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const limit = Number(q.get('limit') ?? '200')
            const items = await listArtifacts(Number.isFinite(limit) ? limit : 200)
            /* ⚠️ 列表类回包**同时给具名键与 `items`，两个键指向同一个数组**
             * （契约 BC 定的约定，见 `AGENTS.md`）。
             * 为什么两个都给：具名键是给人读的（`artifacts` 一看就知道是什么），
             * `items` 是给通用代码读的（同一个渲染函数能处理所有列表）。
             * 只给一个的话，调用方就会写 `r.data?.artifacts ?? r.data?.items` 这种兜底 ——
             * 两边都猜等于约定缺位。 */
            const withUrl = items.map(m => ({ ...m, url: '/api/ecom-workbench/artifact/' + m.id }))
            /* ★ 票 52（2026-10-28）：`total` 原来是 `items.length` —— 那是**截断后**的
             * 条数，超过 200 条时界面上的「共 N 条」就是假的（用户拿它判断要不要清理，
             * 显示的比实际少，他会以为干净了）。
             *
             * 现在 `total` 是磁盘上的真实条数（`countArtifacts` 只数文件、不解析内容）。
             * ⚠️ 这个键**以前也有**，只是值是错的 —— 所以这不是「新增键」，
             * 是「把一个假值改成真值」。既有调用方读它的写法不用改。
             *
             * ⚠️ 不许把 `limit` 调大来「解决」这件事：那只是把几千条元数据
             * 塞进界面，把性能问题换了个位置。 */
            send(200, {
              ok: true, dir: artifactsDir(), total: await countArtifacts(),
              items: items.map(m => ({ ...m, url: '/api/ecom-workbench/artifact/' + m.id })),
              /* 契约 BC：具名键与 `items` 内容一致（各自 map 一遍，两个数组内容相同）。
               * 之所以不共用 `withUrl` 变量去改上面那行 —— 那会删除既有行；
               * 契约要求这个文件只增不删。 */
              artifacts: withUrl,
            })
            return
          }
          /* 内容板块新增目录的解析自检（Step 0/1 的沙箱那条要能一眼看出目录对不对）。
           * ⚠️ 只报路径，**不创建** —— GET 不该有副作用。 */
          if (path === '/api/ecom-workbench/content/dirs' && r.method === 'GET') {
            send(200, {
              ok: true,
              canvases: canvasesDir(),
              artifacts: artifactsDir(),
              materials: materialsDir(),
              genLogs: genLogsDir(),
              promptCache: promptCacheDir(),
            })
            return
          }
          /* ── 渠道表（契约 AX，2026-10-25）──────────────────────────────
           *
           * ## 这个接口的唯一硬要求：**密钥不出宿主**
           *
           * 回给前端的每一条只有 `hasKey: boolean`（界面据此显示「已配置 / 未配置」）。
           * 密钥本体存在另一个文件（`channels.secret.json`）里，只有宿主自己调上游时读。
           *
           * 为什么不「读出来再删掉密钥字段」：那种写法只要有一处忘了删就泄一次。
           * 分成两个文件之后，回给前端的那份在磁盘上就不含密钥，漏删也无从泄起。
           *
           * ⚠️ DELETE 必须**同时删密钥** —— 只删渠道不删密钥的话，下次新建一条
           * 同名 id 的渠道会凭空带上旧密钥（用户看到「没配」却能用）。 */
          if (path === '/api/ecom-workbench/channels' && r.method === 'GET') {
            send(200, { ok: true, channels: await readChannelsWithKey() })
            return
          }
          if (path === '/api/ecom-workbench/channels' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const saved = await saveChannel(body)
            /* 用 `in` 判错误分支（`strict: false` 下可判别联合不收窄，见 `channels.ts` 同一处说明）。 */
            if ('error' in saved) send(400, { ok: false, error: saved.error })
            else send(200, { ok: true, channel: saved.channel })
            return
          }
          if (path.startsWith('/api/ecom-workbench/channels/') && r.method === 'DELETE') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/channels/'.length))
            if (id === '') { send(400, { ok: false, error: '要删哪一条？没给 id' }); return }
            const gone = await deleteChannel(id)
            send(gone ? 200 : 404, gone
              ? { ok: true }
              : { ok: false, error: '没有这个渠道：' + id })
            return
          }
          /* ── 生成任务（契约 CC，2026-10-26）────────────────────────────
           *
           * ## 为什么是「提交 + 轮询」两条而不是一条长请求
           *
           * 视频一条十几分钟。让 HTTP 请求挂着等 → 浏览器先超时、用户以为卡死。
           * 所以 `POST /generate` 只做三件毫秒级的事（造任务、登记、起后台），
           * 立刻回任务 id；界面拿 id 轮询 `GET /generate/:id` 看进度。
           *
           * ## 任务只在内存里，重启就清
           *
           * 「这次跑到哪一步」是进程内的瞬时状态。重启后恢复一个「运行中」
           * 只会让界面显示一个永远不动的东西 —— 真正的历史在 `gen-logs/` 里。
           *
           * ⚠️ 长的放前面：`/generate/:id/cancel` 必须排在 `/generate/:id` 之前判断，
           * 否则 `:id` 那条会把 `xxx/cancel` 整段当 id（id 里不含斜杠，但它会匹配不到
           * 而落到 404，看起来像「取消接口不存在」）。 */
          if (path.startsWith('/api/ecom-workbench/generate/') && path.endsWith('/cancel') && r.method === 'POST') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/generate/'.length, -'/cancel'.length))
            const done = cancelTask(id)
            send(done ? 200 : 404, done
              ? { ok: true }
              : { ok: false, error: '这个任务不存在或已经结束：' + id })
            return
          }
          if (path.startsWith('/api/ecom-workbench/generate/') && r.method === 'GET') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/generate/'.length))
            const task = getTask(id)
            if (task === null) { send(404, { ok: false, error: '没有这个任务：' + id }); return }
            send(200, { ok: true, task })
            return
          }
          if (path === '/api/ecom-workbench/generate' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const str = (k: string): string => typeof body[k] === 'string' ? (body[k] as string) : ''
            const num = (k: string): number | undefined =>
              typeof body[k] === 'number' && Number.isFinite(body[k]) ? body[k] as number : undefined
            const kindRaw = str('kind')
            const kind = kindRaw === 'video' || kindRaw === 'text' || kindRaw === 'audio' ? kindRaw : 'image'
            /* 图像操作（契约 T1）：给了就决定用哪一类工作流。
             * 不认识的值当「没给」—— 不因为一个笔误的 op 让整次生成失败。 */
            const opRaw = str('op')
            const op = isGenOp(opRaw) ? opRaw : undefined
            if (str('prompt').trim() === '') { send(400, { ok: false, error: '提示词不能为空' }); return }
            /* ⚠️ `model` **不再必填**（2026-10-26，T-B-后端）。
             *
             * 以前这里要求必填，而界面在「没选模型」时自己填了清单里的第一个 ——
             * 于是「用哪个模型」这件事由渠道顺序决定。现在：不给就走默认模型，
             * 默认也没设在 `runTask` 里**明确报错说去设置里选**（见
             * `resolveGenerationTarget`）。所以这里不再拦，也不许在这里补一个默认值。 */

            /* 参考图走 base64（与 `POST /artifact`、`POST /materials` 同一条路，
             * 不做 multipart —— 这条约定在 `src/schedule/materials.ts` 的文件头写明了代价）。 */
            const refs: { mime: string, bytes: Buffer }[] = []
            if (Array.isArray(body.refs)) {
              for (const one of body.refs) {
                if (typeof one !== 'object' || one === null) continue
                const rec = one as Record<string, unknown>
                const b64 = typeof rec.base64 === 'string' ? rec.base64 : ''
                if (b64 === '') continue
                refs.push({
                  mime: typeof rec.mime === 'string' && rec.mime !== '' ? rec.mime : 'image/png',
                  bytes: Buffer.from(b64, 'base64'),
                })
              }
            }
            /* 遮罩（契约 T1）：同一套 base64 形状，单独一个字段。
             * 只有 ComfyUI 那条路认它；给网络模型会明确报错（见 `net-gen.ts`）。 */
            const maskRaw = body.mask
            let mask: { mime: string, bytes: Buffer } | undefined
            if (typeof maskRaw === 'object' && maskRaw !== null) {
              const rec = maskRaw as Record<string, unknown>
              const b64 = typeof rec.base64 === 'string' ? rec.base64 : ''
              if (b64 !== '') {
                mask = {
                  mime: typeof rec.mime === 'string' && rec.mime !== '' ? rec.mime : 'image/png',
                  bytes: Buffer.from(b64, 'base64'),
                }
              }
            }

            const task = submitGeneration({
              kind,
              ...op === undefined ? {} : { op },
              prompt: str('prompt'), model: str('model'),
              ...str('channelId') === '' ? {} : { channelId: str('channelId') },
              ...str('size') === '' ? {} : { size: str('size') },
              ...num('count') === undefined ? {} : { count: num('count') },
              ...num('seconds') === undefined ? {} : { seconds: num('seconds') },
              /* 种子（票 08）：**给了就用给的，没给由下面那一层随机**。
               * 这里只做一件事 —— 把请求里那个数原样交给 `submitGeneration`。
               * 不在这里补随机值：随机只能取一次，取在 `runComfyBranch`
               * （只有真用得上种子的那条路才取），否则网络模型那条路也会
               * 生出一个没用上的数，记录里就变成假话。 */
              ...num('seed') === undefined ? {} : { seed: num('seed') },
              ...refs.length === 0 ? {} : { refs },
              ...mask === undefined ? {} : { mask },
              ...str('negativePrompt') === '' ? {} : { negativePrompt: str('negativePrompt') },
              ...str('source') === '' ? {} : { source: str('source') },
              ...str('canvasId') === '' ? {} : { canvasId: str('canvasId') },
              ...str('canvasNodeId') === '' ? {} : { canvasNodeId: str('canvasNodeId') },
            })
            send(200, { ok: true, id: task.id, task })
            return
          }
          if (path === '/api/ecom-workbench/generate' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const raw = Number(q.get('limit') ?? '50')
            const list = listTasks(Number.isFinite(raw) && raw > 0 ? raw : 50)
            /* 列表类回包：具名键 + `items` 指向同一个数组（契约 BC 的约定）。 */
            send(200, { ok: true, tasks: list, items: list })
            return
          }
          /* 模型清单（界面做模型下拉用）：**路径是 `/gen-models`，不是 `/models`**。
           *
           * ⚠️ 为什么不能用 `/models`（2026-10-26 踩过一次）：
           * 那个路径**已经被 dsh 的模型目录占了**（本文件后面那条，返回
           * `providers` / `prefs` / `current`，消费方是 `WorkspaceSettings.tsx`）。
           * 路由是「谁先 `return` 谁生效」，两条同名判断**不报错**，先到的把后到的
           * 静静吃掉 —— 表现是「工作台设置页的模型目录整块空白」，而 `check:types`
           * 全绿、没有任何报错。这是本项目 `pitfalls/假防线-看着写了其实不生效.md`
           * 记的同一类病：看着都在，实际只有一条活着。
           *
           * 教训：**加路由前先 `grep` 一遍这个路径存不存在**。`src/index.ts` 有 60+
           * 条路由，重名不会有任何提示。
           *
           * 语义区分：这里是「能生成内容的模型」（从渠道表 `channels.json` 算出来），
           * dsh 那个是「模型目录」（provider / model 清单 + 偏好），两件事。 */
          if (path === '/api/ecom-workbench/gen-models' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const kindRaw = q.get('kind') ?? ''
            const kind = kindRaw === 'image' || kindRaw === 'video' || kindRaw === 'text' || kindRaw === 'audio'
              ? kindRaw : undefined
            /* 按**操作**过滤（契约 T1）：`?op=inpaint` 只列做得了局部重绘的。
             *
             * 判据是「能给这个 op 提供工作流的渠道」——
             * · ComfyUI 渠道：这一类必须有工作流（渠道自己挂的或内置的），
             *   否则它接了单也跑不了（会在生成时报「没挂…工作流」）；
             * · 网络模型渠道：它们的 API 做不了图像操作（超分 / 多角度 / 局部重绘），
             *   所以带 op 的查询里**一条都不列**（列了就是把用户引向一条走不通的路）。
             *   唯一例外是 `caption`（反推提示词）—— 它 kind 是 text，
             *   Gemini 那条路能做，所以不排除。 */
            const opRaw = q.get('op') ?? ''
            const op = isGenOp(opRaw) ? opRaw : undefined
            /* ★ 票 67（2026-10-29）：`?type=` 按五类过滤。
             *
             * 顺序固定为 **kind → op → type**（票面「五、」）。顺序有意义：
             * 前两条是既有调用方在用的粗筛，`type` 是在那之后再细分。
             * 反过来（先 type 再 kind）在这三条判据互不矛盾时结果一样，
             * 但一旦将来某条判据互相矛盾，谁先谁后决定最终留下谁 ——
             * 钉死一个顺序，省得到时候猜。
             *
             * ⚠️ 不传 `type` 时回包与改动前**逐字段一致**：`types` 字段是
             * `ModelOption` 上新增的（见 `listModels` 的注释），除此之外一个字节没动。 */
            /* ★ 票 74（2026-10-29）：类型退回四类（`text` / `image` / `video` / `audio`）。
             *
             * ## 旧取值 `t2i` / `i2i` **当 `image` 处理**，不拒掉
             *
             * 那是票 67 用过两天的取值，界面（票 68 那一版）可能还在发。
             * 拒掉等于模型下拉突然空了，而且要一直空到界面重做完。
             *
             * 当 `image` 处理是**语义安全**的：`t2i` / `i2i` 本来就都是 `image` 的子集，
             * 放宽范围不会选到做不了这件事的模型 —— 真做不了的那条由
             * `generate.ts` 的 `caps` 校验拦住并说清缺什么能力。
             *
             * 一句话：筛窄了会误伤既有调用方，筛宽了最坏只是多列几个模型。
             *
             * ⚠️ `t2i` / `i2i` **不进 `MODEL_TYPES`** —— 进了的话界面那四个勾选框
             * 会冒出两个不该有的选项。它们只活在 `LEGACY_TYPE_ALIAS` 里认旧值。 */
            const typeRaw = q.get('type') ?? ''
            const alias = LEGACY_TYPE_ALIAS[typeRaw]
            const type = isModelType(typeRaw) ? typeRaw : alias
            let list = await listModels(kind)
            if (op !== undefined) list = await filterModelsByOp(list, op)
            /* 过滤用 `typesOfModel`，**拿渠道里的原始模型**判。
             *
             * ⚠️ 为什么不用列表项里的 `m.types`：那个字段是票 70 加的、值也是
             * `typesOfModel` 的结论，两者本该一致。但回表取原始记录这一步留着更稳 ——
             * 列表项是"某一时刻算出来的快照"，而这一层要判的是**现在存着的那份**。
             * 手工标过 `types` 的模型靠的是这一条（手标值在原始记录里）。
             *
             * 这里按 `channelId + modelId` 回表，取不到时退回列表项（渠道刚被改掉的情形）。 */
            if (type !== undefined) {
              const byChannel = new Map((await readChannels()).map(c => [c.id, c]))
              list = list.filter((m) => {
                const raw = byChannel.get(m.channelId)?.models.find(x => x.id === m.modelId)
                /* 取不到原始记录时退回列表项的 `caps` 推导：那说明这条渠道刚被改掉，
                 * 列表是旧的。宁可给出推导结果，也不要把它从所有栏里都删掉。 */
                return typesOfModel(raw ?? m).includes(type)
              })
            }
            send(200, {
              ok: true, models: list, items: list,
              ...op === undefined ? {} : { op },
              ...type === undefined ? {} : { type },
            })
            return
          }
          /* ── 拉模型清单（2026-10-26，T-B-后端）───────────────────────────
           *
           * 用户原话：「新增渠道，连拉取模型都没有，你是在敷衍我吗？」
           *
           * ## 为什么放在 `/channels/:id/models` 而不是 `/gen-models`
           *
           * `/gen-models` 是「**已经配好的**渠道里能用的模型」（从 `channels.json` 算），
           * 这条是「**去上游问一次**它能给什么」。前者读本地、瞬间返回；后者发外网请求、
           * 可能慢、可能失败。两条语义完全不同，混在一起会让界面分不清「空」是什么意思。
           *
           * ⚠️ 路径要先于 `/channels/:id/test` 判吗？不必 —— 那个是 `endsWith('/test')`，
           * 这条是 `endsWith('/models')`，两者不重叠。但**必须**在 `/channels` 那条
           * 精确匹配之前不会撞（那条是 `path === '…/channels'`，也不重叠）。
           *
           * 失败一律回 200 + `ok:false`：这是「拉取结果」不是「接口坏了」。
           * 回 4xx 会让界面把它当异常，而它要的是把 `error` 那句原因显示出来。 */
          if (path.startsWith('/api/ecom-workbench/channels/')
            && path.endsWith('/models') && r.method === 'GET') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/channels/'.length, -'/models'.length))
            if (id === '') { send(400, { ok: false, error: '要拉哪个渠道的模型？没给 id' }); return }
            const all = await readChannels()
            const one = all.find(c => c.id === id)
            if (one === undefined) { send(404, { ok: false, error: '没有这个渠道：' + id }); return }
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const kindRaw = q.get('kind') ?? ''
            const kind = (COMFY_FETCH_KINDS as readonly string[]).includes(kindRaw)
              ? kindRaw as (typeof COMFY_FETCH_KINDS)[number] : undefined
            /* 密钥走 `channelKey`（读 `channels.secret.json`）——
             * `readChannelsWithKey` 只给 `hasKey: boolean`，拿不到本体。 */
            const out = await fetchChannelModels(one, await channelKey(one.id), kind)
            send(200, { ok: out.ok, ...out })
            return
          }
          /* ── 四类默认模型（2026-10-26，T-B-后端）────────────────────────
           *
           * 用户原话：「生图、视频、文本、音频这些的模型设置在哪，
           * 节点是怎么知道自己该用什么模型的？？？」
           *
           * 这一组就是那个「设置」。⚠️ 路径**不是** `/model-prefs` ——
           * 那个名字已经被 dsh 的模型目录用过（`/models/prefs`），
           * 上一轮为此踩过路由撞车（改成 `/gen-models` 那次）。
           * 这里用 `/model-defaults`，grep 过：全文件 0 命中。 */
          if (path === '/api/ecom-workbench/model-defaults' && r.method === 'GET') {
            const defaults = await readModelDefaults()
            /* 顺带把「每一类现在能不能用」算给界面：设了默认、但那个渠道/模型
             * 已经不存在时，界面要能一眼看出来（不然用户以为设好了）。
             *
             * ★ 2026-10-28（票 38）加了**第三条**原因：模型在、但没这一类能力。
             *
             * ## 为什么这一条必须算进来
             *
             * 「存在」不等于「能用」。`src/schedule/generate.ts:543-552` 在真跑之前
             * 会查 `model.caps.includes(effectiveKind)`，不满足就抛「模型 X 没有
             * 「text」能力」。而界面这边原来只看「渠道在不在、模型 id 在不在」，
             * 于是「设了一个没有这类能力的模型」会显示成**绿色的「已设」**，
             * 用户到生成那一刻才失败 —— 正是 `broken` 这套东西要防的情形。
             *
             * 最常见的成因：从上游拉回来的模型 `caps` 是空的（上游只说有什么、
             * 不说能干什么，见 `FetchModelsDialog.tsx` 文件头），用户直接拿去设默认。
             *
             * ⚠️ 回包形状**没改**：`broken` 仍是 `Record<string, string>`，
             * 只是多了一种原因的文字。界面侧不需要任何改动就能显示出来
             * （`kindState` 已经把 `broken` 排在 `status` 之前）。 */
            const all = await readChannels()
            const broken: Record<string, string> = {}
            /* ★ 票 67（2026-10-29）：按**五类**（`MODEL_TYPES`）遍历，判据用 `typesOfModel`。
             *
             * 原来按 `CAPS`（四类）遍历、判据是 `caps.includes(kind)`。
             * 改了之后「文生图」与「图生图」各判各的 —— 一条只会文生图的模型
             * 设在图生图那一栏里会被标出来，而旧写法两个都认 `image`、两个都绿。
             *
             * ⚠️ `CAPS` 与 `MODEL_TYPES` 两套并存（理由见 `model-types.ts` 文件头）：
             * 这里判「界面上算哪一类」，用 `types`；`generate.ts` 判「真能不能出图」，
             * 仍然用 `caps`。两处不能互换。 */
            for (const type of MODEL_TYPES) {
              const ref = defaultOf(defaults, type)
              if (ref === undefined) continue
              const ch = all.find(c => c.id === ref.channelId)
              if (ch === undefined) { broken[type] = '这条默认指向的渠道已经不在了：' + ref.channelId; continue }
              const found = ch.models.find(m => m.id === ref.modelId)
              if (found === undefined) {
                broken[type] = '这条默认指向的模型在这个渠道里找不到了：' + ref.modelId
                continue
              }
              /* 类型这一条排在最后：前两条是「根本找不到」，这一条是「找到了但用不了」，
               * 逐层递进，用户先修前面的。 */
              const types = typesOfModel(found)
              if (!types.includes(type)) {
                const label = MODEL_TYPE_LABEL[type] ?? type
                broken[type] = '这条默认指向的模型不属于「' + label + '」类（它算的是：'
                  + (types.length === 0 ? '未登记' : types.map(t => MODEL_TYPE_LABEL[t] ?? t).join('、'))
                  + '）。到渠道那边给它标上这一项，或换一个模型。'
              }
            }
            send(200, {
              ok: true,
              defaults,
              status: defaultStatus(defaults),
              broken,
              /* ⚠️ **不给 `items`**：这是「一个映射」不是「一组列表项」。
               * `AGENTS.md` 的列表类约定管的是数组型回包（具名键 + `items` 指向同一数组）；
               * 这里四类是四个键，硬包一个 `items: [defaults]` 只会让通用渲染函数读到一个
               * 「只有一个元素的数组」而把四类显示成一条。 */
            })
            return
          }
          if (path === '/api/ecom-workbench/model-defaults' && r.method === 'PUT') {
            const body = await readJsonBody(r) as Record<string, unknown>
            /* 接受两种形状：整份 `{defaultImageModel, …}`，或者 `{defaults: {...}}`。
             * 后者是照 `GET` 的回包直接回发时最自然的写法。 */
            const payload = (typeof body.defaults === 'object' && body.defaults !== null)
              ? body.defaults as Record<string, unknown>
              : body
            const saved = await saveModelDefaults(payload)
            send(200, { ok: true, defaults: saved, status: defaultStatus(saved) })
            return
          }
          /* ── 本地存储目录（2026-10-26，T-B-后端）────────────────────────
           *
           * `/content/dirs` 只「回」路径（那是自检用的）。这一组是**可改**的：
           * GET 看现状（含「这一格改过没有、默认在哪」），PUT 改（改前逐格验可写）。
           *
           * 热生效：目录是每次调用现算的，存完下一次写盘就进新目录，不用重启。
           * **不搬旧文件**：改路径不改数据位置，老产物还在老目录 —— 假装搬家比不搬更糟。 */
          if (path === '/api/ecom-workbench/storage' && r.method === 'GET') {
            const cfg = await readStorageConfig()
            const dirs = dirsSummary()
            send(200, { ok: true, config: cfg, dirs, items: dirs })
            return
          }
          if (path === '/api/ecom-workbench/storage' && r.method === 'PUT') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const src = (typeof body.dirs === 'object' && body.dirs !== null)
              ? body.dirs as Record<string, unknown> : body
            const out = await saveStorageConfig(src)
            if ('error' in out) {
              /* 400 而不是 500：这是「你给的路径不能用」，不是我们坏了。
               * **整份不存** —— 半套配置最难查（用户以为全改了，实际有一格还是旧路径）。 */
              send(400, { ok: false, error: out.error, key: out.key })
              return
            }
            send(200, { ok: true, config: out.config, dirs: dirsSummary(), items: dirsSummary() })
            return
          }
          /* ── 提示词源可配（2026-10-26，T-B-后端）────────────────────────
           *
           * 用户原话：「配置里应有提示词库来源配置」。原来五个源是硬编码常量。
           *
           * 三条规矩：内置五个**删不掉、只能停用**；用户能加自己的；每个能测连通。
           * ⚠️ 顺序：`/config` 与 `/:id` 两组都以 `/prompt-sources/` 开头，
           * 但下面那条已有的 `/:id/refresh` 与 `/:id` 是**两条不同的后缀**，
           * 所以 `GET /prompt-sources/:id` 不会把 `/prompt-sources/config` 吃掉 ——
           * 除了一个例外：源 id 恰好叫 `config` 时会。所以 `config` 这条放**前面**。 */
          if (path === '/api/ecom-workbench/prompt-sources/config' && r.method === 'GET') {
            const sources = await listConfiguredSources()
            send(200, { ok: true, sources, items: sources })
            return
          }
          if (path === '/api/ecom-workbench/prompt-sources/config' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const out = await addSource({
              ...typeof body.id === 'string' ? { id: body.id } : {},
              ...typeof body.name === 'string' ? { name: body.name } : {},
              ...typeof body.url === 'string' ? { url: body.url } : {},
            })
            if ('error' in out) { send(400, { ok: false, error: out.error }); return }
            send(200, { ok: true, sources: out.sources, items: out.sources })
            return
          }
          if (path.startsWith('/api/ecom-workbench/prompt-sources/config/') && r.method === 'PUT') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/prompt-sources/config/'.length))
            const body = await readJsonBody(r) as Record<string, unknown>
            const patch: { enabled?: boolean, name?: string, url?: string } = {}
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
            if (typeof body.name === 'string') patch.name = body.name
            if (typeof body.url === 'string') patch.url = body.url
            const out = await updateSource(id, patch)
            if ('error' in out) { send(400, { ok: false, error: out.error }); return }
            send(200, { ok: true, sources: out.sources, items: out.sources })
            return
          }
          if (path.startsWith('/api/ecom-workbench/prompt-sources/config/') && r.method === 'DELETE') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/prompt-sources/config/'.length))
            const out = await deleteSource(id)
            if ('error' in out) {
              send(out.builtin === true ? 409 : 404,
                { ok: false, error: out.error, builtin: out.builtin === true })
              return
            }
            send(200, { ok: true, sources: out.sources, items: out.sources })
            return
          }
          if (path.startsWith('/api/ecom-workbench/prompt-sources/config/')
            && path.endsWith('/probe') && r.method === 'POST') {
            const id = decodeURIComponent(
              path.slice('/api/ecom-workbench/prompt-sources/config/'.length, -'/probe'.length))
            const out = await probeSource(id)
            /* 测试失败也回 200：这是「测试结果」不是「接口失败」（与渠道 test 一致）。 */
            send(200, { ok: out.ok, ...out })
            return
          }
          /* 渠道连通性测试。三种协议各有最便宜的探测端点，**不真发一次生成**
           * （那要花钱、要等，而且「能生成」不等于「配置对」）。 */
          if (path.startsWith('/api/ecom-workbench/channels/') && path.endsWith('/test') && r.method === 'POST') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/channels/'.length, -'/test'.length))
            if (id === '') { send(400, { ok: false, error: '要测哪一条？没给 id' }); return }
            const out = await testChannel(id)
            /* 测试失败仍然回 200：这是「测试结果」不是「接口失败」——
             * 回 4xx 会让界面把它当异常处理，而它要的是显示那句原因。 */
            send(200, { ok: out.ok, result: out, error: out.ok ? undefined : out.message })
            return
          }
          /* ── 用**还没保存的**密钥去问一次上游（票 36，2026-10-28）───────
           *
           * ## 它补的缺口
           *
           * `GET /channels/:id/models` 要渠道 id —— 也就是**必须先保存一次**才能验。
           * 于是用户「填完密钥 → 想先看看对不对」这条路走不通：得先瞎填着存一次。
           * 用户原话：「模型接口密钥填了后应该可以读取接口支持的模型。」
           *
           * ## 为什么是新开一条而不是给 `/models` 加参数
           *
           * `/channels/:id/models` 的语义是「这条已存的渠道上游有什么」。
           * 混进「拿一份临时凭据去问」会让同一条路由有两种身份来源（id 或请求体），
           * 排查时说不清问的到底是哪一份配置。分开之后：
           *   · `/channels/:id/models` → 读盘上的渠道（不变，一个字段没动）
           *   · `/channels/probe`      → 只认请求体里那三样，**不读也不写盘**
           *
           * ## 三个不许
           *
           * ① **不许落盘**：这是预检，不能因为用户点了「测连通」就凭空多一条渠道；
           * ② **不许回显密钥**：回包里只有结果，密钥连错误信息里都不拼（上游原文里
           *    若带了密钥，那是上游的事 —— 我们只透传它给的 `error` 文本）；
           * ③ **失败也回 200**：与上面 `/test`、`/models` 一致，这是「结果」不是「接口坏了」。
           *
           * ⚠️ 路由顺序：`/channels/probe` 以 `/channels/` 开头，与本段其它三条
           * 后缀（`/test`、`/models`、DELETE 的 `/:id`）都不重叠。 */
          if (path === '/api/ecom-workbench/channels/probe' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const protocol = typeof body.protocol === 'string' ? body.protocol.trim() : ''
            const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
            const apiKey = typeof body.apiKey === 'string' ? body.apiKey : ''
            if (baseUrl === '') {
              /* 空地址是「没东西可问」，不是「上游不通」—— 两者的话完全不同。 */
              send(200, {
                ok: false, models: [], kind: 'unreachable',
                error: '这条渠道还没有接口地址。先填上地址（例如 https://api.openai.com 或 http://127.0.0.1:8188），再来测。',
              })
              return
            }
            if (!(PROTOCOLS as readonly string[]).includes(protocol)) {
              send(200, {
                ok: false, models: [], kind: 'no-endpoint',
                error: '不认识的协议：' + (protocol === '' ? '（没选）' : protocol)
                  + '。只能是 openai / comfyui / gemini 三种之一。',
              })
              return
            }
            /* 上面那条 `includes` 挡过了，这里收窄成协议联合类型 ——
             * `fetchChannelModels` 的参数是 `Pick<Channel, 'protocol' | 'baseUrl'>`，
             * 不收任意字符串。 */
            const proto = protocol as (typeof PROTOCOLS)[number]
            const kindRaw = typeof body.kind === 'string' ? body.kind : ''
            const kind = (COMFY_FETCH_KINDS as readonly string[]).includes(kindRaw)
              ? kindRaw as (typeof COMFY_FETCH_KINDS)[number] : undefined
            /* 两个字段够 `fetchChannelModels` 用（它只要 protocol 与 baseUrl），
             * 所以这里传一个字面量对象，不去碰 channels.json。 */
            const out = await fetchChannelModels({ protocol: proto, baseUrl }, apiKey, kind)
            send(200, { ok: out.ok, ...out })
            return
          }
          /* ── 提示词源（契约 CG，2026-10-26）────────────────────────────
           *
           * ## 它补的缺口
           *
           * 上一轮核查点名：`promptCacheDir()` 造好了**没人写、没人读**，
           * 只在 `/content/dirs` 里露过一次面。这一组路由把「拉 → 缓存 → 读」接上。
           *
           * ## 三层回落（用户 m01114 定的规矩）
           *
           * 缓存 → 内置副本 → 拉取失败仍是内置副本（**并明确说出来**）。
           * 源挂了不能让人打不开提示词库，但也不能让人以为看到的是最新的。
           *
           * ⚠️ refresh 是 `POST` 不是 `GET`：它会写盘、会发外网请求，
           * 用 GET 的话任何一次误点/预取都会触发一次拉取。 */
          if (path === '/api/ecom-workbench/prompt-sources' && r.method === 'GET') {
            /* 列表类回包：具名键 + `items` 指向同一个数组（契约 BC 的约定）。
             * 只回清单（不含 entries）—— 五个源共 800KB，清单页不该搬一遍。
             *
             * ⚠️ **空态要带一句话**：全部源都停用时这里回一个空数组，
             * 界面若只画列表就是一片空白，看着像坏了。`emptyNote` 让界面不必自己去猜
             * 「是没配、是停光了、还是加载失败」—— 这三种在页面上必须长得不一样。 */
            const list = await listPromptSources()
            send(200, {
              ok: true,
              sources: list,
              items: list,
              ...list.length === 0
                ? { emptyNote: '提示词源全被停用了。到「工作台设置 → 提示词源」里启用至少一个，或加一个自己的源。' }
                : {},
            })
            return
          }
          if (path.startsWith('/api/ecom-workbench/prompt-sources/')
            && path.endsWith('/refresh') && r.method === 'POST') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/prompt-sources/'.length, -'/refresh'.length))
            const out = await refreshPromptSource(id)
            /* 失败也回 200：这是「拉取结果」不是「接口失败」。
             * 回 4xx 会让界面把它当异常，而它要显示的是那句原因 + 「用的是内置副本」。 */
            send(200, { ok: out.ok, result: out, error: out.ok ? undefined : out.error })
            return
          }
          if (path.startsWith('/api/ecom-workbench/prompt-sources/') && r.method === 'GET') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/prompt-sources/'.length))
            const got = await readPromptSource(id)
            if (got === null) {
              /* 「没有这个源」与「源被停用了」要分开说 —— 前者该去加一个，后者该去启用，
               * 给同一句「没有这个源」会让人以为配置丢了。 */
              const cfg = (await listConfiguredSources()).find(s => s.id === id)
              send(404, {
                ok: false,
                disabled: cfg !== undefined && !cfg.enabled,
                error: cfg !== undefined && !cfg.enabled
                  ? '这个提示词源已停用：' + id + '（要用它先到「工作台设置 → 提示词源」里启用）'
                  : '没有这个提示词源：' + id,
              })
              return
            }
            /* `from` 与 `note` 必须一起回：界面靠它们说清「这是缓存还是内置副本」。 */
            send(200, { ok: true, source: got.source, from: got.from, note: got.note })
            return
          }
          /* ── 内容画布（契约 AX，Step 3.1 的宿主半）──────────────────────
           *
           * `nodes` / `edges` / `viewport` **原样存原样取**：本层不解释它们。
           * 列表只回 `nodeCount` 不回节点内容 —— 一个画布可能几十个节点，
           * 列表页不该把它整份搬一遍。 */
          if (path === '/api/ecom-workbench/canvases' && r.method === 'GET') {
            /* 列表类回包：具名键 + `items` 指向同一个数组（契约 BC 的约定）。 */
            const list = await listCanvases()
            send(200, { ok: true, canvases: list, items: list })
            return
          }
          if (path === '/api/ecom-workbench/canvases' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            send(200, { ok: true, canvas: await createCanvas(body) })
            return
          }
          if (path.startsWith('/api/ecom-workbench/canvases/')) {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/canvases/'.length))
            /* `id` 只许 `[A-Za-z0-9_-]`：它是文件名，非法值一律当「没有这个画布」，
             * 不进 `loadCanvas`。 */
            if (!isCanvasId(id)) {
              send(404, { ok: false, error: '没有这个画布：' + id })
              return
            }
            if (r.method === 'GET') {
              const doc = await loadCanvas(id)
              send(doc === null ? 404 : 200, doc === null
                ? { ok: false, error: '没有这个画布：' + id }
                : { ok: true, canvas: doc })
              return
            }
            if (r.method === 'PUT') {
              const body = await readJsonBody(r) as Record<string, unknown>
              /* 先确认存在：`PUT` 一个不存在的 id 不该「顺手建出来」——
               * 那会把「界面拿着一个已删的画布继续自动保存」变成悄悄复活。 */
              if ((await loadCanvas(id)) === null) {
                send(404, { ok: false, error: '没有这个画布：' + id })
                return
              }
              const doc = await saveCanvas(id, body)
              send(doc === null ? 404 : 200, doc === null
                ? { ok: false, error: '没有这个画布：' + id }
                : { ok: true, canvas: doc })
              return
            }
            if (r.method === 'DELETE') {
              const gone = await deleteCanvas(id)
              send(gone ? 200 : 404, gone
                ? { ok: true }
                : { ok: false, error: '没有这个画布：' + id })
              return
            }
          }
          /* ── 生成记录（契约 BA，2026-10-25）────────────────────────────
           *
           * ⚠️ **本期没有生成链路**：没有渠道调用、没有出图。这两条路由只负责
           * 读写磁盘上的记录 —— 现在这些记录是**手工放进去的**（或以后接生成链条
           * 由它写）。不许因为「列表里有三条」就说生成跑通了。
           *
           * 为什么不给写接口：形状定了（`plans/2026-10-25-执行-生成记录与两个工作台.md`
           * §2.2），但写入者是生成链路。现在开一条 POST 等于让人提前手填记录，
           * 填出来的数据会混进以后的真记录里，分不清。 */
          if (path === '/api/ecom-workbench/gen-logs' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const kind = q.get('kind') === 'video' ? 'video' : 'image'
            const rawLimit = Number(q.get('limit') ?? '100')
            const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 100
            /* 列表类回包：具名键 + `items` 指向同一个数组（契约 BC 的约定）。 */
            const logs = await listGenLogs(kind, limit)
            send(200, { ok: true, kind, logs, items: logs })
            return
          }
          /* 删一条生成记录（票 44）。
           *
           * ## 为什么只删记录、不连带产物
           *
           * 产物在 `artifacts/` 是另一个库，记录里只是 id 引用；一张图可能还被画布用着。
           * 界面那侧要删产物时**自己另发 `DELETE /artifact/:id`**，并且先问过
           * `GET /artifacts/usage`。把两件事混成一颗路由，等于替用户做了个他没要的决定。
           *
           * ## 为什么必须在拼路径之前校验
           *
           * `:id` 来自 URL。不校验时一个 `../` 就能删到别的文件 —— 那是安全漏洞。
           * `deleteGenLog` 内部已经 `isGenLogId` 校验过一次，这里再挡一道是为了
           * **回一个明确的 400**（内部返回 `false` 分不清「不合法」与「没这条」）。 */
          if (path.startsWith('/api/ecom-workbench/gen-logs/') && r.method === 'DELETE') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/gen-logs/'.length))
            if (!isGenLogId(id)) {
              send(400, { ok: false, error: '记录 id 不合法：' + id })
              return
            }
            const gone = await deleteGenLog(id)
            send(gone ? 200 : 404, gone ? { ok: true } : { ok: false, error: '没有这条生成记录：' + id })
            return
          }
          if (path.startsWith('/api/ecom-workbench/gen-log/') && r.method === 'GET') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/gen-log/'.length))
            const log = await readGenLog(id)
            if (log === null) { send(404, { ok: false, error: '没有这条生成记录：' + id }); return }
            send(200, { ok: true, log })
            return
          }
          /* ── 产物引用计数（契约 BA，Step 4.1）──────────────────────────
           * 每次现扫 `canvases/*.json`，**不建索引文件**（计划 §三 4.1 定的）。
           * 界面删产物前调它，被引用就弹确认框说清「删了那几处会显示图已删除」。 */
          if (path === '/api/ecom-workbench/artifacts/usage' && r.method === 'GET') {
            send(200, { ok: true, usage: await artifactUsage() })
            return
          }
          /* ── 素材库（契约 BA，Step 4.2）──
           * 读目录、不建索引。上传走 base64 + JSON（同 `POST /artifact`），
           * 代价是 >6 MB 的文件传不了 —— 写进了 `src/schedule/materials.ts` 的文件头。
           *
           * ★ 票 34（2026-10-28）加文本素材：同一份目录里多一种 `<id>.text.json`，
           * 一条素材一个文件（**仍然不建索引**，理由见 `materials.ts` 文件头）。
           * 存文本走 `POST /materials/text`，那条路的输入是标题 + 正文，不是 base64。 */
          if (path === '/api/ecom-workbench/materials' && r.method === 'GET') {
            /* 列表类回包：具名键 + `items` 指向同一个数组（契约 BC 的约定）。
             * 每一项多了 `kind`（`image` / `video` / `text`），老字段一个没动。 */
            const materials = await listMaterials()
            send(200, { ok: true, dir: materialsDir(), materials, items: materials })
            return
          }
          /* 存一条文本素材（票 34）。**必须在 `/materials` 的 POST 之前判** ——
           * 否则会先落到图片视频那条路，被「只收图片与视频」挡掉。 */
          if (path === '/api/ecom-workbench/materials/text' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            try {
              send(200, { ok: true, material: await saveTextMaterial({ title: body.title, content: body.content, name: body.name }) })
            } catch (e) {
              send(400, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          if (path === '/api/ecom-workbench/materials' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            const base64 = typeof body.base64 === 'string' ? body.base64 : ''
            try {
              send(200, { ok: true, material: await saveMaterial(name, base64) })
            } catch (e) {
              send(400, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          if (path.startsWith('/api/ecom-workbench/materials/') && r.method === 'DELETE') {
            const name = decodeURIComponent(path.slice('/api/ecom-workbench/materials/'.length))
            const gone = await deleteMaterial(name)
            send(gone ? 200 : 404, gone ? { ok: true } : { ok: false, error: '没有这个素材：' + name })
            return
          }
          /* 素材是**二进制**：与产物那条分开，不去凑产物 id 索引（那是另一张表）。 */
          if (path.startsWith('/api/ecom-workbench/material/') && r.method === 'GET') {
            const name = decodeURIComponent(path.slice('/api/ecom-workbench/material/'.length))
            const got = await loadMaterial(name)
            if (got === null) {
              w.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
              w.end(JSON.stringify({ error: '没有这个素材：' + name }))
              return
            }
            w.writeHead(200, {
              'content-type': got.mime,
              'content-length': String(got.data.length),
              'cache-control': 'no-cache',
            })
            w.end(got.data)
            return
          }
          /* 删产物：本体 + 元数据都真删（计划 §4.1「资产库是主」）。
           * 被引用不拦着 —— 界面删之前已经问过 `artifacts/usage` 并弹过确认框。 */
          if (path.startsWith('/api/ecom-workbench/artifact/') && r.method === 'DELETE') {
            const id = decodeURIComponent(path.slice('/api/ecom-workbench/artifact/'.length))
            const gone = await deleteArtifact(id)
            send(gone ? 200 : 404, gone ? { ok: true } : { ok: false, error: '没有这个产物：' + id })
            return
          }
          if (path === '/api/ecom-workbench/health' && r.method === 'GET') {
            send(200, { ok: true, runs: d.list().length, workdir: process.cwd() })
            return
          }
          if (path === '/api/ecom-workbench/runs' && r.method === 'GET') { send(200, d.list()); return }

          /**
           * 检测本机有哪些浏览器可用（用户 2026-10-13 要的「增加一个检测功能」）。
           *
           * ## 为什么在宿主半做
           *
           * 它要**读磁盘 / 查端口** —— 客户端半（浏览器里跑）两样都做不到
           * （拿不到文件系统、也连不了 127.0.0.1:9222）。
           * 宿主半本来就是「唯一能碰磁盘的一侧」（`AGENTS.md` 的分层）。
           *
           * ## 检测三层（用户原话：「我的电脑应该有很多浏览器可以用，
           * 包括 playwright 默认打包的浏览器……另外我们的 CDP 也列进去」）
           *
           *   ① 系统里装了的（按各平台常见安装路径找）
           *   ② Playwright 自带的那份（它在缓存目录下）
           *   ③ CDP 端口在不在听（用户的常驻浏览器 —— 我们要复用的登录态）
           *
           * ⚠️ **只读、不改任何东西**：`existsSync` + 一次 `net.connect` 探端口。
           */
          if (path === '/api/ecom-workbench/browser/detect' && r.method === 'GET') {
            send(200, await detectBrowsers())
            return
          }
          /**
           * 查**一个**用户手填的端口是不是 CDP 端点（用户 2026-10-14 要的「检测」）。
           *
           * ## 为什么要单开一条（而不是只靠上面那条全扫）
           *
           * 全扫要 2 秒左右（实测 50 个端口 2145ms），适合「我不知道端口，帮我找」。
           * 而用户**已经填了一个**端口时，他只想知道「这个对不对」——
           * 那条路径只要 1 毫秒（实测）。两者混在一起会让「我填完了，确认一下」
           * 也要等 2 秒。所以分开。
           *
           * ## 三态回复（这是本条路由存在的理由）
           *
           *   `listening:false`                        → 没人在听（那个浏览器没开 / 端口错）
           *   `listening:true, browser:null`           → 有程序在听，但它**不是**浏览器调试端口
           *   `listening:true, browser:'Chrome/...'`   → 就是它 ✓
           *
           * ⚠️ **只读**：一次 TCP 连接 + 一次 HTTP GET，不启动任何东西。
           */
          if (path === '/api/ecom-workbench/browser/cdp' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const norm = normalizePort(q.get('port') ?? '')
            if (norm === '') {
              send(400, { error: '端口不合法（要是 1–65535 的数字）：' + (q.get('port') ?? '') })
              return
            }
            const port = Number(norm)
            const listening = await probePort(port)
            const browser = listening ? await probeCdp(port) : null
            send(200, { ok: true, port, listening, browser })
            return
          }
          /* ── 环境检测（用户 m03425 第 6 条：「在工作流管理 tab 中增加一个
           * 环境检测按钮」）────────────────────────────────────────────
           *
           * ## 检测什么（以及为什么只检测这些）
           *
           * 用户原话：「你思考一下应该检测些什么，节点依赖，浏览器准备（特别是
           * 默认浏览器是否可用，比如默认浏览器如果是 cdp，那么这个 cdp 接口
           * 是否可用需要验证）。**现在不必求全**，因为依赖声明这个部分还没做，
           * 将部分没实现后期准备完善的部分写入总纲即可。」
           *
           * 所以这里只报**现在真能查出来**的三件事：
           *
           *   ① **存档引用的节点类型是否都还在**（`defs`）——
           *      这是「节点依赖」现在唯一能验证的部分。节点库删掉某个定义、
           *      老存档里还引用着它 → 那份工作流打开就缺节点。**能查、且用户真会遇到**。
           *      真正的「npm 包 / 外部程序 / 环境变量」依赖检测**做不了**：
           *      节点目录里一个 `deps.json` 都没有、也没有代码读它
           *      （见 `src/workflow/model.ts` 的说明）—— 那部分在总纲里挂着。
           *
           *   ② **浏览器准备**（`browsers`）—— 机器上找到几个能用的。
           *
           *   ③ **CDP 端点**（`cdp`）—— 现在有几个调试端口在听。
           *      ⚠️ 「默认来源是不是 CDP、那个端口通不通」**不由这里判断** ——
           *      默认值存在浏览器 localStorage 里（`browserPrefs`），宿主半读不到。
           *      所以这里只给**机器事实**，由客户端拿它跟自己那份偏好对照
           *      （见 `WorkflowList.tsx` 的 `checkEnv`）。
           *
           * ⚠️ **只读**：读存档目录、跑一次浏览器检测（`existsSync` + 探端口），
           * 不改任何东西、不启动任何东西。 */
          if (path === '/api/ecom-workbench/env-check' && r.method === 'GET') {
            const known = new Set(NODE_LIBRARY.map(x => x.id))
            const saved = await listWorkflows()
            /* 判缺类型是**纯逻辑**，住在 `workflow/env-check.ts`（可单测）。
             * 这里只负责「读存档目录」这一件 IO —— 照 AGENTS.md 的分层。 */
            const gaps = scanNodeGaps(saved, known)
            /* 依赖判定（票 22）：每次请求现查，不缓存。
             *
             * 为什么现查：缓存正好在最该准的时候过期 —— 用户看到「缺 python」
             * → 去装 → 回来点「环境检测」，缓存会让他继续看见「缺」，直到重启。
             * 而四种探测都便宜（一次 resolve、几次 existsSync、一次 env 取值），
             * 五条声明的量级是毫秒。判据写在票 22 的进度里。 */
            const deps = judgeLibrary(NODE_LIBRARY)
            const det = await detectBrowsers()
            const usable = det.browsers.filter(b => b.path !== null)
            send(200, {
              ok: true,
              workdir: process.cwd(),
              nodes: {
                library: NODE_LIBRARY.length,
                workflows: saved.length,
                gaps,
                /* 已经实现（票 22）。留着这个键而不是删掉：删了会让老版本的界面
                 * 读不到它、按 `undefined` 走「没实现」那条提示 —— 那是假话。 */
                depsImplemented: true,
                /* 缺件的节点类型（只报不满意的那些）。每项带 `kind` / `name` / `reason`。 */
                depsMissing: deps.map(d => ({ id: d.id, gaps: d.gaps, reason: d.reason })),
                /* 查了哪些类（四类全查）。界面据此说「查过这四类」而不是笼统「查过了」。 */
                depsChecked: ['npm', 'bin', 'env', 'files'],
              },
              browsers: {
                total: det.browsers.length,
                usable: usable.length,
                found: usable.map(b => b.name),
              },
              cdp: det.cdp,
              platform: det.platform,
            })
            return
          }
          /* ── 节点依赖现状（票 22，2026-10-27）────────────────────
           *
           * `/env-check` 那条要读存档目录、跑浏览器检测，代价不小，而画布只需要
           * 「哪些节点类型缺依赖」这一件事。所以单开一条只做依赖判定的路由：
           * 画布挂载时取一次，把缺件的节点标成 `missing`。
           *
           * 判据只读、不写：不碰存档、不启进程、不改任何状态。
           * `ok` 恒为 true（这是「查询结果」不是「操作结果」）；
           * 缺件的清单在 `missing[]`，全齐时是空数组。 */
          if (path === '/api/ecom-workbench/nodes/deps' && r.method === 'GET') {
            /* 每次现查，不缓存 —— 理由与 `/env-check` 那句相同：
             * 缓存会在「用户刚装完东西回来再看」这个最该准的时刻给出旧答案。 */
            const deps = judgeLibrary(NODE_LIBRARY)
            send(200, {
              ok: true,
              /* 查了哪些类。界面据此说「查过这四类」，不是笼统「查过了」。 */
              checked: ['npm', 'bin', 'env', 'files'],
              missing: deps.map(d => ({ id: d.id, gaps: d.gaps, reason: d.reason })),
            })
            return
          }
          /* ── 浏览器偏好（2026-10-20）────────────────────────────
           *
           * 为什么要有这条路由：偏好原来只存**浏览器的 localStorage**，
           * 宿主半（独立 Node 进程）读不到。而「从列表 / 定时启动」不经过画布，
           * 于是存档里的 port 是空的 → 驱动报「连不上浏览器」。
           *
           * 现在画布改设置时同时写这里（文件是权威），宿主半跑之前读它。
           * localStorage 仍然保留 —— 那是画布的快速缓存，不是第二份真相。
           *
           * GET  → 读（文件不存在返回一份空偏好，不是 404：前端用它当初始值）
           * POST → 写（只接受能归一的形状，写坏了下次读回来还是可用的） */
          if (path === '/api/ecom-workbench/browser/prefs' && r.method === 'GET') {
            const p = await readBrowserPrefs()
            send(200, { ok: true, prefs: p ?? normalizePrefs(null) })
            return
          }
          if (path === '/api/ecom-workbench/browser/prefs' && r.method === 'POST') {
            const body = await readJsonBody(r) as { prefs?: unknown }
            const prefs = normalizePrefs(body.prefs)
            try {
              const dir = join(workflowsDir(), "..")
              await mkdir(dir, { recursive: true })
              await writeFile(join(dir, PREFS_FILE), JSON.stringify(prefs, null, 2), "utf8")
              send(200, { ok: true })
            } catch (e) {
              send(500, { ok: false, error: '写偏好失败：' + (e instanceof Error ? e.message : String(e)) })
            }
            return
          }
          /* ── 提醒偏好（2026-10-22，同日改成两项独立设置）──────
           *
           * 用户原话：「应该改成每个独立的设置：失败是否提醒、预警节点什么级别才提醒」。
           * 形状与旧文件迁移都在 `src/notify/prefs.ts`（宿主半与 `flow.notify` 共用一份规则）。
           *
           * GET  → 读（文件不存在返回默认值，不是 404：前端用它当初始值；
           *        旧文件 `{ mode }` 在读取时翻译成新形状，磁盘不动）
           * POST → **部分更新**（只改传进来的键，其余保持；非法字段跳过，照样回 200 ——
           *        与 `/browser/prefs`、`/ui/prefs` 同一取舍） */
          if (path === '/api/ecom-workbench/notify/prefs' && r.method === 'GET') {
            send(200, { ok: true, prefs: await readNotifyPrefs() })
            return
          }
          if (path === '/api/ecom-workbench/notify/prefs' && r.method === 'POST') {
            const body = await readJsonBody(r) as { prefs?: unknown }
            try {
              send(200, { ok: true, prefs: await writeNotifyPrefs(body.prefs) })
            } catch (e) {
              send(500, { ok: false, error: '写提醒偏好失败：' + (e instanceof Error ? e.message : String(e)) })
            }
            return
          }
          /* ── 界面偏好（2026-10-22）──────────────────────────────
           *
           * 启动器用 `--port 0`，浏览器存储按「域名 + 端口」隔离 → 重启就丢。
           * 所以「顶部收起 / 侧栏收起 / 节点库宽 / 图例 / 节点宽」五个开关落到文件，
           * 规则与逐字段容错在 `src/prefs/ui-prefs.ts`。
           *
           * GET  → 读（文件不存在返回全默认值，不是 404：前端用它当初始值）
           * POST → **部分更新**（只改传进来的键、其余保持；非法字段跳过，照样回 200，
           *        与 `/browser/prefs`、`/notify/prefs` 同一取舍） */
          if (path === '/api/ecom-workbench/ui/prefs' && r.method === 'GET') {
            send(200, { ok: true, prefs: await readUiPrefs() })
            return
          }
          if (path === '/api/ecom-workbench/ui/prefs' && r.method === 'POST') {
            const body = await readJsonBody(r) as { prefs?: unknown }
            try {
              send(200, { ok: true, prefs: await writeUiPrefs(body.prefs) })
            } catch (e) {
              send(500, { ok: false, error: '写界面偏好失败：' + (e instanceof Error ? e.message : String(e)) })
            }
            return
          }
          /* ── 模型目录与工作台自己的模型偏好（2026-10-23，契约 H）────
           *
           * 用户原话：「不应该只设置一个默认模型，而是应该自动读取模型列表……
           * 模型列表从 dsh 中读。被选择的模型进入备选名单……
           * **不是所有的 dsh 模型都读入工作台**」。
           *
           * 所以这条读接口同时给三样：
           *   - `providers`：dsh 的**全集**（只读、只给下拉用，不进任何存储）；
           *   - `prefs`：工作台自己的**子集**（一个默认 + 一份备选名单）；
           *   - `current`：dsh 当前选中的那个（界面上标一下「dsh 默认」用）。
           *
           * ⚠️ `picks` 里**只放用户挑过的** —— 不许把 `providers` 整个倒进去。 */
          if (path === '/api/ecom-workbench/models' && r.method === 'GET') {
            const out = await readModelsCatalog()
            send(200, { ok: true, ...out })
            return
          }
          if (path === '/api/ecom-workbench/models/prefs' && r.method === 'POST') {
            const body = await readJsonBody(r) as { default?: unknown, picks?: unknown }
            try {
              /* 整个 body 当 patch 传：`{ default, picks }` 两个都可选，只传哪个改哪个。 */
              send(200, { ok: true, prefs: await writeModelPrefs(body) })
            } catch (e) {
              send(500, { ok: false, error: '写模型偏好失败：' + (e instanceof Error ? e.message : String(e)) })
            }
            return
          }
          if (path === '/api/ecom-workbench/run' && r.method === 'POST') {            /* 客户端断开 = 用户点了「停止」：把取消信号传下去，
             * 执行方会终止子进程并等整棵进程树退干净（不 terminate 只 waitForExit 会漏孙进程）。
             *
             * ## ⚠️ 判据必须挂在**响应** `w` 上，不能用 `r.on('close')`（2026-10-23 修 P0）
             *
             * 原来是 `r.on('close', () => { if (!w.writableEnded) ac.abort() })`，
             * 它**在每次正常请求时都会触发**：Node 真 HTTP 下 `req` 的 `close`
             * 是「请求体读完了」，不是「连接断了」。实测时序（真 `http.createServer`
             * + 一次正常 fetch）：
             *
             *   req close at +1ms    writableEnded=false  writableFinished=false
             *   body done at +1ms
             *   res.end  at +59ms
             *
             * 于是 `!w.writableEnded` 在 1 毫秒时必然成立 → `ac.abort()` →
             * 派发器把信号接通之后（契约 S1），执行方看到 `signal.aborted === true`，
             * 如实报 `cancelled`。**每一次 `/run` 一进来就被判成取消，模型一次都没调。**
             * （S1 之前这个信号被派发器丢掉，所以这个错判被掩盖着，测试全绿也看不出来。）
             *
             * ## 为什么换 `w.on('close')` + `writableFinished`
             *
             * 「客户端真的断开」在响应流上的表现是 `close` **且**没写完。
             * 正常请求：`req.close`(+1ms) → `res.finish` → `res.close`(+62ms, `writableFinished=true`)；
             * 客户端中途断开：`res.close`(+1ms, `writableFinished=false`)。
             * 只有这一对能分开两者（`writableEnded` 分不开 —— 它只是「标记要结束」）。
             *
             * ## 为什么 `r` 的 close 一个都不留
             *
             * `r.close` 在这里**没有第二种含义可用**：它既可能是「体读完」，也可能是「断开」，
             * 而这个区别恰恰是我们分不出来的（`readableEnded` 可以参考，但请求体被截断时
             * 也可能为 true）。留一个"可能有意义"的监听，等于留一处会误判的隐患；
             * 而「请求体都没读完就断」这种情形**不需要单独处理**：那时 `readJsonBody` 会
             * 拿到不完整的 JSON 并抛错，路由照常回 4xx，没有派发就没有要取消的东西。
             * 所以按「一条不留隐患的写法」处理：`r` 的监听删掉，只留 `w` 这一条。 */
            const ac = new AbortController()
            w.on('close', () => { if (!w.writableFinished) ac.abort() })
            const body = await readJsonBody(r)
            const list = Array.isArray(body) ? body : [body]
            /** 逐个派发；上游输出按 payload.context.upstream 原样转交。 */
            const results = await Promise.all(list.map(async (item) => {
              const q = item as DispatchBody
              return await d.dispatch({
                runId: q.runId ?? '',
                nodeId: q.nodeId ?? '?',
                executor: (q.executor ?? 'builtin') as ExecutorKind,
                command: q.command,
                context: {
                  workflowId: q.context?.workflowId ?? '',
                  upstream: q.context?.upstream ?? [],
                  workdir: q.context?.workdir ?? process.cwd(),
                  env: q.context?.env,
                },
                signal: ac.signal,
              })
            }))
            send(200, { results })
            return
          }
          /* ── 节点流订阅（票 28 第二步，2026-10-27）──────────────────
           *
           * ## 它补的是哪一段
           *
           * 票 14 让 agent 节点在宿主半逐片吐字，但那个回调挂在命令体的 `__onStream`
           * 上，而命令体要过 `JSON.stringify` —— 函数被静静丢掉。画布按 ▶ 那条路
           * （`POST /run`）因此一个分片都收不到。
           *
           * 这条路由让画布**先开一条订阅**，宿主半把「往这条响应写」的闭包存进
           * `nodeStreams`（键是 `runId`）。闭包留在进程里，没有序列化这回事 ——
           * 这才是能绕开 `JSON.stringify` 的原因。
           *
           * ## 帧形状与 `step` 帧逐字一致
           *
           * 画布那侧的 `onEvent` 已经在认 `{kind:'stream', nodeId, text}`（第一步做了），
           * 所以这里只要照那个形状发，两边天然对上，不必另立一套。
           *
           * ## `done` 帧不能省
           *
           * `EventSource` 断线会**自动重连**（`FlowRunPanel.tsx:224` 记着这个坑）。
           * 没有终止帧的话，这条流跑完就被重订一次 —— 客户端那边多开一条订阅，
           * 而宿主半的表里多一条没人用的条目。
           *
           * ## 与 `/run` 的关系：**互不知道对方**
           *
           * `/run` 那条路由一个字节都没改（它那段 P0 注释记着断流判据，
           * 改流式会让那个判据失效）。这条路只是「一张表 + 一条流」，
           * 两边靠 `runId` 在表里对上。
           *
           * ⚠️ **断开连接不当作取消**：与 `/workflow/run-stream` 一致 ——
           * 用户可能切走页面，节点照跑，只是没人听了。 */
          if (path === '/api/ecom-workbench/run-node-stream' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const runId = q.get('runId') ?? ''
            if (!isRunIdShape(runId)) { send(400, { error: 'runId 不合法' }); return }

            w.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              /* 反向代理下要这一条才不会缓冲（本机直连时无副作用）。 */
              'x-accel-buffering': 'no',
            })

            /** 发一条 SSE 消息（`event:` + `data:`）。 */
            const sse = (event: string, data: unknown): void => {
              /* ⚠️ 写完要判 `writableEnded`：客户端断开后继续写会抛。 */
              if (w.writableEnded) return
              w.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n')
            }

            /**
             * 收尾这条流：发 `done` 帧并关连接（**幂等**，且不许抛）。
             *
             * ⚠️ 必须先用 `const` 声明、再交给上面那个 `finish`（见下面的登记处）。
             */
            let finished = false
            const bye = (): void => {
              if (finished) return
              finished = true
              try {
                if (!w.writableEnded) {
                  /* 给一条 `done`：客户端那边据此收尾，不去重连。 */
                  sse('done', { ok: true })
                  w.end()
                }
              } catch { /* 断开时的任何错都不该冒出去 */ }
            }

            /* 登记：把「往这条响应流写」与「收尾这条流」一起塞进表。
             * **这是全仓唯一建表的地方** —— `__runId` 只查表、不建表
             * （理由见 `nodeStreams` 的注释）。 */
            nodeStreams.set(runId, {
              at: Date.now(),
              sink: (frame) => { sse('step', frame) },
              finish: bye,
            })

            /* 清场路径 ③：客户端断开（画布关掉 / 点停止 / 页面切走）。
             *
             * ⚠️ **不许抛错**：这里只是「没人听了」这件正常事，
             * 抛出去会把那条连接的错误日志弄脏。
             *
             * ⚠️ 这条 GET 没有请求体，所以 `r.on('close')` 只剩「连接断了」一个含义
             * （判据的完整推导在 `/workflow/run-stream` 那段注释里，同一套事实）。
             * 两条都挂上是因为不同运行时上 `res` 的 `close` 时序不同。
             *
             * ⚠️ 这里**只删条目、不再走 `finish`**：客户端已经断开了，
             * 再往那条流写 `done` 没有意义（`sse` 里判过 `writableEnded`，
             * 但 `destroy` 之后不一定置位）。所以直接 `delete`。 */
            const byeByClient = (): void => {
              try {
                finished = true
                nodeStreams.delete(runId)
              } catch { /* 断开时的任何错都不该冒出去 */ }
            }
            r.on('close', byeByClient)
            w.on('close', byeByClient)
            return
          }
          /* ── 工作流存档（画布的保存/导入/打开）─────────────────
           * 为什么放宿主半：浏览器里存不了本机文件；宿主半是插件里唯一能碰磁盘的一侧。 */
          if (path === '/api/ecom-workbench/workflows' && r.method === 'GET') {
            const items = await listWorkflows()
            /* 列表里补「节点数 / 连线数 / 修改时间」——列表界面要这些才看得出哪份是哪份，
             * 光有名字的话，用户看着一堆「工作流-20261008」分不清哪个是哪个。 */
            const rich = items.map(x => {
              const doc = x.doc as { nodes?: { defId?: string, params?: Record<string, unknown> }[], edges?: unknown[], description?: unknown } | null
              return {
                name: x.name,
                /* ★ 编号（2026-10-19）：`flow.workflow` 节点引用它，不引用名字。
                 * 列表界面不需要显示它，但「选一份工作流」的控件要它当值。 */
                id: x.id,
                nodes: Array.isArray(doc?.nodes) ? doc.nodes.length : 0,
                edges: Array.isArray(doc?.edges) ? doc.edges.length : 0,
                /* 一句话说明（用户 2026-10-14 要求显示在列表里）。
                 * ⚠️ 老存档没这个字段 → 给空串（列表不显示那一行），**不报错、不当坏档**。 */
                description: typeof doc?.description === 'string' ? doc.description : '',
                /* 「谁能启动它」由**开始节点的类型**决定（用户 m00901 定案）。
                 * 列表要据此隐藏「执行」按钮 —— 所以这里把类型一起给出去，
                 * 免得前端为每一行各发一次请求。
                 * ⚠️ 没有开始节点时是 `null`（老存档）—— 那种情况**照旧显示**
                 * 执行按钮（它自己带初始数据，手动跑没问题）。 */
                /* 工作流类型（用户 m00861）：给人看与筛选用，**不参与执行判断**。
                 * 读法只有一处（workflow-types.ts 的 readTypes），与画布共用。 */
                types: readTypes(doc),
                startType: (() => {
                  const st = Array.isArray(doc?.nodes) ? doc.nodes.find(n => n.defId === 'flow.start') : undefined
                  return typeof st?.params?.type === 'string' ? st.params.type : null
                })(),
                at: x.at,
              }
            })
            send(200, { dir: workflowsDir(), items: rich })
            return
          }
          if (path === '/api/ecom-workbench/workflows' && r.method === 'POST') {
            const body = await readJsonBody(r) as { name?: string, doc?: unknown }
            const name = typeof body.name === 'string' && body.name !== '' ? body.name : '未命名工作流'
            const saved = await saveWorkflow(body.doc ?? {}, name)
            /* `id` 一起回给客户端：画布要拿它回写自己的 `wfId`，
             * 否则「保存一份老存档」之后画布还以为它没有编号，
             * 下一次保存又会走派生那条路（详见 `workflow-doc.ts` 的 `WorkflowDoc.id`）。 */
            send(200, { ok: true, path: saved.path, name: saved.name, id: saved.id })
            return
          }
          /* ── 跑一份工作流，**边跑边推**（SSE；用户 m00789 定案用 SSE）─────
           *
           * ## 与上面那条 `POST /workflow/run` 的分工
           *
           * 那条是「跑完一次性返回日志」——画布与列表页那条路用惯了，**保留不动**。
           * 这条是**边跑边推**：前端面板要按时间摊开每一步（bat 那种效果），
           * 等跑完再一次性给就没有「正在进行」的感觉了。
           *
           * ## 为什么用 SSE 而不是 WebSocket
           *
           * 用户 m00789 定的是 SSE。事实依据：这里的数据流**单向**（服务器 → 浏览器），
           * 而 WebSocket 要额外协议升级、要心跳管理，对单向推送没有好处。
           * ⚠️ SSE 是**浏览器原生**的 `EventSource`，但 `EventSource` 只能发 GET、
           * 不能带请求体 —— 所以**输入通过查询串传**（字段不多，够用）。
           *
           * ## 断开连接不当作取消（与上一条一致）
           *
           * 用户可能点了按钮就切走页面。断开只是没人听了，**运行照旧跑完**、
           * 照旧写运行记录。
           */
          if (path === '/api/ecom-workbench/workflow/run-stream' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const name = q.get('name') ?? ''
            const workflowId = q.get('workflowId') ?? ''
            /* ★ 引用（2026-10-19）：编号优先、名字兼容（与 `/workflow/run` 同一条规矩）。 */
            const ref = {
              ...(workflowId !== '' ? { id: workflowId } : {}),
              ...(name !== '' ? { name } : {}),
            }
            if (ref.id === undefined && ref.name === undefined) { send(400, { error: '要跑哪一份？没给 name' }); return }

            /* 输入走查询串（EventSource 不能带 body）：`?inputs=<JSON>`。
             * 形状不对就当没给 —— 让它跑到「必填没给」那条日志上，比在这里 400 更好查。 */
            let inputs: Record<string, unknown> | undefined
            const rawInputs = q.get('inputs')
            if (rawInputs !== null && rawInputs !== '') {
              try {
                const parsed = JSON.parse(rawInputs) as unknown
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  inputs = parsed as Record<string, unknown>
                }
              } catch { /* 形状不对 → 当没给 */ }
            }

            w.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              /* 反向代理下要这一条才不会缓冲（本机直连时无副作用）。 */
              'x-accel-buffering': 'no',
            })

            /** 发一条 SSE 消息（`event:` + `data:`）。 */
            const sse = (event: string, data: unknown): void => {
              /* ⚠️ 写完要判 `writableEnded`：客户端断开后继续写会抛。 */
              if (w.writableEnded) return
              w.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n')
            }

            /* ## 这里为什么可以继续用 `r.on('close')`（2026-10-23 核过，不是漏改）
             *
             * 与 `/run` 那条的关键差别：**这条是 GET，没有请求体**。
             * `/run` 那条踩的坑是「`req` 的 close 在**请求体读完**时触发」——
             * GET 没有体可读完，所以 `req` 的 close 只剩「连接断了」这一个含义。
             *
             * 实测（真 `http.createServer`）：
             *   · 正常 GET 跑完：`res.close(+74ms, writableFinished=true)`、`req.close(+74ms)`
             *   · 客户端 20ms 主动断开：`res.close(+20ms, writableFinished=false)`、`req.close(+21ms)`
             * 两种情形都判得对。
             *
             * ⚠️ 将来若把这条改成 POST（例如要给 `EventSource` 之外的东西送请求体），
             * 这个判据会**立刻变成错判**，必须一起改成 `w.on('close')` + `writableFinished`
             * （判据与理由见 `/run` 那条的注释）。`closed` 只用于拦后续的 SSE 写入，
             * 判错不会取消运行（本路由不传取消信号），但会让日志少推。 */
            let closed = false
            r.on('close', () => { closed = true })

            /* ★ 整次运行的记录（用户 m03287）—— 边跑边攒，跑完落盘。 */
            const rec = runCollector(recNameOf(ref), 'stream')

            /* ★ **工作流级并发**（2026-10-21，计划 Step 11）：
             * 同时跑几份由上限定，超出的**排队**而不是拒绝 ——
             * 用户点了三份就该三份都跑完，而不是第三份报「忙」。
             * 同一份不许叠着开（会在同一批浏览器标签上互相踩）。
             *
             * ⚠️ 排队期间 SSE 连接是**开着等**的：这正是「排队中」该有的样子
             * （前端已经能显示 queued 状态），不必先断再重连。 */
            /* ⚠️ 入队那个回调要写成 `async`：里面要 `await readBrowserPrefs()`
             * （偏好文件读一次几毫秒，放在入队前读也等价，但保持这条形状与
             * 另一条跑路一致 —— `tests/browser-prefs.mjs` 靠这个形状数「两条都传了」）。 */
            const res = await sharedRunQueue().run(recNameOf(ref), async () => runWorkflowFile(ref, NODE_LIBRARY, dispatchNode, {
              workdir: process.cwd(),
              inputs,
              /* ★ 浏览器偏好（2026-10-20）：从列表 / 定时启动不经过画布，
               * 而存档里没有 port —— 这里补上，否则驱动报「连不上浏览器」。 */
              prefs: await readBrowserPrefs(),
              /* ★ 运行 id 由收集器先定好 —— 挂起现场的文件名要用同一个 id，
               * 否则「等待中的那条记录」与磁盘上的现场对不上（见 `RunGraphInput.runId`）。 */
              runId: rec.id,
              startedAt: rec.startedAt,
              /* 每条事件原样推出去（`nodeId` 与 `kind` 都在，前端据此排队/着色）。
               * 同一份还喂给历史收集器 —— 一路两用，不另开一条观察者链。 */
              onEvent: (e) => {
                rec.feed(e as { kind: string, nodeId: string, line?: string, nodeLabel?: string, error?: string })
                if (!closed) sse('step', e)
              },
            })).catch((e: unknown): RunFileResult => {
              /* 队列拒绝（同一份已在跑/在排）也走这里 —— 转成普通失败结果，
               * 于是下面的收尾逻辑只有一条路（不必为「被拒」再写一遍）。
               * ⚠️ 返回类型要**显式标** `RunFileResult`：不标的话 TS 会把
               * `Promise<RunFileResult> | Promise<{…}` 合成一个联合，下面取
               * `res.name` / `res.paused` 就报「属性不存在」（已踩）。 */
              return {
                ok: false, ran: [], aborted: false, missingTypes: [],
                error: e instanceof Error ? e.message : String(e),
              }
            })

            /* 落盘（失败只在服务端留个静默，不影响已经跑完的结果）。 */
            const saved = await rec.finish(res)

            /* ★ 产出归档（2026-10-21，计划 Step 2 第 2 条）：结束节点声明的产出
             * **再落一份**到板块记录（采集类 → `collect/<工作流名>/<时间戳>.json`，
             * 巡查类 → 复用 `patrol/`）。
             *
             * ⚠️ **运行历史里没有它**（用户 m03841 定案，红线）：`rec.finish` 那份
             * 记录照旧只写「跑过什么」。两份是**两个读者**：历史给人回看，
             * 板块记录给取数 / 总览板块列表。
             *
             * 失败不抛：跑都跑完了，记录没落上不该让这次执行报错。 */
            await archiveOutputs({
              workflowName: res.name ?? (ref.name ?? ref.id ?? ''),
              ...res.declaredOutputs === undefined ? {} : { declaredOutputs: res.declaredOutputs },
              /* 本次运行的节点汇报（契约 AN）：从已收集的节点明细里汇总。 */
              ...collectReports(rec.byNode()).length === 0
                ? {}
                : { reports: collectReports(rec.byNode()) },
              ok: res.ok && !res.aborted,
              /* 工作流编号（契约 AJ）：改名后靠它对上当前名字。 */
              ...res.id === undefined ? {} : { workflowId: res.id },
              /* 失败原因取**真实那条**（`res.error` 是工作流执行方给的原话）。
               * 成功时不给 —— `archiveOutputs` 就不会写这个键。 */
              ...res.ok && !res.aborted ? {} : { error: res.error },
              via: 'stream',
              runId: saved.id,
              startedAt: saved.startedAt,
              endedAt: saved.endedAt ?? Date.now(),
            })

            /* 收尾：把「成没成」与输入输出一起给出去，然后关连接。
             * ⚠️ 用 `done` 这个事件名（前端据此收尾），与逐条的 `step` 分开 ——
             * 合成一种事件的话，前端要自己攒「最后一条是不是结束」。 */
            sse('done', {
              ok: res.ok,
              aborted: res.aborted,
              ran: res.ran,
              error: res.error,
              missingTypes: res.missingTypes,
              inputs: res.inputs,
              declaredOutputs: res.declaredOutputs,
              /* ★ 挂起时前端要显示「等待中」而不是成功 —— 见 `RunGraphResult.paused`。 */
              ...res.paused === undefined ? {} : { waiting: true, resumeAt: res.paused.wait.resumeAtMs },
              /* 运行 id：前端拿到它就能去历史里定位这一次（回看用）。 */
              runId: saved.id,
            })
            w.end()
            return
          }

          /* ── 整次运行的记录（用户 m03287：「运行历史应该根据工作流做分组」）
           *
           * ## 为什么在这里攒、而不是在调度器里
           *
           * 调度器（`workflow/run.ts`）只认「节点」，它不知道「哪一次整份工作流跑」——
           * 那是入口的事（这条路由接收了一次「跑这份工作流」的请求）。
           * 所以「整次运行」这一层的记录由**入口**攒，节点明细从事件流里捡。
           *
           * ## 与上方节点级 `/runs` 的关系
           *
           * `/runs` 那个是 `WorkflowDispatcher` 内部的节点执行记录（画布逐节点派发时也在写），
           * 一行一个节点、没有「整次」的概念。两者**并存、不合并** ——
           * 那个是「引擎此刻在干什么」，这个是「历史里跑过什么」。
           */
          /**
           * 排队 / 运行记录用的名字（**引用里可能只有编号**，那就先用编号占位）。
           *
           * 为什么单独一个函数：三条跑路（SSE / 列表 / 恢复）都要算它，
           * 各写一遍必漂。真正显示用的名字由 `runWorkflowFile` 解析后带回
           * （见 `res.name`），这里只是「入队时先有个键」。
           *
           * @param ref - 工作流引用（可能只有编号、也可能只有名字）。
           * @returns 名字或编号。
           */
          function recNameOf(ref: { id?: string, name?: string }): string {
            return (ref.name ?? '').trim() !== '' ? String(ref.name) : String(ref.id ?? '')
          }

          /**
           * 造一个「整次运行」收集器。
           *
           * @param name - 工作流名（分组键）。
           * @param via - 谁发起的（`list` / `stream` / `sub`），只用于显示。
           * @returns 收集器（吃事件、跑完 `finish` 落盘）。
           */
          function runCollector(name: string, via: string) {
            const startedAt = Date.now()
            const id = newRunId(startedAt)
            /** 节点 id → 明细（同一个节点跑多轮时**合并**，日志累加）。 */
            const byNode = new Map<string, RunNodeLine>()
            /** 节点 id → 是否已经见过 started（用于算耗时）。 */
            return {
              id,
              startedAt,
              /**
               * 看一眼已收集的节点明细（**只读**，返回副本）。
               *
               * 给 `archiveOutputs` 汇总汇报用（契约 AN）：任务记录里的 `reports`
               * 要取自**这份**数据，与运行历史里显示的一致 ——
               * 另攒一条通道就会出现两个真相来源。
               *
               * @returns 明细副本（改它不影响收集器）。
               */
              byNode(): RunNodeLine[] {
                return [...byNode.values()]
              },
              /**
               * 吃一条事件。
               *
               * @param e - 调度器事件（形状见 `run.ts` 的 `RunEvent`）。
               */
              feed(e: { kind: string, nodeId: string, depth?: number, line?: string, label?: string, nodeLabel?: string, defId?: string, error?: string, output?: unknown }) {
                /* ⚠️ 与 `resumePausedRun` 里那处调的是**同一个函数**（`mergeNodeEvent`）——
                 * 两处同形同责，只改一处就是「列表里跑修好了、画布跑还坏着」的半修。 */
                mergeNodeEvent(byNode, e)
              },
              /**
               * 收尾并落盘。
               *
               * @param res - `runWorkflowFile` 的返回值。
               * @returns 存进去的那条记录（供调用方回给前端）。
               */
              async finish(res: {
                ok: boolean, ran: string[], aborted: boolean, error?: string,
                inputs?: Record<string, unknown>, declaredOutputs?: Record<string, unknown>,
                paused?: RunSnapshot,
              }): Promise<WorkflowRun> {
                /* ★ **挂起不是失败**（2026-10-21，计划 Step 12 红线）。
                 *
                 * 挂起时 `res.ok` 仍是 true、`aborted` 仍是 false —— 它既没跑完
                 * 也没出错。所以记录里必须**单独标一个 `waiting`**：
                 * 只写 `ok: true` 的话界面会显示成「跑完了」，而只写 `ok: false`
                 * 又会被当成失败、去发通知。两种都是错的。
                 *
                 * 现场落盘在**这里**（而不是调用方）：两个跑路都要做同一件事，
                 * 写两遍必漂（见 `pitfalls/同一件事写两份迟早漂.md`）。 */
                const paused = res.paused
                if (paused !== undefined) {
                  /* 存不上要**说清**：假装挂起的话用户会等一个永远不来的恢复。 */
                  const savedSnap = await savePausedRun(paused)
                  if (!savedSnap) {
                    const failedRecord: WorkflowRun = {
                      id, name, startedAt, endedAt: Date.now(),
                      ok: false,
                      aborted: false,
                      ran: res.ran,
                      nodes: [...byNode.values()],
                      via,
                      error: '运行现场存不下（磁盘？），这次没法恢复 —— 当成失败处理',
                      ...res.inputs === undefined ? {} : { inputs: res.inputs },
                    }
                    await appendRun(failedRecord)
                    return failedRecord
                  }
                }
                const record: WorkflowRun = {
                  id,
                  name,
                  startedAt,
                  endedAt: Date.now(),
                  /* ⚠️ `ok` 与 `aborted` 要一起看（`run-file` 里已写清这个坑）：
                   * `ok` 只表示「档读得出来、真的跑了」，不表示「跑成功了」。 */
                  ok: res.ok && !res.aborted,
                  aborted: res.aborted,
                  ran: res.ran,
                  nodes: [...byNode.values()],
                  via,
                  ...res.error === undefined ? {} : { error: res.error },
                  ...res.inputs === undefined ? {} : { inputs: res.inputs },
                  ...res.declaredOutputs === undefined ? {} : { outputs: res.declaredOutputs },
                  /* ★ 等待中：`ok` 保持原样（它没失败），另标两个字段让界面能说人话。 */
                  ...paused === undefined ? {} : {
                    waiting: true,
                    resumeAt: paused.wait.resumeAtMs,
                  },
                }
                await appendRun(record)
                return record
              },
            }
          }

          /* ── 运行历史：按工作流分组读（用户 m03287）──────────────────
           *
           * 两种读法：
           *   · `GET /workflow/runs?name=X` —— 某一份的全部运行（新的在前）；
           *   · `GET /workflow/runs` —— 有哪些工作流留下过记录（给分组列表用）。
           *
           * 另外：`DELETE /workflow/runs?name=X` 清掉某一份的历史。 */
          if (path === '/api/ecom-workbench/workflow/runs' && r.method === 'GET') {
            const name = new URL(r.url ?? '/', 'http://x').searchParams.get('name') ?? ''
            if (name === '') {
              send(200, { ok: true, names: await listRunNames() })
              return
            }
            send(200, { ok: true, name, runs: await loadRuns(name) })
            return
          }
          if (path === '/api/ecom-workbench/workflow/runs' && r.method === 'DELETE') {
            const name = new URL(r.url ?? '/', 'http://x').searchParams.get('name') ?? ''
            if (name === '') { send(400, { error: '要清哪一份的历史？没给 name' }); return }
            send(200, { ok: await clearRuns(name) })
            return
          }

          /* ── 一份工作流的「输入 / 输出声明」───────────────────────
           *
           * 前端在点「执行」之前要知道**这份工作流要填什么**（开始节点声明的输入项），
           * 跑完之后要知道**它交出了什么**（结束节点声明的产出）。
           * 两件事都住在存档里（`flow.start` / `flow.end` 两个节点的参数），
           * 解析规则只有一份（`io-fields.ts`），所以这里直接调它，不在本文件里再写一遍。
           *
           * ⚠️ 老存档里没有这两个节点 → 两栏都是空数组（前端就知道「不用填输入」），
           * 不是错误、不当坏档。 */
          if (path === '/api/ecom-workbench/workflow/io' && r.method === 'GET') {
            const name = new URL(r.url ?? '/', 'http://x').searchParams.get('name') ?? ''
            if (name === '') { send(400, { error: '要查哪一份？没给 name' }); return }
            const doc = await loadWorkflow(name) as { nodes?: { defId?: string, params?: Record<string, unknown> }[] } | null
            if (doc === null) { send(404, { error: '没有这份工作流：' + name }); return }
            const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
            const start = nodes.filter(n => n.defId === 'flow.start')
            const end = nodes.filter(n => n.defId === 'flow.end')
            send(200, {
              ok: true,
              /* 开始节点的类型决定「谁能启动它」——前端据此隐藏「执行」按钮（用户 m00901）。 */
              startType: typeof start[0]?.params?.type === 'string' ? start[0].params.type : null,
              inputs: start.length === 0 ? [] : parseInputFields(start[0]?.params?.fields),
              outputs: end.length === 0 ? [] : parseOutputFields(end[0]?.params?.fields),
            })
            return
          }
          if (path === '/api/ecom-workbench/workflow' && r.method === 'GET') {
            const name = new URL(r.url ?? '/', 'http://x').searchParams.get('name') ?? ''
            /* ⚠️ 走 `loadWorkflowByRef` 而**不是** `loadWorkflow`（2026-10-19）。
             *
             * 差别在「补编号 + 去重」这一步：`loadWorkflow` 只看得见一个文件，
             * 无法发现「另一份文件已经占了这个编号」—— 而编号必须全目录唯一
             * （撞了就会按编号跑到别的份上，见 `ids.ts` 的 `dedupeWorkflowIds`）。
             * 这条路会先列一遍目录（补编号、去重、迁移老引用），再读那一份。
             *
             * 代价是打开一份多读一次目录（几十个文件、几毫秒），
             * 换来「打开的正是你点的那一份」—— 值得。 */
            const hit = await loadWorkflowByRef({ name })
            if (hit === null) { send(404, { error: '没有这份工作流：' + name }); return }
            send(200, { name, doc: hit.doc })
            return
          }
          if (path === '/api/ecom-workbench/workflow' && r.method === 'DELETE') {
            const name = new URL(r.url ?? '/', 'http://x').searchParams.get('name') ?? ''
            const ok = await deleteWorkflow(name)
            send(ok ? 200 : 404, { ok })
            return
          }
          /* 在资源管理器里打开**这份工作流所在的目录**（用户 2026-10-14 要求）。
           *
           * ## 能力用的是哪个（以及为什么不用 dsh 现成的那个）
           *
           * 复用本插件已有的 `openInFileManager()` —— 就是上面 `/collect/open`
           * 打开 skill 目录用的同一个函数（三平台标准做法：Windows `explorer` /
           * macOS `open` / Linux `xdg-open`）。**全插件只此一处实现**。
           *
           * ⚠️ 我**查过** dsh 官方有没有现成的：有，`@deepseek-ai/dsh-host-open-in-app`
           * （`packages/host/open-in-app`，路由 `/open-in-app/open`，目录 id 是
           * `explorer` / `finder` / `filemanager`）。**实测它在本机是活着的**
           * （`GET /open-in-app/apps` 返回 401 = 被它自己的登录围栏挡住，不是 404）。
           * **但这条不适用**，两个理由：
           *   1. 它要**绝对路径**由客户端传（`{ app, path }`，且校验 `isAbsolute`）——
           *      而本插件的分层是「**客户端只报名字，路径由宿主半自己算**」
           *      （见上面 `/collect/open` 的注释：绝不接受客户端传来的任意路径，
           *      那等于开一个「打开任意目录」的口子）。用它就得先让客户端拿到绝对路径，
           *      既多一次往返、又把那条安全约定破了。
           *   2. 它的**打开方式与我们要的完全一样**（同一份 `native-command` 的
           *      path-opener：Windows Explorer 的 file URI、`/select,` 揭示）。
           *      也就是说复用它不会多得到任何东西，只多一层耦合。
           *
           * 所以：**沿用我们自己的那一个**，理由写在这里备查。
           *
           * 安全上照 `/collect/open`：客户端只给**名字**，路径由宿主半用 `safeName`
           * 清洗后再拼，**打不开也不报错**（界面已拿到路径可自己复制）。 */
          if (path === '/api/ecom-workbench/workflow/open' && r.method === 'POST') {
            const body = await readJsonBody(r) as { name?: string }
            if (typeof body.name !== 'string' || body.name === '') {
              send(400, { error: '要打开哪一份？没给 name' })
              return
            }
            /* ⚠️ **所有工作流存在同一个平铺目录里**（没有按工作流分子目录），
             * 所以「这份工作流所在的目录」对每一份都一样 = 工作流根目录。
             * 这里仍按 `safeName(name)` 走一遍，是为了**保住那条约定**：
             * 目录由宿主半自己算，客户端给的只是一个名字。
             * 将来若改成每份一个子目录，这里换成 `dirname(那份的路径)` 即可。 */
            const dir = workflowsDir()
            /* 名字只为「这份在工作（存在）吗」做一次确认 —— 不存在也照样开目录，
             * 用户可能正要去那里找它。所以确认失败不拦，只把结果如实回报。 */
            const exists = (await loadWorkflow(safeName(body.name))) !== null
            openInFileManager(dir)
            send(200, { ok: true, path: dir, exists })
            return
          }
          /* ── 画布跑完后的运行记录（用户 m14827：「我在画布中运行的，运行历史没有出现记录」）
           *
           * ## 为什么需要这条路由
           *
           * `appendRun` 原来只有两处调用，都在「宿主半自己跑整份工作流」的路径上
           * （`/workflow/run` 与 `/workflow/run-stream`）。
           * 而**画布是客户端自己跑的** —— 它调 `runGraph`、逐节点 `POST /run` 派发，
           * 宿主半全程不知道「这是一次整份运行的开始和结束」，所以没法自己写记录。
           *
           * 于是「列表里点▶跑」有历史、「画布上点▶运行」没有 —— 用户看到的就是这一条。
           *
           * ## 谁算这次的账
           *
           * 画布侧有 `useRunStore`（事件流、每个节点的日志与结局都在里面），
           * 它攒完之后把**一份**记录报给这里。宿主半只负责落盘（`appendRun`），
           * 不重算任何东西 —— 免得「同一件事写两份」再漂一次
           * （见 `pitfalls/同一件事写两份迟早漂.md`）。
           *
           * ## 安全
           *
           * 只接受这条路由自己认识的形状，字段逐个洗：
           * `name` 走 `safeName`（防 `../`），节点明细截断到 `MAX_NODE_LINES`，
           * 日志截到 `MAX_NODE_LOGS` —— 那是 `appendRun` 本来就做的事，
           * 这里只需要保证「不是数组的东西不进 `nodes`」。
           *
           * ⚠️ **名字为空时不落盘**（返回 `ok: false`）：画布可能还没保存成文件，
           * 那种运行没有可归属的工作流，硬塞一个名字只会污染历史列表。 */
          if (path === '/api/ecom-workbench/workflow/record' && r.method === 'POST') {
            const body = await readJsonBody(r) as {
              name?: unknown, startedAt?: unknown, endedAt?: unknown, ok?: unknown,
              aborted?: unknown, error?: unknown, ran?: unknown,
              nodes?: unknown, outputs?: unknown, inputs?: unknown,
            }
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            if (name === '') {
              /* 不是错误：画布没归属时跑一次是合理的，只是没地方记。
               * 用 200 + ok:false + 原因，前端据此提示「先保存再跑，历史才会留下」。 */
              send(200, { ok: false, error: '这次运行没有归属的工作流名，历史不记（先把画布保存成一份工作流）' })
              return
            }
            const num = (v: unknown, dflt: number): number =>
              typeof v === 'number' && Number.isFinite(v) ? v : dflt
            /**
             * 把界面报回来的模型痕迹**逐字段洗**一遍。
             *
             * ## 为什么不直通
             *
             * 这条路由的 body 来自浏览器。`...n` 那种写法会把客户端塞进来的任意形状
             * 原样写进运行记录文件 —— 那既是文件体积风险（一条 10MB 的 trace），
             * 也是「界面改错一个字段名，记录里就静默多一个没人认识的键」的来源。
             *
             * 规则：**认识的才留，不认识的一律丢**；数字只收有限的非负数；
             * 两个摘要**在这里再截一次**（防上游漏截，上限同一份 `TRACE_TEXT_PREVIEW`）。
             *
             * @param raw - 客户端给的 llm 字段（任意形状）。
             * @returns 洗过的痕迹；洗不出可用形状时 `undefined`（调用方据此不写这个键）。
             */
            const sanitizeLlmTrace = (raw: unknown): LlmTrace | undefined => {
              if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
              const o = raw as Record<string, unknown>
              if (typeof o.provider !== 'string' || o.provider === '') return undefined
              if (typeof o.model !== 'string' || o.model === '') return undefined
              if (typeof o.finish !== 'string' || o.finish === '') return undefined
              const out: LlmTrace = { provider: o.provider, model: o.model, finish: o.finish }
              /** 只收有限非负数（0 是实测值，合法）。 */
              const take = (v: unknown): number | undefined =>
                typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
              const input = take(o.inputTokens)
              const output = take(o.outputTokens)
              const total = take(o.totalTokens)
              if (input !== undefined) out.inputTokens = input
              if (output !== undefined) out.outputTokens = output
              if (total !== undefined) out.totalTokens = total
              /* 两个摘要：按同一上限再截一次（上游漏截也不至于把记录撑爆）。 */
              let cut = false
              if (typeof o.promptPreview === 'string') {
                const p = truncateTraceText(o.promptPreview)
                /* 空串不写键 —— 与 `previewBlock` 同一条纪律（见那边的注释）。 */
                if (p.text !== '') out.promptPreview = p.text
                cut = cut || p.truncated
              }
              if (typeof o.outputPreview === 'string') {
                const a = truncateTraceText(o.outputPreview)
                if (a.text !== '') out.outputPreview = a.text
                cut = cut || a.truncated
              }
              if (cut || o.truncated === true) out.truncated = true
              return out
            }
            const runNodes = Array.isArray(body.nodes)
              ? body.nodes.filter(x => x !== null && typeof x === 'object') as {
                nodeId: string, defId?: string, label?: string, state: string,
                startedAt?: number, endedAt?: number, error?: string, logs?: string[],
                llm?: unknown, depth?: unknown,
              }[]
              : []
            const record: WorkflowRun = {
              id: newRunId(),
              name,
              startedAt: num(body.startedAt, Date.now()),
              endedAt: num(body.endedAt, Date.now()),
              /* `ok` 与 `aborted` 一起看 —— 与 `finish()` 里那条判据同源。 */
              ok: body.ok === true && body.aborted !== true,
              ...body.aborted === true ? { aborted: true } : {},
              ran: Array.isArray(body.ran) ? body.ran.filter(x => typeof x === 'string') as string[] : [],
              nodes: runNodes.map(n => {
                /* ⚠️ 只放行认识的字段：`...n` 会把客户端塞的任何键写进记录文件。
                 * `llm` 走白名单洗一遍，其余字段照旧逐项取（不接受的丢掉）。 */
                const llm = sanitizeLlmTrace(n.llm)
                return {
                  nodeId: String(n.nodeId ?? ''),
                  ...typeof n.defId === 'string' ? { defId: n.defId } : {},
                  ...typeof n.label === 'string' ? { label: n.label } : {},
                  /* `depth` 只收**有限正整数**（顶层 0 不写，与收集层同一条纪律）。 */
                  ...n.depth !== undefined && typeof n.depth === 'number' && Number.isFinite(n.depth) && n.depth > 0
                    ? { depth: Math.floor(n.depth) } : {},
                  state: (n.state === 'success' || n.state === 'failed' || n.state === 'skipped'
                    || n.state === 'running' || n.state === 'queued') ? n.state : 'failed',
                  ...typeof n.startedAt === 'number' && Number.isFinite(n.startedAt) ? { startedAt: n.startedAt } : {},
                  ...typeof n.endedAt === 'number' && Number.isFinite(n.endedAt) ? { endedAt: n.endedAt } : {},
                  ...typeof n.error === 'string' ? { error: n.error } : {},
                  ...Array.isArray(n.logs) ? { logs: n.logs.filter(x => typeof x === 'string') as string[] } : {},
                  /* 没有可用痕迹就**不写这个键**（不是 null、不是 {}）。 */
                  ...llm === undefined ? {} : { llm },
                }
              }),
              via: 'canvas',
              ...typeof body.error === 'string' ? { error: body.error } : {},
              ...body.outputs !== null && typeof body.outputs === 'object'
                ? { outputs: body.outputs as Record<string, unknown> } : {},
              ...body.inputs !== null && typeof body.inputs === 'object'
                ? { inputs: body.inputs as Record<string, unknown> } : {},
            }
            const saved = await appendRun(record)
            send(200, saved ? { ok: true, id: record.id } : { ok: false, error: '写运行历史失败（磁盘？）' })
            return
          }

          /* ── 版本快照（改坏了想退回去）───────────────────────── */
          if (path === '/api/ecom-workbench/snapshots' && r.method === 'POST') {
            const body = await readJsonBody(r) as { name?: string, doc?: unknown }
            const name = typeof body.name === 'string' && body.name !== '' ? body.name : '未命名工作流'
            const saved = await saveSnapshot(name, body.doc ?? {})
            send(200, { ok: true, path: saved.path, snap: saved.snap })
            return
          }
          if (path === '/api/ecom-workbench/snapshots' && r.method === 'GET') {
            const name = new URL(r.url ?? '/', 'http://x').searchParams.get('name') ?? ''
            send(200, { snaps: await listSnapshots(name) })
            return
          }
          if (path === '/api/ecom-workbench/snapshot' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const doc = await loadSnapshot(q.get('name') ?? '', q.get('snap') ?? '')
            if (doc === null) { send(404, { error: '没有这份快照' }); return }
            send(200, { doc })
            return
          }
          /* ── 收藏（skill 备忘 / 插件与项目清单）──────────────────
           * 设计要点：只有 4 条路由，尽量少。
           * 备注与「目录配置」**共用一个 POST**（整份覆盖 notes.json）——
           * 界面本来就持有整份备注，分开写反而要多几个「改哪个字段」的接口。 */
          if (path === '/api/ecom-workbench/collect/list' && r.method === 'GET') {
            const notes = await readNotes()
            send(200, {
              skills: await scanSkills({ notes }),
              notes,
              /* 两侧的根目录明细（设置 tab 用）：路径 + 扫到几个 + 存在否。
               * 「扫到 0 个」与「目录不存在」是两种毛病，界面要能分开说。 */
              roots: {
                installed: await rootInfos('installed', { notes }),
                collected: await rootInfos('collected', { notes }),
              },
            })
            return
          }
          if (path === '/api/ecom-workbench/collect/skill' && r.method === 'GET') {
            const name = new URL(r.url ?? '/', 'http://x').searchParams.get('name') ?? ''
            const got = await readSkillBody(name)
            if (got === null) { send(404, { error: '读不到这个 skill：' + name }); return }
            send(200, got)
            return
          }
          if (path === '/api/ecom-workbench/collect/notes' && r.method === 'POST') {
            const body = await readJsonBody(r) as Partial<Notes>
            const saved = await writeNotes({
              ...body.roots === undefined ? {} : { roots: body.roots },
              skills: typeof body.skills === 'object' && body.skills !== null ? body.skills : {},
              plugins: Array.isArray(body.plugins) ? body.plugins : [],
              projects: Array.isArray(body.projects) ? body.projects : [],
            })
            send(200, { ok: true, path: saved })
            return
          }
          if (path === '/api/ecom-workbench/collect/move' && r.method === 'POST') {
            const body = await readJsonBody(r) as { name?: string, to?: string }
            const to: MoveDirection = body.to === 'install' ? 'install' : 'collect'
            const res = await moveSkill(body.name ?? '', to)
            send(res.ok ? 200 : 400, res)
            return
          }
          /* 在资源管理器里打开某个 skill 的目录（用户 2026-10-11 要求）。
           *
           * **安全做法**：客户端只给 **skill 名**，路径由宿主半自己解析 ——
           * 绝不接受客户端传来的任意路径（那等于给了一个「打开任意程序」的口子）。
           * 名字先过 isSafeSkillName，再在两侧的已知根里找到它，
           * 拿**宿主半算出来的绝对路径**去开资源管理器。 */
          if (path === '/api/ecom-workbench/collect/open' && r.method === 'POST') {
            const body = await readJsonBody(r) as { name?: string }
            const found = await resolveSkillDir(body.name ?? '')
            if (found === null) { send(404, { error: '找不到这个 skill 的目录：' + String(body.name) }); return }
            openInFileManager(found)
            send(200, { ok: true, path: found })
            return
          }
          /* ── 跑一份工作流（**无界面执行**，用户 2026-10-11 要求）────────
           * 「工作流板块的工作流界面应该有执行按钮，不依赖画布执行工作流。」
           *
           * 与上面 `/run` 的区别：`/run` 只执行**单个节点**（画布算好了顺序再逐个发）；
           * 这条是**拿着整份工作流文件自己跑完** —— 顺序、上游、跳过、失败策略
           * 全部由共用的调度器（`workflow/run.ts`）决定，**与画布同一份跑法**。
           *
           * 客户端断开**不当作取消**：用户可能点了按钮就切走/关页面，
           * 那不该把正在跑的采集掐掉。（将来要「取消」就再给一个显式接口。） */
          if (path === '/api/ecom-workbench/workflow/run' && r.method === 'POST') {
            const body = await readJsonBody(r) as { name?: string, workflowId?: string, inputs?: Record<string, unknown> }
            /* ★ 引用（2026-10-19）：**编号优先、名字兼容**。
             * 客户端从画布发的是 `flow.workflow` 节点上的引用；列表页发的是名字。
             * 两者都收，解析顺序交给 `runWorkflowFile`（它内部先编号后名字）。 */
            const ref = {
              ...(typeof body.workflowId === 'string' && body.workflowId !== '' ? { id: body.workflowId } : {}),
              ...(typeof body.name === 'string' && body.name !== '' ? { name: body.name } : {}),
            }
            if (ref.id === undefined && ref.name === undefined) {
              send(400, { error: '要跑哪一份？没给 name 或 workflowId' })
              return
            }
            const logs: { nodeId: string, line: string }[] = []
            /* ★ 整次运行的记录（用户 m03287）—— 与 SSE 那条同一条路。 */
            const rec = runCollector(recNameOf(ref), 'list')
            /* ★ **工作流级并发**（计划 Step 11）—— 与 SSE 那条**同一个队列**。
             * 分两个队列等于上限翻倍，等于没上限。 */
            const res = await sharedRunQueue().run(recNameOf(ref), async () => runWorkflowFile(ref, NODE_LIBRARY, dispatchNode, {
              workdir: process.cwd(),
              /* ★ 浏览器偏好（2026-10-20）：从列表 / 定时启动不经过画布，
               * 而存档里没有 port —— 这里补上，否则驱动报「连不上浏览器」。 */
              prefs: await readBrowserPrefs(),
              /* ⚠️ **外部喂进来的输入**（2026-10-17）：
               * 由这份工作流的「开始」节点声明决定收哪些（多给的会被丢掉，
               * 见 `io-fields.ts` 的 `resolveInputs`）。
               * 没有开始节点时这些值**一个都进不去** —— 那是用户 m00901 定的语义
               * （不是「发给第一个节点」），执行层会记一条日志说清。 */
              inputs: typeof body.inputs === 'object' && body.inputs !== null ? body.inputs : undefined,
              /* ★ 运行 id 由收集器先定好（挂起现场的文件名要用同一个 id）。 */
              runId: rec.id,
              startedAt: rec.startedAt,
              onLog: (nodeId, line) => { logs.push({ nodeId, line }); rec.feed({ kind: 'log', nodeId, line }) },
              /* ★ 节点事件（2026-10-25，契约 AJ）—— **必须与另外两个入口同一个函数**。
               *
               * 原来这条只传了 `onLog`，于是从列表点「执行」跑出来的运行记录里，
               * `nodes[]` 每一条都停在默认状态 `queued`（实测：`runs/提示词优化.json` 的
               * `20261023-083041-mpr7`，`ok: true`、`ran` 三个节点、`outputs` 2067 字，
               * 而 `nodes` 三条全是 `queued`）。用户点开记录看到「排队中」，其实早跑完了。
               *
               * 三个入口的分工见文件里那两处（流式 `:1898`、定时 `runner.ts:150`）；
               * 归并逻辑只有一份（`mergeNodeEvent`），这里**不另写**。 */
              onEvent: (e) => { rec.feed(e as { kind: string, nodeId: string }) },

            })).catch((e: unknown): RunFileResult => {
              /* 队列拒绝（同一份已在跑/在排）也走这里 —— 转成普通失败结果，
               * 于是下面的收尾逻辑只有一条路。返回类型显式标（理由同上）。 */
              return {
                ok: false, ran: [], aborted: false, missingTypes: [],
                error: e instanceof Error ? e.message : String(e),
              }
            })
            const saved = await rec.finish(res)
            /* ★ 产出归档（2026-10-21）—— 与上面 SSE 那条**同一份实现**。
             * 两条跑路各写一遍就会漂（见 `pitfalls/同一件事写两份迟早漂.md`）。 */
            await archiveOutputs({
              workflowName: res.name ?? (ref.name ?? ref.id ?? ''),
              ...res.declaredOutputs === undefined ? {} : { declaredOutputs: res.declaredOutputs },
              /* 本次运行的节点汇报（契约 AN）：从已收集的节点明细里汇总。 */
              ...collectReports(rec.byNode()).length === 0
                ? {}
                : { reports: collectReports(rec.byNode()) },
              ok: res.ok && !res.aborted,
              /* 工作流编号（契约 AJ）：与 SSE 那条同一份判据。 */
              ...res.id === undefined ? {} : { workflowId: res.id },
              /* 失败原因取**真实那条**（与 SSE 那条同一份判据）。 */
              ...res.ok && !res.aborted ? {} : { error: res.error },
              via: 'list',
              runId: saved.id,
              startedAt: saved.startedAt,
              endedAt: saved.endedAt ?? Date.now(),
            })
            send(res.ok ? 200 : 400, {
              ...res,
              logs,
              runId: saved.id,
              /* ★ 挂起时前端要显示「等待中」而不是成功（计划 Step 12 的红线）。 */
              ...res.paused === undefined ? {} : { waiting: true, resumeAt: res.paused.wait.resumeAtMs },
            })
            return
          }
          /* ── 暂停恢复（2026-10-21，计划 Step 12）──────────────────
           *
           * 三条路由，都只做「看」与「手动触发」—— **自动恢复由下面的定时器做**，
           * 不靠界面开着。用户关掉工作台、甚至重启电脑，到点照样继续。
           *
           *   · `GET  /workflow/paused`        —— 现在有哪些在等（列表）
           *   · `GET  /workflow/paused?id=`    —— 某一份的现场（界面要看「等的是什么」）
           *   · `POST /workflow/resume`        —— 立刻恢复某一份（**不等**到点，调试 / 用户催）
           *   · `POST /workflow/paused/cancel` —— 放弃某一份（删掉现场，不再恢复）
           *
           * ⚠️ 恢复走**同一个队列**：它与「新点一次执行」是同一类负载，
           * 各开一个队列等于上限翻倍。
           */
          if (path === '/api/ecom-workbench/workflow/paused' && r.method === 'GET') {
            const id = new URL(r.url ?? '/', 'http://x').searchParams.get('id') ?? ''
            if (id !== '') {
              const snap = await loadPausedRun(id)
              send(snap === null ? 404 : 200, snap === null ? { error: '没有这份挂起的运行：' + id } : { ok: true, paused: snap })
              return
            }
            const list = await listPausedRuns()
            /* 只回「界面要显示的那几项」—— 现场里的 `outputs` 可能很大
             * （一份采集的原始数据），列个表不需要它。要看细节走上面那条单条查询。 */
            send(200, {
              ok: true,
              paused: list.map(p => ({
                runId: p.runId,
                workflowId: p.workflowId,
                pausedAt: p.pausedAt,
                resumeAfter: p.resumeAfter,
                resumeAt: p.wait.resumeAtMs,
                mode: p.wait.mode,
                ...p.wait.until === undefined ? {} : { until: p.wait.until },
                ran: p.ran.length,
              })),
            })
            return
          }
          if (path === '/api/ecom-workbench/workflow/paused/cancel' && r.method === 'POST') {
            const body = await readJsonBody(r) as { id?: unknown }
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (id === '') { send(400, { error: '要放弃哪一份？没给 id' }); return }
            const gone = await removePausedRun(id)
            send(gone ? 200 : 400, gone ? { ok: true } : { error: '删不掉这份现场：' + id })
            return
          }
          if (path === '/api/ecom-workbench/workflow/resume' && r.method === 'POST') {
            const body = await readJsonBody(r) as { id?: unknown }
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (id === '') { send(400, { error: '要恢复哪一份？没给 id' }); return }
            const snap = await loadPausedRun(id)
            if (snap === null) { send(404, { error: '没有这份挂起的运行：' + id }); return }
            const r2 = await resumePausedRun(snap, 'manual')
            /* ★ 拒绝恢复时，把原因**同时**放在 `error` 上（票 17，2026-10-27）。
             *
             * 界面（`RunHistoryPanel.tsx:645`）读的是 `body.error`，
             * 而 `resumePausedRun` 的理由一直放在 `summary` 里。
             * 不加这一行，用户看到的会是「宿主半返回 400」——
             * 一句既没说原因、也没说怎么办的话，等于白拒。
             *
             * ⚠️ **只补拒绝那一条**：其余失败路径的响应形状一个字节不变
             * （它们本来就这样，不在本单范围里顺手改 —— 那会动到别人正在用的口径）。 */
            send(r2.ok ? 200 : 400, r2.rejected === true ? { ...r2, error: r2.summary } : r2)
            return
          }
          /* ── 采集记录（2026-10-21，计划 Step 2 第 2 条的后半）────────
           *
           * 取数板块要「列采集记录」。数据来自跑完时落下的板块记录
           * （见上面两条跑路里的 `archiveOutputs`）。
           *
           * ⚠️ **与运行历史不是一回事**：历史记「跑过什么」，这里记「交出了什么」。
           * `?workflow=<名字>` 只看一份；不给就扫全部。
           */
          if (path === '/api/ecom-workbench/collect/records' && r.method === 'GET') {
            const q = new URL(r.url ?? '/', 'http://x').searchParams
            const workflow = q.get('workflow') ?? ''
            const limitRaw = q.get('limit') ?? ''
            const limit = Number(limitRaw)
            const records = await readCollectRecords({
              ...workflow === '' ? {} : { workflow },
              ...Number.isFinite(limit) && limit > 0 ? { limit } : {},
            })
            send(200, { ok: true, records })
            return
          }

          /* ── 巡查结果（票 11，2026-10-30）──────────────────────────
           *
           * 总览要「显示数据本身」，而巡查结果的指标明细此前没有任何接口能读到：
           * `collect/records` 读的是**归档格式**（`outputs` / `reports`），不读 `blocks`；
           * `/workflow/runs` 是**运行历史**，只有「成没成、跑多久」，没有数字。
           *
           * ## 三栏，不是一栏
           *
           * `items` / `broken` / `missing`。为什么必须分开：
           * 「有文件但读不出」与「文件根本不存在」对用户是两件事 ——
           * 一个是「这份坏了」，一个是「这份还没跑过」。混在一起界面上分不清该去修还是该去跑。
           *
           * ⚠️ **`patrol/` 里不止巡查结果**。同一个目录还住着 `tm-sycm.json` /
           * `douyin-ui.json`（另一条取数路）与 `巡查-<名字>-<时间戳>.json`
           * （`archiveOutputs` 归档的运行记录）。所以按 `scripts/patrol/jobs.mjs`
           * 那张 5 个名字的名单认，**不按文件名前缀扫** —— 按前缀扫会把上面那些
           * 报成「坏了」，那是假警报。名单的镜像在 `patrol-results.ts`。
           *
           * ⚠️ **只读**，且**不按 `state` 过滤**：`blocks[].items[]` 原样透传。
           * 归并与筛选是界面的事（总览与「需要处理的事项」两处规则不同）。
           *
           * 列表类接口的约定（AGENTS.md）：具名键 + `items` 指向同一个数组。 */
          if (path === '/api/ecom-workbench/patrol/results' && r.method === 'GET') {
            const res = await readPatrolResults()
            /* ⚠️ 这里有一处**两套约定撞名**，写清免得下一个人改错：
             *
             * · 本票定的三栏里，正常那一栏叫 `items`（界面按它画指标卡）；
             * · AGENTS.md 的列表类约定是「具名键 + `items` 指向同一个数组」。
             *
             * 于是 `items` 同时承担两个角色 —— 它就是「正常结果」那一栏。
             * 具名键取 `results`（**指向同一个数组**，不是把三栏包起来），
             * 给通用渲染函数用。`broken` / `missing` 不是列表接口意义上的「主列表」，
             * 所以只给一个名字，不再各配一个具名键。 */
            send(200, {
              ok: true,
              results: res.items,
              items: res.items,
              broken: res.broken,
              missing: res.missing,
              /* 票 14：哪些块是上一次采到的旧数据（这些块**仍在 items 里正常显示**，
               * 只是数字是旧的），以及每块数据真正拿到的时间。
               * ⚠️ 与 broken / missing 是三件不同的事，别混着用。 */
              compensated: res.compensated,
              blockAt: res.blockAt,
            })
            return
          }

          /* ── BI（Superset）：启动 / 状态（计划 Step 3-8 的 BI 板块）──────
           *
           * 两件事都只能在宿主半做：起 `.bat`、探 8088 端口。
           * 界面只拿结论（起没起来 / 在不在听），不碰进程与端口。
           *
           * ⚠️ 启动是**异步的**（Docker 拉镜像要几分钟），所以这条路由回的是
           * 「已发起」，不是「已就绪」—— 就绪与否看 `/bi/status`。 */
          if (path === '/api/ecom-workbench/bi/start' && r.method === 'POST') {
            const res = startBi()
            send(res.ok ? 200 : 400, res)
            return
          }
          if (path === '/api/ecom-workbench/bi/status' && r.method === 'GET') {
            send(200, { ok: true, ...await biStatus() })
            return
          }

          /* ── 定时任务（计划 Step 5/6/7）────────────────────────────
           *
           * 任务表在 `data/ecom-workbench/schedule/tasks.json`，执行器在
           * `src/schedule/runner.ts`（每分钟扫一次，到点**直接调 `runWorkflowFile`**，
           * 不经过 agent、不新开 Session）。
           *
           * 四条 CRUD + 一条「立即执行」：
           *   GET    /schedule/tasks          列表
           *   POST   /schedule/tasks          新建（body: name / workflowName / time / enabled / note）
           *   PUT    /schedule/tasks          改（body: id + 要改的字段）
           *   DELETE /schedule/tasks?id=      删
           *   POST   /schedule/run/:id        现在就跑一次（调试用，也顺便验通知链路）
           *
           * ⚠️ 第一版只支持「每天一次」（`HH:MM`）。每周 / 工作日等更复杂的编排
           * 见计划 §七「未决问题」—— 没定之前不发明。
           */
          if (path === '/api/ecom-workbench/schedule/tasks' && r.method === 'GET') {
            send(200, { ok: true, tasks: await loadTasks() })
            return
          }
          if (path === '/api/ecom-workbench/schedule/tasks' && r.method === 'POST') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const time = normalizeTime(body.time)
            const workflowName = typeof body.workflowName === 'string' ? body.workflowName.trim() : ''
            if (time === '') { send(400, { error: '时间不合法（要 HH:MM，如 09:30）：' + String(body.time) }); return }
            if (workflowName === '') { send(400, { error: '要跑哪一份工作流？没给 workflowName' }); return }
            const made = normalizeTask({
              ...body,
              id: typeof body.id === 'string' && body.id !== '' ? body.id : newTaskId(),
              workflowName,
              time,
            })
            if (made === null) { send(400, { error: '任务形状不对（要 id / workflowName / time）' }); return }
            const next = await updateTasks(list => [...list, made])
            send(200, { ok: true, task: made, tasks: next })
            return
          }
          if (path === '/api/ecom-workbench/schedule/tasks' && r.method === 'PUT') {
            const body = await readJsonBody(r) as Record<string, unknown>
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (id === '') { send(400, { error: '要改哪一条？没给 id' }); return }
            /** 改一条：只覆盖给了的字段（没给的保持原样）。 */
            const patch = (t: ScheduleTask): ScheduleTask => ({
              ...t,
              ...typeof body.name === 'string' && body.name.trim() !== '' ? { name: body.name.trim() } : {},
              ...typeof body.workflowName === 'string' && body.workflowName.trim() !== ''
                ? { workflowName: body.workflowName.trim() } : {},
              ...typeof body.time === 'string' && normalizeTime(body.time) !== ''
                ? { time: normalizeTime(body.time) } : {},
              ...typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {},
              ...typeof body.note === 'string' ? { note: body.note } : {},
            })
            let found = false
            const next = await updateTasks(list => list.map(t => {
              if (t.id !== id) return t
              found = true
              return patch(t)
            }))
            send(found ? 200 : 404, found ? { ok: true, tasks: next } : { ok: false, error: '没有这个任务：' + id })
            return
          }
          if (path === '/api/ecom-workbench/schedule/tasks' && r.method === 'DELETE') {
            const id = new URL(r.url ?? '/', 'http://x').searchParams.get('id') ?? ''
            if (id === '') { send(400, { error: '要删哪一条？没给 id' }); return }
            let found = false
            const next = await updateTasks(list => list.filter(t => {
              if (t.id === id) { found = true; return false }
              return true
            }))
            send(found ? 200 : 404, found ? { ok: true, tasks: next } : { ok: false, error: '没有这个任务：' + id })
            return
          }
          if (path.startsWith('/api/ecom-workbench/schedule/run/') && r.method === 'POST') {
            const id = path.slice('/api/ecom-workbench/schedule/run/'.length)
            if (id === '') { send(400, { error: '要跑哪一条？没给 id' }); return }
            /* ⚠️ 先读到变量再传：`browser-prefs` 测试用「字面量出现几次」来数
             * 有几条跑路补了偏好（`tests/browser-prefs.mjs:133`）。这里写成一模一样的
             * 一行会让它多数一条、把那条测试弄红 —— 而它红得不对（功能是对的）。 */
            const prefs = await readBrowserPrefs()
            const out = await runTaskById(id, dispatchNode, {
              workdir: process.cwd(),
              prefs,
              via: 'schedule',
            })
            send(out.ok ? 200 : 400, out)
            return
          }

          /* ── 系统通知自检（计划 Step 3-8 的「提醒」板块）──────────
           *
           * 三项**分别**返回结论与原因（界面照计划「三项分别显示」）：
           *   ① 能不能起 PowerShell；
           *   ② 能不能弹（真的弹一条）；
           *   ③ 系统通知总开关（读注册表 `HKCU/.../PushNotifications`）。
           *
           * ⚠️ 为什么必须分开报：三项是**三个不同的故障**，
           * 合成一个「通知不可用」等于让用户没法修（是没装 PowerShell、还是被系统关了？）。 */
          if (path === '/api/ecom-workbench/notify/selfcheck' && r.method === 'POST') {
            send(200, { ok: true, ...await notifySelfcheck() })
            return
          }

          send(404, { error: 'not found: ' + path })
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    })
    ctx.effect(() => dispose, 'ecom-workbench: http routes')
  })
}
