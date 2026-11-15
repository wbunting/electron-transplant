# electron-transplant itself, as the app packages run it at build time: the files the
# offline build and the package install read, and @electron/asar with its
# dependencies from package-lock.json (fetched by nixpkgs' importNpmLock from the
# lock file's URLs and integrity hashes; no hash to maintain here, no network in
# the build). Only these files are copied, so editing docs or tests rebuilds nothing.
{
  lib,
  stdenvNoCC,
  importNpmLock,
  nodejs,
}:
let
  fs = lib.fileset;
  src = fs.toSource {
    root = ../.;
    fileset = fs.unions [
      ../apps
      ../bin
      ../compat
      ../lib
      ../pins
      ../LICENSE
      ../package.json
      ../package-lock.json
    ];
  };
  nodeModules = importNpmLock.buildNodeModules {
    package = lib.importJSON ../package.json;
    packageLock = lib.importJSON ../package-lock.json;
    inherit nodejs;
    # The dependencies have no install scripts; never run any.
    derivationArgs.npmRebuildFlags = [ "--ignore-scripts" ];
  };
in
stdenvNoCC.mkDerivation {
  pname = "electron-transplant";
  inherit ((lib.importJSON ../package.json)) version;
  inherit src;

  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    cp -r . "$out"
    ln -s ${nodeModules}/node_modules "$out/node_modules"
    runHook postInstall
  '';

  passthru = { inherit nodeModules nodejs; };

  meta = {
    description = "Run macOS Electron apps on Linux Electron (build-time tool)";
    homepage = "https://github.com/wbunting/electron-transplant";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
