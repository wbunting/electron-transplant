# Graphics drivers for the Nix launcher (nix/app.nix runs this in the launcher's
# wrapper, before the launcher). nixpkgs' libglvnd, libgbm and Vulkan loader look
# for drivers only in @driverLink@, which only NixOS provides. Elsewhere
# Chromium's GPU process can't start and the app shows no window ("GPU process
# isn't usable"). @envPrefix@_NIX_GL picks what the app uses:
#   auto      (default) host if @driverLink@ exists (NixOS) or GL is already set
#             up (nixGL); software if every GPU runs NVIDIA's own driver; else mesa
#   host      the environment as it is
#   mesa      nixpkgs' Mesa from this package's closure: AMD, Intel, nouveau, ...
#   software  SwiftShader, the CPU renderer Electron ships, for WebGL, and software
#             compositing (composited with SwiftShader, a Wayland window can keep
#             drawing at its first size)
nix_gl=${@envPrefix@_NIX_GL:-auto}
nix_gl_log() {
  local log_dir="${XDG_CACHE_HOME:-$HOME/.cache}/@installId@"
  if (umask 077 && mkdir -p "$log_dir") 2>/dev/null; then
    printf '%s\n' "$1" >>"$log_dir/launcher.log" || true
  fi
}
case $nix_gl in
  auto | host | mesa | software) ;;
  *)
    printf '@command@: unknown @envPrefix@_NIX_GL=%s (auto, host, mesa or software); using auto\n' "$nix_gl" >&2
    nix_gl=auto
    ;;
esac
if [[ $nix_gl == auto ]]; then
  if [[ -e @driverLink@ || -n ${__EGL_VENDOR_LIBRARY_FILENAMES-}${__EGL_VENDOR_LIBRARY_DIRS-}${LIBGL_DRIVERS_PATH-}${GBM_BACKENDS_PATH-} ]]; then
    nix_gl=host
  else
    # Mesa has no driver for NVIDIA's proprietary one; hybrid laptops still have
    # an Intel or AMD GPU that Mesa drives.
    nix_gl=mesa nix_gl_nvidia=0 nix_gl_other=0
    for nix_gl_driver in @drmClass@/renderD*/device/driver; do
      if [[ ! -e $nix_gl_driver ]]; then
        continue
      elif [[ $(readlink -f -- "$nix_gl_driver") == */nvidia ]]; then
        nix_gl_nvidia=1
      else
        nix_gl_other=1
      fi
    done
    if [[ $nix_gl_nvidia == 1 && $nix_gl_other == 0 ]]; then
      nix_gl=software
      nix_gl_message="@command@: Nix's Mesa has no driver for NVIDIA's proprietary one, rendering in software. For the GPU: nix run --impure github:nix-community/nixGL#nixGLNvidia -- @command@ (@envPrefix@_NIX_GL=software hides this)"
      printf '%s\n' "$nix_gl_message" >&2
      nix_gl_log "$nix_gl_message"
    fi
  fi
fi
case $nix_gl in
  mesa)
    export GBM_BACKENDS_PATH=@mesa@/lib/gbm
    export LIBGL_DRIVERS_PATH=@mesa@/lib/dri
    export __EGL_VENDOR_LIBRARY_FILENAMES=@mesa@/share/glvnd/egl_vendor.d/50_mesa.json
    ET_NIX_GL_VARS="GBM_BACKENDS_PATH LIBGL_DRIVERS_PATH __EGL_VENDOR_LIBRARY_FILENAMES"
    # Only Mesa's Vulkan drivers: the host's are built against the host's libraries.
    if [[ -z ${VK_DRIVER_FILES-}${VK_ICD_FILENAMES-} ]]; then
      nix_gl_icds=(@mesa@/share/vulkan/icd.d/*.json)
      VK_DRIVER_FILES=$(IFS=: && printf '%s' "${nix_gl_icds[*]}")
      export VK_DRIVER_FILES
      ET_NIX_GL_VARS+=" VK_DRIVER_FILES"
    fi
    # Programs the app opens with xdg-open (a browser for links) get the host's
    # graphics setup back: host-env/xdg-open drops these variables.
    export ET_NIX_GL_VARS
    export PATH="@hostEnv@${PATH:+:$PATH}"
    nix_gl_log "@command@: graphics: nixpkgs' Mesa (@mesa@); @envPrefix@_NIX_GL=host|software overrides"
    ;;
  software)
    set -- --use-angle=swiftshader --disable-gpu-compositing "$@"
    ;;
esac
unset -f nix_gl_log
