param([switch]$Register, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$nativeName = 'com.salesmartly.local_archive'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$nativeName"
if ($Unregister) {
    if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
    Write-Output 'Native host registration removed. Archive files were retained.'
    exit 0
}
$buildInfoPath = Join-Path $taskRoot 'dist\build-info.json'
if (-not (Test-Path -LiteralPath $buildInfoPath)) { throw 'Build first: npm run build' }
$buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
$nativeDirectory = Join-Path $taskRoot '.local\native'
New-Item -ItemType Directory -Path $nativeDirectory -Force | Out-Null
$configPath = Join-Path $nativeDirectory 'config.json'
$launcherPath = Join-Path $nativeDirectory 'salesmartly-native.exe'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, (@{ archiveRoot=$buildInfo.archiveRoot; extensionId=$buildInfo.extensionId } | ConvertTo-Json), $utf8)
[System.IO.File]::WriteAllText((Join-Path $nativeDirectory 'launcher.json'), (@{ nodePath=$buildInfo.nodePath; nativeEntry=$buildInfo.nativeEntry; configPath=$configPath } | ConvertTo-Json), $utf8)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler was not found.' }
& $compiler /nologo /target:exe /optimize+ /reference:System.Web.Extensions.dll "/out:$launcherPath" (Join-Path $PSScriptRoot 'NativeLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native launcher compilation failed.' }
$manifestPath = Join-Path $nativeDirectory "$nativeName.json"
[System.IO.File]::WriteAllText($manifestPath, (@{ name=$nativeName; description='SaleSmartly local chat archive'; path=$launcherPath; type='stdio'; allowed_origins=@("chrome-extension://$($buildInfo.extensionId)/") } | ConvertTo-Json), $utf8)
if ($Register) {
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $manifestPath
    Write-Output 'Registered the native host for the current Windows user.'
}
Write-Output "Native manifest: $manifestPath"
Write-Output "Extension ID: $($buildInfo.extensionId)"
Write-Output "Load unpacked in your existing Chrome Profile: $($buildInfo.extensionDir)"
