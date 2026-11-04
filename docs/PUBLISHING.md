# 发布到 GitHub

## 发布前

1. 从这个独立源码目录发布，**不要从日常运行目录发布**。
2. 保持 `config.json`、`state/`、`audio/`、`roles/local/`、`node_modules/`、`assets/voice-runtime/` 和所有备份不入库。
3. 阅读 `THIRD_PARTY_NOTICES.md`，核对第三方网关及 SDK 的许可；本项目 MIT 不替代这些授权。
4. 运行 `npm ci`、`npm test`、`npm run test:voice` 和 `npm run release:check`。
5. 检查 `git status --short`、`git diff --cached` 和 `git ls-files`，确认没有私人文件。

扫描器是最后一道辅助检查，不保证识别任意秘密。如果误把真实密钥推到 GitHub，应先在提供方撤销或轮换，而不是只删除文件。

## 新建自己的仓库

该源码没有原项目提交历史，也没有预设远程地址。先在 GitHub 创建一个空仓库，然后在源码根目录执行：

```powershell
git init -b main
git add .
git diff --cached --stat
npm run release:check
git commit -m "Prepare standalone QQ Bridge source release"
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

把占位地址替换为你自己的仓库。`YOUR_ACCOUNT` / `YOUR_REPOSITORY` 不是已创建的项目。

不要把此版本推送到别人的上游仓库。若要贡献上游，请先 fork 并按其贡献流程提交 Pull Request。

## 更新源码

只同步经过审查的源文件、公开配置示例和测试；不要整目录复制运行项目。私人角色、聊天状态、模型 Key 和本机资源永远留在运行目录。

GitHub Actions 默认执行离线测试和发布扫描，不需要 Secrets，不连接你的真实 QQ 或模型服务。
