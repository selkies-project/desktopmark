---
title: Running
description: Commands, options and the results a run produces.
---

## Requirements

- x86-64 with AVX2 and at least 4 cores. 12 or more physical cores give the cleanest numbers.
- Docker, and `CAP_NET_ADMIN` for the container (`--cap-add NET_ADMIN`). The delivered-bandwidth
  counters and the WAN link use `tc` and `ip` on loopback. Without it those cells are blank and only
  the LAN runs.
- An output directory writable by uid 1000, the user the image runs as.

The stack under test is pinned to 8 physical cores on hosts with 12 or more, 6 on hosts with 8 to
11 (`stackcores=` overrides), and the browser and harness to the rest. On smaller hosts nothing is
pinned, and `meta.json` says so.

## Commands

```sh
alias desktopmark='docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" ghcr.io/selkies-project/desktopmark'

desktopmark run                               # the benchmark
desktopmark run stacks=selkies-ws,voxl-ws     # some of the stacks
desktopmark doctor                            # runtime checks for every stack
desktopmark calibrate                         # KasmVNC CRF under the bitrate ceiling -> /out/kasm-crf.json
desktopmark selftest                          # the live quality gauge's cost per stack
desktopmark preview                           # only the walkthrough video
desktopmark report /out/run-<time>            # re-render a run's report
```

The benchmark is the walkthrough at 2560×1440, 60 fps, on LAN and on WAN, for every stack, one rep
with 4 s phases. It takes about 20 minutes on a 16-core host.

## Options

Options are `key=value` arguments, or `DM_<KEY>` environment variables.

| Option | Default | Meaning |
|---|---|---|
| `stacks` | all | columns to run, comma separated |
| `links` | `lan,wan` | links to run |
| `scenarios` | all | walkthrough phases to run |
| `reps` | `1` | repetitions; every cell is the median |
| `secs` | `4` | length of each phase in seconds |
| `settle` | `2000` | settle after each stop, in ms |
| `gap` | `10` | seconds with nothing running between sessions |
| `extras` | `0` | `1` adds the labelled extra rows |
| `preview` | `1` | `0` skips the walkthrough video |
| `gauge` | `1` | `0` turns off the live quality gauge |
| `pin` | `1` | `0` turns off core pinning |
| `stackcores` | 8 or 6 | physical cores for the stack |
| `label` | | a name for the run, shown in the report |
| `merge` | | a run folder or `latest`, see below |
| `set.<target>.<key>` | | a stack setting, see [Stack Settings](./settings.md) |
| `settings` | | a JSON file of stack settings |

## Re-measuring part of a run

`merge=` re-measures some columns and updates an earlier run in place:

```sh
desktopmark run merge=latest stacks=neko-rtc links=wan
desktopmark run merge=run-2026-11-07T16-19-27 stacks=voxl-ws set.voxl.crf=22
```

Only those sessions run, and they replace the run's matching records, logs and screenshots
(`results.jsonl` is backed up first). Their settings in `meta.json` are updated and the full report
is re-rendered. Reps, phase length and settle default to the run's own values. The report says which
data points were re-measured, when, with what overrides, and whether the binary differs.

## Results

Each run writes `/out/run-<time>/`:

| File | Contents |
|---|---|
| `report.html` | the report: session cost, headline tables, bandwidth per phase, session timeline, sharpening curves, screenshots against the X server's pixels, and the configuration under test |
| `report.md` | the same tables as text |
| `walkthrough.mp4` | the walkthrough recorded once on a bare X server, shown at the top of the report |
| `results.jsonl` | one record per scenario per rep, and each session's timeline |
| `shots/` | lossless screenshots from the first rep |
| `meta.json` | host, versions, every column's resolved settings, overrides, the schedule |
| `logs/` | every process's output and the page console |
