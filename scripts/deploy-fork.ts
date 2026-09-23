#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - deployment orchestration is intentionally host-facing.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEFAULT_REMOTE = "ubuntu@dev48";
const SERVER_PACKAGE_PATH = "apps/server/package.json";
const SEA_NODE_VERSION = "26.8.2";

export interface DeployForkOptions {
  readonly deployLocal: boolean;
  readonly dryRun: boolean;
  readonly keepArtifacts: boolean;
  readonly remotes: ReadonlyArray<string>;
}

interface BuildMetadata {
  readonly commit: string;
  readonly version: string;
  readonly archPackageVersion: string;
}

interface BuiltArtifacts {
  readonly cliArchive: string;
  readonly desktopAppImage: string;
  readonly scratchRoot: string;
}

interface RunOptions {
  readonly capture?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function run(command: string, args: ReadonlyArray<string>, options: RunOptions = {}): string {
  const capture = options.capture === true;
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    stdio: capture
      ? ["ignore", "pipe", "pipe"]
      : [options.input ? "pipe" : "inherit", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stdout}${result.stderr}`.trimEnd() : "";
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}${detail}`);
  }
  return capture ? result.stdout.trim() : "";
}

function commandSucceeds(command: string, args: ReadonlyArray<string>): boolean {
  return NodeChildProcess.spawnSync(command, [...args], { stdio: "ignore" }).status === 0;
}

export function nodeSupportsExecutableBuild(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 25 || (major === 25 && minor >= 7);
}

function buildStandaloneExecutable(): void {
  const args = ["apps/server/scripts/cli.ts", "build-exe", "--verbose"];
  const env = { ...process.env, VP_NODE_VERSION: SEA_NODE_VERSION };
  if (nodeSupportsExecutableBuild(process.version)) {
    run(process.execPath, args, { env });
    return;
  }
  if (commandSucceeds("mise", ["exec", "node@26", "--", "node", "--version"])) {
    run("mise", ["exec", "node@26", "--", "node", ...args], { env });
    return;
  }
  throw new Error(
    "The standalone executable build needs Node.js 25.7 or later. Install Node 26 or make it available through mise as node@26.",
  );
}

function takeValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseDeployForkArgs(args: ReadonlyArray<string>): DeployForkOptions {
  let deployLocal = true;
  let dryRun = false;
  let keepArtifacts = false;
  let remoteDisabled = false;
  const remotes: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--remote") {
      const value = takeValue(args, index, argument);
      remotes.push(
        ...value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      index += 1;
    } else if (argument === "--no-remote" || argument === "--local-only") {
      remoteDisabled = true;
    } else if (argument === "--no-local" || argument === "--remote-only") {
      deployLocal = false;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--keep-artifacts") {
      keepArtifacts = true;
    } else if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return {
    deployLocal,
    dryRun,
    keepArtifacts,
    remotes: remoteDisabled ? [] : remotes.length > 0 ? [...new Set(remotes)] : [DEFAULT_REMOTE],
  };
}

function printHelp(): void {
  process.stdout.write(`Deploy the current T3 Code fork revision locally and to remote servers.

Usage:
  pnpm deploy:fork [options]

Options:
  --remote user@host    Remote server to update; repeat or comma-separate values
  --remote-only         Skip the local Arch desktop package
  --local-only          Skip all remote servers
  --no-local            Alias for --remote-only
  --no-remote           Alias for --local-only
  --dry-run             Print the derived version and targets without changing anything
  --keep-artifacts      Keep the temporary build/package directory
  --help, -h            Show this help

Default remote: ${DEFAULT_REMOTE}
`);
}

export function deriveForkVersion(
  packageVersion: string,
  commit: string,
  commitEpochSeconds: string,
): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(packageVersion);
  if (!match) throw new Error(`Cannot derive a fork version from '${packageVersion}'.`);
  if (!/^\d+$/.test(commitEpochSeconds)) {
    throw new Error(`Invalid commit timestamp '${commitEpochSeconds}'.`);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${String(Number(patch) + 1)}-zzfork.${commitEpochSeconds}.${commit.slice(0, 9)}`;
}

export function toArchPackageVersion(version: string): string {
  return version.replaceAll(/[-+]/g, ".");
}

function resolveBuildMetadata(): BuildMetadata {
  const packageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, SERVER_PACKAGE_PATH), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error(`${SERVER_PACKAGE_PATH} does not contain a string version.`);
  }
  const commit = run("git", ["rev-parse", "HEAD"], { capture: true });
  const commitEpochSeconds = run("git", ["show", "-s", "--format=%ct", "HEAD"], {
    capture: true,
  });
  const version = deriveForkVersion(packageJson.version, commit, commitEpochSeconds);
  return { commit, version, archPackageVersion: toArchPackageVersion(version) };
}

function sha256(filePath: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
}

function withTemporaryServerVersion<A>(version: string, action: () => A): A {
  const manifestPath = NodePath.join(repoRoot, SERVER_PACKAGE_PATH);
  const original = NodeFS.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original) as Record<string, unknown>;
  manifest.version = version;
  let restored = false;
  const restore = () => {
    if (restored) return;
    NodeFS.writeFileSync(manifestPath, original);
    restored = true;
  };
  const interrupt = (signal: NodeJS.Signals) => {
    restore();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    return action();
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    restore();
  }
}

function findSingleFile(directory: string, predicate: (name: string) => boolean): string {
  const matches = NodeFS.readdirSync(directory).filter(predicate);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one matching artifact in ${directory}, found ${String(matches.length)}.`,
    );
  }
  return NodePath.join(directory, matches[0]!);
}

function buildArtifacts(metadata: BuildMetadata): BuiltArtifacts {
  const scratchRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-fork-deploy-"));
  const desktopOutput = NodePath.join(scratchRoot, "desktop");
  const cliOutput = NodePath.join(scratchRoot, "cli");
  const monitorRoot = NodePath.join(scratchRoot, "resource-monitor", "linux-x64");
  NodeFS.mkdirSync(desktopOutput, { recursive: true });
  NodeFS.mkdirSync(cliOutput, { recursive: true });
  NodeFS.mkdirSync(monitorRoot, { recursive: true });

  try {
    withTemporaryServerVersion(metadata.version, () => {
      run("pnpm", [
        "dist:desktop:linux",
        "--build-version",
        metadata.version,
        "--output-dir",
        desktopOutput,
      ]);
      buildStandaloneExecutable();
      const monitor = NodePath.join(
        repoRoot,
        "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
      );
      if (!NodeFS.existsSync(monitor)) throw new Error(`Missing resource monitor: ${monitor}`);
      NodeFS.copyFileSync(monitor, NodePath.join(monitorRoot, "t3-resource-monitor"));
      run("node", [
        "scripts/build-cli-archive.ts",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        metadata.version,
        "--resource-monitor-dir",
        NodePath.dirname(monitorRoot),
        "--output-dir",
        cliOutput,
      ]);
    });

    const desktopAppImage = findSingleFile(desktopOutput, (name) => name.endsWith(".AppImage"));
    const cliArchive = findSingleFile(cliOutput, (name) => name.endsWith(".tar.gz"));
    run("node", [
      "scripts/smoke-cli-archive.ts",
      "--archive",
      cliArchive,
      "--expect-version",
      metadata.version,
    ]);
    return { cliArchive, desktopAppImage, scratchRoot };
  } catch (error) {
    process.stderr.write(`Build artifacts retained at ${scratchRoot}\n`);
    throw error;
  }
}

export function renderCliWrapper(): string {
  return `#!/bin/bash
set -euo pipefail
export ELECTRON_RUN_AS_NODE=1
exec /usr/lib/t3code/t3code /usr/lib/t3code/resources/app.asar/apps/server/dist/bin.mjs "$@"
`;
}

export function renderDesktopWrapper(): string {
  return `#!/bin/bash
set -euo pipefail
user_flags=()
config_home="\${XDG_CONFIG_HOME:-}"
[[ -n "$config_home" || -z "\${HOME:-}" ]] || config_home="$HOME/.config"
flags_file="\${config_home:+$config_home/t3code-flags.conf}"
if [[ -n "$flags_file" && -f "$flags_file" && -r "$flags_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="\${line%%#*}"
    [[ -n "\${line//[[:space:]]/}" ]] || continue
    read -r -a flags <<<"$line"
    user_flags+=("\${flags[@]}")
  done <"$flags_file"
fi
platform_flags=()
if [[ -n "\${WAYLAND_DISPLAY:-}" || "\${XDG_SESSION_TYPE:-}" == wayland ]]; then
  platform_flags=(--ozone-platform=wayland)
  for flag in "\${user_flags[@]}" "$@"; do
    case "$flag" in
      --ozone-platform=* | --ozone-platform-hint=*) platform_flags=() ;;
    esac
  done
fi
exec /usr/lib/t3code/t3code "\${platform_flags[@]}" "\${user_flags[@]}" "$@"
`;
}

export function renderPkgbuild(input: {
  readonly appImageName: string;
  readonly appImageSha: string;
  readonly archPackageVersion: string;
  readonly cliWrapperSha: string;
  readonly commit: string;
  readonly desktopWrapperSha: string;
  readonly licenseSha: string;
  readonly version: string;
}): string {
  return `pkgname=t3code-bin
pkgver=${input.archPackageVersion}
pkgrel=1
pkgdesc="T3 Code built locally from jvelascodev/t3code commit ${input.commit.slice(0, 9)}"
arch=('x86_64')
url="https://github.com/jvelascodev/t3code"
license=('MIT')
depends=('alsa-lib' 'at-spi2-core' 'cairo' 'dbus' 'expat' 'gcc-libs' 'glib2' 'glibc' 'gtk3' 'hicolor-icon-theme' 'libcups' 'libnotify' 'libx11' 'libxcb' 'libxcomposite' 'libxdamage' 'libxext' 'libxfixes' 'libxkbcommon' 'libxrandr' 'mesa' 'nspr' 'nss' 'pango' 'systemd-libs' 'xdg-utils')
optdepends=('claude-code: drive Claude Code from the app' 'cursor-cli: drive Cursor from the app' 'github-copilot-cli: drive Copilot from the app' 'openai-codex: drive Codex from the app')
provides=('t3code=${input.version.split("-")[0]}')
conflicts=('t3code')
options=('!strip')
source=('${input.appImageName}' 't3' 't3code-launcher' 'LICENSE')
sha256sums=('${input.appImageSha}' '${input.cliWrapperSha}' '${input.desktopWrapperSha}' '${input.licenseSha}')

prepare() {
  chmod +x "\${srcdir}/${input.appImageName}"
  cd "\${srcdir}"
  "\${srcdir}/${input.appImageName}" --appimage-extract >/dev/null
}

package() {
  install -dm755 "\${pkgdir}/usr/lib/t3code"
  cp -a "\${srcdir}/squashfs-root/." "\${pkgdir}/usr/lib/t3code/"
  rm -f "\${pkgdir}/usr/lib/t3code/AppRun" "\${pkgdir}/usr/lib/t3code/.DirIcon" "\${pkgdir}/usr/lib/t3code/t3code.desktop" "\${pkgdir}/usr/lib/t3code/t3code.png"
  rm -rf "\${pkgdir}/usr/lib/t3code/usr"
  install -Dm755 "\${srcdir}/t3" "\${pkgdir}/usr/bin/t3"
  install -Dm755 "\${srcdir}/t3code-launcher" "\${pkgdir}/usr/bin/t3code"
  install -Dm644 "\${srcdir}/squashfs-root/t3code.desktop" "\${pkgdir}/usr/share/applications/t3code.desktop"
  sed -i 's|^Exec=.*|Exec=t3code %U|' "\${pkgdir}/usr/share/applications/t3code.desktop"
  cp -a "\${srcdir}/squashfs-root/usr/share/icons" "\${pkgdir}/usr/share/"
  install -Dm644 "\${srcdir}/LICENSE" "\${pkgdir}/usr/share/licenses/\${pkgname}/LICENSE"
  find "\${pkgdir}" -type d -exec chmod 755 {} +
}
`;
}

function installLocalDesktop(artifacts: BuiltArtifacts, metadata: BuildMetadata): void {
  const hostPlatform = run("uname", ["-s"], { capture: true });
  const hostArchitecture = run("uname", ["-m"], { capture: true });
  if (hostPlatform !== "Linux" || hostArchitecture !== "x86_64") {
    throw new Error("Local fork deployment currently supports Linux x64 only.");
  }
  for (const command of ["makepkg", "pacman"]) {
    if (!commandSucceeds("sh", ["-c", `command -v ${command}`])) {
      throw new Error(`Local deployment requires ${command}.`);
    }
  }

  const packageRoot = NodePath.join(artifacts.scratchRoot, "arch-package");
  NodeFS.mkdirSync(packageRoot, { recursive: true });
  const appImageName = NodePath.basename(artifacts.desktopAppImage);
  const localAppImage = NodePath.join(packageRoot, appImageName);
  const cliWrapper = NodePath.join(packageRoot, "t3");
  const desktopWrapper = NodePath.join(packageRoot, "t3code-launcher");
  const license = NodePath.join(packageRoot, "LICENSE");
  NodeFS.copyFileSync(artifacts.desktopAppImage, localAppImage);
  NodeFS.copyFileSync(NodePath.join(repoRoot, "LICENSE"), license);
  NodeFS.writeFileSync(cliWrapper, renderCliWrapper(), { mode: 0o755 });
  NodeFS.writeFileSync(desktopWrapper, renderDesktopWrapper(), { mode: 0o755 });
  NodeFS.writeFileSync(
    NodePath.join(packageRoot, "PKGBUILD"),
    renderPkgbuild({
      appImageName,
      appImageSha: sha256(localAppImage),
      archPackageVersion: metadata.archPackageVersion,
      cliWrapperSha: sha256(cliWrapper),
      commit: metadata.commit,
      desktopWrapperSha: sha256(desktopWrapper),
      licenseSha: sha256(license),
      version: metadata.version,
    }),
  );

  run("makepkg", ["--clean", "--cleanbuild", "--force"], { cwd: packageRoot });
  const packagePath = run("makepkg", ["--packagelist"], { capture: true, cwd: packageRoot });
  const pacmanArgs = ["pacman", "-U", "--noconfirm", packagePath];
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    run(pacmanArgs[0]!, pacmanArgs.slice(1));
  } else if (commandSucceeds("sudo", ["-n", "true"])) {
    run("sudo", pacmanArgs);
  } else if (commandSucceeds("sh", ["-c", "command -v pkexec"])) {
    run("pkexec", pacmanArgs);
  } else {
    throw new Error(`Install the built package manually: ${packagePath}`);
  }

  const installed = run("pacman", ["-Q", "t3code-bin"], { capture: true });
  if (!installed.includes(metadata.archPackageVersion)) {
    throw new Error(`Unexpected installed package: ${installed}`);
  }
  const cliVersion = run("t3", ["--version"], { capture: true });
  if (cliVersion !== `t3 v${metadata.version}`) {
    throw new Error(`Unexpected local CLI version: ${cliVersion}`);
  }
  const integrity = run("pacman", ["-Qkk", "t3code-bin"], { capture: true });
  if (!integrity.includes("0 altered files")) {
    throw new Error(`Local package integrity check failed: ${integrity}`);
  }
  process.stdout.write(`Local desktop installed: ${installed}\n`);
}

export function renderRemoteInstallScript(): string {
  return `set -euo pipefail
version="$1"
expected_sha="$2"
archive="$3"
base_dir="\${T3CODE_HOME:-$HOME/.t3}"
target="$base_dir/runtime/versions/$version"
stage=""
cleanup() {
  rm -f "$archive"
  if [[ -n "$stage" && -d "$stage" ]]; then rmdir "$stage" 2>/dev/null || true; fi
}
trap cleanup EXIT
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo "Remote must be Linux x86_64" >&2; exit 1; }
[[ "$(sha256sum "$archive" | cut -d' ' -f1)" == "$expected_sha" ]] || { echo "Archive checksum mismatch" >&2; exit 1; }
if [[ -e "$target" ]]; then
  [[ "$($target/t3 --version)" == "t3 v$version" ]] || { echo "Existing runtime is invalid: $target" >&2; exit 1; }
else
  mkdir -p "$base_dir/runtime/versions"
  stage=$(mktemp -d "$base_dir/runtime/versions/.fork-install.XXXXXX")
  tar -xzf "$archive" -C "$stage"
  source_dir="$stage/t3-$version-linux-x64"
  [[ -x "$source_dir/t3" && "$($source_dir/t3 --version)" == "t3 v$version" ]] || { echo "Extracted runtime failed validation" >&2; exit 1; }
  printf '%s\\n' "$version" > "$source_dir/.install-complete"
  mv "$source_dir" "$target"
fi
T3CODE_HOME="$base_dir" "$target/t3" service install --base-dir "$base_dir"
[[ "$(systemctl --user is-active t3code.service)" == active ]]
[[ "$(systemctl --user is-enabled t3code.service)" == enabled ]]
http_ready=false
for _attempt in {1..30}; do
  if [[ "$(curl --connect-timeout 1 --max-time 2 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3773/ 2>/dev/null || true)" == 200 ]]; then
    http_ready=true
    break
  fi
  sleep 1
done
[[ "$http_ready" == true ]] || { echo "T3 Code service did not become HTTP-ready" >&2; exit 1; }
printf 'Remote service active: t3 v%s (%s)\n' "$version" "$target"
`;
}

function installRemoteServer(remote: string, cliArchive: string, version: string): void {
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(remote)) {
    throw new Error(`Invalid remote '${remote}'; expected user@host.`);
  }
  const archiveName = NodePath.basename(cliArchive);
  const remoteArchive = `/tmp/${archiveName}`;
  run("scp", ["-q", "-o", "BatchMode=yes", cliArchive, `${remote}:${remoteArchive}`]);
  run(
    "ssh",
    ["-o", "BatchMode=yes", remote, "bash", "-s", "--", version, sha256(cliArchive), remoteArchive],
    { input: renderRemoteInstallScript() },
  );
  process.stdout.write(`Remote server installed: ${remote} · t3 v${version}\n`);
}

function cleanupScratch(scratchRoot: string): void {
  const resolved = NodePath.resolve(scratchRoot);
  const expectedPrefix = NodePath.join(NodeOS.tmpdir(), "t3code-fork-deploy-");
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove unexpected artifact directory: ${resolved}`);
  }
  NodeFS.rmSync(resolved, { recursive: true, force: true });
}

export function main(args: ReadonlyArray<string> = process.argv.slice(2)): void {
  const options = parseDeployForkArgs(args);
  if (!options.deployLocal && options.remotes.length === 0) {
    throw new Error("Nothing to deploy: both local and remote targets are disabled.");
  }
  const metadata = resolveBuildMetadata();
  process.stdout.write(
    `Fork deployment\n  commit: ${metadata.commit}\n  version: ${metadata.version}\n  local: ${options.deployLocal ? "yes" : "no"}\n  remotes: ${options.remotes.join(", ") || "none"}\n`,
  );
  if (options.dryRun) return;

  const artifacts = buildArtifacts(metadata);
  try {
    if (options.deployLocal) installLocalDesktop(artifacts, metadata);
    for (const remote of options.remotes)
      installRemoteServer(remote, artifacts.cliArchive, metadata.version);
    process.stdout.write(`Deployment complete: ${metadata.version}\n`);
  } finally {
    if (options.keepArtifacts) {
      process.stdout.write(`Artifacts retained at ${artifacts.scratchRoot}\n`);
    } else {
      cleanupScratch(artifacts.scratchRoot);
    }
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
