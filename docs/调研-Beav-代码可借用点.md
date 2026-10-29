# Beav 源码调研：什么时候该看哪个文件（2026-10-06）

> 对象：`refs-projects/Beav/`（本地 git HEAD `f35befd`，无 tag）
> 方法：结论全部来自实际读文件；路径均相对 **Beav 仓库根**，行号已核对。
> 委托人项目：电商 AI 工作台（dsh 插件，React + TS，一切执行皆工作流 / 一切板块皆插件）

---

## 0. 一个会改变结论的前提（已验证）

**源码树停在 2.5.0，根目录 CHANGELOG 却写到了 2.8.13。**

| 证据 | 内容 |
|---|---|
| `desktop/README.md:1` | "Beav · Tauri **2.5.0** source" |
| `desktop/package.json:5` | `"version": "2.5.0"` |
| `desktop/src-tauri/Cargo.toml:3` | `version = "2.5.0"` |
| `CHANGELOG.md`（根） | 记到 v2.8.13（2026-10-06） |
| 全目录 grep `去 AI 元数据` / `Live Photo` / `字幕提取器` / `账号运营规划` | **0 命中** |

**所以：委托清单里的「图片去 AI 水印」「图片转 Live 图」，开源版里没有代码，只有更新日志的文字描述。** 想看它们的实现，这个仓库给不了。

---

## 1. 一句话结论

- **最有用**：`desktop/src-tauri/src/commands/media_transcribe.rs` 和 `desktop/src-tauri/src/voice_service.rs`——把「本地文件 → ffmpeg 预处理 → 调外部 HTTP → 落地产物」这条链路（含重试、降级、产物登记）写得很干净，可直接拆成我们的 `shell` + `http` 节点。
- **第二有用**：`Plugin/src/xhsBridge.js` + `Plugin/src/background.js:4326-4647`——小红书素材下载的真实做法，它暴露了一个关键依赖：**要的是一个「已登录的浏览器」，不是 API key**。
- **第三有用**：`desktop/src-tauri/src/commands/plugin/manifest_primitives.rs`——一份现成的「插件能力白名单 + UI 槽位白名单」，对「一切板块皆插件」的权限边界有直接参考价值。
- **最没用**：`desktop/src/pages/*` 那批 20 万字节的巨型 tsx、`src-tauri/src/acp_gateway/`、`desktop/remotion/`、`desktop/src/vendor/freecut/`。与电商工作台无关。

---

## 2. 可借用清单（核心产出）

| 我们要做什么 | 看它的哪个文件（相对路径 + 行号） | 借什么 | 工作量估计 |
|---|---|---|---|
| **音视频转文字 / 字幕节点** | `desktop/src-tauri/src/commands/media_transcribe.rs:113-158`（抽音频）`164-213`（三级降级）`215-296`（主流程）；`desktop/src-tauri/src/desktop_io.rs:69-180`（HTTP） | **抄逻辑** | 小，约 2 天 |
| 无时间戳时「估算字幕」 | `desktop/src-tauri/src/commands/media_transcribe/subtitles.rs:13-88` | 抄逻辑 | 小，0.5 天 |
| **AI 配音（TTS）节点** | `desktop/src-tauri/src/voice_service.rs:306-386`（取配置）`1662-1757`（请求体）`1880-2023`（主流程） | 抄逻辑 + 抄请求体 | 小，约 1 天 |
| 音色克隆 | `voice_service.rs:941-1022`（样本预处理）`1022-1229`（clone） | 抄结构 | 中，3 天 |
| **素材下载（小红书）** | `Plugin/src/xhsBridge.js:65-118`（劫持 fetch/XHR）；`Plugin/src/background.js:3475-3505`（页面内执行）`4751-4785`（字段映射）`4525-4537`+`4357-4373`（带 cookie 下载）`4431+`（手写 ZIP） | **抄逻辑**（注意依赖浏览器） | 中，3-5 天 |
| **定时 / 日历** | `desktop/src-tauri/src/scheduler/mod.rs:55-83`（下次触发时间）`608-663`（调度循环）`664+`（job runner）；`scheduler/README.md`；`desktop/src/pages/Automation.tsx:32-67`、`551-600`（计划 UI） | 抄结构 | 中，2-3 天 |
| **板块插件机制** | `desktop/src-tauri/src/commands/plugin/manifest_primitives.rs:34-65`（能力白名单）`67-80`（UI 槽位）`86-102`（数据源）`115-130`（域名校验）；`commands/plugin/manifest.rs:3-32`（路径安全）`61-120`（校验） | **抄结构**（照抄清单） | 小，1 天 |
| 节点注册表 | `desktop/src-tauri/src/tools/catalog.rs:38-51`（`ActionDescriptor` 定义）`6269-6333`（描述符实例）`61-90`（runtimeMode 分组） | 抄结构 | 小，1 天 |
| 派发器 / 路由 | `desktop/src-tauri/src/tools/executor.rs:48-105`；`tools/registry.rs`、`tools/packs.rs`、`tools/guards.rs`、`tools/router.rs` | 仅参考 | 中 |
| 前端 IPC 分层 | `desktop/src-tauri/src/commands/IPC-GUIDE.md`（全文）；`desktop/src/bridge/domains/mediaBridge.ts`（30 行示例） | 仅参考 | 0 |

---

## 3. 关键实现解读

### 3.1 音视频转文字 —— 最能直接落成节点的一条

流程（`media_transcribe.rs:215-296`）：
1. 解析本地 `sourcePath`（`:18-41`）；
2. **ffmpeg 抽音频**：固定 `-vn -ac 1 -ar 16000 -acodec pcm_s16le` 输出 wav（`:113-158`）——16k 单声道是 ASR 通用最优解，照抄；
3. **curl 多部分上传**：`-F model= -F file=@path;type=audio/wav -F response_format=`，`Authorization: Bearer`（`desktop_io.rs:124-180`）；
4. **3 次重试 + 1s/3s 退避**（`desktop_io.rs:69-122`）；
5. **三级降级**（`media_transcribe.rs:164-213`）：直接要 srt → 退到 `verbose_json` 用 segments 自己拼 → 再退到纯文本 + 按标点/字数估算时间轴（`subtitles.rs:13-88`）。

**能不能用**：能，**这是最干净的「http 节点 + shell 节点」样板**。它证明了只要目标是 OpenAI 兼容的 `/audio/transcriptions`，就不需要绑定任何具体厂商。
**注意**：它把 HTTP 调用交给了 **外部 curl 进程**而不是 HTTP 库（`desktop_io.rs:133`）——这点别抄，我们用 `http` 节点直接发。
**依赖**：ffmpeg sidecar（`tauri.conf.json:84-87` `externalBin`，解析逻辑 `src-tauri/src/ffmpeg_runtime.rs:74-88`：先找打包目录再找 PATH）+ 任意兼容转写接口。**不需要 key 以外的本地程序**。

### 3.2 AI 配音 —— 请求体就是一份现成的适配器规格

`voice_service.rs:1662-1757` 的 `build_speech_request_body` 是一份按模型能力裁剪的字段表：基础字段 `model/input/voice_id/response_format/return_audio_binary`，可选 `prompt`（仅 CosyVoice 系）、`emotion`（仅支持的模型）、`speed/pitch/language_hints/add_silence/audio_setting`。模型判定在 `:58-73`，配置解析在 `:306-386`（payload → 路由 → 设置项 → 官方兜底）。
**能不能用**：能。**这就是我们要的「执行方适配器」的具体形态**：一份「能力表 + 按能力裁剪请求体」的逻辑，而不是为每个厂商写一个适配器类。
**注意**：`:1902-1920` 有一段音色与模型绑定校验（音色绑到 A 模型就不能用在 B 模型上）——做多供应商时这个坑真实存在，建议照抄。

### 3.3 小红书素材下载 —— 它依赖浏览器，不是 API

三步：
1. **注入页面主世界**劫持 `window.fetch` 和 `XMLHttpRequest`，把小红书域名的 JSON 响应存进 `window.__REDBOX_XHS_RESPONSES__`（`xhsBridge.js:65-118`，最多 120 条）；
2. 后台用 `chrome.scripting.executeScript({world:'MAIN'})` 在页面里跑提取函数（`background.js:3475-3505`），从 `noteCard.image_list[].urlDefault` 取图、从 `video.media.stream.h264[].master_url` 按体积排序取视频（`:4751-4785`）；
3. 下载走 `fetch(url, {credentials:'include'})` 复用登录态，或直接交给 `chrome.downloads`（`:4525-4537`、`:4357-4373`）；多图打包是**手写 ZIP**（`:4431+`，自己算 CRC32）。

**能不能用**：**逻辑能用，形态不能照搬。** 我们的「素材下载节点」不能假设有一个浏览器；要么用同样的「先拿页面接口数据、再带 cookie 直链下载」思路配一个浏览器执行方，要么放弃小红书这种纯前端方案。
**注意**：这套完全绕开官方 API、靠登录 cookie，稳定性和合规性都由对方页面结构决定（它为此专门留了 `isLivePhotoNote` 之类的兼容分支，`background.js:6637` 与 `:9247` 重复定义了一次，说明这里在打补丁）。

### 3.4 插件机制 —— 清单式白名单，直接抄

`manifest_primitives.rs` 用 4 个硬编码清单收口插件能做什么：
- 能力：`ai.skill / mcp.server / knowledge.read / media.process / network.request.scoped / pluginData.read|write / ui.settingsPanel ...`（`:34-65`）；
- UI 槽位：`settings / home / manuscriptSidebar / videoInspectorPanel / commandPaletteCommand ...`（`:67-80`）；
- 首页数据源与控件类型（`:82-102`）；
- 网络域名白名单校验：禁 `://`、`/`、`*`（`:115-130`）。

配套的路径安全在 `manifest.rs:3-32`：插件内资源必须 `./` 开头、禁止 `..`。清单文件名支持 `.codex-plugin / .claude-plugin / .redbox-plugin / .thrive-plugin / plugin.json`（`commands/plugin.rs:74-80`）。
**能不能用**：能，**这是我们「板块插件」最该抄的一处**——不是抄它的运行时，而是抄「**能力/槽位/域名三张白名单 + 路径必须相对且不含 ..**」这套收口方式。

---

## 4. 不借的部分

- **整个 Tauri/Rust 宿主**：`src-tauri/src/host_impl.rs`（**409 KB**）、`media_runtime/mod.rs`（220 KB）、`tools/catalog.rs`（314 KB）、`tools/compat.rs`（150 KB）。体积本身就说明它们是历史堆积，不是设计。
- **`desktop/src/pages/*`**：Settings.tsx 400 KB、Subjects.tsx 302 KB、GenerationStudio.tsx 225 KB。这种巨型组件是反面教材。
- **`desktop/remotion/`、`desktop/src/vendor/freecut/`、`src-tauri/src/acp_gateway/`、`manuscripts/`**：视频剪辑与外部 Agent 协议，与电商工作台无关。
- **`tools/compat.rs` 的兼容层**：它自己的 `tools/README.md:39-49` 明说「compatibility alias 已从主执行路径硬切移除」。看它的**结论**（`tools/README.md:32-49` 的治理规则）就够了，不要看实现。
- **图片去 AI 水印 / 图片转 Live 图**：**源码里没有**（见第 0 节），不要浪费时间找。
- **`scripts/`（根）**：只有一个 GitHub release 下载量统计脚本，无价值。

---

## 5. 未获取 / 未验证

- **未获取**：图片去 AI 元数据、图片转 Live 图的实现（源码不含，仅 `CHANGELOG.md:296-297` 的文字描述）。
- **未获取**：「创作小工具」的独立窗口框架（`CHANGELOG.md:239` 提到），源码中未找到对应模块。
- **未验证**：以上工具在 2.8 正式版中的实现；本仓库只是 2.5.0，正式版在「独立代码基础上迭代」（`README.md:231`）。
- **未验证**：`desktop/src-tauri/binaries/` 下只有 FFmpeg 的许可证与说明文本，**实际 ffmpeg/ffprobe 二进制未随源码提供**（`desktop/src-tauri/binaries/README.md`），故无法实跑验证转写链路。
- **未运行**：本次为静态阅读，未编译、未执行任何 Beav 代码。
