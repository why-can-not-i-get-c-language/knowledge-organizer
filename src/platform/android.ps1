param([string]$ToolRoot = (Join-Path $env:LOCALAPPDATA 'KnowledgeOrganizer\toolchains'), [switch]$SignOnly)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$OutputEncoding = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = $OutputEncoding
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nativeRoot = Join-Path $projectRoot 'src\native'
$androidProject = Join-Path $nativeRoot 'gen\android'
$env:JAVA_HOME = (Get-ChildItem -LiteralPath (Join-Path $ToolRoot 'java') -Directory | Select-Object -First 1).FullName
$env:ANDROID_HOME = Join-Path $ToolRoot 'android'
$env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk\28.2.13676358'
$env:RUSTUP_HOME = Join-Path $ToolRoot 'rustup'
$env:CARGO_HOME = Join-Path $ToolRoot 'cargo'
$env:GRADLE_USER_HOME = Join-Path $ToolRoot 'gradle'
$env:CARGO_TARGET_DIR = Join-Path $ToolRoot 'android-target'
$env:PATH = "$env:CARGO_HOME\bin;$env:JAVA_HOME\bin;$env:PATH"
# 仅为本次构建继承已有本机代理，不改系统网络或用户代理配置。
if ($env:HTTPS_PROXY) {
    $proxyUri = [Uri]$env:HTTPS_PROXY
    if ($proxyUri.Scheme -eq 'http' -and $proxyUri.IsLoopback -and -not $proxyUri.UserInfo) {
        $env:JAVA_TOOL_OPTIONS = "$env:JAVA_TOOL_OPTIONS -Dhttp.proxyHost=$($proxyUri.Host) -Dhttp.proxyPort=$($proxyUri.Port) -Dhttps.proxyHost=$($proxyUri.Host) -Dhttps.proxyPort=$($proxyUri.Port)"
    }
}
$buildTools = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0'
foreach ($required in @("$env:JAVA_HOME\bin\java.exe", "$env:CARGO_HOME\bin\cargo.exe", "$buildTools\apksigner.bat", "$env:NDK_HOME\source.properties")) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing Android build dependency: $required" }
}
function Assert-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)" } }
Push-Location $projectRoot
try {
  if (-not $SignOnly) {
    & npm.cmd run typecheck
    Assert-Exit 'TypeScript check'
    & npm.cmd run build
    Assert-Exit 'Frontend build'
    Push-Location $nativeRoot
    try {
        $buildLines = New-Object 'System.Collections.Generic.List[string]'
        $ErrorActionPreference = 'Continue'
        & node (Join-Path $projectRoot 'node_modules\@tauri-apps\cli\tauri.js') android build --apk --target aarch64 2>&1 | ForEach-Object {
            $line = $_.ToString(); Write-Host $line; [void]$buildLines.Add($line)
        }
        $tauriExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
    } finally { Pop-Location }
    if ($tauriExit -ne 0) {
        if (($buildLines -join "`n") -notmatch 'Creation symbolic link is not allowed') { throw 'Tauri Android build failed; see output above.' }
        # Windows未启用符号链接时，用刚编译的原生库副本交给同一个Gradle工程。
        $lib = Join-Path $env:CARGO_TARGET_DIR 'aarch64-linux-android\release\libknowledge_organizer_lib.so'
        if (-not (Test-Path -LiteralPath $lib)) { throw 'Compiled Android library not found.' }
        $jni = Join-Path $androidProject 'app\src\main\jniLibs\arm64-v8a'
        [void](New-Item -ItemType Directory -Force -Path $jni)
        Copy-Item -LiteralPath $lib -Destination (Join-Path $jni 'libknowledge_organizer_lib.so') -Force
        $ndkBin = Join-Path $env:NDK_HOME 'toolchains\llvm\prebuilt\windows-x86_64\bin'
        $dynamicInfo = & (Join-Path $ndkBin 'llvm-readelf.exe') -d $lib
        Assert-Exit 'ELF dependency inspection'
        $symbols = & (Join-Path $ndkBin 'llvm-readelf.exe') --dyn-syms $lib
        Assert-Exit 'JNI symbol inspection'
        if (($symbols -join "`n") -notmatch 'Java_app_tauri_plugin_PluginManager_handlePluginResponse') { throw 'Tauri mobile entry point missing.' }
        if (($dynamicInfo -join "`n") -match 'libc\+\+_shared.so') {
            Copy-Item -LiteralPath (Join-Path $env:NDK_HOME 'toolchains\llvm\prebuilt\windows-x86_64\sysroot\usr\lib\aarch64-linux-android\libc++_shared.so') -Destination $jni -Force
        }
        $assetDir = Join-Path $androidProject 'app\src\main\assets'
        [void](New-Item -ItemType Directory -Force -Path $assetDir)
        Copy-Item -LiteralPath (Join-Path $nativeRoot 'tauri.conf.json') -Destination (Join-Path $assetDir 'tauri.conf.json') -Force
        Push-Location $androidProject
        try {
            & .\gradlew.bat --no-daemon --console=plain :app:assembleArm64Release -x :app:rustBuildArm64Release -PabiList=arm64-v8a -ParchList=arm64 -PtargetList=aarch64
            Assert-Exit 'Gradle APK packaging'
        } finally { Pop-Location }
    }
  }
    $unsigned = Join-Path $androidProject 'app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk'
    if (-not (Test-Path -LiteralPath $unsigned)) { throw 'Unsigned APK not found.' }
    # 签名密钥与DPAPI加密口令仅存在本机应用目录，后续升级复用，绝不进入仓库。
    $signingRoot = Join-Path $env:LOCALAPPDATA 'KnowledgeOrganizer\signing'
    [void](New-Item -ItemType Directory -Force -Path $signingRoot)
    $keyFile = Join-Path $signingRoot 'android-release.p12'
    $passwordFile = Join-Path $signingRoot 'android-release.password'
    if ((Test-Path -LiteralPath $keyFile) -and -not (Test-Path -LiteralPath $passwordFile)) { throw 'Signing password missing; preserve the existing keystore.' }
    if (-not (Test-Path -LiteralPath $passwordFile)) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $securePassword = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
        ConvertFrom-SecureString $securePassword | Set-Content -LiteralPath $passwordFile
    }
    $secret = ConvertTo-SecureString (Get-Content -LiteralPath $passwordFile -Raw).Trim()
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { $env:KO_APK_SIGN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if (-not (Test-Path -LiteralPath $keyFile)) {
        & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -keystore $keyFile -storetype PKCS12 -alias knowledge-organizer -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Knowledge Organizer,O=Local Development,C=CN' -storepass:env KO_APK_SIGN_PASSWORD -keypass:env KO_APK_SIGN_PASSWORD
        Assert-Exit 'APK signing key generation'
    }
    $version = (Get-Content -LiteralPath (Join-Path $nativeRoot 'tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $releaseDir = Join-Path $projectRoot 'release'
    [void](New-Item -ItemType Directory -Force -Path $releaseDir)
    $aligned = Join-Path $releaseDir 'android-aligned.tmp.apk'
    $apk = Join-Path $releaseDir "knowledge-organizer-$version-arm64.apk"
    & (Join-Path $buildTools 'zipalign.exe') -P 16 -f 4 $unsigned $aligned
    Assert-Exit 'APK alignment'
    & (Join-Path $buildTools 'apksigner.bat') sign --v4-signing-enabled false --ks $keyFile --ks-key-alias knowledge-organizer --ks-pass env:KO_APK_SIGN_PASSWORD --key-pass env:KO_APK_SIGN_PASSWORD --out $apk $aligned
    Assert-Exit 'APK signing'
    & (Join-Path $buildTools 'apksigner.bat') verify --verbose $apk
    Assert-Exit 'APK signature verification'
    # aapt不接受Windows中文绝对路径，从产物目录使用ASCII文件名读取。
    Push-Location $releaseDir
    try {
        & (Join-Path $buildTools 'aapt.exe') dump badging ([IO.Path]::GetFileName($apk))
        Assert-Exit 'APK manifest inspection'
    } finally { Pop-Location }
    Write-Host "APK ready: $apk"
} finally {
    Remove-Item Env:KO_APK_SIGN_PASSWORD -ErrorAction SilentlyContinue
    if ($aligned -and (Test-Path -LiteralPath $aligned)) { Remove-Item -LiteralPath $aligned -Force }
    Pop-Location
}
