/** 把「运行期脚本」复制到 `lib/`（构建的一部分）。
 *
 * ## 为什么需要这一步
 *
 * 浏览器节点要起一个子进程跑 playwright，那段脚本是 **`.mjs` 运行期脚本**，
 * 不是插件源码 —— 它不参与 tsc、也不该被打包器分析（它 `import('playwright')` 是运行时的）。
 *
 * 但它**必须放进 `lib/`**，因为一个实测出来的硬约束：
 *
 * > **Node 找 `node_modules` 是从「脚本所在位置」往上找，不看 cwd。**
 * > 实测：脚本放 `$DSH_HOME/tmp/` 跑 → `ERR_MODULE_NOT_FOUND`；
 * > 放插件自己的 `lib/` 下 → 能找到。
 *
 * 而部署目录（`profiles/<x>/node_modules/@our/ecom-workbench/`）里**只有 `lib/` 与
 * `node_modules/`**（没有 `src/`）—— 所以脚本必须在 `lib/` 里，不能指望源码目录。
 *
 * 跑法：`npm run bundle` 会自动调它（见 package.json 的 scripts）。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\//, '')
const LIB = join(ROOT, 'lib')

/** 要复制的运行期脚本（源 → lib 里的相对路径）。 */
const FILES = [
  ['src/nodes/browser/driver.mjs', 'nodes/browser/driver.mjs'],
]

let n = 0
for (const [from, to] of FILES) {
  const src = join(ROOT, from)
  const dst = join(LIB, to)
  try {
    const text = readFileSync(src, 'utf8')
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, text, 'utf8')
    n += 1
    console.log('  复制 ' + from + ' → lib/' + to)
  } catch (e) {
    /* 缺失要**报错退出**：静默跳过会让「浏览器节点跑不起来」变成运行期才发现的问题。 */
    console.error('  复制失败 ' + from + '：' + (e?.message ?? e))
    process.exit(1)
  }
}
console.log('运行期脚本已复制 ' + n + ' 个到 lib/')
