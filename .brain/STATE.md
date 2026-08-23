# sop-runtime-agentd 状态卡

## 定位
SOP 平台 Runtime 本地控制面守护进程:把多种 agent 引擎(sop-native/codex/claude-code/hermes/
openclaw/dsh/opencode)归一成统一的 执行/会话/事件/审批/webhook 契约。Node 22 + TS,
`node:http` 手写路由,`node:sqlite` 持久化。对外承诺 `agentd.runtime`,唯一消费方 sop-ui。

## 现状
- main 与远端同步。8 月下旬整轮主题是**性能**:各引擎冷启动全面砍掉(常驻进程/预建会话池/
  dsh 改接常驻 web 的 /api),量级从几十秒降到个位数秒。
- 生产在 runtime-84(84.8.217.45)`/opt/sop-runtime-agentd`,systemd 跑 **User=claude**
  (登录态都在 /home/claude,root 读不到)——但仓库 service 文件仍写 User=root,重装会退回。
- brain 只有能力声明和这张卡,交接文档(HANDOFF/TASKS)还欠着,踩坑史记在 sop-ui 的 dev-log 里。

## 下一步
1. 仓库 `deploy/sop-runtime-agentd.service` 的 User 与线上对齐(claude),消除重装退化
2. 版本双口径统一:package.json 0.1.0 vs src/supervisor.ts 的 SUPERVISOR_VERSION(sop-ui 拿后者做徽章比较,改版本改 supervisor.ts)
3. README 的 HTTP API 章节与 http-server.ts 实况对齐(sessions/webhooks/steer/approval 全没写)

## 阻塞
- 无硬阻塞;内部 token 收口(bridge 公网代理敞口)记录在 sop-ui evidence,属跨项目统一动作

## 关键路径
- 协议真相看 `src/http-server.ts`(路由)+ `src/contracts.ts`(zod,与 sop-ui 的协议面),**别信 README**
- 核心 `src/supervisor.ts`;适配器在 `src/adapters/`(acp=hermes+opencode 共享常驻进程)
- 部署:`scripts/install.sh`;验活:`scripts/smoke.sh` 或 `curl 127.0.0.1:8789/health`

## 雷区
- 改 `contracts.ts` 的任务/事件协议必须与 sop-ui 两边同步(能力图会点名它)
- `persistentSessions` 能力位是协议开关:翻 true 后 supervisor 不再喂历史上下文,静默改行为
- dsh `/api`:信封 method 必须与 URL 末段一致;`events.mux` WS 必须在 prompt 前连上,否则漏帧
- codex 杀进程要一并清预建 thread,否则下次认领撞 thread not found
- 用 root 跑的典型症状:codex 401 / claude "未登录"(其实是身份读不到 /home/claude 登录态)
