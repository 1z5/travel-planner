# AI Travel Companion

[English](README.en.md) · [主站](https://travel-planner-demo.onrender.com) · [离线验真台](https://1z5.github.io/AI-Travel-Companion/)

一个可自托管的旅行工具。出发前按目的地、日期和偏好生成计划，旅途中打开「今日」查看下一站、路线和当日安排。已有行程也可以直接检查。

- **规划与行中**支持按天查看和调整、地图导航、分享和日历导出。
- **Trip Check 行程体检**分开呈现时间、顺序等结构问题和事实核验覆盖情况。同一文档与规则版本可复算同一凭据。CLI、API 和离线验真台共用规则引擎。
- **数据边界**。地点、营业时间和路线资料来自高德开放平台，覆盖视城市和接口而定。请按场所公告确认临时变更。持普通分享链接的人可以查看行程，部分行程也可编辑。

## 在本地运行

使用 Node.js 22 或以上版本。

```bash
npm ci
npm run db:generate
cp .env.example .env
npm run dev
```

打开 <http://localhost:3000>。没有模型或地图密钥时，可以查看内置示例、运行离线核验，并用 `npm run gate` 验证桩服务下的完整流程。要生成行程，在 `.env.local` 中配置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`。需要在线地图数据时再配置 `AMAP_WEB_SERVICE_KEY`。

在生成结果或分享页点击「下载行程文件」，然后从「我的行程」导入 JSON，即可在当前设备打开完整计划和「今日」。PDF 通过浏览器打印保存。请保留文件作为备份。

本机优先模式将行程、手动编辑和到达记录保存在浏览器。部署时可使用内存暂存在线任务，服务重启只影响尚未保存的任务。持久部署、数据库迁移与自托管步骤见[部署指南](docs/DEPLOY.md)。

## 项目文档

- [文档索引](docs/README.md) · [架构](docs/ARCHITECTURE.md) · [HTTP API](docs/API.md)
- [Trip Check 标准](docs/TRIP-CHECK-STANDARD.md) · [MCP 接入](mcp/README.md)
- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全报告](SECURITY.md)

源码采用 [Apache-2.0](LICENSE)。第三方组件与数据来源见 [NOTICE.md](NOTICE.md)。
