/** 内容目录可改（2026-10-26，T-B-后端）。
 *
 * ## 它补的是哪个缺口
 *
 * 用户原话：「配置里应有…本地存储目录」。而 `/content/dirs` 只**回**路径，
 * 界面无处显示、无处修改 —— 数据全在插件数据目录里，换块大盘就得手工搬。
 *
 * ## 能改的只有**内容目录**，不是数据根
 *
 * 五个内容目录（画布 / 产物 / 素材 / 生成记录 / 提示词缓存）允许指到别处。
 * **`channels.json`、`model-defaults.json` 这些配置不动** —— 它们是「这个插件怎么配」，
 * 必须留在数据根：跟着内容跑会让「换盘」变成「换配置」，换回去还得再配一遍渠道。
 *
 * ## 三条纪律
 *
 * 1. **改之前先验可写**：目录不存在就建，建完写一个临时文件再删。
 *    验不过就**不改**，并说清是哪一格、为什么。
 *    「改完才发现写不进去」是这一条要防的事 —— 那时用户已经以为改好了。
 * 2. **不搬旧文件**。改路径不改数据位置，说清楚：改完新产物进新目录，
 *    老产物还在老目录，界面上按各自的路径取。假装「自动搬家」比不搬更糟
 *    （搬一半失败会留下两份互不相认的数据）。
 * 3. **热生效，不用重启**。目录是每次调用现算的（见 `artifacts.ts` 里那几个函数），
 *    所以存完下一次写盘就进新目录。
 *    ⚠️ 但**重启之后要重新套一次**：那次现算读的是内存里的覆盖表，内存重启就空了。
 *    `applyStorageConfig()` 就是跨那道桥的唯一入口，必须在 `apply` 里调
 *    （它一度写完没人调 —— 用户改了目录、一重启全回默认，而 `storage.json` 明明还在）。
 *
 * ## 关于 `export`（写给下一个看这个文件的人）
 *
 * `checkDir` / `effectiveDirs` 这两个生产代码不直接调（只在本文件内部被
 * `saveStorageConfig` / `dirsSummary` 用），`export` 只为单测边界：
 * 空路径、相对路径、指到文件而不是目录、目录不可写各是什么话；以及五个键里
 * 只覆盖了一部分时，其余几个回落到哪里。
 * 那是有意的，不是漏接线 —— 别因为「grep 不到跨文件调用方」就把它们收回去，
 * 删了会让这些断言只能靠端到端跑。
 */
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { dataRoot, setDirOverrides, currentDirOverrides } from './artifacts.ts'

/** 文件名（留在数据根，跟配置一起）。 */
export const STORAGE_FILE = 'storage.json'

/** 五个可改的目录键。 */
export const STORAGE_KEYS = ['canvases', 'artifacts', 'materials', 'genLogs', 'promptCache'] as const

/** 目录键。 */
export type StorageKey = typeof STORAGE_KEYS[number]

/** 键 → 中文名（报错时说人话）。 */
const KEY_LABEL: Record<StorageKey, string> = {
  canvases: '画布',
  artifacts: '产物',
  materials: '素材',
  genLogs: '生成记录',
  promptCache: '提示词缓存',
}

/** 一份目录配置（只有改过的键）。 */
export type StorageConfig = Partial<Record<StorageKey, string>>

/** 配置文件路径。 */
function storageFile(): string {
  return join(dataRoot(), STORAGE_FILE)
}

/**
 * 读配置文件，**并报出「文件在但读不出来」的原因**。
 *
 * ## 为什么要把「没有文件」与「文件坏了」分开
 *
 * 从没改过目录的用户根本没有 `storage.json` —— 那是**正常情况**，安静地用默认目录就对。
 * 但如果文件存在却读不出来（JSON 写坏了、权限不对），**必须说出来**：
 * 否则界面显示的是默认目录、用户以为改过的配置丢了，而真实原因是那一次读失败。
 * 这两种情况在旧写法里都是 `{}`，静默吞掉了后者。
 *
 * @returns 配置，以及（仅当文件在却读不出来时）一句原因。
 */
async function readStorageConfigDetailed(): Promise<{ config: StorageConfig, problem?: string }> {
  let text: string
  try {
    text = await readFile(storageFile(), 'utf8')
  } catch (e) {
    const code = (e as { code?: string }).code ?? ''
    /* 没有文件 = 从没配过，正常。 */
    if (code === 'ENOENT') return { config: {} }
    return { config: {}, problem: '存储目录配置读不出来（' + code + '）：' + storageFile() }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { config: {}, problem: '存储目录配置不是合法 JSON（先按默认目录走）：' + storageFile() }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { config: {}, problem: '存储目录配置顶层不是一个对象（先按默认目录走）：' + storageFile() }
  }
  const rec = parsed as Record<string, unknown>
  const out: StorageConfig = {}
  for (const k of STORAGE_KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return { config: out }
}

/**
 * 读配置文件（**不套用**，只读内容）。
 * @returns 配置（文件不存在给空对象）。
 */
export async function readStorageConfig(): Promise<StorageConfig> {
  return (await readStorageConfigDetailed()).config
}

/** 启动时套用配置的结论。 */
export interface StorageApplyResult {
  /** 套用了什么。 */
  config: StorageConfig
  /** 文件在却读不出来时的原因（正常情况没有这个字段）。 */
  problem?: string
}

/**
 * 把配置**套用**进 `artifacts.ts`（进程内立即生效）。
 *
 * ⚠️ **必须在插件启动时调一次**（`src/index.ts` 的 `apply`）：
 * 目录是每次调用现算的，但「现算」读的是内存里的覆盖表 ——
 * 不套一次的话，重启后覆盖表是空的，用户改过的目录全部回到默认，
 * 而 `storage.json` 明明还在盘上。这个函数就是那道唯一没人跨过的桥。
 *
 * @returns 套用了什么，以及（仅当文件坏了）一句原因。
 */
export async function applyStorageConfig(): Promise<StorageApplyResult> {
  const got = await readStorageConfigDetailed()
  setDirOverrides(got.config)
  return got.problem === undefined ? { config: got.config } : { config: got.config, problem: got.problem }
}

/** 一次校验的结论。 */
export interface CheckDirResult {
  /** 这一格能不能用。 */
  ok: boolean
  /** 最终路径（`ok` 时为绝对路径）。 */
  path?: string
  /** 不通的原因（`ok:false` 时给一句人话）。 */
  error?: string
}

/**
 * 验一个目录：存在就建、建完写一个临时文件再删。
 *
 * ## 为什么必须真写一次
 *
 * `access(dir, W_OK)` 在 Windows 上**不可靠**（它会看只读属性，而真正的写入还要
 * 看 ACL、磁盘满不满、目录是不是网络盘断了）。所以这里真写一个临时文件 ——
 * 那是唯一能确定「以后产物存得进来」的证据。
 *
 * @param raw - 用户给的路径。
 * @returns 结论。
 */
export async function checkDir(raw: string): Promise<CheckDirResult> {
  const path = String(raw ?? '').trim()
  if (path === '') return { ok: false, error: '路径不能为空' }
  if (!isAbsolute(path)) {
    /* 相对路径不许：进程的工作目录会随启动方式变（桌面端与兜底 CLI 不同），
     * 相对路径今天指这里、明天指那里，产物就散了。 */
    return { ok: false, error: '要写完整路径（形如 D:\\ecom\\artifacts），不要用相对路径：' + path }
  }
  const abs = resolve(path)
  try {
    await mkdir(abs, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      error: '建不出这个目录：' + abs + '（' + (e instanceof Error ? e.message : String(e)) + '）',
    }
  }
  /* 真写一次。文件名带随机后缀，避免与真实产物撞名。 */
  const probe = join(abs, '.ewb-write-test-' + Math.random().toString(36).slice(2, 8))
  try {
    await writeFile(probe, 'ok', 'utf8')
    await unlink(probe)
  } catch (e) {
    return {
      ok: false,
      error: '这个目录写不进去：' + abs + '（' + (e instanceof Error ? e.message : String(e))
        + '）。换一个可写的位置，或先把目录的权限改掉。',
    }
  }
  /* 读一次（有些网络盘能写不能列，列不出来以后读文件也会怪）。 */
  try {
    await access(abs)
  } catch {
    return { ok: false, error: '这个目录读不到：' + abs }
  }
  return { ok: true, path: abs }
}

/**
 * 存目录配置（**先逐格校验，有一格不过就整份不存**）。
 *
 * 为什么不「能存的先存」：那种半套配置最难查 —— 用户以为全改了，
 * 而其中一格还是老路径，产物一半进新盘一半进旧盘。
 *
 * @param input - 要改的键（给空串 = 恢复默认；没给的键保持不变）。
 * @returns 存好的完整配置；有错给错（并说明是哪一格）。
 */
export async function saveStorageConfig(
  input: Record<string, unknown>,
): Promise<{ ok: true, config: StorageConfig, dirs: Record<StorageKey, string> } | { ok: false, error: string, key?: string }> {
  const before = await readStorageConfig()
  const next: StorageConfig = { ...before }

  for (const key of STORAGE_KEYS) {
    const raw = input[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string') {
      return { ok: false, key, error: '「' + KEY_LABEL[key] + '」的路径要是字符串' }
    }
    if (raw.trim() === '') {
      /* 空串 = 回到默认（数据根下那一格）。 */
      delete next[key]
      continue
    }
    const checked = await checkDir(raw)
    if (!checked.ok) {
      return { ok: false, key, error: '「' + KEY_LABEL[key] + '」：' + (checked.error ?? '校验没通过') }
    }
    next[key] = checked.path as string
  }

  await mkdir(dataRoot(), { recursive: true })
  await writeFile(storageFile(), JSON.stringify(next, null, 2), 'utf8')
  /* 存完立刻套用 —— 热生效，不等重启。 */
  setDirOverrides(next)
  return { ok: true, config: next, dirs: effectiveDirs() }
}

/**
 * 现在**实际生效**的五个目录（改过的用改的，没改的用默认）。
 *
 * @returns 五个绝对路径。
 */
export function effectiveDirs(): Record<StorageKey, string> {
  const ov = currentDirOverrides()
  const def: Record<StorageKey, string> = {
    canvases: join(dataRoot(), 'canvases'),
    artifacts: join(dataRoot(), 'artifacts'),
    materials: join(dataRoot(), 'materials'),
    genLogs: join(dataRoot(), 'gen-logs'),
    promptCache: join(dataRoot(), 'prompt-cache'),
  }
  const out = { ...def }
  for (const k of STORAGE_KEYS) {
    const custom = (ov as Record<string, string | undefined>)[k]
    if (custom !== undefined && custom !== '') out[k] = custom
  }
  return out
}

/**
 * 给界面用的一份摘要：每一格「现在在哪、是不是改过、默认在哪」。
 * @returns 摘要。
 */
export function dirsSummary(): {
  key: StorageKey, label: string, path: string, isDefault: boolean, defaultPath: string,
}[] {
  const ov = currentDirOverrides()
  const now = effectiveDirs()
  return STORAGE_KEYS.map((key) => {
    const defaultPath = join(dataRoot(), key === 'genLogs' ? 'gen-logs' : key === 'promptCache' ? 'prompt-cache' : key)
    const custom = (ov as Record<string, string | undefined>)[key]
    return {
      key, label: KEY_LABEL[key], path: now[key],
      isDefault: custom === undefined || custom === '',
      defaultPath,
    }
  })
}
