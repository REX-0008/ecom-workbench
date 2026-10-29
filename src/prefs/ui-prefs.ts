/** 界面偏好的**落盘**（用户 2026-10-22：「重启桌面端就丢」）。
 *
 * ## 为什么要落盘
 *
 * 启动器用 `--port 0`（系统每次分配不同端口），而浏览器的 localStorage 按
 * 「域名 + 端口」隔离 —— 端口一变，之前存的偏好就读不到了。
 * 所以凡是「跨重启要记住」的界面开关都得落到文件：
 * `$DSH_HOME/AGENTS.md` 的「启动与配置」节明写着这条。
 *
 * 现在存在文件里的五个键（原来各存在 localStorage 里，见 `src/client/workbench/`）：
 *
 * | 字段 | 原来那个键 | 作用 |
 * | --- | --- | --- |
 * | `topHidden` | `ewb.topHidden` | 顶部面包屑与大标题是否收起 |
 * | `navCollapsed` | `ewb.navCollapsed` | 侧栏是否收起 |
 * | `libW` | `ewb.libW` | 节点库宽度 |
 * | `legend` | `ewb.legend` | 端口图例开关 |
 * | `nodeW` | `ewb.nodeW` | 节点宽度 |
 *
 * ## 与浏览器偏好同一套分工
 *
 * 文件是权威（宿主半只读它），localStorage 以后退成画布的快速缓存。
 * 落盘位置与 `browser-prefs.json`、`notify-prefs.json` **同目录同级**
 * （插件数据目录，`workflows/` 的上一层）。
 *
 * ## 读的一律容错、写的是**部分更新**
 *
 * 这份文件是**手也能改**的（就在数据目录里）。所以：
 *
 *   - 读：文件不存在 / JSON 坏 / 某个字段非法 → **逐字段回落默认值**，不抛错、不建文件。
 *     一个字段写坏了不该把其它四个开关也重置（那是「整份作废」的坏处）。
 *   - 写：只改传进来的键，其余保持原值；非法字段**跳过**，合法字段照样生效。
 *
 * 默认值与取值范围抄自现行代码，**别在这里另定一套**：
 * `WorkflowCanvas.tsx` 的 `LIB_W_DEFAULT`（票 58 起 260 / 180–460）、`SettingsDrawer.tsx:65-68`
 * （nodeW 300 / 200–520）、`WorkflowCanvas.tsx:323`（legend 默认开）、
 * `EcomWorkbench.tsx`（topHidden / navCollapsed 默认关）。
 * ⚠️ 故意**不 import 那两个客户端文件** —— `SettingsDrawer.tsx` 是 `.tsx`，
 * 引进来会把 React 与样式拖进宿主半的产物。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { workflowsDir } from '../workflow/store.ts'

/** 界面偏好（五个跨重启要记住的开关与尺寸）。 */
export interface UiPrefs {
  /** 顶部面包屑与大标题是否收起。 */
  topHidden: boolean
  /** 侧栏是否收起。 */
  navCollapsed: boolean
  /** 节点库宽度（像素）。 */
  libW: number
  /** 端口图例是否显示。 */
  legend: boolean
  /** 节点卡片宽度（像素）。 */
  nodeW: number
  /**
   * 内容画布侧栏宽度（像素，票 58，2026-10-29）。
   *
   * ## 为什么要存
   *
   * 票 58 之前内容画布那个侧栏的宽度与折叠状态**哪里都不存** ——
   * 宽度是父组件传的 props，折叠也是。用户拖完一刷新就回默认。
   * 执行画布那边早就存在这份偏好了（`libW`），两边要对齐就得都存。
   *
   * ## 为什么是**可选**字段
   *
   * 这个文件宿主半与客户端**共用**（`WorkflowCanvas.tsx` 与
   * `dispatch-client.ts` 都读它）。老存档里没有这两个键 ——
   * 做成必填会让「读一份老 `ui-prefs.json`」直接缺字段，
   * 调用方拿到的对象形状就不对了。
   *
   * 可选 + 调用方 `?? 默认值`，老存档读出来就是干净的两个 `undefined`。
   */
  contentSideW?: number
  /** 内容画布侧栏是否折叠（票 58）。可选的理由同上。 */
  contentSideCollapsed?: boolean
}

/** 偏好文件名（插件数据目录下，与 `browser-prefs.json` 同级）。 */
export const UI_PREFS_FILE = 'ui-prefs.json'

/**
 * 节点库（执行画布侧栏）宽度的取值范围。
 *
 * ⚠️ **2026-10-29（票 58）160–420 → 180–460**：用户定两侧栏默认宽度统一 260，
 * 而 260 落在 160–420 里本来也合法 —— 改范围是因为**两侧栏要能拖到一样的边界**：
 * 内容画布那边 `clampPanelWidth` 是 180–460（`CanvasSidePanel.tsx:66`），
 * 执行画布若只到 420，同样拖到底一边 460 一边 420。
 *
 * ⚠️ **这两个数在两处出现、必须同一组**：
 *   · 本文件的 `LIB_W_MIN` / `LIB_W_MAX`（宿主半校验）
 *   · `dispatch-client.ts:1004` 的 `n(UI_PREF_KEYS.libW, 180, 460)`（前端读缓存）
 * 只改一处会出现「拖到 450 存进去、刷新读回 420」。
 * `tests/ui-prefs.mjs` 有一条断言直接读**两处源码**比这组数 —— 将来谁漏改会红。
 */
const LIB_W_MIN = 180
const LIB_W_MAX = 460
/** 节点宽度的取值范围（`SettingsDrawer.tsx:65-66`）。 */
const NODE_W_MIN = 200
const NODE_W_MAX = 520

/**
 * 内容画布侧栏宽度的取值范围（票 58）。
 *
 * ⚠️ 与 `CanvasSidePanel.tsx:60-62` 的 `PANEL_MIN` / `PANEL_MAX` **必须同一组**：
 * 那边是拖动时的钳制，这里是落盘时的校验。两处不一致会出现
 * 「拖到 180 存进去、读回来被打回 260」。
 */
const CONTENT_SIDE_W_MIN = 180
const CONTENT_SIDE_W_MAX = 460

/**
 * 偏好文件的绝对路径。
 *
 * ⚠️ 用 `workflowsDir` 的父目录 —— 与 `browser-prefs.json` / `notify-prefs.json`
 * 同一个写法，不在这里另写一遍目录解析规则（沙箱与降级路径自动一致）。
 *
 * @returns 绝对路径。
 */
export function uiPrefsFile(): string {
  return join(workflowsDir(), '..', UI_PREFS_FILE)
}

/**
 * 一份全默认的偏好。
 *
 * @returns 默认值（每次给新对象，调用方改了不污染别人）。
 */
export function defaultUiPrefs(): UiPrefs {
  /* ⚠️ 2026-10-29（票 58）`libW` 212 → **260**：用户定两侧栏默认宽度统一 260。
   * 内容画布那边 `clampPanelWidth` 的回落值也是 260（`CanvasSidePanel.tsx:66`），
   * 两边默认值与回落值都对齐。 */
  return { topHidden: false, navCollapsed: false, libW: 260, legend: true, nodeW: 300 }
}

/** 布尔字段：只认真正的 `true` / `false`（`'yes'`、`1` 一律当没填）。 */
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

/** 数值字段：必须是**有限数**且落在区间内，越界回落默认。 */
function num(v: unknown, min: number, max: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return v >= min && v <= max ? Math.round(v) : dflt
}

/**
 * 把任意输入逐字段归一。
 *
 * 非法字段**单独**回落 `fallback` 里对应的值，不影响其它字段 —— 这是本文件的要害：
 * 「手改坏了一个数」不该让另外四个开关一起重置。
 *
 * ⚠️ `fallback` 分两种用法，别合并成一种：
 *   - **读**时回落**默认值**（盘上没有可用值）；
 *   - **写**时回落**盘上原值**（`writeUiPrefs` 的部分更新 —— 非法字段等于「跳过」，
 *     要保持原值，而不是打回默认。第一版就是错在这一点上）。
 *
 * @param raw - 读到的 JSON（可能是 null / 字符串 / 残缺对象）。
 * @param fallback - 某个字段不可用时用它。
 * @returns 偏好（一定带齐五个字段）。
 */
function normalize(raw: unknown, fallback: UiPrefs): UiPrefs {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const o = raw as Record<string, unknown>
  return {
    topHidden: bool(o.topHidden, fallback.topHidden),
    navCollapsed: bool(o.navCollapsed, fallback.navCollapsed),
    libW: num(o.libW, LIB_W_MIN, LIB_W_MAX, fallback.libW),
    legend: bool(o.legend, fallback.legend),
    nodeW: num(o.nodeW, NODE_W_MIN, NODE_W_MAX, fallback.nodeW),
    /* ★ 票 58：两个**可选**字段。没给就**不写进结果**（保持 `undefined`），
     * 而不是填一个默认值 —— 那样调用方分不清「用户设过 260」与「从没设过」。 */
    ...o.contentSideW === undefined
      ? {}
      : { contentSideW: num(o.contentSideW, CONTENT_SIDE_W_MIN, CONTENT_SIDE_W_MAX, fallback.contentSideW ?? 260) },
    ...o.contentSideCollapsed === undefined
      ? {}
      : { contentSideCollapsed: bool(o.contentSideCollapsed, fallback.contentSideCollapsed ?? false) },
  }
}

/**
 * 读界面偏好。
 *
 * 文件不存在 / JSON 坏 / 个别字段非法 → 逐字段回落默认值，**不抛错、不建文件**。
 *
 * @returns 偏好（一定可用）。
 */
export async function readUiPrefs(): Promise<UiPrefs> {
  try {
    const text = await readFile(uiPrefsFile(), 'utf8')
    return normalize(JSON.parse(text), defaultUiPrefs())
  } catch {
    return defaultUiPrefs()
  }
}

/**
 * 写界面偏好（**部分更新**）。
 *
 * 只改传进来的键，其余保持盘上的原值；非法字段跳过，合法字段照样生效。
 * 返回合并后的完整对象 —— 调用方照它回话，界面上就不会出现「显示成功了，其实没存」。
 *
 * @param patch - 要改的那几个键（任意输入，坏值由 `normalize` 逐个挡掉）。
 * @returns 合并后的完整偏好。
 */
export async function writeUiPrefs(patch: unknown): Promise<UiPrefs> {
  /* 先读盘上的、再用 patch 覆盖 —— 顺序反过来就成了「整份替换」，
   * 那样改一个开关会把另外四个打回默认。
   * 非法字段以**盘上原值**为回落（等于「跳过这个字段」），不打回默认。 */
  const base = await readUiPrefs()
  const raw = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
    ? { ...base, ...(patch as Record<string, unknown>) }
    : base
  const merged = normalize(raw, base)
  const file = uiPrefsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}
