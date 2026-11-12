# syntax=docker/dockerfile:1
ARG SELKIES_IMAGE=ghcr.io/selkies-project/selkies/base:main-debiantrixie
ARG NEKO_IMAGE=ghcr.io/m1k1o/neko/base:3.2.0
ARG KASMVNC_DEB=https://github.com/kasmtech/KasmVNC/releases/download/v1.5.2/kasmvncserver_debian_trixie_1.5.2_amd64.deb
ARG KASMVNC_SHA256=6ed957163275088a5ce52b525f82f145014e3289699d576ce26745a4249407f8
ARG VOXL_REF=v0.3.4

FROM scratch AS voxl
ARG VOXL_REF
ADD https://github.com/tembo/voxl.git#${VOXL_REF} /

FROM debian:trixie-slim AS kasmvnc
ARG KASMVNC_DEB
ARG KASMVNC_SHA256
ADD ${KASMVNC_DEB} /deb/
RUN if [ -n "${KASMVNC_SHA256}" ]; then echo "${KASMVNC_SHA256}  $(ls /deb/*.deb)" | sha256sum -c -; fi

FROM nixos/nix:2.28.3 AS nix
COPY --from=voxl / /src/voxl
COPY nix /src/dm/nix
COPY apps /src/dm/apps
RUN nix-build --option sandbox false /src/dm/nix/env.nix -o /result \
 && mkdir -p /out/nix/store /out/opt/pw \
 && cp -a $(nix-store -qR /result) /out/nix/store/ \
 && ln -s "$(readlink -f /result)" /out/env \
 && cd /out/opt/pw && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 /result/bin/npm install --no-fund --no-audit playwright-core@1.52.0

FROM ${SELKIES_IMAGE} AS selkies
USER root
RUN for f in /usr/local/bin/selkies /usr/bin/Xvfb; do ldd "$f" | awk '/=>/ {print $3}'; done \
  | xargs readlink -f | xargs dpkg -S 2>/dev/null | cut -d: -f1 | sort -u > /dm-packages

FROM ${NEKO_IMAGE} AS neko
USER root
RUN { ldd /usr/bin/neko; for f in /usr/lib/xorg/modules/drivers/dummy_drv.so /usr/lib/xorg/modules/input/neko_drv.so; do ldd "$f"; done; } \
  | awk '/=>/ {print $3}' | xargs readlink -f | xargs dpkg -S 2>/dev/null | cut -d: -f1 | sort -u > /dm-packages \
 && dpkg -S /usr/bin/X /usr/bin/Xorg "$(readlink -f /usr/lib/xorg/Xorg)" | cut -d: -f1 >> /dm-packages \
 && dpkg-query -W -f '${Package}\n' 'gstreamer1.0-plugins-*' libxcvt0 2>/dev/null >> /dm-packages

FROM debian:trixie-slim
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=selkies /dm-packages /tmp/pkgs-selkies
COPY --from=neko /dm-packages /tmp/pkgs-neko
COPY --from=kasmvnc /deb/ /tmp/kasmvnc/
# The Debian archive's state, which CI reads before the build: an archive update
# rebuilds this layer where a build cache would hand back the last build's
# packages. Empty in a build that does not read it.
ARG DISTRIB_ARCHIVE=""
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      $(cat /tmp/pkgs-selkies /tmp/pkgs-neko | grep -v -E '^(libc6|libgcc-s1|libstdc\+\+6)$' | sort -u) \
      /tmp/kasmvnc/*.deb libavcodec61 libavformat61 libavutil59 libswscale8 ffmpeg \
      openbox x11-xserver-utils x11-utils xkb-data x11-xkb-utils xauth fonts-dejavu-core fontconfig \
      iproute2 busybox procps util-linux ca-certificates libcap2-bin \
 && rm -rf /var/lib/apt/lists/* /tmp/pkgs-* /tmp/kasmvnc
COPY --from=nix /out/ /
COPY --from=selkies /usr/local/bin/selkies /opt/selkies/bin/selkies
COPY --from=selkies /usr/bin/Xvfb /opt/selkies/bin/Xvfb
COPY --from=neko /usr/bin/neko /opt/neko/bin/neko
COPY --from=neko /var/www /opt/neko/www
COPY --from=neko /etc/neko/xorg.conf /opt/neko/xorg.conf
COPY --from=neko /usr/lib/xorg/modules/drivers/dummy_drv.so /usr/lib/xorg/modules/drivers/dummy_drv.so
COPY --from=neko /usr/lib/xorg/modules/input/neko_drv.so /usr/lib/xorg/modules/input/neko_drv.so
COPY content /dm/content
COPY harness /dm/harness
RUN useradd -m -u 1000 bench && mkdir -p /out && chown bench /out \
 && printf 'allowed_users=anybody\nneeds_root_rights=no\n' > /etc/X11/Xwrapper.config \
 && setcap cap_net_admin+ep "$(readlink -f /usr/sbin/tc)" \
 && setcap cap_net_admin+ep "$(readlink -f /usr/bin/busybox)"
ARG SELKIES_IMAGE
ARG NEKO_IMAGE
ARG KASMVNC_DEB
ARG VOXL_REF
USER bench
ENV PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/env/bin \
    PLAYWRIGHT_NODE_MODULES=/opt/pw/node_modules \
    CHROMIUM=/env/bin/chromium \
    FONTCONFIG_FILE=/etc/fonts/fonts.conf \
    DM_SOURCES="selkies=${SELKIES_IMAGE} neko=${NEKO_IMAGE} kasmvnc=${KASMVNC_DEB} voxl=https://github.com/tembo/voxl/tree/${VOXL_REF}"
WORKDIR /dm
ENTRYPOINT ["/env/bin/node", "/dm/harness/run.mjs"]
