/** 钉住测试环境跑在**真机那个 React 大版本**上（18.x）。
 *
 * ## 为什么需要这个文件（2026-10-26）
 *
 * 起因：本仓库 `package.json` 里**从来没声明过 `react`**（只有 `@types/react`），
 * 于是 npm 装了 `@xyflow/react` 自带的依赖，整棵树去重到 **React 19.3.0**。
 * 而真机（dsh 桌面端）共享的是 **React 18.3.1**
 * （`refs/deepseek-harness@62962ee4/pnpm-lock.yaml` 的 `react@18.3.1`，
 * `packages/client/web/package.json:40` 写 `^18.2.0`，且在 `PLATFORM_MODULES`
 * 里作为**唯一一份**共享给所有插件 —— 见 `refs/.../packages/client/web/src/platform.ts:8-17`）。
 *
 * 后果：`dom-render`、`content-canvas`、`prompt-library` 这些**真挂 DOM 的测试
 * 全都在 React 19 上跑**，而真机是 18。同一份代码两个宿主，是经典的假绿来源：
 * 测试会替真机做它不会做的决定。
 *
 * ## 现在怎么办
 *
 * `package.json` 的 `devDependencies` 显式钉了 `react@18.3.1` / `react-dom@18.3.1`。
 * 本文件是它的**看门人**：谁哪天顺手 `npm i react@latest`，这里立刻红，
 * 而不是等真机上出事。
 *
 * ⚠️ **为什么不写成 `>=18`**：真机就是 18.3.1 这一版。写 `>=18` 会让 19 也通过，
 * 那就等于没钉。要验的是「与真机同大版本」，不是「比 18 新」。
 *
 * ## 这条断言能不能变红（自证过）
 *
 * 把 `package.json` 里那两条改成 `"react": "19.3.0"` 再 `npm install`，本文件立刻红
 * （`React.version` 变成 19.x 那两行）。验完已还原。
 *
 * ## 为什么每条都要打版本号
 *
 * 失败时最想知道的就是「我这台机器上到底是哪个版本」。只打 `✗` 的话，
 * 查的人还得自己再去跑一次 `require('react').version`。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const react = require('react')
const reactDom = require('react-dom')
const manifest = require('../package.json')

console.log('')
console.log('=== 测试环境的 React 大版本必须与真机一致（18.x）===')

/* ── ① 实际加载到的版本 ── */
check('★★ `react` 加载到的是 18.x（真机版本）',
  String(react.version).startsWith('18.'),
  'React.version = ' + String(react.version))

check('★★ `react-dom` 也是 18.x（两个大版本必须配对，不配对会 Invalid hook call）',
  String(reactDom.version).startsWith('18.'),
  'react-dom = ' + String(reactDom.version))

check('★ react 与 react-dom 的小版本一致（18.x 对 18.x，不能 18.2 对 18.3）',
  String(react.version) === String(reactDom.version),
  String(react.version) + ' vs ' + String(reactDom.version))

/* ── ② 声明层：`package.json` 里必须写着它 ──
 * 只验「加载到 18」不够：那可能只是某个包碰巧带了一份 18 进来，
 * 而 npm 一次 dedupe 就会变。声明写死了才算钉住。 */
const declared = manifest.devDependencies?.react ?? ''
check('★★ `package.json` 的 devDependencies 里声明了 react（不能只靠传递依赖）',
  declared !== '', 'devDependencies.react = ' + JSON.stringify(declared) + '（缺省说明没声明）')

check('★★ 声明的不是范围而是**那一个版本**（`>=18` / `^18` 会让 19 也通过）',
  /^18\.\d+\.\d+$/.test(declared), 'devDependencies.react = ' + JSON.stringify(declared))

check('★ react-dom 也声明了同一个版本',
  (manifest.devDependencies?.['react-dom'] ?? '') === declared,
  'react-dom = ' + JSON.stringify(manifest.devDependencies?.['react-dom'] ?? ''))

/* ── ③ 树里不许有第二份 react（两份 = Invalid hook call，且测试怎么绿都不代表真机）
 *
 * 判据取「`react` 的解析路径里只有一份 node_modules/react」——
 * 嵌套的第二份会出现在 `node_modules/<某个包>/node_modules/react`。 */
{
  const { readdirSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ROOT = 'node_modules'
  const nested = []
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    /* 作用域包（@ant-design 这类）要再下探一层。 */
    const dirs = entry.name.startsWith('@')
      ? readdirSync(join(ROOT, entry.name), { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => join(ROOT, entry.name, e.name))
      : [join(ROOT, entry.name)]
    for (const dir of dirs) {
      if (existsSync(join(dir, 'node_modules', 'react', 'package.json'))) nested.push(join(dir, 'node_modules', 'react'))
    }
  }
  check('★★ 依赖树里只有一份 react（嵌套第二份会导致 Invalid hook call）',
    nested.length === 0, nested.length === 0 ? '只有一个（顶层）' : nested.slice(0, 3).join(' | '))
}

console.log('')
console.log(failed === 0 ? '结论：测试跑在真机同款 React ' + String(react.version) + ' 上 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
