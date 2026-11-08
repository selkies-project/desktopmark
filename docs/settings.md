---
title: Stack Settings
description: How each stack is configured, and how to run it with other settings.
---

Every flag, environment variable and URL parameter the harness gives a stack is in
[`harness/settings/<stack>.json`](https://github.com/selkies-project/desktopmark/tree/main/harness/settings),
one entry per setting with its value, the stack's shipped value where known and the reason it has
that value. The adapters build their command lines from these files, so retesting the same binaries
with other settings needs no code change.

## Overrides

```sh
desktopmark run stacks=voxl-ws set.voxl.crf=22 label="voxl at CRF 22"
desktopmark run set.selkies-rtc.congestion-control=false   # one column only
desktopmark run set.neko.x264:qp-min=10                     # a setting the file lacks: group:key
desktopmark run set.kasmvnc.quality=unset                   # leave a setting out
desktopmark run settings=/out/proposal.json                 # {"voxl": {"crf": "22"}}
```

Targets are a stack (`voxl`, `selkies`, `kasmvnc`, `neko`) or a column (`selkies-rtc`). Values can
use `{fps}`, `{w}`, `{h}` and `{ceilingKbps}` (and `{crf}`, KasmVNC's calibrated CRF), with
arithmetic: `{ceilingKbps/2}`.

| Stack | Groups |
|---|---|
| voxl, selkies | `server` |
| KasmVNC | `server`, `client` |
| Neko | `env`, `pipeline`, `x264` |

Ports, addresses and log paths stay in the adapters.

## Per-link values and notes

A setting can take another value on one link (`"links": {"wan": "{linkKbps}"}`, with `"linkWhy"`),
and a settings file can carry `notes` (`kind` `defect` or `note`). Both are flagged in the report: a
⚑ on the column and a note above that network's results, with the details under the stack's
configuration.

## In the report

A run with overrides says so at the top. The report's **Configuration under test** section lists,
per stack, its version, source, binary sha256, X server and x264 build, every setting with its
reason and any override marked against the file's value, and the exact command lines, environment
and viewer URL that were launched.
