#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xatom.h>
#include <X11/Xft/Xft.h>
#include <X11/extensions/XTest.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef DM_FONT_SANS
#define DM_FONT_SANS "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
#endif
#ifndef DM_FONT_MONO
#define DM_FONT_MONO "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
#endif

enum { CELL = 16, MCOLS = 10, MROWS = 4, MW = CELL * MCOLS, MH = CELL * MROWS };

static Display *dpy;
static int scr;
static Window root;

static struct { int x, y, w, h, secs; double fps; const char *title, *edge; } opt = {
    0, 0, 640, 360, 0, 60.0, "dm-window", "top"};

static double mono_now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

static uint32_t real_ms24(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return (uint32_t)(((uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000) & 0xffffff);
}

static void sleep_until(double t) {
  struct timespec ts = {(time_t)t, (long)((t - (time_t)t) * 1e9)};
  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL);
}

static unsigned long rgb(int r, int g, int b) {
  XColor c = {.red = r * 257, .green = g * 257, .blue = b * 257, .flags = DoRed | DoGreen | DoBlue};
  XAllocColor(dpy, DefaultColormap(dpy, scr), &c);
  return c.pixel;
}

static void marker_into(uint32_t *buf, int stride, int ox, int oy, uint32_t counter) {
  uint64_t v = ((uint64_t)(counter & 0xffff) << 24) | real_ms24();
  for (int b = 0; b < 40; b++) {
    uint32_t px = ((v >> b) & 1) ? 0xffffffff : 0xff000000;
    int bx = ox + (b % MCOLS) * CELL, by = oy + (b / MCOLS) * CELL;
    for (int y = by; y < by + CELL; y++)
      for (int x = bx; x < bx + CELL; x++) buf[(size_t)y * stride + x] = px;
  }
}

static Window make_window(int managed, unsigned long bg) {
  XSetWindowAttributes a = {.background_pixel = bg, .override_redirect = !managed,
                            .event_mask = ExposureMask | KeyPressMask | ButtonPressMask |
                                          (managed ? StructureNotifyMask : 0)};
  Window w = XCreateWindow(dpy, root, opt.x, opt.y, opt.w, opt.h, 0, CopyFromParent, InputOutput,
                           CopyFromParent, CWBackPixel | CWOverrideRedirect | CWEventMask, &a);
  if (managed) {
    XSizeHints *sh = XAllocSizeHints();
    sh->flags = USPosition | USSize | PPosition | PSize;
    sh->x = opt.x, sh->y = opt.y, sh->width = opt.w, sh->height = opt.h;
    XSetWMNormalHints(dpy, w, sh);
    XFree(sh);
    XStoreName(dpy, w, opt.title);
  }
  XMapRaised(dpy, w);
  XSync(dpy, False);
  return w;
}

static XftFont *font(const char *file, double px) {
  return XftFontOpen(dpy, scr, XFT_FILE, XftTypeString, file, XFT_PIXEL_SIZE, XftTypeDouble, px,
                     XFT_ANTIALIAS, XftTypeBool, True, NULL);
}

static XftColor xftcolor(int r, int g, int b) {
  XRenderColor rc = {r * 257, g * 257, b * 257, 0xffff};
  XftColor c;
  XftColorAllocValue(dpy, DefaultVisual(dpy, scr), DefaultColormap(dpy, scr), &rc, &c);
  return c;
}

static const char *WORDS[] = {"desktop", "stream", "window", "frame", "latency", "encoder", "pixel",
                              "the", "of", "and", "a", "to", "in", "is", "that", "for", "browser",
                              "render", "scroll", "text", "chroma", "motion", "vector", "packet",
                              "glyph", "kernel", "buffer", "cursor", "display", "codec"};
static void line_text(char *out, int n, unsigned line) {
  unsigned s = line * 2654435761u + 12345;
  int len = 0;
  out[0] = 0;
  while (len < n - 12) {
    s = s * 1103515245u + 12345;
    const char *wd = WORDS[(s >> 16) % (sizeof WORDS / sizeof *WORDS)];
    len += snprintf(out + len, n - len, "%s ", wd);
  }
}

static uint32_t wseed;
static uint32_t wrand(void) { wseed ^= wseed << 13, wseed ^= wseed >> 17, wseed ^= wseed << 5; return wseed; }
static int clamp8(double v) { return v < 0 ? 0 : v > 255 ? 255 : (int)v; }
static double lattice(int x, int y) { uint32_t h = (uint32_t)x * 374761393u + (uint32_t)y * 668265263u; h = (h ^ (h >> 13)) * 1274126177u; return (h >> 8 & 0xffff) / 65535.0; }
static double vnoise(double x, double y) {
  int ix = (int)x, iy = (int)y;
  double fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  double a = lattice(ix, iy), b = lattice(ix + 1, iy), c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
enum { TILE = 96 };
static int run_wallpaper(void) {
  int W = DisplayWidth(dpy, scr), H = DisplayHeight(dpy, scr), tx = (W + TILE - 1) / TILE, ty = (H + TILE - 1) / TILE;
  Pixmap pm = XCreatePixmap(dpy, root, W, H, DefaultDepth(dpy, scr));
  XImage *img = XCreateImage(dpy, DefaultVisual(dpy, scr), 24, ZPixmap, 0, malloc((size_t)W * H * 4), W, H, 32, 0);
  uint32_t *px = (uint32_t *)img->data;
  int *kind = malloc(sizeof(int) * tx * ty), (*col)[6] = malloc(sizeof(int[6]) * tx * ty);
  wseed = 20261107u;
  for (int i = 0; i < tx * ty; i++) {
    kind[i] = wrand() % 7;
    for (int k = 0; k < 6; k++) col[i][k] = 30 + wrand() % 200;
  }
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++) {
      int i = (y / TILE) * tx + x / TILE, lx = x % TILE, ly = y % TILE, *c = col[i];
      double u = lx / (double)TILE, v = ly / (double)TILE, t;
      int r, g, b;
      switch (kind[i]) {
      case 0:
        t = 0.5 + 0.5 * sin((lx * lx + ly * ly) * 0.012);
        r = clamp8(c[0] * t + c[3] * (1 - t)), g = clamp8(c[1] * t + c[4] * (1 - t)), b = clamp8(c[2] * t + c[5] * (1 - t));
        break;
      case 1:
        t = ((lx + ly) % 3 == 0);
        r = t ? c[0] : 240, g = t ? c[1] : 240, b = t ? c[2] : 236;
        break;
      case 2:
        t = ((lx / 2 + ly / 2) & 1);
        r = t ? c[0] : c[3], g = t ? c[1] : c[4], b = t ? c[2] : c[5];
        break;
      case 3:
        t = (u + v) / 2;
        r = clamp8(c[0] + (c[3] - c[0]) * t), g = clamp8(c[1] + (c[4] - c[1]) * t), b = clamp8(c[2] + (c[5] - c[2]) * t);
        break;
      case 4:
        t = vnoise(x / 16.0, y / 16.0) * 0.65 + vnoise(x / 4.0, y / 4.0) * 0.35;
        r = clamp8(c[0] * t * 1.4), g = clamp8(c[1] * t * 1.4), b = clamp8(c[2] * t * 1.4);
        break;
      case 5:
        t = (lx & 1);
        r = t ? clamp8(c[0] * (0.6 + 0.4 * v)) : 20, g = t ? clamp8(c[1] * (0.6 + 0.4 * u)) : 20, b = t ? c[2] : 30;
        break;
      default:
        r = c[3] / 2 + 100, g = c[4] / 2 + 100, b = c[5] / 2 + 100;
      }
      if (lx == 0 || ly == 0) r = g = b = 16;
      if (r > 180 && g > 70 && g < 210 && b < 110) b = 150;
      px[(size_t)y * W + x] = 0xff000000u | (uint32_t)r << 16 | (uint32_t)g << 8 | (uint32_t)b;
    }
  GC gc = XCreateGC(dpy, pm, 0, NULL);
  XPutImage(dpy, pm, gc, img, 0, 0, 0, 0, W, H);
  XftDraw *d = XftDrawCreate(dpy, pm, DefaultVisual(dpy, scr), DefaultColormap(dpy, scr));
  XftFont *fs[3] = {font(DM_FONT_SANS, 11), font(DM_FONT_SANS, 14), font(DM_FONT_MONO, 12)};
  char line[512];
  for (int i = 0; i < tx * ty; i++) {
    if (kind[i] != 6) continue;
    int x0 = (i % tx) * TILE, y0 = (i / tx) * TILE, *c = col[i];
    XftColor ink = xftcolor(c[0] / 3, c[1] / 3, c[2] / 3);
    XftFont *f = fs[i % 3];
    int lh = f->ascent + f->descent + 1;
    for (int k = 0, y = y0 + 4 + f->ascent; y + f->descent < y0 + TILE; k++, y += lh) {
      line_text(line, 40, (unsigned)(i * 7 + k));
      XRectangle clip = {(short)(x0 + 1), (short)(y0 + 1), TILE - 2, TILE - 2};
      XftDrawSetClipRectangles(d, 0, 0, &clip, 1);
      XftDrawStringUtf8(d, &ink, f, x0 + 4, y, (const FcChar8 *)line, (int)strlen(line));
    }
  }
  XSetWindowBackgroundPixmap(dpy, root, pm);
  XClearWindow(dpy, root);
  XSetCloseDownMode(dpy, RetainPermanent);
  XSync(dpy, False);
  return 0;
}

static void set_atoms(Window w, const char *prop, const char *const *vals, int n) {
  Atom a[8];
  for (int i = 0; i < n; i++) a[i] = XInternAtom(dpy, vals[i], False);
  XChangeProperty(dpy, w, XInternAtom(dpy, prop, False), XA_ATOM, 32, PropModeReplace, (unsigned char *)a, n);
}
static void draw_top_panel(Window w, XftDraw *d, GC gc, int W, int H) {
  static const int bars[8][3] = {{255, 255, 255}, {255, 255, 0}, {0, 255, 255}, {0, 255, 0},
                                 {255, 0, 255},   {255, 0, 0},   {0, 0, 255},   {0, 0, 0}};
  static const int pairs[4][6] = {{255, 0, 0, 0, 0, 255}, {0, 0, 255, 255, 0, 0}, {0, 128, 0, 255, 0, 255}, {255, 255, 0, 0, 0, 255}};
  int cw = W / 8;
  for (int i = 0; i < 8; i++) { XSetForeground(dpy, gc, rgb(bars[i][0], bars[i][1], bars[i][2])); XFillRectangle(dpy, w, gc, i * cw / 8, 0, cw / 8 + 1, H); }
  for (int x = 0; x < cw; x++) { int v = 255 * x / (cw - 1); XSetForeground(dpy, gc, rgb(v, v, v)); XDrawLine(dpy, w, gc, cw + x, 0, cw + x, H); }
  for (int y = 0; y < H; y++) { XSetForeground(dpy, gc, (y & 1) ? rgb(0, 0, 0) : rgb(255, 255, 255)); XDrawLine(dpy, w, gc, 2 * cw, y, 3 * cw - 1, y); }
  for (int x = 3 * cw; x < 4 * cw; x++) { XSetForeground(dpy, gc, (x & 1) ? rgb(0, 0, 0) : rgb(255, 255, 255)); XDrawLine(dpy, w, gc, x, 0, x, H); }
  char line[512];
  for (int i = 0; i < 4; i++) {
    int x0 = (4 + i) * cw, cwi = i == 3 ? W - x0 : cw;
    XSetForeground(dpy, gc, rgb(pairs[i][3], pairs[i][4], pairs[i][5]));
    XFillRectangle(dpy, w, gc, x0, 0, cwi, H);
    XftColor c = xftcolor(pairs[i][0], pairs[i][1], pairs[i][2]);
    XftFont *f = font(DM_FONT_SANS, 10 + i * 2);
    XRectangle clip = {(short)x0, 0, (unsigned short)cwi, (unsigned short)H};
    XftDrawSetClipRectangles(d, 0, 0, &clip, 1);
    int lh = f->ascent + f->descent;
    for (int k = 0, y = 2 + f->ascent; y + f->descent <= H; k++, y += lh) {
      line_text(line, 120, 2000 + i * 10 + k);
      XftDrawStringUtf8(d, &c, f, x0 + 4, y, (const FcChar8 *)line, (int)strlen(line));
    }
    XftFontClose(dpy, f);
  }
  XftDrawSetClip(d, 0);
}
static void draw_bottom_panel(Window w, XftDraw *d, GC gc, int W, int H) {
  XSetForeground(dpy, gc, rgb(34, 36, 42));
  XFillRectangle(dpy, w, gc, 0, 0, W, H);
  XftFont *f = font(DM_FONT_SANS, H / 3.4), *fs = font(DM_FONT_SANS, H / 4.4), *fm = font(DM_FONT_MONO, H / 3.6);
  XftColor light = xftcolor(235, 235, 235), dim = xftcolor(170, 175, 185), dark = xftcolor(20, 20, 24);
  XSetForeground(dpy, gc, rgb(42, 120, 214));
  XFillRectangle(dpy, w, gc, 6, 6, H * 2, H - 12);
  XftDrawStringUtf8(d, &light, f, 16, H / 2 + f->ascent / 2 - 2, (const FcChar8 *)"Start", 5);
  static const char *tasks[] = {"dm-doc: report draft.txt", "dm-edit: notes", "Terminal: ~/src/desktop", "Browser: stream latency",
                                "Mail: Inbox (3)", "Files: /home/bench/pixels", "Music: paused", "Settings: display"};
  int tw = (W * 3 / 4 - H * 2 - 24) / 8, x = H * 2 + 18;
  char line[256];
  for (int i = 0; i < 8; i++, x += tw) {
    int on = i == 1;
    XSetForeground(dpy, gc, on ? rgb(220, 224, 232) : rgb(56, 60, 70));
    XFillRectangle(dpy, w, gc, x, 6, tw - 6, H - 12);
    XRectangle clip = {(short)(x + 2), 0, (unsigned short)(tw - 10), (unsigned short)H};
    XftDrawSetClipRectangles(d, 0, 0, &clip, 1);
    XftDrawStringUtf8(d, on ? &dark : &light, f, x + 8, H / 2 + f->ascent / 2 - 2, (const FcChar8 *)tasks[i], (int)strlen(tasks[i]));
  }
  XftDrawSetClip(d, 0);
  int tx0 = W * 3 / 4 + 8, tcw = (W - tx0 - H * 3) / 3;
  for (int c = 0; c < 3; c++)
    for (int r = 0; r < 2; r++) {
      line_text(line, 40, 3000 + c * 2 + r);
      XRectangle clip = {(short)(tx0 + c * tcw), 0, (unsigned short)(tcw - 6), (unsigned short)H};
      XftDrawSetClipRectangles(d, 0, 0, &clip, 1);
      XftDrawStringUtf8(d, r ? &dim : &light, fs, tx0 + c * tcw, (r + 1) * H / 2 - 6, (const FcChar8 *)line, (int)strlen(line));
    }
  XftDrawSetClip(d, 0);
  XftDrawStringUtf8(d, &light, fm, W - H * 3 + 12, H / 2 - 2, (const FcChar8 *)"12:34", 5);
  XftDrawStringUtf8(d, &dim, fs, W - H * 3 + 12, H - 8, (const FcChar8 *)"2026-11-07", 10);
  XftFontClose(dpy, f), XftFontClose(dpy, fs), XftFontClose(dpy, fm);
}
static int run_panel(void) {
  int W = DisplayWidth(dpy, scr), Hs = DisplayHeight(dpy, scr), H = opt.h, top = strcmp(opt.edge, "bottom") != 0;
  opt.x = 0, opt.y = top ? 0 : Hs - H, opt.w = W;
  XSetWindowAttributes a = {.background_pixel = rgb(128, 128, 128), .event_mask = ExposureMask};
  Window w = XCreateWindow(dpy, root, opt.x, opt.y, W, H, 0, CopyFromParent, InputOutput, CopyFromParent, CWBackPixel | CWEventMask, &a);
  XStoreName(dpy, w, top ? "dm-topbar" : "dm-taskbar");
  const char *type[] = {"_NET_WM_WINDOW_TYPE_DOCK"}, *state[] = {"_NET_WM_STATE_ABOVE", "_NET_WM_STATE_STICKY"};
  set_atoms(w, "_NET_WM_WINDOW_TYPE", type, 1);
  set_atoms(w, "_NET_WM_STATE", state, 2);
  long strut[12] = {0};
  if (top) strut[2] = H, strut[8] = 0, strut[9] = W - 1;
  else strut[3] = H, strut[10] = 0, strut[11] = W - 1;
  XChangeProperty(dpy, w, XInternAtom(dpy, "_NET_WM_STRUT_PARTIAL", False), XA_CARDINAL, 32, PropModeReplace, (unsigned char *)strut, 12);
  XChangeProperty(dpy, w, XInternAtom(dpy, "_NET_WM_STRUT", False), XA_CARDINAL, 32, PropModeReplace, (unsigned char *)strut, 4);
  XSizeHints *sh = XAllocSizeHints();
  sh->flags = USPosition | USSize | PMinSize | PMaxSize;
  sh->x = opt.x, sh->y = opt.y, sh->width = sh->min_width = sh->max_width = W, sh->height = sh->min_height = sh->max_height = H;
  XSetWMNormalHints(dpy, w, sh);
  XFree(sh);
  XWMHints wh = {.flags = InputHint, .input = False};
  XSetWMHints(dpy, w, &wh);
  XMapRaised(dpy, w);
  XftDraw *d = XftDrawCreate(dpy, w, DefaultVisual(dpy, scr), DefaultColormap(dpy, scr));
  GC gc = XCreateGC(dpy, w, 0, NULL);
  for (;;) {
    XEvent e;
    XNextEvent(dpy, &e);
    if (e.type == Expose && e.xexpose.count == 0) { (top ? draw_top_panel : draw_bottom_panel)(w, d, gc, W, H); XSync(dpy, False); }
  }
}

typedef void (*painter)(uint32_t *buf, int w, int h, long f);

static void paint_anim(uint32_t *buf, int w, int h, long f) {
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      int band = ((x + (int)f * 4) / 24) & 7;
      uint32_t c = 0xff000000u | (40 + band * 20) << 16 | (90 + ((y + (int)f * 2) & 63)) << 8 | 160;
      buf[(size_t)y * w + x] = c;
    }
  int bs = h / 3, bx = (int)((f * 6) % (w > bs ? w - bs : 1)), by = h - bs - 4;
  for (int y = by; y < by + bs; y++)
    for (int x = bx; x < bx + bs && x < w; x++) buf[(size_t)y * w + x] = 0xffe04848;
}

static uint32_t xs = 2463534242u;
static void paint_noise(uint32_t *buf, int w, int h, long f) {
  (void)f;
  for (size_t i = 0; i < (size_t)w * h; i++) {
    xs ^= xs << 13, xs ^= xs >> 17, xs ^= xs << 5;
    buf[i] = 0xff000000u | (xs & 0xffffff);
  }
}

static void paint_none(uint32_t *buf, int w, int h, long f) {
  (void)buf, (void)w, (void)h, (void)f;
}

static int run_paced(painter paint, int w, int h) {
  opt.w = w, opt.h = h;
  Window win = make_window(0, BlackPixel(dpy, scr));
  GC gc = XCreateGC(dpy, win, 0, NULL);
  XImage *img = XCreateImage(dpy, DefaultVisual(dpy, scr), 24, ZPixmap, 0,
                             calloc((size_t)w * h, 4), w, h, 32, 0);
  uint32_t *buf = (uint32_t *)img->data;
  double t0 = mono_now(), period = 1.0 / opt.fps;
  long f = 0;
  for (;;) {
    double due = t0 + f * period;
    if (opt.secs && due - t0 >= opt.secs) break;
    sleep_until(due);
    paint(buf, w, h, f);
    marker_into(buf, w, 0, 0, (uint32_t)f);
    XPutImage(dpy, win, gc, img, 0, 0, 0, 0, w, h);
    XSync(dpy, False);
    f++;
  }
  return 0;
}

static void draw_doc(Window w, XftDraw *d, XftFont *f, unsigned long band) {
  GC gc = XCreateGC(dpy, w, 0, NULL);
  XSetForeground(dpy, gc, band);
  XFillRectangle(dpy, w, gc, 0, 0, opt.w, 12);
  XFillRectangle(dpy, w, gc, 0, 0, 12, opt.h);
  XFreeGC(dpy, gc);
  XftColor ink[3] = {xftcolor(20, 20, 20), xftcolor(30, 60, 160), xftcolor(150, 30, 30)};
  char line[512];
  int lh = f->ascent + f->descent + 2;
  for (int i = 0, y = 12 + f->ascent + 6; y < opt.h; i++, y += lh) {
    line_text(line, sizeof line, (unsigned)i);
    XftDrawStringUtf8(d, &ink[i % 7 == 3 ? 1 : i % 11 == 5 ? 2 : 0], f, 20, y, (const FcChar8 *)line,
                      (int)strlen(line));
  }
}

static int run_doc(void) {
  Window w = make_window(1, rgb(250, 250, 248));
  XftDraw *d = XftDrawCreate(dpy, w, DefaultVisual(dpy, scr), DefaultColormap(dpy, scr));
  XftFont *f = font(DM_FONT_SANS, 14);
  unsigned long band = rgb(255, 140, 0);
  double t0 = mono_now();
  for (;;) {
    while (XPending(dpy)) {
      XEvent e;
      XNextEvent(dpy, &e);
      if (e.type == ConfigureNotify) opt.w = e.xconfigure.width, opt.h = e.xconfigure.height;
      else if (e.type == Expose && e.xexpose.count == 0) draw_doc(w, d, f, band);
    }
    if (opt.secs && mono_now() - t0 >= opt.secs) return 0;
    struct timespec ts = {0, 5000000};
    nanosleep(&ts, NULL);
  }
}

static int run_edit(void) {
  Window w = make_window(1, rgb(255, 255, 255));
  XftDraw *d = XftDrawCreate(dpy, w, DefaultVisual(dpy, scr), DefaultColormap(dpy, scr));
  XftFont *f = font(DM_FONT_MONO, 18);
  XftColor ink = xftcolor(10, 10, 10);
  GC gc = XCreateGC(dpy, w, 0, NULL);
  XImage *mk = XCreateImage(dpy, DefaultVisual(dpy, scr), 24, ZPixmap, 0, calloc(MW * MH, 4), MW,
                            MH, 32, 0);
  char text[4096] = {0};
  int n = 0;
  uint32_t presses = 0;
  XGlyphInfo gi;
  XftTextExtentsUtf8(dpy, f, (const FcChar8 *)"M", 1, &gi);
  int cw = gi.xOff, lh = f->ascent + f->descent + 4, cols = (opt.w - 16) / cw;
  marker_into((uint32_t *)mk->data, MW, 0, 0, 0);
  XPutImage(dpy, w, gc, mk, 0, 0, 0, 0, MW, MH);
  XSync(dpy, False);
  for (;;) {
    XEvent e;
    XNextEvent(dpy, &e);
    if (e.type == Expose && e.xexpose.count == 0) {
      XPutImage(dpy, w, gc, mk, 0, 0, 0, 0, MW, MH);
      for (int i = 0; i < n; i++)
        XftDrawStringUtf8(d, &ink, f, 8 + (i % cols) * cw, MH + 8 + f->ascent + (i / cols) * lh,
                          (const FcChar8 *)&text[i], 1);
    } else if (e.type == KeyPress) {
      char ch[8];
      KeySym ks;
      int len = XLookupString(&e.xkey, ch, sizeof ch, &ks, NULL);
      if (len != 1 || ch[0] < 32 || n >= (int)sizeof text - 1) continue;
      text[n] = ch[0];
      XftDrawStringUtf8(d, &ink, f, 8 + (n % cols) * cw, MH + 8 + f->ascent + (n / cols) * lh,
                        (const FcChar8 *)&text[n], 1);
      n++;
      marker_into((uint32_t *)mk->data, MW, 0, 0, ++presses);
      XPutImage(dpy, w, gc, mk, 0, 0, 0, 0, MW, MH);
      XSync(dpy, False);
    }
  }
}

static void draw_chart(Window w, XftDraw *d, GC gc) {
  static const int bars[8][3] = {{255, 255, 255}, {255, 255, 0}, {0, 255, 255}, {0, 255, 0},
                                 {255, 0, 255},   {255, 0, 0},   {0, 0, 255},   {0, 0, 0}};
  static const int pairs[6][6] = {{255, 0, 0, 0, 0, 255},   {0, 0, 255, 255, 0, 0},
                                  {0, 128, 0, 255, 0, 255}, {255, 255, 0, 0, 0, 255},
                                  {0, 0, 0, 255, 255, 255}, {255, 255, 255, 0, 0, 0}};
  int bw = opt.w / 8;
  for (int i = 0; i < 8; i++) {
    XSetForeground(dpy, gc, rgb(bars[i][0], bars[i][1], bars[i][2]));
    XFillRectangle(dpy, w, gc, i * bw, 0, bw, opt.h / 5);
  }
  int ry = opt.h / 5, rh = opt.h / 10;
  for (int x = 0; x < opt.w; x++) {
    int v = 255 * x / (opt.w - 1);
    XSetForeground(dpy, gc, rgb(v, v, v));
    XDrawLine(dpy, w, gc, x, ry, x, ry + rh);
  }
  int ly = ry + rh, lh = opt.h / 10;
  for (int y = ly; y < ly + lh; y++) {
    XSetForeground(dpy, gc, (y & 1) ? rgb(0, 0, 0) : rgb(255, 255, 255));
    XDrawLine(dpy, w, gc, 0, y, opt.w / 2, y);
  }
  for (int x = opt.w / 2; x < opt.w; x++) {
    XSetForeground(dpy, gc, (x & 1) ? rgb(0, 0, 0) : rgb(255, 255, 255));
    XDrawLine(dpy, w, gc, x, ly, x, ly + lh);
  }
  int ty = ly + lh, th = (opt.h - ty) / 6;
  for (int i = 0; i < 6; i++) {
    XSetForeground(dpy, gc, rgb(pairs[i][3], pairs[i][4], pairs[i][5]));
    XFillRectangle(dpy, w, gc, 0, ty + i * th, opt.w, th);
    XftColor c = xftcolor(pairs[i][0], pairs[i][1], pairs[i][2]);
    XftFont *f = font(DM_FONT_SANS, 9 + i * 2);
    char line[512];
    line_text(line, sizeof line, 1000 + i);
    XftDrawStringUtf8(d, &c, f, 6, ty + i * th + th / 2 + f->ascent / 2, (const FcChar8 *)line,
                      (int)strlen(line));
    XftFontClose(dpy, f);
  }
  XSync(dpy, False);
}

static int run_chart(void) {
  Window w = make_window(1, rgb(128, 128, 128));
  XftDraw *d = XftDrawCreate(dpy, w, DefaultVisual(dpy, scr), DefaultColormap(dpy, scr));
  GC gc = XCreateGC(dpy, w, 0, NULL);
  draw_chart(w, d, gc);
  for (;;) {
    XEvent e;
    XNextEvent(dpy, &e);
    if (e.type == ConfigureNotify) opt.w = e.xconfigure.width, opt.h = e.xconfigure.height;
    else if (e.type == Expose && e.xexpose.count == 0) draw_chart(w, d, gc);
  }
}

static int run_input(void) {
  char line[64];
  while (fgets(line, sizeof line, stdin)) {
    int x, y, n;
    if (sscanf(line, "m %d %d", &x, &y) == 2) XTestFakeMotionEvent(dpy, scr, x, y, CurrentTime);
    else if (line[0] == 'd') XTestFakeButtonEvent(dpy, 1, True, CurrentTime);
    else if (line[0] == 'u') XTestFakeButtonEvent(dpy, 1, False, CurrentTime);
    else if (line[0] == 'k' && line[1] == ' ' && line[2] >= 32) {
      KeyCode kc = XKeysymToKeycode(dpy, (KeySym)(unsigned char)line[2]);
      if (kc) XTestFakeKeyEvent(dpy, kc, True, CurrentTime), XTestFakeKeyEvent(dpy, kc, False, CurrentTime);
    } else if (sscanf(line, "w %d", &n) == 1)
      for (int i = 0; i < (n < 0 ? -n : n); i++)
        XTestFakeButtonEvent(dpy, n < 0 ? 4 : 5, True, CurrentTime), XTestFakeButtonEvent(dpy, n < 0 ? 4 : 5, False, CurrentTime);
    XFlush(dpy);
  }
  return 0;
}

static int titled(Window w, const char *title) {
  Atom type;
  int fmt, hit = 0;
  unsigned long n, after;
  unsigned char *v = NULL;
  if (XGetWindowProperty(dpy, w, XInternAtom(dpy, "_NET_WM_NAME", False), 0, 1024, False,
                         XInternAtom(dpy, "UTF8_STRING", False), &type, &fmt, &n, &after, &v) == Success && v) {
    hit = !strcmp((char *)v, title);
    XFree(v);
    if (hit) return 1;
  }
  char *name = NULL;
  if (XFetchName(dpy, w, &name) && name) {
    hit = !strcmp(name, title);
    XFree(name);
  }
  return hit;
}

static Window find_titled(Window w, const char *title) {
  if (titled(w, title)) return w;
  Window r, p, *kids = NULL;
  unsigned n = 0;
  Window found = 0;
  if (XQueryTree(dpy, w, &r, &p, &kids, &n)) {
    for (unsigned i = 0; i < n && !found; i++) found = find_titled(kids[i], title);
    if (kids) XFree(kids);
  }
  return found;
}

static int wm_message(const char *type, long l0, long l1, long l2, long l3) {
  Window w = find_titled(root, opt.title);
  if (!w) { fprintf(stderr, "dmapp: no window titled %s\n", opt.title); return 1; }
  XEvent e = {0};
  e.xclient.type = ClientMessage;
  e.xclient.window = w;
  e.xclient.message_type = XInternAtom(dpy, type, False);
  e.xclient.format = 32;
  e.xclient.data.l[0] = l0, e.xclient.data.l[1] = l1, e.xclient.data.l[2] = l2, e.xclient.data.l[3] = l3;
  XSendEvent(dpy, root, False, SubstructureRedirectMask | SubstructureNotifyMask, &e);
  XSync(dpy, False);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: dmapp wallpaper|panel|marker|anim|noise|doc|edit|chart|activate|maximize|minimize|input [--x --y --w --h --fps --secs --title --edge]\n");
    return 2;
  }
  for (int i = 2; i + 1 < argc; i += 2) {
    const char *k = argv[i], *v = argv[i + 1];
    if (!strcmp(k, "--x")) opt.x = atoi(v);
    else if (!strcmp(k, "--y")) opt.y = atoi(v);
    else if (!strcmp(k, "--w")) opt.w = atoi(v);
    else if (!strcmp(k, "--h")) opt.h = atoi(v);
    else if (!strcmp(k, "--fps")) opt.fps = atof(v);
    else if (!strcmp(k, "--secs")) opt.secs = atoi(v);
    else if (!strcmp(k, "--title")) opt.title = v;
    else if (!strcmp(k, "--edge")) opt.edge = v;
    else { fprintf(stderr, "unknown option %s\n", k); return 2; }
  }
  dpy = XOpenDisplay(NULL);
  if (!dpy) { fprintf(stderr, "dmapp: cannot open display\n"); return 1; }
  scr = DefaultScreen(dpy);
  root = RootWindow(dpy, scr);
  const char *m = argv[1];
  if (!strcmp(m, "wallpaper")) return run_wallpaper();
  if (!strcmp(m, "marker")) return run_paced(paint_none, MW, MH);
  if (!strcmp(m, "anim")) return run_paced(paint_anim, opt.w < MW ? MW : opt.w, opt.h < MH ? MH : opt.h);
  if (!strcmp(m, "noise")) return run_paced(paint_noise, opt.w < MW ? MW : opt.w, opt.h < MH ? MH : opt.h);
  if (!strcmp(m, "doc")) return run_doc();
  if (!strcmp(m, "edit")) return run_edit();
  if (!strcmp(m, "chart")) return run_chart();
  if (!strcmp(m, "input")) return run_input();
  if (!strcmp(m, "panel")) return run_panel();
  if (!strcmp(m, "activate")) return wm_message("_NET_ACTIVE_WINDOW", 2, CurrentTime, 0, 0);
  if (!strcmp(m, "maximize"))
    return wm_message("_NET_WM_STATE", 2, (long)XInternAtom(dpy, "_NET_WM_STATE_MAXIMIZED_VERT", False),
                      (long)XInternAtom(dpy, "_NET_WM_STATE_MAXIMIZED_HORZ", False), 2);
  if (!strcmp(m, "minimize")) return wm_message("WM_CHANGE_STATE", IconicState, 0, 0, 0);
  fprintf(stderr, "dmapp: unknown mode %s\n", m);
  return 2;
}
