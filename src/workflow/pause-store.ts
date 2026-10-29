/** 挂起的运行**落盘**（宿主半）：`data/ecom-workbench/paused/<runId>.json`。
 *
 * ## 为什么与 `snapshot.ts` 分成两个文件
 *
 * `snapshot.ts` 是**形状 + 规则**（纯逻辑，画布也要引）；本文件**碰磁盘**，
 * 只有宿主半能引。混在一起的话画布一 import 就带上 `node:fs`，打包直接失败。
 * 这与 `specs.ts` / `run-file.ts` 的拆法同一条纪律。
 *
 * ## 落盘必须走**串行队列**（红线）
 *
 * 「读一份 → 改 → 写回」如果在同一文件上并发，后写的会**整条覆盖**先写的。
 * 运行历史的 `appendRun` 已经因为这件事丢过记录（见 `workflow-runs.ts` 的长注释）。
 * 挂起这里形态不同（一运行一个文件、不读整份数组），但仍然排队：
 * 同一份运行**可能同时**被「跑完的清理」与「恢复的删除」碰到，排队最省心。
 *
 * ## 目录位置
 *
 * 与 `workflows/`、`runs/` 同级（都在插件数据目录下）。这样备份 / 搬迁一次带走，
 * 而「按运行分文件」天然不冲突 —— 同时挂起十份就是十个文件。
 */
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowsDir, safeName } from './store.ts'
import { asSnapshot, type RunSnapshot } from './snapshot.ts'

/**
 * 挂起目录。
 *
 * ⚠️ 用 `workflowsDir` 的**父目录**再拼 `paused` —— 与 `runsDir` 同一个写法，
 * 于是沙箱（`EWB_TEST_HOME`）与降级路径都自动一致，不必在这里重写一遍解析规则。
 *
 * @param dshHome - 数据根（测试可注入）。
 * @param profile - profile 名（测试可注入）。
 * @returns 绝对路径。
 */
export function pausedDir(dshHome?: string, profile?: string): string {
  return join(workflowsDir(dshHome, profile), '..', 'paused')
}

/**
 * 一份挂起现场的文件路径。
 *
 * @param runId - 运行 id（走 `safeName`，防 `../` 写出目录外）。
 * @param dshHome - 数据根。
 * @param profile - profile 名。
 * @returns 绝对路径。
 */
function pausedFile(runId: string, dshHome?: string, profile?: string): string {
  return join(pausedDir(dshHome, profile), safeName(runId) + '.json')
}

/**
 * 每个文件一条写入队列（与 `workflow-runs.ts` 的 `serialize` 同一个做法）。
 *
 * 键是文件名而不是绝对路径：沙箱切换（测试）时不会串到上一个沙箱的队列上。
 */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * 把一次写入排进该文件的队列，等前面那些都做完再跑。
 *
 * @param file - 文件名（队列键）。
 * @param job - 要做的写入。
 * @returns 这次写入的结果。
 */
function serialize<K>(file: string, job: () => Promise<K>): Promise<K> {
  const prev = writeQueues.get(file) ?? Promise.resolve()
  const next = prev.catch(() => { /* 上一次的失败与这一次无关 */ }).then(job)
  writeQueues.set(file, next)
  void next.finally(() => { if (writeQueues.get(file) === next) writeQueues.delete(file) })
  return next
}

/**
 * 存一份挂起现场。
 *
 * ⚠️ 写失败**要报出来**（与 `appendRun` 不同）：运行历史存不上只是「少一条记录」，
 * 而现场存不上意味着**这份运行恢复不了** —— 必须让调用方知道，好当场报错而不是假装挂起了。
 *
 * @param snap - 现场。
 * @param opts.dshHome - 数据根（测试可注入）。
 * @param opts.profile - profile 名（测试可注入）。
 * @returns 存成功了没。
 */
export async function savePausedRun(
  snap: RunSnapshot,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<boolean> {
  const file = safeName(snap.runId) + '.json'
  return serialize(file, async () => {
    try {
      const dir = pausedDir(opts.dshHome, opts.profile)
      await mkdir(dir, { recursive: true })
      await writeFile(pausedFile(snap.runId, opts.dshHome, opts.profile), JSON.stringify(snap, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  })
}

/**
 * 读一份挂起现场。
 *
 * 读不到 / 内容坏了都返回 null —— **不抛**：一份坏文件不该让「列出所有等待中」整个失败。
 *
 * @param runId - 运行 id。
 * @param opts.dshHome - 数据根。
 * @param opts.profile - profile 名。
 * @returns 现场；没有或坏掉给 null。
 */
export async function loadPausedRun(
  runId: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<RunSnapshot | null> {
  try {
    const text = await readFile(pausedFile(runId, opts.dshHome, opts.profile), 'utf8')
    return asSnapshot(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

/**
 * 删一份挂起现场（恢复完 / 用户取消时）。
 *
 * 本来就不存在也算成功 —— 调用方关心的是「现在没有它了」。
 *
 * @param runId - 运行 id。
 * @param opts.dshHome - 数据根。
 * @param opts.profile - profile 名。
 * @returns 删掉了没（不存在也算 true）。
 */
export async function removePausedRun(
  runId: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<boolean> {
  const file = safeName(runId) + '.json'
  return serialize(file, async () => {
    try {
      await unlink(pausedFile(runId, opts.dshHome, opts.profile))
      return true
    } catch {
      return true
    }
  })
}

/**
 * 列出全部挂起现场（新的在前）。
 *
 * 坏文件跳过、不整批失败（与 `listWorkflows` 同一个取舍）。
 *
 * @param opts.dshHome - 数据根。
 * @param opts.profile - profile 名。
 * @returns 现场数组（按挂起时刻倒序）。
 */
export async function listPausedRuns(
  opts: { dshHome?: string, profile?: string } = {},
): Promise<RunSnapshot[]> {
  const dir = pausedDir(opts.dshHome, opts.profile)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const out: RunSnapshot[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const snap = await loadPausedRun(f.slice(0, -5), opts)
    if (snap !== null) out.push(snap)
  }
  out.sort((a, b) => b.pausedAt - a.pausedAt)
  return out
}

/**
 * 挂起目录里最新一份文件的修改时间（给「有没有在等」这类判断用）。
 *
 * @param runId - 运行 id。
 * @param opts.dshHome - 数据根。
 * @param opts.profile - profile 名。
 * @returns 毫秒时间戳；没有给 null。
 */
export async function pausedAtOf(
  runId: string,
  opts: { dshHome?: string, profile?: string } = {},
): Promise<number | null> {
  try {
    const st = await stat(pausedFile(runId, opts.dshHome, opts.profile))
    return Math.round(st.mtimeMs)
  } catch {
    return null
  }
}
