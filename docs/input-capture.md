# 精确话题输入接管（通用插件候选）

仅可信宿主可为一个现有活动会话注册接管。身份从 daemon 活动会话解析，精确绑定 bot/session/chat/anchor/owner；providerRef 是由插件解释的不透明引用。可通过 `--input-anchor <message-id>` 指定该 chat 内由宿主核验的原消息或插件卡片话题；sourceAnchor 仍固定为真实来源会话的 anchor。使用已启用、已安装并声明 card-actions 的插件，以复用其现有私有服务凭据。无需平台枚举、业务提示词或私有数据目录接口。

```
botmux input-capture register --bot <app> --session <session> --plugin <installed-plugin> --request <stable-key> --ref <opaque-ref>
botmux input-capture inspect --bot <app> --session <session> --binding <binding-id>
botmux input-capture revoke --bot <app> --session <session> --binding <binding-id> --revision <revision>
```

对应 `POST /api/sessions/:sessionId/input-capture`，body 包含 larkAppId、operation 与命令字段。路由必须通过当前宿主 HMAC；不加入 session relay allowlist。register 同一身份幂等；同一 bot/chat/anchor/owner 的第二个活动绑定冲突。撤销后保留墓碑，同一个 request 不会重新激活。

接管在飞书 SDK 回调返回 ACK 之前同步执行，并排除 slash/回调命令、话题控制头与附件；不会经过先 ACK 再异步执行的普通消息调度队列。附件、workflow grill、机器人和其他答复者继续走现有路由。命中后重新检查当前原生 talk 权限及会话身份，再将完整文字、真实 messageId、sender 和单调序号 fsync 到宿主日志，才返回已接收。持久化失败不返回成功，也不转投普通 Worker；需要排查保存故障，不能假定上游一定重投。

宿主异步向该插件的现有服务 `POST /botmux/inputs/v1`。沿用官方插件服务注册、固定 loopback 端口和 `BOTMUX_PLUGIN_CARD_ACTION_TOKEN`，不接受调用者提供 URL 或凭据：

```
{schemaVersion: 1, binding: {id, larkAppId, sessionId, chatId, anchor, ownerOpenId, pluginId, requestId, providerRef, ...},
 input: {id, bindingId, sequence, messageId, senderOpenId, text, receivedAt, delivery: "pending"}}
```

插件必须先按 input.id 幂等持久化，再返回 `{schemaVersion:1, bindingId, acceptedInputId}`。输入是已接收事实，不能视作未来执行的授权。相同 ID 的不同内容必须拒绝，禁止改写历史消息。服务离线、错误 ACK、超时或宿主保存 ACK 失败，均保留原条目并按原顺序重试；不得 fallback 普通 Worker，也不得假定飞书重投。

重启恢复 pending；撤销接管保留并继续交付已经接收的输入。移除插件启用配置会暂停交付，保留记录。inspect 不消费、不 GC。当前不自动清理绑定、已确认输入或墓碑；历史数据归档/清理由未来显式迁移处理。接口只接管已经通过消息入口到达原会话的纯文字，不声称覆盖附件或飞书未投递的消息。

此能力不调度模型、不解释答案、不维护业务阶段。平台负责原会话续执行、scope/专业回执与副作用校验。没有完成平台 consumer 和旧数据迁移前不能切换生产来源。
