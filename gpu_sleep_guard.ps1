# -Always: 学習していなくてもずっとスリープさせない（外出先からリモートでつなぐとき）
param([switch]$Always)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class SleepControl {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;

    // 離席中に Windows が省電力（Eコア・低クロック）へ回すのを、プロセスごとに止める
    [StructLayout(LayoutKind.Sequential)]
    public struct ThrottleState { public uint Version; public uint ControlMask; public uint StateMask; }
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr h, int cls, ref ThrottleState info, uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static bool DisableThrottling(int pid) {
        IntPtr h = OpenProcess(0x0200, false, pid);  // PROCESS_SET_INFORMATION
        if (h == IntPtr.Zero) return false;
        ThrottleState s = new ThrottleState();
        s.Version = 1; s.ControlMask = 1; s.StateMask = 0;  // 実行速度の省電力をオフ
        bool ok = SetProcessInformation(h, 4, ref s, (uint)Marshal.SizeOf(typeof(ThrottleState)));  // ProcessPowerThrottling
        CloseHandle(h);
        return ok;
    }
}
"@

# 学習・評価・対局サーバーなど、動いている間はスリープさせないスクリプト
# （自己対局中の GPU 使用率は 55〜60% ほどなので、使用率だけでは判定しない）
$watchScripts = 'train_loop.py|pretrain_scaffold.py|eval_models.py|bench_selfplay.py'
$gpuThreshold = 30   # スクリプト以外で GPU を使っているときの目安（%）

$lowSeconds = 0
$blocking = $false
$tuned = @{}

while ($true) {
    $busy = $false
    $reason = ''
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
            Where-Object { $_.CommandLine -match $watchScripts }
        if ($procs) {
            $busy = $true
            $reason = '学習プロセスあり'
            foreach ($p in $procs) {
                if (-not $tuned.ContainsKey($p.ProcessId)) {
                    # 省電力の対象から外し、優先度を少し上げる（1プロセス1回）
                    $ok = [SleepControl]::DisableThrottling([int]$p.ProcessId)
                    try { (Get-Process -Id $p.ProcessId).PriorityClass = 'AboveNormal' } catch {}
                    $tuned[$p.ProcessId] = $true
                    Write-Host "$(Get-Date -Format 'HH:mm:ss') pid $($p.ProcessId) を高性能に設定: $ok"
                }
            }
        }
    }
    catch {}
    try {
        # GPU が複数あっても最大値を使う
        $gpuUsage = (nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits |
            ForEach-Object { [int]$_ } | Measure-Object -Maximum).Maximum
        if ($gpuUsage -ge $gpuThreshold) {
            $busy = $true
            if (-not $reason) { $reason = "GPU $gpuUsage%" }
        }
    }
    catch {
        $gpuUsage = -1
    }

    if ($Always -and -not $busy) {
        $busy = $true
        $reason = '常に禁止（-Always）'
    }

    if ($busy) {
        # スリープ禁止（このスクリプトを閉じれば自動で解除される）
        [SleepControl]::SetThreadExecutionState([SleepControl]::ES_CONTINUOUS -bor [SleepControl]::ES_SYSTEM_REQUIRED) | Out-Null
        $lowSeconds = 0
        $blocking = $true
    }
    else {
        $lowSeconds += 10
        # 60秒ずっと暇なら解除
        if ($blocking -and $lowSeconds -ge 60) {
            [SleepControl]::SetThreadExecutionState([SleepControl]::ES_CONTINUOUS) | Out-Null
            $blocking = $false
        }
    }

    $state = if ($blocking) { 'スリープ禁止中' } else { 'スリープ可' }
    Write-Host "$(Get-Date -Format 'HH:mm:ss') GPU: $gpuUsage% $state $reason"
    Start-Sleep -Seconds 10
}
