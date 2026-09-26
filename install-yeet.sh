#!/bin/sh
# Install a pinned yeet release on Arch, verifying it before anything runs.
#
# Fetches yeet 0.23.0 for this machine's architecture from pkgs.yeet.cx,
# checks the package's sha256 against the values below and its signature
# against the pinned release key, installs it with pacman and starts the
# daemon. Every step must succeed for the next to run. Log in afterwards
# with `yeet login`.
#
# Run it from the plugin checkout, which is this repository:
#   sh ~/.config/omarchy/plugins/cx.yeet.proctop/install-yeet.sh

set -eu

version=0.23.0-1
key=F537B2E78670F4F6C75D0E997FE0E3E7218228E6
sha256_x86_64=3c771d827de504b25418ebf863482a1fd5ac27a8f20e3f599c8e6c61efe05ea3
sha256_aarch64=cd5ed0c40ee01d1b33f6e26845935c7913ff92dccb0dad341def84ccd6e53768

main() {
  arch=$(uname -m)
  case $arch in
    x86_64)  sum=$sha256_x86_64 ;;
    aarch64) sum=$sha256_aarch64 ;;
    *) echo "install-yeet: no yeet package for $arch" >&2; exit 1 ;;
  esac

  pkg="yeet-$version-$arch.pkg.tar.zst"
  base="https://pkgs.yeet.cx/archlinux/os/$arch/stable"

  dir=$(mktemp -d)
  trap 'cd / && rm -rf "$dir"' EXIT
  cd "$dir"

  echo "Fetching yeet $version for $arch"
  curl -fsSLO "$base/$pkg"
  curl -fsSLO "$base/$pkg.sig"
  curl -fsSLo yeet.pub https://pkgs.yeet.cx/archlinux/yeet.noarmor.gpg

  echo "$sum  $pkg" | sha256sum -c

  sudo pacman-key --add yeet.pub
  sudo pacman-key --lsign-key "$key"
  sudo pacman -U --noconfirm "$pkg"
  sudo systemctl enable --now yeetd
}

main "$@"
