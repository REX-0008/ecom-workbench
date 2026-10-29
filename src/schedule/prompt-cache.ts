/** 提示词源的本地缓存（契约 CG，2026-10-26）。
 *
 * ## 它补的是哪个缺口
 *
 * 上一轮核查点名：`artifacts.ts:63` 的 `promptCacheDir()` **造好了没人写、没人读**
 * —— 只在 `/content/dirs` 的自检响应里露过一次面。计划 Step 6 说「拉下来缓存到
 * `prompt-cache/`」，而实际是「提示词库完全是内置快照 + 零网络」。
 *
 * 这个文件把它接上：按源 id 读写 `prompt-cache/<源id>.json`。
 *
 * ## 三层回落（用户 m01114 定的规矩）
 *
 * ```
 * ① 缓存文件（最新拉到的）
 *   ② 内置兜底副本（src/client/workbench/prompt-sources/ 里那五份）
 *     ③ 拉取失败 → 仍然是内置那份，并**明确说出**「用的是内置副本」
 * ```
 *
 * 第 ③ 条是要点：源挂了不能让人打不开提示词库，但**也不能让人以为看到的是最新的**
 * —— 所以读回来的结果里必须有个 `from` 字段说明来源，界面据此提示。
 *
 * ## 缓存写在哪、为什么不写进 `src/`
 *
 * `src/` 里的五份 JSON 是**兜底副本**（跟代码一起打包、换机不丢）；
 * `prompt-cache/` 是**缓存**（会过期、会清、能删）。两者不能混：
 * 把拉下来的最新数据写进 `src/` 就等于「改源码」，下次升级会被覆盖掉。
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promptCacheDir } from './artifacts.ts'
import {
  builtinSourceById,
  type BuiltinPromptSource, type PromptEntry,
} from '../client/workbench/prompt-sources/index.ts'
/* 配置层：哪些源要列出来、叫什么名、停用了没有、用户自己加了哪些。
 * ⚠️ **方向只能是这样**（配置 → 消费方）。`prompt-source-config.ts` 不 import 本文件，
 * 所以不成环。反过来就会成环。 */
import { listConfiguredSources } from './prompt-source-config.ts'

/**
 * 一个源的清单项（**不含 entries** —— 五个源共 800KB，清单页不该搬一遍）。
 */
export interface PromptSourceSummary {
  /** 源 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 上游地址。 */
  url: string
  /** 上游仓库主页。 */
  homepage: string
  /** 许可。 */
  license: string
  /** 当前能读到的条目数（缓存有就用缓存的，否则内置的）。 */
  count: number
  /** 上游原文的条目数。与 `count` 不等即表示「这是截断过的内置副本」。 */
  upstreamCount: number
  /** 这一份从哪来：`cache`（拉过）或 `builtin`（内置兜底）。 */
  from: SourceOrigin
  /** 什么时候拉的（只有 `from === 'cache'` 时才有）。 */
  fetchedAt?: number
  /** 启用没有（`false` 的源**不会出现在清单里**，这个字段只在诊断时用）。 */
  enabled: boolean
  /** 是不是内置的（内置删不掉只能停用；自定义的能删）。 */
  builtin: boolean
}

/**
 * 一份数据从哪来。
 *
 * - `cache`：从上游拉过，用缓存
 * - `builtin`：还没拉过，用内置兜底副本
 * - `custom`：**用户自己加的源**，没有内置副本可回落（还没拉过时就是空的）
 */
export type SourceOrigin = 'cache' | 'builtin' | 'custom'

/**
 * 这份缓存是不是「按另一个地址拉下来的」。
 *
 * ## 为什么要比这一下（2026-10-27，票 26）
 *
 * 缓存文件里本来就存了 `url`（拉的那一刻用的是哪个地址），但读的时候从来不看它。
 * 于是用户把源的地址从 A 改成 B 之后，`readSource` 照旧把 A 拉下来的内容回给
 * 提示词库，note 里只说「X 时间拉下来的缓存」—— 用户没有任何办法知道那份内容
 * 不是从现在的地址来的。
 *
 * 原来靠界面上一句「改过地址的要再点一次刷新」兜着。那是要用户记住一条隐性规则，
 * 而且他改了五个源里哪一个，自己也不记得。
 *
 * ## 两条刻意不判过期的情况
 *
 * - 配置里地址是空串：地址被清空之后旧缓存怎么算，没有定过，凭空加规则会造出
 *   没人验证过的说明。保持原行为。
 * - 缓存里 `url` 是空串：那说明这份缓存早于这个字段，无法证明它错，就不当它错。
 *
 * @param cached - 读到的缓存。
 * @param cfgUrl - 配置里现在的地址。
 * @returns 地址改过就 true。
 */
export function cacheIsStale(cached: CachedSource, cfgUrl: string): boolean {
  if (cfgUrl === '') return false
  if (cached.url === '') return false
  return cached.url !== cfgUrl
}

/** 缓存文件里的形状（就是 `BuiltinPromptSource` + 拉取时间）。 */
export interface CachedSource extends BuiltinPromptSource {
  /** 拉到的时间（ms）。 */
  fetchedAt: number
}

/** 读一个源的结果。 */
export interface ReadSourceResult {
  /** 源定义（含 entries）。 */
  source: CachedSource
  /** 这份从哪来。 */
  from: SourceOrigin
  /** 给人看的说明（`from === 'builtin'` 时写明「用的是内置副本」）。 */
  note?: string
}

/** id 的合法形状。**安全边界**：id 会进文件名。 */
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * 源 id 合不合法。
 * @param id - 待查 id。
 * @returns 合法为 true。
 */
export function isSourceId(id: string): boolean {
  return ID_OK.test(id)
}

/**
 * 问配置层「这个源现在算不算数」。
 *
 * @param id - 源 id。
 * @returns 配置项；**没有或已停用给 `null`**（这两种对消费方是一回事：不该出现）。
 */
async function configuredOrNull(id: string): Promise<{ name: string, url: string, builtin: boolean } | null> {
  const all = await listConfiguredSources()
  const one = all.find(s => s.id === id)
  if (one === undefined || !one.enabled) return null
  return { name: one.name, url: one.url, builtin: one.builtin }
}

/** 一个源的缓存文件路径。 */
function cacheFile(id: string): string {
  return join(promptCacheDir(), id + '.json')
}

/** 注入的 fetch（测试塞假响应；不给用全局）。 */
let fetchImpl: typeof fetch | undefined

/**
 * 换掉 fetch（**只给测试用**）。
 * @param next - 新的实现；传 `null` 恢复全局 fetch。
 */
export function setPromptCacheFetch(next: typeof fetch | null): void {
  fetchImpl = next ?? undefined
}

/**
 * 读一个缓存文件。
 *
 * @param id - 源 id。
 * @returns 缓存内容；没有 / 坏了 / id 非法给 `null`。
 */
export async function readCache(id: string): Promise<CachedSource | null> {
  if (!isSourceId(id)) return null
  let text: string
  try {
    text = await readFile(cacheFile(id), 'utf8')
  } catch { return null }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  return asCachedSource(parsed)
}

/**
 * 把磁盘上的东西归一成 `CachedSource`（**纯函数**，能单测）。
 *
 * 为什么要归一：缓存文件是外部可控的（用户可能手工改过），
 * 直接当 `CachedSource` 用会让界面读到 undefined 字段。这里只收能用的那条，
 * 其余的当「没有缓存」—— **不静默给个半残的对象**。
 *
 * @param raw - 磁盘上的原文。
 * @returns 归一后的缓存；形状不对给 `null`。
 */
export function asCachedSource(raw: unknown): CachedSource | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const id = typeof rec.id === 'string' ? rec.id : ''
  if (!isSourceId(id)) return null
  if (!Array.isArray(rec.entries)) return null
  const entries = rec.entries.filter((e): e is PromptEntry =>
    typeof e === 'object' && e !== null
    && typeof (e as Record<string, unknown>).id === 'string'
    && typeof (e as Record<string, unknown>).prompt === 'string')
  return {
    id,
    name: typeof rec.name === 'string' ? rec.name : id,
    url: typeof rec.url === 'string' ? rec.url : '',
    homepage: typeof rec.homepage === 'string' ? rec.homepage : '',
    license: typeof rec.license === 'string' ? rec.license : '',
    count: entries.length,
    upstreamCount: typeof rec.upstreamCount === 'number' ? rec.upstreamCount : entries.length,
    entries,
    fetchedAt: typeof rec.fetchedAt === 'number' ? rec.fetchedAt : 0,
  }
}

/**
 * 把内置副本包成 `CachedSource` 的形状（好让调用方不用分两条路取值）。
 *
 * @param src - 内置源。
 * @returns 缓存形状（`fetchedAt: 0` 表示「不是拉来的」）。
 */
function fromBuiltin(src: BuiltinPromptSource): CachedSource {
  return { ...src, entries: [...src.entries], fetchedAt: 0 }
}

/**
 * 读一个源：**缓存优先，没有就内置**；自定义源没有内置副本。
 *
 * ## 为什么先去问配置
 *
 * 「停用一个源」如果只改配置页上的一个开关，而这里照旧把内置那五个读出来，
 * 那停用就没有任何效果 —— 用户点了停用，提示词库里它还在。
 * 所以**清单与单条读取都必须以配置为准**：配置里没有（或停用了）就是 `null`。
 *
 * @param id - 源 id。
 * @returns 结果；id 非法、配置里没有、或已停用给 `null`。
 */
export async function readSource(id: string): Promise<ReadSourceResult | null> {
  if (!isSourceId(id)) return null
  const cfg = await configuredOrNull(id)
  if (cfg === null) return null

  const cached = await readCache(id)
  if (cached !== null && !cacheIsStale(cached, cfg.url)) {
    return {
      source: { ...cached, name: cfg.name !== '' ? cfg.name : cached.name },
      from: 'cache',
      note: '用的是 ' + new Date(cached.fetchedAt).toLocaleString('zh-CN') + ' 拉下来的缓存',
    }
  }
  const builtin = builtinSourceById(id)
  /* 缓存是拿另一个地址拉的（票 26 的甲 + 乙）。
   *
   * 有内置副本就回落（甲）：内置那份至少跟着代码走、能自我说明，
   * 比把几个月前的旧内容当成「现在的缓存」喂出去强。
   * 没有内置副本（自定义源）就留着旧内容（乙）：按甲只能回空清单，
   * 用户会以为「刚拉的东西没了」—— 那比旧一点更糟。
   *
   * 两句话都必须说出三件事：地址改过、这份内容从哪来、下一步做什么。 */
  if (cached !== null) {
    if (builtin !== undefined) {
      return {
        source: { ...fromBuiltin(builtin), name: cfg.name !== '' ? cfg.name : builtin.name },
        from: 'builtin',
        note: '源地址改过，原来拉的内容按旧地址算，这里用的是内置副本。点刷新会按新地址重新拉一次。',
      }
    }
    return {
      source: { ...cached, name: cfg.name !== '' ? cfg.name : cached.name },
      from: 'custom',
      note: '源地址改过，这份内容是从旧地址拉下来的。点刷新会按新地址重新拉一次。',
    }
  }
  if (builtin !== undefined) {
    return {
      source: { ...fromBuiltin(builtin), name: cfg.name !== '' ? cfg.name : builtin.name },
      from: 'builtin',
      /* 这句话必须说 —— 不说的话，用户以为看到的是上游最新的，
       * 而实际上可能是几个月前的截断副本。 */
      note: '用的是内置副本（还没有拉过上游）',
    }
  }
  /* 自定义源还没拉过：**没有内置副本可以回落**，所以给一份空的，并把原因说出来
   * —— 静默回一个空清单会让人以为这个源是坏的。
   *
   * ⚠️ 这句话只说「还没有内容 + 下一步做什么」，**不解释为什么没有内置副本**
   *    —— 那是给开发看的。用户要知道的是「拉一次就有」，不是「自定义源没有回落副本」。
   *
   * 📌 历史教训（2026-10-26）：这句曾经在括号里写「刷新只适用于内置那几份」意思的话。
   *    那半句在当时也是错的 —— 刷新早已按配置取地址，自定义源一样能拉。
   *    一句过期的解释让人误判了两次：一次是 lead 据此让界面别放刷新按钮，
   *    一次是那个按钮真的漏做了。**代码里一句假话，比文档写错更能把人带偏。** */
  return {
    source: {
      id, name: cfg.name !== '' ? cfg.name : id,
      url: cfg.url, homepage: '', license: '',
      count: 0, upstreamCount: 0, entries: [], fetchedAt: 0,
    },
    from: 'custom',
    note: '这个源是自定义的，还没有内容（刷新一次就有）',
  }
}

/**
 * 列所有源的清单（**不含 entries**）。
 *
 * ## 顺序与过滤都以配置为准（2026-10-26 自查后改）
 *
 * 旧写法只 `for` 一遍 `BUILTIN_PROMPT_SOURCES` —— 于是「提示词源可配」
 * 在这条路上完全不起作用：停用的照旧列出来，用户自己加的**一个都看不到**。
 * 现在遍历 `listConfiguredSources()`：它已经把内置套上用户改动、
 * 再把自定义的接在后面，顺序就是界面要的顺序。
 *
 * @returns 清单数组（停用的不在里面；全停用时是空数组）。
 */
export async function listSources(): Promise<PromptSourceSummary[]> {
  const out: PromptSourceSummary[] = []
  for (const cfg of await listConfiguredSources()) {
    if (!cfg.enabled) continue
    const cached = await readCache(cfg.id)
    const builtin = builtinSourceById(cfg.id)
    /* 缓存是拿另一个地址拉的：这一条也要跟着变质，否则「单条读取说实话、
     * 清单照旧把旧内容标成 cache」—— 同一个谎换个地方再说一遍。
     * 分岔与 `readSource` 逐条对齐：有内置副本用内置，没有就留旧内容但标成 custom。 */
    const stale = cached !== null && cacheIsStale(cached, cfg.url)
    const useCache = cached !== null && !stale
    /* 这一条最终拿哪份数据：地址改过且有内置副本 → 内置；其余情况缓存优先。 */
    const pick = stale && builtin !== undefined ? undefined : cached ?? undefined
    out.push({
      id: cfg.id,
      /* 名字以配置为准（用户可能改过）；没改过时配置里就是内置原名。 */
      name: cfg.name !== '' ? cfg.name : pick !== undefined ? pick.name : (builtin?.name ?? cfg.id),
      url: pick !== undefined && pick.url !== '' ? pick.url : cfg.url,
      homepage: builtin?.homepage ?? '',
      license: builtin?.license ?? '',
      count: pick !== undefined ? pick.count : builtin !== undefined ? builtin.count : 0,
      upstreamCount: pick !== undefined ? pick.upstreamCount : builtin !== undefined ? builtin.upstreamCount : 0,
      /* 自定义源没有内置副本可回落 → 来源是 `custom`（不是 `builtin`）。
       * 地址改过又没有内置副本 → 也是 `custom`：它此刻不代表配置里那个地址的内容。 */
      from: useCache ? 'cache' : builtin !== undefined && pick === undefined ? 'builtin' : 'custom',
      ...useCache ? { fetchedAt: cached.fetchedAt } : {},
      enabled: true,
      builtin: cfg.builtin,
    })
  }
  return out
}

/** 一次刷新拉取的结论。 */
export interface RefreshResult {
  /** 成功没有。 */
  ok: boolean
  /** 拉到了几条（成功时）。 */
  count?: number
  /** 什么时候拉的（成功时）。 */
  fetchedAt?: number
  /** 失败原因（失败时）。 */
  error?: string
  /** 失败时回落到哪一份（永远是 `builtin`）。 */
  fallback?: SourceOrigin
  /** 给人看的说明。 */
  note?: string
}

/**
 * 从上游拉一次，写进缓存。
 *
 * ## 失败时**不覆盖**已有缓存
 *
 * 这条很重要：缓存里有一份上周拉到的 200 条，这次上游挂了 ——
 * 把缓存清掉换成内置的 53 条，是**降级**而不是「保持一致」。
 * 所以失败一律不动缓存，只把原因报回去。
 *
 * @param id - 源 id。
 * @param doFetch - 注入的 fetch（不给就用模块级那份，再不给就全局）。
 * @returns 结论。
 */
export async function refreshSource(id: string, doFetch?: typeof fetch): Promise<RefreshResult> {
  if (!isSourceId(id)) return { ok: false, error: '源 id 不合法：' + id }
  /* 地址与名字**以配置为准**：内置的地址能被用户改过，自定义的地址只在配置里。
   * 旧写法硬取内置常量，于是「改了地址」和「自定义源」两条都拉不到东西。 */
  const cfg = await configuredOrNull(id)
  if (cfg === null) {
    const isKnown = builtinSourceById(id) !== undefined
    return {
      ok: false,
      error: isKnown ? '这个源已停用：' + id + '（要用它先在提示词源配置里启用）' : '没有这个源：' + id,
    }
  }
  const builtin = builtinSourceById(id)
  const targetUrl = cfg.url
  if (targetUrl === '') return { ok: false, error: '这个源没有配上游地址（它只用内置副本）' }

  const impl = doFetch ?? fetchImpl ?? fetch
  let res: Response
  try {
    res = await impl(targetUrl)
  } catch (e) {
    return {
      ok: false,
      error: '连不上上游：' + (e instanceof Error ? e.message : String(e)),
      ...(builtin !== undefined ? { fallback: 'builtin' as const, note: '用的是内置副本' } : {}),
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      error: '上游返回 ' + String(res.status),
      ...(builtin !== undefined ? { fallback: 'builtin' as const, note: '用的是内置副本' } : {}),
    }
  }

  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return {
      ok: false, error: '上游返回的不是合法 JSON',
      ...(builtin !== undefined ? { fallback: 'builtin' as const, note: '用的是内置副本' } : {}),
    }
  }
  /* 上游的形状：条目数组，或 `{entries:[...]}` / `{prompts:[...]}` 包一层。
   * 三种都认 —— 只认一种的话，换个源就「拉到了但读不出来」。 */
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null
      ? (Array.isArray((raw as Record<string, unknown>).entries) ? (raw as Record<string, unknown>).entries as unknown[]
        : Array.isArray((raw as Record<string, unknown>).prompts) ? (raw as Record<string, unknown>).prompts as unknown[] : [])
      : []
  if (list.length === 0) {
    return {
      ok: false, error: '上游一个条目都没给（形状不对或确实是空的）',
      ...(builtin !== undefined ? { fallback: 'builtin' as const, note: '用的是内置副本' } : {}),
    }
  }

  const entries = list.filter((e): e is PromptEntry =>
    typeof e === 'object' && e !== null
    && typeof (e as Record<string, unknown>).id === 'string'
    && typeof (e as Record<string, unknown>).prompt === 'string')

  if (entries.length === 0) {
    return {
      ok: false,
      error: '上游给了 ' + String(list.length) + ' 条，但没有一条符合形状（缺 id 或 prompt）',
      ...(builtin !== undefined ? { fallback: 'builtin' as const, note: '用的是内置副本' } : {}),
    }
  }

  const fetchedAt = Date.now()
  /* 名字与地址以**配置**为准（内置的可能被改过名；自定义源根本没有内置常量）。
   * `homepage` / `license` 只有内置源才有。 */
  const payload: CachedSource = {
    id,
    name: cfg.name !== '' ? cfg.name : (builtin?.name ?? id),
    url: targetUrl,
    homepage: builtin?.homepage ?? '',
    license: builtin?.license ?? '',
    count: entries.length,
    upstreamCount: entries.length,
    entries,
    fetchedAt,
  }
  await mkdir(promptCacheDir(), { recursive: true })
  await writeFile(cacheFile(id), JSON.stringify(payload), 'utf8')
  return {
    ok: true,
    count: entries.length,
    fetchedAt,
    note: '已从上游拉到 ' + String(entries.length) + ' 条并写进缓存',
  }
}

/**
 * 删掉一个源的缓存（回到内置副本）。
 *
 * 为什么要它：拉下来的缓存可能比内置的**少**（上游删了条目），
 * 界面要能提供「退回内置那份」的出口。
 *
 * @param id - 源 id。
 * @returns 删掉了就 true。
 */
export async function clearCache(id: string): Promise<boolean> {
  if (!isSourceId(id)) return false
  const s = await stat(cacheFile(id)).catch(() => null)
  if (s === null || !s.isFile()) return false
  const { unlink } = await import('node:fs/promises')
  await unlink(cacheFile(id))
  return true
}

/**
 * 缓存目录里现有哪些源（诊断用）。
 * @returns 源 id 数组。
 */
export async function cachedIds(): Promise<string[]> {
  let names: string[]
  try { names = await readdir(promptCacheDir()) } catch { return [] }
  return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length))
}
