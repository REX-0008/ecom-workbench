/** 工作台级设置：**跨所有工作流共用**的那些（目前只有浏览器）。
 *
 * ## 为什么它要独立于「画布设置」（2026-10-22）
 *
 * 原来 7 项设置混在一个抽屉里：
 *
 * | 项 | 作用范围 |
 * | --- | --- |
 * | 节点宽度 / 展开高度 / 背景透明 / 间距 / 输出高度 | **画布**怎么画（只影响这张图） |
 * | 快捷键表 | 画布操作说明 |
 * | **浏览器**（来源 / 端口 / 检测） | **工作台级**：会话与登录态，跨所有工作流共用 |
 *
 * 前六项进画布抽屉是合理的（就在画布工具条上，就地调）；而浏览器那一段与「当前这张图」
 * 毫无关系 —— 它是整台机器的浏览器怎么用。放画布抽屉里有两个后果：
 *   ① 要改浏览器得先进画布、再点设置，路径与它的作用范围不匹配；
 *   ② 用户在**别的板块**（取数、定时）想看看浏览器选对没有，根本进不去。
 *
 * 所以搬到**侧栏底部的齿轮**：那是「工作台这一层」的位置，与它的作用范围一致。
 *
 * ## ⚠️ 只有一个入口
 *
 * 浏览器设置**只在**这里能改（画布抽屉里那一行已删）。两处都能改比没有更糟 ——
 * 用户在这边改完、那边还显示旧值，会以为没生效。
 *
 * 节点设置里的「标签 → 浏览器」（`NodeBrowserSection`）**不是另一个入口**：
 * 它改的是「这个节点用哪个标签」，属于流程级；第二层的浏览器配置只有本文件能改。
 * （分工见 `BrowserSettings.tsx` 与 `browser-settings.ts` 的文件头。）
 *
 * ## 为什么偏好状态放在这里而不是各组件自己 useState
 *
 * 两个地方要用同一份：
 *   · 本文件（改）；
 *   · `WorkflowCanvas.tsx`（读 —— 它要把第二层解析进每个节点的 params）。
 *
 * 两处各持一份的话，一边改完另一边不更新，节点上算出来的浏览器就与设置面板不一致
 * （`pitfalls/同一件事写两份迟早漂.md`）。所以做成**模块级共享状态 + 订阅**，
 * 与 `browser-detect-store.ts` 同一个套路（理由也一样：跨组件的共享只读数据，
 * 放进全局 store 反而要处理更多订阅与清理）。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
/* ★ 自己的宽面板样式（2026-10-23）。
 *
 * ⚠️ **为什么不再用 `workflow-canvas.module.css` 的那套**：那份的抽屉是
 * `min(340px, 80%)`，装不下模型行右边那两个动作按钮（用户 m02240 报的
 * 「很多模型被压到右侧点不到」就是这个）。两份用途不同，所以类也分开：
 * 画布抽屉保持窄，工作台设置这个 720 宽。理由写在 `WorkbenchSettings.module.css` 头里。 */
import ws from './WorkbenchSettings.module.css'
import { BrowserSettings } from './BrowserSettings.tsx'
import { readPrefs, writePrefs, type BrowserPrefs } from './browser-settings.ts'
import { saveBrowserPrefs } from './dispatch-client.ts'
/* ★ 票 69：内容区限宽也住在这份工作台偏好里（见 `lib/workbench-prefs.ts` 的
 * `contentMaxWidth`）。读写走同一套实现，不在这里另开一份。 */
import {
  CONTENT_MAX_WIDTHS, currentWorkbenchPrefs, normalizeContentMaxWidth,
  subscribeWorkbenchPrefs, updateWorkbenchPrefs,
} from './lib/workbench-prefs.ts'
import {
  ALERT_LEVELS, alertLevelLabel, loadNotifyPrefs, saveNotifyPrefs,
  type AlertMinLevel, type NotifyPrefs,
} from './dispatch-client.ts'
import { call } from './board-kit.ts'
import { NotifyDiagnostics } from './NotifyDiagnostics.tsx'
/* ★ 渠道与四类默认模型（票 38，2026-10-28 从内容板块的配置页上收）。
 *
 * ## 为什么搬到这里
 *
 * 用户原话（票 37 条目一）：「模型方面的配置，工作台级设置其实有这个内容了，
 * 是不是这里的渠道、默认模型应该放到工作台设置中。……其他三项提示词源、存储、
 * 偏好保留在内容板块，这个是板块设置。」
 *
 * 判据：渠道是**跨板块共用**的资源（内容生图要用，将来别的板块也要用），
 * 它的作用范围与「工作台级」一致，不是某一个板块自己的事。
 *
 * ## ⚠️ 与本节已有的「节点默认模型」不是一回事
 *
 * 见 `ModelSettings` 里那段注释：一个是 dsh 模型目录（`{provider, model}`），
 * 一个是内容渠道（`{channelId, modelId}`），形状都不同、不可互相回落。
 * 两者现在**同居一个抽屉**，所以名字必须自证身份 —— 这也是本节三块标题
 * 刻意写成「模型 / 内容渠道 / 内容默认模型」而不是都叫「模型」的原因。 */
import { ChannelSettings } from './ChannelSettings.tsx'
import { DefaultsSettings } from './DefaultsSettings.tsx'

/* ── 共享状态 ─────────────────────────────────────────────────────────── */

/** 当前偏好（模块级，唯一真值来源）。 */
let prefs: BrowserPrefs = readPrefs()

/** 订阅者。 */
const listeners = new Set<(p: BrowserPrefs) => void>()

/**
 * 读当前偏好（给非组件代码用）。
 * @returns 偏好。
 */
export function currentBrowserPrefs(): BrowserPrefs {
  return prefs
}

/**
 * 改偏好：更新共享状态 → 写缓存 → 写宿主半文件 → 通知订阅者。
 *
 * ## 两处都要写（2026-10-20 的教训）
 *
 *   - `localStorage`（`writePrefs`）：画布的快速缓存，首帧靠它；
 *   - 宿主半那份文件（`saveBrowserPrefs`）：从列表 / 定时启动时宿主半读它补端口
 *     —— 它读不到 `localStorage`。
 *
 * 只写缓存就是用户报过的那个 bug：「从画布跑得了、从列表启动找不到浏览器」。
 *
 * @param next - 新偏好。
 */
export function updateBrowserPrefs(next: BrowserPrefs): void {
  prefs = next
  writePrefs(next)
  void saveBrowserPrefs(next).then((r) => {
    if (!r.ok) console.warn('[浏览器偏好] 没存进宿主半：' + String(r.error ?? ''))
  })
  for (const cb of listeners) {
    try { cb(next) } catch { /* 一个订阅者抛错不该拖垮别的 */ }
  }
}

/**
 * 订阅浏览器偏好（组件用）。
 *
 * 订阅时**若已有值就立刻回调一次** —— 否则「值比组件先更新」时那个组件会一直等下一次变化。
 *
 * @param cb - 收到新偏好时调用。
 * @returns 退订函数。
 */
export function subscribeBrowserPrefs(cb: (p: BrowserPrefs) => void): () => void {
  listeners.add(cb)
  cb(prefs)
  return () => { listeners.delete(cb) }
}

/**
 * 组件里读浏览器偏好（会自动跟着变）。
 *
 * ⚠️ 不用 `useSyncExternalStore`：那要一个**稳定引用**的快照，
 * 而 `BrowserPrefs` 是对象、每次 `updateBrowserPrefs` 都换新引用 —— 用起来更绕。
 * `useState` + 订阅在这个数据量下足够（改的是低频设置，不是每帧都变）。
 *
 * @returns 当前偏好。
 */
export function useBrowserPrefs(): BrowserPrefs {
  const [value, setValue] = useState<BrowserPrefs>(prefs)
  useEffect(() => subscribeBrowserPrefs(setValue), [])
  return value
}

/* ── 模型清单：一次请求、两处共用 ─────────────────────────────────────
 *
 * ## 为什么也必须做成模块级缓存 + 订阅
 *
 * 「有哪些模型可选」有两个地方要用：
 *   ① 本文件的工作台设置（看全部、设默认、增减备选）；
 *   ② `NodeEditorPopover.tsx` 的 `kind: 'model'` 控件（选一个模型）。
 *
 * 两处各拉一次 `/models` 会有三个后果：两次往返；回来先后不定导致两处看到
 * 不一样的清单；节点展开一次就拉一次（节点要频繁开关）。
 * 与 `useBrowserPrefs` 同一个套路，理由也一样 —— 跨组件共享的**只读数据**，
 * 放进全局 store 反而要处理更多订阅与清理。
 *
 * ## 形状照计划 §2.4（接口由契约 H 实现）
 *
 * ⚠️ 接口若还不存在，`call()` 会回 `ok: false`。这里**不重试、不兜假数据**：
 * 把原因原样交给界面显示（「读不到模型列表：…」），页面照常打开。
 * 假装「没有模型」比空白更糟 —— 用户会去 dsh 里反复翻设置。
 *
 * ## 为什么这份缓存住在本文件、不单开一个 `model-store.ts`
 *
 * 契约给的可改路径只有本文件与 `NodeEditorPopover.tsx`，新建文件不在其中。
 * 这与浏览器偏好那套放在同一个文件是同一个取舍 —— 共享状态的**主要使用者**
 * 就是这个设置面板，另一处是消费者。
 */

/** 一条模型选择（`provider/model`，与 `src/workflow/model.ts` 的存档形状一致）。 */
export interface ModelPick {
  /** 提供方 id（如 `deepseek-official`）。 */
  provider: string
  /** 模型 id（如 `deepseek-v4-flash`）。 */
  model: string
}

/** 一个模型（`llm.listModels()` 的子集）。 */
export interface ModelInfo {
  /** 模型 id（存进存档的就是它）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 一句话说明（可能没有）。 */
  description?: string
}

/** 一个提供方及其模型。 */
export interface ModelProvider {
  /** 提供方 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 这个提供方下的模型（`listModels` 抛错时这里是空数组）。 */
  models: readonly ModelInfo[]
}

/** 模型偏好（`model-prefs.json` 的形状）。 */
export interface ModelPrefs {
  /** 工作台默认模型；`null` = 没设过，走 dsh 的全局选择。 */
  default: ModelPick | null
  /** 备选名单（节点下拉里出现的就是它）。 */
  picks: readonly ModelPick[]
}

/** `/models` 的返回。 */
export interface ModelCatalog {
  /** 全部提供方与它们的模型。 */
  providers: readonly ModelProvider[]
  /** 工作台自己那份偏好。 */
  prefs: ModelPrefs
  /** dsh 当前选中的模型（拿不到给 `null`）。 */
  current: ModelPick | null
}

/** 把一条选择写成存档里的字符串（显示用）。 */
export function modelPickKey(pick: ModelPick): string {
  return pick.provider + '/' + pick.model
}

/** 当前缓存（`null` = 还没拿到）。 */
let catalog: ModelCatalog | null = null
/** 读失败的原因（成功时为 undefined）。 */
let catalogError: string | undefined
/** 正在飞的那次请求（并发去重：两个组件同时挂载只发一次）。 */
let catalogFlight: Promise<void> | null = null
/** 是否已经**尝试过**读一次（成功失败都算）。
 *
 * ## 为什么要有它
 *
 * 光判 `catalog !== null` 不够：读失败时 `catalog` 一直是 null，
 * 于是「节点每展开一次」「设置每打开一次」都会重发一次请求 ——
 * 接口没上那段时间里，开关十次节点就是十次往返。
 *
 * 所以失败也记一笔：之后**只在按「重读」时**再试（`force`）。
 * 代价是「接口后来好了」需要用户点一下，这比每次挂载都静默重试好 ——
 * 后者在宿主半没起时会一直打，日志里全是同一句错。
 */
let catalogAttempted = false
/** 订阅者。 */
const catalogListeners = new Set<() => void>()

/** 通知所有订阅者（清单或偏好变了）。 */
function publishCatalog(): void {
  for (const cb of catalogListeners) {
    try { cb() } catch { /* 一个订阅者抛错不该拖垮别的 */ }
  }
}

/**
 * 确保「从宿主半读模型清单」这件事已经发起过（幂等）。
 *
 * 失败**只记原因**，不抛、不重试：模型面板与节点下拉各自显示那句话即可。
 *
 * @param force - 传 true 时重新读一次（「重读」按钮用）。
 * @returns 完成（失败也算完成）。
 */
export function ensureModelsLoaded(force = false): Promise<void> {
  if (!force && catalogFlight !== null) return catalogFlight
  if (!force && catalogAttempted) return Promise.resolve()
  catalogAttempted = true
  catalogFlight = (async (): Promise<void> => {
    const r = await call<{
      providers?: readonly ModelProvider[]
      prefs?: ModelPrefs
      current?: ModelPick | null
    }>('/models')
    if (!r.ok || r.body === undefined) {
      catalogError = r.error ?? '宿主半没有回内容'
      /* ⚠️ 保留上一次成功拿到的那份（刷新失败不该把界面清空）。 */
      publishCatalog()
      return
    }
    const body = r.body
    catalogError = undefined
    catalog = {
      providers: Array.isArray(body.providers) ? body.providers : [],
      prefs: {
        default: body.prefs?.default ?? null,
        picks: Array.isArray(body.prefs?.picks) ? body.prefs.picks : [],
      },
      current: body.current ?? null,
    }
    publishCatalog()
  })().finally(() => { catalogFlight = null })
  return catalogFlight
}

/**
 * 订阅模型清单（组件用）。
 *
 * 订阅时**若已经有值就立刻回调一次**，理由同 `subscribeBrowserPrefs`：
 * 否则「清单比组件先到」时组件会一直等下一次变化。
 *
 * @param cb - 清单或错误变化时调用。
 * @returns 退订函数。
 */
export function subscribeModels(cb: () => void): () => void {
  catalogListeners.add(cb)
  cb()
  return () => { catalogListeners.delete(cb) }
}

/**
 * 布局（票 69，用户 2026-10-29）。
 *
 * ## 用户原话
 *
 * > 内容区限宽，这个做到设置里面去吧，浏览器、提醒、内容区限宽都做为一个 tab 的内容先。
 *
 * ## 这一块只有一行，且**不写说明**
 *
 * 用户 2026-10-29 另一句：「说明文字尽量不写，看不出后果的开关简写。」
 * 这一项**看得出后果**（拖着窗口宽度就能看出变没变），所以不写。
 *
 * ## 为什么选项是五档而不是手填
 *
 * 见 `lib/workbench-prefs.ts` 的 `CONTENT_MAX_WIDTHS`：用户看不出
 * 「1387 和 1440 差在哪」，给手填只会让人反复试。
 *
 * @returns 界面。
 */
export function LayoutSettings() {
  const prefs = useSyncExternalStore(
    subscribeWorkbenchPrefs,
    currentWorkbenchPrefs,
    currentWorkbenchPrefs,
  )
  /**
   * 改一档。
   * @param raw - 下拉给的值（字符串）。
   */
  const change = (raw: string): void => {
    /* 走 `normalizeContentMaxWidth`：界面给的是字符串，坏值回缺省 ——
     * 与读盘走同一条判据，不在这里另写一份 `Number(...)`。 */
    updateWorkbenchPrefs({ contentMaxWidth: normalizeContentMaxWidth(raw) })
  }
  return (
    <div className={ws.section} data-ewb-layout-section="">
      <div className={ws.sectionTitle}>布局</div>
      <div className={ws.row}>
        <span className={ws.rowLabel}>内容区限宽</span>
        <select
          data-ewb-layout-width=""
          className={ws.input}
          value={String(prefs.contentMaxWidth)}
          onChange={(e) => { change(e.target.value) }}
        >
          {CONTENT_MAX_WIDTHS.map(w => (
            <option key={w} value={String(w)}>{w === 0 ? '不限宽' : String(w)}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

/**
 * 组件里读模型清单（会自动跟着变，且首次挂载会自动触发一次读取）。
 *
 * @returns 清单、错误原因、是否还在读。
 */
export function useModels(): {
  catalog: ModelCatalog | null
  error: string | undefined
  loading: boolean
} {
  const [snap, setSnap] = useState<{ c: ModelCatalog | null, e: string | undefined }>({
    c: catalog, e: catalogError,
  })
  useEffect(() => {
    const cb = (): void => { setSnap({ c: catalog, e: catalogError }) }
    const off = subscribeModels(cb)
    void ensureModelsLoaded()
    return off
  }, [])
  return { catalog: snap.c, error: snap.e, loading: snap.c === null && snap.e === undefined }
}

/**
 * 改模型偏好（**部分更新**：只传要改的那个键）。
 *
 * 失败时界面的旧值**保持不变**，并把原因交给调用方显示 ——
 * 与提醒偏好那条同一条纪律（改了没生效却显示已改，比不显示更糟）。
 *
 * @param patch - 只含要改的键（`default` 或 `picks`）。
 * @returns 结果（永不抛异常）。
 */
export async function saveModelPrefs(
  patch: { default?: ModelPick | null, picks?: readonly ModelPick[] },
): Promise<{ ok: boolean, error?: string }> {
  const r = await call<{ prefs?: ModelPrefs, error?: string }>('/models/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!r.ok) return { ok: false, error: r.error ?? '保存失败' }
  /* 宿主半回的是**合并后的完整偏好**，照它更新本地缓存即可（不用再 GET）。 */
  if (r.body?.prefs !== undefined && catalog !== null) {
    catalog = {
      ...catalog,
      prefs: {
        default: r.body.prefs.default ?? null,
        picks: Array.isArray(r.body.prefs.picks) ? r.body.prefs.picks : [],
      },
    }
    publishCatalog()
  }
  return { ok: true }
}

/* ── 界面 ─────────────────────────────────────────────────────────────── */

/* ── 「提醒」一节的两组选项与说明 ───────────────────────────────────────
 *
 * ## 每个选项各带一句说明，界面**只显示当前选中那一句**
 *
 * 用户原话（m02240）：「说明文案只放当前选项的说明，**为每个选项做说明然后切换**」。
 *
 * 为什么这样定：旧界面把四档的含义一次铺成四行（`NotifyBoard.tsx` 里那张
 * 「不发送 / 信息及以上 / 注意及以上 / 严重及以上」的对照表）。四条并排时
 * 用户的视线要来回比「这两档差在哪」，而且**当前选的是哪一档**反而不显眼。
 * 改成「选哪个就说哪个」之后，一屏只有一句话，读起来是「我现在这样」。
 *
 * 代价如实记：换档位时说明会变，用户没法在同一屏对照两档的差别。
 * 这个代价是可接受的 —— 要对照也只需要点一下另一档。
 *
 * ## 文案的出处
 *
 * 级别的三个说法（信息 / 注意 / 严重）与它们的一句话，全部来自
 * `dispatch-client.ts` 的 `ALERT_LEVELS`（那是与 `flow.notify` 节点
 * `level` 选项**同一套**的说法，不在这里另编一套）。
 * `off` 那一档是我们界面自己加的（"不发送"），说明也是我们写的。
 */

/** 失败提醒两态的说明（值 → 一句话）。 */
const FAIL_NOTE: Record<'on' | 'off', string> = {
  on: '定时任务跑失败、挂起的运行到点续不上，各发一条系统通知。这两类共用这一项。',
  off: '上面两类失败都不发通知，失败原因仍记在「运行历史」里。',
}

/**
 * 预警节点四档的说明（值 → 一句话）。
 *
 * ⚠️ 三档正文取自 `ALERT_LEVELS` 的 `label` + `note`，**不在这里另写**；
 * 这里只负责把 `off` 补上，并把「及以上」的推断写出来。
 */
function alertNote(v: AlertMinLevel): string {
  if (v === 'off') return '工作流里「通知」节点一律不发。这一项与上面的失败提醒互不影响。'
  const i = ALERT_LEVELS.findIndex(l => l.value === v)
  const hit = ALERT_LEVELS[i]
  if (hit === undefined) return '工作流里「通知」节点一律不发。'
  const higher = ALERT_LEVELS.slice(i + 1).map(l => l.label)
  const tail = higher.length === 0 ? '没有更高的档位' : '以及更高的「' + higher.join('」「') + '」'
  return '工作流里「通知」节点的级别：' + hit.label + '（' + hit.note + '）' + tail + '都发。'
}

/**
 * 「提醒」设置一段：两项独立设置，说明只显示当前选中那一项。
 *
 * ## 两项**各自独立**（2026-10-22 定的语义，本次搬家一字未改）
 *
 * | 字段 | 管什么 |
 * | --- | --- |
 * | `failNotify` | 失败类：定时任务失败 + 挂起恢复失败 |
 * | `alertMinLevel` | 预警节点（`flow.notify`）的级别门槛 |
 *
 * 写的时候**只提交要改的那一个键**：整份提交会把用户刚改的另一项打回去
 * （两个标签页同开时尤其明显）。
 *
 * ## 读失败不冒充默认值
 *
 * `prefs === null` 时两个选项都**不选中**、并给三段式说明 + 「重试」。
 * 拿 `DEFAULT` 冒充会把「读不到」显示成「已经是这样的设置」，那是假成功。
 *
 * @returns 设置段元素。
 */
/* ⚠️ 票 66：改成 export —— 它们现在由 `ConfigBoard.tsx` 的「其它」那一格渲染。
 * 原来的抽屉（`WorkspaceSettings` 函数）已经删了，这两个跟着内容搬进板块。 */
export function NotifySettings() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState<'fail' | 'alert' | null>(null)

  /** 读当前偏好（`null` = 还没读到，不是「全关」）。 */
  const load = useCallback((): void => {
    void (async () => {
      const r = await loadNotifyPrefs()
      if (!r.ok || r.prefs === undefined) {
        setPrefs(null)
        setErr('读不到当前提醒设置：' + (r.error ?? '宿主半没有回应')
          + '。设置存在宿主半的数据目录，读不到时不知道现在按什么规则发；'
          + '点「重试」再读一次，仍读不到就检查工作台引擎是否在运行。')
        return
      }
      setErr('')
      setPrefs(r.prefs)
    })()
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * 改**其中一项**。
   *
   * 三条与搬家前一样：只提交那个键、用响应里的 `prefs` 更新（宿主半对非法值
   * 会回落到盘上原值且仍回 200）、失败保留原选中。
   *
   * @param patch - 要改的那一项。
   */
  const commit = (patch: Partial<NotifyPrefs>): void => {
    if (saving !== null) return
    setSaving(patch.alertMinLevel === undefined ? 'fail' : 'alert')
    setErr('')
    void (async () => {
      const r = await saveNotifyPrefs(patch)
      setSaving(null)
      if (!r.ok || r.prefs === undefined) {
        setErr('提醒设置没有保存成功：' + (r.error ?? '宿主半没有说明原因')
          + '。设置写在宿主半的数据目录里，写不进去通常是磁盘或权限问题；'
          + '原来的设置仍然有效，可再点一次重试。')
        return
      }
      setPrefs(r.prefs)
    })()
  }

  const failValue: 'on' | 'off' = prefs?.failNotify === true ? 'on' : 'off'
  const alertValue: AlertMinLevel = prefs?.alertMinLevel ?? 'off'
  const ALERT_CHOICES: readonly AlertMinLevel[] = ['off', ...ALERT_LEVELS.map(l => l.value)]

  return (
    <div className={ws.section} data-ewb-notify-section="">
      <div className={ws.sectionTitle}>提醒</div>

      {prefs === null && err === '' && (
        <div className={ws.note}>正在读取当前设置…</div>
      )}
      {err !== '' && (
        <div className={ws.note} data-ewb-notify-error="">
          {err}
          <div style={{ marginTop: '6px' }}>
            <button type="button" className={ws.btn} onClick={load}>重试</button>
          </div>
        </div>
      )}

      {/* ── ① 工作流失败提醒 ─────────────────────────────────── */}
      <div className={ws.row} data-ewb-notify-fail="">
        <span className={ws.rowLabel}>工作流失败提醒</span>
        {(['on', 'off'] as const).map(v => {
          const on = prefs !== null && failValue === v
          return (
            <button
              key={v}
              type="button"
              className={on ? ws.btnOn : ws.btn}
              data-ewb-notify-fail-option={v}
              aria-pressed={on}
              disabled={saving !== null || prefs === null}
              onClick={() => { commit({ failNotify: v === 'on' }) }}
            >{v === 'on' ? '提醒' : '不提醒'}</button>
          )
        })}
      </div>
      {/* ⚠️ 只显示**当前选中那一项**的说明。读不到时什么都不写 —— 不猜。 */}
      {prefs !== null && (
        <div className={ws.note} data-ewb-notify-fail-note="">{FAIL_NOTE[failValue]}</div>
      )}

      {/* ── ② 预警节点提醒 ───────────────────────────────────── */}
      {/* 副标题：节内第二层，比节标题小一档（2026-10-23 契约 Y 统一版式）。
       * 不再用内联 `marginTop` 制造间距 —— 那会让三块的节奏各不相同。 */}
      <div className={ws.subTitle}>预警节点提醒</div>
      <div className={ws.row} data-ewb-notify-alert="">
        {ALERT_CHOICES.map(v => {
          const on = prefs !== null && alertValue === v
          return (
            <button
              key={v}
              type="button"
              className={on ? ws.btnOn : ws.btn}
              data-ewb-notify-alert-option={v}
              aria-pressed={on}
              disabled={saving !== null || prefs === null}
              onClick={() => { commit({ alertMinLevel: v }) }}
            >{alertLevelLabel(v)}</button>
          )
        })}
      </div>
      {prefs !== null && (
        <div className={ws.note} data-ewb-notify-alert-note="">{alertNote(alertValue)}</div>
      )}

      <div className={ws.note} style={{ marginTop: '6px' }}>
        两项互不影响：一项关掉，另一项照自己的规则发。
      </div>

      {/* ── 底部：折叠的诊断块（2026-10-23 契约 P 定）────────────────────
       *
       * 这里是「通知通道自检」与「什么情况会提醒」两块**运行时诊断**。
       * 它们原先住在左侧导航的「提醒」板块里（`NotifyBoard.tsx`）；板块下线后
       * 没入口就等于删了，但用户当初正是靠自检发现「系统通知总开关被关了」，
       * 删了会丢掉唯一的排查手段。
       *
       * 放在**设置主选项区之外**（折叠、在最后）：一个「点一下会真的弹通知」的按钮
       * 混在选项里，会让人分不清「我现在选什么」与「它现在怎么样」。
       *
       * `prefs` 直接传下去 —— 这一节已经读过一次，诊断块不再请求第二遍。 */}
      <NotifyDiagnostics prefs={prefs} />
    </div>
  )
}

/**
 * 「模型」设置一段：看全部模型、设默认、增减备选名单。
 *
 * ## 三条判断为什么这么定
 *
 * ① **不把所有模型自动进备选**：用户原话「不是所有的 dsh 模型都读入工作台」。
 *    所以这里没有「全选」按钮，也没有任何自动填充 —— 进备选只能一个一个点。
 * ② **不一次铺开**：一个 provider 可能有几十个模型。默认按 provider 折叠
 *    （`<details>`），另给一个搜索框按名字过滤 —— 两样交叉用，找得动也不长。
 * ③ **读不到就说原因**：宿主半没起 / 接口还没上时，明确写「读不到模型列表」
 *    加原因，不空白、也不假装「没有模型」。
 *
 * ## 刷新失败不清空
 *
 * `ensureModelsLoaded` 失败时保留上一次成功那份（见它的注释）——
 * 这里只额外显示一行原因。
 *
 * @returns 设置段元素。
 */
/* ⚠️ 票 66：改成 export —— 它现在由 `ConfigBoard.tsx` 的「模型」那一格渲染。
 *
 * ⚠️ **2026-10-29（票 68）外面包了一层默认收起的 `<details>`**。
 *
 * 用户原话：「将 dsh 的模型清单默认收起，太长了，点击展开选择即可」。
 *
 * 为什么整节都收进去（而不是只收「全部可用模型」那一半）：
 * 这一节的三块是一条链 —— 先定「节点默认用哪个」、再定「备选名单有哪几个」、
 * 最后是「dsh 一共有哪些可挑」。前两块离开第三块就没法用（备选名单是从清单里挑的），
 * 拆成「收起一半」只会让用户点开之后还得再找。
 *
 * ⚠️ 收起的实现是原生 `<details>`（不是自己用 state 控制显隐）：
 * 原生元素自带键盘可达与无障碍语义，`open` 属性的存在与否也是**能被断言的**
 * （判据 6 钉的就是「默认 open 为 false」）。
 *
 * 钩子 `data-ewb-model-section` 留在 `<details>` 上 —— 测试按它找这一节。 */
export function ModelSettings() {
  const { catalog, error, loading } = useModels()
  const [q, setQ] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const prefs = catalog?.prefs ?? { default: null, picks: [] }
  const picks = prefs.picks
  const pickKeys = picks.map(modelPickKey)
  const defaultKey = prefs.default === null ? '' : modelPickKey(prefs.default)
  const keyword = q.trim().toLowerCase()

  /** 一次改偏好的公共壳：置忙、存、失败写一句原因。 */
  const commit = async (patch: { default?: ModelPick | null, picks?: ModelPick[] }): Promise<void> => {
    setBusy(true)
    setNote('')
    const r = await saveModelPrefs(patch)
    setBusy(false)
    if (!r.ok) setNote('没保存成功：' + (r.error ?? '原因不明'))
  }

  /** 切换一条模型的备选状态。 */
  const togglePick = (m: ModelPick): void => {
    const key = modelPickKey(m)
    const next = pickKeys.includes(key)
      ? picks.filter(p => modelPickKey(p) !== key)
      : [...picks, m]
    void commit({ picks: next })
  }

  /* dsh 一共多少个模型（收起那行右侧的数量）。没读到时不写数字 —— 写 0 会让人
   * 以为「dsh 里没有模型」，那是假的。 */
  const catalogCount = catalog === null
    ? undefined
    : catalog.providers.reduce((n, p) => n + p.models.length, 0)

  return (
    <details className={ws.section} data-ewb-model-section="" data-ewb-dsh-catalog="">
      <summary className={ws.sectionTitle} data-ewb-dsh-catalog-summary="">
        dsh 模型目录{catalogCount === undefined ? '' : ' · ' + String(catalogCount) + ' 个'}
      </summary>

      {/* ── 当前默认 ─────────────────────────────────────────────
       *
       * ★ 「默认模型」→「节点默认模型」（票 38，2026-10-28）。
       *
       * ## 为什么要改名（这一条不是措辞偏好）
       *
       * 工作台设置里现在有**两个**叫「默认模型」的东西，而它们是两条不同的链路：
       *
       * | | 本行（`model-prefs.json` 的 `default`） | 下一节的四类（`model-defaults.json`） |
       * |---|---|---|
       * | 形状 | `{provider, model}`（dsh 模型目录的） | `{channelId, modelId}`（内容渠道的） |
       * | 谁读 | `src/index.ts` 的五级回落 → `ctx.llm.stream` | `src/schedule/generate.ts` → 直接打渠道地址 |
       * | 谁用 | 工作流里的 `ai.agent` 节点 | 内容生成（`caption` 反推提示词） |
       *
       * 两者**不可互相回落**（形状都不同）。同名会让用户以为配一处两处都生效，
       * 而实际上配错那处的那条链路会静默走别的模型。所以名字必须自证身份。 */}
      <div className={ws.row}>
        <span className={ws.rowLabel}>节点默认模型</span>
        <span className={ws.modelName} data-ewb-model-default={defaultKey} title={defaultKey}>
          {prefs.default === null
            ? '未设置（跟随 dsh 里选的模型）'
            : defaultKey}
        </span>
        {prefs.default !== null && (
          <span className={ws.rowActions}>
            <button
              type="button"
              className={ws.btn}
              disabled={busy}
              title="清掉工作台默认，改回跟随 dsh 里选的模型"
              onClick={() => { void commit({ default: null }) }}
            >清除</button>
          </span>
        )}
      </div>
      <div className={ws.note}>
        只用于工作流的 ai.agent 节点，与下面四类默认模型互不影响。
      </div>

      {/* ── 已加进清单（票 75：原来叫「备选名单」）───────────────
       *
       * ## 为什么改名字
       *
       * 用户 2026-10-29 原话：「dsh 模型目录现在不是选择备用模型了，是**增加到模型清单**。」
       *
       * 同一份数据（`model-prefs.json` 的 `picks`）回答的问题一直没变：
       * 「哪几个 dsh 模型被带进工作台」。变的是**界面上的说法** ——
       * 「备选名单」听起来像「备着以后可能用」，而用户要的是「现在加进清单了」。
       *
       * ⚠️ 底层一个字没改：仍是 `picks`、仍存 `{provider, model}`、
       * 仍是 `POST /models/prefs`。判据里那条「不走 `POST /channels`」钉的就是这件事。 */}
      <div className={ws.subTitle}>
        已加进清单（{picks.length} 个）
      </div>
      {picks.length === 0
        ? (
          <div className={ws.note} data-ewb-model-picks="">
            清单是空的。在下面点「加入清单」把模型加进来。
          </div>
        )
        : (
          <div className={ws.card} data-ewb-model-picks="">
            {picks.map(p => (
              <div key={modelPickKey(p)} className={ws.modelRow} data-ewb-model-pick={modelPickKey(p)}>
                <span className={ws.modelName} title={modelPickKey(p)}>{modelPickKey(p)}</span>
                <span className={ws.rowActions}>
                  <button
                    type="button"
                    className={ws.btn}
                    disabled={busy}
                    title="从清单里移出（不再出现在「dsh 内置」那一组）"
                    onClick={() => { togglePick(p) }}
                  >移出</button>
                </span>
              </div>
            ))}
          </div>
        )}

      {/* ── 全部可用模型 ────────────────────────────────────────── */}
      <div className={ws.subTitle}>全部可用模型</div>

      {loading && <div className={ws.note}>正在读取模型列表…</div>}

      {!loading && error !== undefined && catalog === null && (
        <div className={ws.note} data-ewb-model-error="">
          读不到模型列表：{error}
          <br />
          接口不可用期间，节点上的模型下拉只有「跟随默认」一项；工作流仍会按默认链路跑。
          <div style={{ marginTop: '6px' }}>
            <button
              type="button"
              className={ws.btn}
              title="重新读一次模型清单"
              data-ewb-model-retry=""
              onClick={() => { void ensureModelsLoaded(true) }}
            >重读</button>
          </div>
        </div>
      )}

      {catalog !== null && (
        <>
          {error !== undefined && (
            <div className={ws.note} data-ewb-model-error="">
              最近一次重读失败：{error}（下面显示的是上一次读到的清单）
            </div>
          )}
          <div className={ws.row}>
            <input
              className={ws.input}
              value={q}
              placeholder="按模型名或提供方筛选"
              aria-label="筛选模型"
              onChange={e => { setQ(e.target.value) }}
            />
            <span className={ws.rowActions}>
              <button
                type="button"
                className={ws.btn}
                disabled={busy}
                title="重新从 dsh 读一次模型清单"
                onClick={() => { void ensureModelsLoaded(true) }}
              >重读</button>
            </span>
          </div>

          {catalog.providers.length === 0
            ? <div className={ws.note}>dsh 里没有可用的模型提供方。</div>
            : catalog.providers.map(p => {
              const hit = p.models.filter(m => keyword === ''
                || m.id.toLowerCase().includes(keyword)
                || m.name.toLowerCase().includes(keyword)
                || p.name.toLowerCase().includes(keyword))
              if (hit.length === 0) return null
              return (
                /* 每个 provider 一张**卡片**（照 dsh 的 `.rowCard` 纵向排）。
                 *
                 * ⚠️ 为什么不再用 `<details>` 折叠：宽面板里每行放得下名字 + 两个按钮，
                 * 一屏能看的行数已经够。折叠只会多一次点击，而用户来这里是**找模型**的。
                 * 提供方多的时候有筛选框兜底。 */
                <div key={p.id} className={ws.card} data-ewb-model-provider={p.id}>
                  <div className={ws.cardHead}>
                    <span className={ws.cardName}>{p.name}</span>
                    <span className={ws.cardCount}>{hit.length} 个</span>
                  </div>
                  {hit.map(m => {
                    const pick: ModelPick = { provider: p.id, model: m.id }
                    const key = modelPickKey(pick)
                    const inPicks = pickKeys.includes(key)
                    /* ★ 这一行是「不溢出」的落点：名字 `.modelName` 可收缩 + 截断，
                     * 按钮包在 `.rowActions`（`flex: 0 0 auto` + nowrap）里永远在。
                     * 只加宽面板治不了根 —— 名字足够长时照样挤。 */
                    return (
                      <div key={key} className={ws.modelRow} data-ewb-model-row={key}>
                        <span className={ws.modelName} title={key}>
                          {m.name}
                          {m.description === undefined ? '' : ' — ' + m.description}
                        </span>
                        <span className={ws.rowActions}>
                          <button
                            type="button"
                            className={ws.btn}
                            disabled={busy || key === defaultKey}
                            title="设为工作台默认模型"
                            data-ewb-model-set-default={key}
                            onClick={() => { void commit({ default: pick }) }}
                          >{key === defaultKey ? '已是默认' : '设为默认'}</button>
                          <button
                            type="button"
                            className={inPicks ? ws.btnOn : ws.btn}
                            disabled={busy}
                            title={inPicks ? '从清单里移出' : '加入清单（加进来之后出现在「dsh 内置」那一组）'}
                            data-ewb-model-toggle={key}
                            onClick={() => { togglePick(pick) }}
                          >{inPicks ? '移出清单' : '加入清单'}</button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
        </>
      )}

      {note !== '' && <div className={ws.note}>{note}</div>}

      <div className={ws.note} style={{ marginTop: '6px' }}>
        只有加进清单的模型会出现在上面的「dsh 内置」里。
      </div>
    </details>
  )
}

/* ── 工作台设置抽屉**已删**（票 66，用户 2026-10-29）────────────────
 *
 * 原来这里有 `export function WorkspaceSettings(props)` —— 从右侧滑出的一块面板
 * （`.panel` 宽 `min(720px, 92%)`），里面五节竖排：
 * 模型 → 渠道 → 四类默认 → 提醒 → 浏览器。
 *
 * 用户原话：「把左侧栏底部齿轮『工作台设置』改成一个板块，板块名『配置』，
 * 排序在最后一个，内容不变、只按内容分 tab。」
 *
 * 现在那五节住在 `ConfigBoard.tsx` 的两格 tab 里（模型那一格三段、其它那一格两段），
 * 顺序与这里**逐字一致**。改每一块内部的样子是票 68 / 69 的事。
 *
 * ## ⚠️ 为什么只删这一个函数、其余导出原地不动
 *
 * 这个文件里还有一堆被别处 import 的东西：
 *
 * | 导出 | 谁在用 |
 * |---|---|
 * | `currentBrowserPrefs` / `updateBrowserPrefs` / `subscribeBrowserPrefs` / `useBrowserPrefs` | `WorkflowCanvas.tsx` |
 * | `useModels` / `ensureModelsLoaded` / `saveModelPrefs` / `modelPickKey` | `NodeEditorPopover.tsx` |
 * | `ModelSettings` / `NotifySettings` | `ConfigBoard.tsx`（票 66 起） |
 *
 * **把整个文件改名或搬家会牵动上面那两个文件**，而它们不在本票可改路径里。
 * 所以文件名保持 `WorkspaceSettings.tsx`，只把抽屉那一个函数删掉 ——
 * 文件名现在是历史遗留（它现在的实际内容主要是「模型目录与浏览器偏好的状态层」），
 * 真要改名单独开票。
 *
 * ## 连带成了死代码的东西（本票按票面要求**先不删**）
 *
 * `WorkbenchSettings.module.css` 里那套 `.panel` / `.panelHead` / `.panelTitle` /
 * `.panelClose` / `.panelBody` 只有那个抽屉在用，现在没人用了。
 * 票面写明「本票先留着不删」，票 69 收尾时一并清。
 */

export { }