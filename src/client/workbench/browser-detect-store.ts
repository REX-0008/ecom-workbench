/** 浏览器检测结果的**共享读取**（设置面板与节点设置都用它）。
 *
 * ## 为什么要抽出来
 *
 * 「有哪些浏览器可用」这件事现在有**两个地方**要用：
 *   ① 全局设置的「浏览器」一段（默认用哪个 + 检测列表）
 *   ② 节点设置里的「标签 → 浏览器」（用户 2026-10-13 要求搬过去的）
 *
 * 两处各拉一次接口会**不一致**（一边检测完、另一边还是空的），
 * 而且节点那边每次展开都在拉，很浪费。
 *
 * 所以：**模块级缓存 + 订阅**。第一个用到的人触发一次检测，之后大家共用；
 * 「重新检测」按钮显式刷新并通知所有人。
 *
 * ⚠️ 与 `pending-load.ts` 同一个套路（模块级小持有处 + 订阅），
 * 理由也一样：这是一个跨组件共享的**只读数据**，
 * 放进 zustand 反而要处理订阅与清理。
 */
import { useEffect, useState } from 'react'

/** 检测到的一个浏览器（与宿主半 `/api/ecom-workbench/browser/detect` 一致）。 */
export interface DetectedBrowser {
  /** 稳定 id（设置里存的、标签解析用的都是它）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 可执行文件路径；`null` = 找过但没找到。 */
  path: string | null
  /** 来源：系统装的 / Playwright 自带的 / CDP。 */
  source: 'system' | 'playwright' | 'cdp'
  /** 能不能当 CDP 目标。 */
  cdpReady: boolean
}

/** 宿主半的检测结果。 */
export interface DetectResult {
  /** 是否成功。 */
  ok?: boolean
  /** 检测到的浏览器。 */
  browsers?: DetectedBrowser[]
  /**
   * CDP 端点的扫描结果（用户 2026-10-14 改造）。
   *
   * ⚠️ 原来是 `{ port: number, listening: boolean }` —— **单个写死端口**。
   * 现在是一份**端点清单**（每个带它自报的浏览器版本），
   * 因为端口改成手填之后「只有一个 9222」这个前提不成立了。
   */
  cdp?: { listening: boolean, endpoints: CdpFound[] }
  /** 失败原因。 */
  error?: string
  /** 正在检测中（本地状态，不是宿主半返回的）。 */
  loading?: boolean
}

/** 扫到的一个 CDP 端点（与宿主半 `/browser/detect` 的 `cdp.endpoints` 一致）。 */
export interface CdpFound {
  /** 调试端口。 */
  port: number
  /** 它自报的浏览器（如 `Chrome/138.0.7204.0`）；取不到 = null。 */
  browser: string | null
}

/** 查一个**手填**端口的三种结果。 */
export interface CdpCheck {
  /** 端口号。 */
  port: number
  /** 有没有程序在听这个端口。 */
  listening: boolean
  /** 在听，且它确实是浏览器调试端口时，这是它自报的版本；否则 null。 */
  browser: string | null
  /** 查询失败时的原因（网络/接口错误）。 */
  error?: string
}

/** 当前缓存的结果。 */
let cached: DetectResult | null = null
/** 正在跑的那次检测（并发去重 —— 两个组件同时挂载只发一次请求）。 */
let inflight: Promise<DetectResult> | null = null

/** 订阅者。 */
const listeners = new Set<(r: DetectResult) => void>()

/** 通知所有订阅者。 */
function emit(r: DetectResult): void {
  cached = r
  for (const fn of listeners) fn(r)
}

/**
 * 跑一次检测（并发去重）。
 *
 * @returns 检测结果。
 */
export async function detectBrowsers(): Promise<DetectResult> {
  if (inflight !== null) return await inflight
  inflight = (async (): Promise<DetectResult> => {
    try {
      const r = await fetch('/api/ecom-workbench/browser/detect')
      if (!r.ok) return { error: '检测接口返回 ' + String(r.status) }
      return await r.json() as DetectResult
    } catch (e) {
      /* **不自动重试**：检测要起一次 powershell（约 1 秒），
       * 自动重试会让面板打开时卡顿。失败就显示原因、让人按按钮重来。 */
      return { error: e instanceof Error ? e.message : String(e) }
    } finally {
      inflight = null
    }
  })()
  return await inflight
}

/**
 * 查**一个手填的端口**是不是 CDP 端点（用户 2026-10-14 要的「点检测」）。
 *
 * ⚠️ 与 `refreshBrowsers()`（全扫本机端口）**分开**：
 * 全扫要约 2 秒（实测 50 个端口 2145ms），适合「我不知道端口」；
 * 而用户已经填了一个端口时只要 1 毫秒 —— 不该让「确认一下」也等 2 秒。
 *
 * 不走共享缓存（这是一次针对**当前输入**的问询，缓存它反而会显示旧端口的结论）。
 *
 * @param port - 端口文本（可以是任意输入，由宿主半判合法性）。
 * @returns 三态结果（没人在听 / 在听但不是 CDP / 就是 CDP）。
 */
export async function checkCdpPort(port: string): Promise<CdpCheck> {
  const n = Number(port)
  const base: CdpCheck = { port: Number.isFinite(n) ? n : 0, listening: false, browser: null }
  try {
    const r = await fetch('/api/ecom-workbench/browser/cdp?port=' + encodeURIComponent(port))
    if (!r.ok) return { ...base, error: '检测接口返回 ' + String(r.status) }
    const j = await r.json() as { port?: number, listening?: boolean, browser?: string | null, error?: string }
    if (typeof j.error === 'string' && j.error !== '') return { ...base, error: j.error }
    return {
      port: typeof j.port === 'number' ? j.port : base.port,
      listening: j.listening === true,
      browser: typeof j.browser === 'string' && j.browser !== '' ? j.browser : null,
    }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 强制重新检测（用户点「重新检测」）。
 *
 * @returns 新结果。
 */
export async function refreshBrowsers(): Promise<DetectResult> {
  emit({ loading: true })
  const r = await detectBrowsers()
  emit(r)
  return r
}

/**
 * 订阅检测结果（组件用）。
 *
 * 第一次调用会自动触发一次检测（用户 2026-10-13：「这个检测过程能否自动」→ 能）。
 *
 * @returns 当前结果（null = 还没检测过）。
 */
export function useDetectedBrowsers(): DetectResult | null {
  const [state, setState] = useState<DetectResult | null>(cached)
  useEffect(() => {
    listeners.add(setState)
    /* 没有缓存就触发一次（有则直接用缓存 —— 不在每次挂载时重复扫盘）。 */
    if (cached === null) void refreshBrowsers()
    return () => { listeners.delete(setState) }
  }, [])
  return state
}
