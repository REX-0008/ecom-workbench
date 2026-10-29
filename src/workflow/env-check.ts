/**
 * 环境检测的**判定逻辑**（纯函数，无 IO）。
 *
 * ## 为什么单独一个文件（分层，照 `browser-detect.ts` 的做法）
 *
 * `AGENTS.md` 的分层是「能碰磁盘/网络的一侧才做 IO，**规则放纯函数里**」。
 * 环境检测正好是这条规矩的典型：它有**两个 IO 源**（宿主半读存档目录、
 * 客户端读 localStorage），而「这些事实合起来意味着什么」是纯计算。
 *
 * 抽出来的直接好处：可以拿**构造的事实**直接测出判定对不对 ——
 * 不然只能起真服务、真存档、真端口去撞，那种测试又慢又不稳。
 *
 * ## 一件事为什么要分两侧（这是本文件存在的根本原因）
 *
 * 「默认浏览器能不能用」需要两个事实：
 *   · 机器上**有没有**那个调试端口在听 —— 只有宿主半知道（它能连 socket）；
 *   · 用户的默认来源/端口**是什么** —— 只有浏览器知道（存在 localStorage）。
 * 宿主半读不到 localStorage（那是页面里的东西），客户端连不了 socket
 * （画布跑在浏览器里）。所以判定必须在**客户端**做，而宿主半只负责给机器事实。
 */
/* 分组框的两种写法从存档层引（**同一份真源** —— 不在这里再写一遍字面量，
 * 否则 `workflow-doc.ts` 哪天改了这里会静默跟着不对）。 */
import { GROUP_DEF_ID, GROUP_NODE_TYPE } from '../client/workbench/workflow-doc.ts'

/** 宿主半回报的机器事实（`GET /api/ecom-workbench/env-check` 的回复）。 */
export interface EnvFacts {
  /** 节点库里的类型数。 */
  library: number
  /** 存档目录里的工作流份数。 */
  workflows: number
  /** 存档引用了、但节点库里已经没有的类型。 */
  gaps: readonly { workflow: string, defId: string }[]
  /**
   * 声明式依赖（`NodeDef.deps`）是否已经判过。
   *
   * 2026-10-27 起是 `true`（票 22 实现了判定）。留着这个键而不是删掉：
   * 删了会让还没升级的那一侧读到 `undefined`、按「没实现」走提示 —— 那是假话。
   */
  depsImplemented: boolean
  /**
   * 缺依赖的节点类型（只含不满足的；全满足时是空数组）。
   *
   * 老宿主半（票 22 之前）不返回这个键 —— 所以类型是可选，
   * 消费方读不到时要按「没查」处理，别按「没缺」处理。
   */
  depsMissing?: readonly { id: string, gaps: readonly { kind: string, name: string }[], reason: string }[]
  /** 能找到的可用浏览器数。 */
  browsersUsable: number
  /** 可用浏览器的名字。 */
  browserNames: readonly string[]
  /** 现在在听的 CDP 调试端口。 */
  cdpPorts: readonly number[]
}

/** 用户侧的偏好（来自 localStorage，宿主半看不到）。 */
export interface EnvPrefs {
  /** 默认来源。 */
  defaultSource: 'cdp' | 'app'
  /** 默认调试端口（空串 = 每个标签自己选）。 */
  defaultPort: string
}

/** 检测报告。 */
export interface EnvReport extends EnvFacts {
  /** 本机默认来源（来自 localStorage）。 */
  defaultSource: 'cdp' | 'app'
  /** 默认端口（同上）。 */
  defaultPort: string
  /** 跑起来之前必须解决的问题（空 = 就绪）。 */
  blockers: string[]
}

/**
 * 把两侧的事实合成一份报告。
 *
 * ## 什么算「阻塞」（判据要稳，不能一开就红）
 *
 * 只报**确定跑不了**的：
 *
 *   ① 存档里有已经消失的节点类型 —— 那份工作流打开就缺节点。
 *   ② 默认来源是 CDP、机器上**一个调试端口都没有** —— 没有任何能连的东西。
 *   ③ 默认来源是 CDP、**默认端口不在在听列表里** —— 这条正是用户点名要的：
 *      「默认浏览器如果是 cdp，那么这个 cdp 接口是否可用需要验证」。
 *   ④ 默认来源是本机浏览器、却**一个能用的都没有**。
 *
 * ⚠️ **「没设默认端口」不算阻塞**：它是合法的「各标签自己选」
 * （`checkRunnable` 会在真跑的时候明确拦住没配的标签，不会静默连错）。
 * 算成错的话，每个新用户一打开就看见一片红，那会让这条功能失去意义。
 *
 * ⚠️ 各标签可以**覆盖**默认端口，所以「默认端口没在听」不等于「一定跑不了」——
 * 报告里给的是**默认那条路**能不能走通，客户端文案要照这个说。
 *
 * ## 缺依赖的节点算不算阻塞（2026-10-27，票 22 加）
 *
 * 不算。判据是「只报确定跑不了的东西」，而缺依赖的节点：
 *
 *   ① 可能根本不在任何一份工作流里（节点库里有 `ecom.image-gen`，
 *      但用户的工作流可能一个都没用它）；
 *   ② 即使在工作流里，也只是那一个节点跑不了，别的不受影响。
 *
 * 把它算成「环境没就绪」会让每个新用户一打开就看见一片红（`ecom.image-gen` 要
 * `IMAGE_API_KEY`，绝大多数人不会设），那会让这条功能失去意义 —— 与
 * 「没设默认端口不算阻塞」是同一条道理。
 *
 * 所以：缺依赖事实照实带回（`depsMissing`），但不进 `blockers`。
 *
 * @param facts - 宿主半给的机器事实。
 * @param prefs - 用户侧偏好。
 * @returns 报告。
 */
export function buildEnvReport(facts: EnvFacts, prefs: EnvPrefs): EnvReport {
  const blockers: string[] = []
  const port = prefs.defaultPort.trim()

  if (facts.gaps.length > 0) {
    blockers.push('有 ' + String(facts.gaps.length) + ' 处引用了已经没有的节点类型')
  }
  if (prefs.defaultSource === 'cdp') {
    if (facts.cdpPorts.length === 0) {
      blockers.push('默认来源是 CDP，但机器上没有任何调试端口在听')
    } else if (port !== '' && !facts.cdpPorts.includes(Number(port))) {
      blockers.push('默认端口 ' + port + ' 没在听（在听的：' + facts.cdpPorts.join(' / ') + '）')
    }
  } else if (facts.browsersUsable === 0) {
    blockers.push('默认来源是本机浏览器，但没找到能用的')
  }

  return {
    ...facts,
    defaultSource: prefs.defaultSource,
    defaultPort: port,
    blockers,
  }
}

/**
 * 扫一批工作流存档，找出「引用了、但节点库里已经没有」的类型。
 *
 * 这是「节点依赖」现在**唯一能验证**的那一半（真正的 npm 包 / 外部程序 /
 * 环境变量依赖检测还没做 —— 节点目录里一个 `deps.json` 都没有、
 * 也没有代码读它，见 `src/workflow/model.ts` 的说明）。
 *
 * ## 什么是「缺类型」（分组框的**两种**写法都要排掉）
 *
 * 分组框是**渲染时派生出来的假节点**，它不在节点库里是**设计**，不是缺陷。
 * 而它在存档里有**两种**形态，只排掉一种会漏：
 *
 *   ① **新档**：写了 `type: 'group'`（`workflow-doc.ts` 的 `GROUP_NODE_TYPE`）；
 *   ② **旧档**：**没有 `type` 字段**，但 `defId` 是 `'__group'`
 *      （同文件的 `GROUP_DEF_ID` —— 那里的注释写明「旧档没写 type，
 *      但 defId 恰好是 `__group`」，读回时按这两条**任一**认它是分组框）。
 *
 * ⚠️ **只排 ① 会误报每一个旧编组** —— 后果是用户一点环境检测就看见一串
 * 「用到的 `__group` 已经不在节点库里了」，让他以为存档坏了。
 * （这个漏洞是写完测试后专门回去补的：第一版只排了 ①，
 * 而测试造的分组框恰好带 `type`，于是**没抓住** —— 测试与实现对着一处错。）
 *
 * @param items - `listWorkflows()` 的结果（每项含 `name` 与 `doc`）。
 * @param known - 节点库里现有的类型 id 集合。
 * @returns 缺的类型清单（按发现顺序，可重复 —— 同一类型在几份档里缺就几条）。
 */
export function scanNodeGaps(
  items: readonly { name: string, doc: unknown }[],
  known: ReadonlySet<string>,
): { workflow: string, defId: string }[] {
  const gaps: { workflow: string, defId: string }[] = []
  for (const item of items) {
    const doc = item.doc as { nodes?: unknown } | null
    const ns = Array.isArray(doc?.nodes) ? doc.nodes : []
    for (const raw of ns) {
      /* ⚠️ **存档是用户可手改的**（它在磁盘上、就是个 JSON）——
       * 所以每个字段都要当脏数据处理。这里踩过一次真的：
       * `nodes` 数组里混进 `null` 时 `n.type` 直接抛
       * `TypeError: Cannot read properties of null`，
       * 而它出现在宿主半的 GET 路由里 → 整个环境检测 500，
       * 报出来的是「连不上宿主半」，跟真正的原因毫无关系。 */
      if (raw === null || typeof raw !== 'object') continue
      const n = raw as { defId?: unknown, type?: unknown }
      /* 分组框的两种形态（见上面那段）—— 都不是「缺类型」。 */
      if (n.type === GROUP_NODE_TYPE || n.defId === GROUP_DEF_ID) continue
      const id = typeof n.defId === 'string' ? n.defId : ''
      if (id !== '' && !known.has(id)) gaps.push({ workflow: item.name, defId: id })
    }
  }
  return gaps
}
