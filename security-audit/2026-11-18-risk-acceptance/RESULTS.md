# 本轮实际结果（2026-11-18）

机制已经实现并完成本地端到端验证。**CVE-2026-112366 仍未修复，完整审计仍为 18 high。** 没有生产授权、push、标签变更或 Release；版本仍为 1.8.1。

| 检查 | 实际结果 |
| --- | --- |
| 干净本地快照中的 npm ci | 通过，锁文件不变 |
| check:dependencies | 通过，既有 minimatch/ExcelJS 策略保留 |
| 完整 npm audit | 退出 1，18 high；原 stdout/stderr、退出码及逐字节 raw.json 保留 |
| 生产 npm audit | 退出 0，0；没有替代完整审计 |
| 现有 picomatch 隔离探测 | 退出 1，漏洞风险仍可复现；没有重复五个失败补丁实验 |
| 默认严格构建 | 正确拒绝，未消费授权、未生成安装包 |
| 本地签名、同次审计两阶段例外 | 通过，明确记录 acceptedRisk=true、vulnerabilityFixed=false、18 high |
| 完整测试 | 188 项通过；最终工作树完整重跑记录为 npm-test-final.* |
| 最终风险逻辑/CI 增量验证 | 24 项通过，见 focused-tests-final.stdout |
| build + dist:all | 通过，生成 Setup、Portable、ZIP |
| 三种最终归档静态核验 | 通过，含外层归档枚举、Setup 内层 7z、EXE/ASAR 哈希及 ASAR/loose 包排除检查 |
| 故意放入 Vite 的负例产物 | 正确拒绝，没有生成成功报告 |
| 再次使用同一签名 | 正确拒绝，already consumed |
| 显式撤销后再使用 | 正确拒绝，revoked |
| 过期签名 | 正确拒绝，expired |
| GitHub 保护环境读取 | 未认证只读查询返回 404，不能确认环境存在或配置正确；远程入口保持拒绝 |

端到端固定测试提交为 **f185ecb3c1f9eeda5185da781665af4f929b2c51**，只存在于 `test-results/controlled-source-09c91741-7419-45f0-ba71-81ac7d4a4cf3` 的隔离仓库。它不是主仓库提交，不是发布标签。后续对最终归档外层扫描、撤销参数及证据上传的增量加固，另以当前工作树的完整测试和最终归档核验验证；不能把该临时提交当成未来生产授权。

临时授权 ID 为 **8b7f03e8-00e5-4d2f-b188-b0651732e2ae**，类型严格限制为 local-verification。它已被消费并撤销，临时私钥已删除。原计划有效期只有一小时，未使用 7 天上限，不存在可继续使用的生产授权。签名、公钥、消费/撤销回执和完整命令链均在本目录；私钥不在证据或产物中。

验证包复制到：

`release/controlled-validation-09c91741-7419-45f0-ba71-81ac7d4a4cf3/`

| 产物 | SHA-256 |
| --- | --- |
| Setup.exe | d119a19386401bd5ccd07e51ba628abc25488a0e5dbdd231a6e56040c25b163f |
| Portable.exe | 531b08184a129632c28bbd3f2c465688786b5317f567ef2cd069fa8430ccd23a |
| NoInstall.zip | d30465ec59f36a672bd6849d7e5edb8b9d1b835f11044aa60ed70158d402c2b5 |

最终静态检查匹配 20 个源/构建文件、84 个运行时包。三种包中应用 EXE 和 ASAR 均与构建目录一致；未包含 picomatch、Vite、Tailwind、electron-builder 或旧 ExcelJS/browser bundle。未执行交互式安装，产物未代码签名，`releaseEligible`、`publicationAuthorized` 均未设为 true。

第一轮集成暴露了现有中文文件名被路径校验误拒绝，修复后保留测试。第二轮证明同一锁文件下 npm audit 的父依赖元数据确实会变化，精确证据门禁拒绝后没有消费授权。这些原始失败记录保留在 failed-attempt-*，没有通过改写报告消除差异。本地两阶段方案仍逐字节锁定同一次真实审计，而不是忽略 effects/fixAvailable 字段。准备记录及已安装文件任一变化、或准备超过一小时，都会拒绝恢复。

真实发布前仍有两个明确前提：将最终源码审核为一个真实固定提交；由实际批准方配置保护环境/公钥并对该提交、这次运行及审计证据明确签名。目前主工作树含既有未提交内容，远程环境也无法核实，因此**没有授权当前主工作树或任何 GitHub Release**。可验证的替代路线是由批准方在干净本地提交上执行两阶段受控构建，复核完整原始审计及产物后，再另行决定发布。新版本号或锁文件变化都需要重新评估，不能重用本次签名。

残余风险包括 picomatch 构建时 ReDoS、开发工具/生命周期脚本及依赖供应链、受信任签名方/主机/持久账本管理，以及既有 ExcelJS fork 和 deprecated 包的维护风险。该机制是有期限的风险接受，不是漏洞修复，也不能抵御批准方管理员恶意回滚账本或替换信任根。
