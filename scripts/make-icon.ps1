param([string]$SourcePng, [string]$DestinationIco)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskProject = Split-Path -Parent $PSScriptRoot
if (-not $SourcePng) { $SourcePng = Join-Path $taskProject 'build/icon.png' }
if (-not $DestinationIco) { $DestinationIco = Join-Path $taskProject 'build/icon.ico' }
$SourcePng = (Resolve-Path -LiteralPath $SourcePng).Path
$DestinationIco = [IO.Path]::GetFullPath($DestinationIco)
if ($SourcePng -eq $DestinationIco) { throw 'ICO destination cannot overwrite the canonical PNG.' }
# The supplied PNG is canonical. Never draw a replacement or overwrite it.
$taskCanonicalHash = (Get-FileHash -LiteralPath $SourcePng -Algorithm SHA256).Hash
$taskImage = [Drawing.Image]::FromFile($SourcePng)
$taskImages = [Collections.Generic.List[byte[]]]::new()
$taskSizes = @(16, 32, 48, 64, 128, 256)
try {
    foreach ($taskSize in $taskSizes) {
        $taskBitmap = [Drawing.Bitmap]::new($taskSize, $taskSize)
        $taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
        $taskMemory = [IO.MemoryStream]::new()
        try {
            $taskGraphics.Clear([Drawing.Color]::Transparent)
            $taskGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $taskGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $taskScale = [Math]::Min($taskSize / $taskImage.Width, $taskSize / $taskImage.Height)
            $taskWidth = [int][Math]::Round($taskImage.Width * $taskScale)
            $taskHeight = [int][Math]::Round($taskImage.Height * $taskScale)
            $taskGraphics.DrawImage($taskImage, [int](($taskSize-$taskWidth)/2), [int](($taskSize-$taskHeight)/2), $taskWidth, $taskHeight)
            $taskBitmap.Save($taskMemory, [Drawing.Imaging.ImageFormat]::Png)
            $taskImages.Add($taskMemory.ToArray())
        } finally { $taskMemory.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose() }
    }
} finally { $taskImage.Dispose() }
[IO.Directory]::CreateDirectory((Split-Path -Parent $DestinationIco)) | Out-Null
$taskStream = [IO.File]::Create($DestinationIco)
$taskWriter = [IO.BinaryWriter]::new($taskStream)
try {
    $taskWriter.Write([uint16]0); $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]$taskSizes.Count)
    $taskOffset = 6 + (16 * $taskSizes.Count)
    for ($taskIndex = 0; $taskIndex -lt $taskSizes.Count; $taskIndex++) {
        $taskDimension = if ($taskSizes[$taskIndex] -eq 256) { 0 } else { $taskSizes[$taskIndex] }
        $taskWriter.Write([byte]$taskDimension); $taskWriter.Write([byte]$taskDimension)
        $taskWriter.Write([byte]0); $taskWriter.Write([byte]0)
        $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]32)
        $taskWriter.Write([uint32]$taskImages[$taskIndex].Length); $taskWriter.Write([uint32]$taskOffset)
        $taskOffset += $taskImages[$taskIndex].Length
    }
    foreach ($taskBytes in $taskImages) { $taskWriter.Write($taskBytes) }
} finally { $taskWriter.Dispose() }
if ((Get-FileHash -LiteralPath $SourcePng -Algorithm SHA256).Hash -ne $taskCanonicalHash) { throw 'Canonical PNG changed during icon conversion.' }
Write-Output "Glance-Port ICO converted from the supplied PNG: $DestinationIco"
