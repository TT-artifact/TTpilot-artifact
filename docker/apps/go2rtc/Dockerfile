FROM golang:1.21-alpine AS builder

RUN apk add --no-cache git make

WORKDIR /src
ARG BRANCH=v1.8.5
RUN git clone https://github.com/AlexxIT/go2rtc.git /src
RUN git checkout ${BRANCH}

RUN CGO_ENABLED=0 go build -ldflags "-s -w" -trimpath -o go2rtc .

FROM python:3.11-alpine

RUN apk add --no-cache tini ffmpeg bash curl jq alsa-plugins-pulse font-droid

COPY --from=builder /src/go2rtc /usr/local/bin/go2rtc
# COPY go2rtc.yaml /config/go2rtc.yaml

EXPOSE 8080 1935 8554 8555 8443
VOLUME /config
WORKDIR /config

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["go2rtc", "-config", "/config/go2rtc.yaml"]
