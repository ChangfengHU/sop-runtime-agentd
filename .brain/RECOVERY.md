# sop-runtime-agentd 恢复剧本

## 部署形态
- 生产:host-84(84.8.217.45)`/opt/sop-runtime-agentd`,systemd `sop-runtime-agentd.service`,监听 `127.0.0.1:8789`(不对公网,藏在 Runtime Bridge 后)。
- **线上 User=claude**(引擎登录态在 /home/claude);仓库 `deploy/sop-runtime-agentd.service` 仍写 User=root,照抄重装会退化(症状:codex 401 / claude "未登录")。
- 其他 Runtime 宿主(host-188、65)上 agentd 必须用 **8790**:8789 被 linux-clash-dashboard 占;agentd 侧 `SOP_AGENTD_PORT=8790`,machined 侧 `~/.machined.env` 加 `MACHINED_AGENTD_URL`。
- 仓库:`ChangfengHU/sop-runtime-agentd`,分支 main。

## 金库键
- `ssh:host-84-8-217-45`— 登生产机的方式;私钥本体在 `ssh:fleet-operator-key`。
- `service:dashscope` — pi-agent(agentd provider)的模型认证,machined ensure-agents 写 provider 时用。
- `service:github` — clone/push 仓库的 token。
- 引擎凭据文件 `/etc/sop-runtime-agentd/credentials/`(root 700)是机器本地的,不在金库;claude/codex 登录态只能人工。

## 验活
```bash
# 机上(或经 ssh):
curl -s http://127.0.0.1:8789/health
systemctl status sop-runtime-agentd.service
bash /opt/sop-runtime-agentd/scripts/smoke.sh
```
经 sop-ui:`GET /v1/adapters/metrics`(七引擎 probe,harness.vyibc.com 的 Agents 卡片全绿即健康)。

## 从零重建
1. 前置:Node **≥22.19**(NodeSource node_22.x;188/65 都是从 20 升的 22.23.2,回滚锚点见 sop-ui STATE)。
2. `bash scripts/install.sh`(clone → build → 装 systemd → 起服务);端口冲突机器加 `--port 8790`。
3. **装完手改 unit 的 User=claude 再 daemon-reload**(仓库文件还写 root,见上)。
4. provider 配置 `/etc/sop-runtime-agentd/providers/*.json`:正路是 sop-ui `/runtimes/new` 工作流里 machined ensure-agents 自动写(key 出自 `service:dashscope`);手工格式见 README「Provider Profile」。
5. **人工步骤**:claude `/login`、codex 登录(登录态难重获,machined 删 Runtime 时也因此保留这两个引擎);其余引擎(dsh/hermes/openclaw)machined 可自动装。
6. 跑一遍验活;dsh 换过模型端点的机器还要 `ensure_dsh_profile`(profile 补丁 + `session.selectModel` 钉默认,见 sop-ui STATE 2026-08-24)。

## 依赖与连坐
- **唯一消费方 sop-ui**(`agentd.runtime`)。改 `src/contracts.ts` 的任务/事件协议必须两边同步——两项目尚无联合验收,没有自动兜底(relations 记名坑)。
- consumes `vault.config`(mcp:vyibc-vault):各引擎认证配置来源。
- 版本徽章:sop-ui 读 `src/supervisor.ts` 的 SUPERVISOR_VERSION,不读 package.json。
- 雷区详单(persistentSessions 开关、dsh /api 信封、codex 预建 thread)见 `.brain/STATE.md`;协议真相看 `src/http-server.ts`+`src/contracts.ts`,**别信 README**。
