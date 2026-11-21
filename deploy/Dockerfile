FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY agent/go.mod ./
COPY agent/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/server-pulse . \
    && mkdir -p /rootfs/host/proc /rootfs/var/run \
    && touch /rootfs/host/hostname

FROM scratch
COPY --from=builder /rootfs /
COPY --from=builder /out/server-pulse /server-pulse
EXPOSE 9191
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["/server-pulse", "-healthcheck"]
ENTRYPOINT ["/server-pulse"]
