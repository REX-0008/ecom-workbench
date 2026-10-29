/** 内容画布项目的存取（宿主半，契约 AX，2026-10-25）。
 *
 * ## 为什么宿主这一侧要先做好
 *
 * 计划 §三 3.1：一个画布项目 = 一个文件（`canvases/<id>.json`），含标题、节点、
 * 连线、视口、时间。界面那侧的所有工作（拖拽、自动保存、撤销）都建立在这一层
 * 「存得进去、取得回来」之上 —— 先把它做稳，界面才好动。
 *
 * ## 本层**不解释** `nodes` / `edges` / `viewport`
 *
 * 它们原样存、原样取。为什么：那是界面的事（节点长什么样、连线怎么连），
 * 宿主插一脚就会变成「两边各有一份格式定义」，改一个字段要改两处。
 * 这里只认三件：`id` / `title` / 两个时间戳。
 *
 * ## 自动保存会**很频繁**（计划 §三 3.1：改动后 400ms 防抖写一次）
 *
 * 所以每次保存是「整份覆盖一个文件」，没有增量、没有事务。代价清楚：
 * 同一毫秒保存两次会互相盖掉（防抖已经挡住了）；画布很大时写盘有点重。
 * 换取的是「永远只有一个文件、没有中间态」——不需要读日志重放，
 * 出问题时直接打开那个 JSON 就能看。
 */
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { canvasesDir } from './artifacts.ts'

/** 一个画布项目（存下来的完整形状）。 */
export interface CanvasDoc {
  /** 画布 id（`[A-Za-z0-9_-]`）。 */
  id: string
  /** 显示名。 */
  title: string
  /** 创建时间（ms）。 */
  createdAt: number
  /** 最后保存时间（ms）。 */
  updatedAt: number
  /** 节点（**原样**，本层不解释）。 */
  nodes: unknown[]
  /** 连线（原样）。 */
  edges: unknown[]
  /** 视口（原样）。 */
  viewport: unknown
}

/** 列表里的一条（**不含节点内容** —— 画布可能很大，列表不该把它全搬一遍）。 */
export interface CanvasSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 节点数（界面列表上显示「12 个节点」）。 */
  nodeCount: number
}

/** id 的合法形状。**安全边界**：id 进 URL、进文件名。 */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/

/**
 * id 合不合法。
 * @param id - 待查 id。
 * @returns 合法为 true。
 */
export function isCanvasId(id: string): boolean {
  return ID_OK.test(id)
}

/** 一个画布文件的路径。 */
function canvasFile(id: string): string {
  return join(canvasesDir(), id + '.json')
}

/** 现造一个画布 id（`cv_` + 8 位，足够一眼认出来是画布）。 */
export function newCanvasId(): string {
  return 'cv_' + Math.random().toString(36).slice(2, 10)
}

/**
 * 归一一份画布记录（**纯函数**，能单测）。
 *
 * @param raw - 请求体。
 * @param id - 落定用的 id（新建时现造，保存时用 URL 里的）。
 * @param prior - 更新时传旧记录（`createdAt` 沿用旧值）。
 * @returns 完整记录。
 */
export function normalizeCanvas(raw: Record<string, unknown>, id: string, prior?: CanvasDoc): CanvasDoc {
  const now = Date.now()
  const title = typeof raw.title === 'string' && raw.title.trim() !== ''
    ? raw.title.trim()
    : prior?.title ?? '未命名画布'
  return {
    id,
    title,
    createdAt: prior?.createdAt ?? now,
    /* ⚠️ 更新一律用 now，不信客户端传的 updatedAt：
     * 那是「谁最后改了」的唯一真相，客户端时钟不可靠（也可能是缓存的旧值）。 */
    updatedAt: now,
    nodes: Array.isArray(raw.nodes) ? raw.nodes : prior?.nodes ?? [],
    edges: Array.isArray(raw.edges) ? raw.edges : prior?.edges ?? [],
    viewport: raw.viewport !== undefined ? raw.viewport : prior?.viewport ?? { x: 0, y: 0, zoom: 1 },
  }
}

/**
 * 读一个画布。
 *
 * @param id - 画布 id。
 * @returns 记录；id 非法或文件不存在/坏了给 `null`。
 */
export async function loadCanvas(id: string): Promise<CanvasDoc | null> {
  if (!isCanvasId(id)) return null
  let text: string
  try {
    text = await readFile(canvasFile(id), 'utf8')
  } catch { return null }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    /* 存档里的 id 以文件名/URL 为准（改过一次名字也不该让 id 变得可疑）。 */
    return normalizeCanvas(parsed, id, {
      id, title: typeof parsed.title === 'string' ? parsed.title : '未命名画布',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    })
  } catch { return null }
}

/**
 * 保存一个画布（整份覆盖）。
 *
 * @param id - 画布 id。
 * @param raw - 请求体。
 * @returns 保存后的完整记录；id 非法给 `null`。
 */
export async function saveCanvas(id: string, raw: Record<string, unknown>): Promise<CanvasDoc | null> {
  if (!isCanvasId(id)) return null
  const prior = await loadCanvas(id) ?? undefined
  const doc = normalizeCanvas(raw, id, prior)
  await mkdir(canvasesDir(), { recursive: true })
  await writeFile(canvasFile(id), JSON.stringify(doc, null, 2), 'utf8')
  return doc
}

/**
 * 新建一个画布。
 *
 * @param raw - 请求体（可带 `title`，也可以带初始 `nodes` / `edges`）。
 * @returns 完整记录。
 */
export async function createCanvas(raw: Record<string, unknown>): Promise<CanvasDoc> {
  const wanted = typeof raw.id === 'string' && isCanvasId(raw.id.trim()) ? raw.id.trim() : newCanvasId()
  /* 撞了就换一个：id 是文件名，盖掉别人的画布是不可接受的失败方式。 */
  const id = (await loadCanvas(wanted)) === null ? wanted : newCanvasId()
  const doc = normalizeCanvas(raw, id)
  await mkdir(canvasesDir(), { recursive: true })
  await writeFile(canvasFile(id), JSON.stringify(doc, null, 2), 'utf8')
  return doc
}

/**
 * 列画布（新的在前）。
 *
 * 单份读不出来（坏 JSON）就跳过 —— 一条坏记录不该让整个画布库打不开。
 * @returns 摘要数组。
 */
export async function listCanvases(): Promise<CanvasSummary[]> {
  let names: string[]
  try { names = await readdir(canvasesDir()) } catch { return [] }
  const out: CanvasSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    const doc = await loadCanvas(id)
    if (doc === null) continue
    out.push({
      id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      nodeCount: doc.nodes.length,
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/**
 * 删一个画布。
 *
 * @param id - 画布 id。
 * @returns 删掉了就 true（本来就没有给 false，调用方据此回 404）。
 */
export async function deleteCanvas(id: string): Promise<boolean> {
  if (!isCanvasId(id)) return false
  const s = await stat(canvasFile(id)).catch(() => null)
  if (s === null || !s.isFile()) return false
  await unlink(canvasFile(id))
  return true
}
