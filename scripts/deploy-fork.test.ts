import { assert, describe, it } from "@effect/vitest";

import {
  deriveForkVersion,
  nodeSupportsExecutableBuild,
  parseDeployForkArgs,
  renderCliWrapper,
  renderPkgbuild,
  renderRemoteInstallScript,
  toArchPackageVersion,
} from "./deploy-fork.ts";

describe("deploy-fork", () => {
  it("defaults to the local desktop and dev48", () => {
    assert.deepStrictEqual(parseDeployForkArgs([]), {
      deployLocal: true,
      dryRun: false,
      keepArtifacts: false,
      remotes: ["ubuntu@dev48"],
    });
  });

  it("accepts explicit and comma-separated remote targets", () => {
    assert.deepStrictEqual(
      parseDeployForkArgs([
        "--remote-only",
        "--remote",
        "ubuntu@one,deploy@two",
        "--remote",
        "ubuntu@one",
      ]),
      {
        deployLocal: false,
        dryRun: false,
        keepArtifacts: false,
        remotes: ["ubuntu@one", "deploy@two"],
      },
    );
  });

  it("derives a monotonic fork prerelease above the legacy fork label", () => {
    const version = deriveForkVersion(
      "0.0.42",
      "0484ade344430b77df4e6a2e86d2e842a2c4401a",
      "1789992452",
    );
    assert.equal(version, "0.0.43-zzfork.1789992452.0484ade34");
    assert.equal(toArchPackageVersion(version), "0.0.43.zzfork.1789992452.0484ade34");
  });

  it("recognizes Node versions that support executable builds", () => {
    assert.isFalse(nodeSupportsExecutableBuild("v24.13.1"));
    assert.isFalse(nodeSupportsExecutableBuild("25.6.0"));
    assert.isTrue(nodeSupportsExecutableBuild("v25.7.0"));
    assert.isTrue(nodeSupportsExecutableBuild("26.8.1"));
  });

  it("renders package metadata and managed launchers", () => {
    const pkgbuild = renderPkgbuild({
      appImageName: "T3-Code-test.AppImage",
      appImageSha: "a".repeat(64),
      archPackageVersion: "0.0.43.fork.z1.abc",
      cliWrapperSha: "b".repeat(64),
      commit: "abcdef123456",
      desktopWrapperSha: "c".repeat(64),
      licenseSha: "d".repeat(64),
      version: "0.0.43-fork.z1.abc",
    });
    assert.include(pkgbuild, "pkgname=t3code-bin");
    assert.include(pkgbuild, "commit abcdef123");
    assert.include(pkgbuild, 'find "${pkgdir}" -type d -exec chmod 755 {} +');
    assert.include(renderCliWrapper(), "ELECTRON_RUN_AS_NODE=1");
  });

  it("renders an atomic, validated remote service deployment", () => {
    const script = renderRemoteInstallScript();
    assert.include(script, "Archive checksum mismatch");
    assert.include(script, ".install-complete");
    assert.include(script, "service install --base-dir");
    assert.include(script, "systemctl --user is-active t3code.service");
    assert.include(script, "for _attempt in {1..30}");
    assert.include(script, "--max-time 2");
    assert.include(script, "http://127.0.0.1:3773/");
  });
});
