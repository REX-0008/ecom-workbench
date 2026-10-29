/** 图像操作浮层：裁剪 / 拆图 / 抓帧（用户 m02814，#59 / #62 / #65）。
 *
 * ## 这个文件里有什么、没有什么
 *
 * **有**：三个面板的界面、比例预设、行列数、抓哪一帧的三个选项。
 * **没有**：像素操作。真正 `drawImage` / `getImageData` 那一步在
 * `content-nodes.tsx` 的工具条回调里做（那里拿得到 `<img>` / `<video>` 元素），
 * 而**几何算法全在 `lib/canvas/image-ops.ts`**（纯函数、能单独跑）。
 *
 * ## 为什么不把像素操作也放这里
 *
 * 这里是个浮层，它不知道用户点的是哪个节点、那个节点的 `<img>` 在不在。
 * 像素操作需要「现场」（元素、加载完成没、原图尺寸），那属于节点的事。
 * 浮层只负责**问参数**，然后回调出去。
 */
import { useState } from 'react'
import {
  applyRatioPreset, normalizeCrop, ratioValue, splitRects,
  type CropRect, type RatioPreset,
} from './lib/canvas/image-ops.ts'
import css from './EcomWorkbench.module.css'

/** 面板种类。 */
export type ImageOpKind = 'crop' | 'split' | 'frame' | 'mask'

/** 比例预设的显示名（文案守 R6：不用第二人称、不做疑问句）。 */
const RATIO_LABELS: readonly { id: RatioPreset, label: string }[] = [
  { id: 'free', label: '自由' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:4', label: '3:4' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
]

/** 入参。 */
export interface ImageOpPanelProps {
  /** 打开哪个面板。 */
  kind: ImageOpKind
  /** 原图 / 视频的像素宽高（拿不到时给 `undefined`，面板用比例尺代替精确像素）。 */
  image?: { width: number, height: number }
  /** 裁剪：确认。 */
  onCrop?: (rect: CropRect) => void
  /** 拆图：确认（行列数）。 */
  onSplit?: (rows: number, cols: number) => void
  /** 抓帧：确认。 */
  onFrame?: (which: 'first' | 'last' | 'current') => void
  /** 收起。 */
  onClose: () => void
  /**
   * 这一步现在能不能做；不能时**为什么**（判据 5：不许静默）。
   *
   * 比如视频还没加载出元数据时 `duration` 是 `NaN`，抓帧做不了 ——
   * 那时这里要给出「视频还没加载完」这种能看懂的理由，而不是让按钮点了没反应。
   */
  blockedReason?: string
}

/**
 * 裁剪面板。
 * @param props - 见 `ImageOpPanelProps`。
 * @returns 面板。
 */
function CropBody(props: ImageOpPanelProps): React.JSX.Element {
  const [ratio, setRatio] = useState<RatioPreset>('free')
  const [rect, setRect] = useState<CropRect>({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 })
  const img = props.image
  /**
   * 改比例预设。
   * @param p - 新预设。
   */
  const pickRatio = (p: RatioPreset): void => {
    setRatio(p)
    /* 立刻把框收成等比 —— 用户选了 1:1 却看到框还是 16:9 会以为没生效。 */
    setRect(applyRatioPreset(rect, p, img))
  }
  /**
   * 改一个数值（四个输入框共用）。
   * @param key - 哪个字段。
   * @param v - 新值（0~1）。
   */
  const setField = (key: keyof CropRect, v: number): void => {
    const next = { ...rect, [key]: v }
    setRect(normalizeCrop(next, 0))
  }
  const px = img === undefined ? null : {
    width: Math.round(rect.width * img.width),
    height: Math.round(rect.height * img.height),
  }
  return (
    <>
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelKey}>比例</span>
        <div className={css.imageOpRatios}>
          {RATIO_LABELS.map(r => (
            <button
              key={r.id}
              type="button"
              data-ewb-crop-ratio={r.id}
              data-active={ratio === r.id ? '' : undefined}
              className={css.imageOpChip}
              onClick={() => { pickRatio(r.id) }}
            >{r.label}</button>
          ))}
        </div>
      </div>
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelKey}>范围</span>
        <div className={css.imageOpFields}>
          {(['x', 'y', 'width', 'height'] as const).map(k => (
            <label key={k} className={css.imageOpField}>
              <span>{k === 'x' ? '左' : k === 'y' ? '上' : k === 'width' ? '宽' : '高'}</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                data-ewb-crop-field={k}
                className={css.nodePanelInput + ' nodrag'}
                value={rect[k]}
                onChange={(e) => { setField(k, Number(e.target.value)) }}
              />
            </label>
          ))}
        </div>
      </div>
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelHint} data-ewb-crop-size="">
          {px === null ? '原图尺寸未知，按比例裁剪' : '裁出来约 ' + String(px.width) + ' × ' + String(px.height) + ' 像素'}
        </span>
      </div>
      <div className={css.nodePanelRow}>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-crop-ok=""
          className={css.nodePanelBtn}
          disabled={props.blockedReason !== undefined}
          onClick={() => { props.onCrop?.(rect) }}
        >裁剪</button>
      </div>
    </>
  )
}

/**
 * 拆图面板。
 * @param props - 见 `ImageOpPanelProps`。
 * @returns 面板。
 */
function SplitBody(props: ImageOpPanelProps): React.JSX.Element {
  const [rows, setRows] = useState(2)
  const [cols, setCols] = useState(2)
  const img = props.image ?? { width: 1, height: 1 }
  const pieces = splitRects(img.width, img.height, rows, cols)
  return (
    <>
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelKey}>行 × 列</span>
        <div className={css.imageOpFields}>
          <label className={css.imageOpField}>
            <span>行</span>
            <input
              type="number" min={1} max={16} step={1}
              data-ewb-split-rows=""
              className={css.nodePanelInput + ' nodrag'}
              value={rows}
              onChange={(e) => { setRows(Math.max(1, Math.min(16, Math.round(Number(e.target.value) || 1)))) }}
            />
          </label>
          <label className={css.imageOpField}>
            <span>列</span>
            <input
              type="number" min={1} max={16} step={1}
              data-ewb-split-cols=""
              className={css.nodePanelInput + ' nodrag'}
              value={cols}
              onChange={(e) => { setCols(Math.max(1, Math.min(16, Math.round(Number(e.target.value) || 1)))) }}
            />
          </label>
        </div>
      </div>
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelHint} data-ewb-split-count="">
          会切出 {pieces.length} 张，画布上排成一组
        </span>
      </div>
      <div className={css.nodePanelRow}>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-split-ok=""
          className={css.nodePanelBtn}
          disabled={props.blockedReason !== undefined}
          onClick={() => { props.onSplit?.(rows, cols) }}
        >拆图</button>
      </div>
    </>
  )
}

/** 抓帧的三个选项。 */
const FRAMES: readonly { id: 'first' | 'last' | 'current', label: string }[] = [
  { id: 'first', label: '首帧' },
  { id: 'last', label: '尾帧' },
  { id: 'current', label: '当前帧' },
]

/**
 * 抓帧面板。
 * @param props - 见 `ImageOpPanelProps`。
 * @returns 面板。
 */
function FrameBody(props: ImageOpPanelProps): React.JSX.Element {
  return (
    <>
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelKey}>抓哪一帧</span>
        <div className={css.imageOpRatios}>
          {FRAMES.map(f => (
            <button
              key={f.id}
              type="button"
              data-ewb-frame={f.id}
              className={css.imageOpChip}
              disabled={props.blockedReason !== undefined}
              onClick={() => { props.onFrame?.(f.id) }}
            >{f.label}</button>
          ))}
        </div>
      </div>
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelHint} data-ewb-frame-hint="">
          {props.blockedReason ?? '抓出来的那一帧存成新产物，原视频不动'}
        </span>
      </div>
    </>
  )
}

/**
 * 图像操作浮层。
 * @param props - 见 `ImageOpPanelProps`。
 * @returns 浮层。
 */
export function ImageOpPanel(props: ImageOpPanelProps): React.JSX.Element {
  const title = props.kind === 'crop'
    ? '裁剪'
    : props.kind === 'split'
      ? '拆图'
      : props.kind === 'mask' ? '局部重绘' : '抓帧'
  /* 蒙版是单独一个组件（它要 canvas 与指针交互），不在这里面。 */
  if (props.kind === 'mask') return <></>
  return (
    <div className={css.imageOpPanel} data-ewb-image-op={props.kind} onPointerDown={e => { e.stopPropagation() }}>
      <div className={css.nodePanelHead}>
        <span className={css.nodePanelTitle}>{title}</span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-image-op-close=""
          className={css.nodePanelBtn}
          onClick={props.onClose}
        >收起</button>
      </div>
      {/* ⚠️ 判据 5：做不了就当场说清，不许做成「点了没反应」。 */}
      {props.blockedReason !== undefined && props.kind === 'crop'
        ? <div className={css.nodePanelRow}><span className={css.nodePanelHint} data-ewb-image-op-blocked="">{props.blockedReason}</span></div>
        : null}
      {props.kind === 'crop' ? <CropBody {...props} /> : null}
      {props.kind === 'split' ? <SplitBody {...props} /> : null}
      {props.kind === 'frame' ? <FrameBody {...props} /> : null}
    </div>
  )
}

/** 把比例预设换算成数值（给外面算像素用）。 */
export { ratioValue }
