{
  description = "Linear, Notion, Figma and Superhuman from their macOS builds, on Linux Electron";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;
      # The build checks binaries for x86_64; Linux Electron's arm64 build isn't wired up.
      systems = [ "x86_64-linux" ];
      forAllSystems = lib.genAttrs systems;
      sources = lib.importJSON ./sources.json;
      # Package names (pname): linear-desktop, figma-desktop, ...
      installIds = lib.mapAttrsToList (_: entry: entry.installId) sources.apps;

      # mkTransplantApp pkgs { app = "notion"; version ? null; variant ? null; }
      # One app, any of its pins (default: the first one listed in sources.json).
      mkTransplantApp = pkgs: args: pkgs.callPackage ./nix/app.nix args;

      # The flake's own package set allows exactly these unfree packages: building
      # one is the choice to use that vendor's app. The overlay builds with the
      # user's nixpkgs, whose unfree settings apply.
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg: lib.elem (lib.getName pkg) installIds;
        };

      fs = lib.fileset;
      nixFiles = fs.toSource {
        root = ./.;
        fileset = fs.fileFilter (file: file.hasExt "nix") ./.;
      };
    in
    {
      lib = { inherit mkTransplantApp; };

      # pkgs.linear-desktop, pkgs.figma-desktop, pkgs.notion-desktop, pkgs.superhuman-desktop
      overlays.default =
        final: _prev:
        lib.mapAttrs' (
          app: entry: lib.nameValuePair entry.installId (mkTransplantApp final { inherit app; })
        ) sources.apps;

      packages = forAllSystems (
        system: lib.mapAttrs (app: _: mkTransplantApp (pkgsFor system) { inherit app; }) sources.apps
      );

      # No check needs a vendor DMG: CI never has one.
      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          tool = pkgs.callPackage ./nix/tool.nix { };
        in
        {
          # Every pin of every app evaluates to a derivation (nothing is fetched).
          pins = pkgs.writeText "electron-transplant-pins" (
            lib.concatLines (
              lib.concatLists (
                lib.mapAttrsToList (
                  app: entry:
                  map (
                    pin:
                    let
                      drv = mkTransplantApp (pkgsFor system) {
                        inherit app;
                        inherit (pin) version variant;
                      };
                    in
                    "${app} ${pin.version} ${toString pin.variant} ${builtins.unsafeDiscardStringContext drv.drvPath}"
                  ) entry.pins
                ) sources.apps
              )
            )
          );

          inherit tool;

          # npm test in the build sandbox: no network, no HOME, no vendor DMGs (those
          # tests skip), and no cached Electron (the real-Electron tests skip too).
          tests = pkgs.stdenvNoCC.mkDerivation {
            name = "electron-transplant-tests";
            src = fs.toSource {
              root = ./.;
              fileset = fs.difference ./. (
                fs.unions [
                  (fs.maybeMissing ./result)
                  ./docs
                  ./.github
                ]
              );
            };
            nativeBuildInputs = [
              tool.nodejs
              pkgs.python3
              pkgs.unzip
              pkgs._7zz
            ];
            # The tests run bin/electron-transplant (#!/usr/bin/env node) directly.
            postPatch = "patchShebangs bin";
            dontConfigure = true;
            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR/home" XDG_CACHE_HOME="$TMPDIR/cache"
              ln -s ${tool.nodeModules}/node_modules node_modules
              npm test
              runHook postBuild
            '';
            installPhase = "touch $out";
          };

          formatting =
            pkgs.runCommand "electron-transplant-nixfmt" { nativeBuildInputs = [ pkgs.nixfmt ]; }
              ''
                find ${nixFiles} -name '*.nix' -exec nixfmt --check {} +
                touch $out
              '';
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);

      # Node, Python, unzip and 7-Zip for working on electron-transplant itself.
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.python3
              pkgs.unzip
              pkgs._7zz
              pkgs.nixfmt
            ];
          };
        }
      );
    };
}
