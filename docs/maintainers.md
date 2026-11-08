---
title: For Maintainers
description: Updating a stack's version or settings, benching your own build, and adding a stack.
---

Corrections from each project are welcome. Every version and setting the published image uses is
in this repository, and a pull request that changes one builds the image to check it.

## Versions

Each stack comes from a build argument in the [`Dockerfile`](https://github.com/selkies-project/desktopmark/blob/main/Dockerfile).

| Stack | Build argument | Local build |
|---|---|---|
| selkies | `SELKIES_IMAGE`, a selkies base image, `debiantrixie` flavor | `docker build -f addons/base/Dockerfile --build-arg DISTRIB_IMAGE=debian --build-arg DISTRIB_RELEASE=trixie -t my/selkies .` in the selkies tree, then `--build-arg SELKIES_IMAGE=my/selkies` |
| KasmVNC | `KASMVNC_DEB` and `KASMVNC_SHA256`, the trixie package | `--build-context kasmvnc=<dir>` holding `deb/kasmvncserver*.deb` |
| Neko | `NEKO_IMAGE`, a Neko base image | `./build -r local/neko -t head` in the Neko tree, then `--build-arg NEKO_IMAGE=local/neko/base:head` |
| voxl | `VOXL_REF`, a tag or commit of `tembo/voxl` | `--build-context voxl=<tree>` |

To bench your own build, build the image with it and run as usual:

```sh
git clone https://github.com/selkies-project/desktopmark && cd desktopmark
docker build -t desktopmark --build-arg NEKO_IMAGE=local/neko/base:head .
docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" desktopmark run stacks=neko-rtc
```

To move the published image to a new release, open a pull request that changes the default in the
`Dockerfile`.

## Settings

Try a change first with an override (see [Stack Settings](./settings.md)):

```sh
docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" \
  ghcr.io/selkies-project/desktopmark run stacks=voxl-ws set.voxl.crf=22
```

Then open a pull request that changes `harness/settings/<stack>.json`, with the new `value` and a
`why` that says what it is for. Settings follow the [fairness rules](./method.md#fairness-rules):
where two stacks expose the same knob, they get the same value.

## Adding a stack

1. Add a `FROM` stage to the `Dockerfile` that brings its binaries in.
2. Add its settings to `harness/settings/<stack>.json` and an adapter in `harness/stacks/`:
   - `startX` and `startServer`, building the command line with `resolve()` from `lib/settings.mjs`;
   - `version`, `binary`, `xserver` and `encoderLib`, for the report;
   - its URL, its stream element selector and its ports;
   - the log line that proves its fast path.
3. Add it to `STACKS` in `harness/run.mjs`.
