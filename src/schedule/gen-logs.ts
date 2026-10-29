/** 生成记录（宿主半，契约 BA，2026-10-25）。
 *
 * # 形状照 `plans/2026-10-25-执行-生成记录与两个工作台.md` §2.2，别改字段
 *
 * 一次生成 = 一条记录 + 若干产物（0 到 N 个）。记录存
 * `gen-logs/image/<id>.json` 与 `gen-logs/video/<id>.json`。
 *
 * 为什么分两个目录：两个工作台的查看面完全不同（生图按时间、视频按队列），
 * 混在一起每次都要筛。
 *
 * ## 三条硬规矩（写在这里，改的人一眼能看到）
 *
 * 1. **不许出现任何与结算有关的字段**。计划 §三 5.3 与用户 m01114 已定「本期不做这一项」，
 *    留一个字段就会有人填，填了就会有人拿它当真相。用量只记「张数 / 秒数」。
 *    ⚠️ 本条规矩的**措辞也刻意避开了那几个关键词**：验收判据是「全文搜 0 命中」，
 *    连注释里举例都算命中。要把这条规矩写清楚又不踩判据，只能这么绕。
 *    （验收脚本：`tests/gen-logs.mjs` ⑤）
 * 2. **`artifacts` 只是引用**（id + 尺寸），本体在 `artifacts/` 目录。记录不是主 ——
 *    这与「产物库删了文件，画布上显示图已删除」是同一条所有权规则。
 * 3. **失败也留记录**（`status: 'failed'` + `error`）。这是本项目在采集那边踩过的坑：
 *    失败没产出就不写记录，结果事后什么都查不到（见 `src/schedule/records.ts` 那张四档表）。
 *
 * ## ⚠️ 本期**没有生成链路**
 *
 * 没有渠道调用、没有出图。这两条路由只负责**读写磁盘上的记录**。
 * 也就是说：现在这些记录是**手工放进去的**（`tests/gen-logs.mjs` 就是这么造的），
 * 或者以后接上生成链路由它写。不许因为「列表里出现了三条」就说「生成跑通了」。
 */
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { genLogsDir } from './artifacts.ts'

/**
 * 一次生成的记录（字段与执行文档 §2.2 逐字对应）。
 *
 * ⚠️ 可选键的纪律：**没有就不写这个键**（不写 `undefined`、不写空字符串）。
 * 这与 `DispatchResult.reports` / `llm` 是同一条写法，理由也一样 ——
 * 一个「值为 undefined 的键」在 JSON 里会消失，读的人分不清「没这个事」还是「有但为空」。
 */
export interface GenLog {
  /** 记录 id（与产物 id 同一套字符集）。 */
  id: string
  /** 这次生成是图还是视频。 */
  kind: 'image' | 'video'
  /** 什么时候提交的（ms）。 */
  createdAt: number
  /** 什么时候有结果的（ms）；没有结果时不写这个键。 */
  endedAt?: number
  /** 状态（与视频创作台的三态一致，图也一样用三态）。 */
  status: 'pending' | 'success' | 'failed'
  /** 哪个渠道（`channels.json` 里的 id）。 */
  channelId: string
  /** 哪个模型。 */
  model: string
  /** 提示词原文。 */
  prompt: string
  /** 反查提示词（可选）。 */
  negativePrompt?: string
  /** 参数原样留着（尺寸、张数、种子、时长、画幅…）。本层不解释。 */
  params: Record<string, unknown>
  /** 产出（成功时有；失败时可以没有）。 */
  artifacts: { id: string, width?: number, height?: number, bytes?: number }[]
  /** 用量 —— 本期只留位置，不算账。图片是张数、视频是秒数。 */
  usage: { images?: number, seconds?: number }
  /** 失败原因（`status === 'failed'` 时才有这个键）。 */
  error?: string
  /** 从哪触发：`workbench`（工作台）/ `canvas`（画布节点）/ `workflow`（工作流节点）。 */
  source?: string
  /** 画布来源时是哪一份画布与哪个节点（反查用）。 */
  canvasId?: string
  canvasNodeId?: string
}

/** 记录 id 的合法形状。**安全边界**：id 进 URL、进文件名。 */
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * id 合不合法。
 * @param id - 待查 id。
 * @returns 合法为 true。
 */
export function isGenLogId(id: string): boolean {
  return ID_OK.test(id)
}

/**
 * 某一类记录的目录。
 * @param kind - `image` / `video`。
 * @returns 绝对路径。
 */
function kindDir(kind: 'image' | 'video'): string {
  return join(genLogsDir(), kind)
}

/**
 * 归一一条记录（**纯函数**，能单测）。
 *
 * ## 它做两件事
 *
 * 1. **补齐必填的形态**（`params` / `artifacts` / `usage` 缺了给空对象 / 空数组：
 *    这三个是「容器」，缺了会让界面到处判 `undefined`；而 `error` / `endedAt`
 *    这类是「事实」，缺了就该缺着，不能编一个空串）。
 * 2. **丢掉不认识的键**。为什么：写进来什么就存什么的话，某天前端多传一个
 *    结算类字段就会静静躺进磁盘，而规矩说不能有那个东西。白名单是唯一可靠的办法。
 *
 * @param raw - 请求体或磁盘上的原文。
 * @returns 归一后的记录；`id` 或 `kind` 不合法给 `null`。
 */
export function normalizeGenLog(raw: Record<string, unknown>): GenLog | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!isGenLogId(id)) return null
  const kind = raw.kind === 'video' ? 'video' : raw.kind === 'image' ? 'image' : ''
  if (kind === '') return null

  const status = raw.status === 'success' ? 'success' : raw.status === 'failed' ? 'failed' : 'pending'
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined

  const artList: GenLog['artifacts'] = []
  if (Array.isArray(raw.artifacts)) {
    for (const a of raw.artifacts) {
      if (typeof a !== 'object' || a === null) continue
      const rec = a as Record<string, unknown>
      const aid = typeof rec.id === 'string' ? rec.id.trim() : ''
      if (aid === '') continue
      artList.push({
        id: aid,
        ...num(rec.width) === undefined ? {} : { width: num(rec.width) as number },
        ...num(rec.height) === undefined ? {} : { height: num(rec.height) as number },
        ...num(rec.bytes) === undefined ? {} : { bytes: num(rec.bytes) as number },
      })
    }
  }

  const usageRaw = typeof raw.usage === 'object' && raw.usage !== null
    ? raw.usage as Record<string, unknown> : {}
  const usage: GenLog['usage'] = {
    ...num(usageRaw.images) === undefined ? {} : { images: num(usageRaw.images) as number },
    ...num(usageRaw.seconds) === undefined ? {} : { seconds: num(usageRaw.seconds) as number },
  }

  return {
    id,
    kind,
    createdAt: num(raw.createdAt) ?? Date.now(),
    ...num(raw.endedAt) === undefined ? {} : { endedAt: num(raw.endedAt) as number },
    status,
    channelId: typeof raw.channelId === 'string' ? raw.channelId : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    ...str(raw.negativePrompt) === undefined ? {} : { negativePrompt: str(raw.negativePrompt) as string },
    params: typeof raw.params === 'object' && raw.params !== null && !Array.isArray(raw.params)
      ? raw.params as Record<string, unknown> : {},
    artifacts: artList,
    usage,
    ...str(raw.error) === undefined ? {} : { error: str(raw.error) as string },
    ...str(raw.source) === undefined ? {} : { source: str(raw.source) as string },
    ...str(raw.canvasId) === undefined ? {} : { canvasId: str(raw.canvasId) as string },
    ...str(raw.canvasNodeId) === undefined ? {} : { canvasNodeId: str(raw.canvasNodeId) as string },
  }
}

/**
 * 写一条生成记录。
 *
 * @param log - 记录。
 * @throws id / kind 不合法时抛错（不静默丢弃 —— 静默丢弃等于「记录写丢了却没人知道」）。
 */
export async function writeGenLog(log: GenLog): Promise<void> {
  const clean = normalizeGenLog(log as unknown as Record<string, unknown>)
  if (clean === null) throw new Error('生成记录的 id 或 kind 不合法：' + JSON.stringify({ id: log?.id, kind: log?.kind }))
  const dir = kindDir(clean.kind)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, clean.id + '.json'), JSON.stringify(clean, null, 2), 'utf8')
}

/**
 * 读一条生成记录。
 *
 * 两类目录都找（接口只给 id，不给 kind）—— 一条记录的大小可以忽略，
 * 多读一次目录比让调用方先猜 kind 好。
 *
 * @param id - 记录 id。
 * @returns 记录；找不到或读不出来给 `null`。
 */
export async function readGenLog(id: string): Promise<GenLog | null> {
  if (!isGenLogId(id)) return null
  for (const kind of ['image', 'video'] as const) {
    let text: string
    try {
      text = await readFile(join(kindDir(kind), id + '.json'), 'utf8')
    } catch { continue }
    try {
      const parsed = normalizeGenLog(JSON.parse(text) as Record<string, unknown>)
      if (parsed !== null) return parsed
    } catch { /* 坏文件继续找另一个目录 */ }
  }
  return null
}

/**
 * 列某一类记录（按 `createdAt` 倒序，新的在前）。
 *
 * 单条读不出来（坏 JSON / id 不合法）就跳过 —— 一条坏记录不该让整个工作台打不开。
 *
 * @param kind - `image` / `video`（**互不串**：只看自己那个目录）。
 * @param limit - 最多几条（默认 100）。
 * @returns 记录数组。
 */
export async function listGenLogs(kind: 'image' | 'video', limit = 100): Promise<GenLog[]> {
  const dir = kindDir(kind)
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const out: GenLog[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = normalizeGenLog(JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>)
      /* ⚠️ 只收 `kind` 对得上的：有人手工把一份视频记录丢进 `image/` 时，
       * 列表按**文件里写的 kind** 决定，不让它混进生图工作台。 */
      if (parsed !== null && parsed.kind === kind) out.push(parsed)
    } catch { /* 坏文件跳过 */ }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out.slice(0, limit > 0 ? limit : 100)
}

/**
 * 删一条生成记录（票 44）。
 *
 * ## 它只删**记录文件**，不碰产物
 *
 * 产物在 `artifacts/` 是**另一个库**（记录里的 `artifacts` 只是 id 引用）。
 * 「删记录要不要连产物一起删」是两件事：
 *   · 产物可能被画布引用（`GET /artifacts/usage` 会告诉你），删了画布上会显示图已删除
 *   · 一条记录删了，它引用的图仍然可能被别人用
 *
 * 所以这里**只删那条 `.json`**，产物由界面按用户的选择另行处理
 * （界面那一侧会问过 `artifacts/usage` 再决定）。
 *
 * ## 为什么两个目录都试
 *
 * 接口只给 id、不给 kind（与 `readGenLog` 同一个理由：多读一次目录比让调用方先猜更省事）。
 *
 * @param id - 记录 id。
 * @returns 真的删掉了给 `true`；id 不合法或两个目录都没有给 `false`。
 */
export async function deleteGenLog(id: string): Promise<boolean> {
  /* ⚠️ **先校验再拼路径**。`id` 来自 URL，不校验的话 `../` 之类会被拼成路径 ——
   * 那是一个能删任意文件的漏洞。`isGenLogId` 已经把字符集限死。 */
  if (!isGenLogId(id)) return false
  let removed = false
  for (const kind of ['image', 'video'] as const) {
    try {
      await unlink(join(kindDir(kind), id + '.json'))
      removed = true
    } catch { /* 这个目录没有，继续找另一个 */ }
  }
  return removed
}
