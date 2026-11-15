# One app from sources.json, built on the user's machine from the vendor's macOS DMG
# with the offline build and staged with `install --layout package --prefix $out`
# (docs/packaging.md). Everything per app and pin comes from sources.json, so a pin
# bump needs no edit here.
#
#   callPackage ./nix/app.nix { app = "linear"; }
#   callPackage ./nix/app.nix { app = "notion"; variant = "x86_64"; }
#
# The runtime is Electron's official Linux build, patched as nixpkgs patches its
# own binary Electron (pkgs/development/tools/electron/binary): the same libraries,
# nixpkgs' Vulkan loader, and a GApps-wrapped launcher.
{
  lib,
  stdenv,
  callPackage,
  fetchurl,
  requireFile,
  bash,
  nodejs,
  python3,
  unzip,
  _7zz,
  autoPatchelfHook,
  makeWrapper,
  wrapGAppsHook3,
  # Electron's libraries, as nixpkgs' electron lists them.
  alsa-lib,
  at-spi2-atk,
  cairo,
  cups,
  dbus,
  expat,
  gdk-pixbuf,
  glib,
  gtk3,
  gtk4,
  nss,
  nspr,
  libx11,
  libxcb,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxrandr,
  libxkbfile,
  pango,
  pciutils,
  systemd,
  libnotify,
  pipewire,
  libsecret,
  libpulseaudio,
  speechd-minimal,
  libdrm,
  libgbm,
  libxkbcommon,
  libxshmfence,
  libGL,
  vulkan-loader,
  # Commands the apps run.
  coreutils,
  xdg-utils,
  fontconfig,
  wl-clipboard,
  xclip,
  # Which app and pin (default: the first pin listed, as `electron-transplant build`).
  app,
  version ? null,
  variant ? null,
  sources ? lib.importJSON ../sources.json,
}:
let
  entry =
    sources.apps.${app}
      or (throw "electron-transplant: no app ${app} in sources.json (known: ${lib.concatStringsSep ", " (lib.attrNames sources.apps)})");
  # "1.2.3 (universal)"; a pin's variant may be null.
  label = p: p.version + lib.optionalString (p.variant != null) " (${p.variant})";
  matches = lib.filter (
    p: (version == null || p.version == version) && (variant == null || p.variant == variant)
  ) entry.pins;
  pin =
    if matches == [ ] then
      throw "electron-transplant: ${app} has no pin for ${
        lib.concatStringsSep " " (
          lib.remove null [
            version
            variant
          ]
        )
      } (pinned: ${lib.concatMapStringsSep ", " label entry.pins})"
    else
      lib.head matches;

  tool = callPackage ./tool.nix { inherit nodejs; };
  inherit (entry) installId command;

  # The vendor's DMG, from the vendor. A URL can stop working (Figma keeps only its
  # current and previous release): a DMG added to the store by hash under the same
  # name (nix-store --add-fixed sha256 FILE) is the same path, so fetchurl uses it.
  dmg =
    if pin.dmg.url != null then
      fetchurl {
        inherit (pin.dmg) url sha256;
        name = pin.dmg.file;
      }
    else
      requireFile rec {
        name = "${installId}-${pin.version}${
          lib.optionalString (pin.variant != null) "-${pin.variant}"
        }.dmg";
        inherit (pin.dmg) sha256;
        message = ''
          ${entry.name} ${label pin} has no known download URL.
          Download its macOS DMG from ${
            if entry.downloadPage != null then entry.downloadPage else "the vendor"
          }, check that its SHA-256 is
          ${pin.dmg.sha256}, then add it to the store under this name:
            cp <downloaded file> /tmp/${name}
            nix-store --add-fixed sha256 /tmp/${name}
        '';
      };
  electronZip = fetchurl {
    inherit (pin.electron) url sha256;
    name = pin.electron.file;
  };
  npmTarballs = map (
    npm:
    fetchurl {
      inherit (npm) url sha256;
      name = npm.file;
    }
  ) pin.npm;

  # Linked by the runtime's binaries (autoPatchelf finds each in these).
  libraries = [
    alsa-lib
    at-spi2-atk
    cairo
    cups
    dbus
    expat
    gdk-pixbuf
    glib
    gtk3
    gtk4
    nss
    nspr
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxkbfile
    pango
    stdenv.cc.cc
    libdrm
    libgbm
    libxkbcommon
    libxshmfence
  ];
  # Loaded with dlopen by the executables (udev, audio, notifications, GTK 4, ...).
  runtimeLibraries = [
    gtk4
    pciutils
    systemd
    libnotify
    pipewire
    libsecret
    libpulseaudio
    speechd-minimal
  ];
  # Loaded with dlopen by ANGLE (libEGL, libGLESv2) as well, so on every runpath.
  graphicsLibraries = [
    libGL
    vulkan-loader
    pciutils
  ];

  # On the launchers' PATH, after the user's own: xdg-open for links, fc-list for
  # Figma's local fonts, clipboard tools for Superhuman's sign-in helper.
  commands = [
    coreutils
    xdg-utils
    fontconfig.bin
    wl-clipboard
    xclip
    libnotify
    glib.bin
  ];
in
stdenv.mkDerivation {
  pname = installId;
  inherit (pin) version;

  dontUnpack = true;
  strictDeps = true;
  __structuredAttrs = true;

  nativeBuildInputs = [
    nodejs
    python3
    unzip
    autoPatchelfHook
    makeWrapper
    wrapGAppsHook3
  ];
  buildInputs = libraries ++ [ bash ];
  runtimeDependencies = runtimeLibraries;
  appendRunpaths = map (pkg: "${lib.getLib pkg}/lib") graphicsLibraries;

  # The vendor's and Electron's files stay as built: no stripping, and only the
  # launchers get their shebangs patched.
  dontStrip = true;
  dontPatchShebangs = true;
  # The launchers are wrapped below; nothing in lib/ is.
  dontWrapGApps = true;
  # Only the runtime's binaries (lib/), not the launchers' wrappers.
  dontAutoPatchelf = true;

  buildPhase = ''
    runHook preBuild
    node ${tool}/bin/electron-transplant build ${app} --offline --out "$NIX_BUILD_TOP/transplant" \
      --dmg ${dmg} --electron-zip ${electronZip} \
      ${lib.concatMapStringsSep " " (tarball: "--npm-tarball ${tarball}") npmTarballs} \
      --sevenzip ${lib.getExe _7zz}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    node ${tool}/bin/electron-transplant install ${app} --from "$NIX_BUILD_TOP/transplant" \
      --layout package --prefix "$out"
    # nixpkgs' Vulkan loader, which finds the drivers NixOS provides (as nixpkgs' electron).
    ln -sf ${lib.getLib vulkan-loader}/lib/libvulkan.so.1 "$out/lib/${installId}/libvulkan.so.1"
    runHook postInstall
  '';

  preFixup = ''
    patchShebangs --host "$out/bin"
    for program in "$out"/bin/*; do
      wrapProgram "$program" "''${gappsWrapperArgs[@]}" \
        --suffix PATH : ${lib.makeBinPath commands}
    done
  '';

  postFixup = ''
    autoPatchelf "$out/lib"
  '';

  passthru = {
    inherit
      app
      pin
      tool
      dmg
      electronZip
      npmTarballs
      ;
  };

  meta = {
    description = entry.comment;
    longDescription = ''
      ${entry.displayName} ${label pin} from the vendor's macOS DMG,
      run on Electron ${pin.electron.version}'s official Linux build by
      electron-transplant (MIT). The DMG is downloaded from the vendor and built
      locally; the app stays under its vendor's terms.
    '';
    # The vendor's app; the electron-transplant code built into it is MIT.
    license = lib.licenses.unfree;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
    mainProgram = command;
  }
  // lib.optionalAttrs (entry.downloadPage != null) { homepage = entry.downloadPage; };
}
