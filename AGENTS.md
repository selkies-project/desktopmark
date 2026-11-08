# Working on this repository

DesktopMark is one container image that holds every stack under test, a shared viewer (Chromium driven by
Playwright) and the harness that measures them. Every stack is measured the same way, through its own web client, on
its own X server, against the X server's own pixels.

| Path | What it holds |
|---|---|
| `Dockerfile` | the image: one stage per stack, each fed by a build argument (`SELKIES_IMAGE`, `KASMVNC_DEB`/`KASMVNC_SHA256`, `NEKO_IMAGE`, `VOXL_REF`) |
| `nix/` | what the image takes from nix: voxl built from its own tree, the test apps, Chromium, Node.js and Python |
| `apps/` | `dmapp`, the X11 test windows (panels, wallpaper, text, animation, window actions), and `xgrab`, the X server readback |
| `content/` | the pages the desktop's Chromium shows in the scroll and wheel phases |
| `harness/run.mjs` | the runner: commands, options, sessions, pinning, scheduling, merge |
| `harness/scenarios.mjs` | the walkthrough: its phases, their order, the drag path, the benchmark's mode and links |
| `harness/stacks/` | one adapter per stack: how it is started, where its stream element is, the log line that proves its fast path |
| `harness/settings/` | every flag, variable and URL parameter each stack is given, with its shipped value and the reason for it |
| `harness/lib/` | shared mechanics: metrics, link shaping, processes and CPU, the desktop, settings resolution, PNG |
| `harness/page/measure.js` | the instrumentation injected into every viewer page |
| `harness/fidelity.py` | SSIM and PSNR against the X server's pixels |
| `harness/report.mjs`, `harness/report.html` | `report.md` and the HTML report, rendered from a results directory |
| `docs/` | the documentation, rendered by the Fumadocs site in `website/` |

## Documentation

The pages under `docs/` describe what the tree does now, not what an earlier revision did or what a change replaced.
They are plain Markdown that GitHub renders as well as the site does: a page links a sibling as `./page.md`, and
`docs/meta.json` orders the sidebar. A change to a command, an option, a phase, a metric or a rule updates its page
in the same change. `README.md` stays short: what this is, how to run it, and where a project's maintainers change
their version and settings.

## Fairness

These are what make the numbers comparable. A change that weakens one is not an improvement to the benchmark,
whatever it does to a column.

- Every stack runs on the X server it ships with, and that X server's CPU is counted. The fake vblank rate equals the
  test frame rate on all of them.
- A run whose stack fell back from its fast capture path is invalid, not slow: each adapter's `assertions` hold the log
  line that proves it.
- Stacks are configured to one shared envelope (software H.264, 4:2:0, no downscaling, the mode's frame rate, the
  bitrate ceiling from `ceilingKbps`), met with each stack's own rate control. Where two stacks expose the same knob it
  gets the same value. Each stack's encoder shape and paint-over timing are the product's and stay as they are.
- Settings live in `harness/settings/<stack>.json`, never in an adapter. Adapters keep only ports, addresses, log
  paths and what the harness needs to drive the stack. A setting that differs per link says so with `links` and
  `linkWhy`, and a known limitation of a stack is a `notes` entry, so the report flags both.
- Metrics are defined once, in `harness/lib/metrics.mjs`, `harness/page/measure.js` and `harness/fidelity.py`, and
  are the same for every stack. Nothing a stack draws locally, such as the cursor, is ever measured.
- The viewer, its flags, the desktop, the content, the input stream and the core budget are the same for every stack.
  A stack's own code is in its adapter and its settings file, never as a special case elsewhere.

## Testing

Build the image, with a local build of any stack in place of its release (see `docs/maintainers.md`):

```sh
docker build -t desktopmark:dev .
```

Then run, from the smallest check that reaches the change to the full benchmark:

```sh
alias dm='docker run --rm --cap-add NET_ADMIN --shm-size 2g -v "$PWD/out:/out" desktopmark:dev'
dm doctor                                  # every stack starts, streams at the mode, and keeps its fast path
dm run stacks=voxl-ws links=lan            # some columns, one link
dm run merge=latest stacks=voxl-ws         # re-measure columns into an earlier run
dm run                                     # the benchmark, about 20 minutes on a 16-core host
dm report /out/run-<time>                  # re-render a run with the current report code
```

A change to the report is checked by re-rendering an existing run before and after it and comparing the outputs.
A change to the docs is checked by building the site (`cd website && npm ci && npm run build`).

## Landing a change

A change is ready when four questions have answers, and the commit or pull request gives them to the reviewer:

1. What did the tree measure before the change? A run on the old image, or a report rendered from the old code, is
   that answer; an argument from the source is not.
2. What does it measure on the exact image being committed, through the commands a user runs?
3. Which columns can it affect, and which were run to know? A change to the harness, the desktop, the viewer or the
   metrics reaches every stack, so every stack is run, or the pull request names the ones that were not.
4. Is the change stripped to what makes it work? Every line the first two answers do not need is noise; drop it, or
   say why it stays.

A version or settings change for one stack comes with the run that shows it and, for a setting, a `why` that says
what it is for. Results under `out/` are never committed.

Commit subjects follow the selkies form: a type, an optional scope and an imperative sentence, such as
`fix(neko): Start the stream before the pointer moves` or `docs: Name the WAN link's buffer`.
