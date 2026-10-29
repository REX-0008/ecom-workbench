/** 产物（图片 / 视频 / 音频）的存与取，以及内容板块新增的几个数据目录。
 *
 * ## 为什么需要（契约 AV，2026-10-25）
 *
 * 生图链路里有个绕不过去的硬约束：**图片不能进 JSON、不能进前端内存**。
 * 前端只拿一个 id，显示时用 `<img src="/api/ecom-workbench/artifact/<id>">` 去取字节。
 * 于是宿主必须能：① 把二进制落到磁盘；② 按 id 把字节原样吐回去。
 *
 * ## 存法（一条产物两个文件）
 *
 * ```
 * artifacts/<id>.<扩展名>   二进制本体
 * artifacts/<id>.json       元数据（mime、字节、宽高、来源、生成参数）
 * ```
 *
 * 为什么元数据要单独一个文件：产物库要列「谁生成的、什么时候、用的什么提示词」，
 * 但那不能塞进图片里。分开存之后，删产物 = 删两个文件，读产物 = 读两次。
 *
 * ## 目录解析：**每一个都先认 `EWB_TEST_HOME`**
 *
 * 照 `src/workflow/store.ts:41-51` 的写法。不认沙箱就意味着跑一次测试往用户真实
 * 数据目录里丢一堆图 —— 那是红线（`AGENTS.md`）。
 */
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowsDir } from '../workflow/store.ts'
import { newRunId } from '../workflow/workflow-runs.ts'

/**
 * 插件数据根（与 `workflows/` 同级）。
 *
 * ⚠️ **不自己再判一次 `EWB_TEST_HOME`**：`workflowsDir()` 已经判过
 * （`src/workflow/store.ts:41-51`），这里从它派生。判两处就有一天漏掉一处，
 * 那一处就会往真实数据目录里写东西。
 *
 * @returns 绝对路径（形如 `<沙箱>` 或 `…/data/ecom-workbench`）。
 */
export function dataRoot(): string {
  return join(workflowsDir(), '..')
}

/* ── 目录可改（2026-10-26，T-B-后端）───────────────────────────────────
 *
 * 用户点名要「本地存储目录」能配。五个**内容目录**允许指到别处（换块大盘不用手工搬），
 * 配置文件留在 `dataRoot()` 不动 —— 跟着内容跑会让「换盘」变成「换配置」。
 *
 * ## 为什么是进程内一个变量，而不是每个函数都读一次文件
 *
 * 这几个函数在热路径上（每次存产物、每次列素材都调）。每次读一次文件是同步 I/O，
 * 一个列表页能读几十次。所以：**启动时读一次套进来**（`storage-config.ts` 的
 * `applyStorageConfig`），改的时候**存完立刻套用**（热生效，不用重启）。
 *
 * ## 为什么不干脆做成参数
 *
 * 调用点有三十多处（`artifacts.ts` / `materials.ts` / `canvases.ts` / 路由里），
 * 加参数等于全改一遍，且每一处都要判「没给就用默认」—— 那是把同一件事抄三十遍。
 * 一个模块级覆盖表，零调用点改动。
 */

/** 目录覆盖（键与 `storage-config.ts` 的 `STORAGE_KEYS` 一致）。 */
let dirOverrides: Record<string, string> = {}

/**
 * 换掉目录覆盖表（`storage-config.ts` 用）。
 * @param next - 新的覆盖表（空对象 = 全用默认）。
 */
export function setDirOverrides(next: Record<string, string>): void {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(next ?? {})) {
    if (typeof v === 'string' && v.trim() !== '') clean[k] = v.trim()
  }
  dirOverrides = clean
}

/**
 * 读当前的覆盖表（`storage-config.ts` 算「哪一格改过」用）。
 * @returns 覆盖表（只含改过的键）。
 */
export function currentDirOverrides(): Record<string, string> {
  return { ...dirOverrides }
}

/** 取一格的路径：改过用改的，没改用默认。 */
function dirOf(key: string, fallbackName: string): string {
  const custom = dirOverrides[key]
  return custom !== undefined && custom !== '' ? custom : join(dataRoot(), fallbackName)
}

/** 内容画布项目目录（`canvases/`，一个画布一个文件）。 */
export function canvasesDir(): string {
  return dirOf('canvases', 'canvases')
}

/** 产物目录（`artifacts/`，二进制本体 + 元数据）。 */
export function artifactsDir(): string {
  return dirOf('artifacts', 'artifacts')
}

/** 素材库目录（`materials/`，平铺，放进去就算有）。 */
export function materialsDir(): string {
  return dirOf('materials', 'materials')
}

/** 生成记录目录（`gen-logs/`，下分 `image/` 与 `video/`）。 */
export function genLogsDir(): string {
  return dirOf('genLogs', 'gen-logs')
}

/** 提示词源缓存目录（`prompt-cache/`）。 */
export function promptCacheDir(): string {
  return dirOf('promptCache', 'prompt-cache')
}

/**
 * 扩展名 → mime。只列内容板块真会产出的那几种。
 *
 * 分成「图 / 视频 / 音频」三段是因为未来素材库要按类型筛（计划 §6.2 第一条）。
 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
}

/** mime → 首选扩展名（`storeArtifact` 只知道 mime 时反查用）。 */
const EXT_BY_MIME: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
    /* `jpg` 先登记就赢 —— 但 `png` 在它前面，顺序按上面的声明走。
     * `text/plain; charset=utf-8` 这种带参数的键只给 ext 用，不做反查。 */
    if (out[mime] === undefined) out[mime] = ext
  }
  return out
})()

/**
 * 由扩展名取 mime。
 * @param ext - 扩展名（可带点、任意大小写）。
 * @returns mime；不认识就给 `application/octet-stream`（浏览器会下载而不是报错）。
 */
export function mimeOf(ext: string): string {
  const key = ext.replace(/^\./, '').toLowerCase()
  return MIME_BY_EXT[key] ?? 'application/octet-stream'
}

/**
 * 由 mime 取扩展名。
 * @param mime - 完整 mime。
 * @returns 扩展名（不带点）；不认识给 `bin`。
 */
export function extOfMime(mime: string): string {
  return EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] ?? 'bin'
}

/**
 * 产物 id 的合法形状。
 *
 * ⚠️ **这是安全边界**：id 来自 URL，不清洗的话 `../../browser-prefs` 能读到目录外面去。
 * 只认字母数字开头、后面字母数字与 `. _ -`，长度 128 以内。
 * 元数据文件的 `.json` 后缀由我们自己拼，所以 id 里**不许**带点开头。
 */
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * id 合不合法。
 * @param id - 待查 id。
 * @returns 合法为 true。
 */
export function isArtifactId(id: string): boolean {
  return ID_OK.test(id)
}

/** 一条产物的元数据。 */
export interface ArtifactMeta {
  /** 产物 id（文件名去掉扩展名）。 */
  id: string
  /** 本体文件的扩展名（不带点）。 */
  ext: string
  /** 完整 mime。 */
  mime: string
  /** 字节数（**本体**的，不含元数据文件）。 */
  bytes: number
  /** 生成时间（ms）。 */
  createdAt: number
  /** 宽（图片 / 视频；拿不到就不写这个键）。 */
  width?: number
  /** 高。 */
  height?: number
  /** 从哪来：`gen-image` / `gen-video` / `upload` / `workflow` 等。 */
  source?: string
  /** 哪份工作流跑出来的（可选）。 */
  workflowId?: string
  /** 哪次运行（可选）。 */
  runId?: string
  /** 生成参数（提示词、种子、模型…）。原样留着，本文件不解释它。 */
  params?: Record<string, unknown>
}

/** 存一条产物要什么。 */
export interface StoreArtifactInput {
  /** 二进制（与 `base64` 二选一，`data` 优先）。 */
  data?: Buffer
  /** base64 文本（生成接口通常给这个）。 */
  base64?: string
  /** mime（与 `ext` 至少给一个，都给了以 `ext` 为准）。 */
  mime?: string
  /** 扩展名（不带点也行）。 */
  ext?: string
  /** 指定 id（不指定就现造一个）。 */
  id?: string
  /** 宽。 */
  width?: number
  /** 高。 */
  height?: number
  /** 来源标记。 */
  source?: string
  /** 工作流 id。 */
  workflowId?: string
  /** 运行 id。 */
  runId?: string
  /** 生成参数。 */
  params?: Record<string, unknown>
}

/**
 * 存一条产物：写本体 + 写元数据。
 *
 * @param input - 见 `StoreArtifactInput`。
 * @returns 落定后的元数据（字段都齐，可直接回给前端）。
 * @throws 两个都没给字节、或 id 不合法时报错（不静默失败）。
 */
export async function storeArtifact(input: StoreArtifactInput): Promise<ArtifactMeta> {
  const data = input.data ?? (input.base64 !== undefined ? Buffer.from(input.base64, 'base64') : undefined)
  if (data === undefined) throw new Error('没有给产物内容（data 或 base64 必须给一个）')
  const id = input.id ?? newRunId()
  if (!isArtifactId(id)) throw new Error('产物 id 不合法：' + id)
  const ext = (input.ext !== undefined && input.ext !== ''
    ? input.ext.replace(/^\./, '')
    : extOfMime(input.mime ?? '')).toLowerCase()
  const mime = input.mime ?? mimeOf(ext)
  const dir = artifactsDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, id + '.' + ext), data)
  const meta: ArtifactMeta = {
    id, ext, mime, bytes: data.length, createdAt: Date.now(),
    ...input.width !== undefined ? { width: input.width } : {},
    ...input.height !== undefined ? { height: input.height } : {},
    ...input.source !== undefined ? { source: input.source } : {},
    ...input.workflowId !== undefined ? { workflowId: input.workflowId } : {},
    ...input.runId !== undefined ? { runId: input.runId } : {},
    ...input.params !== undefined ? { params: input.params } : {},
  }
  await writeFile(join(dir, id + '.json'), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/** 取到的产物。 */
export interface LoadedArtifact {
  /** 元数据（没有元数据文件时按本体现场推一份）。 */
  meta: ArtifactMeta
  /** 本体字节。 */
  data: Buffer
}

/**
 * 按 id 取产物：元数据 + 本体字节。
 *
 * ## 没有元数据文件也要能取（这是刻意的）
 *
 * 「手工丢一张图进 `artifacts/` 就能在浏览器里看」是计划 §三 Step 1 的完成标准。
 * 那时只有图、没有那份 `.json`。所以元数据缺失时按本体现场推一份
 * （字节数取实际大小、mime 按扩展名），而不是报 404。
 *
 * @param id - 产物 id。
 * @returns 找不到（id 不合法 / 文件不存在）给 `null`。
 */
export async function loadArtifact(id: string): Promise<LoadedArtifact | null> {
  if (!isArtifactId(id)) return null
  const dir = artifactsDir()
  /* 本体文件名带扩展名，但我们只有 id。先读元数据拿扩展名；
   * 没有元数据就按已知扩展名挨个试（表就上面那十几个，比 readdir 便宜）。 */
  let meta: ArtifactMeta | null = null
  try {
    meta = JSON.parse(await readFile(join(dir, id + '.json'), 'utf8')) as ArtifactMeta
  } catch { meta = null }
  const ext = meta?.ext ?? await guessExt(id)
  if (ext === '') return null
  const file = join(dir, id + '.' + ext)
  let data: Buffer
  try {
    data = await readFile(file)
  } catch { return null }
  if (meta === null) {
    const s = await stat(file).catch(() => null)
    meta = {
      id, ext, mime: mimeOf(ext), bytes: data.length,
      createdAt: s?.mtimeMs ?? Date.now(), source: 'unknown',
    }
  }
  return { meta, data }
}

/**
 * 没有元数据时按已知扩展名找本体。
 * @param id - 产物 id。
 * @returns 扩展名；一个都不存在给空串。
 */
async function guessExt(id: string): Promise<string> {
  const dir = artifactsDir()
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const s = await stat(join(dir, id + '.' + ext)).catch(() => null)
    if (s !== null && s.isFile()) return ext
  }
  return ''
}

/**
 * 列产物（按 mtime 倒序，新的在前）。
 *
 * 只为产物库下一步用；本轮只有路由与测试在用，所以不缓存、每次读目录。
 * @param limit - 最多几条（默认 200）。
 * @returns 元数据数组（读不出来的单个文件跳过，不让整份清单失败）。
 */
export async function listArtifacts(limit = 200): Promise<ArtifactMeta[]> {
  const dir = artifactsDir()
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const out: ArtifactMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as ArtifactMeta)
    } catch { /* 坏文件跳过：清单不该因为一条坏记录整份不可用 */ }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out.slice(0, limit)
}

/**
 * 磁盘上**真正有多少条**产物（票 52，2026-10-28）。
 *
 * ## 为什么需要它（`listArtifacts` 的 `limit` 造出来的问题）
 *
 * `listArtifacts` 默认只读 200 条（`out.slice(0, limit)`）。超过 200 时界面上的
 * 「共 N 条」就是**截断后的条数**，而用户拿这个数判断「要不要清理」——
 * 显示的比实际少，他会以为干净了。
 *
 * ## 为什么是单独一个函数，不是让 `listArtifacts` 多回一个数
 *
 * `listArtifacts` 的返回类型是 `ArtifactMeta[]`（纯数组）。加一个数就得改成
 * `{ items, total }`，那会**改掉既有调用方拿到的形状** —— 票面明令禁止。
 * 所以另开一个只读计数。
 *
 * ## 它自己为什么不受 `limit` 影响
 *
 * 它**不解析内容**，只数文件：`readdir` 一遍、数 `.json` 结尾的。
 * 一次 `readdir` 是几百个文件名的量级，代价可以忽略。
 *
 * ## 它与 `listArtifacts` 的口径只有一处会差
 *
 * 两边都只认 `.json`（元数据），一个产物的本体（`<id>.png`）不算一条。
 *
 * **唯一的差别**：元数据坏掉的文件（JSON 解析不了）——
 * `listArtifacts` 会跳过它（读不出内容就没法显示），这里**算一条**。
 * 理由：那个文件确实躺在磁盘上、确实占着空间，把它从总数里藏掉就是
 * 又一次「总数比实际少」。差多少条，就差在有几个坏文件上。
 *
 * @returns 磁盘上真实条数（目录不存在 / 读不出来 → 0）。
 */
export async function countArtifacts(): Promise<number> {
  const dir = artifactsDir()
  let names: string[]
  try { names = await readdir(dir) } catch { return 0 }
  let n = 0
  for (const name of names) {
    /* 与 `listArtifacts` 同一个判据：只数元数据 `.json`。
     * ⚠️ 坏 JSON 也算一条 —— `listArtifacts` 跳过它是因为「读不出来没法显示」，
     * 但它确实占着磁盘，数总数时不该把它藏掉（藏掉就是又一次「总数比实际少」）。 */
    if (name.endsWith('.json')) n += 1
  }
  return n
}

/**
 * 删一条产物：**本体 + 元数据两个文件都删**（契约 BA，2026-10-25）。
 *
 * ## 为什么必须两个都删
 *
 * 只删元数据 → 目录里留一个孤儿本体，`listArtifacts()` 列不出来但磁盘上一直占着，
 * 谁都找不到它、也不会有人删。
 * 只删本体 → 列表里还显示「有一张图」，点开是 404（比直接没有更糟：
 * 用户以为图丢了，开始怀疑程序）。
 *
 * 所以删就删干净。**这条路是「产物库说了算」的执行处**（计划 §附 四个纪律第 2 条：
 * 产物库里删了，文件才删；画布上删节点不删文件）。
 *
 * ## 引用不拦着
 *
 * 被画布引用的产物**也允许删**。调用方（界面）删之前会先问
 * `artifactUsage()`，被引用就弹确认框说清后果；这里不替它做决定。
 * 删完之后被引用的节点显示「图已删除」——那是计划 §4.2 明确要的行为。
 *
 * @param id - 产物 id。
 * @returns 删掉了就 true（本体或元数据删到任何一个都算碰到过）；
 *   两个都不在（或 id 非法）给 false，调用方据此回 404。
 */
export async function deleteArtifact(id: string): Promise<boolean> {
  if (!isArtifactId(id)) return false
  /* ⚠️ 用动态 import 拿 `unlink`，而不是往文件顶上那行 import 里加一个名字：
   * 契约 BA 要求「这个文件只许新增本函数、既有代码一行都不动」，
   * 而改那行 import 会算一处修改。 */
  const { unlink } = await import('node:fs/promises')
  const dir = artifactsDir()
  let removed = false
  /* 元数据先删：先删本体的话，中途失败会留下「元数据说有一张图、本体没了」，
   * 那比反过来难查（反过来是「本体还在、列表里看不到」，至少文件还在）。 */
  try { await unlink(join(dir, id + '.json')); removed = true } catch { /* 没有元数据 */ }
  /* 本体文件名带扩展名而只有 id，所以挨个已知扩展名试（与 `guessExt` 同一个思路，
   * 但这里要删**所有**匹配的，不提前退出）。 */
  for (const ext of Object.keys(MIME_BY_EXT)) {
    try { await unlink(join(dir, id + '.' + ext)); removed = true } catch { /* 这个扩展名没有 */ }
  }
  return removed
}
