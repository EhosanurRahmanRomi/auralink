param([string]$ApkPath, [string]$AndroidSdkRoot, [string]$JdkDirectory)

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$projectVersion = (Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Raw | ConvertFrom-Json).version
if (-not $ApkPath) { $ApkPath = Join-Path $projectPath "release/Auralink-$projectVersion-Android.apk" }
if (-not $AndroidSdkRoot) { $AndroidSdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $AndroidSdkRoot) { $AndroidSdkRoot = $env:ANDROID_HOME }
if (-not $AndroidSdkRoot) { $AndroidSdkRoot = Join-Path $projectPath '.tools/android-sdk' }
if (-not $JdkDirectory) { $JdkDirectory = $env:JAVA_HOME }
if (-not $JdkDirectory) { $JdkDirectory = (Get-ChildItem -LiteralPath (Join-Path $projectPath '.tools/jdk') -Directory | Select-Object -First 1).FullName }
$ApkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$AndroidSdkRoot = (Resolve-Path -LiteralPath $AndroidSdkRoot).Path
$JdkDirectory = (Resolve-Path -LiteralPath $JdkDirectory).Path
$toolsPath = Join-Path $AndroidSdkRoot 'build-tools/36.0.0'
$aaptPath = Join-Path $toolsPath 'aapt.exe'
$javaPath = Join-Path $JdkDirectory 'bin/java.exe'
$apksignerPath = Join-Path $toolsPath 'lib/apksigner.jar'
$evidencePath = Join-Path $projectPath 'test-results/android-apk-validation.json'
foreach ($needed in @($aaptPath, $javaPath, $apksignerPath)) {
    if (-not (Test-Path -LiteralPath $needed)) { throw "Missing verification tool: $needed" }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $evidencePath) | Out-Null
$evidence = [ordered]@{ StartedAt=(Get-Date).ToUniversalTime().ToString('o'); Passed=$false; DeviceTested=$false; DeviceInstallationExecuted=$false; Checks=@(); Caveats=@('No installation, launch, camera, microphone or networking test on a real Android device or emulator was performed.','Android capture/input use MediaProjection and Accessibility, require separate owner approvals, and need physical-device validation.','Reliable cross-network connectivity and sustained high-resolution quality depend on actual devices and networks.','APK uses a private local development signing identity; public app-store distribution is untested.') }

function Invoke-VerificationTool([string]$Tool, [string[]]$Arguments) {
    $lines = @(& $Tool @Arguments 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { throw "Verification tool failed: $Tool (exit $LASTEXITCODE): $($lines -join [Environment]::NewLine)" }
    return ($lines -join [Environment]::NewLine)
}
function Assert-Verification([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-BytesSHA256([byte[]]$Bytes) {
    $digest = [System.Security.Cryptography.SHA256]::HashData($Bytes)
    return [Convert]::ToHexString($digest).ToLowerInvariant()
}
function Read-ApkEntry($Archive, [string]$Name) {
    $entry = $Archive.GetEntry($Name)
    if ($null -eq $entry) { throw "APK entry is missing: $Name" }
    $stream = $entry.Open()
    $memory = [IO.MemoryStream]::new()
    try { $stream.CopyTo($memory); return ,($memory.ToArray()) }
    finally { $stream.Dispose(); $memory.Dispose() }
}

try {
    $artifact = Get-Item -LiteralPath $ApkPath
    $artifactHash = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $evidence.Artifact = [ordered]@{ Path=$ApkPath; Bytes=$artifact.Length; SHA256=$artifactHash }
    $badging = Invoke-VerificationTool $aaptPath @('dump','badging',$ApkPath)
    $manifest = Invoke-VerificationTool $aaptPath @('dump','xmltree',$ApkPath,'AndroidManifest.xml')
    $projectVersion = (Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Raw | ConvertFrom-Json).version
    [xml]$sourceManifest = Get-Content -LiteralPath (Join-Path $projectPath 'android/AndroidManifest.xml') -Raw
    $sourceVersionCode = $sourceManifest.manifest.GetAttribute('versionCode', 'http://schemas.android.com/apk/res/android')
    Assert-Verification ($sourceVersionCode -match '^[1-9][0-9]{0,9}$' -and [long]$sourceVersionCode -le 2100000000) 'Android source manifest versionCode must be a positive Android release number'
    $expectedVersionCode = [int]$sourceVersionCode
    $sourceVersionName = $sourceManifest.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
    Assert-Verification ($sourceVersionName -ceq $projectVersion) 'Android source manifest versionName does not match package.json'
    Assert-Verification ($badging -match "package: name='local\.auralink\.mobile' versionCode='$expectedVersionCode' versionName='$([regex]::Escape($projectVersion))'") 'APK package/version does not match local.auralink.mobile and current project manifest'
    $actualVersionCode = [int][regex]::Match($badging, "versionCode='([0-9]+)'").Groups[1].Value
    Assert-Verification ($badging -match "sdkVersion:'29'") 'APK minimum Android SDK must be API29'
    Assert-Verification ($badging -match "targetSdkVersion:'36'") 'APK target Android SDK must be API36'
    Assert-Verification ($badging -match "launchable-activity: name='local\.auralink\.mobile\.MainActivity'") 'APK launcher must be MainActivity'
    Assert-Verification ($manifest -match 'android:debuggable\(.*?\)=\(type 0x12\)0x0') 'APK debuggable flag must be explicitly false'
    Assert-Verification ($manifest -match 'android:allowBackup\(.*?\)=\(type 0x12\)0x0') 'APK backup flag must be false'
    Assert-Verification ($manifest -match 'android:usesCleartextTraffic\(.*?\)=\(type 0x12\)0x0') 'APK must disable cleartext network traffic'
    Assert-Verification ($manifest -match 'android:exported\(.*?\)=\(type 0x12\)0xffffffff') 'APK launcher must be exported'
    $permissions = @([regex]::Matches($badging, "uses-permission: name='([^']+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object)
    $expectedPermissions = @('android.permission.INTERNET','android.permission.CAMERA','android.permission.RECORD_AUDIO','android.permission.ACCESS_NETWORK_STATE','android.permission.MODIFY_AUDIO_SETTINGS','android.permission.FOREGROUND_SERVICE','android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION','android.permission.FOREGROUND_SERVICE_MICROPHONE','android.permission.FOREGROUND_SERVICE_CAMERA','android.permission.POST_NOTIFICATIONS' | Sort-Object)
    Assert-Verification (($permissions -join ',') -ceq ($expectedPermissions -join ',')) 'APK permissions differ from the expected calling, capture-service and audio-routing permissions'
    $optionalFeatures = @('android.hardware.camera.any','android.hardware.camera','android.hardware.camera.autofocus','android.hardware.microphone')
    foreach ($feature in $optionalFeatures) {
        Assert-Verification ($badging -match "uses-feature-not-required: name='$([regex]::Escape($feature))'") "APK hardware feature must be optional: $feature"
    }
    $evidence.Manifest = [ordered]@{ Package='local.auralink.mobile'; VersionName=$projectVersion; VersionCode=$actualVersionCode; MinimumSDK=29; TargetSDK=36; MainActivity='local.auralink.mobile.MainActivity'; Debuggable=$false; AllowBackup=$false; UsesCleartextTraffic=$false; LauncherExported=$true; Permissions=$permissions; OptionalHardwareFeatures=$optionalFeatures }
    $evidence.Checks += 'Actual binary manifest has expected package, launcher, SDK levels, non-debuggable/security flags and ten reviewed calling, capture-service, notification and audio-routing permissions'

    $signature = Invoke-VerificationTool $javaPath @('-jar',$apksignerPath,'verify','--verbose','--print-certs','--min-sdk-version','29',$ApkPath)
    Assert-Verification ($signature -match 'Verified using v3 scheme .*: true') 'APK v3 signature verification failed'
    $v2 = $signature -match 'Verified using v2 scheme .*: true'
    $certificate = [regex]::Match($signature, 'Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})')
    Assert-Verification $certificate.Success 'Verified signing certificate fingerprint was not reported'
    $subject = [regex]::Match($signature, 'Signer #1 certificate DN: (.+)').Groups[1].Value.Trim()
    $evidence.Signature = [ordered]@{ Verified=$true; MinimumSDKVerified=29; V2=$v2; V3=$true; CertificateSHA256=$certificate.Groups[1].Value.ToLowerInvariant(); Subject=$subject; Identity='Local development signing key'; PublicStoreDistributionTested=$false }
    $evidence.Checks += 'apksigner verifies actual APK signature for Android API29 minimum, including v3, and reports public certificate SHA256'

    $archive = [IO.Compression.ZipFile]::OpenRead($ApkPath)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
        Assert-Verification ($entryNames -contains 'AndroidManifest.xml') 'Binary Android manifest is missing from APK'
        Assert-Verification (@($entryNames | Where-Object { $_.Contains('\') }).Count -eq 0) 'APK entry names must use Android-compatible forward slashes'
        Assert-Verification ($entryNames -contains 'res/drawable/icon.png') 'APK icon resource is missing'
        Assert-Verification ($entryNames -contains 'resources.arsc') 'APK compiled resource table is missing'
        foreach ($legal in @('Auralink-LICENSE.txt','Java-WebSocket-LICENSE.txt','SLF4J-LICENSE.txt')) {
            Assert-Verification ($entryNames -contains "assets/legal/$legal") "APK legal notice is missing: $legal"
        }
        Assert-Verification (@($entryNames | Where-Object { $_ -match '^lib/.+\.so$' }).Count -eq 0) 'APK unexpectedly includes ABI-specific native libraries'
        $dex = Read-ApkEntry $archive 'classes.dex'
        $dexMagic = [Text.Encoding]::ASCII.GetString($dex, 0, 8)
        Assert-Verification ($dexMagic -match '^dex\n0[0-9]{2}\x00$') 'APK classes.dex does not contain a valid DEX header'
        $dexText = [Text.Encoding]::ASCII.GetString($dex)
        foreach ($class in @('Llocal/auralink/mobile/MainActivity;','Llocal/auralink/mobile/PinnedTls;','Llocal/auralink/mobile/PinnedRoomClient;','Llocal/auralink/mobile/Invitation;','Llocal/auralink/mobile/InternetServiceEndpoint;','Llocal/auralink/mobile/RoomMembership;','Llocal/auralink/mobile/ProjectionOwnership;','Llocal/auralink/mobile/ScreenShareService;','Llocal/auralink/mobile/AttendedAccessibilityService;','Llocal/auralink/mobile/AttendedControlPolicy;','Llocal/auralink/mobile/CallAudio;')) {
            Assert-Verification ($dexText.Contains($class)) "APK classes.dex is missing required native class: $class"
        }
        $assetResults = @()
        foreach ($file in @('index.html','styles.css','app.js','rtc.js','android-bridge.js','internet.js','desktop-internet.js')) {
            $packagedBytes = Read-ApkEntry $archive "assets/renderer/$file"
            $sourceHash = (Get-FileHash -LiteralPath (Join-Path $projectPath "src/renderer/$file") -Algorithm SHA256).Hash.ToLowerInvariant()
            $packagedHash = Get-BytesSHA256 $packagedBytes
            $assetResults += [ordered]@{ Path="assets/renderer/$file"; SourceSHA256=$sourceHash; PackagedSHA256=$packagedHash; Matches=($sourceHash -ceq $packagedHash) }
            Assert-Verification ($sourceHash -ceq $packagedHash) "APK renderer asset differs from current source: $file"
        }
        $privateEntries = @($entryNames | Where-Object { $_ -match '(?i)(\.jks$|\.keystore$|signing-password|(^|/)\.private/|(^|/)\.tools/|^android/libs/|^src/.*\.java$)' })
        Assert-Verification ($privateEntries.Count -eq 0) 'APK unexpectedly contains private keys, build tools or unrequested project source'
        $evidence.Contents = [ordered]@{ EntryCount=$entryNames.Count; EntryPathsUseForwardSlashes=$true; IconAndResourceTablePresent=$true; LegalNoticesPresent=$true; HasClassesDEX=$true; ABIIndependentDEX=$true; DEXBytes=$dex.Length; DEXSHA256=(Get-BytesSHA256 $dex); RequiredNativeClassesPresent=$true; PrivateBuildMaterialPresent=$false; RendererAssets=$assetResults; AllRendererAssetsMatch=$true }
        $evidence.Checks += 'APK includes executable DEX/native class descriptors and all seven renderer assets match current source SHA256 without private build material'
    } finally { $archive.Dispose() }
    $buildRecordPath = Join-Path $projectPath 'release/Android-build.json'
    if (Test-Path -LiteralPath $buildRecordPath) {
        $build = Get-Content -LiteralPath $buildRecordPath -Raw | ConvertFrom-Json
        Assert-Verification ($build.SHA256.ToLowerInvariant() -ceq $artifactHash) 'Android build record hash differs from actual APK'
        Assert-Verification ([long]$build.Bytes -eq $artifact.Length) 'Android build record size differs from actual APK'
        $evidence.BuildRecordMatches = $true
        $evidence.Checks += 'Android-build.json size/hash agree with the actual binary'
    }
    $evidence.Passed = $true
    Write-Output 'Android APK verification passed: manifest, signatures, DEX and renderer source parity. No device installation or phone testing performed.'
} catch {
    $evidence.Failure = $_.Exception.Message
    throw
} finally {
    $evidence.FinishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $evidence | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
    Write-Output "Evidence: $evidencePath"
}
