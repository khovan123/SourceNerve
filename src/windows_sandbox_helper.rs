#![cfg(target_os = "windows")]

use std::{
    ffi::{OsStr, OsString, c_void},
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr,
};

use anyhow::{Result, anyhow, bail};
use tokio::process::Command;
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_SUCCESS, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL,
        INVALID_HANDLE_VALUE, LUID, LocalFree, SetHandleInformation,
    },
    Security::{
        ACL, AdjustTokenPrivileges,
        Authorization::{
            EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
            TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
        },
        CopySid, CreateRestrictedToken, DACL_SECURITY_INFORMATION, GetLengthSid,
        GetTokenInformation, LookupPrivilegeValueW, SID_AND_ATTRIBUTES, SetTokenInformation,
        TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER,
        TokenDefaultDacl, TokenGroups, TokenUser,
    },
    Storage::FileSystem::{
        FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    },
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessAsUserW, GetCurrentProcess,
            GetExitCodeProcess, INFINITE, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
            STARTUPINFOW, TerminateProcess, WaitForSingleObject,
        },
    },
};

use crate::error::{AppError, AppResult};

pub const INTERNAL_HELPER_ARGUMENT: &str = "--internal-windows-sandbox";
const MODE_READ_ONLY: &str = "read-only";
const MODE_WORKSPACE_WRITE: &str = "workspace-write";

// Synthetic SIDs in the normal account namespace are used as restricting principals. They are
// not real accounts and only grant access where SourceNerve explicitly adds a matching ACL entry.
const READ_ONLY_CAPABILITY_SID: &str = "S-1-5-21-1943109118-1889117587-1813467404-4241609138";
const WORKSPACE_WRITE_CAPABILITY_SID: &str = "S-1-5-21-3827675621-2387804058-1153500159-2751659043";
const EVERYONE_SID: &str = "S-1-1-0";

const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const WRITE_RESTRICTED: u32 = 0x08;
const SET_ACCESS: i32 = 2;
const GRANT_ACCESS: i32 = 1;
const CONTAINER_INHERIT_ACE: u32 = 0x02;
const OBJECT_INHERIT_ACE: u32 = 0x01;
const GENERIC_ALL: u32 = 0x1000_0000;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
const SE_PRIVILEGE_ENABLED: u32 = 0x0000_0002;
const WAIT_FAILED: u32 = 0xffff_ffff;

#[repr(C)]
struct TokenDefaultDaclInfo {
    default_dacl: *mut ACL,
}

struct LocalSid {
    value: *mut c_void,
}

impl LocalSid {
    fn from_string(value: &str) -> Result<Self> {
        let mut sid = ptr::null_mut();
        let wide = to_wide(OsStr::new(value));
        let converted = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if converted == 0 || sid.is_null() {
            return Err(anyhow!(
                "ConvertStringSidToSidW failed for sandbox SID: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(Self { value: sid })
    }

    fn as_ptr(&self) -> *mut c_void {
        self.value
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        if !self.value.is_null() {
            unsafe {
                LocalFree(self.value as HLOCAL);
            }
        }
    }
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE, operation: &str) -> Result<Self> {
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            return Err(anyhow!("{operation} failed: {}", unsafe { GetLastError() }));
        }
        Ok(Self(handle))
    }

    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut *mut c_void) -> i32;
    fn OpenProcessToken(process: HANDLE, desired_access: u32, token: *mut HANDLE) -> i32;
}

fn to_wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn ensure_workspace_write_acl(path: &Path) -> Result<()> {
    let capability = LocalSid::from_string(WORKSPACE_WRITE_CAPABILITY_SID)?;
    let mut path_wide = to_wide(path.as_os_str());
    let mut security_descriptor = ptr::null_mut();
    let mut dacl: *mut ACL = ptr::null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            1,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut security_descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(anyhow!(
            "GetNamedSecurityInfoW failed for {}: {status}",
            path.display()
        ));
    }
    if dacl.is_null() {
        if !security_descriptor.is_null() {
            unsafe { LocalFree(security_descriptor as HLOCAL) };
        }
        bail!(
            "workspace {} has no discretionary ACL; refusing to replace a null DACL",
            path.display()
        );
    }

    let allow_mask =
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | FILE_DELETE_CHILD;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: allow_mask,
        grfAccessMode: SET_ACCESS,
        grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: capability.as_ptr() as *mut u16,
        },
    };
    let mut new_dacl: *mut ACL = ptr::null_mut();
    let acl_status = unsafe { SetEntriesInAclW(1, &entry, dacl, &mut new_dacl) };
    if acl_status != ERROR_SUCCESS {
        if !security_descriptor.is_null() {
            unsafe { LocalFree(security_descriptor as HLOCAL) };
        }
        return Err(anyhow!("SetEntriesInAclW failed: {acl_status}"));
    }
    let apply_status = unsafe {
        SetNamedSecurityInfoW(
            path_wide.as_mut_ptr(),
            1,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            new_dacl,
            ptr::null_mut(),
        )
    };
    if !new_dacl.is_null() {
        unsafe { LocalFree(new_dacl as HLOCAL) };
    }
    if !security_descriptor.is_null() {
        unsafe { LocalFree(security_descriptor as HLOCAL) };
    }
    if apply_status != ERROR_SUCCESS {
        return Err(anyhow!("SetNamedSecurityInfoW failed: {apply_status}"));
    }
    Ok(())
}

pub fn prepare_command(
    workspace_root: &Path,
    cwd: &Path,
    program: &Path,
    args: &[String],
    workspace_write: bool,
) -> AppResult<Command> {
    let workspace_root = std::fs::canonicalize(workspace_root).map_err(|error| {
        AppError::Sandbox(format!(
            "failed to resolve the workspace root for Windows ACL confinement: {error}"
        ))
    })?;
    if workspace_write {
        ensure_workspace_write_acl(&workspace_root).map_err(|error| {
            AppError::Sandbox(format!(
                "failed to prepare the Windows workspace ACL: {error:#}"
            ))
        })?;
    }

    let executable = std::env::current_exe().map_err(|error| {
        AppError::Sandbox(format!(
            "failed to resolve the trusted SourceNerve Windows sandbox helper: {error}"
        ))
    })?;
    let mut command = Command::new(executable);
    command
        .arg(INTERNAL_HELPER_ARGUMENT)
        .arg(if workspace_write {
            MODE_WORKSPACE_WRITE
        } else {
            MODE_READ_ONLY
        })
        .arg(cwd)
        .arg(program)
        .arg("--")
        .args(args);
    Ok(command)
}

pub fn run_from_arguments() -> Result<Option<i32>> {
    let mut arguments = std::env::args_os();
    let _binary = arguments.next();
    let Some(first) = arguments.next() else {
        return Ok(None);
    };
    if first != OsStr::new(INTERNAL_HELPER_ARGUMENT) {
        return Ok(None);
    }

    let mode = arguments
        .next()
        .ok_or_else(|| anyhow!("Windows sandbox helper requires a mode"))?;
    let cwd = arguments
        .next()
        .ok_or_else(|| anyhow!("Windows sandbox helper requires a cwd"))?;
    let program = arguments
        .next()
        .ok_or_else(|| anyhow!("Windows sandbox helper requires a program"))?;
    let separator = arguments
        .next()
        .ok_or_else(|| anyhow!("Windows sandbox helper requires an argument separator"))?;
    if separator != OsStr::new("--") {
        bail!("Windows sandbox helper expected -- before command arguments");
    }
    let child_arguments: Vec<OsString> = arguments.collect();
    let capability_sid = if mode == OsStr::new(MODE_WORKSPACE_WRITE) {
        WORKSPACE_WRITE_CAPABILITY_SID
    } else if mode == OsStr::new(MODE_READ_ONLY) {
        READ_ONLY_CAPABILITY_SID
    } else {
        bail!("unsupported Windows sandbox helper mode");
    };

    let exit_code = run_restricted_child(
        Path::new(&cwd),
        OsStr::new(&program),
        &child_arguments,
        capability_sid,
    )?;
    Ok(Some(exit_code))
}

fn get_current_token() -> Result<OwnedHandle> {
    let desired_access = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut token = 0;
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), desired_access, &mut token) };
    if opened == 0 {
        return Err(anyhow!("OpenProcessToken failed: {}", unsafe {
            GetLastError()
        }));
    }
    OwnedHandle::new(token, "OpenProcessToken")
}

fn current_user_sid(token: HANDLE) -> Result<Vec<u8>> {
    copy_token_sid(token, TokenUser, |buffer| {
        let token_user = unsafe { ptr::read_unaligned(buffer.as_ptr() as *const TOKEN_USER) };
        token_user.User.Sid
    })
}

fn current_logon_sid(token: HANDLE) -> Result<Vec<u8>> {
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token, TokenGroups, ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        bail!("GetTokenInformation(TokenGroups) size query returned 0");
    }
    let mut buffer = vec![0_u8; needed as usize];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenGroups,
            buffer.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        )
    };
    if read == 0 || buffer.len() < std::mem::size_of::<u32>() {
        return Err(anyhow!(
            "GetTokenInformation(TokenGroups) failed: {}",
            unsafe { GetLastError() }
        ));
    }

    let group_count = unsafe { ptr::read_unaligned(buffer.as_ptr() as *const u32) } as usize;
    let after_count = unsafe { buffer.as_ptr().add(std::mem::size_of::<u32>()) } as usize;
    let align = std::mem::align_of::<SID_AND_ATTRIBUTES>();
    let groups_ptr = ((after_count + align - 1) & !(align - 1)) as *const SID_AND_ATTRIBUTES;
    for index in 0..group_count {
        let group = unsafe { ptr::read_unaligned(groups_ptr.add(index)) };
        if (group.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID {
            return copy_sid(group.Sid, "TokenGroups logon SID");
        }
    }
    bail!("current token does not contain a logon SID")
}

fn copy_token_sid<F>(token: HANDLE, class: i32, extract: F) -> Result<Vec<u8>>
where
    F: FnOnce(&[u8]) -> *mut c_void,
{
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token, class, ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        bail!("GetTokenInformation size query returned 0");
    }
    let mut buffer = vec![0_u8; needed as usize];
    let read = unsafe {
        GetTokenInformation(
            token,
            class,
            buffer.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        )
    };
    if read == 0 {
        return Err(anyhow!("GetTokenInformation failed: {}", unsafe {
            GetLastError()
        }));
    }
    copy_sid(extract(&buffer), "token SID")
}

fn copy_sid(sid: *mut c_void, operation: &str) -> Result<Vec<u8>> {
    let sid_length = unsafe { GetLengthSid(sid) };
    if sid_length == 0 {
        return Err(anyhow!("GetLengthSid({operation}) failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut copy = vec![0_u8; sid_length as usize];
    let copied = unsafe { CopySid(sid_length, copy.as_mut_ptr() as *mut c_void, sid) };
    if copied == 0 {
        return Err(anyhow!("CopySid({operation}) failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(copy)
}

fn set_token_default_dacl(restricted_token: HANDLE, sids: &[*mut c_void]) -> Result<()> {
    let entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: *sid as *mut u16,
            },
        })
        .collect();
    let mut dacl: *mut ACL = ptr::null_mut();
    let status = unsafe {
        SetEntriesInAclW(
            entries.len() as u32,
            entries.as_ptr(),
            ptr::null_mut(),
            &mut dacl,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(anyhow!("SetEntriesInAclW(default DACL) failed: {status}"));
    }
    let mut info = TokenDefaultDaclInfo { default_dacl: dacl };
    let applied = unsafe {
        SetTokenInformation(
            restricted_token,
            TokenDefaultDacl,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
        )
    };
    if !dacl.is_null() {
        unsafe { LocalFree(dacl as HLOCAL) };
    }
    if applied == 0 {
        return Err(anyhow!(
            "SetTokenInformation(TokenDefaultDacl) failed: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

fn enable_change_notify_privilege(token: HANDLE) -> Result<()> {
    let mut luid = LUID {
        LowPart: 0,
        HighPart: 0,
    };
    let name = to_wide(OsStr::new("SeChangeNotifyPrivilege"));
    let found = unsafe { LookupPrivilegeValueW(ptr::null(), name.as_ptr(), &mut luid) };
    if found == 0 {
        return Err(anyhow!("LookupPrivilegeValueW failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut privileges: TOKEN_PRIVILEGES = unsafe { std::mem::zeroed() };
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Luid = luid;
    privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    let adjusted = unsafe {
        AdjustTokenPrivileges(token, 0, &privileges, 0, ptr::null_mut(), ptr::null_mut())
    };
    if adjusted == 0 {
        return Err(anyhow!("AdjustTokenPrivileges failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(())
}

fn create_restricted_token(capability: &LocalSid) -> Result<OwnedHandle> {
    let base = get_current_token()?;
    let mut user_sid = current_user_sid(base.raw())?;
    let mut logon_sid = current_logon_sid(base.raw())?;
    let everyone = LocalSid::from_string(EVERYONE_SID)?;

    let mut restricting_sids = [
        SID_AND_ATTRIBUTES {
            Sid: capability.as_ptr(),
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: logon_sid.as_mut_ptr() as *mut c_void,
            Attributes: 0,
        },
        SID_AND_ATTRIBUTES {
            Sid: everyone.as_ptr(),
            Attributes: 0,
        },
    ];
    let mut restricted = 0;
    let created = unsafe {
        CreateRestrictedToken(
            base.raw(),
            DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
            0,
            ptr::null(),
            0,
            ptr::null(),
            restricting_sids.len() as u32,
            restricting_sids.as_mut_ptr(),
            &mut restricted,
        )
    };
    if created == 0 {
        return Err(anyhow!("CreateRestrictedToken failed: {}", unsafe {
            GetLastError()
        }));
    }
    let restricted = OwnedHandle::new(restricted, "CreateRestrictedToken")?;
    set_token_default_dacl(
        restricted.raw(),
        &[
            user_sid.as_mut_ptr() as *mut c_void,
            logon_sid.as_mut_ptr() as *mut c_void,
            everyone.as_ptr(),
            capability.as_ptr(),
        ],
    )?;
    enable_change_notify_privilege(restricted.raw())?;
    Ok(restricted)
}

fn quote_windows_argument(argument: &OsStr) -> Vec<u16> {
    let raw: Vec<u16> = argument.encode_wide().collect();
    let needs_quotes =
        raw.is_empty() || raw.iter().any(|value| matches!(*value, 0x20 | 0x09 | 0x22));
    if !needs_quotes {
        return raw;
    }

    let mut quoted = Vec::with_capacity(raw.len() + 2);
    quoted.push(0x22);
    let mut backslashes = 0_usize;
    for value in raw {
        if value == 0x5c {
            backslashes += 1;
            continue;
        }
        if value == 0x22 {
            quoted.extend(std::iter::repeat_n(0x5c, backslashes * 2 + 1));
            quoted.push(0x22);
            backslashes = 0;
            continue;
        }
        quoted.extend(std::iter::repeat_n(0x5c, backslashes));
        backslashes = 0;
        quoted.push(value);
    }
    quoted.extend(std::iter::repeat_n(0x5c, backslashes * 2));
    quoted.push(0x22);
    quoted
}

fn command_line(program: &OsStr, arguments: &[OsString]) -> Vec<u16> {
    let mut output = quote_windows_argument(program);
    for argument in arguments {
        output.push(0x20);
        output.extend(quote_windows_argument(argument));
    }
    output.push(0);
    output
}

fn inheritable_standard_handle(kind: u32) -> Result<HANDLE> {
    let handle = unsafe { GetStdHandle(kind) };
    if handle == 0 || handle == INVALID_HANDLE_VALUE {
        return Err(anyhow!("GetStdHandle({kind}) failed: {}", unsafe {
            GetLastError()
        }));
    }
    let inherited =
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
    if inherited == 0 {
        return Err(anyhow!(
            "SetHandleInformation for standard handle failed: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(handle)
}

fn create_kill_on_close_job() -> Result<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) };
    let job = OwnedHandle::new(job, "CreateJobObjectW")?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as *mut c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(anyhow!("SetInformationJobObject failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(job)
}

fn run_restricted_child(
    cwd: &Path,
    program: &OsStr,
    arguments: &[OsString],
    capability_sid: &str,
) -> Result<i32> {
    let capability = LocalSid::from_string(capability_sid)?;
    let token = create_restricted_token(&capability)?;
    let job = create_kill_on_close_job()?;
    let stdin = inheritable_standard_handle(STD_INPUT_HANDLE)?;
    let stdout = inheritable_standard_handle(STD_OUTPUT_HANDLE)?;
    let stderr = inheritable_standard_handle(STD_ERROR_HANDLE)?;
    let mut command_line = command_line(program, arguments);
    let cwd_wide = to_wide(cwd.as_os_str());
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = stdin;
    startup.hStdOutput = stdout;
    startup.hStdError = stderr;
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let created = unsafe {
        CreateProcessAsUserW(
            token.raw(),
            ptr::null(),
            command_line.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            1,
            CREATE_NO_WINDOW | CREATE_SUSPENDED,
            ptr::null_mut(),
            cwd_wide.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(anyhow!("CreateProcessAsUserW failed: {}", unsafe {
            GetLastError()
        }));
    }
    let process_handle = OwnedHandle::new(process.hProcess, "CreateProcessAsUserW process")?;
    let thread_handle = OwnedHandle::new(process.hThread, "CreateProcessAsUserW thread")?;

    let assigned = unsafe { AssignProcessToJobObject(job.raw(), process_handle.raw()) };
    if assigned == 0 {
        unsafe {
            TerminateProcess(process_handle.raw(), 1);
        }
        return Err(anyhow!(
            "AssignProcessToJobObject failed before child resume: {}",
            unsafe { GetLastError() }
        ));
    }
    let resumed = unsafe { ResumeThread(thread_handle.raw()) };
    if resumed == u32::MAX {
        unsafe {
            TerminateProcess(process_handle.raw(), 1);
        }
        return Err(anyhow!(
            "ResumeThread failed after sandbox job assignment: {}",
            unsafe { GetLastError() }
        ));
    }

    let wait = unsafe { WaitForSingleObject(process_handle.raw(), INFINITE) };
    if wait == WAIT_FAILED {
        return Err(anyhow!(
            "WaitForSingleObject failed for sandbox child: {}",
            unsafe { GetLastError() }
        ));
    }
    let mut exit_code = 1_u32;
    let got_exit = unsafe { GetExitCodeProcess(process_handle.raw(), &mut exit_code) };
    if got_exit == 0 {
        return Err(anyhow!(
            "GetExitCodeProcess failed for sandbox child: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(exit_code as i32)
}

#[cfg(test)]
mod tests {
    use super::{
        READ_ONLY_CAPABILITY_SID, WORKSPACE_WRITE_CAPABILITY_SID, ensure_workspace_write_acl,
        run_restricted_child,
    };
    use std::ffi::{OsStr, OsString};
    use std::path::Path;

    fn run_cmd(cwd: &Path, capability_sid: &str, command: &str) -> anyhow::Result<i32> {
        let program = std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
        let arguments = ["/D", "/S", "/C", command]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>();
        run_restricted_child(cwd, OsStr::new(&program), &arguments, capability_sid)
    }

    #[test]
    fn restricted_token_enforces_read_only_and_workspace_write_boundaries() {
        let root = tempfile::tempdir().expect("create sandbox fixture root");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("create sandbox fixture workspace");
        ensure_workspace_write_acl(&workspace).expect("grant workspace capability ACL");

        let read_only = run_cmd(
            &workspace,
            READ_ONLY_CAPABILITY_SID,
            "echo denied>read-only.txt",
        )
        .expect("launch read-only restricted child");
        assert_ne!(read_only, 0, "read-only sandbox unexpectedly wrote into workspace");
        assert!(!workspace.join("read-only.txt").exists());

        let workspace_write = run_cmd(
            &workspace,
            WORKSPACE_WRITE_CAPABILITY_SID,
            "echo allowed>workspace-write.txt",
        )
        .expect("launch workspace-write restricted child");
        assert_eq!(workspace_write, 0, "workspace-write sandbox failed");
        assert!(workspace.join("workspace-write.txt").exists());

        let outside = root.path().join("outside.txt");
        let outside_command = format!("echo blocked>\"{}\"", outside.display());
        let outside_write = run_cmd(
            &workspace,
            WORKSPACE_WRITE_CAPABILITY_SID,
            &outside_command,
        )
        .expect("launch outside-write restricted child");
        assert_ne!(outside_write, 0, "workspace-write sandbox unexpectedly wrote outside workspace");
        assert!(!outside.exists());
    }
}
