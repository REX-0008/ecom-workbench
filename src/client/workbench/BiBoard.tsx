/** BI 板块：把 Superset 嵌进来。
 *
 * ## 这一块**故意没有板块头部、也没有 tab**（用户 2026-10-21 明确要求）
 *
 * 理由：BI 是**一整块外部网页**，多一层标题就少一层看得见的仪表盘。
 * 骨架那边照常有面包屑（那是全站统一的），这里自己只留一条**窄工具条**：
 * 启动 BI / 刷新 / 状态灯。除此之外全部交给 Superset。
 *
 * ## 载体：webview 优先、iframe 兜底
 *
 * 抄的是旧工作台 `my-dsh-plugins/workbench/src/client/workbench/WorkbenchColumn.tsx`
 * 第 42-86 行那套（`window.dshDesktop.browser.acquire` 租约 + webview）：
 *
 *   · **webview**（桌面端给的能力）—— 没有 X-Frame-Options 限制，登录态能持久；
 *   · **iframe**（浏览器 / 无桌面壳）—— Superset 默认会挡，但库没起来时
 *     至少要能看到「连不上」，而不是一片空白。
 *
 * ⚠️ 这与「板块注册不许用 iframe」**不是一回事**：那条讲的是插件自己的界面
 * 要同进程注册（见 `board-registry.ts` 文件头）；这里是嵌**别人的网页**，只能这么嵌。
 *
 * ## 浏览器 API 全判存在（白屏第二大成因）
 *
 * `window.dshDesktop` 在浏览器 / 测试环境里没有；`document.createElement('webview')`
 * 在没有 webview 支持的壳里也造不出来。两处都先判再有，失败就往 iframe 落。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardProps } from './board-registry.ts'
import { call } from './board-kit.ts'

/** 桌面端 preload 注入的壳能力（缺失时退回 iframe）。 */
interface DesktopBrowserBridge {
  /**
   * 申请一份浏览器租约。
   *
   * ⚠️ **桌面端返回的是 Promise**（`electron.ipcRenderer.invoke(...)`），
   * 浏览器 / 测试桩可能同步返回。两种都要认，所以类型写成联合。
   * 见本文件 `mountBi` 的注释：少写 `await` 就是「一片空白且没有报错」的根因。
   */
  acquire: (workspace: string) => Lease | Promise<Lease>
  release?: (lease: string) => void
}

/** 一份浏览器租约（`name` 与 `partition` 都取自它，缺一个 webview 就附加不上）。 */
interface Lease {
  /** 租约号。主进程在 `will-attach-webview` 里按 `about:blank#<租约号>` 认它。 */
  lease: string
  /** 会话分区（登录态落在这里）。 */
  partition: string
}

/** 承载方式（界面要照着它说清「现在走的是哪条路」）。 */
type MountMode = 'pending' | 'webview' | 'iframe'

/** `mountBi` 把过程报给界面的两条通道（都由调用方提供，函数本身不碰 React）。 */
interface MountReport {
  /** 承载方式变了（`why` 只在降级时有内容）。 */
  onMode: (mode: MountMode, why: string) => void
  /** webview 加载失败（`did-fail-load`）。 */
  onFailLoad: (info: { code: number, desc: string, url: string }) => void
}

/** 拿壳能力（没有就 undefined —— 不抛）。 */
function desktopBridge(): DesktopBrowserBridge | undefined {
  const dsh = (window as unknown as { dshDesktop?: { browser?: DesktopBrowserBridge } }).dshDesktop
  const bridge = dsh?.browser
  return bridge !== undefined && typeof bridge.acquire === 'function' ? bridge : undefined
}

/** 一句话描述异常（不抛）。 */
function whyOf(e: unknown): string {
  if (e instanceof Error && e.message !== '') return e.message
  return String(e)
}

/** 造承载容器里的 webview 元素（样式与属性集中在这里，两边一致）。 */
function makeWebview(): HTMLElement & { loadURL?: (u: string) => Promise<void> } {
  const wv = document.createElement('webview') as HTMLElement & { loadURL?: (u: string) => Promise<void> }
  wv.setAttribute('allowpopups', '')
  wv.style.width = '100%'
  wv.style.height = '100%'
  wv.style.border = '0'
  return wv
}

/** 造兜底的 iframe。 */
function makeIframe(url: string): HTMLIFrameElement {
  const fr = document.createElement('iframe')
  fr.src = url
  fr.style.width = '100%'
  fr.style.height = '100%'
  fr.style.border = '0'
  /* 尽量给足权限 —— Superset 的图表要用脚本与 Cookie。 */
  fr.setAttribute('allow', 'clipboard-read; clipboard-write')
  return fr
}

/**
 * 把 BI 页面挂进容器：webview 优先，失败落 iframe。
 *
 * ## ⚠️ 这里必须能等异步（2026-10-22 修的真 BUG）
 *
 * 桌面端的 `acquire` 是 `electron.ipcRenderer.invoke(...)`，**返回 Promise**。
 * 原先写成 `const r = bridge.acquire(...)` 再用 `r.lease`，于是：
 *
 *   1. `r.lease` / `r.partition` 都是 `undefined`；
 *   2. `setAttribute('name', undefined)` 把属性写成了**字符串 "undefined"**，
 *      `src` 变成 `about:blank#undefined`；
 *   3. 主进程按租约号取不到租约 → `event.preventDefault()` → **webview 根本不附加**；
 *   4. `dom-ready` 永不触发 → 永不导航 → 一片空白；
 *   5. 而界面这边已经认为「挂上了」、占位层撤掉 → 用户看到空白，**没有任何报错**。
 *
 * `try/catch` 捕不到（Promise 不会在这里 reject），所以旧写法是**静默失败**。
 *
 * ## 清理函数是**同步返回**的，租约后到也不泄漏
 *
 * 调用方（`useEffect` 的清理）没法等 Promise，所以这里立刻返回一个同步闭包，
 * 内部用变量记租约。三种收场：
 *
 *   · 租约已到、webview 已挂 → 移除元素 + `release(租约号)`；
 *   · 租约还在路上就被卸载 → 置 `cancelled`，租约一到**立刻释放**；
 *   · 取租约失败 → 没有租约可释放，只需移除兜底元素。
 *
 * @param host - 承载容器。
 * @param url - 要打开的地址。
 * @param report - 把承载方式与加载失败报给界面的两条通道。
 * @returns 清理函数（可重复调用，第二次是空操作）。
 */
function mountBi(host: HTMLElement, url: string, report: MountReport): () => void {
  /** 已到手的租约（没到就是 null）。 */
  let lease: Lease | null = null
  /** 已被卸载（租约后到时靠它决定「到了就放掉」）。 */
  let cancelled = false
  /** 已挂上去的元素（webview 与 iframe 二者之一）。 */
  let mounted: HTMLElement | null = null
  /** 释放函数（`release` 可能没提供）。 */
  const bridge = desktopBridge()
  const release = bridge?.release

  /** 收场：移除元素、按需释放租约。重复调用安全。 */
  const dispose = (): void => {
    if (cancelled && mounted === null && lease === null) return
    cancelled = true
    if (mounted !== null) {
      mounted.remove()
      mounted = null
    }
    if (lease !== null) {
      const id = lease.lease
      lease = null
      try { release?.(id) } catch { /* 已经释放过 */ }
    }
  }

  /** 落到 iframe，并把原因交给界面说。 */
  const fallback = (why: string): void => {
    if (cancelled || mounted !== null) return
    const fr = makeIframe(url)
    mounted = fr
    host.appendChild(fr)
    report.onMode('iframe', why)
  }

  /* ── 没有壳能力：直接走 iframe（浏览器环境、测试环境都是这条，属正常路径）── */
  if (bridge === undefined) {
    fallback('当前环境没有桌面外壳能力')
    return dispose
  }

  report.onMode('pending', '')
  let acquireRet: Lease | Promise<Lease>
  try {
    acquireRet = bridge.acquire('ecom-workbench:bi')
  } catch (e) {
    /* 同步抛（桩里可能这样）——同样落到 iframe，不许静默。 */
    fallback('桌面外壳能力不可用（' + whyOf(e) + '），已改用 iframe')
    return dispose
  }

  void Promise.resolve(acquireRet)
    .then((r: Lease | null | undefined) => {
      /* 租约形状不对就当作没拿到 —— 别把 undefined 写进属性（那正是旧 BUG）。 */
      if (r === null || r === undefined || typeof r.lease !== 'string' || r.lease === '') {
        throw new Error('取回的租约里没有租约号')
      }
      if (cancelled) {
        /* 已经卸载了：拿到就放掉，不留悬着的租约。 */
        try { release?.(r.lease) } catch { /* 已经释放过 */ }
        return
      }
      lease = r
      const wv = makeWebview()
      /* ⚠️ 这两个属性是 webview 能不能附加的前提，值必须是**租约里的真值**。 */
      wv.setAttribute('name', r.lease)
      wv.setAttribute('partition', r.partition ?? '')
      wv.setAttribute('src', 'about:blank#' + r.lease)
      let navigated = false
      /** 导航一次（拿到 guest 之后再调，否则 loadURL 还没挂上）。 */
      const go = (): void => {
        if (navigated) return
        navigated = true
        const ret = wv.loadURL?.(url)
        if (ret !== undefined && typeof ret.catch === 'function') {
          ret.catch((e: unknown) => {
            report.onFailLoad({ code: 0, desc: '导航失败：' + whyOf(e), url })
          })
        }
      }
      wv.addEventListener('dom-ready', go, { once: true })
      wv.addEventListener('did-finish-load', () => { go() }, { once: true })
      /* 加载失败要**记下来并说出来**：以前这条事件没人听，
       * 于是「webview 附加上了但页面没打开」与「一片空白」长得一模一样。 */
      wv.addEventListener('did-fail-load', (ev: Event) => {
        const e = ev as Event & {
          errorCode?: number
          errorDescription?: string
          validatedURL?: string
          isMainFrame?: boolean
        }
        /* 子框架（广告、统计之类）的失败与主页面能不能打开无关，不报。 */
        if (e.isMainFrame === false) return
        report.onFailLoad({
          code: typeof e.errorCode === 'number' ? e.errorCode : 0,
          desc: e.errorDescription ?? '未知原因',
          url: e.validatedURL ?? url,
        })
      })
      /* **先装监听、再 append**：about:blank 加载极快，
       * 等 append 之后才装 `dom-ready` 可能已经错过 → 永远不导航。 */
      mounted = wv
      host.appendChild(wv)
      report.onMode('webview', '')
    })
    .catch((e: unknown) => {
      if (cancelled) return
      fallback('桌面外壳能力不可用（' + whyOf(e) + '），已改用 iframe')
    })

  return dispose
}

/** 工具条上的小按钮。 */
const BTN = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border px-2.5 py-1',
  'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]',
  'font-mono text-ewb-caption leading-none disabled:opacity-45',
].join(' ')

/** 次要按钮。 */
const BTN_QUIET = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border border-[var(--dsw-alias-border-l2)]',
  'px-2.5 py-1 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)] disabled:opacity-45',
].join(' ')

/** 地址存在浏览器本地：换机器 / 换端口时用户自己改一处即可。 */
const URL_KEY = 'ewb.bi.url'
/** 默认地址（与宿主半 `src/schedule/bi.ts` 的 `BI_URL` 一致）。 */
const DEFAULT_URL = 'http://127.0.0.1:8088/dashboard/list/'

/** 读地址（读不到用默认值）。 */
function readUrl(): string {
  try {
    const v = window.localStorage.getItem(URL_KEY)
    return v === null || v.trim() === '' ? DEFAULT_URL : v
  } catch {
    return DEFAULT_URL
  }
}

/**
 * BI 板块。
 * @param _props - 骨架入参（这块不用它们：没有 tab、自己也不跑工作流）。
 * @returns 界面。
 */
export function BiBoard(_props: BoardProps): React.JSX.Element {
  /** 8088 有没有在听（宿主半 `GET /bi/status` 的结论）。 */
  const [listening, setListening] = useState<boolean | null>(null)
  /** 探状态时出的错。 */
  const [probeErr, setProbeErr] = useState('')
  /** 启动请求的结果（一句话）。 */
  const [startMsg, setStartMsg] = useState('')
  /** 正在发起启动。 */
  const [starting, setStarting] = useState(false)
  /** 嵌入区真的挂上去了吗（没挂就显示占位）。 */
  const [mounted, setMounted] = useState(false)
  /** 当前地址（可编辑）。 */
  const [url, setUrl] = useState(readUrl)
  /** 地址编辑框展开着吗。 */
  const [editing, setEditing] = useState(false)
  /** 地址草稿。 */
  const [draft, setDraft] = useState(url)
  /** 挂载点。 */
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 每次「刷新 / 地址变了」加一，驱动重新挂载。 */
  const [version, setVersion] = useState(0)
  /**
   * 当前走的是哪条承载路（webview / iframe / 还在取租约）。
   *
   * ⚠️ 必须由 `mountBi` 回报，不能像以前那样「一挂就认为挂上了」——
   * 旧写法在 webview 根本没附加时也把 `mounted` 设成 true 并撤掉占位层，
   * 用户看到的就是**一片空白且没有任何提示**。
   */
  const [mode, setMode] = useState<MountMode>('pending')
  /** 降级到 iframe 的原因（空串 = 没降级）。 */
  const [fallbackWhy, setFallbackWhy] = useState('')
  /** webview 的加载失败记录（空 = 没失败过）。 */
  const [loadFail, setLoadFail] = useState('')
  /**
   * 「迟迟没有进展」的提示（空 = 正常）。
   *
   * 为什么需要：webview 附加不上时**不会有任何事件**（主进程直接 `preventDefault()`），
   * 于是既没有 `dom-ready`、也没有 `did-fail-load` —— 只能靠时间兜底。
   * 上一版的「一片空白且无报错」正是这样来的，这一条就是它的直接对策。
   */
  const [stuckHint, setStuckHint] = useState('')

  /**
   * 探一次 8088。
   * @param silent - 不显示「正在探测」。
   */
  const probe = useCallback((silent = true): void => {
    if (!silent) setProbeErr('')
    void call<{ listening?: boolean }>('/bi/status').then(r => {
      if (!r.ok) { setListening(false); setProbeErr(r.error ?? '探不到 BI 状态'); return }
      setProbeErr('')
      setListening(r.body?.listening === true)
    })
  }, [])

  useEffect(() => { probe() }, [probe])

  /* 「在听」才挂页面。没起来的时候挂 iframe 只会得到一个浏览器自带错误页
   * （Superset 起不来时它对 127.0.0.1 是拒连），看着像我们坏了。
   *
   * ⚠️ **竞态**：`mountBi` 立刻返回，但租约可能晚于卸载才到手。
   * 处理分两层：`mountBi` 内部用 `cancelled` 兜住（拿到即释放）；
   * 这里再挡一道 `alive`，避免卸载之后还把状态写回已卸载的组件。 */
  useEffect(() => {
    const host = hostRef.current
    if (host === null || listening !== true) { setMounted(false); return }
    let alive = true
    setMounted(true)
    setMode('pending')
    setFallbackWhy('')
    setLoadFail('')
    setStuckHint('')
    host.innerHTML = ''
    /* 时间兜底：8 秒还没走成 webview 也没落到 iframe，就明说「可能白屏」。
     * 正常情况这个定时器会被清掉（onMode 一到就清）。 */
    const stuckTimer = window.setTimeout(() => {
      if (!alive) return
      setStuckHint('嵌入未能完成：桌面外壳没有回应取租约的请求。此时窗口里可能是空白，点「刷新」重试；'
        + '若一直这样，说明桌面外壳的浏览器能力不可用。')
    }, 8000)
    const off = mountBi(host, url, {
      onMode: (next, why) => {
        if (!alive) return
        window.clearTimeout(stuckTimer)
        setMode(next)
        setFallbackWhy(why)
      },
      onFailLoad: info => {
        if (!alive) return
        setLoadFail('加载失败（错误码 ' + String(info.code) + '：' + info.desc + '）')
      },
    })
    return () => {
      alive = false
      window.clearTimeout(stuckTimer)
      off()
      setMounted(false)
    }
  }, [listening, url, version])

  /** 点「启动 BI」：发起异步启动，然后开始轮询（Docker 起来要几十秒）。 */
  const start = useCallback((): void => {
    setStarting(true)
    setStartMsg('')
    void call<{ ok?: boolean, reason?: string }>('/bi/start', { method: 'POST' }).then(r => {
      setStarting(false)
      if (!r.ok) { setStartMsg('启动失败：' + (r.error ?? '未知原因')); return }
      setStartMsg(r.body?.reason ?? '已发起启动')
      /* 轮询 90 秒（Docker 首次拉镜像要 30-60 秒，留一点余量）。
       * 到点还没起来就停下 —— 一直转下去只会让人以为还在等。 */
      let left = 45
      const timer = window.setInterval(() => {
        left -= 1
        probe()
        if (left <= 0) {
          window.clearInterval(timer)
          setStartMsg('还没起来。若窗口里没有任何动静，检查一键启动脚本的路径与 Docker 是否在跑。')
        }
      }, 2000)
    })
  }, [probe])

  /** 保存地址（写本地 + 立即重挂）。 */
  const saveUrl = useCallback((): void => {
    const v = draft.trim() === '' ? DEFAULT_URL : draft.trim()
    setUrl(v)
    setEditing(false)
    try { window.localStorage.setItem(URL_KEY, v) } catch { /* 存不了也不影响这次使用 */ }
    setVersion(n => n + 1)
  }, [draft])

  /** 状态灯的三档。 */
  const tone = listening === true ? 'ok' : listening === false ? 'off' : 'warn'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 窄工具条（这一块唯一的我们自己的界面）── */}
      <div className="mb-2 flex flex-none flex-wrap items-center gap-2 border-b border-[var(--dsw-alias-border-l2)] pb-2">
        <button
          type="button"
          className={BTN}
          disabled={starting}
          title="起一键启动脚本（Docker Desktop 会跟着起来；首次拉镜像要 30-60 秒）"
          onClick={start}
        >{starting ? '启动中…' : '启动 BI'}</button>
        <button
          type="button"
          className={BTN_QUIET}
          title="重新探一次 8088 端口，并把嵌入区重挂一遍"
          onClick={() => { probe(); setVersion(n => n + 1) }}
        >刷新</button>
        <span className="flex items-center gap-1.5">
          <span className={'dot ' + tone} />
          <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
            {listening === null ? '探测中' : listening ? 'BI 在线' : 'BI 未启动'}
          </span>
        </span>
        {/* 承载方式：用户能一眼看出「走的是哪条路」。
         * 走 webview 才是正常形态；落到 iframe 就明说原因，
         * 而不是让人对着一片空白猜。 */}
        {listening === true && (
          <span
            className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
            data-ewb-bi-mode={mode}
            title={fallbackWhy === '' ? '嵌入方式' : fallbackWhy}
          >
            {mode === 'webview'
              ? '嵌入方式：webview'
              : mode === 'iframe'
                ? '嵌入方式：iframe（' + (fallbackWhy === '' ? '已降级' : fallbackWhy) + '）'
                : '正在取得嵌入能力…'}
          </span>
        )}
        <span className="flex-1" />
        {editing
          ? (
            <>
              <input
                type="text"
                className="min-w-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-primary)] outline-none"
                value={draft}
                placeholder={DEFAULT_URL}
                onChange={e => { setDraft(e.target.value) }}
              />
              <button type="button" className={BTN} onClick={saveUrl}>保存</button>
              <button type="button" className={BTN_QUIET} onClick={() => { setEditing(false); setDraft(url) }}>取消</button>
            </>
          )
          : (
            <button
              type="button"
              className="pressable is-dark max-w-[280px] truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
              title={'改 BI 地址（默认 ' + DEFAULT_URL + '）'}
              onClick={() => { setDraft(url); setEditing(true) }}
            >{url}</button>
          )}
      </div>

      {startMsg !== '' && (
        <div className="mb-2 flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
          {startMsg}
        </div>
      )}
      {probeErr !== '' && (
        <div className="mb-2 flex-none rounded-ctl border border-[color-mix(in_oklab,var(--dsw-alias-state-warn-primary)_35%,transparent)] px-3 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-state-warn-primary)]">
          {probeErr}
        </div>
      )}
      {/* 加载失败：以前这条事件没人听，于是「页面没打开」与「一片空白」长得一模一样。 */}
      {loadFail !== '' && (
        <div
          className="mb-2 flex-none rounded-ctl border border-[color-mix(in_oklab,var(--dsw-alias-state-danger-primary)_35%,transparent)] px-3 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-state-danger-primary)]"
          data-ewb-bi-fail=""
        >
          {loadFail}。地址与端口确认无误后点「刷新」重试；必要时改地址。
        </div>
      )}
      {/* 取租约超时：webview 附加不上时不会有任何事件，只能靠时间兜底。
       * 这一条是上一版「静默空白」的直接对策 —— 到点就明说，不许让人对着白屏猜。 */}
      {stuckHint !== '' && (
        <div
          className="mb-2 flex-none rounded-ctl border border-[color-mix(in_oklab,var(--dsw-alias-state-warn-primary)_35%,transparent)] px-3 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-state-warn-primary)]"
          data-ewb-bi-stuck=""
        >
          {stuckHint}
        </div>
      )}

      {/* ── 嵌入区 ───────────────────────────────────────────
       * 挂载点**一直在**，占位层盖在它上面 —— 这样从「没起来」到「起来了」
       * 只是把占位层撤掉，不用重新量尺寸。 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)]">
        <div ref={hostRef} className="h-full w-full" data-ewb-bi-host={mounted ? 'on' : 'off'} />
        {listening !== true && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]">BI 还没起来</div>
            <div className="max-w-[420px] font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
              Superset 跑在 8088 上，随 Docker 一起起。<br />
              首次启动要拉镜像，大约 30-60 秒。
            </div>
            <button type="button" className={BTN} disabled={starting} onClick={start}>
              {starting ? '启动中…' : '点这里启动 BI'}
            </button>
            <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-caption)]">{url}</div>
          </div>
        )}
      </div>
    </div>
  )
}
