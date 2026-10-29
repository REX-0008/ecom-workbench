/** 「⎌ 恢复」该去哪个目录找快照 —— 把这条判断从组件里提出来，**为了能测**。
 *
 * ## 为什么单独成文件（这是一个刻意的取舍）
 *
 * 这条规则原本写在 `WorkflowCanvas.tsx` 的按钮 `onClick` 闭包里。闭包里的逻辑
 * **测不到**：那个文件 import 了 `.module.css`，Node 加载不了（`.css` 不是 JS 模块），
 * 所以任何 node 测试都 import 不进它。于是只能在测试里**把规则抄一遍** ——
 * 而「测试抄一份实现」是**假绿**的经典来源：实现改了、测试那份没改，照样通过。
 *
 * 本项目对这类事有明确的教训（`AGENTS.md`：「能在 DOM 上查的，就别在产物里数出现次数」、
 * `browser-driver` 那 4 条被注释里的同一串救活的假绿断言）。
 * 所以这里把它提成一个**纯函数**：组件和测试 import 的是**同一份**代码。
 *
 * ## 它解决什么（用户的数据可达性）
 *
 * 快照名原本**恒为「当前工作流」**，2026-10-14 才改成**跟着归属走**
 * （`file.isNew ? '当前工作流' : file.name`）。于是盘上按老名字存的那批就
 * **够不着了**：实测真机数据目录 `_snapshots/` 下只有「当前工作流」一个目录、
 * 2 个快照文件，而工作流列表里**一份都不叫「当前工作流」** ——
 * 用户在任意一份工作流下点「恢复」都只看到「还没有存过快照」。
 * **老快照等于静默丢了**，连一句提示都没有。
 *
 * ## 为什么选「读的时候兜底」而不是「迁移目录」
 *
 * 迁移要把老快照按**当时的归属**改名，可「当时属于谁」**盘上没记**
 * （快照文件名是时间戳，内容里也没有归属）→ 只能猜。猜错就把快照挂到
 * **别的工作流**名下 —— 用户会在一份工作流里看到另一份的历史版本，比找不到更危险。
 * 兜底**零副作用**：只在「按目录找不到」时多看一眼老目录。
 */

/** 老快照的目录名 —— 快照名原来**恒为**这个，同时也是「还没归属」时的兜底名。
 *
 * ⚠️ 保留它有两个用途，删不得：
 *   ① 读老快照时的兜底目录名（本文件的主角）；
 *   ② 新建（未存盘）的工作流存快照时用的名字 —— 那时**还没有归属**，
 *      只能放在这个兜底名字下。 */
export const LEGACY_SNAP_DIR = '当前工作流'

/** 列快照的返回形状（与 `dispatch-client.ts` 的 `listSnapshots` 一致）。 */
export interface SnapListResult {
  ok: boolean
  snaps: string[]
  error?: string
}

/** 列快照的函数（注入用 —— 组件传真请求，测试传桩）。 */
export type SnapListFn = (name: string) => Promise<SnapListResult>

/** 兜底查找的结果。 */
export interface SnapLookup {
  /** 找到的快照名（新的在前）；找不到是空数组。 */
  snaps: string[]
  /** **实际该去哪个目录读** —— 兜底命中时是 `LEGACY_SNAP_DIR`，否则等于目标名。
   * ⚠️ 读的时候必须用这个，不能用目标名：否则「列的是老目录、读的是新目录」，
   * 必然报「没有这份快照」。 */
  dir: string
  /** 这批是不是从老目录兜底来的（界面要据此**说清来源**）。 */
  legacy: boolean
  /** 目标目录读失败时的原因（`ok:false` 时才有）。 */
  error?: string
}

/**
 * 决定去哪个目录找快照（必要时兜底到老目录）。
 *
 * 规则：
 *   1. 先按目标名找；
 *   2. 目标名**读失败** → 如实回报错误，**不兜底**（分不清是「没有」还是「读不到」，
 *      静默拿老快照顶上会让人以为数据是好的）；
 *   3. 目标名**找到了** → 用它（老目录只在「目标为空」时才看，避免同一批老快照
 *      在每一份工作流下都冒出来，让人误以为属于当前这份）；
 *   4. 目标名为空、且目标名**不是**老目录名本身 → 再试一次老目录，命中则带着
 *      `legacy: true` 返回。
 *
 * @param target - 目标快照目录名（有归属就是工作流名，没归属是 `LEGACY_SNAP_DIR`）。
 * @param list - 列快照的函数。
 * @returns 该去哪个目录、有哪些快照、是不是兜底来的。
 */
export async function resolveSnapLookup(target: string, list: SnapListFn): Promise<SnapLookup> {
  const own = await list(target)
  if (!own.ok) {
    return { snaps: [], dir: target, legacy: false, error: own.error }
  }
  /* ⚠️ 兜底条件里 `target !== LEGACY_SNAP_DIR` 不能省：
   * 没归属时目标名**就是**老目录名，那时上面那次 `list` 已经查过它了，
   * 再查一次纯属重复请求（而且 `legacy` 会被误标成 true，
   * 界面就会对着「本来就是当前目录」的快照说「这些是改版前存的」）。 */
  if (own.snaps.length > 0 || target === LEGACY_SNAP_DIR) {
    return { snaps: own.snaps, dir: target, legacy: false }
  }
  const old = await list(LEGACY_SNAP_DIR)
  if (old.ok && old.snaps.length > 0) {
    return { snaps: old.snaps, dir: LEGACY_SNAP_DIR, legacy: true }
  }
  return { snaps: [], dir: target, legacy: false }
}

/**
 * 给用户看的「这批快照是哪来的」提示。
 *
 * ⚠️ 必须说清「不属于当前这份工作流」—— 光说「改版前存的」不够：
 * 用户会以为「这版工作流本来就有这些快照」，然后恢复一份**别的**工作流的内容。
 *
 * @param lookup - 查找结果。
 * @returns 提示文字（不是兜底来的就没有提示，返回空串）。
 */
export function legacySnapNotice(lookup: SnapLookup): string {
  if (!lookup.legacy) return ''
  return '这些是改版前存的快照（当时还没按工作流分开存，统一放在「'
    + LEGACY_SNAP_DIR + '」下）。它们不一定属于当前这份工作流，恢复前请先确认。'
}
