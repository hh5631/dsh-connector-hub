# 首次贡献 / First contribution

欢迎第一次参与 `dsh-connector-hub`。优先选择带有 [`good first issue`](https://github.com/duhu2000/dsh-connector-hub/labels/good%20first%20issue) 标签、且尚未被认领的任务；在 Issue 留言后再开始，避免重复劳动。

Welcome! Start with an unassigned [`good first issue`](https://github.com/duhu2000/dsh-connector-hub/labels/good%20first%20issue). Leave a short comment before working on it so contributors do not duplicate effort.

> 2026-10-16 复核：原新手任务 [#29](https://github.com/duhu2000/dsh-connector-hub/issues/29) 已完成并关闭；当前可认领任务是 [#156](https://github.com/duhu2000/dsh-connector-hub/issues/156)。请以上面的动态标签页为准，并在 Issue 留言后再开始。

## 适合第一次参与的范围

- 中英文文档示例、安装或故障排查说明。
- 不需要真实 Token、API Key 或私有服务的测试用例。
- 键盘操作、可访问性标签和小型界面文案改进。
- 元数据校验器与贡献者工具链的小改进。

新的公共连接器描述不提交到本仓库，请改走独立 Registry 的[连接器上架指南](https://github.com/duhu2000/dsh-mcp-connector-registry/blob/main/docs/ONBOARDING.md)。

## 当前可认领的新手任务

**Issue [#156](https://github.com/duhu2000/dsh-connector-hub/issues/156)**：`docs: 增加首次成功教程的本地链接校验`

背景：`docs/tutorials/*.md` 已经形成安装、JSON 迁移、OAuth、工具恢复和场景验收网络，但目前的文档门禁主要检查关键文案，还不会统一报告失效的本地 Markdown 链接。这个任务不需要 DSH、网络、真实连接器或凭据。

建议修改文件：

- 新增 `scripts/check-tutorial-links.mjs`，检查 `docs/tutorials/*.md` 中的相对文件链接。
- 在 `package.json` 增加独立命令，并把它接入 `npm run check`。
- 新增一个无网络测试，至少覆盖“有效相对链接”与“失效目标显示源文件和目标”。

验收标准：

- [ ] 只检查本地相对文件链接；忽略 `https://`、`mailto:` 和纯页内锚点，不发起网络请求。
- [ ] 正确处理 URL 编码、`#fragment` 和相对于源文件的路径。
- [ ] 失败信息精确到 `源文件 -> 目标`，方便首次贡献者修复。
- [ ] `npm run check` 通过，且不引入新的运行时依赖。

该 Issue 已带 `documentation` 和 `good first issue` 标签；不要求新手发版或修改 Registry。

## 从 Issue 到 PR

```bash
git switch main
git pull --ff-only
git switch -c docs/<short-purpose>
npm install --legacy-peer-deps
npm run check
```

1. 只处理 Issue 定义的单一问题；不提交真实凭据、业务数据或本机路径。
2. 中英文用户文案保持同步；行为变化需补测试。
3. PR 中链接对应 Issue，并写清问题、改动、验证结果和必要的手工检查。
4. 维护者确认验收标准后合并；版本发布由维护者统一安排。

如果任务描述不够清楚，请先在 Issue 提问。首次贡献不要求拥有 DSH 私有环境，也不要求发布 npm 包。
