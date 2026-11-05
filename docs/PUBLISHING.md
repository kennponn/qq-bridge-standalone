# 发布到 GitHub

本开源分支的公开仓库为 <https://github.com/kennponn/qq-bridge-standalone>。当前版本以 `package.json` 为准；更新记录在根目录 [CHANGELOG.md](../CHANGELOG.md)，每个版本的中文说明保存在 `docs/releases/`。

## 发布前

1. 从这个独立源码目录发布，**不要从日常运行目录发布**。
2. 保持 `config.json`、`state/`、`audio/`、`roles/local/`、`node_modules/`、`assets/voice-runtime/` 和所有备份不入库。
3. 阅读 `THIRD_PARTY_NOTICES.md`，核对第三方网关及 SDK 的许可；本项目 MIT 不替代这些授权。
4. 运行 `npm ci`、`npm test`、`npm run test:voice` 和 `npm run release:check`。
5. 检查 `git status --short`、`git diff --cached` 和 `git ls-files`，确认没有私人文件。

扫描器是最后一道辅助检查，不保证识别任意秘密。如果误把真实密钥推到 GitHub，应先在提供方撤销或轮换，而不是只删除文件。

## 新建自己的仓库

只有发布到自己的新仓库时才执行本节。源码交付包不包含原项目提交历史；已经克隆本仓库的使用者无需重新初始化或再次设置远程。先在 GitHub 创建自己的空仓库，然后在源码根目录执行：

```powershell
git init -b main
git add .
git diff --cached --stat
npm run release:check
git commit -m "发布独立引擎开源源码"
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

把占位地址替换为你自己的仓库。`YOUR_ACCOUNT` / `YOUR_REPOSITORY` 不是已创建的项目。

不要把此版本推送到别人的上游仓库。若要贡献上游，请先 fork 并按其贡献流程提交 Pull Request。

## 更新源码

只同步经过审查的源文件、公开配置示例和测试；不要整目录复制运行项目。私人角色、聊天状态、模型 Key 和本机资源永远留在运行目录。

GitHub Actions 默认执行离线测试和发布扫描，不需要 Secrets，不连接你的真实 QQ 或模型服务。

## 版本号与更新日志

首个开源版本为 `0.2.1-r1`，当前版本为 `0.4.0-r1`。含 `-rN` 的版本按预发布处理；本仓库的公开版本以发布标签和更新日志为准。

后续未定稿改动先写入 `CHANGELOG.md` 的“未发布”章节。发布时按“新增、修复、文档、安全、兼容性”整理到新的版本章节，并写上实际发布日期；不要把同一天的每次文档提交都单独算一个功能版本。

发布新版本时，以下位置必须同步：

1. `package.json` 和 `package-lock.json` 的根包版本。可用 `npm version 新版本号 --no-git-tag-version` 更新，不要修改依赖自身的版本。
2. 两个安全 MCP 服务中声明的项目版本：`src/mcp-snowluma-safe.js`、`src/mcp-web-search-safe.js`。
3. README 的当前版本和发布链接，文档索引的当前版本链接。
4. `CHANGELOG.md` 的版本章节、日期和比较链接，以及 `docs/releases/v新版本号.md`。

```powershell
npm run test:release-docs
npm test
npm run test:voice
npm run release:check
git diff --check
git diff --stat
```

版本文档检查会核对主包、锁文件、安全 MCP 服务、README、更新日志和发布说明。它不能替代人工审阅更新内容。

## 发布标签与中文版本说明

检查通过后提交并推送源码，再创建指向该提交的标签。下例中的 `0.4.1-r1` 仅为演示，请替换为已完成版本检查、尚未发布的新版本；已发布标签不得覆盖或移动。

```powershell
git add .
git diff --cached --stat
git commit -m "整理版本与中文更新日志"
git push origin main
$version = "0.4.1-r1"
$tag = "v$version"
git tag -a $tag -m "$tag QQ Bridge Standalone"
git push origin $tag
```

在 GitHub 的 Releases 中选择该标签，将对应中文说明文件作为发布正文；包含 `-rN` 的版本标为预发布。下载附件应使用从该标签生成的源码归档，不包含运行目录、依赖或私人文件。归档和校验文件属于发布附件，不提交进源码仓库。

若本机已安装并登录 GitHub CLI，也可执行：

```powershell
gh release create $tag --verify-tag --prerelease --title "$tag QQ Bridge Standalone" --notes-file "docs/releases/$tag.md"
```

复制版本说明到 Releases 时，将其中指向源码文档的相对链接替换为该版本的完整 GitHub 链接。发布后核对远程标签、附件、中文说明和该提交的 GitHub Actions 结果；不要对测试结果尚未完成的版本声称检查已通过。
