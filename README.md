<div align="center">

# stepfun-vision-openclaw

**OpenClaw 插件:将阶跃星辰(StepFun)视觉模型注册为图像与视频理解 Provider**

*OpenClaw plugin: register StepFun vision models as image & video understanding providers*

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.7.1-blue.svg)](https://docs.openclaw.ai)

</div>

---

## 简介 / Introduction

OpenClaw 在收到带图片/视频的消息时,会调用「媒体理解」(media understanding)管线对附件做描述。本插件将**阶跃星辰(StepFun)的视觉模型**注册进这条管线,让图片与视频由 StepFun 模型来理解。

This plugin registers **StepFun vision models** into OpenClaw's media-understanding pipeline, so images and videos attached to messages are described by StepFun models.

它同时支持两类用户:

| 用户类型 / User type | 生效模型 / Model | 端点 / Endpoint |
|---|---|---|
| **Step Plan 订阅用户**(token-plan)| `step-3.7-flash` | `https://api.stepfun.com/step_plan/v1`(CN)/ `https://api.stepfun.ai/step_plan/v1`(INTL)|
| **标准 API 用户**(按量付费)| `step-1o-turbo-vision`(优先)+ `step-3.7-flash` | `https://api.stepfun.com/v1`(CN)/ `https://api.stepfun.ai/v1`(INTL)|

> ⚠️ 重要:阶跃星辰对两类用户开放**不同的端点**。`step-1o-turbo-vision` **仅存在于标准 API 端点**;Step Plan 端点上只有 `step-3.7-flash` 等模型(用 plan key 访问标准端点会得到 `402 quota_exceeded`,访问 plan 端点上的 `step-1o-turbo-vision` 会得到 `404 model_invalid`)。

---

## 特性 / Features

- ✅ 注册 `describeImage` / `describeVideo` 媒体理解 Provider
- ✅ 支持 `step-1o-turbo-vision`(标准 API)与 `step-3.7-flash`(Step Plan)两种模型
- ✅ `surface` 配置自动切换默认模型与默认端点:
  - `plan`(默认):默认 `step-3.7-flash`,默认端点 `/step_plan/v1`
  - `api`:默认 `step-1o-turbo-vision`,默认端点 `/v1`
- ✅ 无需 `models.providers` 条目也能工作(通过 `resolveSyntheticAuth` 从 `STEPFUN_API_KEY` 解析密钥)
- ✅ 与 OpenClaw 原生优先级机制兼容(见下文「优先级 / Priority」)

---

## 安装 / Installation

### 方式一:GitHub 仓库安装(推荐)

```bash
openclaw plugins install Mirr0ch1/stepfun-vision-openclaw
systemctl --user restart openclaw-gateway  # systemd 用户服务;或 openclaw gateway restart
```

### 方式二:本地目录开发链接

```bash
openclaw plugins install --link /path/to/stepfun-vision-openclaw
systemctl --user restart openclaw-gateway
```

安装后确认插件已启用:

```bash
openclaw plugins list | grep stepfun-vision
```

---

## 配置 / Configuration

### 1. API Key

设置环境变量 `STEPFUN_API_KEY`(两种订阅共用这一个变量名):

```bash
export STEPFUN_API_KEY=sk-...
```

OpenClaw 网关(`~/.openclaw/.env` 或 systemd 环境文件)加载后需重启生效。

也可以(推荐,更显式)在 `openclaw.json` 中声明:

```jsonc
// ~/.openclaw/openclaw.json
{
  "models": {
    "providers": {
      "stepfun-vision": {
        "baseUrl": "https://api.stepfun.com/step_plan/v1", // plan 用户;api 用户用 https://api.stepfun.com/v1
        "apiKey": "${STEPFUN_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "step-1o-turbo-vision", "name": "Step 1o Turbo Vision", "input": ["text", "image", "video"], "contextWindow": 32768, "maxTokens": 65536, "api": "openai-completions" },
          { "id": "step-3.7-flash", "name": "Step 3.7 Flash", "reasoning": true, "input": ["text", "image", "video"], "contextWindow": 262144, "maxTokens": 65536, "api": "openai-completions" }
        ]
      }
    }
  }
}
```

### 2. 订阅类型(surface)

在插件配置中声明你的订阅类型:

```jsonc
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "stepfun-vision": {
        "enabled": true,
        "config": {
          "surface": "plan" // "plan"(默认,Step Plan 订阅)| "api"(标准 API)
        }
      }
    }
  }
}
```

### 3. 媒体理解模型列表与优先级(tools.media)

在 `tools.media` 中把 `stepfun-vision` 加入图片/视频理解列表。**数组顺序即尝试顺序:第一个成功的模型胜出,失败自动回退到下一个**(详见「优先级」)。

**Step Plan 用户(只配 `step-3.7-flash`):**

```jsonc
{
  "tools": {
    "media": {
      "image": {
        "models": [
          { "provider": "stepfun-vision", "model": "step-3.7-flash", "capabilities": ["image"] },
          { "provider": "minimax-tp", "model": "MiniMax-M3", "capabilities": ["image"] } // 可选兜底
        ]
      },
      "video": {
        "models": [
          { "provider": "stepfun-vision", "model": "step-3.7-flash", "capabilities": ["video"] },
          { "provider": "minimax-tp", "model": "MiniMax-M3", "capabilities": ["video"] } // 可选兜底
        ]
      }
    }
  }
}
```

**标准 API 用户(双模型,`step-1o-turbo-vision` 优先):**

```jsonc
{
  "tools": {
    "media": {
      "image": {
        "models": [
          { "provider": "stepfun-vision", "model": "step-1o-turbo-vision", "capabilities": ["image"] },
          { "provider": "stepfun-vision", "model": "step-3.7-flash", "capabilities": ["image"] },
          { "provider": "minimax-tp", "model": "MiniMax-M3", "capabilities": ["image"] } // 可选兜底
        ]
      },
      "video": {
        "models": [
          { "provider": "stepfun-vision", "model": "step-1o-turbo-vision", "capabilities": ["video"] },
          { "provider": "stepfun-vision", "model": "step-3.7-flash", "capabilities": ["video"] },
          { "provider": "minimax-tp", "model": "MiniMax-M3", "capabilities": ["video"] } // 可选兜底
        ]
      }
    }
  }
}
```

配置修改后重启网关生效。

---

## 优先级机制 / Priority

OpenClaw 的媒体理解优先级规则(基于源码行为):

1. **显式配置优先**:`tools.media.<capability>.models[]` 的**数组顺序 = 尝试顺序**。对每个附件依次尝试,第一个返回成功的模型胜出;失败的条目被记录后自动尝试下一个(即兜底/fallback)。
2. **自动模式**(未配置 `tools.media` 时):按各 Provider 声明的 `autoPriority[capability]` **升序**排序,数字越小优先级越高。本插件声明 `autoPriority: { image: 10, video: 10 }`。
3. 若当前主聊天模型原生支持视觉,且未显式配置图片理解,图片理解可能被跳过。

因此:
- 想让某个模型「最高优先级」→ 把它排在 `tools.media` 数组**最前面**。
- 想让某个模型「仅兜底」→ 排在数组**最后**。

---

## 工作原理 / How it works

- 协议:OpenAI 兼容的 `POST {baseUrl}/chat/completions`
- 图片:`content` 中 `{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }`
- 视频:`content` 中 `{ "type": "video_url", "video_url": { "url": "data:video/mp4;base64,..." } }`(StepFun 扩展类型)
- 返回文本取自 `choices[0].message.content`
- `step-3.7-flash` 是推理模型,`max_tokens` 建议 ≥ 1024(默认 2048),否则推理可能占用全部 token 导致正文为空

---

## 故障排查 / Troubleshooting

| 现象 | 原因 | 解决 |
|---|---|---|
| `402 quota_exceeded` | 用 Step Plan key 请求标准 API 端点 | 使用 `/step_plan/v1` 端点,或购买标准 API 额度 |
| `404 model_invalid` | 在 Step Plan 端点请求 `step-1o-turbo-vision` | Step Plan 用户改用 `step-3.7-flash` |
| 正文为空 / 只有推理过程 | `step-3.7-flash` 推理占满 token | 调大 `maxTokens`(插件配置) |
| `missing API key` | 未配置密钥 | 设置 `STEPFUN_API_KEY`,或配置 `models.providers.stepfun-vision.apiKey` |

---

## 开发 / Development

```bash
git clone https://github.com/Mirr0ch1/stepfun-vision-openclaw
cd stepfun-vision-openclaw
openclaw plugins install --link .
systemctl --user restart openclaw-gateway
```

本地冒烟测试(需在可解析 `openclaw` 包的环境下运行,如插件目录内建 `node_modules/openclaw` 软链):

```bash
node --check index.js
```

---

## 兼容性 / Compatibility

- OpenClaw `2026.7.1+`
- Node.js `>= 18`(OpenClaw 自带运行时)

---

## License

[MIT](LICENSE)
