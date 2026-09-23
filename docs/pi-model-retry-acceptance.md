# Pi 自动重试验收（2026-09-23）

问题：SDK 在一次 turn 内遇到模型错误后会重试，但 worker 只设置 runError，不清除已恢复的错误。工具已成功、模型也已输出报告，执行仍会变成 failed，阻断 Mastra 安装/卸载的后续角色。

修复：根据最新 assistant message_end 更新最终错误状态。成功清除旧错误；终态 error / aborted 仍阻断。不将工具成功直接当作 Agent 成功，不跳过 Mastra 的回执核验。

## 验证

- `node --import tsx --test tests/pi-model-retry.test.ts`：工具前/后临时500、工具后持续500、鉴权失败，真实 Supervisor/Pi worker 对本地模型执行。修复前2失败/2通过；修复后4/4，通过事件计数保证不重复执行工具。
- `npm test`：47/47；`npm run typecheck`、`npm run build` 通过。
- 相同4项故障测试针对 `/opt/sop-runtime-agentd/dist/src` 与线上依赖重新运行，4/4。使用隔离临时数据库和本地模型，无生产凭据或Provider配置变更。编译版父进程测试需使用绝对路径的tsx loader，防止fork后在临时cwd查找tsx失败。

## 部署与回滚

源 runtime-fleet-ops-188 保留原12e5bf6 Supervisor，只原子更新新fork使用的 `dist/src/workers/pi-worker.js`；相比原编译文件只有本次5行差异。没有重启Supervisor，不中断其他会话。

- 代码：050c2a8（已推送main）。
- 新产物与本地build SHA256一致：`3ca25e18ec35fdf99bf2083e0afd0c7da3b1bc82d1369560b8d9e8d88d410899`。
- 备份：`/opt/sop-runtime-agentd-patches/050c2a8/pi-worker.before.js`。
- 后续完整安装从main获得同一修复。

## 真实 Harness 结果

- 原失败卸载 `agent-workflow-run-mastra-74d22a8df6cddec5a40663c8fc0b164a91c17c0f` 恢复后三个节点完成；沿用原删除作业，没有重复删除，SSH登记保留。
- 新安装 `agent-workflow-run-mastra-372e0dde26a9db36732af5372d86eb9babe9a90b`，三节点完成，无人工恢复；pi/DSH实测通过，页面标准就绪。
- 新删除 `agent-workflow-run-mastra-599c10869246c9d0db8c6b81cee6bf19d72c0a42`，三节点完成，无人工恢复；Runtime与宿主登记均消失，SSH登记保留。
- 上述新删除的巡检 execution `agent-execution-eaf2adca-1d0b-4445-8526-bcbe5163ddad` 实际记录1次 `model.request.failed`，之后completed、error为空；`fleet_workflow_inspect`仅调用1次。线上异常恢复已验证，不仅是模拟测试。

完整页面与后续实例兼容修复验收在 sop-ui 的 `prototype/docs/environment-workspace/lifecycle-acceptance-20260923.md`。
