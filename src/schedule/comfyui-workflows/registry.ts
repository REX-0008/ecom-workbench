/** ComfyUI 内置工作流的注册表（契约 CA，2026-10-26）。
 *
 * ## 这 16 份 JSON 从哪来
 *
 * 从参考项目 `refs-projects/infinite-canvas/web/src/assets/workflows/` **原样复制**，
 * 一个字节都没改（验收时用 SHA256 逐份比过，见 `tests/comfyui-workflows.mjs`）。
 * 它们是上游作者导出的 ComfyUI API 格式工作流，属于别人的作品；
 * 我们只做「按类别挑一份、把参数填进槽位」，不改它的拓扑。
 *
 * ⚠️ **不许手工编辑这些 JSON**。要改行为就改填槽位的代码
 * （`applyBindings` / `pruneUnusedRefs`），改 JSON 等于把「上游原文」
 * 变成「我们改过的版本」，以后没法再对齐。
 *
 * ## 为什么分成「默认」与「候选」两层
 *
 * 参考项目也是两层（`DEFAULT_BUILTIN_COMFYUI_WORKFLOWS` 的 bundle +
 * `getDefaultComfyWorkflowItems()` 的候选清单）。理由：
 * · 「默认」= 用户什么都不选时用哪一份（每类只有一个）；
 * · 「候选」= 用户能选的全部（视频那几类各有 4 份，FP8/BF16、步数不同）。
 *
 * ## 三类别**没有**内置工作流
 *
 * `superResolve` / `angle` / `upscale`：参考项目里这三类的 JSON **不在**内置清单里
 * （它由用户自己导入）。所以 `defaultWorkflowOf` 对它们返回 `undefined` ——
 * 这是刻意的，不是漏了。`availableWorkflowsOf` 也回空数组。
 */
import type { ComfyWorkflow } from '../comfyui.ts'

/* 16 份 JSON。用 `with { type: 'json' }` 让打包器把它内联进去 ——
 * 部署目录里只有 `lib/`、没有 `src/`，运行时读文件的写法在部署后找不到文件。 */
import t2iZImageTurbo from './t2i_z_image_turbo_api.json' with { type: 'json' }
import i2iFlux2Dev from './i2i_flux2_dev_api.json' with { type: 'json' }
import inpaintQwenImage from './inpaint_qwen_image_api.json' with { type: 'json' }
import textQwen35 from './text_qwen3_5_api.json' with { type: 'json' }
import omniVideoFp8 from './video_minimax_h3_omni_fp8_20step_api.json' with { type: 'json' }
import omniVideoFp8Pdmd from './video_minimax_h3_omni_fp8_4step_pdmd_api.json' with { type: 'json' }
import omniVideoBf16Turbo from './video_minimax_h3_omni_bf16_8step_turbo_api.json' with { type: 'json' }
import omniVideoBf1620 from './video_minimax_h3_omni_bf16_20step_api.json' with { type: 'json' }
import frameVideoFp8 from './video_minimax_h3_frame_fp8_20step_api.json' with { type: 'json' }
import frameVideoFp8Pdmd from './video_minimax_h3_frame_fp8_4step_pdmd_api.json' with { type: 'json' }
import frameVideoBf16Turbo from './video_minimax_h3_frame_bf16_8step_turbo_api.json' with { type: 'json' }
import frameVideoBf1620 from './video_minimax_h3_frame_bf16_20step_api.json' with { type: 'json' }
import qwenImage21 from './qwen_image_21_api.json' with { type: 'json' }
import audioMinimaxMusic3 from './audio_minimax_music_3_api.json' with { type: 'json' }
import videoH3FaceRefine from './video_h3_face_refine_api.json' with { type: 'json' }
import videoDepthReshot from './video_depth_reshot_api.json' with { type: 'json' }

/**
 * 工作流类别（照参考 `use-config-store.ts:39` 的枚举，一个不多一个不少）。
 *
 * 为什么是这 12 个而不是按我们的界面来定：类别决定「校验时该找哪个输出标记」
 * （生图要有 `output_image`、视频要有 `output_video`…），照抄才能和这 16 份
 * 工作流里的 `_meta.title` 对得上。
 */
export type WorkflowCategory =
  | 't2i' | 'i2i' | 'inpaint' | 'text' | 'omniVideo' | 'frameVideo'
  | 'audio' | 'faceRefine' | 'depthVideo' | 'superResolve' | 'angle' | 'upscale'

/** 12 个类别的完整清单（界面按它排序，测试按它遍历）。 */
export const WORKFLOW_CATEGORIES: readonly WorkflowCategory[] = [
  't2i', 'i2i', 'inpaint', 'text', 'omniVideo', 'frameVideo',
  'audio', 'faceRefine', 'depthVideo', 'superResolve', 'angle', 'upscale',
]

/** 一份带说明的内置工作流（候选清单里的条目）。 */
export interface BuiltinWorkflow {
  /** 稳定 id（存进渠道配置时用它，不用名字）。 */
  id: string
  /** 显示名。 */
  name: string
  /** 属于哪一类。 */
  category: WorkflowCategory
  /** 工作流本体（ComfyUI API 格式）。 */
  json: ComfyWorkflow
  /** 这一类的默认项（每类最多一个 `true`）。 */
  isDefault: boolean
  /** 说明（界面上给用户看「这份与其他份差在哪」）。 */
  description: string
}

/**
 * 16 份全部候选（顺序照参考 `getDefaultComfyWorkflowItems()`）。
 *
 * 为什么把说明文字也抄下来：视频那 4×2 份的区别就在「FP8 / BF16 / 步数」，
 * 用户靠名字分不出来 —— 说明是唯一能说清的地方。
 */
export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  {
    id: 't2i-qwen-image-21', name: 'Qwen-Image-2.1 文生图', category: 't2i',
    json: qwenImage21 as ComfyWorkflow, isDefault: true,
    description: 'Qwen-Image-2.1 大模型文生图工作流（BF16，支持多模态理解与超写实画质）',
  },
  {
    id: 't2i-z-image-turbo', name: 'Z-Image-Turbo 文生图', category: 't2i',
    json: t2iZImageTurbo as ComfyWorkflow, isDefault: false,
    description: 'Z-Image-Turbo 极速文生图工作流（BF16，4~8 步出图）',
  },
  {
    id: 'i2i-qwen-image-21', name: 'Qwen-Image-2.1 多图参考图生图', category: 'i2i',
    json: qwenImage21 as ComfyWorkflow, isDefault: true,
    description: 'Qwen-Image-2.1 多图融合与风格迁移工作流（支持最多 10 张参考图）',
  },
  {
    id: 'i2i-flux2-dev', name: 'Flux2.Dev 图生图', category: 'i2i',
    json: i2iFlux2Dev as ComfyWorkflow, isDefault: false,
    description: 'Flux2.Dev 多图参考与风格迁移工作流（FP8 + Turbo LoRA）',
  },
  {
    id: 'inpaint-qwen-image', name: 'Qwen-Image 局部编辑', category: 'inpaint',
    json: inpaintQwenImage as ComfyWorkflow, isDefault: true,
    description: 'Qwen-Image 视觉语言引导局部精准重绘工作流（4 步 Lightning）',
  },
  {
    id: 'text-qwen3-5', name: 'Qwen3.5 文本生成与反推', category: 'text',
    json: textQwen35 as ComfyWorkflow, isDefault: true,
    description: 'Qwen3.5 4B 本地端侧提示词扩写与视觉反推工作流',
  },
  {
    id: 'omni-video-minimax-h3-fp8-4step-pdmd', name: 'MiniMax H3 全能视频（FP8 4步 PDMD）',
    category: 'omniVideo', json: omniVideoFp8Pdmd as ComfyWorkflow, isDefault: true,
    description: 'MiniMax H3 全能参考视频极速版（FP8 4步 PDMD，集成 EasyCache 特征缓存）',
  },
  {
    id: 'omni-video-minimax-h3-fp8', name: 'MiniMax H3 全能视频（FP8 20步）',
    category: 'omniVideo', json: omniVideoFp8 as ComfyWorkflow, isDefault: false,
    description: 'MiniMax H3 全能参考视频（FP8 Scaled，适合消费级单卡）',
  },
  {
    id: 'omni-video-minimax-h3-bf16-turbo', name: 'MiniMax H3 全能视频（BF16 8步 Turbo）',
    category: 'omniVideo', json: omniVideoBf16Turbo as ComfyWorkflow, isDefault: false,
    description: 'MiniMax H3 全能参考视频极速版（BF16 Turbo 8步，适合大显存高性能显卡）',
  },
  {
    id: 'omni-video-minimax-h3-bf16-20step', name: 'MiniMax H3 全能视频（BF16 20步）',
    category: 'omniVideo', json: omniVideoBf1620 as ComfyWorkflow, isDefault: false,
    description: 'MiniMax H3 全能参考视频高精版（BF16 20步，完整精度采样，画质上限最高）',
  },
  {
    id: 'frame-video-minimax-h3-fp8-4step-pdmd', name: 'MiniMax H3 首尾帧视频（FP8 4步 PDMD）',
    category: 'frameVideo', json: frameVideoFp8Pdmd as ComfyWorkflow, isDefault: true,
    description: 'MiniMax H3 首尾帧插值视频极速版（FP8 4步 PDMD，仅需 4 步极速出片）',
  },
  {
    id: 'frame-video-minimax-h3-fp8', name: 'MiniMax H3 首尾帧视频（FP8 20步）',
    category: 'frameVideo', json: frameVideoFp8 as ComfyWorkflow, isDefault: false,
    description: 'MiniMax H3 首尾帧插值视频（FP8 Scaled，适合消费级单卡）',
  },
  {
    id: 'frame-video-minimax-h3-bf16-turbo', name: 'MiniMax H3 首尾帧视频（BF16 8步 Turbo）',
    category: 'frameVideo', json: frameVideoBf16Turbo as ComfyWorkflow, isDefault: false,
    description: 'MiniMax H3 首尾帧插值视频极速版（BF16 Turbo 8步，适合大显存高性能显卡）',
  },
  {
    id: 'frame-video-minimax-h3-bf16-20step', name: 'MiniMax H3 首尾帧视频（BF16 20步）',
    category: 'frameVideo', json: frameVideoBf1620 as ComfyWorkflow, isDefault: false,
    description: 'MiniMax H3 首尾帧插值视频高精版（BF16 20步，完整精度采样，动态演化更平滑）',
  },
  {
    id: 'audio-minimax-music-3', name: 'MiniMax Music 03 音乐生成', category: 'audio',
    json: audioMinimaxMusic3 as ComfyWorkflow, isDefault: true,
    description: 'MiniMax Music 03 扩散音乐大模型（支持最长 5 分钟完整歌曲与纯伴奏）',
  },
  {
    id: 'tool-face-refine-h3', name: 'MiniMax H3 人脸修复', category: 'faceRefine',
    json: videoH3FaceRefine as ComfyWorkflow, isDefault: true,
    description: 'MiniMax H3 视频人脸/小脸追踪精修工作流（支持最多 9 张角色参考图与原视频局部脸部增强）',
  },
  {
    id: 'tool-depth-video-reshot', name: 'ReShot 深度视频提取', category: 'depthVideo',
    json: videoDepthReshot as ComfyWorkflow, isDefault: true,
    description: 'ReShot 单目视频时序连续深度估计工作流（近白远黑深度视频，用于剥离演员与画风生成走位参考）',
  },
]

/**
 * 某一类的默认工作流。
 *
 * @param category - 类别。
 * @returns 默认那份；**这一类没有内置工作流时给 `undefined`**
 *   （`superResolve` / `angle` / `upscale` 就是这种情况，不是错误）。
 */
export function defaultWorkflowOf(category: WorkflowCategory): BuiltinWorkflow | undefined {
  return BUILTIN_WORKFLOWS.find(w => w.category === category && w.isDefault)
    /* 兜底：这一类有工作流但没有标默认（配置写错时）——给第一份，
     * 比让调用方拿到 undefined 再去查「为什么没默认」好。 */
    ?? BUILTIN_WORKFLOWS.find(w => w.category === category)
}

/**
 * 某一类的全部候选。
 *
 * @param category - 类别。
 * @returns 候选数组；没有内置工作流的类别给空数组（不是抛错）。
 */
export function availableWorkflowsOf(category: WorkflowCategory): BuiltinWorkflow[] {
  return BUILTIN_WORKFLOWS.filter(w => w.category === category)
}

/**
 * 按 id 找一份。
 *
 * @param id - 内置 id（如 `t2i-z-image-turbo`）。
 * @returns 那一份；找不到给 `undefined`。
 */
export function builtinWorkflowById(id: string): BuiltinWorkflow | undefined {
  return BUILTIN_WORKFLOWS.find(w => w.id === id)
}

/**
 * 这份工作流是不是「我们内置的某一份」（按 JSON 内容比，不按引用比）。
 *
 * 为什么需要：渠道里存的可能是用户从内置项复制出去的副本，也可能是他自己导入的。
 * 前者能享受「上游更新了我们就跟着更新」，后者不能。判据只能是内容。
 *
 * @param json - 要查的工作流。
 * @returns 对应的内置项；不是内置的给 `undefined`。
 */
export function builtinOfJson(json: ComfyWorkflow): BuiltinWorkflow | undefined {
  const key = JSON.stringify(json)
  return BUILTIN_WORKFLOWS.find(w => JSON.stringify(w.json) === key)
}

/**
 * 给界面用的清单（不带 JSON 本体 —— 16 份共 148KB，列表页不该搬一遍）。
 *
 * @param category - 只列这一类；不给就列全部。
 * @returns 清单条目。
 */
export function listBuiltinWorkflows(category?: WorkflowCategory): {
  id: string, name: string, category: WorkflowCategory, isDefault: boolean, description: string,
}[] {
  const src = category === undefined ? BUILTIN_WORKFLOWS : BUILTIN_WORKFLOWS.filter(w => w.category === category)
  return src.map(w => ({
    id: w.id, name: w.name, category: w.category, isDefault: w.isDefault, description: w.description,
  }))
}
