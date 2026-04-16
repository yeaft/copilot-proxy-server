# CopilotProxyServer - Claude Code Notes

## Git Push 注意事项

`source ~/.zshrc` 会切换 cwd 到 `~/projects/claude-web-chat`，因此所有需要 git auth 的操作必须用以下格式：

```bash
source ~/.zshrc && cd ~/projects/CopilotProxyServer && git push
```

**绝对不能**只写 `source ~/.zshrc && git push`，否则会 push 错误的 repo。

## 构建

```bash
npm run build
```

## 部署

```bash
cd ~/projects/termination && docker compose up -d --build copilot-proxy
```

## 数据目录

配置和数据在 `~/data/copilot-proxy/`：
- `.env` — 环境变量 (GITHUB_TOKEN, API_KEY, DASHBOARD_USER/PASS 等)
- `usage.db` — SQLite 使用统计数据库
- `github_token` — 保存的 GitHub device flow token
