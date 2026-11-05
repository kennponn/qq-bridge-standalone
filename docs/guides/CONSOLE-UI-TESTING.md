# 控制台离线预览与回归测试

预览使用 `audit-bridge-harness.mjs` 在临时目录加载真实桥接处理器；QQ 网关和模型调用被隔离，不读取运行项目的私密配置。不要把预览当作实际机器人控制台。

## 启动预览

```sh
npm run preview:console
# 更换本地端口
node scripts/console-ui-fixture.mjs --port=4174
```

浏览器打开终端显示的本机链接。链接中的 `fixture-console-token` 是固定的测试令牌，不是生产令牌。服务只监听 loopback；`Ctrl+C` 退出会清理临时状态。

不再提供旧版 DSH 页面和旧模式的对照基线。

## 浏览器回归

```sh
npm run test:console-ui
```

需要自行安装 Playwright 和 Chromium，或提供已有安装的位置：

- `PLAYWRIGHT_MODULE`：Playwright Node 模块目录。
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`：Chromium / Chrome 可执行文件。

测试自动启动随机端口的临时服务，限制浏览器只能访问该服务，并在退出时关闭浏览器和服务。目前覆盖：

- 独立引擎控制台九个导航视图，无页面脚本异常或失败的 API 响应。
- 黑话设置和 AI 行为 / 语音设置保存，使用真实的临时文件读写流程。
- 本地系统提示词解锁、保存、备份与还原。
- 人格库、编辑器和语音页在 320 / 390 / 768 / 1440px 下无横向溢出。
- 测试期间没有发送 QQ 消息。

`npm test` 还包含无浏览器的页签、草稿保留、高对比度控件、人格保存、密钥保留和权限边界回归。浏览器测试需要额外环境，因此不会静默跳过后计入默认集合。

这些测试不能验证真实 QQ 登录状态、在线模型额度或语音音质；不要用会向真实 QQ 发消息的人工调试脚本替代离线测试。
