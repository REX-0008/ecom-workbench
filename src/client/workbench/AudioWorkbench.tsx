/** 音频工作台（契约 CF，用户 m01076）。
 *
 * ## 与参考项目的关系
 *
 * 参考项目没有独立的音频格（它的音频生成挂在全能参考视频那一类里）。
 * 我们单开一格的理由：宿主那边 `kind: 'audio'` 是**独立的一条能力**
 * （`src/schedule/generate.ts` 的 `GenKind` 有它、`comfyuiAudioWorkflow` 字段也有它），
 * 界面上没有入口就等于那条能力没法用。
 *
 * ## 与生图工作台的关系
 *
 * **同一份实现**（`ImageWorkbench.tsx`），只是 `kind: 'audio'`：
 * 参数少两项（没有张数、没有尺寸），列表里用播放器而不是图片。
 * 用户 m01076 说「按参考抄」，但三格共用一份实现比复制三份更不容易漂
 * （`pitfalls/同一件事写两份迟早漂.md`）。
 */
import { ImageWorkbench } from './ImageWorkbench.tsx'

/** 音频工作台的入参。 */
export interface AudioWorkbenchProps {
  /** 这一格是不是正显示着。 */
  active: boolean
}

/**
 * 音频工作台。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function AudioWorkbench({ active }: AudioWorkbenchProps): React.JSX.Element {
  return <ImageWorkbench active={active} kind="audio" title="音频工作台" />
}
