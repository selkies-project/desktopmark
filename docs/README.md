---
title: DesktopMark
description: A neutral benchmark for web-based desktop streaming, run on your own hardware.
---

DesktopMark runs every stack under test in one container, alone, on its own X server, and measures
it **in Chromium through its own web client**, with the same desktop, the same content, the same
input and the same machine budget.

The baseline category is **X11, software H.264 4:2:0, no GPU**.

| Column | Stack | Transport |
|---|---|---|
| `selkies-ws`, `selkies-rtc` | [selkies](https://github.com/selkies-project/selkies) | WebSockets, WebRTC |
| `kasm-ws` | [KasmVNC](https://github.com/kasmtech/KasmVNC) (H.264 stream mode) | WebSockets |
| `neko-rtc` | [Neko](https://github.com/m1k1o/neko) | WebRTC |
| `voxl-ws` | [voxl](https://github.com/tembo/voxl) | WebSockets |

Extra, labelled rows (`extras=1`): `kasm-ws-hybrid` and `kasm-rtc-hybrid`, KasmVNC's
lossless/JPEG/WebP hybrid. In KasmVNC 1.5.2 that is the only content its WebRTC (UDP) transport
can carry, so there is no H.264 `kasm-rtc` column.

Not compared, because there is no H.264 web path on X11 or the stack isn't a self-hosted web
client: noVNC + x11vnc, Apache Guacamole, Sunshine/Moonlight, hosted sandboxes.

## Quick start

```sh
mkdir -p out && chmod a+rwx out
docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" \
  ghcr.io/selkies-project/desktopmark run
```

Open `out/run-<time>/report.html` when it finishes. See [Running](./running.md) for the options,
[Method](./method.md) for what is measured, and [Stack Settings](./settings.md) for how each stack
is configured.
