# 云同步服务（可选）

一句话：**不用它也能用**。只有想让「桌面小组件自动跟着网页更新」时才需要部署。

它就是一个云端的 JSON 文件柜：网页把数据 PUT 上来，小组件 GET 下去。

## 部署（约 5 分钟，免费）

```bash
npm i -g wrangler          # 或 npx wrangler
wrangler login

cd worker
wrangler kv namespace create LOAN_KV
# 把输出里的 id 粘进 wrangler.toml 的 binding 处

wrangler secret put TOKEN
# 输入一串自己想的随机字符，比如 openssl rand -hex 16 的结果

wrangler deploy
# 输出形如 https://loan-sync.xxx.workers.dev
```

免费额度：KV 读 10 万次/天、写 1000 次/天。一个人用，一天最多几次写入，够用几辈子。

## 用起来

1. 网页 → 数据同步 → 同步地址填 `https://loan-sync.xxx.workers.dev`，访问令牌填你刚设的 TOKEN
2. 点「上传到云端」
3. 小组件脚本 `CONFIG.remote.url` / `.token` 填同样的值

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 取数据，需 `Authorization: Bearer <TOKEN>` |
| PUT | `/api/state` | 存数据，body 为 `{"loans":[...]}` |
| GET | `/` | 健康检查 |

## 自己测一下

```bash
curl https://loan-sync.xxx.workers.dev/api/state -H "Authorization: Bearer <TOKEN>"
```

## 注意

- 数据是明文 JSON 躺在你的 KV 里，别把令牌发到群里。令牌泄露就 `wrangler secret put TOKEN` 换一个。
- 存的是**合同参数**（本金、利率、期数、提前还款事件），不是每期流水，所以只有两三 KB。
- 想彻底不依赖 Cloudflare？把 `web/` 丢到任意静态托管（GitHub Pages / Vercel / 自己的 NAS），数据靠「导出 JSON」手动搬，也完全能用。
