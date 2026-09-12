# TongID Skills

TongID Agent 技能包的独立源仓库。这里的 `main` 分支和发布 tag 是唯一可编辑的原始内容；用户本机安装到 `~/.codex/skills/` 的副本，以及 TongID 网站上的 Agent 页面，都是分发或索引入口，不在其中维护正文。

GitHub：<https://github.com/df007df/tongid-skills>

## 目录

```text
skills/
  tongid-issues/
    SKILL.md                         # Agent 行为边界与操作流程
    references/tongid-issues.json    # 与 TongID /api/v1 对应的 OpenAPI 契约
    scripts/tongid-issues.mjs        # 可重复使用的本机 HTTP helper
    *.test.mjs                       # helper 与契约测试
```

一个业务能力对应一个独立技能目录。后续如新增用户、订单能力，应新增 `tongid-users`、`tongid-orders`，不要把全部说明堆进 `tongid-issues`。

## 维护规则

1. 先改 TongID 的 HTTP API 与服务端测试，再在此仓库更新对应技能的 `SKILL.md`、OpenAPI 契约、helper 和测试。
2. `SKILL.md` 只写会改变 Agent 决策的流程、权限边界与安全约束；完整字段定义只维护在 `references/`。
3. 不提交任何真实 Secret Key、Bearer token、本机 session 或 `.env` 文件。技能只能说明读取哪些环境变量。
4. 每次准备发布前运行 `npm test`；有可用的本地 TongID 环境时，再完整走一次登录、查询和一条可安全清理的写入冒烟。
5. API 不兼容变更时提升主版本；兼容新增时提升次版本。推荐 tag：`tongid-issues-v0.1.0`。

当前 `tongid-issues` 保留了迁入时的 Bearer 本机登录流程。若改为 Secret Key 直连，应单独完成鉴权设计和回归，不在普通文案更新中混改；应使用仅限 Issue 操作的 scoped key，而不是复用工作空间级凭据。

## 发布与安装

推送到 GitHub 后，TongID 的 `/agents` 页面只展示此仓库、已验证的安装命令和最新 tag。安装者不应直接编辑本机已安装副本；需要改动时在这里提交、测试、打 tag，再升级安装。

在配置 GitHub remote 前，先完成本地首个提交：

```bash
cd /Users/df007df/work/product/lingoway/code/tongid-skills
npm test
git add .
git commit -m "feat: initialize tongid issues skill"
```
