{voxlSrc ? /src/voxl}: let
  pkgs = import ./nixpkgs.nix;
  sans = "${pkgs.dejavu_fonts}/share/fonts/truetype/DejaVuSans.ttf";
  mono = "${pkgs.dejavu_fonts}/share/fonts/truetype/DejaVuSansMono.ttf";
  x11app = name: extra:
    pkgs.runCommandCC name {
      buildInputs = with pkgs; [xorg.libX11 xorg.libXext xorg.libXft xorg.libXrender xorg.libXtst xorg.libXi fontconfig freetype];
      nativeBuildInputs = [pkgs.pkg-config];
    } ''
      mkdir -p $out/bin
      cc -O2 -Wall -o $out/bin/${name} ${../apps}/${name}.c \
        -DDM_FONT_SANS='"${sans}"' -DDM_FONT_MONO='"${mono}"' \
        $(pkg-config --cflags --libs x11 xext ${extra}) -lm
    '';
in
  pkgs.buildEnv {
    name = "desktopmark";
    paths = [
      (pkgs.callPackage "${voxlSrc}/default.nix" {})
      (pkgs.runCommand "voxl-xvfb" {} ''
        mkdir -p $out/bin
        ln -s ${pkgs.callPackage "${voxlSrc}/xvfb.nix" {}}/bin/Xvfb $out/bin/Xvfb-voxl
      '')
      (x11app "dmapp" "xft xrender xtst fontconfig freetype2")
      (x11app "xgrab" "")
      (pkgs.python312.withPackages (ps: [ps.numpy]))
      pkgs.chromium
      pkgs.nodejs
    ];
  }
