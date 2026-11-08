<p align="center"><img src="docs/logo.svg" width="192" alt="DesktopMark logo"></p>

# DesktopMark

A neutral benchmark for web-based desktop streaming. Every stack runs in one container, on its own
X server, and is measured in Chromium through its own web client, with the same desktop, content,
input and machine budget.

Stacks: [selkies](https://github.com/selkies-project/selkies) (WebSockets and WebRTC),
[KasmVNC](https://github.com/kasmtech/KasmVNC), [Neko](https://github.com/m1k1o/neko) and
[voxl](https://github.com/tembo/voxl).

Documentation: <https://desktopmark.selkies.io>

## Running

You need an x86-64 host with AVX2, at least 4 cores (12 or more for the cleanest numbers) and
Docker.

```sh
mkdir -p out && chmod a+rwx out
docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" \
  ghcr.io/selkies-project/desktopmark run
```

A full run takes about 20 minutes on a 16-core host. Open `out/run-<time>/report.html` when it
finishes.

Run some of the stacks, or one link:

```sh
docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" \
  ghcr.io/selkies-project/desktopmark run stacks=selkies-ws,voxl-ws links=lan
```

All options are in [Running](docs/running.md).

## For project maintainers

Each stack's version is a build argument in the [`Dockerfile`](Dockerfile), and every setting the
harness gives it is in [`harness/settings/<stack>.json`](harness/settings), with the reason for
its value.

| Stack | Version | Settings |
|---|---|---|
| selkies | `SELKIES_IMAGE` | [`selkies.json`](harness/settings/selkies.json) |
| KasmVNC | `KASMVNC_DEB`, `KASMVNC_SHA256` | [`kasmvnc.json`](harness/settings/kasmvnc.json) |
| Neko | `NEKO_IMAGE` | [`neko.json`](harness/settings/neko.json) |
| voxl | `VOXL_REF` | [`voxl.json`](harness/settings/voxl.json) |

To submit an update, open a pull request that changes the default in the `Dockerfile` or the
setting in your stack's JSON file. Pull requests build the image, and merging publishes it.

Try a settings change before you submit it, with no rebuild:

```sh
docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" \
  ghcr.io/selkies-project/desktopmark run stacks=voxl-ws set.voxl.crf=22
```

To bench your own build, see [For Maintainers](docs/maintainers.md).

## License

[Mozilla Public License 2.0](LICENSE)
