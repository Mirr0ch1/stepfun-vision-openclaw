# stepfun-vision-openclaw

OpenClaw plugin that registers StepFun (阶跃星辰) vision models as image & video
understanding providers.

> Status: under development. Full bilingual README (中文 / English) will be
> published together with the GitHub release.

## Goal

Register `step-1o-turbo-vision` (and optionally `step-3.7-flash`) as
`describeImage` / `describeVideo` providers for the OpenClaw media
understanding pipeline, so attachments in chats are understood by StepFun
vision models instead of the default provider.

## Planned features

- [x] Project scaffolding (this repo)
- [ ] Plugin implementation (`index.js`, `openclaw.plugin.json`, `package.json`)
- [ ] Support both StepFun surfaces:
  - Standard API: `https://api.stepfun.com/v1`
  - Step Plan (token plan subscription): `https://api.stepfun.com/step_plan/v1`
- [ ] Model selection between `step-1o-turbo-vision` and `step-3.7-flash`
- [ ] Local install & end-to-end verification on this machine
- [ ] Bilingual README + publish to GitHub

## Development

```bash
# local smoke test
node --test
```

## License

TBD
