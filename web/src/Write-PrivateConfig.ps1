[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidatePath,
    [Parameter(Mandatory)][string]$OwnerRoot,
    [Parameter(Mandatory)][string]$OwnerId
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$temporary = ''
$stage = 'placement'
try {
    $root = [IO.Path]::GetFullPath($OwnerRoot)
    $expected = [IO.Path]::GetFullPath((Join-Path $root 'data\private-config'))
    $candidate = [IO.Path]::GetFullPath($CandidatePath)
    if ([IO.Path]::GetDirectoryName($candidate) -cne $expected) { throw 'placement_refused' }
    $cursor = $candidate
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'link_refused' }
        $next = [IO.Path]::GetDirectoryName($cursor)
        if ($next -eq $cursor) { break }
        $cursor = $next
    }
    $path = [IO.Path]::GetFullPath($CandidatePath)
    $parent = [IO.Path]::GetDirectoryName($path)
    # This capability owns only a dedicated private-config directory, never an
    # arbitrary existing business directory or legacy credential location.
    if ([IO.Path]::GetFileName($parent) -cne 'private-config') { throw 'private_directory_required' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $allowed = @($sid.Value, $systemSid.Value)
    $directoryAcl = [Security.AccessControl.DirectorySecurity]::new()
    $directoryAcl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid, $systemSid)) {
        $directoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    $grandparent = [IO.Path]::GetDirectoryName($parent)
    $stage = 'directory'
    [IO.Directory]::CreateDirectory($grandparent) | Out-Null
    # Security descriptor is attached when the directory is created, before
    # the first secret byte or temporary file exists.
    [IO.Directory]::CreateDirectory($parent, $directoryAcl) | Out-Null
    $stage = 'acl'
    foreach ($checkPath in @($parent, $path)) {
        if (-not (Test-Path -LiteralPath $checkPath)) { continue }
        $acl = Get-Acl -LiteralPath $checkPath
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) { throw 'private_acl_required' }
        }
    }
    $body = [Console]::In.ReadToEnd()
    $stage = 'input'
    $null = $body | ConvertFrom-Json -ErrorAction Stop
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $stage = 'write'
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($body); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $stage = 'replace'
    if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($temporary,$path,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$path) }
    $temporary = ''
    '{"status":"saved","secretReturned":false}'
} catch {
    # Do not print input, provider keys, or an exception carrying private JSON.
    'Private configuration save refused: ' + $stage + ' (' + $_.Exception.GetType().Name + ').'
    exit 1
} finally {
    if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
