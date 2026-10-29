/** 提醒偏好的**落盘**（用户 2026-10-22 定：拆成两项独立设置）。
 *
 * ## 为什么从「三档」改成「两项」
 *
 * 原来是单枚举 `mode: 'failures' | 'alerts' | 'off'`（一条开关决定两件事）。
 * 用户 2026-10-22 的原话：「既然通知有三挡，那么提醒设置的预警提醒是否也应该分三挡……
 * 应该改成每个独立的设置：失败是否提醒、预警节点什么级别才提醒」。
 *
 * 于是拆成两个互不影响的字段：
 *
 * | 字段 | 管什么 |
 * | --- | --- |
 * | `failNotify` | **失败类**提醒发不发：定时任务失败 + **挂起恢复失败**（用户明确归同一项） |
 * | `alertMinLevel` | **预警节点**（`flow.notify`）什么级别以上才发 |
 *
 * 为什么这两件事必须分开：原来选「不提醒」会把节点预警一起关掉，
 * 而用户只想关失败通知时没有别的选项。
 *
 * ## 旧文件照读（迁移）
 *
 * 用户机器上已经有 `notify-prefs.json` 了，里面是旧形状 `{ "mode": ... }`。
 * 升级后第一次读取要把它翻译过来，不能当成「坏文件」打回默认（那等于把用户设的档位悄悄重置）：
 *
 * | 旧值 | 新值 |
 * | --- | --- |
 * | `{ mode: 'failures' }` | `{ failNotify: true, alertMinLevel: 'off' }` |
 * | `{ mode: 'alerts' }` | `{ failNotify: true, alertMinLevel: 'info' }` |
 * | `{ mode: 'off' }` | `{ failNotify: false, alertMinLevel: 'off' }` |
 *
 * 写法是**读时翻译、不主动改写磁盘**：用户下次在界面里改设置才会落成新形状。
 * 好处是旧版本插件回退时仍读得懂（文件里那一份没被升级动作改过）。
 *
 * ## 读的一律容错、写的是**部分更新**
 *
 * 与 `src/prefs/ui-prefs.ts` 同一套做法：
 *
 *   - 读：缺文件 / JSON 坏 / 某个字段非法 → **逐字段回落默认值**，不抛错、不建文件；
 *   - 写：只改传进来的键、其余保持盘上原值；非法字段等于**跳过**（回落盘上原值，不打回默认）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { workflowsDir } from '../workflow/store.ts'

/** 预警节点的级别从低到高。 */
export type AlertLevel = 'info' | 'notice' | 'severe'

/** `alertMinLevel` 的全部取值（`off` = 预警节点一律不发）。 */
export type AlertMinLevel = 'off' | AlertLevel

/** 提醒偏好（两项独立设置）。 */
export interface NotifyPrefs {
  /** 失败类提醒发不发（定时任务失败 + 挂起恢复失败）。 */
  failNotify: boolean
  /** 预警节点（`flow.notify`）什么级别以上才发；`off` 表示一律不发。 */
  alertMinLevel: AlertMinLevel
}

/** 提醒偏好文件名（插件数据目录下，与 `browser-prefs.json` 同级）。 */
export const NOTIFY_PREFS_FILE = 'notify-prefs.json'

/** 默认偏好：失败要提醒（用户 2026-10-22 之前定的「失败并提醒」），预警节点默认不发。 */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { failNotify: true, alertMinLevel: 'off' }

/** 合法的 `alertMinLevel` 取值（归一用）。 */
const ALERT_MIN_LEVELS: readonly AlertMinLevel[] = ['off', 'info', 'notice', 'severe']

/** 旧形状的三个 `mode` 值，以及各自该迁移成什么。 */
const LEGACY_MODES: Record<string, NotifyPrefs> = {
  failures: { failNotify: true, alertMinLevel: 'off' },
  alerts: { failNotify: true, alertMinLevel: 'info' },
  off: { failNotify: false, alertMinLevel: 'off' },
}

/**
 * 偏好文件的绝对路径。
 *
 * ⚠️ 用 `workflowsDir` 的父目录 —— 与 `browser-prefs.json` / `ui-prefs.json`
 * 同一个写法，不在这里另写一遍目录解析规则。
 *
 * @returns 绝对路径。
 */
export function notifyPrefsFile(): string {
  return join(workflowsDir(), '..', NOTIFY_PREFS_FILE)
}

/**
 * 一份全默认的偏好。
 *
 * @returns 默认值（每次给新对象，调用方改了不污染别人）。
 */
export function defaultNotifyPrefs(): NotifyPrefs {
  return { ...DEFAULT_NOTIFY_PREFS }
}

/** 布尔字段：只认真正的 `true` / `false`（`'yes'`、`1` 一律当没填）。 */
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

/**
 * 把任意输入归一成一份可用的偏好。
 *
 * 非法字段**单独**回落 `fallback` 里对应的值，不影响其它字段。
 *
 * ⚠️ `fallback` 分两种用法（与 `src/prefs/ui-prefs.ts` 同一条纪律）：
 *   - **读**时回落**默认值**（盘上没有可用值）；
 *   - **写**时回落**盘上原值**（非法字段等于「跳过」，不打回默认）。
 *
 * @param raw - 读到的 JSON（可能是 null / 字符串 / 只带 mode 的旧文件）。
 * @param fallback - 某个字段不可用时用它。
 * @returns 偏好（一定带齐两个字段）。
 */
function normalize(raw: unknown, fallback: NotifyPrefs): NotifyPrefs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const o = raw as Record<string, unknown>

  /* 新形状优先：只要出现任一新字段，就按新形状逐字段归一。
   * 这样「新旧混写」的文件不会被旧 `mode` 抢走判据。 */
  if (o.failNotify !== undefined || o.alertMinLevel !== undefined) {
    const level = o.alertMinLevel
    return {
      failNotify: bool(o.failNotify, fallback.failNotify),
      alertMinLevel: ALERT_MIN_LEVELS.includes(level as AlertMinLevel)
        ? level as AlertMinLevel
        : fallback.alertMinLevel,
    }
  }

  /* 旧形状：`{ mode }` 迁移过来。旧值非法（大小写不符、带空格、别的字符串）
   * 一律当「没填」，回落 fallback —— 与原来「非法值当 failures」同一条保守取向。 */
  const legacy = LEGACY_MODES[typeof o.mode === 'string' ? o.mode : '']
  return legacy === undefined ? { ...fallback } : { ...legacy }
}

/**
 * 读提醒偏好。
 *
 * 缺文件 / JSON 坏 / 旧文件（`{ mode }`）/ 个别字段非法 → 逐字段回落，**不抛错、不建文件**。
 * 旧文件按迁移表翻译成新形状（文件本身不改）。
 *
 * @returns 偏好（一定可用）。
 */
export async function readNotifyPrefs(): Promise<NotifyPrefs> {
  try {
    const text = await readFile(notifyPrefsFile(), 'utf8')
    return normalize(JSON.parse(text), defaultNotifyPrefs())
  } catch {
    return defaultNotifyPrefs()
  }
}

/**
 * 写提醒偏好（**部分更新**）。
 *
 * 只改传进来的键，其余保持盘上的原值；非法字段跳过，合法字段照样生效。
 * 返回合并后的完整对象 —— 调用方照它回话，界面上就不会出现「显示成功了，其实没存」。
 *
 * @param patch - 要改的那几个键（任意输入，坏值由 `normalize` 逐个挡掉）。
 * @returns 合并后的完整偏好。
 */
export async function writeNotifyPrefs(patch: unknown): Promise<NotifyPrefs> {
  /* 先读盘上的、再用 patch 覆盖 —— 顺序反过来就成了「整份替换」，
   * 那样改一个开关会把另一个打回默认。 */
  const base = await readNotifyPrefs()
  const raw = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
    ? { ...base, ...(patch as Record<string, unknown>) }
    : base
  const merged = normalize(raw, base)
  const file = notifyPrefsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}
