/** 提示词源的可配置层（2026-10-26，T-B-后端）。
 *
 * ## 它补的是哪个缺口
 *
 * 用户原话：「配置里应有提示词库来源配置」。现在的五个源是**硬编码**在
 * `src/client/workbench/prompt-sources/index.ts` 里的常量，用户看不到、改不了、
 * 停不掉 —— 等于没有这个设置项。
 *
 * ## 三条规矩（缺一条都算没做）
 *
 * 1. **内置五个不能被删，只能停用**。
 *    删了下次升级又回来（内置副本跟代码一起打包），反而更乱 ——
 *    用户会看到「我明明删了它又出现了」。
 * 2. **用户能加自己的源**（名字 / 地址），能改，能停用。
 * 3. **每个源能测连通**（拉一次看通不通），失败要说清哪一步。
 *
 * ## 覆盖文件只存「差异」
 *
 * `prompt-sources.json` 里只存**用户改过的部分**：
 *
 * ```json
 * { "overrides": { "awesome-gpt-image": { "enabled": false } },
 *   "custom": [ { "id": "my-source", "name": "我的源", "url": "https://…" } ] }
 * ```
 *
 * 为什么不存整份：内置源的 `name` / `url` / `homepage` / `license` 会随上游更新，
 * 存一份快照就等于把它们冻住 —— 下次官方改了地址，用户那边还是旧的。
 * 只存差异，官方改了能跟着走。
 *
 * ## 关于 `export`（写给下一个看这个文件的人）
 *
 * `isPromptSourceId` / `readSourcesFile` / `saveSourcesFile` 这几个**生产代码不直接调**
 * （只在同文件内部用），`export` 出来是为了能单测形状与边界（非法 id、坏文件归一）。
 * 那是**有意的**，不是漏接线 —— 别因为「grep 不到调用方」就把它们收回去。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from './artifacts.ts'
import { BUILTIN_PROMPT_SOURCES, builtinSourceById } from '../client/workbench/prompt-sources/index.ts'

/** 文件名。 */
export const PROMPT_SOURCES_FILE = 'prompt-sources.json'

/** 一个源在配置面上的样子（**不含 entries** —— 那是 800KB 的东西，配置页不该搬）。 */
export interface PromptSourceConfig {
  /** 源 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 上游地址（拉取用；空串表示这个源只用来展示、不拉）。 */
  url: string
  /** 仓库主页。 */
  homepage: string
  /** 许可。 */
  license: string
  /** 启用没有。停用的源不参与提示词库。 */
  enabled: boolean
  /** 是不是内置的（内置的不能删，只能停用）。 */
  builtin: boolean
}

/** 用户对内置源的一处改动。 */
interface Override {
  /** 停用了没有。 */
  enabled?: boolean
  /** 改过的显示名。 */
  name?: string
  /** 改过的地址。 */
  url?: string
}

/** 用户自己加的源。 */
interface CustomSource {
  id: string
  name: string
  url: string
}

/** 覆盖文件的内容。 */
export interface SourcesFile {
  overrides?: Record<string, Override>
  custom?: CustomSource[]
}

/** id 的合法形状（会进文件名，所以是安全边界）。 */
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * id 合不合法。
 * @param id - 待查。
 * @returns 合法为 true。
 */
export function isPromptSourceId(id: string): boolean {
  return ID_OK.test(id)
}

/** 覆盖文件路径。 */
function sourcesFile(): string {
  return join(dataRoot(), PROMPT_SOURCES_FILE)
}

/**
 * 读覆盖文件。
 *
 * @returns 内容（文件不存在给空对象）。
 */
export async function readSourcesFile(): Promise<SourcesFile> {
  let text: string
  try {
    text = await readFile(sourcesFile(), 'utf8')
  } catch { return {} }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return {} }
  if (typeof parsed !== 'object' || parsed === null) return {}
  return parsed as SourcesFile
}

/**
 * 写覆盖文件。
 *
 * @param next - 要存的内容。
 * @returns 存好的内容。
 */
export async function saveSourcesFile(next: SourcesFile): Promise<SourcesFile> {
  const clean: SourcesFile = {}
  if (typeof next.overrides === 'object' && next.overrides !== null) {
    const ov: Record<string, Override> = {}
    for (const [id, one] of Object.entries(next.overrides)) {
      if (!isPromptSourceId(id) || typeof one !== 'object' || one === null) continue
      const rec: Override = {}
      if (typeof (one as Override).enabled === 'boolean') rec.enabled = (one as Override).enabled
      if (typeof (one as Override).name === 'string' && (one as Override).name !== '') rec.name = (one as Override).name
      if (typeof (one as Override).url === 'string') rec.url = (one as Override).url
      if (Object.keys(rec).length > 0) ov[id] = rec
    }
    if (Object.keys(ov).length > 0) clean.overrides = ov
  }
  if (Array.isArray(next.custom)) {
    const list: CustomSource[] = []
    for (const one of next.custom) {
      if (typeof one !== 'object' || one === null) continue
      const rec = one as unknown as Record<string, unknown>
      const id = typeof rec.id === 'string' ? rec.id.trim() : ''
      if (!isPromptSourceId(id)) continue
      /* 内置 id 不许被用户源占用 —— 否则两处同 id，读的时候谁赢说不清。 */
      if (builtinSourceById(id) !== undefined) continue
      const url = typeof rec.url === 'string' ? rec.url.trim() : ''
      if (url === '') continue
      list.push({
        id,
        name: typeof rec.name === 'string' && rec.name.trim() !== '' ? rec.name.trim() : id,
        url,
      })
    }
    if (list.length > 0) clean.custom = list
  }
  await mkdir(dataRoot(), { recursive: true })
  await writeFile(sourcesFile(), JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

/**
 * 列出配置面上全部源：内置五个（套上用户改动）+ 用户自加的。
 *
 * @returns 清单（内置在前、自定义在后，各自保持原顺序）。
 */
export async function listConfiguredSources(): Promise<PromptSourceConfig[]> {
  const file = await readSourcesFile()
  const ov = file.overrides ?? {}
  const out: PromptSourceConfig[] = []

  for (const b of BUILTIN_PROMPT_SOURCES) {
    const patch = ov[b.id] ?? {}
    out.push({
      id: b.id,
      name: patch.name ?? b.name,
      /* `url` 允许被清成空串（= 不拉上游、只用内置副本），所以这里用 `??` 而不是 `||`。 */
      url: patch.url ?? b.url,
      homepage: b.homepage,
      license: b.license,
      enabled: patch.enabled ?? true,
      builtin: true,
    })
  }

  for (const c of file.custom ?? []) {
    out.push({
      id: c.id, name: c.name, url: c.url,
      homepage: '', license: '',
      enabled: true, builtin: false,
    })
  }
  return out
}

/**
 * 改一个源（**内置也能改，但改的是覆盖层，不动内置常量**）。
 *
 * @param id - 源 id。
 * @param patch - 要改的项（`enabled` / `name` / `url`）。
 * @returns 改后的清单；找不到这个源给 `{ ok: false, error }`。
 */
export async function updateSource(
  id: string, patch: { enabled?: boolean, name?: string, url?: string },
): Promise<{ ok: true, sources: PromptSourceConfig[] } | { ok: false, error: string }> {
  if (!isPromptSourceId(id)) return { ok: false, error: '源 id 不合法：' + id }
  const file = await readSourcesFile()

  const isBuiltin = builtinSourceById(id) !== undefined
  if (isBuiltin) {
    const ov = { ...(file.overrides ?? {}) }
    const cur = { ...(ov[id] ?? {}) }
    if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled
    if (typeof patch.name === 'string') cur.name = patch.name
    if (typeof patch.url === 'string') cur.url = patch.url
    ov[id] = cur
    file.overrides = ov
  } else {
    const list = file.custom ?? []
    const at = list.findIndex(c => c.id === id)
    if (at < 0) return { ok: false, error: '没有这个源：' + id }
    /* 自定义源的 `enabled` 没有单独字段（存在就是启用）。要停用就删掉 ——
     * 与内置的「停用但不删」不同：自定义的是用户自己加的，删了不会自己回来。 */
    if (patch.name !== undefined && patch.name !== '') list[at] = { ...list[at], name: patch.name }
    if (patch.url !== undefined && patch.url !== '') list[at] = { ...list[at], url: patch.url }
    file.custom = list
  }

  await saveSourcesFile(file)
  return { ok: true, sources: await listConfiguredSources() }
}

/**
 * 加一个用户自己的源。
 *
 * @param input - `{ id?, name, url }`。
 * @returns 加后的清单；不成立给错。
 */
export async function addSource(
  input: { id?: string, name?: string, url?: string },
): Promise<{ ok: true, sources: PromptSourceConfig[] } | { ok: false, error: string }> {
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (url === '') return { ok: false, error: '源地址不能为空' }
  const id = (typeof input.id === 'string' && input.id.trim() !== '')
    ? input.id.trim()
    : 'src_' + Math.random().toString(36).slice(2, 10)
  if (!isPromptSourceId(id)) return { ok: false, error: '源 id 只能用字母、数字、下划线、点、短横线：' + id }
  if (builtinSourceById(id) !== undefined) {
    return { ok: false, error: '这个 id 是内置源的名（' + id + '）：内置的不能改名占用，换一个 id' }
  }
  const file = await readSourcesFile()
  const list = file.custom ?? []
  if (list.some(c => c.id === id)) return { ok: false, error: '已经有这个源了：' + id }
  list.push({
    id,
    name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : id,
    url,
  })
  file.custom = list
  await saveSourcesFile(file)
  return { ok: true, sources: await listConfiguredSources() }
}

/**
 * 删一个源。
 *
 * ⚠️ **内置的删不掉**，会明确报错并告诉调用方改用停用 ——
 * 静默「删了但下次升级又回来」是更糟的一种结果。
 *
 * @param id - 源 id。
 * @returns 删后的清单。
 */
export async function deleteSource(
  id: string,
): Promise<{ ok: true, sources: PromptSourceConfig[] } | { ok: false, error: string, builtin?: boolean }> {
  if (!isPromptSourceId(id)) return { ok: false, error: '源 id 不合法：' + id }
  if (builtinSourceById(id) !== undefined) {
    return {
      ok: false, builtin: true,
      error: '「' + id + '」是内置源，删不掉（内置副本跟代码一起打包，删了下次升级还会回来）。'
        + '不想用它就停用：把 enabled 改成 false。',
    }
  }
  const file = await readSourcesFile()
  const list = (file.custom ?? []).filter(c => c.id !== id)
  if (list.length === (file.custom ?? []).length) return { ok: false, error: '没有这个源：' + id }
  file.custom = list
  await saveSourcesFile(file)
  return { ok: true, sources: await listConfiguredSources() }
}

/** 测一个源通不通的结论。 */
export interface ProbeResult {
  /** 通没通。 */
  ok: boolean
  /** 拿到的条目数（成功时）。 */
  count?: number
  /** HTTP 状态码。 */
  status?: number
  /** 问的地址。 */
  url?: string
  /** 失败原因（失败时给一句人话）。 */
  error?: string
}

/**
 * 测一个源通不通：拉一次，只数条目、不落盘。
 *
 * 「只数条目」是有意的：测试连通的目标是「地址对不对、是不是那个结构」，
 * 不是刷新数据。真刷新走 `/prompt-sources/:id/refresh`（那条会写缓存）。
 *
 * @param id - 源 id。
 * @param doFetch - 注入的 fetch。
 * @returns 结论。
 */
export async function probeSource(id: string, doFetch?: typeof fetch): Promise<ProbeResult> {
  const all = await listConfiguredSources()
  const one = all.find(s => s.id === id)
  if (one === undefined) return { ok: false, error: '没有这个源：' + id }
  if (one.url === '') return { ok: false, error: '这个源没有配地址，探不了（它只用内置副本）' }

  const impl = doFetch ?? fetch
  let res: Response
  try {
    res = await impl(one.url)
  } catch (e) {
    return {
      ok: false, url: one.url,
      error: '连不上：' + (e instanceof Error ? e.message : String(e))
        + '。检查地址写对没有、网络通不通。',
    }
  }
  if (!res.ok) {
    return {
      ok: false, url: one.url, status: res.status,
      error: 'HTTP ' + String(res.status) + '：' + (res.status === 404
        ? '这个地址没有东西（404）—— 检查地址末尾有没有落文件、仓库改名没有。'
        : '上游拒绝了这次请求。'),
    }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    return {
      ok: false, url: one.url, status: res.status,
      error: '回的不是 JSON（' + (e instanceof Error ? e.message : String(e)) + '）：'
        + '这个地址多半是一个网页，不是提示词 JSON。',
    }
  }
  if (!Array.isArray(body)) {
    return {
      ok: false, url: one.url, status: res.status,
      error: '回的是 JSON 但不是一个数组：这个源要求顶层是条目数组，实际是 '
        + (typeof body === 'object' && body !== null ? '一个对象' : typeof body) + '。',
    }
  }
  return { ok: true, count: body.length, status: res.status, url: one.url }
}
