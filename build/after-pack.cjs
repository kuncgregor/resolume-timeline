// No Developer ID on this machine: sign the app ad hoc so macOS accepts it as one app
// (a valid signature is what the microphone permission for LTC input is bound to)
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', context.packager.appInfo.id, app], { stdio: 'inherit' })
}
