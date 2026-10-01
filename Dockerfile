# singweb 的镜像：一个进程同时发前端和接口，不需要额外的 nginx。
#
# 分两段。构建段装全部依赖、跑类型检查、打包前端；运行段只留运行时需要的
# 东西。服务端本身是 Node 直接跑 TypeScript，没有编译产物，所以运行段把
# server/ 和 shared/ 原样带过去就行。

# ---------------------------------------------------------------- 构建

FROM node:24-alpine AS build

WORKDIR /app

# 先只拷依赖清单，装完依赖再拷源码：改一行业务代码不会让这层缓存失效
COPY package.json package-lock.json ./

# 用 ci 而不是 install：锁文件说什么就装什么，构建结果可复现。
# 前端打包要 devDependencies（vite、typescript），所以不能加 --omit=dev
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY shared ./shared
COPY server ./server
# agent/ 不是运行时代码，但安装路由要把 agent/src 和 agent/package.json
# 打成一个 tarball 发给设备，所以构建和运行两段都得有它
COPY agent ./agent

# 类型检查放进构建里：检查不过就不该产出镜像，而不是等跑起来才发现
RUN npx tsc --noEmit -p . && npx tsc --noEmit -p server && npx tsc --noEmit -p agent && npm run build

# ---------------------------------------------------------------- 运行

FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# 运行段只要生产依赖：pg 是唯一一个服务端真正 import 的运行时库，
# rollup 打前端时用到的那些不用跟过来
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 前端构建产物。服务端从 dist 读，路径由 index.ts 里的 STATIC_DIR 决定
COPY --from=build /app/dist ./dist

# 服务端和它 import 的共享代码。Node 24 直接执行 .ts，没有编译产物要拷；
# 相对路径的 import 决定了两边的目录结构必须保持原样
COPY server ./server
COPY shared ./shared
# 安装路由现打 tarball 用的，见上
COPY agent ./agent

# alpine 自带的 node 用户是现成的，不用 root 跑
RUN chown -R node:node /app
USER node

EXPOSE 8080

# 健康检查打接口而不是首页：首页由静态处理器兜底，服务端挂了也可能缓存着
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.ts"]
