/** 节点注册表（**唯一的汇总点**）。
 *
 * ## 为什么是「一个节点一个目录」
 *
 * 用户 2026-10-12 定为**项目基础的文件规划**：
 * > 「内置节点都做成文件夹，这是标准，相对独立。……因为后期是希望一切皆工作流，
 * >   所以节点是核心之一，必须清晰，所以**所有节点一个目录，每个节点单独目录**。」
 *
 * 布局（照 `plans/2026-10-08-板块范式与目录规划.md` §2）：
 *
 * ```
 * src/nodes/<分类>/<节点名>/
 *   ├── node.ts     节点定义（纯数据；客户端与宿主半共用这一份）
 *   ├── impl.ts     实现（宿主半用；可选）
 *   └── deps.json   依赖声明（可选）
 * ```
 *
 * ## ⚠️ 加节点要在这里补一行（如实说明，别当它不存在）
 *
 * 规划里写的是「加节点 = 加目录，**无需改注册表**」。那条**在打包后做不到**：
 * 动态扫目录要求「每个节点单独产出一个 .js」，而现在是全部打进 `lib/index.js`
 * （`import.meta.glob` 那类约定要么依赖 Vite、要么依赖运行时有源码目录）。
 *
 * 折中：把那一行**集中到本文件**。所以「加节点 = 加目录 + 在这里加一行」，
 * 而不是像以前那样散在三个文件里、有 6 个导出要同步。
 * 要真做到零改动，得改构建配置（每节点独立产物 + 运行时按路径加载）——见计划 §六。
 *
 * ## 两份导出，别搞混
 *
 * - `NODE_LIBRARY`：**定义**（纯数据）。客户端渲染节点库与表单用它。
 * - `NODE_IMPLS`：**实现**。宿主半派发时按节点 id 查它。客户端**不要**引它
 *   （实现里会 import Node 内置模块，打进客户端体积且没意义）。
 */

import type { NodeDef } from '../workflow/model.ts'

/* ── ① 定义：顺序 = 节点库里的显示顺序（与搬迁前一致，别随手重排）──
 *
 * 顺序即节点库里的显示顺序（浏览器 → 代码 → 电商 → 终端 → 流程 → AI → 数据）。
 *
 * ⚠️ **2026-10-12 删掉了 10 个「只有定义、没有实现、也没验证过」的节点**
 * （用户定：「哪些本来就是搜集的通用节点，没验证过的，重复就把他们删了」）：
 *   - 采集族 5 个（`collect.open/list/detail/paginate/parsehtml`）——
 *     全都只有定义；其中 `collect.open`（打开页面）与「浏览器」节点的
 *     「打开页面」动作**重复**，一并删掉；
 *   - 旧浏览器族 5 个（`browser.click/input/wait/screenshot/eval`）——
 *     被一个「浏览器」节点（动作是下拉）取代，照 n8n 的形态。
 * 删掉的理由不是「功能不要」，而是**它们从未被实现过**（点了会失败），
 * 留着只会让人以为能用。要加回来时按新目录规范加即可。
 *
 * ⚠️ **2026-10-27 又删了六个**（票 21，判定写在票的评论里）：
 *   - `ecom.product.get` / `ecom.sku.update` / `ecom.order.pull` / `ecom.image.gen` ——
 *     走 http 执行方但**定义里没有 url、没有 toCommand**，命令体永远是 `{url:""}`。
 *     要真做需要「哪家平台的哪个接口 + token 怎么来 + 字段怎么映射」，三件全没定过；
 *   - `ecom.copy.gen` —— 已被 `ai.agent` 覆盖（那个有 system / prompt / input 三段）；
 *   - `data.map` —— 纯数据加工，按 `AGENTS.md` 的硬规则该用 `code.js`。
 * **`flow.merge` 没删，补了实现** —— 理由见 `src/dispatch/builtins.ts` 的 `mergeFn`：
 * 引擎里有两处报错文案把用户指向它，节点不存在的话那两句就是假话。 */
import { NODE as browserAct } from './browser/act/node.ts'
import { NODE as browserDownload } from './browser/download/node.ts'
import { NODE as codeJs } from './code/js/node.ts'
import { NODE as codePython } from './code/python/node.ts'
import { NODE as codeShell } from './code/shell/node.ts'
import { NODE as sysFsRead } from './terminal/fs-read/node.ts'
import { NODE as sysFsWrite } from './terminal/fs-write/node.ts'
import { NODE as sysHttp } from './terminal/http/node.ts'
import { NODE as flowStart } from './flow/start/node.ts'
import { NODE as flowEnd } from './flow/end/node.ts'
import { NODE as flowIf } from './flow/if/node.ts'
import { NODE as flowLoop } from './flow/loop/node.ts'
import { NODE as flowMerge } from './flow/merge/node.ts'
import { NODE as flowWorkflow } from './flow/workflow/node.ts'
import { NODE as flowDelay } from './flow/delay/node.ts'
import { NODE as flowParallel } from './flow/parallel/node.ts'
import { NODE as flowNotify } from './flow/notify/node.ts'
import { NODE as flowAlertWait } from './flow/alert-wait/node.ts'
import { NODE as flowWait } from './flow/wait/node.ts'
import { NODE as aiAgent } from './ai/agent/node.ts'

/** 通用节点库（顺序即节点库里的显示顺序）。 */
export const NODE_LIBRARY: readonly NodeDef[] = [
  browserAct, browserDownload,
  codeJs, codePython, codeShell,
  sysFsRead, sysFsWrite, sysHttp,
  flowStart, flowEnd, flowIf, flowLoop, flowMerge, flowWorkflow, flowDelay, flowParallel, flowNotify, flowAlertWait, flowWait,
  aiAgent,
]

/**
 * ⚠️ **本文件只导出「定义」**，不导出实现 ——
 * 客户端要用节点定义渲染节点库与表单，而实现里会 import Node 内置模块
 * （`node:fs` 等），打进客户端体积且毫无意义。
 *
 * 实现表在 `./impls.ts`，**只由宿主半引**（`src/index.ts`）。
 * 两者分开是刻意的：一个入口只给一侧用，谁引错了在构建期就能看出来。
 */
