# GitHub 发布与一次性风险批准配置

本指南以本仓库实际 YAML 和代码为准，机器可读对照见 `security-audit/release-preparation/workflow-contract.json`。不包含生产密钥、真实签名或自动授权。

## 先区分两个工作流

| 文件 | 触发与权限 | Environment | 结果 |
| --- | --- | --- | --- |
| `.github/workflows/release.yml` | `v*` 标签 push 或手动；构建只有 contents:read，标签发布任务才有 contents:write | **未声明环境** | 完整严格审计和 ReDoS 门禁通过才构建；只有标签 push 才自动发布同次运行的包。手动执行不发布 |
| `.github/workflows/controlled-build.yml` | 仅本仓库 main 的 workflow_dispatch；contents:read、actions:read | mode=strict 用 `strict-build`；mode=picomatch-once 用 `picomatch-risk-acceptance` | 只生成供另行审核的构建和证据，**没有 Release 发布步骤或写权限** |

所以配置例外环境不会改变 release.yml 的严格门禁。当前 18 high 和实际 ReDoS 探测仍会阻断普通标签发布。不要创建新标签试图绕过，更不能移动/重推已有 v1.8.1。

## 仓库管理员需要执行的操作

下列设置必须由个人仓库所有者，或组织仓库 admin 执行。先确认账号计划/仓库可见性支持 required reviewers；如果界面没有相应能力，保持阻断，不能用无审核环境代替。参见 [GitHub 环境管理文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。

1. 用户另外确认后，才将本地审核提交送审/推送并合并 main。本任务不做这一步。保护 main，要求代码审查和状态检查，限制直接改写工作流、风险控制器及证据的权限。签名应绑定最终 main 的实际 SHA；合并产生新 SHA 时不能沿用分支或测试快照授权。
2. 在仓库 **Settings → Environments** 创建准确名称 `picomatch-risk-acceptance`。
3. 开启 **Required reviewers**，指定独立批准人/安全团队；开启 **Prevent self-review**。工作流会读取 GitHub API，必须看到非空 required_reviewers 和 `prevent_self_review: true`，否则拒绝。管理员不能替安全批准方代签风险声明。
4. 将可部署分支限制为 main（Selected branches and tags 中仅选 Branch main，或等效的受保护 main 设置）。建议禁止管理员绕过保护规则；代码另外验证本仓库、main、固定 workflow_ref、run_id 和 attempt=1。
5. 在该 Environment 的 **Environment variables** 配置下表两项，在 **Environment secrets** 配置一项；不要放在同名 repository/org 变量中依赖回退，也不要把私钥上传到任何 GitHub secret。
6. 可以另建 `strict-build` 环境以便管理严格手动构建；它不需要风险公钥/签名。没有这些风险配置也不能将 strict 变为例外。
7. 保持 Actions 允许已固定 SHA 的官方/已审核 Actions。不要给构建任务 contents:write 或更大 token。actions:read 只用于读取环境保护设置；[该 API 的权限说明](https://docs.github.com/en/rest/deployments/environments#get-an-environment)列出 Actions read。读取失败时应查访问权限/计划，不能删除检查。

| 准确名称 | 类型和位置 | 含义/初始安全值 |
| --- | --- | --- |
| `N7M_RISK_PUBLIC_KEY` | `picomatch-risk-acceptance` 的 Environment variable | 实际批准方 Ed25519 的 **SPKI PEM 公钥全文**，保留多行。由代码 `crypto.createPublicKey` 解析。不是 GitHub token、GPG 指纹或证书路径 |
| `N7M_RISK_REVOKED` | 同环境的 Environment variable | 初始设为字面量 `true`；只有针对这次真实批准才明确改成字面量 `false`。缺失、True、空串等都不会放行 |
| `N7M_RISK_AUTHORIZATION` | 同环境的 Environment secret | 批准方签名的 JSON envelope 全文，只有 `statement` 与 `signature`。按每次真实运行单独更新，不能填入旧测试授权 |

YAML 将它们分别映射为预检进程的 `RISK_PUBLIC_KEY`、`RISK_REVOKED`、`RISK_ENVELOPE`；控制器另接收 `N7M_RISK_REVOKED`。`BUILD_MODE` 来自工作流 choice 输入，`GH_READ_TOKEN` 来自只读 github.token。以上进程变量不是需要管理员另建的 secrets。

本机此前未认证 GET 返回 404，只能说明当时无法核实环境，不能断言环境一定不存在。必须由有权限的管理员检查当前设置。本文没有声称已创建、连接或验证远程环境。

## 正式安全批准方需要执行的操作

批准方的 Ed25519 私钥应离线保管、位于源码 checkout 外，不进 Git、不进 runner、不进安装包。私钥生成和生产签名都必须在明确批准后由实际批准方操作，本任务没有生成它们。与仓库管理员核对公钥信任根，保留批准人、理由和撤销记录。

签名只接受 GHSA-fc5q-39xc-vjpf / CVE-2026-112366，固定以下开发依赖：

| 安装位置 | 版本 |
| --- | --- |
| node_modules/picomatch | 2.3.2 |
| node_modules/tinyglobby/node_modules/picomatch | 4.0.7 |
| node_modules/vite/node_modules/picomatch | 4.0.7 |

声明还绑定：一个真实固定 commit、全部已提交源码摘要、lockfile 逐字节 SHA-256、一次完整原始 audit 逐字节摘要、调查证据集合/摘要、批准人、原因、起止时间、一次运行上下文。最长 7×24 小时，无自动续期；调查日期不可伪造刷新。unknown advisory（包括 low）、生产漏洞、新路径/版本、锁文件或证据变化、审计/探测执行异常均拒绝。

### 本地两阶段审核路线（已验证）

在准确最终提交的干净 checkout 中设置 `core.autocrlf=false`，确保文件字节与 Git 一致，使用 Node 24.13.0/npm 11.6.2。

1. 执行 `node build/controlled-build.cjs --mode review --run-id <新的UUID> --output <checkout内.risk-build下的新空目录>`。它真正执行 npm ci、依赖策略、完整 audit、生产 audit、隔离探测，封存报告及已安装文件清单；不构建、不批准。
2. 实际批准方先审核这次 raw audit（仍为 18 high）和上下文，再执行 `--mode issue`。必填参数包括同一 `--run-id`、checkout 外的绝对 `--ledger`、`--private-key`、`--approved-by`、`--reason`、明确 `--expires-at`、与已锁定调查执行记录 end 完全一致的 `--evidence-at`、`--acknowledgement`。`--envelope` 指向这次 review 目录下尚不存在的 authorization.json；签发输出用另一个新空 `--output` 目录。完整声明的准确值为：

   `I accept the unresolved picomatch CVE-2026-112366 for this one build only`

3. 使用 `--mode picomatch-once`、同一 `--run-id`、`--ledger`、`--envelope`、`--public-key` 和 `--prepared <这次review目录>`，在新空输出目录恢复。准备记录不得超过一小时，源文件、依赖文件及报告任何变化都拒绝；不是重用历史调查报告，也不声称重新跑过审计。
4. 授权在构建前原子消费，构建失败也不能重用。然后执行完整测试、dist:all、三种包静态检查，记录所有真实高危发现，`publicationAuthorized` 仍为 false。
5. 需要撤销时，使用 `--mode revoke --ledger <同一绝对账本目录> --id <真实授权UUID> --reason <原因>`。账本由批准方持久保存，不能删除或回滚备份。发布仍是另一个用户决定。

这些是待批准方执行的操作协议，不是本次自动签发授权的命令。测试用临时公钥、签名、已撤销记录和测试快照都不在本次正式提交范围内，不能代入上述参数。

### GitHub 单次例外路线（仍需远程验证）

1. 管理员完成环境配置，用户批准后，在 main 的 “Controlled one-run Windows build” 选择 `mode=picomatch-once` 发起一次新 workflow_dispatch，让任务停在环境审批等待状态，先不要批准运行。记录真实 commit SHA 和 run_id。
2. 离线批准方在该精确提交的干净 checkout 收集并审核新鲜 audit。使用 `--mode issue --context <上下文JSON文件>` 签发 GitHub 上下文；不使用 `--prepared`。上下文必须是：

   ```json
   {
     "kind": "github",
     "repository": "limo-577/N7M---Custom-Email-Management",
     "runId": "本次实际数字run_id",
     "attempt": "1",
     "event": "workflow_dispatch",
     "ref": "refs/heads/main",
     "workflowRef": "limo-577/N7M---Custom-Email-Management/.github/workflows/controlled-build.yml@refs/heads/main"
   }
   ```

3. 管理员把本次真实签名 envelope 写入准确的 Environment secret，确认对应公钥和 `N7M_RISK_REVOKED=false`，独立 reviewer 审核一致后才批准该任务。环境 secrets 在受保护任务获准启动后才可使用，参见 [GitHub 环境保护文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。
4. 工作流执行仓库代码前先验签并核对 commit、run_id、attempt、workflow_ref、期限和保护环境。随后它重新安装、完整审计、隔离探测；原始结果必须与签名逐字节一致。npm audit 的 effects/fixAvailable 元数据已观察到会变化：**即使不是新 CVE，也会拒绝，不得过滤字段来放行**。此远程路线未实测成功，不承诺仅配置环境就能成功。
5. GitHub 不支持本实现的本地 prepared 恢复；不下载其他运行的 node_modules 或来源不明的构建。发生差异或失败，保留证据、保持阻断；新评估需新的显式批准，不能重跑同一授权。GitHub `run_attempt>1` 和另一 run_id 均拒绝，见 [上下文定义](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)。
6. 运行中撤销应**取消该工作流**并撤下待用签名、把变量置回 true。变量/secret 在启动时取快照，修改后台值不会自动更新已经启动的进程。成功后也删除/撤销待用授权，保存证据 artifact；该工作流没有自动发布功能。

## 用户另外确认发布前的清单

- 新版本不能覆盖现有 v1.8.1。版本、锁文件或最终提交有变更，就要重新验证和审批，不能沿用本次或旧测试授权。
- 必须有有效的正式安全风险批准，清楚保留 18 high、未修复 CVE 和未代码签名等实际限制。
- 必须复核该次 commit、审计、测试、静态包检查与三种包的 SHA-256；运行时包不得含 picomatch、Vite、Tailwind、electron-builder。
- 普通 release.yml 路线仍要求严格门禁通过；当前不能走这条自动发布路线。例外工作流只有审核包，正式上传 Release 须用户另行明确批准并执行独立、受审查的发布操作。不能偷偷把两条流水线接通或增加写权限。
