FROM oven/bun:1.3.11 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json ./web/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run web:build && bun run workerd:build

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=build /app/node_modules/workerd/bin/workerd /app/workerd
COPY --from=build /app/dist/workerd /app/dist/workerd
COPY --from=build /app/web/dist /app/web/dist
COPY --from=build /app/workerd/motel.capnp /app/config/motel.capnp
COPY --from=build --chown=65532:65532 /app/.local/workerd-data /app/.local/workerd-data
VOLUME ["/app/.local/workerd-data"]
EXPOSE 4318
ENTRYPOINT ["/app/workerd", "serve", "/app/config/motel.capnp", "--experimental", "--socket-addr=http=0.0.0.0:4318"]
