# N7M 1.8.0 安全审核报告

审核日期：2026-11-17，Europe/Rome。对象：D:\email-manager-app 当前工作区，Git HEAD 2e44f78bc03f887b26d757b46041a049a381edde 加全部既有未提交修改。本轮没有提交、回退或覆盖既有业务改动。旧 SECURITY-AUDIT.md 描述 1.3.1，不能作为当前版本的结论。

## 1. 项目概况与范围

JavaScript（CommonJS / ES modules）、JSX、CSS，辅以 PowerShell / 内嵌 C# 和 NSIS。Electron 45.2.1、React 19.2.8、Vite 8.3.7、Tailwind 3.4.17；npm，package-lock.json v3。无 Python、Go、Rust、Java 或移动端依赖清单；无后端服务、数据库或浏览器扩展。

直接依赖 18 项：运行时 4，开发依赖 14；React 等开发依赖会被打入 UI，Electron 是实际运行时，不能因 devDependencies 分类而忽略。最终锁文件 494 个安装条目，包括不同平台的可选包；OSV 去重后查询 463 个官方包版本，本地兼容包另行读源码审核。

审核覆盖 electron、src、build、.github/workflows、vendor/minimatch-compat、项目配置和依赖锁文件；查看全部应用执行入口及权限边界，对测试进行边界与凭据复核，范围清单和源码 SHA-256 见 security-audit/2026-11-17/scope-manifest.json。构建文本、文档、示例、本地 Git 历史及已有发行 ASAR 也纳入密钥特征扫描。第三方依赖以锁文件、漏洞公告和关键源码为主，不声称人工逐行阅读全部 node_modules。未逆向第三方二进制，未检查远端不可见 Git refs、用户真实资料库或云平台。

## 2. 问题汇总

| 编号 | 类别 | 严重级别 | 位置 | 问题与状态 |
| --- | --- | --- | --- | --- |
| D01 | 依赖 | Critical | package.json:38；package-lock.json 的 Vite 条目 | Vite 开发服务器 RCE 公告；8.3.5 → 8.3.7，已修复 |
| D02 | 依赖 | High | electron/xlsx-worker.cjs:91；原 ExcelJS 4.4.0 | 恶意 XLSX 原型污染已复现；经开发者批准迁移非官方 exceljs-hardened 5.1.1，已修复已验证的两种污染路径 |
| C01 | 代码 | Low | electron/browser-launch.cjs:114 | 默认浏览器发现失败后的异步回退缺少解锁复核；已修复 |
| D03 | 依赖 | Low | security-audit/dependency-policy.json | 仍有 5 个弃用间接依赖及非官方 fork 维护/供应链风险；建议关注，复核期限 2026-12-04 |
| C02 | 代码 | Low | package.json build；本地 Windows 发行包 | 构建未配置代码签名；建议关注，未擅自创建或使用签名凭据 |
| S01 | 密钥 | Low | .gitignore；本地历史、源文件与构建产物 | 未发现生产密钥或被跟踪敏感路径；建议持续关注，并非发现一项泄露漏洞 |

严重级别中 D01 使用上游 Critical，D02 使用披露者 High；应用实际暴露和缓解见下文。维护/签名项是风险与加固建议，不能计为已证实远程漏洞。

## 3. 已修复问题与利用条件

### D01：Vite 开发服务器执行任意代码

[Vite 官方公告 GHSA-p4f5-76q4-ffq7](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7) 将 8.3.0–8.3.6 列为受影响，8.3.7 为修复版。HTTP 请求可经虚拟模块触发服务端代码执行。项目使用开发服务器但默认监听 127.0.0.1；没有确认默认配置允许来自其他机器的直接攻击，暴露到网络或转发端口会扩大风险。生产静态构建不是该漏洞入口。

本轮把 Vite 精确固定为 8.3.7，核验 npm 官方元数据后更新 package-lock.json；其 Rolldown 依赖按上游要求解析到 1.2.19。未修改服务监听范围，也未运行 npm audit fix --force。升级前 npm audit 仍报 0，说明不能只依赖单一扫描数据源。

### D02：ExcelJS 不可信 XLSX 原型污染

真实入口为 electron/xlsx-worker.cjs 的 Workbook.xlsx.load(bytes)。构造 x14 条件格式规则 ID 或 definedName 即可触发；这两种小型工作簿可通过常规 ZIP 规模检查，单靠文件大小预算不能修复。

在一次性 Worker 中，原 4.4.0 分别污染普通对象属性和数字键；新候选相同输入不污染。证据 candidate-probes.json。披露者公告标 High，但公告中的 5.1.0 是 **exceljs-hardened 的版本**，不是官方 ExcelJS 修复版。[x14 公告](https://github.com/mateocallec/exceljs-hardened/security/advisories/GHSA-86ch-m4gp-r5xf)、[definedName 公告](https://github.com/mateocallec/exceljs-hardened/security/advisories/GHSA-pwgq-2cgg-6ph9)。[CVE 官方记录](https://www.cve.org/CVERecord?id=CVE-2026-128336) 对原 ExcelJS 对应问题给出 Medium，评级差异保留，不将 fork 公告分数直接当作本应用实际分数。

本应用需要用户选择文件，解析隔离于单个 Worker，有限时、堆和解压/单元格预算；污染不自动传播到主进程。没有证明主进程 RCE 或凭据外泄，应用层实际影响主要是恶意导入的数据完整性与可用性。Worker 不是文件系统权限沙箱，不能据此断言所有未来解析器漏洞都被隔离。

开发者先批准评估，再明确批准非官方 fork 的正式迁移。具体修改：

- package.json：exceljs 4.4.0 → 明确命名的 exceljs-hardened 5.1.1；构建排除该 fork 的过旧浏览器 bundle；删除已不再被依赖树使用的 uuid override。
- electron/xlsx-worker.cjs：使用 fork 的 Node 入口；保留所有原有 ZIP 预检、Worker 终止、取消、行列/文本预算。
- 对 readdir-glob@3.0.0 的 minimatch 单独固定官方 11.0.9，保留旧构建链所需 @n7m/minimatch-compat 1.0.2。不能全局强换适配包：候选测试实际发现 ESM 命名导出不兼容，已修正。
- tests/dependencies.test.cjs：改为测试实际安装的现代 archiver/readdir-glob 和旧 glob/ASAR 链；删除已无实际依赖的 UUID 测试。
- tests/xlsx.test.cjs：使用新库，新增两种原型污染攻击的永久回归；tests/desktop.spec.cjs 同步生成测试工作簿的库。
- security-audit/dependency-policy.json、build/check-dependencies.cjs、对应测试及 README.md：监控 fork 的官方 npm 注册表状态，保留每月复核期限；移除已随旧库删除的 fstream 弃用例外，剩 5 项。没有把换库解释为全部维护风险消失。

### C01：锁定后仍可能触发系统浏览器回退

利用条件：已解锁用户发起系统默认浏览器启动，Windows 注册表异步发现失败，并在等待期间锁定资料库。原 catch 分支直接 shell.openExternal，主调用结束后的代次检查太晚，网址可能已经打开。

electron/browser-launch.cjs:114 在副作用之前再次调用 ensureUnlocked，阻止锁定后的回退。只影响取消边界，不改变正常默认浏览器回退功能。tests/browser-launch-firefox.test.cjs 新增确定性模拟，检查锁定时零次打开、正常情况下仍可打开。

## 4. 全部直接依赖

实际版本来自最终锁文件；完整 resolved、integrity 和间接依赖安装路径见 dependencies.json。每个包名均进行网页检索，原始结果保存在 direct-search-*.txt；“无匹配”仅表示本次数据源没有返回适用公告，不是无漏洞保证。

| 依赖 | 实际版本 | 用途/核对结果 |
| --- | --- | --- |
| exceljs-hardened | 5.1.1 | XLSX；开发者批准的非官方 fork；验证修复两种污染，保留供应链风险 |
| hash-wasm | 4.13.0 | Argon2id Worker；无本次适用公告匹配，随机盐及固定资源参数已审查 |
| jszip | 3.10.2 | ZIP 预检；历史路径穿越公告不影响该版本，且应用额外拒绝不安全路径 |
| minimatch（本地兼容包） | @n7m/minimatch-compat 1.0.2 | 实际引擎 minimatch 11.0.9；不是同名旧 minimatch 1.x |
| @playwright/test | 1.64.1 | 桌面回归；无本次适用公告匹配 |
| @vitejs/plugin-react | 6.1.0 | 构建插件；无本次适用公告匹配 |
| autoprefixer | 10.5.4 | CSS；无本次适用公告匹配 |
| concurrently | 10.0.6 | 开发启动；无本次适用公告匹配 |
| electron | 45.2.1 | 桌面运行时；核对官方安全/发行页，无本次适用公告匹配 |
| electron-builder | 26.18.0 | Windows 打包；历史 NSIS 公告与当前版本范围不符 |
| lucide-react | 1.34.0 | UI 图标；无本次适用公告匹配 |
| postcss | 8.5.32 | CSS；无本次适用公告匹配 |
| react | 19.2.8 | 本地客户端 UI；未使用 React Server Components |
| react-dom | 19.2.8 | 本地渲染；没有 react-server-dom-* 安装条目，不套用 RSC 远程执行公告 |
| tailwindcss | 3.4.17 | CSS 构建；仍为旧主线，不等同确认 EOL；旧 glob 维护风险单列 |
| vite | 8.3.7 | 本轮补丁升级，见 D01 |
| wait-on | 9.1.0 | 本机开发启动等待；无本次适用公告匹配 |
| yaml | 2.9.1 | CI 测试配置解析；无本次适用公告匹配 |

辅助来源：[JSZip 历史公告](https://github.com/advisories/GHSA-36fh-84j7-cv5h)、[Electron 45.2.1 官方发行说明](https://github.com/electron/electron/releases/tag/v45.2.1)、[Electron 安全公告](https://github.com/electron/electron/security/advisories)、[React 安全公告](https://github.com/react/react/security/advisories)、[构建器安全公告](https://github.com/electron-userland/electron-builder/security)。恶意仿冒包搜索结果不等于项目安装了同名近似包；当前未发现确认的仿冒依赖。

## 5. 关键间接依赖实际版本与触达

| 依赖 | 实际版本 | 安全相关用途 |
| --- | --- | --- |
| minimatch（两个官方引擎安装路径） | 11.0.9 | 现代 ESM 链和旧适配引擎；[旧版放大公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)不覆盖当前引擎 |
| brace-expansion / braces | 5.0.13 / 3.0.3 | 模式展开，主要为构建输入 |
| glob / inflight | 7.2.3 / 1.0.6 | 旧构建链；弃用/内存泄漏维护风险保留 |
| archiver / readdir-glob | 8.0.0 / 3.0.0 | fork 内部；现代匹配接口已测试，应用未调用任意路径归档 API |
| unzipper | 0.12.5 | fork 依赖；应用使用内存 xlsx.load，不调用文件系统 Extract |
| jszip / saxes | 3.10.2 / 5.0.1 | 实际 ZIP/XML 解析边界；按不可信输入审核 |
| fast-csv / lodash.isequal | 4.3.6 / 4.5.0 | fork 的 CSV 辅助链；应用自行处理 CSV，后者仍弃用 |
| tmp / rimraf | 0.2.7 / 2.6.3 | 临时文件/构建清理链；不暴露任意 renderer 文件操作 |
| tar | 7.5.22 | 打包依赖，不作为应用用户导入格式 |
| @electron/asar | 3.4.1 | 打包归档；应用不从外来 ASAR 加载模块 |
| builder-util-runtime | 9.7.0 | 打包基础设施；应用没有自动更新/远程下载 token 功能 |
| lodash / js-yaml | 4.18.1 / 4.3.2 | 工具配置与构建链；无本次适用公告匹配 |
| rolldown | 1.2.19 | Vite 编译器 |
| playwright / playwright-core | 1.64.1 / 1.64.1 | 测试运行器 |

原 ExcelJS、uuid、fstream 以及 unzipper 0.10 分支已从最终锁文件移除。关键间接包逐包搜索见 transitive-search-*.txt。全锁文件 npm audit 与 OSV 查询均未过滤结果；OSV 只上传公开包名及版本，没有上传项目代码或资料库。

## 6. 代码审核结果与已存在的防护

- IPC：electron/security.cjs:5、main.cjs:169 校验精确 URL、已知窗口和主 frame。preload 暴露固定 API，没有透传任意 IPC channel。敏感编辑/恢复 token 有 sender、generation、TTL、字段/记录范围和冲突检查；锁定/导航撤销会话。
- Electron：main.cjs:197 启用 sandbox、contextIsolation，禁用 nodeIntegration；拒绝窗口创建、导航、webview 和所有额外权限。生产 CSP 位于 vite.config.js，禁用外部网络、inline script、eval、frame/object；样式保留 unsafe-inline 是 UI 兼容选择，不将它冒称为脚本执行漏洞。
- 注入：没有 SQL/NoSQL 服务端入口、动态模板或应用 eval。浏览器命令使用 spawn/execFile 参数数组，用户 profile 不拼入 shell；PowerShell 的 ScriptBlock 来源为固定本地脚本，用户请求走 JSON；启动 URL 仅允许无用户名密码的 HTTP(S)。没有发现可利用命令注入路径。
- 路径/导入：ZIP 不写入磁盘；拒绝 traversal、别名、重复路径及不支持的 ZIP64/加密格式，实际流式解压计量；新库继续运行于限时 Worker。NSIS 缓存检查限制在用户目录，构建身份使用内容哈希；同一 OS 用户已控制本地可执行代码不被视为新增提权边界。
- XSS/CSRF/SSRF/CORS：React 文本渲染，没有 dangerouslySetInnerHTML；未发现远程请求和服务端请求代理；无后端 cookie 鉴权面。开发服务器与生产桌面暴露分别判断，不凭空报告不适用的服务端漏洞。
- 密码学：vault.cjs:13/75 使用固定预算 Argon2id、随机 32 字节盐和 12 字节 GCM IV、AES-256-GCM 及 AAD；旧 scrypt 在认证后迁移。未发现自造密码算法或关闭 TLS 验证。TOTP 的 HMAC-SHA1 是既有协议参数，不能套用普通 SHA1 碰撞结论。
- 明文与错误：常规 snapshot 剔除 password/totpSecret；显式编辑需要解锁，批量/备份另需重新认证。剪贴板按值比较后 30 秒清理；错误不包含用户提交的凭据值。CSV 排除凭据并转义公式前缀；用户主动填进备注等公开字段的秘密仍可能随 CSV 导出。
- CI/CD：release 和 dependency-review 没有 pull_request_target 或不可信事件文本插入 shell；第三方 Action 固定完整 SHA；checkout 不持久化凭据；只读构建和单独最小写权限发布隔离。未重写已有工作流。

## 7. 密钥与凭据检查

密钥特征扫描包括 API token、云 AccessKey、私钥、带凭据数据库 URL、Slack/Discord webhook；另人工检查配置和运行参数。扫描输出仅含路径/类型，不保存命中的值。最终扫描 4352 个工作区/文本产物文件、185 个本地历史文本 blob、19 个发行 ASAR 应用文本文件，未发现生产密钥，Git 跟踪的敏感路径为空；本地历史扫描不代表远端历史已完整覆盖。计数包含测试产物，并不代表有 4352 个应用源码文件。

.env / .env.*、*.pem、*.key、*.pfx、*.p12、email-data.json*、email-vault.json* 均已忽略；.env.example 明确保留可跟踪。测试里的主密码、邮箱密码和标准 TOTP 测试向量属于合成 fixture，不作为真实凭据报告。本轮无硬编码生产密钥需要环境变量替换，因此未杜撰环境变量或创建无用途 .env.example。

如以后确认任何密钥曾被提交或泄露，必须到对应平台作废并重新生成；仅删代码、加 gitignore 或改读环境变量无法撤销已泄露凭据。本轮没有替开发者执行密钥轮换。

## 8. 验证与证据

- 迁移前基线 npm test：165/165 通过；只加锁定回归后串行 166/166 通过。
- 迁移后 npm test：**167/167 通过**，含新增原型污染回归；证据 tests-migrated.txt。
- npm run build：Vite 8.3.7 构建通过；完整 Windows 打包同时再次执行生产构建。
- npm audit：最终 0 条；证据 npm-audit-final.json。初次沙箱网络失败有记录，后使用官方网络访问成功完成，未把失败当作 0 漏洞。
- OSV 官方 querybatch：最终 463 个不同包版本，0 匹配；证据 osv-querybatch.json。注意前述 Vite 公告曾晚于扫描数据库体现，零匹配不构成绝对安全结论。
- npm run check:dependencies:online：通过；确认 fork 5.1.1 及 5 项现存弃用例外，复核期限 2026-12-04。
- 候选隔离验证：11 项导入测试通过，两个攻击工作簿修复验证通过。候选阶段失败的 ESM 适配尝试保留日志，最终主项目兼容性测试通过，不隐瞒中间失败。
- 迁移后 npm run test:ui：**27/27 通过**（10.3 分钟），证据 ui-tests-migrated.txt。
- 生产 ASAR 独立冒烟：**1/1 通过**，覆盖生产 CSP、网络阻断、实际打包依赖、Excel 导入及快捷栏，证据 packaged-ui.txt。其输出目录单独指定，未清理完整回归的结果目录。
- npm run dist:all：通过，重新生成 1.8.0 安装版、便携版、ZIP。包内 20 个应用源码/构建文件逐字节匹配，生产 manifest 关键属性匹配，已删除旧 ExcelJS 且排除 fork 浏览器 bundle；ZIP 的 ASAR 和主 EXE 与 win-unpacked SHA-256 一致。证据 packages-final.txt、packaged-verification.json、zip-verification.json。没有进行真实机器交互安装，也没有外部发布。

早期曾并行运行单元和 Playwright，后者清理共享 test-results 导致一项单元测试 ENOENT；随后串行重跑全部通过。沙箱本地服务器启动也发生超时/端口占用；仅清理本轮已核对的测试进程后重新启动。换库前尚未跑完的 UI 被明确终止，不能算完整通过。所有 UI 使用隐藏窗口、独立测试资料目录、模拟浏览器与剪贴板，不使用真实账户或浏览器数据。

## 9. 开发者决定、剩余风险与建议

本轮两个明确决定均已收到：先评估替代库，再批准迁移非官方 exceljs-hardened 5.1.1。无需再批准同一迁移。没有未处理的大版本升级或待轮换的已发现密钥。

保留风险：fork 的维护历史和供应链信任；boolean 3.2.0、glob 7.2.3、inflight 1.0.6、lodash.isequal 4.5.0、rimraf 2.6.3 的弃用；Windows 发布未配置代码签名。建议于 2026-12-04 前复核 fork 和弃用链，继续保留无过滤 audit 与上游公告检查。签名需开发者持有证书或选择签名服务，本轮不擅自采购、创建身份或上传产物。

Argon2id 是离线抗猜测措施，无法抵消弱主密码；JS 字符串不能保证从内存物理擦除，系统剪贴板历史也不能被应用完全撤销。这些边界不等于本轮发现实际凭据泄露。

本次结论仅针对所核验工作区和本地构建；未证明不存在未知漏洞，也没有宣称远端 CI 或外部发布已成功。
