# 子城联合工程部 · EdgeOne 中国站部署

生产项目 `zicheng-engineering`，项目 ID `makers-cnwks8jmg4xl`。GitHub 仓库 `zy2315785/zicheng-engineering` 已公开，完整正文和凭证保留在私有存储。

## 运行结构

- `dist/`：网页和脱敏目录；启动后从 `/api/documents` 同步实际 ima 目录。
- `cloud-functions/api/[[default]].js`：Node.js 云函数，提供目录、原件下载、分步 Agent。
- `cloud-functions/_lib/agent.js`：DeepSeek Flash 高强度思考，保留每轮完整推理字段和全部工具响应，最多十轮查阅。
- `cloud-functions/_lib/original.js`：通过 ima 官方签名地址与必要请求头读取中文 PDF 文本层、DOCX、XLSX。扫描页使用已有逐页转写缓存，未实现实时在线 OCR。
- 私有 Blob `zc-index/v2/{ruibang,huoju}.json`：带页码、路径、关键词、来源和内容哈希的文字缓存，片段不超过 1800 字符。

提问访问 `/api/ask`，然后连续访问 `/api/agent/step`。每个请求执行一轮模型调用或一个工具，避免整段查阅挤在一次函数中。会话状态采用 AES-256-GCM 加密验证，30 分钟有效。浏览器只在内存中转发密文游标，不展示内部推理，不要将游标写入日志。

ima 的 `search_knowledge` 是关键词接口，并非客户端内置语义问答。系统会更换关键词、检索当前项目目录和文字缓存，再实际打开文件。目录命中与正文证据明确区分，结果严格限定当前项目。

## 部署

选择 Other 框架，项目根目录为仓库根目录，输出目录 `dist`。部署必须包含云函数；只上传 `dist` 只有网页。

`edgeone.json` 将 Node 云函数最大执行时间设为 120 秒。模型单次调用超时 95 秒，工具独立执行。

| 后台环境变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 模型密钥 |
| `DEEPSEEK_MODEL` | `deepseek-flash` |
| `DEEPSEEK_BASE` | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MAX_TOKENS` | 每轮输出预算，默认 8192、最高 16384，不代表上下文窗口 |
| `IMA_CLIENT_ID` / `IMA_API_KEY` | ima 开放平台凭证 |
| `IMA_KB_NAME` | 默认 `子城` |
| `AGENT_SESSION_SECRET` | 可选；未设置时从现有后台凭证派生会话加密密钥 |
| `REQUIRE_AUTH` | 保留既有访问策略；设为 `1` 时使用 `ACCESS_USER` / `ACCESS_PASS` |

部署内 Blob 通过官方 `@edgeone/pages-blob` 自动认证。本机调试可通过进程环境提供 `BLOB_TOKEN` / `BLOB_PROJECT_ID`，不要将长期令牌嵌入代码。

原件下载沿用当前 ima 通道，只显示“下载原件”；本次未切换到百度下载。

## 验证和维护

```powershell
npm ci
npm test
node scripts/dev-cloud.mjs <私有环境文件>
```

默认预览 `http://127.0.0.1:4175`，运行同一份云端代码。`/api/health` 不调用模型；加 `?check=storage` 可验证两个私有索引。

自动测试使用合成正文，避免在公开仓库泄露资料。两项本机原件集成检查仅在 `TEST_PRIVATE_DATA=<本地完整资料索引路径>` 时执行。

```powershell
python scripts/build-index-v2.py --private-root <私有备份目录> --output <私有输出目录>
# 上传凭证从进程环境 BLOB_TOKEN 读取，不要在命令中粘贴密钥。
node scripts/upload-private-index.mjs <私有输出目录>
```

索引按项目与相对路径匹配 ima media ID；同名有歧义就停止，不跨项目猜测。逐页转写保留页码，长段无损分割。新版本上传到 `v2/`，旧版本保留以便回退。

中国站 MCP 使用腾讯官方 `TencentEdgeOne/edgeone-makers-mcp`，区域 `china`。代码部署通过 MCP，环境变量等管理通过官方 CLI 或中国站控制台。
