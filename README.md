# Zentao Bug + Testcase Capture

一个 Tampermonkey 用户脚本，用于在**禅道（ZenTao）** QA 页面自动采集 Bug / 测试用例的创建信息，识别实体编号和创建者，并推送到自定义后端服务。

## 功能特性

- **自动采集**：在 Bug / 用例创建页捕获表单数据（标题、产品、版本、关联需求等）
- **列表识别**：创建成功后，在列表页自动补齐实体 ID 和创建者信息
- **推送后端**：将完整记录推送到你自己的后端 API
- **记录面板**：可拖动悬浮按钮，点击展开可筛选、重试、删除的记录面板
- **本地持久化**：记录存储在 localStorage，页面刷新后不丢失
- **自动重试**：推送失败时自动重试，最多 3 次

## 安装

### 前置条件

1. 浏览器已安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 你有一套运行中的[禅道](https://www.zentao.net/)实例
3. 你有一个接收推送数据的后端服务（见下方配置说明）

### 从 Greasy Fork 安装

> 链接待补充（发布后更新）

### 手动安装

1. 打开 Tampermonkey 管理面板 → 新建脚本
2. 将 `zentao-capture.user.js` 内容粘贴进去
3. 修改配置区（见下方）
4. 保存

## 配置

打开脚本，修改顶部 `CONFIG` 对象中的以下字段：

```js
const CONFIG = {
  // 你的禅道后端推送服务地址
  API_BASE_URL: 'http://your-backend-server:8000',

  // 推送接口路径
  SYNC_ENDPOINT: '/api/zentao/browser-sync',

  // 接口鉴权密钥（与后端约定）
  SYNC_API_KEY: 'your-secret-key',

  // 是否自动推送（false 则只记录，需手动点推送）
  AUTO_PUSH: true,

  // 其他配置保持默认即可
};
```

同时，在脚本头部的 `@match` 行，将通配符替换为你的禅道实际地址：

```
// @match  http://your-zentao-host/zentao/*
```

并将 `@connect` 替换为你的后端域名：

```
// @connect  your-backend-server
```

## 后端接口

脚本向 `POST {API_BASE_URL}{SYNC_ENDPOINT}` 推送 JSON 数据，携带请求头 `X-Zentao-Sync-Key: <你的密钥>`。

推送的数据结构示例：

```json
{
  "clientRecordId": "xxx",
  "entityType": "bug",
  "action": "create",
  "capturedAt": 1748000000000,
  "draft": {
    "bugTitle": "...",
    "productId": "15",
    "productName": "Survey Master",
    "affectedVersion": "4.0.2.0"
  },
  "result": {
    "zentaoBugId": "29587",
    "creatorName": "张三"
  }
}
```

后端返回 `{"ok": true}` 表示接收成功。

## 支持页面

| 页面类型 | URL 示例 |
|---------|---------|
| Bug 列表 | `/zentao/bug-browse-*.html` |
| Bug 创建 | `/zentao/bug-create-*.html` |
| 用例列表 | `/zentao/testcase-browse-*.html` |
| 用例创建 | `/zentao/testcase-create-*.html` |

> 脚本通过 `#appIframe-qa` iframe 识别以上页面，适配禅道 IPD 版 4.x。

## 许可证

[MIT](LICENSE)
