# QQ Bridge

一个本地运行的 QQ AI 机器人桥接项目：连接你自行安装的 SnowLuma / OneBot 网关，让支持 OpenAI 兼容接口的模型参与群聊和私聊。

默认使用 **Standalone 独立引擎**，不需要启动 DSH。DSH 兼容后端仍然保留，供已有用户选用。

## 能做什么

- 群聊、私聊、引用回复和分条发送；发送目标由本地白名单限制。
- 本地控制台管理模型、人格、会话、暂停、权限和 token 用量。
- 二代仿真：查看消息、选择是否参与、等待、潜水和定时唤醒。
- 图片、表情、合并转发、联网搜索和会话记忆。
- QQ 原生语音转文字；可选在线女声朗读，启用前需明确同意。

Standalone 只支持二代仿真，不向模型提供任意命令执行或本地文件读写。DSH 后端的其他模式及其权限边界见 [RULES.md](RULES.md)。

## 快速开始

需要 Node.js >= 22.13.0，以及你自行取得并配置好的 QQ / OneBot 网关。网关的安装、登录和许可不包含在本项目中。

```powershell
npm ci
Copy-Item config.example.json config.json
npm start
```

打开本地控制台 `http://127.0.0.1:3100/`。首次启动生成的控制台令牌可在本机启动日志或 `state/console-token` 中查看，**不要公开这些文件**。

Windows 也可以双击 `start-ui.bat`，自动选择合适的 Node、启动守护进程并打开带认证的控制台。退出守护进程使用 Ctrl+C；重启按钮在守护模式下才会自动恢复。

在控制台中依次配置：

1. 模型提供方的 HTTPS API 基础地址、模型名称及 API Key。也可在启动前设置 `QQ_DIRECT_API_KEY` 环境变量。
2. 本机网关的 WebSocket / HTTP 地址和访问令牌；示例为 `ws://127.0.0.1:3001` 和 `http://127.0.0.1:3000`，以你的安装为准。
3. 管理员 QQ，以及允许交互的群号和私聊 QQ。**空白名单默认不放行，不要为图方便打开全量放行。**
4. 选择二代仿真和示例人格，保存；确认 QQ 连接状态后，再自行发消息验证。

`config.example.json` 只含占位符，没有可用的模型密钥、QQ 账号或控制台令牌。默认模型地址 `https://your-provider.example/v1` 必须替换；不要将配置文件提交到 Git。

更多配置见 [独立引擎说明](docs/guides/STANDALONE.md)。可选 DSH 配置见 [DSH_SETUP.md](docs/guides/DSH_SETUP.md)。

## 语音功能

接收语音使用 QQ 网关原生转写；这是在线能力，不是本机离线识别，实际可用性取决于网关和 QQ。

女声朗读为可选功能，需要 Python >= 3.10 和 FFmpeg。安装 Python 依赖：

```powershell
npm run voice:install
```

这会在本机 `assets/voice-runtime/vendor/` 安装 `edge-tts==7.3.1` 及依赖，目录已被 Git 忽略，不随源码分发。可通过 `QQ_BRIDGE_TTS_PYTHON` 指定 Python 路径。

控制台中勾选在线朗读及文字发送到 Microsoft 服务的同意项，然后保存。默认不启用、不自动朗读。先试听，再明确选择会话发送；模型调用沿用白名单、暂停和频率限制。详见 [VOICE.md](docs/guides/VOICE.md)。

## 人格和隐私

开源版本只有重新编写的中性示例人格 `roles/assistant.md`。私人角色库、聊天记录、语音素材、模型密钥、QQ 账号和个人费用数据均不包含在源码中。

你的个人人格可放在 `roles/你的角色名.md`，除 README 和审核过的示例外，新的角色 Markdown 默认被 Git 忽略；不要用自己的私人内容覆盖已跟踪的 `assistant.md` 示例。`roles/local/` 可用于私人备份，但不作为默认角色加载目录。运行数据写入 `state/`；模型 Key 可以保存在环境变量或本地受限的秘密文件中。文件权限限制不等于加密，本机管理员仍可读取。

群聊内容、人设和必要上下文会传给配置的模型提供方；开启联网或语音功能时还会访问相应第三方服务。请先取得参与者同意、了解服务的数据处理规则，并保护自己的 QQ 账号。

## 验证和发布

```powershell
npm test
npm run test:voice
npm run release:check
```

上述测试使用本地夹具和模拟服务，不应调用真实模型、QQ 或生产 DSH。`npm run test:audit` 是较完整的旧版离线审计集合；部分语音验证依赖 FFmpeg，可选 DSH 集成测试不在默认集合中。

发布步骤和检查清单见 [发布说明](docs/PUBLISHING.md)。本源码包没有原项目 `.git` 历史；不要从真实运行目录直接推送。

## 许可边界

本项目自己的代码沿用 [MIT License](LICENSE)，保留原作者版权声明。

**MIT 不覆盖 SnowLuma 或其他第三方组件。** 本包不含 QQ、SnowLuma 本体、专有原生组件、已安装的 npm 依赖或 Python 二进制。`@snowluma/sdk` / `@snowluma/mcp` 的锁定版本声明独立许可，请在公开分发、商业使用或部署前核对原始许可及授权要求；本项目不代替上游授予权利。

详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
