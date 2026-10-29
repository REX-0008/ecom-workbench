/** 视频创作台（契约 CF，用户 m01076）。
 *
 * **除了「多一个取消、参数是时长与分辨率」之外，与生图工作台是同一份实现** ——
 * 提交、轮询、列表、重试全在 `ImageWorkbench.tsx` 里（一个 `kind` 区分）。
 * 这个文件只做三件事：把 `kind: 'video'` 传进去、留住两个老名字的导出。
 *
 * ## 为什么当初「没有取消按钮」，现在有了
 *
 * 那时候（契约 BB）**真实任务不存在** —— 加一个「取消」只会让用户以为取消成功了，
 * 然后等一个永远不会结束的「进行中」。现在宿主真的有任务在跑
 * （`src/schedule/generate.ts` 的 `cancelTask` 会真的 abort 掉上游），所以取消有意义。
 *
 * ## 计时为什么仍是本机算
 *
 * 「已等 N 秒」= `now - createdAt`。宿主也给了 `waitedMs`，但它只在轮询那一刻是准的，
 * 两次轮询之间秒数不动，看起来像卡住。钟表读数是本机的事。
 *
 * ## 没有百分比
 *
 * 参考项目也没有。上游只报「第几步」，要换算成百分比只能编一个分母 ——
 * 编出来的数字比没有更糟。
 */
import { ImageWorkbench, waitText as sharedWaitText } from './ImageWorkbench.tsx'

/** 视频创作台的入参。 */
export interface VideoWorkbenchProps {
  /** 这一格是不是正显示着。 */
  active: boolean
}

/**
 * 视频创作台。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function VideoWorkbench({ active }: VideoWorkbenchProps): React.JSX.Element {
  return <ImageWorkbench active={active} kind="video" title="视频创作台" />
}

/**
 * 「已等 N 秒」的秒数。
 * @param createdAt - 提交时间（ms）。
 * @param now - 现在的时刻（ms）。
 * @returns 秒数（不小于 0；时钟回拨时钳到 0）。
 */
export function waitedSeconds(createdAt: number, now: number): number {
  const ms = now - createdAt
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.floor(ms / 1000)
}

/**
 * 「已等 N 秒 / 用时 …」。
 *
 * ⚠️ 这是**老签名**（记录 + 现在）。共用实现在 `ImageWorkbench.tsx`，
 * 那里收的是 `(createdAt, endedAt, now)` —— 三个数比一个对象好用（纯函数好喂）。
 * 这里只把老形状摊开，别再写第二份计时逻辑。
 *
 * @param log - 记录（只用到 `createdAt` 与 `endedAt`）。
 * @param now - 现在的时刻（ms）。
 * @returns 文案。
 */
export function waitText(log: { createdAt: number, endedAt?: number }, now: number): string {
  return sharedWaitText(log.createdAt, log.endedAt, now)
}
