/** 巡查结果（`patrol/`）的只读读路：给总览拿「数据本身」（票 11，2026-10-30）。
 *
 * # 为什么要有它
 *
 * 总览要显示数据，但巡查结果的指标明细**此前没有任何接口能拿到**：
 * `readCollectRecords()` 读的是归档格式（`reports` / `outputs`），**不读 `blocks`**；
 * 总览当时读的是 `GET /workflow/runs`，那是运行历史，只有「成没成、跑多久」，没有数字。
 *
 * # 为什么不能「把 `patrol/*.json` 全读一遍就返」
 *
 * `patrol/` 里住着**三种完全不同的东西**（实测 9 个文件）：
 *
 * | 文件 | 形状 | 是不是巡查结果 |
 * |---|---|---|
 * | `patrol-tm-shop.json` / `patrol-dy-shop.json` / `patrol-dy-qianchuan.json` | `job`/`platform`/`runAt`/`dataDate`/`ok`/`error`/`blocks` | 是（形状对） |
 * | `patrol-tm-activity.json` | 同上但结果装在**单数** `block` 里，且**没有** `runAt` / `dataDate` | 是（形状错，票 10 在修） |
 * | `tm-sycm.json` / `douyin-ui.json` | 只有 `runAt`，或 `{ ok, total, okCount … }` | **不是**，另一条取数路的产物 |
 * | `巡查-<工作流名>-<时间戳>.json` | `startedAt`/`outputs`/`runId`/`via` | **不是**，`archiveOutputs` 归档的**运行记录** |
 *
 * 所以判据是**按名单认**，不是按文件名前缀扫。按 `patrol-` 前缀扫会把
 * `tm-sycm` / `douyin-ui` 也当巡查结果报成「坏了」—— 那是假警报。
 *
 * # 三栏分开，因为它们对用户是三件事
 *
 * | 栏 | 含义 | 用户该做什么 |
 * |---|---|---|
 * | `items` | 文件在、形状对 | 看数字 |
 * | `broken` | 文件在、读不出或形状不对 | 这份坏了，去看为什么（`why` 一句人话） |
 * | `missing` | 名单里有、盘上没有 | 这份**还没跑过**，去跑一次 |
 *
 * 合成一栏的话，「这份坏了」与「这份还没跑过」在界面上分不清。
 *
 * # 两件刻意不做的事
 *
 * 1. **不按 `state` 过滤**：`blocks[].items[]` 的 `label` / `value` / `state` / `note`
 *    原样透传。总览的筛选规则与「需要处理的事项」不一样，归并是界面的事。
 * 2. **不顺手纠正形状错的文件**：只读。那份错的由票 10 修；读取时纠正会掩盖真问题，
 *    还会与票 10 的修法打架。
 *
 * # 块级补偿（票 14，2026-10-30）
 *
 * 用户第 9 条：「更新没有成功不要更新数据，不是跑了就更新数据，而是**成功拿到数据才更新数据**。」
 *
 * 不做这一层的话，抖音店铺那 11 项一次没采到（`state: 'unknown'`）就真的全变成 `—`，
 * 而上一趟明明采到了 —— 用户看到的是「数据突然没了」，不是「这一趟没采到」。
 *
 * 做法（照旧项目 `workbench/src/workbench-node.ts:180-271` 的语义，不照抄代码）：
 *
 * | 这一趟的块 | 怎么办 |
 * |---|---|
 * | 有效（`state !== 'unknown'`） | 用它，刷新 `blockAt[id]` |
 * | `unknown` 且缓存里有同 id 的块 | **用缓存里那块**，id 记进 `compensated`，块时间不变 |
 * | `unknown` 且缓存里没有 | 原样返回（第一次就没采到，没有旧数据可保） |
 * | 整份进 `broken` / `missing` | 那一份的全部旧块从缓存补回 `items`，全部记进 `compensated` |
 *
 * ⚠️ **`blockAt` 与 `runAt` 不是一回事**：`runAt` 是「这一趟跑的时间」，
 * `blockAt` 是「这块数据最后一次真正采到的时间」。补偿之后两者必然不同 ——
 * 分不清就会出现「报告说这块是今天的数据，其实是上周的」。
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { patrolDir } from './records.ts'

/**
 * 五份巡查工作流的结果文件（**唯一真相是 `scripts/patrol/jobs.mjs` 的
 * `PATROL_JOBS[].outFile`**，这里是它在宿主半的一份镜像）。
 *
 * ## 为什么是镜像，不是 `import` 那个文件
 *
 * 它在 `scripts/` —— 那是**生成器一侧**，构建产物（`lib/`）不打包它，
 * 部署目录里只有 `lib/` 与 `node_modules/`。`src/` 去 `import` 一个不随产物发布的
 * 路径，等于让「部署之后就找不到文件」变成一个只在真机上才出现的运行期错误。
 * （同一个理由：`scripts/` 是生成器一侧，构建产物不打包它。）
 *
 * 代价是「加一份巡查工作流要在这里补一行」—— 所以用**测试**钉住漂移：
 * `tests/patrol-results-route.mjs` 里那条「名单与 `PATROL_JOBS` 逐条对上」，
 * 以及那五条默认任务的 id / 名字。漂了就红，不靠人记。
 *
 * ⚠️ **这份清单现在是全仓唯一一份「五份巡查」**（票 12，2026-10-30 合并）：
 * `store.ts` 的 `defaultPatrolTasks()` 从它派生默认任务的名字，
 * 原来的 `PATROL_WORKFLOW_NAMES` 已删。所以**顺序不能随手调** ——
 * 默认任务的 id 按 index 编号，顺序一变 id 就变，用户已有的定时任务会对不上。
 */
export const PATROL_RESULT_FILES: readonly { file: string, name: string, platform: string }[] = [
  { file: 'patrol-tm-shop.json', name: '巡查-天猫-店铺数据', platform: 'tm' },
  { file: 'patrol-tm-activity.json', name: '巡查-天猫-活动报名', platform: 'tm' },
  { file: 'patrol-dy-shop.json', name: '巡查-抖音-店铺数据', platform: 'dy' },
  { file: 'patrol-dy-activity.json', name: '巡查-抖音-活动报名', platform: 'dy' },
  { file: 'patrol-dy-qianchuan.json', name: '巡查-抖音-千川余额', platform: 'dy' },
]

/** 一份正常的巡查结果（字段原样透传，不加不减）。 */
export interface PatrolResult {
  /** 磁盘上那个文件名。 */
  file: string
  /** 面板显示名（`平台-任务`）。 */
  name: string
  /** `tm` / `dy`。 */
  platform: string
  /** 什么时候跑的（文件里的原值）。 */
  runAt: string
  /** 数据日期（文件里的原值）。 */
  dataDate: string
  /** 这一趟巡查本身成没成（原值；文件里没有就是 `null`）。 */
  ok: boolean | null
  /** 失败原因（原值；没有就是 `null`）。 */
  error: string | null
  /** 指标块（原样透传，**不过滤、不归并、不改名**）。 */
  blocks: unknown[]
}

/** 读不出的那一份。 */
export interface PatrolBroken {
  /** 磁盘上那个文件名。 */
  file: string
  /** 面板显示名。 */
  name: string
  /** 为什么读不出（一句人话，说清是哪个字段不对）。 */
  why: string
}

/** 名单里有、盘上没有的那一份。 */
export interface PatrolMissing {
  /** 应该有的文件名。 */
  file: string
  /** 面板显示名。 */
  name: string
}

/** 三栏 + 补偿。 */
export interface PatrolResults {
  /** 正常的那些。 */
  items: PatrolResult[]
  /** 有文件但读不出的那些。 */
  broken: PatrolBroken[]
  /** 文件根本不在的那些。 */
  missing: PatrolMissing[]
  /**
   * 这次返回的是旧数据的块 id（票 14）。
   *
   * ⚠️ 与 `broken` / `missing` 是**三件不同的事**：这里的块在 `items` 里正常显示，
   * 只是数据是上一次采到的。整份读不出来才是 `broken` / `missing`。
   */
  compensated: string[]
  /** 每个块最后一次**真正采到**的时间（ISO）；补偿过的块不刷新它。 */
  blockAt: Record<string, string>
}

/** 补偿缓存（票 14）。 */
interface PatrolCache {
  /**
   * 上一次有效的块。
   *
   * `file` 是**这块属于哪一份结果** —— 必须存。不存的话，一份文件整份坏掉时
   * 就不知道该把缓存里的哪些块补回去（旧项目靠一张额外的 `jobOf` 表，
   * 我们直接把它挪进每一条里，不另起一张表）。
   */
  blocks: { id: string, file: string, block: unknown }[]
  /** 每个块最后一次真正采到的时间（ISO）。 */
  at: Record<string, string>
}

/**
 * 缓存文件路径。
 *
 * 与 `patrol/` 同级（就是插件数据根下），与旧项目的
 * `profiles/<profile>/data/workbench/patrol-cache.json` 同一个位置口径。
 * 不复用 `dataRoot()`：它没导出，而 `patrolDir()` 的父目录就是它。
 * @returns 绝对路径。
 */
export function patrolCacheFile(): string {
  return join(patrolDir(), '..', 'patrol-cache.json')
}

/**
 * 读缓存。
 *
 * ⚠️ **坏档 / 不存在 / 形状不对一律当空缓存**，不抛 —— 缓存是「补偿」，
 * 不是数据真相；它坏了不该让整条路由报错（否则一个临时文件就能让总览整块空掉）。
 * @returns 缓存（坏档时是空缓存）。
 */
async function readCache(): Promise<PatrolCache> {
  try {
    const raw = JSON.parse(await readFile(patrolCacheFile(), 'utf8')) as Partial<PatrolCache>
    const blocks = Array.isArray(raw.blocks)
      ? raw.blocks.filter((b): b is { id: string, file: string, block: unknown } =>
        typeof b === 'object' && b !== null
        && typeof (b as { id?: unknown }).id === 'string' && (b as { id: string }).id !== ''
        && typeof (b as { file?: unknown }).file === 'string')
      : []
    const at = typeof raw.at === 'object' && raw.at !== null && !Array.isArray(raw.at)
      ? raw.at as Record<string, string> : {}
    return { blocks, at }
  } catch {
    return { blocks: [], at: {} }
  }
}

/**
 * 写缓存。
 *
 * ⚠️ **写失败吞掉**（留一行日志）：磁盘满、目录只读、文件被占用都可能，
 * 而它们都不该让「读巡查结果」这件事失败 —— 用户要的是数据，不是缓存落盘成功。
 * @param cache - 要写的缓存。
 */
async function writeCache(cache: PatrolCache): Promise<void> {
  try {
    await writeFile(patrolCacheFile(), JSON.stringify(cache, null, 1), 'utf8')
  } catch (e) {
    console.warn('[patrol] 补偿缓存写失败（不影响本次返回）：' + (e instanceof Error ? e.message : String(e)))
  }
}

/**
 * 读一次巡查结果（三栏 + 块级补偿，票 14）。
 *
 * @returns 三栏与补偿信息（目录不存在时 `items` 与 `broken` 空、`missing` 是全部 5 份）。
 */
export async function readPatrolResults(): Promise<PatrolResults> {
  const root = patrolDir()
  /* 目录列一次就够：名单里只有 5 个文件，逐个 `stat` 是 5 次磁盘调用，
   * 而且「目录不存在」要单独判 —— 那是「一次都没跑过」，不是错误。 */
  let present: Set<string>
  try {
    present = new Set(await readdir(root))
  } catch {
    present = new Set()
  }

  const cache = await readCache()
  const oldOf = new Map<string, { id: string, file: string, block: unknown }>()
  for (const one of cache.blocks) oldOf.set(one.id, one)
  const nextCache = new Map<string, { id: string, file: string, block: unknown }>()
  const nextAt: Record<string, string> = {}
  const compensated: string[] = []

  const items: PatrolResult[] = []
  const broken: PatrolBroken[] = []
  const missing: PatrolMissing[] = []

  for (const one of PATROL_RESULT_FILES) {
    /* 整份读不出来（不进 items）时走下面 `why !== null` 那条出口，
     * 那一条负责把这一份的旧块从缓存补回来。 */
    let raw: unknown = null
    let why: string | null = null

    if (!present.has(one.file)) {
      missing.push({ file: one.file, name: one.name })
      why = '文件不在'
    } else {
      const path = join(root, one.file)
      try {
        raw = JSON.parse(await readFile(path, 'utf8'))
        why = shapeWhy(raw)
      } catch (e) {
        /* 两种可能：文件读不了（权限、被占用）或不是合法 JSON。都是「有文件但读不出」，
         * 归 broken 不归 missing —— 用户该看的是「这份坏了」，不是「这份还没跑过」。 */
        why = '文件读不出或不是合法 JSON：' + (e instanceof Error ? e.message : String(e))
      }
      if (why !== null) broken.push({ file: one.file, name: one.name, why })
    }

    if (why !== null) {
      /* 整份坏了 / 不在 → **这一份的全部旧块从缓存补回来**（票 14 判据 4 / 5）。
       *
       * 不补的话，一份文件坏掉就等于「这个平台的数据突然全没了」，
       * 而缓存里明明有上一趟采到的数字。
       *
       * ⚠️ 这里**必须按 `file` 认**，不能「按这一轮没被认领的 id 认」：
       * 后者会把「另一份正常文件里被删掉的块」也算进来（那块的旧值不该复活）。
       * 旧项目用 `jobOf` 做这件事；我们把归属直接存进每一条缓存里（`file`），
       * 所以不需要第二张表。 */
      const back: unknown[] = []
      for (const old of cache.blocks) {
        if (old.file !== one.file) continue
        back.push(old.block)
        compensated.push(old.id)
        nextCache.set(old.id, old)
        const at = cache.at[old.id]
        if (typeof at === 'string' && at !== '') nextAt[old.id] = at
      }
      /* 补回来的块挂到一份「有块可挂」的条目上 —— 这一份本身进的是 broken / missing，
       * 它不在 items 里。做法：挂到同名单里第一份正常的那份上是不对的（平台会串），
       * 所以这里**新建一条只含旧块的条目**，`file` 仍是这一份，`ok` 记 null、
       * `runAt` / `dataDate` 取缓存里这个块的时间 —— 它表示「这份文件这次没读到，
       * 下面是它上次采到的数据」。界面据此能显示而不是整块空白。 */
      if (back.length > 0) {
        items.push({
          file: one.file,
          name: one.name,
          platform: one.platform,
          runAt: lastOf(back, cache, one.file) ?? '',
          dataDate: '',
          ok: null,
          error: why,
          blocks: back,
        })
      }
      continue
    }

    const obj = raw as Record<string, unknown>
    const runAt = obj.runAt as string
    const mergedBlocks: unknown[] = []
    for (const block of obj.blocks as unknown[]) {
      const id = blockId(block)
      if (id === '') { mergedBlocks.push(block); continue }
      const old = oldOf.get(id)
      if (blockState(block) === 'unknown' && old !== undefined) {
        /* 这一趟没采到 → 保留上次那块（票 14 判据 2）。
         * ⚠️ 块时间**不刷新** —— 它是「最后一次真正采到的时间」，不是这次跑的时间。 */
        mergedBlocks.push(old.block)
        compensated.push(id)
        nextCache.set(id, { id, file: one.file, block: old.block })
        const at = cache.at[id]
        if (typeof at === 'string' && at !== '') nextAt[id] = at
      } else {
        mergedBlocks.push(block)
        nextCache.set(id, { id, file: one.file, block })
        nextAt[id] = runAt
      }
    }
    items.push({
      file: one.file,
      name: one.name,
      /* 平台以文件里写的为准（它自己知道自己是哪个平台），文件没写才用名单里的。
       * 反过来（名单盖过文件）会让「文件写错平台」这类问题永远看不见。 */
      platform: typeof obj.platform === 'string' && obj.platform !== '' ? obj.platform : one.platform,
      runAt,
      dataDate: obj.dataDate as string,
      ok: typeof obj.ok === 'boolean' ? obj.ok : null,
      error: typeof obj.error === 'string' ? obj.error : null,
      blocks: mergedBlocks,
    })
  }

  /* 没被任何一份认领、但缓存里还留着的块（那一份文件这次既没坏也没少，
   * 只是这一趟没给出这些块）—— 一并留在缓存里，别丢。
   * 不往 `items` 里塞：那会在「正常的那一份」下面冒出上一趟才有的块，
   * 界面上的分组会与文件内容对不上。 */
  for (const old of cache.blocks) {
    if (nextCache.has(old.id)) continue
    nextCache.set(old.id, old)
    const at = cache.at[old.id]
    if (typeof at === 'string' && at !== '') nextAt[old.id] = at
  }

  await writeCache({ blocks: [...nextCache.values()], at: nextAt })
  return { items, broken, missing, compensated, blockAt: nextAt }
}

/**
 * 一份补回来的旧块里最晚的那个采到时间（给补偿条目的 `runAt` 用）。
 * @param back - 补回来的块。
 * @param cache - 缓存。
 * @param file - 归属文件。
 * @returns ISO 时间；都没有给 `null`。
 */
function lastOf(back: unknown[], cache: PatrolCache, file: string): string | null {
  const times = back
    .map(b => cache.at[blockId(b)])
    .filter((t): t is string => typeof t === 'string' && t !== '')
  if (times.length === 0) return null
  return times.sort().at(-1) ?? null
}

/**
 * 块的 id（取不到给空串）。
 * @param block - 块。
 * @returns id。
 */
function blockId(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const id = (block as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

/**
 * 块的 `state`（取不到给空串）。
 * @param block - 块。
 * @returns state。
 */
function blockState(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const s = (block as { state?: unknown }).state
  return typeof s === 'string' ? s : ''
}

/**
 * 形状对不对（对＝返回 `null`）。
 *
 * 判据三条：`blocks` 是非空数组、`runAt` 是非空字符串、`dataDate` 是非空字符串。
 * 缺哪条说哪条 —— 只说「形状不对」等于让用户自己去猜。
 *
 * ⚠️ **`ok: false` 不算形状错**：那是「这一趟巡查自己没成」，结果文件是合格的，
 * 里面照样有 `blocks`（`patrol-dy-qianchuan.json` 实测就是这样一个）。
 * 把失败的结果当坏文件，总览上就会少一块本该显示「余额不足」的数据。
 *
 * @param raw - 解析后的 JSON。
 * @returns 不对时给一句人话；对时 `null`。
 */
function shapeWhy(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return '顶层不是对象（JSON 里应该是一份结果，不是数组或一个值）'
  }
  const obj = raw as Record<string, unknown>
  const lacks: string[] = []
  if (!Array.isArray(obj.blocks) || obj.blocks.length === 0) {
    /* 单数 `block` 是本项目真实踩过的写法（`patrol-tm-activity.json`）。
     * 认出来就点名说，否则用户看到「blocks 不是非空数组」会以为自己找错文件了。 */
    lacks.push(typeof obj.block === 'object' && obj.block !== null
      ? 'blocks 不是非空数组（结果装在单数 block 里）'
      : 'blocks 不是非空数组')
  }
  if (typeof obj.runAt !== 'string' || obj.runAt === '') lacks.push('缺 runAt')
  if (typeof obj.dataDate !== 'string' || obj.dataDate === '') lacks.push('缺 dataDate')
  return lacks.length === 0 ? null : lacks.join('、')
}

/**
 * 这一份结果最后一次落盘的时间（ms）。
 *
 * 只为测试用：判据里有「这条路由不写盘」，做法是读之前与之后比一遍
 * 目录里每个文件的修改时间。生产代码不调它。
 *
 * @param file - 文件名。
 * @returns 修改时间；文件不在时 `null`。
 */
export async function patrolFileMtime(file: string): Promise<number | null> {
  try {
    return (await stat(join(patrolDir(), file))).mtimeMs
  } catch {
    return null
  }
}
