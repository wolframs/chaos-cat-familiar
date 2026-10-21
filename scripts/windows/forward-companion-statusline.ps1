param(
    [Parameter(Mandatory=$true)][string]$Payload,
    [string]$SettingsPath = [IO.Path]::Combine($env:APPDATA, 'chaos-cat-familiar', 'settings.json'),
    [string]$CompanionPath = [IO.Path]::Combine($HOME, 'repos', 'work-companion')
)

# Called in-process by the Windows dotfiles status line. It does not render
# anything, write to stdout, or start Claude Code. Failure leaves CC's line alone.
$client = $null
$content = $null
$response = $null
$payloadJson = $null
$settingsJson = $null
try {
    $payloadJson = [Text.Json.JsonDocument]::Parse($Payload)
    $cwdElement = [Text.Json.JsonElement]::new()
    if (-not $payloadJson.RootElement.TryGetProperty('cwd', [ref]$cwdElement)) {
        $workspace = [Text.Json.JsonElement]::new()
        if (-not $payloadJson.RootElement.TryGetProperty('workspace', [ref]$workspace)) { return }
        if (-not $workspace.TryGetProperty('current_dir', [ref]$cwdElement)) { return }
    }
    $cwd = $cwdElement.GetString()
    if (-not $cwd) { return }
    $actual = [IO.Path]::GetFullPath($cwd).TrimEnd([char[]]@('\', '/'))
    $expected = [IO.Path]::GetFullPath($CompanionPath).TrimEnd([char[]]@('\', '/'))
    if (-not [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) { return }
    if (-not [IO.File]::Exists($SettingsPath)) { return }

    $settingsJson = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($SettingsPath))
    $portElement = [Text.Json.JsonElement]::new()
    $tokenElement = [Text.Json.JsonElement]::new()
    if (-not $settingsJson.RootElement.TryGetProperty('port', [ref]$portElement)) { return }
    if (-not $settingsJson.RootElement.TryGetProperty('hookToken', [ref]$tokenElement)) { return }
    $port = $portElement.GetInt32()
    $token = $tokenElement.GetString()
    if ($port -lt 1 -or $port -gt 65535 -or -not $token) { return }

    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromMilliseconds(300)
    $client.DefaultRequestHeaders.Add('x-ccf-token', $token)
    $content = [Net.Http.StringContent]::new($Payload, [Text.UTF8Encoding]::new($false), 'application/json')
    $response = $client.PostAsync("http://127.0.0.1:$port/companion/status", $content).GetAwaiter().GetResult()
} catch {
    # A missing/stopped CCF must never blank or slow the Claude status line.
} finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $content) { $content.Dispose() }
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $settingsJson) { $settingsJson.Dispose() }
    if ($null -ne $payloadJson) { $payloadJson.Dispose() }
}
