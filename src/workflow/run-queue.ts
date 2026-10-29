/** 工作流级并发控制（**排队而不是拒绝**）。
 *
 * ## 为什么需要它（计划 Step 11）
 *
 * 「同时启动两个工作流」原先做不到：一次只跑一份。放开之后立刻出现第二个问题 ——
 * 十份采集同时开，浏览器 / 进程全被挤爆。所以并发度要有上限。
 *
 * ## 为什么是「排队」不是「拒绝」
 *
 * `src/index.ts` 文件头写着这条理由：dsh-jobs-local 的并发上限是**拒绝**，
 * 与我们需要的 queued 状态不符，所以要在它前面自己排队。
 * 工作流这一层同理：用户点了三份，应该三份都**进队列**、按顺序跑完，
 * 而不是「第三份报错说忙」—— 后者等于让用户自己盯着点。
 *
 * ## 两道限制，别搞混
 *
 * | 限制 | 管什么 | 在哪 |
 * | --- | --- | --- |
 * | **本文件** | 同时跑几**份工作流** | 整份运行之间 |
 * | `WorkflowDispatcher` 的 p-queue | 同时跑几**个节点** | 一份运行内部 |
 *
 * 两者是乘法关系（3 份 × 每份 2 个节点 = 最多 6 个进程），所以默认值都取小的。
 *
 * ## ⚠️ 同一份工作流不许叠着跑
 *
 * 不拦的话，同一份采集会在同一批浏览器标签上互相踩，而两边的运行记录
 * 又会往同一个 `runs/<名字>.json` 里抢写（那个文件有串行队列，但语义上仍是「两次运行」）。
 * 所以按**工作流名**去重：已经在跑/在排的那份再点，直接给一句可读的错。
 *
 * ## 纯逻辑（不 import Node 内置模块）
 *
 * 这样测试能直接跑它，宿主半也只是「接线」。本文件不做任何 IO。
 */

/** 一份排队的活。 */
interface Job<T> {
  /** 去重键（工作流名）。 */
  key: string
  /** 真正要做的。 */
  run: () => Promise<T>
  /** 活开始跑时resolve。 */
  start: () => void
  /** 活跑完/失败时resolve。 */
  finish: (r: { ok: true, value: T } | { ok: false, error: unknown }) => void
}

/** 队列此刻的样子（给界面 / 健康检查看）。 */
export interface RunQueueStats {
  /** 并发上限。 */
  limit: number
  /** 正在跑几份。 */
  running: number
  /** 排队中几份。 */
  queued: number
  /** 正在跑或排队的工作流名（按入队顺序）。 */
  keys: string[]
}

/** 队列对象。 */
export interface RunQueue {
  /**
   * 排一份活进去（并发没满就立刻开跑）。
   *
   * @param key - 去重键（工作流名）。
   * @param job - 要做的。
   * @returns 与 `job()` 相同的结果；被拒（同名已在跑/排队）时 reject 一句可读的错。
   */
  run: <T>(key: string, job: () => Promise<T>) => Promise<T>
  /** 这份工作流在跑或在排吗。 */
  has: (key: string) => boolean
  /** 此刻的样子。 */
  stats: () => RunQueueStats
  /**
   * 改并发上限。
   *
   * ⚠️ **调小不会砍掉正在跑的**：已开跑的照常跑完，新的一批按新上限放行。
   * 中途砍掉正在跑的工作流属于「中断」，那是另一件事（要显式取消接口）。
   *
   * @param limit - 新的上限（小于 1 按 1 处理）。
   */
  setLimit: (limit: number) => void
}

/**
 * 建一个工作流级队列。
 *
 * @param limit - 同时最多跑几份（默认 2；小于 1 按 1）。
 * @returns 队列。
 */
export function createRunQueue(limit = 2): RunQueue {
  /** 当前上限。 */
  /* ⚠️ 非法值要有兜底，且**不能兜成「无限并发」**：
   *   · 非数字（NaN / Infinity）→ 当默认 2；
   *   · 数字但小于 1（0 / -5）→ 当 1（**不是** 2，也不是「不限」）。
   * 两条分开写，因为它们的意图不同：前者是「没给」，后者是「给了个无效值」。 */
  let max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 2
  /** 正在跑的键（去重用）。 */
  const active = new Set<string>()
  /** 排队中的活（先进先出）。 */
  const pending: Job<unknown>[] = []
  /** 正在跑的份数（= active 里「真跑起来」的那些；排队时也算占位，见 run）。 */
  let runningCount = 0

  /** 放行下一批（能开几个开几个）。 */
  const pump = (): void => {
    while (runningCount < max && pending.length > 0) {
      const job = pending.shift() as Job<unknown>
      runningCount += 1
      job.start()
      /* ⚠️ **先减水位、再交结果**（2026-10-21 被测试抓出来的顺序问题）：
       * 原来把 `runningCount -= 1` 放在 `.finally()` 里，而 `.finally` 在
       * `resolve()` **之后**才跑 —— 于是「await 完这一次立刻看 stats」会看到
       * 它还在跑（`running: 1`）。用户视角是「跑完了列表还显示在跑」。
       *
       * 顺序：减水位 → 交结果 → 放行下一批。三者都不可换。 */
      const settle = (r: { ok: true, value: unknown } | { ok: false, error: unknown }): void => {
        runningCount -= 1
        job.finish(r)
        pump()
      }
      void job.run().then(
        (value) => settle({ ok: true, value }),
        (error) => settle({ ok: false, error }),
      )
    }
  }

  return {
    run<T>(key: string, job: () => Promise<T>): Promise<T> {
      const name = key === '' ? '(未命名)' : key
      if (active.has(name)) {
        /* ⚠️ 这句错要**说清是同一份**，否则用户会以为「点了没反应」。 */
        return Promise.reject(new Error('这份工作流已经在跑或在排队了，别叠着开：' + name))
      }
      active.add(name)
      return new Promise<T>((resolve, reject) => {
        const entry: Job<T> = {
          key: name,
          run: job,
          start: () => { /* 立刻放行时也要走同一条路 —— 下面 pump 里会调 */ },
          finish: (r) => {
            /* ⚠️ **先摘掉占位再 resolve**（2026-10-21 被测试抓出来的顺序问题）：
             * 原来摘占位放在 `.finally()` 里，而 `resolve()` 先执行 ——
             * 于是「`await` 这一次跑完之后立刻用同一个名字再排一份」会**被自己拒掉**
             * （`active` 里还留着刚跑完的那个键）。
             * 用户视角就是「明明跑完了，再点却说已经在跑」。
             *
             * ⚠️ 判 `'error' in r` 而不是 `!r.ok`：本项目 tsconfig 关着 `strict`，
             * 那种模式下 TypeScript 不按布尔字面量收窄联合类型（见 `run.ts` 里同一条说明）。 */
            active.delete(key)
            if ('error' in r) reject(r.error)
            else resolve(r.value)
          },
        }
        /* 排队是**先入队再 pump**：并发没满时 pump 会立刻把它捞出来，
         * 于是「立刻开跑」与「等前面跑完」走的是同一条代码路径（不写两份）。 */
        pending.push(entry as Job<unknown>)
        pump()
      })
    },
    has(key: string): boolean {
      return active.has(key)
    },
    stats(): RunQueueStats {
      return {
        limit: max,
        running: runningCount,
        queued: pending.length,
        keys: [...active],
      }
    },
    setLimit(next: number): void {
      max = Number.isFinite(next) && next >= 1 ? Math.floor(next) : 1
      pump()
    },
  }
}

/**
 * 全局队列（宿主半用这一个）。
 *
 * ⚠️ 为什么是**模块级单例**而不是每次新建：并发上限管的是**整个进程**的负载
 * （浏览器、子进程），每个入口各建一个队列等于没有上限。
 *
 * @param limit - 只在第一次调用时生效（之后用 `setLimit` 改）。
 * @returns 队列。
 */
let shared: RunQueue | null = null
export function sharedRunQueue(limit?: number): RunQueue {
  if (shared === null) shared = createRunQueue(limit ?? 2)
  else if (limit !== undefined) shared.setLimit(limit)
  return shared
}
