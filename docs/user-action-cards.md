# 用户待办与运行强度一致性

## 问题与范围

项目仍 active 时可能正在等待方案确认，旧项目卡只按生命周期显示“进行中”。确认卡未注册时，方案链接也随之缺失。Codex 经 Aiden 和持久终端启动时，worker 的 PATH 不进入 pane，导致转接器未执行，实际推理强度与保存值分离。

影响 Botmux 的飞书项目卡、Managed Ask、Aiden Codex 启动；IP/Gaia 发布询问脚本同步适配。业务仓库和 Featspace 无需修改。

## 设计

1. ProjectStore 新增可选 userAction：requestId、summary、question、HTTPS documentUrl、pending/delivery_failed。项目卡顶部复用既有“需要你”标签，常驻待办与技术方案链接；投递异常复用“受阻”；两种布局都适用。旧 awaiting_confirmation 等明确等待用户阶段作为兼容回退，内部 blocker 不推断成用户待办。completed 优先。
2. project update 支持 userAction 与 expectedUserActionId。清除/结算使用请求 ID 比较，防止旧回答清掉新问题。生命周期关闭清理待办。Dashboard 仅通过已鉴权 session proxy 转交原协调者 daemon，不新增访客写权限。
3. 两端在验证原 receipt、scope 与调用身份后，先投影文档再注册原生 Ask。确定的注册拒绝单独持久化为 ask_rejected；网络未知仍按 uncertain 对账，不推测失败而重发。无注册记录的后台查询显示 delivery_failed，不再标等待用户。只记录白名单错误码，不保存原始 stderr。
4. 持久 pane 传递 worker 已计算的 session scope。Managed Ask 接受没有 dispatchAttempt 的 keyed turn，但必须由 daemon 当前 keyed registry 证明并保存执行代次、replayKey、bootId；缺失或伪造身份继续拒绝。恢复沿用精确原轮和幂等 continuation。
5. Aiden 启动经过固定绝对路径 launcher，在 pane shell 加载后置入 shim PATH。shim 注入推理强度并恢复父 PATH，避免污染 Codex 的工具子进程。其他 CLI 和非 Aiden 路径保持原行为。卡片沿用“思考强度”原文案，选中值与本轮正文同取实际执行强度；保存配置另沿用“待生效”提示并列出配置值。提交的 CAS 仍比较保存值，防止旧卡覆盖新设置。

## 实施与验证

- [x] Project 数据、解析、卡片两布局与兼容显示。
- [x] 群 scope 传输和 keyed Ask 鉴权、持久化、回答、重启恢复。
- [x] Aiden 启动路径和卡片强度文案；通过 pane wrapper 及可执行替身核验 argv。
- [x] IP/Gaia 询问发布与错误对账成对修改。
- [ ] 固定提交发布、空闲窗口启用、原群卡回读；不得替用户回答、变更配置强度或重新运行业务。

测试覆盖：内部阻塞不误报、completed 优先、隐藏 section 仍可读文档、拒绝危险链接、旧请求不能清新请求；keyed turn 无 attempt 完整链路及错误身份；确定拒绝与网络未知、取消 scope、后台不重复发卡；Aiden 通过 PATH 解析的真实 shell 执行形态。自动化不能替代飞书客户端视觉验收或真实模型执行确认。
