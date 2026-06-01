# ⏳ 时间管理大师 v2.7

云端同步手账应用，支持多设备数据同步。

## 功能

- 🔐 邮箱注册/登录，密码 bcrypt 加密存储，JWT 30天有效
- 📅 日历手账：月视图日历，点击日期查看/编辑日记
- ✅ 待办事项：分类管理，优先级标记，完成状态切换
- 💰 记账管理：分类记账，月/年统计，日历视图
- 🐱 宠物档案：宠物信息管理，健康事件追踪
- 🏋️ 健身计划：21天训练计划，每日饮食建议，激励语
- 😊 心情标签：每条手账可标记"好/一般/差"
- 🖼️ 配图支持：手账可附加图片 URL
- ☁️ 云端同步：所有数据存数据库，不同设备登录看到相同内容
- 🎨 高端冷色风设计，手机/平板/桌面全适配

## 分类

💪 健身 | 🎬 影视 | 📚 学习 | 💼 工作 | 🌟 日常 | 🎮 游戏 | 🎥 视频消化

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start

# 3. 浏览器打开
# http://localhost:3000
```

## 部署到 Railway

1. 将项目推送到 GitHub
2. 在 Railway 创建新项目，关联 GitHub 仓库
3. Railway 自动检测 Node.js 项目并安装依赖
4. 添加 PostgreSQL 插件，Railway 自动提供 `DATABASE_URL`
5. 应用自动使用 PostgreSQL（否则使用本地 SQLite）

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/register | 注册（email, password, nickname） |
| POST | /api/login | 登录（email, password）返回 JWT |
| POST | /api/logout | 退出 |
| GET | /api/diaries | 获取日记列表（支持 year/month 参数） |
| GET | /api/diaries/date/:date | 获取指定日期日记 |
| POST | /api/diaries | 创建日记（category, title, content, diary_date, mood, image_url） |
| PUT | /api/diaries/:id | 更新日记 |
| DELETE | /api/diaries/:id | 删除日记 |
| GET | /api/tasks | 获取待办列表 |
| POST | /api/tasks | 创建待办 |
| PUT | /api/tasks/:id | 更新待办 |
| DELETE | /api/tasks/:id | 删除待办 |
| PATCH | /api/tasks/:id/toggle | 切换完成状态 |
| GET | /api/expenses | 获取记账列表 |
| POST | /api/expenses | 创建记账 |
| PUT | /api/expenses/:id | 更新记账 |
| DELETE | /api/expenses/:id | 删除记账 |
| GET | /api/expenses/stats | 获取记账统计 |
| GET | /api/stats | 获取统计数据 |

所有 API（除注册/登录外）需在 Header 中携带 `Authorization: Bearer <token>`。

## 数据库

- **本地开发**：SQLite（`time_master.db`），无需配置
- **Railway 部署**：自动切换为 PostgreSQL（需 `DATABASE_URL` 环境变量）
