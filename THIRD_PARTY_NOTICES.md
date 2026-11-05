# 第三方依赖与许可说明

本项目的 MIT 许可证只覆盖项目自身代码，原作者版权声明保留在 `LICENSE` 中。本项目不授予 QQ、SnowLuma、模型服务、商标或第三方角色与媒体素材的使用权。

源码包不包含已安装的 `node_modules`、Python 第三方运行环境、QQ 客户端、SnowLuma 可执行文件或源码树，也不包含专有原生组件。使用者需要自行取得并配置网关。控制台可由管理员启动已经安装好的 SnowLuma，但不是网关安装器，也不会自动接受上游条款。

## 锁定的直接 npm 依赖

下表依据源码中的 `package-lock.json` 及整理发布包时检查到的依赖元数据。它仅列出依赖自行声明的许可，不代表本项目对许可兼容性或使用权限作出判断。

| 包名 | 锁定版本 | 声明的许可 |
| --- | --- | --- |
| `@deepseek-ai/dsh-host-apiproxy` | 0.1.1-rc.2 | MIT |
| `@deepseek-ai/schemastery` | 3.18.1 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `@snowluma/mcp` | 1.14.20 | SEE LICENSE IN LICENSE |
| `@snowluma/sdk` | 1.14.20 | SEE LICENSE IN LICENSE |
| `js-yaml` | 4.3.2 | MIT |
| `zod` | 4.6.7 | MIT |

使用或再次分发前，请阅读每个依赖的实际许可证和上游条款。特别是 `SEE LICENSE IN LICENSE` 只表示需要查阅相应许可证文件，并非 MIT 授权；若文件缺失或含义不清，应向维护者取得许可原文。不要假定网关及其 npm 包允许商业部署。

现有 `postinstall` 脚本会修改本机安装的两个 SnowLuma npm 包。在安装或分发修改后的依赖前，请检查 `scripts/patch-snowluma-sdk.mjs` 和相应条款。修改后的依赖副本不包含在本仓库和源码包中。

## 可选语音功能

`scripts/requirements-voice.txt` 请求安装 `edge-tts==7.3.1`。它及其间接依赖由使用者自行安装，不随源码包分发；其许可证和 Microsoft 服务条款仍然适用。只有本地管理员明确同意后，文本才会传给在线语音服务。

FFmpeg 是可选的独立软件，其许可与具体构建方式有关。本项目没有附带 FFmpeg 可执行文件，请自行核对所安装版本的许可。

`LICENSE` 的英文原文和表中的许可标识保持不变，便于核对原始授权；本页中文说明不替代任何上游许可。
