/** 定时任务表（宿主半）：存与取。
 *
 * ## 它是什么（以及**不是**什么）
 *
 * 计划 §二「定时（参考已装插件）」钉住的那条：
 * > @michengai/dsh-automation：每次定时新开独立 DSH Session 让 agent 跑。采集巡查不该这样。
 * > 我们要的：**无 AI 参与、直接调 runWorkflowFile**。
 *
 * 所以这里只是一张**任务表**：几个点跑哪份工作流。执行由 `runner.ts` 做 ——
 * 不经过 agent、不新开 Session、不投消息。
 *
 * ## 存哪
 *
 * `data/ecom-workbench/schedule/tasks.json`（插件数据目录，跟 `workflows/` 同级）。
 * 落盘走**串行队列**（照 `workflow-runs.ts` 的 `serialize`）——
 * 「读整份 → 改 → 整份写回」并发时会互相覆盖，实测踩过（见那边的注释）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowsDir } from '../workflow/store.ts'
/* 五份巡查的清单只在一处（`patrol-results.ts`），这里从它派生默认任务的名字（票 12）。
 * 为什么不再在这里存一份：两份必然漂，见那个文件的说明与 `pitfalls/`。 */
import { PATROL_RESULT_FILES } from './patrol-results.ts'

/** 一条定时任务。 */
export interface ScheduleTask {
  /** 稳定 id（`s-<时间戳>-<随机>`）。 */
  id: string
  /** 给人看的名字。 */
  name: string
  /** 跑哪一份工作流（**名字**，与列表页的引用口径一致）。 */
  workflowName: string
  /** 每天几点几分（`HH:MM`，本地时间）。第一版只支持每天一次。 */
  time: string
  /** 启用中吗（停用的不跑，但留在表里）。 */
  enabled: boolean
  /** 备注（比如「[自动生成] 巡查默认任务」）。 */
  note?: string
  /** 上次跑的时间（毫秒）。 */
  lastRunAt?: number
  /** 上次跑的结果（一句话）。 */
  lastResult?: string
  /** 上次跑的是哪一天（`YYYY-MM-DD`）——**防同一天跑两次**。 */
  lastRunDate?: string
}

/** 任务表文件的形状（版本号留着以后加字段）。 */
interface ScheduleFile {
  version: number
  tasks: ScheduleTask[]
}

/** 任务表的版本（改形状时加一，读的时候按它兼容）。 */
const VERSION = 1

/**
 * 定时目录（`schedule/` 在插件数据目录下）。
 * @returns 绝对路径。
 */
export function scheduleDir(): string {
  return join(workflowsDir(), '..', 'schedule')
}

/**
 * 任务表文件路径。
 * @returns 绝对路径。
 */
export function tasksFile(): string {
  return join(scheduleDir(), 'tasks.json')
}

/** 任务表的写入队列（「读-改-写」要整段串起来）。 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * 把一次写入排进队列（照 `workflow-runs.ts` 的 `serialize`）。
 *
 * @param job - 要做的写入。
 * @returns 这次写入的结果。
 */
function serialize<K>(job: () => Promise<K>): Promise<K> {
  const next = queue.catch(() => { /* 上一次的失败与这一次无关 */ }).then(job)
  queue = next
  return next
}

/**
 * 造一个任务 id。
 * @returns 如 `s-20261021-143021-a1b2`。
 */
export function newTaskId(now: number = Date.now()): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return 's-' + String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    + '-' + Math.random().toString(36).slice(2, 6)
}

/**
 * 把 `HH:MM` 归一（不合法给空串）。
 *
 * 时间写错的任务应当**读出来就被识别为不可用**，而不是每晚在某个奇怪的点上跑。
 *
 * @param raw - 原始文本（可能是 `9:30` / `09:30` / `25:00`）。
 * @returns 规范的 `HH:MM`；认不出给空串。
 */
export function normalizeTime(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (m === null) return ''
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return ''
  if (h < 0 || h > 23 || min < 0 || min > 59) return ''
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0')
}

/**
 * 把一条不认识的输入洗成任务（不合法给 null）。
 *
 * 存档与界面来的东西都不可信，所以逐字段洗 —— 与 `/workflow/record` 那条路由同一个纪律。
 *
 * @param raw - 原始对象。
 * @returns 洗好的任务；没有 id / 名字 / 时间不合法给 null。
 */
export function normalizeTask(raw: unknown): ScheduleTask | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const workflowName = typeof o.workflowName === 'string' ? o.workflowName.trim() : ''
  const time = normalizeTime(o.time)
  if (id === '' || workflowName === '' || time === '') return null
  const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim() : workflowName
  return {
    id,
    name,
    workflowName,
    time,
    enabled: o.enabled !== false,
    ...typeof o.note === 'string' && o.note !== '' ? { note: o.note } : {},
    ...typeof o.lastRunAt === 'number' ? { lastRunAt: o.lastRunAt } : {},
    ...typeof o.lastResult === 'string' ? { lastResult: o.lastResult } : {},
    ...typeof o.lastRunDate === 'string' ? { lastRunDate: o.lastRunDate } : {},
  }
}

/** 默认巡查任务的时间（每天 09:30）。 */
export const DEFAULT_PATROL_TIME = '09:30'

/** 默认巡查任务的名字前缀（用户要求「名字前加 [自动生成]」）。 */
const AUTO_PREFIX = '[自动生成] '

/**
 * 造五份巡查的默认任务（首次启动任务表为空时用）。
 *
 * ## 名字从哪来（票 12，2026-10-30）
 *
 * 从 `PATROL_RESULT_FILES` **派生**，不再在这里另存一份名字清单。
 * 理由：那份清单已经是信息最全的（文件名 / 显示名 / 平台三者都有），
 * 两边各存一份必然漂 —— `pitfalls/同一件事写两份迟早漂.md` 记的就是这件事。
 * 原来这里那份 `PATROL_WORKFLOW_NAMES` 已删。
 *
 * ⚠️ **顺序就是 id**：id 由 `now + i * 1000` 拼，所以「第几条」一变，id 就跟着变，
 * 而用户已有的定时任务按 id 对 —— 顺序变了等于和已存的表对不上。
 * 所以派生顺序必须与 `PATROL_RESULT_FILES` 的声明顺序一致（它照
 * `scripts/patrol/jobs.mjs` 的 `PATROL_JOBS` 顺序），且**改动顺序要先想清楚这件事**。
 * `tests/patrol-results-route.mjs` 里有断言钉着这五条 id。
 *
 * @param now - 造 id 用的时间（测试可注入）。
 * @returns 五条任务。
 */
export function defaultPatrolTasks(now: number = Date.now()): ScheduleTask[] {
  return PATROL_RESULT_FILES.map((one, i) => ({
    /* id 由「时间 + 序号」拼，不用随机 —— 同一秒内造五条也要各不相同。 */
    id: newTaskId(now + i * 1000),
    name: AUTO_PREFIX + one.name,
    workflowName: one.name,
    time: DEFAULT_PATROL_TIME,
    enabled: true,
    note: '首次启动自动生成：每天 09:30 跑一份巡查',
  }))
}

/**
 * 读任务表。
 *
 * ⚠️ 读不到 / 坏档 → 返回空表，**不抛**：定时是附带能力，
 * 它坏了不该让整个插件起不来（与 `loadRuns` 同一条纪律）。
 *
 * @returns 任务表（已洗过；不合法的条目被丢掉）。
 */
export async function loadTasks(): Promise<ScheduleTask[]> {
  try {
    const parsed = JSON.parse(await readFile(tasksFile(), 'utf8')) as Partial<ScheduleFile>
    if (!Array.isArray(parsed.tasks)) return []
    return parsed.tasks.map(normalizeTask).filter((t): t is ScheduleTask => t !== null)
  } catch {
    return []
  }
}

/**
 * 整份写回任务表（走串行队列）。
 *
 * @param tasks - 要写的任务（已洗过）。
 * @returns 写成功了没。
 */
export async function saveTasks(tasks: ScheduleTask[]): Promise<boolean> {
  return serialize(async () => {
    try {
      await mkdir(scheduleDir(), { recursive: true })
      const doc: ScheduleFile = { version: VERSION, tasks }
      await writeFile(tasksFile(), JSON.stringify(doc, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  })
}

/**
 * 读-改-写（整段在队列里，不会被并发覆盖）。
 *
 * @param fn - 拿到当前任务表，返回新的任务表。
 * @returns 新的任务表。
 */
export async function updateTasks(fn: (tasks: ScheduleTask[]) => ScheduleTask[]): Promise<ScheduleTask[]> {
  return serialize(async () => {
    const current = await loadTasks()
    const next = fn(current)
    try {
      await mkdir(scheduleDir(), { recursive: true })
      const doc: ScheduleFile = { version: VERSION, tasks: next }
      await writeFile(tasksFile(), JSON.stringify(doc, null, 2), 'utf8')
    } catch {
      /* 写不进去也要把内存里的结果给调用方（它要据此回话） */
    }
    return next
  })
}

/**
 * 首次启动：任务表为空时写入五份巡查默认任务。
 *
 * 「为空」按**文件不存在**或**条目为 0** 判 —— 用户把五条全删了不该被重新塞回来；
 * 所以还要看文件在不在：文件在（哪怕 0 条）就说明用户已经表过态，不再插手。
 *
 * @returns 写进去了几条（0 = 没动）。
 */
export async function seedDefaultTasks(): Promise<number> {
  let exists = true
  try {
    await readFile(tasksFile(), 'utf8')
  } catch {
    exists = false
  }
  if (exists) {
    const tasks = await loadTasks()
    if (tasks.length > 0) return 0
    /* 文件在但读出来 0 条：可能是坏档。这时**照写**默认任务比留一张空表好
     * （空表 = 定时板块一片空白，用户不知道为什么）。 */
  }
  const made = defaultPatrolTasks()
  await saveTasks(made)
  return made.length
}
