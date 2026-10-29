/** 节点悬浮工具条（契约 CD 第六节）。
 *
 * ## 照参考项目的做法
 *
 * `refs-projects/infinite-canvas/web/src/components/canvas/canvas-node-hover-toolbar.tsx`
 * 的核心是一条规则：**显示哪几项由节点类型和「有没有内容」决定**，不是固定一条。
 * 它那里的判据在 `:215-228`（`hasImage / hasVideo / hasAudio / isText / isConfig` 各推一批）。
 *
 * ## 我们的对应规则
 *
 * | 项 | 什么时候有 | 为什么 |
 * |---|---|---|
 * | 下载 | 有产物（图 / 视频 / 音频） | 文本与配置没有可下载的字节 |
 * | 存素材 | 有产物，或文本 | 文本也能当素材存进素材库 |
 * | 复制提示词 | 有提示词 | 没提示词就没什么可复制的 |
 * | 全屏 | 有产物（图 / 视频 / 音频） | 同下载 |
 * | 替换 | 图片 / 视频 / 音频 | 文本与配置没有可替换的字节 |
 * | 删除 | 总是有 | — |
 *
 * 为什么按类型给项而不是给一堆灰按钮：配置节点上出现「下载」，用户点它只会疑惑
 * 「这里下载什么」。按类型给项比给灰按钮清楚 —— 参考项目也是这么做的。
 *
 * ## 为什么这层是「纯展示」的
 *
 * 它不 import 画布的 context，只收回调。这样它可以被单元断言单独验
 * （「图片节点有下载项、配置节点没有」这条断言不用挂整个画布）。
 */
import css from './EcomWorkbench.module.css'

/** 悬浮工具条要做的事（由节点外壳传下来）。 */
export interface NodeHoverActions {
  onDownload: () => void
  onSaveAsset: () => void
  onCopyPrompt: () => void
  onView: () => void
  onUpload: () => void
  onDelete: () => void
  /** 打开图像操作浮层（用户 m02814，三种共用一个入口，浮层里再分）。 */
  onImageOp: () => void
  /** 打开局部重绘的蒙版面板（用户 m02814 #60）。 */
  onMask: () => void
  /** 跑一个图像操作（放大 / 超分，用户 m02814 #61 / #63）。
   *
   * ⚠️ 票 76：`caption` 从联合类型里去掉了 —— 工具栏不再给那颗按钮，
   * 留着类型会让人以为还能调。 */
  onRunOp: (op: 'upscale' | 'superResolve') => void
}

/** 入参。 */
export interface NodeHoverToolbarProps extends NodeHoverActions {
  /** 节点 id（断言与 key 用）。 */
  id: string
  /** 节点类型。 */
  type: string
  /** 有没有产物。 */
  hasArtifact: boolean
  /** 有没有提示词。 */
  hasPrompt: boolean
}

/**
 * 这一项该不该显示（**纯函数**，验收 9 的判据落在这里）。
 *
 * @param item - 项 id。
 * @param type - 节点类型。
 * @param hasArtifact - 有没有产物。
 * @param hasPrompt - 有没有提示词。
 * @returns 显示给 true。
 */
export function showHoverItem(
  item: 'download' | 'saveAsset' | 'copyPrompt' | 'view' | 'upload' | 'delete' | 'imageOp' | 'mask'
    | 'upscale' | 'superResolve',
  type: string,
  hasArtifact: boolean,
  hasPrompt: boolean,
): boolean {
  const media = type === 'image' || type === 'video' || type === 'audio'
  if (item === 'download' || item === 'view') return hasArtifact && media
  if (item === 'saveAsset') return hasArtifact || type === 'text'
  if (item === 'copyPrompt') return hasPrompt
  if (item === 'upload') return media
  /* ★ 图像操作（裁剪 / 拆图 / 抓帧）：只有**真的有产物**的图与视频才给
   * （空节点上没东西可裁、没视频可抓帧）。 */
  if (item === 'imageOp') return hasArtifact && (type === 'image' || type === 'video')
  /* ★ 局部重绘只对**图片**给：视频没有「涂一块重画」这回事。 */
  if (item === 'mask') return hasArtifact && type === 'image'
  /* ★ 放大 / 超分都只对**图片**、且**必须有产物**（没图放大什么）。
   * `caption` 票 76 停用了，清单里已经没有它，这里也就不再有那一支。 */
  if (item === 'upscale' || item === 'superResolve') {
    return hasArtifact && type === 'image'
  }
  return true
}

/**
 * 悬浮工具条。
 * @param props - 见 `NodeHoverToolbarProps`。
 * @returns 工具条。
 */
export function NodeHoverToolbar(props: NodeHoverToolbarProps): React.JSX.Element {
  const { id, type, hasArtifact, hasPrompt } = props
  /** 全部候选（顺序即显示顺序）。 */
  const all: readonly {
    id: 'download' | 'saveAsset' | 'copyPrompt' | 'view' | 'upload' | 'delete' | 'imageOp' | 'mask'
      | 'upscale' | 'superResolve'
    label: string
    run: () => void
  }[] = [
    { id: 'download', label: '下载', run: props.onDownload },
    { id: 'saveAsset', label: '存素材', run: props.onSaveAsset },
    /* ★ 图像操作放这里：用户 m02814 要的三个功能都在这一格后面展开。
     * 文案守 R6：「图像操作」是名词短语，不是疑问句、没有第二人称。 */
    { id: 'imageOp', label: '图像操作', run: props.onImageOp },
    { id: 'mask', label: '局部重绘', run: props.onMask },
    /* ★ 三个轻量操作（用户 m02814 #61 / #63）：点了直接跑，没有参数要填。 */
    { id: 'upscale', label: '放大', run: () => { props.onRunOp('upscale') } },
    { id: 'superResolve', label: '超分', run: () => { props.onRunOp('superResolve') } },
    /* ⚠️ 票 76（2026-10-29）：**「反推」那一颗去掉了**（停用，不是删功能）。
     *
     * 它要的是文本模型，而渠道里已经没有「文本」这一类（文本统一走 dsh）。
     * 规格还在 `op-specs.ts`（带 `disabled: true`），以后接上 dsh 的视觉模型能回来。
     *
     * 为什么在**这里**删而不是靠 `showHoverItem` 返回 false：
     * 那一层的判据是「节点类型 + 有没有产物」，加一个「op 停用了没有」会让
     * 它开始 import 规格表 —— 而这层文件头写着「纯展示、只收回调」。
     * 直接从清单里删掉最简单，也不会有一条永远为 false 的判据骗人。 */
    { id: 'copyPrompt', label: '复制提示词', run: props.onCopyPrompt },
    { id: 'view', label: '全屏', run: props.onView },
    { id: 'upload', label: '替换', run: props.onUpload },
    { id: 'delete', label: '删除', run: props.onDelete },
  ]
  return (
    <span className={css.contentHoverBar} data-ewb-node-hoverbar={id}>
      {all.filter(it => showHoverItem(it.id, type, hasArtifact, hasPrompt)).map(it => (
        <button
          key={it.id}
          type="button"
          data-ewb-hover-item={it.id}
          className={css.contentHoverBtn + ' nodrag'}
          title={it.label}
          onPointerDown={e => { e.stopPropagation() }}
          onClick={(e) => { e.stopPropagation(); it.run() }}
        >{it.label}</button>
      ))}
    </span>
  )
}
