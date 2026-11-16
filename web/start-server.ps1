$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $PSScriptRoot 'src\server.mjs'
$url = 'http://127.0.0.1:4577/api/health'
function Test-AiImgGenReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}
if (-not (Test-Path -LiteralPath $server)) {
    Write-Error "Web server not found: $server"
    exit 1
}
if (-not (Test-AiImgGenReady)) {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $env:AI_IMG_GEN_AI_PROMPT_WRITER_ENABLED = 'true'
    $bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (-not $env:AI_IMG_GEN_PYTHON -and (Test-Path -LiteralPath $bundledPython)) {
        $env:AI_IMG_GEN_PYTHON = $bundledPython
    }
    $process = Start-Process -FilePath $node -ArgumentList @($server) -WorkingDirectory $root -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-AiImgGenReady) { break }
        if ($process.HasExited) { break }
    }
}
if (-not (Test-AiImgGenReady)) {
    Write-Error "Web service did not become ready at $url"
    exit 1
}
exit 0
