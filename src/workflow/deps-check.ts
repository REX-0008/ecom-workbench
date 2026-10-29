/** 依赖判定的**规则**（纯逻辑 + 一处受控的探测注入）。
 *
 * ## 它补的是哪个缺口（票 22，2026-10-27）
 *
 * `NodeDef.deps` 一直是「声明了但没人读」的死字段：每类节点写了自己要哪些
 * npm 包 / 外部程序 / 环境变量，而**没有任何代码去判它满不满足**，
 * `NodeState` 里那个 `missing` 态一次都没被置过。
 *
 * 界面上「缺件时把四类依赖列出来」的渲染其实早就写好了
 * （`src/client/workbench/NodeEditorPopover.tsx:1082-1097` 那一块），
 * 只是没有任何东西会把 state 置成 `missing` —— 所以它从来没显示过。
 *
 * ## 为什么判定在这里、探测在外面
 *
 * `AGENTS.md` 的分层：能碰磁盘/进程的一侧才做 IO，**规则放纯函数里**。
 * 这里的分法更细一层：
 *
 *   · `judgeDeps`：纯函数。给「声明」与「探到的结果」→ 结论。可单测，不碰任何 IO。
 *   · `probeDeps`：真去探（`require.resolve` / `PATH` / `process.env` / `existsSync`）。
 *     **探什么由一个注入的 `DepProbe` 决定**，默认实现是本文件那个。
 *
 * 这样拆的直接好处：单测能造「node 有、python 没有」这种事实，不用真去装一个 python；
 * 也不会因为这台机器碰巧有 python 就让「缺件」那条断言永远绿着。
 *
 * ## 检查时机：按需现查，不缓存（判据写在票 22 的进度里）
 *
 * 四种探测全都便宜（一次 resolve、几次 `existsSync`、一次 env 取值），
 * 而缓存会在**最该准的时候**过期：用户看到「缺 python」→ 去装 → 回来再查，
 * 缓存让他继续看见「缺」。那正是这一轮反复出现的病。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import type { NodeDeps } from '../workflow/model.ts'

/** 一类依赖。 */
export type DepKind = 'npm' | 'bin' | 'env' | 'files'

/**
 * 四类依赖的中文名。
 *
 * ⚠️ 与 `src/client/workbench/NodeEditorPopover.tsx` 的 `DEP_KIND` **同一套字**：
 * 那边是「把声明列出来给人看」，这里是「把缺口说清楚」，两处对不上
 * 用户会以为缺的是两样东西。改一处就要改另一处（有断言钉住）。
 */
export const DEP_KIND_LABEL: Record<DepKind, string> = {
  npm: 'NPM 包',
  bin: '外部程序',
  env: '环境变量',
  files: '随附文件',
}

/** 四类的顺序（与 `NodeDeps` 的字段顺序一致，界面照这个排）。 */
export const DEP_KINDS: readonly DepKind[] = ['npm', 'bin', 'env', 'files']

/** 一条缺口。 */
export interface DepGap {
  /** 哪一类。 */
  kind: DepKind
  /** 缺的名字（包名 / 程序名 / 变量名 / 文件路径）。 */
  name: string
}

/**
 * 探测能力（**注入点**）。
 *
 * 四个都是同步的：它们本来就不耗时，做成异步只会让调用点多出一层 await，
 * 而调用点（`/env-check` 路由）已经是异步了，多这一层没有收益。
 */
export interface DepProbe {
  /** 这个 npm 包能不能解析到。 */
  hasNpm: (name: string) => boolean
  /** 这个外部程序在不在 `PATH` 里。 */
  hasBin: (name: string) => boolean
  /** 这个环境变量有没有（**非空**才算有）。 */
  hasEnv: (name: string) => boolean
  /** 这个文件在不在（按 `process.cwd()` 解析相对路径）。 */
  hasFile: (path: string) => boolean
}

/**
 * 默认探测实现（真去看机器）。
 *
 * ## 四条判据各自的一句话理由
 *
 * - **npm**：`createRequire(import.meta.url).resolve(name)` —— 能解析到就算有。
 *   用 `require.resolve` 而不是 `existsSync(node_modules/<name>)`：后者对
 *   scoped 包、对 hoist 到上游目录的包都会判错。
 * - **bin**：在 `PATH` 的每个目录里找 `<name>` 与（Windows）`<name>.exe/.cmd/.bat/.com`。
 *   用 `existsSync` 而不是真起一次 `<name> --version`：起进程要几十到几百毫秒，
 *   而且有些程序带副作用。
 * - **env**：`process.env[name]` **非空**才算有 —— 设成空串的变量与没设一样，
 *   拿它当「有」会让后面真跑时报一个更难懂的错。
 * - **files**：按 `process.cwd()` 解析（理由写在票 22 的进度里）。
 */
export function makeDepProbe(opts?: {
  /** 判程序存在时用的候选后缀（默认按平台给）。 */
  exts?: readonly string[]
  /** `PATH` 分隔符（默认按平台）。 */
  sep?: string
  /** 解析文件相对路径的根（默认 `process.cwd()`）。 */
  cwd?: string
}): DepProbe {
  const isWin = process.platform === 'win32'
  const exts = opts?.exts ?? (isWin ? ['.exe', '.cmd', '.bat', '.com', ''] : [''])
  const sep = opts?.sep ?? delimiter
  const cwd = opts?.cwd ?? process.cwd()
  /* `createRequire` 要一个绝对 URL 才能解析包 —— 用本文件的位置。
   * 产物里 `import.meta.url` 指向 `lib/index.js`，而 `node_modules` 在仓库根，
   * Node 的解析算法会逐级往上找，所以两种布局都对。 */
  const req = createRequire(import.meta.url)
  return {
    hasNpm(name) {
      try { req.resolve(name); return true } catch { return false }
    },
    hasBin(name) {
      const dirs = String(process.env.PATH ?? '').split(sep).filter(d => d !== '')
      for (const d of dirs) {
        for (const ext of exts) {
          /* Windows 上 `PATH` 里写的是 `C:\…\python.EXE` 这种大小写混的，
           * 而 `existsSync` 是否区分大小写取决于文件系统（NTFS 默认不区分）。
           * 这里不做小写化 —— 那会让 Linux 上判错。 */
          if (existsSync(join(d, name + ext))) return true
        }
      }
      return false
    },
    hasEnv(name) {
      const v = process.env[name]
      return typeof v === 'string' && v.trim() !== ''
    },
    hasFile(path) {
      return existsSync(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : join(cwd, path))
    },
  }
}

/** 一次判定结果。 */
export interface DepJudgement {
  /** 满不满足（`gaps` 为空）。 */
  ok: boolean
  /** 缺的每一条（空 = 全满足）。 */
  gaps: DepGap[]
  /** 有一句话就说清缺什么、怎么装（`ok` 时是空串）。 */
  reason: string
}

/**
 * 装什么、怎么装 —— 每一类给一句可执行的下一步。
 *
 * 为什么不写成一个通用句「请安装缺失的依赖」：四类的装法完全不同
 * （装包 / 装软件 / 设环境变量 / 放文件），一句通用话等于没说。
 */
const FIX_HINT: Record<DepKind, string> = {
  npm: '装包：在这个插件目录里执行 npm install',
  bin: '装程序：把可执行文件装进 PATH，或改用它需要的软件',
  env: '设变量：在启动桌面端之前把环境变量设好',
  files: '补文件：把文件放到上面写的那个路径',
}

/**
 * 判一份声明满不满足（**纯函数**）。
 *
 * @param deps - 节点定义上的声明（没有就传 `undefined`）。
 * @param probe - 探测实现（默认用 `makeDepProbe()`）。
 * @returns 结论（`ok` / 缺口清单 / 一句话原因）。
 */
export function judgeDeps(deps: NodeDeps | undefined, probe: DepProbe = makeDepProbe()): DepJudgement {
  if (deps === undefined) return { ok: true, gaps: [], reason: '' }
  const gaps: DepGap[] = []
  for (const kind of DEP_KINDS) {
    const list = deps[kind]
    if (!Array.isArray(list)) continue
    for (const name of list) {
      if (typeof name !== 'string' || name.trim() === '') continue
      const hit = kind === 'npm' ? probe.hasNpm(name)
        : kind === 'bin' ? probe.hasBin(name)
          : kind === 'env' ? probe.hasEnv(name)
            : probe.hasFile(name)
      if (!hit) gaps.push({ kind, name })
    }
  }
  if (gaps.length === 0) return { ok: true, gaps: [], reason: '' }

  /* 一句话说清缺什么。按类别归组 —— 缺三个包时不要把「装包」那句说三遍。 */
  const parts: string[] = []
  for (const kind of DEP_KINDS) {
    const names = gaps.filter(g => g.kind === kind).map(g => g.name)
    if (names.length === 0) continue
    parts.push('缺' + DEP_KIND_LABEL[kind] + '：' + names.join('、'))
  }
  const hint = DEP_KINDS.filter(k => gaps.some(g => g.kind === k)).map(k => FIX_HINT[k])
  return {
    ok: false,
    gaps,
    reason: parts.join('；') + '。' + hint.join('；') + '。',
  }
}

/** 节点定义里判依赖需要的那两个字段（避免本文件依赖整个 `NodeDef`）。 */
export interface DepOwner {
  /** 节点类型 id。 */
  id: string
  /** 声明。 */
  deps?: NodeDeps
}

/** 一个节点的依赖判定结果（带 id，便于路由攒成清单）。 */
export interface NodeDepStatus extends DepJudgement {
  /** 节点类型 id。 */
  id: string
}

/**
 * 判一批节点（**纯函数**）。
 *
 * 只回**不满意的**那些 —— 满足的占了绝大多数，全带回去等于把响应体撑大
 * 而调用方一条都用不上。
 *
 * @param defs - 节点定义（只读需要 `id` 与 `deps`）。
 * @param probe - 探测实现。
 * @returns 缺件的节点（按传入顺序；全满足时是空数组）。
 */
export function judgeLibrary(defs: readonly DepOwner[], probe: DepProbe = makeDepProbe()): NodeDepStatus[] {
  const out: NodeDepStatus[] = []
  for (const d of defs) {
    const j = judgeDeps(d.deps, probe)
    if (!j.ok) out.push({ id: d.id, ...j })
  }
  return out
}
