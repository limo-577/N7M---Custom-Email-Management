# 一次性构建时风险接受机制

本轮沿用 ../2026-11-18/README.md 的调查，不重复五个失败补丁实验。CVE-2026-112366 没有被本轮代码修复；18 high 和生产审计 0 的范围必须分开显示。

## 两条明确分开的路线

原 release.yml 和 weekly review 继续严格阻断；本轮还为严格发布增加三种安装包静态验证。新增 `npm run build:controlled` 默认 strict，完整审计或隔离探测失败就拒绝。`review` 只收集真实审计和探测证据，绝不构建。

只有显式 `--mode picomatch-once` 可评估例外，必须提供独立 Ed25519 签名授权、公钥和外置持久消费账本。签发还必须输入完整风险声明，默认不生成授权、不生成生产签名密钥、不自动延长期限。

签名声明锁定：仓库、固定 commit、所有已提交源码的 SHA-256 清单摘要、lockfile 的逐字节 SHA-256、三个 picomatch 位置及 2.3.2/4.0.7 版本、当前原始完整审计逐字节摘要、调查证据的精确文件集合及摘要、签发人与理由、发行/截止时间、一次运行的标识及 attempt=1。本地授权还绑定唯一外置账本位置。本地测试签名与 GitHub 运行签名不是同一种上下文，不能互换。

最长有效期是签发后 7×24 小时，到期边界直接拒绝。调查证据日期必须等于已有真实审计执行记录，且签发时不得超过 7 天；不能通过传入新日期刷新旧调查。过期需重新调查、复核和签名，程序无自动续期分支。

所有源码必须已经提交且工作树干净，任何新增文件、未提交修改、符号链接、签名不符、commit/source/lock/evidence 变化均拒绝。完整审计仍真实执行、保存 stdout/stderr/退出码；唯一可接受根通告为 GHSA-fc5q-39xc-vjpf。未知 low/high 通告、审计错误、缺失节点、生产依赖暴露、无根循环和虚假 totals 均拒绝。npm 传播的父依赖环只在确实可达该单一通告时纳入评估。当前原始审计摘要稍有变化也需要重新授权。

## 一次性和撤销

通过所有前置检查后，控制器在构建前使用排他创建 `wx` 写入消费回执并 fsync；并发请求最多一个成功。构建失败也消耗授权，没有自动重试。改变本地账本路径不能重用签名。每个后续阶段及产物核验后重查有效期、源码、证据、撤销标记和消费回执；账本文件丢失或回滚也拒绝继续。

本地通过 `revoke` 写入不覆盖的撤销记录。账本应由批准方保管、位于 checkout 外部，不能清理或恢复旧备份；能删除/回滚批准方账本的管理员位于系统信任边界内，普通文件账本不能抵御恶意管理员恢复磁盘。发布决策另行审批，机制没有自动上传 Release 的代码。

GitHub 入口 `controlled-build.yml` 只允许本仓库 main 上的 workflow_dispatch，mode 默认 strict，没有 PR、外部 checkout、自由文本 glob、构建缓存恢复或自动发布。例外在 `picomatch-risk-acceptance` Environment 中等待独立审核。执行仓库代码前用 inline Node 验签并校验 GitHub 固定 SHA、run_id、run_attempt、workflow_ref，再通过只读 API 验证环境具有 required reviewers 和 prevent_self_review。环境不存在、配置无法读取、签名/公钥缺失、撤销变量不是字面量 false，均拒绝。

GitHub 签名绑定具体 run_id 且只允许 attempt=1：新运行和 rerun 都不能重放。该只读单任务工作流没有发布 token、矩阵或复用授权入口。私钥不放到 GitHub runner。环境批准人/密钥管理员属于信任边界；其职责是审核已签名的精确提交。环境变量在 job 启动时取快照：**运行期间撤销应取消该工作流，并撤下待用签名**，不能假称运行中修改变量会自动推送到现有进程。已生成产物也不能绕过后续独立发布审查。

## 可信 glob 与输入范围

`security-audit/picomatch-build-inputs.json` 固定 Tailwind、Vite、PostCSS、Windows 包装器及 Portable 脚本的当前字节摘要。Tailwind 只扫描仓库内固定 index.html/src 模式；构建与 dist:all 命令及包装文件 glob 必须匹配已审核值。整个 Git 源码清单也被签名，避免只校验单个配置而漏掉导入代码。

控制器先验签、再运行 npm。依赖由固定锁文件的 npm ci 安装；不接受仓库 .npmrc，使用空 user/global npm 配置。子进程环境白名单移除 NODE_OPTIONS、NODE_PATH、npm 覆盖、外部 glob 变量、Electron 镜像/路径覆盖及 GitHub 凭据。OS/代理配置仍是执行环境的信任边界；本地 Node 进程启动之前的恶意宿主环境无法由已启动的 JS 自行修复。GitHub 使用临时托管 Windows runner，固定 Node/npm 和 Action SHA，依赖下载由锁文件 integrity 验证。

这些控制限定的是已审核的构建输入，不证明 picomatch 的正则算法安全。构建工具、npm 生命周期脚本及依赖供应链仍是残余风险；作业 30 分钟超时、只读 token、独立进程及静态产物核验只是降低影响。

实际文件系统还会扫描：不能仅凭 git status 干净就允许被 .gitignore 隐藏的 `.env.production` 或 `src/dist/injected.jsx`。只有顶层、固定的生成目录可例外；源码目录中的未知/忽略文件和链接均拒绝。

## 产物检查

`build/verify-release.cjs` 对 ASAR 和 loose/unpacked 资源拒绝 picomatch、Vite、Tailwind、electron-builder、旧 ExcelJS 及 fork 的浏览器 bundle，检查运行时包匹配生产锁文件和保护 pin，并核对源码。实际解出 Setup 的 app-64.7z、Portable 和 ZIP 的应用 EXE/ASAR，逐项比较构建目录 SHA-256。不运行安装器，不宣称经过交互式安装或签名验证。严格路线和例外路线都调用该检查；检查失败不能上传为已验证构建。

## 授权操作协议

1. 先审核并提交源码，使用干净 checkout 和空 `.risk-build/<run>/review` 目录运行 `--mode review`，获得完整原始审计。审计结果不得过滤或手工改写。
2. 批准方在该精确 checkout 使用 `--mode issue`、外部私钥、批准人、理由、明确截止时间和完整风险声明签发。`--envelope` 指向 review 目录中尚不存在的 authorization.json；当前实现只接受一小时内的真实审计执行记录。`--evidence-at` 必须等于已锁定调查记录的 end 值。
3. 本地显式提供 `--run-id` 与 `--ledger`；GitHub 离线签发通过 `--context` 指向本次等待审批运行的 JSON 上下文，其中 kind=github、repository、runId、attempt、event、ref、workflowRef 必须精确匹配。公钥放 Environment variable `N7M_RISK_PUBLIC_KEY`，签名 envelope 放 Environment secret `N7M_RISK_AUTHORIZATION`，`N7M_RISK_REVOKED` 只有显式 false 才允许评估。签发前不得把私钥传给 runner。
4. GitHub 例外仍重新 npm ci、完整 audit、生产 audit 和隔离探测，必须逐字节匹配签名证据才消费授权，然后测试、dist:all、静态验证。所有输出写入新目录，拒绝覆盖。构建最终记录 publicationAuthorized=false、vulnerabilityFixed=false，并保留高危数量。
5. 消费后、失败后、过期后或撤销后不能重用；若真要重新评估，必须由批准方重新审核和显式签名，不能由工作流自动续签。发布仍需用户另外明确确认，不改变已有 v1.8.1 标签。

完整 CLI 参数由 `build/controlled-build.cjs` 定义；不接收自定义构建命令或 glob。测试使用的临时密钥只用于 local-verification，不能形成 GitHub 授权。

### 本地同一次构建的两阶段审批

实测 npm audit 在相同锁文件上也可能改变父依赖的 effects 和建议修复信息。逐字节不同依然拒绝；不能删除这些字段或只比较安全通告来冒充证据未变。

为避免在审批前后各跑一次 audit 导致不同，本地可先 review（或默认 strict 的拒绝阶段）完成**这一次运行**的 npm ci、策略检查、完整和生产 audit、隔离探测，保存并封存。批准方随后签名精确原始证据；同一 runId 通过 `--prepared <review目录>` 恢复。封存额外绑定所有报告、原命令及退出码、安装后的 node_modules 每个文件/链接的摘要。恢复前必须全部匹配，准备记录最多保留一小时，不能替换源码、依赖、报告或上下文。审批时间不自动刷新调查日期。

恢复步骤不会声称重新执行了 audit；它逐字节复制此前同一次运行的原报告，并用单独 continuation 事件指向原始命令记录。完整审计检查并没有关闭，也不是用旧调查报告代替本次审计。签名包含封存目录与摘要，没有此项签名不得恢复。后续任何一次新运行都需重新安装、审计和审批。

此两阶段恢复**仅限本地**。GitHub 入口仍使用新鲜执行的完整门禁；若 npm 返回的原始 JSON 与签名不符，即使只是父依赖元数据变化，也拒绝且不消费授权。尚未实现跨 GitHub 作业的准备产物交接，也不会下载来源不明的 node_modules 来绕过校验。因此当前可验证的受控路线是本地完成两阶段审批和构建，再由用户独立决定是否发布；不能声称远程例外构建已成功。

## 本地验证与实际发布前提

自动测试覆盖期限、未知漏洞、路径/版本/生产范围变化、lock/source/commit/raw-audit/evidence 变化、恶意路径与环境输入、签名伪造、重放、撤销、显式声明和并发排他消费。完整 CLI 与三种包的实测结果将保存在本目录的 `validation-result.json` 及相关原始输出；旧调查输出不被覆盖。

当前项目工作树仍含用户原有未提交改动。因此本地端到端验证在 `test-results` 下创建独立 Git 快照，只给该测试提交签发 local-verification 授权，不提交主仓库、不推送、不配置或更改 GitHub 环境。生产授权尚未签发。必须完成真实精确提交审核、配置独立批准方公钥和保护环境，才能走真实例外构建；无法核实这些条件时继续阻断。是否允许实际发布是另外的决定，不由本机制自动作出。
