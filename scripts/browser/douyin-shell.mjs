/** 「抖音表单下载」工作流的 shell 步骤（单一来源：生成器与测试都用）。
 *
 * ## 交接方式与另两份同一条约定
 *
 * `cmd /c` 会剥掉开头的引号、还有长度上限 → **命令行只带短参数**（路径 + 文件夹名）。
 * 这一个脚本**不需要**中间文件：它的入参就是三个短字符串（目录/数据根/文件夹），
 * 出参是「文件名清单」（**条数少、体积小**，可以直接打 stdout）。
 *
 * ## 它干什么
 *
 * 扫某个模块文件夹里已有的 xlsx 文件名 —— 用来算「现有最大日期 L」
 * （照源码 `findLastDate`：文件名里的 `(20\d{2})(\d{2})(\d{2})`）。
 */

/**
 * 列一个模块文件夹里的文件名。
 *
 * 用法：`node dy-list-one.mjs <工作目录> <数据根> <文件夹>`
 *
 * ⚠️ 第 1 个参数（工作目录）**本脚本不用**，但**保留它**是为了与另两份脚本的
 * 命令形状一致（都从 `argv[2]` 起读）—— 少一处「哪个脚本第几个参数是什么」的记忆负担。
 *
 * 出参（stdout 一行 JSON）：`{ ok, folder, files, count }`
 */
export const DY_LIST_ONE = `
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 收口：结果以一行 JSON 打到 stdout（宿主半只认最后一行）。 */
const emit = (obj, fail) => {
  process.stdout.write(JSON.stringify(obj) + '\\n')
  process.exit(fail === true ? 1 : 0)
}

/* argv[2] = 工作目录（本脚本不用，保留是为了命令形状统一）。 */
const dataRoot = String(process.argv[3] ?? '')
const folder = String(process.argv[4] ?? '')
if (dataRoot === '') emit({ ok: false, error: '没给数据根（argv[3]）' }, true)
if (folder === '') emit({ ok: false, error: '没给文件夹（argv[4]）' }, true)

let files = []
try {
  /* ⚠️ 排除 ~$ 开头的 **Office 锁文件**（照原脚本）。 */
  files = readdirSync(join(dataRoot, folder))
    .filter((f) => /\\.(xlsx|xls)$/i.test(f) && !f.startsWith('~$'))
    .sort()
} catch {
  /* ⚠️ 文件夹不存在**不是错**（第一次跑该模块就没有）—— 返回空清单。
   * 那会让下游算出「没有 L」→ 该模块跳过（照源码行为）。 */
  files = []
}
emit({ ok: true, folder, files, count: files.length })
`
