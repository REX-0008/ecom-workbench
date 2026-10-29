/** 内容板块：**内容画布**（画布库 + 画布本体）＋ 其余格的占位。
 *
 * ## 2026-10-25 契约 AY 之前它是什么，改了什么
 *
 * 原来这个板块是「图片生产 / 视频生产」两格的**空壳**（所有按钮禁用、
 * 顶部写着「未接通」）。计划 §三 Step 3 把内容板块定成画布形态，所以两格表单让位给：
 *
 *   · **画布库**（常驻格）—— 已经有哪些画布，新建 / 打开 / 改名 / 删除；
 *   · **画布**（动态格）—— 打开一份画布才出现，关闭后消失；
 *   · **其余格**（生图工作台 / 视频创作台 / 内容库 / 提示词库 / 配置）——
 *     计划里排在 Step 2/4/5/6，本轮**只留占位**，写明「还没做 + 排在哪一步」。
 *
 * ⚠️ 占位不能写成「点着没反应」：那在本项目踩过（用户会当成坏了）。
 * 所以占位格是一段说明 + 一句「排在后面哪一步」，**没有假按钮**。
 *
 * ## tab 条上「画布」怎么出现
 *
 * 走上一轮（契约 AU）铺好的通道：`BoardProps.onTabsChange`。
 * 本板块把 `canvas` 声明成 `dynamic`，然后上报「现在该显示哪几格」；
 * 骨架只过滤、不重排 —— 所以「画布排第一」靠的是**注册时写在第一位**。
 *
 * ## 为什么重命名 `openId` 之外不加状态
 *
 * 「当前编辑哪份画布」只有一份真相（`openId`）。画布内容、撤销栈都在
 * `ContentCanvas` 里面 —— 板块这一层不该知道节点长什么样。
 */
import { useCallback, useEffect, useState } from 'react'
import type { BoardProps } from './board-registry.ts'
import { ContentCanvas } from './ContentCanvas.tsx'
import { ContentCanvasLib } from './ContentCanvasLib.tsx'
import { ContentLibrary } from './ContentLibrary.tsx'
import { ImageWorkbench } from './ImageWorkbench.tsx'
import { VideoWorkbench } from './VideoWorkbench.tsx'
/* ★ `AudioWorkbench` 的 import **已撤**（票 34，2026-10-28）：音频工作台那一格
 * 已从 `boards.ts` 的 tab 声明里删掉，所以这里不再需要它。
 * 文件本身**先留着** —— 删文件不可逆，等确认没有别处 import 再删。 */
import { PromptLibrary } from './PromptLibrary.tsx'
/* 配置格：三个 tab（提示词源 / 存储 / 偏好）。
 * 2026-10-27 起由 `ConfigTabs.tsx` 管挂载 —— 原来这里直接挂 `ChannelSettings`，
 * 而它把另外三块竖着叠在渠道下面（票 10）。
 * ★ 票 38（2026-10-28）：渠道与四类默认模型**已上收到工作台设置**
 * （`WorkspaceSettings.tsx`），配置页只剩板块自己那三项。
 * 所以这里不需要 `ChannelSettings` / `DefaultsSettings` 的 import 了。 */
import { ConfigTabs } from './ConfigTabs.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import css from './EcomWorkbench.module.css'

/** 除「画布」之外永远显示的那几格（顺序与 `boards.ts` 的 `tabs` 一致）。 */
const ALWAYS: readonly string[] = ['lib', 'gen', 'video', 'library', 'prompts', 'config']

/**
 * 内容板块。
 * @param props - 骨架给的入参。
 * @returns 界面。
 */
export function ContentBoard({ active, tab, keptTabs, onTabsChange, onSelectTab }: BoardProps): React.JSX.Element {
  /** 正在编辑哪一份画布（空串 = 没打开）。 */
  const [openId, setOpenId] = useState('')

  /* 上报「现在哪几格该显示」：只有画布是动态格，打开了一份才出现。 */
  useEffect(() => {
    onTabsChange?.(openId === '' ? ALWAYS : ['canvas', ...ALWAYS])
  }, [openId, onTabsChange])

  /** 打开一份画布：记下 id，并让骨架切到画布那一格。 */
  const openCanvas = useCallback((id: string): void => {
    setOpenId(id)
    onSelectTab('canvas')
  }, [onSelectTab])

  /** 关掉画布：清空 id（tab 条上那一格随之消失，骨架会把当前格落到别的格）。 */
  const closeCanvas = useCallback((): void => {
    setOpenId('')
  }, [])

  /* 画布这一格是不是正显示着（板块本身没显示时当然也不是）。 */
  const canvasActive = active && tab === 'canvas'
  /** 骨架说「画布这一格必须留着」（常驻），切走也不许卸。 */
  const canvasKept = (keptTabs ?? []).includes('canvas')
  /* 挂不挂画布：打开过一份、或此刻正看着、或骨架说它常驻。 */
  const canvasMounted = openId !== '' || canvasActive || canvasKept
  const canvasShown = canvasActive && openId !== ''

  /**
   * 这一格实际该显示什么。
   *
   * ## ⚠️ 为什么要这一层（2026-10-25 契约 AY 实测发现的坑）
   *
   * 画布那格写在 `tabs` 的**第一位**（验收要求「出现时排第一」），
   * 而骨架的「当前格」默认取 `tabs[0]` —— 于是**第一次进内容板块时，
   * 骨架给的 `tab` 就是 `'canvas'`，但一份画布都没打开**。
   *
   * 结果是进板块先看到一片空白，等上报把画布格过滤掉才换成画布库。
   * 所以这里兜一层：说是画布、可又没有画布时，显示画布库。
   */
  const shown = tab === 'canvas' && openId === '' ? 'lib' : tab

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ewb-content="">
      {/* ⚠️ 画布**不条件渲染**（打开过就一直挂着，只藏起来）：
          节点与撤销栈在组件内，卸载就丢；藏的四个坑见 EcomWorkbench.module.css 的 .pane 注释。
          这里用 .contentPane（与 .pane 同一套手法，新加的类，不动既有类）。 */}
      {canvasMounted && openId !== ''
        ? (
          <div className={css.contentPane} data-active={canvasShown || undefined} data-ewb-content-pane="canvas">
            <ErrorBoundary
              name="内容画布"
              retryLabel="重试画布"
              onEscape={() => { closeCanvas() }}
            >
              <ContentCanvas canvasId={openId} active={canvasShown} onClose={closeCanvas} />
            </ErrorBoundary>
          </div>
        )
        : null}

      {/* ⚠️ 这里的判据是 `shown`（不是 `canvasShown`）：非激活时骨架传下来的
          `tab` 是第一个常驻格，用 `canvasShown` 会把列表也一起藏掉。 */}
      {shown === 'canvas'
        ? null
        : (
          <div className="flex min-h-0 flex-1 flex-col">
            {shown === 'lib' || shown === ''
              ? <ContentCanvasLib active={active} onOpen={openCanvas} />
              : shown === 'library'
                ? <ContentLibrary active={active} />
                : shown === 'gen'
                  ? <ImageWorkbench active={active} />
                  : shown === 'video'
                    ? <VideoWorkbench active={active} />
                    : shown === 'prompts'
                      ? <PromptLibrary active={active} />
                      : shown === 'config'
                        ? <ConfigTabs active={active} />
                        /* 七个格都有真实内容了（2026-10-25 契约 BF），所以这里不会走到。
                         * 留一句兜底而不是 `null`：万一以后加了一格忘了接线，
                         * 用户看到「这一格还没接上」比看到一片空白好查。 */
                        : <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-content-unknown={shown}>
                            这一格还没接上：{shown}
                          </div>}
          </div>
        )}
    </div>
  )
}
