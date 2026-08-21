# M7 Session Reload Regression Validation

Date: 2026-08-21
Status: **PASS, awaiting user approval**

## 问题

Session 历史中的 MCP App 结果持久化了创建它的 Host 进程所生成的随机
`viewId`。重新启动 DSH 后，同一 MCP tool 会获得新的 `viewId`，但 Browser
仍使用历史 ID 请求 View，Host 因此返回：

```text
MCP App View is unavailable
```

这只影响 Session 历史恢复，不影响首次打开 App。

## 修复

`dsh-uni-editor` 现在把历史 App 结果按以下 durable identity 重新绑定到当前
MCP Server 进程：

```text
publicToolName + resourceUri
```

只有两者都与当前 catalog descriptor 一致时，Browser 才使用当前 `viewId`
加载 View、调用 App-only tool 和读取 resource。定义不一致时仍拒绝加载，
Host 的进程内 `viewId` 隔离边界没有放宽。

## 自动验证

```text
dsh-uni-editor typecheck: PASS
dsh-uni-editor build: PASS
dsh-uni-editor tests: 9 / 9 PASS
persisted-result rebinding test: PASS
changed-definition rejection test: PASS
```

## Fresh Harness Browser 回归

测试使用隔离的 `DSH_HOME`、真实 DSH Web、Replay Agent Loop 和
`threejs-editor-mcp`：

1. 第一次启动 DSH，调用 `mcp__threejs__open_editor` 并持久化 Session；
2. 确认 App 正常挂载；
3. 停止 DSH；
4. 使用同一 `DSH_HOME` 和端口重新启动；
5. 重新加载同一 Session；
6. 检查历史 App 卡片、当前 catalog 和页面错误状态。

证据：

```text
persisted viewId:
d854a366-8963-4df4-ae09-c840f17f7c40

restarted-process viewId:
bab822a4-9ed1-454a-a520-23e58dd1cb2d

viewId changed: true
historical MCP App views: 1
MCP App unavailable errors: 0
loading states after settle: 0
outer iframe display: block
new sandbox origin: http://127.0.0.1:58809
```

压缩 Session log 中的 `tool/result` 保留旧 `viewId`，因此该结果证明 Browser
实际完成了跨进程重绑定，而不是复用了旧 Host binding。

## 影响边界

- 修改仅位于 `dsh-uni-editor` Browser client；
- 不修改 Harness Session schema；
- 不修改 `threejs-editor-mcp` Server 或 project revision；
- 不接受不同 tool 或不同 resource URI 的历史结果；
- M8 尚未开始。
