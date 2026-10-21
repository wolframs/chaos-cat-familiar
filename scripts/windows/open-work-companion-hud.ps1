param(
    [string]$SettingsPath = [IO.Path]::Combine($env:APPDATA, 'chaos-cat-familiar', 'settings.json')
)

# The work-companion shortcut calls this instead of opening a Windows Terminal
# tab. Only CCF's authenticated local endpoint may start the Claude session.
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(1)

function Get-CcfConnection {
    if (-not [IO.File]::Exists($SettingsPath)) { return $null }
    $json = $null
    try {
        $json = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($SettingsPath))
        $portElement = [Text.Json.JsonElement]::new()
        $tokenElement = [Text.Json.JsonElement]::new()
        if (-not $json.RootElement.TryGetProperty('port', [ref]$portElement)) { return $null }
        if (-not $json.RootElement.TryGetProperty('hookToken', [ref]$tokenElement)) { return $null }
        $port = $portElement.GetInt32()
        $token = $tokenElement.GetString()
        if ($port -lt 1 -or $port -gt 65535 -or -not $token) { return $null }
        return @{ Port = $port; Token = $token }
    } catch { return $null }
    finally { if ($null -ne $json) { $json.Dispose() } }
}

function Test-CcfHealth($connection) {
    if ($null -eq $connection) { return $false }
    $response = $null
    try {
        $response = $client.GetAsync("http://127.0.0.1:$($connection.Port)/health").GetAwaiter().GetResult()
        return $response.IsSuccessStatusCode
    } catch { return $false }
    finally { if ($null -ne $response) { $response.Dispose() } }
}

try {
    $connection = Get-CcfConnection
    if (-not (Test-CcfHealth $connection)) {
        $repoRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
        $electronExe = [IO.Path]::Combine($repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
        $shellDir = [IO.Path]::Combine($repoRoot, 'apps', 'windows-shell')
        if (-not [IO.File]::Exists($electronExe)) { throw "CCF Electron is missing: $electronExe" }
        Start-Process -FilePath $electronExe -ArgumentList @($shellDir) -WorkingDirectory $shellDir -WindowStyle Hidden
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 200
            $connection = Get-CcfConnection
        } until ((Test-CcfHealth $connection) -or [DateTime]::UtcNow -ge $deadline)
        if (-not (Test-CcfHealth $connection)) { throw 'CCF did not become ready.' }
    }

    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,
        "http://127.0.0.1:$($connection.Port)/companion/open")
    try {
        $request.Headers.Add('x-ccf-token', $connection.Token)
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            if (-not $response.IsSuccessStatusCode) {
                $detail = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                throw "CCF companion open failed ($([int]$response.StatusCode)): $detail"
            }
        } finally { $response.Dispose() }
    } finally { $request.Dispose() }
} finally { $client.Dispose() }
