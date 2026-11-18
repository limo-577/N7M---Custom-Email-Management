# 1.8.2 本地审核与独立发布

2026-11-18 GitHub 已撤回 GHSA-fc5q-39xc-vjpf。完整与生产审计必须真实为 0；历史 18 high 原始证据保留，撤回不代表 matcher 修复。原始隔离探测仍有 24 个超时。

当前路线：本地 review → strict 受控构建 → 人工审核 → 独立发布。不需要 GitHub Environment 或风险签名。旧 picomatch-once 是历史通告例外，不适用于当前零发现审计；不得生成、复用或冒签授权。

使用干净 checkout 的最终固定提交、新 UUID 和新的空输出目录：

```powershell
node build/controlled-build.cjs --mode review --run-id <新UUID>
node build/controlled-build.cjs --mode strict --run-id <另一个新UUID>
```

每次均重新安装、审计并记录原始探测。review 还执行八项 glob 边界/资源控制测试；guardedBuildEligible=true 只表示可进入受控构建。strict 必须通过全部测试、三种打包、实际 matcher 覆盖证明和最终归档核验，才生成 build-result.json 的 releaseEligible=true。publicationAuthorized 始终为 false。

门禁要求审计无任何发现、固定提交/锁文件/输入配置满足策略、glob 边界强制生效、Windows 进程树 CPU/提交内存/进程数/墙钟限制有效、三份实际 matcher 都验证了输入、没有被依赖捕获的拒绝事件，且 Setup/Portable/ZIP 不含 picomatch、Vite、Tailwind、electron-builder。任一失败即阻断，无不受限回退。

证据及残余风险见 security-audit/2026-11-18-withdrawal/README.md。这只约束构建，不修复上游 matcher，不能作为敌对仓库代码的执行沙箱。放宽 glob 或资源预算需要另行评审、明确批准、重新实现和测试，不能用旧授权绕过。

旧 v1.8.1 标签不得移动。建议新标签 v1.8.2，创建前须确认未占用。未经明确批准，不 push、不创建标签、不上传包、不创建 Release。发布前复核远程 main 关系、固定 SHA、同次审计/测试/静态核验和三个真实 SHA-256。SHA 变化必须重新验证。

当前安装包没有 Windows Authenticode 代码签名。文件 SHA-256 不能称为代码签名。
