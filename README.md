# Socket Firewall Free

`sfw` is Socket Firewall Free, made by [Socket](https://socket.dev). Use it by putting `sfw` in front of the package manager command you already run, like `sfw npm install`. If a package in the install is known malware, the download is refused and never reaches disk so its code never runs on the machine.

It is free with no API key or configuration needed. It works the same on a laptop and in CI, and it covers the whole dependency tree. Malware at any depth is blocked, not only packages named on the command line.

```text
$ npm i -g sfw
$ sfw npm install lodahs
npm error code E403
npm error 403 403 Forbidden - GET https://registry.npmjs.org/lodahs/-/lodahs-0.0.1-security.tgz
npm error 403 In most cases, you or one of your dependencies are requesting a package version that is forbidden by your security policy, or on a server you do not have access to.

=== Socket Firewall ===

 - blocked npm package: name: lodahs; version: 0.0.1-security; reason: malware (critical) - https://socket.dev/npm/package/lodahs/alerts/0.0.1-security

For more information, check https://socket.dev.
```

In this demo `lodahs` is a typo of `lodash` that Socket lists as malware. npm has since replaced `lodahs` with a security holding package so the demo is safe to run yourself. The command exits with code `1` and `node_modules` is never created.

## How it works

`sfw <command>` starts an HTTP proxy on localhost that lasts only for the duration of that command. It generates a CA certificate in a temporary directory and sets proxy and CA environment variables for that process, including `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `PIP_CERT` and `CARGO_HTTP_CAINFO`. This does not change system proxy settings or the system trust store.

When a request goes to a package registry, `sfw` reads the package name and version from the URL and asks Socket's API whether that version is malware. Confirmed malware gets a `403` and the file is never downloaded, while anything else is forwarded to the registry. Requests to hosts that are not package registries pass through untouched.

When the command exits, the proxy stops and the temporary directory is deleted. `sfw` exits with the package manager's exit code.

Two limits to know about: `sfw` acts on network requests, so a package already in the local cache installs without a request and `sfw` never sees it. You can clear the cache, for example with `npm cache clean --force`, and use `sfw` from then on. Second, `sfw` needs network access to Socket's API and does not work offline.

## What gets blocked

Socket finds malware with AI scans followed by human review. The category a package version is in decides what `sfw` does.

- Confirmed malware, meaning a human reviewer has verified it: blocked
- AI-detected and not yet confirmed: not blocked, `sfw` prints a warning that names the package and links to its page on [socket.dev](https://socket.dev) and the install continues
- Unknown or unscanned package versions: not blocked

## Supported package managers

- JavaScript and TypeScript: `npm`, `yarn`, `pnpm`
- Python: `pip`, `uv`
- Rust: `cargo`

Other package managers might work, but support is not guaranteed. Socket Firewall Free does not support private or custom registries. It runs on macOS, Linux and Windows, on x86_64 and arm64. This npm package needs Node.js 20 or later.

## Install and use

Install with `npm i -g sfw`, then put `sfw` in front of any supported command.

```sh
sfw npm install
sfw pnpm add express
sfw yarn add react
sfw pip install requests
sfw uv pip install flask
sfw cargo fetch
```

To run it without a global install, use `npx`.

```sh
npx sfw npm install
```

Add shell aliases to `~/.bashrc` or `~/.zshrc` so you do not have to remember the prefix.

```sh
alias npm="sfw npm"
alias pip="sfw pip"
```

In GitHub Actions, the action `SocketDev/action` with `mode: firewall-free` installs `sfw` on the runner. It works on Linux, Windows and macOS runners.

```yaml
steps:
  - uses: SocketDev/action@ba6de6cc0565af1f42295590380973573297e31f # v1.3.2
    with:
      mode: firewall-free
  - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
  - run: sfw npm ci
```

On a machine without Node.js, download a standalone binary from the [releases page](https://github.com/SocketDev/sfw-free/releases).

## Free and Enterprise

Socket Firewall Free is free for open source and commercial projects. Socket Firewall Enterprise is the paid version.

| | Free | Enterprise |
| --- | --- | --- |
| AI-detected malware | warning only | configurable, can block |
| Unknown or unscanned packages | not blocked | configurable |
| Ecosystems | JavaScript/TypeScript, Python, Rust | adds Go, Java (Maven, Gradle), Ruby (gem, Bundler), .NET (NuGet) |
| Registries | public only | private and custom |
| Allow-list | none | yes |
| Deployment | wrapper mode (the `sfw` prefix) | wrapper mode, plus registry mode for centralized deployment |
| Socket dashboard | not connected | install activity across your organization |
| Telemetry | always on | configurable |

The full comparison is in the [Socket Firewall overview](https://docs.socket.dev/docs/socket-firewall-overview). To try Enterprise, email sales@socket.dev or book a [demo](https://socket.dev/demo).

## What this npm package does

The `sfw` package is a small launcher. Its source is at [GitHub](https://github.com/SocketDev/sfw-installer). The firewall itself is a prebuilt binary published at [GitHub releases](https://github.com/SocketDev/sfw-free/releases). On its first run the launcher downloads the binary for your operating system and CPU from the latest release and checks it against the digest GitHub publishes. A file that does not match is rejected.

The binary is cached in `.sfw-cache` inside the package's install directory. Later runs start the cached binary. At most once an hour the launcher checks for a newer release and downloads it. The run after that uses the new binary. If that check fails and a binary is already cached, the cached binary runs.

`SFW_SKIP_UPDATE_CHECK=1` skips the update check when a binary is already cached, and is meant for offline or air-gapped machines. With no cached binary, the first download still happens. The release lookup calls the GitHub API, which allows 60 unauthenticated requests per hour per IP address. Set `GITHUB_TOKEN` or `GH_TOKEN` and the launcher sends the token with the lookup.

## Telemetry

Socket Firewall Free collects anonymous telemetry that is always on and cannot be turned off:

- A non-reversible identifier per machine
- The name, namespace and version of blocked and permitted packages
- The latency `sfw` adds to package fetches
- Errors without call stacks, paths or file names

It may also collect the name of your GitHub organization read from your configured git remotes. It never collects repository names, source code or commit history. The full statement is in the [Socket Firewall Free docs](https://docs.socket.dev/docs/socket-firewall-free).

## License and links

This launcher package is MIT licensed. The firewall binary it downloads is under the [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0). The [docs](https://docs.socket.dev/docs/socket-firewall-free) have the rest, and bugs or questions go to the [issue tracker](https://github.com/SocketDev/sfw-free/issues).
