# MCP stdio sandbox and isolation policy

SourceNerve launches local stdio MCP extensions without a user shell. The child environment is rebuilt from a small reviewed set, SourceNerve/provider credentials are not inherited, and each extension receives a private HOME/TMP area under the SourceNerve MCP sandbox root.

## Policy

The daemon-owned policy is controlled by deployment/runtime configuration, not by downstream MCPs:

- `SOURCENERVE_MCP_STDIO_SANDBOX=auto|required|disabled` (`auto` by default).
- `SOURCENERVE_MCP_STDIO_NETWORK=inherit|deny` (`inherit` by default).
- `SOURCENERVE_MCP_STDIO_ALLOWED_ROOTS` is an OS path-list of specific existing directories that may be mounted read/write by a kernel sandbox.
- `SOURCENERVE_MCP_STDIO_MAX_MEMORY_MB`, `SOURCENERVE_MCP_STDIO_MAX_PROCESSES`, and `SOURCENERVE_MCP_STDIO_CPU_SECONDS` request bounded resource limits.

`required`, network deny, explicit allowed roots, or explicit resource limits are fail-closed requirements. If the host cannot enforce a requested restriction, SourceNerve does not launch the extension and returns a safe error that Desktop can display.

## Platform matrix

| Platform | Filesystem/process isolation | Network policy | Resource limits | Failure behavior |
| --- | --- | --- | --- | --- |
| Linux | Bubblewrap (`bwrap`) user/PID/IPC/UTS namespace, private `/tmp`, explicit system read-only mounts, explicit allowed roots, `--die-with-parent` | `--unshare-net` when deny is required | `prlimit` for address-space, process-count and CPU limits | Required restrictions fail closed when `bwrap`/`prlimit` is unavailable |
| macOS | `sandbox-exec` profile with default deny, reviewed system reads, private sandbox HOME/TMP, explicit allowed roots | profile denies network unless inherit is configured | Not claimed by this runtime | Required unsupported limits or unavailable `sandbox-exec` fail closed |
| Windows | Environment/HOME/TMP isolation and `kill_on_drop`; no kernel filesystem/network sandbox is claimed by this runtime | Not enforceable in this slice | Not enforceable in this slice | Any policy that requires kernel/network/resource isolation fails closed |
| Other | Environment/HOME/TMP isolation only | Not enforceable | Not enforceable | Required kernel restrictions fail closed |

`auto` uses the strongest supported kernel sandbox when the required helper exists; otherwise it keeps the reviewed environment/private HOME+TMP boundary without claiming kernel isolation. `disabled` disables kernel wrapping but still keeps the minimal environment and private HOME/TMP boundary.

## Environment boundary

The stdio process starts with `env_clear()`. SourceNerve may copy only a reviewed parent set such as PATH/system runtime variables and locale. It does not inherit HOME, SSH agent sockets, shell startup state, SourceNerve bearer material, OAuth tokens, provider credentials, or arbitrary daemon environment variables.

Extension-specific environment values must be explicitly materialized by SourceNerve. Sandbox-owned keys (`PATH`, `HOME`, `USERPROFILE`, temporary-directory variables, OS runtime roots, SSH/Git prompt hooks, and all `SOURCENERVE_*` keys) cannot be replaced by an extension environment recipe.

## Filesystem roots

Allowed roots must already exist, canonicalize successfully, be directories, be absolute, and must not be the filesystem root. Extension IDs are validated before they are used in sandbox paths, preventing `..`, path separators, or other path-escape forms.

On Linux/macOS, a command installed outside the reviewed system roots gets only the executable parent mounted/readable as needed for launch; this does not implicitly grant the extension broad user-home access.

## Process cleanup

MCP child processes remain `kill_on_drop`. Linux bubblewrap is started with `--die-with-parent`, a new session, and a PID namespace so descendants cannot silently outlive the sandbox supervisor. MCP lifecycle cancellation and the bounded graceful shutdown window from the runtime supervisor continue to apply before forced process termination.

## Trust note

Sandboxing limits ambient host access; it does not make a third-party MCP safe. SourceNerve tool policy, Ask/Blocked decisions, credential isolation, artifact provenance, and invocation audit remain separate security controls.