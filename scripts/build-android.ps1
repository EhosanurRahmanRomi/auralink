param([string]$AndroidSdkRoot, [string]$JdkDirectory)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$projectConfig = Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Raw | ConvertFrom-Json
$projectVersion = $projectConfig.version
$productName = $projectConfig.build.productName
if ($productName -notmatch '^[A-Za-z0-9-]{1,60}$') { throw 'Invalid product name for Android artifact.' }
if (-not $AndroidSdkRoot) { $AndroidSdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $AndroidSdkRoot) { $AndroidSdkRoot = $env:ANDROID_HOME }
if (-not $AndroidSdkRoot) { $AndroidSdkRoot = Join-Path $projectPath '.tools/android-sdk' }
if (-not $JdkDirectory) { $JdkDirectory = $env:JAVA_HOME }
if (-not $JdkDirectory) { $JdkDirectory = (Get-ChildItem -LiteralPath (Join-Path $projectPath '.tools/jdk') -Directory | Select-Object -First 1).FullName }
$AndroidSdkRoot = (Resolve-Path -LiteralPath $AndroidSdkRoot).Path
$JdkDirectory = (Resolve-Path -LiteralPath $JdkDirectory).Path
$buildTools = Join-Path $AndroidSdkRoot 'build-tools/36.0.0'
$platformJar = Join-Path $AndroidSdkRoot 'platforms/android-36/android.jar'
foreach ($needed in @($platformJar, (Join-Path $buildTools 'aapt2.exe'), (Join-Path $buildTools 'd8.bat'), (Join-Path $JdkDirectory 'bin/javac.exe'))) {
    if (-not (Test-Path -LiteralPath $needed)) { throw "Missing build dependency: $needed" }
}
$env:JAVA_HOME = $JdkDirectory
$env:PATH = (Join-Path $JdkDirectory 'bin') + ';' + $env:PATH
$androidPath = Join-Path $projectPath 'android'
$outPath = Join-Path $androidPath 'out'
$assetsPath = Join-Path $outPath 'assets/renderer'
$classesPath = Join-Path $outPath 'classes'
$dexPath = Join-Path $outPath 'dex'
$privatePath = Join-Path $projectPath '.private'
$releasePath = Join-Path $projectPath 'release'
# A changed anonymous/lambda class must not leave executable classes from an
# earlier version in the next APK. Delete only these verified generated paths.
foreach ($generatedPath in @($classesPath, $dexPath)) {
    if (Test-Path -LiteralPath $generatedPath) {
        $resolvedGenerated = (Resolve-Path -LiteralPath $generatedPath).Path
        $resolvedOutput = (Resolve-Path -LiteralPath $outPath).Path.TrimEnd('\') + '\'
        if (-not $resolvedGenerated.StartsWith($resolvedOutput, [StringComparison]::OrdinalIgnoreCase) -or
            (Get-Item -LiteralPath $generatedPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
            (Get-Item -LiteralPath $outPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean an Android output path outside the generated build directory.' }
        Remove-Item -LiteralPath $resolvedGenerated -Recurse -Force
    }
}
foreach ($directory in @($assetsPath, $classesPath, $dexPath, $privatePath, $releasePath, (Join-Path $androidPath 'res/drawable'))) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
# All source copies are explicit; toolchains, keys and arbitrary PC files are not packaged.
foreach ($file in @('index.html','styles.css','app.js','rtc.js','android-bridge.js','internet.js','desktop-internet.js','relay-media.js','audio-worklet.js','screen-view.js','audio-mixer.js','brand-mark.png')) { Copy-Item -LiteralPath (Join-Path $projectPath "src/renderer/$file") -Destination (Join-Path $assetsPath $file) -Force }
$legalAssets = Join-Path $outPath 'assets/legal'
New-Item -ItemType Directory -Path $legalAssets -Force | Out-Null
foreach ($file in @('Java-WebSocket-LICENSE.txt','SLF4J-LICENSE.txt')) { Copy-Item -LiteralPath (Join-Path $androidPath "legal/$file") -Destination (Join-Path $legalAssets $file) -Force }
Copy-Item -LiteralPath (Join-Path $projectPath 'LICENSE') -Destination (Join-Path $legalAssets "$productName-LICENSE.txt") -Force
Copy-Item -LiteralPath (Join-Path $projectPath 'build/icon.png') -Destination (Join-Path $androidPath 'res/drawable/icon.png') -Force
function Invoke-BuildTool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build tool failed: $Tool (exit $LASTEXITCODE)" }
}
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$resources = Join-Path $outPath 'resources.zip'
$unsigned = Join-Path $outPath 'unsigned.apk'
$aligned = Join-Path $outPath 'aligned.apk'
Invoke-BuildTool $aapt2 @('compile','--no-crunch','--dir',(Join-Path $androidPath 'res'),'-o',$resources)
Invoke-BuildTool $aapt2 @('link','-o',$unsigned,'--manifest',(Join-Path $androidPath 'AndroidManifest.xml'),'-I',$platformJar,'--auto-add-overlay',$resources)
$libraries = @((Join-Path $androidPath 'libs/Java-WebSocket-1.6.0.jar'),(Join-Path $androidPath 'libs/slf4j-api-2.0.13.jar'))
$classpath = (@($platformJar) + $libraries) -join ';'
$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $androidPath 'src') -Recurse -Filter '*.java' -File | ForEach-Object { $_.FullName })
Invoke-BuildTool (Join-Path $JdkDirectory 'bin/javac.exe') (@('--release','8','-encoding','UTF-8','-classpath',$classpath,'-d',$classesPath) + $sourceFiles)
$classJar = Join-Path $outPath 'app-classes.jar'
Invoke-BuildTool (Join-Path $JdkDirectory 'bin/jar.exe') @('--create','--file',$classJar,'-C',$classesPath,'.')
Invoke-BuildTool (Join-Path $buildTools 'd8.bat') (@('--release','--min-api','29','--lib',$platformJar,'--output',$dexPath,$classJar) + $libraries)
$archive = [System.IO.Compression.ZipFile]::Open($unsigned, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    # Windows aapt2 can emit backslashes for assets. Android AssetManager
    # requires slash names, so create these fixed entries explicitly.
    foreach ($file in @('index.html','styles.css','app.js','rtc.js','android-bridge.js','internet.js','desktop-internet.js','relay-media.js','audio-worklet.js','screen-view.js','audio-mixer.js','brand-mark.png')) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $assetsPath $file), "assets/renderer/$file", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    foreach ($file in @('Java-WebSocket-LICENSE.txt','SLF4J-LICENSE.txt',"$productName-LICENSE.txt")) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $legalAssets $file), "assets/legal/$file", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    foreach ($dex in Get-ChildItem -LiteralPath $dexPath -Filter '*.dex' -File) {
        $existing = $archive.GetEntry($dex.Name); if ($existing) { $existing.Delete() }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $dex.FullName, $dex.Name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose() }
Invoke-BuildTool (Join-Path $buildTools 'zipalign.exe') @('-f','4',$unsigned,$aligned)
# Keep the same private development signing identity for later local updates.
# Git ignores it. Public/reproducible distribution signing is a separate step.
$keyStore = Join-Path $privatePath 'android-development.jks'
$passwordPath = Join-Path $privatePath 'android-signing-password.txt'
if (-not (Test-Path -LiteralPath $keyStore)) {
    $random = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($random)
    $password = [Convert]::ToBase64String($random)
    [IO.File]::WriteAllText($passwordPath, $password)
    $env:AURALINK_SIGNING_PASSWORD = $password
    Invoke-BuildTool (Join-Path $JdkDirectory 'bin/keytool.exe') @('-genkeypair','-keystore',$keyStore,'-alias','auralink-local','-keyalg','RSA','-keysize','3072','-validity','3650','-storepass:env','AURALINK_SIGNING_PASSWORD','-keypass:env','AURALINK_SIGNING_PASSWORD','-dname','CN=Auralink local development, O=Local project, C=BD')
} else { $env:AURALINK_SIGNING_PASSWORD = [IO.File]::ReadAllText($passwordPath).Trim() }
$artifact = Join-Path $releasePath "$productName-$projectVersion-Android.apk"
try {
    Invoke-BuildTool (Join-Path $buildTools 'apksigner.bat') @('sign','--ks',$keyStore,'--ks-key-alias','auralink-local','--ks-pass','env:AURALINK_SIGNING_PASSWORD','--key-pass','env:AURALINK_SIGNING_PASSWORD','--out',$artifact,$aligned)
    Invoke-BuildTool (Join-Path $buildTools 'apksigner.bat') @('verify','--verbose','--print-certs',$artifact)
} finally { Remove-Item Env:\AURALINK_SIGNING_PASSWORD -ErrorAction SilentlyContinue }
$hash = Get-FileHash -LiteralPath $artifact -Algorithm SHA256
[pscustomobject]@{Artifact=$artifact;Bytes=(Get-Item -LiteralPath $artifact).Length;SHA256=$hash.Hash;MinimumAndroid='10 / API29';TargetSDK=36;Signed=$true;Signing='Private local development key';DeviceTested=$false;BuiltAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releasePath 'Android-build.json') -Encoding UTF8
Write-Output "Android APK built: $artifact"
