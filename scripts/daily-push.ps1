# Daily push of the current feature branch (user, 2026-11-11: "Push the code daily at 11.30 PM once").
# Run by the Windows scheduled task "JobOpenings daily push" at 23:30. Never pushes main, never forces; the pre-push
# hook (.git/hooks/pre-push) runs the personal-data scan and blocks the push on a hit. Log: qa/daily-push.log.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $repo 'qa\daily-push.log'
function Write-Log($text) { Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $text) }

Set-Location $repo
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -eq 'main' -or $branch -eq 'HEAD') { Write-Log "skipped: on '$branch' (only feature branches are pushed)"; exit 0 }

git fetch -q origin $branch 2>$null
$ahead = (git rev-list --count "origin/$branch..HEAD" 2>$null)
if (-not $ahead) { $ahead = (git rev-list --count HEAD --not --remotes) }
if ([int]$ahead -eq 0) { Write-Log "nothing to push on $branch"; exit 0 }

$out = git push origin $branch 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { Write-Log "pushed $ahead commit(s) on $branch" }
else { Write-Log "push FAILED on ${branch}: $($out.Trim() -replace '\s+', ' ')"; exit 1 }
