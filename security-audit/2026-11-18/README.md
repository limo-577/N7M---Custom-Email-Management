# 2026-11-18 dependency and release investigation

结论：**本地安装、测试和三种打包已验证；picomatch CVE 尚未安全修复，发布仍被安全门禁阻断。** 未升级到 1.8.2，未提交、push、创建或修改标签、发布 Release。本目录的构建仅用于验证，不代表发布批准。

## 已完成的代码和流程改动

- 保留用户已有 @emnapi/core、@emnapi/runtime 2.0.0-beta.2 锁文件补充和版本日志。`before/`、`worktree-before.txt` 保存进入任务时的未提交内容；HEAD 和 v1.8.1 标签对象记录在相应 `*-before.txt`。
- 工作流固定为本地通过验证的 Node 24.13.0、npm 11.6.2；执行 `npm ci` 后检查 manifest/lockfile 未改变。不能把本地成功表述为 GitHub 托管 runner 已成功：本次未推送或触发远程工作流。
- Electron 45 的包没有安装后自动下载脚本；加载模块时才会下载二进制。加入固定 Electron 包的显式 `install.js` 步骤，避免并行测试首次加载时隐式下载。首次本地测试因沙箱网络限制失败；显式下载后完整重跑通过，初次失败日志未删除。
- 保留完整 `npm audit --audit-level=low` 失败语义，改为输出原始 JSON；无 `continue-on-error`、无漏洞过滤。失败后仍上传原始审计和隔离探测证据。原有 SHA 固定的 Actions、只读构建权限、独立 tag 发布写权限保持。
- 新增 `build/picomatch-probe.cjs`、`check:picomatch` 以及隔离测试。编译和匹配均在限 128 MiB V8 堆的子进程内执行；父进程使用 2 秒超时和强制终止。CI 的独立探测门禁目前正确返回失败。此处为回归检测，**不是对运行时 matcher 的修复或安全隔离**。
- 构建包装器新增可选 `--output`，本次输出到 `release/security-review-2026-11-18`，避免覆盖原安装包和 win-unpacked。默认打包命令行为保留。

## 完整依赖来源

锁文件包含 496 个安装位置条目（包括其他平台 optional 包），全部带完整性摘要。除已有本地 minimatch 兼容包外，均解析到 npm 官方 registry；完整清单见 `lockfile-review.json`，实际安装图见 `dependencies-installed.json`。

| 安装位置 | 版本 | 来源 |
| --- | --- | --- |
| node_modules/picomatch | 2.3.2 | tailwindcss → micromatch；tailwindcss → fast-glob → micromatch；tailwindcss → chokidar → anymatch/readdirp |
| node_modules/vite/node_modules/picomatch | 4.0.7 | vite 直接依赖 |
| node_modules/tinyglobby/node_modules/picomatch | 4.0.7 | vite → tinyglobby；tailwindcss → sucrase → tinyglobby；electron-builder → app-builder-lib → @electron/rebuild → node-gyp → tinyglobby；tinyglobby → fdir 的 optional peer 也使用此副本 |

三个安装位置均为开发依赖。`npm explain` 的全部父链（包括 electron-builder 的 peer 环）保存在 `picomatch-explain.txt`；不能只依赖 `npm ls picomatch` 的简略展示判断所有来源。

## 补丁评估与阻塞证据

[官方通告](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)当前仍列 <=4.0.7 为受影响范围，`first_patched_version` 为 null；npm latest 仍为 4.0.7。原始响应为 `advisory.json`、`picomatch-registry.json`。维护者对通告的争议不作为风险已消失的证据。

检查并保存了五个上游仓库 PR 的源码、差异、状态和精确 SHA。`evaluate-picomatch.cjs` 将 parser 差异的每个上下文严格匹配、应用到独立候选目录，其他模块沿用对应的已安装主版本；不会修改 node_modules。4.x 补丁在其基分支还包含其他行为修改，因此没有直接用整个 head parser 替换 npm 发布文件。实验检查 10 项短输入合法行为，以及每个候选 9 项有 1 秒强制终止期限的攻击向量。

| PR | 主版本 | 固定 head SHA | 本次行为变化 | 攻击向量超时 | 决定 |
| --- | --- | --- | --- | --- | --- |
| [235](https://github.com/micromatch/picomatch/pull/235) | 4 | 0150ed18b7971894bfd1824c8f96d6b63c70ad1f | 8 | 2 | 已关闭未合并，不采用 |
| [254](https://github.com/micromatch/picomatch/pull/254) | 4 | c63a5bf4e61dbdb81bc41e97dc2616c30acce337 | 2（捕获内容） | 3 | 不采用 |
| [257](https://github.com/micromatch/picomatch/pull/257) | 4 | 4e4892e0ac6c374ec3d9e4dc430101da9a20a37b | 2（捕获内容） | 6 | 不采用 |
| [262](https://github.com/micromatch/picomatch/pull/262) | 4 | 3222059ac27492d9c0147fee5c65f751bbd851ab | 5 | 0 | 合法匹配回退为字面量，不采用 |
| [263](https://github.com/micromatch/picomatch/pull/263) | 2 | 9ca61909ab0ec680953e21bac80a6e825e1ede81 | 5 | 0 | 合法匹配回退为字面量，不采用 |

例如，262/263 把 `+(*a)`、`capture:true` 对 `aaa` 的匹配由 true 改为 false，也不再匹配 `+(*a|b)` 对 `aba`；254/257 对 `aba` 的内部捕获从 `b` 改为 `ab`，且 `+(*a|b)b` 仍超时。235 的未闭合方括号和 `nobracket` 向量仍超时。逐例结果和 parser 摘要见 `candidate-evaluation.json`。

现有三个安装副本对公开 `+(*a)` 等向量仍被父进程超时终止，见 `picomatch-installed-probes.json` 和 `picomatch-check.stdout.txt`。无候选满足本次兼容性及安全条件；没有安装未经验证的 fork，没有把 2.x 全局替换为 4.x。局部样本通过也不能证明所有 glob/RegExp 构造具备线性复杂度。

## 通告、本地补丁和未解决风险分开记录

| 项目 | 状态 |
| --- | --- |
| 完整 npm audit | **18 high，退出码 1**；都是同一 picomatch 通告及其传递影响，不能解释为 18 个独立 CVE，也不能报告为 0 |
| npm audit --omit=dev | **0，退出码 0**；只适用于生产依赖范围 |
| 既有 minimatch 本地兼容包 | 1.0.2 兼容层和官方 11.0.9 引擎保留，依赖兼容与既有安全测试通过；未改名或版本伪装消除告警 |
| picomatch 本地补丁 | **无已部署补丁**；五个候选仅为隔离实验，均拒绝集成 |
| exceljs-hardened 5.1.1 | 保留已有修复及开发者既有维护风险接受；不是上游官方 ExcelJS。相关 pin、策略文件未变 |
| 5 个 deprecated 包 | 既有风险接受不变，复核截止仍为 **2026-12-04** |
| picomatch 风险接受 | **未创建、未批准**；不会借用 ExcelJS 或 deprecated 包的接受条款 |

`npm-audit-full.raw.json`、`npm-audit-production.raw.json` 是 CLI stdout 的逐字节副本，原 stdout/stderr 和退出码也保留。没有使用 `npm audit fix --force`、删除安全检查、篡改锁文件审计元数据，或用自定义包名逃避通告。

未来若部署本地维护补丁，仍需同时保留原始审计、确切上游版本及补丁 hash、受影响路径、隔离和合法行为测试；审计工具未识别补丁时应单独记录验证结论，不得改写原始报告。未知通告、路径/版本变动、证据失效或期限到期应拒绝通过。本次没有足够证据启用任何此类例外。

## 验证结果

| 命令/检查 | 结果 |
| --- | --- |
| npm ci | 通过；用户锁文件字节保持不变，@emnapi 缺失错误未再出现 |
| npm run check:dependencies | 通过；不代表完整审计通过 |
| npm audit --json | 失败，18 high；原始输出保留 |
| npm audit --omit=dev --json | 通过，0 |
| npm run --silent check:picomatch | **预期失败**：现有副本仍可触发 ReDoS，不可当作修复成功 |
| npm test | **171/171 通过**（原 167 + 新增 4）；最终工作流补充后相关 CI 7 项又单独通过 |
| npm run build | 通过 |
| npm run dist:all -- --output release/security-review-2026-11-18 | 通过，Setup、Portable、ZIP 全部生成 |
| 归档静态内容验证 | 通过，见 artifact-verification.json |
| git diff --check | 通过 |

初次测试因 Electron 按需下载被沙箱网络阻断，日志为 `tests.*`；修复安装步骤后完整成功日志为 `tests-final.*`。所有命令的版本、时间、退出码分别保存在 `*.result.json`。没有执行交互式安装或声称已验证 GitHub 远程执行。

三种包均实际解出并比较应用 EXE 和 ASAR 的 SHA-256；Setup 的 app-64.7z 也解开检查。20 个源/构建文件与 ASAR 一致；84 个运行时包的名称和版本符合生产锁文件，包括 ExcelJS fork、minimatch 兼容层及引擎；未包含 picomatch、Vite、Tailwind、electron-builder、旧 exceljs 或 fork 的浏览器 bundle。产物摘要见 `artifact-verification.json`。包未代码签名；本次仅验证静态内容，未执行安装器。

## 最小风险路线和提交准备

推荐保留本次安装/CI 可复现性修正和证据，暂停新的发布，等待或继续开发 **2.x 与 4.x 分开的、保持合法匹配和捕获语义**的补丁，再做上下游测试和产物验证。当前发布阻断是安全门禁正确工作，不能通过改成生产审计替代完整审计来绕过。

如必须紧急发布，只能另行审查有期限的构建时风险接受：限定此 GHSA、三条精确路径和版本及锁文件摘要；仅从审核后的可信提交构建、不允许外部输入定义 glob；使用有期限的隔离只读构建；继续保存完整审计并阻断未知风险；重新核对最终包不存在开发 matcher。当前 Tailwind 内容模式来自固定仓库配置，且最终包不含此依赖，这些降低生产暴露，但**不能证明漏洞已修复或构建无风险**。该路线尚未实施或批准，建议复核期限不超过 7 天，不能擅自延续。

`COMMIT_MESSAGE.txt` 已准备与实际范围一致的提交说明。工作树保留所有改动供复核，未自动暂存用户原有内容或创建提交。安全修复不成熟，版本仍是 1.8.1；后续修复完成才适合升级 1.8.2。v1.8.1 标签、HEAD 和原发布包保持不变。
