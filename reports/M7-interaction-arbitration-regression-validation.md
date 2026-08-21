# M7 Interaction Arbitration Regression Validation

Date: 2026-08-21
Status: **PASS, awaiting user approval**

## 问题

在 Workspace 编辑态从 Scene graph 选中 `helmet` 后，按下 TransformControls
Gizmo 会同时触发画布场景拾取。拾取先于 Gizmo 的 `dragging=true` 执行，
因此底下的 `sidepod` 可能替换当前选择，随后 Gizmo 拖动错误对象。

OrbitControls 视角拖动与画布点击也共用同一 pointer 事件链，缺少统一的手势
互斥裁决。

Formula One 的程序几何还有独立的 pivot 问题：`helmet` 顶点直接写在车体坐标
中，但 Mesh 节点 `position` 为世界原点。标准 TransformControls 因此把 Gizmo
放在节点原点，而不是可见几何中心。

## 根因

画布拾取监听器在 Runtime 初始化时注册，OrbitControls 和 TransformControls
在项目启动后注册。浏览器按注册顺序分发 `pointerdown`：

```text
scene pick
-> OrbitControls
-> TransformControls
```

因此不能在 `pointerdown` 直接改变选择，也不能只检查当时尚未建立的
`transformDragging`。

## 修复

Scene 模式和 Workspace Runtime 现在使用同一手势规则：

1. `pointerdown` 只采样当前射线候选，不改变选择；
2. 非主 pointer、非左键、Gizmo hover 或已有 Transform drag 直接阻止场景选择；
3. `pointermove` 一旦超过 4px，永久把本次手势标记为视角/拖动操作；
4. `pointerup` 仅在 pointer identity 一致、未移动、未命中 Gizmo 且未发生
   Transform drag 时提交按下时采样的候选；
5. `pointercancel` 清理手势，不留下下一次点击状态。

候选在按下时采样，避免 Orbit damping 在按下到抬起之间移动相机后让细物体
射线失效。

对于顶点不以节点原点为中心的对象，Runtime 使用一个不进入 Scene catalog 的
编辑器 pivot proxy：

- proxy 位于对象世界包围盒中心；
- TransformControls 只附着 proxy，不修改 geometry；
- 拖动期间把 proxy 的世界矩阵增量映射回真实对象；
- 平移、旋转和缩放都围绕可见几何中心；
- 保存的仍是真实对象官方 Editor Command，不持久化 proxy。

## 自动验证

```text
threejs-editor-mcp typecheck: PASS
threejs-editor-mcp build: PASS
threejs-editor-mcp tests: 7 / 7 PASS
pointer arbitration unit tests: 2 / 2 PASS
dsh-uni-editor checks: 9 / 9 PASS
```

## Browser 回归

焦点 E2E 从持久 Session 恢复 Formula One Race Car，并执行真实 WebGPU 画布
交互：

```text
selectedAfterOrbit: VF-26
cameraChanged: true
selectedAfterGizmoDrag: helmet
gizmoAxis: Y
gizmoCenteredOnHelmet: true
gizmoPickBlocked: true
App console/page errors: 0
```

这同时证明：

- OrbitControls 实际改变了相机，但没有改变 Scene 选择；
- Gizmo 世界位置与 `helmet` 世界包围盒中心逐轴误差小于 `1e-6`；
- `helmet` 的 Y 轴 Gizmo 被真实命中并拖动；
- 拖动前后 `helmet` 包围盒中心不同，证明真实对象发生位移；
- Gizmo 手势进入互斥分支，没有对下层 `sidepod` 执行场景拾取；
- Properties 与 Gizmo 继续绑定同一个 `helmet`。

Browser 命令在输出全部业务断言后，因 TRAE 沙箱拒绝 Chrome
Crashpad/Updater 写入用户目录而返回非零；产品断言已全部完成，页面错误为 0。

## 影响边界

- 不改变 Scene graph、Properties 或官方 Editor Command 语义；
- 不改变中心射线和 6px 多射线容差排序；
- 不重建 iframe 或 WebGPU Runtime；
- 只增加只读 Runtime interaction diagnostics；
- M8 尚未开始。
