# N7M 正式发布准备报告

日期：2026-11-18。版本保持 **1.8.1**。本轮完成的是可审核源码提交和本地验证，**不是发布批准，也没有修复 CVE-2026-112366**。

## 已完成

- 在独立本地分支 `codex/release-preparation-20261118` 整理实现、测试、工作流和证据；保留用户的 @emnapi core/runtime 2.0.0-beta.2 安装修复、minimatch 兼容补丁、ExcelJS 安全措施和依赖维护策略。
- 正式提交不含测试仓库/快照、任何 PEM/私钥、旧测试签名 envelope 或账本文件、验证安装包、账户/密库数据。详细原件保存在本机忽略目录而非删除，范围见 EVIDENCE_SCOPE.md 和 curation.json。
- 发现并修复输入摘要的 CRLF/LF 差异：保护的构建脚本与摘要统一采用 Git blob 字节；普通 release.yml 也在 checkout 前设 `core.autocrlf=false`，与受控工作流一致。没有修改 minimatch fork 的代码或 tarball。
- 修正 ASAR 测试夹具对隐藏 checkout 父目录的依赖：夹具改放系统临时目录，保留原有 unpack 和所有兼容性断言。
- 根据实际 YAML 提供 [管理员操作指南](../../docs/GITHUB_RELEASE_SETUP.md) 和 workflow-contract.json，并将准确配置名称纳入现有 CI 回归断言。
- 保留默认严格门禁、完整原始审计、真实 ReDoS 探测和三种包的静态检查。没有应用任何生产风险例外。

本轮验证的精确暂存 **tree** 为 `2ff2ea7bb14dfe9ea0e10dcf44b7e8a46da924e8`。这是 tree 对象，**不能拿来填写批准声明中的 commit SHA**。最终正式提交承载本报告，只追加/整理非执行的证据和归档说明；全部执行代码、锁文件、配置、测试及签名依赖证据与被测 tree 对照检查。正式提交 SHA 由 `git log -1` / 本次交付的本地 Git 回执确定；签名必须针对实际最终 commit。

### 本轮真实验证结果

从该暂存树以 `core.autocrlf=false` 导出干净候选，没有复制工作副本的 node_modules、环境文件、密钥或测试缓存。工具链 Node **24.13.0**、npm **11.6.2**。

| 项目 | 实际结果 |
| --- | --- |
| npm ci | 通过；lockfile 字节不变，@emnapi 缺失错误未再出现 |
| npm run check:dependencies | 通过，原维护期限和保护 pin 不变 |
| 完整 npm audit | **18 high，退出 1**；原始报告 npm-audit-full.raw.json，未过滤 |
| 生产 npm audit | **0，退出 0**；只适用于生产依赖，不替代完整审计 |
| check:picomatch | **退出 1，风险仍可复现**；所有攻击匹配都在有超时的子进程中 |
| npm test | **188/188 通过，0 失败**，见 npm-test.stdout |
| npm run build | 连续两次通过，3 个前端产物的路径和内容摘要一致 |
| npm run dist:all | 对同一源码树执行两次，Setup/Portable/ZIP 均成功 |
| 静态安装包验证 | 两次均通过；20 个源码/构建文件匹配，84 个运行时包符合生产锁文件，无禁止的开发包 |
| 两次打包运行时对比 | **73 个运行时文件逐字节一致**，包括应用 EXE、app.asar 和其余运行时资源 |
| 封装文件位级可复现 | **未达到**：两次 Setup/Portable/ZIP 的整体 SHA-256 不同；不得据此声称所有安装包位级可复现 |
| 提交范围/敏感签名检查 | 全量暂存 blob 扫描；无匹配的敏感内容或被禁止的生成产物路径，最终回执另存本机忽略目录 |

lockfile SHA-256：`d84d05fb69daef713726fb3ed25b5bb0550b342f8a26971cf756df3aeb620426`。

本轮完整 raw audit SHA-256：`71e07cce1769d338fc85e4eaa2b7fc722aad4cde813dded7d5ca69e2749d2ee4`。

审计和隔离探测均失败后，本轮仅按用户指令执行**本地验证构建**，未将它们视为通过的发布门禁，也未签发任何例外授权。所有步骤的真实退出码见 commands.json，汇总见 verification.json。没有复跑之前五个失败的 picomatch 补丁实验。

其他目录中历史文件即使名称含 current，也不能代替本目录这次真实运行的审计结果；旧原始报告仍按历史证据保留。

验证包位于本机已忽略的 `release/commit-review-2ff2ea7bb14d/`。它们不是新版本 Release，也不能覆盖已存在的 v1.8.1。

| 第一轮验证包 | SHA-256 |
| --- | --- |
| Setup.exe | dfabcdb265a8ca0391d6e2b3f3036af3e15c8b9cb6efc254278c92b48a2833f7 |
| Portable.exe | 303cf330d1672b45237846b5adfdaeafd3eedd3ac197fd757037bc473785aad1 |
| NoInstall.zip | 8c635014331e7dad4174c63ccd2066213722e2644ed853d7649a213769604eb8 |

完整比较含第二轮摘要，见 reproducibility.json。最终发布审核必须选择一组确切产物摘要，不得以“运行时一致”替代对拟上传封装包的确认。当前未配置代码签名，也未执行交互式安装测试。

## 需要管理员操作

1. 由用户另行批准后，才送审/推送/合并源码，保护 main 及安全相关文件。本轮只创建本地提交，不推送。
2. `release.yml` **没有声明 Environment**，保持完整严格审计；不能猜测存在名为 production 或 release 的环境。
3. 例外只属于 `controlled-build.yml` 的 `picomatch-risk-acceptance`；默认严格手动模式是 `strict-build`。管理员需确认账号计划支持 required reviewers，设置独立 reviewer、Prevent self-review 和 main 分支限制。
4. 在例外环境设置准确的变量 `N7M_RISK_PUBLIC_KEY`（Ed25519 SPKI PEM 公钥）、`N7M_RISK_REVOKED`（默认 true），及 secret `N7M_RISK_AUTHORIZATION`（每次真实批准的签名 envelope）。不得上传私钥，不能使用旧测试公钥或签名。
5. 用有权限的账号核实环境。此前未认证读取返回 404，**不能确认当前存在/不存在或是否配置正确**，本轮没有改变远程设置。实际 workflow 必须能通过只读 API 验证保护规则，否则继续阻断。

具体 UI 路径、变量/secret 区分、所需只读权限及撤销步骤见管理员指南。本轮没有创建远程环境、修改 GitHub secret 或扩大构建写权限。

## 需要正式安全风险批准

实际批准方须独立评估仍存在的构建时 ReDoS 和供应链风险，再决定是否签发。声明只能锁定这一 GHSA、三个已知位置/版本、最终固定提交、完整源码/lockfile 摘要、一次真实审计和证据、唯一运行及最长 7 天有效期。未知漏洞、生产暴露、新依赖路径、锁文件或证据变更都拒绝。

旧本地测试授权已消费并撤销，测试私钥已删除，本轮没有复用，也没有生成生产授权。Git 提交本身不是风险接受签名。

本地两阶段路线可封存同一次安装和 audit，再由批准方显式签名；准备记录最多一小时，源码、已安装文件或 raw 报告任一变化都拒绝。GitHub 路线仍要现场重跑门禁并逐字节匹配已批准报告；npm 的父依赖元数据会变化，发生差异只能拒绝，不能删除字段。该远程例外路线尚未验证成功。

## 尚未修复的漏洞和限制

- **CVE-2026-112366 / GHSA-fc5q-39xc-vjpf 未修复**。完整审计 18 high 是该通告及传播链，不是生产审计 0 的反面证据，也不是 18 个独立 CVE。
- picomatch 只在构建工具链中，但这不等于构建无风险；最终安装包排除它只是降低终端用户暴露。
- 既有 ExcelJS fork 和五个 deprecated 依赖的维护风险保留，复核期限仍为 2026-12-04，没有借用其风险接受条款豁免 picomatch。
- 安装包整体不是位级确定性产物；当前未配置代码签名，未执行交互安装，GitHub 托管 runner 和保护环境也未获本轮远程验证。

## 可以执行正式发布的条件

以下均满足后才能提交最终发布决定：

1. 最终源码和版本被审核为真实固定 commit；新 Release 使用新的版本/标签，不能修改 v1.8.1。任何版本、锁文件或合并 SHA 的变化都需要重新验证和批准。
2. 普通自动发布路线必须先通过完整严格门禁；**当前不满足**。若使用临时例外，须有实际批准方有效、未消费、未撤销、未过期且精确绑定本次输入的授权。
3. 管理员完成并核实必要远程保护；没有审核能力、密钥/签名缺失或读取失败，保持阻断。
4. 对拟发布的同次包完成测试与静态核验，明确显示完整 audit 的真实结果、风险接受和签名状态，并逐一确认 Setup/Portable/ZIP 的 SHA-256。
5. **用户另外明确批准推送、创建新标签及上传 Release**。当前受控工作流只生成供审核的构建，不会自动出版；不得悄悄连接到拥有写权限的 publisher。

因此本次交付状态为：**本地源码提交和证据可正式审核；真实发布仍待管理员操作和安全风险批准。**

备注：原始 PR `.diff` 中的空白上下文行按原文保存，Git 全量 whitespace check 会提示这些数据行；执行源码的 whitespace 检查通过。没有为通过检查而改写原始补丁或审计报告。中止/失败的验证原件均保留在本机 `.risk-build/preparation-run/`，未混同为最终成功结果。
