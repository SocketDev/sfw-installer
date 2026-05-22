This is a wrapper script to download os + arch prebuilt executables of [Socket Firewall Free](https://github.com/SocketDev/sfw-free).

It will automatically try to update in the background once a day if it finds a new release.

Set `SFW_SKIP_UPDATE_CHECK=1` to skip the background update check when a cached binary is already present (useful for offline or air-gapped environments). The initial download still runs if no binary is cached.

Directory Structure:

```console
# directory for downloaded versions of sfw
./.swf-cache
# a symlink that always points to the latest version downloaded
./.sfw-cache/latest => .sfw-cache/$VERSION/
# a downloading executable that should be able to run on the machine
./.sfw-cache/$VERSION/$BIN
# UTC based time to next look for a newly published version
./.sfw-cache/next-check
# a resumable download of the asset
# these will download in the background by default
./.sfw-cache/$VERSION/$BIN.dl
```
