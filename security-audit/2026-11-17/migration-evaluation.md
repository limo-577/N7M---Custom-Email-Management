# XLSX 替代库评估（2026-11-17）

开发者本轮先选择评估迁移，再明确批准非官方 fork 的正式迁移。以下保留决策时的评估结果；主项目随后已迁移，最终验证见根目录 SECURITY-AUDIT-2026-11-17.md。

建议候选：非官方、与原维护者无关联的 `exceljs-hardened@5.1.1`。注册表版本、时间、仓库和完整性见 exceljs-hardened-registry.json；不能把它写成官方 ExcelJS 5.1.1。该版本于 2026-11-16 发布，维护历史短，增加对 fork 维护者的供应链信任。

| 方案 | 兼容性和风险 | 建议 |
| --- | --- | --- |
| exceljs-hardened 5.1.1 | 沿用 Workbook API；安全维护 fork；默认依赖仍引入易受攻击的 minimatch；需独立固定修复引擎 | 首选迁移候选，须接受非官方 fork 并完成主项目集成 |
| SheetJS CE 官方渠道当前版本 | API、格式化文本、公式缓存、隐藏工作表处理需要重写；官方文档提示公共 npm 的 xlsx 包过旧，不能直接 npm install xlsx 当作修复 | 作为需要更多改造的备选；本轮未安装或验证兼容性，待确认 |
| 保留 ExcelJS 4.4.0 | 官方 npm 最新仍为 4.4.0，两种原型污染已本地复现；Worker 降低波及范围，不消除漏洞 | 仅作为等待迁移期间的风险状态，不建议长期保留 |

实际验证：

- 隔离安装使用 --ignore-scripts，主 package.json / package-lock.json 未引入候选库。
- 默认候选通过原项目全部 11 项 XLSX 导入测试，但 npm audit 报告 minimatch 及其父链共 4 个 Medium 条目，属于同一根漏洞传播。
- 沿用现有 CommonJS minimatch 适配包会因 ESM 命名导出不兼容而失败，此方案已否决。
- 全新隔离目录 tmp/security-excel-engine 使用 minimatch **11.0.9 官方引擎** override 后，npm audit 0 条，原项目 11/11 项 XLSX 测试通过；保留全部原有 Worker、ZIP、取消和资源预算措施。
- 两个小型攻击工作簿分别触发 x14 conditional-format ID 和 __proto__ definedName：当前库均污染原型，候选库均无污染；所有危险解析都在临时 Worker 内，父进程原型未变化。证据 candidate-probes.json。
- 候选仍含弃用 lodash.isequal 4.5.0；不代表完整消除了维护风险。
- 主项目其他旧依赖仍需 CommonJS 适配包，迁移时必须针对现代父链设置单独 override，不能直接全局替换现有适配包。本轮尚未验证这一主依赖树整合、完整桌面回归和发行打包，待确认。

建议下一步：批准采用非官方 fork 后，定向调整应用 import、测试、构建排除规则及依赖政策；确保现代 readdir-glob 使用官方引擎，旧链继续使用兼容适配；重新安装锁文件并运行完整构建、单元/桌面测试和打包。不要按 npm audit 的建议降到候选 5.0.0，那会退回已有安全修复之前。

来源：[候选仓库](https://github.com/mateocallec/exceljs-hardened)、[x14 公告](https://github.com/mateocallec/exceljs-hardened/security/advisories/GHSA-86ch-m4gp-r5xf)、[definedName 公告](https://github.com/mateocallec/exceljs-hardened/security/advisories/GHSA-pwgq-2cgg-6ph9)、[minimatch 公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)、[SheetJS 官方安装说明](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)。
