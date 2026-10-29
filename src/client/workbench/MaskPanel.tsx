/** 局部重绘的蒙版面板（用户 m02814 #60）。
 *
 * ## 这个文件里有什么、没有什么
 *
 * **有**：画笔 / 橡皮 / 笔刷大小、涂在底图上的交互、导出**黑底白遮罩**、
 * 「没涂不许提交」的拦截与原因。
 * **没有**：算的部分 —— 那些在 `lib/canvas/mask-ops.ts`（纯函数、能单独跑）。
 *
 * ## ⚠️ 为什么必须拦住「没涂就提交」
 *
 * 后端**不校验** `mask` 有没有内容。缺了它会给 ComfyUI 用工作流自带的占位遮罩，
 * **任务照样成功**、结果完全不对 —— 这是这一批最危险的失败方式：不报错。
 *
 * 所以「没涂」这件事必须在**界面**上挡住，并且说清原因（判据 2）。
 *
 * ## ⚠️ 像素绘制在浏览器，jsdom 里跑不了
 *
 * `getContext('2d')` 在 jsdom 里返回 `null`（实测）。所以这里真正画的那几步
 * （`ctx.arc` / `fill` / `toDataURL`）自动化**没验到**，交付时单独列出。
 * 能验的是：笔刷换算、笔画面积、有没有涂过、导出前的尺寸与底色约定。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  brushCommands, maskHasContent, normalizeBrush, strokeArea,
  type BrushStroke,
} from './lib/canvas/mask-ops.ts'
import css from './EcomWorkbench.module.css'

/** 入参。 */
export interface MaskPanelProps {
  /** 底图的产物 id（涂在它上面）。 */
  artifact: string
  /** 底图地址（`artifactHref` 的结果）。 */
  src: string
  /** 底图原始像素宽高（拿不到时给 `undefined`，面板用 1:1 兜底）。 */
  image?: { width: number, height: number }
  /** 导出成功：黑底白遮罩 PNG 的 base64（**不含** `data:` 前缀）。 */
  onExport: (mask: { mime: string, base64: string }) => void
  /** 收起。 */
  onClose: () => void
}

/** 笔刷的像素半径档（滑块给的是这个）。 */
export const BRUSH_MIN = 4
/** 笔刷最大像素半径。 */
export const BRUSH_MAX = 80

/**
 * 局部重绘面板。
 * @param props - 见 `MaskPanelProps`。
 * @returns 面板。
 */
export function MaskPanel(props: MaskPanelProps): React.JSX.Element {
  const [brushPx, setBrushPx] = useState(24)
  const [erase, setErase] = useState(false)
  const [strokes, setStrokes] = useState<BrushStroke[]>([])
  /** 正在画的那一笔（松手才进 `strokes`，这样撤销是「一笔」为单位）。 */
  const [drawing, setDrawing] = useState<BrushStroke | null>(null)
  const [err, setErr] = useState('')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const baseRef = useRef<HTMLImageElement | null>(null)

  const w = props.image?.width ?? 1
  const h = props.image?.height ?? 1
  const brushNorm = normalizeBrush(brushPx, w, h)
  /** 遮罩有没有真的涂到东西（判据 2）。 */
  const touched = maskHasContent(strokes)

  /**
   * 重画整块（底图 + 全部笔画）。
   *
   * ⚠️ 这段在 jsdom 里**跑不了**（`getContext('2d')` 给 `null`），
   * 所以它没有自动化判据 —— 见文件头那段。
   */
  const redraw = useCallback((): void => {
    const cv = canvasRef.current
    const base = baseRef.current
    if (cv === null || base === null) return
    const ctx = cv.getContext('2d')
    if (ctx === null) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.drawImage(base, 0, 0, cv.width, cv.height)
    /* 涂的那层单独用半透明红显示（用户看得见涂到哪儿了）。 */
    ctx.save()
    ctx.globalAlpha = 0.45
    ctx.strokeStyle = '#ff3b30'
    ctx.fillStyle = '#ff3b30'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const all = drawing === null ? strokes : [...strokes, drawing]
    for (const s of all) {
      const cmd = brushCommands(s)
      ctx.globalCompositeOperation = 'source-over'
      const pxRadius = cmd.radius * Math.min(cv.width, cv.height)
      ctx.lineWidth = pxRadius * 2
      ctx.beginPath()
      cmd.ops.forEach((op, i) => {
        const x = op.x * cv.width
        const y = op.y * cv.height
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      /* 单点也要画出圆头（只 moveTo 不 stroke 是什么都没有）。 */
      cmd.ops.forEach((op) => {
        ctx.beginPath()
        ctx.arc(op.x * cv.width, op.y * cv.height, pxRadius, 0, Math.PI * 2)
        ctx.fill()
      })
    }
    ctx.restore()
  }, [drawing, strokes])

  useEffect(() => { redraw() }, [redraw])

  /**
   * 鼠标位置 → 归一化坐标。
   * @param e - 指针事件。
   * @returns 归一化点（可能出界，`brushCommands` 会夹）。
   */
  const pointOf = (e: React.PointerEvent): { x: number, y: number } => {
    const cv = canvasRef.current
    if (cv === null) return { x: 0, y: 0 }
    const r = cv.getBoundingClientRect()
    return {
      x: r.width === 0 ? 0 : (e.clientX - r.left) / r.width,
      y: r.height === 0 ? 0 : (e.clientY - r.top) / r.height,
    }
  }

  /**
   * 导出**黑底白遮罩**的 PNG 并交给调用方。
   *
   * ## 为什么是黑底白
   *
   * ComfyUI 的 `ref_mask` 约定：白 = 要重绘、黑 = 保留。画反了会变成
   * 「保留要改的地方、改掉要留的地方」—— 结果完全相反，而且不报错。
   *
   * @returns 无。
   */
  const doExport = (): void => {
    if (!touched) { setErr('先涂出要重绘的区域'); return }
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(w))
    cv.height = Math.max(1, Math.round(h))
    const ctx = cv.getContext('2d')
    if (ctx === null) { setErr('这个环境不支持画布取像素（拿不到 2d 上下文）'); return }
    /* 先铺黑。 */
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, cv.width, cv.height)
    /* 再按笔画铺白（橡皮用 'destination-out' 擦回黑）。 */
    for (const s of strokes) {
      const cmd = brushCommands(s)
      const r = cmd.radius * Math.min(cv.width, cv.height)
      ctx.globalCompositeOperation = s.erase === true ? 'destination-out' : 'source-over'
      ctx.strokeStyle = '#ffffff'
      ctx.fillStyle = '#ffffff'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = r * 2
      ctx.beginPath()
      cmd.ops.forEach((op, i) => {
        const x = op.x * cv.width
        const y = op.y * cv.height
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      cmd.ops.forEach((op) => {
        ctx.beginPath()
        ctx.arc(op.x * cv.width, op.y * cv.height, r, 0, Math.PI * 2)
        ctx.fill()
      })
    }
    ctx.globalCompositeOperation = 'source-over'
    const url = cv.toDataURL('image/png')
    const base64 = url.includes(',') ? url.slice(url.indexOf(',') + 1) : ''
    if (base64 === '') { setErr('遮罩导出失败（画布没给出数据）'); return }
    setErr('')
    props.onExport({ mime: 'image/png', base64 })
  }

  return (
    <div className={css.imageOpPanel} data-ewb-mask-panel="" onPointerDown={e => { e.stopPropagation() }}>
      <div className={css.nodePanelHead}>
        <span className={css.nodePanelTitle}>局部重绘</span>
        <span className="flex-1" />
        <button type="button" data-ewb-mask-close="" className={css.nodePanelBtn} onClick={props.onClose}>收起</button>
      </div>

      <div className={css.nodePanelRow}>
        <span className={css.nodePanelKey}>笔刷</span>
        <input
          type="range"
          data-ewb-mask-brush=""
          className="nodrag"
          min={BRUSH_MIN}
          max={BRUSH_MAX}
          step={1}
          value={brushPx}
          onChange={(e) => { setBrushPx(Number(e.target.value)) }}
        />
        <span className={css.nodePanelUnit} data-ewb-mask-brush-px="">{String(brushPx)} px</span>
      </div>

      <div className={css.nodePanelRow}>
        <span className={css.nodePanelKey}>工具</span>
        <div className={css.imageOpRatios}>
          <button
            type="button" data-ewb-mask-eraser="" className={css.imageOpChip}
            data-active={erase ? '' : undefined}
            onClick={() => { setErase(v => !v) }}
          >橡皮</button>
          <button
            type="button" data-ewb-mask-undo="" className={css.imageOpChip}
            onClick={() => { setStrokes(v => v.slice(0, -1)); setErr('') }}
          >撤销一笔</button>
          <button
            type="button" data-ewb-mask-clear="" className={css.imageOpChip}
            onClick={() => { setStrokes([]); setErr('') }}
          >清空</button>
        </div>
      </div>

      {/* 底图 + 涂抹层。底图是 `<img>`，涂抹层是盖在上面的 `<canvas>`。 */}
      <div
        className={css.maskWrap}
        ref={wrapRef}
        data-ewb-mask-wrap=""
        onPointerDown={(e) => {
          e.stopPropagation()
          setDrawing({ points: [pointOf(e)], radius: brushNorm, erase })
        }}
        onPointerMove={(e) => {
          if (drawing === null) return
          setDrawing({ ...drawing, points: [...drawing.points, pointOf(e)] })
        }}
        onPointerUp={() => {
          if (drawing === null) return
          setStrokes(v => [...v, drawing])
          /* 统计一下这一笔画了多大（诊断用；判据看 `maskHasContent`）。 */
          const a = strokeArea(drawing)
          if (a.covered > 0) setErr('')
          setDrawing(null)
        }}
      >
        <img
          ref={baseRef}
          className={css.maskBase}
          data-ewb-mask-base=""
          src={props.src}
          alt=""
          draggable={false}
          onLoad={() => { redraw() }}
        />
        <canvas ref={canvasRef} className={css.maskCanvas} data-ewb-mask-canvas="" width={w} height={h} />
      </div>

      {/* ⚠️ 判据 2：没涂就说清，不许静默让用户点了没反应，也不许提交。 */}
      <div className={css.nodePanelRow}>
        <span className={css.nodePanelHint} data-ewb-mask-hint="">
          {err !== ''
            ? err
            : touched
              ? '遮罩已经涂好，可以提交局部重绘'
              : '在图上涂出要重绘的区域（白色 = 重绘，黑色 = 保留）'}
        </span>
      </div>
      <div className={css.nodePanelRow}>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-mask-ok=""
          className={css.nodePanelBtn}
          /* 没涂就禁用 —— 这是「拦住」的第一道；第二道在 `doExport` 里
           * 再判一次（按钮被别的方式触发时也要挡住）。 */
          disabled={!touched}
          onClick={doExport}
        >用这块遮罩重绘</button>
      </div>
    </div>
  )
}

/** `MaskOpMount` 的入参。 */
export interface MaskOpMountProps {
  /** 要给哪个节点涂（空串 = 面板关着）。 */
  nodeId: string
  /** 画布上的节点（React Flow 形状，只为读 `data.artifact`）。 */
  nodes: readonly { id: string, data: { artifact?: string } }[]
  /** 涂好了，交出遮罩。 */
  onDone: (mask: { mime: string, base64: string }) => void
  /** 收起。 */
  onClose: () => void
}

/**
 * 把「节点 → 底图地址 / 尺寸 → 蒙版面板」这一段接起来。
 *
 * ## 为什么要单独一个组件
 *
 * 底图的**像素宽高**得等 `<img>` 加载完才知道（`naturalWidth`），
 * 而那个值决定笔刷半径的换算（`normalizeBrush` 按较小边算）。
 * 把这件「等加载」的事关在这里，画布那边就只管「开 / 关 + 收到遮罩」。
 *
 * @param props - 见 `MaskOpMountProps`。
 * @returns 面板；`nodeId` 为空时不渲染。
 */
export function MaskOpMount({ nodeId, nodes, onDone, onClose }: MaskOpMountProps): React.JSX.Element | null {
  const [size, setSize] = useState<{ width: number, height: number } | null>(null)
  const node = nodes.find(n => n.id === nodeId)
  const artifact = (node?.data.artifact ?? '').trim()

  /* 换节点时把上一张的尺寸清掉 —— 否则新图会用旧图的尺寸算笔刷。 */
  useEffect(() => { setSize(null) }, [nodeId])

  if (nodeId === '' || artifact === '') return null
  const src = '/api/ecom-workbench/artifact/' + encodeURIComponent(artifact)
  return (
    <>
      {/* 隐藏的探针图：只为拿 naturalWidth / naturalHeight。 */}
      {size === null
        ? (
          <img
            src={src}
            alt=""
            style={{ display: 'none' }}
            data-ewb-mask-probe=""
            onLoad={(e) => {
              const el = e.currentTarget
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setSize({ width: el.naturalWidth, height: el.naturalHeight })
              }
            }}
          />
        )
        : null}
      <MaskPanel
        artifact={artifact}
        src={src}
        image={size ?? undefined}
        onExport={onDone}
        onClose={onClose}
      />
    </>
  )
}
