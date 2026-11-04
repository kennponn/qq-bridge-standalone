# DSH 后端的直连模型引擎（兼容功能）

本文介绍旧 DSH 后端中的可选直连模型引擎，不是默认 Standalone 模式。新安装请先阅读 [独立引擎说明](STANDALONE.md)。

此功能直接请求 OpenAI 兼容的 `chat/completions` 接口，仅用于二代模式 `reserved2`；DSH 仍负责创建会话以及模式和配置管理，不能替代 DSH。

## 配置

未配置模型密钥前，请保持 `dsh.directEngine` 为 `false`。

在启动桥接器的进程环境中设置密钥：

```powershell
$env:QQ_DIRECT_API_KEY = '<替换为模型提供方密钥>'
```

通过 `dsh.directLLM.baseUrl` 配置接口基础地址，通常以 `/v1` 结尾，而不是 `/chat/completions`；也可设置 `QQ_DIRECT_BASE_URL`。`dsh.directLLM.apiKeyEnv` 可指定其他密钥环境变量。不要将 API Key 写入 `config.json` 或源码。

未明确指定地址时，`deepseek-official` 使用 `https://api.deepseek.com/v1` 和 `DEEPSEEK_API_KEY`；`openai-ultrarouter` 使用 `https://ultrarouter.org/v1` 和 `ULTRAROUTER_API_KEY`。`QQ_DIRECT_API_KEY` 的优先级更高。未知提供方必须明确配置地址。模型默认使用 `dsh.model`，可通过 `dsh.directLLM.model` 覆盖。

`dsh.directLLM` 的可选设置：

- `requestTimeoutMs`：单次请求超时，默认 90000 毫秒。
- `turnTimeoutMs`：整个回合超时，包含工具等待，默认 900000 毫秒。
- `maxRounds`：默认 16 轮；达到上限会报错，不算成功回复。
- `maxRetries`：默认重试 2 次，仅重试临时模型 HTTP 或网络故障。
- `vision`：默认 `true`；纯文本模型可设为 `false`。
- `webSearch`：默认 `true`，使用现有安全、只读的搜索 MCP 服务。

## 运行边界

- 文本输出保持私有，真实发送始终需要明确调用安全 QQ 工具。
- 静默或后台回合不提供 QQ 发送工具。
- 工具复用现有 MCP 参数结构，以及桥接器授权和审计检查。
- 宿主绑定会话密钥和令牌，模型不能更改目标会话。
- 只根据已经展示的快照授权读取游标；发送后不会自动确认新到达的消息。
- 回合结束或睡眠前，模型仍需满足既有观察要求。
- 每个回合均限制执行时间、清理资源并检查会话是否失效。
- 直连提示词队列释放锁后，会重放待唤醒任务。
- 模型 Token 用量与 DSH 会话基线分别记录。
- 日志仅记录工具名称和状态，不记录提示词、令牌或完整工具结果。

运行 `npm run test:direct` 进行离线回归，或运行 `npm run test:audit` 执行完整离线集合。测试不会发送真实 QQ 消息或调用真实模型。
