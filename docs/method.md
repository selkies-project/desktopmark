---
title: Method
description: The links, the desktop, the walkthrough, the metrics and the fairness rules.
---

## Links

- **LAN:** loopback, unshaped.
- **WAN:** a modest home connection. 10 Mbit/s down, 100 ms round trip, a 200 ms router buffer
  that drops packets when full, and 1500-byte packets. It tests congestion control and what quality
  each stack keeps when the link is the limit. A stack without congestion control meets the same
  full buffer as everyone else.

## The desktop

A top bar and a taskbar are docked across the full width, as real panels are, and reserve their
space. The top bar holds the colour reference: colour bars, a grey ramp, 1 px lines both ways and
coloured text on coloured backgrounds. The taskbar holds text: a start button, task buttons, a tray
and a fixed clock. Behind the windows is a dense wallpaper of 96 px tiles from a fixed seed: rings,
1 px lines, checkers, gradients, smooth noise and coloured text. It is the cleanup target, because a
drag or a window switch uncovers it.

## The walkthrough

One continuous session per stack, the way a person uses a desktop. Every window is opened once
before the clock starts. After that the phases run back to back, except the settle after each stop,
which is itself measured.

| Phase | What it does |
|---|---|
| `drag` | a text window dragged by its title bar along a fixed path over the other windows at 900 px/s, then let go; the uncovered wallpaper is measured as it sharpens |
| `typing` | keystrokes into an editor, 8/s |
| `scroll-narrow`, `scroll-medium`, `scroll` | a near-full-screen Chromium page scrolling a 680 px, 1280 px and full-width text column, each stop then settling |
| `switch` | windows brought to the front, maximised and restored, the big page restored over everything and minimised again, then the wallpaper settles |
| `wheel` | mouse-wheel scrolling through a long document, 6/s, then it settles |
| `region-256`, `region-640` | a widget-sized and a video-sized animation on an otherwise still desktop |
| `area-12`, `area-25`, `area-50`, `area-100` | the same animation on 1/8, 1/4, 1/2 and all of the work area |
| `idle` | a 2 Hz caret, then no changes: whatever a stack sends, cleanup included, is counted |
| `fidelity` | the two bars, the text and the wallpaper, read at the end of the stillness |

## Quality

Every score is against the X server's own pixels.

- **After each stop:** a 480×270 crop as fast as the readback allows (at most every 30 ms) for the
  first 500 ms, then every 100 ms to the end of the settle. Time to SSIM 0.98, SSIM and PSNR at the
  end, and a screenshot.
- **While something else moves:** during every animation phase the untouched text window is scored
  and photographed while the animation still runs.
- **Live:** eight 256 px slices of the two bars are read every 250 ms for the whole session and
  scored against one X server grab taken before the clock starts (`gauge=0` turns it off). A stack
  that re-sends the whole frame when busy dips while other things move. `selftest` reports the
  gauge's own cost per stack.

## Metrics

| Metric | How it's measured |
|---|---|
| Frames or positions shown per second | distinct values read from the stream element on each presented frame (`requestVideoFrameCallback`, or `requestAnimationFrame` for a canvas) |
| Draw→screen latency | the content stamps a millisecond timestamp into its pixels; latency runs until the page shows it |
| Input→screen latency | from Playwright's input event to the first frame showing the content's response, never the cursor |
| Bandwidth | bytes delivered to the viewer per 100 ms: mean, peak 100 ms, p95 1 s |
| Server CPU | every process of the stack, X server included |
| Client CPU | the viewer's Chromium processes |
| Fidelity | SSIM (mean of R, G and B, 8×8 windows) and PSNR over R, G and B, so no stack's colour matrix is favoured |

Every cell is the median over reps.

## Fairness rules

- **Its own X server.** voxl runs its patched Xvfb with `-shmem`, selkies XLibre Xvfb, KasmVNC
  `Xkasmvnc` and Neko Xorg with its patched dummy driver. The X server's CPU is counted, and the
  fake vblank rate equals the test frame rate on all of them.
- **Capture path asserted.** Each run checks the stack's log for its fast capture path. A run that
  fell back is reported as invalid, not as slow.
- **One matched configuration per stack:** software H.264, 4:2:0, no downscaling, resolution
  locked, the mode's frame rate and a bitrate ceiling of 30 Mbit/s at 1440p60, met as well as each
  stack allows with its own rate control. Where two stacks expose the same knob it gets the same
  value. Each stack's encoder shape and paint-over timing are part of the product and are left as
  they are.
- **Same inputs and environment:** the same viewer flags, a fresh browser profile and `$HOME` per
  run, no `CAP_SYS_NICE`, audio off, no public STUN/TURN or IP lookups, the stack restarted every
  rep and the order randomized.

## Known limits

- **The viewer presents at most 60 Hz.** Chromium without a GPU presents `<video>` at most 60 times
  a second, so frames shown above 60 fps are capped for every stack.
- **Canvas clients** (KasmVNC) are sampled once per paint, by wrapping the canvas's drawing calls.
- **KasmVNC has no bitrate cap**, only CRF. `calibrate` picks the lowest CRF whose p95 one-second
  rate on the page scroll stays under the ceiling. `run` uses `/out/kasm-crf.json` when present,
  otherwise the table baked into the image.
