const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

// identity:null skips electron-builder signing entirely, which leaves the
// bundle with a bare linker signature and no resource seal. Re-seal the whole
// bundle ad-hoc so the signature is at least internally consistent — without
// this, macOS refuses to launch the app on Apple Silicon.
//
// This is not distribution signing: opening it on another Mac still requires
// clearing the quarantine attribute, or a Developer ID and notarization.
exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
