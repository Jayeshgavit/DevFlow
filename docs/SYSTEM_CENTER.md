# Windows System Monitor and Maintenance

System operations use current-user rights. There is no elevation, generic command runner, arbitrary deletion path, automatic process killing, memory cleaner, or performance score. Windows service launch/stop and Job Object cleanup remain in the existing project lifecycle.

## Measurements

`system_snapshot(forceHardware)` runs on a blocking worker with a backend refresh lock. The React views share one completion-based refresh timer, approximately two seconds after the previous refresh completes. Refresh requests never overlap. Leaving the system views or hiding the document stops polling and invalidates pending responses. Returning starts a new read. Maintenance results persist across navigation.

- CPU uses deltas from `GetSystemTimes`. It needs two samples, and is unavailable after a sampling gap of ten seconds or more. Aggregate CPU is unavailable above 64 logical processors because this API is processor-group scoped on those systems.
- Logical count uses `GetActiveProcessorCount`; x64 processor branding uses CPUID and is cached. Other architectures show their architecture identifier.
- RAM uses `GlobalMemoryStatusEx`. Used RAM is total physical minus available physical. Units are binary (MiB/GiB).
- Process enumeration uses Toolhelp, `GetProcessTimes`, `QueryFullProcessImageNameW`, and `GetProcessMemoryInfo`. CPU is normalized to the machine's logical processor count. Memory is working set, including shared pages. Inaccessible data is null, never fabricated as zero. CPU values may sum differently from aggregate CPU due to sampling windows and inaccessible/short-lived processes.
- Drives use `GetLogicalDrives`, `GetDriveTypeW`, and `GetDiskFreeSpaceExW`, cached for sixty seconds. Refresh Now bypasses this cache. Only fixed drive letters are included; network/removable drives and mount-only volumes are outside this version. Drive errors remain visible.
- Uptime uses `GetTickCount64` (the Windows session uptime, including sleep; Fast Startup can affect restart expectations). Process count is the enumerated snapshot count.
- GPU name, utilization, and dedicated memory telemetry are unavailable in this version. No estimates or simulated values are substituted. The recovery shortcut is guidance only.

## Process termination

`system_end_task(pid, created)` requires a process from the backend's current snapshot. Creation timestamps are strings to preserve all 64 bits. The backend opens one handle with query/terminate/synchronize rights, rechecks creation time, executable path/name, same-user SID, critical status, protection level, and Job Object membership, then calls `TerminateProcess` on that handle only. It confirms exit with a bounded wait. A PID reused for a different process is rejected.

End Task refuses DevFlow, its descendants and launcher ancestors, Windows-directory executables, other users' processes, critical/protected processes, and uncertain/inaccessible identities. **All Job Object members are refused**, including third-party application jobs. Managed services must use Projects → Stop, which retains existing Windows Job Object cleanup. The service registry is held while terminating and termination is refused while any DevFlow service is starting, preventing a race with job assignment. No process tree is generically terminated.

The UI confirms name, PID, executable, and unsaved-work risk. Frontend disabled states are explanatory; backend validation is authoritative. A process may disappear or lose permissions after the dialog opens; this reports an error instead of success.

## Temporary files

`scan_temp_files` derives **current-user Local AppData/Temp** with `SHGetKnownFolderPath`, ignoring caller paths and environment-defined alternate temp locations. The root must be on a fixed local drive. Only immediate children are inspected; no directory recursion or content reads occur. Candidates must:

- Have `.tmp` or `.temp` extension and Windows `FILE_ATTRIBUTE_TEMPORARY` set.
- Have last-write time older than seven days, one hard link, and no directory/reparse/read-only/system/hidden attributes.
- Have no recognized environment, Git, database, configuration, profile, or backup markers in their names.
- Open with exclusive sharing. Inaccessible/in-use or uncertain files are skipped.

The scope is intentionally conservative: most files in Temp will not qualify. Filename/attribute checks do not establish the semantic contents of a file; users must review paths before deletion. Never select a candidate known to contain source, database, configuration, or other valuable data.

The backend pins the root and each ancestor using no-delete-sharing directory handles, rejects reparse points and Git/environment ancestors, and refuses cleanup if the root overlaps saved project roots, service working directories, or DevFlow config. Unverifiable project exclusions fail closed. Unsaved or unregistered directories cannot be inferred; cleanup remains restricted to explicitly reviewed, Windows-marked temporary files.

Scans cap at 10,000 inspected entries and 1,000 candidates. The preview reports caps, candidates, file lengths, excluded/inaccessible count, and paths. The server stores file volume/index, last-write timestamp, size, and link count. Scan IDs expire after five minutes and are single-use.

`clean_temp_files(scanId, selectedIds)` accepts only IDs from that stored scan, not filesystem paths. It reacquires the operation lock, rederives/pins the root, verifies root identity and project exclusions, then opens each selected file with exclusive access and DELETE rights. It rechecks identity, metadata, attributes, age, and parent against the scan and uses `SetFileInformationByHandle(FileDispositionInfo)` on the **same handle**. It never calls recursive delete or follows reparse points. This is permanent deletion, bypassing Recycle Bin.

`cancel_system_maintenance` requests cooperative cancellation between files, not rollback. Completed deletions remain deleted. Results report deleted count, summed logical lengths of deleted files, skipped/unprocessed count, cancellation, and up to thirty skip details. Logical file lengths are not a promise of physical disk savings; allocation/compression and concurrent activity can change free-space differences. Scans/cleanup and other mutating operations share a backend lock.

## Other maintenance commands

| Command | Fixed operation | Effect and limits |
| --- | --- | --- |
| Refresh Now | `system_snapshot(true)` | Re-query measurements; no RAM clearing, optimization, or service restarts. |
| `open_storage_tool("settings")` | `ShellExecuteW` with `ms-settings:storagesense` | Requests Windows Storage Settings; user reviews Windows-managed cleanup there. |
| `open_storage_tool("disk-cleanup")` | System directory `cleanmgr.exe`, no arguments | Launches interactive Windows Disk Cleanup when installed; does not approve any cleanup selection. |
| `flush_dns_cache` | System directory `ipconfig.exe /flushdns`, no shell | Clears DNS resolver cache. Confirmation required; fifteen-second deadline, exit-code validation, no elevation. Does not improve CPU/RAM speed. |

No Windows Update caches, restore points, driver packages, Downloads, Recycle Bin, DISM, chkdsk repair, formatting, registry cleaning, service disabling, or defragmentation are performed by DevFlow.

## Release verification still required

Only compilation/type/diff checks were authorized during implementation. **End Task and permanent temporary-file deletion require manual Windows testing before release**, including PID reuse, disappearing/protected/other-user processes, managed service descendants, locked files, hard links, reparse/path swaps, scan expiry, cancellation, partial failures, and byte accounting. DNS flush and Windows tool launches also remain unexecuted. Confirm polling/minimize behavior, high-DPI/narrow layouts, keyboard/focus behavior, and long-running process enumeration on Windows 10/11. No application grouping is implemented; individual PIDs remain explicit.
