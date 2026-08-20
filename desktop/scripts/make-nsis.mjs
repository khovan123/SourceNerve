import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
const arch = process.argv[2] ?? process.arch;

if (process.platform !== "win32") {
  throw new Error("SourceNerve NSIS installer must be built on Windows");
}
if (arch !== "x64") {
  throw new Error(`SourceNerve NSIS currently supports x64 only, received ${arch}`);
}

const packagedDirectory = path.join(desktopDirectory, "out", `SourceNerve-win32-${arch}`);
const packagedExecutable = path.join(packagedDirectory, "sourcenerve-desktop.exe");
const iconPath = path.join(desktopDirectory, "assets", "generated", "icon.ico");
await access(packagedExecutable);
await access(iconPath);

const makeDirectory = path.join(desktopDirectory, "out", "make", "nsis", arch);
await mkdir(makeDirectory, { recursive: true });
const outputPath = path.join(makeDirectory, `SourceNerve-Setup-${packageJson.version}-${arch}.exe`);
const scriptPath = path.join(makeDirectory, "SourceNerve.nsi");
const windowsVersion = toWindowsVersion(packageJson.version);

await rm(outputPath, { force: true });
await writeFile(scriptPath, nsisScript({ packagedDirectory, iconPath, outputPath, version: packageJson.version, windowsVersion }), "utf8");

try {
  const { stdout, stderr } = await execFileAsync("makensis", [scriptPath], {
    cwd: desktopDirectory,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
} finally {
  await rm(scriptPath, { force: true });
}

await access(outputPath);
console.log(`created SourceNerve NSIS installer: ${path.relative(desktopDirectory, outputPath)}`);

function toWindowsVersion(version) {
  const core = String(version).split("-")[0].split(".");
  if (core.length > 4 || core.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`Desktop version is not compatible with Windows version metadata: ${version}`);
  }
  return [...core, ...Array(4 - core.length).fill("0")].join(".");
}

function win(candidate) {
  return candidate.replaceAll("/", "\\");
}

function nsisScript({ packagedDirectory, iconPath, outputPath, version, windowsVersion }) {
  const source = win(packagedDirectory);
  const icon = win(iconPath);
  const output = win(outputPath);
  return `Unicode true
!include "MUI2.nsh"

Name "SourceNerve"
OutFile "${output}"
InstallDir "$LOCALAPPDATA\\Programs\\SourceNerve"
InstallDirRegKey HKCU "Software\\SourceNerve" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "${icon}"
VIProductVersion "${windowsVersion}"
VIAddVersionKey /LANG=1033 "ProductName" "SourceNerve"
VIAddVersionKey /LANG=1033 "FileDescription" "SourceNerve Desktop Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${version}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${version}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MIT License"

!define MUI_ABORTWARNING
!define MUI_ICON "${icon}"
!define MUI_UNICON "${icon}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "SourceNerve" SEC_MAIN
  SetShellVarContext current
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${source}\\*.*"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  WriteRegStr HKCU "Software\\SourceNerve" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve" "DisplayName" "SourceNerve"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve" "DisplayVersion" "${version}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve" "Publisher" "SourceNerve"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve" "URLInfoAbout" "https://github.com/khovan123/SourceNerve"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve" "UninstallString" "$\"$INSTDIR\\Uninstall.exe$\""
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve" "NoRepair" 1

  WriteRegStr HKCU "Software\\Classes\\sourcenerve" "" "URL:SourceNerve Protocol"
  WriteRegStr HKCU "Software\\Classes\\sourcenerve" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\sourcenerve\\DefaultIcon" "" "$INSTDIR\\sourcenerve-desktop.exe,0"
  WriteRegStr HKCU "Software\\Classes\\sourcenerve\\shell\\open\\command" "" "$\"$INSTDIR\\sourcenerve-desktop.exe$\" $\"%1$\""

  CreateDirectory "$SMPROGRAMS\\SourceNerve"
  CreateShortcut "$SMPROGRAMS\\SourceNerve\\SourceNerve.lnk" "$INSTDIR\\sourcenerve-desktop.exe"
  CreateShortcut "$DESKTOP\\SourceNerve.lnk" "$INSTDIR\\sourcenerve-desktop.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\\SourceNerve.lnk"
  Delete "$SMPROGRAMS\\SourceNerve\\SourceNerve.lnk"
  RMDir "$SMPROGRAMS\\SourceNerve"
  DeleteRegKey HKCU "Software\\Classes\\sourcenerve"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SourceNerve"
  DeleteRegKey HKCU "Software\\SourceNerve"
  RMDir /r "$INSTDIR"
  ; User state lives outside $INSTDIR and is intentionally preserved.
SectionEnd
`;
}
