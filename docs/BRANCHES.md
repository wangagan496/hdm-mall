# 功能分支说明

`main` 只保留 HarmonyOS 工程骨架、公共模块和启动入口，不再包含商城业务模块。完整商城代码保留在本地 `mall` 分支，作为拆分前的可运行基线。

## 分支命名

| 分支 | 入口功能 | 当前代码模块 |
| --- | --- | --- |
| `home` | 首页 | `features/home` |
| `search` | 搜索 | `features/home`（搜索与首页共用模块） |
| `goods` | 商品详情 | `features/home`（详情与首页共用模块） |
| `category` | 分类 | `features/category` |
| `cart` | 购物车 | `features/cart` |
| `order` | 订单 | `features/cart`（订单与购物车共用模块） |
| `payment` | 支付 | `features/cart`（支付与购物车共用模块） |
| `login` | 登录 | `features/mine` |
| `address` | 地址 | `features/mine`（个人中心子功能） |
| `profile` | 个人中心 | `features/mine` |
| `favorites` | 收藏 | `features/mine`（个人中心子功能） |
| `history` | 足迹 | `features/mine`（个人中心子功能） |
| `service` | 客服 | `features/mine`（个人中心子功能） |

每个功能分支都从 `main` 的框架提交点创建，只恢复自身所需的业务模块和入口依赖，不把其他业务模块带入工作树。`search`、`goods`、`order`、`payment` 以及个人中心子功能目前受现有模块边界约束，分支会携带对应的上层模块；后续若需要更细粒度，可再把这些页面从上层模块中抽成独立 HAR。

## 工作方式

```text
main      ← 公共框架 / 启动入口
  ├─ home / search / goods
  ├─ category
  ├─ cart / order / payment
  └─ login / address / profile / favorites / history / service
mall      ← 拆分前的完整商城基线（保留，不与 main 混用）
```

功能开发请切换到对应分支；公共能力变更先在 `main` 完成，再按需要合并到功能分支。
