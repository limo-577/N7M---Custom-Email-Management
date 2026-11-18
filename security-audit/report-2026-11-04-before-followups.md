# N7M 邮箱管理 · 安全复核报告

审核日期：2026-11-04（Europe/Rome）。版本：1.3.1。Git 基线：`155123a647539744a9609a5a3fb5d400a83451a8`。

当前 1.3.1 的原安全修复与新分发物已复核，依赖扫描 0 告警；未确认当前源码存在 Critical / High 可利用漏洞。本次新增 CI 发布阻塞及供应链/权限跟进项，敏感文件忽略规则也不再完整。

共 12 项复核事项：7 项已复核通过（含安全加固与当前分发物更新），5 项待跟进；不等于修复了 7 个可直接利用漏洞。CI03 是发布功能故障。

## 问题汇总

| 编号 | 类别 | 严重级别 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| C01 | 代码 | Medium | IPC 主 frame 与精确页面来源校验 | electron/main.cjs:50 | 已复核 |
| C02 | 代码 | Medium | 生产 CSP | vite.config.js:10 | 已复核 |
| C03 | 代码 | Low | Electron 导航与权限边界 | electron/main.cjs:63 | 已复核 |
| S01 | 密钥 | Low | 敏感文件忽略规则不完整 | .gitignore:4、25 | 待跟进 |
| D01 | 依赖 | Medium | minimatch 使用官方修复引擎 | package.json overrides；vendor/minimatch-compat/index.cjs | 已复核 |
| D02 | 依赖 | Medium | uuid 升级 | package.json overrides.uuid | 已复核 |
| C04 | 代码 | Medium | Excel 线程隔离及资源预算 | electron/xlsx-import.cjs；electron/xlsx-worker.cjs | 已复核 |
| D03 | 依赖 | Low | 弃用间接包与 ExcelJS 维护 | package-lock.json deprecated 字段 | 待跟进 |
| C05 | 代码 | Low | 当前 1.3.1 分发物已更新 | release/win-unpacked；1.3.1-NoInstall.zip | 已复核 |
| CI01 | 代码 | Medium | 第三方 Action 未固定提交 | .github/workflows/release.yml:25、28、45、57 | 待跟进 |
| CI02 | 代码 | Medium | 构建 job 拥有写仓库权限 | .github/workflows/release.yml:20 | 待跟进 |
| CI03 | 代码 | Low | CI 打包参数被新入口拒绝 | .github/workflows/release.yml:40；build/build-windows.cjs:63 | 待跟进 |

## 逐项结论、利用条件和方案

**C01 · IPC 主 frame 与精确页面来源校验**（Medium；已复核）

位置：electron/main.cjs:50。来源白名单、解锁与操作代次检查仍保留。

**C02 · 生产 CSP**（Medium；已复核）

位置：vite.config.js:10。禁止内联脚本、eval、外部网络及多余页面能力；样式允许 inline 以兼容界面。

**C03 · Electron 导航与权限边界**（Low；已复核）

位置：electron/main.cjs:63。webview、新窗口、导航与未使用权限限制未回退，sandbox / contextIsolation 保留。

**S01 · 敏感文件忽略规则不完整**（Low；待跟进）

位置：.gitignore:4、25。环境文件和 PEM/PFX/P12 已忽略，但 *.key、email-data.json*、email-vault.json* 不再覆盖；当前无这些敏感文件被跟踪。建议补齐规则，不能再按旧报告称完整修复。

**D01 · minimatch 使用官方修复引擎**（Medium；已复核）

位置：package.json overrides；vendor/minimatch-compat/index.cjs。本地兼容包 1.0.1 委托官方 minimatch 11.0.4；适配旧 CommonJS、glob 7 分段匹配和 Windows 路径，实际匹配不回退旧解析器。

**D02 · uuid 升级**（Medium；已复核）

位置：package.json overrides.uuid。实际锁定 11.1.1；ExcelJS 使用 v4()，原公告针对 v3/v5/v6，未发现项目满足原利用条件，已消除受影响版本。

**C04 · Excel 线程隔离及资源预算**（Medium；已复核）

位置：electron/xlsx-import.cjs；electron/xlsx-worker.cjs。15 秒终止、实际流式解压计量、全部工作表预算、锁定/取消终止与固定错误文案仍保留。

**D03 · 弃用间接包与 ExcelJS 维护**（Low；待跟进）

位置：package-lock.json deprecated 字段。仍有 6 个弃用间接包：boolean、fstream、glob、inflight、lodash.isequal、rimraf；ExcelJS 仍为 4.4.0。弃用与已确认可利用漏洞分别判断。

**C05 · 当前 1.3.1 分发物已更新**（Low；已复核）

位置：release/win-unpacked；1.3.1-NoInstall.zip。包内 13 个应用文件与当前代码/构建一致，ZIP 的 ASAR 和主 EXE 与 win-unpacked 一致。仅结案当前包缺少修复的问题，历史旧包和签名仍另行关注。

**CI01 · 第三方 Action 未固定提交**（Medium；待跟进）

位置：.github/workflows/release.yml:25、28、45、57。使用 @v4 / @v2 可移动标签；若上游标签或发布账户被控制，构建可执行替换后的代码。建议固定经核实的完整提交 SHA，并受控更新。

**CI02 · 构建 job 拥有写仓库权限**（Medium；待跟进）

位置：.github/workflows/release.yml:20。安装依赖、测试和构建均处于 contents: write 的 job。供应链脚本被控制时影响扩大。建议构建只读，标签发布拆到单独的最小写权限 job。

**CI03 · CI 打包参数被新入口拒绝**（Low；待跟进）

位置：.github/workflows/release.yml:40；build/build-windows.cjs:63。已复现 Unsupported build argument: --publish。CI 传 --publish never，而包装器不接受且本来已固定 publish: never；建议去掉多余参数或显式兼容。此项是构建/发布功能故障，不是已证实远程攻击。

## 项目概况与本次范围

Windows 桌面邮箱及浏览器账号管理工具，版本 1.3.1；JavaScript / Electron 45 / React 19 / Vite 8 / Tailwind CSS 3。16 项直接依赖：3 项运行时、13 项开发依赖；React 等在构建时打入界面。锁文件 566 个安装条目，含重复版本与平台可选包。

本次基于 Git 提交 155123a647539744a9609a5a3fb5d400a83451a8，复核 electron/*、src/*、全部测试、依赖与锁文件、构建配置、index.html、README、.gitignore，以及新增 build/* 和 .github/workflows/release.yml。当前已有 Git 与 CI，不沿用旧报告“无 Git / 无 CI”描述。本轮只更新报告和证据，没有改应用源码或修复这些新发现。

未发现后端 API、数据库、浏览器扩展或移动应用；不凭空报告 SQL/NoSQL、服务端 CSRF/SSRF、扩展权限或移动 WebView 漏洞。新增工作流未使用 pull_request_target，也未发现把不可信事件字段直接拼接 shell。

## 本次确认的更新与修复

1.3.1 的启动依赖改为并行准备，重复点击等待资料库和 IPC 初始化；启动反馈与便携版缓存未跳过密码锁，也未降低 scrypt 参数。原 IPC、生产 CSP、导航/权限限制和 Excel 隔离保留。

build/build-windows.cjs 固定 electron-builder 26.18.0 并验证模板接口，只在当前构建进程替换模板。缓存身份由运行文件内容和启动器模板的 SHA-256 生成，拒绝链接/特殊文件，不只依赖版本号和时间戳。

portable-fast.nsi 增加准备互斥、完成标记、必需文件与路径检查，使用新缓存代次，不覆盖正在运行的旧目录。当前 1.3.1 的安装版、便携版和 ZIP 均已生成；不能继续称只有上一轮验证目录中的包。

运行时直接依赖已精简为 ExcelJS、JSZip 和本地 minimatch 兼容包，React / ReactDOM / Lucide 改为开发依赖；打包配置明确排除 ExcelJS 旧浏览器 dist。兼容包版本 1.0.1 与实际官方匹配引擎版本 11.0.4 必须区分。

## 依赖与已知漏洞复核

本次联网完整 npm audit 为 0 告警，包含开发依赖；未用 omit、audit fix --force 或忽略规则掩盖结果。初次 21 项 Moderate 包告警来自两条底层公告，已修复；不能把该历史数字当作当前告警，也不能把零告警当作无未知漏洞保证。

关键实际版本：minimatch-engine alias 对应官方 minimatch 11.0.4、uuid 11.1.1、JSZip 3.10.2、ExcelJS 4.4.0、Electron 45.2.1、Vite 8.3.5。全部直接与锁定安装版本见依赖清单；未在本轮重新升级依赖。

minimatch 公告 GHSA-g3hv-75wg-m249 的修复版为 11.0.1；本项目使用 11.0.4。uuid 公告 GHSA-w5hq-g745-h8pq 的修复支线包括 11.1.1。原 React RSC 公告涉及本项目未安装的 react-server-dom-*；原 Electron/Vite/tar/JSZip 已核对公告范围不适用于当前版本。今日查询结果以 npm-audit-current.json 为准。

6 个弃用间接包仍需跟踪，inflight 还带内存泄漏弃用警告。ExcelJS 4.4.0 的维护状态继续关注；本轮没有重新做发布者身份和全部历史发行包的恶意行为溯源。

## Excel、IPC 与资料库安全边界

XLSX 在主进程管理的单个 Node 工作线程解析：输入 20 MiB，ZIP 最多 512 项，单项/总实际解压量 16/64 MiB；工作表 30 张，每表 50,000 行和 100 列，总单元格 250,000、总字符 4,000,000、单格 32,767 字符。全部表受预算约束，veryHidden 仅在返回时排除。

解析 15 秒超时；取消、锁定、关闭/导航及退出会终止线程，等待终止后释放任务槽。ZIP 预检和解析用同一不可变字节，流式计量实际膨胀，固定错误不回显工作簿内容。V8 老生代 192 MiB 并不是进程 RSS 或 Buffer 总内存硬上限，线程隔离也不是任意代码执行的操作系统沙箱。

资料库继续使用 AES-256-GCM、随机盐/nonce、scrypt 和固定参数验证。浏览器启动使用参数数组及 Profile 白名单，URL 限 HTTP/HTTPS；React 展示转义文本；CSV 防公式前缀且不导出密码/TOTP。未确认这些路径出现安全回退。

## 密钥、Git 历史与忽略规则

本次高置信特征扫描覆盖 49 个当前受跟踪/构建文本文件与 63 个去重的本地 Git 历史文本 blob，未命中所检查的真实密钥特征，当前敏感文件跟踪列表为空。证据仅保存路径/类别，不输出密钥值。

本地 Git 历史确有 440 个 test-results 路径；当前已移除跟踪并忽略，但历史对象仍存在。路径数和去重 blob 数口径不同，不能声称“从未提交测试资料”，也不能把固定测试密码或 RFC TOTP 样例自动认定为真实凭据泄露。

S01 已从完整修复改为待跟进：.env/.env.* 和 PEM/PFX/P12 已忽略，但 *.key、email-data.json*、email-vault.json* 当前未忽略。本次没有发现这些文件实际被跟踪，建议补齐规则。

扫描未包含压缩/加密内部解码、二进制逆向、远端未获取 Git refs 或托管平台保留副本。若真实密钥曾提交或泄露，必须到对应平台作废并重建；只删除文件或增加 .gitignore 不够。

## 分发物、签名与启动缓存

release/win-unpacked/resources/app.asar 实际版本为 1.3.1，8 个 Electron 模块、3 个 dist 文件和 model/mutations 共 13 个应用文件与当前本地字节一致；1.3.1 ZIP 内 ASAR 和主 EXE 摘要与 win-unpacked 一致。打包 package.json 正常裁掉开发/脚本/构建字段，版本、入口和运行时依赖一致。

Setup.exe、Portable.exe 和 win-unpacked 主 EXE 的 Authenticode 状态均为 NotSigned。这表示没有可信发布者签名，不等于程序不能运行；建议正式分发前签名。latest.yml 的 Setup SHA-512 与本地 Setup 一致，但普通摘要不能替代可信签名。

缓存构建身份与较新的 .startup-qa/cached-portable-1.3.1-release-verified.json 对应；该记录的 pass:true、首次约 15.255 秒、缓存约 0.723 秒可关联当前载荷。这是已有 QA 证据，本轮没有重测启动速度，也不把较早失败记录称为全部通过。

缓存复用只检查可写完成标记和必需文件存在，没有每次重新校验所有运行文件。若攻击者已能写同一用户缓存，可替换其运行文件；未发现跨用户写入或提权路径，不将其夸大为远程 High。构建内容哈希和 CRC 均不等于运行时完整性或签名验证。

旧版 1.0～1.3.0 分发物仍存在；本次没有删除、重打包、上传或发布任何安装包，也未做 Setup 安装/升级/卸载验收。远端 Release 是否成功不能由本地文件或静态工作流推断。

## 验证结果与优先跟进

本次 npm test：47/47；单独 node --test build/launcher.test.cjs：4/4；npm run build：成功；源码桌面流程 6/6；当前 release/win-unpacked 的实际打包桌面流程 6/6。共 51 项 Node 测试分两条命令运行，不能把 npm test 本身写成 51 项。

CI03 已用 parseArguments([nsis, portable, zip, --publish, never]) 复现参数拒绝。工作流的 npm run dist:all -- --publish never 与新包装器冲突，包装器本来已固定 publish: never；建议去掉冗余参数或加入明确兼容。当前 npm test / CI 也未包含 4 项启动器测试，应补进常规检查。

先修正 CI 打包参数，再将 Action 固定到经核实的完整 SHA、拆分只读构建和最小写权限发布 job，并补齐敏感文件忽略规则。上述新发现只记录为待跟进，没有在本轮擅自改动你的业务、启动器或发布配置。

其余长期风险：JavaScript 字符串、崩溃转储、交换文件、备份和第三方剪贴板历史不能保证即时擦除；普通删除旧明文不能保证物理擦除；资料库持有者可离线猜测弱密码。

## 全部直接依赖

| 名称 | 清单版本 / 来源 | 类型 |
| --- | --- | --- |
| exceljs | 4.4.0 | 运行时 |
| jszip | 3.10.2 | 运行时 |
| minimatch | file:vendor/n7m-minimatch-compat-1.0.1.tgz | 运行时 |
| @playwright/test | 1.64.1 | 开发 |
| @vitejs/plugin-react | 6.1.0 | 开发 |
| autoprefixer | 10.5.4 | 开发 |
| concurrently | 10.0.6 | 开发 |
| electron | 45.2.1 | 开发 |
| electron-builder | 26.18.0 | 开发 |
| postcss | 8.5.32 | 开发 |
| tailwindcss | 3.4.17 | 开发 |
| vite | 8.3.5 | 开发 |
| wait-on | 9.1.0 | 开发 |
| react | 19.2.8 | 开发 |
| react-dom | 19.2.8 | 开发 |
| lucide-react | 1.34.0 | 开发 |

## 证据与来源

[本次 npm audit](security-audit/npm-audit-current.json)、[依赖清单](security-audit/dependencies.json)、[本次凭据/历史扫描](security-audit/secret-scan-current.json)、[验证记录](security-audit/verification-current.json)。初审及上一轮数据保留在 security-audit，不作为今天重新验证的替代。

[minimatch 官方公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)、[uuid 官方公告](https://github.com/advisories/GHSA-w5hq-g745-h8pq)。CI 最小权限和固定提交建议参考 [GitHub 官方安全使用指南](https://docs.github.com/en/actions/reference/security/secure-use)。线程内存边界参考 [Node 官方文档](https://nodejs.org/api/worker_threads.html)。
