#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 5) { fprintf(stderr, "usage: xgrab X Y W H\n"); return 2; }
  int x = atoi(argv[1]), y = atoi(argv[2]), w = atoi(argv[3]), h = atoi(argv[4]);
  Display *d = XOpenDisplay(NULL);
  if (!d) { fprintf(stderr, "xgrab: cannot open display\n"); return 1; }
  XImage *im = XGetImage(d, DefaultRootWindow(d), x, y, w, h, AllPlanes, ZPixmap);
  if (!im) { fprintf(stderr, "xgrab: GetImage failed\n"); return 1; }
  unsigned char *out = malloc((size_t)w * h * 3), *p = out;
  for (int j = 0; j < h; j++)
    for (int i = 0; i < w; i++) {
      unsigned long px = XGetPixel(im, i, j);
      *p++ = (px >> 16) & 0xff, *p++ = (px >> 8) & 0xff, *p++ = px & 0xff;
    }
  fwrite(out, 1, (size_t)w * h * 3, stdout);
  return 0;
}
