/** 通知节点（`flow.notify`）的实现 —— 在宿主半进程内直接跑。
 *
 * ## 它只做三件事
 *
 *   ① 读提醒偏好（`src/notify/prefs.ts` 的 `readNotifyPrefs`）；
 *   ② 按偏好与节点参数决定发不发；
 *   ③ 允许发时调既有能力 `notify(title, text)`（`src/notify/index.ts`），把它的结论透传。
 *
 * 「要不要报」不在这里判断 —— 用户 2026-10-22 定：判断交给条件判断节点去连。
 * 所以本节点**不读上游数据**，只按偏好报一声。
 *
 * ## 为什么输出不带上游数据
 *
 * 用户定的形态是「报一声就结束」。带上游数据会让下游「以为这是个数据节点」，
 * 把它串进数据链中间时容易误读 —— 所以输出只有 `notified` / `level` / `reason`。
 * 要往下传数据的流程，把本节点接在分支末端。
 *
 * ## 偏好形状（2026-10-22 后端改成两项，本文件跟着改）
 *
 * `readNotifyPrefs()` 返回 `{ failNotify, alertMinLevel }`。两者**互不相干**：
 *
 * | 字段 | 管什么 | 本节点读不读 |
 * | --- | --- | --- |
 * | `failNotify` | 定时任务失败 / 挂起恢复失败要不要发通知 | **不读**（那两处由宿主半直接判） |
 * | `alertMinLevel` | 预警节点（本节点）什么级别以上才发 | 读这个 |
 *
 * ⚠️ 上一版这里自造了一个 `NotifyMode`（`failures` / `alerts` / `off`）去解析
 * `{ mode }`。后端把文件改成两项之后，那个解析器**永远只认得出默认值**，
 * 于是本节点永远不发 —— 修法不是再写一个解析器，而是**按后端那份的形状直接用**：
 * 类型从 `prefs.ts` 引，形状不再有第二份副本（两份必然漂）。
 */
import type { BuiltinFn } from '../../../dispatch/executors.ts'
import { notify } from '../../../notify/index.ts'
import { readNotifyPrefs, type AlertLevel, type AlertMinLevel, type NotifyPrefs } from '../../../notify/prefs.ts'

/** 节点输出（形状固定，不带上游数据）。界面在依赖这三个字段。 */
export interface NotifyOutput {
  /** 这次是否真的发出去了。 */
  notified: boolean
  /** 级别（`info` / `notice` / `severe`）。 */
  level: string
  /** 为什么是这个结果（成败都要有）。 */
  reason: string
}

/** 级别的显示名（进通知标题，也进 `reason` 文案）。 */
const LEVEL_LABEL: Record<AlertLevel, string> = {
  info: '信息',
  notice: '注意',
  severe: '严重',
}

/**
 * 级别高低（`severe` > `notice` > `info`）。
 *
 * 顺序由 `AlertLevel` 联合类型的书写顺序表达（后端已注明），这里落成可比较的数。
 * **别把顺序写反**：门槛比较就是比这个数。
 */
const LEVEL_RANK: Record<AlertLevel, number> = { info: 1, notice: 2, severe: 3 }

/**
 * 节点参数里的级别归一（写错 / 没填 → `notice`，与参数默认值一致）。
 *
 * @param raw - 参数里的原值。
 * @returns 三档之一。
 */
export function asAlertLevel(raw: unknown): AlertLevel {
  return raw === 'info' || raw === 'severe' || raw === 'notice' ? raw : 'notice'
}

/**
 * 门槛比较：这个级别的提醒该不该发。
 *
 * @param min - 提醒设置里的门槛（`off` = 一律不发）。
 * @param level - 本条提醒的级别。
 * @returns 过没过门槛（`off` 时永远不过）。
 */
export function levelPasses(min: AlertMinLevel, level: AlertLevel): boolean {
  if (min === 'off') return false
  return LEVEL_RANK[level] >= LEVEL_RANK[min]
}

/**
 * 按偏好与参数算出「发不发、为什么」。**纯函数**，不碰磁盘、不起进程。
 *
 * ## 四种原因，四种文案（别合并）
 *
 * 用户 2026-10-23 明确要求能区分开 —— 因为界面上「没收到提醒」有四种完全不同的处置：
 *   ① 设置了不发送（`off`）      → 去提醒设置里打开；
 *   ② 级别不够被门槛挡住          → 调低门槛，或把节点级别调高；
 *   ③ 节点自己设为不发系统通知    → 去节点参数里打开；
 *   ④ 真发出去了                  → 不必处理。
 *
 * `failNotify` **不参与**这里的判断（它管的是定时失败与恢复失败，与本节点无关）。
 *
 * @param prefs - 提醒偏好。
 * @param level - 本条提醒的级别。
 * @param system - 节点的「同时发系统通知」参数。
 * @returns 发不发 + 一句话理由。
 */
export function decideNotify(
  prefs: NotifyPrefs,
  level: AlertLevel,
  system: boolean,
): { send: boolean, reason: string } {
  const min = prefs.alertMinLevel
  if (min === 'off') {
    return { send: false, reason: '提醒设置里预警节点设为不发送（off）' }
  }
  if (!levelPasses(min, level)) {
    return {
      send: false,
      reason: '本条级别「' + LEVEL_LABEL[level] + '」低于提醒门槛「' + LEVEL_LABEL[min] + '」，按设置不发',
    }
  }
  if (!system) return { send: false, reason: '节点设为不发系统通知' }
  return { send: true, reason: '' }
}

/**
 * 读提醒偏好（交给 `src/notify/prefs.ts`，那一侧自带「缺文件 / 旧文件 / 坏字段」的容错）。
 *
 * @returns 偏好（一定可用）。
 */
async function readPrefs(): Promise<NotifyPrefs> {
  try {
    return await readNotifyPrefs()
  } catch {
    /* 契约上它不抛；抛了也按「不发送预警」处理 —— 读配置失败不该让提醒节点报错，
     * 也不该因此凭空弹出通知（默认值就是这个取向，见 `DEFAULT_NOTIFY_PREFS`）。 */
    return { failNotify: true, alertMinLevel: 'off' }
  }
}

/**
 * 通知节点的**核心**（偏好由调用方给，便于脱离磁盘单测）。
 *
 * @param p - 节点参数（`{{变量}}` 已由 `buildCommand` 替换过）。
 * @param prefs - 提醒偏好。
 * @returns 固定三个字段的输出。
 * @throws 提醒内容为空时 —— 按节点的失败策略（`continue`）继续，不中断整条流程。
 */
export async function runNotify(p: Record<string, unknown>, prefs: NotifyPrefs): Promise<NotifyOutput> {
  const content = typeof p.content === 'string' ? p.content.trim() : ''
  if (content === '') throw new Error('没填提醒内容：在节点设置里填「提醒内容」后再跑')
  const level = asAlertLevel(p.level)
  /* `system` 缺省视为开（与参数默认值一致）。 */
  const system = p.system !== false

  const verdict = decideNotify(prefs, level, system)
  if (!verdict.send) return { notified: false, level, reason: verdict.reason }

  const sent = await notify('电商 AI 工作台 · ' + LEVEL_LABEL[level], content)
  /* ⚠️ 前缀不能省：`notify()` 的原话在闸门下是「没有真的弹」、在真机上是「已弹出」，
   * 两种情况都要能一眼看出是**发出了**而不是被设置挡住（那是另一类原因）。 */
  return {
    notified: sent.ok,
    level,
    reason: (sent.ok ? '已发出：' : '发送失败：') + sent.reason,
  }
}

/**
 * 通知节点的实现（派发入口）：先读偏好，再交给 `runNotify`。
 *
 * @param cmd - 命令体（`{ node, params }`；`{{变量}}` 已由 `buildCommand` 替换过）。
 * @returns 固定三个字段的输出。
 * @throws 提醒内容为空时 —— 按节点的失败策略（`continue`）继续，不中断整条流程。
 */
export const notifyFn: BuiltinFn = async (cmd) => {
  const p = (cmd as { params?: Record<string, unknown> } | undefined)?.params ?? {}
  return await runNotify(p, await readPrefs())
}
