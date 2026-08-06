# Asspp UDID 自助配置与 Ad Hoc OTA 运维

本文记录 Asspp Fork 的生产配置、用户操作、验证方法和故障处理。任何口令、令牌、Apple 私钥、证书密码和真实 UDID 都不得写入仓库、网页或日志。

## 生产入口

- 自助配置：<https://asspp-udid-onboarding.709962401.workers.dev>
- 最新安装页：<https://bulai0408.github.io/Asspp/ios/latest/install.html>
- GitHub Actions：`Upstream Signed iOS Build`
- Worker：`asspp-udid-onboarding`
- D1：`asspp-udid-onboarding`
- Bundle ID：`com.thoamsy2.asspp`

截至 2026-08-06，生产 Ad Hoc Profile 包含 6 台兼容设备：4 台 iPhone、1 台 iPad 和 1 台 iPod。Apple API 同时返回的 Apple Watch 与 Apple TV 会被过滤，因为 `IOS_APP_ADHOC` 不接受这两类设备。

## 用户操作

1. 在需要安装 Asspp 的 iPhone 或 iPad 上，用 Safari 打开自助配置页。
2. 回答页面问题并提交。答案只在 Cloudflare Worker Secret 中校验。
3. 点击“下载设备描述文件”，然后在“设置”中安装刚下载的描述文件。
4. 安装过程中，设备会向 Worker 提交由 Apple CMS 签名的 `UDID`、`PRODUCT`、`VERSION` 和一次性 challenge。完成后会留下一个可删除的状态 Web Clip 描述文件。
5. 返回状态页等待 GitHub Actions 注册设备、生成 Ad Hoc Profile、签名 IPA 并发布。正常构建约 7 分钟，GitHub Pages 排队时可能延长。
6. 页面显示“安装 Asspp”后点击安装。确认 App 能启动后，可以在“设置”中删除临时状态描述文件。

每个请求有效 60 分钟。描述文件只用于取得设备标识和返回状态入口，不包含 MDM、根证书、VPN 或设备限制。

## 数据与安全边界

- Worker 页面只显示问题，不包含答案。
- 错误答案按来源限流为每分钟 8 次。
- D1 只持久化 challenge 哈希；原始 challenge 由请求 ID 和 HMAC Secret 派生。
- CMS 回调最大 256 KiB，只允许提交和领取一次。
- GitHub workflow dispatch 只携带随机请求 ID，不携带 UDID 或 CMS。
- GitHub runner 领取 CMS 时立即从 D1 清空原始数据，并在日志中 mask UDID。
- Worker 每 15 分钟清理一次：过期请求清空 CMS 并标记 `expired`，到期 24 小时后删除整行元数据。
- Apple 私钥只存在 GitHub Secrets；Worker 无法访问 Apple 凭据。
- Worker 内部接口使用独立 bearer token，公开状态接口不返回 UDID、challenge 或供应商错误正文。

## Cloudflare 配置

在 `Services/UDIDOnboarding` 下执行：

```bash
npm ci
npm test -- --run
npm run typecheck
npx wrangler d1 migrations apply asspp-udid-onboarding --remote --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

必须配置以下 Worker Secrets，命令会交互式读取值：

```bash
npx wrangler secret put GATE_ANSWER --config wrangler.jsonc
npx wrangler secret put CHALLENGE_KEY --config wrangler.jsonc
npx wrangler secret put GITHUB_TOKEN --config wrangler.jsonc
npx wrangler secret put INTERNAL_API_TOKEN --config wrangler.jsonc
```

`GITHUB_TOKEN` 需要对 `bulai0408/Asspp` 具备 workflow dispatch 权限。`INTERNAL_API_TOKEN` 必须与 GitHub Secret `UDID_WORKER_API_TOKEN` 相同。

检查绑定和健康状态：

```bash
npx wrangler secret list --config wrangler.jsonc
curl -fsS https://asspp-udid-onboarding.709962401.workers.dev/health
```

## GitHub 配置

动态注册与签名需要以下 Secrets：

| Secret | 用途 |
| --- | --- |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect API issuer |
| `APP_STORE_CONNECT_KEY_ID` | App Store Connect API key ID |
| `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | API `.p8` 私钥的 Base64 |
| `IOS_CERT_P12_BASE64` | Apple Distribution 证书和私钥 |
| `IOS_CERT_PASSWORD` | P12 密码 |
| `IOS_KEYCHAIN_PASSWORD` | CI 临时 Keychain 密码 |
| `IOS_TEAM_ID` | Apple Developer Team ID |
| `UDID_WORKER_URL` | Worker HTTPS 地址 |
| `UDID_WORKER_API_TOKEN` | Worker 内部接口令牌 |

保留 `IOS_PROVISIONING_PROFILE_BASE64` 作为静态 Profile 回退。动态模式还使用以下 Variables：

| Variable | 当前用途 |
| --- | --- |
| `IOS_BUNDLE_ID` | 必须匹配 Apple App ID |
| `IOS_EXPORT_METHOD` | `ad-hoc` |
| `IOS_SIGNING_IDENTITY` | `Apple Distribution` |

手动验证完整发布：

```bash
gh workflow run upstream-signed-ios.yml \
  --repo bulai0408/Asspp \
  -f source_kind=upstream \
  -f source_repo=Lakr233/Asspp \
  -f source_branch=main \
  -f force_build=true
```

工作流会复用关系集合相同且仍为 ACTIVE 的 Profile；新增兼容设备后会生成新 Profile。定时上游构建也走同一动态 Profile 逻辑，因此后续自动更新会继续包含已登记设备。

## Apple 设备名额

Apple Developer Program 每个会员年度、每个产品家族最多登记 100 台设备。iPhone 与 iPad 分别计数。停用设备不会返还当年名额；新会员年度开始时可重置设备列表。Apple 还提示，同一平台登记量达到 11 至 100 台时，新设备可能需要 24 至 72 小时完成处理。

- [Apple Devices overview](https://developer.apple.com/help/account/devices/devices-overview)
- [Apple Device registration updates](https://developer.apple.com/help/account/reference/device-registration-updates)
- [Apple Ad Hoc provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile)

## 故障处理

### 安装很快失败或提示“无法验证完整性”

确认该设备已登记到当前 Apple Team，并确认最新 IPA 的 `embedded.mobileprovision` 包含其 UDID。删除设备上的旧 Asspp 后，从最新安装页重新安装。设备首次启动 Ad Hoc App 时还需要联网访问 Apple 的 PPQ 验证服务。

### 描述文件已下载，状态页没有变化

下载动作本身不会提交 UDID。用户必须进入“设置”完成描述文件安装。请求超过 60 分钟后重新从自助配置页开始。

### Actions 构建成功，Pages 部署超时

签名 Release 和 Pages artifact 会保留。只重跑失败 job：

```bash
gh run rerun <run-id> --repo bulai0408/Asspp --failed
```

`actions/deploy-pages@v4` 默认等待 10 分钟。若仓库持续出现超过 10 分钟的正常部署，可在 workflow 的 deploy step 设置更长的 `timeout` 输入。

### Apple Profile 创建返回 409

查看受保护日志中的稳定错误类别。iOS Ad Hoc Profile 的设备集合只能包含 `IPHONE`、`IPAD`、`IPOD`；Apple API 的 `platform=IOS` 还可能返回 Apple Watch 与 Apple TV，代码会主动过滤它们。

## 已验证基线

2026-08-06 的生产验收结果：

- Worker 健康检查、口令失败、内部接口未授权边界均符合预期。
- Apple Profile CMS 有效，Bundle ID 匹配，`get-task-allow=false`，包含 6 台兼容设备。
- GitHub Actions 运行 `31096766575` 完成动态 Profile、归档、IPA 导出、Release 与 Pages 部署。
- IPA 大小为 11,504,981 字节，`codesign --verify --deep --strict` 通过。
- 最新安装页包含自助配置入口和“需要联系 kami 配置 udid，配完后 可用 1 年”提示。
