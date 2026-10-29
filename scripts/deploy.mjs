/** 把刚构建好的 `lib/` 同步到**部署目录**。
 *
 * ## 为什么需要这一步
 *
 * ⚠️ **改了代码、跑了 `npm run bundle`，桌面端看到的还是旧版本** ——
 * 这是本项目**最容易白干活**的一个坑（已踩过两次）：
 *
 *   - 插件在 `profiles/desktop/package.json` 里是 `file:` 依赖；
 *   - 而 `profiles/desktop/pnpm-workspace.yaml` 是 `nodeLinker: hoisted`；
 *   - 两者合起来 = pnpm 把插件**复制**一份到
 *     `profiles/desktop/node_modules/@our/ecom-workbench/`，
 *     **不是符号链接**。
 *
 * 所以源码目录里的 `lib/client.js` 与部署目录里那份是**两个不同的文件**。
 * 改完源码只跑 `npm run bundle`，改的是前者；桌面端读的是后者 ——
 * 症状是「代码明明改了、测试也全绿，界面上就是没有新东西」。
 *
 * 实测（2026-10-15）：
 * ```
 * 源码  lib/client.js  ino=3659174698027428  size=3818442  ← 刚构建的
 * 部署  lib/client.js  ino=4503599627979835  size=3766226  ← 桌面端实际在读的（旧）
 * ```
 * inode 不同 + 大小不同 = 确实是两份拷贝。
 *
 * ## 为什么这么做是合理的（不是绕过 pnpm）
 *
 * 与 `install-browser-deps.mjs` 同一个理由：这只是**提前做了 `pnpm install`
 * 本来要做的事**（同一位置、同一结果）。`pnpm install` 会重写整个
 * `node_modules/`，而那是**运行中的桌面端正在用的目录**（红线：单写入者）；
 * 本脚本只**覆盖我们插件自己那几个产物文件**，不动别的包，
 * 所以能在桌面端运行时做。
 *
 * ⚠️ **不会倒退**：将来任何一次 `pnpm install` 都会用源码重新复制一份，
 * 结果与这里一致。但**反过来**要注意 —— `pnpm install` 之后要**再跑一次本脚本**
 * 才保证是最新的（因为 pnpm 复制的是它那一刻看到的源码）。
 *
 * 跑法：`node scripts/deploy.mjs`（构建后跑）
 */
import { readdirSync, statSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')
const SRC = join(ROOT, 'lib')
/* 部署根：优先用环境变量（脚本可从任意位置跑），退回「相对本仓库推算」。
 * 我们的源码在 <数据根>/my-dsh-plugins/ecom-workbench，所以上两级就是数据根。 */
const DSH_HOME = process.env.DSH_HOME ?? join(ROOT, '..', '..')
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const DEPLOY = join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@our', 'ecom-workbench')
const DEST = join(DEPLOY, 'lib')

if (!existsSync(SRC)) {
  console.error('找不到构建产物：' + SRC)
  console.error('（先跑 `npm run bundle`）')
  process.exit(1)
}
if (!existsSync(DEPLOY)) {
  console.error('找不到部署目录：' + DEPLOY)
  console.error('（插件还没装到那个 profile？先按 AGENTS.md 的「装插件」走一遍）')
  process.exit(1)
}

/* ⚠️ 先确认「部署目录确实是一份拷贝」而不是符号链接。
 * 哪天有人把依赖改成 `link:`，本脚本就该退化成空操作 ——
 * 那时继续拷反而会把源码目录里的东西搅乱（link 模式下两边是同一份）。 */
const srcStat = statSync(join(SRC, 'index.js'))
const dstIndex = join(DEST, 'index.js')
if (existsSync(dstIndex) && statSync(dstIndex).ino === srcStat.ino) {
  console.log('部署目录与源码是同一份（符号链接）—— 不用同步。')
  process.exit(0)
}

console.log('源码：' + SRC)
console.log('部署：' + DEST)
console.log('')

/* 整个 lib/ 镜像过去：`index.js` / `client.js` 是产物，
 * `nodes/browser/driver.mjs` 是运行期脚本（由 copy-runtime.mjs 放进来的）。
 * 先清掉再拷，避免旧文件残留造成「版本混杂」这种极难查的问题
 * （与 install-browser-deps.mjs 同一个理由）。 */
mkdirSync(DEST, { recursive: true })
for (const name of readdirSync(DEST)) {
  rmSync(join(DEST, name), { recursive: true, force: true })
}
cpSync(SRC, DEST, { recursive: true })

let n = 0
let bytes = 0
for (const name of readdirSync(DEST)) {
  const p = join(DEST, name)
  const st = statSync(p)
  if (st.isDirectory()) {
    const sub = listFiles(p)
    n += sub.count
    bytes += sub.bytes
  } else {
    n += 1
    bytes += st.size
  }
}
console.log('同步了 ' + String(n) + ' 个文件（' + String(Math.round(bytes / 1024)) + ' KB）')
console.log('')
console.log('⚠️ 客户端改动要刷新页面才生效（宿主半改动要重启桌面端）。')

/**
 * 数一个目录下的文件数与总字节数。
 * @param {string} dir - 目录。
 * @returns {{count: number, bytes: number}} 统计结果。
 */
function listFiles(dir) {
  let count = 0
  let bytes = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = listFiles(p)
      count += sub.count
      bytes += sub.bytes
    } else {
      count += 1
      bytes += statSync(p).size
    }
  }
  return { count, bytes }
}
