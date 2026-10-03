---
created: 2026-10-01
updated: 2026-10-01
tags: []
---

# 单机生产部署

## 摘要

采用一个 Node.js 进程、SQLite、持久化素材卷和 Caddy HTTPS。前端使用构建产物，不运行 Vite。不要扩成多个应用实例或使用 PM2 cluster：队列和分钟限流仍是单进程状态。

当前验证（2026-10-01）：Linux Docker 镜像构建、本地独立容器 HTTPS 联调、容器内后端 111 项测试、容器重建与完整数据卷备份恢复均已通过。此前前端 19 项测试、前端构建及前后端依赖审计也已通过（0 项已知漏洞）。Docker Hub 直连受阻的问题已通过 AWS 公共仓库托管的 Docker 官方基础镜像绕过。尚未部署真实服务器，也未验收公网域名证书；按用户安排，真实 AI 厂商调用等模型配置完成后再测试。

AI 配置回归修复：首次验收遗漏配置创建流程，后续发现手动创建与厂商配置导入的 INSERT 语句均存在“18 个值对应 17 个字段”的错误。现已修复并重新构建镜像，新增真实 HTTP 回归覆盖七类配置的新增、读取、编辑、删除、默认切换和跨组织隔离，以及厂商导入与密钥保留；本地浏览器新增和编辑也已实测成功。上述保存配置验证不依赖真实 AI 厂商调用。

## 正文

### 首次部署

服务器安装 Docker Engine 和 Compose 插件，建议至少 2 核 4 GB。将域名 A/AAAA 记录正确指向服务器，开放 80/443；不开放 3014/5680。上传源码时不要携带开发数据库、密钥、日志或本地配置。

镜像使用 Node.js 22。安全更新后的图片处理依赖要求 Node.js 至少 20.9；不要再使用 Node.js 18。后端对厂商 SDK 的 axios、protobufjs、uuid 间接依赖配置了修复版本 overrides，升级 SDK 时需要保留或重新验证这些限制，不要用 `npm audit fix --force` 自动降级 SDK。

在本目录执行：

```sh
cp .env.example .env
# 编辑 .env 中 APP_DOMAIN，不能包含 https:// 或路径。
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 app caddy
```

设置管理员后台入口：在 `.env` 中将 `PLATFORM_ADMIN_USER_IDS` 配置为数据库中已存在的用户 ID，多个 ID 用逗号分隔。仅名单内账号会在账号菜单中看到“管理员后台”，并可管理平台公告；普通工作区所有者和管理员不会自动获得平台级权限。平台公告对所有已登录工作区成员可见。使用用户 ID 可避免未验证邮箱被抢注后继承平台权限。

如果 Docker Hub 直连超时，可在 `.env` 中选择 AWS 公共仓库托管的 Docker 官方镜像，无需修改系统代理或关闭证书校验：

```dotenv
NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
CADDY_IMAGE=public.ecr.aws/docker/library/caddy:2-alpine
```

后端锁文件应在 Node 22 / npm 10 环境维护，避免不同 npm 版本生成的间接依赖记录在 Linux `npm ci` 中缺失。镜像内仍使用 `npm ci` 严格安装锁定版本。

Caddy 自动申请和续期证书。验证 `https://你的域名/health` 和注册、登录、上传、播放。首次创建账号时短暂把 `ALLOW_REGISTRATION=true`，执行 `docker compose up -d app`；创建完毕后改回 false 并再次执行。生产配置默认关闭公开注册；后续可以在受控注册期间开放。

邀请者必须核对对方账号 ID 和邮箱。账号 ID 位于账号菜单。邮箱只是账号标识，不代表已经验证邮箱归属。旧的未绑定账号邀请显示“需重新确认”，需要重新发送；现有成员不会因此被移除。

### 素材与 AI 调用

新素材位于工作区目录。旧项目目录按项目所属工作区鉴权，旧公共目录根据数据库中的引用建立一次性归属记录；无法确认或有冲突的文件不开放。原始文件不移动、不删除。上线前用已有项目抽查旧素材显示。

`/static` 只允许登录会话或有效文件签名访问。浏览器使用 HttpOnly、SameSite=Strict 的素材 Cookie，生产环境要求 Secure。退出、移除成员会使会话失效。AI 厂商收到的签名链接最长有效 10 分钟；已经发出的签名链接在到期前仍可访问，已被对方下载的内容无法撤回。不要在代理层绕过接口直接映射素材卷。第三方原有公开 URL 不在本平台访问控制范围内。

生产环境禁止向默认公共图床上传本地素材，使用本站短期签名或模型支持的文件/base64 输入。各种厂商协议需要在配置真实 API 后逐一验收，不会为测试自动产生付费调用。

默认登录每 IP 30 次/15 分钟、每账号 10 次/15 分钟；注册每 IP 5 次/小时；普通写操作每账号 120 次/分钟。批量图片/视频提交不设置应用层图片/视频并发上限；`AI_GENERATION_RATE_LIMIT` 仅在显式设置为正数时启用工作区突发保护，默认关闭。每日 AI 请求限额默认 300（UTC 零点重置，写入数据库，失败请求也计数），待处理异步任务上限 50；后台 AI 任务消费者默认 4 个，负责统一调度和失败重试。每日限额是请求数，不是费用预算，一次批量请求及自动重试可能产生多次模型调用。

### 备份、升级和回退

```sh
sh backup.sh
```

备份会短暂停止应用，打包数据库、WAL、素材及签名/邀请密钥，再恢复应用。备份包含敏感数据；定期加密复制到另一台机器并验证校验和，不只留在原服务器。不要只复制正在写入的 drama.db。

升级前备份，并将 `APP_VERSION` 设为唯一版本，例如日期加修订号，保留旧镜像。构建、启动后检查健康、登录和素材访问。数据库迁移会自动执行；失败时不要反复强行启动。

恢复演练在独立测试服务器或新 Compose 项目中进行：先校验归档，再停止应用，将完整归档还原到空的数据卷，使用对应版本镜像启动。检查 SQLite `PRAGMA integrity_check`、账号、邀请、图片和视频，然后再安排正式恢复。回退必须配套恢复该版本数据库和文件，不能只回滚镜像，也不要直接覆盖在线卷。

### 发布前验收

确认跨工作区访问被拒绝，退出后素材 URL 不再可读，视频拖动播放正常，限流返回 429 和 Retry-After，HTTPS 证书正常，容器重启后数据仍在，完成一次备份恢复演练。按实际 AI 厂商验证参考图、音频和任务恢复，并进行代表性并发压测后再扩大使用范围。

### 本地容器验收

`compose.acceptance.yaml` 仅用于测试：绑定本机回环地址 18080/18443，启用测试注册，使用 Caddy 内部 CA。必须使用单独的 Compose 项目名和空数据卷，不能用于公网部署，也不要将开发数据库复制进去。

```sh
export APP_DOMAIN=localhost APP_VERSION=acceptance
docker compose -p minidrama-acceptance -f compose.yaml -f compose.acceptance.yaml up -d --build
docker compose -p minidrama-acceptance -f compose.yaml -f compose.acceptance.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt /tmp/minidrama-acceptance-ca.crt
export ACCEPTANCE_CA=/tmp/minidrama-acceptance-ca.crt
export ACCEPTANCE_STATE=/tmp/minidrama-acceptance-state.json
node container-acceptance.cjs seed
docker compose -p minidrama-acceptance -f compose.yaml -f compose.acceptance.yaml restart app
node container-acceptance.cjs persisted
```

验收程序只信任指定的测试 CA，不修改系统证书信任，也不跳过 TLS 校验。状态文件含测试账号凭据和会话，只放在临时目录，不提交源码。`video` 模式检查预先生成的 FFmpeg 测试视频；`verify-restored-volume.cjs` 在隔离容器内检查恢复卷、密钥、素材、会话及原生图片处理模块。验收不会调用 AI 厂商。

视频测试使用 `prepare-acceptance-video.cjs`：将 `ACCEPTANCE_ORG_ID` 设为状态文件中的 `a.user.organization.id`，通过 `docker compose ... exec -T -e ACCEPTANCE_ORG_ID app node < prepare-acceptance-video.cjs` 在测试应用中执行。该脚本只接受 localhost:18443 和专用测试账号，生成一秒 H.264 视频，并将签名 URL 写入容器 `/tmp/acceptance-signed-url.txt`。用 `exec -T app cat` 将该文件保存到主机临时目录，设置 `ACCEPTANCE_SIGNED_URL_FILE` 后执行 `node container-acceptance.cjs video`。应用根文件系统只读，不能依赖 `docker cp` 向容器写入脚本。

2026-10-01 实测结果：

| 验收项 | 结果 |
| --- | --- |
| Node 22 Linux 镜像、前端构建、后端原生依赖 | 通过；镜像 `minidrama:acceptance-20261001` |
| Caddy HTTPS、前端页面及 JS、Secure/HttpOnly Cookie | 通过；使用显式信任的测试 CA |
| 注册登录、跨工作区隔离、账号邀请、移除成员后会话失效 | 通过 |
| 图片上传、素材匿名拒绝、跨组织拒绝、Range 分段读取 | 通过 |
| 登录账号限流 | 通过；返回 429 和 Retry-After |
| FFmpeg 生成 H.264、ffprobe、视频分段读取、签名与篡改拒绝 | 通过 |
| 非 root 进程、只读根目录、临时可写目录、容器健康检查 | 通过 |
| 容器内后端测试 | 111 通过，0 失败、0 跳过（含新增的 AI 配置回归） |
| AI 配置新增、编辑保存、删除、默认切换、跨组织隔离、厂商配置导入 | 修复 SQL 后通过；实际页面新增/编辑通过 |
| 重建应用并关闭注册，账号/会话/项目/素材仍保留 | 通过 |
| 停止写入后备份，gzip 校验、SHA256、新卷恢复 | 通过 |
| 恢复卷启动、SQLite 完整性、密钥、素材权限、sharp 图片处理 | 通过 |

演练归档保留在 `backups/acceptance/minidrama-container-20261001.tar.gz`，旁边有 SHA256 校验文件；只含合成测试数据。恢复使用独立卷 `minidrama-acceptance-restore-20261001`，验证容器禁用外部网络。测试栈验收后停止，数据卷保留，现有开发服务不受影响。这些结果不代表真实 AI 厂商链路、公网证书或高并发负载已完成验收。

## 相关笔记

项目现有部署说明及配置说明位于源码 docs 目录。
