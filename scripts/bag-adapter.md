# 把真 bag agent 接进游戏 / 把游戏接上真链

这份文档讲两件事：

1. **接真 agent** —— 让某张卡的报价来自一台真实运行的 `bag dev` agent，而不是内置大脑
2. **上真链** —— 让托管真的落在 BNB Chain 测试网上

---

## 一、接真 agent（约 10 分钟）

### 1. 生成真实工作区

```powershell
cd D:\AgentGuild
.\scripts\scaffold-bag-agents.ps1
```

每张卡得到一个独立的 bag 工作区：**独立钱包 + 独立 keystore + 独立端点**。
（`bag init` 每张约 1–3 分钟，主要是装依赖。）

### 2. 跑起来

每张卡必须换一个端口，否则会打架：

```powershell
cd D:\AgentGuild\cards\reporta; bag dev --port 9001     # 终端 1
cd D:\AgentGuild\cards\detectb; bag dev --port 9003     # 终端 2
```

### 3. 验证协议面（**用 curl，别用 IDE 的聊天框**）

`bag dev` 本地跑的时候不带 Cognito，端点可以匿名访问：

```powershell
curl http://localhost:9001/.well-known/agent-card.json
```

应当看到 agent card 里有两个技能：`negotiate` 和 `notify_funded`。

手打一张报价单（**注意 `terms` 里必须同时有 `deliverables` 和 `quality_standards`，
少任何一个都会被直接拒签，`reason_code 0x04`**）：

```powershell
curl -s -X POST http://localhost:9001/ -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"message/send",
  "params":{"message":{"role":"user","parts":[{"kind":"data","data":{
    "skill":"negotiate",
    "task_description":"根据链上转账日志生成对账报告",
    "terms":{"deliverables":"JSON 对账清单","quality_standards":"差值为 0"}
  }}],"messageId":"nego-1"}}}'
```

返回的 DataPart 里就是**签名报价单**（`price` / `negotiation_hash` / `provider_sig`）。
这张报价单是链下 EIP-191 签名，**不花一分 gas** —— 所以投标阶段不烧钱，游戏节奏才跑得起来。

### 4. 让游戏去用这个真 agent

```powershell
$env:BAG_ENDPOINT_A_REPORT = "http://localhost:9001"
$env:BAG_ENDPOINT_B_DETECT = "http://localhost:9003"
node server/index.js
```

启动横幅会列出已接的真 agent。开一局，事件流里会出现：

```
📡 真实 bag agent 报价 7 币
   报告师 @ http://localhost:9001 · 这行报价来自一台真实运行的 bag agent … · hash 3f2a…
```

**关键**：外部 agent 的报价**照样要过游戏侧的确定性闸门**。
如果它报的价低于你的「最低报价」，或者完成它需要的分包超过你的「最大分包支出」，
一样会被 `⛔ 闸门拦截`。

这就是设计稿里那两道墙的意义 —— **不管报价是本地算的还是外面 agent 给的，
钱的那一步永远走固定代码**。

### 5. 没配端点的卡怎么办

自动回落到内置大脑。所以你可以只接一张，混着跑，逐张替换。

---

## 二、分包链路怎么走真 bag

游戏里的"分包"= 总包向另一张卡下一张子任务。在真链上就是**第二个独立的 ERC-8183 job**。

在**总包的工作区**里跑（买方流程用的是当前工作区钱包）：

```powershell
cd D:\AgentGuild\cards\reportera

bag erc8183 buy --provider <侦探卡的钱包地址> `
  "清理转账日志中的重复事件" `
  --budget-usd 0.03 --deadline-min 30 --network bsc-testnet
```

输出 4 个 tx hash + `job_id`。这 4 步就是托管的完整链路：

```
createJobWithToken(provider, expiredAt, description, token)  → job_id
registerJob(jobId)
setBudget(jobId, rawBudget)
fund(jobId, rawBudget)          ← 钱在这里进托管
```

然后通知卖方 + 轮询：

```powershell
bag erc8183 status <job_id>     # FUNDED → SUBMITTED
bag erc8183 fetch  <job_id>     # 取交付物 URL
bag erc8183 settle <job_id> --action approve
```

> ⚠️ **本地跑必须手工议价**：`--agent-id` 的自动议价要求公网 HTTPS 端点，
> 会拒绝 loopback/内网地址。本地流程是：游戏层先拿到签名报价，
> 再用 `--provider <addr> --no-negotiate --budget-usd <中标价>` 建 job。

---

## 三、上真链的三条路

### 为什么不能直接用标准合约跑比赛

真实合约的**争议窗口写死 24 小时**，而且 `approve` 必须等窗口过后才能调用
（提前调会被链拒绝，revert `0x17be5b7b`）。用它跑一局 3 回合的比赛，**一局要跑 3 天**。

### 路线 A（推荐）：自部署参数化合约

在测试网部署一个争议窗口 30 秒的兼容合约，然后覆盖三个地址：

```powershell
bag env set ERC8183_COMMERCE_ADDRESS 0x...
bag env set ERC8183_ROUTER_ADDRESS   0x...
bag env set ERC8183_POLICY_ADDRESS   0x...
bag doctor
```

> 三个必须**同时**来自同一套部署。只设一两个会被拒绝（防止混用不兼容的合约）。

游戏侧的 `escrow.js` 状态机本来就是按同样的语义写的，把结算动作从本机账本换成链上调用即可。

### 路线 B：游戏层结算 + 链上锚定哈希

比赛主体走本机确定性账本（当前实现），链上只锚定**报价单 / 交付物 / 证据包**的哈希。
最快，但"真托管"的说服力打折。

### 路线 C：真链铁证（强烈建议叠加）

演示**前一天**用标准栈发起一笔真实任务，当天正好满 24 小时：

```powershell
# 演示前一天
bag erc8183 buy --provider <地址> "对账报告" --budget-usd 0.1 --deadline-min 30 --network bsc-testnet
# ……卖方交付，job 到 SUBMITTED……

# 演示当天（已过 24h 争议窗口）
bag erc8183 settle <job_id> --action approve
bag erc8183 status <job_id>          # COMPLETED
```

现场把 BscScan 链接上屏 —— **链上真的动了钱**。
这一招堵死"你们是不是只做了个游戏"的质疑。

---

## 四、已知的坑（都是实测踩过的）

| 坑 | 表现 | 应对 |
|---|---|---|
| **买方流程未产品化** | bag v1 是 seller-only，分包要自己封装买方链路 | 第一天就先手工打通一笔 |
| **24h 争议窗口** | `approve` 提前调 revert `0x17be5b7b` | 见上方三条路线 |
| **测试网 U 双 rail** | 余额明明有钱却买不了 | ERC-8183 认准 **18 位小数**的合约；b402/x402 是另一条 6 位的 |
| **没有 `bag wallet transfer`** | 给多个钱包分发测试币只能手动 | 用外部钱包（小狐狸等）转 |
| **部署需要 Bun 1.3+** | `bag deploy` 失败（`bag dev` 不需要） | 装 Bun，或设 `BNBAGENT_DEPLOY_COMMAND` |
| **部署后端点不匿名** | 云端 agent 需要 Cognito OAuth2 令牌 | **黑客松优先全本地**：本机 `bag dev` 不带 Cognito，卡与卡可直接通信 |
| **inspector 聊天框测不了卖家技能** | 只能发纯文本，构造不出 DataPart | 只用 curl / A2A 客户端 |
| **报价缺字段被拒签** | `reason_code 0x04` | `terms` 必须带 `deliverables` + `quality_standards` |

---

## 五、环境变量速查

| 变量 | 作用 |
|---|---|
| `BAG_ENDPOINT_<CARD_ID>` | 让该卡的报价来自真 bag agent。卡 id 里的 `-` 换成 `_`，如 `A-REPORT` → `BAG_ENDPOINT_A_REPORT` |
| `BAG_PROVIDER_<CARD_ID>` | 该卡在 ERC-8183 里的 provider 地址（上链时用） |
| `PORT` | 游戏服务器端口（默认 9200） |
| `STUDIO_BSC_TESTNET_RPC` | 覆盖测试网 RPC（公共 RPC 限流时用私有节点） |
