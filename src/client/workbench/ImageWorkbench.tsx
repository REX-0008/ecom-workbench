/** 三个工作台（生图 / 视频 / 音频）的**共用实现** + 生图工作台本体。
 *
 * ## 为什么三个工作台住在一个文件里（契约 CF，用户 m01076）
 *
 * 视频创作台与音频工作台**除了参数项之外完全一样**：提交区、轮询、列表、
 * 重试、取消。复制三份之后「改一处忘两处」是必然
 * （本项目 `pitfalls/同一件事写两份迟早漂.md` 记的就是这个）。
 *
 * 所以：
 *   · 提交与轮询的公共件在本文件（`SubmitForm` / `useGenerate` / `mergeRows`…）；
 *   · 生图工作台本体也在本文件（`ImageWorkbench`）；
 *   · 视频与音频只是**传一个 `kind` 进来**（`VideoWorkbench.tsx` / `AudioWorkbench.tsx`）。
 *
 * ## 一条记录是什么（这一条别混）
 *
 * | 来源 | 是什么 | 谁写 |
 * |---|---|---|
 * | `gen-logs/` | **历史**：跑完了的每一次（要了什么、得到了什么） | 宿主（`writeGenLog`） |
 * | 内存里的任务 | **现在**：`submitted` / `running` 的那几条 | 宿主（`submitGeneration`） |
 *
 * 列表是两者**合并按时间倒序** —— 只读 `gen-logs/` 的话，刚点完「生成」
 * 到它落盘之间那一段界面上什么都没有（用户会以为没提交成功）。
 *
 * ## 「已等 N 秒」是本机算的，不是宿主给的
 *
 * 宿主也给了 `waitedMs`，但它只在**轮询那一刻**是准的；两次轮询之间秒数不动，
 * 看起来像卡住。所以每秒由本机按 `now - createdAt` 算（视频那格原来就是这么做的）。
 *
 * ## 布局：**结果墙是主视觉，表单收进左窄栏**（用户 m03414 / m03555）
 *
 * 用户原话：「生图工作台应该有图片展示，整个界面核心应该是以生成结果展示为核心，
 * 我们现在的是什么？填表？差距太大了。好好看看别人怎么做的。」
 *
 * 之前是**上下堆叠**：表单一整块在上面、结果一行行在下面 —— 打开第一眼看到的是
 * 「提示词 / 模型 / 渠道 / 参数」四个输入框，也就是一张表单。参考项目反过来：
 * 左窄栏（约 320px）放表单，右边**整块留给结果墙**（多列网格、大图、卡片式）。
 *
 * 现在照它做：`flex` 两栏，左栏 `w-[320px] shrink-0`（窄屏折成上下两段），
 * 右栏 `min-w-0 flex-1` 放结果墙。**每加一个元素都问一句「它是结果还是表单」**，
 * 表单往左栏收。
 *
 * ## 没有百分比
 *
 * 参考项目也没有（计划已核实）。上游 ComfyUI 只报「第几步」，要换算成百分比
 * 只能编一个分母 —— 编出来的数字比没有更糟。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
/* ⚠️ 从 `antd` **按需解构两个**，绝不 `import antd from 'antd'`（照抄三条纪律之一）。
 * `Drawer` 是票 33 补宽屏记录抽屉时加的（照参考 `pages/image/index.tsx:541`）。 */
import { Drawer, Modal } from 'antd'
import { call, when } from './board-kit.ts'
/* 「一次生成几张」的偏好（票 05）。别名带 Workbench 前缀：
 * 这个文件里已经有一个画布侧的 `readPrefs` 语义（`lib/canvas/canvas-prefs.ts`），
 * 同名会让人以为是那一份。 */
import { readPrefs as readWorkbenchPrefs } from './lib/workbench-prefs.ts'
/* 提示词库那份内置副本（与 `PromptLibrary` 同一个数据源，零请求）。 */
import { allBuiltinEntries } from './prompt-sources/index.ts'

/** 三态（与宿主 `GenLog.status` 一致）。 */
export type GenStatus = 'pending' | 'success' | 'failed'

/** 能生成的四种东西（与宿主 `GenKind` 一致；`text` 没有工作台）。 */
export type GenKind = 'image' | 'video' | 'audio'

/** 宿主任务的状态（`src/schedule/generate.ts` 的 `TaskStatus`）。 */
export type TaskStatus = 'submitted' | 'running' | 'success' | 'failed'

/** 一条生成记录（照执行文档 §2.2 的十五个字段，一个不多一个不少）。 */
export interface GenLog {
  id: string
  kind: 'image' | 'video'
  createdAt: number
  endedAt?: number
  status: GenStatus
  channelId: string
  model: string
  prompt: string
  negativePrompt?: string
  params: Record<string, unknown>
  artifacts: { id: string, width?: number, height?: number, bytes?: number }[]
  usage: { images?: number, seconds?: number }
  error?: string
  source?: string
  canvasId?: string
  canvasNodeId?: string
}

/** 宿主内存里的一个任务（`GET /generate/:id` 的 `task`，只抄界面要用的字段）。 */
export interface GenTask {
  id: string
  kind: string
  status: TaskStatus
  stage: string
  prompt: string
  model: string
  channelId: string
  channelName: string
  createdAt: number
  endedAt?: number
  waitedMs: number
  artifacts: { id: string, url?: string, mime?: string }[]
  error?: string
}

/** 一个可选的模型（`GET /gen-models?kind=` 的 `models[]`）。 */
export interface ModelOption {
  channelId: string
  channelName: string
  protocol: string
  modelId: string
  modelLabel: string
  caps: string[]
}

/** 按渠道分好组的模型（下拉里的 `<optgroup>`）。 */
export interface ChannelGroup {
  channelId: string
  channelName: string
  protocol: string
  models: ModelOption[]
}

/**
 * 把模型清单按渠道分组（**顺序照宿主给的**：渠道顺序、渠道内登记顺序）。
 * @param models - 平铺的模型清单。
 * @returns 分组后的清单。
 */
export function groupModelsByChannel(models: readonly ModelOption[]): ChannelGroup[] {
  const out: ChannelGroup[] = []
  for (const m of models) {
    const hit = out.find(g => g.channelId === m.channelId)
    if (hit !== undefined) { hit.models.push(m); continue }
    out.push({ channelId: m.channelId, channelName: m.channelName, protocol: m.protocol, models: [m] })
  }
  return out
}

/** 状态的中文说法（三态，别自己再编第四种）。 */
export const STATUS_TEXT: Readonly<Record<GenStatus, string>> = {
  pending: '进行中',
  success: '成功',
  failed: '失败',
}

/**
 * 产物的显示地址（宿主半的二进制路由）。
 * @param id - 产物 id。
 * @returns 地址。
 */
export function artifactUrl(id: string): string {
  return '/api/ecom-workbench/artifact/' + encodeURIComponent(id)
}

/**
 * 耗时写成一句（`endedAt - createdAt`）。
 *
 * 没有 `endedAt`（还在跑 / 手工造的记录没写）时给「—」，**不编一个数字**。
 *
 * @param log - 记录。
 * @returns 如 `12.4 秒` / `3 分 05 秒` / `—`。
 */
export function elapsedText(log: GenLog): string {
  if (log.endedAt === undefined) return '—'
  const ms = log.endedAt - log.createdAt
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + ' 秒'
  const m = Math.floor(s / 60)
  const rest = Math.round(s - m * 60)
  return String(m) + ' 分 ' + String(rest).padStart(2, '0') + ' 秒'
}

/**
 * 「已等 N 秒 / 用时 …」。
 *
 * 跑完了就不再是「等待」—— 说「用时」，免得一条昨天跑完的记录上
 * 还写着「已等 86400 秒」。
 *
 * @param createdAt - 提交时间（ms）。
 * @param endedAt - 结束时间（ms，可缺）。
 * @param now - 现在的时刻（ms）。
 * @returns 文案。
 */
export function waitText(createdAt: number, endedAt: number | undefined, now: number): string {
  if (endedAt !== undefined) {
    const s = Math.max(0, (endedAt - createdAt) / 1000)
    if (!Number.isFinite(s)) return '—'
    return '用时 ' + (s < 60 ? s.toFixed(1) + ' 秒'
      : String(Math.floor(s / 60)) + ' 分 ' + String(Math.round(s % 60)).padStart(2, '0') + ' 秒')
  }
  const ms = now - createdAt
  return '已等 ' + String(!Number.isFinite(ms) || ms < 0 ? 0 : Math.floor(ms / 1000)) + ' 秒'
}

/**
 * 成功几张 / 失败几张。
 *
 * 判据是「这条记录里有几个产物」与「状态」——
 * **不按张数编**：失败时可能一张都没有，也可能部分成功。
 *
 * @param log - 记录。
 * @returns 一句话。
 */
export function outcomeText(log: GenLog): string {
  const got = log.artifacts.length
  /* ⚠️ `usage` 在老记录里可能没有（手工放进 gen-logs 的、或者宿主早期写的）。
   * 直接读 `log.usage.images` 会整块界面崩 —— 这一条是写测试时真踩到的
   * （从任务来的行根本没有 usage）。缺就按「产出数」算。 */
  const want = log.usage?.images ?? got
  if (log.status === 'success') return '成功 ' + String(got) + ' 张'
  if (log.status === 'failed') {
    const miss = Math.max(0, want - got)
    return got === 0 ? '失败，没有产出' : '部分成功 ' + String(got) + ' 张，失败 ' + String(miss) + ' 张'
  }
  return '还没结果'
}

/**
 * 一条记录的成败张数（票 44 的五个标签用）。
 *
 * ## 「算不出就不显示」这条边界（lead 2026-10-28 裁的）
 *
 * 参考那边是 `failCount = generationCount - successCount`（`:185`），
 * 前提是它手上有个**准的 generationCount**。我们没有：`usage.images` 只在
 * **新记录**里有（老记录、手工放进 `gen-logs/` 的记录都没有）。
 *
 * 所以这里的规矩是：
 *   · `ok` 恒可算（就是产物数）—— 失败数算不出时它仍然要显示
 *   · `fail` **只在能算时才给数字**：`usage.images` 存在、且它 ≥ 产物数
 *   · 算不出时给 `null`，**界面整个不渲染那一个标签**
 *
 * ⚠️ **不许**为了「总有东西显示」编一个 `0` 或拿产物数当分母 —— 老记录里
 * 减数是空的，硬算出来会是负值或恰好等于成功数，比不显示更坏。
 *
 * @param row - 一行。
 * @returns `{ ok, fail }`；`fail` 为 `null` 表示算不出。
 */
export function countsOf(row: WorkRow): { ok: number, fail: number | null } {
  const ok = row.artifacts.length
  const want = (row.raw as GenLog).usage?.images
  if (typeof want !== 'number' || !Number.isFinite(want) || want < ok) return { ok, fail: null }
  const fail = want - ok
  /* 一张没成、也没有任何失败（即「要了 0 张」这种坏数据）时也算不出。 */
  if (fail === 0 && ok === 0 && want === 0) return { ok, fail: null }
  return { ok, fail }
}

/**
 * 一条记录的「共 N 张」（票 44 的五个标签之一）。
 *
 * @param row - 一行。
 * @returns 数字；算不出给 `null`。
 */
export function totalOf(row: WorkRow): number | null {
  const want = (row.raw as GenLog).usage?.images
  if (typeof want === 'number' && Number.isFinite(want)) return want
  /* 老记录没有 usage：退回产物数（**不等于**「这一轮要了几张」，但它至少是真的）。 */
  return row.artifacts.length > 0 ? row.artifacts.length : null
}

/* ── 列表行（历史 + 在跑，合成一种形状）──────────────────────────────── */

/** 列表里的一行。 */
export interface WorkRow {
  id: string
  kind: string
  createdAt: number
  endedAt?: number
  status: GenStatus
  prompt: string
  model: string
  channelId: string
  /** 参数那一句（历史记录由 `params` 拼，在跑的任务用 `stage`）。 */
  paramsText: string
  /**
   * 产物。
   *
   * ## 为什么带上尺寸与体积（票 44 加）
   *
   * 结果卡下方那行元信息要显示「1024×1024 · 200 KB」（判据 7）。
   * `GenLog.artifacts` 本来就有 `width` / `height` / `bytes`（`gen-logs.ts:113-121`），
   * 是这里当初收窄成 `{ id }` 把它们丢了。**接上来，不动上游形状**。
   *
   * ⚠️ 在跑的任务（`GenTask.artifacts`）只有 id —— 所以这三个字段都是可选的，
   * 缺的时候界面显示「尺寸 — / 体积 —」，不编数。
   */
  artifacts: { id: string, width?: number, height?: number, bytes?: number }[]
  error?: string
  /** 是不是还在跑的那几条（决定要不要显示「取消」、要不要继续轮询）。 */
  live: boolean
  /** 原样留着：重试要用它的参数。 */
  raw: GenLog | GenTask
}

/**
 * 任务状态 → 三态。
 * @param s - 任务状态。
 * @returns 三态。
 */
export function taskToGenStatus(s: TaskStatus): GenStatus {
  if (s === 'success') return 'success'
  if (s === 'failed') return 'failed'
  return 'pending'
}

/**
 * 把「历史记录」与「在跑的任务」合成一张表（按 `createdAt` 倒序，同 id 以任务为准）。
 *
 * 为什么任务优先：任务是**活的**，历史是快照。同一条 id 两边都有时，
 * 任务那条的 `status` 更新（历史那条可能是上一次跑完的旧结论）。
 *
 * @param logs - `gen-logs` 读出来的。
 * @param tasks - 内存里的任务。
 * @returns 合成后的行。
 */
export function mergeRows(logs: readonly GenLog[], tasks: readonly GenTask[]): WorkRow[] {
  const out: WorkRow[] = []
  const seen = new Set<string>()

  for (const t of tasks) {
    seen.add(t.id)
    out.push({
      id: t.id, kind: t.kind, createdAt: t.createdAt,
      ...t.endedAt === undefined ? {} : { endedAt: t.endedAt },
      status: taskToGenStatus(t.status),
      prompt: t.prompt, model: t.model, channelId: t.channelId,
      /* 任务没有 `params`（它在 history 里），这里给阶段名 —— 那是它唯一说得出的话。 */
      paramsText: t.stage === '' ? '' : '阶段 ' + t.stage,
      artifacts: t.artifacts.map(a => ({ id: a.id })),
      ...t.error === undefined ? {} : { error: t.error },
      live: t.status === 'submitted' || t.status === 'running',
      raw: t,
    })
  }
  for (const l of logs) {
    if (seen.has(l.id)) continue
    out.push({
      id: l.id, kind: l.kind, createdAt: l.createdAt,
      ...l.endedAt === undefined ? {} : { endedAt: l.endedAt },
      status: l.status,
      prompt: l.prompt, model: l.model, channelId: l.channelId,
      paramsText: paramsLine(l.params),
      /* ⚠️ 宽 / 高 / 字节要**一起抄过来**（票 44）：结果卡下方那行元信息
       * 显示「1024×1024 · 196 KB」靠的就是这三个。原来只抄了 `id`，
       * 于是界面上永远是「尺寸 — · 体积 —」—— 数据在磁盘上有、在界面里不见了。 */
      artifacts: l.artifacts.map(a => ({
        id: a.id,
        ...a.width === undefined ? {} : { width: a.width },
        ...a.height === undefined ? {} : { height: a.height },
        ...a.bytes === undefined ? {} : { bytes: a.bytes },
      })),
      ...l.error === undefined ? {} : { error: l.error },
      live: false,
      raw: l,
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 参数写成一行（`尺寸 1024x1024 · 张数 2`）。
 *
 * 只列认识的键，其余原样附在后面 —— 不认识就一个字都不显示的话，
 * 用户会以为「参数没存下来」。
 *
 * @param params - 记录的参数对象。
 * @returns 一句。
 */
export function paramsLine(params: Record<string, unknown>): string {
  const known: string[] = []
  const used = new Set<string>()
  const put = (key: string, label: string, unit = ''): void => {
    const v = params[key]
    if (v === undefined) return
    used.add(key)
    known.push(label + ' ' + String(v) + unit)
  }
  put('size', '尺寸')
  put('count', '张数')
  put('seconds', '时长', ' 秒')
  put('ratio', '画幅')
  put('seed', '种子')
  const rest = Object.keys(params).filter(k => !used.has(k))
  for (const k of rest) known.push(k + ' ' + String(params[k]))
  return known.join(' · ')
}

/* ── 表单字段（按 kind 决定显示哪几项）────────────────────────────────── */

/**
 * 这一种生成要哪几个字段。
 * @param kind - 生成什么。
 * @returns 字段 id 数组。
 */
export function formFields(kind: GenKind): string[] {
  if (kind === 'image') return ['prompt', 'model', 'size', 'count', 'seed', 'ref', 'submit']
  if (kind === 'video') return ['prompt', 'model', 'seconds', 'size', 'seed', 'ref', 'submit']
  return ['prompt', 'model', 'seconds', 'submit']
}

/**
 * 种子的合法值（`null` = 没填 = 让后端随机）。
 *
 * ## 三档，一档都不能少
 *
 * | 输入 | 返回 | 为什么 |
 * |---|---|---|
 * | 空串 / 只有空格 | `null` | 「不填」的语义是**不发这个键**，让后端随机 |
 * | `12345` | `12345` | 原样用 |
 * | `abc` / `-1` / `1.5` | `NaN` | **非法** —— 调用方据此拦住，别让它静默变成「没填」 |
 *
 * ⚠️ 为什么非法要单独一档而不是干脆返回 `null`：后端对 `seed` 的判据是
 * `Number.isFinite`，`abc` 送过去会被当成「没给」而**静默随机**。
 * 那时用户以为自己指定了种子、拿到的却是随机图，而且没有任何提示 ——
 * 这种「看着生效了其实没生效」是本项目反复在消灭的一类问题。
 *
 * @param raw - 表单里的原文。
 * @returns 合法数字、`null`（没填），或 `NaN`（填了但不合法）。
 */
export function seedValue(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return null
  /* 只收非负整数：种子的语义是一个 32 位无符号整数（后端那侧就是
   * `0 ~ 2**32-1`），小数与负数送过去不是它本意。 */
  if (!/^\d+$/.test(t)) return Number.NaN
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : Number.NaN
}

/**
 * 种子填得对不对（`''` = 没问题）。
 *
 * 三段式：① 发生了什么 ② 为什么 ③ 怎么办。
 *
 * @param raw - 表单里的原文。
 * @returns 一句人话；没问题时是空串。
 */
export function seedProblem(raw: string): string {
  if (!Number.isNaN(seedValue(raw))) return ''
  return '种子填的不是整数：' + raw.trim() + '。要复现同一张图，种子得是一个非负整数（例如 12345）；留空则由后端随机。'
}

/**
 * 一张参考图（票 41：从单张扩到多张）。
 *
 * ## 为什么带 `id`
 *
 * 增删与调序都按 `id` 定位，不按下标 —— 下标会在删掉中间一张之后整体错位，
 * 表现是「点了这张的删除，消失的是另一张」。
 *
 * ## 为什么 `base64` 与 `name` 分开存
 *
 * `base64` 要进请求体（`submitBody` 只发它和 `mime`），`name` 只给人看。
 * 合成一个字符串的话，发请求前还得再切一次 —— 切错就是「发出去的是文件名」。
 */
export interface RefImage {
  /** 本地唯一 id（增删与调序用）。 */
  id: string
  /** 图片内容（不含 `data:...;base64,` 前缀）。 */
  base64: string
  /** MIME（`image/png` 这类）。空串按 `image/png` 发。 */
  mime: string
  /** 文件名 / 来源标签，只给人看。 */
  name: string
}

/** 参考图编号（照参考 `image-reference-prompt.ts:5` 的「图片N」，从 1 起）。 */
export function refLabel(index: number): string {
  return '图片' + String(index + 1)
}

/**
 * 把 `data:` URL 拆成 base64 与 MIME（**纯函数**）。
 *
 * @param dataUrl - `FileReader` 给的整串。
 * @param fallbackMime - 拆不出 MIME 时的兜底。
 * @returns 两段。
 */
export function splitDataUrl(dataUrl: string, fallbackMime = 'image/png'): { base64: string, mime: string } {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return { base64: dataUrl, mime: fallbackMime }
  const head = dataUrl.slice(0, comma)
  const m = /^data:([^;,]+)/.exec(head)
  return {
    base64: dataUrl.slice(comma + 1),
    mime: m === null ? fallbackMime : m[1],
  }
}

/**
 * 追加几张参考图（**纯函数**）。
 *
 * 为什么是「追加」不是「替换」：参考 `index.tsx:126` 原话是
 * `setReferences(value => [...value, ...nextReferences])` ——
 * 拖文件进框、点上传、读剪贴板三条路**都是往后面加**，
 * 只有「删单张」才会让列表变短。
 *
 * @param list - 现有列表。
 * @param more - 要加的。
 * @returns 新列表（不改入参）。
 */
export function appendRefs(list: readonly RefImage[], more: readonly RefImage[]): RefImage[] {
  return [...list, ...more]
}

/**
 * 删掉一张（**纯函数**，按 id 不按下标）。
 * @param list - 现有列表。
 * @param id - 要删的那张。
 * @returns 新列表。
 */
export function removeRef(list: readonly RefImage[], id: string): RefImage[] {
  return list.filter(r => r.id !== id)
}

/**
 * 前后移一位（**纯函数**，照参考 `index.tsx:847` 的 `moveListItem`）。
 *
 * 越界就原样返回 —— 参考那边也是这个写法（`if (targetIndex < 0 || >= length) return items`）。
 * 不抛错的理由：首尾那两颗按钮在界面上已经是 disabled，越界只可能是调用方写错，
 * 那时「不动」比「炸掉整个表单」好。
 *
 * @param list - 现有列表。
 * @param index - 当前位置。
 * @param offset - `-1` 前移、`+1` 后移。
 * @returns 新列表。
 */
export function moveRef(list: readonly RefImage[], index: number, offset: number): RefImage[] {
  const target = index + offset
  if (index < 0 || index >= list.length) return [...list]
  if (target < 0 || target >= list.length) return [...list]
  const next = [...list]
  const a = next[index]
  const b = next[target]
  next[index] = b
  next[target] = a
  return next
}

/** 提交区的草稿。 */
export interface GenDraft {
  prompt: string
  /** 选中的模型 id（`模型` 下拉）。 */
  model: string
  /** 选中的渠道 id（由模型带出来，不单独选）。 */
  channelId: string
  size: string
  count: string
  seconds: string
  /**
   * 种子（票 09，2026-10-30）。
   *
   * **表单里一律字符串** —— 与 `count` / `seconds` 同一套做法（填的时候就存原文，
   * 合法性与换算在 `seedValue` / `submitBody` 那两处收口）。
   *
   * 空串 = 没填 = **不发这个键**，让后端随机；后端会把实际用的那个写进
   * `task.seed` 与记录的 `params.seed`，界面上那一行的参数串里看得到。
   *
   * 为什么不做成 `number | null`：受控输入框的 `value` 只能是字符串，
   * 存成数字就得在每个 `onChange` 里来一次「空串怎么办」的换算 ——
   * 那正是「清空时变成 0」这类 bug 的产地。
   */
  seed: string
  /**
   * 参考图 / 首帧列表（票 41：**数组**，可为空）。
   *
   * ## 从三个标量改名过来的（`refBase64` / `refMime` / `refName`）
   *
   * 那三个字段只装得下一张。后端 `GenerateInput.refs`（`src/schedule/generate.ts:428`）
   * 一直是 `{ mime, bytes }[]`，`gemini-gen` / `net-gen` / `openai-gen` 三条路
   * 都是 `for (const ref of req.refs ?? [])` 逐张处理 —— **缺的从来只是前端**。
   */
  refs: RefImage[]
}

/** 空草稿（**视频 / 生图那一套**默认值）。
 *
 * ## 音频不走这一份（票 29，2026-10-27）
 *
 * `seconds: '5'` 对视频是对的（MiniMax 视频要这个数），但对**音频**是错的：
 *
 * · 内置音频工作流（`audio_minimax_music_3_api.json`）里 node47 是
 *   `{"Number": ""}`，那个空串的意思是「用模型自己的默认时长」；
 * · 后端 `runComfyBranch`（`generate.ts:700`）与 `applyBindings` 都守住了
 *   「没给就不动它」这条边界 —— 注释原话：「发 0 或 5 会把那个空串改掉，
 *   等于替用户做了个他没收到的决定」；
 * · 而界面这一侧如果默认填 5，用户只填提示词、不碰时长，就会发出 `seconds: 5`，
 *   **把后端刚守住的边界绕过去了**。
 *
 * 所以音频用 `emptyDraftOf('audio')`，时长默认留空。 */
export const EMPTY_DRAFT: GenDraft = {
  prompt: '', model: '', channelId: '',
  size: '1024x1024', count: '1', seconds: '5',
  /* 种子默认**空**：不填就由后端随机（票 09）。 */
  seed: '',
  refs: [],
}

/**
 * 按生成种类给一份空草稿。
 *
 * 只有音频与别的不同：**时长默认空**（含义是「用模型自己的默认」，
 * 与内置工作流里那个空串对齐）。理由见 `EMPTY_DRAFT` 上那段。
 *
 * ⚠️ 不给音频改 `size`：那一路由 `submitBody` 按 kind 显式拦掉
 * （`kind !== 'audio'`），不靠这里的空串兜。两处各管一件事 ——
 * 草稿管「框里显示什么」，`submitBody` 管「发不发这个键」。
 *
 * @param kind - 生成什么。
 * @returns 空草稿。
 */
export function emptyDraftOf(kind: GenKind): GenDraft {
  /* ⚠️ `refs: []` 必须是**新数组**，不能直接返回 `EMPTY_DRAFT` 里那个。
   *
   * 共享同一个数组的后果：某处若写了 `draft.refs.push(...)`（或者调了一个
   * 就地排序的 helper），`EMPTY_DRAFT` 这份常量就被污染了 ——
   * 之后每一份空草稿都带着上一轮那些图，而且**测试之间会互相污染**。
   * 这里是浅拷贝，`RefImage` 本身是只读用的，不需要深拷。 */
  if (kind === 'audio') return { ...EMPTY_DRAFT, refs: [], seconds: '' }
  return { ...EMPTY_DRAFT, refs: [] }
}

/** 图 / 视频的常见尺寸。 */
export const SIZES: readonly string[] = ['1024x1024', '832x1216', '1216x832', '768x1344', '1344x768']

/**
 * 把草稿拼成 `POST /generate` 的请求体（**纯函数**，验收 2 的判据落在这里）。
 *
 * 空值**不发键**（宿主按「键不在 = 用默认」处理，发空串会让它当成真的空值）。
 *
 * @param kind - 生成什么。
 * @param d - 草稿。
 * @returns 请求体。
 */
export function submitBody(kind: GenKind, d: GenDraft): Record<string, unknown> {
  const body: Record<string, unknown> = { kind, prompt: d.prompt.trim(), model: d.model }
  if (d.channelId !== '') body.channelId = d.channelId
  const n = Number(d.count)
  if (kind === 'image' && Number.isFinite(n) && n > 0) body.count = Math.round(n)
  if (kind !== 'image') {
    const s = Number(d.seconds)
    if (Number.isFinite(s) && s > 0) body.seconds = Math.round(s)
  }
  /* ⚠️ `kind !== 'audio'` 是**业务事实**，不是布局的副产品（票 29）：
   * 音频链路不认尺寸（`applyBindings` 没有对应槽位），发过去是无效字段。
   *
   * 为什么不写成「`formFields(kind)` 里有 `size` 才发」：那等于拿界面布局
   * 当业务规则 —— 将来谁把 `size` 从视频表单里挪走，请求体就悄悄不发 `size` 了，
   * 后端那边看着像「这个字段再没人传」。**用布局推断业务，就是在埋
   * 「改界面把后端弄坏」的坑。** */
  if (kind !== 'audio' && d.size !== '') body.size = d.size
  /* 参考图：**有几张发几张，顺序就是列表里的顺序**（票 41）。
   *
   * 空列表时**整个键不发** —— 与改造前同一个约定（宿主按「键不在 = 没有参考图」处理，
   * 发 `[]` 会让它当成一个真的空参数）。`workbenches-submit.mjs` 那条
   * 「没选参考图就不发 refs 这个键」盯的就是这里。 */
  if (d.refs.length > 0) {
    body.refs = d.refs.map(r => ({
      mime: r.mime === '' ? 'image/png' : r.mime,
      base64: r.base64,
    }))
  }
  /* 种子（票 09）：**只在填了一个合法整数时才发这个键**。
   *
   * ### 为什么空着要「不发键」而不是发空串或 0
   *
   * 后端的判据是 `Number.isFinite(req.seed)`（`src/schedule/generate.ts`）：
   * `undefined` → 它自己随机一个；`0` → 它**真的就用 0**。
   * 发 `0` 的话「用户没填」会被变成「用户指定了种子 0」，
   * 之后每一张都是同一个随机序列 —— 表面正常，实际是错的。
   *
   * 同理不发空串：`Number('')` 是 0（不是 NaN），一样会落进「指定了 0」。
   *
   * ### 非法值在这里**拦不住**，那是另一层的事
   *
   * `seedValue` 返回 `NaN` 时这里**不发键**（等价于没填），但用户必须**先被告知**
   * —— 那一层在 `seedProblem` 与提交前的拦截里（`missingFields` 旁边）。
   * 这里不再判一次，免得两处判据漂开。 */
  const seed = seedValue(d.seed)
  if (seed !== null && !Number.isNaN(seed)) body.seed = seed
  return body
}

/**
 * 提交区缺什么（空数组 = 可以提交）。
 * @param kind - 生成什么。
 * @param d - 草稿。
 * @returns 缺的那几项（给人看的名字）。
 */
export function missingFields(kind: GenKind, d: GenDraft): string[] {
  const miss: string[] = []
  if (d.prompt.trim() === '') miss.push('提示词')
  if (d.model === '') miss.push('模型')
  void kind
  return miss
}

/**
 * 一行该显示什么结论（历史与在跑两种来源形状不同，这里收口）。
 *
 * 在跑的行（任务是活的）**没有 `usage`** —— 拿它去算「成功几张」会读到 undefined，
 * 表现是整块界面崩（写 `tests/workbenches-submit.mjs` 时真踩到）。
 * 所以按「来源」分：任务的行说结果，历史记录的行用 `outcomeText`。
 *
 * @param row - 一行。
 * @param kind - 生成什么（图片说「张」，视频与音频说「段」）。
 * @returns 一句。
 */
export function outcomeLine(row: WorkRow, kind: GenKind): string {
  if (row.live) return '进行中'
  const unit = kind === 'image' ? '张' : '段'
  const got = row.artifacts.length
  if (row.status === 'success') return '成功 ' + String(got) + ' ' + unit
  if (row.status === 'failed') return got === 0 ? '失败，没有产出' : '部分成功 ' + String(got) + ' ' + unit
  return '还没结果'
}

/* ── 提交 + 轮询 ─────────────────────────────────────────────────────── */

/** 轮询间隔（ms）。够快看得见进度，又不至于把宿主问成压力。 */
export const POLL_MS = 800

/**
 * 一次生成的「提交 → 轮询 → 收尾」。
 *
 * ## 为什么不用 `setInterval` 一把梭
 *
 * `setInterval` 不等待上一次请求返回：宿主慢的时候请求会堆起来，
 * 取消之后还在飞。这里用「一笔完了再排下一笔」的写法。
 *
 * @param kind - 生成什么（只用来过滤任务）。
 * @returns 见 `UseGenerate`。
 */
export interface UseGenerate {
  /** 正在跑的那几条（列表里排在前面）。 */
  tasks: GenTask[]
  /** 提交一次。返回任务 id（失败给空串，原因在 `error`）。 */
  submit: (d: GenDraft) => Promise<{ ok: boolean, id: string }>
  /** 取消一个在跑的任务。 */
  cancel: (id: string) => Promise<boolean>
  /** 提交 / 取消的错因（一条，显示在顶部）。 */
  error: string
  /** 清掉错因。 */
  clearError: () => void
  /** 正在提交（按钮转圈 / 禁用）。 */
  submitting: boolean
}

/**
 * 提交与轮询的钩子。
 * @param kind - 生成什么。
 * @param enabled - 这一格显示着没有（藏起来时不轮询）。
 * @returns 见 `UseGenerate`。
 */
export function useGenerate(kind: GenKind, enabled: boolean): UseGenerate {
  const [tasks, setTasks] = useState<GenTask[]>([])
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** 还在跑的 id（轮询谁）。 */
  const liveRef = useRef<Set<string>>(new Set())
  const aliveRef = useRef(true)
  /** 一轮轮询的定时器（卸载 / 取消时清掉）。 */
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  /** 把一条任务贴回去（按 id 替换，不在就插到最前）。 */
  const patch = useCallback((t: GenTask): void => {
    setTasks(prev => {
      const i = prev.findIndex(x => x.id === t.id)
      if (i < 0) return [t, ...prev]
      const next = [...prev]
      next[i] = t
      return next
    })
  }, [])

  /**
   * 轮询一轮。
   *
   * 只在还有「在跑」的 id 时才排下一轮 —— 全都跑完了就让定时器停掉，
   * 不然后台一直在问宿主。
   */
  const pollOnce = useCallback(async (): Promise<void> => {
    const ids = [...liveRef.current]
    if (ids.length === 0) return
    let stillLive = false
    for (const id of ids) {
      const r = await call<{ task?: GenTask }>('/generate/' + encodeURIComponent(id))
      if (!aliveRef.current) return
      if (!r.ok || r.body?.task === undefined) {
        /* 查不到就摘掉它（宿主重启会清任务，不该永远轮询一个不存在的 id）。 */
        liveRef.current.delete(id)
        continue
      }
      const t = r.body.task
      patch(t)
      if (t.status === 'submitted' || t.status === 'running') {
        stillLive = true
      } else {
        liveRef.current.delete(id)
      }
    }
    if (!aliveRef.current) return
    if (stillLive && liveRef.current.size > 0) {
      timerRef.current = window.setTimeout(() => { void pollOnce() }, POLL_MS)
    }
  }, [patch])

  /** 提交一次。 */
  const submit = useCallback(async (d: GenDraft): Promise<{ ok: boolean, id: string }> => {
    const miss = missingFields(kind, d)
    if (miss.length > 0) {
      setError('还差：' + miss.join('、'))
      return { ok: false, id: '' }
    }
    /* ★ 票 09：种子填错了**在这里拦住**，别让它静默变成「没填」。
     *
     * 后端对 `seed` 的判据是 `Number.isFinite`，`abc` 送过去会被当成没给、
     * 悄悄随机一个 —— 用户以为自己复现了那一张，实际拿到的是新图。
     * 这条与上面「还差：…」那条同属提交前的闸，所以放在同一处。 */
    const seedBad = seedProblem(d.seed)
    if (seedBad !== '') {
      setError(seedBad)
      return { ok: false, id: '' }
    }
    setSubmitting(true)
    setError('')
    const r = await call<{ id?: string, task?: GenTask }>('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submitBody(kind, d)),
    })
    setSubmitting(false)
    if (!r.ok || r.body?.id === undefined) {
      setError(r.error ?? '提交失败')
      return { ok: false, id: '' }
    }
    const id = r.body.id
    /* 宿主的回包里带 task 就照它贴；没带就造一条 `pending` 占位 ——
     * 提交之后界面上必须**立刻**有这一条，否则用户会以为没提交成功。 */
    const t: GenTask = r.body.task ?? {
      id, kind, status: 'submitted', stage: 'submitted',
      prompt: d.prompt.trim(), model: d.model, channelId: d.channelId, channelName: '',
      createdAt: Date.now(), waitedMs: 0, artifacts: [],
    }
    patch(t)
    liveRef.current.add(id)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { void pollOnce() }, POLL_MS)
    return { ok: true, id }
  }, [kind, patch, pollOnce])

  /** 取消一个。 */
  const cancel = useCallback(async (id: string): Promise<boolean> => {
    const r = await call<unknown>('/generate/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
    if (!r.ok) { setError(r.error ?? '取消失败'); return false }
    liveRef.current.delete(id)
    /* 取消之后状态由宿主给（它可能标 failed 也可能标别的），这里只把它从「在跑」里摘掉，
     * 下一次轮询会把它最终的状态贴回来。为了不让它一直显示「进行中」，
     * 先按本地判断收一下。 */
    setTasks(prev => prev.map(t => (t.id === id
      ? { ...t, status: 'failed', endedAt: Date.now(), error: t.error ?? '已取消' }
      : t)))
    return true
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (liveRef.current.size === 0) return
    if (timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => { void pollOnce() }, POLL_MS)
  }, [enabled, pollOnce])

  return {
    tasks, submit, cancel, error,
    clearError: useCallback(() => { setError('') }, []),
    submitting,
  }
}

/* ── 提交区（三个工作台共用）────────────────────────────────────────── */

/** 宽高比的一个选项（照参考 `components/image-settings-panel.tsx:17-31` 那 13 项）。
 *
 * ## 为什么「2k / 4k」不是独立字段
 *
 * 参考 `selectAspect`（`:53-55`）原话是 `onConfigChange("size", option?.size || option?.value)` ——
 * **点击只写 `size` 一个字符串**。2k 那几项只是「同一个比例 + 另一档像素」的预设，
 * 落到请求体里还是 `2048x2048` 这种写法。
 *
 * 我们的后端 `parseSize`（`src/schedule/comfyui.ts:661`）认三种写法：
 * 空 / `auto`、`1024x1024`、`16:9` 或 `9:16-2k`。下表全部写成像素形式，
 * 所以每一档都走 `parseSize` 的第一条分支，不依赖它猜比例。
 */
export interface AspectOption {
  /** 按钮上显示的字。 */
  label: string
  /** 点下去写进 `size` 的值（也是这个按钮的身份）。 */
  value: string
  /** 图标朝向。 */
  icon: 'square' | 'landscape' | 'portrait' | 'auto'
  width: number
  height: number
}

/** 13 个宽高比预设（顺序照参考那张表，一个不多一个不少）。 */
export const ASPECT_OPTIONS: readonly AspectOption[] = [
  { label: '1:1', value: '1024x1024', icon: 'square', width: 1024, height: 1024 },
  { label: '3:2', value: '1536x1024', icon: 'landscape', width: 1536, height: 1024 },
  { label: '2:3', value: '1024x1536', icon: 'portrait', width: 1024, height: 1536 },
  { label: '4:3', value: '1360x1024', icon: 'landscape', width: 1360, height: 1024 },
  { label: '3:4', value: '1024x1360', icon: 'portrait', width: 1024, height: 1360 },
  { label: '16:9', value: '1824x1024', icon: 'landscape', width: 1824, height: 1024 },
  { label: '9:16', value: '1024x1824', icon: 'portrait', width: 1024, height: 1824 },
  { label: '1:1(2k)', value: '2048x2048', icon: 'square', width: 2048, height: 2048 },
  { label: '16:9(2k)', value: '2048x1152', icon: 'landscape', width: 2048, height: 1152 },
  { label: '9:16(2k)', value: '1152x2048', icon: 'portrait', width: 1152, height: 2048 },
  { label: '16:9(4k)', value: '3840x2160', icon: 'landscape', width: 3840, height: 2160 },
  { label: '9:16(4k)', value: '2160x3840', icon: 'portrait', width: 2160, height: 3840 },
  /* `auto` 宽高都是 0：它表示「交给工作流自己的默认」，不参与比例换算。 */
  { label: 'auto', value: 'auto', icon: 'auto', width: 0, height: 0 },
]

/** 「16 倍数对齐」的步长（照参考 `:15` 的 `DIMENSION_STEP`）。 */
export const ALIGN_STEP = 16

/**
 * 把一个像素值向上补成 `ALIGN_STEP` 的倍数（照参考 `alignDimension`，`:231-233`）。
 *
 * 为什么**向上**而不是就近：ComfyUI 的 VAE 对非 16 倍数的宽高会出黑边或直接报错，
 * 向上补保证不缩水；就近取整可能把 1024 变成 1020。
 *
 * @param value - 原值。
 * @param enabled - 开关是否打开（关掉就原样返回）。
 * @returns 对齐后的值。
 */
export function alignDimension(value: number, enabled: boolean): number {
  if (!enabled) return value
  return Math.ceil(value / ALIGN_STEP) * ALIGN_STEP
}

/**
 * 从 `size` 写法里取出宽高（照参考 `readSizeDimensions`，`:225-229`）。
 *
 * 认不出（空 / `auto` / 比例写法）就退回兜底值 —— 那两个输入框只服务
 * 「像素形式」这一种，别的写法它们显示兜底值、并且是**禁用**的。
 *
 * @param size - 尺寸写法。
 * @param fallback - 兜底宽高。
 * @returns 宽高。
 */
export function readSizeDimensions(size: string, fallback: { width: number, height: number }): { width: number, height: number } {
  const m = /^(\d+)x(\d+)$/.exec(size.trim())
  if (m === null) return { width: fallback.width, height: fallback.height }
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * 按钮上的比例图标（照参考 `AspectIcon`，`:210-223`）。
 *
 * 画的是一个按真实比例缩放的方框：`16:9` 宽、`9:16` 高、`1:1` 方。
 * `auto` 不画图形，只留空位（参考也是 `return null`）。
 *
 * @param props - 见参数说明。
 * @returns 图标。
 */
function AspectIcon(props: { option: AspectOption }): React.JSX.Element {
  const o = props.option
  if (o.icon === 'auto') return <span className="grid h-5 w-6 place-items-center" />
  const ratio = o.width / Math.max(1, o.height)
  const w = ratio >= 1 ? 18 : Math.max(8, 18 * ratio)
  const h = ratio >= 1 ? Math.max(8, 18 / ratio) : 18
  return (
    <span className="grid h-5 w-6 place-items-center">
      <span className="border border-current" style={{ width: w, height: h }} />
    </span>
  )
}

/**
 * 参考图 id 里的序号（模块级计数器）。
 *
 * 为什么不用 `Date.now()` 单独做 id：一次选五张时五张**在同一毫秒**里生成，
 * 光靠时间戳会撞车，`key` 重复 → React 只画一张、删一张时删错。
 *
 * @returns 递增序号。
 */
let refSeqCounter = 0
export function refSeq(): number {
  refSeqCounter += 1
  return refSeqCounter
}

/** 提交区 / 设置抽屉共用的参数块入参。 */
export interface GenSettingsProps {
  kind: GenKind
  values: GenDraft
  onChange: (patch: Partial<GenDraft>) => void
  /** 模型清单（按渠道分好组）。 */
  groups: readonly ChannelGroup[]
  /** 读模型清单失败时的原因。 */
  modelsError: string
  /**
   * 数据钩子的前缀。
   *
   * ## 为什么必须分前缀（不是小事）
   *
   * 这块组件在**同一个页面里被渲染两次**：中栏一次、设置抽屉一次（照参考
   * `pages/image/index.tsx:567` 的 `GenerationSettings` 也是两处共用）。
   * 两处挂同一个 `data-ewb-gen-submit-model`，测试里的 `querySelector` 就会
   * 取到抽屉那一份 —— 断言从此验的是「抽屉里的框」，不是用户看到的表单。
   *
   * 所以中栏用 `data-ewb-gen-submit`、抽屉用 `data-ewb-gen-setting`，
   * 谁是谁一目了然；判据 3 就按「两边字段名（去掉前缀后）完全一致」来比。
   */
  hook: string
}

/**
 * 参数块：模型 + 尺寸（宽高比 / W·H / 16 倍数对齐）+ 张数 / 时长。
 *
 * ## 与参考的关系
 *
 * 参考把这三块拆进 `ImageSettingsPanel`（`components/image-settings-panel.tsx`）
 * 与 `GenerationSettings`（`pages/image/index.tsx:567`）。我们两个工作台共用一份实现，
 * 所以合成一个组件、按 `kind` 决定显示哪几项（`formFields` 已经是这件事的唯一出口）。
 *
 * ## 质量那一项**刻意不做**
 *
 * 参考那边有 6 档质量，但 `services/api/image.ts` 里 `quality` **零命中** ——
 * 它从不进请求体。加一个「存了但不生效」的开关，正是这一轮反复在删的东西。
 *
 * @param props - 见 `GenSettingsProps`。
 * @returns 参数块。
 */
export function GenSettings(props: GenSettingsProps): React.JSX.Element {
  const { kind, values, hook } = props
  const fields = formFields(kind)
  const has = (f: string): boolean => fields.includes(f)
  const set = (p: Partial<GenDraft>): void => { props.onChange(p) }
  /** 「16 倍数对齐」开关。参考也是**组件本地状态**（`:52`），不进存档、不进请求体。 */
  const [align16, setAlign16] = useState(true)

  const box = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'
  const cap = 'font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]'
  const noModels = props.groups.length === 0

  /** 选模型时把它的渠道一起记下（提交体要 channelId）。 */
  const pickModel = (modelId: string): void => {
    for (const g of props.groups) {
      if (g.models.some(m => m.modelId === modelId)) {
        set({ model: modelId, channelId: g.channelId })
        return
      }
    }
    set({ model: modelId, channelId: '' })
  }

  const current = ASPECT_OPTIONS.find(o => o.value === values.size) ?? null
  const dims = readSizeDimensions(values.size, {
    width: current?.width ?? 1024,
    height: current?.height ?? 1024,
  })
  const isAuto = values.size === 'auto'

  /** 改 W 或 H：换算成 `size = "{W}x{H}"`（照参考 `updateDimension`，`:57-62`）。 */
  const updateDimension = (key: 'width' | 'height', raw: number): void => {
    const next = Math.max(1, Math.floor(Number.isFinite(raw) && raw > 0 ? raw : dims[key]))
    const w = key === 'width' ? next : dims.width
    const h = key === 'height' ? next : dims.height
    set({ size: String(alignDimension(w, align16)) + 'x' + String(alignDimension(h, align16)) })
  }

  return (
    <>
      {has('model')
        ? (
          <label className="col-span-2 block min-w-0 sm:col-span-1">
            <span className={'mb-1 block ' + cap}>模型</span>
            <select
              {...{ [hook + '-model']: '' }}
              className={box}
              value={values.model}
              onChange={e => { pickModel(e.target.value) }}
            >
              <option value="">（选一个模型）</option>
              {/* ★ 按渠道分组（`<optgroup>`）—— 用户要的是「同一渠道的模型归在一起」。 */}
              {props.groups.map(g => (
                <optgroup key={g.channelId} label={g.channelName + '（' + g.protocol + '）'} data-ewb-gen-group={g.channelId}>
                  {g.models.map(m => (
                    <option key={g.channelId + '/' + m.modelId} value={m.modelId}>{m.modelLabel}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {noModels
              ? (
                <span {...{ [hook + '-nomodels']: '' }} className="mt-1 block font-mono text-ewb-caption text-[#ff8a8a]">
                  {props.modelsError === '' ? '没有能做这件事的模型，先去「配置」里加渠道' : props.modelsError}
                </span>
              )
              : null}
          </label>
        )
        : null}

      {has('size')
        ? (
          <div className="col-span-2 min-w-0">
            {/* ── 标题行：左「尺寸」、右「16 倍数对齐」（照参考 `:70-76`）── */}
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className={cap}>{kind === 'video' ? '分辨率' : '尺寸'}</span>
              <label className="flex shrink-0 items-center gap-1.5">
                <span className={cap}>16 倍数对齐</span>
                <input
                  {...{ [hook + '-align16']: '' }}
                  type="checkbox"
                  className="h-3.5 w-3.5 cursor-pointer accent-[var(--dsw-alias-brand-primary)]"
                  checked={align16}
                  onChange={e => { setAlign16(e.target.checked) }}
                />
              </label>
            </div>

            {/* ── W ↔ H（照参考 `:78-83` 的 `grid-cols-[1fr_auto_1fr]`）──
             * `auto` 时两个框**禁用**：那种写法下没有具体像素可改（参考 `:174`）。 */}
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              {(['width', 'height'] as const).map((side, idx) => (
                <label key={side} className={idx === 0 ? 'flex h-8 overflow-hidden rounded-ctl border border-[var(--dsw-alias-border-l2)]'
                  : 'flex h-8 overflow-hidden rounded-ctl border border-[var(--dsw-alias-border-l2)]'}>
                  <span className="grid w-6 place-items-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                    {side === 'width' ? 'W' : 'H'}
                  </span>
                  <input
                    {...{ [hook + '-' + (side === 'width' ? 'w' : 'h')]: '' }}
                    type="number"
                    min={1}
                    disabled={isAuto}
                    className="min-w-0 flex-1 bg-transparent px-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none disabled:opacity-45"
                    value={dims[side]}
                    onChange={e => { updateDimension(side, Number(e.target.value)) }}
                  />
                </label>
              )).reduce<React.JSX.Element[]>((acc, el, idx) => {
                /* 中间那个 ↔ 插在两个输入框之间（照参考）。 */
                if (idx === 1) acc.push(<span key="arrow" className="justify-self-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">↔</span>)
                acc.push(el)
                return acc
              }, [])}
            </div>

            {/* ── 13 个宽高比按钮（照参考 `:95-108` 的 `grid-cols-4`）── */}
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {ASPECT_OPTIONS.map(o => (
                <button
                  key={o.value}
                  type="button"
                  {...{ [hook + '-aspect']: o.value }}
                  data-ewb-gen-aspect-active={o.value === values.size ? '' : undefined}
                  className={[
                    'flex h-12 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-ctl border font-mono text-ewb-caption',
                    o.value === values.size
                      ? 'border-[var(--dsw-alias-brand-primary)] text-[var(--dsw-alias-label-primary)]'
                      : 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-secondary)]',
                  ].join(' ')}
                  title={o.value === 'auto' ? '交给工作流自己的默认尺寸' : o.value}
                  onClick={() => { set({ size: o.value }) }}
                >
                  <AspectIcon option={o} />
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
          </div>
        )
        : null}

      {has('count')
        ? (
          <div className="col-span-2 min-w-0">
            <span className={'mb-1 block ' + cap}>生成张数</span>
            {/* ── 快选 1-N + 自定义（照参考 `:110-125` 的 `grid-cols-4`）──
             * N 取 8：`EMPTY_DRAFT.count` 那把输入框一直是 `max={8}`，
             * 快选与自定义框的上限必须是同一个数（两个上限就是两个真相）。 */}
            <div className="grid grid-cols-4 gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                <button
                  key={n}
                  type="button"
                  {...{ [hook + '-quick-count']: String(n) }}
                  className={[
                    'h-8 cursor-pointer rounded-full border font-mono text-ewb-caption',
                    String(n) === values.count
                      ? 'border-[var(--dsw-alias-brand-primary)] text-[var(--dsw-alias-label-primary)]'
                      : 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-secondary)]',
                  ].join(' ')}
                  onClick={() => { set({ count: String(n) }) }}
                >{n} 张</button>
              ))}
              <input
                {...{ [hook + '-count']: '' }}
                type="number"
                min={1}
                max={8}
                className="col-span-2 h-8 rounded-full border border-[var(--dsw-alias-border-l2)] bg-transparent px-2 text-center font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
                value={values.count}
                onChange={e => { set({ count: e.target.value }) }}
              />
            </div>
          </div>
        )
        : null}

      {has('seconds')
        ? (
          <label className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1">
            <span className={'w-8 shrink-0 ' + cap}>时长</span>
            <input
              {...{ [hook + '-seconds']: '' }}
              className={box}
              type="number"
              min={1}
              max={300}
              value={values.seconds}
              onChange={e => { set({ seconds: e.target.value }) }}
            />
            <span className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">秒</span>
          </label>
        )
        : null}

      {/* ★ 票 09：种子。空着 = 让后端随机；填了非负整数 = 复现那一张。
       *
       * 占位提示只写一句「留空则随机」—— 不解释「种子是什么」（那是模型内部的事，
       * 一句话说不清，说不清就不写）。 */}
      {has('seed')
        ? (
          <label className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1">
            <span className={'w-10 shrink-0 ' + cap}>种子</span>
            <input
              {...{ [hook + '-seed']: '' }}
              className={box}
              type="text"
              inputMode="numeric"
              placeholder="留空则随机"
              value={values.seed}
              onChange={e => { set({ seed: e.target.value }) }}
            />
            {/* 填错了当场说，不等提交（提交时还有一道闸，两处判据都走 `seedValue`）。 */}
            {seedProblem(values.seed) === ''
              ? null
              : (
                <span
                  {...{ [hook + '-seed-bad']: '' }}
                  className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-state-error-primary)]"
                >要非负整数</span>
              )}
          </label>
        )
        : null}
    </>
  )
}

/** 提交区的入参。 */
export interface SubmitFormProps {
  kind: GenKind
  values: GenDraft
  onChange: (patch: Partial<GenDraft>) => void
  onSubmit: () => void
  submitting: boolean
  /** 模型清单（按渠道分好组）。 */
  groups: readonly ChannelGroup[]
  /** 读模型清单失败时的原因。 */
  modelsError: string
  /** 窄屏紧凑条上「调整」按钮：开设置抽屉。 */
  onOpenSettings: () => void
  /**
   * 说一句给用户听的话（剪贴板读不到、剪贴板里没图）。
   *
   * ⚠️ 不走 `window.alert`：那会打断操作，而且 jsdom 里 `alert` 是空实现，
   * 断言「有没有提示」量不到。走父组件那条 `data-ewb-gen-error` 通道，
   * 用户看得见、测试也读得到。
   */
  onNotice: (msg: string) => void
}

/**
 * 提示词 + 参考图 + 参数块 + 生成按钮。
 *
 * ## 四层窄屏（照参考 `pages/image/index.tsx`，票 42 补齐）
 *
 * ```
 * 宽度 ≥ sm   中栏直接显示参数块（`hidden sm:grid`）
 * 宽度 < sm   参数块收起，只留一行「模型 · 尺寸 + 调整」（`sm:hidden`）
 * 宽度 < lg   左栏记录消失，工具条上出现「记录 / 设置」两个按钮
 * ```
 *
 * 三条断点类**必须成对出现**，任何一边写错就是「宽屏重复入口」或
 * 「窄屏一个入口都没有」—— 那是用户实际会碰到的形态，不是理论风险。
 *
 * @param props - 见 `SubmitFormProps`。
 * @returns 表单。
 */
export function SubmitForm(props: SubmitFormProps): React.JSX.Element {
  const { kind, values } = props
  const field = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'
  const label = 'flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]'
  const noModels = props.groups.length === 0
  /** 那个藏起来的文件框（「上传」按钮转去点它）。 */
  const fileRef = useRef<HTMLInputElement | null>(null)
  /** 拖进虚线框的层数（`dragenter/leave` 会在子元素上反复触发，用深度避免一直闪）。 */
  const dragDepth = useRef(0)
  /** 有没有文件正拖在框上（决定虚线框高亮与空态文案）。 */
  const [dragActive, setDragActive] = useState(false)
  /**
   * 当前环境能不能读剪贴板（判据 3）。
   *
   * ⚠️ 用 `useState` + `useEffect` 而不是渲染期直接读 `navigator.clipboard`：
   * 渲染期读会让 SSR / 首帧与之后不一致；而 jsdom 里 `navigator.clipboard`
   * 可能根本不存在，直接读属性会抛。放 effect 里、外面套 `try` 最稳。
   */
  const [clipboardOk, setClipboardOk] = useState(false)
  useEffect(() => {
    try {
      const c = (navigator as unknown as { clipboard?: { read?: unknown } }).clipboard
      setClipboardOk(typeof c?.read === 'function')
    } catch { setClipboardOk(false) }
  }, [])

  /**
   * 把一个 `File` 读成 `RefImage`（**异步**）。
   *
   * 为什么不再用 `props.onChange` 直接写：一次可能加好几张，
   * 逐个 `onChange` 会让「第一张的回调跑完前第二张又来了」这种交错变得难查。
   * 改成先 `Promise.all` 攒齐、**一次性** `onChange`，顺序才等于用户选的顺序。
   *
   * @param file - 文件。
   * @returns 一张参考图。
   */
  const refOfFile = async (file: File): Promise<RefImage> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { resolve(String(reader.result ?? '')) }
      reader.onerror = () => { reject(new Error('读文件失败：' + file.name)) }
      reader.readAsDataURL(file)
    })
    const { base64, mime } = splitDataUrl(dataUrl, file.type === '' ? 'image/png' : file.type)
    return {
      /* id 用「时间 + 序号 + 名字」拼：不引 nanoid（本项目没这个依赖），
       * 而 `Date.now()` 单独用会在同一毫秒内批量添加时撞车。 */
      id: 'r' + String(Date.now()) + '-' + String(refSeq()) + '-' + file.name,
      base64,
      mime,
      name: file.name,
    }
  }

  /**
   * 加几张（拖文件 / 上传 两条路共用）。
   *
   * ⚠️ **只收图片**（照参考 `index.tsx:119` 的 `.filter(file => file.type.startsWith('image/'))`）。
   * 拖一个 PDF 进来时静默忽略比报错好 —— 那多半是手滑。
   *
   * @param files - 文件列表。
   */
  const addFiles = (files: FileList | null | undefined): void => {
    if (files === null || files === undefined) return
    const picked = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (picked.length === 0) return
    void Promise.all(picked.map(refOfFile)).then(made => {
      props.onChange({ refs: appendRefs(values.refs, made) })
    })
  }

  /**
   * 从系统剪贴板读图追加（照参考 `index.tsx:129-151`）。
   *
   * ## 为什么先判 API 在不在
   *
   * `navigator.clipboard.read` **不是所有环境都有**（jsdom 没有、非 HTTPS 也没有）。
   * 直接调会抛 `TypeError`，界面上表现成「点了没反应」。
   * 所以按钮在 `clipboardOk === false` 时置灰并给出原因（判据 3）。
   *
   * ## 为什么 `catch` 里也要报错
   *
   * 用户在浏览器里**点了「拒绝」**（权限提示）时，`read()` 抛的是
   * `NotAllowedError`。那不是「剪贴板里没图」，是「没给权限」——
   * 两种要说不同的话，否则用户会去剪贴板里翻半天。
   */
  const addFromClipboard = (): void => {
    if (!clipboardOk) return
    void (async () => {
      try {
        const items = await navigator.clipboard.read()
        const blobs: Blob[] = []
        for (const item of items) {
          for (const type of item.types) {
            if (!type.startsWith('image/')) continue
            blobs.push(await item.getType(type))
          }
        }
        if (blobs.length === 0) { props.onNotice('剪贴板里没有可读取的图片'); return }
        const made = await Promise.all(blobs.map(async (blob, i) => {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => { resolve(String(reader.result ?? '')) }
            reader.onerror = () => { reject(new Error('读剪贴板图片失败')) }
            reader.readAsDataURL(blob)
          })
          const { base64, mime } = splitDataUrl(dataUrl, blob.type === '' ? 'image/png' : blob.type)
          return { id: 'c' + String(Date.now()) + '-' + String(refSeq()) + '-' + String(i + 1), base64, mime, name: '剪贴板图片' + String(i + 1) }
        }))
        props.onChange({ refs: appendRefs(values.refs, made) })
        props.onNotice('已读取 ' + String(made.length) + ' 张参考图')
      } catch {
        props.onNotice('读不到剪贴板：浏览器没给权限，或当前环境不支持')
      }
    })()
  }

  /* ── 紧凑条上那一行字（「模型 · 尺寸」）──
   *
   * 模型取**它的显示名**不是 id（`modelLabel`），与下拉里看到的一致；
   * 没选就明确写「未选模型」，不显示空串（空串看起来像界面坏了）。 */
  const modelLabel = ((): string => {
    if (values.model === '') return '未选模型'
    for (const g of props.groups) {
      const hit = g.models.find(m => m.modelId === values.model)
      if (hit !== undefined) return hit.modelLabel
    }
    return values.model
  })()
  const sizeLabel = ASPECT_OPTIONS.find(o => o.value === values.size)?.label ?? values.size

  return (
    <div
      data-ewb-gen-submit={kind}
      className="mb-3 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-card border border-[var(--dsw-alias-border-l2)] px-3 py-2.5"
    >
      <div className="flex flex-none items-center gap-2">
        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">新建生成</span>
        <span className="flex-1" />
        {noModels
          ? (
            <span data-ewb-gen-nomodels="" className="font-mono text-ewb-caption text-[#ff8a8a]">
              {props.modelsError === '' ? '没有能做这件事的模型，先去「配置」里加渠道' : props.modelsError}
            </span>
          )
          : null}
      </div>

      <label className={label}>
        <span className="w-14 shrink-0">提示词</span>
        {/* ⚠️ `rows={7}` 照参考 `:419` 的 `<Input.TextArea rows={7}>`（票 33 补做）。
         * 原来只有 `min-h-[44px]` —— 那是「一行半」的高度，写长提示词时
         * 只有一条细缝，与参考那种「一大块可写区域」差得远。
         * `resize-y` 留着：行数是默认高度，不是上限。 */}
        <textarea
          data-ewb-gen-submit-prompt=""
          className={field + ' min-h-[44px] resize-y'}
          rows={7}
          value={values.prompt}
          placeholder="写清楚要生成什么"
          onChange={e => { props.onChange({ prompt: e.target.value }) }}
        />
      </label>

      {/* ══ 参考图（票 41，照参考 `pages/image/index.tsx:421-478`）══
       *
       * ## 参考的形状
       *
       * ```
       * 标题行：左「参考图」            右 [剪贴板] [上传]
       * 虚线框：横向滚动，每张 size-20 缩略图
       *         ├ 左上角编号「图片1」
       *         ├ 底部左右两颗圆形箭头（前后移）
       *         └ 右上角删除（悬停才出现）
       * 空态：框里一句「暂无参考图，可将图片拖到这里」
       * ```
       *
       * ## 与改造前差在哪
       *
       * 改造前是一个 `<input type="file">` 裸控件 + 一行文件名，**只有一张**、
       * 没有缩略图、不能删、不能调序、不能拖进来。判据 1-4 全部落在这块。
       *
       * ## 为什么 `onWheel` 把竖直滚动转成横向
       *
       * 那是参考 `:461-464` 的原做法。横向滚动的容器在鼠标上很难滚（没有横向滚轮），
       * 不转的话用户只能去拖滚动条。只在**真的溢出时**才拦（`scrollWidth > clientWidth`），
       * 否则会把整页的滚动吞掉。 */}
      {formFields(kind).includes('ref')
        ? (
          <div data-ewb-gen-refs-wrap="" className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-none items-center justify-between gap-2">
              <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                {kind === 'video' ? '首帧' : '参考图'}
              </span>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  data-ewb-gen-ref-clipboard=""
                  disabled={!clipboardOk}
                  className={[
                    'pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption',
                    clipboardOk ? 'text-[var(--dsw-alias-label-secondary)]' : 'cursor-not-allowed opacity-45 text-[var(--dsw-alias-label-tertiary)]',
                  ].join(' ')}
                  title={clipboardOk ? '从剪贴板读取图片，追加到参考图' : '当前环境不支持读取剪贴板（需要浏览器允许读取剪贴板）'}
                  onClick={addFromClipboard}
                >剪贴板</button>
                <button
                  type="button"
                  data-ewb-gen-ref-upload=""
                  className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                  title="选择图片，可一次多选"
                  onClick={() => { fileRef.current?.click() }}
                >上传</button>
              </div>
            </div>

            {/* 真正的文件框藏起来：`display:none` 的元素点不到，只能由上面的按钮转去点它。
             * `multiple` 是判据 1 的前提（一次多张）。 */}
            <input
              ref={fileRef}
              data-ewb-gen-submit-ref=""
              className="hidden"
              type="file"
              accept="image/*"
              multiple
              onChange={e => {
                addFiles(e.target.files)
                /* ⚠️ 清空 `value`：不清的话选同一个文件第二次不触发 `change`
                 * （浏览器认为值没变）。表现是「再选一次同一张，没反应」。 */
                e.target.value = ''
              }}
            />

            <div
              data-ewb-gen-ref-box=""
              data-ewb-gen-ref-drag={dragActive ? '' : undefined}
              className={[
                'flex min-h-[64px] w-full min-w-0 gap-2 overflow-x-auto overflow-y-hidden rounded-card border border-dashed p-2',
                dragActive
                  ? 'border-[var(--dsw-alias-brand-primary)]'
                  : 'border-[var(--dsw-alias-border-l2)]',
              ].join(' ')}
              onDragEnter={e => {
                e.preventDefault()
                dragDepth.current += 1
                if (e.dataTransfer.types.includes('Files')) setDragActive(true)
              }}
              onDragOver={e => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDragLeave={e => {
                e.preventDefault()
                /* 用深度计数而不是直接置 false：`dragenter/leave` 会在子元素上反复触发，
                 * 直接置 false 会让虚线框**一直闪**（鼠标每过一个缩略图就闪一下）。 */
                dragDepth.current = Math.max(0, dragDepth.current - 1)
                if (dragDepth.current === 0) setDragActive(false)
              }}
              onDrop={e => {
                e.preventDefault()
                dragDepth.current = 0
                setDragActive(false)
                addFiles(e.dataTransfer.files)
              }}
              onWheel={e => {
                const el = e.currentTarget
                if (el.scrollWidth <= el.clientWidth) return
                e.preventDefault()
                el.scrollLeft += e.deltaY
              }}
            >
              {values.refs.length === 0
                ? (
                  <span className="flex min-w-full items-center justify-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                    {dragActive ? '松开即可添加参考图' : '暂无参考图，可将图片拖到这里'}
                  </span>
                )
                : values.refs.map((r, i) => (
                  <div
                    key={r.id}
                    data-ewb-gen-ref-item={r.id}
                    data-ewb-gen-ref-index={String(i)}
                    className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-ctl border border-[var(--dsw-alias-border-l2)]"
                  >
                    <img
                      data-ewb-gen-ref-thumb={r.id}
                      src={'data:' + (r.mime === '' ? 'image/png' : r.mime) + ';base64,' + r.base64}
                      alt={r.name}
                      className="h-full w-full object-cover"
                    />
                    {/* 编号（照参考 `:465` 的「图片N」，从 1 起）。 */}
                    <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 font-mono text-ewb-caption text-white">
                      {refLabel(i)}
                    </span>
                    {/* 删除：**悬停 / 键盘聚焦才出现**（照参考 `hidden … group-hover:flex`）。
                     * ⚠️ 不用 `display:none` 藏 —— jsdom 里 `display` 不参与可见性判断，
                     * 断言「点了能删」需要一个**始终在 DOM 里**的按钮。所以用 `opacity`。 */}
                    <button
                      type="button"
                      data-ewb-gen-ref-del={r.id}
                      className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/60 font-mono text-ewb-caption leading-none text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
                      title="移除这张参考图"
                      onClick={() => { props.onChange({ refs: removeRef(values.refs, r.id) }) }}
                    >×</button>
                    {/* 前后移（照参考 `ReferenceOrderButtons`，`:855-863`）。
                     * 只在两张以上时出现 —— 一张时调序没有意义。 */}
                    {values.refs.length > 1
                      ? (
                        <div className="absolute inset-x-0.5 bottom-0.5 flex justify-between">
                          <button
                            type="button"
                            data-ewb-gen-ref-left={r.id}
                            disabled={i <= 0}
                            className="pressable is-dark flex h-4 w-4 items-center justify-center rounded-full bg-black/60 font-mono text-ewb-caption leading-none text-white disabled:opacity-30"
                            title="往前移一位"
                            onClick={() => { props.onChange({ refs: moveRef(values.refs, i, -1) }) }}
                          >‹</button>
                          <button
                            type="button"
                            data-ewb-gen-ref-right={r.id}
                            disabled={i >= values.refs.length - 1}
                            className="pressable is-dark flex h-4 w-4 items-center justify-center rounded-full bg-black/60 font-mono text-ewb-caption leading-none text-white disabled:opacity-30"
                            title="往后移一位"
                            onClick={() => { props.onChange({ refs: moveRef(values.refs, i, 1) }) }}
                          >›</button>
                        </div>
                      )
                      : null}
                  </div>
                ))}
            </div>
          </div>
        )
        : null}

      {/* ── 紧凑参数条（`sm` 以下才有，照参考 `:481-486`）──
       *
       * ```
       * ┌────────────────────────────────┐
       * │ 模型名 · 1024x1024      [调整] │
       * └────────────────────────────────┘
       * ```
       *
       * 它和下面那个参数块是**互斥**的：`sm:hidden` 对 `hidden sm:grid`。
       * 上面几行（提示词、参考图）在两种宽度下都在 —— 只有参数块被收起。 */}
      <div
        data-ewb-gen-compact=""
        className="flex flex-none items-center justify-between gap-2 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1.5 sm:hidden"
      >
        <span data-ewb-gen-compact-text="" className="min-w-0 truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
          {modelLabel + ' · ' + sizeLabel}
        </span>
        <button
          type="button"
          data-ewb-gen-open-settings=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={props.onOpenSettings}
        >调整</button>
      </div>

      {/* ── 参数块（`sm` 以上才显示，照参考 `:490-492` 的 `hidden gap-4 sm:grid sm:grid-cols-2`）── */}
      <div data-ewb-gen-settings="" className="hidden gap-3 sm:grid sm:grid-cols-2">
        <GenSettings
          kind={kind}
          values={values}
          onChange={props.onChange}
          groups={props.groups}
          modelsError={props.modelsError}
          hook="data-ewb-gen-submit"
        />
      </div>

      {/* ── 生成按钮沉底（照参考 `:495-499` 的 `mt-auto pt-6`）──
       *
       * ## 为什么从标题行搬到这里
       *
       * 原来按钮挂在「新建生成」那一行的右边，位置取决于上面有几行参数 ——
       * 参数一多按钮就跟着往上飘，与参数块挤在一起，不像「这一步做完就按它」。
       * 参考把提交按钮交给 `mt-auto` 顶到卡片底部：不管上面几行，它永远在最下面。
       *
       * ⚠️ `mt-auto` 只在父级是 flex 且**有富余高度**时才推到底 ——
       * 所以父级这一块加了 `min-h-0 flex-1`（表单栏高度不够时它仍紧贴上一行，
       * 不会悬在半空）。这是纯布局，没动提交逻辑。 */}
      <div className="mt-auto flex flex-none items-center gap-2 pt-3">
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-gen-submit-btn=""
          disabled={props.submitting || noModels}
          className={[
            'pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-4 py-1.5 font-mono text-ewb-caption',
            props.submitting || noModels
              ? 'opacity-45 cursor-not-allowed text-[var(--dsw-alias-label-tertiary)]'
              : 'text-[var(--dsw-alias-label-primary)]',
          ].join(' ')}
          onClick={props.onSubmit}
        >{props.submitting ? '提交中…' : '生成'}</button>
      </div>
    </div>
  )
}

/* ── 生图工作台本体 ─────────────────────────────────────────────────── */

/** 读模型清单的结果。 */
export interface ModelsState {
  groups: ChannelGroup[]
  error: string
}

/**
 * 读一次模型清单（按 kind 过滤）。
 * @param kind - 生成什么。
 * @returns 分组后的清单。
 */
export async function loadModels(kind: GenKind): Promise<ModelsState> {
  /* ⚠️ 路径是 `/gen-models`，不是 `/models` —— 后者被 dsh 的模型目录占了。 */
  const r = await call<{ models?: ModelOption[] }>('/gen-models?kind=' + kind)
  if (!r.ok) return { groups: [], error: r.error ?? '读不到模型清单' }
  const list = Array.isArray(r.body?.models) ? r.body.models : []
  return { groups: groupModelsByChannel(list), error: '' }
}

/** 生图工作台的入参。 */
export interface ImageWorkbenchProps {
  /** 这一格是不是正显示着。 */
  active: boolean
  /**
   * 要哪一类生成。默认 `image`。
   *
   * 视频创作台与音频工作台**除参数项之外全一样**，所以它们传一个别的 `kind`
   * 进来复用本组件（见 `VideoWorkbench.tsx` / `AudioWorkbench.tsx`）。
   */
  kind?: GenKind
  /** 标题（三格各一个）。 */
  title?: string
}

/**
 * 一条记录的窄条目（左栏与窄屏抽屉**共用同一份**）。
 *
 * ## 为什么抽出来（照参考的做法）
 *
 * 参考 `pages/image/index.tsx:376` 的左栏与 `:541` 的 `Drawer` **都渲染同一个
 * `LogPanel`** —— 两处各写一份，改一处忘一处是必然（本项目
 * `pitfalls/同一件事写两份迟早漂.md` 记的就是这个）。
 *
 * ## 为什么钩子只挂 `data-ewb-gen-log`
 *
 * 结果卡的 `data-ewb-gen-status` / `-prompt` 那几套钩子归**右栏结果墙**。
 * 这里也挂一份会让 `querySelector` 取到这一份，断言就变成「验的是索引而不是结果卡」。
 *
 * @param props - 见参数说明。
 * @returns 条目列表。
 */
/**
 * 五个小标签里的一个（票 44）。
 *
 * ## 为什么不引 antd 的 `Tag`
 *
 * 参考用的是 `Tag color="blue|red|green"`（`pages/image/index.tsx:751-772`）。
 * 我们**只按需解构了 `Drawer` 与 `Modal`**（`ImageWorkbench.tsx:50`），
 * 为三个字引一个组件不值当。更关键的是：引人家的预设色名，等于把「成功是蓝」这种
 * 反直觉的配色一起搬进来 —— lead 2026-10-28 裁的是「**语义守住**：成功绿系、失败红系」。
 *
 * ## 配色用 dsh 语义色
 *
 * `ok` → `--dsw-alias-state-success-primary`（绿系）
 * `err` → `--dsw-alias-state-error-primary`（红系）
 * `plain` → 不设色，跟当前文字（标签的默认档）
 *
 * @param props - 见下。
 * @returns 胶囊。
 */
function MiniTag(props: { tone: 'ok' | 'err' | 'plain', hook: string, value: string, children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      {...{ [props.hook]: props.value }}
      className={[
        'inline-flex h-4 shrink-0 items-center rounded-[4px] border px-1 font-mono text-ewb-caption leading-none',
        props.tone === 'ok'
          ? 'border-[color-mix(in_srgb,var(--dsw-alias-state-success-primary)_45%,transparent)] text-[var(--dsw-alias-state-success-primary)]'
          : props.tone === 'err'
            ? 'border-[color-mix(in_srgb,var(--dsw-alias-state-error-primary)_45%,transparent)] text-[var(--dsw-alias-state-error-primary)]'
            : 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-tertiary)]',
      ].join(' ')}
    >
      {props.children}
    </span>
  )
}

/**
 * 记录栏里的一条（左栏与窄屏抽屉**共用同一份**）。
 *
 * ## 票 44 的三处改动（都照参考 `LogCard`，`:729-779`）
 *
 * | 改了什么 | 参考 | 为什么 |
 * |---|---|---|
 * | 左上角加勾选框 | `:741` | 批量删除要知道勾了哪几条 |
 * | 右侧五个小标签 | `:751-772` | 一眼看出成了几张、废了几张 |
 * | 卡主体点击改为**回填表单** | `:733` + `:719` | 用户的既有习惯；参考就是这么做的 |
 *
 * ## 「展开明细」去哪儿了
 *
 * 原来点整张卡是展开明细。现在整卡给了「回填」，明细改成**右上角一颗小按钮**
 * （`data-ewb-gen-log-detail`）—— 逐条明细是这轮之前唯一能看详情的地方，不能丢。
 *
 * 两条互不干扰：勾选框与明细按钮都 `stopPropagation`，点它们不触发回填。
 *
 * @param props - 见 `GenLogEntries`。
 * @returns 一条记录。
 */
function LogCard(props: {
  row: WorkRow
  open: boolean
  selected: boolean
  onToggleDetail: (id: string) => void
  onSelectedChange: (id: string, next: boolean) => void
  onPick: (row: WorkRow) => void
}): React.JSX.Element {
  const { row } = props
  const { ok, fail } = countsOf(row)
  const total = totalOf(row)
  return (
    <div
      data-ewb-gen-log={row.id}
      data-ewb-gen-log-live={row.live ? '' : undefined}
      className="relative shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1.5"
    >
      {/* 整卡可点 → 回填表单（照参考 `LogCard` 的 `<button onClick>`）。
       *
       * ⚠️ 用一个**绝对定位铺满**的透明按钮做点击层，而不是把整块包进 `<button>`：
       * 里面还有勾选框、明细按钮、以及将来可能加的东西 ——
       * 嵌套 `<button>` 在 HTML 里是非法的，浏览器会自作主张拆开。
       * 这一层的 `aria-label` 给读屏用，说明点它会做什么。 */}
      <button
        type="button"
        data-ewb-gen-log-pick={row.id}
        className="absolute inset-0 z-0 cursor-pointer rounded-ctl border-0 bg-transparent"
        aria-label="把这条记录的参数填回表单"
        title="把这条记录的参数填回表单"
        onClick={() => { props.onPick(row) }}
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-1.5">
        <input
          type="checkbox"
          data-ewb-gen-log-check={row.id}
          className="pointer-events-auto mt-0.5 h-3 w-3 shrink-0 cursor-pointer accent-[var(--dsw-alias-brand-primary)]"
          checked={props.selected}
          aria-label="选中这条记录"
          onClick={e => { e.stopPropagation() }}
          onChange={e => { props.onSelectedChange(row.id, e.target.checked) }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-primary)]">
            {row.prompt === '' ? '（没有提示词）' : row.prompt}
          </div>
          {/* 五个标签（照参考 `:751-772` 的三行）。
           *
           * ⚠️ **「失败 N」只在算得出时渲染**（lead 2026-10-28 裁的落差 C）。
           * 算不出时那一个标签**整个不出现** —— 不是显示「失败 —」。
           * 一个写着「失败 —」的标签会被读成「没有失败」，而真相是「不知道」。 */}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <MiniTag tone="ok" hook="data-ewb-gen-tag-ok" value={String(ok)}>成功 {ok}</MiniTag>
            {fail === null
              ? null
              : <MiniTag tone="err" hook="data-ewb-gen-tag-fail" value={String(fail)}>失败 {fail}</MiniTag>}
            {total === null
              ? null
              : <MiniTag tone="plain" hook="data-ewb-gen-tag-total" value={String(total)}>共 {total} 张</MiniTag>}
            {/* 用时与时间：参考用的是 `formatDuration` / `log.time`，
             * 我们用自己那两个（`elapsedText` / `when`）—— lead 裁过「不为对齐格式改已在用的函数」。 */}
            {row.endedAt === undefined
              ? null
              : <MiniTag tone="ok" hook="data-ewb-gen-tag-elapsed" value={elapsedText(row.raw as GenLog)}>{elapsedText(row.raw as GenLog)}</MiniTag>}
            <MiniTag tone="plain" hook="data-ewb-gen-tag-time" value={when(row.createdAt)}>{when(row.createdAt)}</MiniTag>
          </div>
        </div>
        {/* 展开明细：右上角一颗小按钮（原来整卡点击就是它，现在让位给回填）。 */}
        <button
          type="button"
          data-ewb-gen-log-detail={row.id}
          className="pointer-events-auto shrink-0 cursor-pointer rounded-[4px] border border-[var(--dsw-alias-border-l2)] px-1 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)]"
          title={props.open ? '收起这条的明细' : '展开这条的明细'}
          onClick={e => { e.stopPropagation(); props.onToggleDetail(row.id) }}
        >{props.open ? '收起' : '明细'}</button>
      </div>
      {props.open
        ? (
          <div data-ewb-gen-log-open={row.id} className="pointer-events-none relative z-10 mt-1.5 flex flex-col gap-1 border-t border-[var(--dsw-alias-border-l2)] pt-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            <span>{STATUS_TEXT[row.status]} · 模型 {row.model === '' ? '—' : row.model}</span>
            {row.paramsText === '' ? null : <span>{row.paramsText}</span>}
            <span>参数原文 {JSON.stringify((row.raw as GenLog).params ?? {})}</span>
            {(row.raw as GenLog).negativePrompt === undefined
              ? null
              : <span>反向提示词 {(row.raw as GenLog).negativePrompt}</span>}
          </div>
        )
        : null}
    </div>
  )
}

function GenLogEntries(props: {
  rows: readonly WorkRow[]
  openId: string
  onToggle: (id: string) => void
  /** 勾了哪几条（**并集**，不区分来源 —— 左栏与抽屉共用同一份）。 */
  selected: readonly string[]
  onSelectedChange: (id: string, next: boolean) => void
  /** 点卡片主体：把参数回填进表单。 */
  onPick: (row: WorkRow) => void
}): React.JSX.Element {
  if (props.rows.length === 0) {
    return <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">还没有记录</span>
  }
  return (
    <>
      {props.rows.map(row => (
        <LogCard
          key={row.id}
          row={row}
          open={props.openId === row.id}
          selected={props.selected.includes(row.id)}
          onToggleDetail={props.onToggle}
          onSelectedChange={props.onSelectedChange}
          onPick={props.onPick}
        />
      ))}
    </>
  )
}

/**
 * 生图 / 视频 / 音频工作台（同一份实现，按 `kind` 变）。
 *
 * @param props - 见 `ImageWorkbenchProps`。
 * @returns 界面。
 */
export function ImageWorkbench({ active, kind = 'image', title }: ImageWorkbenchProps): React.JSX.Element {
  const [logs, setLogs] = useState<GenLog[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  /** 展开明细的那一条（空串 = 都收起）。 */
  const [openId, setOpenId] = useState('')
  /** 正在看大图的那个产物 id（空串 = 没开）。点结果墙里的产物打开。 */
  const [preview, setPreview] = useState('')
  /** 「重跑」填回表单的那条记录（null = 表单是空的）。 */
  const [rerun, setRerun] = useState<GenLog | null>(null)
  /** 提交区草稿。**按 kind 取空草稿**（音频的时长默认空，见 `emptyDraftOf`）。 */
  const [draft, setDraft] = useState<GenDraft>(() => emptyDraftOf(kind))
  /** 模型清单。 */
  const [models, setModels] = useState<ModelsState>({ groups: [], error: '' })
  /** 计时用的「现在」（每秒刷新）。 */
  const [now, setNow] = useState(() => Date.now())
  /** 提示词选择面板是否展开（照参考的「查看提示词」按钮）。 */
  const [promptPick, setPromptPick] = useState(false)
  /** 窄屏记录抽屉是否打开（照参考 `:541` 那个 `Drawer`）。 */
  const [logsOpen, setLogsOpen] = useState(false)
  /** 窄屏设置抽屉是否打开（照参考 `:552-556` 那个 `Drawer`，装模型 + 尺寸 + 张数）。 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * 勾了哪几条记录（票 44）。**左栏与窄屏抽屉共用同一份** ——
   * 两处各存一份的话，抽屉里勾的、左栏里没勾，删的时候就少删了。
   */
  const [picked, setPicked] = useState<string[]>([])
  /** 删除确认框是否打开（照参考 `:559-561`，**删之前一定要问**）。 */
  const [delAsk, setDelAsk] = useState(false)
  /** 「查看素材」面板是否打开（票 44 的第五项）。 */
  const [assetPick, setAssetPick] = useState(false)
  /** 正在做的一件耗时动作（「读取产物…」这种）。空串 = 空闲。 */
  const [busy, setBusy] = useState('')
  /** 一次性的成功提示（存进素材之后那句）。 */
  const [notice2, setNotice2] = useState('')
  /* 内置提示词副本（常量，不需要每次 render 重算）。 */
  const builtinEntries = allBuiltinEntries()

  const gen = useGenerate(kind, active)

  /** 重读历史记录。 */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await call<{ logs?: GenLog[] }>('/gen-logs?kind=' + kind + '&limit=100')
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '读不到生成记录'); return }
    setErr('')
    const list = Array.isArray(r.body?.logs) ? r.body.logs : []
    /* 宿主已经按 createdAt 倒序给过了，这里**再排一次**：
     * 万一以后宿主漏了排序，界面不该跟着错（排序是显示的事）。 */
    setLogs([...list].sort((a, b) => b.createdAt - a.createdAt))
  }, [kind])

  useEffect(() => {
    if (!active) return
    void load()
    void loadModels(kind).then(setModels)
  }, [active, kind, load])

  /* ★ 打开工作台时按偏好预填「一次生成几张」（票 05）。
   *
   * ## 只在这一格里预填，不改生成逻辑
   *
   * 票 05 的三条判定：`count` 链路后端是支持的（`src/index.ts:1848` 一路到
   * ComfyUI 的 `batch_size`），参考项目那 `canvasImageCount` 也只是**预填**
   * （`canvas-config-node-panel.tsx:225`）。所以这里只把数填进草稿，
   * 提交时走的还是同一个 `count` 字段 —— 请求体形状一个字没变。
   *
   * ## 为什么放在 `active` 变真时读，而不是 `useState` 初值
   *
   * 初值在组件挂载时求值，而工作台是常驻的（`active` 只是显不显示）——
   * 放初值就等于「这次打开页面时的那份偏好」终生有效，
   * 用户去配置页改完回来还是旧值。放 effect 里才是「每次打开都读一遍」。
   *
   * ⚠️ **只在草稿还是空的时候预填**（`count` 仍是默认值）：
   * 用户在表单里手填了数、切走一格再切回来，不该把他填的盖掉。 */
  useEffect(() => {
    if (!active) return
    if (!formFields(kind).includes('count')) return
    const p = readWorkbenchPrefs()
    setDraft((cur) => (cur.count === EMPTY_DRAFT.count ? { ...cur, count: String(p.count) } : cur))
  }, [active, kind])

  const rows = mergeRows(logs, gen.tasks)
  /* 时钟要不要每秒走：判据是「有没有还没结束的行」，不是「有没有在跑的任务」。
   * 从 gen-logs 读出来的 `pending` 记录也没有 endedAt —— 它们同样每秒都要变。 */
  const hasLive = rows.some(r => r.endedAt === undefined)

  /**
   * 每秒把「现在」往前推一下。
   *
   * ⚠️ **只在有在跑的记录时才走**：一条跑完的记录不需要每秒重渲染。
   */
  useEffect(() => {
    if (!active || !hasLive) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [active, hasLive])

  /** 提交。 */
  const doSubmit = useCallback(async (d: GenDraft): Promise<void> => {
    const r = await gen.submit(d)
    /* ★ 「提交成功就清空表单」—— 不清的话用户会以为没提交、再点一次，
     * 于是同一条生成提交两遍。验收 3 的判据也落在这里。
     *
     * ⚠️ 用 `emptyDraftOf(kind)` 不是 `EMPTY_DRAFT`：音频提交完清空时，
     * 时长要回到**空**（用模型默认），不能塞一个 5（票 29）。 */
    if (r.ok) setDraft(emptyDraftOf(kind))
  }, [gen, kind])

  /** 重试：用那一行的参数再提交一次。 */
  const doRetry = useCallback((row: WorkRow): void => {
    const d = draftFromRow(kind, row)
    void gen.submit(d)
  }, [gen, kind])

  /** 「重跑」：把这条的参数填回表单区**并且真的填进表单草稿**（票 09）。
   *
   * ## 为什么两件事都要做（改前只做了前一件）
   *
   * 改前这里只 `setRerun(...)`：把上次的参数**摆出来看**，但提交区的草稿
   * （`draft`）一个字没动。于是「重跑」之后点「生成」，发出去的还是草稿里
   * 原来那些值 —— 种子上就表现为「重跑拿不回上一次的种子」。
   *
   * `rerun` 那块仍然留着（它明写「这里只是把上次的参数摆出来看」，
   * 是给用户核对用的），只是现在**同时**把草稿补齐，两条路一致。
   *
   * ⚠️ 用 `draftFromRow(kind, row)` 补齐，不在这里自己拼参数串 ——
   * 那个函数已经是「记录 → 草稿」的唯一出口（票 41 的参考图规则也在那里）。
   */
  const doRerun = (log: GenLog): void => {
    setRerun({ ...log, params: { ...log.params } })
    /* 记录 → 一等行再喂 `draftFromRow`（它读的是 `WorkRow` 形状）。
     * 这里只补齐 `draftFromRow` 真会读的字段，`paramsText` 给个空串 ——
     * 那是渲染用的，与「记录 → 草稿」无关。 */
    setDraft(draftFromRow(kind, {
      id: log.id, kind: log.kind, createdAt: log.createdAt, status: log.status,
      prompt: log.prompt, model: log.model, channelId: log.channelId,
      paramsText: '', artifacts: log.artifacts, live: false, raw: log,
    }))
  }

  /* ══ 票 44：三个批量动作（照参考 `createSession` / `toggleAll` / `deleteSelectedLogs`）══ */

  /**
   * 「新建」：清空**本轮**的输入与结果，开一轮新的（参考 `:274-283`）。
   *
   * ## 它不清记录
   *
   * 参考的 `createSession` 也不清 —— 记录是历史，清它得走「删除」。
   * 这里清的是：草稿（提示词/模型/参考图）、重跑回填块、勾选、明细展开、大图预览。
   */
  const doNewSession = useCallback((): void => {
    setDraft(emptyDraftOf(kind))
    setRerun(null)
    setOpenId('')
    setPreview('')
    setPicked([])
    setErr('')
  }, [kind])

  /**
   * 「全选 / 取消」：全选或全不选（参考 `:690-691`）。
   *
   * ⚠️ 判据是**长度相等**（照参考原文），但要先过滤掉已经不存在的 id ——
   * 否则「删了几条之后，剩下的都勾了，按钮还显示『全选』」。
   * 参考那边靠「删完立刻清空勾选」绕开这个，我们两边都做。
   */
  const allPicked = rows.length > 0 && rows.every(r => picked.includes(r.id))
  const toggleAll = useCallback((): void => {
    setPicked(allPicked ? [] : rows.map(r => r.id))
  }, [allPicked, rows])

  /**
   * 真的删（确认框点了「删除」之后走这里）。
   *
   * ## 三步，缺一步就是「删了记录、图还在」或「图删了、记录还在」
   *
   * ① **先删记录本身**（`DELETE /gen-logs/:id`）—— 它才是列表里那一条
   * ② 再删这条记录里的**产物**（`DELETE /artifact/:id`）—— 参考那边
   *    `deleteStoredImages` 就是这么做的（`:285-286`），它删的是记录里那些图片的字节
   * ③ 重读列表
   *
   * ⚠️ 顺序不能反：先删产物的话，记录还在、图没了 —— 界面上会出现一条
   * 「成功 3 张」但点开一张都看不到的记录。反过来的中间态（记录没了、图还在）
   * 只是磁盘上多了几个孤儿文件，看得见的是对的。
   *
   * ⚠️ 产物删失败**不阻断**记录删除（用户要的是「这条消失」）；
   * 失败只报一句，不静默吞掉。
   */
  const doDeletePicked = useCallback(async (): Promise<void> => {
    const targets = rows.filter(r => picked.includes(r.id))
    if (targets.length === 0) { setDelAsk(false); return }
    setDelAsk(false)
    setErr('')
    const failedArt: string[] = []
    for (const row of targets) {
      /* ① 记录本身。失败就跳过这一条的产物 —— 记录没删掉时删它的图更糟。 */
      const r = await call<unknown>('/gen-logs/' + encodeURIComponent(row.id), { method: 'DELETE' })
      if (!r.ok) { setErr(r.error ?? '删除记录失败'); continue }
      /* ② 这条记录里的产物。 */
      for (const a of row.artifacts) {
        const ra = await call<unknown>('/artifact/' + encodeURIComponent(a.id), { method: 'DELETE' })
        if (!ra.ok) failedArt.push(a.id)
      }
    }
    setPicked([])
    if (failedArt.length > 0) setErr('记录已删除，但有 ' + String(failedArt.length) + ' 个产物没删掉')
    await load()
  }, [load, picked, rows])

  /* ══ 票 44 第五项：「查看素材」════════════════════════════════════════
   *
   * ## 参考是怎么做的
   *
   * 提示词标题行右边两个按钮（`pages/image/index.tsx:408-418`）：
   * 「查看提示词库」+「查看我的资产」。后者打开一个 860px 弹窗
   * （`asset-picker-modal.tsx:22-32`），里面是搜索框 + 类型筛选 + 四列网格。
   * 选完按载荷类型分三路（`:258-272`）：文本 → 填提示词；图片 → **追加**进参考图；
   * 其他 → 提示不支持。
   *
   * ## 我们改了什么、为什么（这一处**故意不照抄**）
   *
   * | 参考 | 这里 |
   * |---|---|
   * | 叫「资产」 | 叫「**素材**」—— 后端路由 `/materials`、画布侧栏都叫素材，照抄一个对不上的名字只会让人搜不到 |
   * | 860px Modal + 分页 | 就地展开的面板（与「查看提示词」同一个形态）—— 我们的素材量不是几百条，分页是多余的层级 |
   * | 读本地 IndexedDB | 读 `GET /materials`（宿主那条现成路由） |
   *
   * ## 「选图片要经一次网络」这条是 lead 批的
   *
   * 素材项给的是 `url`（`/material/:name`），`POST /materials` 另说；
   * 要把素材当参考图，只能先 `fetch` 那个 url 再转 base64。
   * 两条约束照批的做：读取期间有「读取中」状态、失败报清原因。 */

  /** 素材清单（打开面板时才拉）。 */
  const [mats, setMats] = useState<{ name: string, url: string, kind: string, title?: string, content?: string }[] | null>(null)
  /** 读素材清单失败的原因。 */
  const [matsErr, setMatsErr] = useState('')

  /** 拉一次素材清单（只在面板打开时调，不在后台白拉）。 */
  const loadMats = useCallback(async (): Promise<void> => {
    setMatsErr('')
    const r = await call<{ materials?: { name: string, url: string, kind: string, title?: string, content?: string }[] }>('/materials')
    if (!r.ok) { setMatsErr(r.error ?? '读不到素材'); setMats([]); return }
    const list = Array.isArray(r.body?.materials) ? r.body.materials : []
    setMats(list)
  }, [])

  useEffect(() => {
    if (!assetPick || mats !== null) return
    void loadMats()
  }, [assetPick, loadMats, mats])

  /**
   * 选了一条素材之后（照参考 `insertPickedAsset`：文本填空、图片进参考图、其余说不支持）。
   *
   * @param m - 素材项。
   */
  const insertMaterial = useCallback(async (m: { name: string, url: string, kind: string, title?: string, content?: string }): Promise<void> => {
    /* ── 文本：直接填提示词（这条现在就通，不经网络往返）── */
    if (m.kind === 'text') {
      setDraft(d => ({ ...d, prompt: m.content ?? '' }))
      setAssetPick(false)
      setErr('')
      return
    }
    /* ── 视频 / 音频：生图工作台用不上（照参考那句「只能使用文本或图片资产」）── */
    if (m.kind !== 'image') {
      setErr('只有文本与图片能做参考，' + m.name + ' 不行')
      return
    }
    /* ── 图片：读字节 → 追加进参考图 ──
     *
     * ⚠️ 三步都要有自己的失败说法：读不到（文件不在了）、不是图片、读超时。
     * 静默跳过会让用户点了没反应，还以为是自己点错了。 */
    setBusy('读取素材…')
    try {
      const res = await fetch(m.url)
      if (!res.ok) { setBusy(''); setErr('读不到素材（HTTP ' + String(res.status) + '）—— 文件可能已经被删掉了'); return }
      const mime = res.headers.get('content-type') ?? 'image/png'
      if (!mime.startsWith('image/')) { setBusy(''); setErr('这个素材不是图片（' + mime + '）'); return }
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
      const base64 = btoa(bin)
      setDraft(d => ({
        ...d,
        refs: appendRefs(d.refs, [{
          id: 'm' + String(Date.now()) + '-' + String(refSeq()) + '-' + m.name,
          base64,
          mime,
          name: m.title ?? m.name,
        }]),
      }))
      setBusy('')
      setAssetPick(false)
      setErr('')
      setNotice2('已加入参考图')
    } catch (e) {
      setBusy('')
      setErr('读素材失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }, [])

  /**
   * 把产物读成 base64（票 44 的「加入素材」与「加为参考图」都要它）。
   *
   * ## 为什么必须绕一次网络
   *
   * 产物在磁盘上（`artifacts/`），界面手上只有地址 `/artifact/:id`。
   * `POST /materials` 要的是 `{ name, base64 }` —— 所以先 `fetch` 产物再转 base64。
   * lead 2026-10-28 批的正是这条路（「那是唯一能拿到素材字节的路」）。
   *
   * ## 两条约束（同一次批复）
   *
   * · 读取期间**要有「读取中」状态** —— 由调用方置位，这里不自己管 UI
   * · 读失败**报清原因**（产物不在了 / 不是图片），不许静默跳过
   *
   * @param id - 产物 id。
   * @returns `{ base64, mime }`；失败给 `{ error }`。
   */
  const readArtifact = useCallback(async (id: string): Promise<{ base64: string, mime: string } | { error: string }> => {
    try {
      const res = await fetch(artifactUrl(id))
      if (!res.ok) return { error: '读不到产物（HTTP ' + String(res.status) + '）—— 可能已经被删掉了' }
      const mime = res.headers.get('content-type') ?? 'image/png'
      if (!mime.startsWith('image/')) return { error: '这个产物不是图片（' + mime + '），不能当参考图或素材' }
      const buf = await res.arrayBuffer()
      /* `btoa` 只吃 latin1；二进制要先转成字节串再编码。分段是为了
       * 避免 `String.fromCharCode(...bigArray)` 撑爆调用栈（一张 4K 图几 MB）。 */
      const bytes = new Uint8Array(buf)
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CH))
      }
      return { base64: btoa(bin), mime }
    } catch (e) {
      return { error: '读产物失败：' + (e instanceof Error ? e.message : String(e)) }
    }
  }, [])

  /** 「加为参考图」：把这张结果丢进参考图列表，接着改（照参考 `:242-246`）。 */
  const addResultAsRef = useCallback(async (artId: string): Promise<void> => {
    setBusy('读取产物…')
    const got = await readArtifact(artId)
    setBusy('')
    if ('error' in got) { setErr(got.error); return }
    /* ⚠️ **追加**不是替换（票 41 定的形状）：参考那边也是 `[...v, {...}]`。 */
    setDraft(d => ({
      ...d,
      refs: appendRefs(d.refs, [{
        id: 'r' + String(Date.now()) + '-' + String(refSeq()) + '-' + artId,
        base64: got.base64,
        mime: got.mime,
        name: '结果-' + artId.slice(-6),
      }]),
    }))
    setErr('')
  }, [readArtifact])

  /** 「加入素材」：存进素材库（照参考 `:248-256` 的 `saveResultToAssets`）。 */
  const saveResultAsMaterial = useCallback(async (artId: string): Promise<void> => {
    setBusy('读取产物…')
    const got = await readArtifact(artId)
    if ('error' in got) { setBusy(''); setErr(got.error); return }
    setBusy('写入素材…')
    const r = await call<{ material?: { name?: string } }>('/materials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '生成结果-' + artId.slice(-6) + '.png', base64: got.base64 }),
    })
    setBusy('')
    if (!r.ok) { setErr(r.error ?? '存入素材失败'); return }
    setErr('')
    setNotice2('已加入素材')
  }, [readArtifact])

  /**
   * 「下载」：把产物存到本地。
   *
   * 纯前端能做的做法是造一个 `<a download>` 点一下 —— 不需要后端参与。
   * 地址指向宿主那条产物路由，浏览器会按 `Content-Disposition` 或文件名处理。
   *
   * @param artId - 产物 id。
   */
  const downloadArtifact = useCallback((artId: string): void => {
    const a = document.createElement('a')
    a.href = artifactUrl(artId)
    a.download = 'ewb-' + artId + '.png'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [])

  /**
   * 点记录卡主体：把它的参数**填回表单**（票 44，照参考 `:719` 的 `onPreviewLog`）。
   *
   * ## 与「重跑」那两颗按钮分工
   *
   * | 动作 | 做什么 | 发请求吗 |
   * |---|---|---|
   * | 点卡片主体（本函数） | 把参数填进**当前表单**，用户可以改了再提交 | 不发 |
   * | 「重跑」按钮 | 把参数摆进「已填回参数」那一块（只读展示） | 不发 |
   * | 「重试」按钮 | **直接再提交一次**同样的参数 | **发** |
   *
   * 三个动作在参考那边分得更细（它只有「点卡片回填」与「失败卡上的重试」）。
   * 我们保留这三种是因为后两种已经在用（`tests/workbenches.mjs` 钉着），
   * 不能为了照抄而删掉既有能力。
   *
   * @param row - 点的那一条。
   */
  const pickLog = useCallback((row: WorkRow): void => {
    setDraft(draftFromRow(kind, row))
    setErr('')
  }, [kind])

  const headTitle = title ?? (kind === 'image' ? '生图工作台' : kind === 'video' ? '视频创作台' : '音频工作台')
  const tag = kind === 'image' ? 'gen' : kind === 'video' ? 'video' : 'audio'
  const shownError = gen.error !== '' ? gen.error : err

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ewb-workbench={kind}>
      <div className="mb-2 flex flex-none items-center gap-3">
        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">{headTitle}</span>
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-gen-total="">
          共 {String(rows.length)} 条
        </span>
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-gen-live="">
          在跑 {String(rows.filter(r => r.live).length)}
        </span>
        <span className="flex-1" />
        {/* ── 窄屏两个入口（照参考 `:395-400` 的 `flex shrink-0 gap-2 lg:hidden`）──
         *
         * 参考在那儿放两个按钮：「记录」「设置」。**两个都要**（票 42 补齐）：
         * 窄屏既看不到左栏记录，也看不到中栏参数块 —— 少了任何一个，
         * 那个宽度的用户就没有对应的入口，功能等于不存在。
         *
         * ⚠️ `lg:hidden` 与左栏的 `hidden lg:flex` **恰好互补**；
         * 「设置」按钮与中栏参数块的 `hidden sm:grid` 是**另一对**互补：
         * 窄屏窄到 `sm` 以下时参数块整个不在，只能从这个按钮进。
         * 也就是说 `sm` ~ `lg` 之间两个参数入口同时在（这是参考的形状，
         * 不是重复：紧凑条只在 `sm` 以下出现，参数块在 `sm` 以上出现）。 */}
        <button
          type="button"
          data-ewb-gen-open-logs=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] lg:hidden"
          onClick={() => { setLogsOpen(true) }}
        >记录</button>
        <button
          type="button"
          data-ewb-gen-open-settings-top=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] lg:hidden"
          onClick={() => { setSettingsOpen(true) }}
        >设置</button>
        <button
          type="button"
          data-ewb-gen-refresh=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { void load() }}
        >刷新</button>
      {/* ★ 票 44：耗时动作要看得见（lead 批的「读取期间要有状态，不许静默卡住」）。
         *
         * 与下面那条错误不是一回事：`busy` 是「正在做」，`shownError` 是「做失败了」。
         * 两者同时为真时都显示 —— 一条说在做，一条说上一次为什么没成。 */}
        {busy === ''
          ? null
          : <span data-ewb-gen-busy="" className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">{busy}</span>}
        {notice2 === ''
          ? null
          : <span data-ewb-gen-notice2="" className="font-mono text-ewb-caption text-[var(--dsw-alias-state-success-primary)]">{notice2}</span>}
        </div>

      {/* ══ 三栏（票 33，2026-10-28 照参考整页重排）══
       *
       * ## 参考项目的形状（`refs-projects/infinite-canvas/web/src/pages/image/index.tsx:375`）
       *
       * ```
       * main  lg:grid-cols-[300px_minmax(0,1fr)]  xl:grid-cols-[320px_minmax(0,1fr)]
       * ├ aside  左栏：生成记录（LogPanel）
       * └ section  xl:grid-cols-[420px_minmax(0,1fr)]
       *    ├ 中栏 420：表单
       *    └ 右栏 1fr：结果墙
       * ```
       *
       * ## 与改之前的两栏差在哪（这是用户说「板式差别还是那么大」的根）
       *
       * 改之前是「表单 320 + 一大堆东西挤在 flex-1 里」：结果墙那一栏里既有
       * 一条条记录行（状态、提示词、模型、尺寸、耗时、按钮），又有产物大图。
       * 两种密度完全不同的东西塞在同一列，看着就像「一张表加上一些图」。
       *
       * 参考把两者**分开**：左边一窄栏是记录（一行一条，扫一眼看跑过什么），
       * 右边宽栏只放产物卡片。这正是「以生成结果为核心」的形状。
       *
       * ## 左栏在窄屏时隐藏 —— 窄屏靠抽屉（票 33 补做）
       *
       * `hidden … lg:block`：窄屏放不下三栏，参考也是在窄屏把记录改成底部抽屉
       * （`:541` 那个 `Drawer`）。我们照它补了：窄屏时工具条上多一个「记录」按钮
       * （`data-ewb-gen-open-logs`，`lg:hidden`），点开是底部抽屉，
       * 里面渲染的 `GenLogEntries` 与左栏**是同一个组件**。 */}
      <main
        data-ewb-wb-split=""
        className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]"
      >
        {/* ── 左栏：生成记录 ──
         *
         * ⚠️ 这一栏**不挂** `data-ewb-gen-status` / `-prompt` 之类的钩子：
         * 那几套钩子归右栏的结果卡片（`tests/workbenches.mjs` 按
         * `[data-ewb-gen-row]` 往下查）。左边也挂一份会让 `querySelector`
         * 取到左边这份，断言就变成「验的是索引而不是结果卡」。
         *
         * 左栏只挂 `data-ewb-gen-log`（这一条记录的 id）。 */}
        <aside
          data-ewb-wb-log-col=""
          className="hidden min-h-0 flex-col gap-2 overflow-y-auto rounded-card border border-[var(--dsw-alias-border-l2)] p-3 lg:flex"
        >
          {/* ── 记录栏标题行：条数（照参考 `:696-700` 的标题 + `Tag` 计数）── */}
          <div className="flex flex-none items-center gap-2">
            <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">生成记录</span>
            <span data-ewb-gen-log-total="" className="rounded-[4px] border border-[var(--dsw-alias-border-l2)] px-1 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)]">{rows.length}</span>
          </div>
          {/* ── 三颗批量按钮（票 44，照参考 `:702-711`）──
           *
           * ```
           * [+ 新建]  [☑ 全选/取消]  [🗑 删除]
           * ```
           *
           * 禁用条件逐字照参考：全选在**一条记录都没有**时禁用（`:705`），
           * 删除在**一个都没勾**时禁用（`:708`）。
           * 删除**不直接删**，先开确认框（`:559-561`）—— 那是参考的做法，
           * 也是这一条唯一的不可逆动作。 */}
          <div className="flex flex-none flex-wrap gap-1.5">
            <button
              type="button"
              data-ewb-gen-batch-new=""
              className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
              title="清空提示词、参考图与回填块，开一轮新的"
              onClick={doNewSession}
            >新建</button>
            <button
              type="button"
              data-ewb-gen-batch-all=""
              disabled={rows.length === 0}
              className={[
                'pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption',
                rows.length === 0 ? 'cursor-not-allowed opacity-45 text-[var(--dsw-alias-label-tertiary)]' : 'text-[var(--dsw-alias-label-secondary)]',
              ].join(' ')}
              title={allPicked ? '取消全选' : '选中全部记录'}
              onClick={toggleAll}
            >{allPicked ? '取消' : '全选'}</button>
            <button
              type="button"
              data-ewb-gen-batch-del=""
              disabled={picked.length === 0}
              className={[
                'pressable is-dark rounded-ctl border px-2 py-0.5 font-mono text-ewb-caption',
                picked.length === 0
                  ? 'cursor-not-allowed border-[var(--dsw-alias-border-l2)] opacity-45 text-[var(--dsw-alias-label-tertiary)]'
                  : 'border-[color-mix(in_srgb,var(--dsw-alias-state-error-primary)_45%,transparent)] text-[var(--dsw-alias-state-error-primary)]',
              ].join(' ')}
              title="删除勾选的记录（会先确认）"
              onClick={() => { setDelAsk(true) }}
            >删除</button>
          </div>
          <GenLogEntries
            rows={rows}
            openId={openId}
            onToggle={id => { setOpenId(openId === id ? '' : id) }}
            selected={picked}
            onSelectedChange={(id, next) => {
              setPicked(cur => (next ? [...cur.filter(x => x !== id), id] : cur.filter(x => x !== id)))
            }}
            onPick={pickLog}
          />
        </aside>

        {/* ── 中栏（420）+ 右栏（1fr），与参考 `:388` 同构 ── */}
        <section
          data-ewb-wb-body=""
          className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]"
        >
        {/* ── 中栏：表单（参考 `:389` 那一个 420px 的卡片） ── */}
        <div
          data-ewb-wb-form-col=""
          className="thin-scrollbar flex min-h-0 w-full flex-col gap-2 overflow-y-auto rounded-card border border-[var(--dsw-alias-border-l2)] p-3 lg:min-h-0"
        >
          {/* ── 提示词标题行（照参考 `:408-418`：左标题、右两个入口按钮）──
           *
           * ## 参考那两个按钮是干什么的
           *
           * `workbench.viewPrompts` 打开提示词选择弹窗；`workbench.viewAssets` 打开素材选择。
           * 两者都是**从别处拿一段文字填进提示词框**，不是新开一页。
           *
           * ## 我们这版的取法
           *
           * 提示词库那份数据在 `prompt-sources/index.ts`（内置副本，零请求）。
           * 这里直接弹出一个小面板列标题，点一条把 `prompt` 正文填进来 ——
           * 与 `PromptLibrary` 用的是**同一份数据**，不新造第二套。
           *
           * ⚠️ 素材那个按钮**没做**：素材面板的插入入口现在挂在画布侧栏上
           * （`CanvasSidePanel` 的 `onInsertMaterial`），工作台这一格拿不到它。
           * 硬塞一个自己实现的素材列表等于第二套素材读取逻辑 —— 那正是这一轮
           * 反复在删的东西。这一处如实记为「参考有、我们没做」。 */}
          <div className="flex flex-none items-center justify-between gap-3">
            <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">提示词</span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                data-ewb-gen-pick-prompt=""
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { setPromptPick(v => !v) }}
              >{promptPick ? '收起提示词' : '查看提示词'}</button>
              {/* 「查看素材」（票 44，照参考 `:415` 的第二颗）。
               *
               * ⚠️ 名字是「素材」不是「资产」—— lead 2026-10-28 裁的：
               * 后端路由 `/materials`、画布侧栏都叫素材，照抄一个对不上的名字
               * 只会让人在两个地方搜不到同一个东西。**这一处故意不照抄，交付里注明**。 */}
              <button
                type="button"
                data-ewb-gen-pick-asset=""
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { setAssetPick(v => !v) }}
              >{assetPick ? '收起素材' : '查看素材'}</button>
            </div>
          </div>
          {promptPick
            ? (
              <div data-ewb-gen-prompt-picker="" className="max-h-56 flex-none overflow-y-auto rounded-card border border-[var(--dsw-alias-border-l2)] p-2">
                {builtinEntries.slice(0, 60).map(e => (
                  <button
                    key={e.id}
                    type="button"
                    data-ewb-gen-prompt-entry={e.id}
                    className="block w-full cursor-pointer truncate rounded-ctl px-1.5 py-1 text-left font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                    title={e.title}
                    onClick={() => {
                      setDraft(d => ({ ...d, prompt: e.prompt }))
                      setPromptPick(false)
                    }}
                  >{e.title}</button>
                ))}
              </div>
            )
            : null}

          <SubmitForm
            kind={kind}
            values={draft}
            onChange={p => { setDraft(d => ({ ...d, ...p })) }}
            onSubmit={() => { void doSubmit(draft) }}
            submitting={gen.submitting}
            groups={models.groups}
            modelsError={models.error}
            onOpenSettings={() => { setSettingsOpen(true) }}
            /* 提示走 `setErr`，它渲染成右栏顶部那条 `data-ewb-gen-error`
             * （与「提交失败」同一条通道）—— 用户看得见，测试也读得到。 */
            onNotice={msg => { setErr(msg) }}
          />

      {/* ── 「查看素材」面板（票 44，照参考 `AssetPickerModal` 的网格）──
       *
       * 参考是个 860px 弹窗 + 搜索 + 类型筛选 + 四列网格 + 分页（每页 8）。
       * 我们做成**就地展开的面板**（与「查看提示词」同一个形态），理由：
       * 素材量不是几百条，分页是多余的层级；而弹窗会盖住画布与结果墙，
       * 用户挑素材时往往还要看着结果挑。
       *
       * 三件事必须都在（判据 8）：
       *   · 选文本 → 填提示词
       *   · 选图片 → **追加**进参考图列表
       *   · 选其他 → 明确说不支持（不静默） */}
      {assetPick
        ? (
          <div data-ewb-gen-asset-panel="" className="mb-3 flex flex-none flex-col gap-1.5 rounded-card border border-[var(--dsw-alias-border-l2)] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">素材</span>
              <span className="flex-1" />
              <button
                type="button"
                data-ewb-gen-asset-refresh=""
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { setMats(null); void loadMats() }}
              >刷新</button>
              <button
                type="button"
                data-ewb-gen-asset-close=""
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { setAssetPick(false) }}
              >收起</button>
            </div>
            {matsErr === ''
              ? null
              : <span data-ewb-gen-asset-error="" className="font-mono text-ewb-caption text-[#ff8a8a]">{matsErr}</span>}
            {mats === null
              ? <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</span>
              : mats.length === 0
                ? <span data-ewb-gen-asset-empty="" className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">素材库是空的，先去画布侧栏存几个</span>
                : (
                  <div className="grid max-h-[220px] gap-1.5 overflow-y-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
                    {mats.map(mt => (
                      <button
                        key={mt.name}
                        type="button"
                        data-ewb-gen-asset={mt.name}
                        data-ewb-gen-asset-kind={mt.kind}
                        className="flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-1.5 py-1 text-left"
                        title={mt.kind === 'text' ? (mt.content ?? '').slice(0, 120) : mt.name}
                        disabled={busy !== ''}
                        onClick={() => { void insertMaterial(mt) }}
                      >
                        <span className="truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-primary)]">
                          {mt.kind === 'text' ? (mt.title === undefined || mt.title === '' ? '（无标题）' : mt.title) : mt.name}
                        </span>
                        <span className="truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                          {mt.kind} · {mt.kind === 'text' ? (mt.content ?? '').slice(0, 30) : '点一下加入参考图'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
          </div>
        )
        : null}

      {/* ── 删除确认框（票 44，照参考 `:559-561`）──
       *
       * 参考：标题「删除生成记录」，正文「确定删除选中的 N 条生成记录吗？」，
       * 确认按钮是 danger 色。**这是本票唯一的不可逆动作**，必须问一次。 */}
      <Modal
        title="删除生成记录"
        open={delAsk}
        onCancel={() => { setDelAsk(false) }}
        onOk={() => { void doDeletePicked() }}
        okText="删除"
        cancelText="取消"
        /* ⚠️ 用 `data-*` 钩子找确认按钮，**不锚 `.ant-modal` 这类第三方类名**
         * （lead 2026-10-28 点出来的：锚第三方生成的类名与锚 dsh 的哈希类名
         * 是同一个病 —— 对方一升级就断，而且断得没声音）。
         *
         * 这里给 `okButtonProps` 塞一个钩子，测试就能
         * `querySelector('[data-ewb-gen-del-ok]')` 直接取到。
         * 顺带说明 `getContainer={false}` 之后它渲染在组件自己的容器里，
         * 不再挂到 `document.body` 上 —— 但它**仍在 `.ant-modal` 的子树里**，
         * 别指望「用 closest 往祖先找」能稳。 */
        okButtonProps={{ danger: true, 'data-ewb-gen-del-ok': '' }}
        getContainer={false}
      >
        <span data-ewb-gen-del-ask="">确定删除选中的 {picked.length} 条生成记录吗？它们的产物也会一起删掉。</span>
      </Modal>

      {/* 点「重跑」之后展开的那块（只读，把上次的参数摆好）。 */}
      {rerun === null
        ? null
        : (
          <div data-ewb-gen-form="" className="mb-3 flex flex-none flex-col gap-1.5 rounded-card border border-[var(--dsw-alias-border-l2)] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">已填回参数</span>
              <span className="flex-1" />
              <button
                type="button"
                data-ewb-gen-form-clear=""
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { setRerun(null) }}
              >清空</button>
            </div>
            {/* 五项各带一个 data 钩子：断言直接读值，不靠界面文字。 */}
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">提示词</span>
              <input
                readOnly
                data-ewb-gen-form-prompt=""
                value={rerun.prompt}
                className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">模型</span>
              <input
                readOnly
                data-ewb-gen-form-model=""
                value={rerun.model}
                className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">渠道</span>
              <input
                readOnly
                data-ewb-gen-form-channel=""
                value={rerun.channelId}
                className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">参数</span>
              <input
                readOnly
                data-ewb-gen-form-params=""
                value={JSON.stringify(rerun.params)}
                className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              />
            </label>
            <span className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
              这里只是把上次的参数摆出来看。要再跑一次，用中间那一栏提交区的「生成」按钮。
            </span>
          </div>
        )}
        </div>

        {/* ══ 右栏：结果墙（主视觉）══
         *
         * 这一栏是「整个界面的核心」——用户原话。所以它：
         *   · 吃满剩余宽度（min-w-0 flex-1）
         *   · 卡片式多列网格：**按可用宽度自适应列数**（见下面 gridTemplateColumns
         *     的 auto-fill / minmax），不写死断点列数 —— 我们右列的宽度随左侧栏
         *     与宿主窗口一起变，写死 2 列或 3 列总有一头不合适
         *   · 每条结果大图在前，文字在后
         *   · 失败项是一个带重试按钮的红框卡，不是灰一行 */}
        <div
          data-ewb-wb-result-col=""
          className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-card border border-[var(--dsw-alias-border-l2)] p-3"
        >
          {shownError === ''
            ? null
            : (
              <div data-ewb-gen-error="" className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
                <span className="dot warn" style={{ marginTop: 5 }} />
                <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">{shownError}</span>
                <button
                  type="button"
                  data-ewb-gen-error-clear=""
                  className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                  onClick={() => { gen.clearError(); setErr('') }}
                >知道了</button>
              </div>
            )}

      {/* ── 结果墙是**响应式网格**（照参考 `:510`）──
       *
       * ⚠️ **注释里不写断点类名**（`css-refs.mjs` 的文件头记着这条）：
       * 那个检查逐行扫源码全文本、不跳注释，注释里出现的断点类名会被当成
       * 「源码用了这个断点」，然后去产物里找规则 —— 找不到就红。
       * 所以这里只描述形状，类名写在下面真实的 `className` 里。
       *
       * 窄屏单列 → 中宽两列 → 很宽三列（断点是 `sm` 与 `2xl`，
       * 具体写法见下面 `className` 那两段）。
       *
       * ## 为什么从纵向列表改成网格（票 42）
       *
       * 之前是 `flex flex-col` —— 一条记录占满整行，宽屏上一屏只看得见两三条，
       * 而每条记录里的产物缩略图又是自己内部的小网格。两层网格套着，
       * 外层却还是「一行一条」，这就是参考那边没有的形状。
       *
       * ## 为什么 `items-start` 必须加
       *
       * grid 默认 `align-items: stretch`：同一行里两条记录高度不同时，
       * 矮的那张卡会被拉长到与高的等高 —— 卡片底部留一大片空白。
       * `items-start` 让每张卡按自己的内容高度排。 */}
      <div className="grid min-h-0 flex-1 content-start items-start gap-2 overflow-y-auto sm:grid-cols-2 2xl:grid-cols-3" data-ewb-gen-list="">
        {loading && rows.length === 0
          ? <div className="px-1 py-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>
          : null}
        {!loading && rows.length === 0 && shownError === ''
          ? (
            <div data-ewb-gen-empty="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-8">
              <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">还没有生成记录</span>
              <span className="mt-1 block font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                在中间那一栏填好提示词、选一个模型就能提交。生成出来的结果会按卡片排在右侧这一栏。
              </span>
            </div>
          )
          : null}

        {rows.map((row, i) => {
          const open = openId === row.id
          /* ⚠️ 视频那格除了通用的 `data-ewb-gen-*` 钩子，还多一套 `data-ewb-video-*`
           * 别名：`tests/workbenches.mjs` 早就按后者写了一批断言（计时器、状态文），
           * 不改那些判据就得留着这层别名。别名只对 `kind === 'video'` 挂，
           * 免得别的格也长出视频的钩子、把「这一格是什么」搞混。 */
          const alias = kind === 'video'
            ? { row: { 'data-ewb-video-row': row.id }, status: 'data-ewb-video-status', wait: 'data-ewb-video-wait', prompt: 'data-ewb-video-prompt', model: 'data-ewb-video-model', time: 'data-ewb-video-time' }
            : kind === 'audio'
              ? { row: { 'data-ewb-audio-row': row.id }, status: 'data-ewb-audio-status', wait: 'data-ewb-audio-wait', prompt: 'data-ewb-audio-prompt', model: 'data-ewb-audio-model', time: 'data-ewb-audio-time' }
              : { row: {}, status: 'data-ewb-gen-status', wait: 'data-ewb-gen-elapsed', prompt: 'data-ewb-gen-prompt', model: 'data-ewb-gen-model', time: 'data-ewb-gen-time' }
          return (
            <div
              key={row.id}
              data-ewb-gen-row={row.id}
              {...alias.row}
              data-ewb-gen-index={String(i)}
              data-ewb-gen-live={row.live ? '' : undefined}
              className="min-w-0 rounded-card border border-[var(--dsw-alias-border-l2)] px-2.5 py-2"
            >
              <div className="flex items-start gap-2">
                <span
                  data-ewb-gen-status={row.status}
                  {...{ [alias.status]: row.status }}
                  className={[
                    'shrink-0 font-mono text-ewb-caption',
                    row.status === 'success' ? 'text-[#4ec9b0]'
                      : row.status === 'failed' ? 'text-[#ff5f6d]' : 'text-[#4fd6ff]',
                  ].join(' ')}
                >{STATUS_TEXT[row.status]}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]" data-ewb-gen-prompt="" {...{ [alias.prompt]: '' }} title={row.prompt}>
                  {row.prompt === '' ? '（没有提示词）' : row.prompt}
                </span>
                <span className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-gen-time="" {...{ [alias.time]: '' }}>{when(row.createdAt)}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                <span data-ewb-gen-model="" {...{ [alias.model]: '' }}>模型 {row.model === '' ? '—' : row.model}</span>
                <span data-ewb-gen-size="">{row.paramsText === '' ? '—' : row.paramsText}</span>
                <span data-ewb-gen-count="">张数 {(row.raw as GenLog).usage?.images === undefined ? '—' : String((row.raw as GenLog).usage.images)}</span>
                {/* 这一条是计时器：本机算，每秒变。视频那格的别名钩子挂在它上面。 */}
                <span data-ewb-gen-elapsed="" {...{ [alias.wait]: '' }}>
                  {row.endedAt === undefined ? waitText(row.createdAt, undefined, now) : '耗时 ' + elapsedText(row.raw as GenLog)}
                </span>
                {row.live
                  ? null
                  : <span data-ewb-gen-outcome="">{outcomeLine(row, kind)}</span>}
                <span className="flex-1" />
                {/* 在跑的那几条：视频要给「取消」。 */}
                {row.live && kind === 'video'
                  ? (
                    <button
                      type="button"
                      data-ewb-gen-cancel={row.id}
                      className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                      onClick={() => { void gen.cancel(row.id) }}
                    >取消</button>
                  )
                  : null}
                {row.status === 'failed'
                  ? (
                    <button
                      type="button"
                      data-ewb-gen-retry={row.id}
                      className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                      title="用同样的参数再提交一次"
                      onClick={() => { doRetry(row) }}
                    >重试</button>
                  )
                  : null}
                {true
                  ? (
                    <button
                      type="button"
                      data-ewb-gen-rerun={row.id}
                      className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                      title="把这条的参数填回上面的表单"
                      onClick={() => { doRerun(row.raw as GenLog) }}
                    >重跑</button>
                  )
                  : null}
                <button
                  type="button"
                  data-ewb-gen-detail={row.id}
                  className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                  onClick={() => { setOpenId(open ? '' : row.id) }}
                >{open ? '收起' : '明细'}</button>
              </div>

              {row.status === 'failed' && row.error !== undefined
                ? <div data-ewb-gen-failreason={row.id} className="mt-1 font-mono text-ewb-caption text-[#ff8a8a]">失败原因：{row.error}</div>
                : null}

              {open
                ? (
                  <div data-ewb-gen-open={row.id} className="mt-1.5 flex flex-col gap-1 border-t border-[var(--dsw-alias-border-l2)] pt-1.5">
                    <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-gen-rawparams="">
                      参数原文 {JSON.stringify((row.raw as GenLog).params ?? {})}
                    </span>
                    {(row.raw as GenLog).negativePrompt === undefined
                      ? null
                      : <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">反向提示词 {(row.raw as GenLog).negativePrompt}</span>}
                  </div>
                )
                : null}

              {/* 产物：没有时**整块不出现**（不占位）。
               * 音频用播放器，视频用播放器，图片用 <img>。
               *
               * ★ 2026-10-26 用户 m03414 / m03555：结果墙是主视觉，所以产物**放大**了 ——
               * 原来缩略图最小 88px（一行行的小方块，看着像附件），现在最小 150px、
               * 图片 1:1、视频 16:9。`loading="lazy"` 一定要有：一屏可能挂几十张。 */}
              {row.artifacts.length === 0
                ? null
                : (
                  <div
                    data-ewb-gen-thumbs={row.id}
                    className="mt-2 grid gap-2"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
                  >
                    {row.artifacts.map(a => (
                      <div key={a.id} className="flex min-w-0 flex-col gap-1">
                        <button
                          type="button"
                          data-ewb-gen-thumb-btn={a.id}
                          className="block cursor-pointer overflow-hidden rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] p-0 text-left"
                          style={{ aspectRatio: kind === 'image' ? '1 / 1' : '16 / 9' }}
                          title="点开看大图"
                          onClick={() => { setPreview(a.id) }}
                        >
                          {kind === 'image'
                            ? <img data-ewb-gen-thumb={a.id} src={artifactUrl(a.id)} alt="" loading="lazy" className="h-full w-full object-cover" />
                            : kind === 'audio'
                              ? <audio data-ewb-gen-thumb={a.id} src={artifactUrl(a.id)} className="w-full" preload="metadata" controls />
                              : <video data-ewb-gen-thumb={a.id} src={artifactUrl(a.id)} className="h-full w-full object-contain" preload="metadata" controls />}
                        </button>
                        {/* ── 下方元信息（判据 7）：尺寸 / 体积 ──
                         *
                         * 参考那行是「尺寸 体积 用时」三样（`:602-607`）。我们用两样：
                         * 每张的用时只有参考那边记了（它是逐张记 `durationMs`），
                         * 我们的 `GenLog.artifacts` 只有 id / 宽 / 高 / 字节 —— 没有逐张用时。
                         * 整条的用时已经在记录卡的标签里了，不在这里重复。 */}
                        <span
                          data-ewb-gen-artmeta={a.id}
                          className="truncate font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)]"
                        >
                          {(a.width === undefined || a.height === undefined ? '尺寸 —' : String(a.width) + '×' + String(a.height))
                            + ' · ' + (a.bytes === undefined ? '体积 —' : String(Math.round(a.bytes / 1024)) + ' KB')}
                        </span>
                        {/* ── 三颗操作按钮（照参考 `ResultImageCard` `:608-624`）──
                         *
                         * `grid grid-cols-3 gap-1` 等宽。等宽是为了「文字长短不把三栏撑歪」——
                         * 参考专门抽了 `RESULT_ACTION_BUTTON_CLASS`（`:68`）做 truncate。
                         *
                         * ⚠️ **「加为参考图」只在 `kind === 'image'` 时出现**：
                         * 视频与音频的产物不能当图片参考图（`readArtifact` 会拒非 image/*）。
                         * 参考只有生图页，没这个分叉；我们三格共用一份实现，必须分开。 */}
                        <div data-ewb-gen-actions={a.id} className="grid min-w-0 gap-1" style={{ gridTemplateColumns: kind === 'image' ? 'repeat(3, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))' }}>
                          <button
                            type="button"
                            data-ewb-gen-add-material={a.id}
                            className="min-w-0 cursor-pointer truncate rounded-[4px] border border-[var(--dsw-alias-border-l2)] px-1 py-0.5 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-secondary)]"
                            title="把这张存进素材库"
                            onClick={() => { void saveResultAsMaterial(a.id) }}
                          >加入素材</button>
                          {kind === 'image'
                            ? (
                              <button
                                type="button"
                                data-ewb-gen-add-ref={a.id}
                                className="min-w-0 cursor-pointer truncate rounded-[4px] border border-[var(--dsw-alias-border-l2)] px-1 py-0.5 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-secondary)]"
                                title="把这张加进参考图列表，接着改"
                                onClick={() => { void addResultAsRef(a.id) }}
                              >加为参考图</button>
                            )
                            : null}
                          <button
                            type="button"
                            data-ewb-gen-download={a.id}
                            className="min-w-0 cursor-pointer truncate rounded-[4px] border border-[var(--dsw-alias-border-l2)] px-1 py-0.5 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-secondary)]"
                            title="下载这张"
                            onClick={() => { downloadArtifact(a.id) }}
                          >下载</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          )
        })}
        </div>
        </div>
        </section>
      </main>

      {/* ★ 窄屏记录抽屉（票 33 补做，照参考 `pages/image/index.tsx:541`）。
       *
       * ## 参考原样
       *
       * ```
       * <Drawer title={t("workbench.logs")} placement="bottom" size="large"
       *         open={logsOpen} onClose={() => setLogsOpen(false)}>
       *     <LogPanel … />
       * </Drawer>
       * ```
       *
       * 底部弹出、撑大半个屏、里面就是左栏那一份记录。
       * 我们这一版**结构逐字照它**：`placement="bottom"` + `size="large"`，
       * 里面渲染的 `GenLogEntries` 与左栏**是同一个组件**（不复制一份条目写法）。
       *
       * ## 为什么窄屏才用得上
       *
       * 左栏是 `hidden … lg:flex` —— 窄屏时它整个不在（`hidden` 不算布局）。
       * 抽屉是**唯一**能在窄屏看到逐条记录的地方，所以那个「记录」按钮
       * 也是 `lg:hidden`：宽屏开着它等于两个入口。
       *
       * ⚠️ `getContainer={false}` 与下面那个预览弹层同一个理由：默认 antd 会
       * portal 到 `document.body`，测试挂在自己的容器里就查不到。 */}
      <Drawer
        title="生成记录"
        placement="bottom"
        size="large"
        open={logsOpen}
        getContainer={false}
        onClose={() => { setLogsOpen(false) }}
      >
        {/* 钩子挂在自己写的 div 上，不挂 `Drawer` 上：antd 的 `Drawer` 不保证把
         * 未知属性透到根元素（`data-*` 落在哪一层是它的实现细节），
         * 挂在自己写的元素上才是稳定的锚点。 */}
        <div data-ewb-gen-logs-drawer="" className="flex flex-col gap-2">
          <GenLogEntries
            rows={rows}
            openId={openId}
            onToggle={id => { setOpenId(openId === id ? '' : id) }}
            selected={picked}
            onSelectedChange={(id, next) => {
              setPicked(cur => (next ? [...cur.filter(x => x !== id), id] : cur.filter(x => x !== id)))
            }}
            onPick={pickLog}
          />
        </div>
      </Drawer>

      {/* ★ 窄屏设置抽屉（票 42，照参考 `pages/image/index.tsx:552-556`）。
       *
       * ## 参考原样
       *
       * ```
       * <Drawer title={t("workbench.settings")} placement="bottom" size="82vh"
       *         open={settingsOpen} onClose={() => setSettingsOpen(false)}>
       *     <div>  ← 两列网格
       *         <GenerationSettings … />
       *     </div>
       * </Drawer>
       * ```
       *
       * ## 与中栏**渲染同一组件**
       *
       * 里面就是 `GenSettings`，与中栏那个参数块是**同一个组件**（`hook` 不同）。
       * 照参考的做法 —— 它也只有一个 `GenerationSettings`，左栏参数块与抽屉各调一次。
       * 复制一份参数控件的后果是「改一处忘一处」，本项目
       * `pitfalls/同一件事写两份迟早漂.md` 记的就是这个。
       *
       * ⚠️ `hook` 必须与中栏**不同**：两处挂同一个数据钩子的话，
       * 测试里的 `querySelector` 会取到抽屉那一份，断言从此验的不是用户看到的表单。 */}
      <Drawer
        title="参数设置"
        placement="bottom"
        size="82vh"
        open={settingsOpen}
        getContainer={false}
        onClose={() => { setSettingsOpen(false) }}
      >
        <div data-ewb-gen-settings-drawer="" className="grid grid-cols-2 gap-3 pb-4">
          <GenSettings
            kind={kind}
            values={draft}
            onChange={p => { setDraft(d => ({ ...d, ...p })) }}
            groups={models.groups}
            modelsError={models.error}
            hook="data-ewb-gen-setting"
          />
        </div>
      </Drawer>

      {/* ★ 点产物看大图（用户 m03414 判据 3）。
       *
       * ⚠️ `getContainer={false}` 是刻意的：默认 antd 会把弹层 portal 到
       * `document.body`，测试挂在自己的容器里就查不到，判据会变成「点了没反应」。 */}
      <Modal
        open={preview !== ''}
        footer={null}
        width={860}
        centered
        getContainer={false}
        onCancel={() => { setPreview('') }}
        title="结果预览"
      >
        {preview === ''
          ? null
          : (
            <div data-ewb-gen-preview={preview}>
              {kind === 'image'
                ? <img src={artifactUrl(preview)} alt="" className="max-h-[70vh] w-full object-contain" />
                : kind === 'audio'
                  ? <audio src={artifactUrl(preview)} className="w-full" preload="metadata" controls />
                  : <video src={artifactUrl(preview)} className="max-h-[70vh] w-full" preload="metadata" controls />}
            </div>
          )}
      </Modal>
    </div>
  )
}

/**
 * 从一行反推出提交草稿（「重试」用）。
 *
 * 历史记录有 `params`，在跑的任务只有 `stage` —— 后者的参数拿不到，
 * 所以只用它那几个一定能拿到的字段（提示词、模型、渠道）。
 *
 * @param kind - 生成什么。
 * @param row - 一行。
 * @returns 草稿。
 */
export function draftFromRow(kind: GenKind, row: WorkRow): GenDraft {
  const log = row.raw as GenLog
  const p = log.params ?? {}
  const num = (v: unknown): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : '')
  return {
    /* ⚠️ 基数是 `emptyDraftOf(kind)` 不是 `EMPTY_DRAFT`（票 29）：
     * 音频「重跑」一条没有时长参数的旧记录时，要落回**空**（用模型默认），
     * 不能落回 5 —— 那等于替这条记录编了个它当初没有的时长。 */
    ...emptyDraftOf(kind),
    prompt: row.prompt,
    model: row.model,
    channelId: row.channelId,
    size: typeof p.size === 'string' ? p.size : EMPTY_DRAFT.size,
    count: num(p.count) === '' ? EMPTY_DRAFT.count : num(p.count),
    seconds: num(p.seconds) === '' ? emptyDraftOf(kind).seconds : num(p.seconds),
    /* 种子（票 09）：记录里有 `params.seed` 就读回来 —— 那是**实际用的那个**
     * （用户没填时由后端随机之后写进去的），照着它再跑一次能复现同一张图。
     *
     * 老记录没有这个键 → `num(undefined)` 是空串 → 落到「不填」，
     * 也就是让后端重新随机。这与「这条记录当初就没指定种子」是同一个语义。 */
    seed: num(p.seed),
    /* 参考图**不回填**（票 41 判据 5 的另一半）：
     *
     * 记录里存的 `params` 只有 size / count / seconds（`generate.ts:814-818`），
     * **没有参考图的字节** —— 那是输入，不是产出，落盘会把记录文件撑爆。
     * 所以「重跑一条带参考图的记录」只能把参数填回去，图要用户重新选。
     *
     * 老记录（改造前只有一张、也没存字节）与新记录在这一项上**表现相同**，
     * 都是空列表 —— 不会出现「老的读成一张、新的读成多张」这种不一致。 */
    refs: [],
    ...kind === 'image' ? {} : { count: EMPTY_DRAFT.count },
  }
}
