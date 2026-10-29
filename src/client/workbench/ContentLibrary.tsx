/** 内容库：**产物库 + 素材库两段**（计划 §三 Step 4，契约 BB）。
 *
 * ## 为什么两段挤在一格（不是两个 tab）
 *
 * 计划 §三 Step 7 那条⚠️：「七个格子会挤」—— 所以「内容库」内部用两段，
 * 不占两个 tab。这里就是那个决定落地的地方：两段竖着排，一起滚。
 *
 * ## 两个池子的分工（计划 §三 4.3，别混）
 *
 * | | 产物库 | 素材库 |
 * |---|---|---|
 * | 来源 | 我们生成的 | 外面来的（上传 / 采集） |
 * | 有生成记录 | 有（提示词、模型、参数） | 没有 |
 * | 数据形态 | 一条记录 + 一个文件（**记录是主**） | **目录是主**，放进去就算有 |
 * | 删除 | 删记录同时删文件（真删） | 删文件即消失 |
 *
 * 所以这两个列表**从两条不同的路由读**、**删除语义也不同** —— 它们长得像，
 * 但底下不是一回事。合并成一个「文件列表」会很省事，代价是丢了「这条是谁生成的」。
 *
 * ## 引用计数为什么是「调一次接口」而不是「界面上算」
 *
 * 计划 §三 4.1 明确**不建索引文件**：每次现扫 `canvases/*.json` 数引用。
 * 那一层在宿主（`src/schedule/artifact-usage.ts`），界面只拿结果。
 * 界面自己扫不了画布 —— 它没有磁盘。
 *
 * ## 传素材为什么先拦 6 MB
 *
 * 上传走 base64 + JSON（`src/schedule/materials.ts` 文件头写了这个取舍），
 * 而宿主读请求体的上限是 8 MB（`src/index.ts:808`），base64 会涨约 1/3。
 * 不拦的话用户会看到一个**看不懂的解码错**；拦下来能说清「这个文件太大了」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from './board-kit.ts'
import { when } from './board-kit.ts'
/* 上传的把关与编码在 `upload-file.ts`（契约 CG）：那边不依赖 DOM，能真跑断言。
 * `checkUpload` 这个名字在本文件里保留（既有调用方与测试都在用），
 * 但它只是转发 —— 判据只有一份。 */
import { prepareUpload, base64FromDataUrl, MAX_UPLOAD_BYTES, humanBytes } from './upload-file.ts'
/* ★ 票 39（2026-10-29）：三组的判据**只认这一份** —— 与画布左栏共用，
 * 不在这里重写。左栏是 `CanvasSidePanel.tsx:383` 那一处，这里是第二处。
 *
 * ⚠️ 为什么从 `CanvasSidePanel.tsx` import 而不是把这三个函数挪到中立文件：
 * 「哪一条素材属于哪一类」是**一个**判据，挪家会动到界面那张票正在改的文件
 * （`CanvasSidePanel.tsx` 归「工作台·界面」），两边同时动同一个文件必撞。
 * 从那边 import 过来，判据仍然只有一份，而且谁都不用抢文件。 */
import { ASSET_GROUPS, materialKindOf, materialSummaryOf } from './CanvasSidePanel.tsx'

/* ── 接口返回的形状（照契约 BB §二 那张表，别自己猜字段名）─────────────── */

/** 一条产物（`GET /artifacts` 的 `items[]`）。 */
export interface ArtifactItem {
  id: string
  ext: string
  mime: string
  bytes: number
  createdAt: number
  width?: number
  height?: number
  source?: string
  params?: Record<string, unknown>
  /** 宿主直接给的显示地址。 */
  url: string
}

/** 一处引用（`GET /artifacts/usage` 的 `usage[id][]`）。 */
export interface ArtifactRef {
  canvasId: string
  canvasTitle: string
  nodeId: string
}

/** 一条素材（`GET /materials` 的 `materials[]`）。 */
export interface MaterialItem {
  name: string
  bytes: number
  mtime: number
  url: string
  /**
   * 类型（`image` / `video` / `text`）。
   *
   * ★ 票 45 补上：后端从票 34 起就在回这个键（`src/schedule/materials.ts` 的
   * `Material.kind`），界面这一侧的接口声明一直没跟上。搜索要覆盖文本素材的标题，
   * 就得先知道哪条是文本素材。
   */
  kind?: 'image' | 'video' | 'text'
  /** 文本素材的标题（只有 `kind === 'text'` 才有；后端 `listMaterials` 给的）。 */
  title?: string
  /** 文本素材的正文（只有 `kind === 'text'` 才有）。 */
  content?: string
}

/**
 * 一条素材是否命中搜索词。
 *
 * ## 搜哪些字段（票 45 定的）
 *
 * **文件名 + 文本素材的标题**。
 *
 * 为什么不搜文本素材的正文：正文可能几千字，一搜「好的」会命中一大片，
 * 而用户找素材时想的是「那份写文案的素材叫什么」——`title` 才是他起的名字。
 * 也不搜超时的字节数与时间：那不是用来找东西的。
 *
 * ## 为什么文件名要搜（不只是标题）
 *
 * 图片与视频素材**没有** `title`（`title` 只对文本素材有）。不搜文件名的话，
 * 图片与视频就完全搜不到 —— 而素材库里绝大多数是它们。
 *
 * @param m - 一条素材。
 * @param needle - 搜索词（**原样传入即可**，内部会 trim 并转小写）。
 * @returns 命中给 true。
 */
export function matchesMaterial(m: MaterialItem, needle: string): boolean {
  const n = needle.trim().toLowerCase()
  if (n === '') return true
  const hay = (m.name + '\n' + (m.title ?? '')).toLowerCase()
  return hay.includes(n)
}

/**
 * 按搜索词筛素材。
 *
 * @param mats - 候选素材。
 * @param q - 搜索词（原样传入，内部 trim + 小写）。
 * @returns 筛出来的素材（空词时原样返回）。
 */
export function filterMaterials(mats: readonly MaterialItem[], q: string): MaterialItem[] {
  const needle = q.trim().toLowerCase()
  if (needle === '') return [...mats]
  return mats.filter(m => matchesMaterial(m, needle))
}

/**
 * 一条素材在列表上**显示什么**（票 51，2026-10-28）。
 *
 * ## 为什么要这个纯函数
 *
 * 文本素材存了两个名字：**文件名**（`文案.text.json`）与**用户起的标题**
 * （`小红书开箱文案`）。界面上一直只画文件名，于是用户起的标题从来没露过面 ——
 * 而票 45 的搜索**已经能按标题命中**了，命中之后列表里看不见那个词，用户只会困惑
 * 「为什么这条被搜出来了」。
 *
 * ## 只改文本素材，其余一个字不动
 *
 * 判据是 `kind === 'text'` **且** 标题非空：
 *
 * | 情况 | 显示 |
 * |---|---|
 * | 文本素材 + 有标题 | 标题 |
 * | 文本素材 + 标题为空/只有空格 | 文件名（没标题就别编一个） |
 * | 图片 / 视频 | 文件名 |
 * | `kind` 缺失（老宿主半） | 文件名 |
 *
 * ⚠️ **不许为了「统一」把图片也改成别的样子**。图片与视频没有标题这个字段，
 * 给它们编一个（比如用产物的提示词）会让「这条到底是什么」变得不可信 ——
 * 而素材库的用途正是「认出这个文件是哪个」。这条有两个断言钉着。
 *
 * ## 长标题怎么办
 *
 * 卡片里那行本来就是 `truncate`（一行、超出省略号），所以长标题不会撑破卡片；
 * 全名放 `title` 属性，鼠标悬停能看全。**不做字数截断** —— 截断成「小红书开箱…」
 * 之后悬停看到的是同一个被截的串，等于没给全。
 *
 * @param m - 一条素材。
 * @returns `label` 是主文字，`title` 是悬停提示（总是给全名）。
 */
export function materialLabel(m: MaterialItem): { label: string, title: string } {
  /* ★ 2026-10-29（票 39）：「这一条是不是文本素材」改用**与左栏同一个判据**
   * `materialKindOf`（`CanvasSidePanel.tsx:122`）。原来这里自己写
   * `m.kind === 'text'` —— 两份判据迟早漂，而且**已经漂了**：
   * `kind` 缺席的老目录里，左栏按扩展名认出这是文本素材，原来的这里认不出。
   * 改成共用之后两边判得一样了（实测：`kind` 缺席 + 名字 `.text.json` /
   * `.json` 两种都判成 `text`）。
   *
   * ## 剩下的差别只有一处：标题为空时显示什么（**这是有意的，不是漂移**）
   *
   * | 情况 | 左栏 `materialLabelOf` | 内容库（本函数） |
   * |---|---|---|
   * | 文本素材 + 有标题 | 标题 | 标题 |
   * | 文本素材 + 标题为空/只有空格/没有该字段 | **「（没有标题）」** | **文件名** |
   * | 图片 / 视频 | 文件名 | 文件名 |
   * | 文本素材 + 标题前后有空格 | 去掉空格后的标题 | 去掉空格后的标题 |
   *
   * 只有一行不同，其余**逐字相同**（逐输入实测过）。理由是两处的用途不同：
   *
   *   · 左栏是**挑一条往画布上放**的地方 —— 「（没有标题）」明确告诉你这条
   *     没起名字，你会换个方式认它（看正文摘要，左栏也画了）；
   *   · 内容库是**管理磁盘文件**的地方 —— 「删除」按钮就在旁边，删的正是那个
   *     文件名。显示「（没有标题）」会让你不知道要删的是哪个文件。
   *
   * 这一处差别是票 51 的断言钉死的
   * （`★★ 文本素材但没有标题 → 退回文件名（不显示空串）`），不是随手写的。
   *
   * ## 另一处差别：返回形状（本函数多给一个 `title`）
   *
   * 内容库的卡片能悬停，左栏那个按钮不能 —— 所以这里返回
   * `{ label, title }`，`title` 给「标题（文件名）」两样都带。
   * 两者都要：用户既可能按标题找，也可能要去目录里找那个文件。
   * 左栏没有这个需要，不该为了「统一」让它多背一个不用的字段。 */
  if (materialKindOf(m) !== 'text') return { label: m.name, title: m.name }
  const clean = (m.title ?? '').trim()
  if (clean !== '') return { label: clean, title: clean + '（' + m.name + '）' }
  return { label: m.name, title: m.name }
}

/** 上传体积上限与字节格式化：**定义在 `upload-file.ts`**（契约 CG）。
 * 这里转发出去，保持既有引用（`tests/content-library.mjs`）不破。 */
export { MAX_UPLOAD_BYTES, humanBytes }

/**
 * 上传前的把关。**实现已挪到 `upload-file.ts` 的 `prepareUpload`**（契约 CG）。
 *
 * 这一层保留是为了不破既有调用方（`tests/content-library.mjs` 与组件本身），
 * 它只做形状转换：`(name, size)` → `prepareUpload({name, size, base64:'x'})`。
 * 真正的判据只有一份，在 `upload-file.ts` —— 两处各写一遍必然漂。
 *
 * @param name - 文件名。
 * @param size - 字节数。
 * @returns `ok: true` 表示通过；不通过带 `why`。
 */
export function checkUpload(name: string, size: number): { ok: boolean, why?: string } {
  /* 传一段「形状合法的 base64」占位：这个包装只关心名字 / 类型 / 大小三关，
   * base64 那一关由真正的上传路径（`prepareUpload`）在读到内容后再查。 */
  const r = prepareUpload({ name, size, base64: 'AAAA' })
  /* ⚠️ 用 `in` 判分支，不用 `r.ok` 判别式：本项目 `strict: false`，
   * 关掉 `strictNullChecks` 之后可判别联合**不会收窄**（同一处坑在
   * `channels.ts` 与 `generate.ts` 都踩过）。 */
  return 'why' in r ? { ok: false, why: r.why } : { ok: true }
}

/**
 * 中文数量（「引用 2」里的 2 不带单位后缀，这里只保证是整数串）。
 * @param n - 数量。
 * @returns 字符串。
 */
function countText(n: number): string {
  return String(Number.isFinite(n) ? n : 0)
}

/** 内容库的入参。 */
export interface ContentLibraryProps {
  /** 这一格是不是正显示着（隐藏时不去拉数据）。 */
  active: boolean
}

/**
 * 内容库（产物库 + 素材库两段）。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function ContentLibrary({ active }: ContentLibraryProps): React.JSX.Element {
  /* ── 产物库 ── */
  const [arts, setArts] = useState<ArtifactItem[]>([])
  const [usage, setUsage] = useState<Record<string, ArtifactRef[]>>({})
  const [artErr, setArtErr] = useState('')
  const [artLoading, setArtLoading] = useState(true)
  /** 展开了引用明细的产物 id（空串 = 都没展开）。 */
  const [expanded, setExpanded] = useState('')
  /**
   * 磁盘上真实的产物条数（票 52，2026-10-28）。
   *
   * `arts` 只是**前 200 条**（`listArtifacts` 默认上限），拿它当总数是假的。
   * 这个数由宿主半单独给（`total`，它只数文件、不解析内容）。
   *
   * `0` 表示「没拿到」—— 显示时退回 `arts.length`（见下面那格注释）。
   */
  const [artTotal, setArtTotal] = useState(0)

  /* ── 素材库 ── */
  const [mats, setMats] = useState<MaterialItem[]>([])
  const [matErr, setMatErr] = useState('')
  const [matLoading, setMatLoading] = useState(true)
  const [uploadErr, setUploadErr] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  /**
   * 素材库的搜索词（票 45，2026-10-28）。
   *
   * 用户原话：「给这三个都增加搜索功能，他们都是可能会很多的东西需要搜索功能」。
   * 范围见 `matchesMaterial`：文件名 + 文本素材的标题。
   */
  const [matQ, setMatQ] = useState('')

  /** 按搜索词筛过的素材。 */
  const shownMats = filterMaterials(mats, matQ)

  /** 重读产物 + 引用计数。 */
  const loadArts = useCallback(async (): Promise<void> => {
    setArtLoading(true)
    const r = await call<{ items?: ArtifactItem[], total?: number }>('/artifacts')
    if (!r.ok) { setArtLoading(false); setArtErr(r.error ?? '读不到产物清单'); return }
    setArtErr('')
    setArts(Array.isArray(r.body?.items) ? r.body.items : [])
    /* ★ 票 52：真实总数。老宿主半回的是 `items.length`（假），拿不到时置 0
     * 让显示退回 `arts.length` —— 那种情况下显示什么都不会比原来更假。 */
    setArtTotal(typeof r.body?.total === 'number' && r.body.total >= 0 ? r.body.total : 0)
    /* 引用计数单独一次：它要扫全部画布，与清单是两件事，不该被清单失败拖累。 */
    const u = await call<{ usage?: Record<string, ArtifactRef[]> }>('/artifacts/usage')
    setUsage(u.ok && u.body?.usage !== undefined ? u.body.usage : {})
    setArtLoading(false)
  }, [])

  /** 重读素材目录。 */
  const loadMats = useCallback(async (): Promise<void> => {
    setMatLoading(true)
    const r = await call<{ materials?: MaterialItem[] }>('/materials')
    setMatLoading(false)
    if (!r.ok) { setMatErr(r.error ?? '读不到素材目录'); return }
    setMatErr('')
    setMats(Array.isArray(r.body?.materials) ? r.body.materials : [])
  }, [])

  useEffect(() => {
    if (!active) return
    void loadArts()
    void loadMats()
  }, [active, loadArts, loadMats])

  /**
   * 删一条产物。
   *
   * ## 被引用时**必须**先说清后果
   *
   * 计划 §三 4.1：「删除时弹提醒，告诉用户『这张图被 N 个画布引用，
   * 删了那 N 处会显示图已删除』，确认才删」。所以这里先读一遍最新的引用表
   * （不用 state 里那份：它可能是几分钟前拉的，用户可能刚在画布上加了引用）。
   *
   * @param it - 要删的产物。
   */
  const delArtifact = async (it: ArtifactItem): Promise<void> => {
    const u = await call<{ usage?: Record<string, ArtifactRef[]> }>('/artifacts/usage')
    const refs = u.ok ? (u.body?.usage?.[it.id] ?? []) : []
    if (refs.length > 0) {
      const where = refs.map(r => '「' + r.canvasTitle + '」的节点 ' + r.nodeId).join('、')
      const yes = window.confirm(
        '这个产物被 ' + countText(refs.length) + ' 个画布引用（' + where + '）。\n'
        + '删除之后那 ' + countText(refs.length) + ' 处会显示「图已删除」，文件本身也会从磁盘删掉，无法恢复。\n'
        + '确定删除？',
      )
      if (!yes) return
    }
    const r = await call<unknown>('/artifact/' + encodeURIComponent(it.id), { method: 'DELETE' })
    if (!r.ok) { setArtErr(r.error ?? '删除失败'); return }
    setArtErr('')
    await loadArts()
  }

  /**
   * 删一条素材（直接删文件，素材库没有记录层）。
   * @param m - 素材。
   */
  const delMaterial = async (m: MaterialItem): Promise<void> => {
    /* ★ 票 51：有标题的用标题问（用户当初给它起的名字），
     * 没有标题才退回文件名 —— 问的是「要删哪个」，而用户认的是标题。 */
    const shown = materialLabel(m)
    const yes = window.confirm('删除素材「' + shown.label + '」？文件会从磁盘删掉。')
    if (!yes) return
    /* ⚠️ 删除请求仍然按**文件名**发 —— 标题不是键，文件名才是
     * （`DELETE /materials/<name>` 收的是目录里的真实文件名）。 */
    const r = await call<unknown>('/materials/' + encodeURIComponent(m.name), { method: 'DELETE' })
    if (!r.ok) { setMatErr(r.error ?? '删除失败'); return }
    setMatErr('')
    await loadMats()
  }

  /**
   * 上传一个文件（读成 base64 → POST）。
   *
   * ## 为什么不用 FormData
   *
   * 宿主那侧的请求体读取只有一条 `readJsonBody`（上限 8 MB），没有 multipart 解析。
   * 所以走 base64 + JSON —— 与 `POST /artifact` 完全同构。
   * 代价（>6 MB 传不了）在 `checkUpload` 里说清。
   *
   * @param file - 浏览器给的 File。
   */
  const uploadOne = async (file: File): Promise<void> => {
    /* 先读成 base64，再交给纯函数把关。
     * ⚠️ 顺序与原来不同：原来是先 `checkUpload` 再读。现在读在前 —— 因为
     * `prepareUpload` 要一起看「名字 / 类型 / 大小 / base64 内容」四件事，
     * 内容要到读完才有。多读一次大文件的代价可以接受（上限 6 MB，且它本来就要读）。 */
    let base64 = ''
    try {
      base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(base64FromDataUrl(
          typeof reader.result === 'string' ? reader.result : '',
        ))
        reader.onerror = () => { reject(new Error('文件读不出来')) }
        reader.readAsDataURL(file)
      })
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e))
      return
    }

    /* 四关一起过（名字 / 类型 / 大小 / base64）——见 `upload-file.ts` 的 `prepareUpload`。 */
    const gate = prepareUpload({ name: file.name, size: file.size, type: file.type, base64 })
    if ('why' in gate) { setUploadErr(gate.why); return }
    setUploadErr('')

    const r = await call<unknown>('/materials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(gate.upload),
    })
    if (!r.ok) { setUploadErr(r.error ?? '上传失败'); return }
    await loadMats()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-ewb-content-library="">
      {/* ══ 第一段：产物库 ══ */}
      <div className="flex flex-none items-center gap-3 pb-2" data-ewb-art-section="">
        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">产物库</span>
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-art-total="">
          {/* ★ 票 52（2026-10-28）：原来这里显示的是 `arts.length` ——
           * 那是**截断后**的条数（`listArtifacts` 默认只读 200 条）。
           * 超过 200 时用户看到「共 200 条」，而磁盘上可能有一千张，
           * 他拿这个数判断要不要清理，会以为已经干净了。
           *
           * 现在用宿主半给的 `total`（磁盘上的真实条数）。
           * 拿不到时退回 `arts.length` —— 老宿主半不回首这个数的正确值，
           * 那时候**显示什么都不会比原来的更假**。 */}
          共 {countText(artTotal === 0 ? arts.length : artTotal)} 条
        </span>
        {/* ★ 超过上限要说出来（票 52，不许静默截断）。
         *
         * 单独一格、与总数分开：总数是「一共有多少」，这一格是「你看到的不是全部」。
         * 合成一句会让「300 条」这个数读起来像「已有 300 条，都在下面」。 */}
        {arts.length > 0 && artTotal > arts.length
          ? (
            <span
              data-ewb-art-truncated=""
              className="flex-none font-mono text-ewb-caption text-[var(--dsw-alias-state-warn-primary)]"
              title="产物库一次最多列 200 条（按生成时间新的在前）。总数是磁盘上的真实条数，删掉旧的之后后面的会补上。"
            >
              显示前 {countText(arts.length)} 条
            </span>
          )
          : null}
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-art-refresh=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { void loadArts() }}
        >刷新</button>
      </div>

      {artErr === ''
        ? null
        : (
          <div data-ewb-art-error="" className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">{artErr}</span>
          </div>
        )}

      {artLoading && arts.length === 0
        ? <div className="px-1 py-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>
        : null}
      {!artLoading && arts.length === 0 && artErr === ''
        ? (
          <div data-ewb-art-empty="" className="mb-3 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-5">
            <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">产物库是空的</span>
            <span className="mt-1 block font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
              生成出来的图片与视频会出现在这里。生成链路还没接通，所以现在只有手工放进产物目录的才会列出。
            </span>
          </div>
        )
        : null}

      <div className="grid gap-2 pb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }} data-ewb-art-grid="">
        {arts.map(it => {
          const refs = usage[it.id] ?? []
          const open = expanded === it.id
          const isVideo = (it.mime ?? '').startsWith('video/')
          return (
            <div
              key={it.id}
              data-ewb-artifact={it.id}
              className="flex min-w-0 flex-col gap-1 rounded-card border border-[var(--dsw-alias-border-l2)] p-1.5"
            >
              <div className="relative overflow-hidden rounded-ctl bg-[var(--dsw-alias-bg-layer-1)]" style={{ aspectRatio: '1 / 1' }}>
                {isVideo
                  ? <video data-ewb-artifact-video="" src={it.url} className="h-full w-full object-contain" preload="metadata" controls />
                  : <img data-ewb-artifact-img="" src={it.url} alt="" className="h-full w-full object-contain" />}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]" data-ewb-artifact-dims="">
                  {it.width !== undefined && it.height !== undefined ? String(it.width) + '×' + String(it.height) : it.ext}
                </span>
                {/* ★ 引用计数：**常驻显示**（不是只在悬浮时）。
                    「悬浮才显示」在真机上够用，但它让「这张图被几个画布用着」
                    变成要靠运气才能看到的信息 —— 而删之前最该知道的就是它。 */}
                <button
                  type="button"
                  data-ewb-artifact-usage={it.id}
                  data-count={String(refs.length)}
                  className={[
                    'shrink-0 rounded-ctl border px-1.5 py-0.5 font-mono text-ewb-caption',
                    refs.length > 0
                      ? 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-primary)]'
                      : 'border-transparent text-[var(--dsw-alias-label-tertiary)]',
                  ].join(' ')}
                  title={refs.length > 0 ? '被引用了，点开看是哪里' : '没有被任何画布引用'}
                  onClick={() => { setExpanded(open ? '' : it.id) }}
                >引用 {countText(refs.length)}</button>
              </div>
              <div className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                <span data-ewb-artifact-bytes="">{humanBytes(it.bytes)}</span>
                <span className="flex-1" />
                <span data-ewb-artifact-time="">{when(it.createdAt)}</span>
              </div>
              {/* 引用明细：点「引用 N」展开。列到「哪个画布 + 哪个节点」。 */}
              {open && refs.length > 0
                ? (
                  <div data-ewb-artifact-refs={it.id} className="flex flex-col gap-0.5 rounded-ctl border border-dashed border-[var(--dsw-alias-border-l2)] px-1.5 py-1">
                    {refs.map(r => (
                      <span
                        key={r.canvasId + '/' + r.nodeId}
                        data-ewb-artifact-ref={r.canvasId + '/' + r.nodeId}
                        className="truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                      >「{r.canvasTitle}」· 节点 {r.nodeId}</span>
                    ))}
                  </div>
                )
                : null}
              <button
                type="button"
                data-ewb-artifact-del={it.id}
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { void delArtifact(it) }}
              >删除</button>
            </div>
          )
        })}
      </div>

      {/* ══ 第二段：素材库 ══ */}
      <div className="flex flex-none items-center gap-3 border-t border-[var(--dsw-alias-border-l2)] pb-2 pt-3" data-ewb-mat-section="">
        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">素材库</span>
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-mat-total="">
          共 {countText(mats.length)} 个文件
        </span>
        <span className="flex-1" />
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-mat-limit="">
          上传上限 {humanBytes(MAX_UPLOAD_BYTES)}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          data-ewb-mat-file=""
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f !== undefined) void uploadOne(f)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          data-ewb-mat-upload=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { fileRef.current?.click() }}
        >上传</button>
        <button
          type="button"
          data-ewb-mat-refresh=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { void loadMats() }}
        >刷新</button>
      </div>

      {/* ★ 素材库搜索（票 45，2026-10-28）。
       *
       * 只在**有素材时**才显示 —— 一份都没有时搜索框没有意义。
       * 与产物库不同：产物库这一票不加搜索（用户点名的三处是工作流管理、
       * 素材库、画布库），所以这里只有素材库这一段有框。 */}
      {mats.length > 0
        ? (
          <div data-ewb-mat-search-bar="" className="mb-2 flex flex-none flex-wrap items-center gap-1.5">
            <input
              data-ewb-mat-search=""
              className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              value={matQ}
              placeholder="搜文件名与标题"
              onChange={(e) => { setMatQ(e.target.value) }}
            />
            <span data-ewb-mat-hit-count="" className="flex-none font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              {String(shownMats.length)} 个
            </span>
            {matQ.trim() === ''
              ? null
              : (
                <button
                  type="button"
                  data-ewb-mat-clear=""
                  className="pressable is-dark flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                  onClick={() => { setMatQ('') }}
                >清空搜索</button>
              )}
          </div>
        )
        : null}

      {/* 上传被拦下的原因（>6 MB / 类型不对）—— 必须说清楚，不许静默。 */}
      {uploadErr === ''
        ? null
        : (
          <div data-ewb-mat-upload-error="" className="mb-2 flex items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">{uploadErr}</span>
          </div>
        )}

      {matErr === ''
        ? null
        : (
          <div data-ewb-mat-error="" className="mb-2 flex items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">{matErr}</span>
          </div>
        )}

      {matLoading && mats.length === 0
        ? <div className="px-1 py-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>
        : null}
      {!matLoading && mats.length === 0 && matErr === ''
        ? (
          <div data-ewb-mat-empty="" className="mb-4 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-5">
            <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">素材目录是空的</span>
            <span className="mt-1 block font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
              素材库读的是一个目录：放进去就有。也可以点上面的「上传」。
              目录被手工清空时素材会立刻全消失，没有回收站。
            </span>
          </div>
        )
        : null}

      {/* ★ 「没搜到」单独一句（票 45，2026-10-28）。
       *
       * 与上面那句「素材目录是空的」**不能共用** —— 两种下一步完全不同：
       * 空的要上传或放文件进去，搜不到要换个词。
       * 共用一句会让用户去上传一份本来就有的素材。 */}
      {!matLoading && mats.length > 0 && shownMats.length === 0 && matErr === ''
        ? (
          <div data-ewb-mat-no-hit="" className="mb-4 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-5">
            <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">没有匹配的素材</span>
            <span className="mt-1 block font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
              共 {countText(mats.length)} 个文件，文件名与标题里都没有「{matQ.trim()}」。换个词，或者清空搜索。
            </span>
          </div>
        )
        : null}

      {/* ★★ 票 39（2026-10-29）：素材按 kind **分三组**，不再平铺成一张混在一起的网格。
       *
       * ## 为什么必须分组
       *
       * 文本素材混在图片网格里长这样：一张 `<img>` 加载失败的空框（它的 `url`
       * 指向 `<name>.text.json`，浏览器画不出来）+ 一个 `text-1750000000.text.json`
       * 文件名。用户既看不出它是什么，也认不出是哪一条。
       *
       * ## 判据只认一份
       *
       * 顺序与标题来自 `ASSET_GROUPS`、归类来自 `materialKindOf` ——
       * 两者都 **import 自 `CanvasSidePanel.tsx`**（与画布左栏同一份），
       * 这里**不重写**。两处各写一份必然分叉（票面判据 4 点名的就是这件事）。
       *
       * ## 空组不画
       *
       * 与左栏同一做法：三个标题下面挂着「（0）」比只画有内容的那组更乱。
       * 三组都空是另一回事 —— 那由上面「素材目录是空的」那句管。
       *
       * ## 搜索与分组同时生效
       *
       * `shownMats` 已经过搜索筛，这里在它的结果上再按 kind 分。
       * 所以「搜一个词」不会把分组拆掉：命中什么就落在它自己那一组里。 */}
      {ASSET_GROUPS.map(g => {
        const items = shownMats.filter(m => materialKindOf(m) === g.kind)
        if (items.length === 0) return null
        return (
          <div key={g.kind} data-ewb-mat-group={g.kind}>
            <div
              data-ewb-mat-group-head={g.kind}
              className="flex flex-none items-center gap-2 pb-1.5 pt-1 font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]"
            >
              <span>{g.label}</span>
              <span data-ewb-mat-group-count={g.kind} className="text-[var(--dsw-alias-label-secondary)]">{String(items.length)}</span>
              <span className="h-px flex-1 bg-[var(--dsw-alias-border-l2)]" />
            </div>
            <div className="grid gap-2 pb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))' }} data-ewb-mat-grid={g.kind}>
              {items.map(m => {
                /* ★ 票 39：不再自己正则判视频 —— 归类统一走 `materialKindOf`。
                 * 这一条同时修掉了「文本素材被当成图片画成破图」。 */
                const kind = materialKindOf(m)
                const shown = materialLabel(m)
                /* 文本素材的正文摘要（与左栏同一份函数）。 */
                const summary = materialSummaryOf(m)
                return (
                  <div
                    key={m.name}
                    data-ewb-material={m.name}
                    data-ewb-material-kind={kind}
                    className="flex min-w-0 flex-col gap-1 rounded-card border border-[var(--dsw-alias-border-l2)] p-1.5"
                  >
                    {/* ★★ 文本素材**不画媒体占位**。
                     *
                     * 它的 `url` 指向 `<name>.text.json`（`src/schedule/materials.ts:319`），
                     * 拿它当 `<img src>` 就是一张破图 —— 票 39 之前这里正是这么画的。
                     * 改画「标题 + 正文摘要」，与左栏同一形态：两行都读得出来，
                     * 而且看得出这是一段**文字**而不是一张加载失败的图。 */}
                    {kind === 'text'
                      ? (
                        <div
                          data-ewb-material-text={m.name}
                          className="flex min-h-0 flex-col gap-1 overflow-hidden rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] p-2"
                          style={{ aspectRatio: '1 / 1' }}
                        >
                          <span
                            data-ewb-material-text-title={m.name}
                            className="min-w-0 truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]"
                          >{shown.label}</span>
                          <span
                            data-ewb-material-text-body={m.name}
                            className="min-h-0 flex-1 overflow-hidden font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]"
                          >{summary === '' ? '（没有正文）' : summary}</span>
                        </div>
                      )
                      : (
                        <div className="overflow-hidden rounded-ctl bg-[var(--dsw-alias-bg-layer-1)]" style={{ aspectRatio: '1 / 1' }}>
                          {kind === 'video'
                            ? <video data-ewb-material-video="" src={m.url} className="h-full w-full object-contain" preload="metadata" controls />
                            : <img data-ewb-material-img="" src={m.url} alt="" className="h-full w-full object-contain" />}
                        </div>
                      )}
                    {/* ★ 票 51：文本素材显示**标题**（用户当初给它起的名字），
                     * 图片与视频仍显示文件名 —— `materialLabel` 里那个表定了四种情况。
                     *
                     * ⚠️ `data-ewb-material-name` 给的是**主文字**（可能是标题），
                     * `data-ewb-material-file` 给的是磁盘上的真实文件名。
                     * 两个分开挂：测试要能分别断言「显示的是什么」与「发删除请求用哪个」。 */}
                    <span
                      data-ewb-material-label=""
                      data-ewb-material-name={shown.label}
                      data-ewb-material-file={m.name}
                      className="min-w-0 truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]"
                      title={shown.title}
                    >{shown.label}</span>
                    <div className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                      <span data-ewb-material-bytes="">{humanBytes(m.bytes)}</span>
                      <span className="flex-1" />
                      <span data-ewb-material-time="">{when(m.mtime)}</span>
                    </div>
                    <button
                      type="button"
                      data-ewb-material-del={m.name}
                      className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                      onClick={() => { void delMaterial(m) }}
                    >删除</button>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
