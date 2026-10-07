Add-Type -AssemblyName System.Drawing
$taskIconDir = Join-Path $PSScriptRoot '..\build'
[System.IO.Directory]::CreateDirectory($taskIconDir) | Out-Null
$taskBitmap = New-Object System.Drawing.Bitmap 256,256
$taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
$taskGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$taskGraphics.Clear([System.Drawing.Color]::FromArgb(255,11,18,32))
$taskBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,68,222,181))
$taskFont = New-Object System.Drawing.Font 'Segoe UI',150,([System.Drawing.FontStyle]::Bold),([System.Drawing.GraphicsUnit]::Pixel)
$taskGraphics.DrawString('a',$taskFont,$taskBrush,48,20)
$taskPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255,255,255,255)),10
$taskGraphics.DrawArc($taskPen,64,62,132,132,15,115)
$taskPng = Join-Path $taskIconDir 'icon.png'
$taskBitmap.Save($taskPng,[System.Drawing.Imaging.ImageFormat]::Png)
$taskBytes=[System.IO.File]::ReadAllBytes($taskPng)
$taskStream=[System.IO.File]::Create((Join-Path $taskIconDir 'icon.ico'))
$taskWriter=New-Object System.IO.BinaryWriter $taskStream
$taskWriter.Write([uint16]0);$taskWriter.Write([uint16]1);$taskWriter.Write([uint16]1)
$taskWriter.Write([byte]0);$taskWriter.Write([byte]0);$taskWriter.Write([byte]0);$taskWriter.Write([byte]0)
$taskWriter.Write([uint16]1);$taskWriter.Write([uint16]32);$taskWriter.Write([uint32]$taskBytes.Length);$taskWriter.Write([uint32]22)
$taskWriter.Write($taskBytes);$taskWriter.Dispose();$taskGraphics.Dispose();$taskBitmap.Dispose();$taskBrush.Dispose();$taskFont.Dispose();$taskPen.Dispose()
Write-Output 'Auralink PNG and ICO generated.'
