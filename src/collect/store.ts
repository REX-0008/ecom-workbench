/** 收藏：目录配置、skill 扫描、备注读写、搬移（宿主半）。
 *
 * ## 这个模块干什么
 *
 * 「收藏」板块用来**记录、备忘**暂时用不上的好东西，不是管理它们。三类内容：
 *   - **skill**：有文件（`SKILL.md`）。可读正文预览；可在「已安装 ⇄ 收藏」之间**搬移**。
 *   - **dsh 插件 / GitHub 项目**：没有文件，纯「名称 + 备注 + 可选地址」，只记。
 *
 * ## 两侧目录都是**可配置的多根**（用户 2026-10-11 定）
 *
 * 默认值：
 * ```
 * 已安装：$DSH_HOME/skills/                                    ← dsh 自己从这里读
 * 收藏：  $DSH_HOME/profiles/<profile>/data/ecom-workbench/collect/skills/
 * ```
 * 两侧都可以再加别的根（照 dsh 自己的 `customSkillDirs` 做法 —— 有人会把 skill
 * 放在项目目录或云盘里）。配置写在 `notes.json` 的 `roots` 字段，不另开文件。
 *
 * **为什么「搬出去 = 模型看不到」**：dsh 的 skill 加载器把 `$DSH_HOME/skills` 当根扫
 * （`refs/deepseek-harness@62962ee4/packages/skill/skill-filesystem/src/index.ts:257`），
 * 不在它那些根下的目录不进候选。所以搬移有真实效果 —— 这正是用户
 * 「放在这里考虑是否要启用」的意思。
 *
 * ## 三条安全线
 *
 * 1. **搬移只在「两侧的根」之间**，名字先过 `isSafeSkillName`（挡 `..` 与分隔符），
 *    绝不接受调用方给的任意路径。
 * 2. **目标同名则拒绝**，不覆盖。
 * 3. **备注的键用 skill 名，不用路径** —— 搬移换目录但名字不变，备注得跟着走。
 *
 * ## 测试沙箱
 *
 * 沿用工作流存档那套：`EWB_TEST_HOME` 优先，另有 `EWB_TEST_SKILLS` 覆盖「已安装」
 * 的**默认根** —— 否则测试会真的去动用户的 skill 目录（红线）。
 * 注意：用户手工加的额外根不受沙箱约束（那是他自己的配置）。
 */
import { readFile, writeFile, mkdir, readdir, rename, cp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 插件数据目录名（与 `src/workflow/store.ts` 保持一致）。 */
const PLUGIN_DIR = 'ecom-workbench'
/** 收藏数据在插件数据目录下的子目录名。 */
const COLLECT_DIR = 'collect'
/** 收藏的 skill 文件放的默认子目录名。 */
const COLLECT_SKILLS_DIR = 'skills'
/** 备注文件名（目录配置也存在这份里，不另开文件）。 */
const NOTES_FILE = 'notes.json'
/** 搬移前备份的目录名。 */
const BACKUP_DIR = '.backup'
/** 备份最多保留几份（防无限增长）。 */
const BACKUP_KEEP = 20

/** 一次搬移的方向。 */
export type MoveDirection = 'collect' | 'install'

/** 一条备注（skill / 插件 / 项目共用同一形状）。 */
export interface Note {
  /** 可选：GitHub 等项目地址（用户说非必要）。 */
  repo?: string
  /** 自己的备忘说明。 */
  note?: string
  /**
   * 分类（**用户 2026-10-11 要求**）。
   *
   * 只对 Github 项目用。分类值**存在数据里**而不是写死在代码里：
   * 分类归属是用户自己的判断，他会调；界面只决定**显示顺序**。
   *
   * 现有 5 类（用户要求「分类不要太多」）：
   *   Agent 与 Skill ｜ 采集与搜索 ｜ 内容与设计 ｜ 实用工具 ｜ 学习参考
   */
  category?: string
}

/** 两侧的 skill 根目录配置（都可为空数组 = 用默认）。 */
export interface RootConfig {
  /** 「已安装」侧的额外/替代根。 */
  installed?: string[]
  /** 「收藏」侧的根。 */
  collected?: string[]
}

/** 备注表（唯一需要写盘的数据）。 */
export interface Notes {
  /** 目录配置（缺省时用默认根）。 */
  roots?: RootConfig
  /** skill 备注：**键是 skill 名**（不是路径）——搬移换目录但名字不变，备注要跟着走。 */
  skills: Record<string, Note>
  /** 插件备注（无文件，用户手输）。 */
  plugins: ({ name: string } & Note)[]
  /** GitHub 项目备注（无文件，用户手输）。 */
  projects: ({ name: string } & Note)[]
}

/**
 * 解析插件数据根（收藏数据的家）。
 *
 * 与 `workflowsDir` 同一套规则：测试沙箱优先，其次 dsh 数据目录，最后退回用户主目录。
 *
 * @param dshHome - 数据根（测试可注入）。
 * @param profile - profile 名（测试可注入）。
 * @returns 绝对路径。
 */
export function collectRoot(dshHome?: string, profile?: string): string {
  const sandbox = process.env.EWB_TEST_HOME
  if (sandbox !== undefined && sandbox !== '') return join(sandbox, COLLECT_DIR)
  const home = dshHome ?? process.env.DSH_HOME
  if (home !== undefined && home !== '') {
    const prof = profile ?? process.env.DSH_PROFILE ?? 'desktop'
    return join(home, 'profiles', prof, 'data', PLUGIN_DIR, COLLECT_DIR)
  }
  return join(homedir(), '.ecom-workbench', COLLECT_DIR)
}

/** 解析选项（测试与路由都传它）。 */
export interface Opts {
  /** 数据根（测试可注入）。 */
  dshHome?: string
  /** profile 名（测试可注入）。 */
  profile?: string
  /** 已解析的备注表（路由已读一次时传进来，避免重复读盘）。 */
  notes?: Notes
}

/**
 * 「收藏」侧的默认根。
 * @param opts - 解析选项。
 * @returns 绝对路径。
 */
function defaultCollectedRoot(opts: Opts): string {
  return join(collectRoot(opts.dshHome, opts.profile), COLLECT_SKILLS_DIR)
}

/**
 * 「已安装」侧的默认根（dsh 自己读的那个）。
 * @param opts - 解析选项。
 * @returns 绝对路径。
 */
function defaultInstalledRoot(opts: Opts): string {
  const sandbox = process.env.EWB_TEST_SKILLS
  if (sandbox !== undefined && sandbox !== '') return sandbox
  const home = opts.dshHome ?? process.env.DSH_HOME
  return join(home !== undefined && home !== '' ? home : homedir(), 'skills')
}

/**
 * 取一侧的全部根目录。
 *
 * 配置为空（或没配）时用默认根；配了就用配的 —— 不把默认根混进去，
 * 否则用户想去掉默认根也去不掉。
 *
 * @param side - 哪一侧。
 * @param opts - 解析选项。
 * @returns 根目录列表（至少一个）。
 */
export function sideRoots(side: 'installed' | 'collected', opts: Opts = {}): string[] {
  const configured = (opts.notes ?? { roots: undefined }).roots?.[side]
  if (Array.isArray(configured) && configured.length > 0) return configured
  return [side === 'installed' ? defaultInstalledRoot(opts) : defaultCollectedRoot(opts)]
}

/**
 * 校验一个 skill 名是不是**安全的一层目录名**。
 *
 * **这是安全边界**：搬移会拼路径，名字里带 `..` 或分隔符就能写到目录外面去。
 *
 * @param name - 待校验的名字。
 * @returns 安全则 true。
 */
export function isSafeSkillName(name: string): boolean {
  if (typeof name !== 'string') return false
  const n = name.trim()
  if (n === '' || n === '.' || n === '..') return false
  if (n.includes('/') || n.includes('\\')) return false
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) return false
  return n.length <= 120
}

/**
 * 从 `SKILL.md` 的 frontmatter 里取我们关心的字段。
 *
 * 解析的字段（**与 dsh 自己的口径对齐**，依据
 * `refs/.../packages/skill/skill-filesystem/src/index.ts:1000-1010` 的 `parseInvocationPolicy`）：
 *   - `name` / `description`：显示用；
 *   - **`disable-model-invocation`**：为 true 时 dsh 把它从**面向模型的目录**里排除，
 *     只有用户用 `/技能名` 才能触发。→ 界面上就是「仅用户」；
 *   - `user-invocable`：为 false 时从**面向用户的命令**里排除（省略 = 允许）。
 *     两者组合出四种，我们只区分「agent 能不能用」这一件最要紧的事。
 *
 * ⚠️ 取值规则照 dsh：YAML 布尔，另外接受大小写不敏感的
 * `true/false`、`yes/no`、`on/off`、`1/0`。**不是**布尔就当作没写
 * （dsh 那边是报错丢弃整个 skill；我们只做显示，宽松处理即可）。
 *
 * @param text - SKILL.md 全文。
 * @returns 解析到的字段（可能为空对象）。
 */
export function parseSkillFrontmatter(text: string): {
  name?: string
  description?: string
  /** `disable-model-invocation` 的解析结果（undefined = 没写）。 */
  disableModelInvocation?: boolean
  /** `user-invocable` 的解析结果（undefined = 没写）。 */
  userInvocable?: boolean
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (m === null) return {}
  const body = m[1]
  const out: {
    name?: string
    description?: string
    disableModelInvocation?: boolean
    userInvocable?: boolean
  } = {}
  for (const field of ['name', 'description'] as const) {
    const line = new RegExp('^' + field + '\\s*:\\s*(.+)$', 'm').exec(body)
    if (line === null) continue
    let v = line[1].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (v !== '') out[field] = v
  }
  const bool = (key: string): boolean | undefined => {
    const line = new RegExp('^' + key + '\\s*:\\s*(\\S+)\\s*$', 'm').exec(body)
    if (line === null) return undefined
    return parseYamlBool(line[1])
  }
  const dmi = bool('disable-model-invocation')
  if (dmi !== undefined) out.disableModelInvocation = dmi
  const ui = bool('user-invocable')
  if (ui !== undefined) out.userInvocable = ui
  return out
}

/**
 * 按 dsh 的口径解析一个 YAML 布尔值。
 * @param raw - 原始文本（如 `true` / `off` / `1`）。
 * @returns 布尔；认不出则 undefined。
 */
function parseYamlBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true
  if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false
  return undefined
}

/** 扫到的一个 skill。 */
export interface ScannedSkill {
  /** 目录名（也是搬移时用的名字）。 */
  name: string
  /** `SKILL.md` 里声明的名字（可能没有）。 */
  title?: string
  /** `SKILL.md` 里声明的描述（可能没有）。 */
  description?: string
  /** 它在哪一侧。 */
  where: 'installed' | 'collected'
  /** 它在哪个根下（多根时用来区分，也供界面显示来源）。 */
  root: string
  /**
   * **agent（模型）能不能用它**。
   *
   * 依据 `SKILL.md` 的 `disable-model-invocation`：写了 true 的会被 dsh 从
   * 面向模型的目录里排除，只有用户 `/技能名` 才能触发 —— 也就是「仅用户」。
   * 没写 = 默认允许（agent 可用）。
   */
  agentUsable: boolean
  /**
   * 用户能不能用（`/技能名` 触发）。`user-invocable: false` 时为 false。
   *
   * 与 `agentUsable` 组合出四种可能；界面目前只把「两个都不能用」当异常提示，
   * 其余按 agent 可用性着色。
   */
  userUsable: boolean
}

/**
 * 扫一个根目录，列出其中的 skill。
 * @param dir - 根目录。
 * @param where - 这个根属于哪一侧。
 * @returns skill 列表。
 */
async function scanRoot(dir: string, where: 'installed' | 'collected'): Promise<ScannedSkill[]> {
  let entries: { name: string, isDirectory: () => boolean }[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ScannedSkill[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (typeof e.isDirectory === 'function' && !e.isDirectory()) continue
    const file = join(dir, e.name, 'SKILL.md')
    try {
      const fm = parseSkillFrontmatter(await readFile(file, 'utf8'))
      out.push({
        name: e.name,
        title: fm.name,
        description: fm.description,
        where,
        root: dir,
        /* 两侧口径都照 dsh：`disable-model-invocation: true` → 模型用不了；没写 → 能用。
         * `user-invocable: false` → 用户用不了；没写 → 能。 */
        agentUsable: fm.disableModelInvocation !== true,
        userUsable: fm.userInvocable !== false,
      })
    } catch {
      /* 没有 SKILL.md 的目录不算 skill（dsh 也要求它必须有） */
    }
  }
  return out
}

/**
 * 扫描两侧（已安装 + 已收藏），合并成一份列表。
 *
 * **同一侧同名只留第一个**（按根的配置顺序）—— 与 dsh 自己按 rank 定胜负一致，
 * 也避免用户配了重叠的根时看到重复条目。
 *
 * @param opts - 解析选项。
 * @returns 全部 skill（已安装在前，各自按名字排序）。
 */
export async function scanSkills(opts: Opts = {}): Promise<ScannedSkill[]> {
  const notes = opts.notes ?? await readNotes(opts)
  const o: Opts = { dshHome: opts.dshHome, profile: opts.profile, notes }
  const out: ScannedSkill[] = []
  for (const side of ['installed', 'collected'] as const) {
    const seen = new Set<string>()
    for (const root of sideRoots(side, o)) {
      for (const s of await scanRoot(root, side)) {
        if (seen.has(s.name)) continue
        seen.add(s.name)
        out.push(s)
      }
    }
  }
  /* 两侧各自按名字排序，已安装段在前。 */
  const installed = out.filter(s => s.where === 'installed').sort(byName)
  const collected = out.filter(s => s.where === 'collected').sort(byName)
  return [...installed, ...collected]
}

/** 按名字排序的比较器。 */
function byName(a: ScannedSkill, b: ScannedSkill): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** 一个根目录的扫描情况。 */
export interface RootInfo {
  /** 目录绝对路径。 */
  path: string
  /** 这个目录当前扫到几个 skill（**0 个说明目录配错或还是空的**）。 */
  count: number
  /** 这个目录存在吗（不存在与「存在但空」是两回事，要分开告诉用户）。 */
  exists: boolean
  /** 是不是内置的默认根（界面上可以标一下「默认」，并说明不建议删）。 */
  isDefault: boolean
}

/**
 * 一侧的根目录明细（设置界面用）。
 *
 * 为什么要 `count` 与 `exists` 分开：用户加了目录却扫不到东西时，
 * 「目录不存在」和「目录在但里面没有 skill」是两种完全不同的毛病
 * （前者是路径写错，后者是把 skill 放错层了）。界面必须能区分。
 *
 * @param side - 哪一侧。
 * @param opts - 解析选项。
 * @returns 明细列表。
 */
export async function rootInfos(side: 'installed' | 'collected', opts: Opts = {}): Promise<RootInfo[]> {
  const notes = opts.notes ?? await readNotes(opts)
  const o: Opts = { dshHome: opts.dshHome, profile: opts.profile, notes }
  const defaults = [side === 'installed' ? defaultInstalledRoot(o) : defaultCollectedRoot(o)]
  const configured = notes.roots?.[side]
  const paths = Array.isArray(configured) && configured.length > 0 ? configured : defaults
  const out: RootInfo[] = []
  for (const p of paths) {
    let exists = true
    try {
      exists = (await stat(p)).isDirectory()
    } catch {
      exists = false
    }
    const count = exists ? (await scanRoot(p, side)).length : 0
    out.push({ path: p, count, exists, isDefault: defaults.includes(p) })
  }
  return out
}

/**
 * 读备注表。
 *
 * 文件不存在或读坏都返回空白表（不是错误 —— 用户还没记过东西）。
 *
 * @param opts - 解析选项。
 * @returns 备注表。
 */
export async function readNotes(opts: Opts = {}): Promise<Notes> {
  const file = join(collectRoot(opts.dshHome, opts.profile), NOTES_FILE)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Notes>
    return {
      ...parsed.roots === undefined ? {} : { roots: parsed.roots },
      skills: typeof parsed.skills === 'object' && parsed.skills !== null ? parsed.skills : {},
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    }
  } catch {
    return { skills: {}, plugins: [], projects: [] }
  }
}

/**
 * 写备注表（整份覆盖）。
 * @param notes - 备注表。
 * @param opts - 解析选项。
 * @returns 写入的路径。
 */
export async function writeNotes(notes: Notes, opts: Opts = {}): Promise<string> {
  const root = collectRoot(opts.dshHome, opts.profile)
  await mkdir(root, { recursive: true })
  const file = join(root, NOTES_FILE)
  await writeFile(file, JSON.stringify(notes, null, 2), 'utf8')
  return file
}

/**
 * 读一个 skill 的正文（供界面预览）。
 *
 * 名字先过安全校验，再在**两侧的全部根**里按名字找 `SKILL.md`。
 * 绝不接受调用方给的任意路径。
 *
 * @param name - skill 名（目录名）。
 * @param opts - 解析选项。
 * @returns 正文与位置；找不到则 null。
 */
export async function readSkillBody(
  name: string,
  opts: Opts = {},
): Promise<{ name: string, where: 'installed' | 'collected', text: string } | null> {
  if (!isSafeSkillName(name)) return null
  const notes = opts.notes ?? await readNotes(opts)
  const o: Opts = { dshHome: opts.dshHome, profile: opts.profile, notes }
  for (const side of ['installed', 'collected'] as const) {
    for (const root of sideRoots(side, o)) {
      try {
        return { name, where: side, text: await readFile(join(root, name, 'SKILL.md'), 'utf8') }
      } catch {
        /* 这个根里没有，试下一个 */
      }
    }
  }
  return null
}

/**
 * 找出一个 skill 的**目录绝对路径**（在两侧的已知根里找）。
 *
 * 用途：界面上的「打开目录」——**客户端只给名字，路径由宿主半解析**。
 * 这条边界很重要：若接受客户端传路径，就等于开了一个「用资源管理器打开任意位置」的口子。
 *
 * @param name - skill 名（目录名）。
 * @param opts - 解析选项。
 * @returns 目录绝对路径；名字不合法或两侧都找不到则 null。
 */
export async function resolveSkillDir(name: string, opts: Opts = {}): Promise<string | null> {
  if (!isSafeSkillName(name)) return null
  const notes = opts.notes ?? await readNotes(opts)
  const o: Opts = { dshHome: opts.dshHome, profile: opts.profile, notes }
  for (const side of ['installed', 'collected'] as const) {
    for (const root of sideRoots(side, o)) {
      const dir = join(root, name)
      try {
        /* 认「有 SKILL.md」的目录（与扫描口径一致），避免打开一个空壳目录。 */
        await readFile(join(dir, 'SKILL.md'), 'utf8')
        return dir
      } catch {
        /* 这个根里没有，试下一个 */
      }
    }
  }
  return null
}

/**
 * 搬移一个 skill（已安装 ⇄ 收藏）。
 *
 * 用户选了「先备份再移」，顺序：
 *   ① 校验名字 → ② 找源、确认存在 → ③ 目标**没有**同名（有就拒绝，不覆盖）
 *   → ④ 复制一份进 `.backup/` → ⑤ `rename` 搬过去 → ⑥ 清理过量旧备份。
 *
 * 用 `rename` 而不是「复制 + 删除」：同一磁盘内是原子操作，中途失败不会两头各一半。
 *
 * **多根时搬去哪**：搬到目标侧的**第一个根**（配置顺序的第一个，即默认根或用户首选）。
 * `ponytail:` 先这样 —— 多根场景本来罕见，需要选根时再让界面传目标根。
 *
 * @param name - skill 名（目录名）。
 * @param to - 搬到哪一侧。
 * @param opts - 解析选项。
 * @returns 结果（**不抛异常**，让路由统一处理）。
 */
export async function moveSkill(
  name: string,
  to: MoveDirection,
  opts: Opts = {},
): Promise<{ ok: boolean, from?: string, to?: string, backup?: string, error?: string }> {
  if (!isSafeSkillName(name)) return { ok: false, error: '名字不合法（含路径分隔符或保留名）' }

  const notes = opts.notes ?? await readNotes(opts)
  const o: Opts = { dshHome: opts.dshHome, profile: opts.profile, notes }
  const root = collectRoot(opts.dshHome, opts.profile)
  const fromSide = to === 'collect' ? 'installed' : 'collected'
  const toSide = to === 'collect' ? 'collected' : 'installed'

  /* 源：在 from 侧的根里按名字找（多根时逐个试）。 */
  let src: string | undefined
  for (const r of sideRoots(fromSide, o)) {
    try {
      if ((await stat(join(r, name))).isDirectory()) { src = join(r, name); break }
    } catch { /* 这个根里没有 */ }
  }
  if (src === undefined) {
    return { ok: false, error: (fromSide === 'installed' ? '已安装' : '收藏') + '里没有这个 skill：' + name }
  }

  const dst = join(sideRoots(toSide, o)[0], name)

  /* 目标同名则拒绝 —— 不覆盖用户已有的东西。 */
  try {
    await stat(dst)
    return { ok: false, error: '目标位置已有同名 skill，未覆盖：' + name }
  } catch { /* 不存在才继续 */ }

  /* ④ 先备份（用户明确要求）。备份失败就**不搬**，避免「移走了又没备份」。 */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupDir = join(root, BACKUP_DIR, stamp + '-' + (to === 'collect' ? 'to-collect' : 'to-install') + '-' + name)
  try {
    await mkdir(join(root, BACKUP_DIR), { recursive: true })
    await cp(src, backupDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: '备份失败，未搬移：' + (e instanceof Error ? e.message : String(e)) }
  }

  /* ⑤ 搬。 */
  try {
    await mkdir(join(dst, '..'), { recursive: true })
    await rename(src, dst)
  } catch (e) {
    return { ok: false, error: '搬移失败（备份已留下）：' + (e instanceof Error ? e.message : String(e)) }
  }

  await pruneBackups(root).catch(() => { /* 清理失败不影响搬移结果 */ })
  return { ok: true, from: src, to: dst, backup: backupDir }
}

/**
 * 清理过量的备份，只保留最近若干份。
 * @param root - 收藏数据根。
 */
async function pruneBackups(root: string): Promise<void> {
  const dir = join(root, BACKUP_DIR)
  const sorted = (await readdir(dir)).sort()
  const excess = sorted.length - BACKUP_KEEP
  if (excess <= 0) return
  for (const name of sorted.slice(0, excess)) {
    await rm(join(dir, name), { recursive: true, force: true })
  }
}
