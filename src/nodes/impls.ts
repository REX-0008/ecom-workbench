/** 节点**实现**表（节点 id → 在 dsh 进程内直接跑的函数）。
 *
 * ⚠️ **只有宿主半引本文件**（客户端只引 `./index.ts` 拿定义）。
 * 理由：这里会拉进 `node:fs` 这类 Node 内置模块，打进客户端毫无意义。
 *
 * ## 什么该在这里
 *
 * 只有「**必须在本程序里做**」的节点：读文件、写文件、等待、跑一小段代码、条件分流。
 *
 * 不该在这里的两类：
 *   - **要起子进程的**（跑 shell / python / 浏览器）→ 走 `shell` 执行方，
 *     它们的「实现」是**拼一条命令**（见 `workflow/command.ts` 的通用约定），
 *     真正的代码住在那条命令指向的脚本里。
 *   - **循环（`flow.loop`）** → 由调度器解释执行（见 `workflow/loop.ts`），
 *     它不是「派发一个节点」。放进这张表反而会被当成 builtin 去派发。
 *
 * ## 加节点要在这里补一行
 *
 * 与 `./index.ts` 同样的取舍（打包后无法零改动自动收集），见那里的说明。
 */
import type { BuiltinFn } from '../dispatch/executors.ts'
import { readFileFn, writeFileFn, delayFn, runCodeFn, branchFn, mergeFn } from '../dispatch/builtins.ts'
import { browserActFn } from './browser/impl.ts'
/* 通知：按提醒档位决定发不发。档位读取在 `src/notify/prefs.ts`，**静态引入** ——
 * 打包后动态 import 的相对路径按 `lib/` 解析不到那个文件；静态引入还能让
 * `check:types` 在那边改返回形状时当场抓住（形状契约由类型系统守，运行期只做容错回落）。 */
import { notifyFn } from './flow/notify/impl.ts'

/** 内置实现表。 */
export const NODE_IMPLS: ReadonlyMap<string, BuiltinFn> = new Map<string, BuiltinFn>([
  ['sys.fs.read', readFileFn],
  ['sys.fs.write', writeFileFn],
  ['flow.delay', delayFn],
  ['code.js', runCodeFn],
  /* 条件判断：返回带 `__handle` 的输出，调度器据此知道哪条分支走了（见 workflow/branch.ts）。 */
  ['flow.if', branchFn],
  /* 浏览器：宿主半自己拼 argv、起子进程跑驱动脚本。
   * 为什么是 builtin 而不是 shell（驱动脚本路径只有宿主半知道）见 `browser/impl.ts`。
   * ⚠️ 「浏览器-playwright」与「下载-playwright」两个节点共用同一个实现
   * —— 动作由**节点 id** 决定（下载那个没有 action 参数，见 impl.ts 里的说明）。
   * 用户 2026-10-19 明确「下载与浏览器作为两个节点」，所以这里是**两个 id 指向一份实现**，
   * 不是把它们合成一个节点。 */
  ['browser.act', browserActFn],
  ['browser.download', browserActFn],
  /* 并行（`flow.parallel`）**不在这张表里**：它由调度器解释执行
   * （`run.ts` 的 `runParallel`），与循环、子工作流、等待同一类 —— 它要的是
   * 「把框里的成员按图切成几路、并发调度」，内置函数看不见图。
   * 2026-10-22 起它已经真的并行了，占位的直通实现已删。 */
  /* 通知：按档位发不发。判断要不要报交给前面的条件判断节点（用户 2026-10-22 定）。 */
  ['flow.notify', notifyFn],
  /* 合并：把两路数据并成一路（票 21 补上，2026-10-27）。
   * 它原来只有定义、没有实现，而引擎里有两处报错文案把这句指向它 ——
   * 补上之后那两句话才成立（理由见 `builtins.ts` 的 `mergeFn`）。 */
  ['flow.merge', mergeFn],
])
