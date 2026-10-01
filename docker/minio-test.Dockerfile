# Isolated test fixture only; never use this legacy source build for production.
# Build with a context containing minio-source.tar, produced by `git archive`
# from MinIO commit 07c3a429bfed433e49018cb0f78a52145d4bedeb
# (RELEASE.2025-09-07T16-13-09Z). See docs/dev/release-validation.md.
FROM golang:1.24-bookworm AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2
WORKDIR /src
COPY minio-source.tar /tmp/minio-source.tar
RUN echo '3fd74f9e3123e8d112141b9764e583b263c711b9ce87661bfa3afda586f92091  /tmp/minio-source.tar' | sha256sum -c - \
    && tar -xf /tmp/minio-source.tar -C /src \
    && rm /tmp/minio-source.tar
RUN go build -p 2 -trimpath -buildvcs=false -o /out/minio .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 fixture
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /licenses/MinIO-LICENSE
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="07c3a429bfed433e49018cb0f78a52145d4bedeb" \
      org.opencontainers.image.description="Local test-only source build; not an official release image"
USER 10001
ENTRYPOINT ["/usr/local/bin/minio"]
