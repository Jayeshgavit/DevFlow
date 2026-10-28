use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    sync::Arc,
};
use tokio::process::{Child, Command};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject,
            SetInformationJobObject, TerminateJobObject, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            PROCESS_SET_QUOTA, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME},
    },
};

pub(crate) struct WindowsJob(OwnedHandle, u64);

impl WindowsJob {
    fn new() -> io::Result<Self> {
        // No name or inheritable handle: only DevFlow owns this service's job.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() { return Err(io::Error::last_os_error()); }
        static NEXT_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) }, NEXT_RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(job.handle(), JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _, size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
        };
        if ok == 0 { return Err(io::Error::last_os_error()); }
        Ok(job)
    }

    fn handle(&self) -> HANDLE { self.0.as_raw_handle() }
    pub(crate) fn run_token(&self) -> String { self.1.to_string() }

    pub(crate) fn contains(&self, process: HANDLE) -> io::Result<bool> {
        let mut member = 0;
        if unsafe { windows_sys::Win32::System::JobObjects::IsProcessInJob(process, self.handle(), &mut member) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(member != 0)
    }

    fn assign_suspended(&self, pid: u32) -> io::Result<()> {
        // The child is still suspended, and its Child handle prevents PID reuse.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() { return Err(io::Error::last_os_error()); }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        if unsafe { AssignProcessToJobObject(self.handle(), process.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume_primary_thread(pid)
    }

    pub(crate) fn active_processes(&self) -> io::Result<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let ok = unsafe {
            QueryInformationJobObject(self.handle(), JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _, size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut())
        };
        if ok == 0 { return Err(io::Error::last_os_error()); }
        Ok(info.ActiveProcesses)
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn resume_primary_thread(pid: u32) -> io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
    if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut thread_id = None;
    loop {
        if entry.th32OwnerProcessID == pid {
            if thread_id.replace(entry.th32ThreadID).is_some() {
                return Err(io::Error::other("Suspended service has multiple threads; refusing to resume it"));
            }
        }
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 { break; }
    }
    let thread_id = thread_id.ok_or_else(|| io::Error::other("Suspended service thread was not found"))?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
    if thread.is_null() { return Err(io::Error::last_os_error()); }
    let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn spawn_contained(command: &mut Command) -> Result<(Child, Arc<WindowsJob>), String> {
    let job = Arc::new(WindowsJob::new().map_err(|error| format!("Could not create service Job Object: {error}"))?);
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command.spawn().map_err(|error| format!("Could not spawn service: {error}"))?;
    let pid = child.id().ok_or("Spawned service has no process ID")?;
    if let Err(error) = job.assign_suspended(pid) {
        // Never let a service run outside the job. If assignment succeeded but
        // resuming failed, dropping the job also kills the suspended child.
        let _ = child.start_kill();
        return Err(format!("Could not contain service process {pid}: {error}"));
    }
    Ok((child, job))
}
