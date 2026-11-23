# Puts a process into a new Windows job object that kills every process in it when the job's last handle closes, and
# hands that last handle to the process itself (process-split plan, step 4). The companion process runs this once,
# before it starts any child: everything it starts afterwards (Claude's PTY and whatever Claude starts, codex
# app-server, the habitat bridge and watcher) is in the job and ends when the companion process ends, crash included.
# Children may still leave the job explicitly (CREATE_BREAKAWAY_FROM_JOB). Prints the handle value on success.
param([Parameter(Mandatory = $true)][int]$TargetPid)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace Ccf -Name KillOnCloseJob -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll")]
public static extern IntPtr GetCurrentProcess();
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target,
  uint access, bool inherit, uint options);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr handle);
'@

function Fail([string]$step) {
  throw "$step failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

# PROCESS_TERMINATE | PROCESS_DUP_HANDLE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION
$target = [Ccf.KillOnCloseJob]::OpenProcess(0x1141, $false, $TargetPid)
if ($target -eq [IntPtr]::Zero) { Fail 'OpenProcess' }
$job = [Ccf.KillOnCloseJob]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { Fail 'CreateJobObject' }
try {
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes on x64); LimitFlags at offset 16:
  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000) | JOB_OBJECT_LIMIT_BREAKAWAY_OK (0x800).
  $size = 144
  $info = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    for ($offset = 0; $offset -lt $size; $offset += 8) { [Runtime.InteropServices.Marshal]::WriteInt64($info, $offset, 0) }
    [Runtime.InteropServices.Marshal]::WriteInt32($info, 16, 0x2800)
    if (-not [Ccf.KillOnCloseJob]::SetInformationJobObject($job, 9, $info, $size)) { Fail 'SetInformationJobObject' }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
  # The handle goes to the target before the target joins the job: closing our own handle afterwards must never be
  # the job's last one while the target is in it (that would kill the target). DUPLICATE_SAME_ACCESS (2).
  $handed = [IntPtr]::Zero
  if (-not [Ccf.KillOnCloseJob]::DuplicateHandle([Ccf.KillOnCloseJob]::GetCurrentProcess(), $job, $target, [ref]$handed, 0, $false, 2)) {
    Fail 'DuplicateHandle'
  }
  if (-not [Ccf.KillOnCloseJob]::AssignProcessToJobObject($job, $target)) { Fail 'AssignProcessToJobObject' }
  Write-Output $handed.ToInt64()
} finally {
  [void][Ccf.KillOnCloseJob]::CloseHandle($job)
  [void][Ccf.KillOnCloseJob]::CloseHandle($target)
}
