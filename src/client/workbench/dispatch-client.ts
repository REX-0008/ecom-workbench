/** 客户端 → 宿主半的派发通道。
 *
 * 走插件自己的 HTTP 前缀 `/api/ecom-workbench`（宿主半注册的），
 * 因为前端跑在浏览器里，**不能直接起进程**——真正的执行在宿主半。
 *
 * 一个约定：**不抛异常**。网络失败、401、宿主没起……全部变成 { ok: false, error }，
 * 由调用方决定怎么显示（画布上要显示成节点失败，不是让它白屏）。
 */
import type { DispatchRequest } from '../../workflow/command.ts'
/* 编号派生（纯函数、零 IO，`ids.ts` 文件头写了「宿主半与客户端半共用」）。
 * 复制工作流时要**本地先算一遍**新编号会不会与现有存档撞，
 * 撞了就换个名字再算 —— 而不是先写一次盘才发现撞了。 */
import { deriveWorkflowId } from '../../workflow/ids.ts'

/** 一次派发的结果。 */
export interface RunOutcome {
  /** 成功拿到结果（不代表节点成功）。 */
  ok: boolean
  /** 节点结局。 */
  status?: 'success' | 'failed' | 'cancelled'
  /** 输出（给下游用）。 */
  output?: unknown
  /** 日志行。 */
  logs?: string[]
  /** 失败原因。 */
  error?: string
  /** 是否超时。 */
  timedOut?: boolean
}

/** 派发接口的地址（同源，所以用相对路径）。 */
const ENDPOINT = '/api/ecom-workbench/run'

/** 节点流订阅的地址（票 28 第二步，2026-10-27）。 */
const STREAM_ENDPOINT = '/api/ecom-workbench/run-node-stream'

/**
 * 等订阅就绪的最长时间（毫秒）。
 *
 * ## 为什么要等
 *
 * 宿主半执行一个节点是**毫秒级**就开始了，`llm.stream` 的第一次回调可能早于
 * 订阅建立 —— 那几片字就丢了。症状是「有时候吐字、有时候不吐」，
 * 比完全不吐更难查。
 *
 * ## 为什么不用「无限等 `open`」
 *
 * `EventSource` 的 `open` 多数时候几十毫秒内就到，但如果那条连接卡住，
 * 无限等会把整个节点派发拖住。120 毫秒是权衡：够覆盖本机回环的握手，
 * 又不至于让「订阅根本没起来」这种情况卡住跑图。
 *
 * ⚠️ 等不到也**照样发 `/run`** —— 宁可少几片字，也不能让节点不跑。
 */
const STREAM_OPEN_WAIT_MS = 120

/**
 * 一个流式分片（与宿主半那一帧的形状逐字对应）。
 */
export interface NodeStreamChunk {
  /** 哪个节点实例吐的字。 */
  nodeId: string
  /** 这一片**新增**的字（不是累计全文）。 */
  text: string
}

/**
 * 把一个节点派发给宿主半执行。
 *
 * ## 流式分片怎么来（票 28 第二步，2026-10-27）
 *
 * 宿主半执行 agent 节点时逐片吐字，但那个回调挂在命令体的 `__onStream` 上 ——
 * 过 `JSON.stringify` 时**函数被静静丢掉**，所以画布这条路原先一个分片都收不到。
 *
 * 现在：**先开订阅、再发 `/run`**。
 *
 * ```
 * 1. 用 req.runId 开 EventSource('/run-node-stream?runId=…')
 * 2. 等它 open（最多 STREAM_OPEN_WAIT_MS，等不到也继续）
 * 3. 把同一个 id 塞进命令体的 __runId，发 POST /run
 * 4. finally 里关掉 EventSource
 * ```
 *
 * 顺序不能反：先发后订会丢前几片字（理由见 `STREAM_OPEN_WAIT_MS`）。
 *
 * ⚠️ **粒度跟着本次调用走**：`req.runId` 是引擎**每个节点各造一个**
 * （重试会再造一个），所以一次调用一个订阅、用完就关。
 * 在最外层开一条长订阅覆盖整个工作流的话，重试的第二片字会推到第一条流上。
 *
 * @param req - 派发请求（命令体由 workflow/command.ts 拼好）。
 * @param signal - 取消信号。
 * @param onStream - 收到一片字时调它（不传就不开订阅，与改动前完全一致）。
 * @returns 结果（永不抛异常）。
 */
export async function dispatchNode(
  req: DispatchRequest,
  signal?: AbortSignal,
  onStream?: (chunk: NodeStreamChunk) => void,
): Promise<RunOutcome> {
  /* 没有消费方 / 环境里没有 `EventSource`（jsdom、老浏览器）→ 不开订阅，
   * 走改动前那条路。**这一分支必须留着**：订阅是增强，不能变成前置条件。 */
  const wantStream = onStream !== undefined && typeof EventSource !== 'undefined'
  const runId = typeof req.runId === 'string' ? req.runId : ''

  let stream: EventSource | null = null
  if (wantStream && runId !== '') {
    try {
      stream = new EventSource(STREAM_ENDPOINT + '?runId=' + encodeURIComponent(runId))
      stream.addEventListener('step', (ev) => {
        /* 帧的形状与宿主半逐字对应；解析失败就当没收到（不打扰用户）。 */
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { kind?: string, nodeId?: string, text?: string }
          if (data?.kind !== 'stream') return
          const nodeId = typeof data.nodeId === 'string' ? data.nodeId : ''
          const text = typeof data.text === 'string' ? data.text : ''
          if (nodeId === '' || text === '') return
          onStream({ nodeId, text })
        } catch { /* 不是 JSON 就跳过 */ }
      })
      /* `done` 帧到了就关：不关的话 `EventSource` 会自己重连（`FlowPanel` 记着这个坑）。 */
      stream.addEventListener('done', () => { close() })
      /* 等就绪 —— 见 `STREAM_OPEN_WAIT_MS` 那段。`open` 与超时**谁先到算谁**。 */
      await new Promise<void>((resolve) => {
        let settled = false
        const fin = (): void => { if (!settled) { settled = true; resolve() } }
        stream?.addEventListener('open', fin)
        setTimeout(fin, STREAM_OPEN_WAIT_MS)
      })
    } catch { stream = null }
  }

  /** 关掉订阅（**幂等**，且不许抛）。 */
  const close = (): void => {
    try { stream?.close() } catch { /* 已经关了 */ }
    stream = null
  }

  let res: Response
  try {
    /* 命令体是引擎拼好的；这里**只在有订阅时**补一个 `__runId`。
     *
     * ⚠️ 不补 `__nodeId`：那一侧宿主半从 `command` 里读的是节点实例 id，
     * 而 `req.nodeId` 就是它 —— 直接一起带上，省得宿主半再去猜。
     * `__` 前缀是项目的保留键约定（`variables.ts:49`），不会被当成变量替换。 */
    const payload = stream === null
      ? req
      : {
          ...req,
          command: req.command !== null && typeof req.command === 'object'
            ? { ...(req.command as Record<string, unknown>), __runId: runId, __nodeId: req.nodeId }
            : { node: req.nodeId, __runId: runId, __nodeId: req.nodeId },
        }
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([payload]),
      /* 传取消信号：用户点「停止」时连接断开，宿主半据此终止子进程 */
      signal,
    })
  } catch (e) {
    close()
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
  /* 无论成功失败都要关：不关的话这条连接会一直挂着（`EventSource` 还会自动重连）。 */
  try {
    if (!res.ok) {
      close()
      return { ok: false, error: '宿主半返回 ' + String(res.status) }
    }
    try {
      const body = await res.json() as { results?: RunOutcome[] }
      const first = body.results?.[0]
      if (first === undefined) return { ok: false, error: '宿主半没有返回结果' }
      return { ...first, ok: true }
    } catch (e) {
      return { ok: false, error: '返回内容读不出来：' + (e instanceof Error ? e.message : String(e)) }
    }
  } finally {
    close()
  }
}

/**
 * 请宿主半**整份**跑一份已保存的工作流（不是单个节点）。
 *
 * ## 谁用它
 *
 * 画布上的「跑另一份工作流」节点。画布自己**碰不到磁盘**（它跑在浏览器里），
 * 所以那一环只能转交给宿主半：宿主半有存档目录、有节点定义表、有本地派发器，
 * 于是它能在自己的进程里把子工作流跑完（含子工作流再套子工作流）。
 *
 * ⚠️ 与 `dispatchNode` 的一个区别：这条**要等整份跑完**才返回。
 * 长流程（抖音表单下载能跑十几分钟）会让这个请求挂很久 —— 这是有意的，
 * 「跑另一份工作流」的语义就是「等它跑完再往下走」。
 *
 * ⚠️ 断开连接**不算取消**（宿主半那侧的注释写了理由）：这是唯一一条
 * 不会因为关掉页面就停下来的路径。
 *
 * @param ref - 工作流引用（编号优先、名字兼容。2026-10-19 改：以前只能给名字）。
 * @returns 结果（永不抛异常）。
 */
export async function runWorkflowFile(
  ref: { id?: string, name?: string } | string,
  signal?: AbortSignal,
  inputs?: Record<string, unknown>,
): Promise<RunOutcome> {
  /* 字符串 = 只给名字（老调用点照旧能用）。 */
  const body = typeof ref === 'string' ? { name: ref } : {
    ...(ref.id === undefined || ref.id === '' ? {} : { workflowId: ref.id }),
    ...(ref.name === undefined || ref.name === '' ? {} : { name: ref.name }),
  }
  const shown = typeof ref === 'string' ? ref : (ref.name ?? ref.id ?? '')
  let res: Response
  try {
    res = await fetch('/api/ecom-workbench/workflow/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...(inputs === undefined ? {} : { inputs }) }),
      signal,
    })
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
  try {
    const resBody = await res.json() as { ok?: boolean, ran?: string[], aborted?: boolean, error?: string, name?: string }
    /* ⚠️ **`ok` 与 `aborted` 要一起看**（宿主半那侧同一个坑，已在那里记过）：
     * 宿主半返回的 `ok` 意思是「这份档读得出来、真的跑了」，不是「跑成功了」——
     * 中途有节点失败并中断时，`ok: true` 而 `aborted: true`。
     * 只认 `ok` 的话，子工作流的失败**在父流程看来是成功**。 */
    if (resBody.ok === true && resBody.aborted !== true) {
      /* 输出里带上**解析出来的名字**（宿主半回的名字优先）——
       * 新写法传的是编号，界面要看的是名字。 */
      return { ok: true, output: { workflow: resBody.name ?? shown, ran: resBody.ran ?? [] } }
    }
    if (resBody.ok === true) {
      return { ok: false, error: resBody.error ?? '子工作流里有节点失败并中断了' }
    }
    return { ok: false, error: resBody.error ?? ('宿主半返回 ' + String(res.status)) }
  } catch (e) {
    return { ok: false, error: '返回内容读不出来：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 读一份工作流的「输入 / 输出声明」。
 *
 * 前端在点「执行」之前要知道**这份工作流要填什么**（开始节点声明的输入项），
 * 跑完之后要知道**它交出了什么**（结束节点声明的产出）。
 *
 * ⚠️ 老存档里没有 `flow.start` / `flow.end` 两个节点 → `inputs` / `outputs`
 * 都是空数组（前端就知道「不用填输入」），**不是错误**。
 *
 * @param name - 工作流名。
 * @returns 声明（失败给 `ok:false` 与原因）。
 */
export async function loadWorkflowIo(name: string): Promise<{
  ok: boolean
  startType?: string | null
  inputs?: { name: string, description: string, required: boolean, default?: string }[]
  outputs?: { name: string, nodeId: string, field: string }[]
  error?: string
}> {
  try {
    const res = await fetch('/api/ecom-workbench/workflow/io?name=' + encodeURIComponent(name))
    if (!res.ok) return { ok: false, error: res.status === 404 ? '没有这份工作流' : '宿主半返回 ' + String(res.status) }
    return await res.json() as { ok: boolean, startType?: string | null, inputs?: [], outputs?: [] }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 探一下宿主半在不在（打开画布时判断要不要提示「引擎未连接」）。
 *
 * @returns 在不在，以及宿主的工作目录。
 */export async function probeEngine(): Promise<{ ok: boolean, workdir?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/health')
    if (!res.ok) return { ok: false }
    const body = await res.json() as { ok?: boolean, workdir?: string }
    return { ok: body.ok === true, workdir: body.workdir }
  } catch {
    return { ok: false }
  }
}

/** 一次存档操作的结果（同 dispatchNode：永不抛异常）。 */
export interface SaveOutcome {
  /** 是否成功。 */
  ok: boolean
  /** 实际写入的路径（成功后给出，便于用户去找）。 */
  path?: string
  /** 存档名（清洗后）。 */
  name?: string
  /** 这份存档的编号（宿主半定的；2026-10-19 加 —— 画布要拿它回写 `wfId`）。 */
  id?: string
  /** 失败原因。 */
  error?: string
}

/**
 * 把一份工作流存到本机。
 *
 * @param name - 工作流名。
 * @param doc - 工作流内容。
 * @returns 结果（永不抛异常）。
 */
export async function saveWorkflowFile(name: string, doc: unknown): Promise<SaveOutcome> {
  try {
    const res = await fetch('/api/ecom-workbench/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, doc }),
    })
    const body = await res.json() as SaveOutcome
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return body
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/* ── 复制一份工作流（票 46，2026-10-28）──────────────────────────────
 *
 * ## 这里最要紧的一条：**撞名会覆盖写**
 *
 * `saveWorkflow`（`src/workflow/store.ts:88-100`）是直接 `writeFile`，**没有同名拒绝**。
 * 所以「读出来 + 换个名字保存」这个最直觉的做法，名字撞了会**直接盖掉别人的存档，
 * 还不报错**。用户点了「复制」结果少了一份原有工作流 —— 那种失败比「复制没成功」
 * 恶劣得多，所以这不是能留到后面的细节。
 *
 * 两道防线（缺一不可）：
 *   ① **存之前先查名字**：拿 `listWorkflowFiles()` 的现有名字集合，撞了就往后数；
 *   ② **id 也查重**：见下面 `duplicateWorkflow` 的注释。
 */

/** 副本名的后缀（与画布侧用同一个词，用户看着一致）。
 *
 * ⚠️ **不要加 `export`**（2026-10-28 实测）。加了 `npm run bundle` 会 panic：
 * `SymbolRef { … } "COPY_SUFFIX" is not in any chunk` —— rolldown 的 bug，
 * 触发条件是「客户端模块导出一个纯字符串常量、而没有任何别的模块 import 它」。
 * 见 `content-canvas-store.ts` 同一条注释里的完整说明。 */
const WF_COPY_SUFFIX = '副本'

/**
 * 从一个名字算出一个**没人用过**的副本名。
 *
 * 规则与画布侧同一套（`content-canvas-store.ts` 的 `copyNameOf`）：
 * `X` → `X 副本` → `X 副本 2` → `X 副本 3` ……
 *
 * ⚠️ **不能只判 `X 副本`**：用户连着复制两次、或手动改过名字时，
 * 中间某个序号可能已被占。只判第一个的话第二次复制就会撞上它 —— 而这里是覆盖写。
 *
 * @param name - 原名（可以已带后缀，照样往后数）。
 * @param taken - 已被占用的名字集合。
 * @returns 一个不在 `taken` 里的名字。
 */
export function workflowCopyName(name: string, taken: ReadonlySet<string>): string {
  const stripped = name.replace(new RegExp(' ' + WF_COPY_SUFFIX + '( \\d+)?$'), '').trim()
  const base = stripped === '' ? name : stripped
  const first = base + ' ' + WF_COPY_SUFFIX
  if (!taken.has(first)) return first
  for (let i = 2; i <= 999; i += 1) {
    const cand = first + ' ' + String(i)
    if (!taken.has(cand)) return cand
  }
  return first + ' ' + String(Date.now())
}

/**
 * 复制一份工作流。
 *
 * ## id 为什么要特别处理（票 46 的核心）
 *
 * `saveWorkflow(doc, name)` 走 `syncDocIdentity(doc, file)`（`src/workflow/ids.ts:145-159`）：
 *
 * ```ts
 * const existing = readWorkflowId(base)
 * const finalId = id !== '' ?​ id : existing !== '' ?​ existing :​ deriveWorkflowId(fileName)
 * ```
 *
 * **`existing` 优先** —— 从原件读出来的 doc 带着原件的 `id`，直接拿去存，
 * 副本会**沿用原件的 id**。而 `flow.workflow` 节点按 id 引用工作流
 * （`ids.ts` 文件头：引用认编号、不认名字），两份同 id 就说不清引用指哪份。
 *
 * 所以这里**先把 `id` 删掉**，逼它走到 `deriveWorkflowId(副本名)`。
 *
 * ## 但派生值也可能撞（`deriveWorkflowId` 是纯哈希，不查重）
 *
 * 同一个名字永远派生出同一个 id。若「X 副本」这个名字以前用过、删了又建回来，
 * 或者只是碰巧哈希撞上，就会与另一份存档同 id。
 *
 * 处理：**拿现有全部 id 做集合，派生出撞了就换个名字再派生**（名字变 → 哈希变）。
 * 最多试 20 次 —— 撞一次概率已经极低，连撞 20 次是荒谬的。
 *
 * @param name - 原件名。
 * @returns 新副本名与编号；失败给原因。
 */
export async function duplicateWorkflow(name: string): Promise<{
  ok: boolean
  /** 副本名（失败时没有）。 */
  name?: string
  /** 副本的编号。 */
  id?: string
  error?: string
}> {
  /* ① 先读原件。读不到就别往下走 —— 千万别「读失败当空文档存一份」。 */
  const got = await loadWorkflowFile(name)
  if (!got.ok) return { ok: false, error: '读原件失败：' + (got.error ?? '未知原因') }
  if (got.doc === null || typeof got.doc !== 'object' || Array.isArray(got.doc)) {
    return { ok: false, error: '原件内容不是一份工作流，没法复制' }
  }

  /* ② 拿现有的名字与编号（**两个都要**：名字防覆盖、编号防引用串）。 */
  const listed = await listWorkflowFiles()
  if (!listed.ok) return { ok: false, error: '读不到现有工作流清单：' + (listed.error ?? '未知原因') }
  const takenNames = new Set<string>(listed.names)
  const takenIds = new Set<string>(listed.items.map(x => x.id).filter(id => id !== ''))

  /* ③ 算一个不撞的名字。 */
  let target = workflowCopyName(name, takenNames)

  /* ④ 副本内容：删掉 id 与 name，逼 `syncDocIdentity` 重新定身份。
   *
   * ⚠️ `name` 也删 —— 它只是显示用的冗余副本（`syncDocIdentity` 会把
   * `base.name` 改写成文件名），留着不碍事但会让人误读。 */
  const src = got.doc as Record<string, unknown>
  const body: Record<string, unknown> = { ...src }
  delete body.id
  delete body.name

  /* ⑤ 派生出撞了就换个名字重来（名字变 → 哈希变）。 */
  for (let attempt = 0; attempt < 20; attempt += 1) {
    /* 本地先算一遍看会不会撞：`deriveWorkflowId` 是纯函数，直接引它，
     * 不必真写一次盘才知道撞没撞。 */
    const candidateId = deriveWorkflowId(target)
    if (!takenIds.has(candidateId)) {
      const saved = await saveWorkflowFile(target, body)
      if (!saved.ok) return { ok: false, error: saved.error ?? '保存副本失败' }
      /* 宿主半回的实际名字（会被 `safeName` 清洗）与编号才是最准的。 */
      return { ok: true, name: saved.name ?? target, id: saved.id ?? candidateId }
    }
    /* 撞了：把 target 这个名字也当「已占」，换个不撞的名字继续。 */
    takenNames.add(target)
    target = workflowCopyName(target, takenNames)
  }
  return { ok: false, error: '连试 20 次都没有可用的编号，请换一个名字再复制' }
}

/**
 * 列出本机已存的工作流。
 *
 * ## ⚠️ 从「只给名字」扩成「名字 + 编号」（2026-10-19）
 *
 * 用户要求引用**按编号**，而编号存在存档里（宿主半手上）——
 * 所以这个接口必须把它一起给出来，界面上的「选一份工作流」才有值可选。
 *
 * `names` 保留着：老调用点（打开存档、另存为重名检查）只关心名字。
 *
 * @returns 条目（名字 + 编号）、存放目录、纯名字清单（失败给空列表 + 原因）。
 */
export async function listWorkflowFiles(): Promise<{
  ok: boolean
  dir?: string
  items: { name: string, id: string }[]
  names: string[]
  error?: string
}> {
  try {
    const res = await fetch('/api/ecom-workbench/workflows')
    if (!res.ok) return { ok: false, items: [], names: [], error: '宿主半返回 ' + String(res.status) }
    const body = await res.json() as { dir?: string, items?: { name: string, id?: string }[] }
    const items = (body.items ?? []).map(x => ({ name: x.name, id: x.id ?? '' }))
    return { ok: true, dir: body.dir, items, names: items.map(x => x.name) }
  } catch (e) {
    return { ok: false, items: [], names: [], error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 读回一份已存的工作流。
 *
 * @param name - 工作流名。
 * @returns 内容（失败给 ok:false 与原因）。
 */
export async function loadWorkflowFile(name: string): Promise<{ ok: boolean, doc?: unknown, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/workflow?name=' + encodeURIComponent(name))
    if (!res.ok) return { ok: false, error: res.status === 404 ? '没有这份工作流' : '宿主半返回 ' + String(res.status) }
    const body = await res.json() as { doc?: unknown }
    return { ok: true, doc: body.doc }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 存一份版本快照。
 *
 * @param name - 工作流名。
 * @param doc - 内容。
 * @returns 结果（永不抛异常）。
 */
export async function saveSnapshot(name: string, doc: unknown): Promise<{ ok: boolean, snap?: string, path?: string, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, doc }),
    })
    const body = await res.json() as { ok?: boolean, snap?: string, path?: string, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    /* 走到这里 `body.ok` 一定是 `true`（上一行已经排除了不是的情况），
     * 但类型上它仍是 `ok?: boolean` —— 直接 `return body` 会报「可能 undefined」。
     * 显式补 `ok: true` 不是敷衍，是把**刚刚验证过的事实**写进类型。 */
    return { ...body, ok: true }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 列某份工作流的快照（新的在前）。
 *
 * @param name - 工作流名。
 * @returns 快照名数组（失败给空数组 + 原因）。
 */
export async function listSnapshots(name: string): Promise<{ ok: boolean, snaps: string[], error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/snapshots?name=' + encodeURIComponent(name))
    if (!res.ok) return { ok: false, snaps: [], error: '宿主半返回 ' + String(res.status) }
    const body = await res.json() as { snaps?: string[] }
    return { ok: true, snaps: body.snaps ?? [] }
  } catch (e) {
    return { ok: false, snaps: [], error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 读一份快照。
 *
 * @param name - 工作流名。
 * @param snap - 快照名。
 * @returns 内容（失败给 ok:false）。
 */
export async function loadSnapshot(name: string, snap: string): Promise<{ ok: boolean, doc?: unknown, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/snapshot?name=' + encodeURIComponent(name) + '&snap=' + encodeURIComponent(snap))
    if (!res.ok) return { ok: false, error: res.status === 404 ? '没有这份快照' : '宿主半返回 ' + String(res.status) }
    const body = await res.json() as { doc?: unknown }
    return { ok: true, doc: body.doc }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 在系统的文件管理器里打开**工作流存放的目录**（用户 2026-10-14 要求）。
 *
 * 能力在宿主半（见 `src/index.ts` 那条路由的长注释：为什么沿用我们自己的
 * `openInFileManager`、而**不用** dsh 那个 `open-in-app`）。
 * 这里只发**名字**，路径由宿主半自己算 —— 那条安全约定是刻意的。
 *
 * @param name - 工作流名。
 * @returns 结果（永不抛异常）；`path` 是实际打开的目录。
 */
export async function openWorkflowDir(name: string): Promise<{ ok: boolean, path?: string, exists?: boolean, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/workflow/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const body = await res.json() as { ok?: boolean, path?: string, exists?: boolean, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    /* 同上：`body.ok` 到这里必为 true，显式补出来满足类型。 */
    return { ...body, ok: true }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 删掉一份已保存的工作流（不可逆）。
 *
 * @param name - 工作流名。
 * @returns 结果（永不抛异常）。
 */
export async function deleteWorkflowFile(name: string): Promise<{ ok: boolean, error?: string }> {
  try {
    /* 注意是单数 /workflow（与读取同路径，靠方法区分）—— 后端就是这么分的。 */
    const res = await fetch('/api/ecom-workbench/workflow?name=' + encodeURIComponent(name), { method: 'DELETE' })
    const body = await res.json() as { ok?: boolean, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/** 上报一次「画布跑完」的运行记录时用的形状（与宿主半 `WorkflowRun` 对齐）。 */
export interface RecordRunInput {
  /** 归属的工作流名（画布还没保存时为空 —— 那种运行历史不记）。 */
  name: string
  startedAt: number
  endedAt: number
  ok: boolean
  aborted?: boolean
  error?: string
  ran: string[]
  nodes: {
    nodeId: string
    defId?: string
    label?: string
    state: string
    startedAt?: number
    endedAt?: number
    error?: string
    logs?: string[]
  }[]
  outputs?: Record<string, unknown>
  inputs?: Record<string, unknown>
}

/**
 * 把画布跑的这一次上报成「运行历史」的一条记录。
 *
 * ## 为什么画布要自己上报（用户 m14827 报的「画布中运行，历史没有记录」）
 *
 * `appendRun` 原先只在**宿主半自己跑整份工作流**的两条路径上调
 * （`/workflow/run`、`/workflow/run-stream`）。而画布是**客户端自己跑的** ——
 * 它调 `runGraph`、逐节点 `POST /run` 派发，宿主半全程不知道
 * 「这是一次整份运行的开始与结束」，所以没法自己写。
 *
 * ## 为什么在这里上报而不是在宿主半补一条「猜」的
 *
 * 画布才知道这次跑了哪些节点、哪个失败、日志是什么（都在 `useRunStore` 里）。
 * 宿主半去猜只能拿到零散节点，拼不出「整次」。
 *
 * ⚠️ **失败不抛、不打扰用户**：跑都跑完了，历史没记上不该冒一个错误框。
 * 但也不静默 —— 返回的 `error` 由调用方决定要不要说（画布只在控制台留一句）。
 *
 * @param input - 这次运行的记录。
 * @returns 结果（永不抛异常）。
 */
export async function recordCanvasRun(input: RecordRunInput): Promise<{ ok: boolean, id?: string, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/workflow/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = await res.json() as { ok?: boolean, id?: string, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true, id: body.id }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 把浏览器偏好写进**宿主半能读到的那份文件**。
 *
 * ## 为什么要有这一步（用户 2026-10-20：「从列表启动找不到浏览器」）
 *
 * 偏好原来只存 `localStorage` —— 那是**浏览器进程**里的东西，宿主半读不到。
 * 画布在打开时会把它写进节点参数，所以从画布跑没问题；而从列表 / 定时启动
 * 不经过画布，存档里的 `port` 是空的 → 驱动报「连不上浏览器的调试端口」。
 *
 * 现在两边都写：`localStorage`（画布的快速缓存）+ 这个文件（**权威**）。
 * 只写一个会让两边漂（见 `pitfalls/同一件事写两份迟早漂.md`）。
 *
 * ⚠️ **失败不抛、不打扰用户**：设置面板改一下端口不该弹错误框；
 * 但也不静默 —— 调用方可以看返回的 `error`（画布只在控制台留一句）。
 *
 * @param prefs - 当前偏好（形状由 `browser-settings.ts` 定）。
 * @returns 结果（永不抛异常）。
 */
export async function saveBrowserPrefs(prefs: unknown): Promise<{ ok: boolean, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/browser/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefs }),
    })
    const body = await res.json() as { ok?: boolean, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 读宿主半那份偏好文件。
 *
 * 画布启动时用它当**权威初始值**（localStorage 只是上一次的缓存）。
 * 文件不存在时宿主半返回一份空偏好，不是 404 —— 所以这里也一定拿得到形状。
 *
 * @returns 偏好（读不到时返回 `ok: false`，调用方退回 localStorage）。
 */
export async function loadBrowserPrefs(): Promise<{ ok: boolean, prefs?: unknown, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/browser/prefs')
    const body = await res.json() as { ok?: boolean, prefs?: unknown, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true, prefs: body.prefs }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 一条「等待中」的运行（宿主半 `GET /workflow/paused` 的列表项）。
 *
 * ⚠️ **不是现场**：宿主半刻意只回这几项（现场的 `outputs` 可能很大，
 * 一份采集的原始数据全在里面）。要看节点明细走运行记录，不从这里拿。
 */
export interface PausedRunItem {
  /** 运行 id（恢复 / 放弃时传给宿主半的就是它）。 */
  runId: string
  /** 哪份工作流（解析出来的名字）。 */
  workflowId: string
  /** 挂起的时刻（毫秒时间戳）。 */
  pausedAt: number
  /** 从哪个节点之后继续（节点 id）。 */
  resumeAfter: string
  /** 计划恢复的时刻（毫秒时间戳）。 */
  resumeAt: number
  /** 怎么恢复：`until` = 等到某个时刻，其余是时长型。 */
  mode: 'until' | 'duration'
  /** `until` 模式填的时刻文本（`HH:MM`），便于与节点参数对上。 */
  until?: string
  /** 已经跑过几个节点。 */
  ran: number
}

/**
 * 列出「现在有哪些运行在等」（新的在前）。
 *
 * 与 `dispatchNode` 同一个约定：永不抛异常，失败给 `ok: false` 与一句话。
 *
 * @returns 列表（失败给空列表 + 原因）。
 */
export async function listPausedRuns(): Promise<{ ok: boolean, paused: PausedRunItem[], error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/workflow/paused')
    const body = await res.json() as { ok?: boolean, paused?: PausedRunItem[], error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, paused: [], error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true, paused: body.paused ?? [] }
  } catch (e) {
    return { ok: false, paused: [], error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 让某一份**立刻**继续（不等它到点；用户催的时候用）。
 *
 * ⚠️ 三种结局要分开看，界面别混成一种报错：
 *   · `ok: true` —— 真的续上了；`waiting: true` 表示**又挂起**了（等下一个条件）；
 *   · `gone: true` —— 宿主半回 404：这份现场已经不在（被自动恢复 / 已放弃）；
 *   · 其余 `ok: false` —— 宿主半给了原因（如队列拒绝）。
 *
 * @param id - 运行 id。
 * @returns 结果（永不抛异常）。
 */
export async function resumePausedRun(id: string): Promise<{
  ok: boolean
  /** 现场已经不在了（宿主半回 404）—— 不是网络错误。 */
  gone?: boolean
  /** 一句话结果（宿主半写的，如「继续跑完了（5 个节点）」）。 */
  summary?: string
  /** 续上的那次运行的 id。 */
  runId?: string
  /** 又挂起了。 */
  waiting?: boolean
  /** 又挂起时，新的恢复时刻。 */
  resumeAt?: number
  error?: string
}> {
  try {
    const res = await fetch('/api/ecom-workbench/workflow/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await res.json() as { ok?: boolean, summary?: string, runId?: string, waiting?: boolean, resumeAt?: number, error?: string }
    if (res.status === 404) return { ok: false, gone: true, error: body.error ?? '这份挂起的运行已经不在了' }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true, ...body }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 放弃某一份等待中的运行（删掉现场，之后不再自动恢复）。
 *
 * ⚠️ **删不掉时宿主半回 400**（不是 404）—— 那时 `error` 里就是给人看的原因，
 * 界面照转，别自己另编一句。
 *
 * @param id - 运行 id。
 * @returns 结果（永不抛异常）。
 */
export async function cancelPausedRun(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/workflow/paused/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await res.json() as { ok?: boolean, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 预警节点的一个级别（与宿主半 `src/notify/prefs.ts` 的 `AlertLevel` 同名同形）。
 *
 *   · `info` 信息 —— 过程正常，仅作记录；
 *   · `notice` 注意 —— 需要留意，但不用马上处理；
 *   · `severe` 严重 —— 需要马上处理。
 *
 * ⚠️ **从低到高就是这个顺序**（与节点 `level` 参数的选项顺序一致），
 * 界面上的「X 及以上」靠它推算，别在别处另排一遍。
 */
export type AlertLevel = 'info' | 'notice' | 'severe'

/** 预警节点的**最低级别**门槛（`off` = 预警节点一律不发）。 */
export type AlertMinLevel = 'off' | AlertLevel

/**
 * 提醒偏好（与宿主半 `src/notify/prefs.ts` 的 `NotifyPrefs` 逐字段一致）。
 *
 * ## 从「三档单选」改成「两项独立设置」（2026-10-22）
 *
 * 旧形状 `{ mode: 'failures' | 'alerts' | 'off' }` 把两件**互不相干**的事绑成一个枚举：
 *
 *   · **失败要不要提醒**（定时任务失败、挂起恢复失败）—— 这是「要不要知道出事了」；
 *   · **预警节点什么级别才提醒**（`flow.notify` 的级别门槛）—— 这是「多吵才算吵」。
 *
 * 绑在一起的后果：想要「失败静默、但严重预警要弹」这个完全合理的组合，
 * 旧的三档里**没有**（`off` 连预警也不发，`failures` 又不弹预警）。所以拆成两项。
 *
 * 旧文件由宿主半读时自动迁移，界面这边只管新形状。
 */
export interface NotifyPrefs {
  /** 失败类提醒发不发（定时任务失败 + 挂起恢复失败，**共用这一项**）。 */
  failNotify: boolean
  /** 预警节点（`flow.notify`）什么级别以上才发；`off` 表示一律不发。 */
  alertMinLevel: AlertMinLevel
}

/** 三个级别的中文名与说明（与 `flow.notify` 节点的 `level` 选项**同一套**）。 */
export const ALERT_LEVELS: readonly { value: AlertLevel, label: string, note: string }[] = [
  { value: 'info', label: '信息', note: '过程正常，仅作记录' },
  { value: 'notice', label: '注意', note: '需要留意，但不用马上处理' },
  { value: 'severe', label: '严重', note: '需要马上处理' },
]

/**
 * 一个级别门槛的显示文案（「信息及以上」这种）。
 *
 * @param v - 门槛。
 * @returns 一句话。
 */
export function alertLevelLabel(v: AlertMinLevel): string {
  if (v === 'off') return '不发送'
  const hit = ALERT_LEVELS.find(l => l.value === v)
  return hit === undefined ? '不发送' : hit.label + '及以上'
}

/**
 * 读提醒偏好。
 *
 * ⚠️ 文件不存在时宿主半返回**默认值**（`failNotify: true` / `alertMinLevel: 'off'`），
 * 不是 404 —— 所以读成功不等于「用户设过」，只是「现在按这一份发」。
 *
 * @returns 偏好（读不到时给 `ok: false`，调用方据此显示提示，**别拿默认值冒充成功**）。
 */
export async function loadNotifyPrefs(): Promise<{ ok: boolean, prefs?: NotifyPrefs, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/notify/prefs')
    const body = await res.json() as { ok?: boolean, prefs?: NotifyPrefs, error?: string }
    if (!res.ok || body.ok !== true || body.prefs === undefined) {
      return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    }
    return { ok: true, prefs: body.prefs }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 写提醒偏好（**部分更新**：传几个键就只改几个）。
 *
 * ⚠️ **别把 200 当成「传的值一定存下来了」**：宿主半对非法值会**回落盘上原值且仍回 200**
 * （与 `/browser/prefs` 同一个取舍：不为一个怪值弹个没用的错误框）。
 * 所以调用方必须用响应里的 `prefs` 更新界面，而不是用自己传进去的那个。
 *
 * ⚠️ **只带要改的那个键**：两项是独立的，整份提交会把用户刚改的另一项打回去
 * （两个标签页同时开着时尤其明显）。
 *
 * @param patch - 要改的键。
 * @returns 宿主半回的**合并后完整偏好**（永不抛异常）。
 */
export async function saveNotifyPrefs(
  patch: Partial<NotifyPrefs>,
): Promise<{ ok: boolean, prefs?: NotifyPrefs, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/notify/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefs: patch }),
    })
    const body = await res.json() as { ok?: boolean, prefs?: NotifyPrefs, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true, prefs: body.prefs }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/* ── 界面偏好（用户 2026-10-22：「重启桌面端就丢」）─────────────────────
 *
 * ## 为什么要落盘
 *
 * 启动器用 `--port 0`（系统每次分配不同端口），而 `localStorage` 按
 * 「域名 + 端口」隔离 —— 端口一变，上一轮存的偏好就读不到了。
 * 所以凡是「跨重启要记住」的开关都得落到文件：`$DSH_HOME/AGENTS.md`
 * 的「启动与配置」节明写着这条。
 *
 * ## 分工：文件是权威，`localStorage` 只是首帧缓存
 *
 *   · **首帧**必须靠 `localStorage` 撑住 —— 文件要经一次网络往返，
 *     等它回来才渲染会闪一下默认值（宽度从默认值跳到用户设的那个，看得见）。
 *   · **文件回来了**就以它为准校正：它是上一轮真正存下的值，缓存可能是旧的
 *     （端口变了之后缓存是空的，或者用户在别的端口改过）。
 *   · **改动时两边都写**：只写文件 → 下次首帧还是旧值（会闪）；
 *     只写缓存 → 重启就丢（就是这次的病）。
 *
 * 形状、区间、默认值与逐字段容错都在宿主半（`src/prefs/ui-prefs.ts`），
 * 这里**不另立一套默认值** —— 两处各写一份迟早会漂。
 */

/** 界面偏好（与宿主半 `src/prefs/ui-prefs.ts` 的 `UiPrefs` 逐字段一致）。 */
export interface UiPrefs {
  /** 顶部面包屑与大标题是否收起。 */
  topHidden: boolean
  /** 侧栏是否收起。 */
  navCollapsed: boolean
  /** 节点库宽度（像素，180–460）。票 58 之前是 160–420。 */
  libW: number
  /** 端口图例是否显示。 */
  legend: boolean
  /** 节点卡片宽度（像素，200–520）。 */
  nodeW: number
  /**
   * 内容画布侧栏宽度（像素，180–460；票 58）。
   *
   * ⚠️ **可选**：老存档里没有这个键。做成必填会让「读一份老 `ui-prefs.json`」
   * 直接缺字段，而调用方拿到的是 `Partial<UiPrefs>`（本来就允许缺）。
   */
  contentSideW?: number
  /** 内容画布侧栏是否折叠（票 58）。可选的理由同上。 */
  contentSideCollapsed?: boolean
}

/**
 * 五个键在 `localStorage` 里的名字。
 *
 * 与旧代码里散落的字面量逐个对齐；改名字会让**已存在的缓存全部失效**
 * （用户重启后就看不到自己上次的值了），所以只许加、不许改。
 */
/**
 * 节点库宽度的上下限（**与 `src/prefs/ui-prefs.ts` 的 `LIB_W_MIN` / `LIB_W_MAX` 同值**）。
 *
 * ## 为什么这里也写一份，而不是从那边 import
 *
 * `src/prefs/ui-prefs.ts` 是**宿主半模块**（它 `import` 了 `node:fs` 与
 * `src/workflow/store.ts`）。客户端文件 import 它会把这个模块拖进客户端产物，
 * 而项目纪律是「客户端不 import Node 内置模块」。
 *
 * 所以两处各写一份数字，靠 `tests/ui-prefs.mjs` 的一条断言**直接读两处源码比对**
 * 来钉住它们一致。这不是偷懒 —— 是分层约束下的唯一做法，且那条断言比
 * 「共用一个常量」更早发现漂移（共用常量时，改了一处另一处根本不会红）。
 */
const LIB_W_MIN = 180
const LIB_W_MAX = 460
/** 内容画布侧栏宽度的上下限（与 `CanvasSidePanel.tsx` 的 `PANEL_MIN/MAX` 同值）。 */
const CONTENT_SIDE_W_MIN = 180
const CONTENT_SIDE_W_MAX = 460

export const UI_PREF_KEYS = {
  topHidden: 'ewb.topHidden',
  navCollapsed: 'ewb.navCollapsed',
  libW: 'ewb.libW',
  legend: 'ewb.legend',
  nodeW: 'ewb.nodeW',
  /* ★ 票 58（2026-10-29）：内容画布侧栏的宽度与折叠。
   *
   * ## 为什么必须加进这张表
   *
   * 这张表是**缓存读写的白名单** —— `readUiPrefsCache` / `writeUiPrefsCache`
   * 逐个键名读写，表里没有的键**根本不会被读、也不会被写**。
   * 只往 `UiPrefs` 接口里加字段而不加这里，表现是：
   *   ① 首帧读不到缓存 → 回默认值，闪一下；
   *   ② 拖完之后写不进缓存 → 每次刷新都要等后端走一次网络往返才校正。
   * 而「拖了、刷新又变回 260」正是这一票要修的毛病，漏一处等于没做。
   *
   * 沿用既有命名（`ewb.*`）—— 改前缀会让老缓存全部失效。 */
  contentSideW: 'ewb.contentSideW',
  contentSideCollapsed: 'ewb.contentSideCollapsed',
} as const

/** 一个键的名字（`UI_PREF_KEYS` 的键类型）。 */
export type UiPrefKey = keyof typeof UI_PREF_KEYS

/**
 * 读一份**缓存**（`localStorage`）里的偏好；缺哪个键就不给哪个键。
 *
 * 只有「读到过」的键才出现在结果里 —— 这样调用方可以「有就用、没有才用默认」，
 * 而不是被缓存里一个假的默认值糊住。
 *
 * @returns 读到的键（可能一个都没有；从不抛）。
 */
export function readUiPrefsCache(): Partial<UiPrefs> {
  const out: Partial<UiPrefs> = {}
  try {
    const b = (k: string): boolean | undefined => {
      const v = localStorage.getItem(k)
      return v === null ? undefined : v === '1'
    }
    const n = (k: string, min: number, max: number): number | undefined => {
      const raw = localStorage.getItem(k)
      if (raw === null) return undefined
      const v = Number(raw)
      return Number.isFinite(v) && v >= min && v <= max ? v : undefined
    }
    const topHidden = b(UI_PREF_KEYS.topHidden)
    if (topHidden !== undefined) out.topHidden = topHidden
    const navCollapsed = b(UI_PREF_KEYS.navCollapsed)
    if (navCollapsed !== undefined) out.navCollapsed = navCollapsed
    /* ⚠️ 2026-10-29（票 58）160/420 → **180/460**，与 `src/prefs/ui-prefs.ts` 的
     * `LIB_W_MIN` / `LIB_W_MAX` **必须同一组**。只改一处会出现
     * 「拖到 450 存进去、刷新读回 420」。`tests/ui-prefs.mjs` 有一条断言
     * 直接读**两处源码**比这组数字。 */
    const libW = n(UI_PREF_KEYS.libW, LIB_W_MIN, LIB_W_MAX)
    if (libW !== undefined) out.libW = libW
    const legend = b(UI_PREF_KEYS.legend)
    if (legend !== undefined) out.legend = legend
    const nodeW = n(UI_PREF_KEYS.nodeW, 200, 520)
    if (nodeW !== undefined) out.nodeW = nodeW
    /* ★ 票 58：内容画布侧栏那两个。范围与 `CanvasSidePanel` 的钳制同一组。 */
    const contentSideW = n(UI_PREF_KEYS.contentSideW, CONTENT_SIDE_W_MIN, CONTENT_SIDE_W_MAX)
    if (contentSideW !== undefined) out.contentSideW = contentSideW
    const contentSideCollapsed = b(UI_PREF_KEYS.contentSideCollapsed)
    if (contentSideCollapsed !== undefined) out.contentSideCollapsed = contentSideCollapsed
  } catch {
    /* `localStorage` 不可用（隐私模式 / 配额满）—— 当作没有缓存 */
  }
  return out
}

/**
 * 把偏好写进 `localStorage` 缓存（只写传进来的键）。
 * @param patch - 要写的键。
 */
export function writeUiPrefsCache(patch: Partial<UiPrefs>): void {
  try {
    if (patch.topHidden !== undefined) localStorage.setItem(UI_PREF_KEYS.topHidden, patch.topHidden ? '1' : '0')
    if (patch.navCollapsed !== undefined) localStorage.setItem(UI_PREF_KEYS.navCollapsed, patch.navCollapsed ? '1' : '0')
    if (patch.libW !== undefined) localStorage.setItem(UI_PREF_KEYS.libW, String(patch.libW))
    if (patch.legend !== undefined) localStorage.setItem(UI_PREF_KEYS.legend, patch.legend ? '1' : '0')
    if (patch.nodeW !== undefined) localStorage.setItem(UI_PREF_KEYS.nodeW, String(patch.nodeW))
    /* ★ 票 58：与读那边的白名单**成对**。只加读不加写 = 缓存永远空着。 */
    if (patch.contentSideW !== undefined) localStorage.setItem(UI_PREF_KEYS.contentSideW, String(patch.contentSideW))
    if (patch.contentSideCollapsed !== undefined) localStorage.setItem(UI_PREF_KEYS.contentSideCollapsed, patch.contentSideCollapsed ? '1' : '0')
  } catch {
    /* 写不进缓存不影响这一次使用（文件那条才是权威） */
  }
}

/**
 * 读界面偏好**文件**（宿主半那份权威值）。
 *
 * 文件不存在时宿主半返回一份全默认值（不是 404），所以正常情况一定拿得到形状；
 * 拿不到（宿主半没起、500）就回 `ok: false`，由调用方**退回缓存** ——
 * ⚠️ **不许**因此把界面重置成默认值（那等于把用户上次的设置抹掉）。
 *
 * @returns 偏好（永不抛异常）。
 */
export async function loadUiPrefs(): Promise<{ ok: boolean, prefs?: UiPrefs, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/ui/prefs')
    const body = await res.json() as { ok?: boolean, prefs?: UiPrefs, error?: string }
    if (!res.ok || body.ok !== true || body.prefs === undefined) {
      return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    }
    return { ok: true, prefs: body.prefs }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/**
 * 写界面偏好（**部分更新**）：文件与缓存**两边都写**。
 *
 * ## 顺序为什么是「先缓存、后文件」
 *
 * 缓存是同步的、改完立刻生效；文件要走网络。先写缓存，界面下一次挂载就一定
 * 拿得到新值；万一文件那条失败，至少这一次会话内是对的。
 * 反过来（先文件后缓存）在网络慢时会出现「文件已经改了、缓存还是旧的」，
 * 恰好在下次首帧把旧值撑出来 —— 那正是要避免的闪。
 *
 * ## 失败不打扰用户
 *
 * 设置面板拖一下滑块不该弹错误框。返回 `ok: false` 让调用方**可以**留一句日志，
 * 但不当成用户要处理的错误（宿主半挂了的时候什么都做不了）。
 *
 * @param patch - 要改的那几个键（传几个就只改几个，其余保持原值）。
 * @returns 结果与**合并后的完整偏好**（宿主半回的，照它更新界面即可，不用再 GET）。
 */
export async function saveUiPrefs(
  patch: Partial<UiPrefs>,
): Promise<{ ok: boolean, prefs?: UiPrefs, error?: string }> {
  writeUiPrefsCache(patch)
  try {
    const res = await fetch('/api/ecom-workbench/ui/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefs: patch }),
    })
    const body = await res.json() as { ok?: boolean, prefs?: UiPrefs, error?: string }
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true, prefs: body.prefs }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/* ── 偏好的一次加载、多处共用 ────────────────────────────────────────
 *
 * ## 为什么要一个模块级的广播
 *
 * 五个键住在**两个组件**里（`EcomWorkbench` 管 topHidden / navCollapsed，
 * `WorkflowCanvas` 管 libW / legend / nodeW）。各自去 `GET /ui/prefs` 会有两个问题：
 *
 *   1. 两次往返、两个真值来源，回来先后不定，界面可能一半新一半旧；
 *   2. 用户在设置里改了一处，另一处不知道 —— 切板块回来会跳回旧值。
 *
 * 所以只拉**一次**，结果存在这里，两个组件订阅同一份。改动也走同一条广播，
 * 谁改的谁不特殊（包括「别处改的」这种将来可能出现的情况）。
 */

/** 已拿到的那份偏好（null = 还没到）。 */
let prefsValue: UiPrefs | null = null
/** 正在飞的那次请求（幂等：重复调用不会发第二次）。 */
let prefsFlight: Promise<void> | null = null
/** 订阅者。 */
const prefsListeners = new Set<(p: UiPrefs) => void>()

/**
 * 当前已经拿到的偏好（没拿到就是 null）。
 *
 * 组件首帧**不用它** —— 首帧用 `readUiPrefsCache()`（同步、不闪）。
 * 它是给「已经挂载之后又想看一眼」的地方用的。
 *
 * @returns 偏好或 null。
 */
export function currentUiPrefs(): UiPrefs | null {
  return prefsValue
}

/**
 * 订阅偏好变化（文件到货、或某处保存成功时都会回调）。
 *
 * 订阅时**若已经有值就立刻回调一次** —— 否则「文件比组件先到」时组件会一直等下一次变化。
 *
 * @param cb - 收到新偏好时调用。
 * @returns 退订函数。
 */
export function subscribeUiPrefs(cb: (p: UiPrefs) => void): () => void {
  prefsListeners.add(cb)
  if (prefsValue !== null) cb(prefsValue)
  return () => { prefsListeners.delete(cb) }
}

/** 把一份新偏好广播出去（内部用；保存成功后也走这里）。 */
function publishUiPrefs(p: UiPrefs): void {
  prefsValue = p
  for (const cb of prefsListeners) {
    try { cb(p) } catch { /* 一个订阅者抛错不该拖垮别的 */ }
  }
}

/**
 * 确保「从文件取偏好」这件事已经发起过（幂等）。
 *
 * 失败**什么都不做**：界面继续用首帧那份缓存值 —— 这是任务书的要求
 * （宿主半没起来时不许把界面重置成默认值）。
 *
 * @returns 完成（失败也算完成 —— 没有人会等它做别的事）。
 */
export function ensureUiPrefsLoaded(): Promise<void> {
  if (prefsFlight !== null) return prefsFlight
  prefsFlight = (async (): Promise<void> => {
    const r = await loadUiPrefs()
    if (!r.ok || r.prefs === undefined) {
      /* ⚠️ 这里**故意不广播默认值**：广播就等于把界面重置了。
       * 让它停在首帧那份缓存值上，是任务书明确要的行为。 */
      return
    }
    publishUiPrefs(r.prefs)
  })()
  return prefsFlight
}

/**
 * 存档一份偏好并广播（保存成功后调用，让其它组件立刻跟上）。
 * @param p - 宿主半回的**合并后完整偏好**。
 */
export function adoptUiPrefs(p: UiPrefs): void {
  publishUiPrefs(p)
}

/* ── 跑一份工作流并**取回它交出的东西**（2026-10-23 加）────────────────
 *
 * ## 为什么不直接用 `runWorkflowFile`
 *
 * `runWorkflowFile`（本文件 L81）只回 `{ workflow, ran }` —— 它把宿主半响应里的
 * `declaredOutputs` **丢掉了**。那份东西是「结束节点声明的产出」，也就是
 * 「这份工作流算出来的结果」。对「跑完只要知道成没成」的场合（列表页执行）
 * 丢掉无所谓；但提示词优化要的就是模型写的那段文字，**没有它就做不了**。
 *
 * ⚠️ 所以这里**另开一条路**，而不是改 `runWorkflowFile` 的返回形状：
 * 那个函数有别的调用点（列表页、画布子工作流节点），改返回形状会牵动它们。
 * 另开一条的代价是多一个函数，好处是既有调用点一行都不用动。
 *
 * ⚠️ **不是自己拼 HTTP 调模型**：这仍然是「请宿主半跑一份工作流」，
 * 模型由工作流里的 `ai.agent` 节点去调。项目纪律要求调模型必须做成工作流，
 * 这条只是把工作流的产出取回来。
 */

/** 跑完一份工作流之后的完整结果（含它交出的产出）。 */
export interface WorkflowRunResult {
  /** 拿得到结果（不代表成功 —— 还要看 `aborted`）。 */
  ok: boolean
  /** 工作流名（宿主半解析出来的，界面要显示它）。 */
  name?: string
  /** 跑过的节点。 */
  ran?: string[]
  /** 有节点失败并中断。 */
  aborted?: boolean
  /** 结束节点声明的产出（键 = 声明里的名字）。 */
  outputs?: Record<string, unknown>
  /** 失败原因（宿主半原话，或这里补的）。 */
  error?: string
}


/* ══════════════════════════════════════════════════════════════════════
 * 提示词源：读一个源的**真实状态**（票 27）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么要有这一条
 *
 * `PromptLibrary` 原本**一个请求都不发**，数据全部来自随代码发布的副本
 * （`prompt-sources/index.ts`）。那个设计本身没错 —— 源会挂（改名、删库、断网），
 * 而这一格必须永远能用。
 *
 * 但它有个代价：后端已经能说「这份内容是从旧地址拉的」「这里用的是内置副本」了
 * （票 26，`4ca17fa`），界面上一个字都看不到。用户改过源地址之后，
 * 看到的是几个月前的内容，而且**没有任何提示**。
 *
 * ## 所以形状是「先副本、后替换、失败留副本」
 *
 * 调用方**不是**等这个函数回来才渲染：首屏用内置副本立刻画出来，
 * 这个函数回来了再替换。失败就当没发生过（副本还在，界面照常能用）。
 *
 * ⚠️ `from` 与 `note` 必须一起处理：只说 `from` 不说 `note` 等于没说 ——
 * 用户看不懂 `builtin` 这个英文词。
 */

/** 读一个提示词源的结果。 */
export interface PromptSourceReply {
  /** 拿到了（不代表内容是最新的 —— 看 `from`）。 */
  ok: boolean
  /** 源定义（含 `entries`）。 */
  source?: {
    id: string
    name: string
    url: string
    homepage: string
    license: string
    count: number
    upstreamCount: number
    fetchedAt: number
    entries: unknown[]
  }
  /** 这份内容从哪来：`cache` 拉过存下的 / `builtin` 内置副本 / `custom` 自定义源。 */
  from?: 'cache' | 'builtin' | 'custom'
  /** 给人看的说明（后端原话，界面直接显示，不要自己改写）。 */
  note?: string
  /** 失败原因（后端原话）。 */
  error?: string
  /** 源被停用了（与「没有这个源」分开说）。 */
  disabled?: boolean
}

/**
 * 读一个提示词源的当前状态。
 *
 * @param id - 源 id。
 * @returns 结果（永不抛异常）。
 */
export async function loadPromptSource(id: string): Promise<PromptSourceReply> {
  try {
    const res = await fetch('/api/ecom-workbench/prompt-sources/' + encodeURIComponent(id))
    const body = await res.json() as PromptSourceReply & { ok?: boolean }
    if (!res.ok || body.ok !== true) {
      return {
        ok: false,
        error: body.error ?? ('宿主半返回 ' + String(res.status)),
        ...body.disabled === true ? { disabled: true } : {},
      }
    }
    if (body.source === undefined) return { ok: false, error: '宿主半没给源内容' }
    return { ok: true, source: body.source, from: body.from, note: body.note }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}
