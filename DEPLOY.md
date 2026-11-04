# 部署说明（GitHub + EdgeOne Pages）

本目录是从 `zicheng-engineering/` 分离出的**可公开/可推送版本**，只含代码与前端发布物。
本地后台、运行时、凭证、项目原件均不在其中。

## 一、仓库里有什么

| 目录 / 文件 | 用途 | 去向 |
|---|---|---|
| `*.mjs`（根目录 9 个） | 本机后台：服务、模型桥接、ima 与百度对接、检索规划 | 仅 GitHub |
| `scripts/`（8 py + 4 mjs） | 文档解析、索引、OCR、便携打包、验证 | 仅 GitHub |
| `tests/`（4 个） | Node 原生测试，`npm test` | 仅 GitHub |
| `dist/` | 纯静态前端 + 已生成的资料快照 | GitHub + EdgeOne |
| `projects.json` | 11 个项目清单与目录映射 | 两者都要 |
| `package.json` / `.gitignore` / `.gitattributes` | 工程配置 | 仅 GitHub |
| `.env.example` | 环境变量样例，不含真实值 | 仅 GitHub |
| `.openai/hosting.json` | 静态目录声明（`dist`） | 仅 GitHub |

被有意排除（不会出现在仓库里）：

- `.local/`：含 DeepSeek key 明文、ima 凭证、百度 refresh_token
- `runtime/`：492 MB 的 Node + Python 二进制
- `瑞邦国际大厦/`、`火炬…项目/`：120+ 份项目原件
- `tmp/`、`output/`、`*.log`、`*.zip`

## 二、⚠️ 关于 dist/project-data.json

这份 2.2 MB 的 JSON 是静态站的**全部内容来源**，里面包含 169 份真实项目文件的
文件名、路径和正文摘录（工期表、审批信息等）。

因此：

1. **仓库必须设为 Private。**
2. 若确实要建公开仓库，先执行脱敏（保留结构，抹掉文件名与正文）：

   ```bash
   node scripts/sanitize-project-data.mjs           # 先预览会抹掉多少
   node scripts/sanitize-project-data.mjs --write   # 确认后执行，自动备份原文件
   ```

3. EdgeOne 站点如果对外开放，同样要加访问限制，否则任何人拿到链接都能下载这份 JSON。

## 三、推到 GitHub

```bash
git config --global --add safe.directory "C:/Users/94525/Desktop/AI/zicheng-engineering"
cd "C:/Users/94525/Desktop/AI/github-zicheng-engineering"
git init -b main
git add -A
git commit -m "chore: 子城联合工程部工程知识助手 源码与静态发布物"
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

创建远端仓库时选 **Private**，不要勾选自动生成 README / .gitignore，避免冲突。

## 四、部署到 EdgeOne Pages

1. 控制台 → Pages → 新建项目 → 导入 Git 仓库，选刚推的仓库与 `main` 分支。
2. 构建配置：
   - 框架预设：**其他 / None**
   - 构建命令：**留空**
   - 输出目录：**`dist`**
   - 根目录：**`/`**
3. 部署完成后访问分配的域名，应看到工作台首页。

静态模式下会自动降级：`dist/app.mjs` 只在 `127.0.0.1` / `localhost` 下才请求
`/api/health`，线上不会出现接口报错。此时「提问」不具备真实检索能力，只展示
已生成的资料快照，这属于预期行为。

只想快速试预览，也可以把 `dist` 目录直接拖拽上传，跳过 Git 集成。

## 五、本地完整功能（后台）

静态站不含后台能力。完整问答仍需在本机运行：

```bash
cp .env.example .env      # 填 ZC_API_KEY 等，或在网页「云端连接」里配置
node server.mjs           # 默认 http://127.0.0.1:4173
```

需要 `runtime/`（Node 与 Python）以及两个项目原件目录，这些都在原 `AI` 文件夹里，
不在本仓库中。

## 六、后续让后台也上线

EdgeOne 的运行时无法满足本后台的三个硬性依赖：Python 文档解析与 OCR、
本机磁盘上的项目原件、分钟级的单次请求。可行路径是把后台部署到一台常开的服务器：

- 安装 Node 与 Python，上传 `server.mjs` 与 `scripts/`
- 项目原件放到服务器数据盘，修改 `projects.json` 里的 `folder`
- 凭证改为环境变量 `ZC_API_KEY` / `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY`
- EdgeOne 只托管前端，`/api/*` 反代到服务器
