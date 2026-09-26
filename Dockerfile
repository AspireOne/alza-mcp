FROM node:24-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0 AS build
WORKDIR /app
COPY --chmod=644 package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY --chmod=644 tsconfig.json ./
COPY --chown=node:node src ./src
RUN npm run build

FROM build AS validation
COPY --chown=node:node scripts/validate-api.ts scripts/validation-report.ts ./scripts/
USER node
ENTRYPOINT ["node", "--import", "tsx", "scripts/validate-api.ts"]

FROM build AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/browsers ALZA_DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=production-dependencies --chmod=644 /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth tini \
    && node node_modules/patchright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data && chmod 700 /data \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    && chmod -R a+rX /opt/browsers
COPY --from=build /app/dist ./dist
COPY --chmod=755 scripts/entrypoint.sh ./scripts/entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "/app/scripts/entrypoint.sh"]
CMD ["--http"]
