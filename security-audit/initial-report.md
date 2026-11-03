# 安全审核报告

审核日期：2026-11-03（Europe/Rome）。对象：`D:\email-manager-app` 当前工作目录，版本 1.3.0。

## 1. 项目概况和范围

JavaScript（JSX / ES modules / CommonJS）、React 19、Electron 45、Vite 8、Tailwind CSS 3；包管理器为 npm，存在 package.json 和 package-lock.json，未发现其他语言的依赖清单。14 项直接依赖（4 运行时、10 开发），锁文件 576 个非根包安装条目（含重复版本和平台可选包，不是 576 个不同包名）。完整实际版本、安装路径、完整性摘要、弃用标记见 [依赖清单](security-audit/dependencies.json)。

逐文件审阅：electron/main.cjs、preload.cjs、browser-launch.cjs、vault.cjs、totp.cjs；src/EmailManager.jsx、AuthGate.jsx、model.mjs、mutations.mjs、main.jsx、index.css；index.html；package.json、锁文件；Vite / PostCSS / Tailwind / Playwright 配置；全部三份原有测试；README、.gitignore。新 security.cjs 和新增回归测试也经检查。assets 只有图标。未发现浏览器扩展、移动应用、后端数据库、服务端 API 或 CI workflow，因此 SQL/NoSQL 注入、服务端 CSRF/SSRF、多租户越权、pull_request_target 等没有对应实现可审查。

额外检查 dist、release、test-results；原始字节凭据特征扫描覆盖 566 文件，无命中，见 [扫描证据](security-audit/secret-scan.json) 和 [可重复运行的采集脚本](security-audit/collect.cjs)。扫描包含二进制原始字节，但不等于解压审查所有 EXE/ZIP 内容；未做二进制逆向、OCR、全量第三方源码审计或渗透测试。当前目录没有 .git，无法验证跟踪状态、历史提交和远端泄露。

## 2. 问题汇总

以下为项目情境评级；依赖公告评级与可利用性分别说明。加固项不代表已经存在可直接利用的漏洞链。

| 编号 | 类别 | 严重级别 | 位置（当前行号） | 状态 |
| --- | --- | --- | --- | --- |
| C01 | 代码 | Medium | electron/main.cjs:45；electron/security.cjs:14 | 已修复：IPC 未验证主 frame 和页面 URL |
| C02 | 代码 | Medium | vite.config.js:6；原 index.html 无 CSP | 已修复：生产页面缺少 CSP，扩大脚本注入后果 |
| C03 | 代码 | Low | electron/main.cjs:58、140 | 已修复：子 frame 导航、webview、权限缺少集中拒绝策略 |
| S01 | 密钥 | Low | .gitignore:8 | 已修复：敏感环境文件、私钥和资料库文件未被忽略；未发现真实泄露 |
| D01 | 依赖 | Medium | package-lock.json:5226，及各嵌套 minimatch | 建议关注：开发者已决定保留，等待上游兼容修复；可达性部分待确认 |
| D02 | 依赖 | Medium | package-lock.json:7494；package.json:19 | 建议关注：开发者已决定保留；已核查 ExcelJS 不调用受影响 UUID 方法 |
| C04 | 代码 | Medium | src/EmailManager.jsx:141、143 | 建议关注：开发者已决定保留 Excel 导入行为，另行设计资源限额 |
| D03 | 依赖 | Low | package-lock.json；security-audit/dependencies.json 的 deprecated 字段 | 建议关注：7 个停止支持/弃用的间接包，及长期无新版的 ExcelJS |
| C05 | 代码 | Low | release/ 中历史 EXE/ZIP、release/win-unpacked | 建议关注：既有分发物不包含本次修复，尚未重新打包 |

未确认当前源码存在 Critical / High 可利用漏洞；这不是“没有漏洞”的保证。

## 3. 依赖审核

先对所有直接包逐个进行 WebSearch，再对关键间接包（minimatch、uuid、archiver、glob、jszip、unzipper、tar、ejs、@electron/asar、@electron/universal）检索公告，并以联网 npm audit 交叉核对。没有检索命中不能证明安全；下表“无匹配告警”仅表示本次扫描和检索没有确认适用于实际版本的问题。未将同名或相关包的漏洞直接套用到本项目。

| 直接依赖 | 清单和锁定版本 | 用途 | 本次结果 |
| --- | --- | --- | --- |
| exceljs | 4.4.0 | XLSX 导入 | 间接 minimatch / uuid 告警；浏览器实际加载预构建 bundle |
| lucide-react | 1.34.0 | 图标 | 无匹配告警 |
| react | 19.2.8 | 客户端 UI | 未使用 RSC；不能将 react-server-dom 的漏洞算入 |
| react-dom | 19.2.8 | 客户端 UI | 同上 |
| @playwright/test | 1.64.1 | 桌面测试 | 无匹配告警 |
| @vitejs/plugin-react | 6.1.0 | 构建 | 不是 @vitejs/plugin-rsc；无匹配告警 |
| autoprefixer | 10.5.4 | CSS 构建 | 无匹配告警 |
| concurrently | 10.0.6 | 开发脚本 | 无匹配告警 |
| electron | 45.2.1 | 桌面运行时 | 无匹配告警；已核对下述 High 公告 |
| electron-builder | 26.18.0 | 分发打包 | 间接 minimatch 告警 |
| postcss | 8.5.32 | CSS 构建 | 无匹配告警 |
| tailwindcss | 3.4.17 | CSS 构建 | 无匹配告警 |
| vite | 8.3.5 | 构建、开发服务器 | 无匹配告警；已超过下述 High 公告修复版本 |
| wait-on | 9.1.0 | 等待开发服务器 | 无匹配告警 |

关键间接版本：

| 包 | 锁文件实际版本 |
| --- | --- |
| minimatch | 3.1.5、5.1.9、9.0.9、10.2.6（多路径） |
| uuid | 8.3.2 |
| @electron/asar / @electron/universal | 3.4.1 / 2.0.3 |
| glob / archiver | 7.2.3 / 5.3.2 |
| jszip | 3.10.2 |
| unzipper | 0.10.14（ExcelJS）、0.12.5 |
| tar / ejs | 7.5.22 / 3.1.10 |

注意：ExcelJS package.json 的 browser 入口是 dist/exceljs.min.js；其构建内嵌的依赖可能与外层锁文件不同。包内非压缩构建可见 JSZip 3.10.1 标记，不能声称锁文件升级一定修复内嵌代码。后续升级必须检查实际 bundle。

### D01：minimatch 模式放大 DoS

[GitHub 公告 GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) 标记 <11.0.1，修复版 11.0.1，Moderate。说明中的触发条件是攻击者控制 glob 模式且 optimizationLevel >=2，引起 CPU/内存耗尽。

项目没有将账号资料、启动 URL 或 Excel 单元格用作 glob 模式；主要路径来自 electron-builder 的文件选择和 ExcelJS 的 archiver 依赖。打包配置使用固定 files 模式。构建配置本身须来自可信源码。当前未证明存在用户导入文件触发此模式的路径。

本地 9.0.9、10.2.6 含 firstPhasePreProcess；3.1.5 和 5.1.9 没有同名实现。数据库宽泛版本范围与旧分支代码是否一致，以及完整调用链是否打开优化等级 2，均标为**待确认**，没有仅凭包名判定可利用。

安全修复需跨大版本升级至 >=11.0.1；不能将旧版 CommonJS 函数导出无条件替换为新版 API。npm audit 给出的 electron-builder 20.23.1 / exceljs 3.4.0 是跨大版本降级建议，不是经验证的安全升级方案，未执行。

### D02：uuid 外部输出缓冲区检查

[GitHub 公告 GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) 的受影响方法是 v3/v5/v6（不是包的大版本号）；外部 buf/offset 不正确时产生不完整写入。修复支线包括 11.1.1、12.0.1、13.0.1。当前 8.3.2 命中版本范围。

ExcelJS 源码唯一 UUID 引用在 node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:1，调用 v4() 且不提供外部缓冲区；包内浏览器构建也使用 uuidv4()。应用 ID 使用 crypto.randomUUID()。因此未发现本项目满足该公告利用条件的路径。公告页面当前 Moderate / CVSS v4 6.3，与 npm 返回的旧 CVSS v3 数值不同，采用公告等级并保留原始扫描值。

### Critical / High 适用性核查

- [React RSC RCE 公告](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3)：涉及 react-server-dom-*，对应 19.2 支线修复版 19.2.9。本项目没有这些包和服务端 RSC；客户端 react/react-dom 19.2.8 不满足该公告适用条件，不据此盲目升级。
- [Electron 证书缓解公告](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)：High，45 支线修复于 45.0.0-beta.6；45.2.1 不在受影响范围。项目也没有业务 HTTPS 请求；打开网页交给外部浏览器。
- [Vite WebSocket 文件读取公告](https://github.com/advisories/GHSA-p9ff-h696-f583)：High，8 支线修复版 8.0.5；8.3.5 不在受影响范围。开发脚本绑定 127.0.0.1。
- [node-tar 硬链接路径穿越公告](https://github.com/isaacs/node-tar/security/advisories/GHSA-34x7-hfp2-rc4v)：High，修复 >=7.5.7；当前 7.5.22 不匹配。本应用不导入 TAR。
- [JSZip 路径穿越公告](https://github.com/advisories/GHSA-36fh-84j7-cv5h)：修复 3.8.0；锁定 3.10.2 和上述 bundle 3.10.1 均高于修复版。XLSX 导入不将 ZIP 路径提取写入磁盘。

### 扫描、维护与供应链限制

联网 npm audit：0 Critical、0 High、21 Moderate、0 Low；21 是带依赖传播的包条目数，根源是上面两条公告，并不是 21 个独立漏洞。完整原始输出见 [npm-audit.json](security-audit/npm-audit.json)。退出码 1 表示仍有告警。首次沙箱联网失败后，已在授权网络环境成功重跑。

21 个条目为 @electron/asar、@electron/universal、app-builder-lib、archiver、archiver-utils、dir-compare、dmg-builder、ejs、electron-builder、electron-builder-squirrel-windows、electron-winstaller、exceljs、filelist、glob、jake、minimatch、readdir-glob、rimraf、temp、uuid、zip-stream。并非全部在当前 Windows NSIS 或浏览器导入路径使用。

锁文件明确标记弃用/不支持的包：boolean 3.2.0、fstream 1.0.12、glob 7.2.3、inflight 1.0.6（含内存泄漏警告）、lodash.isequal 4.5.0、rimraf 2.6.3、uuid 8.3.2。它们是间接包，未直接删除。

[ExcelJS 官方发布页](https://github.com/exceljs/exceljs/releases) 仍将 4.4.0 列为 Latest；本地 bundle 标注 2023-10-19。归为长期无新版关注项，不能据此断言官方宣布停止维护。未发现可确认的仿冒包；没有做发布者身份溯源或所有 npm 历史发布的恶意行为分析。

## 4. 已修复问题与具体改动

**C01 — IPC 来源验证。** 原先只判断 event.sender 属于应用窗口，同一 WebContents 的非预期页面或子 frame 未单独验证。利用前提是攻击者使可访问 preload API 的非预期上下文运行，不能仅靠恶意账号文本直接利用。新增 electron/security.cjs，对主 frame 身份、协议、host、完整路径和允许的查询参数验证；生产只允许 dist/index.html，开发只允许 http://127.0.0.1:5173/，快捷栏只允许 ?toolbar=1。主进程所有 IPC 统一使用该校验。保留现有资料库解锁和 generation 检查。新增真实恶意 URL / 子 frame 拒绝用例。

**C02 — 生产 CSP。** 在 Vite build 的 HTML 转换中注入策略：默认拒绝，只允许本地脚本/样式/字体和本地/data 图片；拒绝外部网络、frame、worker、object、表单提交和 base。脚本不允许 unsafe-inline 或 unsafe-eval。style 保留 unsafe-inline 以兼容当前 UI。原 React 插值已转义，未发现 dangerouslySetInnerHTML / eval；此项是降低未来注入影响的加固。开发 HMR 不套用生产 CSP；开发时不应使用真实账号资料。新增生产路径桌面测试，验证动态 Excel chunk、账号导入、快捷栏正常，内联脚本和 fetch 被拒绝。

**C03 — 默认拒绝未使用能力。** 拦截 will-frame-navigate 与 will-attach-webview，集中拒绝 Electron 权限请求和权限检查。当前产品无摄像头、麦克风、地理位置、USB 等使用需求。已有 contextIsolation:true、nodeIntegration:false、sandbox:true 和新窗口 deny 保留。此项利用同样依赖非预期活跃内容，不单独认定远程利用链。

**S01 — 忽略敏感文件。** .gitignore 增加 .env、.env.*（保留 .env.example）、私钥/证书容器扩展名、旧明文资料库和加密资料库副本。未发现生产 API Key、云 AccessKey、真实密码、私钥、数据库连接串或 webhook；没有凭据需要迁移到环境变量，因此未编造 .env.example 的变量。测试中的固定密码和 RFC TOTP 样例是明确的虚构测试数据。N7M_TEST_DATA_DIR 是测试资料目录开关，不是密钥，未改变其行为。

所有 package.json 和锁文件版本均未改动；没有执行 audit fix --force、删除功能或修改资料格式。dist 已通过 npm run build 更新。

## 5. 开发者决策（已在本次会话确认）

**D01/D02：保留版本，等待上游兼容修复。** 选项 A 为保留并跟踪公告、验证调用可达性；选项 B 为授权定向 overrides 跨大版本升级，检查 CommonJS/ESM API、内嵌 bundle，再运行导入和打包测试。建议先采用 A，随后安排单独升级验证。开发者已选择 A，因此状态为建议关注，而不是未答复或已修复。现有告警仍存在。

**C04：XLSX 解压资源消耗。** 20 MB 是压缩文件大小上限，workbook.xlsx.load 在 UI 进程解析，没有解压总量、单项大小、行列数、CPU 时间或工作簿数量限额。用户主动导入恶意/高膨胀工作簿时可导致卡顿、内存耗尽或进程崩溃；未实际运行破坏性的 OOM 样本，不将其宣称为某个已确认 CVE。

选项 A：保留现有功能，记录风险，另行设计隔离与资源限额；选项 B：本次加入 worker 隔离、终止超时与大小限额，但部分合法大型文件会被拒绝。开发者已选择 A。建议后续为解析使用可终止隔离上下文，并在解压过程中计量实际输出字节（只信 ZIP 声明大小不够），同时限制行列和总单元格数。仅加 Promise 超时不能停止同步解析或释放已分配内存。

## 6. 其他代码结论和剩余风险

- 浏览器启动：spawn/execFile 使用参数数组、不经 shell；Profile 白名单；启动网页只接受 HTTP/HTTPS 且拒绝内嵌用户名密码。未确认命令注入、javascript/file 协议执行或账号可控路径穿越。系统浏览器注册项/环境路径依赖本机可信环境；不把同权限用户篡改系统设置视作已证实远程漏洞。
- 展示/导出：React 文本插值；CSV 对危险公式前缀加单引号，正确处理引号；CSV 不含密码/TOTP；文件写出位置来自系统保存对话框。未发现远程代码加载、可控 SQL/eval/模板执行或自动跟随 Excel 外链。
- 加密：AES-256-GCM、随机 12 字节 nonce、随机 32 字节盐，scrypt N=65536/r=8/p=1；KDF 参数固定校验，GCM AAD/tag，原子写入；修改软件密码会更新当前和备份文件。TOTP 的 HMAC-SHA1 是协议要求，不等于使用弱密码哈希。未发现禁用 TLS 证书验证或自造加密。
- 主进程清理密钥 Buffer，但 JavaScript 字符串、GC 堆、崩溃转储、操作系统交换文件无法保证即时擦除。已解锁 renderer 被完全控制时，合法 IPC 能读编辑凭据；CSP 和来源验证不替代预防所有脚本执行。剪贴板 30 秒清理无法撤回第三方剪贴板历史已保存内容。
- 离线密码猜测：加密文件持有者可绕过 UI 重试延时离线尝试。使用足够长且独立的软件密码；8 字符最低要求不保证强度。未擅自提高密码策略或修改 KDF/资料格式。
- 旧明文迁移删除只是普通文件删除，不能保证 SSD、备份、同步盘中旧数据物理擦除。test-results 和失败 trace 只应使用测试账号，不要上传真实凭据。
- 发布物：release 中存在 1.0/1.1/1.2/1.3 历史程序；README 明确 1.1 及以前无加密资料库。它们未因源码修复自动变化，本次未删除、覆盖或重新发布。发布前重新打包、检查实际 ASAR、回归安装版/免安装版；审查代码签名、ASAR 完整性和 Electron fuses。未验证旧 EXE 的实际 Electron 版本和签名状态，标为待确认。
- 忽略规则不会从 Git 历史、已上传附件或现有远端仓库移除文件。如果任何真实密钥曾提交或泄露，必须到对应平台作废并重新生成；只删代码或加 .gitignore 不够。本次无证据证明已经发生泄露，也未执行密钥轮换。

## 7. 验证与证据

- npm test：29/29 通过（原 28 项 + IPC 来源回归）。
- npm run build：成功；仅有 ExcelJS 生成 chunk 超过 500 kB 的体积警告。
- npm run test:ui：5/5 通过（原 4 项 + 生产 CSP / XLSX / 快捷栏回归）。生产测试使用独立资料目录，bootstrap 模拟 app.isPackaged，运行当前源码和新 dist；不是声称已测试历史 release 安装包。
- 新生产测试确认 CSP 实际拒绝内联脚本执行和网络 fetch，且 Excel 导入功能可用。
- npm audit --json：成功取得数据库结果，因 21 项 Moderate 告警退出 1，原始结果保留。
- node security-audit/collect.cjs：扫描 566 文件，敏感文件名列表和所检查凭据特征命中均为空。模式扫描不能排除未符合特征的自定义凭据；压缩/加密内部和历史 Git 未覆盖。

本报告对应的文件变更：electron/main.cjs、electron/security.cjs（新增）、vite.config.js、.gitignore、tests/vault.test.cjs、tests/desktop.spec.cjs、新 dist 及本报告/证据文件。依赖清单和 lock 未修改。后续优先事项是跟踪上游依赖修复、隔离 Excel 解析以及对重新生成的分发物进行实际验收。
