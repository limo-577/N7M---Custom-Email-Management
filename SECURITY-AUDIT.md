# 安全审核与修复复核报告

日期：2026-11-03（Europe/Rome）。项目：N7M - Custom Email Management 1.3.0，目录 `D:\email-manager-app`。

## 1. 项目概况与范围

JavaScript（JSX / ESM / CommonJS），React 19、Electron 45、Vite 8、Tailwind CSS 3，npm 管理依赖。修复后 16 项直接依赖（6 运行时、10 开发），锁文件有 566 个非根安装条目，含重复版本和平台可选包。完整版本见 [依赖清单](security-audit/dependencies.json)。

审查范围：electron/*、src/*、依赖清单及锁文件、index.html、构建与测试配置、测试、README、.gitignore；初次另扫描 dist、release、test-results。未发现后端 API、数据库、浏览器扩展、移动应用或 CI workflow，因此没有对应的 SQL/NoSQL、服务端 CSRF/SSRF、扩展权限或 pull_request_target 实现可审查。

开发者已授权修复原暂缓的依赖升级和 Excel 资源隔离，本报告描述修复后状态。原逐文件结论与初次告警保存在 [初次报告](security-audit/initial-report.md) 和 [初次 npm audit](security-audit/npm-audit.json)，不能当作当前结果。

## 2. 问题汇总

未确认当前源码存在 Critical / High 可利用漏洞。共 9 项发现，7 项已修复或加固，2 项建议关注，无待开发者决定事项。最新完整 npm audit 为 **0 漏洞告警**；没有省略开发依赖或使用忽略规则。零告警不保证没有未知漏洞。

| 编号 | 类别 | 严重级别 | 位置 | 当前状态 |
| --- | --- | --- | --- | --- |
| C01 | 代码 | Medium | electron/main.cjs:49；electron/security.cjs:14 | 已修复：IPC 校验主 frame 和精确页面来源 |
| C02 | 代码 | Medium | vite.config.js:6 | 已修复：生产 CSP |
| C03 | 代码 | Low | electron/main.cjs:62、173 | 已加固：导航、webview 与权限集中限制 |
| S01 | 密钥 | Low | .gitignore:8 | 已加固：敏感文件忽略规则；未发现真实泄露 |
| D01 | 依赖 | Medium | package.json overrides；vendor/minimatch-compat/index.cjs | 已修复：官方匹配引擎升级至 11.0.4 |
| D02 | 依赖 | Medium | package.json overrides.uuid | 已修复：uuid 升至 11.1.1 |
| C04 | 代码 | Medium | electron/xlsx-import.cjs；electron/xlsx-worker.cjs；src/EmailManager.jsx 的 readFile | 已修复：隔离解析、实际解压计量与资源预算 |
| D03 | 依赖 | Low | 锁文件 deprecated 字段；ExcelJS 4.4.0 | 建议关注：6 个弃用间接包、ExcelJS 发布滞后 |
| C05 | 代码 | Low | release/ 中既有历史 EXE / ZIP | 建议关注：历史发布物未覆盖，发布前重新生成 |

评级按项目情境确定。IPC/CSP 等加固项仍需攻击者在非预期上下文执行代码才能形成利用链，不能仅凭恶意账号文本推导可直接利用。

## 3. 依赖审核与具体修复

初次对全部直接依赖及关键间接包逐个进行 WebSearch，以 GitHub Advisory Database、上游公告和联网 npm audit 交叉核对。初次 21 项 Moderate 是两条底层公告传播到的包条目，不是 21 个独立漏洞。

| 直接依赖 | 修复后版本 / 来源 |
| --- | --- |
| exceljs | 4.4.0，仅 Node 工作线程使用 |
| jszip | 3.10.2，新增明确运行依赖 |
| minimatch | 本地 @n7m/minimatch-compat 1.0.1，实际引擎为官方 11.0.4 |
| lucide-react | 1.34.0 |
| react / react-dom | 各 19.2.8（分别计为一项直接依赖） |
| @playwright/test | 1.64.1 |
| @vitejs/plugin-react | 6.1.0 |
| autoprefixer | 10.5.4 |
| concurrently | 10.0.6 |
| electron | 45.2.1 |
| electron-builder | 26.18.0 |
| postcss | 8.5.32 |
| tailwindcss | 3.4.17 |
| vite | 8.3.5 |
| wait-on | 9.1.0 |

关键间接版本：minimatch-engine（npm alias，实际包名 minimatch）11.0.4、uuid 11.1.1、@electron/asar 3.4.1、@electron/universal 2.0.3、glob 7.2.3、archiver 5.3.2、unzipper 0.10.14 / 0.12.5、tar 7.5.22、ejs 3.1.10。所有实际路径及版本以 JSON 清单为准。

**D01：minimatch。** [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) 描述攻击者可控 glob 在特定优化条件下导致 CPU/内存放大，公告修复版 11.0.1。旧分支适用性和原项目利用链在初审中仍有待确认部分；此次已直接移除旧匹配引擎，统一使用官方已修复版 11.0.4。

新版导出和匹配对象与旧 glob 7 / ASAR / 目录比较工具不兼容。新增小型本地适配包，提供旧式可调用导出、Minimatch 子类、_glob / Symbol.match 和 Windows filelist 的路径选项适配；实际匹配委托官方非递归 Matcher.test()，没有复制旧模式解析、生成旧正则或重建 makeRe API。官方包经 minimatch-engine alias 固定版本，避免 override 递归替换自身。

可审源码和说明在 [vendor/minimatch-compat](vendor/minimatch-compat/SECURITY.md)，本地安装归档为 vendor/n7m-minimatch-compat-1.0.1.tgz。使用归档避免打包依赖开发目录符号链接；锁文件保存完整性摘要。后续父依赖原生支持修复版时应移除适配层，新调用方需重新验证。

**D02：uuid。** [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) 涉及 v3/v5/v6 对外部 buf/offset 的检查；修复支线包括 11.1.1。ExcelJS 原先使用 v4()，应用使用 crypto.randomUUID()，初审未发现满足公告条件的利用路径。本次仍将锁定 uuid 从 8.3.2 升到 11.1.1，消除易受影响包版本。

**旧浏览器 bundle。** renderer 已删除 import('exceljs')，当前 XLSX 路径使用工作线程 require('exceljs') 的 Node 入口，因此实际运行采用更新后的锁定依赖。旧上游浏览器 bundle 不再进入 dist；不能声称 overrides 改写了它的内嵌代码。如果以后重新使用该入口，必须另行核查。

**High / Critical 公告核对。** [React RSC RCE](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3) 涉及本项目未使用的 react-server-dom-*；[Electron 证书缓解](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9) 的 45 支线修复版为 45.0.0-beta.6，当前 45.2.1 不匹配；[Vite WebSocket 文件读取](https://github.com/advisories/GHSA-p9ff-h696-f583) 的 8 支线修复版 8.0.5，当前 8.3.5 不匹配；[tar 硬链接路径穿越](https://github.com/isaacs/node-tar/security/advisories/GHSA-34x7-hfp2-rc4v) 修复 >=7.5.7，当前 7.5.22 不匹配；[JSZip 路径穿越](https://github.com/advisories/GHSA-36fh-84j7-cv5h) 修复 3.8.0，当前 3.10.2 不匹配。

锁文件为移除本地 override 的旧元数据重新解析，包含符合父依赖 SemVer 范围的间接版本刷新和 hoist 变化，见 [变更证据](security-audit/dependency-changes.json)。完整最新扫描见 [修复后 npm audit](security-audit/npm-audit-after.json)。

仍有 6 个弃用间接包：boolean 3.2.0、fstream 1.0.12、glob 7.2.3、inflight 1.0.6、lodash.isequal 4.5.0、rimraf 2.6.3。弃用不等于已确认可利用漏洞。ExcelJS 官方发布页仍列 4.4.0 为 Latest，不能据此断言官方已宣布停止维护。未确认仿冒包；没有进行完整发布者历史溯源。

## 4. 代码和密钥修复

**C01：IPC。** 统一校验应用窗口、主 frame、协议、host、完整路径和查询参数；开发仅允许本地 Vite 页，生产仅允许 dist/index.html。继续检查解锁状态和 generation，锁定可撤销未完成操作。

**C02/C03：CSP 与权限。** 生产默认拒绝外部网络、内联脚本、eval、frame、object、表单和 base，仅开放必要本地资源；style 保留 unsafe-inline 兼容界面。拦截新窗口、子 frame 导航、webview 和未使用权限。保留 contextIsolation / sandbox，关闭 nodeIntegration。Excel 使用 Node worker_threads，没有放宽 renderer worker-src 或启用 nodeIntegrationInWorker。

**S01：敏感文件。** .gitignore 补充环境文件、私钥/证书容器和资料库文件，保留 .env.example 例外。初次 566 文件所检查凭据特征未命中，测试密码/TOTP 为明确样例。没有真实凭据需要迁移，因此未编造 .env.example 变量。模式扫描不能排除所有自定义凭据或历史泄露。

**C04：Excel 隔离与预算。** 主进程管理单任务 Node 工作线程，ZIP 预检、解压与 ExcelJS 解析都移出主事件循环和界面。受控字节复制后转移给工作线程，预检与解析使用同一不可变输入；renderer 不能指定限额或 worker 路径。

| 资源 | 上限 |
| --- | --- |
| 文件 / ZIP 项数 | 20 MiB / 512 项 |
| 实际解压输出 | 单项 16 MiB、合计 64 MiB |
| 工作表 | 30 张 |
| 每表行 / 列 | 50,000 / 100 |
| 总单元格 / 字符 | 250,000 / 4,000,000 |
| 单元格文本 | 32,767 字符 |
| 解析时间 | 15 秒 |
| V8 老生代 / 新生代堆 | 192 MiB / 32 MiB |

核对 ZIP central/local 目录与名称，拒绝路径穿越、重复路径、名称别名、重叠区域、ZIP64、分卷和加密 ZIP。流式计量实际解压块，不能用伪造的声明大小绕过；JSZip/ExcelJS 一致忽略的目录项不会在第二遍展开。所有工作表均受规模预算约束，veryHidden 仅在返回时排除。

取消、超时、锁定、窗口关闭/导航及退出时终止线程。终止后才释放并发槽；界面等待取消完成再导入新文件，防止旧结果恢复预览。错误不回显工作簿内容；失败不保存部分账号。多工作表、空列、编号补零和原隐藏表规则保留，CSV/TSV/粘贴逻辑不变。

工作线程用于隔离资源消耗，不是任意代码执行的操作系统权限沙箱。[Node 官方文档](https://nodejs.org/api/worker_threads.html) 明确 resourceLimits 不限制全部 ArrayBuffer/外部分配；192 MiB 不是应用 RSS 硬上限，需要结合实际解压和输出预算。复杂合法文件也可能被拒绝，应拆分导入。

## 5. 开发者决定与验证

用户已授权并完成原两类暂缓事项，无待答复问题。没有删除功能、轮换密钥、修改加密资料格式或执行 audit fix --force。

- 干净 npm ci --ignore-scripts 安装成功，随后恢复官方 Electron 运行文件；npm ls 无 invalid。
- npm test：**47 / 47 通过**，含 11 项 XLSX 安全测试、7 项真实依赖调用兼容测试。
- npm run build：成功；浏览器 ExcelJS chunk 已移除，原体积警告消失。
- npm run test:ui：源码模式 **6 / 6 通过**。
- 实际 ASAR 打包成功，使用新包重跑完整桌面测试 **6 / 6 通过**，验证工作线程、升级后的依赖、生产 CSP 与原有功能。验证构建关闭了可执行文件资源编辑/签名，不作为正式发布安装包。
- npm audit --json：完整依赖 **0 告警**，原始数据已保存。

测试覆盖伪造解压大小、压缩炸弹、路径穿越/重复/加密标志、规模预算、固定错误、主事件循环响应、同步死循环超时、并发和取消后恢复。未运行耗尽整机资源的破坏性 OOM 样本。验证用新包位于 output/security-build，不覆盖或发布历史 release 安装包。

## 6. 剩余风险与后续建议

1. 跟踪上游修复与弃用依赖，父依赖支持新版 minimatch 后移除本地适配层。零告警不代替后续监测。
2. 历史 release EXE/ZIP 不因源码变化更新；旧版 Electron 和签名状态仍待确认，发布前重新生成所有分发形式。考虑代码签名、ASAR 完整性和 Electron fuses。
3. 未确认 SQL/eval/模板注入、可控 shell 调用、关闭 TLS 校验或当前资料库明文保存。浏览器用参数数组和 Profile 白名单、URL 仅 HTTP/HTTPS；React 转义文本；CSV 防公式且不含凭据；加密使用随机盐/nonce、scrypt 和 AES-GCM。
4. JavaScript 字符串、崩溃转储、交换文件、备份和第三方剪贴板历史无法保证即时擦除；普通删除旧明文不能保证物理擦除，资料库持有者可离线猜弱密码。
5. 当前没有 .git，无法核对历史跟踪状态或远端泄露；二进制原始字节扫描不等于完整解包或逆向。若真实密钥曾泄露，必须到平台作废并重新生成，只删代码或加 .gitignore 不够。
